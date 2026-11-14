// The store: one process, one in-memory forge. Every surface reads and writes through here, so the
// REST view, the git view, GraphQL and MCP always describe the same objects.

import {
  ZERO_SHA,
  buildCommit,
  hashObject,
  parseCommit,
  parseTree,
  serializeTree,
} from './git.ts';
import type { Identity, Obj, ObjType, TreeEntry } from './git.ts';

export interface User {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** The one account the trial's bearer token names (wire.ts's scenario viewer). */
export const VIEWER: User = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };

/** A user named by a repository path that is not the token's own: never readable with this token. */
export const STRANGER: User = { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' };

export interface Label {
  readonly id: number;
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly user: User;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly user: User;
  readonly created_at: string;
  updated_at: string;
  closed_at: string | null;
  readonly comments: IssueComment[];
}

export interface PullRequest {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly user: User;
  readonly created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface FileEntry {
  readonly sha: string;
  readonly mode: string;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  readonly private: boolean;
  defaultBranch: string;
  readonly created_at: string;
  updated_at: string;
  pushed_at: string | null;
  readonly objects: Map<string, Obj>;
  readonly refs: Map<string, string>;
  readonly issues: Issue[];
  readonly pulls: PullRequest[];
  readonly labels: Label[];
  nextIssueNumber: number;
  nextPullNumber: number;
  nextIssueId: number;
  nextCommentId: number;
  nextLabelId: number;
  /** Flattened tree cache: `${commit}\u0000${tree}` -> paths. */
  readonly flatCache: Map<string, Map<string, FileEntry>>;
}

// --------------------------------------------------------------------------- clock

// A monotonic clock: timestamps order events deterministically even inside one millisecond, which
// keeps issue and pull listings stable between a trial and its replay.
let lastMs = Date.UTC(2026, 0, 1, 0, 0, 0);
let lastIso = '';
export function nowIso(): string {
  const ms = Math.max(Date.now(), lastMs + 1);
  lastMs = ms;
  lastIso = new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return lastIso;
}
export function lastTimestamp(): string {
  return lastIso === '' ? nowIso() : lastIso;
}

// --------------------------------------------------------------------------- the store

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 9000;

  key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  get(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  /** The repository when the token's own login owns it; undefined for a foreign or absent path. */
  owned(owner: string, name: string): Repo | undefined {
    if (owner.toLowerCase() !== VIEWER.login) return undefined;
    return this.get(owner, name);
  }

  create(owner: string, name: string, description: string, isPrivate: boolean, defaultBranch: string): Repo {
    const existing = this.get(owner, name);
    if (existing !== undefined) return existing;
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch,
      created_at: nowIso(),
      updated_at: nowIso(),
      pushed_at: null,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextIssueId: 1,
      nextCommentId: 1,
      nextLabelId: 1,
      flatCache: new Map(),
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  delete(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** Every repository the viewer owns, in creation (id) order. */
  listOwned(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner.toLowerCase() === VIEWER.login) out.push(repo);
    return out.sort((a, b) => a.id - b.id);
  }
}

// --------------------------------------------------------------------------- objects and refs

export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

export function getObject(repo: Repo, sha: string): Obj | undefined {
  return repo.objects.get(sha);
}

export function refName(ref: string): string {
  if (ref.startsWith('refs/')) return ref;
  return `refs/heads/${ref}`;
}

export function resolveRef(repo: Repo, ref: string): string | null {
  if (ref === '' || ref === 'HEAD') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const direct = repo.refs.get(refName(ref));
  if (direct !== undefined) return direct;
  // A commit sha is a valid "ref" for the REST reads that accept one.
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
  return null;
}

export function branchOf(repo: Repo, ref: string): string {
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  if (ref.startsWith('refs/')) return ref;
  return ref;
}

export function commitTree(repo: Repo, commitSha: string): string | null {
  const object = repo.objects.get(commitSha);
  if (object === undefined) return null;
  if (object.type === 'commit') return parseCommit(object.data).tree;
  if (object.type === 'tree') return commitSha;
  return null;
}

/** Every path reachable from a commit's tree, with its blob sha and mode. */
export function flatten(repo: Repo, commitSha: string): Map<string, FileEntry> {
  const cached = repo.flatCache.get(commitSha);
  if (cached !== undefined) return cached;
  const out = new Map<string, FileEntry>();
  const tree = commitTree(repo, commitSha);
  if (tree !== null) walkTree(repo, tree, '', out);
  repo.flatCache.set(commitSha, out);
  return out;
}

function walkTree(repo: Repo, treeSha: string, prefix: string, out: Map<string, FileEntry>): void {
  const object = repo.objects.get(treeSha);
  if (object === undefined || object.type !== 'tree') return;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') walkTree(repo, entry.sha, path, out);
    else out.set(path, { sha: entry.sha, mode: entry.mode });
  }
}

interface TreeNode {
  readonly children: Map<string, TreeNode | FileEntry>;
}

function marker(entry: FileEntry | TreeNode): entry is FileEntry {
  return (entry as FileEntry).sha !== undefined;
}

/** Write a tree (nested or flat) for `files` and answer its sha. */
export function writeTree(repo: Repo, files: Map<string, FileEntry>): string {
  const root: TreeNode = { children: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/').filter((part) => part !== '');
    let node = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index];
      let next = node.children.get(part);
      if (next === undefined || marker(next)) {
        const created: TreeNode = { children: new Map() };
        node.children.set(part, created);
        next = created;
      }
      node = next as TreeNode;
    }
    node.children.set(parts[parts.length - 1], entry);
  }
  const emit = (node: TreeNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, child] of node.children) {
      if (marker(child)) entries.push({ mode: child.mode, name, sha: child.sha });
      else entries.push({ mode: '40000', name, sha: emit(child) });
    }
    return putObject(repo, 'tree', serializeTree(entries));
  };
  return emit(root);
}

