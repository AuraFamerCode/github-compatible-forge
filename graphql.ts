// A small GraphQL v4 engine: the documents gh and github-mcp-server send, executed against the store.
//
// The parser handles operations (query/mutation), variable definitions, aliases, arguments with
// variables, inline objects, enum lists, inline fragments and named fragments. The executor answers
// the Query, Repository, Issue, PullRequest, connection and mutation-payload fields GitHub's own
// schema holds, plus `__type` introspection, and reports an unknown field as an `errors` entry.

import {
  VIEWER,
  diffCommits,
  flatten,
  makeCommit,
  mergeTrees,
  nowIso,
  resolveRef,
  setRef,
} from './store.ts';
import { parseCommit } from './git.ts';
import type { Issue, PullRequest, Repo, Store } from './store.ts';

export interface GraphQLReply {
  status: number;
  body: unknown;
}

// --------------------------------------------------------------------------- lexer and parser

type Token = { kind: 'name' | 'number' | 'string' | 'punct' | 'spread'; value: string };

function lex(text: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < text.length) {
    const ch = text[at];
    if (ch === '#' ) {
      while (at < text.length && text[at] !== '\n') at += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      at += 1;
      continue;
    }
    if (ch === '.' && text.startsWith('...', at)) {
      tokens.push({ kind: 'spread', value: '...' });
      at += 3;
      continue;
    }
    if (ch === '"' ) {
      if (text.startsWith('"""', at)) {
        const end = text.indexOf('"""', at + 3);
        const stop = end < 0 ? text.length : end;
        tokens.push({ kind: 'string', value: text.slice(at + 3, stop) });
        at = end < 0 ? text.length : end + 3;
        continue;
      }
      let value = '';
      at += 1;
      while (at < text.length && text[at] !== '"') {
        if (text[at] === '\\' && at + 1 < text.length) {
          const escape = text[at + 1];
          value += escape === 'n' ? '\n' : escape === 't' ? '\t' : escape;
          at += 2;
          continue;
        }
        value += text[at];
        at += 1;
      }
      at += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let value = ch;
      at += 1;
      while (at < text.length && /[0-9.eE+-]/.test(text[at])) {
        value += text[at];
        at += 1;
      }
      tokens.push({ kind: 'number', value });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let value = ch;
      at += 1;
      while (at < text.length && /[A-Za-z0-9_]/.test(text[at])) {
        value += text[at];
        at += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    tokens.push({ kind: 'punct', value: ch });
    at += 1;
  }
  return tokens;
}

interface Selection {
  kind: 'field' | 'inline' | 'spread';
  name?: string;
  alias?: string;
  args?: Record<string, Value>;
  typeName?: string;
  children?: Selection[];
  spreadName?: string;
}

type Value = { var: string } | string | number | boolean | null | Value[] | { [key: string]: Value };

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

class Parser {
  private readonly tokens: Token[];
  private at = 0;
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private next(): Token | undefined {
    return this.tokens[this.at++];
  }

  private accept(kind: 'punct' | 'name', value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === kind && token.value === value) {
      this.at += 1;
      return true;
    }
    return false;
  }

  private expect(kind: 'punct' | 'name', value: string): void {
    if (!this.accept(kind, value)) throw new Error(`expected ${value}`);
  }

  parseDocument(): { operation: Operation; fragments: Map<string, { typeName: string | null; selections: Selection[] }> } {
    const fragments = new Map<string, { typeName: string | null; selections: Selection[] }>();
    let operation: Operation | null = null;
    while (this.peek() !== undefined) {
      const token = this.peek();
      if (token?.kind === 'punct' && token.value === '{') {
        const selections = this.parseSelectionSet();
        operation = operation ?? { kind: 'query', name: null, selections };
        continue;
      }
      const keyword = this.next();
      if (keyword === undefined) break;
      if (keyword.kind === 'name' && keyword.value === 'fragment') {
        const name = this.next()?.value ?? '';
        this.expect('name', 'on');
        const typeName = this.next()?.value ?? null;
        fragments.set(name, { typeName, selections: this.parseSelectionSet() });
        continue;
      }
      if (keyword.kind === 'name' && (keyword.value === 'query' || keyword.value === 'mutation' || keyword.value === 'subscription')) {
        let name: string | null = null;
        if (this.peek()?.kind === 'name') name = this.next()?.value ?? null;
        if (this.accept('punct', '(')) {
          let depth = 1;
          while (depth > 0) {
            const token2 = this.next();
            if (token2 === undefined) break;
            if (token2.kind === 'punct' && token2.value === '(') depth += 1;
            if (token2.kind === 'punct' && token2.value === ')') depth -= 1;
          }
        }
        while (this.accept('punct', '@')) {
          this.next();
          if (this.accept('punct', '(')) {
            let depth = 1;
            while (depth > 0) {
              const token2 = this.next();
              if (token2 === undefined) break;
              if (token2.kind === 'punct' && token2.value === '(') depth += 1;
              if (token2.kind === 'punct' && token2.value === ')') depth -= 1;
            }
          }
        }
        const selections = this.parseSelectionSet();
        operation = operation ?? {
          kind: keyword.value === 'mutation' ? 'mutation' : 'query',
          name,
          selections,
        };
        continue;
      }
    }
    if (operation === null) throw new Error('the document holds no operation');
    return { operation, fragments };
  }

  private parseSelectionSet(): Selection[] {
    this.expect('punct', '{');
    const selections: Selection[] = [];
    while (!this.accept('punct', '}')) {
      const token = this.next();
      if (token === undefined) break;
      if (token.kind === 'spread') {
        if (this.accept('name', 'on')) {
          const typeName = this.next()?.value ?? '';
          selections.push({ kind: 'inline', typeName, children: this.parseSelectionSet() });
        } else {
          const spreadName = this.next()?.value ?? '';
          selections.push({ kind: 'spread', spreadName });
        }
        continue;
      }
      let alias: string | undefined;
      let name = token.value;
      if (this.accept('punct', ':')) {
        alias = name;
        name = this.next()?.value ?? '';
      }
      let args: Record<string, Value> | undefined;
      if (this.accept('punct', '(')) {
        args = {};
        while (!this.accept('punct', ')')) {
          const argName = this.next()?.value ?? '';
          this.expect('punct', ':');
          args[argName] = this.parseValue();
        }
      }
      while (this.accept('punct', '@')) {
        this.next();
        if (this.accept('punct', '(')) {
          let depth = 1;
          while (depth > 0) {
            const inner = this.next();
            if (inner === undefined) break;
            if (inner.kind === 'punct' && inner.value === '(') depth += 1;
            if (inner.kind === 'punct' && inner.value === ')') depth -= 1;
          }
        }
      }
      const children = this.peek()?.kind === 'punct' && this.peek()?.value === '{' ? this.parseSelectionSet() : undefined;
      selections.push({ kind: 'field', name, alias, args, children });
    }
    return selections;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token === undefined) throw new Error('value expected');
    if (token.kind === 'punct' && token.value === '$') {
      return { var: this.next()?.value ?? '' };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const list: Value[] = [];
      while (!this.accept('punct', ']')) list.push(this.parseValue());
      return list;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const object: { [key: string]: Value } = {};
      while (!this.accept('punct', '}')) {
        const key = this.next()?.value ?? '';
        this.expect('punct', ':');
        object[key] = this.parseValue();
      }
      return object;
    }
    if (token.kind === 'string') return token.value;
    if (token.kind === 'number') return Number(token.value);
    if (token.value === 'true') return true;
    if (token.value === 'false') return false;
    if (token.value === 'null') return null;
    return token.value;
  }
}

