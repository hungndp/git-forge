// The git object layer: a content-addressed store of blobs, trees, commits and tags, with pack
// reading/writing, pkt-line framing, ancestry walks, tree diffs and three-way merges. Everything the
// forge's surfaces share, built only on node:crypto and node:zlib.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** The in-memory object store. One per forge; objects are immutable and shared by every repo. */
export class ObjectStore {
  private readonly objects = new Map<string, GitObj>();

  put(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putKnown(oid: string, type: ObjType, data: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }

  get(oid: string): GitObj | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }
}

// ---------------------------------------------------------------- commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommitData(tree: string, parents: readonly string[], author: string, committer: string, message: string): Buffer {
  let head = `tree ${tree}\n`;
  for (const parent of parents) head += `parent ${parent}\n`;
  head += `author ${author}\ncommitter ${committer}\n\n`;
  return Buffer.from(head + message, 'utf8');
}

/** Split an ident line ("Name <email> 1700000000 +0000") into its parts for the REST commit shape. */
export function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: new Date(0).toISOString() };
  const seconds = Number(match[3]);
  return { name: match[1]!, email: match[2]!, date: new Date(seconds * 1000).toISOString() };
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.toString('utf8', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTreeData(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface FlatEntry {
  mode: string;
  oid: string;
}

/** Every file (blob or link) under a tree, keyed by slash-joined path. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', out = new Map<string, FlatEntry>()): Map<string, FlatEntry> {
  const obj = store.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Build (and store) the tree hierarchy for a flat path map; answers the root tree oid. */
export function buildTreeFromFlat(store: ObjectStore, flat: ReadonlyMap<string, FlatEntry>): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      let next = node.dirs.get(part);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: build(dir) });
    return store.put('tree', buildTreeData(entries));
  };
  return build(root);
}

/** The blob oid at `path` in a tree, or undefined (also answers the tree oid for a directory path). */
export function lookupPath(store: ObjectStore, treeOid: string, path: string): { mode: string; oid: string; type: 'blob' | 'tree' } | undefined {
  if (path === '') return { mode: '40000', oid: treeOid, type: 'tree' };
  const parts = path.split('/');
  let current = treeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const obj = store.get(current);
    if (obj === undefined || obj.type !== 'tree') return undefined;
    const entry = parseTree(obj.data).find((candidate) => candidate.name === parts[i]);
    if (entry === undefined) return undefined;
    if (i === parts.length - 1) {
      return entry.mode === '40000' ? { mode: entry.mode, oid: entry.oid, type: 'tree' } : { mode: entry.mode, oid: entry.oid, type: 'blob' };
    }
    if (entry.mode !== '40000') return undefined;
    current = entry.oid;
  }
  return undefined;
}

// ---------------------------------------------------------------- tags

export function parseTagTarget(data: Buffer): string {
  const match = /^object ([0-9a-f]{40})$/m.exec(data.toString('utf8'));
  return match === null ? '' : match[1]!;
}

/** Follow tag objects to the commit they name; answers the input oid when it is not a tag. */
export function peelToCommit(store: ObjectStore, oid: string): string {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const obj = store.get(current);
    if (obj === undefined || obj.type !== 'tag') return current;
    const target = parseTagTarget(obj.data);
    if (target === '') return current;
    current = target;
  }
  return current;
}

// ---------------------------------------------------------------- ancestry

/** Every commit reachable from `tip`, mapped to its shortest distance (in parent hops) from the tip. */
export function ancestorsOf(store: ObjectStore, tip: string): Map<string, number> {
  const distances = new Map<string, number>();
  if (!isOid(tip) || tip === ZERO_OID) return distances;
  const queue: Array<{ oid: string; depth: number }> = [{ oid: peelToCommit(store, tip), depth: 0 }];
  while (queue.length > 0) {
    const { oid, depth } = queue.shift()!;
    if (distances.has(oid)) continue;
    const obj = store.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    distances.set(oid, depth);
    for (const parent of parseCommit(obj.data).parents) queue.push({ oid: parent, depth: depth + 1 });
  }
  return distances;
}

export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return ancestorsOf(store, descendant).has(ancestor);
}