export function identityOf(user: User, epoch: number): Identity {
  return { name: user.name, email: user.email, epoch, tz: '+0000' };
}

export function epochOf(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000);
}

/** Create a commit for `files` on top of `parents` and answer its sha (the ref is the caller's). */
export function makeCommit(
  repo: Repo,
  files: Map<string, FileEntry>,
  parents: readonly string[],
  message: string,
  author: User,
): string {
  const tree = writeTree(repo, files);
  const when = epochOf(nowIso());
  const data = buildCommit({
    tree,
    parents,
    author: identityOf(author, when),
    committer: identityOf(author, when),
    message,
  });
  return putObject(repo, 'commit', data);
}

export function setRef(repo: Repo, ref: string, sha: string): void {
  repo.refs.set(refName(ref), sha);
  repo.pushed_at = nowIso();
  repo.updated_at = repo.pushed_at;
}

export function deleteRef(repo: Repo, ref: string): boolean {
  return repo.refs.delete(refName(ref));
}

export function branches(repo: Repo): Array<{ name: string; sha: string }> {
  const out: Array<{ name: string; sha: string }> = [];
  for (const [name, sha] of repo.refs) {
    if (name.startsWith('refs/heads/')) out.push({ name: name.slice('refs/heads/'.length), sha });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function tags(repo: Repo): Array<{ name: string; sha: string }> {
  const out: Array<{ name: string; sha: string }> = [];
  for (const [name, sha] of repo.refs) {
    if (name.startsWith('refs/tags/')) out.push({ name: name.slice('refs/tags/'.length), sha });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Walk first parents from `from` until `stop` (inclusive), newest first; `limit` caps the list. */
export function history(repo: Repo, from: string | null, limit = 100): string[] {
  const out: string[] = [];
  let current = from;
  while (current !== null && out.length < limit) {
    if (repo.objects.get(current) === undefined) break;
    out.push(current);
    const parsed = repo.objects.get(current)?.type === 'commit' ? parseCommit(repo.objects.get(current)!.data) : null;
    current = parsed !== null && parsed.parents.length > 0 ? parsed.parents[0] : null;
  }
  return out;
}

/** The nearest commit reachable from both tips (by first-parent, then by full ancestry when needed). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestors = new Set<string>();
  for (const sha of history(repo, a, 10_000)) ancestors.add(sha);
  for (const sha of history(repo, b, 10_000)) if (ancestors.has(sha)) return sha;
  return null;
}

export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  for (const sha of history(repo, descendant, 10_000)) if (sha === ancestor) return true;
  return false;
}

export interface DiffEntry {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly sha: string;
  readonly previousSha: string | null;
}

function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  let count = 1;
  for (let index = 0; index < data.length; index += 1) if (data[index] === 0x0a) count += 1;
  if (data[data.length - 1] === 0x0a) count -= 1;
  return count;
}

/** The change list between two commits' trees, in path order. */
export function diffCommits(repo: Repo, base: string | null, head: string | null): DiffEntry[] {
  const before = base === null ? new Map<string, FileEntry>() : flatten(repo, base);
  const after = head === null ? new Map<string, FileEntry>() : flatten(repo, head);
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  const out: DiffEntry[] = [];
  for (const path of [...paths].sort()) {
    const from = before.get(path);
    const to = after.get(path);
    if (from !== undefined && to !== undefined && from.sha === to.sha && from.mode === to.mode) continue;
    const fromLines = from === undefined ? 0 : lineCount(repo.objects.get(from.sha)?.data ?? Buffer.alloc(0));
    const toLines = to === undefined ? 0 : lineCount(repo.objects.get(to.sha)?.data ?? Buffer.alloc(0));
    const status = from === undefined ? 'added' : to === undefined ? 'removed' : 'modified';
    const additions = status === 'removed' ? 0 : status === 'added' ? toLines : Math.max(0, toLines - Math.min(fromLines, toLines));
    const deletions = status === 'added' ? 0 : status === 'removed' ? fromLines : Math.max(0, fromLines - Math.min(fromLines, toLines));
    out.push({
      path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      sha: to?.sha ?? from?.sha ?? ZERO_SHA,
      previousSha: from?.sha ?? null,
    });
  }
  return out;
}

export interface MergeResult {
  readonly ok: boolean;
  readonly files?: Map<string, FileEntry>;
}

/** Three-way merge of `head` into `base` from their common ancestor; a same-path clash conflicts. */
export function mergeTrees(repo: Repo, base: string, head: string): MergeResult {
  const ancestor = mergeBase(repo, base, head);
  if (ancestor === head) return { ok: true, files: flatten(repo, base) };
  const baseFiles = flatten(repo, base);
  const headFiles = flatten(repo, head);
  const commonFiles = ancestor === null ? new Map<string, FileEntry>() : flatten(repo, ancestor);
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  const merged = new Map<string, FileEntry>();
  for (const path of paths) {
    const ours = baseFiles.get(path);
    const theirs = headFiles.get(path);
    const common = commonFiles.get(path);
    const oursSame = ours?.sha === common?.sha;
    const theirsSame = theirs?.sha === common?.sha;
    if (ours?.sha === theirs?.sha) {
      if (ours !== undefined) merged.set(path, ours);
    } else if (oursSame) {
      if (theirs !== undefined) merged.set(path, theirs);
    } else if (theirsSame) {
      if (ours !== undefined) merged.set(path, ours);
    } else {
      return { ok: false };
    }
  }
  return { ok: true, files: merged };
}
