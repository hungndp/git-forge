// Boot shim for the forge: this file owns no product logic at all. It starts the
// HTTP server that app.ts builds, tells the trial environment where that server
// can be reached, and then keeps the process alive until the environment says
// the trial is finished. The wire contract it speaks is the harness's:
//
//   * MAKEFUN_ENV_URL is the environment's origin. If it is missing there is
//     nobody to register with, so the process gives up immediately.
//   * The server binds port 0, which lets the kernel hand out a free ephemeral
//     port. Port 8080 belongs to the environment and is never touched here.
//   * POST {port} as JSON to <env>/register announces the bound port. The
//     environment notes the caller's address and dials it back from then on.
//     200 means the announcement landed; 409 means another process registered
//     first, which is equally final as far as this process is concerned.
//     400 and 405 mean the request itself broke the contract, so those abort
//     the boot; anything else (a 5xx, a refused connection, a timeout) is
//     retried, because the environment may simply not be up yet.
//   * GET <env>/done is polled until its JSON body reports done: true. The
//     environment answers straight away, so polling — not one long-held
//     request — is the shape of the wait, and the process never exits early.
//   * Once done arrives, the server closes and the process exits 0.
//
// The only import is the server factory from ./app.ts: no packages, no Node
// built-ins, no model calls — the lifecycle needs nothing more.

import { createApp as buildForgeServer } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

// The one way this process dies early: say why on stderr, then exit 1.
function abortBoot(message: string): never {
  process.stderr.write('[forge] ' + message + '\n');
  return process.exit(1);
}

if (envOrigin.length === 0) {
  abortBoot('MAKEFUN_ENV_URL is unset: no environment to register with');
}

// One env request gets at most this long before it counts as failed.
const REQUEST_DEADLINE_MS = 30_000;
// Retry waits grow from the floor to the ceiling, doubling each time.
const FIRST_RETRY_WAIT_MS = 250;
const LONGEST_RETRY_WAIT_MS = 2_000;

function pause(milliseconds: number): Promise<void> {
  return new Promise<void>((wake) => {
    setTimeout(wake, milliseconds);
  });
}

// How long to wait before retry number `failures + 1`: the doubling is capped
// both in the exponent and in the result, so a long outage settles into a
// steady two-second rhythm instead of an ever-growing silence.
function waitBeforeRetry(failures: number): number {
  const doubled = FIRST_RETRY_WAIT_MS * 2 ** Math.min(failures, 8);
  return Math.min(LONGEST_RETRY_WAIT_MS, doubled);
}

// One registration attempt, classified three ways: 'accepted' when the
// environment took the port (or an earlier process registered first, which
// settles the matter just the same), an Error when the environment refused
// the request itself as a contract violation, and 'again' for everything
// transient — a 5xx, a refused connection, a timeout — because the
// environment may simply not be up yet.
async function tryAnnounceOnce(port: number): Promise<'accepted' | 'again' | Error> {
  let reply;
  try {
    reply = await fetch(envOrigin + '/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: port }),
      signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
    });
  } catch {
    return 'again';
  }
  if (reply.status === 200 || reply.status === 409) {
    return 'accepted';
  }
  if (reply.status === 400 || reply.status === 405) {
    const detail = await reply.text().catch(() => '');
    return new Error('the environment refused the registration: HTTP ' + reply.status + ' — ' + detail);
  }
  return 'again';
}

// POST the bound port to the environment until it accepts the announcement;
// a contract refusal aborts the boot instead of retrying forever.
async function announcePort(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    const outcome = await tryAnnounceOnce(port);
    if (outcome === 'accepted') {
      return;
    }
    if (outcome instanceof Error) {
      throw outcome;
    }
    await pause(waitBeforeRetry(failures));
    failures += 1;
  }
}

// Poll the environment's /done endpoint until it reports the trial over.
// Any answer other than a JSON body with done set to true — including no
// answer at all — simply means: keep waiting.
async function holdUntilDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const reply = await fetch(envOrigin + '/done', {
        signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
      });
      if (reply.ok) {
        const payload: unknown = await reply.json();
        if (typeof payload === 'object' && payload !== null && (payload as { done?: unknown }).done === true) {
          return;
        }
      }
    } catch {
      // Not reachable, not JSON, too slow: all of it just means "not done".
    }
    await pause(waitBeforeRetry(failures));
    failures += 1;
  }
}

// The whole life of the process, in order: bind, announce, hold, close.
async function runLifecycle(): Promise<void> {
  const server = buildForgeServer();

  const boundPort = await new Promise<number>((resolve, reject) => {
    server.once('error', (bindError) => {
      reject(bindError);
    });
    server.listen(0, () => {
      const address = server.address();
      if (address !== null && typeof address === 'object') {
        resolve(address.port);
      } else {
        reject(new Error('the server bound no TCP port to announce'));
      }
    });
  });
  process.stdout.write('[forge] listening on ephemeral port ' + boundPort + '\n');

  await announcePort(boundPort);
  process.stdout.write('[forge] registered with the environment; waiting for it to finish\n');

  await holdUntilDone();
  // Stop listening, but do not wait for the close to drain: the exit below
  // ends the process either way, exactly as the harness expects.
  server.close(() => undefined);
  process.stdout.write('[forge] environment reports done; exiting\n');
}

runLifecycle().then(
  () => {
    process.exit(0);
  },
  (problem: unknown) => {
    abortBoot(problem instanceof Error ? problem.message : String(problem));
  },
);