/** A best common ancestor of two commits (the one minimising the summed distance), or null. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const fromA = ancestorsOf(store, a);
  const fromB = ancestorsOf(store, b);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [oid, depthA] of fromA) {
    const depthB = fromB.get(oid);
    if (depthB === undefined) continue;
    const score = depthA + depthB;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

/** Commits from `tip` in git-log order (newest generation first), at most `limit`. */
export function logFrom(store: ObjectStore, tip: string, limit: number): string[] {
  const distances = ancestorsOf(store, tip);
  return [...distances.entries()]
    .sort((x, y) => x[1] - y[1])
    .slice(0, limit)
    .map(([oid]) => oid);
}

// ---------------------------------------------------------------- object selection for fetch

/** Every object (commit, tree, blob, tag) reachable from the given tips. */
export function reachableObjects(store: ObjectStore, tips: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const tip of tips) if (isOid(tip) && tip !== ZERO_OID) stack.push(tip);
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = store.get(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      stack.push(info.tree);
      for (const parent of info.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target !== '') stack.push(target);
    }
  }
  return seen;
}

export interface FetchSelection {
  oids: Set<string>;
  /** Commits at the cut whose parents were left out (the shallow boundary to report). */
  boundary: string[];
  /** Client shallow commits that are now included and no longer on the boundary. */
  unshallow: string[];
}

/**
 * What a fetch sends. With a depth, the cut is absolute from the wants: generations below the depth
 * are included with their trees, the last included generation is the boundary. Without a depth,
 * everything reachable from the wants that is not reachable from the haves or the client's declared
 * shallow commits.
 */
export function selectFetchObjects(
  store: ObjectStore,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | null,
): FetchSelection {
  const oids = new Set<string>();
  const boundary: string[] = [];
  const unshallow: string[] = [];
  const wantCommits = wants.map((oid) => peelToCommit(store, oid)).filter((oid) => store.get(oid)?.type === 'commit');

  if (depth !== null && depth > 0) {
    const generations = new Map<string, number>();
    const queue: Array<{ oid: string; depth: number }> = wantCommits.map((oid) => ({ oid, depth: 0 }));
    const included: string[] = [];
    while (queue.length > 0) {
      const { oid, depth: at } = queue.shift()!;
      if (generations.has(oid) || at >= depth) continue;
      const obj = store.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      generations.set(oid, at);
      included.push(oid);
      for (const parent of parseCommit(obj.data).parents) queue.push({ oid: parent, depth: at + 1 });
    }
    // The client already holds its declared shallow commits and their trees: never re-send those,
    // so a fetch that asks for nothing new answers an empty pack.
    const held = new Set<string>();
    for (const shallow of clientShallow) {
      const obj = store.get(shallow);
      if (obj !== undefined && obj.type === 'commit') {
        held.add(shallow);
        for (const sub of reachableObjects(store, [parseCommit(obj.data).tree])) held.add(sub);
      }
    }
    for (const oid of included) {
      if (!held.has(oid)) oids.add(oid);
      const info = parseCommit(store.get(oid)!.data);
      for (const sub of reachableObjects(store, [info.tree])) if (!held.has(sub)) oids.add(sub);
      if (generations.get(oid) === depth - 1 && info.parents.length > 0) boundary.push(oid);
    }
    const boundarySet = new Set(boundary);
    for (const shallow of clientShallow) {
      if (generations.has(shallow) && !boundarySet.has(shallow)) unshallow.push(shallow);
    }
    // A want that names an annotated tag delivers the tag object too, when its commit is included.
    for (const want of wants) {
      const obj = store.get(want);
      if (obj !== undefined && obj.type === 'tag' && generations.has(peelToCommit(store, want))) oids.add(want);
    }
    return { oids, boundary, unshallow };
  }

  const excluded = reachableObjects(store, [...haves, ...clientShallow]);
  for (const oid of reachableObjects(store, wants)) {
    if (!excluded.has(oid)) oids.add(oid);
  }
  return { oids, boundary, unshallow };
}

// ---------------------------------------------------------------- tree diff and merge

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
}

function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

