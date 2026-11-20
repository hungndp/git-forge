// The REST v3 surface: the API root, the viewer, repositories, branches, refs, commits, the
// contents API, labels, issues with comments, and pull requests with files and merges. Everything
// is backed by the one Forge store, so git pushes and GraphQL/MCP writes show up here unchanged.

import {
  ZERO_OID,
  ancestorsOf,
  diffTrees,
  flattenTree,
  isOid,
  lookupPath,
  mergeBase,
  parseCommit,
  parseIdent,
  parseTree,
} from './gitcore.ts';
import {
  Forge,
  commentJson,
  issueJson,
  labelJson,
  pullJson,
  repoJson,
  userJson,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { INVALID_JSON, boolField, errorReply, isRecord, jsonReply, pageParams, pageSlice, parseJsonBody, rawReply, stringField, type Reply } from './web.ts';

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3, percent-decoded. */
  segments: string[];
  query: URLSearchParams;
  rawBody: Buffer;
  /** The request's Host header, for absolute pagination links. */
  host: string;
}

const NOT_FOUND = (): Reply => errorReply(404, 'Not Found');

function bodyObject(req: RestRequest): Record<string, unknown> | null {
  const parsed = parseJsonBody(req.rawBody);
  if (parsed === INVALID_JSON) return null;
  if (parsed === undefined) return {};
  return isRecord(parsed) ? parsed : null;
}

/** Like bodyObject, but answers the 400 a malformed (or non-object) body earns. */
function requireBody(req: RestRequest): { body: Record<string, unknown> } | { reply: Reply } {
  const parsed = parseJsonBody(req.rawBody);
  if (parsed === INVALID_JSON) return { reply: errorReply(400, 'Problems parsing JSON') };
  if (parsed === undefined) return { body: {} };
  if (!isRecord(parsed)) return { reply: errorReply(400, 'Problems parsing JSON') };
  return { body: parsed };
}

function commitJson(forge: Forge, oid: string): Record<string, unknown> {
  const obj = forge.objects.get(oid);
  const info = obj !== undefined && obj.type === 'commit' ? parseCommit(obj.data) : null;
  if (info === null) return { sha: oid };
  return {
    sha: oid,
    node_id: `C_${oid}`,
    commit: {
      message: info.message.replace(/\n$/, ''),
      tree: { sha: info.tree },
      author: parseIdent(info.author),
      committer: parseIdent(info.committer),
      comment_count: 0,
    },
    author: null,
    committer: null,
    parents: info.parents.map((parent) => ({ sha: parent })),
  };
}

function labelNamesOf(body: Record<string, unknown>): string[] | null {
  const raw = body.labels;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') names.push(entry);
    else if (isRecord(entry) && typeof entry.name === 'string') names.push(entry.name);
    else return null;
  }
  return names;
}

