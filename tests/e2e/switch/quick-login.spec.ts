import type { LoginSpec } from '../../../entrypoints/tools/account-switch/spec/types';
import { test, expect } from '../fixtures/extension';
import {
  FIXTURE_PASSWORD,
  FIXTURE_TESTER_NAME,
  apiCookieLoginSpec,
  fixtureAccounts,
  makeAccountSwitchConfig,
  makeMultiEnvironmentConfig,
  pageLoginSpec,
  seedAccountSwitch,
} from '../fixtures/config';
import {
  ConsolePage,
  loginViaPanel,
  submitQuickLogin,
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

function multiEnvironmentConfig(
  fixtureServer: FixtureServer,
  options: {
    exactSpec: LoginSpec;
    otherSpec: LoginSpec;
    debugRedirect?: string;
  },
) {
  const exactOrigin = fixtureServer.urlFor('exact.test');
  const otherOrigin = fixtureServer.urlFor('other.test');
  return makeMultiEnvironmentConfig({
    environments: [
      {
        key: exactOrigin,
        name: '测试环境',
        spec: options.exactSpec,
        ...(options.debugRedirect
          ? {
              debugRedirect: options.debugRedirect,
              debugRedirectEnabled: true,
            }
          : {}),
      },
      {
        key: otherOrigin,
        name: '其他环境',
        spec: options.otherSpec,
      },
    ],
    accounts: fixtureAccounts([exactOrigin, otherOrigin]),
  });
}

test('[QUICK-01] logs in with a pure account and the environment default password @smoke', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seedAccountSwitch(
    context,
    makeAccountSwitchConfig({
      originPattern: origin,
      accounts: fixtureAccounts([origin]),
      spec: pageLoginSpec({}),
      defaultPassword: FIXTURE_PASSWORD,
    }),
  );
  const page = await context.newPage();
  await page.goto(fixtureServer.urlFor('exact.test', '/login'));

  await submitQuickLogin(page, worker, 'tester@fixture.test');
  await expect(page).toHaveURL(/\/console$/);
  await new ConsolePage(page).expectIdentity(TESTER_IDENTITY);
  expect(
    (await context.cookies(origin)).find(
      (cookie) => cookie.name === 'shadekit_session',
    )?.value,
  ).toBeTruthy();
});

test('[QUICK-02] preserves path, query and hash in a new tab without touching the source page @smoke', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const exactOrigin = new URL(fixtureServer.urlFor('exact.test')).origin;
  const otherOrigin = new URL(fixtureServer.urlFor('other.test')).origin;
  await seedAccountSwitch(
    context,
    multiEnvironmentConfig(fixtureServer, {
      exactSpec: pageLoginSpec({}),
      otherSpec: pageLoginSpec({}),
    }),
  );
  const source = await context.newPage();
  await source.goto(fixtureServer.urlFor('exact.test', '/login'));
  await loginViaPanel(source, worker, FIXTURE_TESTER_NAME);
  await new ConsolePage(source).expectIdentity(TESTER_IDENTITY);
  await source.evaluate(() => {
    localStorage.setItem('quick_source', 'keep');
    localStorage.setItem('unrelated', 'keep');
  });
  const sourceCookie = (await context.cookies(exactOrigin)).find(
    (cookie) => cookie.name === 'shadekit_session',
  )?.value;
  expect(sourceCookie).toBeTruthy();

  const newPagePromise = context.waitForEvent('page');
  await submitQuickLogin(
    source,
    worker,
    `${otherOrigin}/console?source=quick#identity\nadmin@fixture.test/${FIXTURE_PASSWORD}`,
  );
  const target = await newPagePromise;
  await target.waitForURL(
    (url) =>
      url.origin === otherOrigin &&
      url.pathname === '/console' &&
      url.search === '?source=quick' &&
      url.hash === '#identity',
  );
  await new ConsolePage(target).expectIdentity(ADMIN_IDENTITY);

  expect(
    (await context.cookies(exactOrigin)).find(
      (cookie) => cookie.name === 'shadekit_session',
    )?.value,
  ).toBe(sourceCookie);
  expect(
    await source.evaluate(() => ({
      quick: localStorage.getItem('quick_source'),
      unrelated: localStorage.getItem('unrelated'),
    })),
  ).toEqual({ quick: 'keep', unrelated: 'keep' });
  expect(
    (await context.cookies(otherOrigin)).find(
      (cookie) => cookie.name === 'shadekit_session',
    )?.value,
  ).toBeTruthy();
});

test('[QUICK-03] follows the configured debug redirect to the reproduction URL', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const exactOrigin = new URL(fixtureServer.urlFor('exact.test')).origin;
  const otherOrigin = new URL(fixtureServer.urlFor('other.test')).origin;
  const apiBase = apiCookieLoginSpec();
  // 登录在 redirect origin 执行：保留 goto 与 token 请求，去掉登录后的控制台导航。
  const redirectSpec = { ...apiBase, ops: apiBase.ops.slice(0, -1) };
  await seedAccountSwitch(
    context,
    multiEnvironmentConfig(fixtureServer, {
      exactSpec: pageLoginSpec({}),
      otherSpec: redirectSpec,
      debugRedirect: otherOrigin,
    }),
  );
  const source = await context.newPage();
  await source.goto(fixtureServer.urlFor('exact.test', '/login'));

  const newPagePromise = context.waitForEvent('page');
  await submitQuickLogin(
    source,
    worker,
    `${exactOrigin}/console?source=debug#frag\nadmin@fixture.test/${FIXTURE_PASSWORD}`,
    { debugRedirect: true },
  );
  const target = await newPagePromise;
  await target.waitForURL(
    (url) =>
      url.origin === otherOrigin &&
      url.pathname === '/console' &&
      url.search === '?source=debug' &&
      url.hash === '#frag',
  );
  await new ConsolePage(target).expectIdentity(ADMIN_IDENTITY);
  expect(await target.evaluate(() => location.origin)).toBe(otherOrigin);
});
