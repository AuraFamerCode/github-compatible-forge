// MCP over Streamable HTTP: JSON-RPC 2.0 at /mcp, with the 2026-07-28 revision's server/discover and
// the handshake era's initialize, and a tool set that acts on the same store REST reads back.

import {
  VIEWER,
  makeCommit,
  mergeTrees,
  nowIso,
  resolveRef,
  setRef,
} from './store.ts';
import type { Issue, Repo, Store } from './store.ts';

const REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'] as const;

interface ToolProperty {
  readonly type: string;
  readonly description: string;
}

interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, ToolProperty>;
    readonly required: readonly string[];
  };
}

const OWNER: ToolProperty = { type: 'string', description: 'The repository owner login, for example adaiversen.' };
const REPO: ToolProperty = { type: 'string', description: 'The repository name.' };
const FULL_NAME: ToolProperty = { type: 'string', description: 'The repository full name, owner/repo.' };

/** The tool list, built once so two tools/list answers are byte-identical. */
const TOOLS: readonly Tool[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated account and return it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        default_branch: { type: 'string', description: 'The default branch name, main by default.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name, or by its full name.',
    inputSchema: {
      type: 'object',
      properties: { owner: OWNER, repo: REPO, full_name: FULL_NAME },
      required: [],
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories the authenticated account owns.',
    inputSchema: { type: 'object', properties: { per_page: { type: 'number', description: 'How many to return.' } }, required: [] },
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository and return it.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: OWNER,
        repo: REPO,
        full_name: FULL_NAME,
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        labels: { type: 'array', description: 'Label names that already exist on the repository.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, open by default.',
    inputSchema: {
      type: 'object',
      properties: { owner: OWNER, repo: REPO, full_name: FULL_NAME, state: { type: 'string', description: 'open, closed or all.' } },
      required: [],
    },
  },
  {
    name: 'get_issue',
    description: 'Read one issue by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: OWNER,
        repo: REPO,
        full_name: FULL_NAME,
        issue_number: { type: 'number', description: 'The issue number.' },
        number: { type: 'number', description: 'The issue number.' },
      },
      required: [],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a pushed head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: OWNER,
        repo: REPO,
        full_name: FULL_NAME,
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['title', 'head', 'base'],
    },
  },
  {
    name: 'list_pulls',
    description: 'List the pull requests of a repository.',
    inputSchema: {
      type: 'object',
      properties: { owner: OWNER, repo: REPO, full_name: FULL_NAME, state: { type: 'string', description: 'open, closed or all.' } },
      required: [],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch and return the merge commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: OWNER,
        repo: REPO,
        full_name: FULL_NAME,
        pull_number: { type: 'number', description: 'The pull request number.' },
        merge_method: { type: 'string', description: 'merge, squash or rebase.' },
      },
      required: ['pull_number'],
    },
  },
]);

// --------------------------------------------------------------------------- tool implementations

interface ToolResult {
  readonly isError: boolean;
  readonly payload: unknown;
}

function str(args: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

function num(args: Record<string, unknown>, ...names: string[]): number | null {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  }
  return null;
}

function repoArgs(store: Store, args: Record<string, unknown>): Repo | null {
  const full = str(args, 'full_name', 'repo_full_name', 'repository_full_name', 'repositoryFullName');
  if (full.includes('/')) {
    const [owner, name] = full.split('/');
    return store.owned(owner, name) ?? null;
  }
  const owner = str(args, 'owner', 'owner_login', 'org', 'organization', 'login');
  const name = str(args, 'repo', 'repository', 'repository_name', 'repo_name', 'name');
  if (name.includes('/')) {
    const [owner2, name2] = name.split('/');
    return store.owned(owner2, name2) ?? null;
  }
  return store.owned(owner === '' ? VIEWER.login : owner, name) ?? null;
}

function repoPayload(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    clone_url: `/${repo.owner}/${repo.name}.git`,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
  };
}

function issuePayload(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    user: { login: issue.user.login },
    repository: `${repo.owner}/${repo.name}`,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    comments: issue.comments.length,
  };
}

function pullPayload(repo: Repo, number: number): Record<string, unknown> | null {
  const pull = repo.pulls.find((entry) => entry.number === number);
  if (pull === undefined) return null;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'merged' : pull.state,
    merged: pull.merged,
    head: { ref: pull.headRef, sha: resolveRef(repo, pull.headRef) ?? pull.headSha },
    base: { ref: pull.baseRef, sha: resolveRef(repo, pull.baseRef) ?? pull.baseSha },
    merge_commit_sha: pull.merge_commit_sha,
    created_at: pull.created_at,
  };
}

