import { createHash } from 'node:crypto';
import type { BrowserContext, Cookie, Page } from '@playwright/test';
import {
  LOGIN_SPEC_VERSION,
  type LoginSpec,
  type SpecOp,
  type SuccessSignal,
} from '../../../entrypoints/tools/account-switch/spec/types';
import { test, expect } from '../fixtures/extension';
import {
  FIXTURE_ADMIN_NAME,
  FIXTURE_PASSWORD,
  FIXTURE_TESTER_NAME,
  apiCookieLoginSpec,
  digestLoginSpec,
  fixtureAccounts,
  makeAccountSwitchConfig,
  pageLoginSpec,
  seedAccountSwitch,
} from '../fixtures/config';
import {
  ConsolePage,
  expectAccountSuccess,
  loginViaPanel,
  runAccount,
} from '../fixtures/pages';
import type { FixtureServer } from '../fixtures/server';

const ADMIN_IDENTITY = {
  role: 'admin',
  name: '林屿',
  email: 'admin@fixture.test',
  title: '交付管理员',
  scope: '全部项目 · 发布与权限管理',
} as const;

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
  extra: Partial<LoginSpec> = {},
): LoginSpec {
  return {
    version: LOGIN_SPEC_VERSION,
    template: 'api',
    ops,
    success,
    auth: { mode: 'engine', cookiesWrite: [] },
    limits: { requestMs: 15000, stepMs: 5000, settleMs: 10000 },
    ...extra,
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

function sessionCookieValue(cookies: Cookie[]): string | undefined {
  return cookies.find((cookie) => cookie.name === 'shadekit_session')?.value;
}

test('[API-15] signs a password with digest and logs in', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seed(context, origin, digestLoginSpec());

  const page = await openLogin(context, fixtureServer);
  await loginViaPanel(page, worker, FIXTURE_ADMIN_NAME);

  await new ConsolePage(page).expectIdentity(ADMIN_IDENTITY);
  const request = fixtureServer.requests.find(
    (entry) => entry.path === '/api/digest-login',
  );
  const submitted = JSON.parse(request?.body ?? '{}') as Record<
    string,
    string
  >;
  expect(submitted.username).toBe('admin@fixture.test');
  expect(submitted.password).toBe(
    createHash('sha256').update(FIXTURE_PASSWORD).digest('hex'),
  );
  expect(submitted.password).not.toBe(FIXTURE_PASSWORD);
});

test('[API-16] builds string and object payloads before writing storage', async ({
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
          op: 'payload.build',
          parts: [
            { key: 'username', value: '{username}' },
            { key: 'password', value: '{password}' },
          ],
          as: 'profile',
        },
        {
          op: 'payload.build',
          parts: [{ value: '{username}' }, { value: '{password}' }],
          join: ':',
          as: 'joined',
        },
        {
          op: 'http.execute',
          url: '{origin}/api/echo',
          method: 'POST',
          body: { ref: 'profile' },
          parse: 'json',
          as: 'echo',
        },
        { op: 'auth.write' },
      ],
      [
        {
          response: {
            from: 'echo',
            path: 'body.username',
            equals: 'admin@fixture.test',
          },
        },
      ],
      {
        auth: {
          mode: 'engine',
          cookiesWrite: [],
          localStorageWrite: [
            { key: 'payload_json', value: '$profile' },
            { key: 'payload_joined', value: '$joined' },
          ],
        },
      },
    ),
  );

  const page = await openLogin(context, fixtureServer);
  await runAccount(page, worker, FIXTURE_ADMIN_NAME);
  await expectAccountSuccess(page);

  const stored = await page.evaluate(() => ({
    json: localStorage.getItem('payload_json'),
    joined: localStorage.getItem('payload_joined'),
  }));
  expect(JSON.parse(stored.json ?? 'null')).toEqual({
    username: 'admin@fixture.test',
    password: FIXTURE_PASSWORD,
  });
  expect(stored.joined).toBe(`admin@fixture.test:${FIXTURE_PASSWORD}`);
});