// --------------------------------------------------------------------------- schema

const SCHEMA_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'user', 'search', 'rateLimit', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'url',
    'isPrivate', 'createdAt', 'updatedAt', 'stargazerCount', 'isFork', 'languages', 'object',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'closed', 'closedAt', 'labels', 'comments', 'url', 'repository'],
  PullRequest: [
    'id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files',
    'body', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'headRefOid', 'baseRefOid',
    'isDraft', 'url', 'comments', 'labels', 'repository',
  ],
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl', 'databaseId'],
  Ref: ['id', 'name', 'target', 'prefix'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes', 'viewerViewedState'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  ReopenIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId', 'subject'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  IssueCommentEdge: ['node', 'cursor'],
  Label: ['id', 'name', 'color', 'description'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  Commit: ['id', 'oid', 'message', 'messageHeadline', 'committedDate', 'tree'],
  GitObject: ['id', 'oid', 'abbreviatedOid', 'commitUrl'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'type', 'args', 'isDeprecated'],
  __EnumValue: ['name', 'description', 'isDeprecated'],
};

const SCHEMA_ENUMS: Readonly<Record<string, readonly string[]>> = {
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

/** A resolved node: its GraphQL type name and the store object behind it. */
type Node = { __type: string; [key: string]: unknown };

interface ExecContext {
  readonly store: Store;
  readonly fragments: Map<string, { typeName: string | null; selections: Selection[] }>;
  readonly variables: Record<string, unknown>;
  readonly errors: Array<{ message: string; path: Array<string | number>; locations?: unknown[] }>;
}

class FieldError extends Error {}

function nodeType(node: unknown): string {
  if (node !== null && typeof node === 'object') {
    const type = (node as Record<string, unknown>).__type;
    if (typeof type === 'string') return type;
  }
  return '';
}

function repoOf(node: Node): Repo {
  return node.repo as Repo;
}

function issueOf(node: Node): Issue {
  return node.issue as Issue;
}

function pullOf(node: Node): PullRequest {
  return node.pull as PullRequest;
}

function globalId(type: string, ...parts: Array<string | number>): string {
  return Buffer.from(JSON.stringify([type, ...parts]), 'utf8').toString('base64').replace(/=+$/, '');
}

function parseGlobalId(id: string): [string, ...Array<string | number>] | null {
  try {
    const parsed = JSON.parse(Buffer.from(id, 'base64').toString('utf8')) as unknown;
    if (Array.isArray(parsed) && typeof parsed[0] === 'string') return parsed as [string, ...Array<string | number>];
    return null;
  } catch {
    return null;
  }
}

function userNode(login: string): Node {
  return { __type: 'User', login };
}

function issueNode(repo: Repo, issue: Issue): Node {
  return { __type: 'Issue', repo, issue };
}

function pullNode(repo: Repo, pull: PullRequest): Node {
  return { __type: 'PullRequest', repo, pull };
}

function mergeableState(repo: Repo, pull: PullRequest): string {
  const baseTip = resolveRef(repo, pull.baseRef);
  const headTip = resolveRef(repo, pull.headRef);
  if (baseTip === null || headTip === null) return 'UNKNOWN';
  return mergeTrees(repo, baseTip, headTip).ok ? 'MERGEABLE' : 'CONFLICTING';
}

function connection(items: Node[], args: Args, nodeTypeName: string): Node {
  const first = typeof args.first === 'number' ? args.first : items.length;
  const after = typeof args.after === 'string' ? Number.parseInt(Buffer.from(args.after, 'base64').toString('utf8'), 10) : 0;
  const start = Number.isFinite(after) && after > 0 ? after : 0;
  const page = items.slice(start, start + Math.max(0, first));
  const end = start + page.length;
  const edgeType = nodeTypeName === 'PullRequestChangedFile' ? 'PullRequestEdge' : nodeTypeName === 'IssueComment' ? 'IssueCommentEdge' : 'IssueEdge';
  return {
    __type: nodeTypeName === 'PullRequestChangedFile' ? 'PullRequestChangedFileConnection' : `${nodeTypeName}Connection`,
    nodes: page,
    edges: page.map((node, index) => ({ __type: edgeType, node, cursor: Buffer.from(String(start + index + 1), 'utf8').toString('base64') })),
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage: end < items.length,
      hasPreviousPage: start > 0,
      endCursor: page.length === 0 ? null : Buffer.from(String(end), 'utf8').toString('base64'),
      startCursor: page.length === 0 ? null : Buffer.from(String(start + 1), 'utf8').toString('base64'),
    },
    totalCount: items.length,
  };
}

type Args = Record<string, unknown>;
type Ast = { query: string; variables: Record<string, unknown> };

// --------------------------------------------------------------------------- execution

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, variables));
  if (typeof value === 'object') {
    if ('var' in value && typeof (value as { var: string }).var === 'string') return variables[(value as { var: string }).var] ?? null;
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = resolveValue(inner, variables);
    return out;
  }
  return value;
}