export function callTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  const tool = name.toLowerCase();
  const missing = (tool.endsWith('create_repo') && str(args, 'name', 'repo', 'repository') === '')
    || (tool.endsWith('create_issue') && str(args, 'title') === '')
    || (tool.endsWith('create_pull_request') && (str(args, 'title') === '' || str(args, 'head') === '' || str(args, 'base') === ''))
    || (tool.endsWith('merge_pull_request') && num(args, 'pull_number', 'number') === null);
  if (missing) return { isError: true, payload: { message: 'the call is missing a required argument' } };

  if (tool.endsWith('create_repo')) {
    const repoName = str(args, 'name', 'repo', 'repository');
    const existing = store.get(VIEWER.login, repoName);
    if (existing !== undefined) return { isError: false, payload: repoPayload(existing) };
    const repo = store.create(
      VIEWER.login,
      repoName,
      str(args, 'description'),
      args.private === true,
      str(args, 'default_branch') === '' ? 'main' : str(args, 'default_branch'),
    );
    return { isError: false, payload: repoPayload(repo) };
  }

  if (tool.endsWith('get_repo')) {
    const repo = repoArgs(store, args);
    if (repo === null) return { isError: true, payload: { message: 'repository not found' } };
    return { isError: false, payload: repoPayload(repo) };
  }

  if (tool.endsWith('list_repos')) {
    return { isError: false, payload: { repositories: store.listOwned().map((repo) => repoPayload(repo)) } };
  }

  if (tool.endsWith('create_issue')) {
    const repo = repoArgs(store, args);
    if (repo === null) return { isError: true, payload: { message: 'repository not found' } };
    const labels = Array.isArray(args.labels) ? args.labels.filter((label): label is string => typeof label === 'string') : [];
    const unknown = labels.filter((label) => repo.labels.every((entry) => entry.name !== label));
    if (unknown.length > 0) return { isError: true, payload: { message: `labels do not exist: ${unknown.join(', ')}` } };
    const when = nowIso();
    const issue: Issue = {
      id: repo.nextIssueId++,
      number: repo.nextIssueNumber++,
      title: str(args, 'title', 'issue_title'),
      body: str(args, 'body', 'description', 'content'),
      state: 'open',
      labels,
      user: VIEWER,
      created_at: when,
      updated_at: when,
      closed_at: null,
      comments: [],
    };
    repo.issues.push(issue);
    return { isError: false, payload: issuePayload(repo, issue) };
  }

  if (tool.endsWith('list_issues')) {
    const repo = repoArgs(store, args);
    if (repo === null) return { isError: true, payload: { message: 'repository not found' } };
    const state = str(args, 'state') === '' ? 'open' : str(args, 'state');
    const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    return { isError: false, payload: { issues: issues.map((issue) => issuePayload(repo, issue)), total_count: issues.length } };
  }

  if (tool.endsWith('get_issue')) {
    const repo = repoArgs(store, args);
    if (repo === null) return { isError: true, payload: { message: 'repository not found' } };
    const number = num(args, 'issue_number', 'number');
    const issue = repo.issues.find((entry) => entry.number === number);
    if (issue === undefined) return { isError: true, payload: { message: 'issue not found' } };
    return { isError: false, payload: issuePayload(repo, issue) };
  }

  if (tool.endsWith('create_pull_request')) {
    const repo = repoArgs(store, args);
    if (repo === null) return { isError: true, payload: { message: 'repository not found' } };
    const head = str(args, 'head', 'head_ref', 'head_branch');
    const base = str(args, 'base', 'base_ref', 'base_branch');
    const headSha = resolveRef(repo, head);
    const baseSha = resolveRef(repo, base);
    if (headSha === null) return { isError: true, payload: { message: `head branch ${head} has no commits` } };
    if (baseSha === null) return { isError: true, payload: { message: `base branch ${base} has no commits` } };
    const when = nowIso();
    const pull = {
      id: repo.nextPullNumber + 9000,
      number: repo.nextPullNumber++,
      title: str(args, 'title'),
      body: str(args, 'body'),
      state: 'open' as const,
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      user: VIEWER,
      created_at: when,
      updated_at: when,
      closed_at: null,
    };
    repo.pulls.push(pull);
    return { isError: false, payload: pullPayload(repo, pull.number) };
  }

  if (tool.endsWith('list_pulls')) {
    const repo = repoArgs(store, args);
    if (repo === null) return { isError: true, payload: { message: 'repository not found' } };
    const state = str(args, 'state') === '' ? 'open' : str(args, 'state');
    const pulls = repo.pulls.filter((pull) => state === 'all' || (state === 'merged' ? pull.merged : pull.state === state));
    return {
      isError: false,
      payload: { pull_requests: pulls.map((pull) => pullPayload(repo, pull.number)).filter((entry) => entry !== null), total_count: pulls.length },
    };
  }

  if (tool.endsWith('merge_pull_request')) {
    const repo = repoArgs(store, args);
    if (repo === null) return { isError: true, payload: { message: 'repository not found' } };
    const number = num(args, 'pull_number', 'number');
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull === undefined) return { isError: true, payload: { message: 'pull request not found' } };
    if (pull.merged) return { isError: false, payload: pullPayload(repo, pull.number) };
    const baseTip = resolveRef(repo, pull.baseRef);
    const headTip = resolveRef(repo, pull.headRef);
    if (baseTip === null || headTip === null) return { isError: true, payload: { message: 'pull request is not mergeable' } };
    const merged = mergeTrees(repo, baseTip, headTip);
    if (!merged.ok || merged.files === undefined) return { isError: true, payload: { message: 'pull request has merge conflicts' } };
    const commit = makeCommit(repo, merged.files, [baseTip], `${pull.title} (#${pull.number})`, VIEWER);
    setRef(repo, pull.baseRef, commit);
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = nowIso();
    pull.closed_at = pull.merged_at;
    pull.merge_commit_sha = commit;
    pull.updated_at = pull.merged_at;
    return { isError: false, payload: pullPayload(repo, pull.number) };
  }

  return { isError: true, payload: { message: `no such tool ${name}` } };
}

