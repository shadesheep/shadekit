import type { BrowserContext } from '@playwright/test';
import type { Account } from '../../../entrypoints/tools/account-switch/types';
import { test, expect } from '../fixtures/extension';
import {
  FIXTURE_ADMIN_NAME,
  FIXTURE_PASSWORD,
  FIXTURE_TESTER_NAME,
  fixtureAccounts,
  makeAccountSwitchConfig,
  makeMultiEnvironmentConfig,
  pageLoginSpec,
  seedAccountSwitch,
} from '../fixtures/config';
import {
  ConsolePage,
  closeSwitcher,
  expectAccountSuccess,
  expectEnvBadge,
  expectMatchedEnvironment,
  loginViaPanel,
  openSwitcher,
  runAccount,
  shadowText,
  switchTo,
} from '../fixtures/pages';
import { createFixtureServer, type FixtureServer } from '../fixtures/server';

const ADMIN_NAME = FIXTURE_ADMIN_NAME;
const TESTER_NAME = FIXTURE_TESTER_NAME;

const ADMIN_IDENTITY = {
  role: 'admin',
  name: '林屿',
  email: 'admin@fixture.test',
  title: '交付管理员',
  scope: '全部项目 · 发布与权限管理',
} as const;

const TESTER_IDENTITY = {
  role: 'tester',
  name: '周然',
  email: 'tester@fixture.test',
  title: '验收测试',
  scope: '验收任务 · 回归与结果提交',
} as const;

async function seedWildcardEnvironment(
  context: BrowserContext,
  fixtureServer: Pick<FixtureServer, 'port'>,
  hostPattern = '*.wild.test',
): Promise<string> {
  const pattern = `http://${hostPattern}:${fixtureServer.port}`;
  await seedAccountSwitch(
    context,
    makeAccountSwitchConfig({
      originPattern: pattern,
      accounts: fixtureAccounts([pattern]),
      spec: pageLoginSpec({}),
    }),
  );
  return pattern;
}

function accountById(accounts: Account[], id: string): Account {
  const account = accounts.find((candidate) => candidate.id === id);
  if (!account) throw new Error(`fixture account ${id} is missing`);
  return account;
}

test('[ENV-WILD-01] matches a single-label subdomain and switches on concrete origin @smoke', async ({
  context,
  fixtureServer,
  worker,
}) => {
  await seedWildcardEnvironment(context, fixtureServer);

  const page = await context.newPage();
  await page.goto(fixtureServer.urlFor('a.wild.test', '/login'));
  await expectEnvBadge(page, '测试环境');
  await loginViaPanel(page, worker, TESTER_NAME);
  await new ConsolePage(page).expectIdentity(TESTER_IDENTITY);

  await openSwitcher(page, worker);
  expect(await shadowText(page, '#devtools-panel')).toContain(ADMIN_NAME);
  await switchTo(page, worker, ADMIN_NAME);
  await page.waitForURL((url) => url.pathname === '/console');
  await new ConsolePage(page).expectIdentity(ADMIN_IDENTITY);

  expect(new URL(page.url()).hostname).toBe('a.wild.test');
  expect(page.url()).not.toContain('*');
  expect(
    fixtureServer.requests.some(
      (request) =>
        request.host === 'a.wild.test' &&
        request.path.includes('/api/session/login'),
    ),
  ).toBe(true);
});

test('[ENV-WILD-02] matches another single-label subdomain under the same wildcard', async ({
  context,
  fixtureServer,
  worker,
}) => {
  await seedWildcardEnvironment(context, fixtureServer);

  const page = await context.newPage();
  await page.goto(fixtureServer.urlFor('b.wild.test', '/login'));
  await expectEnvBadge(page, '测试环境');
  await expectMatchedEnvironment(page, worker, '测试环境', [
    ADMIN_NAME,
    TESTER_NAME,
  ]);
});

const NEGATIVE_HOSTS = [
  {
    id: 'ENV-WILD-03',
    title: 'does not match a deeper subdomain with a single-label wildcard',
    host: 'deep.a.wild.test',
  },
  {
    id: 'ENV-WILD-04',
    title: 'does not match the apex domain',
    host: 'wild.test',
  },
  {
    id: 'ENV-WILD-05',
    title: 'does not match a suffix impostor @smoke',
    host: 'evilwild.test',
  },
  {
    id: 'ENV-WILD-06',
    title: 'does not match the wildcard base appearing before another suffix',
    host: 'wild.test.evil.test',
  },
] as const;

