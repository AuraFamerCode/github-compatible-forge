// Git smart HTTP (upload-pack v2, receive-pack v0) over the store, with no git binary anywhere.
//
// The suite speaks both services in process: v2 fetch (`ls-refs`, `fetch` with wants/haves/shallow
// and a sideband packfile section) and the v0 push command list with report-status.

import {
  FLUSH,
  ZERO_SHA,
  parseCommit,
  parseTree,
  pktLine,
  readPack,
  writePack,
} from './git.ts';
import type { Obj } from './git.ts';
import {
  branches,
  deleteRef,
  flatten,
  history,
  isAncestor,
  mergeBase,
  resolveRef,
  setRef,
  tags,
} from './store.ts';
import type { Repo, Store } from './store.ts';

export interface SmartReply {
  status: number;
  body: Buffer;
  contentType: string;
}

const UPLOAD_PACK = 'git-upload-pack';
const RECEIVE_PACK = 'git-receive-pack';

const V0_UPLOAD_CAPS = [
  'multi_ack',
  'thin-pack',
  'side-band',
  'side-band-64k',
  'ofs-delta',
  'shallow',
  'deepen-since',
  'deepen-not',
  'deepen-relative',
  'no-progress',
  'include-tag',
  'multi_ack_detailed',
  'object-format=sha1',
  'agent=forge/1.0',
].join(' ');

const V0_RECEIVE_CAPS = [
  'report-status',
  'delete-refs',
  'side-band-64k',
  'quiet',
  'ofs-delta',
  'object-format=sha1',
  'agent=forge/1.0',
].join(' ');

interface Packet {
  readonly kind: 'data' | 'flush' | 'delim';
  readonly payload: Buffer;
}

/** Decode a pkt-line stream; control packets carry an empty payload. */
function decodePackets(buf: Buffer): Packet[] {
  const out: Packet[] = [];
  let at = 0;
  while (at + 4 <= buf.length) {
    const header = buf.toString('latin1', at, at + 4);
    if (!/^[0-9a-f]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    at += 4;
    if (length === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      continue;
    }
    if (length === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      continue;
    }
    if (length === 2) continue; // response-end
    const end = at + length - 4;
    out.push({ kind: 'data', payload: buf.subarray(at, Math.min(end, buf.length)) });
    at = end;
  }
  return out;
}

function text(packet: Packet): string {
  return packet.payload.toString('utf8');
}

// --------------------------------------------------------------------------- advertisement

function v2Advertisement(): Buffer {
  const lines = [
    pktLine('version 2\n'),
    pktLine('agent=forge/1.0\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('server-option\n'),
    pktLine('object-format=sha1\n'),
    pktLine('object-info\n'),
  ];
  return Buffer.concat([...lines, FLUSH]);
}

function refAdvertLines(repo: Repo, service: string): Buffer {
  const parts: Buffer[] = [];
  const head = resolveRef(repo, repo.defaultBranch);
  const branchRefs = branches(repo);
  const tagRefs = tags(repo);
  const caps = service === UPLOAD_PACK ? `${V0_UPLOAD_CAPS} symref=HEAD:refs/heads/${repo.defaultBranch}` : V0_RECEIVE_CAPS;

  if (service === UPLOAD_PACK) {
    if (head === null) {
      parts.push(pktLine(`${ZERO_SHA} capabilities^{}\u0000${caps}\n`));
      return Buffer.concat([...parts, FLUSH]);
    }
    parts.push(pktLine(`${head} HEAD\u0000${caps}\n`));
    for (const branch of branchRefs) parts.push(pktLine(`${branch.sha} refs/heads/${branch.name}\n`));
    for (const tag of tagRefs) {
      parts.push(pktLine(`${tag.sha} refs/tags/${tag.name}\n`));
      const object = repo.objects.get(tag.sha);
      if (object !== undefined && object.type === 'tag') {
        const peeled = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'))?.[1];
        if (peeled !== undefined) parts.push(pktLine(`${peeled} refs/tags/${tag.name}^{}\n`));
      }
    }
    return Buffer.concat([...parts, FLUSH]);
  }

  // receive-pack: no HEAD, and an empty repository advertises a zero-id capabilities line.
  if (branchRefs.length === 0 && tagRefs.length === 0) {
    parts.push(pktLine(`${ZERO_SHA} capabilities^{}\u0000${caps}\n`));
    return Buffer.concat([...parts, FLUSH]);
  }
  let first = true;
  for (const branch of branchRefs) {
    parts.push(pktLine(first ? `${branch.sha} refs/heads/${branch.name}\u0000${caps}\n` : `${branch.sha} refs/heads/${branch.name}\n`));
    first = false;
  }
  for (const tag of tagRefs) {
    parts.push(pktLine(first ? `${tag.sha} refs/tags/${tag.name}\u0000${caps}\n` : `${tag.sha} refs/tags/${tag.name}\n`));
    first = false;
  }
  return Buffer.concat([...parts, FLUSH]);
}

function preamble(service: string): Buffer {
  return Buffer.concat([pktLine(`# service=${service}\n`), FLUSH]);
}

// --------------------------------------------------------------------------- object graphs

function commitParents(repo: Repo, sha: string): string[] {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return [];
  return parseCommit(object.data).parents;
}

/** Every object id reachable from `tip`, commits+tags+trees+blobs. */
function reachableObjects(repo: Repo, tip: string, into: Set<string>): void {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    into.add(sha);
    const object = repo.objects.get(sha);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      const parsed = parseCommit(object.data);
      stack.push(parsed.tree);
      for (const parent of parsed.parents) stack.push(parent);
    } else if (object.type === 'tag') {
      const target = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'))?.[1];
      if (target !== undefined) stack.push(target);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.sha);
    }
  }
}