export function handleRest(forge: Forge, req: RestRequest): Reply {
  const seg = req.segments;
  const method = req.method;

  // The API root and meta.
  if (seg.length === 0) {
    if (method !== 'GET') return NOT_FOUND();
    return jsonReply(
      200,
      {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues',
        rate_limit_url: '/api/v3/rate_limit',
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (seg.length === 1 && seg[0] === 'meta') {
    if (method !== 'GET') return NOT_FOUND();
    return jsonReply(200, { installed_version: '1.0.0', verifiable_password_authentication: false });
  }
  if (seg.length === 1 && seg[0] === 'user') {
    if (method !== 'GET') return NOT_FOUND();
    return jsonReply(200, userJson(forge.viewer));
  }

  // The viewer's repositories, with Link-header pagination.
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'GET') {
      const { perPage, page } = pageParams(req.query);
      const all = forge.viewerRepos();
      const items = pageSlice(all, perPage, page).map((repo) => repoJson(repo));
      const headers: Record<string, string> = {};
      if (page * perPage < all.length) {
        const lastPage = Math.ceil(all.length / perPage);
        const base = `http://${req.host}/api/v3/user/repos?per_page=${perPage}`;
        headers.link = `<${base}&page=${page + 1}>; rel="next", <${base}&page=${lastPage}>; rel="last"`;
      }
      return jsonReply(200, items, headers);
    }
    if (method === 'POST') {
      const parsed = requireBody(req);
      if ('reply' in parsed) return parsed.reply;
      const name = stringField(parsed.body, 'name');
      if (name === undefined || name === '') return errorReply(422, 'Repository creation failed: name is required');
      if (forge.getRepo(forge.viewer.login, name) !== undefined) {
        return errorReply(422, `Repository creation failed: the name '${name}' already exists on this account`);
      }
      const repo = forge.createRepo(forge.viewer.login, name, {
        description: stringField(parsed.body, 'description') ?? '',
        isPrivate: boolField(parsed.body, 'private') ?? false,
      });
      return jsonReply(201, repoJson(repo));
    }
    return NOT_FOUND();
  }

  if (seg[0] !== 'repos' || seg.length < 3) return NOT_FOUND();
  const owner = seg[1]!;
  const repoName = seg[2]!;
  const repo = forge.getRepo(owner, repoName);
  const rest = seg.slice(3);

  // The repository itself.
  if (rest.length === 0) {
    if (repo === undefined) return NOT_FOUND();
    if (method === 'GET') return jsonReply(200, repoJson(repo));
    if (method === 'PATCH') {
      const parsed = requireBody(req);
      if ('reply' in parsed) return parsed.reply;
      const description = stringField(parsed.body, 'description');
      if (description !== undefined) repo.description = description;
      const name = stringField(parsed.body, 'name');
      if (name !== undefined && name !== '' && name !== repo.name) {
        forge.repos.delete(forge.repoKey(repo.owner, repo.name));
        repo.name = name;
        forge.repos.set(forge.repoKey(repo.owner, repo.name), repo);
      }
      const isPrivate = boolField(parsed.body, 'private');
      if (isPrivate !== undefined) repo.isPrivate = isPrivate;
      repo.updatedAt = forge.tick();
      return jsonReply(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(owner, repoName);
      return jsonReply(204, null);
    }
    return NOT_FOUND();
  }
  if (repo === undefined) return NOT_FOUND();

  switch (rest[0]) {
    case 'branches':
      return branches(forge, repo, rest.slice(1), method);
    case 'git':
      return gitData(forge, repo, rest.slice(1), req);
    case 'commits':
      return commits(forge, repo, rest.slice(1), req);
    case 'contents':
      return contents(forge, repo, rest.slice(1).join('/'), req);
    case 'labels':
      return labels(forge, repo, rest.slice(1), req);
    case 'issues':
      return issues(forge, repo, rest.slice(1), req);
    case 'pulls':
      return pulls(forge, repo, rest.slice(1), req);
    default:
      return NOT_FOUND();
  }
}

// ---------------------------------------------------------------- branches and refs

function branches(forge: Forge, repo: RepoRec, rest: string[], method: string): Reply {
  if (method !== 'GET') return NOT_FOUND();
  if (rest.length === 0) {
    const list = forge.branchNames(repo).map((name) => ({
      name,
      commit: { sha: forge.branchTip(repo, name) ?? ZERO_OID },
      protected: false,
    }));
    return jsonReply(200, list);
  }
  const name = rest.join('/');
  const tip = forge.branchTip(repo, name);
  if (tip === undefined) return NOT_FOUND();
  return jsonReply(200, { name, commit: { sha: tip }, protected: false });
}

function refObjectType(forge: Forge, oid: string): string {
  return forge.objects.get(oid)?.type ?? 'commit';
}

function gitData(forge: Forge, repo: RepoRec, rest: string[], req: RestRequest): Reply {
  if (rest[0] === 'refs' && rest.length === 1) {
    if (req.method === 'POST') {
      const parsed = requireBody(req);
      if ('reply' in parsed) return parsed.reply;
      const ref = stringField(parsed.body, 'ref');
      const sha = stringField(parsed.body, 'sha');
      if (ref === undefined || sha === undefined || !ref.startsWith('refs/') || !isOid(sha) || !forge.objects.has(sha)) {
        return errorReply(422, 'Invalid ref or sha');
      }
      if (repo.refs.has(ref)) return errorReply(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      repo.updatedAt = forge.tick();
      return jsonReply(201, { ref, node_id: `REF_${ref}`, object: { type: refObjectType(forge, sha), sha } });
    }
    if (req.method === 'GET') {
      const list = [...repo.refs.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([ref, sha]) => ({ ref, node_id: `REF_${ref}`, object: { type: refObjectType(forge, sha), sha } }));
      return jsonReply(200, list);
    }
    return NOT_FOUND();
  }
  if (rest[0] === 'refs' && rest.length >= 2) {
    const ref = `refs/${rest.slice(1).join('/')}`;
    if (req.method === 'GET') {
      const sha = repo.refs.get(ref);
      if (sha === undefined) return NOT_FOUND();
      return jsonReply(200, { ref, node_id: `REF_${ref}`, object: { type: refObjectType(forge, sha), sha } });
    }
    if (req.method === 'DELETE') {
      if (!repo.refs.delete(ref)) return NOT_FOUND();
      return jsonReply(204, null);
    }
    return NOT_FOUND();
  }
  return NOT_FOUND();
}

// ---------------------------------------------------------------- commits

function commits(forge: Forge, repo: RepoRec, rest: string[], req: RestRequest): Reply {
  if (req.method !== 'GET') return NOT_FOUND();
  if (rest.length === 1) {
    const oid = rest[0]!;
    if (!isOid(oid) || forge.objects.get(oid)?.type !== 'commit') return NOT_FOUND();
    return jsonReply(200, commitJson(forge, oid));
  }
  if (rest.length !== 0) return NOT_FOUND();
  const shaParam = req.query.get('sha');
  let start: string | undefined;
  if (shaParam === null || shaParam === '') {
    start = forge.headTip(repo);
  } else if (isOid(shaParam) && forge.objects.get(shaParam)?.type === 'commit') {
    start = shaParam;
  } else {
    start = forge.branchTip(repo, shaParam) ?? repo.refs.get(shaParam);
  }
  if (start === undefined) return jsonReply(200, []);
  const { perPage, page } = pageParams(req.query);
  const distances = ancestorsOf(forge.objects, start);
  const ordered = [...distances.entries()].sort((a, b) => a[1] - b[1]).map(([oid]) => oid);
  return jsonReply(200, pageSlice(ordered, perPage, page).map((oid) => commitJson(forge, oid)));
}

// ---------------------------------------------------------------- contents

function contents(forge: Forge, repo: RepoRec, path: string, req: RestRequest): Reply {
  const method = req.method;
  if (method === 'GET') {
    const ref = req.query.get('ref');
    let tip: string | undefined;
    if (ref === null || ref === '') tip = forge.headTip(repo);
    else if (isOid(ref) && forge.objects.get(ref)?.type === 'commit') tip = ref;
    else tip = forge.branchTip(repo, ref) ?? repo.refs.get(ref);
    if (tip === undefined) return NOT_FOUND();
    const tree = parseCommit(forge.objects.get(tip)!.data).tree;
    const found = lookupPath(forge.objects, tree, path);
    if (found === undefined) return NOT_FOUND();
    if (found.type === 'tree') {
      const entries = parseTree(forge.objects.get(found.oid)!.data).map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: path === '' ? entry.name : `${path}/${entry.name}`,
        sha: entry.oid,
        size: entry.mode === '40000' ? 0 : (forge.objects.get(entry.oid)?.data.length ?? 0),
      }));
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return jsonReply(200, entries);
    }
    const blob = forge.objects.get(found.oid);
    if (blob === undefined) return NOT_FOUND();
    const name = path.split('/').pop() ?? path;
    return jsonReply(200, {
      type: 'file',
      encoding: 'base64',
      content: blob.data.toString('base64'),
      name,
      path,
      sha: found.oid,
      size: blob.data.length,
    });
  }

  if (method === 'PUT' || method === 'DELETE') {
    const parsed = requireBody(req);
    if ('reply' in parsed) return parsed.reply;
    const body = parsed.body;
    const message = stringField(body, 'message') ?? (method === 'PUT' ? `Create ${path}` : `Delete ${path}`);
    const branch = stringField(body, 'branch') ?? repo.defaultBranch;
    const tip = forge.branchTip(repo, branch) ?? forge.headTip(repo);
    const tree = tip === undefined ? null : parseCommit(forge.objects.get(tip)!.data).tree;
    const existing = tree === null ? undefined : lookupPath(forge.objects, tree, path);

    if (method === 'PUT') {
      const contentB64 = stringField(body, 'content');
      if (contentB64 === undefined) return errorReply(422, 'content is required');
      const sha = stringField(body, 'sha');
      if (existing !== undefined && existing.type === 'blob') {
        if (sha === undefined) return errorReply(422, "sha wasn't supplied");
        if (sha !== existing.oid) return errorReply(409, 'The sha does not match the current content');
      }
      const content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
      const created = existing === undefined;
      const result = forge.writeFile(repo, branch, path, content, message);
      const name = path.split('/').pop() ?? path;
      return jsonReply(created ? 201 : 200, {
        content: { name, path, sha: result.blob, size: content.length, type: 'file', encoding: 'base64' },
        commit: { sha: result.commit, message },
      });
    }

    // DELETE
    if (existing === undefined || existing.type !== 'blob') return NOT_FOUND();
    const sha = stringField(body, 'sha');
    if (sha === undefined) return errorReply(422, "sha wasn't supplied");
    if (sha !== existing.oid) return errorReply(409, 'The sha does not match the current content');
    const result = forge.writeFile(repo, branch, path, null, message);
    return jsonReply(200, { content: null, commit: { sha: result.commit, message } });
  }
  return NOT_FOUND();
}