for (const scenario of NEGATIVE_HOSTS) {
  test(`[${scenario.id}] ${scenario.title}`, async ({
    context,
    fixtureServer,
    worker,
  }) => {
    await seedWildcardEnvironment(context, fixtureServer);

    const page = await context.newPage();
    await page.goto(fixtureServer.urlFor(scenario.host, '/login'));
    await new ConsolePage(page).expectUnmatchedEnvironment(
      worker,
      fixtureServer,
    );
  });
}

test('[ENV-WILD-07] does not match the same host on a different port', async ({
  context,
  egressProxy,
  fixtureServer,
  worker,
}) => {
  await seedWildcardEnvironment(context, fixtureServer);

  // 第二个站点网络可达（代理已登记），但端口不在配置 key 内：必须区分
  // 「网络不可达」和「环境不匹配」，后者才由本用例断言。
  const secondServer = await createFixtureServer();
  const revoke = egressProxy.allowServer(secondServer);
  try {
    const page = await context.newPage();
    const response = await page.goto(
      secondServer.urlFor('a.wild.test', '/login'),
    );
    expect(response?.status()).toBe(200);
    await expect(page.locator('#username')).toBeVisible();
    await new ConsolePage(page).expectUnmatchedEnvironment(worker, secondServer);
  } finally {
    revoke();
    await secondServer.close();
  }
});

test('[ENV-WILD-08] matches a multi-label wildcard subdomain', async ({
  context,
  fixtureServer,
  worker,
}) => {
  await seedWildcardEnvironment(context, fixtureServer, '*.*.wild.test');

  const page = await context.newPage();
  await page.goto(fixtureServer.urlFor('deep.a.wild.test', '/login'));
  await expectEnvBadge(page, '测试环境');
  await loginViaPanel(page, worker, TESTER_NAME);
  await new ConsolePage(page).expectIdentity(TESTER_IDENTITY);
  expect(new URL(page.url()).hostname).toBe('deep.a.wild.test');
});

test('[ENV-WILD-09] resolves every login request and the final URL to the concrete origin', async ({
  context,
  fixtureServer,
  worker,
}) => {
  await seedWildcardEnvironment(context, fixtureServer);

  const page = await context.newPage();
  await page.goto(fixtureServer.urlFor('a.wild.test', '/login'));
  await loginViaPanel(page, worker, TESTER_NAME);

  const beforeSwitch = fixtureServer.requests.length;
  await switchTo(page, worker, ADMIN_NAME);
  await page.waitForURL((url) => url.pathname === '/console');
  await new ConsolePage(page).expectIdentity(ADMIN_IDENTITY);

  const finalUrl = page.url();
  expect(finalUrl.startsWith(`http://a.wild.test:${fixtureServer.port}`)).toBe(
    true,
  );
  expect(finalUrl).not.toContain('*');
  expect(finalUrl).not.toContain('{origin}');

  const switchRequests = fixtureServer.requests.slice(beforeSwitch);
  const loginRequests = switchRequests.filter((request) =>
    request.path.includes('/api/session/login'),
  );
  expect(loginRequests.length).toBeGreaterThan(0);
  for (const request of loginRequests) {
    expect(request.host).toBe('a.wild.test');
    expect(request.path).not.toContain('*');
    expect(request.path).not.toContain('%2A');
    expect(request.path).not.toContain('{origin}');
  }

  // 登录声明的 goto `{origin}/login` 也必须落在具体子域上。
  const gotoRequests = switchRequests.filter((request) =>
    request.path.startsWith('/login'),
  );
  expect(gotoRequests.length).toBeGreaterThan(0);
  for (const request of gotoRequests) {
    expect(request.host).toBe('a.wild.test');
    expect(request.path).not.toContain('*');
    expect(request.path).not.toContain('%2A');
    expect(request.path).not.toContain('{origin}');
  }

  // 会话 Cookie 也必须落在具体子域上，而不是通配符/父域。
  const cookies = await context.cookies(
    `http://a.wild.test:${fixtureServer.port}`,
  );
  expect(
    cookies.some(
      (cookie) =>
        cookie.name === 'shadekit_session' && cookie.domain === 'a.wild.test',
    ),
  ).toBe(true);
});

