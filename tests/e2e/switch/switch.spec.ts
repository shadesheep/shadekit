import type { BrowserContext } from '@playwright/test';
import type { LoginSpec } from '../../../entrypoints/tools/account-switch/spec/types';
import { test, expect } from '../fixtures/extension';
import {
  FIXTURE_ADMIN_NAME,
  FIXTURE_TESTER_NAME,
  apiCookieLoginSpec,
  cleanupSpec,
  fixtureAccounts,
  makeAccountSwitchConfig,
  makeMultiEnvironmentConfig,
  pageLoginSpec,
  seedAccountSwitch,
  specWithSuccess,
} from '../fixtures/config';
import {
  ConsolePage,
  authStorage,
  expectAccountFailure,
  expectAccountSuccess,
  expectNoAuthentication,
  loginViaPanel,
  OptionsPage,
  runAccount,
  switchTo,
} from '../fixtures/pages';
import type { FixtureServer } from '../fixtures/server';

const TESTER_IDENTITY = {
  role: 'tester',
  name: '周然',
  email: 'tester@fixture.test',
  title: '验收测试',
  scope: '验收任务 · 回归与结果提交',
} as const;

const ADMIN_IDENTITY = {
  role: 'admin',
  name: '林屿',
  email: 'admin@fixture.test',
  title: '交付管理员',
  scope: '全部项目 · 发布与权限管理',
} as const;

function loginRequests(server: FixtureServer) {
  return server.requests.filter(
    (request) => request.path === '/api/session/login',
  );
}

async function seed(
  context: BrowserContext,
  origin: string,
  spec: LoginSpec,
) {
  await seedAccountSwitch(
    context,
    makeAccountSwitchConfig({
      originPattern: origin,
      accounts: fixtureAccounts([origin]),
      spec,
    }),
  );
}

test('[SWITCH-01] switches tester to admin and preserves unrelated storage @smoke', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seed(context, origin, cleanupSpec());
  const page = await context.newPage();
  await page.goto(fixtureServer.urlFor('exact.test', '/login'));

  await loginViaPanel(page, worker, FIXTURE_TESTER_NAME);
  await new ConsolePage(page).expectIdentity(TESTER_IDENTITY);
  await page.evaluate(() => {
    localStorage.setItem('token', 'old-token');
    localStorage.setItem('refreshToken', 'old-refresh');
    localStorage.setItem('expireAt', 'old-expiry');
    localStorage.setItem('userInfo', 'old-user');
    localStorage.setItem('themePreference', 'keep-me');
    localStorage.setItem('unrelated', 'keep');
    sessionStorage.setItem('access_token', 'old-session');
  });
  await context.addCookies([
    { name: 'theme_cookie', value: 'keep', url: origin },
  ]);

  await switchTo(page, worker, FIXTURE_ADMIN_NAME);
  await new ConsolePage(page).expectIdentity(ADMIN_IDENTITY);

  const storage = await authStorage(page);
  expect(storage.local).toEqual({
    token: null,
    refreshToken: null,
    expireAt: null,
    userInfo: null,
    access_token: null,
  });
  expect(storage.session.access_token).toBeNull();
  expect(
    await page.evaluate(() => ({
      theme: localStorage.getItem('themePreference'),
      unrelated: localStorage.getItem('unrelated'),
    })),
  ).toEqual({ theme: 'keep-me', unrelated: 'keep' });
  expect((await context.cookies(origin)).map((cookie) => cookie.name).sort())
    .toEqual(['shadekit_session', 'theme_cookie']);
});

test('[SWITCH-02] switches admin back to tester', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seed(context, origin, cleanupSpec());
  const page = await context.newPage();
  await page.goto(fixtureServer.urlFor('exact.test', '/login'));

  await loginViaPanel(page, worker, FIXTURE_ADMIN_NAME);
  await new ConsolePage(page).expectIdentity(ADMIN_IDENTITY);
  await switchTo(page, worker, FIXTURE_TESTER_NAME);
  await new ConsolePage(page).expectIdentity(TESTER_IDENTITY);
});

test('[SWITCH-03] keeps the final identity when the same account logs in again', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seed(context, origin, cleanupSpec());
  const page = await context.newPage();
  await page.goto(fixtureServer.urlFor('exact.test', '/login'));

  await loginViaPanel(page, worker, FIXTURE_TESTER_NAME);
  await new ConsolePage(page).expectIdentity(TESTER_IDENTITY);
  await switchTo(page, worker, FIXTURE_TESTER_NAME);
  await new ConsolePage(page).expectIdentity(TESTER_IDENTITY);
  expect(loginRequests(fixtureServer)).toHaveLength(2);
});

test('[SWITCH-04] switches tester → admin → tester consecutively', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seed(context, origin, cleanupSpec());
  const page = await context.newPage();
  await page.goto(fixtureServer.urlFor('exact.test', '/login'));

  await loginViaPanel(page, worker, FIXTURE_TESTER_NAME);
  await new ConsolePage(page).expectIdentity(TESTER_IDENTITY);
  await switchTo(page, worker, FIXTURE_ADMIN_NAME);
  await new ConsolePage(page).expectIdentity(ADMIN_IDENTITY);
  await switchTo(page, worker, FIXTURE_TESTER_NAME);
  await new ConsolePage(page).expectIdentity(TESTER_IDENTITY);
});

