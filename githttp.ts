// Git smart HTTP: the v0 and v2 advertisements, ls-refs, fetch (with shallow/deepen semantics) and
// receive-pack with report-status. The wire dialect is the one the suite's client speaks: pkt-lines,
// side-band-64k framing for pack data, plain (undeltified) packs out, deltified packs accepted in.

import {
  PktReader,
  ZERO_OID,
  isAncestor,
  isOid,
  parseTagTarget,
  peelToCommit,
  pktDelim,
  pktFlush,
  pktLine,
  pktLineBand1,
  readPackInto,
  selectAndPackFetch,
} from './gitcore.ts';
import { Forge, type RepoRec } from './store.ts';
import { errorReply, rawReply, type Reply } from './web.ts';

const AGENT = 'makefun-forge/1.0';
const UPLOAD_CAPS_V0 = 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta';

export interface GitRequest {
  method: string;
  owner: string;
  repo: string;
  /** 'info/refs', 'git-upload-pack' or 'git-receive-pack'. */
  tail: string;
  query: URLSearchParams;
  /** The Git-Protocol header, when the client sent one. */
  gitProtocol: string | null;
  rawBody: Buffer;
}

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** Every advertised ref, HEAD first, then refs in name order, with peeled lines for annotated tags. */
function advertisedRefs(forge: Forge, repo: RepoRec): RefLine[] {
  const lines: RefLine[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    lines.push({ oid, name });
    const obj = forge.objects.get(oid);
    if (obj !== undefined && obj.type === 'tag') {
      lines.push({ oid: parseTagTarget(obj.data), name: `${name}^{}` });
    }
  }
  return lines;
}

function headLine(forge: Forge, repo: RepoRec): { oid: string; target: string } {
  return { oid: forge.headTip(repo) ?? ZERO_OID, target: forge.headTarget(repo) };
}

function infoRefs(forge: Forge, repo: RepoRec, service: string, version2: boolean): Reply {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  if (service === 'git-upload-pack' && version2) {
    parts.push(pktLine('version 2\n'));
    parts.push(pktLine(`agent=${AGENT}\n`));
    parts.push(pktLine('ls-refs=unborn\n'));
    parts.push(pktLine('fetch=shallow wait-for-done\n'));
    parts.push(pktLine('object-format=sha1\n'));
    parts.push(pktFlush());
    return rawReply(200, Buffer.concat(parts), 'application/x-git-upload-pack-advertisement');
  }
  const caps = service === 'git-upload-pack' ? `${UPLOAD_CAPS_V0} symref=HEAD:${forge.headTarget(repo)} agent=${AGENT}` : `${RECEIVE_CAPS} agent=${AGENT}`;
  const refs = advertisedRefs(forge, repo);
  const head = headLine(forge, repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${head.oid} HEAD\0${caps}\n`));
    for (const ref of refs) parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
  }
  parts.push(pktFlush());
  return rawReply(200, Buffer.concat(parts), `application/x-${service}-advertisement`);
}

// ---------------------------------------------------------------- ls-refs (protocol v2)

function lsRefs(forge: Forge, repo: RepoRec, reader: PktReader): Reply {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  // Argument lines follow the delimiter packet.
  for (let packet = reader.next(); packet !== null; packet = reader.next()) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const head = headLine(forge, repo);
  if (matches('HEAD')) {
    if (head.oid === ZERO_OID) {
      if (unborn) parts.push(pktLine(`unborn HEAD symref-target:${head.target}\n`));
    } else {
      parts.push(pktLine(symrefs ? `${head.oid} HEAD symref-target:${head.target}\n` : `${head.oid} HEAD\n`));
    }
  }
  for (const ref of advertisedRefs(forge, repo)) {
    if (ref.name.endsWith('^{}')) continue;
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const obj = forge.objects.get(ref.oid);
      if (obj !== undefined && obj.type === 'tag') line += ` peeled:${peelToCommit(forge.objects, ref.oid)}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return rawReply(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

// ---------------------------------------------------------------- fetch (v0 and v2)

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  if (pack.length === 0) {
    parts.push(pktLineBand1(Buffer.alloc(0)));
    return parts;
  }
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLineBand1(chunk));
  }
  return parts;
}

