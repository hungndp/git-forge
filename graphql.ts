// The GraphQL v4 surface: a hand-written parser and executor for the subset gh speaks — named
// operations, variables, aliases, inline fragments, input objects, Relay connections with cursor
// pagination, the five mutations the suite performs, node(id:) global-id round-trips, batched
// operations, and the __type introspection the schema checks read.

import { diffTrees, mergeBase, parseCommit } from './gitcore.ts';
import { Forge, type CommentRec, type IssueRec, type PullRec, type RepoRec, type UserRec } from './store.ts';
import { INVALID_JSON, isRecord, jsonReply, parseJsonBody, type Reply } from './web.ts';

// ---------------------------------------------------------------- tokenizer

interface Tok {
  t: string;
  v: string;
}

const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (src.startsWith('...', i)) {
      toks.push({ t: '...', v: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      toks.push({ t: c, v: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        toks.push({ t: 'string', v: src.slice(i + 3, end === -1 ? src.length : end) });
        i = end === -1 ? src.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const esc = src[j + 1]!;
          if (esc === 'u') {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += ESCAPES[esc] ?? esc;
            j += 2;
          }
        } else {
          out += src[j];
          j += 1;
        }
      }
      toks.push({ t: 'string', v: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i))!;
      toks.push({ t: match[0].includes('.') || /[eE]/.test(match[0]) ? 'float' : 'int', v: match[0] });
      i += match[0].length;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(src.slice(i))!;
      toks.push({ t: 'name', v: match[0] });
      i += match[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in the GraphQL document`);
  }
  toks.push({ t: 'eof', v: '' });
  return toks;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Map<string, ValueNode> };

type FieldSel = { kind: 'field'; name: string; alias: string | null; args: Map<string, ValueNode>; selections: SelNode[] };
type SelNode = FieldSel | { kind: 'inline'; typeCondition: string; selections: SelNode[] } | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  varDefaults: Map<string, ValueNode>;
  selections: SelNode[];
}

interface Fragment {
  typeCondition: string;
  selections: SelNode[];
}

class Parser {
  private pos = 0;
  private readonly toks: Tok[];

  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok {
    return this.toks[this.pos]!;
  }

  private next(): Tok {
    const tok = this.toks[this.pos]!;
    this.pos += 1;
    return tok;
  }

  private expect(t: string): Tok {
    const tok = this.next();
    if (tok.t !== t) throw new Error(`expected ${t}, found ${tok.t} ${JSON.stringify(tok.v)}`);
    return tok;
  }

  private skipDirectives(): void {
    while (this.peek().t === '@') {
      this.next();
      this.expect('name');
      if (this.peek().t === '(') this.parseArguments();
    }
  }

  private parseTypeRef(): void {
    if (this.peek().t === '[') {
      this.next();
      this.parseTypeRef();
      this.expect(']');
    } else {
      this.expect('name');
    }
    if (this.peek().t === '!') this.next();
  }

  private parseArguments(): Map<string, ValueNode> {
    const args = new Map<string, ValueNode>();
    this.expect('(');
    while (this.peek().t !== ')') {
      const name = this.expect('name').v;
      this.expect(':');
      args.set(name, this.parseValue());
    }
    this.expect(')');
    return args;
  }

  private parseValue(): ValueNode {
    const tok = this.next();
    switch (tok.t) {
      case '$':
        return { kind: 'variable', name: this.expect('name').v };
      case 'string':
        return { kind: 'string', value: tok.v };
      case 'int':
        return { kind: 'int', value: parseInt(tok.v, 10) };
      case 'float':
        return { kind: 'float', value: parseFloat(tok.v) };
      case 'name':
        if (tok.v === 'true') return { kind: 'boolean', value: true };
        if (tok.v === 'false') return { kind: 'boolean', value: false };
        if (tok.v === 'null') return { kind: 'null' };
        return { kind: 'enum', value: tok.v };
      case '[': {
        const items: ValueNode[] = [];
        while (this.peek().t !== ']') items.push(this.parseValue());
        this.expect(']');
        return { kind: 'list', items };
      }
      case '{': {
        const fields = new Map<string, ValueNode>();
        while (this.peek().t !== '}') {
          const name = this.expect('name').v;
          this.expect(':');
          fields.set(name, this.parseValue());
        }
        this.expect('}');
        return { kind: 'object', fields };
      }
      default:
        throw new Error(`unexpected value token ${tok.t}`);
    }
  }

  private parseSelectionSet(): SelNode[] {
    const selections: SelNode[] = [];
    this.expect('{');
    while (this.peek().t !== '}') selections.push(this.parseSelection());
    this.expect('}');
    return selections;
  }

  private parseSelection(): SelNode {
    if (this.peek().t === '...') {
      this.next();
      if (this.peek().t === 'name' && this.peek().v === 'on') {
        this.next();
        const typeCondition = this.expect('name').v;
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      const name = this.expect('name').v;
      this.skipDirectives();
      return { kind: 'spread', name };
    }
    const first = this.expect('name').v;
    let alias: string | null = null;
    let name = first;
    if (this.peek().t === ':') {
      this.next();
      alias = first;
      name = this.expect('name').v;
    }
    const args = this.peek().t === '(' ? this.parseArguments() : new Map<string, ValueNode>();
    this.skipDirectives();
    const selections = this.peek().t === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', name, alias, args, selections };
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, Fragment> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, Fragment>();
    while (this.peek().t !== 'eof') {
      const tok = this.peek();
      if (tok.t === '{') {
        operations.push({ type: 'query', name: null, varDefaults: new Map(), selections: this.parseSelectionSet() });
      } else if (tok.t === 'name' && (tok.v === 'query' || tok.v === 'mutation' || tok.v === 'subscription')) {
        this.next();
        const name = this.peek().t === 'name' ? this.next().v : null;
        const varDefaults = new Map<string, ValueNode>();
        if (this.peek().t === '(') {
          this.next();
          while (this.peek().t !== ')') {
            this.expect('$');
            const varName = this.expect('name').v;
            this.expect(':');
            this.parseTypeRef();
            if (this.peek().t === '=') {
              this.next();
              varDefaults.set(varName, this.parseValue());
            }
            this.skipDirectives();
          }
          this.expect(')');
        }
        this.skipDirectives();
        operations.push({ type: tok.v === 'mutation' ? 'mutation' : 'query', name, varDefaults, selections: this.parseSelectionSet() });
      } else if (tok.t === 'name' && tok.v === 'fragment') {
        this.next();
        const fragName = this.expect('name').v;
        const on = this.expect('name');
        if (on.v !== 'on') throw new Error('fragment without on');
        const typeCondition = this.expect('name').v;
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selections: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${tok.t} ${JSON.stringify(tok.v)} in the document`);
      }
    }
    return { operations, fragments };
  }
}

