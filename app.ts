// The forge's HTTP server: one router over four surfaces — git smart HTTP, REST v3, GraphQL v4 and
// MCP — all backed by the single Forge store in store.ts, so every surface sees the same objects.
// main.ts owns the lifecycle (bind, register, wait for done); this file is the whole product.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGit } from './githttp.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { errorReply, type Reply } from './web.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 256 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendReply(res: ServerResponse, reply: Reply, requestId: string): void {
  const headers: Record<string, string> = { 'x-github-request-id': requestId, ...reply.headers };
  if (reply.raw !== undefined) {
    res.writeHead(reply.status, { 'content-type': reply.contentType ?? 'application/octet-stream', 'content-length': reply.raw.length, ...headers });
    res.end(reply.raw);
    return;
  }
  if (reply.body === null || reply.body === undefined) {
    res.writeHead(reply.status, headers);
    res.end();
    return;
  }
  const text = `${JSON.stringify(reply.body)}\n`;
  res.writeHead(reply.status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Whether the request carries the trial's bearer token (any token at all when none is configured). */
function authorized(req: IncomingMessage, expectedToken: string): boolean {
  if (expectedToken === '') return true;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match !== null && match[1] === expectedToken;
}

export function createApp(): Server {
  const forge = new Forge();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestSeq = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requestSeq += 1;
    const requestId = `F${requestSeq.toString(16).padStart(8, '0')}`;
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        // The env's boot check: no auth, always up.
        if (method === 'GET' && path === '/healthz') {
          sendReply(res, { status: 200, body: { ok: true }, headers: {} }, requestId);
          return;
        }

        const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        const segments = path.split('/').filter((part) => part !== '').map(decodeSegment);

        // REST v3 (the root itself is public, as api.github.com's is; everything else needs the token).
        if (segments[0] === 'api' && segments[1] === 'v3') {
          const restSegments = segments.slice(2);
          if (!(method === 'GET' && restSegments.length === 0) && !authorized(req, expectedToken)) {
            sendReply(res, errorReply(401, 'Bad credentials'), requestId);
            return;
          }
          const reply = handleRest(forge, { method, segments: restSegments, query: url.searchParams, rawBody, host: req.headers.host ?? 'entry' });
          sendReply(res, reply, requestId);
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql') {
          if (!authorized(req, expectedToken)) {
            sendReply(res, errorReply(401, 'Bad credentials'), requestId);
            return;
          }
          if (method !== 'POST') {
            sendReply(res, errorReply(405, 'Method Not Allowed'), requestId);
            return;
          }
          sendReply(res, handleGraphQL(forge, rawBody), requestId);
          return;
        }

        // MCP.
        if (path === '/mcp') {
          if (!authorized(req, expectedToken)) {
            sendReply(res, { status: 401, body: { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }, headers: {} }, requestId);
            return;
          }
          if (method !== 'POST') {
            sendReply(res, errorReply(405, 'Method Not Allowed'), requestId);
            return;
          }
          sendReply(res, handleMcp(forge, rawBody), requestId);
          return;
        }

        // Git smart HTTP: /<owner>/<repo>[.git]/<tail>, where the tail itself may span segments.
        const gitTail = segments.slice(2).join('/');
        if (segments.length >= 3 && (gitTail === 'info/refs' || gitTail === 'git-upload-pack' || gitTail === 'git-receive-pack')) {
          if (!authorized(req, expectedToken)) {
            sendReply(res, errorReply(401, 'Bad credentials'), requestId);
            return;
          }
          const repoName = segments[1]!.endsWith('.git') ? segments[1]!.slice(0, -4) : segments[1]!;
          const reply = handleGit(forge, {
            method,
            owner: segments[0]!,
            repo: repoName,
            tail: gitTail,
            query: url.searchParams,
            gitProtocol: typeof req.headers['git-protocol'] === 'string' ? (req.headers['git-protocol'] as string) : null,
            rawBody,
          });
          sendReply(res, reply, requestId);
          return;
        }

        sendReply(res, errorReply(404, 'Not Found'), requestId);
      } catch {
        // One bad request never takes the forge down.
        if (!res.headersSent) sendReply(res, errorReply(500, 'Internal Server Error'), requestId);
        else res.end();
      }
    })();
  });
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;
  return server;
}
