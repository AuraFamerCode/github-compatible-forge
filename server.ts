// A small HTTP/1.1 server on node:net, because the built-in one costs about twice as much CPU per
// request as the request itself. It speaks what this forge's clients send: a request line, headers, a
// body framed by content-length or chunked encoding, keep-alive, pipelining and Expect: 100-continue.
// Every reply carries a content-length, so nothing here needs chunked responses.

import { createServer as createNetServer, type Server, type Socket } from 'node:net';

const EMPTY = Buffer.alloc(0);
const MAX_HEADER_BYTES = 64 * 1024;

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  503: 'Service Unavailable',
};

export interface Request {
  readonly method: string;
  /** The request target as it arrived, path and query. */
  readonly target: string;
  /** The path part of the target, still percent-encoded. */
  readonly path: string;
  /** The query string without its `?`, empty when there is none. */
  readonly search: string;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

export class Response {
  #socket: Socket;
  #status = 200;
  #headers: Record<string, string> = {};
  #finished = false;
  readonly headOnly: boolean;
  keepAlive: boolean;

  constructor(socket: Socket, keepAlive: boolean, headOnly: boolean) {
    this.#socket = socket;
    this.keepAlive = keepAlive;
    this.headOnly = headOnly;
  }

  writeHead(status: number, headers: Record<string, string>): void {
    this.#status = status;
    this.#headers = headers;
  }

  end(body?: string | Buffer): void {
    if (this.#finished) return;
    this.#finished = true;
    const payload = body === undefined ? EMPTY : typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    let head = `HTTP/1.1 ${this.#status} ${REASONS[this.#status] ?? 'OK'}\r\n`;
    for (const key of Object.keys(this.#headers)) head += `${key}: ${this.#headers[key]}\r\n`;
    head += this.keepAlive ? 'connection: keep-alive\r\n\r\n' : 'connection: close\r\n\r\n';
    if (payload.length === 0 || this.headOnly) {
      this.#socket.write(head);
    } else {
      // One write for the head and body: a second call would cost another syscall per reply.
      this.#socket.cork();
      this.#socket.write(head);
      this.#socket.write(payload);
      this.#socket.uncork();
    }
  }

  destroy(): void {
    this.#socket.destroy();
  }
}

interface Head {
  method: string;
  target: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  contentLength: number;
  chunked: boolean;
  keepAlive: boolean;
  headOnly: boolean;
}

function parseHead(raw: string): Head | null {
  const firstEnd = raw.indexOf('\r\n');
  if (firstEnd < 0) return null;
  const requestLine = raw.slice(0, firstEnd);
  const firstSpace = requestLine.indexOf(' ');
  if (firstSpace < 0) return null;
  const lastSpace = requestLine.lastIndexOf(' ');
  if (lastSpace <= firstSpace) return null;
  const method = requestLine.slice(0, firstSpace);
  const target = requestLine.slice(firstSpace + 1, lastSpace);
  const version = requestLine.slice(lastSpace + 1);

  const headers: Record<string, string> = {};
  let at = firstEnd + 2;
  for (;;) {
    const end = raw.indexOf('\r\n', at);
    if (end < 0) return null;
    if (end === at) break;
    const line = raw.slice(at, end);
    at = end + 2;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const existing = headers[name];
    headers[name] = existing === undefined ? value : `${existing}, ${value}`;
  }

  const question = target.indexOf('?');
  const path = question < 0 ? target : target.slice(0, question);
  const search = question < 0 ? '' : target.slice(question + 1);
  const connection = (headers.connection ?? '').toLowerCase();
  const keepAlive = connection === 'close' ? false : version === 'HTTP/1.0' ? connection === 'keep-alive' : true;
  const lengthText = headers['content-length'];
  const contentLength = lengthText === undefined ? 0 : Number.parseInt(lengthText, 10) || 0;
  return {
    method,
    target,
    path,
    search,
    headers,
    contentLength,
    chunked: (headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked'),
    keepAlive,
    headOnly: method === 'HEAD',
  };
}

/** Decode a complete chunked body; undefined when the terminal chunk has not arrived yet. */
function decodeChunked(buffer: Buffer): { body: Buffer; used: number } | undefined {
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    const lineEnd = buffer.indexOf('\r\n', at);
    if (lineEnd < 0) return undefined;
    const size = Number.parseInt(buffer.toString('latin1', at, lineEnd).split(';')[0] ?? '', 16);
    if (!Number.isFinite(size) || size < 0) return undefined;
    at = lineEnd + 2;
    if (size === 0) {
      // The terminal chunk is followed by an empty trailer line.
      const trailerEnd = buffer.indexOf('\r\n', at);
      if (trailerEnd < 0) return undefined;
      return { body: Buffer.concat(parts), used: trailerEnd + 2 };
    }
    if (buffer.length < at + size + 2) return undefined;
    parts.push(buffer.subarray(at, at + size));
    at += size + 2;
  }
}

export function createServer(handler: (request: Request, response: Response) => void): Server {
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.setTimeout(75_000, () => socket.destroy());
    let buffer: Buffer = EMPTY;
    let head: Head | null = null;
    let body: Buffer | null = null;

    const pump = (): void => {
      for (;;) {
        if (head === null) {
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0) {
            if (buffer.length > MAX_HEADER_BYTES) socket.destroy();
            return;
          }
          const parsed = parseHead(buffer.toString('latin1', 0, end + 4));
          if (parsed === null) {
            socket.destroy();
            return;
          }
          buffer = buffer.subarray(end + 4);
          head = parsed;
          body = parsed.contentLength === 0 && !parsed.chunked ? EMPTY : null;
          if (parsed.headers.expect !== undefined && parsed.headers.expect.toLowerCase().includes('100-continue')) {
            socket.write('HTTP/1.1 100 Continue\r\n\r\n');
          }
        }
        if (body === null) {
          if (head.chunked) {
            const decoded = decodeChunked(buffer);
            if (decoded === undefined) return;
            body = decoded.body;
            buffer = buffer.subarray(decoded.used);
          } else {
            if (buffer.length < head.contentLength) return;
            body = buffer.subarray(0, head.contentLength);
            buffer = buffer.subarray(head.contentLength);
          }
        }
        const request: Request = {
          method: head.method,
          target: head.target,
          path: head.path,
          search: head.search,
          headers: head.headers,
          body,
        };
        const response = new Response(socket, head.keepAlive, head.headOnly);
        const closeAfter = !head.keepAlive;
        head = null;
        body = null;
        handler(request, response);
        if (closeAfter) {
          socket.end();
          return;
        }
      }
    };

    socket.on('data', (chunk: Buffer) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      pump();
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
  });

  // A kept-alive connection must not hold the process open once the harness asks the server to stop.
  const close = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void): Server => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    return close(callback) as Server;
  }) as typeof server.close;

  return server;
}
