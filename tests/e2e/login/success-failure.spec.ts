import type { BrowserContext, Page } from '@playwright/test';
import type { LoginSpec } from '../../../entrypoints/tools/account-switch/spec/types';
import { test, expect } from '../fixtures/extension';
import {
  FIXTURE_ADMIN_NAME,
  FIXTURE_PASSWORD,
  FIXTURE_TESTER_NAME,
  apiCookieLoginSpec,
  apiStorageLoginSpec,
  fixtureAccounts,
  makeAccountSwitchConfig,
  pageLoginSpec,
  seedAccountSwitch,
  specWithFailure,
  specWithSuccess,
} from '../fixtures/config';
import {
  ConsolePage,
  expectAccountFailure,
  expectAccountSuccess,
  loginViaPanel,
  runAccount,
} from '../fixtures/pages';
import type { FixtureServer } from '../fixtures/server';

const TESTER_IDENTITY = {
  role: 'tester',
  name: '周然',
  email: 'tester@fixture.test',
  title: '验收测试',
  scope: '验收任务 · 回归与结果提交',
} as const;

const AUTH_STORAGE_KEYS = [
  'token',
  'refreshToken',
  'expireAt',
  'userInfo',
  'access_token',
];

async function seed(
  context: BrowserContext,
  origin: string,
  spec: LoginSpec,
  accounts = fixtureAccounts([origin]),
): Promise<void> {
  await seedAccountSwitch(
    context,
    makeAccountSwitchConfig({ originPattern: origin, accounts, spec }),
  );
}

async function openPage(
  context: BrowserContext,
  fixtureServer: FixtureServer,
  path: string,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(fixtureServer.urlFor('exact.test', path));
  return page;
}

async function expectNoAuthentication(page: Page, origin: string) {
  const cookies = await page.context().cookies(origin);
  expect(cookies.filter((cookie) => cookie.name === 'shadekit_session')).toEqual(
    [],
  );
  const authKeys = await page.evaluate((keys) => {
    const present = [
      ...Object.keys(window.localStorage),
      ...Object.keys(window.sessionStorage),
    ];
    return present.filter((key) => keys.includes(key));
  }, AUTH_STORAGE_KEYS);
  expect(authKeys).toEqual([]);
}

test('[RESULT-01] accepts formGone as a success signal', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seed(
    context,
    origin,
    specWithSuccess(pageLoginSpec({ loginPath: '/form-spa' }), [
      { page: { type: 'formGone' } },
    ]),
  );
  const page = await openPage(context, fixtureServer, '/form-spa');

  await runAccount(page, worker, FIXTURE_TESTER_NAME);
  await expectAccountSuccess(page);

  await expect(page.locator('#login-form')).toHaveCount(0);
  await new ConsolePage(page).expectIdentity(TESTER_IDENTITY);
});

test('[RESULT-02] accepts urlChanged as a success signal', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seed(
    context,
    origin,
    specWithSuccess(pageLoginSpec({}), [
      { page: { type: 'urlChanged' } },
    ]),
  );
  const page = await openPage(context, fixtureServer, '/login');

  await loginViaPanel(page, worker, FIXTURE_TESTER_NAME);
  await new ConsolePage(page).expectIdentity(TESTER_IDENTITY);
});

test('[RESULT-03] accepts a selector as a success signal', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seed(
    context,
    origin,
    specWithSuccess(pageLoginSpec({}), [
      { page: { type: 'selector', target: '#current-account' } },
    ]),
  );
  const page = await openPage(context, fixtureServer, '/login');

  await loginViaPanel(page, worker, FIXTURE_TESTER_NAME);
  await new ConsolePage(page).expectIdentity(TESTER_IDENTITY);
});

test('[RESULT-04] accepts a cookie as a success signal', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  const base = apiCookieLoginSpec();
  // Cookie 由 auth.write 直接写入，避免表单提交与尾部刷新竞争导致
  // cookie 已成立但页面尚未导航的中间态。
  await seed(
    context,
    origin,
    specWithSuccess(
      { ...base, ops: base.ops.filter((op) => op.op !== 'goto') },
      [{ page: { type: 'cookie', name: 'shadekit_session' } }],
    ),
  );
  const page = await openPage(context, fixtureServer, '/login');

  await runAccount(page, worker, FIXTURE_ADMIN_NAME);
  await expectAccountSuccess(page);
  const cookie = (await context.cookies(origin)).find(
    (candidate) => candidate.name === 'shadekit_session',
  );
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.value).toBeTruthy();
});

test('[RESULT-05] accepts localStorage as a success signal', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  const base = apiStorageLoginSpec();
  await seed(
    context,
    origin,
    specWithSuccess(
      { ...base, ops: base.ops.filter((op) => op.op !== 'goto') },
      [
        { page: { type: 'storage', area: 'local', key: 'access_token' } },
      ],
    ),
  );
  const page = await openPage(context, fixtureServer, '/login');

  await runAccount(page, worker, FIXTURE_ADMIN_NAME);
  await expectAccountSuccess(page);
  expect(
    await page.evaluate(() => window.localStorage.getItem('access_token')),
  ).toBeTruthy();
});