test('[ENV-WILD-10] prefers the exact origin over a wildcard configured first', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const wildcardKey = `http://*.wild.test:${fixtureServer.port}`;
  const exactKey = `http://a.wild.test:${fixtureServer.port}`;
  const wildcardTester = accountById(
    fixtureAccounts([wildcardKey]),
    'fixture-tester',
  );
  const exactAdmin: Account = {
    id: 'fixture-exact-admin',
    name: '精确环境管理员',
    username: 'admin@fixture.test',
    password: FIXTURE_PASSWORD,
    roles: ['管理员'],
    domains: [exactKey],
  };

  await seedAccountSwitch(
    context,
    makeMultiEnvironmentConfig({
      // wildcard 先插入，精确 origin 后插入：匹配必须由特异性决定。
      environments: [
        { key: wildcardKey, name: '通配环境', spec: pageLoginSpec({}) },
        {
          key: exactKey,
          name: '精确环境',
          spec: pageLoginSpec({ loginPath: '/login?from=exact' }),
        },
      ],
      accounts: [wildcardTester, exactAdmin],
    }),
  );

  // b.wild.test 只命中通配环境：精确环境账号不可见。
  const wildcardPage = await context.newPage();
  await wildcardPage.goto(fixtureServer.urlFor('b.wild.test', '/login'));
  await expectEnvBadge(wildcardPage, '通配环境');
  await expectMatchedEnvironment(wildcardPage, worker, '通配环境', [
    TESTER_NAME,
  ]);
  await loginViaPanel(wildcardPage, worker, TESTER_NAME);
  await new ConsolePage(wildcardPage).expectIdentity(TESTER_IDENTITY);
  expect(
    fixtureServer.requests.some(
      (request) => request.host === 'b.wild.test' && request.path === '/login',
    ),
  ).toBe(true);

  // a.wild.test 同时命中通配与精确：精确环境的角标、声明与账号生效。
  const exactPage = await context.newPage();
  await exactPage.goto(fixtureServer.urlFor('a.wild.test', '/login'));
  await expectEnvBadge(exactPage, '精确环境');
  await expectMatchedEnvironment(exactPage, worker, '精确环境', [
    TESTER_NAME,
    '精确环境管理员',
  ]);
  await loginViaPanel(exactPage, worker, '精确环境管理员');
  await new ConsolePage(exactPage).expectIdentity(ADMIN_IDENTITY);
  expect(
    fixtureServer.requests.some(
      (request) =>
        request.host === 'a.wild.test' &&
        request.path === '/login?from=exact',
    ),
  ).toBe(true);
});

// BLOCKED（产品缺陷，非用例问题）：SPA history.pushState 后，Chrome 给 content
// script 消息的 sender.url 仍是文档初始地址（/login），而 sender.tab.url 已
// 更新；handleGetAccountPanel 优先取 sender.url，于是背景投影按根环境过滤
// 账号/环境，面板却按实时 location 显示路径环境。断言保持原样，待产品修复
// （http(s) 页面优先使用 sender.tab.url）后解除。
test('[ENV-WILD-11] follows path-scoped environments as the SPA route changes', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const rootKey = `http://exact.test:${fixtureServer.port}`;
  const pathKey = `${rootKey}/management`;
  const rootAdmin = accountById(
    fixtureAccounts([rootKey]),
    'fixture-admin',
  );
  const pathTester = accountById(
    fixtureAccounts([pathKey]),
    'fixture-tester',
  );

  await seedAccountSwitch(
    context,
    makeMultiEnvironmentConfig({
      environments: [
        {
          key: rootKey,
          name: '根环境',
          spec: pageLoginSpec({ loginPath: '/login' }),
        },
        {
          key: pathKey,
          name: '管理端',
          matchPath: '/management',
          spec: pageLoginSpec({ loginPath: '/login?from=management' }),
        },
      ],
      accounts: [rootAdmin, pathTester],
    }),
  );

  const page = await context.newPage();
  await page.goto(fixtureServer.urlFor('exact.test', '/login'));
  await expectEnvBadge(page, '根环境');
  await expectMatchedEnvironment(page, worker, '根环境', [ADMIN_NAME]);
  await closeSwitcher(page);

  await page.evaluate(() => history.pushState({}, '', '/management/dashboard'));
  await expectEnvBadge(page, '管理端');
  // 无路径绑定的账号覆盖整个 origin；仅绑定路径子系统的账号只在这里出现。
  await expectMatchedEnvironment(page, worker, '管理端', [
    ADMIN_NAME,
    TESTER_NAME,
  ]);
  await closeSwitcher(page);

  await page.evaluate(() => history.pushState({}, '', '/home'));
  await expectEnvBadge(page, '根环境');
  await expectMatchedEnvironment(page, worker, '根环境', [ADMIN_NAME]);
  await closeSwitcher(page);

  await page.evaluate(() => history.pushState({}, '', '/management/dashboard'));
  await expectEnvBadge(page, '管理端');
  await runAccount(page, worker, TESTER_NAME);
  await expectAccountSuccess(page);
  await page.waitForURL((url) => url.pathname === '/console');
  await new ConsolePage(page).expectIdentity(TESTER_IDENTITY);

  // 执行的是当前路由环境的登录声明，而不是根环境声明。
  expect(
    fixtureServer.requests.some(
      (request) => request.path === '/login?from=management',
    ),
  ).toBe(true);
});