/** Line-level change counts between two blob bodies (an LCS diff; small inputs in practice). */
export function diffLineCounts(before: Buffer, after: Buffer): { additions: number; deletions: number } {
  const a = before.toString('utf8').split('\n');
  const b = after.toString('utf8').split('\n');
  if (a.length > 4000 || b.length > 4000) {
    return { additions: b.length, deletions: a.length };
  }
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = dp[j]!;
      dp[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(dp[j]!, dp[j - 1]!);
      diagonal = above;
    }
  }
  const common = dp[b.length]!;
  return { additions: b.length - common, deletions: a.length - common };
}

/** The file changes between two trees, GitHub's pull-request files view. */
export function diffTrees(store: ObjectStore, baseTree: string, headTree: string): FileChange[] {
  const base = flattenTree(store, baseTree);
  const head = flattenTree(store, headTree);
  const changes: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const before = base.get(path);
    const after = head.get(path);
    if (before === undefined && after !== undefined) {
      const obj = store.get(after.oid);
      changes.push({ path, status: 'added', additions: obj === undefined ? 0 : lineCount(obj.data), deletions: 0 });
    } else if (before !== undefined && after === undefined) {
      const obj = store.get(before.oid);
      changes.push({ path, status: 'removed', additions: 0, deletions: obj === undefined ? 0 : lineCount(obj.data) });
    } else if (before !== undefined && after !== undefined && before.oid !== after.oid) {
      const counts = diffLineCounts(store.get(before.oid)?.data ?? Buffer.alloc(0), store.get(after.oid)?.data ?? Buffer.alloc(0));
      changes.push({ path, status: 'modified', additions: counts.additions, deletions: counts.deletions });
    }
  }
  return changes;
}

/**
 * A file-level three-way merge of two trees against their common base. Both sides changing the same
 * path differently (or one deleting what the other changed) is a conflict; anything else merges.
 */
export function mergeTrees(
  store: ObjectStore,
  baseTree: string,
  ourTree: string,
  theirTree: string,
): { tree: string } | { conflict: true } {
  const base = flattenTree(store, baseTree);
  const ours = flattenTree(store, ourTree);
  const theirs = flattenTree(store, theirTree);
  const merged = new Map<string, FlatEntry>();
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const same = (x: FlatEntry | undefined, y: FlatEntry | undefined): boolean =>
    (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid && x.mode === y.mode);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (same(o, t)) {
      if (o !== undefined) merged.set(path, o);
    } else if (same(b, o)) {
      if (t !== undefined) merged.set(path, t);
    } else if (same(b, t)) {
      if (o !== undefined) merged.set(path, o);
    } else {
      return { conflict: true };
    }
  }
  return { tree: buildTreeFromFlat(store, merged) };
}

// ---------------------------------------------------------------- packs

function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODES[type]!;
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** A version-2 pack of the given objects, plain (no deltas), with its SHA-1 trailer. */
export function writePack(store: ObjectStore, oids: Iterable<string>): Buffer {
  const list = [...oids];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'utf8');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const oid of list) {
    const obj = store.get(oid);
    if (obj === undefined) continue;
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset]!;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // source size (the base is what it is)
  const targetSize = readVarint();
  const out: Buffer[] = [];
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) { copyOffset = delta[offset]!; offset += 1; }
      if (op & 0x02) { copyOffset |= delta[offset]! << 8; offset += 1; }
      if (op & 0x04) { copyOffset |= delta[offset]! << 16; offset += 1; }
      if (op & 0x08) { copyOffset |= delta[offset]! << 24; offset += 1; }
      if (op & 0x10) { copySize = delta[offset]!; offset += 1; }
      if (op & 0x20) { copySize |= delta[offset]! << 8; offset += 1; }
      if (op & 0x40) { copySize |= delta[offset]! << 16; offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
    } else if (op > 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize) throw new Error('delta result size mismatch');
  return result;
}

interface PackEntry {
  offset: number;
  type: ObjType;
  data?: Buffer;
  deltaBaseOid?: string;
  deltaBaseOffset?: number;
  delta?: Buffer;
}

/**
 * Read a pack into the store (resolving OFS/REF deltas against the pack itself and the store).
 * Throws on anything malformed; answers the object ids the pack carried.
 */