// ---------------------------------------------------------------- values

function resolveValue(node: ValueNode, variables: Record<string, unknown>, defaults: Map<string, ValueNode>): unknown {
  switch (node.kind) {
    case 'variable': {
      if (node.name in variables) return variables[node.name];
      const fallback = defaults.get(node.name);
      return fallback === undefined ? undefined : resolveValue(fallback, variables, defaults);
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables, defaults));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of node.fields) out[key] = resolveValue(value, variables, defaults);
      return out;
    }
  }
}

// ---------------------------------------------------------------- schema tables

const OBJECT_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', 'rateLimit', 'organization', 'user'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'url', 'createdAt', 'updatedAt', 'isSiteAdmin'],
  Organization: ['id', 'login', 'name', 'email', 'avatarUrl', 'url', 'createdAt', 'updatedAt'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'isFork', 'isArchived',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasProjectsEnabled', 'hasWikiEnabled',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'label', 'labels', 'createdAt', 'updatedAt', 'url',
    'stargazerCount', 'forkCount', 'primaryLanguage',
  ],
  Issue: [
    'id', 'number', 'title', 'body', 'state', 'author', 'labels', 'comments', 'repository',
    'createdAt', 'updatedAt', 'closedAt', 'closed', 'url', 'participants',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'files', 'author', 'repository', 'createdAt', 'updatedAt', 'closedAt', 'closed',
    'mergedAt', 'mergeCommit', 'additions', 'deletions', 'changedFiles', 'url', 'comments', 'isDraft',
  ],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Ref: ['name', 'prefix', 'target'],
  Commit: ['oid', 'message', 'messageHeadline', 'committedDate', 'author', 'tree'],
  Tree: ['oid', 'entries'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  Label: ['id', 'name', 'color', 'description'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestFileEdge: ['node', 'cursor'],
  IssueCommentEdge: ['node', 'cursor'],
  LabelEdge: ['node', 'cursor'],
  SearchResultItemConnection: ['nodes', 'edges', 'pageInfo', 'issueCount'],
  RateLimit: ['limit', 'cost', 'remaining', 'resetAt', 'used'],
};

const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  SearchType: ['DISCUSSION', 'ISSUE', 'REPOSITORY', 'USER'],
  PullRequestFileChangeType: ['ADDED', 'DELETED', 'MODIFIED', 'RENAMED'],
};

