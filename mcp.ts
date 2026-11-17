// The MCP endpoint (POST /mcp): streamable-HTTP JSON-RPC speaking both protocol eras the suite
// judges — the 2026-07-28 revision's handshake-free `server/discover`, and the legacy initialize
// handshake. The tools are the github-mcp-server verbs over the same Forge store as every other
// surface, so an object made here is the same object over REST and GraphQL.

import { Forge, issueJson, pullJson, repoJson, type RepoRec } from './store.ts';
import { createPullReply, mergePullReply } from './rest.ts';
import { INVALID_JSON, isRecord, jsonReply, parseJsonBody, type Reply } from './web.ts';

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  required: string[];
  run: (forge: Forge, args: Record<string, unknown>) => unknown;
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: isRecord(value) ? value : { result: value },
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function needRepo(forge: Forge, args: Record<string, unknown>): RepoRec {
  const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : forge.viewer.login;
  const name = typeof args.repo === 'string' ? args.repo : '';
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) throw new Error(`repository ${owner}/${name} not found`);
  return repo;
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name' },
        description: { type: 'string', description: 'A short description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
    required: ['name'],
    run: (forge, args) => {
      const name = str(args, 'name');
      if (forge.getRepo(forge.viewer.login, name) !== undefined) throw new Error(`repository ${name} already exists`);
      const repo = forge.createRepo(forge.viewer.login, name, {
        description: str(args, 'description'),
        isPrivate: args.private === true,
      });
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner' },
        repo: { type: 'string', description: 'The repository name' },
      },
      required: ['owner', 'repo'],
    },
    required: ['owner', 'repo'],
    run: (forge, args) => repoJson(needRepo(forge, args)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner' },
        repo: { type: 'string', description: 'The repository name' },
        title: { type: 'string', description: 'The issue title' },
        body: { type: 'string', description: 'The issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
    required: ['owner', 'repo', 'title'],
    run: (forge, args) => {
      const repo = needRepo(forge, args);
      const issue = forge.createIssue(repo, { title: str(args, 'title'), body: str(args, 'body') }, forge.viewer.login);
      return issueJson(forge, repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner' },
        repo: { type: 'string', description: 'The repository name' },
        state: { type: 'string', description: 'open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
    required: ['owner', 'repo'],
    run: (forge, args) => {
      const repo = needRepo(forge, args);
      const state = str(args, 'state') || 'open';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      return list.map((issue) => issueJson(forge, repo, issue));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner' },
        repo: { type: 'string', description: 'The repository name' },
        title: { type: 'string', description: 'The pull request title' },
        body: { type: 'string', description: 'The pull request body' },
        head: { type: 'string', description: 'The head branch' },
        base: { type: 'string', description: 'The base branch' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
    run: (forge, args) => {
      const repo = needRepo(forge, args);
      const reply = createPullReply(forge, repo, { title: str(args, 'title'), body: str(args, 'body'), head: str(args, 'head'), base: str(args, 'base') });
      if (reply.status !== 201) throw new Error(`create_pull_request failed: ${JSON.stringify(reply.body)}`);
      return reply.body;
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner' },
        repo: { type: 'string', description: 'The repository name' },
        pull_number: { type: 'number', description: 'The pull request number' },
        merge_method: { type: 'string', description: 'merge or squash' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    required: ['owner', 'repo', 'pull_number'],
    run: (forge, args) => {
      const repo = needRepo(forge, args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (pull === undefined) throw new Error(`pull request #${number} not found`);
      const reply = mergePullReply(forge, repo, pull, str(args, 'merge_method') || undefined);
      if (reply.status !== 200) throw new Error(`merge_pull_request failed: ${JSON.stringify(reply.body)}`);
      return pullJson(forge, repo, pull);
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner' },
        repo: { type: 'string', description: 'The repository name' },
        issue_number: { type: 'number', description: 'The issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
    required: ['owner', 'repo', 'issue_number'],
    run: (forge, args) => {
      const repo = needRepo(forge, args);
      const issue = repo.issues.get(typeof args.issue_number === 'number' ? args.issue_number : Number(args.issue_number));
      if (issue === undefined) throw new Error('issue not found');
      return issueJson(forge, repo, issue);
    },
  },
  {
    name: 'list_branches',
    description: 'List the branches of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner' },
        repo: { type: 'string', description: 'The repository name' },
      },
      required: ['owner', 'repo'],
    },
    required: ['owner', 'repo'],
    run: (forge, args) => {
      const repo = needRepo(forge, args);
      return forge.branchNames(repo).map((name) => ({ name, commit: { sha: forge.branchTip(repo, name) } }));
    },
  },
];

/** The tools/list payload: one frozen structure, so two calls answer byte for byte the same. */
const TOOLS_LIST = {
  tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
};

function rpcError(id: unknown, code: number, message: string): Reply {
  return jsonReply(200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function rpcResult(id: unknown, result: unknown): Reply {
  return jsonReply(200, { jsonrpc: '2.0', id: id ?? null, result });
}

function callTool(forge: Forge, params: Record<string, unknown>): Reply {
  const name = typeof params.name === 'string' ? params.name : '';
  const tool = TOOLS.find((candidate) => candidate.name === name);
  const id = (params as { __id?: unknown }).__id;
  if (tool === undefined) return rpcError(id, -32602, `unknown tool: ${name}`);
  const args = isRecord(params.arguments) ? params.arguments : {};
  for (const key of tool.required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      return rpcError(id, -32602, `missing required argument: ${key}`);
    }
  }
  try {
    return rpcResult(id, toolResult(tool.run(forge, args)));
  } catch (error) {
    return rpcResult(id, toolError(error instanceof Error ? error.message : String(error)));
  }
}

/** POST /mcp. Auth (the bearer token) is enforced by app.ts before this runs. */
export function handleMcp(forge: Forge, rawBody: Buffer): Reply {
  const parsed = parseJsonBody(rawBody);
  if (parsed === INVALID_JSON || !isRecord(parsed)) {
    return jsonReply(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const id = parsed.id;
  const method = typeof parsed.method === 'string' ? parsed.method : '';
  const params = isRecord(parsed.params) ? parsed.params : {};
  if (id === undefined) {
    // A notification (notifications/initialized and friends): accepted, never answered.
    return jsonReply(202, null);
  }
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        supported: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, TOOLS_LIST);
    case 'tools/call':
      return callTool(forge, { ...params, __id: id });
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}
