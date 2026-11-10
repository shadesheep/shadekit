import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from 'node:http';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_HOSTS } from './hosts';
import { LOOPBACK_HOSTS, normalizeHostname, redactQuery } from './net';

const ALLOWED_HOSTS: readonly string[] = [...E2E_HOSTS, ...LOOPBACK_HOSTS];
const MAX_BODY_BYTES = 1024 * 1024;
const SESSION_COOKIE = 'shadekit_session';
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');

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

export type ResponseBarrier = {
  entered: Promise<void>;
  release(): void;
};

export type FixtureServer = {
  readonly port: number;
  readonly origin: string;
  readonly allowedHosts: readonly string[];
  readonly requests: FixtureRequest[];
  readonly closed: boolean;
  urlFor(host: string, path?: string): string;
  holdResponse(path: string): ResponseBarrier;
  diagnostics(): FixtureServerDiagnostics;
  reset(): void;
  close(): Promise<void>;
};

export type CreateFixtureServerOptions = {
  port?: number;
};

export type FixtureIdentity = {
  username: string;
  email: string;
  name: string;
  title: string;
  scope: string;
  role: 'admin' | 'tester';
};

type FixtureAccount = Omit<FixtureIdentity, 'username' | 'email'> & {
  password: string;
};

type BarrierSlot = {
  entered: Promise<void>;
  enteredResolve: () => void;
  released: Promise<void>;
  release: () => void;
  cancel: () => void;
};

const FIXTURE_ACCOUNTS: Readonly<Record<string, FixtureAccount>> = {
  'admin@fixture.test': {
    name: '林屿',
    title: '交付管理员',
    scope: '全部项目 · 发布与权限管理',
    role: 'admin',
    password: 'fixture-pass',
  },
  'tester@fixture.test': {
    name: '周然',
    title: '验收测试',
    scope: '验收任务 · 回归与结果提交',
    role: 'tester',
    password: 'fixture-pass',
  },
};

function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  return ALLOWED_HOSTS.includes(normalizeHostname(hostHeader));
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function pathnameOf(path: string): string {
  try {
    return new URL(path, 'http://fixture.invalid').pathname;
  } catch {
    return path;
  }
}

function sessionCookie(token?: string): string {
  const value = `${SESSION_COOKIE}=${token ?? ''}`;
  const attributes = 'HttpOnly; SameSite=Lax; Path=/';
  return token ? `${value}; ${attributes}` : `${value}; ${attributes}; Max-Age=0`;
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

function send(
  response: ServerResponse,
  status: number,
  body: string,
  contentType?: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    ...(contentType ? { 'content-type': contentType } : {}),
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  send(
    response,
    status,
    JSON.stringify(payload),
    'application/json; charset=utf-8',
    headers,
  );
}

function sendHtml(
  response: ServerResponse,
  status: number,
  html: string,
): void {
  send(response, status, html, 'text/html; charset=utf-8');
}

function sendRedirect(response: ServerResponse, location: string): void {
  send(response, 302, '', undefined, { location });
}

function sanitizePath(path: string): {
  path: string;
  query: Record<string, string>;
} {
  const parsed = new URL(path, 'http://fixture.invalid');
  return { path: parsed.pathname, query: redactQuery(parsed) };
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    if (!name) continue;
    cookies[name] = part.slice(separator + 1).trim();
  }
  return cookies;
}

function parseRequestBody(
  body: string,
  contentType: string | undefined,
): Record<string, unknown> {
  if (!body) return {};
  if (contentType?.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(body));
  }
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character] ?? character,
  );
}

function renderConsole(template: string, identity: FixtureIdentity): string {
  const values: Record<string, string> = {
    role: identity.role,
    name: identity.name,
    email: identity.email,
    title: identity.title,
    scope: identity.scope,
    username: identity.username,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    key in values ? escapeHtml(values[key] as string) : match,
  );
}

