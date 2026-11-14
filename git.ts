// Git's object model and packfile wire format, on node:crypto and node:zlib alone.
//
// Objects are the store's only source of truth: REST contents writes, git pushes and squash merges
// all produce the same blobs, trees and commits, so a clone and the REST view can never disagree.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface Obj {
  readonly type: ObjType;
  readonly data: Buffer;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly sha: string;
}

export const TYPE_NUM: Readonly<Record<ObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Readonly<Record<number, ObjType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export const ZERO_SHA = '0000000000000000000000000000000000000000';

export function sha1(bytes: Buffer | string): string {
  return createHash('sha1').update(bytes).digest('hex');
}

/** The object id of `type`+`data`: sha1 of Git's `<type> <len>\0<payload>` header and payload. */
export function hashObject(type: ObjType, data: Buffer): string {
  return sha1(Buffer.concat([Buffer.from(`${type} ${data.length}\u0000`, 'latin1'), data]));
}

// --------------------------------------------------------------------------- trees

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.toString('latin1', at, space),
      name: data.toString('utf8', space + 1, nul),
      sha: data.toString('hex', nul + 1, nul + 21),
    });
    at = nul + 21;
  }
  return entries;
}

/** Git's tree order: entry names compared as bytes, a directory as if its name ended in '/'. */
function compareEntries(a: TreeEntry, b: TreeEntry): number {
  const left = a.name + (a.mode === '40000' ? '/' : '');
  const right = b.name + (b.mode === '40000' ? '/' : '');
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

// --------------------------------------------------------------------------- commits

export interface Identity {
  readonly name: string;
  readonly email: string;
  /** Seconds since the epoch. */
  readonly epoch: number;
  /** `+0000` and friends. */
  readonly tz: string;
}

export function identityLine(identity: Identity): string {
  return `${identity.name} <${identity.email}> ${identity.epoch} ${identity.tz}`;
}

export function buildCommit(o: {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: Identity;
  readonly committer: Identity;
  readonly message: string;
  readonly extra?: readonly string[];
}): Buffer {
  const lines: string[] = [`tree ${o.tree}`];
  for (const parent of o.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${identityLine(o.author)}`);
  lines.push(`committer ${identityLine(o.committer)}`);
  for (const line of o.extra ?? []) lines.push(line);
  const message = o.message.endsWith('\n') ? o.message : `${o.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export interface ParsedCommit {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7).trim();
    else if (line.startsWith('committer ')) committer = line.slice(10).trim();
  }
  return { tree, parents, author, committer, message };
}

// --------------------------------------------------------------------------- pack: writing

/** Serialize objects into a version-2 packfile (no deltas, checksummed). */
export function writePack(objects: readonly Obj[]): Buffer {
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  chunks.push(header);
  for (const object of objects) {
    let size = object.data.length;
    let byte = (TYPE_NUM[object.type] << 4) | (size & 0x0f);
    size >>>= 4;
    const head: number[] = [];
    while (size > 0) {
      head.push(byte | 0x80);
      byte = size & 0x7f;
      size >>>= 7;
    }
    head.push(byte);
    chunks.push(Buffer.from(head));
    chunks.push(deflateSync(object.data));
  }
  const body = Buffer.concat(chunks);
  return Buffer.concat([body, Buffer.from(sha1(body), 'hex')]);
}

// --------------------------------------------------------------------------- pack: reading

/**
 * Inflate one zlib stream from `buf` at `start`, answering the data and how many input bytes it used.
 * `inflateSync` with `info: true` reports the bytes it consumed, so a pack can be walked object by
 * object without a second copy.
 */
function inflateAt(buf: Buffer, start: number): { data: Buffer; used: number } {
  const slice = buf.subarray(start);
  const result = inflateSync(slice, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, used: result.engine.bytesWritten };
}

function deltaVarint(delta: Buffer, cursor: { at: number }): number {
  let value = 0;
  let shift = 0;
  for (;;) {
    const byte = delta[cursor.at];
    cursor.at += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) return value >>> 0;
  }
}

/** Apply a Git delta (base + instructions) and answer the resulting bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const cursor = { at: 0 };
  deltaVarint(delta, cursor);
  const target = deltaVarint(delta, cursor);
  const out = Buffer.alloc(target);
  let written = 0;
  while (cursor.at < delta.length && written < target) {
    const op = delta[cursor.at];
    cursor.at += 1;
    if (op === 0) throw new Error('git delta: invalid opcode 0');
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset |= delta[cursor.at++] ?? 0;
      if (op & 0x02) offset |= (delta[cursor.at++] ?? 0) << 8;
      if (op & 0x04) offset |= (delta[cursor.at++] ?? 0) << 16;
      if (op & 0x08) offset |= (delta[cursor.at++] ?? 0) << 24;
      if (op & 0x10) size |= delta[cursor.at++] ?? 0;
      if (op & 0x20) size |= (delta[cursor.at++] ?? 0) << 8;
      if (op & 0x40) size |= (delta[cursor.at++] ?? 0) << 16;
      if (size === 0) size = 0x10000;
      base.copy(out, written, offset, offset + size);
      written += size;
    } else {
      delta.copy(out, written, cursor.at, cursor.at + op);
      written += op;
      cursor.at += op;
    }
  }
  return out;
}

export interface PackReadResult {
  /** Object id -> object, in pack order (deltas resolved). */
  readonly objects: Map<string, Obj>;
  /** Offset -> object id, for resolving `ofs-delta` bases. */
  readonly byOffset: Map<number, string>;
  readonly deltaCount: number;
}

