import type { BrowserContext, Page } from '@playwright/test';
import type { LoginSpec } from '../../../entrypoints/tools/account-switch/spec/types';
import { test, expect } from '../fixtures/extension';
import {
  FIXTURE_TESTER_NAME,
  fixtureAccounts,
  makeAccountSwitchConfig,
  pageLoginSpec,
  seedAccountSwitch,
} from '../fixtures/config';
import {
  ConsolePage,
  expectAccountFailure,
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

function loginRequests(server: FixtureServer) {
  return server.requests.filter(
    (request) => request.path === '/api/session/login',
  );
}

function requestBody(request: { body: string } | undefined) {
  return JSON.parse(request?.body || '{}') as Record<string, unknown>;
}

async function seedWithSpec(
  context: BrowserContext,
  origin: string,
  spec: LoginSpec,
  accounts = fixtureAccounts([origin]),
) {
  await seedAccountSwitch(
    context,
    makeAccountSwitchConfig({ originPattern: origin, accounts, spec }),
  );
}

async function openLoginPage(
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

test('[FORM-01] logs in through a standard input form @smoke', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seedWithSpec(context, origin, pageLoginSpec({}));
  const page = await openLoginPage(context, fixtureServer, '/login');

  await loginViaPanel(page, worker, FIXTURE_TESTER_NAME);

  await new ConsolePage(page).expectIdentity(TESTER_IDENTITY);
  expect(requestBody(loginRequests(fixtureServer)[0])).toMatchObject({
    username: 'tester@fixture.test',
    password: 'fixture-pass',
  });
});

test('[FORM-02] recovers after the server rejects the saved password', async ({
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
  // 失败时面板必须留在同一文档里才能接收错误并恢复：去掉登录声明中的 goto，
  // 直接在测试已打开的 /login 上执行（成功场景仍用含 goto 的标准声明）。
  const failingSpec = pageLoginSpec({});
  await seedWithSpec(
    context,
    origin,
    {
      ...failingSpec,
      ops: failingSpec.ops.filter((op) => op.op !== 'goto'),
    },
    wrongPasswordAccounts,
  );

  const page = await openLoginPage(context, fixtureServer, '/login');
  await runAccount(page, worker, FIXTURE_TESTER_NAME);
  await expectAccountFailure(page, '未确认登录成功');

  const error = page.locator('#login-error');
  await expect(error).toBeVisible();
  await expect(error).toContainText('Invalid username or password');
  expect(new URL(page.url()).pathname).toBe('/login');
  await expectNoAuthentication(page, origin);

  // 同页恢复：用真实保存链路把密码改回正确值，再次点击同一账号卡。
  await seedWithSpec(context, origin, pageLoginSpec({}));
  await loginViaPanel(page, worker, FIXTURE_TESTER_NAME);
  await new ConsolePage(page).expectIdentity(TESTER_IDENTITY);

  const attempts = loginRequests(fixtureServer);
  expect(attempts).toHaveLength(2);
  expect(requestBody(attempts[0])).toMatchObject({
    username: 'tester@fixture.test',
    password: 'wrong-pass',
  });
  expect(requestBody(attempts[1])).toMatchObject({
    username: 'tester@fixture.test',
    password: 'fixture-pass',
  });
});

test('[FORM-03] logs in through textarea username and password @smoke', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  // textarea 密码框不匹配 formGone 的 input[type=password] 基准，改用目标
  // 控制台真实渲染出的身份节点作为成功信号，避免导航未提交就判成功。
  await seedWithSpec(context, origin, {
    ...pageLoginSpec({ loginPath: '/textarea-login' }),
    success: [{ page: { type: 'selector', target: '#identity-name' } }],
  });
  const page = await openLoginPage(context, fixtureServer, '/textarea-login');

  // 负向控制：只改 value 不派发事件时，表单模型不更新，提交必须被拒绝。
  await page.evaluate(() => {
    const setValue = (selector: string, value: string) => {
      const field = document.querySelector<HTMLTextAreaElement>(selector);
      if (!field) throw new Error(`missing textarea ${selector}`);
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      if (!setter) throw new Error('textarea value setter unavailable');
      setter.call(field, value);
    };
    setValue('#username', 'tester@fixture.test');
    setValue('#password', 'fixture-pass');
    document.querySelector<HTMLFormElement>('#login-form')?.requestSubmit();
  });
  await expect(page.locator('#login-error')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/textarea-login');
  expect(loginRequests(fixtureServer)).toEqual([]);

  await loginViaPanel(page, worker, FIXTURE_TESTER_NAME);
  await new ConsolePage(page).expectIdentity(TESTER_IDENTITY);
  expect(requestBody(loginRequests(fixtureServer)[0])).toMatchObject({
    username: 'tester@fixture.test',
    password: 'fixture-pass',
  });
});

test('[FORM-04] submits through an input[type=submit] control', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seedWithSpec(
    context,
    origin,
    pageLoginSpec({ loginPath: '/login-submit-input' }),
  );
  const page = await openLoginPage(
    context,
    fixtureServer,
    '/login-submit-input',
  );

  await loginViaPanel(page, worker, FIXTURE_TESTER_NAME);

  await new ConsolePage(page).expectIdentity(TESTER_IDENTITY);
});

test('[FORM-05] applies select and checkbox values before submit', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seedWithSpec(
    context,
    origin,
    pageLoginSpec({
      loginPath: '/login-options',
      preSubmitOps: [
        { op: 'fill', target: '#tenant', value: 'blue', clearFirst: true },
        { op: 'click', target: '#remember' },
      ],
    }),
  );
  const page = await openLoginPage(context, fixtureServer, '/login-options');

  await loginViaPanel(page, worker, FIXTURE_TESTER_NAME);

  await new ConsolePage(page).expectIdentity(TESTER_IDENTITY);
  expect(requestBody(loginRequests(fixtureServer)[0])).toMatchObject({
    tenant: 'blue',
    remember: true,
  });
});

test('[FORM-06] clears prefilled inputs before filling the saved account', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seedWithSpec(
    context,
    origin,
    pageLoginSpec({ loginPath: '/login?prefill=1', clearFirst: true }),
  );
  const page = await openLoginPage(context, fixtureServer, '/login?prefill=1');
  await expect(page.locator('#username')).toHaveValue('stale@fixture.test');

  await loginViaPanel(page, worker, FIXTURE_TESTER_NAME);

  await new ConsolePage(page).expectIdentity(TESTER_IDENTITY);
  const submitted = requestBody(loginRequests(fixtureServer)[0]);
  expect(submitted.username).toBe('tester@fixture.test');
  expect(submitted.password).toBe('fixture-pass');
});