export function readPackInto(store: ObjectStore, pack: Buffer): string[] {
  if (pack.length < 12 + 20 || pack.toString('utf8', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const entries: PackEntry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = pack[offset]!;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset back to the base entry.
      let b = pack[offset]!;
      offset += 1;
      let back = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset]!;
        offset += 1;
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      const inflated = inflateSync(pack.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      entries.push({ offset: entryOffset, type: 'blob', deltaBaseOffset: entryOffset - back, delta: inflated.buffer });
      offset += inflated.engine.bytesWritten;
    } else if (typeCode === 7) {
      // REF_DELTA: the base's object id.
      const baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
      const inflated = inflateSync(pack.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      entries.push({ offset: entryOffset, type: 'blob', deltaBaseOid: baseOid, delta: inflated.buffer });
      offset += inflated.engine.bytesWritten;
    } else {
      const type = CODE_TYPES[typeCode];
      if (type === undefined) throw new Error(`pack object type ${typeCode}`);
      const inflated = inflateSync(pack.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      if (inflated.buffer.length !== size) throw new Error('pack object size mismatch');
      entries.push({ offset: entryOffset, type, data: inflated.buffer });
      offset += inflated.engine.bytesWritten;
    }
  }
  const byOffset = new Map<number, PackEntry>();
  for (const entry of entries) byOffset.set(entry.offset, entry);
  const resolved = new Map<PackEntry, { oid: string; type: ObjType; data: Buffer }>();
  const resolve = (entry: PackEntry): { oid: string; type: ObjType; data: Buffer } => {
    const done = resolved.get(entry);
    if (done !== undefined) return done;
    let result: { oid: string; type: ObjType; data: Buffer };
    if (entry.data !== undefined) {
      result = { oid: hashObject(entry.type, entry.data), type: entry.type, data: entry.data };
    } else {
      let base: { type: ObjType; data: Buffer } | undefined;
      if (entry.deltaBaseOid !== undefined) {
        base = store.get(entry.deltaBaseOid);
        if (base === undefined) {
          const carrier = entries.find((candidate) => candidate.data !== undefined && hashObject(candidate.type, candidate.data) === entry.deltaBaseOid);
          if (carrier !== undefined) base = resolve(carrier);
        }
      } else if (entry.deltaBaseOffset !== undefined) {
        const baseEntry = byOffset.get(entry.deltaBaseOffset);
        if (baseEntry !== undefined) base = resolve(baseEntry);
      }
      if (base === undefined || entry.delta === undefined) throw new Error('delta base is not available');
      const data = applyDelta(base.data, entry.delta);
      result = { oid: hashObject(base.type, data), type: base.type, data };
    }
    resolved.set(entry, result);
    return result;
  };
  const oids: string[] = [];
  for (const entry of entries) {
    const { oid, type, data } = resolve(entry);
    store.putKnown(oid, type, data);
    oids.push(oid);
  }
  return oids;
}

// ---------------------------------------------------------------- pkt-lines

export const PKT_MAX = 65520;

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > PKT_MAX) throw new Error('pkt-line too long');
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'utf8');
  return Buffer.concat([header, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'utf8');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'utf8');
}

export interface Pkt {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/** A cursor over a buffer of pkt-lines; `rest` is whatever follows the last full packet. */
export class PktReader {
  private offset = 0;
  private readonly buffer: Buffer;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  next(): Pkt | null {
    if (this.offset + 4 > this.buffer.length) return null;
    const header = this.buffer.toString('utf8', this.offset, this.offset + 4);
    if (!/^[0-9a-f]{4}$/.test(header)) throw new Error(`bad pkt-line header ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      this.offset += 4;
      return { kind: 'flush', payload: Buffer.alloc(0) };
    }
    if (length === 1) {
      this.offset += 4;
      return { kind: 'delim', payload: Buffer.alloc(0) };
    }
    if (length === 2 || length === 3) {
      this.offset += 4;
      return { kind: 'data', payload: Buffer.alloc(0) };
    }
    if (length < 4 || this.offset + length > this.buffer.length) throw new Error('truncated pkt-line');
    const payload = this.buffer.subarray(this.offset + 4, this.offset + length);
    this.offset += length;
    return { kind: 'data', payload };
  }

  rest(): Buffer {
    return this.buffer.subarray(this.offset);
  }

  get position(): number {
    return this.offset;
  }
}