/** Read a packfile: every entry, ofs/ref deltas resolved against the pack or `resolveBase`. */
export function readPack(buf: Buffer, resolveBase?: (oid: string) => Obj | undefined): PackReadResult {
  if (buf.length < 32 || buf.toString('latin1', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, Obj>();
  const byOffset = new Map<number, string>();
  const pending: Array<{ sha: string; type: ObjType | null; data: Buffer; baseOffset: number; baseSha: string | null; offset: number }> = [];
  let at = 12;
  let deltaCount = 0;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = at;
    let byte = buf[at++];
    const typeCode = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buf[at++];
      size += (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset = -1;
    let baseSha: string | null = null;
    if (typeCode === 6) {
      let byte2 = buf[at++];
      let value = byte2 & 0x7f;
      while ((byte2 & 0x80) !== 0) {
        byte2 = buf[at++];
        value = ((value + 1) << 7) | (byte2 & 0x7f);
      }
      baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      baseSha = buf.toString('hex', at, at + 20);
      at += 20;
    }
    const inflated = inflateAt(buf, at);
    at += inflated.used;
    const type = typeCode === 6 || typeCode === 7 ? null : NUM_TYPE[typeCode];
    if (type === undefined) throw new Error(`bad pack object type ${typeCode}`);
    if (typeCode === 6 || typeCode === 7) deltaCount += 1;
    pending.push({ sha: '', type, data: inflated.data, baseOffset, baseSha, offset: entryOffset });
  }
  // Resolve in pack order: an ofs-delta's base is always earlier in the pack.
  for (let index = 0; index < pending.length; index += 1) {
    const entry = pending[index];
    let type = entry.type;
    let data = entry.data;
    if (type === null) {
      let base: Obj | undefined;
      if (entry.baseOffset >= 0) {
        const baseSha = byOffset.get(entry.baseOffset);
        if (baseSha === undefined) throw new Error(`ofs-delta base offset ${entry.baseOffset} is not in the pack`);
        base = objects.get(baseSha);
      } else if (entry.baseSha !== null) {
        base = objects.get(entry.baseSha) ?? resolveBase?.(entry.baseSha);
      }
      if (base === undefined) throw new Error('delta base object is missing');
      data = applyDelta(base.data, entry.data);
      type = base.type;
    }
    const sha = hashObject(type, data);
    objects.set(sha, { type, data });
    byOffset.set(entry.offset, sha);
    pending[index].sha = sha;
  }
  return { objects, byOffset, deltaCount };
}

// --------------------------------------------------------------------------- pkt-line framing

export function pktLine(text: string | Buffer): Buffer {
  const payload = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
  const length = payload.length + 4;
  if (length > 65520) throw new Error('pkt-line too long');
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'latin1'), payload]);
}

export const FLUSH = Buffer.from('0000', 'latin1');
export const DELIM = Buffer.from('0001', 'latin1');