test('[API-17] maps a value with a matching case and a default', async ({
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
          op: 'map',
          input: '{username}',
          cases: [{ equals: 'admin@fixture.test', value: 'ADMIN' }],
          default: 'USER',
          as: 'role',
        },
        {
          op: 'map',
          input: 'unknown@fixture.test',
          cases: [{ equals: 'admin@fixture.test', value: 'ADMIN' }],
          default: 'USER',
          as: 'fallback',
        },
        { op: 'auth.write' },
      ],
      [{ page: { type: 'selector', target: '#username' } }],
      {
        auth: {
          mode: 'engine',
          cookiesWrite: [],
          localStorageWrite: [
            { key: 'mapped_role', value: '$role' },
            { key: 'mapped_fallback', value: '$fallback' },
          ],
        },
      },
    ),
  );

  const page = await openLogin(context, fixtureServer);
  await runAccount(page, worker, FIXTURE_ADMIN_NAME);
  await expectAccountSuccess(page);

  const stored = await page.evaluate(() => ({
    role: localStorage.getItem('mapped_role'),
    fallback: localStorage.getItem('mapped_fallback'),
  }));
  expect(stored).toEqual({ role: 'ADMIN', fallback: 'USER' });
});

test('[API-18] encrypts the password with RSA PKCS#1 v1.5', async ({
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
        { op: 'clear.cookies', range: 'all' },
        { op: 'goto', url: '{origin}/login', waitForLoad: true },
        {
          op: 'crypto.encrypt',
          algorithm: 'rsa-pkcs1v15',
          publicKey: '{publicKey}',
          input: '{password}',
          as: 'encrypted',
        },
        {
          op: 'http.execute',
          url: '{origin}/api/rsa-login',
          method: 'POST',
          body: {
            json: { username: '{username}', password: '$encrypted' },
          },
          parse: 'json',
          as: 'rsa',
        },
        { op: 'auth.write' },
        { op: 'goto', url: '{origin}/console', waitForLoad: true },
      ],
      [{ token: { from: 'rsa', path: 'sessionToken' } }],
      {
        vars: [{ name: 'publicKey', default: fixtureServer.rsaPublicKey }],
        auth: {
          mode: 'engine',
          cookiesWrite: [
            {
              name: 'shadekit_session',
              value: '$rsa.sessionToken',
              httpOnly: true,
              sameSite: 'lax',
            },
          ],
        },
      },
    ),
  );

  const page = await openLogin(context, fixtureServer);
  await loginViaPanel(page, worker, FIXTURE_ADMIN_NAME);

  await new ConsolePage(page).expectIdentity(ADMIN_IDENTITY);
  const request = fixtureServer.requests.find(
    (entry) => entry.path === '/api/rsa-login',
  );
  const submitted = JSON.parse(request?.body ?? '{}') as Record<
    string,
    string
  >;
  expect(submitted.password).not.toBe(FIXTURE_PASSWORD);
  expect(submitted.password.length).toBeGreaterThan(100);
});

test('[API-19] extracts a nested token from localStorage JSON', async ({
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
          op: 'extract',
          source: 'local',
          key: 'profile',
          parse: 'jsonValue',
          as: 'profile',
        },
        { op: 'auth.write' },
      ],
      [{ page: { type: 'selector', target: '#username' } }],
      {
        auth: {
          mode: 'engine',
          cookiesWrite: [],
          localStorageWrite: [
            {
              key: 'access_token',
              value: '$profile.data.accessToken',
            },
          ],
        },
      },
    ),
  );

  const page = await openLogin(context, fixtureServer);
  await page.evaluate(() => {
    localStorage.setItem(
      'profile',
      JSON.stringify({ data: { accessToken: 'profile-token' } }),
    );
  });
  await runAccount(page, worker, FIXTURE_ADMIN_NAME);
  await expectAccountSuccess(page);

  expect(
    await page.evaluate(() => localStorage.getItem('access_token')),
  ).toBe('profile-token');
});

