/**
 * login-session prepareLogin — 登录 prelude 不变量（ADR-0004 D2 / ADR-0012 D9）
 * 锁互斥 / 配置缺失 / URL 非法 / 环境未匹配 / 未配置策略 / debugRedirect 非法 / 成功路径字段
 * execTarget：existing / new 两态、建 tab 失败、执行 tab 缺失、失败回滚关 tab
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const storageGetMock = vi.fn();
const tabsCreateMock = vi.fn();
const tabsGetMock = vi.fn();
const tabsRemoveMock = vi.fn();

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: (...args: unknown[]) => storageGetMock(...args),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  },
  tabs: {
    create: (...args: unknown[]) => tabsCreateMock(...args),
    get: (...args: unknown[]) => tabsGetMock(...args),
    remove: (...args: unknown[]) => tabsRemoveMock(...args),
    onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
  },
});

import {
  isLoginLocked,
  prepareLogin,
  releaseLoginLock,
  tryAcquireLoginLock,
  type PrepareLoginInput,
} from '../entrypoints/tools/account-switch/login-session';
import { ErrorCodes, LOGIN_BUSY_ERROR } from '../entrypoints/tools/account-switch/utils/error-codes';
import {
  DEFAULT_AUTH,
  LOGIN_SPEC_VERSION,
  type LoginSpec,
} from '../entrypoints/tools/account-switch/spec/types';

/** 最小可执行 spec（v2）：断言 prelude 只负责读出声明，不关心其内容 */
function stubSpec(): LoginSpec {
  return {
    version: LOGIN_SPEC_VERSION,
    template: 'test',
    ops: [],
    success: [],
    auth: DEFAULT_AUTH,
  };
}

function storageWith(config: unknown) {
  storageGetMock.mockImplementation(async (keys: string[]) => {
    if (keys.includes('devtools-account-switch')) {
      return { 'devtools-account-switch': config };
    }
    return {};
  });
}

const CONFIG = {
  domains: {
    'http://example.com': {
      name: '测试环境',
      loginMethod: 'generic',
      strategyConfig: { spec: stubSpec() },
    },
  },
};

function baseInput(overrides: Partial<PrepareLoginInput> = {}): PrepareLoginInput {
  return {
    action: 'QUICK_LOGIN',
    account: { name: 'user1', username: 'user1' },
    credentials: { username: 'user1', password: 'pass1' },
    target: 'http://example.com/page',
    targetKind: 'url',
    execTarget: { kind: 'existing', tabId: 1 },
    ...overrides,
  };
}