// --------------------------------------------------------------------------- JSON-RPC

interface RpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

function result(id: unknown, value: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result: value };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function serverInfo(): Record<string, unknown> {
  return { name: 'forge', version: '1.0.0' };
}

function handleOne(store: Store, request: RpcRequest): { reply: Record<string, unknown> | null } {
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params !== null && typeof request.params === 'object' ? request.params : {}) as Record<string, unknown>;
  const isNotification = id === undefined || id === null;

  if (method === 'server/discover') {
    return {
      reply: result(id, {
        supportedVersions: [...REVISIONS],
        capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
        serverInfo: serverInfo(),
        instructions: 'A GitHub-compatible forge: repositories, issues and pull requests over MCP, REST v3 and git.',
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
      }),
    };
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = (REVISIONS as readonly string[]).includes(requested) ? requested : REVISIONS[2];
    return {
      reply: result(id, {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: serverInfo(),
        instructions: 'A GitHub-compatible forge: repositories, issues and pull requests over MCP.',
      }),
    };
  }

  if (method === 'notifications/initialized' || method === 'notifications/cancelled' || method.startsWith('notifications/')) {
    return { reply: null };
  }

  if (method === 'ping') return { reply: result(id, {}) };

  if (method === 'tools/list') {
    return { reply: result(id, { tools: TOOLS }) };
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = params.arguments !== null && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : {};
    const tool = TOOLS.find((entry) => entry.name === name);
    if (tool === undefined) return { reply: rpcError(id, -32602, `no such tool: ${name}`) };
    const outcome = callTool(store, name, args);
    const text = JSON.stringify(outcome.payload);
    return {
      reply: result(id, {
        content: [{ type: 'text', text }],
        structuredContent: outcome.payload,
        isError: outcome.isError,
      }),
    };
  }

  if (method === 'resources/list') return { reply: result(id, { resources: [] }) };
  if (method === 'prompts/list') return { reply: result(id, { prompts: [] }) };

  if (isNotification) return { reply: null };
  return { reply: rpcError(id, -32601, `method not found: ${method}`) };
}

export interface McpReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  empty?: boolean;
}

export function handleMcp(store: Store, rawBody: string): McpReply {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error: the body is not JSON') };
  }

  const batch = Array.isArray(payload) ? payload : null;
  const requests = batch ?? [payload];
  const replies: Array<Record<string, unknown>> = [];
  for (const entry of requests) {
    if (entry === null || typeof entry !== 'object') {
      replies.push(rpcError(null, -32600, 'Invalid Request'));
      continue;
    }
    const outcome = handleOne(store, entry as RpcRequest);
    if (outcome.reply !== null) replies.push(outcome.reply);
  }

  if (batch !== null) {
    if (replies.length === 0) return { status: 202, empty: true };
    return { status: 200, body: replies };
  }
  if (replies.length === 0) return { status: 202, empty: true };
  return { status: 200, body: replies[0] };
}

export { TOOLS, REVISIONS };