function argsOf(selection: Selection, context: ExecContext): Args {
  const out: Args = {};
  for (const [key, value] of Object.entries(selection.args ?? {})) out[key] = resolveValue(value, context.variables);
  return out;
}

function expand(selections: Selection[], context: ExecContext, typeName: string): Selection[] {
  const out: Selection[] = [];
  for (const selection of selections) {
    if (selection.kind === 'field') out.push(selection);
    else if (selection.kind === 'inline') {
      if (selection.typeName === undefined || selection.typeName === typeName || selection.typeName === 'Node') {
        out.push(...expand(selection.children ?? [], context, typeName));
      }
    } else if (selection.kind === 'spread') {
      const fragment = context.fragments.get(selection.spreadName ?? '');
      if (fragment !== undefined && (fragment.typeName === null || fragment.typeName === typeName || fragment.typeName === 'Node')) {
        out.push(...expand(fragment.selections, context, typeName));
      }
    }
  }
  return out;
}

/** Execute one selection set against a node; answers a plain JSON object. */
function executeSet(node: Node | null, selections: Selection[], context: ExecContext, path: Array<string | number>): unknown {
  if (node === null) return null;
  const typeName = nodeType(node);
  const out: Record<string, unknown> = {};
  for (const selection of expand(selections, context, typeName)) {
    const key = selection.alias ?? selection.name ?? '';
    const fieldName = selection.name ?? '';
    try {
      const value = resolveField(node, typeName, fieldName, argsOf(selection, context), context, [...path, key]);
      out[key] = applySelections(value, selection.children, context, [...path, key]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.errors.push({ message, path: [...path, key] });
      out[key] = null;
    }
  }
  return out;
}

function applySelections(value: unknown, selections: Selection[] | undefined, context: ExecContext, path: Array<string | number>): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry, index) => applySelections(entry, selections, context, [...path, index]));
  if (typeof value === 'object') {
    if (selections === undefined) return {} as Record<string, unknown>;
    const node = value as Node;
    if (nodeType(node) === '') return value as Record<string, unknown>;
    return executeSet(node, selections, context, path);
  }
  return value;
}

