import type { Page, Worker } from '@playwright/test';
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
  domains: Record<string, { name: string }>;
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
    const tab = matches[0];
    if (matches.length !== 1 || !tab || tab.id === undefined) {
      throw new Error(
        `expected exactly one tab for ${url}, found ${matches.length}`,
      );
    }
    return tab.id;
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
  const matchedName = projection.matchedEnvKey
    ? projection.domains[projection.matchedEnvKey]?.name
    : undefined;
  if (matchedName) {
    // 命中环境时，环境名只在 `loadConfig` 完成后才出现，可作为加载完成信号。
    await expect(panel.locator('.as-tab-env-label')).toHaveText(matchedName);
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

/** 等待本次执行成功结束：成功时面板关闭（导航时面板随文档消失）。 */
export async function expectAccountSuccess(page: Page): Promise<void> {
  await expect(page.locator(PANEL_HOST)).toHaveCount(0, {
    timeout: LOGIN_TIMEOUT,
  });
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
}