describe('prepareLogin — prelude 不变量', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tabsCreateMock.mockResolvedValue({ id: 42 });
    tabsGetMock.mockResolvedValue({
      id: 42,
      status: 'complete',
      url: 'http://example.com/page',
    });
    tabsRemoveMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    releaseLoginLock(1);
    releaseLoginLock(42);
  });

  it('锁占用时直接拒绝（LOGIN_BUSY），不形成会话', async () => {
    storageWith(CONFIG);
    tryAcquireLoginLock(1);
    const outcome = await prepareLogin(baseInput());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe(LOGIN_BUSY_ERROR);
      expect(outcome.errorCode).toBe(ErrorCodes.LOGIN_BUSY);
    }
  });

  it('存储中无配置 → CONFIG_NOT_FOUND，且锁已释放', async () => {
    storageWith(undefined);
    const outcome = await prepareLogin(baseInput());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errorCode).toBe(ErrorCodes.CONFIG_NOT_FOUND);
    expect(isLoginLocked(1)).toBe(false);
  });

  it('targetKind=url 且 URL 非法 → INVALID_URL', async () => {
    storageWith(CONFIG);
    const outcome = await prepareLogin(baseInput({ target: 'not-a-url' }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errorCode).toBe(ErrorCodes.INVALID_URL);
  });

  it('域名无匹配环境 → ENV_NOT_MATCHED', async () => {
    storageWith(CONFIG);
    const outcome = await prepareLogin(
      baseInput({ target: 'http://other.com/page' }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errorCode).toBe(ErrorCodes.ENV_NOT_MATCHED);
  });

  it('loginMethod 缺失且无策略参数 → NO_STRATEGY（显式报错，不隐式回退）', async () => {
    storageWith({
      domains: { 'http://example.com': { name: 'x' } },
    });
    const outcome = await prepareLogin(baseInput());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errorCode).toBe(ErrorCodes.NO_STRATEGY);
  });

  it('扩展策略 key 查不到 → STRATEGY_NOT_FOUND 且文案指明「已随插件市场移除」', async () => {
    storageWith({
      domains: {
        'http://example.com': {
          name: 'x',
          loginMethod: 'acme@uninstalled-ext',
        },
      },
    });
    const outcome = await prepareLogin(baseInput());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorCode).toBe(ErrorCodes.STRATEGY_NOT_FOUND);
      expect(outcome.error).toContain('该扩展已随插件市场移除');
    }
  });

  it('debugRedirect 非法 → INVALID_REDIRECT_URL', async () => {
    storageWith(CONFIG);
    const outcome = await prepareLogin(
      baseInput({ debugRedirect: 'not-a-url' }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok)
      expect(outcome.errorCode).toBe(ErrorCodes.INVALID_REDIRECT_URL);
  });

  it('成功路径：ctx/strategy/redirect 字段齐备，release 后锁释放', async () => {
    storageWith(CONFIG);
    const outcome = await prepareLogin(
      baseInput({ debugRedirect: 'http://localhost:8888' }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const { prepared } = outcome;
    // debugRedirect origin 优先生效
    expect(prepared.origin).toBe('http://localhost:8888');
    expect(prepared.ctx.origin).toBe('http://localhost:8888');
    expect(prepared.redirect?.fullUrl).toBe('http://localhost:8888/page');
    expect(prepared.spec).toEqual(stubSpec());
    expect(prepared.ctx.debugBuffer).toBe(prepared.session.buffer);
    expect(isLoginLocked(1)).toBe(true);
    prepared.release();
    expect(isLoginLocked(1)).toBe(false);
  });

  it('targetKind=origin（switch 路径）：不做 URL 解析，origin 原样使用', async () => {
    storageWith(CONFIG);
    const outcome = await prepareLogin(
      baseInput({
        target: 'http://example.com',
        targetKind: 'origin',
        debugRedirect: 'http://localhost:8888', // origin 路径忽略 redirect
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.prepared.origin).toBe('http://example.com');
    expect(outcome.prepared.redirect).toBeNull();
    outcome.prepared.release();
  });
});

describe('prepareLogin — execTarget（ADR-0012 D9）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tabsCreateMock.mockResolvedValue({ id: 42 });
    tabsGetMock.mockResolvedValue({
      id: 42,
      status: 'complete',
      url: 'http://example.com/page',
    });
    tabsRemoveMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    releaseLoginLock(1);
    releaseLoginLock(42);
  });

  it('existing 路径：不做 tab 创建，ctx.tabId 为传入 tab', async () => {
    storageWith(CONFIG);
    const outcome = await prepareLogin(
      baseInput({ execTarget: { kind: 'existing', tabId: 7 } }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.prepared.ctx.tabId).toBe(7);
    expect(tabsCreateMock).not.toHaveBeenCalled();
    expect(isLoginLocked(7)).toBe(true);
    outcome.prepared.release();
    expect(isLoginLocked(7)).toBe(false);
  });

  it('existing 路径目标为扩展页/受限页（如 options）→ TAB_RESTRICTED 且不占锁', async () => {
    storageWith(CONFIG);
    tabsGetMock.mockResolvedValueOnce({
      id: 7,
      status: 'complete',
      url: 'chrome-extension://ebiccilfbpbngmjhagemgmglkelmcofi/options.html',
    });
    const outcome = await prepareLogin(
      baseInput({ execTarget: { kind: 'existing', tabId: 7 } }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorCode).toBe(ErrorCodes.TAB_RESTRICTED);
      expect(outcome.error).toContain('chrome-extension');
    }
    expect(isLoginLocked(7)).toBe(false);
  });

  it('new 路径：后台创建一次 tab，等待加载后用真实 id 构建 ctx', async () => {
    storageWith(CONFIG);
    const outcome = await prepareLogin(
      baseInput({ execTarget: { kind: 'new', url: 'http://example.com/page' } }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(tabsCreateMock).toHaveBeenCalledTimes(1);
    expect(tabsCreateMock).toHaveBeenCalledWith({
      url: 'http://example.com/page',
      active: false,
    });
    expect(outcome.prepared.ctx.tabId).toBe(42);
    expect(outcome.prepared.ctx.tabId).not.toBe(0);
    expect(outcome.prepared.execTabId).toBe(42);
    // 锁以执行 tab 为键
    expect(isLoginLocked(42)).toBe(true);
    outcome.prepared.release();
    expect(isLoginLocked(42)).toBe(false);
    // 成功路径 release 不关闭执行 tab
    expect(tabsRemoveMock).not.toHaveBeenCalled();
  });

  it('new 路径 + debugRedirect：在 redirect origin 建 tab（登录发生在该 origin）', async () => {
    storageWith(CONFIG);
    const outcome = await prepareLogin(
      baseInput({
        execTarget: { kind: 'new', url: 'http://example.com/page' },
        debugRedirect: 'http://localhost:8888',
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(tabsCreateMock).toHaveBeenCalledWith({
      url: 'http://localhost:8888',
      active: false,
    });
    outcome.prepared.release();
  });

  it('new 路径建 tab 失败 → 明确错误且锁已释放', async () => {
    storageWith(CONFIG);
    tabsCreateMock.mockRejectedValue(new Error('cannot create tab'));
    const outcome = await prepareLogin(
      baseInput({ execTarget: { kind: 'new', url: 'http://example.com/page' } }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorCode).toBe(ErrorCodes.TAB_CLOSED);
      expect(outcome.error).toContain('打开登录页面');
    }
    expect(isLoginLocked(42)).toBe(false);
  });

  it('new 路径后续步骤失败 → 新建 tab 被关闭、锁被释放', async () => {
    storageWith({
      domains: {
        'http://example.com': {
          name: 'x',
          loginMethod: 'missing-strategy',
        },
      },
    });
    const outcome = await prepareLogin(
      baseInput({ execTarget: { kind: 'new', url: 'http://example.com/page' } }),
    );
    expect(outcome.ok).toBe(false);
    expect(tabsCreateMock).toHaveBeenCalledTimes(1);
    expect(tabsRemoveMock).toHaveBeenCalledWith(42);
    expect(isLoginLocked(42)).toBe(false);
  });

  it('existing 路径 tabId 缺失 → 显式错误，不创建 tab、不进入流程', async () => {
    storageWith(CONFIG);
    const outcome = await prepareLogin(
      baseInput({ execTarget: { kind: 'existing', tabId: 0 } }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorCode).toBe(ErrorCodes.TAB_CLOSED);
      expect(outcome.error).toContain('执行页面');
    }
    expect(tabsCreateMock).not.toHaveBeenCalled();
  });

  it('new 路径 url 非法 → INVALID_URL，不创建 tab', async () => {
    storageWith(CONFIG);
    const outcome = await prepareLogin(
      baseInput({ execTarget: { kind: 'new', url: 'not-a-url' } }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errorCode).toBe(ErrorCodes.INVALID_URL);
    expect(tabsCreateMock).not.toHaveBeenCalled();
  });

  it('release({ closeExecTab: true }) 关闭新建 tab（幂等）', async () => {
    storageWith(CONFIG);
    const outcome = await prepareLogin(
      baseInput({ execTarget: { kind: 'new', url: 'http://example.com/page' } }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    outcome.prepared.release({ closeExecTab: true });
    outcome.prepared.release({ closeExecTab: true });
    expect(tabsRemoveMock).toHaveBeenCalledTimes(1);
    expect(tabsRemoveMock).toHaveBeenCalledWith(42);
    expect(isLoginLocked(42)).toBe(false);
  });
});