/** Commits to send for `wants` at `depth`, and the shallow boundary the client must record. */
function shallowCommits(repo: Repo, wants: readonly string[], depth: number | null, existingShallow: readonly string[]): { commits: string[]; boundary: string[] } {
  // A deepen request re-walks from the tips: the client's current boundary no longer stops the walk.
  const block = new Set(depth === null ? existingShallow : []);
  if (depth === null) {
    const commits: string[] = [];
    const seen = new Set<string>();
    const stack: Array<{ sha: string; level: number }> = wants.map((sha) => ({ sha, level: 0 }));
    while (stack.length > 0) {
      const item = stack.pop() as { sha: string; level: number };
      if (seen.has(item.sha) || block.has(item.sha)) continue;
      seen.add(item.sha);
      const object = repo.objects.get(item.sha);
      if (object === undefined) continue;
      if (object.type === 'tag') {
        const target = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'))?.[1];
        if (target !== undefined) stack.push({ sha: target, level: 0 });
        continue;
      }
      if (object.type !== 'commit') continue;
      commits.push(item.sha);
      for (const parent of commitParents(repo, item.sha)) stack.push({ sha: parent, level: item.level + 1 });
    }
    return { commits, boundary: [] };
  }

  const commits: string[] = [];
  const boundary = new Set<string>();
  const seen = new Set<string>();
  const queue: Array<{ sha: string; level: number }> = wants.map((sha) => ({ sha, level: 0 }));
  while (queue.length > 0) {
    const item = queue.shift() as { sha: string; level: number };
    if (seen.has(item.sha) || block.has(item.sha)) continue;
    const object = repo.objects.get(item.sha);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      const target = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'))?.[1];
      if (target !== undefined) queue.push({ sha: target, level: 0 });
      continue;
    }
    if (object.type !== 'commit') continue;
    seen.add(item.sha);
    commits.push(item.sha);
    if (item.level + 1 >= depth) {
      boundary.add(item.sha);
      continue;
    }
    for (const parent of commitParents(repo, item.sha)) queue.push({ sha: parent, level: item.level + 1 });
  }
  return { commits, boundary: [...boundary] };
}

