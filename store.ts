// The forge's state: users, repositories (refs, labels, issues, pull requests, comments) and the
// operations every surface shares, so a change made over REST is the same object over GraphQL, MCP
// and git. All timestamps come from a logical clock seeded by MAKEFUN_TRIAL_NOW: a trial's replay
// makes the same requests in the same order, so the same values come out byte for byte.

import {
  ObjectStore,
  ZERO_OID,
  buildCommitData,
  buildTreeFromFlat,
  flattenTree,
  isAncestor,
  mergeBase,
  mergeTrees,
  parseCommit,
} from './gitcore.ts';

export interface UserRec {
  login: string;
  id: number;
  name: string;
  email: string;
  type: 'User' | 'Organization';
}

export interface LabelRec {
  name: string;
  color: string;
  description: string | null;
}

export interface IssueRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface PullRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface CommentRec {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  comments: Map<number, CommentRec[]>;
  nextNumber: number;
  createdAt: string;
  updatedAt: string;
}

const FALLBACK_NOW_MS = Date.UTC(2026, 10, 14, 6, 30, 0);

export class Forge {
  readonly objects = new ObjectStore();
  readonly users = new Map<string, UserRec>();
  readonly repos = new Map<string, RepoRec>();
  readonly viewer: UserRec;
  private repoSeq = 0;
  private issueSeq = 0;
  private commentSeq = 0;
  private tickCount = 0;
  private readonly baseMs: number;

  constructor() {
    const trialNow = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = Date.parse(trialNow);
    this.baseMs = Number.isFinite(parsed) ? parsed : FALLBACK_NOW_MS;
    this.viewer = { login: 'adaiversen', id: 1000, name: 'ada iversen', email: 'adaiversen@example.invalid', type: 'User' };
    this.users.set(this.viewer.login, this.viewer);
    this.users.set('quinnkeller', { login: 'quinnkeller', id: 1001, name: 'quinn keller', email: 'quinnkeller@example.invalid', type: 'User' });
    this.users.set('olgabauer', { login: 'olgabauer', id: 1002, name: 'olga bauer', email: 'olgabauer@example.invalid', type: 'User' });
    this.users.set('faint-meadow-org', { login: 'faint-meadow-org', id: 2000, name: 'faint meadow', email: '', type: 'Organization' });
  }

  /** The next logical timestamp (ISO), one second past the previous one: deterministic per run. */
  tick(): string {
    this.tickCount += 1;
    return new Date(this.baseMs + this.tickCount * 1000).toISOString();
  }

  /** A git ident line for a server-made commit, on the same logical clock. */
  ident(user: UserRec): string {
    this.tickCount += 1;
    const seconds = Math.floor(this.baseMs / 1000) + this.tickCount;
    return `${user.name} <${user.email}> ${seconds} +0000`;
  }

  userOrViewer(login: string): UserRec {
    return this.users.get(login) ?? this.viewer;
  }

