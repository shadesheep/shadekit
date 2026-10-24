/**
 * 登录并发互斥
 * ① login-lock：同 tabId 只允许一个持锁者，释放后可再次获取
 * ② handleSwitchAccount：同 tab 登录进行中再次触发 → 直接拒绝「正在登录中」
 * ③ 不同 tab 的登录流程互不影响，各自持有独立 ctx/debugBuffer
 * ④ 登录结束（成功/失败）后锁释放，同 tab 可再次登录
 *
 * 注：登录执行已统一为 spec 引擎。本文件只关心锁与 prelude，
 * 因此把 `runLoginSpec` 换成可控闸门——锁语义不应随执行器实现而变。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const storageGetMock = vi.fn().mockResolvedValue({});
const storageSetMock = vi.fn().mockResolvedValue(undefined);

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: (...args: unknown[]) => storageGetMock(...args),
      set: (...args: unknown[]) => storageSetMock(...args),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  },
  tabs: {
    query: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    reload: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
});

/** 可控登录执行器：记录每次调用的 ctx，并在测试放行前保持进行中 */
const loginRunMock = vi.hoisted(() => ({
  contexts: [] as Array<{ debugBuffer?: unknown }>,
  gate: Promise.resolve(),
  resolveGate: () => {},
  result: { success: true } as {
    success: boolean;
    error?: string;
    errorCode?: string;
  },
}));

vi.mock('../entrypoints/tools/account-switch/spec/login-run', () => ({
  runLoginSpec: async (_spec: unknown, ctx: { debugBuffer?: unknown }) => {
    loginRunMock.contexts.push(ctx);
    await loginRunMock.gate;
    return loginRunMock.result;
  },
}));

import {
  isLoginLocked,
  releaseLoginLock,
  tryAcquireLoginLock,
} from '../entrypoints/tools/account-switch/login-session';
import { LOGIN_BUSY_ERROR } from '../entrypoints/tools/account-switch/utils/error-codes';
import { handleSwitchAccount } from '../entrypoints/tools/account-switch/background-handler';
import {
  DEFAULT_AUTH,
  LOGIN_SPEC_VERSION,
  type LoginSpec,
} from '../entrypoints/tools/account-switch/spec/types';
import type { Account } from '../entrypoints/tools/account-switch/types';

describe('login-lock — 基于 tabId 的内存锁', () => {
  afterEach(() => {
    releaseLoginLock(1);
    releaseLoginLock(2);
  });

  it('首次获取成功，同 tab 重复获取被拒绝', () => {
    expect(tryAcquireLoginLock(1)).toBe(true);
    expect(tryAcquireLoginLock(1)).toBe(false);
    expect(isLoginLocked(1)).toBe(true);
  });

  it('不同 tab 互不影响', () => {
    expect(tryAcquireLoginLock(1)).toBe(true);
    expect(tryAcquireLoginLock(2)).toBe(true);
  });

  it('释放后可再次获取；重复释放幂等', () => {
    tryAcquireLoginLock(1);
    releaseLoginLock(1);
    expect(isLoginLocked(1)).toBe(false);
    expect(tryAcquireLoginLock(1)).toBe(true);
    releaseLoginLock(1);
    releaseLoginLock(1); // 幂等，不抛错
    expect(isLoginLocked(1)).toBe(false);
  });
});

describe('handleSwitchAccount — 同 tab 登录并发互斥', () => {
  const account: Account = {
    id: 'a1',
    name: '测试账号',
    username: 'user1',
    password: 'pass1',
    roles: [],
    domains: ['example.com'],
  } as Account;

  /** 最小 v2 spec：prelude 只读取、不校验内容 */
  function stubSpec(): LoginSpec {
    return {
      version: LOGIN_SPEC_VERSION,
      template: 'lock-test',
      ops: [],
      success: [],
      auth: DEFAULT_AUTH,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    loginRunMock.contexts.length = 0;
    loginRunMock.result = { success: true };
    loginRunMock.gate = new Promise<void>((resolve) => {
      loginRunMock.resolveGate = resolve;
    });
    storageGetMock.mockImplementation(async (keys: string[]) => {
      if (keys.includes('devtools-account-switch')) {
        return {
          'devtools-account-switch': {
            domains: {
              'http://example.com': {
                name: '测试环境',
                loginMethod: 'generic',
                strategyConfig: { spec: stubSpec() },
              },
            },
          },
        };
      }
      return {};
    });
  });

  afterEach(() => {
    releaseLoginLock(1);
    releaseLoginLock(2);
  });

  const senderOf = (tabId: number) =>
    ({ tab: { id: tabId } }) as chrome.runtime.MessageSender;

  it('同 tab 登录进行中再次触发 → 拒绝且提示正在登录中，不重复发登录请求', async () => {
    const first = handleSwitchAccount(account, 'http://example.com', senderOf(1));
    // 等第一次流程进入登录执行
    await vi.waitFor(() => expect(loginRunMock.contexts).toHaveLength(1));

    const second = await handleSwitchAccount(account, 'http://example.com', senderOf(1));
    expect(second.success).toBe(false);
    expect(second.error).toBe(LOGIN_BUSY_ERROR);
    // 第二次未触发新的登录执行
    expect(loginRunMock.contexts).toHaveLength(1);

    loginRunMock.resolveGate();
    const firstResult = await first;
    expect(firstResult.success).toBe(true);
  });

  it('不同 tab 的登录可并行，且各自持有独立 debugBuffer', async () => {
    const first = handleSwitchAccount(account, 'http://example.com', senderOf(1));
    const second = handleSwitchAccount(account, 'http://example.com', senderOf(2));
    await vi.waitFor(() => expect(loginRunMock.contexts).toHaveLength(2));

    // 两个流程的调试缓冲不是同一个对象
    expect(loginRunMock.contexts[0].debugBuffer).not.toBe(
      loginRunMock.contexts[1].debugBuffer,
    );

    loginRunMock.resolveGate();
    // 两个流程共享同一个 gate promise（测试如此），均成功
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
  });

  it('登录结束后锁释放，同 tab 可再次登录', async () => {
    const first = handleSwitchAccount(account, 'http://example.com', senderOf(1));
    await vi.waitFor(() => expect(loginRunMock.contexts).toHaveLength(1));
    expect(isLoginLocked(1)).toBe(true);

    loginRunMock.resolveGate();
    await first;
    expect(isLoginLocked(1)).toBe(false);

    // 再次登录正常进行
    loginRunMock.gate = new Promise<void>((resolve) => {
      loginRunMock.resolveGate = resolve;
    });
    const second = handleSwitchAccount(account, 'http://example.com', senderOf(1));
    await vi.waitFor(() => expect(loginRunMock.contexts).toHaveLength(2));
    loginRunMock.resolveGate();
    expect((await second).success).toBe(true);
  });

  it('登录失败后锁同样释放', async () => {
    loginRunMock.result = { success: false, error: '密码错误' };
    const first = handleSwitchAccount(account, 'http://example.com', senderOf(1));
    await vi.waitFor(() => expect(loginRunMock.contexts).toHaveLength(1));

    loginRunMock.resolveGate();
    const result = await first;
    expect(result.success).toBe(false);
    expect(isLoginLocked(1)).toBe(false);
  });
});