test('[API-20] captures and restores cookies and storage', async ({
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
          url: '{origin}/api/token',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: { json: { username: '{username}', password: '{password}' } },
          parse: 'json',
          as: 'token',
        },
        { op: 'auth.write' },
        {
          op: 'auth.capture',
          cookies: ['shadekit_session'],
          localStorage: ['token'],
          as: 'snapshot',
        },
        { op: 'clear.cookies', range: 'all' },
        { op: 'clear.storage', area: 'local', range: ['token'] },
        { op: 'auth.restore', snapshot: 'snapshot' },
      ],
      [{ page: { type: 'selector', target: '#username' } }],
      {
        auth: {
          mode: 'engine',
          cookiesWrite: [
            {
              name: 'shadekit_session',
              value: '$token.data.sessionToken',
              httpOnly: true,
              sameSite: 'lax',
            },
          ],
        },
      },
    ),
  );

  const page = await openLogin(context, fixtureServer);
  await page.evaluate(() => localStorage.setItem('token', 'old-token'));
  await runAccount(page, worker, FIXTURE_ADMIN_NAME);
  await expectAccountSuccess(page);

  const cookies = await context.cookies(origin);
  expect(sessionCookieValue(cookies)).toBeTruthy();
  expect(await page.evaluate(() => localStorage.getItem('token'))).toBe(
    'old-token',
  );
});

test('[API-21] clears only the declared auth keys and cookies', async ({
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
        { op: 'clear.cookies', range: ['shadekit_session'] },
        {
          op: 'clear.storage',
          area: 'local',
          range: ['token', 'refreshToken', 'expireAt', 'userInfo'],
        },
        { op: 'clear.storage', area: 'session', range: ['access_token'] },
      ],
      [{ page: { type: 'selector', target: '#username' } }],
    ),
  );

  const page = await openLogin(context, fixtureServer);
  await context.addCookies([
    { name: 'shadekit_session', value: 'stale', url: origin },
    { name: 'theme_cookie', value: 'keep', url: origin },
  ]);
  await page.evaluate(() => {
    localStorage.setItem('token', 'stale');
    localStorage.setItem('refreshToken', 'stale');
    localStorage.setItem('expireAt', 'stale');
    localStorage.setItem('userInfo', 'stale');
    localStorage.setItem('themePreference', 'keep-me');
    localStorage.setItem('unrelated', 'keep');
    sessionStorage.setItem('access_token', 'stale');
  });
  await runAccount(page, worker, FIXTURE_ADMIN_NAME);
  await expectAccountSuccess(page);

  const cookies = await context.cookies(origin);
  expect(cookies.map((cookie) => cookie.name).sort()).toEqual([
    'theme_cookie',
  ]);
  const storage = await page.evaluate(() => ({
    local: Object.fromEntries(
      Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]),
    ),
    session: sessionStorage.getItem('access_token'),
  }));
  expect(storage.local).toEqual({
    themePreference: 'keep-me',
    unrelated: 'keep',
  });
  expect(storage.session).toBeNull();
});

test('[API-22] observes page and engine auth modes in one session', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');

  await seed(context, origin, pageLoginSpec({}));
  const page = await openLogin(context, fixtureServer);
  await loginViaPanel(page, worker, FIXTURE_TESTER_NAME);
  const pageModeToken = sessionCookieValue(await context.cookies(origin));
  expect(pageModeToken).toBeTruthy();

  await seed(context, origin, apiCookieLoginSpec());
  await page.goto(fixtureServer.urlFor('exact.test', '/login'));
  await loginViaPanel(page, worker, FIXTURE_ADMIN_NAME);

  await new ConsolePage(page).expectIdentity(ADMIN_IDENTITY);
  const engineModeToken = sessionCookieValue(await context.cookies(origin));
  expect(engineModeToken).toBeTruthy();
  expect(engineModeToken).not.toBe(pageModeToken);
  expect(await page.evaluate(() => localStorage.getItem('access_token'))).toBeNull();
});
