import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { E2E_HOSTS } from './hosts';
import { LOOPBACK_HOSTS, normalizeHostname, redactQuery } from './net';

const ALLOWED_HOSTS: readonly string[] = [...E2E_HOSTS, ...LOOPBACK_HOSTS];
const MAX_BODY_BYTES = 1024 * 1024;

export type FixtureRequest = {
  method: string;
  host: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  at: string;
};

export type SanitizedFixtureRequest = Omit<FixtureRequest, 'headers' | 'body'> & {
  query: Record<string, string>;
};

export type FixtureServerDiagnostics = {
  port: number;
  closed: boolean;
  requests: SanitizedFixtureRequest[];
};

export type FixtureServer = {
  readonly port: number;
  readonly origin: string;
  readonly allowedHosts: readonly string[];
  readonly requests: FixtureRequest[];
  readonly closed: boolean;
  urlFor(host: string, path?: string): string;
  diagnostics(): FixtureServerDiagnostics;
  reset(): void;
  close(): Promise<void>;
};

export type CreateFixtureServerOptions = {
  port?: number;
};

function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  return ALLOWED_HOSTS.includes(normalizeHostname(hostHeader));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('fixture request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sanitizePath(path: string): {
  path: string;
  query: Record<string, string>;
} {
  const parsed = new URL(path, 'http://fixture.invalid');
  return { path: parsed.pathname, query: redactQuery(parsed) };
}

export async function createFixtureServer(
  options: CreateFixtureServerOptions = {},
): Promise<FixtureServer> {
  const requests: FixtureRequest[] = [];
  const sockets = new Set<Socket>();
  let closed = false;

  const server = createServer(async (request, response) => {
    const hostHeader = request.headers.host;
    const host = hostHeader ? normalizeHostname(hostHeader) : '';
    const method = request.method ?? 'GET';
    const path = request.url ?? '/';

    if (!isAllowedHost(hostHeader)) {
      sendJson(response, 404, { error: 'unknown_host' });
      return;
    }

    let body = '';
    try {
      body = await readBody(request);
    } catch {
      sendJson(response, 413, { error: 'body_too_large' });
      return;
    }

    requests.push({
      method,
      host,
      path,
      headers: request.headers,
      body,
      at: new Date().toISOString(),
    });

    const { pathname } = new URL(path, 'http://fixture.invalid');
    if (method === 'GET' && pathname === '/health') {
      sendJson(response, 200, { ok: true });
      return;
    }

    sendJson(response, 404, { error: 'not_found' });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('fixture server did not bind a TCP port');
  }
  const port = address.port;

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    allowedHosts: ALLOWED_HOSTS,
    requests,
    get closed() {
      return closed;
    },
    urlFor(host, path = '/') {
      return `http://${host}:${port}${path.startsWith('/') ? path : `/${path}`}`;
    },
    diagnostics() {
      return {
        port,
        closed,
        requests: requests.map(({ method, host, path, at }) => {
          const sanitized = sanitizePath(path);
          return { method, host, path: sanitized.path, query: sanitized.query, at };
        }),
      };
    },
    reset() {
      requests.length = 0;
    },
    async close() {
      if (closed) return;
      closed = true;
      const closedPromise = new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.closeAllConnections();
      await closedPromise;
    },
  };
}