  // -------------------------------------------------------------- repositories

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, init: { description?: string; isPrivate?: boolean }): RepoRec {
    this.repoSeq += 1;
    const now = this.tick();
    const repo: RepoRec = {
      id: this.repoSeq,
      owner,
      name,
      description: init.description ?? '',
      isPrivate: init.isPrivate ?? false,
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      comments: new Map(),
      nextNumber: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  viewerRepos(): RepoRec[] {
    return [...this.repos.values()].filter((repo) => repo.owner === this.viewer.login).sort((a, b) => a.id - b.id);
  }

  /** The commit a branch ref names, following HEAD's target for the default branch. */
  branchTip(repo: RepoRec, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  headTarget(repo: RepoRec): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  headTip(repo: RepoRec): string | undefined {
    return repo.refs.get(this.headTarget(repo));
  }

  /** Sorted branch names (without the refs/heads/ prefix). */
  branchNames(repo: RepoRec): string[] {
    const names: string[] = [];
    for (const ref of repo.refs.keys()) if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
    return names.sort();
  }

  // -------------------------------------------------------------- commits the server makes

  /**
   * Commit a whole new tree onto a branch: the contents API's and the merge paths' one write.
   * A missing branch is created (at the default branch's tip when there is one).
   */
  commitTree(repo: RepoRec, branch: string, treeOid: string, message: string, extraParents: readonly string[] = []): string {
    const ref = `refs/heads/${branch}`;
    let parent = repo.refs.get(ref);
    if (parent === undefined) {
      parent = this.headTip(repo);
      if (parent !== undefined) repo.refs.set(ref, parent);
    }
    const parents = parent === undefined ? [...extraParents] : [parent, ...extraParents];
    const ident = this.ident(this.viewer);
    const data = buildCommitData(treeOid, parents, ident, ident, message.endsWith('\n') ? message : `${message}\n`);
    const oid = this.objects.put('commit', data);
    repo.refs.set(ref, oid);
    repo.updatedAt = this.tick();
    return oid;
  }

  /** Write one file (or remove it, when `content` is null) on a branch and commit the change. */
  writeFile(repo: RepoRec, branch: string, path: string, content: Buffer | null, message: string): { commit: string; blob: string | null } {
    const tip = this.branchTip(repo, branch) ?? this.headTip(repo);
    const flat = tip === undefined ? new Map<string, { mode: string; oid: string }>() : flattenTree(this.objects, parseCommit(this.objects.get(tip)!.data).tree);
    let blob: string | null = null;
    if (content === null) {
      flat.delete(path);
    } else {
      blob = this.objects.put('blob', content);
      const existing = flat.get(path);
      flat.set(path, { mode: existing?.mode ?? '100644', oid: blob });
    }
    const tree = buildTreeFromFlat(this.objects, flat);
    const commit = this.commitTree(repo, branch, tree, message);
    return { commit, blob };
  }

  // -------------------------------------------------------------- issues and pulls

  createIssue(repo: RepoRec, init: { title: string; body?: string; labels?: string[] }, userLogin: string): IssueRec {
    this.issueSeq += 1;
    const now = this.tick();
    const issue: IssueRec = {
      number: repo.nextNumber,
      id: this.issueSeq,
      title: init.title,
      body: init.body ?? '',
      state: 'open',
      labels: [...(init.labels ?? [])],
      userLogin,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createPull(repo: RepoRec, init: { title: string; body?: string; headRef: string; baseRef: string }, userLogin: string): PullRec {
    this.issueSeq += 1;
    const now = this.tick();
    const pull: PullRec = {
      number: repo.nextNumber,
      id: this.issueSeq,
      title: init.title,
      body: init.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: init.headRef,
      baseRef: init.baseRef,
      userLogin,
      createdAt: now,
      updatedAt: now,
    };
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  addComment(repo: RepoRec, number: number, body: string, userLogin: string): CommentRec {
    this.commentSeq += 1;
    const now = this.tick();
    const comment: CommentRec = { id: this.commentSeq, body, userLogin, createdAt: now, updatedAt: now };
    const list = repo.comments.get(number) ?? [];
    list.push(comment);
    repo.comments.set(number, list);
    return comment;
  }

  // -------------------------------------------------------------- merging

  /** Whether a pull request's head merges cleanly into its base right now. */
  pullMergeable(repo: RepoRec, pull: PullRec): boolean {
    if (pull.merged) return false;
    const baseTip = this.branchTip(repo, pull.baseRef);
    const headTip = this.branchTip(repo, pull.headRef);
    if (baseTip === undefined || headTip === undefined) return false;
    if (isAncestor(this.objects, headTip, baseTip)) return true; // already up to date
    const base = mergeBase(this.objects, baseTip, headTip);
    if (base === null) return false;
    const baseTree = parseCommit(this.objects.get(base)!.data).tree;
    const ourTree = parseCommit(this.objects.get(baseTip)!.data).tree;
    const theirTree = parseCommit(this.objects.get(headTip)!.data).tree;
    return !('conflict' in mergeTrees(this.objects, baseTree, ourTree, theirTree));
  }

  /**
   * Merge a pull request into its base branch ('squash' or 'merge'). Answers the merge commit's sha,
   * or null when the merge conflicts (or the branches have moved away).
   */
  mergePull(repo: RepoRec, pull: PullRec, method: 'squash' | 'merge'): string | null {
    const baseTip = this.branchTip(repo, pull.baseRef);
    const headTip = this.branchTip(repo, pull.headRef);
    if (baseTip === undefined || headTip === undefined) return null;
    let tree: string;
    let parents: string[];
    if (isAncestor(this.objects, headTip, baseTip)) {
      // Nothing to bring over: the merge commit is the base tip itself for squash purposes; make a
      // real (empty) merge commit so the pull has a merge_commit_sha and the branch advances visibly.
      tree = parseCommit(this.objects.get(baseTip)!.data).tree;
      parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
    } else {
      const base = mergeBase(this.objects, baseTip, headTip);
      if (base === null) return null;
      const merged = mergeTrees(
        this.objects,
        parseCommit(this.objects.get(base)!.data).tree,
        parseCommit(this.objects.get(baseTip)!.data).tree,
        parseCommit(this.objects.get(headTip)!.data).tree,
      );
      if ('conflict' in merged) return null;
      tree = merged.tree;
      parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
    }
    const message =
      method === 'merge'
        ? `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`
        : `${pull.title}\n\n${pull.body === '' ? '' : `${pull.body}\n`}Squashed merge of pull request #${pull.number}.\n`;
    const ident = this.ident(this.viewer);
    const data = buildCommitData(tree, parents, ident, ident, message);
    const oid = this.objects.put('commit', data);
    repo.refs.set(`refs/heads/${pull.baseRef}`, oid);
    const now = this.tick();
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = now;
    pull.mergeCommitSha = oid;
    pull.updatedAt = now;
    repo.updatedAt = now;
    return oid;
  }
}

// ---------------------------------------------------------------- REST shapes

export function userJson(user: UserRec): Record<string, unknown> {
  return { login: user.login, id: user.id, type: user.type, name: user.name, email: user.email, site_admin: false };
}

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson({ login: repo.owner, id: repo.owner === 'adaiversen' ? 1000 : 2000, name: repo.owner, email: '', type: repo.owner === 'faint-meadow-org' ? 'Organization' : 'User' }),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    fork: false,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

export function labelJson(label: LabelRec, id: number): Record<string, unknown> {
  return { id, name: label.name, color: label.color, description: label.description, default: false };
}

export function issueJson(forge: Forge, repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  const labels = issue.labels.map((name, index) => {
    const label = repo.labels.get(name);
    return label === undefined ? { id: index + 1, name, color: 'ededed', description: null, default: false } : labelJson(label, index + 1);
  });
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels,
    user: userJson(forge.userOrViewer(issue.userLogin)),
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(forge: Forge, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = forge.branchTip(repo, pull.headRef) ?? ZERO_OID;
  const baseSha = forge.branchTip(repo, pull.baseRef) ?? ZERO_OID;
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(forge.userOrViewer(pull.userLogin)),
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.merged ? pull.mergedAt : pull.state === 'closed' ? pull.updatedAt : null,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

export function commentJson(forge: Forge, comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    body: comment.body,
    user: userJson(forge.userOrViewer(comment.userLogin)),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}
