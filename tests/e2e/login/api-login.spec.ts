import type { BrowserContext } from '@playwright/test';
import {
  LOGIN_SPEC_VERSION,
  type LoginSpec,
} from '../../../entrypoints/tools/account-switch/spec/types';
import { test, expect } from '../fixtures/extension';
import {
  FIXTURE_ADMIN_NAME,
  apiCookieLoginSpec,
  apiStorageLoginSpec,
  fixtureAccounts,
  makeAccountSwitchConfig,
  seedAccountSwitch,
} from '../fixtures/config';
import {
  ConsolePage,
  expectAccountFailure,
  expectAccountSuccess,
  loginViaPanel,
  runAccount,
} from '../fixtures/pages';

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

/** 只读取文本 token 的成功信号，不写任何会话。 */
function apiTextLoginSpec(): LoginSpec {
  return {
    version: LOGIN_SPEC_VERSION,
    template: 'api',
    ops: [
      { op: 'goto', url: '{origin}/login', waitForLoad: true },
      {
        op: 'http.execute',
        url: '{origin}/api/token-text',
        method: 'GET',
        parse: 'text',
        expectStatus: '2xx',
        as: 'textToken',
      },
    ],
    success: [{ token: { from: 'textToken', path: '' } }],
    auth: { mode: 'engine', cookiesWrite: [] },
    limits: { requestMs: 15000, stepMs: 5000, settleMs: 10000 },
  };
}

/**
 * 请求固定返回 401：http.execute 必须失败且不写认证。
 * 失败变体不带 goto：测试已在 /login，导航会销毁承载错误 Toast 的文档。
 */
function apiRejectedLoginSpec(): LoginSpec {
  return {
    version: LOGIN_SPEC_VERSION,
    template: 'api',
    ops: [
      {
        op: 'http.execute',
        url: '{origin}/api/status/401',
        method: 'GET',
        parse: 'json',
        as: 'rejected',
      },
    ],
    success: [{ response: { from: 'rejected', path: 'status', equals: 200 } }],
    auth: { mode: 'engine', cookiesWrite: [] },
    limits: { requestMs: 15000, stepMs: 5000, settleMs: 10000 },
  };
}

test('[API-01] logs in via http.execute and writes an HttpOnly cookie @smoke', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seed(context, origin, apiCookieLoginSpec());

  const page = await context.newPage();
  await page.goto(fixtureServer.urlFor('exact.test', '/login'));
  await loginViaPanel(page, worker, FIXTURE_ADMIN_NAME);

  await new ConsolePage(page).expectIdentity(ADMIN_IDENTITY);
  const cookies = await context.cookies(origin);
  expect(
    cookies.find((cookie) => cookie.name === 'shadekit_session')?.httpOnly,
  ).toBe(true);
  expect(
    fixtureServer.requests.some(
      (request) => request.path === '/api/token' && request.method === 'POST',
    ),
  ).toBe(true);
});

test('[API-02] writes and reads a localStorage token @smoke', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seed(context, origin, apiStorageLoginSpec());

  const page = await context.newPage();
  await page.goto(fixtureServer.urlFor('exact.test', '/login'));
  await loginViaPanel(page, worker, FIXTURE_ADMIN_NAME, '/api-console');

  const token = await page.evaluate(() =>
    localStorage.getItem('access_token'),
  );
  expect(token).toBeTruthy();
  await new ConsolePage(page).expectIdentity(ADMIN_IDENTITY);

  const verification = fixtureServer.requests.find(
    (request) => request.path === '/api/session/me',
  );
  expect(verification?.headers.authorization).toBe(`Bearer ${token}`);
});

test('[API-03] parses a text response into a token binding', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seed(context, origin, apiTextLoginSpec());

  const page = await context.newPage();
  await page.goto(fixtureServer.urlFor('exact.test', '/login'));
  await runAccount(page, worker, FIXTURE_ADMIN_NAME);
  await expectAccountSuccess(page);

  expect(
    fixtureServer.requests.some(
      (request) => request.path === '/api/token-text',
    ),
  ).toBe(true);
  expect(await context.cookies(origin)).toEqual([]);
  expect(new URL(page.url()).pathname).toBe('/login');
});

test('[API-04] surfaces a non-2xx API response without writing auth', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seed(context, origin, apiRejectedLoginSpec());

  const page = await context.newPage();
  await page.goto(fixtureServer.urlFor('exact.test', '/login'));
  await runAccount(page, worker, FIXTURE_ADMIN_NAME);
  await expectAccountFailure(page, /登录未通过/);

  expect(await context.cookies(origin)).toEqual([]);
  const authKeys = await page.evaluate(() => ({
    local: Object.keys(window.localStorage),
    session: Object.keys(window.sessionStorage),
  }));
  expect(authKeys).toEqual({ local: [], session: [] });
});
