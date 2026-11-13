import type { Page, Worker } from '@playwright/test';
import { pickEnvironment } from '../../../entrypoints/tools/account-switch/utils/env';
import { expect } from './extension';
import type { FixtureServer } from './server';

const PANEL_HOST = '#devtools-panel';
const PANEL_ROOT = '.as-panel';
const ACCOUNT_CARD = '.as-account-card';
const TOAST_ROOT = '#devtools-toast-root';
const TOAST_ITEM = `${TOAST_ROOT} .toast-item`;
const ENV_BADGE_HOST = '#shadekit-env-badge-host';
const SESSION_COOKIE = 'shadekit_session';
const LOGIN_TIMEOUT = 30_000;
/** 尾随刷新稳定窗口：连续这么久文档身份不变，才认为整页刷新已提交。 */
const DOCUMENT_SETTLE_MS = 300;
const DOCUMENT_POLL_MS = 50;
const DOCUMENT_SETTLE_TIMEOUT = 5_000;

/** 认证相关存储键：切换/清理用例的观察面，未登录时不得出现。 */
const AUTH_STORAGE_KEYS = [
  'token',
  'refreshToken',
  'expireAt',
  'userInfo',
  'access_token',
];

export type AccountIdentity = {
  role: string;
  name: string;
  email: string;
  title: string;
  scope: string;
};

type PanelProjection = {
  matchedEnvKey: string;
  accounts: Array<{ id: string; name: string }>;
  domains: Record<string, { name: string; matchPath?: string }>;
};

function accountCard(page: Page, accountName: string) {
  return page
    .locator(PANEL_HOST)
    .locator(ACCOUNT_CARD)
    .filter({ hasText: accountName });
}

async function tabIdFor(page: Page, worker: Worker): Promise<number> {
  return worker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const matches = tabs.filter((tab) => tab.url === url);
    if (matches.length === 1 && matches[0]?.id !== undefined) {
      return matches[0].id;
    }
    // 同 URL 多标签（同源共享 Cookie 场景）用前台标签消歧。
    const active = tabs.find((tab) => tab.active);
    if (active?.url === url && active.id !== undefined) return active.id;
    throw new Error(
      `could not identify tab for ${url}: ${matches.length} matches, active=${active?.url ?? 'none'}`,
    );
  }, page.url());
}

/**
 * 读取 Background 对该 tab 的面板投影（在扩展隔离世界中执行，sender 带真实
 * tab）。它与面板是否已经渲染无关，因此「未匹配环境」不依赖空状态的出现
 * 顺序，避免把「还没加载完」误判成「没有账号」。
 */
async function readPanelProjection(
  worker: Worker,
  tabId: number,
): Promise<PanelProjection> {
  const projection = await worker.evaluate(async (id) => {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: id },
      func: () => chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_PANEL' }),
    });
    return injection?.result as unknown;
  }, tabId);
  const candidate = projection as {
    matchedEnvKey?: unknown;
    accounts?: unknown;
    domains?: unknown;
  } | null;
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    typeof candidate.matchedEnvKey !== 'string' ||
    !Array.isArray(candidate.accounts) ||
    typeof candidate.domains !== 'object' ||
    candidate.domains === null
  ) {
    throw new Error('background did not return account panel data');
  }
  return projection as PanelProjection;
}

async function dismissToasts(page: Page): Promise<void> {
  const toasts = page.locator(TOAST_ITEM);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if ((await toasts.count()) === 0) return;
    await toasts
      .first()
      .locator('.toast-close')
      .click({ timeout: 1_000 })
      .catch(() => undefined);
  }
  await expect(toasts).toHaveCount(0, { timeout: 10_000 });
}

/**
 * 打开账号切换浮动面板（幂等）。
 *
 * 不重复发送 toggle：先按页面完整 URL 在扩展内确认唯一 tabId，再向该 tab
 * 发送 `OPEN_ACCOUNT_SWITCHER`，最后等待面板完成配置加载。
 */
