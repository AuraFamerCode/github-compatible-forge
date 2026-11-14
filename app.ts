// The forge's HTTP surface: one server, one store, four surfaces on it.
//
//   git smart HTTP   /<owner>/<repo>.git/{info/refs,git-upload-pack,git-receive-pack}
//   REST v3          /api/v3/...
//   GraphQL v4       /api/graphql
//   MCP              /mcp
//   health           /healthz
//
// Everything else answers GitHub's JSON 404. Every API reply carries an X-GitHub-Request-Id and is
// JSON, never HTML, and a request with no bearer token is 401 where the contract requires auth.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest, repoJson } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleSmart, parseSmartPath } from './smart.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

export const store = new Store();

// Request ids only have to be non-empty and distinct within a run; a counter costs far less than a
// UUID and keeps every reply's id in order.
let requestSeq = 0;
function nextRequestId(): string {
  requestSeq += 1;
  return `forge-${process.pid.toString(16)}-${requestSeq.toString(36)}`;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  sendText(res, status, `${JSON.stringify(body)}\n`, headers);
}

/** Send JSON that was serialized before the request (a cached, unchanged body). */
function sendText(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-cache',
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (error) => reject(error));
  });
}

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match === null ? '' : match[1].trim();
}

/** Parse a JSON body, answering undefined when it does not parse (a 400 for the caller). */
function parseJson(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  const text = raw.toString('utf8');
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function queryOf(url: URL): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of url.searchParams) if (!(key in out)) out[key] = value;
  return out;
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://forge');
  } catch {
    send(res, 400, { message: 'Bad Request' });
    return;
  }
  const path = url.pathname;
  const segments = path.split('/').filter((part) => part !== '').map((part) => decodeURIComponent(part));

  if (method === 'GET' && path === '/healthz') {
    send(res, 200, { ok: true });
    return;
  }

  const token = bearer(req);

  // ------------------------------------------------------------------ MCP
  if (segments.length === 1 && segments[0] === 'mcp') {
    if (token === '') {
      send(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: no bearer token' } });
      return;
    }
    if (method !== 'POST') {
      send(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'the MCP endpoint takes POST' } });
      return;
    }
    const raw = await readBody(req);
    const reply = handleMcp(store, raw.toString('utf8'));
    if (reply.empty === true) {
      res.writeHead(reply.status, { 'content-length': 0, 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    send(res, reply.status, reply.body, { 'mcp-protocol-version': String(req.headers['mcp-protocol-version'] ?? '2026-07-28') });
    return;
  }

  // ------------------------------------------------------------------ GraphQL
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
    if (token === '') {
      send(res, 401, { message: 'Requires authentication' });
      return;
    }
    if (method !== 'POST') {
      send(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const raw = await readBody(req);
    const parsed = parseJson(raw);
    if (!parsed.ok) {
      send(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const reply = handleGraphQL(store, parsed.value);
    send(res, reply.status, reply.body);
    return;
  }

  // ------------------------------------------------------------------ REST v3
  if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
    if (token === '') {
      send(res, 401, { message: 'Requires authentication', documentation_url: 'https://docs.github.com/rest' });
      return;
    }
    const rest = segments.slice(2);
    if (rest.length === 0 && method === 'GET') {
      send(res, 200, {
        current_user_url: `http://${req.headers.host ?? 'forge'}/api/v3/user`,
        repository_url: `http://${req.headers.host ?? 'forge'}/api/v3/repos/{owner}/{repo}`,
        user_repositories_url: `http://${req.headers.host ?? 'forge'}/api/v3/user/repos{?type,page,per_page,sort}`,
        rate_limit_url: `http://${req.headers.host ?? 'forge'}/api/v3/rate_limit`,
      }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    const raw = method === 'GET' || method === 'DELETE' ? Buffer.alloc(0) : await readBody(req);
    let body: Record<string, unknown> = {};
    if (raw.length > 0) {
      const parsed = parseJson(raw);
      if (!parsed.ok) {
        send(res, 400, { message: 'Problems parsing JSON', documentation_url: 'https://docs.github.com/rest' });
        return;
      }
      body = asObject(parsed.value);
    }
    const reply = handleRest(store, {
      method,
      segments: rest,
      query: queryOf(url),
      body,
      host: req.headers.host ?? 'forge',
    });
    if (reply === null) {
      send(res, 404, { message: 'Not Found' });
      return;
    }
    if (reply.status === 204) {
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    if (reply.text !== undefined) {
      sendText(res, reply.status, reply.text, reply.headers ?? {});
      return;
    }
    send(res, reply.status, reply.body, reply.headers ?? {});
    return;
  }

  // ------------------------------------------------------------------ git smart HTTP
  const target = parseSmartPath(segments);
  if (target !== null) {
    if (token === '') {
      sendRaw(res, 401, Buffer.from('{"message":"Requires authentication"}\n', 'utf8'), JSON_TYPE);
      return;
    }
    const raw = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    const protocol = String(req.headers['git-protocol'] ?? '');
    const reply = handleSmart(store, target, method, url.searchParams, protocol, raw);
    sendRaw(res, reply.status, reply.body, reply.contentType);
    return;
  }

  send(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on port 0. */
export function createApp(): Server {
  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      try {
        send(res, 500, { message: `Internal error: ${message}` });
      } catch {
        res.destroy();
      }
    });
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  return server;
}

export { repoJson };