// ---------------------------------------------------------------- global ids

function gid(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

function decodeGid(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const split = text.indexOf(':');
    if (split === -1) return null;
    return { type: text.slice(0, split), key: text.slice(split + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- execution

interface GObject {
  __type: string;
  data: unknown;
}

type GValue = null | string | number | boolean | GObject | GValue[];

function obj(type: string, data: unknown): GObject {
  return { __type: type, data };
}

class FieldError extends Error {}

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  defaults: Map<string, ValueNode>;
  fragments: Map<string, Fragment>;
  errors: Array<{ message: string }>;
}

function argsOf(ctx: Ctx, field: FieldSel): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of field.args) out[key] = resolveValue(value, ctx.variables, ctx.defaults);
  return out;
}

interface ConnData {
  items: GObject[];
  total: number;
  hasNext: boolean;
  endCursor: string | null;
  startCursor: string | null;
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function connection(type: string, all: GObject[], args: Record<string, unknown>): GObject {
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : all.length;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const decoded = Buffer.from(args.after, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    if (match !== null) start = Number(match[1]) + 1;
  }
  const items = all.slice(start, start + first);
  const data: ConnData = {
    items,
    total: all.length,
    hasNext: start + items.length < all.length,
    endCursor: items.length > 0 ? cursorFor(start + items.length - 1) : null,
    startCursor: items.length > 0 ? cursorFor(start) : null,
  };
  return obj(type, data);
}

function repoById(forge: Forge, id: number): RepoRec | undefined {
  for (const repo of forge.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function issueObject(repo: RepoRec, issue: IssueRec): GObject {
  return obj('Issue', { repo, issue });
}

function pullObject(repo: RepoRec, pull: PullRec): GObject {
  return obj('PullRequest', { repo, pull });
}

function commentObject(repo: RepoRec, issueNumber: number, comment: CommentRec): GObject {
  return obj('IssueComment', { repo, issueNumber, comment });
}

function nodeById(ctx: Ctx, id: string): GValue {
  const decoded = decodeGid(id);
  if (decoded === null) return null;
  const forge = ctx.forge;
  switch (decoded.type) {
    case 'Repository': {
      const repo = repoById(forge, Number(decoded.key));
      return repo === undefined ? null : obj('Repository', repo);
    }
    case 'Issue': {
      const [repoId, number] = decoded.key.split(':').map(Number);
      const repo = repoById(forge, repoId ?? -1);
      const issue = repo?.issues.get(number ?? -1);
      return repo === undefined || issue === undefined ? null : issueObject(repo, issue);
    }
    case 'PullRequest': {
      const [repoId, number] = decoded.key.split(':').map(Number);
      const repo = repoById(forge, repoId ?? -1);
      const pull = repo?.pulls.get(number ?? -1);
      return repo === undefined || pull === undefined ? null : pullObject(repo, pull);
    }
    case 'User': {
      for (const user of forge.users.values()) if (user.id === Number(decoded.key)) return obj('User', user);
      return null;
    }
    default:
      return null;
  }
}

interface PullFileData {
  path: string;
  additions: number;
  deletions: number;
  changeType: string;
}

function pullFileData(forge: Forge, repo: RepoRec, pull: PullRec): PullFileData[] {
  const headTip = forge.branchTip(repo, pull.headRef);
  const baseTip = forge.branchTip(repo, pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return [];
  const base = mergeBase(forge.objects, baseTip, headTip) ?? baseTip;
  const baseTree = parseCommit(forge.objects.get(base)!.data).tree;
  const headTree = parseCommit(forge.objects.get(headTip)!.data).tree;
  return diffTrees(forge.objects, baseTree, headTree).map((change) => ({
    path: change.path,
    additions: change.additions,
    deletions: change.deletions,
    changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'DELETED' : 'MODIFIED',
  }));
}

function resolveField(ctx: Ctx, typeName: string, data: unknown, fieldName: string, args: Record<string, unknown>): GValue {
  const forge = ctx.forge;

  // Introspection types resolve from their own tables.
  if (typeName === '__Type') {
    const { name } = data as { name: string };
    switch (fieldName) {
      case 'name': return name;
      case 'kind': return ENUM_VALUES[name] !== undefined ? 'ENUM' : 'OBJECT';
      case 'description': return null;
      case 'fields': return (OBJECT_FIELDS[name] ?? []).map((field) => obj('__Field', { name: field }));
      case 'enumValues': return ENUM_VALUES[name] === undefined ? null : ENUM_VALUES[name]!.map((value) => obj('__EnumValue', { name: value }));
      case 'possibleTypes': return null;
      case 'inputFields': return null;
      case 'ofType': return null;
      case 'specifiedByURL': return null;
      default: break;
    }
    throw new FieldError(`Field '${fieldName}' doesn't exist on type '__Type'`);
  }
  if (typeName === '__Field') {
    const { name } = data as { name: string };
    switch (fieldName) {
      case 'name': return name;
      case 'description': return null;
      case 'args': return [];
      case 'type': return obj('__Type', { name: 'String' });
      case 'isDeprecated': return false;
      case 'deprecationReason': return null;
      default: break;
    }
    throw new FieldError(`Field '${fieldName}' doesn't exist on type '__Field'`);
  }
  if (typeName === '__EnumValue') {
    const { name } = data as { name: string };
    switch (fieldName) {
      case 'name': return name;
      case 'description': return null;
      case 'isDeprecated': return false;
      case 'deprecationReason': return null;
      default: break;
    }
    throw new FieldError(`Field '${fieldName}' doesn't exist on type '__EnumValue'`);
  }
  if (typeName === '__Schema') {
    switch (fieldName) {
      case 'queryType': return obj('__Type', { name: 'Query' });
      case 'mutationType': return obj('__Type', { name: 'Mutation' });
      case 'subscriptionType': return null;
      case 'types': return [...Object.keys(OBJECT_FIELDS), ...Object.keys(ENUM_VALUES)].map((name) => obj('__Type', { name }));
      case 'directives': return [];
      case 'description': return null;
      default: break;
    }
    throw new FieldError(`Field '${fieldName}' doesn't exist on type '__Schema'`);
  }

  switch (typeName) {
    case 'Query': {
      switch (fieldName) {
        case 'viewer':
          return obj('User', forge.viewer);
        case 'repository': {
          const repo = forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
          return repo === undefined ? null : obj('Repository', repo);
        }
        case 'node':
          return nodeById(ctx, String(args.id ?? ''));
        case 'user': {
          const user = forge.users.get(String(args.login ?? ''));
          return user === undefined ? null : obj('User', user);
        }
        case 'organization': {
          const user = forge.users.get(String(args.login ?? ''));
          return user === undefined ? null : obj('Organization', user);
        }
        case 'search':
          return obj('SearchResultItemConnection', { items: [], total: 0, hasNext: false, endCursor: null, startCursor: null } satisfies ConnData);
        case 'rateLimit':
          return obj('RateLimit', {});
        default:
          break;
      }
      break;
    }
    case 'Mutation': {
      switch (fieldName) {
        case 'createIssue': {
          const input = isRecord(args.input) ? args.input : {};
          const decoded = decodeGid(String(input.repositoryId ?? ''));
          const repo = decoded === null ? undefined : repoById(forge, Number(decoded.key));
          if (repo === undefined) throw new FieldError('createIssue: the repository does not exist');
          const issue = forge.createIssue(repo, { title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : '' }, forge.viewer.login);
          return obj('CreateIssuePayload', { issue: issueObject(repo, issue), clientMutationId: input.clientMutationId ?? null });
        }
        case 'closeIssue': {
          const input = isRecord(args.input) ? args.input : {};
          const target = nodeById(ctx, String(input.issueId ?? ''));
          if (target === null || (target as GObject).__type !== 'Issue') throw new FieldError('closeIssue: the issue does not exist');
          const { repo, issue } = (target as GObject).data as { repo: RepoRec; issue: IssueRec };
          issue.state = 'closed';
          issue.closedAt = forge.tick();
          issue.updatedAt = issue.closedAt;
          return obj('CloseIssuePayload', { issue: issueObject(repo, issue), clientMutationId: input.clientMutationId ?? null });
        }
        case 'createPullRequest': {
          const input = isRecord(args.input) ? args.input : {};
          const decoded = decodeGid(String(input.repositoryId ?? ''));
          const repo = decoded === null ? undefined : repoById(forge, Number(decoded.key));
          if (repo === undefined) throw new FieldError('createPullRequest: the repository does not exist');
          const head = String(input.headRefName ?? '');
          const base = String(input.baseRefName ?? '');
          if (forge.branchTip(repo, head) === undefined) throw new FieldError(`createPullRequest: head branch '${head}' does not exist`);
          if (forge.branchTip(repo, base) === undefined) throw new FieldError(`createPullRequest: base branch '${base}' does not exist`);
          const pull = forge.createPull(
            repo,
            { title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : '', headRef: head, baseRef: base },
            forge.viewer.login,
          );
          return obj('CreatePullRequestPayload', { pullRequest: pullObject(repo, pull), clientMutationId: input.clientMutationId ?? null });
        }
        case 'mergePullRequest': {
          const input = isRecord(args.input) ? args.input : {};
          const target = nodeById(ctx, String(input.pullRequestId ?? ''));
          if (target === null || (target as GObject).__type !== 'PullRequest') throw new FieldError('mergePullRequest: the pull request does not exist');
          const { repo, pull } = (target as GObject).data as { repo: RepoRec; pull: PullRec };
          const method = String(input.mergeMethod ?? 'SQUASH').toUpperCase();
          if (!pull.merged) {
            const sha = forge.mergePull(repo, pull, method === 'MERGE' ? 'merge' : 'squash');
            if (sha === null) throw new FieldError('mergePullRequest: the pull request is not mergeable');
          }
          return obj('MergePullRequestPayload', { pullRequest: pullObject(repo, pull), clientMutationId: input.clientMutationId ?? null });
        }
        case 'addComment': {
          const input = isRecord(args.input) ? args.input : {};
          const target = nodeById(ctx, String(input.subjectId ?? ''));
          if (target === null) throw new FieldError('addComment: the subject does not exist');
          const targetData = (target as GObject).data as { repo: RepoRec; issue?: IssueRec; pull?: PullRec };
          const number = targetData.issue?.number ?? targetData.pull?.number;
          if (number === undefined) throw new FieldError('addComment: the subject does not accept comments');
          const comment = forge.addComment(targetData.repo, number, String(input.body ?? ''), forge.viewer.login);
          return obj('AddCommentPayload', {
            commentEdge: obj('CommentEdge', { node: commentObject(targetData.repo, number, comment), cursor: cursorFor(0) }),
            subject: target,
            clientMutationId: input.clientMutationId ?? null,
          });
        }
        default:
          break;
      }
      break;
    }
    case 'User':
    case 'Organization': {
      const user = data as UserRec;
      switch (fieldName) {
        case 'id': return gid('User', String(user.id));
        case 'login': return user.login;
        case 'name': return user.name;
        case 'email': return user.email;
        case 'avatarUrl': return '';
        case 'url': return `https://forge.invalid/${user.login}`;
        case 'createdAt': return '2026-01-01T00:00:00Z';
        case 'updatedAt': return '2026-01-01T00:00:00Z';
        case 'isSiteAdmin': return false;
        default: break;
      }
      break;
    }
    case 'Repository': {
      const repo = data as RepoRec;
      switch (fieldName) {
        case 'id': return gid('Repository', String(repo.id));
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return obj(forge.users.get(repo.owner)?.type === 'Organization' ? 'Organization' : 'User', forge.userOrViewer(repo.owner));
        case 'description': return repo.description === '' ? null : repo.description;
        case 'isPrivate': return repo.isPrivate;
        case 'isFork': return false;
        case 'isArchived': return false;
        case 'defaultBranchRef': {
          const tip = forge.headTip(repo);
          return tip === undefined ? null : obj('Ref', { name: repo.defaultBranch, oid: tip });
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'hasProjectsEnabled': return true;
        case 'hasWikiEnabled': return true;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : issueObject(repo, issue);
        }
        case 'issues': {
          let list = [...repo.issues.values()];
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          if (states !== null) list = list.filter((issue) => states.includes(issue.state.toUpperCase()));
          const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
          list.sort((a, b) => a.number - b.number);
          if (orderBy !== null && orderBy.direction === 'DESC') list.reverse();
          return connection('IssueConnection', list.map((issue) => issueObject(repo, issue)), args);
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull === undefined ? null : pullObject(repo, pull);
        }
        case 'pullRequests': {
          let list = [...repo.pulls.values()];
          const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
          list = list.filter((pull) => {
            const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
            return states.includes(state) || (pull.merged && states.includes('CLOSED'));
          });
          list.sort((a, b) => a.number - b.number);
          return connection('PullRequestConnection', list.map((pull) => pullObject(repo, pull)), args);
        }
        case 'label': {
          const label = repo.labels.get(String(args.name ?? ''));
          return label === undefined ? null : obj('Label', { id: gid('Label', `${repo.id}:${label.name}`), name: label.name, color: label.color, description: label.description });
        }
        case 'labels':
          return connection('LabelConnection', [...repo.labels.values()].map((label) => obj('Label', { id: gid('Label', `${repo.id}:${label.name}`), name: label.name, color: label.color, description: label.description })), args);
        case 'createdAt': return repo.createdAt;
        case 'updatedAt': return repo.updatedAt;
        case 'url': return `https://forge.invalid/${repo.owner}/${repo.name}`;
        case 'stargazerCount': return 0;
        case 'forkCount': return 0;
        case 'primaryLanguage': return null;
        default: break;
      }
      break;
    }
    case 'Issue': {
      const { repo, issue } = data as { repo: RepoRec; issue: IssueRec };
      switch (fieldName) {
        case 'id': return gid('Issue', `${repo.id}:${issue.number}`);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'author': return obj('User', forge.userOrViewer(issue.userLogin));
        case 'labels':
          return connection('LabelConnection', issue.labels.map((name) => obj('Label', { id: gid('Label', `${repo.id}:${name}`), name, color: repo.labels.get(name)?.color ?? 'ededed', description: repo.labels.get(name)?.description ?? null })), args);
        case 'comments':
          return connection('IssueCommentConnection', (repo.comments.get(issue.number) ?? []).map((comment) => commentObject(repo, issue.number, comment)), args);
        case 'repository': return obj('Repository', repo);
        case 'createdAt': return issue.createdAt;
        case 'updatedAt': return issue.updatedAt;
        case 'closedAt': return issue.closedAt;
        case 'closed': return issue.state === 'closed';
        case 'url': return `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
        case 'participants':
          return connection('IssueCommentConnection', [], args);
        default: break;
      }
      break;
    }
    case 'PullRequest': {
      const { repo, pull } = data as { repo: RepoRec; pull: PullRec };
      switch (fieldName) {
        case 'id': return gid('PullRequest', `${repo.id}:${pull.number}`);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'mergeable': return pull.merged ? 'UNKNOWN' : forge.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRef': {
          const tip = forge.branchTip(repo, pull.headRef);
          return tip === undefined ? null : obj('Ref', { name: pull.headRef, oid: tip });
        }
        case 'baseRef': {
          const tip = forge.branchTip(repo, pull.baseRef);
          return tip === undefined ? null : obj('Ref', { name: pull.baseRef, oid: tip });
        }
        case 'files':
          return connection('PullRequestFileConnection', pullFileData(forge, repo, pull).map((file) => obj('PullRequestFile', file)), args);
        case 'author': return obj('User', forge.userOrViewer(pull.userLogin));
        case 'repository': return obj('Repository', repo);
        case 'createdAt': return pull.createdAt;
        case 'updatedAt': return pull.updatedAt;
        case 'closedAt': return pull.merged ? pull.mergedAt : pull.state === 'closed' ? pull.updatedAt : null;
        case 'closed': return pull.state === 'closed';
        case 'mergedAt': return pull.mergedAt;
        case 'mergeCommit': return pull.mergeCommitSha === null ? null : obj('Commit', { oid: pull.mergeCommitSha });
        case 'additions': return pullFileData(forge, repo, pull).reduce((sum, file) => sum + file.additions, 0);
        case 'deletions': return pullFileData(forge, repo, pull).reduce((sum, file) => sum + file.deletions, 0);
        case 'changedFiles': return pullFileData(forge, repo, pull).length;
        case 'url': return `https://forge.invalid/${repo.owner}/${repo.name}/pulls/${pull.number}`;
        case 'comments':
          return connection('IssueCommentConnection', (repo.comments.get(pull.number) ?? []).map((comment) => commentObject(repo, pull.number, comment)), args);
        case 'isDraft': return false;
        default: break;
      }
      break;
    }
    case 'IssueComment': {
      const { comment } = data as { repo: RepoRec; issueNumber: number; comment: CommentRec };
      switch (fieldName) {
        case 'id': return gid('IssueComment', String(comment.id));
        case 'body': return comment.body;
        case 'author': return obj('User', forge.userOrViewer(comment.userLogin));
        case 'createdAt': return comment.createdAt;
        case 'updatedAt': return comment.updatedAt;
        case 'url': return '';
        default: break;
      }
      break;
    }
    case 'Ref': {
      const ref = data as { name: string; oid: string };
      switch (fieldName) {
        case 'name': return ref.name;
        case 'prefix': return 'refs/heads/';
        case 'target': return obj('Commit', { oid: ref.oid });
        default: break;
      }
      break;
    }
    case 'Commit': {
      const commit = data as { oid: string };
      switch (fieldName) {
        case 'oid': return commit.oid;
        case 'message': {
          const found = forge.objects.get(commit.oid);
          return found === undefined ? '' : parseCommit(found.data).message;
        }
        case 'messageHeadline': {
          const found = forge.objects.get(commit.oid);
          return found === undefined ? '' : (parseCommit(found.data).message.split('\n')[0] ?? '');
        }
        case 'committedDate': return '2026-01-01T00:00:00Z';
        case 'author': return null;
        case 'tree': {
          const found = forge.objects.get(commit.oid);
          return found === undefined ? null : obj('Tree', { oid: parseCommit(found.data).tree });
        }
        default: break;
      }
      break;
    }
    case 'Tree': {
      const tree = data as { oid: string };
      if (fieldName === 'oid') return tree.oid;
      if (fieldName === 'entries') return [];
      break;
    }
    case 'Label': {
      const label = data as { id: string; name: string; color: string; description: string | null };
      switch (fieldName) {
        case 'id': return label.id;
        case 'name': return label.name;
        case 'color': return label.color;
        case 'description': return label.description;
        default: break;
      }
      break;
    }
    case 'PullRequestFile': {
      const file = data as PullFileData;
      switch (fieldName) {
        case 'path': return file.path;
        case 'additions': return file.additions;
        case 'deletions': return file.deletions;
        case 'changeType': return file.changeType;
        default: break;
      }
      break;
    }
    case 'RateLimit': {
      switch (fieldName) {
        case 'limit': return 5000;
        case 'cost': return 1;
        case 'remaining': return 4999;
        case 'used': return 1;
        case 'resetAt': return '2027-01-01T00:00:00Z';
        default: break;
      }
      break;
    }
    default:
      break;
  }

  // Connection-shaped types share one resolver.
  if (typeName.endsWith('Connection')) {
    const conn = data as ConnData;
    switch (fieldName) {
      case 'nodes': return conn.items;
      case 'edges': return conn.items.map((node, index) => obj(typeName.replace('Connection', 'Edge'), { node, cursor: cursorFor(index) }));
      case 'pageInfo': return obj('PageInfo', conn);
      case 'totalCount': return conn.total;
      case 'issueCount': return conn.total;
      default: break;
    }
  }
  if (typeName === 'PageInfo') {
    const conn = data as ConnData;
    switch (fieldName) {
      case 'hasNextPage': return conn.hasNext;
      case 'hasPreviousPage': return false;
      case 'startCursor': return conn.startCursor;
      case 'endCursor': return conn.endCursor;
      default: break;
    }
  }
  if (typeName.endsWith('Payload')) {
    const payload = data as Record<string, unknown>;
    if (fieldName === 'clientMutationId') return (payload.clientMutationId as GValue) ?? null;
    const value = payload[fieldName];
    if (value !== undefined) return value as GValue;
  }
  if (typeName.endsWith('Edge')) {
    const edge = data as { node: GObject; cursor: string };
    if (fieldName === 'node') return edge.node;
    if (fieldName === 'cursor') return edge.cursor;
  }
  throw new FieldError(`Field '${fieldName}' doesn't exist on type '${typeName}'`);
}

function collectFields(ctx: Ctx, typeName: string, selections: SelNode[], into = new Map<string, FieldSel>()): Map<string, FieldSel> {
  for (const sel of selections) {
    if (sel.kind === 'field') {
      const key = sel.alias ?? sel.name;
      const existing = into.get(key);
      if (existing === undefined) into.set(key, sel);
      else existing.selections.push(...sel.selections);
    } else if (sel.kind === 'inline') {
      if (sel.typeCondition === typeName || sel.typeCondition === 'Node') collectFields(ctx, typeName, sel.selections, into);
    } else {
      const fragment = ctx.fragments.get(sel.name);
      if (fragment !== undefined && (fragment.typeCondition === typeName || fragment.typeCondition === 'Node')) {
        collectFields(ctx, typeName, fragment.selections, into);
      }
    }
  }
  return into;
}

function completeValue(ctx: Ctx, value: GValue, selections: SelNode[]): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(ctx, entry, selections));
  if (typeof value === 'object') {
    const gobj = value as GObject;
    const out: Record<string, unknown> = {};
    const fields = collectFields(ctx, gobj.__type, selections);
    for (const [key, field] of fields) {
      if (field.name === '__typename') {
        out[key] = gobj.__type;
        continue;
      }
      try {
        const resolved = resolveField(ctx, gobj.__type, gobj.data, field.name, argsOf(ctx, field));
        out[key] = completeValue(ctx, resolved, field.selections);
      } catch (error) {
        if (error instanceof FieldError) {
          ctx.errors.push({ message: error.message });
          out[key] = null;
        } else {
          throw error;
        }
      }
    }
    return out;
  }
  return value;
}

function typeObject(name: string): GValue {
  const known =
    OBJECT_FIELDS[name] !== undefined ||
    ENUM_VALUES[name] !== undefined ||
    name === '__Type' ||
    name === '__Field' ||
    name === '__EnumValue' ||
    name === '__Schema' ||
    name === '__Directive' ||
    name === '__InputValue';
  return known ? obj('__Type', { name }) : null;
}

function executeOne(forge: Forge, entry: Record<string, unknown>): Record<string, unknown> {
  const queryText = typeof entry.query === 'string' ? entry.query : '';
  const variables = isRecord(entry.variables) ? entry.variables : {};
  let document: { operations: Operation[]; fragments: Map<string, Fragment> };
  try {
    document = new Parser(tokenize(queryText)).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const operationName = typeof entry.operationName === 'string' ? entry.operationName : null;
  const operation = document.operations.find((op) => operationName === null || op.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'No operation in the document' }] };
  const ctx: Ctx = { forge, variables, defaults: operation.varDefaults, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data: Record<string, unknown> = {};
  const fields = collectFields(ctx, rootType, operation.selections);
  for (const [key, field] of fields) {
    if (field.name === '__typename') {
      data[key] = rootType;
      continue;
    }
    if (field.name === '__type') {
      const name = String(argsOf(ctx, field).name ?? '');
      data[key] = completeValue(ctx, typeObject(name), field.selections);
      continue;
    }
    if (field.name === '__schema') {
      data[key] = completeValue(ctx, obj('__Schema', {}), field.selections);
      continue;
    }
    try {
      const resolved = resolveField(ctx, rootType, null, field.name, argsOf(ctx, field));
      data[key] = completeValue(ctx, resolved, field.selections);
    } catch (error) {
      if (error instanceof FieldError) {
        ctx.errors.push({ message: error.message });
        data[key] = null;
      } else {
        throw error;
      }
    }
  }
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}

/** POST /api/graphql: one operation document, or a batch of them in a JSON array. */
export function handleGraphQL(forge: Forge, rawBody: Buffer): Reply {
  const parsed = parseJsonBody(rawBody);
  if (parsed === INVALID_JSON) return jsonReply(400, { errors: [{ message: 'Problems parsing JSON' }] });
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => (isRecord(entry) ? executeOne(forge, entry) : { errors: [{ message: 'Invalid operation entry' }] }));
    return jsonReply(200, results);
  }
  if (!isRecord(parsed)) return jsonReply(400, { errors: [{ message: 'Expected a GraphQL operation object' }] });
  return jsonReply(200, executeOne(forge, parsed));
}