function packFor(repo: Repo, wants: readonly string[], exclude: Set<string>, depth: number | null, existingShallow: readonly string[]): { pack: Buffer; boundary: string[]; count: number } {
  const { commits, boundary } = shallowCommits(repo, wants, depth, existingShallow);
  const include = new Set<string>();
  for (const sha of wants) if (repo.objects.has(sha)) include.add(sha);
  for (const sha of commits) include.add(sha);
  // Trees and blobs of every included commit.
  for (const sha of [...include]) {
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') continue;
    const tree = parseCommit(object.data).tree;
    const stack = [tree];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (include.has(current) || exclude.has(current)) continue;
      include.add(current);
      const node = repo.objects.get(current);
      if (node === undefined) continue;
      if (node.type === 'tree') for (const entry of parseTree(node.data)) stack.push(entry.sha);
    }
  }
  const objects: Obj[] = [];
  for (const sha of include) {
    if (exclude.has(sha)) continue;
    const object = repo.objects.get(sha);
    if (object !== undefined) objects.push(object);
  }
  return { pack: objects.length === 0 ? Buffer.alloc(0) : writePack(objects), boundary, count: objects.length };
}

// --------------------------------------------------------------------------- v2 ls-refs

function lsRefs(repo: Repo, request: Packet[]): Buffer {
  const prefixes: string[] = [];
  let symrefs = false;
  let peel = false;
  let unborn = false;
  for (const packet of request) {
    if (packet.kind !== 'data') continue;
    const line = text(packet).replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    else if (line.startsWith('server-option')) {
      // no server options are meaningful here
    }
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const head = resolveRef(repo, repo.defaultBranch);
  if (matches('HEAD')) {
    const target = `symref-target:refs/heads/${repo.defaultBranch}`;
    if (head !== null) parts.push(pktLine(`${head} HEAD${symrefs ? ` ${target}` : ''}\n`));
    else if (unborn) parts.push(pktLine(`unborn HEAD${symrefs ? ` ${target}` : ''}\n`));
  }
  for (const branch of branches(repo)) {
    const name = `refs/heads/${branch.name}`;
    if (matches(name)) parts.push(pktLine(`${branch.sha} ${name}\n`));
  }
  for (const tag of tags(repo)) {
    const name = `refs/tags/${tag.name}`;
    if (!matches(name)) continue;
    const object = repo.objects.get(tag.sha);
    let peeled: string | undefined;
    if (object !== undefined && object.type === 'tag') {
      peeled = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'))?.[1];
    }
    // v2 reports a peeled tag as an attribute of its own line, never as a `^{}` ref.
    parts.push(pktLine(`${tag.sha} ${name}${peel && peeled !== undefined ? ` peeled:${peeled}` : ''}\n`));
  }
  return Buffer.concat([...parts, FLUSH]);
}

// --------------------------------------------------------------------------- sideband

function sideband(payload: Buffer): Buffer {
  const parts: Buffer[] = [];
  const chunk = 60_000;
  for (let at = 0; at < payload.length; at += chunk) {
    const slice = payload.subarray(at, at + chunk);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// --------------------------------------------------------------------------- v2 fetch

function v2Fetch(repo: Repo, request: Packet[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let done = false;
  for (const packet of request) {
    if (packet.kind !== 'data') continue;
    const line = text(packet).replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
    else if (line === 'done') done = true;
  }

  const headers: Buffer[] = [];
  const sections: Buffer[] = [];

  // A deepen sends the objects the client's boundary hid, so its haves must not exclude them.
  const exclude = new Set<string>();
  if (depth === null) {
    for (const have of haves) {
      if (repo.objects.has(have)) reachableObjects(repo, have, exclude);
      else exclude.add(have);
    }
  } else {
    for (const boundary of shallow) exclude.add(boundary);
  }

  const { pack, boundary, count } = packFor(repo, wants, exclude, depth, shallow);

  if (haves.length > 0) {
    const acks: Buffer[] = [];
    let any = false;
    for (const have of haves) {
      if (repo.objects.has(have)) {
        acks.push(pktLine(`ACK ${have}\n`));
        any = true;
      }
    }
    if (!any) acks.push(pktLine('NAK\n'));
    acks.push(FLUSH);
    sections.push(Buffer.concat([pktLine('acknowledgments\n'), ...acks]));
  } else if (!done) {
    sections.push(Buffer.concat([pktLine('acknowledgments\n'), pktLine('NAK\n'), FLUSH]));
  }

  if (depth !== null) {
    const lines: Buffer[] = [];
    const before = new Set(shallow);
    for (const sha of boundary) lines.push(pktLine(`shallow ${sha}\n`));
    for (const sha of before) if (!boundary.includes(sha)) lines.push(pktLine(`unshallow ${sha}\n`));
    lines.push(FLUSH);
    sections.push(Buffer.concat([pktLine('shallow-info\n'), ...lines]));
  }

  if (count > 0) {
    sections.push(Buffer.concat([pktLine('packfile\n'), sideband(pack)]));
  } else if (!done) {
    sections.push(FLUSH);
  }

  return Buffer.concat([...headers, ...sections]);
}

// --------------------------------------------------------------------------- v0 fetch

/** The v0 upload-pack exchange: wants and deepen in the first section, haves and done in the second. */
function v0Fetch(repo: Repo, packets: Packet[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let sidebanded = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = text(packet).replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const parts = line.slice(5).trim().split(' ');
      wants.push(parts[0]);
      if (parts.includes('side-band-64k')) sidebanded = true;
    } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
  }
  const exclude = new Set<string>();
  if (depth === null) {
    for (const have of haves) {
      if (repo.objects.has(have)) reachableObjects(repo, have, exclude);
    }
  }
  const { pack, boundary, count } = packFor(repo, wants, exclude, depth, shallow);
  const parts: Buffer[] = [];
  if (depth !== null) {
    for (const sha of boundary) parts.push(pktLine(`shallow ${sha}\n`));
    for (const sha of shallow) if (!boundary.includes(sha)) parts.push(pktLine(`unshallow ${sha}\n`));
    parts.push(FLUSH);
  }
  const acknowledged = haves.filter((have) => repo.objects.has(have));
  if (acknowledged.length > 0) {
    parts.push(pktLine(`ACK ${acknowledged[acknowledged.length - 1]}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  if (count > 0) {
    if (sidebanded) parts.push(sideband(pack));
    else parts.push(pack);
  }
  return Buffer.concat(parts);
}

// --------------------------------------------------------------------------- receive-pack

function parseReceiveCommands(body: Buffer): { commands: Array<{ old: string; new: string; ref: string }>; capabilities: string[]; packStart: number } {
  const commands: Array<{ old: string; new: string; ref: string }> = [];
  const capabilities: string[] = [];
  let at = 0;
  while (at + 4 <= body.length) {
    const header = body.toString('latin1', at, at + 4);
    if (!/^[0-9a-f]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    at += 4;
    if (length === 0) break;
    if (length < 5) continue;
    const payload = body.subarray(at, at + length - 4);
    at += length - 4;
    const line = payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\u0000');
    const command = nul < 0 ? line : line.slice(0, nul);
    if (nul >= 0) capabilities.push(...line.slice(nul + 1).split(' ').filter((entry) => entry !== ''));
    const parts = command.split(' ');
    if (parts.length >= 3) commands.push({ old: parts[0], new: parts[1], ref: parts.slice(2).join(' ') });
  }
  return { commands, capabilities, packStart: at };
}

function reportStatus(lines: string[], sidebanded: boolean): Buffer {
  const packets: Buffer[] = [];
  for (const line of lines) packets.push(pktLine(`${line}\n`));
  packets.push(FLUSH);
  const stream = Buffer.concat(packets);
  if (!sidebanded) return stream;
  return sideband(stream);
}

function receivePack(repo: Repo, body: Buffer): Buffer {
  const { commands, capabilities, packStart } = parseReceiveCommands(body);
  const sidebanded = capabilities.includes('side-band-64k');
  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = body.subarray(packStart);
  if (packBytes.length >= 32 && packBytes.toString('latin1', 0, 4) === 'PACK') {
    try {
      const read = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [sha, object] of read.objects) {
        if (!repo.objects.has(sha)) repo.objects.set(sha, object);
      }
    } catch (error) {
      unpackOk = false;
      unpackDetail = error instanceof Error ? error.message : 'unpack failed';
    }
  }

  const report: string[] = [`unpack ${unpackOk ? 'ok' : `error ${unpackDetail}`}`];
  for (const command of commands) {
    if (command.new === ZERO_SHA) {
      const existing = repo.refs.get(command.ref);
      if (existing === undefined) {
        report.push(`ng ${command.ref} delete-current`);
        continue;
      }
      deleteRef(repo, command.ref);
      report.push(`ok ${command.ref}`);
      continue;
    }
    if (!repo.objects.has(command.new)) {
      report.push(`ng ${command.ref} missing necessary objects`);
      continue;
    }
    const current = repo.refs.get(command.ref) ?? null;
    if (current !== null && command.old !== ZERO_SHA) {
      const fastForward = isAncestor(repo, command.old, command.new) || current === command.new;
      if (!fastForward) {
        report.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
    }
    setRef(repo, command.ref, command.new);
    report.push(`ok ${command.ref}`);
  }
  if (!unpackOk) {
    // A failed unpack refuses every ref it would have updated.
    const fixed = report[0];
    return reportStatus([fixed, ...commands.map((command) => `ng ${command.ref} unpacker error`)], sidebanded);
  }
  return reportStatus(report, sidebanded);
}

// --------------------------------------------------------------------------- entry point

export interface SmartTarget {
  readonly owner: string;
  readonly repo: string;
  readonly segments: readonly string[];
}

/** Split `/<owner>/<repo>.git/...` into its parts; null when the path is not a git service route. */
export function parseSmartPath(rawSegments: readonly string[]): SmartTarget | null {
  if (rawSegments.length < 3) return null;
  const owner = rawSegments[0];
  const repoName = rawSegments[1];
  if (!repoName.endsWith('.git')) return null;
  return { owner, repo: repoName.slice(0, -'.git'.length), segments: rawSegments.slice(2) };
}

export function handleSmart(
  store: Store,
  target: SmartTarget,
  method: string,
  query: URLSearchParams,
  protocolVersion: string,
  body: Buffer,
): SmartReply {
  const repo = store.owned(target.owner, target.repo);
  if (repo === undefined) {
    return { status: 404, body: Buffer.from('{"message":"Not Found"}\n', 'utf8'), contentType: 'application/json; charset=utf-8' };
  }
  const route = target.segments.join('/');

  if (method === 'GET' && route === 'info/refs') {
    const service = query.get('service') ?? '';
    if (service !== UPLOAD_PACK && service !== RECEIVE_PACK) {
      return { status: 403, body: Buffer.from('{"message":"Smart HTTP is required"}\n', 'utf8'), contentType: 'application/json; charset=utf-8' };
    }
    if (service === UPLOAD_PACK && /version=2/.test(protocolVersion)) {
      return { status: 200, body: v2Advertisement(), contentType: `application/x-${service}-advertisement` };
    }
    return {
      status: 200,
      body: Buffer.concat([preamble(service), refAdvertLines(repo, service)]),
      contentType: `application/x-${service}-advertisement`,
    };
  }

  if (method === 'POST' && route === UPLOAD_PACK) {
    const packets = decodePackets(body);
    const command = packets.length > 0 && packets[0].kind === 'data' ? text(packets[0]).trim() : '';
    const args = packets.slice(1);
    let response: Buffer;
    if (command === 'command=ls-refs') response = lsRefs(repo, args);
    else if (command === 'command=fetch') response = v2Fetch(repo, args);
    else response = v0Fetch(repo, packets);
    return { status: 200, body: response, contentType: `application/x-${UPLOAD_PACK}-result` };
  }

  if (method === 'POST' && route === RECEIVE_PACK) {
    return { status: 200, body: receivePack(repo, body), contentType: `application/x-${RECEIVE_PACK}-result` };
  }

  return { status: 404, body: Buffer.from('{"message":"Not Found"}\n', 'utf8'), contentType: 'application/json; charset=utf-8' };
}

export { mergeBase, flatten, history, writePack };
