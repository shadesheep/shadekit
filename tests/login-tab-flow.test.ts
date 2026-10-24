/**
 * login-tab-flow: quick-login 编排收口（ADR-0003 D4）
 *
 * - parseDebugRedirect / resolvePostLoginUrl：URL 推导规则的纯函数单测
 * - injectAndNavigate：「注入登录态失败必须关闭新建 tab 回滚、
 *   绝不静默导航成假登录」不变量的归属测试
 * - setupAuthTab：create-at-url + injectAuth + reload 的行为固定；
 *   复用 tab 时同 URL 不导航、刷新后激活（ADR-0012 D18）
 *
 * 注：会话清理与写入已由 spec 的 `clear.*` / `auth.write` 算子承担，
 * 本模块只负责「目标 origin 文档内恢复快照 + 显式注入 token + 刷新/激活」。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const restoreAuthMock = vi.fn().mockResolvedValue(undefined);
const reloadTabAndWaitMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../entrypoints/tools/account-switch/utils/tab-load', () => ({
  waitForTabLoaded: vi.fn().mockResolvedValue(undefined),
  reloadTabAndWait: (...args: unknown[]) => reloadTabAndWaitMock(...args),
}));

vi.mock('../entrypoints/tools/account-switch/utils/auth-snapshot', () => ({
  restoreAuth: (...args: unknown[]) => restoreAuthMock(...args),
}));

const tabsMock = {
  create: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  reload: vi.fn(),
  remove: vi.fn(),
};
vi.stubGlobal('chrome', { tabs: tabsMock });

import {
  parseDebugRedirect,
  resolvePostLoginUrl,
  setupAuthTab,
  injectAndNavigate,
} from '../entrypoints/tools/account-switch/login-tab-flow';
import type { TokenData } from '../entrypoints/tools/account-switch/types';
import { ErrorCodes } from '../entrypoints/tools/account-switch/utils/error-codes';

const REDIRECT = {
  origin: 'http://localhost:8888',
  hashPath: '/p/x',
  fullUrl: 'http://localhost:8888/p/x',
};

function buildInject(): (tabId: number, tokenData: TokenData) => Promise<void> {
  return vi.fn().mockResolvedValue(undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  tabsMock.create.mockResolvedValue({ id: 99 });
  tabsMock.get.mockResolvedValue({ id: 42, url: 'http://a.com/home', status: 'complete' });
  tabsMock.update.mockResolvedValue(undefined);
  tabsMock.reload.mockResolvedValue(undefined);
  tabsMock.remove.mockResolvedValue(undefined);
  restoreAuthMock.mockResolvedValue(undefined);
  reloadTabAndWaitMock.mockResolvedValue(undefined);
});

describe('parseDebugRedirect', () => {
  it('非法 debugRedirect URL → null', () => {
    expect(
      parseDebugRedirect('not a url', new URL('http://a.com/x')),
    ).toBeNull();
  });

  it('hash 路径无前导斜杠时补 /', () => {
    const r = parseDebugRedirect('http://localhost:8888', {
      pathname: 'develop',
      search: '',
      hash: '',
    });
    expect(r).toEqual({
      origin: 'http://localhost:8888',
      hashPath: '/develop',
      fullUrl: 'http://localhost:8888/develop',
    });
  });

  it('保留 targetUrl 的 query 与 hash，debugRedirect 只取 origin', () => {
    const r = parseDebugRedirect(
      'http://localhost:8888/base?ignored=1',
      new URL('http://a.com/p/x?y=1#/h?z=2'),
    );
    expect(r).toEqual({
      origin: 'http://localhost:8888',
      hashPath: '/p/x?y=1#/h?z=2',
      fullUrl: 'http://localhost:8888/p/x?y=1#/h?z=2',
    });
  });
});

describe('resolvePostLoginUrl', () => {
  it('hasUrl 为 true → 直接使用 targetUrl', () => {
    expect(
      resolvePostLoginUrl({
        hasUrl: true,
        targetUrl: 'http://a.com/deep/page',
        origin: 'http://a.com',
      }),
    ).toBe('http://a.com/deep/page');
  });

  it('hasUrl 为 false → 回退 origin（ADR-0015 D12）', () => {
    expect(
      resolvePostLoginUrl({
        hasUrl: false,
        targetUrl: '',
        origin: 'http://a.com',
      }),
    ).toBe('http://a.com');
  });
});

describe('setupAuthTab', () => {
  it('建 tab → 等待加载 → 注入认证 → 刷新', async () => {
    const injectAuth = buildInject();

    const id = await setupAuthTab(
      injectAuth,
      'http://a.com',
      'http://a.com/home',
      { token: 't' },
    );

    expect(id).toBe(99);
    expect(tabsMock.create).toHaveBeenCalledWith({
      url: 'http://a.com/home',
      active: true,
    });
    expect(injectAuth).toHaveBeenCalledWith(99, { token: 't' });
    expect(tabsMock.reload).toHaveBeenCalledWith(99);
  });

  it('复用已有 tab 且地址相同（D18）：不导航、写入后刷新再激活', async () => {
    const calls: string[] = [];
    const injectAuth = vi.fn().mockImplementation(async () => {
      calls.push('inject');
    });
    reloadTabAndWaitMock.mockImplementation(async () => {
      calls.push('reload');
    });
    tabsMock.update.mockImplementation(async (_tabId, props) => {
      calls.push(props?.url ? 'navigate' : 'activate');
    });

    const id = await setupAuthTab(
      injectAuth,
      'http://a.com',
      'http://a.com/home',
      { token: 't' },
      { execTab: { tabId: 42 } },
    );

    expect(id).toBe(42);
    expect(tabsMock.create).not.toHaveBeenCalled();
    // 同 URL 不触发整页导航（白屏根因），只在最后激活一次
    expect(tabsMock.update).toHaveBeenCalledTimes(1);
    expect(tabsMock.update).toHaveBeenCalledWith(42, { active: true });
    expect(reloadTabAndWaitMock).toHaveBeenCalledWith(42, expect.any(Number));
    // 注入在刷新之前；刷新在激活之前完成
    expect(calls).toEqual(['inject', 'reload', 'activate']);
  });

  it('复用已有 tab 但地址不同（debugRedirect 换站）：先导航，再写入', async () => {
    const calls: string[] = [];
    const injectAuth = vi.fn().mockImplementation(async () => {
      calls.push('inject');
    });
    tabsMock.get.mockResolvedValue({
      id: 42,
      url: 'http://a.com/login',
      status: 'complete',
    });
    tabsMock.update.mockImplementation(async (_tabId, props) => {
      calls.push(props?.url ? 'navigate' : 'activate');
    });
    reloadTabAndWaitMock.mockImplementation(async () => {
      calls.push('reload');
    });

    await setupAuthTab(
      injectAuth,
      'http://a.com',
      'http://a.com/home',
      { token: 't' },
      { execTab: { tabId: 42 } },
    );

    expect(tabsMock.update).toHaveBeenCalledWith(42, { url: 'http://a.com/home' });
    expect(calls).toEqual(['navigate', 'inject', 'reload', 'activate']);
  });

  it('tab 不存在时按「地址不同」降级：走导航而不是直接写', async () => {
    tabsMock.get.mockRejectedValue(new Error('No tab with id: 42'));

    await setupAuthTab(
      buildInject(),
      'http://a.com',
      'http://a.com/home',
      { token: 't' },
      { execTab: { tabId: 42 } },
    );

    expect(tabsMock.update).toHaveBeenCalledWith(42, { url: 'http://a.com/home' });
  });

  it('刷新等待超时不判失败：仍然激活（页面慢不该把登录判死）', async () => {
    const { LoginError } = await import(
      '../entrypoints/tools/account-switch/utils/error-codes'
    );
    reloadTabAndWaitMock.mockRejectedValue(
      new LoginError(ErrorCodes.TAB_LOAD_TIMEOUT, '页面加载超时'),
    );

    await expect(
      setupAuthTab(
        buildInject(),
        'http://a.com',
        'http://a.com/home',
        { token: 't' },
        { execTab: { tabId: 42 } },
      ),
    ).resolves.toBe(42);
    expect(tabsMock.update).toHaveBeenCalledWith(42, { active: true });
  });

  it('刷新期间 tab 被关闭：向上抛 TAB_CLOSED', async () => {
    const { LoginError } = await import(
      '../entrypoints/tools/account-switch/utils/error-codes'
    );
    reloadTabAndWaitMock.mockRejectedValue(
      new LoginError(ErrorCodes.TAB_CLOSED, '页面已关闭，登录中断'),
    );

    await expect(
      setupAuthTab(
        buildInject(),
        'http://a.com',
        'http://a.com/home',
        { token: 't' },
        { execTab: { tabId: 42 } },
      ),
    ).rejects.toThrow('页面已关闭');
  });

  it('快照模式（D7）：在目标 origin 文档内恢复，顺序为 restore → inject → reload', async () => {
    const calls: string[] = [];
    const spec = { mode: 'snapshot' as const, cookies: ['auth'] };
    const snapshot = { cookies: [] };
    const injectAuth = vi.fn().mockImplementation(async () => {
      calls.push('inject');
    });
    reloadTabAndWaitMock.mockImplementation(async () => {
      calls.push('reload');
    });
    restoreAuthMock.mockImplementation(async () => {
      calls.push('restore');
    });

    await setupAuthTab(
      injectAuth,
      'http://a.com',
      'http://a.com/home',
      { token: 't' },
      { execTab: { tabId: 42 }, capturedAuth: { spec, snapshot } },
    );

    expect(restoreAuthMock).toHaveBeenCalledWith(
      'http://a.com',
      42,
      spec,
      snapshot,
    );
    // 快照先恢复，再注入 token；两者都在刷新之前
    expect(calls).toEqual(['restore', 'inject', 'reload']);
  });
});

describe('injectAndNavigate', () => {
  it('redirect 模式：建 tab → 注入 → 导航到 fullUrl', async () => {
    const injectAuth = buildInject();
    const result = await injectAndNavigate({
      injectAuth,
      tokenData: { token: 't' },
      currentTabId: 1,
      redirect: REDIRECT,
      targetUrl: 'http://a.com/p/x',
      hasUrl: true,
    });

    expect(result).toEqual({ success: true });
    expect(tabsMock.create).toHaveBeenCalledWith({
      url: REDIRECT.origin,
      active: true,
    });
    expect(injectAuth).toHaveBeenCalledWith(99, { token: 't' });
    expect(tabsMock.update).toHaveBeenCalledWith(99, { url: REDIRECT.fullUrl });
    // 不触碰来源 tab
    expect(tabsMock.reload).not.toHaveBeenCalled();
  });

  it('快照模式：在注入目标 tab 上恢复捕获的认证态', async () => {
    const injectAuth = buildInject();
    const spec = { mode: 'snapshot' as const, cookies: ['auth'] };
    const snapshot = { cookies: [] };

    const result = await injectAndNavigate({
      injectAuth,
      tokenData: { token: 't' },
      currentTabId: 1,
      redirect: REDIRECT,
      targetUrl: 'http://a.com/p/x',
      hasUrl: true,
      capturedAuth: { spec, snapshot },
      capturedAuthOrigin: REDIRECT.origin,
    });

    expect(result).toEqual({ success: true });
    expect(restoreAuthMock).toHaveBeenCalledWith(
      REDIRECT.origin,
      99,
      spec,
      snapshot,
    );
  });

  it('快照恢复失败（origin 不符）→ 与注入失败同一回滚路径', async () => {
    const injectAuth = buildInject();
    restoreAuthMock.mockRejectedValue(new Error('页面不在目标站点'));

    const result = await injectAndNavigate({
      injectAuth,
      tokenData: { token: 't' },
      currentTabId: 1,
      redirect: REDIRECT,
      targetUrl: 'http://a.com/p/x',
      hasUrl: true,
      capturedAuth: {
        spec: { mode: 'snapshot', localStorage: 'all' },
        snapshot: { cookies: [], localStorage: { token: 't' } },
      },
      capturedAuthOrigin: 'https://other.example.com',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe(ErrorCodes.INJECT_AUTH_FAILED);
      expect(result.error).toContain('页面不在目标站点');
    }
    expect(tabsMock.remove).toHaveBeenCalledWith(99);
    expect(tabsMock.update).not.toHaveBeenCalled();
  });

  it('注入失败 → 关闭新建 tab 回滚 → 返回 INJECT_AUTH_FAILED，绝不导航', async () => {
    const injectAuth = vi.fn().mockRejectedValue(new Error('CSP 阻止'));
    const result = await injectAndNavigate({
      injectAuth,
      tokenData: { token: 't' },
      currentTabId: 1,
      redirect: REDIRECT,
      targetUrl: 'http://a.com/p/x',
      hasUrl: true,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe(ErrorCodes.INJECT_AUTH_FAILED);
      expect(result.error).toContain('CSP 阻止');
    }
    expect(tabsMock.remove).toHaveBeenCalledWith(99);
    // 绝不静默导航成假登录
    expect(tabsMock.update).not.toHaveBeenCalled();
    expect(tabsMock.reload).not.toHaveBeenCalled();
  });

  it('当前 tab 注入失败：无新建 tab 可关，仅返回失败', async () => {
    const injectAuth = vi.fn().mockRejectedValue(new Error('boom'));
    const result = await injectAndNavigate({
      injectAuth,
      tokenData: { token: 't' },
      currentTabId: 1,
      redirect: null,
      targetUrl: 'http://a.com/p',
      hasUrl: true,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe(ErrorCodes.INJECT_AUTH_FAILED);
    }
    expect(tabsMock.remove).not.toHaveBeenCalled();
    expect(tabsMock.update).not.toHaveBeenCalled();
  });

  it('无 redirect 且 hasUrl：当前 tab 注入后导航到 targetUrl', async () => {
    const injectAuth = buildInject();
    const result = await injectAndNavigate({
      injectAuth,
      tokenData: { token: 't' },
      currentTabId: 1,
      redirect: null,
      targetUrl: 'http://a.com/p',
      hasUrl: true,
    });

    expect(result).toEqual({ success: true });
    expect(injectAuth).toHaveBeenCalledWith(1, { token: 't' });
    expect(tabsMock.update).toHaveBeenCalledWith(1, {
      url: 'http://a.com/p',
    });
  });

  it('无 redirect 且无 hasUrl：当前 tab 注入后刷新', async () => {
    const injectAuth = buildInject();
    const result = await injectAndNavigate({
      injectAuth,
      tokenData: { token: 't' },
      currentTabId: 1,
      redirect: null,
      targetUrl: '',
      hasUrl: false,
    });

    expect(result).toEqual({ success: true });
    expect(tabsMock.reload).toHaveBeenCalledWith(1);
    expect(tabsMock.update).not.toHaveBeenCalled();
  });

  it('onBeforeNavigate 在注入之后、导航之前调用（导航抛错时日志已落盘）', async () => {
    const calls: string[] = [];
    const injectAuth = vi.fn().mockImplementation(async () => {
      calls.push('inject');
    });
    tabsMock.update.mockImplementation(async () => {
      calls.push('navigate');
    });

    const result = await injectAndNavigate({
      injectAuth,
      tokenData: { token: 't' },
      currentTabId: 1,
      redirect: REDIRECT,
      targetUrl: 'http://a.com/p/x',
      hasUrl: true,
      onBeforeNavigate: async () => {
        calls.push('log');
      },
    });

    expect(result).toEqual({ success: true });
    expect(calls).toEqual(['inject', 'log', 'navigate']);
  });

  it('fallbackIntent：仅 hasUrl === false 时生效（无明确目标 URL）', async () => {
    const injectAuth = buildInject();
    const result = await injectAndNavigate({
      injectAuth,
      tokenData: { token: 't' },
      currentTabId: 1,
      redirect: null,
      targetUrl: '',
      hasUrl: false,
      fallbackIntent: { action: 'navigate', url: 'http://a.com/redirected' },
    });

    expect(result).toEqual({ success: true });
    expect(tabsMock.update).toHaveBeenCalledWith(1, {
      url: 'http://a.com/redirected',
    });
    expect(tabsMock.reload).not.toHaveBeenCalled();
  });

  it('fallbackIntent：hasUrl === true 时 targetUrl 优先', async () => {
    const injectAuth = buildInject();
    await injectAndNavigate({
      injectAuth,
      tokenData: { token: 't' },
      currentTabId: 1,
      redirect: null,
      targetUrl: 'http://a.com/explicit',
      hasUrl: true,
      fallbackIntent: { action: 'navigate', url: 'http://a.com/redirected' },
    });

    expect(tabsMock.update).toHaveBeenCalledWith(1, {
      url: 'http://a.com/explicit',
    });
  });

  it('fallbackIntent 为 reload：无明确目标时刷新（旧 API 登录 ?redirect= 缺失场景回归）', async () => {
    const injectAuth = buildInject();
    await injectAndNavigate({
      injectAuth,
      tokenData: { token: 't' },
      currentTabId: 1,
      redirect: null,
      targetUrl: '',
      hasUrl: false,
      fallbackIntent: { action: 'reload' },
    });

    expect(tabsMock.reload).toHaveBeenCalledWith(1);
  });

  it('无 tokenData：不建 tab、不注入、不导航', async () => {
    const injectAuth = buildInject();
    const result = await injectAndNavigate({
      injectAuth,
      tokenData: undefined,
      currentTabId: 1,
      redirect: REDIRECT,
      targetUrl: 'http://a.com/p',
      hasUrl: true,
    });

    expect(result).toEqual({ success: true });
    expect(tabsMock.create).not.toHaveBeenCalled();
    expect(injectAuth).not.toHaveBeenCalled();
    expect(tabsMock.update).not.toHaveBeenCalled();
  });
});