test('[SWITCH-05] logs in a saved account from the options row into the bound environment', async ({
  context,
  fixtureServer,
  openOptions,
}) => {
  const exactOrigin = new URL(fixtureServer.urlFor('exact.test')).origin;
  const otherOrigin = new URL(fixtureServer.urlFor('other.test')).origin;
  await seedAccountSwitch(
    context,
    makeMultiEnvironmentConfig({
      environments: [
        { key: exactOrigin, name: '测试环境', spec: pageLoginSpec({}) },
        {
          key: otherOrigin,
          name: '其他环境',
          spec: pageLoginSpec({}),
          // options 行内登录按环境入口打开目标页。
          entryUrl: `${otherOrigin}/console`,
        },
      ],
      // 账号只绑定 other.test，行内「登录」才能落到该环境。
      accounts: fixtureAccounts([otherOrigin]),
    }),
  );

  const source = await context.newPage();
  await source.goto(fixtureServer.urlFor('exact.test', '/login'));
  const options = await openOptions();
  const tabsBeforeLogin = context.pages().length;

  const target = await new OptionsPage(options).loginSavedAccount(
    FIXTURE_ADMIN_NAME,
  );
  await target.waitForURL(
    (url) => url.origin === otherOrigin && url.pathname === '/console',
  );
  await new ConsolePage(target).expectIdentity(ADMIN_IDENTITY);

  expect(context.pages()).toHaveLength(tabsBeforeLogin + 1);
  expect(await source.evaluate(() => location.origin)).toBe(exactOrigin);
  await expectNoAuthentication(source, exactOrigin);
});

test('[SWITCH-06] shares cookies across same-origin tabs and refreshes the stale view', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seed(context, origin, cleanupSpec());
  const first = await context.newPage();
  await first.goto(fixtureServer.urlFor('exact.test', '/login'));
  await loginViaPanel(first, worker, FIXTURE_TESTER_NAME);
  await new ConsolePage(first).expectIdentity(TESTER_IDENTITY);

  const second = await context.newPage();
  await second.goto(fixtureServer.urlFor('exact.test', '/console'));
  await new ConsolePage(second).expectIdentity(TESTER_IDENTITY);

  await switchTo(first, worker, FIXTURE_ADMIN_NAME);
  await new ConsolePage(first).expectIdentity(ADMIN_IDENTITY);

  // 未刷新的标签页保留旧视图，但共享 Cookie 已是新会话。
  await new ConsolePage(second).expectIdentity(TESTER_IDENTITY);
  await second.reload();
  await new ConsolePage(second).expectIdentity(ADMIN_IDENTITY);
});

test('[SWITCH-07] serializes repeated triggers into one login side effect', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  const concurrent = cleanupSpec();
  await seed(context, origin, {
    ...concurrent,
    ops: concurrent.ops.filter((op) => op.op !== 'goto'),
  });
  const page = await context.newPage();
  await page.goto(fixtureServer.urlFor('exact.test', '/login'));

  const barrier = fixtureServer.holdResponse('/api/session/login');
  try {
    await runAccount(page, worker, FIXTURE_TESTER_NAME);
    await barrier.entered;

    const card = page
      .locator('#devtools-panel .as-account-card')
      .filter({ hasText: FIXTURE_TESTER_NAME });
    await card.dispatchEvent('click');
    // 引擎填充后焦点在页面输入框，先回到面板再模拟键盘重复触发，
    // 避免 Enter 顺带提交页面登录表单造成假副作用。
    await page.locator('#devtools-panel .as-panel').focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
  } finally {
    barrier.release();
  }

  await expectAccountSuccess(page);
  await new ConsolePage(page).expectIdentity(TESTER_IDENTITY);
  expect(loginRequests(fixtureServer)).toHaveLength(1);
});

test('[SWITCH-08] releases the login lock after a request timeout', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  const slowBase = apiCookieLoginSpec();
  await seed(
    context,
    origin,
    specWithSuccess(
      { ...slowBase, ops: slowBase.ops.filter((op) => op.op !== 'goto') },
      slowBase.success,
      { limits: { requestMs: 100, settleMs: 1_000 } },
    ),
  );
  const page = await context.newPage();
  await page.goto(fixtureServer.urlFor('exact.test', '/login'));

  const barrier = fixtureServer.holdResponse('/api/token');
  try {
    await runAccount(page, worker, FIXTURE_ADMIN_NAME);
    await barrier.entered;
    await expectAccountFailure(page, '登录请求超时');
  } finally {
    barrier.release();
  }
  await expectNoAuthentication(page, origin);

  await seed(context, origin, apiCookieLoginSpec());
  await loginViaPanel(page, worker, FIXTURE_ADMIN_NAME);
  await new ConsolePage(page).expectIdentity(ADMIN_IDENTITY);
});
