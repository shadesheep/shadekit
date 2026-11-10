import type { BrowserContext } from '@playwright/test';
import {
  LOGIN_SPEC_VERSION,
  type LoginSpec,
  type SpecOp,
} from '../../../entrypoints/tools/account-switch/spec/types';
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
  expectAccountSuccess,
  loginViaPanel,
  runAccount,
} from '../fixtures/pages';

const TESTER_IDENTITY = {
  role: 'tester',
  name: '周然',
  email: 'tester@fixture.test',
  title: '验收测试',
  scope: '验收任务 · 回归与结果提交',
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

/**
 * iframe 内的登录页地址：frame 作用域记录拾取时的绝对地址；执行器按
 * origin + pathname 重新锁定 frame，query 不参与比较。
 */
function specWithFrame(origin: string): LoginSpec {
  const base = pageLoginSpec({ loginPath: '/form-iframe' });
  const frameUrl = `${origin.replace(/\/$/, '')}/login?embed=1`;
  return {
    ...base,
    ops: base.ops.map((op): SpecOp => {
      if (op.op === 'fill' || op.op === 'click') {
        return { ...op, frameUrl };
      }
      return op;
    }),
  };
}

function multistepSpec(): LoginSpec {
  return {
    version: LOGIN_SPEC_VERSION,
    template: 'generic',
    ops: [
      { op: 'clear.cookies', range: 'all' },
      { op: 'goto', url: '{origin}/form-multistep', waitForLoad: true },
      {
        op: 'fill',
        target: '#username',
        value: '{username}',
        clearFirst: true,
      },
      { op: 'click', target: '#next', onNotFound: 'fail' },
      {
        op: 'fill',
        target: '#password',
        value: '{password}',
        clearFirst: true,
      },
      { op: 'click', target: '#submit-btn', onNotFound: 'fail' },
      { op: 'auth.write' },
    ],
    success: [{ page: { type: 'formGone' } }],
    auth: { mode: 'page' },
  };
}

test('[FORM-07] logs in inside an iframe', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seed(context, origin, specWithFrame(origin));
  const page = await context.newPage();
  await page.goto(fixtureServer.urlFor('exact.test', '/form-iframe'));

  await loginViaPanel(page, worker, FIXTURE_TESTER_NAME);

  await new ConsolePage(page).expectIdentity(TESTER_IDENTITY);
  expect(
    fixtureServer.requests.some(
      (request) => request.path === '/api/session/login',
    ),
  ).toBe(true);
});

test('[FORM-08] logs in inside an open shadow root', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seed(context, origin, pageLoginSpec({ loginPath: '/form-shadow' }));
  const page = await context.newPage();
  await page.goto(fixtureServer.urlFor('exact.test', '/form-shadow'));

  await loginViaPanel(page, worker, FIXTURE_TESTER_NAME);

  await new ConsolePage(page).expectIdentity(TESTER_IDENTITY);
});

test('[FORM-09] accepts formGone after a SPA replaces the form', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seed(context, origin, pageLoginSpec({ loginPath: '/form-spa' }));
  const page = await context.newPage();
  await page.goto(fixtureServer.urlFor('exact.test', '/form-spa'));

  await runAccount(page, worker, FIXTURE_TESTER_NAME);
  await expectAccountSuccess(page);

  await expect(page).toHaveURL(/\/form-spa\/dashboard$/);
  await expect(page.locator('body')).toHaveAttribute(
    'data-current-role',
    'tester',
  );
  await expect(page.locator('#identity-name')).toHaveText('周然');
  await expect(page.locator('#login-form')).toHaveCount(0);
});

test('[FORM-10] completes a two-step login form', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seed(context, origin, multistepSpec());
  const page = await context.newPage();
  await page.goto(fixtureServer.urlFor('exact.test', '/form-multistep'));

  await loginViaPanel(page, worker, FIXTURE_TESTER_NAME);

  await new ConsolePage(page).expectIdentity(TESTER_IDENTITY);
  const submitted = fixtureServer.requests.find(
    (request) => request.path === '/api/session/login',
  );
  expect(JSON.parse(submitted?.body ?? '{}')).toMatchObject({
    username: 'tester@fixture.test',
    password: 'fixture-pass',
  });
});