export async function openSwitcher(
  page: Page,
  worker: Worker,
): Promise<void> {
  const panel = page.locator(PANEL_HOST);
  if ((await panel.count()) > 0 && (await panel.first().isVisible())) {
    await expect(panel.locator(PANEL_ROOT)).toBeVisible();
    return;
  }

  await page.bringToFront();
  const tabId = await tabIdFor(page, worker);
  const response = await worker.evaluate(async (id) => {
    const result = (await chrome.tabs.sendMessage(id, {
      type: 'OPEN_ACCOUNT_SWITCHER',
    })) as { success?: boolean } | undefined;
    return result;
  }, tabId);
  if (!response?.success) {
    throw new Error('content script did not open the account switcher');
  }

  await expect(panel.locator(PANEL_ROOT)).toBeVisible();

  const projection = await readPanelProjection(worker, tabId);
  // 用页面实时 URL + 配置摘要推导当前应命中的环境名。不能用
  // `projection.matchedEnvKey`：程序化注入消息的 sender.url 可能仍停留在
  // pushState 之前的地址，而面板自身读的是实时 location。
  const expectedName = pickEnvironment(page.url(), projection.domains)?.env.name;
  if (expectedName) {
    // 命中环境时，环境名只在 `loadConfig` 完成后才出现，可作为加载完成信号。
    await expect(panel.locator('.as-tab-env-label')).toHaveText(expectedName);
    await expect(panel.locator('.as-tab-btn').first()).toBeVisible();
  } else {
    await expect(panel.locator('.as-tab-env-label')).toHaveText('未配置环境');
  }
}

/**
 * 触发一次账号切换/登录；成功或失败由调用方用 expectAccountSuccess /
 * expectAccountFailure 等待。这里只负责清理旧 Toast 并点击真实账号卡。
 */
export async function runAccount(
  page: Page,
  worker: Worker,
  accountName: string,
): Promise<void> {
  await dismissToasts(page);
  await openSwitcher(page, worker);
  const card = accountCard(page, accountName);
  await expect(card, `account card "${accountName}" should be unique`).toHaveCount(
    1,
  );
  await card.click();
}

/**
 * 等待本次执行成功结束：成功时面板关闭（导航时面板随文档消失），
 * 并等待切换尾部刷新提交完成——否则紧接着的 page.evaluate 会撞上导航。
 */
export async function expectAccountSuccess(page: Page): Promise<void> {
  await expect(page.locator(PANEL_HOST)).toHaveCount(0, {
    timeout: LOGIN_TIMEOUT,
  });
  await waitForDocumentSettled(page);
}

let navigationProbe = 0;

async function documentIdentity(page: Page): Promise<string> {
  try {
    return await page.evaluate(
      () => `${performance.timeOrigin}|${location.href}`,
    );
  } catch {
    // 导航中执行上下文会被销毁：每次轮询都视为尚未稳定的新身份。
    navigationProbe += 1;
    return `navigating:${navigationProbe}`;
  }
}

/**
 * 等待登录成功后的尾随整页刷新提交完成。
 *
 * `refreshAfterSwitch` 在成功响应后对执行页发起同 URL reload；面板可能先
 * 于导航提交关闭。此时若立刻在旧文档上开面板，随后的导航会把面板连同正在
 * 点击的账号卡一起销毁。这里轮询文档身份，直到连续一个稳定窗口不再变化；
 * 超时仍未稳定说明登录尾部没有落到可交互页面，直接失败而不是静默放行。
 */
async function waitForDocumentSettled(page: Page): Promise<void> {
  const deadline = Date.now() + DOCUMENT_SETTLE_TIMEOUT;
  let previous = await documentIdentity(page);
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    if (page.isClosed()) {
      throw new Error('page closed while waiting for navigation to settle');
    }
    await page.waitForTimeout(DOCUMENT_POLL_MS);
    const current = await documentIdentity(page);
    if (current !== previous) {
      previous = current;
      stableSince = Date.now();
      continue;
    }
    if (Date.now() - stableSince >= DOCUMENT_SETTLE_MS) return;
  }
  throw new Error(
    `page did not settle after login within ${DOCUMENT_SETTLE_TIMEOUT}ms`,
  );
}

/** 等待失败 Toast，并确认面板仍在、账号卡恢复可点击。 */
export async function expectAccountFailure(
  page: Page,
  message: string | RegExp,
): Promise<void> {
  const toast = page.locator(TOAST_ITEM).filter({ hasText: message });
  await expect(toast).toBeVisible({ timeout: LOGIN_TIMEOUT });
  await expect(page.locator(PANEL_HOST).locator(PANEL_ROOT)).toBeVisible();
  // 本次执行的卡片也在其中：没有任何卡片仍处于禁用态才算恢复可点击。
  await expect(
    page.locator(`${PANEL_HOST} ${ACCOUNT_CARD}[disabled]`),
  ).toHaveCount(0);
}