function requireType(typeName: string, fieldName: string): void {
  const fields = SCHEMA_FIELDS[typeName];
  if (fields !== undefined && !fields.includes(fieldName)) {
    throw new FieldError(`Field '${fieldName}' doesn't exist on type '${typeName}'`);
  }
}

function repoByName(store: Store, owner: unknown, name: unknown): Repo | null {
  if (typeof owner !== 'string' || typeof name !== 'string') return null;
  return store.owned(owner, name) ?? null;
}

function resolveField(node: Node, typeName: string, field: string, args: Args, context: ExecContext, path: Array<string | number>): unknown {
  const { store } = context;

  if (typeName === 'Query') {
    if (field === 'viewer') return userNode(VIEWER.login);
    if (field === 'repository') return withRepo(repoByName(store, args.owner, args.name));
    if (field === 'user') return typeof args.login === 'string' ? userNode(args.login) : null;
    if (field === 'node') {
      if (typeof args.id !== 'string') return null;
      const parsed = parseGlobalId(args.id);
      if (parsed === null) return null;
      const [kind, ...rest] = parsed;
      if (kind === 'Repository') {
        const repo = store.get(String(rest[0]), String(rest[1]));
        return repo === undefined ? null : { __type: 'Repository', repo };
      }
      if (kind === 'Issue') {
        const repo = store.get(String(rest[0]), String(rest[1]));
        const issue = repo?.issues.find((entry) => entry.number === Number(rest[2]));
        return repo !== undefined && issue !== undefined ? issueNode(repo, issue) : null;
      }
      if (kind === 'PullRequest') {
        const repo = store.get(String(rest[0]), String(rest[1]));
        const pull = repo?.pulls.find((entry) => entry.number === Number(rest[2]));
        return repo !== undefined && pull !== undefined ? pullNode(repo, pull) : null;
      }
      return null;
    }
    if (field === '__type') return introspectType(String(args.name ?? ''));
    if (field === '__schema') return { __type: '__Type', name: 'schema', kind: 'SCHEMA' };
    if (field === 'rateLimit') return { __type: 'RateLimit', limit: 5000, remaining: 4999, resetAt: nowIso() };
    if (field === 'search') return { __type: 'SearchResultItemConnection', nodes: [], edges: [], pageInfo: { __type: 'PageInfo', hasNextPage: false, endCursor: null }, totalCount: 0 };
    throw new FieldError(`Field '${field}' doesn't exist on type 'Query'`);
  }

  if (typeName === 'Mutation') {
    return resolveMutation(field, args, context);
  }

  if (typeName === 'Repository') {
    const repo = repoOf(node);
    if (field === 'id') return globalId('Repository', repo.owner, repo.name);
    if (field === 'databaseId') return repo.id;
    if (field === 'name') return repo.name;
    if (field === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (field === 'owner') return userNode(repo.owner);
    if (field === 'description') return repo.description;
    if (field === 'isPrivate') return repo.private;
    if (field === 'url') return `http://forge/${repo.owner}/${repo.name}`;
    if (field === 'createdAt' || field === 'updatedAt') return repo.updated_at;
    if (field === 'stargazerCount') return 0;
    if (field === 'isFork') return false;
    if (field === 'viewerPermission') return 'ADMIN';
    if (field === 'hasIssuesEnabled') return true;
    if (field === 'defaultBranchRef') {
      const sha = resolveRef(repo, repo.defaultBranch);
      if (sha === null) return null;
      return { __type: 'Ref', name: repo.defaultBranch, target: { __type: 'Commit', oid: sha, sha } };
    }
    if (field === 'issue') {
      const issue = repo.issues.find((entry) => entry.number === Number(args.number));
      return issue === undefined ? null : issueNode(repo, issue);
    }
    if (field === 'issues') {
      const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
      let issues = repo.issues.slice();
      if (states !== null && states.length > 0) issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
      const order = args.orderBy as { field?: string; direction?: string } | undefined;
      const orderField = order?.field ?? 'CREATED_AT';
      const direction = order?.direction ?? 'DESC';
      issues.sort((a, b) => {
        const left = orderField === 'UPDATED_AT' ? a.updated_at : orderField === 'COMMENTS' ? a.comments.length : a.created_at;
        const right = orderField === 'UPDATED_AT' ? b.updated_at : orderField === 'COMMENTS' ? b.comments.length : b.created_at;
        const cmp = left === right ? a.number - b.number : left < right ? -1 : 1;
        return direction === 'ASC' ? cmp : -cmp;
      });
      return connection(issues.map((issue) => issueNode(repo, issue)), args, 'Issue');
    }
    if (field === 'pullRequest') {
      const pull = repo.pulls.find((entry) => entry.number === Number(args.number));
      return pull === undefined ? null : pullNode(repo, pull);
    }
    if (field === 'pullRequests') {
      const pulls = repo.pulls.slice().sort((a, b) => b.number - a.number);
      return connection(pulls.map((pull) => pullNode(repo, pull)), args, 'PullRequest');
    }
    if (field === 'object') {
      const sha = typeof args.oid === 'string' ? args.oid : null;
      const object = sha === null ? undefined : repo.objects.get(sha);
      return object === undefined ? null : { __type: 'GitObject', oid: sha, abbreviatedOid: String(sha).slice(0, 7) };
    }
    if (field === 'languages') return { __type: 'LanguageConnection', nodes: [], totalCount: 0 };
    throw new FieldError(`Field '${field}' doesn't exist on type 'Repository'`);
  }

  if (typeName === 'Issue') {
    const repo = repoOf(node);
    const issue = issueOf(node);
    if (field === 'id') return globalId('Issue', repo.owner, repo.name, issue.number);
    if (field === 'number') return issue.number;
    if (field === 'title') return issue.title;
    if (field === 'body') return issue.body;
    if (field === 'state') return issue.state.toUpperCase();
    if (field === 'closed') return issue.state === 'closed';
    if (field === 'closedAt') return issue.closed_at;
    if (field === 'author') return userNode(issue.user.login);
    if (field === 'createdAt') return issue.created_at;
    if (field === 'updatedAt') return issue.updated_at;
    if (field === 'url') return `http://forge/${repo.owner}/${repo.name}/issues/${issue.number}`;
    if (field === 'repository') return { __type: 'Repository', repo };
    if (field === 'labels') return connection(issue.labels.map((name) => ({ __type: 'Label', name })), args, 'Label');
    if (field === 'comments') return connection(issue.comments.map((comment) => ({ __type: 'IssueComment', comment })), args, 'IssueComment');
    throw new FieldError(`Field '${field}' doesn't exist on type 'Issue'`);
  }

  if (typeName === 'PullRequest') {
    const repo = repoOf(node);
    const pull = pullOf(node);
    if (field === 'id') return globalId('PullRequest', repo.owner, repo.name, pull.number);
    if (field === 'number') return pull.number;
    if (field === 'title') return pull.title;
    if (field === 'body') return pull.body;
    if (field === 'state') return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    if (field === 'merged') return pull.merged;
    if (field === 'mergedAt') return pull.merged_at;
    if (field === 'headRefName') return pull.headRef;
    if (field === 'baseRefName') return pull.baseRef;
    if (field === 'headRefOid') return resolveRef(repo, pull.headRef) ?? pull.headSha;
    if (field === 'baseRefOid') return resolveRef(repo, pull.baseRef) ?? pull.baseSha;
    if (field === 'mergeable') return mergeableState(repo, pull);
    if (field === 'isDraft') return false;
    if (field === 'author') return userNode(pull.user.login);
    if (field === 'createdAt') return pull.created_at;
    if (field === 'updatedAt') return pull.updated_at;
    if (field === 'url') return `http://forge/${repo.owner}/${repo.name}/pull/${pull.number}`;
    if (field === 'repository') return { __type: 'Repository', repo };
    if (field === 'mergeCommit') return pull.merge_commit_sha === null ? null : { __type: 'Commit', oid: pull.merge_commit_sha };
    if (field === 'labels') return connection([], args, 'Label');
    if (field === 'comments') return connection([], args, 'IssueComment');
    if (field === 'files') {
      const changes = diffCommits(repo, resolveRef(repo, pull.baseRef) ?? pull.baseSha, resolveRef(repo, pull.headRef) ?? pull.headSha);
      return connection(
        changes.map((entry) => ({ __type: 'PullRequestChangedFile', path: entry.path, additions: entry.additions, deletions: entry.deletions, changes: entry.changes })),
        args,
        'PullRequestChangedFile',
      );
    }
    throw new FieldError(`Field '${field}' doesn't exist on type 'PullRequest'`);
  }

  if (typeName === 'User') {
    const login = String(node.login ?? '');
    if (field === 'login') return login;
    if (field === 'id') return globalId('User', login);
    if (field === 'databaseId') return login === VIEWER.login ? VIEWER.id : 0;
    if (field === 'name') return login === VIEWER.login ? VIEWER.name : login;
    if (field === 'email') return login === VIEWER.login ? VIEWER.email : `${login}@example.invalid`;
    if (field === 'url') return `http://forge/${login}`;
    if (field === 'avatarUrl') return `http://forge/avatars/${login}`;
  }

  if (typeName === 'Ref') {
    if (field === 'name') return node.name ?? null;
    if (field === 'id') return globalId('Ref', String(node.name ?? ''));
    if (field === 'prefix') return 'refs/heads/';
    if (field === 'target') return { __type: 'Commit', oid: node.sha ?? null };
  }

  if (typeName === 'Commit') {
    if (field === 'oid') return node.oid ?? node.sha ?? null;
    if (field === 'id') return globalId('Commit', String(node.oid ?? ''));
    if (field === 'messageHeadline') return node.webUrl ?? '';
    if (field === 'abbreviatedOid') return String(node.oid ?? '').slice(0, 7);
  }

  if (typeName === 'PageInfo') {
    if (field === 'hasNextPage') return node.hasNextPage === true;
    if (field === 'hasPreviousPage') return node.hasPreviousPage === true;
    if (field === 'endCursor') return node.endCursor ?? null;
    if (field === 'startCursor') return node.startCursor ?? null;
  }

  if (typeName === 'PullRequestChangedFile') {
    if (field === 'path') return node.path ?? null;
    if (field === 'additions') return node.additions ?? 0;
    if (field === 'deletions') return node.deletions ?? 0;
    if (field === 'changes') return node.changes ?? 0;
  }

  if (typeName === 'Label') {
    if (field === 'name') return node.name ?? null;
    if (field === 'id') return globalId('Label', String(node.name ?? ''));
    if (field === 'color') return 'ededed';
    if (field === 'description') return null;
  }

  if (typeName === 'IssueComment') {
    const comment = node.comment as { id: number; body: string; created_at: string } | undefined;
    if (field === 'id') return globalId('IssueComment', comment?.id ?? 0);
    if (field === 'body') return comment?.body ?? null;
    if (field === 'createdAt') return comment?.created_at ?? null;
    if (field === 'author') return userNode(VIEWER.login);
  }

  if (typeName === 'IssueCommentEdge') {
    if (field === 'node') return node.node ?? null;
    if (field === 'cursor') return node.cursor ?? null;
  }

  if (typeName === '__Type') {
    if (field === 'name') return node.name ?? null;
    if (field === 'kind') return node.kind ?? 'OBJECT';
    if (field === 'description') return null;
    if (field === 'fields') {
      const names = (node.fields as string[] | undefined) ?? [];
      return names.map((name) => ({ __type: '__Field', name }));
    }
    if (field === 'enumValues') {
      const names = (node.enumValues as string[] | undefined) ?? [];
      return names.map((name) => ({ __type: '__EnumValue', name }));
    }
  }

  if (typeName === '__Field' || typeName === '__EnumValue') {
    if (field === 'name') return node.name ?? null;
    if (field === 'description') return null;
    if (field === 'isDeprecated') return false;
    if (field === 'args') return [];
    if (field === 'type') return { __type: '__Type', name: 'String', kind: 'SCALAR' };
  }

  // Connections of any kind: nodes, edges, pageInfo, totalCount.
  if (field === 'nodes') return (node.nodes as unknown[]) ?? [];
  if (field === 'edges') return (node.edges as unknown[]) ?? [];
  if (field === 'pageInfo') return node.pageInfo ?? { __type: 'PageInfo', hasNextPage: false, endCursor: null };
  if (field === 'totalCount') return node.totalCount ?? 0;
  if (field === 'cursor') return node.cursor ?? null;
  if (field === 'commentEdge') return node.commentEdge ?? null;
  if (field === 'pullRequest') return node.pullRequest ?? null;
  if (field === 'issue') return node.issue ?? null;
  if (field === 'clientMutationId') return null;

  // Scalars on an untyped record (a payload, an edge).
  if (field === 'node') return node.node ?? null;
  throw new FieldError(`Field '${field}' doesn't exist on type '${typeName === '' ? 'Object' : typeName}'`);
}

function withRepo(repo: Repo | null): Node | null {
  return repo === null ? null : { __type: 'Repository', repo };
}

function introspectType(name: string): Node | null {
  const fields = SCHEMA_FIELDS[name];
  const enumValues = SCHEMA_ENUMS[name];
  if (fields === undefined && enumValues === undefined) return null;
  return {
    __type: '__Type',
    name,
    kind: fields !== undefined ? 'OBJECT' : 'ENUM',
    fields: fields ?? undefined,
    enumValues: enumValues ?? undefined,
  };
}

function findRepoById(store: Store, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed[0] !== 'Repository') return null;
  return store.get(String(parsed[1]), String(parsed[2])) ?? null;
}