export async function createFixtureServer(
  options: CreateFixtureServerOptions = {},
): Promise<FixtureServer> {
  const [
    loginPage,
    consoleTemplate,
    textareaLoginPage,
    submitInputPage,
    optionsPage,
    iframePage,
    shadowPage,
    spaPage,
    multistepPage,
    apiConsolePage,
  ] = await Promise.all([
    readFile(join(PUBLIC_DIR, 'login.html'), 'utf8'),
    readFile(join(PUBLIC_DIR, 'console.html'), 'utf8'),
    readFile(join(PUBLIC_DIR, 'textarea-login.html'), 'utf8'),
    readFile(join(PUBLIC_DIR, 'login-submit-input.html'), 'utf8'),
    readFile(join(PUBLIC_DIR, 'login-options.html'), 'utf8'),
    readFile(join(PUBLIC_DIR, 'form-iframe.html'), 'utf8'),
    readFile(join(PUBLIC_DIR, 'form-shadow.html'), 'utf8'),
    readFile(join(PUBLIC_DIR, 'form-spa.html'), 'utf8'),
    readFile(join(PUBLIC_DIR, 'form-multistep.html'), 'utf8'),
    readFile(join(PUBLIC_DIR, 'api-console.html'), 'utf8'),
  ]);

  const sessions = new Map<string, FixtureIdentity>();
  const requests: FixtureRequest[] = [];
  const barriers = new Map<string, BarrierSlot[]>();
  const sockets = new Set<Socket>();
  let closed = false;

  const cancelBarriers = () => {
    for (const queue of barriers.values()) {
      for (const barrier of queue) barrier.cancel();
    }
    barriers.clear();
  };

  const waitOnBarrier = async (pathname: string) => {
    const queue = barriers.get(pathname);
    if (!queue || queue.length === 0) return;
    const barrier = queue.shift();
    if (!barrier) return;
    if (queue.length === 0) barriers.delete(pathname);
    barrier.enteredResolve();
    await barrier.released;
  };

  const sessionToken = (headers: IncomingHttpHeaders): string | undefined =>
    parseCookies(headers.cookie)[SESSION_COOKIE];

  const currentIdentity = (
    headers: IncomingHttpHeaders,
  ): FixtureIdentity | undefined => {
    const token = sessionToken(headers);
    return token ? sessions.get(token) : undefined;
  };

  const bearerToken = (headers: IncomingHttpHeaders): string | undefined => {
    const match = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? '');
    return match?.[1];
  };

  /**
   * 会话身份：HttpOnly Cookie 与服务端签发的 bearer token 都映射到同一
   * `sessions` 表；未知或空 token 一律视为未登录。
   */
  const requestIdentity = (
    headers: IncomingHttpHeaders,
  ): FixtureIdentity | undefined => {
    const cookieIdentity = currentIdentity(headers);
    if (cookieIdentity) return cookieIdentity;
    const token = bearerToken(headers);
    return token ? sessions.get(token) : undefined;
  };

  const handleLogin = (
    request: IncomingMessage,
    response: ServerResponse,
    body: string,
  ) => {
    const payload = parseRequestBody(body, request.headers['content-type']);
    const username =
      typeof payload.username === 'string' ? payload.username : '';
    const password =
      typeof payload.password === 'string' ? payload.password : '';
    const account = FIXTURE_ACCOUNTS[username];
    if (!account || account.password !== password) {
      sendJson(response, 401, { error: 'invalid_credentials' });
      return;
    }
    const identity: FixtureIdentity = {
      username,
      email: username,
      name: account.name,
      title: account.title,
      scope: account.scope,
      role: account.role,
    };
    const token = randomBytes(32).toString('hex');
    sessions.set(token, identity);
    sendJson(response, 200, identity, { 'set-cookie': sessionCookie(token) });
  };

  const handleLogout = (
    request: IncomingMessage,
    response: ServerResponse,
  ) => {
    const token = sessionToken(request.headers);
    if (token) sessions.delete(token);
    sendJson(response, 200, { ok: true }, { 'set-cookie': sessionCookie() });
  };

  /** `POST /api/token`：一次 API 登录返回三种可写入会话的 token。 */
  const handleTokenIssue = (
    request: IncomingMessage,
    response: ServerResponse,
    body: string,
  ) => {
    const payload = parseRequestBody(body, request.headers['content-type']);
    const username =
      typeof payload.username === 'string' ? payload.username : '';
    const password =
      typeof payload.password === 'string' ? payload.password : '';
    const account = FIXTURE_ACCOUNTS[username];
    if (!account || account.password !== password) {
      sendJson(response, 401, { error: 'invalid_credentials' });
      return;
    }
    const identity: FixtureIdentity = {
      username,
      email: username,
      name: account.name,
      title: account.title,
      scope: account.scope,
      role: account.role,
    };
    const sessionTokenValue = randomBytes(32).toString('hex');
    const accessToken = randomBytes(32).toString('hex');
    const refreshToken = randomBytes(32).toString('hex');
    // Cookie 会话与 bearer 身份共用一张 token → identity 表；未知 token
    // 不会因为“看起来像 token”而被当作已登录。
    sessions.set(sessionTokenValue, identity);
    sessions.set(accessToken, identity);
    sendJson(response, 200, {
      data: {
        sessionToken: sessionTokenValue,
        accessToken,
        refreshToken,
      },
    });
  };

  const server = createServer(async (request, response) => {
    const hostHeader = request.headers.host;
    const host = hostHeader ? normalizeHostname(hostHeader) : '';
    const method = request.method ?? 'GET';
    const rawPath = request.url ?? '/';

    let body = '';
    let bodyComplete = true;
    try {
      body = await readBody(request);
    } catch {
      bodyComplete = false;
    }

    requests.push({
      method,
      host,
      path: rawPath,
      headers: request.headers,
      body,
      at: new Date().toISOString(),
    });

    if (!isAllowedHost(hostHeader)) {
      sendJson(response, 404, { error: 'unknown_host' });
      return;
    }

    if (!bodyComplete) {
      sendJson(response, 413, { error: 'body_too_large' });
      return;
    }

    const pathname = pathnameOf(rawPath);

    await waitOnBarrier(pathname);
    if (closed || response.destroyed || response.writableEnded) return;

    const identity = requestIdentity(request.headers);

    if (method === 'GET' && pathname === '/health') {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (method === 'POST' && pathname === '/api/session/login') {
      handleLogin(request, response, body);
      return;
    }

    if (method === 'POST' && pathname === '/api/token') {
      handleTokenIssue(request, response, body);
      return;
    }

    if (method === 'GET' && pathname === '/api/token-text') {
      send(response, 200, 'fixture-token', 'text/plain; charset=utf-8');
      return;
    }

    if (method === 'GET' && pathname === '/api-console') {
      sendHtml(response, 200, apiConsolePage);
      return;
    }

    if (method === 'POST' && pathname === '/api/session/logout') {
      handleLogout(request, response);
      return;
    }

    if (method === 'GET' && pathname === '/api/session/me') {
      if (!identity) {
        sendJson(response, 401, { error: 'unauthenticated' });
        return;
      }
      sendJson(response, 200, identity);
      return;
    }

    if (method === 'GET' && pathname === '/login') {
      sendHtml(response, 200, loginPage);
      return;
    }

    if (method === 'GET' && pathname === '/textarea-login') {
      sendHtml(response, 200, textareaLoginPage);
      return;
    }

    if (method === 'GET' && pathname === '/login-submit-input') {
      sendHtml(response, 200, submitInputPage);
      return;
    }

    if (method === 'GET' && pathname === '/login-options') {
      sendHtml(response, 200, optionsPage);
      return;
    }

    if (method === 'GET' && pathname === '/form-iframe') {
      sendHtml(response, 200, iframePage);
      return;
    }

    if (method === 'GET' && pathname === '/form-shadow') {
      sendHtml(response, 200, shadowPage);
      return;
    }

    if (
      method === 'GET' &&
      (pathname === '/form-spa' || pathname === '/form-spa/dashboard')
    ) {
      sendHtml(response, 200, spaPage);
      return;
    }

    if (method === 'GET' && pathname === '/form-multistep') {
      sendHtml(response, 200, multistepPage);
      return;
    }

    if (method === 'GET' && pathname === '/console') {
      if (!identity) {
        sendRedirect(response, '/login');
        return;
      }
      sendHtml(response, 200, renderConsole(consoleTemplate, identity));
      return;
    }

    const statusMatch = /^\/api\/status\/(\d{3})$/.exec(pathname);
    if (method === 'GET' && statusMatch) {
      const status = Number(statusMatch[1]);
      sendJson(response, status, { status });
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
    holdResponse(path) {
      const key = pathnameOf(path);
      const entered = createDeferred();
      const released = createDeferred();
      let releasedOnce = false;
      const release = () => {
        if (releasedOnce) return;
        releasedOnce = true;
        released.resolve();
      };
      const barrier: BarrierSlot = {
        entered: entered.promise,
        enteredResolve: entered.resolve,
        released: released.promise,
        release,
        cancel: () => {
          entered.resolve();
          release();
        },
      };
      const queue = barriers.get(key);
      if (queue) {
        queue.push(barrier);
      } else {
        barriers.set(key, [barrier]);
      }
      return { entered: barrier.entered, release: barrier.release };
    },
    diagnostics() {
      return {
        port,
        closed,
        requests: requests.map(({ method, host, path, at }) => {
          const sanitized = sanitizePath(path);
          return {
            method,
            host,
            path: sanitized.path,
            query: sanitized.query,
            at,
          };
        }),
      };
    },
    reset() {
      sessions.clear();
      requests.length = 0;
      cancelBarriers();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
    async close() {
      if (closed) return;
      closed = true;
      cancelBarriers();
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