function fetchV2(forge: Forge, repo: RepoRec, reader: PktReader): Reply {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  const wantRefs: string[] = [];
  for (let packet = reader.next(); packet !== null; packet = reader.next()) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7).trim());
    else if (line.startsWith('want-ref ')) wantRefs.push(line.slice(9).trim());
    else if (line === 'done') args.done = true;
  }
  for (const ref of wantRefs) {
    const oid = ref === 'HEAD' ? forge.headTip(repo) : repo.refs.get(ref);
    if (oid !== undefined) args.wants.push(oid);
  }
  // A request without 'done' is one round of negotiation: the answer is the acknowledgments section
  // alone (no 'ready': the client answers with a 'done' request, and only that request is answered
  // with shallow-info and the packfile).
  if (!args.done) {
    const common = args.haves.filter((have) => forge.objects.has(have));
    const parts: Buffer[] = [pktLine('acknowledgments\n')];
    if (common.length === 0) parts.push(pktLine('NAK\n'));
    else for (const have of common) parts.push(pktLine(`ACK ${have}\n`));
    parts.push(pktFlush());
    return rawReply(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
  }
  const { selection, pack } = selectAndPackFetch(forge.objects, args.wants, args.haves, args.shallow, args.depth);
  // Protocol v2 response sections, separated by delim packets; one flush ends the response.
  const parts: Buffer[] = [];
  if (args.depth !== null || selection.boundary.length > 0 || selection.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.boundary) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(pktFlush());
  return rawReply(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function fetchV0(forge: Forge, repo: RepoRec, reader: PktReader): Reply {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  let section = 0;
  for (let packet = reader.next(); packet !== null; packet = reader.next()) {
    if (packet.kind === 'flush') {
      section += 1;
      if (section >= 2) break;
      continue;
    }
    if (packet.kind === 'delim') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim();
      args.wants.push(rest.split(/[\0 ]/)[0]!);
    } else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line === 'done') args.done = true;
  }
  const { selection, pack } = selectAndPackFetch(forge.objects, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  for (const oid of selection.boundary) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const common = args.haves.filter((have) => forge.objects.has(have));
  if (common.length === 0) parts.push(pktLine('NAK\n'));
  else parts.push(pktLine(`ACK ${common[0]}\n`));
  parts.push(...sidebandPack(pack));
  parts.push(pktFlush());
  return rawReply(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function uploadPack(forge: Forge, repo: RepoRec, rawBody: Buffer): Reply {
  const reader = new PktReader(rawBody);
  const first = reader.next();
  if (first === null || first.kind !== 'data') return errorReply(400, 'Bad upload-pack request');
  const firstLine = first.payload.toString('utf8').replace(/\n$/, '');
  if (firstLine === 'command=ls-refs') return lsRefs(forge, repo, reader);
  if (firstLine === 'command=fetch') return fetchV2(forge, repo, reader);
  // Otherwise the body is a v0 request whose first packet is a want line: re-read from the start.
  return fetchV0(forge, repo, new PktReader(rawBody));
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(forge: Forge, repo: RepoRec, rawBody: Buffer): Reply {
  const reader = new PktReader(rawBody);
  const commands: PushCommand[] = [];
  let sawFlush = false;
  for (let packet = reader.next(); packet !== null; packet = reader.next()) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length >= 3 && isOid(parts[0]) && isOid(parts[1])) {
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
    }
  }
  if (!sawFlush && commands.length === 0) return errorReply(400, 'Bad receive-pack request');
  const pack = reader.rest();

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      readPackInto(forge.objects, pack);
    } catch (error) {
      unpackOk = false;
      unpackDetail = `error ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const report: string[] = [`unpack ${unpackDetail}\n`];
  for (const command of commands) {
    const reason = applyPushCommand(forge, repo, command, unpackOk);
    report.push(reason === null ? `ok ${command.ref}\n` : `ng ${command.ref} ${reason}\n`);
  }
  // The report-status stream is itself pkt-lined inside band 1: each band-1 packet carries one
  // inner pkt-line, the inner stream ends with its own flush inside band 1, and a final outer
  // flush closes the sideband stream.
  const parts: Buffer[] = report.map((line) => pktLineBand1(pktLine(line)));
  parts.push(pktLineBand1(pktFlush()));
  parts.push(pktFlush());
  return rawReply(200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
}

/** Validate and apply one push command; answers the refusal reason, or null when applied. */
function applyPushCommand(forge: Forge, repo: RepoRec, command: PushCommand, unpackOk: boolean): string | null {
  if (!command.ref.startsWith('refs/')) return 'invalid ref';
  if (!unpackOk) return 'unpack failed';
  const current = repo.refs.get(command.ref);
  if (command.newOid === ZERO_OID) {
    // A delete: the old value must match what the ref holds (a missing ref with a zero old is a no-op).
    if (current === undefined) return command.oldOid === ZERO_OID ? null : 'reference not found';
    if (current !== command.oldOid) return 'reference already exists';
    repo.refs.delete(command.ref);
    return null;
  }
  const target = forge.objects.get(command.newOid);
  if (target === undefined) return 'unknown object';
  if (command.oldOid === ZERO_OID) {
    if (current !== undefined) return 'reference already exists';
    repo.refs.set(command.ref, command.newOid);
    return null;
  }
  if (current === undefined) return 'reference not found';
  if (current !== command.oldOid) return 'stale info';
  if (command.ref.startsWith('refs/heads/') && target.type === 'commit') {
    if (!isAncestor(forge.objects, command.oldOid, command.newOid)) return 'non-fast-forward';
  }
  repo.refs.set(command.ref, command.newOid);
  return null;
}

// ---------------------------------------------------------------- entry point

export function handleGit(forge: Forge, req: GitRequest): Reply {
  const repo = forge.getRepo(req.owner, req.repo);
  if (req.tail === 'info/refs') {
    if (req.method !== 'GET') return errorReply(405, 'Method Not Allowed');
    if (repo === undefined) return errorReply(404, 'Not Found');
    const service = req.query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return errorReply(400, 'Bad service');
    const version2 = (req.gitProtocol ?? '').includes('version=2');
    return infoRefs(forge, repo, service, version2);
  }
  if (repo === undefined) return errorReply(404, 'Not Found');
  if (req.method !== 'POST') return errorReply(405, 'Method Not Allowed');
  try {
    if (req.tail === 'git-upload-pack') return uploadPack(forge, repo, req.rawBody);
    if (req.tail === 'git-receive-pack') return receivePack(forge, repo, req.rawBody);
  } catch {
    // A malformed body earns an error status, never a dead server.
    return errorReply(400, 'Bad Request');
  }
  return errorReply(404, 'Not Found');
}