function resolveMutation(field: string, args: Args, context: ExecContext): unknown {
  const { store } = context;
  const input = (args.input ?? {}) as Record<string, unknown>;

  if (field === 'createIssue') {
    const repo = findRepoById(store, input.repositoryId);
    if (repo === null) throw new FieldError('Could not resolve to a Repository with the global id given');
    const when = nowIso();
    const issue: Issue = {
      id: repo.nextIssueId++,
      number: repo.nextIssueNumber++,
      title: typeof input.title === 'string' ? input.title : '',
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      user: VIEWER,
      created_at: when,
      updated_at: when,
      closed_at: null,
      comments: [],
    };
    repo.issues.push(issue);
    return { __type: 'CreateIssuePayload', issue: issueNode(repo, issue) };
  }

  if (field === 'closeIssue' || field === 'reopenIssue') {
    const parsed = typeof input.issueId === 'string' ? parseGlobalId(input.issueId) : null;
    if (parsed === null) throw new FieldError('Could not resolve to an Issue with the global id given');
    const repo = store.get(String(parsed[1]), String(parsed[2]));
    const issue = repo?.issues.find((entry) => entry.number === Number(parsed[3]));
    if (repo === undefined || issue === undefined) throw new FieldError('Could not resolve to an Issue with the global id given');
    issue.state = field === 'closeIssue' ? 'closed' : 'open';
    issue.closed_at = field === 'closeIssue' ? nowIso() : null;
    issue.updated_at = issue.closed_at ?? nowIso();
    return { __type: field === 'closeIssue' ? 'CloseIssuePayload' : 'ReopenIssuePayload', issue: issueNode(repo, issue) };
  }

  if (field === 'createPullRequest') {
    const repo = findRepoById(store, input.repositoryId);
    if (repo === null) throw new FieldError('Could not resolve to a Repository with the global id given');
    const head = typeof input.headRefName === 'string' ? input.headRefName : '';
    const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
    const headSha = resolveRef(repo, head);
    const baseSha = resolveRef(repo, base);
    if (headSha === null || baseSha === null) throw new FieldError('No commits between the base and head branches');
    const when = nowIso();
    const pull: PullRequest = {
      id: repo.nextPullNumber + 5000,
      number: repo.nextPullNumber++,
      title: typeof input.title === 'string' ? input.title : '',
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
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
    return { __type: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull) };
  }

  if (field === 'mergePullRequest') {
    const parsed = typeof input.pullRequestId === 'string' ? parseGlobalId(input.pullRequestId) : null;
    if (parsed === null || parsed[0] !== 'PullRequest') throw new FieldError('Could not resolve to a PullRequest with the global id given');
    const repo = store.get(String(parsed[1]), String(parsed[2]));
    const pull = repo?.pulls.find((entry) => entry.number === Number(parsed[3]));
    if (repo === undefined || pull === undefined) throw new FieldError('Could not resolve to a PullRequest with the global id given');
    const baseTip = resolveRef(repo, pull.baseRef);
    const headTip = resolveRef(repo, pull.headRef);
    if (baseTip === null || headTip === null) throw new FieldError('Pull request is not mergeable');
    const merged = mergeTrees(repo, baseTip, headTip);
    if (!merged.ok || merged.files === undefined) throw new FieldError('Pull request has merge conflicts and cannot be merged');
    const commit = makeCommit(repo, merged.files, [baseTip], `${pull.title} (#${pull.number})`, VIEWER);
    setRef(repo, pull.baseRef, commit);
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = nowIso();
    pull.closed_at = pull.merged_at;
    pull.merge_commit_sha = commit;
    pull.updated_at = pull.merged_at;
    return { __type: 'MergePullRequestPayload', pullRequest: pullNode(repo, pull) };
  }

  if (field === 'addComment') {
    const parsed = typeof input.subjectId === 'string' ? parseGlobalId(input.subjectId) : null;
    if (parsed === null) throw new FieldError('Could not resolve to a node with the global id given');
    const repo = store.get(String(parsed[1]), String(parsed[2]));
    const issue = repo?.issues.find((entry) => entry.number === Number(parsed[3]));
    if (repo === undefined || issue === undefined) throw new FieldError('Could not resolve to a node with the global id given');
    const when = nowIso();
    const comment = { id: repo.nextCommentId++, body: typeof input.body === 'string' ? input.body : '', user: VIEWER, created_at: when, updated_at: when };
    issue.comments.push(comment);
    issue.updated_at = when;
    return {
      __type: 'AddCommentPayload',
      commentEdge: { __type: 'IssueCommentEdge', node: { __type: 'IssueComment', comment }, cursor: null },
    };
  }

  if (field === 'updateIssue') return { __type: 'UpdateIssuePayload', issue: null };
  throw new FieldError(`Field '${field}' doesn't exist on type 'Mutation'`);
}

