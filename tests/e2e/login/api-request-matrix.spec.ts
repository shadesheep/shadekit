import type { BrowserContext, Page } from '@playwright/test';
import {
  LOGIN_SPEC_VERSION,
  type LoginSpec,
  type SpecOp,
  type SuccessSignal,
} from '../../../entrypoints/tools/account-switch/spec/types';
import { test, expect } from '../fixtures/extension';
import {
  FIXTURE_ADMIN_NAME,
  fixtureAccounts,
  httpEchoSpec,
  makeAccountSwitchConfig,
  seedAccountSwitch,
} from '../fixtures/config';
import {
  expectAccountFailure,
  expectAccountSuccess,
  runAccount,
} from '../fixtures/pages';
import type { FixtureServer } from '../fixtures/server';

async function seed(
  context: BrowserContext,
  origin: string,
  spec: LoginSpec,
): Promise<void> {
  await seedAccountSwitch(
    context,
    makeAccountSwitchConfig({
      originPattern: origin,
      accounts: fixtureAccounts([origin]),
      spec,
    }),
  );
}

function apiSpec(
  ops: SpecOp[],
  success: SuccessSignal[],
  limits: { requestMs?: number; stepMs?: number; settleMs?: number } = {},
): LoginSpec {
  return {
    version: LOGIN_SPEC_VERSION,
    template: 'api',
    ops,
    success,
    auth: { mode: 'engine', cookiesWrite: [] },
    limits: { requestMs: 15000, stepMs: 5000, settleMs: 10000, ...limits },
  };
}

async function openLogin(
  context: BrowserContext,
  fixtureServer: FixtureServer,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(fixtureServer.urlFor('exact.test', '/login'));
  return page;
}



test('[API-05] applies header, query and body to the next request', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seed(context, origin, httpEchoSpec());
  const page = await openLogin(context, fixtureServer);

  await runAccount(page, worker, FIXTURE_ADMIN_NAME);
  await expectAccountSuccess(page);

  const echo = fixtureServer.requests.find((request) =>
    request.path.startsWith('/api/echo'),
  );
  expect(echo?.headers['x-extra']).toBe('yes');
  expect(echo?.path).toContain('q=1');
  expect(JSON.parse(echo?.body ?? '{}')).toMatchObject({ source: 'e2e' });
});

test('[API-06] rewrites a JSON body field with apply.set', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seed(
    context,
    origin,
    apiSpec(
      [
        { op: 'goto', url: '{origin}/login', waitForLoad: true },
        { op: 'apply.set', target: 'body', key: 'source', value: 'changed' },
        {
          op: 'http.execute',
          url: '{origin}/api/echo',
          method: 'POST',
          body: { json: { source: 'original' } },
          parse: 'json',
          as: 'echo',
        },
      ],
      [{ response: { from: 'echo', path: 'body.source', equals: 'changed' } }],
    ),
  );
  const page = await openLogin(context, fixtureServer);

  await runAccount(page, worker, FIXTURE_ADMIN_NAME);
  await expectAccountSuccess(page);

  expect(
    JSON.parse(
      fixtureServer.requests.find((request) =>
        request.path.startsWith('/api/echo'),
      )?.body ?? '{}',
    ),
  ).toEqual({
    source: 'changed',
  });
});

test('[API-07] sends a raw urlencoded request body', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seed(
    context,
    origin,
    apiSpec(
      [
        { op: 'goto', url: '{origin}/login', waitForLoad: true },
        {
          op: 'http.execute',
          url: '{origin}/api/echo',
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: { raw: 'a=1&b=2' },
          parse: 'json',
          as: 'echo',
        },
      ],
      [{ response: { from: 'echo', path: 'body.a', equals: '1' } }],
    ),
  );
  const page = await openLogin(context, fixtureServer);

  await runAccount(page, worker, FIXTURE_ADMIN_NAME);
  await expectAccountSuccess(page);

  const echo = fixtureServer.requests.find((request) =>
    request.path.startsWith('/api/echo'),
  );
  expect(echo?.headers['content-type']).toContain(
    'application/x-www-form-urlencoded',
  );
  expect(echo?.body).toBe('a=1&b=2');
});

test('[API-08] forwards an earlier response into a referenced body', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seed(
    context,
    origin,
    apiSpec(
      [
        { op: 'goto', url: '{origin}/login', waitForLoad: true },
        {
          op: 'http.execute',
          url: '{origin}/api/csrf',
          method: 'GET',
          parse: 'json',
          as: 'csrf',
        },
        {
          op: 'payload.build',
          parts: [{ key: 'token', value: '$csrf.csrfToken' }],
          as: 'csrfBody',
        },
        {
          op: 'http.execute',
          url: '{origin}/api/echo',
          method: 'POST',
          body: { ref: 'csrfBody' },
          parse: 'json',
          as: 'echo',
        },
      ],
      [{ response: { from: 'echo', path: 'body.token', equals: 'csrf-fixture' } }],
    ),
  );
  const page = await openLogin(context, fixtureServer);

  await runAccount(page, worker, FIXTURE_ADMIN_NAME);
  await expectAccountSuccess(page);

  expect(
    JSON.parse(
      fixtureServer.requests.find((request) =>
        request.path.startsWith('/api/echo'),
      )?.body ?? '{}',
    ),
  ).toEqual({
    token: 'csrf-fixture',
  });
});