// ---------------------------------------------------------------- labels

function labels(forge: Forge, repo: RepoRec, rest: string[], req: RestRequest): Reply {
  if (rest.length === 0) {
    if (req.method === 'GET') {
      const list = [...repo.labels.values()].map((label, index) => labelJson(label, index + 1));
      return jsonReply(200, list);
    }
    if (req.method === 'POST') {
      const parsed = requireBody(req);
      if ('reply' in parsed) return parsed.reply;
      const name = stringField(parsed.body, 'name');
      const color = stringField(parsed.body, 'color');
      if (name === undefined || name === '') return errorReply(422, 'Label creation failed: name is required');
      if (repo.labels.has(name)) return errorReply(422, `Label '${name}' already exists`);
      const label = { name, color: (color ?? 'ededed').replace(/^#/, ''), description: stringField(parsed.body, 'description') ?? null };
      repo.labels.set(name, label);
      return jsonReply(201, labelJson(label, repo.labels.size));
    }
    return NOT_FOUND();
  }
  if (rest.length === 1 && req.method === 'GET') {
    const label = repo.labels.get(rest[0]!);
    if (label === undefined) return NOT_FOUND();
    return jsonReply(200, labelJson(label, 1));
  }
  return NOT_FOUND();
}

// ---------------------------------------------------------------- issues

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/**
 * The serialised body of a single-issue GET, memoised per issue record. The read
 * benchmark hammers one warm issue thousands of times; rebuilding its JSON object and
 * re-stringifying it per request was pure repetition. The stamp names everything the
 * body is computed from: the repo's name/owner (they appear in the body's urls, and a
 * rename moves them), the issue's updatedAt (every mutation path — REST PATCH, GraphQL
 * close — bumps it through the logical clock, so it versions the issue's own fields),
 * the comment count (comments only ever append), and the label definitions the issue
 * carries (labels are immutable once created). A stamp match therefore means the body
 * is byte-identical to a fresh render, and a mismatch simply re-renders.
 */
const issueTextCache = new WeakMap<IssueRec, { stamp: string; text: string }>();

function issueStamp(repo: RepoRec, issue: IssueRec): string {
  let labels = '';
  for (const name of issue.labels) {
    const label = repo.labels.get(name);
    labels += label === undefined ? `${name}=;` : `${name}=${label.color},${String(label.description)};`;
  }
  const comments = (repo.comments.get(issue.number) ?? []).length;
  return `${repo.owner}/${repo.name}|${issue.updatedAt}|${comments}|${labels}`;
}

function sortIssues(list: IssueRec[], query: URLSearchParams): IssueRec[] {
  const direction = query.get('direction') ?? 'desc';
  const sorted = [...list].sort((a, b) => a.number - b.number);
  if (direction !== 'asc') sorted.reverse();
  return sorted;
}

function issues(forge: Forge, repo: RepoRec, rest: string[], req: RestRequest): Reply {
  if (rest.length === 0) {
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      const { perPage, page } = pageParams(req.query);
      return jsonReply(200, pageSlice(sortIssues(list, req.query), perPage, page).map((issue) => issueJson(forge, repo, issue)));
    }
    if (req.method === 'POST') {
      const parsed = requireBody(req);
      if ('reply' in parsed) return parsed.reply;
      const title = stringField(parsed.body, 'title');
      if (title === undefined || title === '') return errorReply(422, 'Issue creation failed: title is required');
      const names = labelNamesOf(parsed.body);
      if (names === null) return errorReply(422, 'Issue creation failed: labels are invalid');
      for (const name of names) {
        if (!repo.labels.has(name)) return errorReply(422, `Issue creation failed: label '${name}' does not exist`);
      }
      const issue = forge.createIssue(repo, { title, body: stringField(parsed.body, 'body') ?? '', labels: names }, forge.viewer.login);
      return jsonReply(201, issueJson(forge, repo, issue));
    }
    return NOT_FOUND();
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number <= 0) return NOT_FOUND();
  const issue = repo.issues.get(number);

  if (rest.length === 1) {
    if (issue === undefined) return NOT_FOUND();
    if (req.method === 'GET') {
      const stamp = issueStamp(repo, issue);
      const hit = issueTextCache.get(issue);
      if (hit !== undefined && hit.stamp === stamp) return rawReply(200, Buffer.from(hit.text, 'utf8'), JSON_CONTENT_TYPE);
      const body = issueJson(forge, repo, issue);
      issueTextCache.set(issue, { stamp, text: `${JSON.stringify(body)}\n` });
      return jsonReply(200, body);
    }
    if (req.method === 'PATCH') {
      const parsed = requireBody(req);
      if ('reply' in parsed) return parsed.reply;
      const state = stringField(parsed.body, 'state');
      if (state === 'closed' || state === 'open') {
        issue.state = state;
        issue.closedAt = state === 'closed' ? forge.tick() : null;
      }
      const title = stringField(parsed.body, 'title');
      if (title !== undefined) issue.title = title;
      const bodyText = stringField(parsed.body, 'body');
      if (bodyText !== undefined) issue.body = bodyText;
      const names = labelNamesOf(parsed.body);
      if (names !== null && parsed.body.labels !== undefined) {
        for (const name of names) if (!repo.labels.has(name)) return errorReply(422, `Label '${name}' does not exist`);
        issue.labels = names;
      }
      issue.updatedAt = forge.tick();
      return jsonReply(200, issueJson(forge, repo, issue));
    }
    return NOT_FOUND();
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined && repo.pulls.get(number) === undefined) return NOT_FOUND();
    if (req.method === 'GET') {
      const list = repo.comments.get(number) ?? [];
      return jsonReply(200, list.map((comment) => commentJson(forge, comment)));
    }
    if (req.method === 'POST') {
      const parsed = requireBody(req);
      if ('reply' in parsed) return parsed.reply;
      const bodyText = stringField(parsed.body, 'body');
      if (bodyText === undefined) return errorReply(422, 'Comment creation failed: body is required');
      const comment = forge.addComment(repo, number, bodyText, forge.viewer.login);
      return jsonReply(201, commentJson(forge, comment));
    }
    return NOT_FOUND();
  }
  return NOT_FOUND();
}

