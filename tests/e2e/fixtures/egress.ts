import { createServer, request as httpRequest } from 'node:http';
import type { ClientRequest, IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { E2E_HOSTS } from './hosts';
import {
  LOOPBACK_HOSTS,
  normalizeHostname,
  sanitizeUrl,
} from './net';
import type { FixtureServer } from './server';

const REGISTRABLE_HOSTS = new Set<string>([...E2E_HOSTS, ...LOOPBACK_HOSTS]);
const UPSTREAM_TIMEOUT_MS = 10_000;

export type EgressDecision = 'allowed' | 'denied';

export type EgressLogEntry = {
  method: string;
  target: string;
  decision: EgressDecision;
  reason?: string;
  at: string;
};

export type EgressDiagnostics = {
  entries: EgressLogEntry[];
  allowedRequests: number;
  deniedRequests: number;
  upstreamConnections: number;
};

export type EgressProxy = {
  readonly url: string;
  allowServer(
    fixtureServer: Pick<FixtureServer, 'port' | 'allowedHosts'>,
  ): () => void;
  diagnostics(): EgressDiagnostics;
  close(): Promise<void>;
};

export type CreateEgressProxyOptions = {
  port?: number;
};

function deny(
  response: ServerResponse,
  status: number,
  reason: string,
): void {
  const body = JSON.stringify({ error: 'egress_denied', reason });
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': '*',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

export async function createEgressProxy(
  options: CreateEgressProxyOptions = {},
): Promise<EgressProxy> {
  // registry: requested "host:port" -> loopback port to dial
  const registry = new Map<string, number>();
  const entries: EgressLogEntry[] = [];
  const sockets = new Set<Socket>();
  const upstreams = new Set<ClientRequest>();
  let allowedRequests = 0;
  let deniedRequests = 0;
  let upstreamConnections = 0;
  let closed = false;

  const record = (
    method: string,
    target: string,
    decision: EgressDecision,
    reason?: string,
  ) => {
    entries.push({
      method,
      target,
      decision,
      ...(reason ? { reason } : {}),
      at: new Date().toISOString(),
    });
    if (decision === 'allowed') allowedRequests += 1;
    else deniedRequests += 1;
  };

  const denyAndRecord = (
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
    target: string,
    status: number,
    reason: string,
  ) => {
    record(method, target, 'denied', reason);
    deny(response, status, reason);
    request.resume();
  };

  const server = createServer((request, response) => {
    const method = request.method ?? 'GET';
    const rawUrl = request.url ?? '';
    const targetForLog = sanitizeUrl(rawUrl);

    if (closed) {
      denyAndRecord(request, response, method, targetForLog, 503, 'proxy-closed');
      return;
    }

    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      denyAndRecord(request, response, method, targetForLog, 400, 'invalid-url');
      return;
    }

    if (target.protocol !== 'http:') {
      denyAndRecord(
        request,
        response,
        method,
        targetForLog,
        400,
        'unsupported-scheme',
      );
      return;
    }

    if (target.username || target.password) {
      denyAndRecord(
        request,
        response,
        method,
        targetForLog,
        400,
        'credentials-in-url',
      );
      return;
    }

    const hostname = normalizeHostname(target.hostname);
    const port = target.port ? Number(target.port) : 80;
    const upstreamPort = REGISTRABLE_HOSTS.has(hostname)
      ? registry.get(`${hostname}:${port}`)
      : undefined;
    if (upstreamPort === undefined) {
      denyAndRecord(
        request,
        response,
        method,
        targetForLog,
        403,
        'host-not-registered',
      );
      return;
    }

    record(method, targetForLog, 'allowed');

    const upstream = httpRequest({
      host: '127.0.0.1',
      port: upstreamPort,
      method,
      path: `${target.pathname}${target.search}`,
      headers: { ...request.headers, host: target.host },
    });
    upstream.on('socket', () => {
      upstreamConnections += 1;
    });
    upstreams.add(upstream);

    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      upstream.destroy(new Error('upstream-timeout'));
    });

    upstream.on('response', (upstreamResponse: IncomingMessage) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.headers,
      );
      upstreamResponse.pipe(response);
      upstreamResponse.on('error', () => response.destroy());
    });

    upstream.on('error', (error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      deny(response, 502, `upstream-error:${error.message}`);
    });

    upstream.on('close', () => upstreams.delete(upstream));
    request.pipe(upstream);
  });

  server.on('connect', (request, clientSocket) => {
    record(
      request.method ?? 'CONNECT',
      sanitizeUrl(request.url ?? ''),
      'denied',
      'connect-not-supported',
    );
    clientSocket.on('error', () => {});
    clientSocket.end(
      'HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n',
    );
    clientSocket.destroy();
  });

  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
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
    throw new Error('egress proxy did not bind a TCP port');
  }
  const port = address.port;

  const unregister = (registrations: Array<[string, number]>) => {
    for (const [key, upstreamPort] of registrations) {
      if (registry.get(key) === upstreamPort) registry.delete(key);
    }
  };

  return {
    url: `http://127.0.0.1:${port}`,
    allowServer(fixtureServer) {
      const registrations: Array<[string, number]> = [];
      for (const host of fixtureServer.allowedHosts) {
        const hostname = normalizeHostname(host);
        if (!REGISTRABLE_HOSTS.has(hostname)) {
          throw new Error(`egress proxy cannot forward to ${host}`);
        }
        const key = `${hostname}:${fixtureServer.port}`;
        registry.set(key, fixtureServer.port);
        registrations.push([key, fixtureServer.port]);
      }
      return () => unregister(registrations);
    },
    diagnostics() {
      return {
        entries: entries.map((entry) => ({ ...entry })),
        allowedRequests,
        deniedRequests,
        upstreamConnections,
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const upstream of upstreams) upstream.destroy();
      upstreams.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      const closedPromise = new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      server.closeAllConnections();
      await closedPromise;
    },
  };
}