/** 触发并等待成功与目标路径（默认 /console）。 */
export async function loginViaPanel(
  page: Page,
  worker: Worker,
  accountName: string,
  path = '/console',
): Promise<void> {
  await runAccount(page, worker, accountName);
  await expectAccountSuccess(page);
  await page.waitForURL((url) => url.pathname === path, {
    timeout: LOGIN_TIMEOUT,
  });
  await waitForDocumentSettled(page);
}

/**
 * 切换账号后的成功契约与 loginViaPanel 相同，但不以 URL 判断完成：
 * 同 URL 刷新（reload）时 URL 不变，调用方必须自行断言最终身份。
 */
export async function switchTo(
  page: Page,
  worker: Worker,
  accountName: string,
): Promise<void> {
  await runAccount(page, worker, accountName);
  await expectAccountSuccess(page);
  await waitForDocumentSettled(page);
}

/** 读取 Shadow Host 的文本内容（面板与角标都在 open shadow root 内）。 */
export async function shadowText(
  page: Page,
  selector: string,
): Promise<string> {
  return page.evaluate((target) => {
    const host = document.querySelector(target);
    return host?.shadowRoot?.textContent ?? '';
  }, selector);
}

/** 等待环境角标出现并显示指定环境名；SPA 路由变更后的角标更新也走这里。 */
export async function expectEnvBadge(page: Page, name: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((selector) => {
          const host = document.querySelector(selector);
          return host?.shadowRoot?.querySelector('.label')?.textContent ?? '';
        }, ENV_BADGE_HOST),
      { timeout: LOGIN_TIMEOUT },
    )
    .toBe(name);
}

/**
 * 关闭已打开的面板。面板只在挂载时读取一次页面 URL，SPA 路由变化后必须
 * 关闭再打开，才能观察当前路由对应的环境与账号过滤。
 */
export async function closeSwitcher(page: Page): Promise<void> {
  const panel = page.locator(PANEL_HOST);
  if ((await panel.count()) === 0) return;
  await page.bringToFront();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
}

/**
 * 命中环境的证据：背景投影的环境名与面板渲染一致，且账号卡正好是当前
 * 环境作用域内的账号（未绑定账号不得混入）。
 */
export async function expectMatchedEnvironment(
  page: Page,
  worker: Worker,
  envName: string,
  accountNames: string[],
): Promise<void> {
  await openSwitcher(page, worker);
  const panel = page.locator(PANEL_HOST);
  await expect(panel.locator('.as-tab-env-label')).toHaveText(envName);
  await expect(panel.locator(ACCOUNT_CARD)).toHaveCount(accountNames.length);
  for (const name of accountNames) {
    await expect(accountCard(page, name)).toHaveCount(1);
  }
}

/** 打开面板并切到快捷登录 Tab；纯账号场景下该 Tab 也会自动可见。 */
export async function openQuickLogin(
  page: Page,
  worker: Worker,
): Promise<void> {
  await openSwitcher(page, worker);
  const panel = page.locator(PANEL_HOST);
  await panel
    .locator('.as-tab-btn')
    .filter({ hasText: '快捷登录' })
    .click();
  await expect(panel.locator('.as-ql-input')).toBeVisible();
}

/** 在面板快捷登录 Tab 粘贴文本并提交，结果由调用方等待。 */
export async function submitQuickLogin(
  page: Page,
  worker: Worker,
  text: string,
  options: { debugRedirect?: boolean } = {},
): Promise<void> {
  await openQuickLogin(page, worker);
  const panel = page.locator(PANEL_HOST);
  await panel.locator('.as-ql-input').fill(text);
  if (options.debugRedirect) {
    const toggle = panel.getByRole('switch', { name: '登录后进入 Bug 页' });
    await expect(toggle).toBeVisible();
    // 环境可默认开启该开关；只在未开启时点击，避免把它关掉。
    if ((await toggle.getAttribute('aria-checked')) !== 'true') {
      await toggle.click();
    }
  }
  await panel.getByRole('button', { name: '登录并跳转' }).click();
}