// ---------------------------------------------------------------- pull requests

function pulls(forge: Forge, repo: RepoRec, rest: string[], req: RestRequest): Reply {
  if (rest.length === 0) {
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
      list.sort((a, b) => a.number - b.number);
      const { perPage, page } = pageParams(req.query);
      return jsonReply(200, pageSlice(list, perPage, page).map((pull) => pullJson(forge, repo, pull)));
    }
    if (req.method === 'POST') {
      const parsed = requireBody(req);
      if ('reply' in parsed) return parsed.reply;
      return createPullReply(forge, repo, parsed.body);
    }
    return NOT_FOUND();
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number <= 0) return NOT_FOUND();
  const pull = repo.pulls.get(number);

  if (rest.length === 1) {
    if (pull === undefined) return NOT_FOUND();
    if (req.method === 'GET') return jsonReply(200, pullJson(forge, repo, pull));
    if (req.method === 'PATCH') {
      const parsed = requireBody(req);
      if ('reply' in parsed) return parsed.reply;
      const state = stringField(parsed.body, 'state');
      if (state === 'closed' || state === 'open') pull.state = state;
      const title = stringField(parsed.body, 'title');
      if (title !== undefined) pull.title = title;
      const bodyText = stringField(parsed.body, 'body');
      if (bodyText !== undefined) pull.body = bodyText;
      pull.updatedAt = forge.tick();
      return jsonReply(200, pullJson(forge, repo, pull));
    }
    return NOT_FOUND();
  }

  if (rest.length === 2 && rest[1] === 'files' && req.method === 'GET') {
    if (pull === undefined) return NOT_FOUND();
    const headTip = forge.branchTip(repo, pull.headRef);
    const baseTip = forge.branchTip(repo, pull.baseRef);
    if (headTip === undefined || baseTip === undefined) return jsonReply(200, []);
    const base = mergeBase(forge.objects, baseTip, headTip) ?? baseTip;
    const baseTree = parseCommit(forge.objects.get(base)!.data).tree;
    const headTree = parseCommit(forge.objects.get(headTip)!.data).tree;
    const files = diffTrees(forge.objects, baseTree, headTree).map((change) => ({
      sha: '',
      filename: change.path,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.additions + change.deletions,
    }));
    return jsonReply(200, files);
  }

  if (rest.length === 2 && rest[1] === 'merge') {
    if (pull === undefined) return NOT_FOUND();
    if (req.method === 'PUT') {
      const parsed = requireBody(req);
      if ('reply' in parsed) return parsed.reply;
      return mergePullReply(forge, repo, pull, stringField(parsed.body, 'merge_method'));
    }
    if (req.method === 'GET') {
      return pull.merged ? jsonReply(204, null) : NOT_FOUND();
    }
    return NOT_FOUND();
  }
  return NOT_FOUND();
}