test('[API-09] prefetches a CSRF token and calls the secure endpoint', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seed(
    context,
    origin,
    apiSpec(
      [
        { op: 'goto', url: '{origin}/login', waitForLoad: true },
        {
          op: 'http.execute',
          url: '{origin}/api/csrf',
          method: 'GET',
          parse: 'json',
          as: 'csrf',
        },
        {
          op: 'http.execute',
          url: '{origin}/api/secure-login',
          method: 'POST',
          headers: { 'x-csrf-token': '$csrf.csrfToken' },
          body: { json: { username: '{username}' } },
          parse: 'json',
          as: 'secure',
        },
      ],
      [{ token: { from: 'secure', path: 'sessionToken' } }],
    ),
  );
  const page = await openLogin(context, fixtureServer);

  await runAccount(page, worker, FIXTURE_ADMIN_NAME);
  await expectAccountSuccess(page);

  const secure = fixtureServer.requests.find(
    (request) => request.path === '/api/secure-login',
  );
  expect(secure?.headers['x-csrf-token']).toBe('csrf-fixture');
});

test('[API-10] surfaces a request timeout', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seed(
    context,
    origin,
    apiSpec(
      [
        {
          op: 'http.execute',
          url: '{origin}/api/slow?ms=500',
          method: 'GET',
          parse: 'json',
          as: 'slow',
        },
      ],
      [{ response: { from: 'slow', path: 'delayedMs', equals: 500 } }],
      { requestMs: 100 },
    ),
  );
  const page = await openLogin(context, fixtureServer);

  await runAccount(page, worker, FIXTURE_ADMIN_NAME);
  await expectAccountFailure(page, /登录请求超时/);
});

test('[API-11] fails on a non-2xx status without writing auth', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seed(
    context,
    origin,
    apiSpec(
      [
        {
          op: 'http.execute',
          url: '{origin}/api/status/500',
          method: 'GET',
          parse: 'json',
          as: 'failed',
        },
      ],
      [{ response: { from: 'failed', path: 'status', equals: 200 } }],
    ),
  );
  const page = await openLogin(context, fixtureServer);

  await runAccount(page, worker, FIXTURE_ADMIN_NAME);
  await expectAccountFailure(page, /登录未通过/);
  expect(await context.cookies(origin)).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('access_token'))).toBeNull();
});

test('[API-12] treats a malformed JSON body as a failed login', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seed(
    context,
    origin,
    apiSpec(
      [
        {
          op: 'http.execute',
          url: '{origin}/api/malformed',
          method: 'GET',
          parse: 'json',
          as: 'malformed',
        },
      ],
      [{ token: { from: 'malformed', path: 'token' } }],
    ),
  );
  const page = await openLogin(context, fixtureServer);

  await runAccount(page, worker, FIXTURE_ADMIN_NAME);
  await expectAccountFailure(page, /未确认登录成功/);
  expect(await context.cookies(origin)).toEqual([]);
});

test('[API-13] keeps HttpOnly and SameSite attributes from Set-Cookie', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seed(
    context,
    origin,
    apiSpec(
      [
        {
          op: 'http.execute',
          url: '{origin}/api/set-cookie',
          method: 'GET',
          parse: 'json',
          as: 'cookie',
        },
      ],
      [{ response: { from: 'cookie', path: 'ok', equals: true } }],
    ),
  );
  const page = await openLogin(context, fixtureServer);

  await runAccount(page, worker, FIXTURE_ADMIN_NAME);
  await expectAccountSuccess(page);

  const cookie = (await context.cookies(origin)).find(
    (entry) => entry.name === 'attr_cookie',
  );
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
});

test('[API-14] calls a cross-origin API host', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  const crossOriginApi = `http://api.wild.test:${fixtureServer.port}/api/echo`;
  await seed(
    context,
    origin,
    apiSpec(
      [
        { op: 'goto', url: '{origin}/login', waitForLoad: true },
        {
          op: 'http.execute',
          url: crossOriginApi,
          method: 'GET',
          parse: 'json',
          as: 'echo',
        },
      ],
      [{ response: { from: 'echo', path: 'host', equals: 'api.wild.test' } }],
    ),
  );
  const page = await openLogin(context, fixtureServer);

  await runAccount(page, worker, FIXTURE_ADMIN_NAME);
  await expectAccountSuccess(page);

  expect(
    fixtureServer.requests.some(
      (request) =>
        request.host === 'api.wild.test' && request.path === '/api/echo',
    ),
  ).toBe(true);
});

test('[API-23] rejects a business-level failure returned with HTTP 200', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seed(
    context,
    origin,
    apiSpec(
      [
        {
          op: 'http.execute',
          url: '{origin}/api/business-error',
          method: 'GET',
          parse: 'json',
          as: 'biz',
        },
      ],
      [{ response: { from: 'biz', path: 'success', equals: true } }],
    ),
  );
  const page = await openLogin(context, fixtureServer);

  await runAccount(page, worker, FIXTURE_ADMIN_NAME);
  await expectAccountFailure(page, /未确认登录成功/);

  expect(await context.cookies(origin)).toEqual([]);
  const meStatus = await page.evaluate(
    async () => (await fetch('/api/session/me')).status,
  );
  expect(meStatus).toBe(401);
});

test('[API-24] rejects an empty token even when HTTP status is 200', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seed(
    context,
    origin,
    apiSpec(
      [
        {
          op: 'http.execute',
          url: '{origin}/api/token-empty',
          method: 'POST',
          parse: 'json',
          as: 'empty',
        },
      ],
      [{ token: { from: 'empty', path: 'data.sessionToken' } }],
    ),
  );
  const page = await openLogin(context, fixtureServer);

  await runAccount(page, worker, FIXTURE_ADMIN_NAME);
  await expectAccountFailure(page, /未确认登录成功/);

  expect(await context.cookies(origin)).toEqual([]);
  const storage = await page.evaluate(() => ({
    local: localStorage.getItem('access_token'),
    session: sessionStorage.getItem('access_token'),
  }));
  expect(storage).toEqual({ local: null, session: null });
});