// --------------------------------------------------------------------------- entry point

export function handleGraphQL(store: Store, payload: unknown): GraphQLReply {
  const runOne = (request: unknown): Record<string, unknown> => {
    const errors: Array<{ message: string; path: Array<string | number> }> = [];
    if (request === null || typeof request !== 'object' || typeof (request as Ast).query !== 'string') {
      return { data: null, errors: [{ message: 'the request names no query', path: [] }] };
    }
    const { query, variables: rawVariables } = request as Ast;
    const variables = rawVariables !== null && typeof rawVariables === 'object' ? (rawVariables as Record<string, unknown>) : {};
    let parsed: { operation: Operation; fragments: Map<string, { typeName: string | null; selections: Selection[] }> };
    try {
      parsed = new Parser(lex(query)).parseDocument();
    } catch (error) {
      return { data: null, errors: [{ message: error instanceof Error ? error.message : 'syntax error', path: [] }] };
    }
    const context: ExecContext = { store, fragments: parsed.fragments, variables, errors };
    const rootNode: Node = { __type: parsed.operation.kind === 'mutation' ? 'Mutation' : 'Query' };
    const data = executeSet(rootNode, parsed.operation.selections, context, []);
    const body: Record<string, unknown> = { data };
    if (context.errors.length > 0) body.errors = context.errors;
    return body;
  };

  if (Array.isArray(payload)) {
    return { status: 200, body: payload.map((entry) => runOne(entry)) };
  }
  const single = runOne(payload);
  if (single.errors !== undefined && single.data === null) return { status: 400, body: single };
  return { status: 200, body: single };
}

export { flatten, parseCommit, VIEWER };