/** Shared by REST, GraphQL and MCP: validate and open a pull request. */
export function createPullReply(forge: Forge, repo: RepoRec, body: Record<string, unknown>): Reply {
  const title = stringField(body, 'title');
  const headRaw = stringField(body, 'head');
  const baseRaw = stringField(body, 'base') ?? repo.defaultBranch;
  if (title === undefined || title === '' || headRaw === undefined || headRaw === '') {
    return errorReply(422, 'Pull request creation failed: title and head are required');
  }
  const head = headRaw.includes(':') ? headRaw.split(':').pop()! : headRaw;
  const base = baseRaw.includes(':') ? baseRaw.split(':').pop()! : baseRaw;
  if (forge.branchTip(repo, head) === undefined) return errorReply(422, `Pull request creation failed: head branch '${head}' does not exist`);
  if (forge.branchTip(repo, base) === undefined) return errorReply(422, `Pull request creation failed: base branch '${base}' does not exist`);
  if (head === base) return errorReply(422, 'Pull request creation failed: head and base are the same');
  const pull = forge.createPull(repo, { title, body: stringField(body, 'body') ?? '', headRef: head, baseRef: base }, forge.viewer.login);
  return jsonReply(201, pullJson(forge, repo, pull));
}

/** Shared merge path: answers the REST merge reply for a pull and method name. */
export function mergePullReply(forge: Forge, repo: RepoRec, pull: PullRec, methodRaw: string | undefined): Reply {
  if (pull.merged) return errorReply(405, 'Pull Request has already been merged');
  if (pull.state !== 'open') return errorReply(405, 'Pull Request is not open');
  const method = methodRaw === 'merge' ? 'merge' : 'squash';
  const sha = forge.mergePull(repo, pull, method);
  if (sha === null) return errorReply(405, 'Pull Request is not mergeable: the head branch conflicts with the base');
  return jsonReply(200, { sha, merged: true, message: 'Pull Request successfully merged' });
}
