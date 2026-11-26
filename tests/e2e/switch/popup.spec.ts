import { test, expect } from '../fixtures/extension';
import {
  fixtureAccounts,
  FIXTURE_TESTER_NAME,
  apiCookieLoginSpec,
  makeAccountSwitchConfig,
  pageLoginSpec,
  seedAccountSwitch,
} from '../fixtures/config';

test('[POPUP-01] matches the active page and keeps account content aligned in both themes', async ({
  context,
  extensionId,
  fixtureServer,
  worker,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  const environmentId = `${origin}/login`;
  const config = makeAccountSwitchConfig({
    originPattern: environmentId,
    name: 'JYPT',
    matchPath: '/login',
    accounts: fixtureAccounts([environmentId]),
    spec: pageLoginSpec(),
  });
  await seedAccountSwitch(context, config);
  const page = await context.newPage();
  await page.goto(fixtureServer.urlFor('exact.test', '/login'));
  await page.bringToFront();

  // 在后台标签页渲染真正的 popup.html，保留前台站点；消息仍来自扩展页。
  const pendingPopup = context.waitForEvent('page');
  await worker.evaluate(async (url) => {
    await chrome.tabs.create({ url, active: false });
  }, `chrome-extension://${extensionId}/popup.html`);
  const popup = await pendingPopup;
  await popup.setViewportSize({ width: 336, height: 600 });
  const errors: string[] = [];
  popup.on('pageerror', (error) => errors.push(error.message));
  await popup.waitForLoadState();

  for (const theme of ['light', 'dark']) {
    await popup.evaluate((value) => localStorage.setItem('devtools-theme', value), theme);
    await popup.reload();
    await popup.getByRole('button', { name: /环境与账号/ }).click();
    await expect(popup.locator('.as-tab-env-label')).toHaveText('JYPT');
    await expect(popup.locator('.as-account-card')).toHaveCount(config.accounts.length);
    for (const account of config.accounts) {
      await expect(popup.locator('.as-account-list')).toContainText(account.name);
    }
    expect(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await popup.getByRole('button', { name: '快捷登录', exact: true }).click();
    expect(await popup.locator('.as-ql-input').evaluate((input) =>
      input.getBoundingClientRect().right <= input.parentElement!.getBoundingClientRect().right + 1,
    )).toBe(true);
  }

  await seedAccountSwitch(context, { ...config, accounts: [] });
  await page.bringToFront();
  await popup.reload();
  await popup.getByRole('button', { name: /环境与账号/ }).click();
  const addAccount = popup.getByRole('button', { name: '打开设置添加账号', exact: true });
  await expect(addAccount).toBeVisible();
  expect(await addAccount.evaluate((button) => {
    const child = button.getBoundingClientRect();
    const parent = button.parentElement!.getBoundingClientRect();
    return Math.abs((child.left + child.right - parent.left - parent.right) / 2);
  })).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

for (const { hostPattern, mode, spec, endpoint } of [
  { hostPattern: 'a.wild.test', mode: 'page', spec: pageLoginSpec(), endpoint: '/api/session/login' },
  { hostPattern: '*.wild.test', mode: 'page', spec: pageLoginSpec(), endpoint: '/api/session/login' },
  { hostPattern: '*.wild.test', mode: 'api', spec: apiCookieLoginSpec(), endpoint: '/api/token' },
]) {
  test(`[POPUP-LOGIN] logs in on the active website without an entry URL (${hostPattern}, ${mode})`, async ({
    context,
    extensionId,
    fixtureServer,
    worker,
  }) => {
    const environmentId = `http://${hostPattern}:${fixtureServer.port}/login`;
    await seedAccountSwitch(context, makeAccountSwitchConfig({
      originPattern: environmentId,
      name: 'JYPT',
      matchPath: '/login',
      accounts: fixtureAccounts([environmentId]),
      spec,
    }));
    const page = await context.newPage();
    await page.goto(fixtureServer.urlFor('a.wild.test', '/login'));
    await page.bringToFront();

    const pendingPopup = context.waitForEvent('page');
    await worker.evaluate(async (url) => {
      await chrome.tabs.create({ url, active: false });
    }, `chrome-extension://${extensionId}/popup.html`);
    const popup = await pendingPopup;
    await popup.waitForLoadState();
    await popup.getByRole('button', { name: /环境与账号/ }).click();
    const cards = popup.locator('.as-account-card');
    await expect(cards).toHaveCount(2);
    await cards.filter({ hasText: FIXTURE_TESTER_NAME }).click();

    await page.waitForURL((url) => url.pathname === '/console');
    await expect(page.locator('body')).toHaveAttribute('data-current-role', 'tester');
    await expect(page.locator('#identity-email')).toHaveText('tester@fixture.test');
    expect(new URL(page.url()).hostname).toBe('a.wild.test');
    expect(context.pages().filter((tab) => /^http:/.test(tab.url()))).toEqual([page]);
    expect(fixtureServer.requests.filter((request) =>
      request.method === 'POST' && request.path === endpoint,
    )).toHaveLength(1);
  });
}