/** 页面认证存储快照：只保留认证相关键，用于证明越域/失败未写入。 */
export async function authStorage(page: Page): Promise<{
  local: Record<string, string | null>;
  session: Record<string, string | null>;
}> {
  return page.evaluate((keys) => {
    const pick = (store: Storage) =>
      Object.fromEntries(keys.map((key) => [key, store.getItem(key)]));
    return {
      local: pick(window.localStorage),
      session: pick(window.sessionStorage),
    };
  }, AUTH_STORAGE_KEYS);
}

/** 断言 origin 与页面存储均无认证残留。 */
export async function expectNoAuthentication(
  page: Page,
  origin: string,
): Promise<void> {
  const cookies = await page.context().cookies(origin);
  expect(
    cookies.filter((cookie) => cookie.name === SESSION_COOKIE),
  ).toEqual([]);
  const storage = await authStorage(page);
  expect(Object.values(storage.local).filter(Boolean)).toEqual([]);
  expect(Object.values(storage.session).filter(Boolean)).toEqual([]);
}

export class LoginPage {
  constructor(private readonly page: Page) {}

  async goto(baseUrl: string, path = '/login'): Promise<void> {
    await this.page.goto(new URL(path, baseUrl).toString());
  }

  async expectError(text: string | RegExp): Promise<void> {
    const error = this.page.locator('#login-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText(text);
  }
}

export class ConsolePage {
  constructor(private readonly page: Page) {}

  async expectIdentity(identity: AccountIdentity): Promise<void> {
    await expect(this.page.locator('body')).toHaveAttribute(
      'data-current-role',
      identity.role,
    );
    await expect(this.page.locator('#identity-name')).toHaveText(identity.name);
    await expect(this.page.locator('#identity-email')).toHaveText(
      identity.email,
    );
    await expect(this.page.locator('#identity-title')).toHaveText(
      identity.title,
    );
    await expect(this.page.locator('#identity-scope')).toHaveText(
      identity.scope,
    );
  }

  /**
   * 未命中环境的完整证据：面板确实打开了、显示未匹配、没有绑定账号卡，
   * 页面无角标、无认证 Cookie/Storage，fixture server 也没有登录请求。
   */
  async expectUnmatchedEnvironment(
    worker: Worker,
    fixtureServer: FixtureServer,
  ): Promise<void> {
    await openSwitcher(this.page, worker);

    // 直接断言 Background 投影：即使面板尚未完成首次渲染，也不会把
    // 「加载中」的空状态误当成「未匹配」。
    const projection = await readPanelProjection(
      worker,
      await tabIdFor(this.page, worker),
    );
    expect(projection.matchedEnvKey).toBe('');
    expect(projection.accounts).toEqual([]);

    const panel = this.page.locator(PANEL_HOST);
    await expect(panel.locator('.as-tab-env-label')).toHaveText('未配置环境');
    await expect(panel.locator(ACCOUNT_CARD)).toHaveCount(0);
    await expect(this.page.locator(ENV_BADGE_HOST)).toHaveCount(0);

    const cookies = await this.page.context().cookies(this.page.url());
    expect(
      cookies.some((cookie) => cookie.name === SESSION_COOKIE),
    ).toBe(false);

    const storage = await this.page.evaluate(() => ({
      local: Object.keys(window.localStorage),
      session: Object.keys(window.sessionStorage),
    }));
    const authKeys = [...storage.local, ...storage.session].filter((key) =>
      AUTH_STORAGE_KEYS.includes(key),
    );
    expect(authKeys).toEqual([]);

    expect(
      fixtureServer.requests.filter((request) =>
        request.path.includes('/api/session/login'),
      ),
    ).toEqual([]);
  }
}

export class OptionsPage {
  constructor(private readonly page: Page) {}

  async expectEnvironment(name: string): Promise<void> {
    await expect(this.page.getByText(name, { exact: true }).first()).toBeVisible();
  }

  async expectAccount(name: string): Promise<void> {
    await expect(this.page.getByText(name, { exact: true }).first()).toBeVisible();
  }

  /** 从账号行「⋯ → 登录」发起已保存账号登录，返回后台新建的目标页。 */
  async loginSavedAccount(name: string): Promise<Page> {
    await this.expectAccount(name);
    const row = this.page.locator('tr').filter({ hasText: name });
    await expect(row).toHaveCount(1);
    const newPage = this.page.context().waitForEvent('page');
    await row
      .getByRole('button', { name: `账号「${name}」的其他操作` })
      .click();
    await this.page.getByRole('menuitem', { name: '登录', exact: true }).click();
    return newPage;
  }
}