test('[RESULT-06] accepts a fixed wait as a success signal', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seed(
    context,
    origin,
    specWithSuccess(
      pageLoginSpec({}),
      [{ page: { type: 'fixed', ms: 1500 } }],
      {
        ops: [{ op: 'clear.cookies', range: 'none' }],
      },
    ),
  );
  const page = await openPage(context, fixtureServer, '/login');

  const started = Date.now();
  await runAccount(page, worker, FIXTURE_TESTER_NAME);
  await expectAccountSuccess(page);
  expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
  expect(new URL(page.url()).pathname).toBe('/login');
});

test('[RESULT-07] distinguishes any (OR) from all (AND)', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');

  // OR：第一个条件永不成立，第二个成立也必须成功。
  await seed(
    context,
    origin,
    specWithSuccess(pageLoginSpec({}), [
      {
        page: {
          type: 'any',
          of: [
            { type: 'selector', target: '#never' },
            { type: 'selector', target: '#current-account' },
          ],
        },
      },
    ]),
  );
  const page = await openPage(context, fixtureServer, '/login');
  await loginViaPanel(page, worker, FIXTURE_TESTER_NAME);
  await new ConsolePage(page).expectIdentity(TESTER_IDENTITY);

  // AND：formGone 成立但 #never 不成立，必须失败且面板留在同一文档。
  // 先清掉上一步的会话，否则 form-spa 载入时会自动 hydrate 并移除登录表单。
  const spaSpec = pageLoginSpec({ loginPath: '/form-spa' });
  await context.clearCookies();
  await page.goto(fixtureServer.urlFor('exact.test', '/form-spa'));
  await seed(
    context,
    origin,
    specWithSuccess(
      {
        ...spaSpec,
        ops: spaSpec.ops.filter((op) => op.op !== 'goto'),
      },
      [
        {
          page: {
            type: 'all',
            of: [
              { type: 'formGone' },
              { type: 'selector', target: '#never' },
            ],
          },
        },
      ],
      { limits: { settleMs: 1500 } },
    ),
  );
  await runAccount(page, worker, FIXTURE_TESTER_NAME);
  await expectAccountFailure(page, '未确认登录成功');
});

test('[RESULT-08] stops on a failure selector and shows the rejection toast', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  const wrongPasswordAccounts = fixtureAccounts([origin]).map((account) =>
    account.id === 'fixture-tester'
      ? { ...account, password: 'wrong-pass' }
      : account,
  );
  const base = pageLoginSpec({});
  // 失败时面板必须留在同一文档：去掉 goto，直接在已打开的登录页执行。
  await seed(
    context,
    origin,
    specWithFailure(
      { ...base, ops: base.ops.filter((op) => op.op !== 'goto') },
      [{ type: 'selector', target: '#login-error' }],
    ),
    wrongPasswordAccounts,
  );
  const page = await openPage(context, fixtureServer, '/login');

  await runAccount(page, worker, FIXTURE_TESTER_NAME);
  await expectAccountFailure(page, '登录未通过');

  await expect(page.locator('#login-error')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/login');
  await expectNoAuthentication(page, origin);
});

test('[RESULT-09] reports SUCCESS_CONDITION_UNMET when the condition never holds', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  const base = apiCookieLoginSpec();
  await seed(
    context,
    origin,
    specWithSuccess(
      {
        ...base,
        ops: base.ops.filter((op) => op.op !== 'goto'),
      },
      [{ page: { type: 'selector', target: '#never' } }],
      { limits: { settleMs: 1500 } },
    ),
  );
  const page = await openPage(context, fixtureServer, '/login');

  await runAccount(page, worker, FIXTURE_ADMIN_NAME);
  await expectAccountFailure(page, '未确认登录成功');
  expect(new URL(page.url()).pathname).toBe('/login');
});

test('[RESULT-10] keeps passwords, tokens and cookies out of failure toast and logs', async ({
  context,
  fixtureServer,
  worker,
  readStorage,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  const base = apiCookieLoginSpec();
  await seed(
    context,
    origin,
    specWithSuccess(
      {
        ...base,
        ops: base.ops.filter((op) => op.op !== 'goto'),
      },
      [{ page: { type: 'selector', target: '#never' } }],
      { limits: { settleMs: 1500 } },
    ),
  );
  const page = await openPage(context, fixtureServer, '/login');

  await runAccount(page, worker, FIXTURE_ADMIN_NAME);
  await expectAccountFailure(page, '未确认登录成功');

  const sessionToken = (await context.cookies(origin)).find(
    (cookie) => cookie.name === 'shadekit_session',
  )?.value;
  expect(sessionToken).toBeTruthy();
  const toastText = await page.locator('#devtools-toast-root').innerText();
  const logs = await readStorage<unknown[]>('devtools-logs');
  expect(logs?.length).toBeGreaterThan(0);

  const observable = JSON.stringify({ toastText, logs });
  expect(observable).not.toContain(FIXTURE_PASSWORD);
  expect(observable).not.toContain(sessionToken as string);
});
