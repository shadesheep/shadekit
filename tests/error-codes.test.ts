/**
 * 错误码体系 + 复制详情 + 非 dev 失败摘要
 *
 * 覆盖：
 * - errorCodeOf：各类异常 → 错误码归一化
 * - buildErrorDetail：复制详情文本含错误码 + 上下文，缺失字段自动省略
 * - logEntry：非 dev 模式失败时写最小摘要（脱敏），dev 模式写完整日志
 * - showToast：action 按钮透传
 *
 * 注：登录失败路径的错误码透传由 spec 引擎承担，见
 * `login-spec-*.test.ts` / `spec-run.test.ts`。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// chrome.storage.local 内存 fake（logger / dev-mode 依赖）
// ---------------------------------------------------------------------------

let store: Record<string, unknown>;

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn(async (keys: string[]) => {
        const out: Record<string, unknown> = {};
        for (const k of keys) {
          if (k in store) out[k] = store[k];
        }
        return out;
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(store, items);
      }),
    },
  },
});

import type { DomainConfig } from '../entrypoints/tools/account-switch/types';
import type { DebugBuffer } from '../entrypoints/tools/account-switch/utils/debug-log';
import {
  logEntry,
  newDebugEntry,
} from '../entrypoints/tools/account-switch/utils/debug-log';
import {
  ErrorCodes,
  LoginError,
  buildErrorDetail,
  errorCodeOf,
} from '../entrypoints/tools/account-switch/utils/error-codes';
import { RequestTimeoutError } from '../entrypoints/tools/account-switch/utils/fetch-timeout';
import { getLogs } from '../entrypoints/shared/logger';
import { showToast, useToast } from '../entrypoints/shared/use-toast';

function buildDomainConfig(
  overrides: Partial<DomainConfig> = {},
): DomainConfig {
  return {
    name: '测试环境',
    tags: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// errorCodeOf — 异常 → 错误码归一化
// ---------------------------------------------------------------------------

describe('errorCodeOf — 异常归一化为错误码', () => {
  it('LoginError → 携带的码原样返回', () => {
    const err = new LoginError(ErrorCodes.RSA_ENCRYPT_ERROR, 'RSA 加密失败');
    expect(errorCodeOf(err)).toBe(ErrorCodes.RSA_ENCRYPT_ERROR);
  });

  it('RequestTimeoutError → REQUEST_TIMEOUT', () => {
    expect(errorCodeOf(new RequestTimeoutError('http://x.com', 15000))).toBe(
      ErrorCodes.REQUEST_TIMEOUT,
    );
    // 跨包实例 instanceof 失效时按 name 兜底
    const alien = new Error('请求超时');
    alien.name = 'RequestTimeoutError';
    expect(errorCodeOf(alien)).toBe(ErrorCodes.REQUEST_TIMEOUT);
  });

  it('NetworkError（fetch-retry）→ NETWORK_ERROR', () => {
    const err = new Error('网络请求失败');
    err.name = 'NetworkError';
    expect(errorCodeOf(err)).toBe(ErrorCodes.NETWORK_ERROR);
  });

  it('fetch 原生 TypeError（断网/DNS）→ NETWORK_ERROR', () => {
    expect(errorCodeOf(new TypeError('Failed to fetch'))).toBe(
      ErrorCodes.NETWORK_ERROR,
    );
    expect(errorCodeOf(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(
      ErrorCodes.NETWORK_ERROR,
    );
  });

  it('无关 TypeError 与普通 Error → UNKNOWN', () => {
    expect(errorCodeOf(new TypeError('undefined is not a function'))).toBe(
      ErrorCodes.UNKNOWN,
    );
    expect(errorCodeOf(new Error('随便什么错误'))).toBe(ErrorCodes.UNKNOWN);
    expect(errorCodeOf('字符串异常')).toBe(ErrorCodes.UNKNOWN);
    expect(errorCodeOf(undefined)).toBe(ErrorCodes.UNKNOWN);
  });
});

// ---------------------------------------------------------------------------
// buildErrorDetail — 复制详情文本
// ---------------------------------------------------------------------------

describe('buildErrorDetail — 复制详情内容', () => {
  const now = new Date('2026-08-12T10:00:00');

  it('包含错误码、错误信息、环境、策略、账号、时间', () => {
    const detail = buildErrorDetail(
      ErrorCodes.LOGIN_FAILED,
      '密码错误',
      {
        action: 'SWITCH_ACCOUNT',
        envName: '生产环境',
        origin: 'https://app.example.com',
        strategy: 'custom-login',
        accountName: '张三',
        username: 'zhangsan',
      },
      now,
    );

    expect(detail).toContain(`错误码: ${ErrorCodes.LOGIN_FAILED}`);
    expect(detail).toContain('错误信息: 密码错误');
    expect(detail).toContain('操作: SWITCH_ACCOUNT');
    expect(detail).toContain('环境: 生产环境');
    expect(detail).toContain('地址: https://app.example.com');
    expect(detail).toContain('登录策略: custom-login');
    expect(detail).toContain('账号: 张三 (zhangsan)');
    expect(detail).toContain(`时间: ${now.toLocaleString()}`);
  });

  it('缺失的上下文字段自动省略', () => {
    const detail = buildErrorDetail(ErrorCodes.UNKNOWN, '未知错误', {}, now);

    expect(detail).toContain('错误码: UNKNOWN');
    expect(detail).not.toContain('环境:');
    expect(detail).not.toContain('登录策略:');
    expect(detail).not.toContain('账号:');
  });

  it('accountName 与 username 相同则不重复展示', () => {
    const detail = buildErrorDetail(
      ErrorCodes.LOGIN_FAILED,
      'x',
      { accountName: 'zhangsan', username: 'zhangsan' },
      now,
    );
    expect(detail).toContain('账号: zhangsan\n');
  });

  it('配方轨迹逐条列出序号 / 操作 / 目标 / 耗时 / 状态 / 错误码', () => {
    const detail = buildErrorDetail(
      ErrorCodes.ELEMENT_NOT_FOUND,
      '未找到元素: #password',
      {
        recipeSteps: [
          {
            index: 0,
            op: 'fill',
            target: '#username',
            status: 'success',
            duration: 12,
          },
          {
            index: 1,
            op: 'click',
            target: '文本「登录」',
            status: 'error',
            duration: 5,
            errorCode: ErrorCodes.ELEMENT_NOT_FOUND,
            error: '未找到元素: #password',
          },
        ],
      },
      now,
    );

    expect(detail).toContain('配方步骤:');
    expect(detail).toContain('  1. fill → #username (12ms) success');
    expect(detail).toContain(
      `  2. click → 文本「登录」 (5ms) error [${ErrorCodes.ELEMENT_NOT_FOUND}]`,
    );
  });
});

// ---------------------------------------------------------------------------
// logEntry — 非 dev 模式最小失败摘要
// ---------------------------------------------------------------------------

describe('logEntry — 非 dev 模式失败摘要', () => {
  const buffer: DebugBuffer = { startTime: 0 };

  function buildEntry(overrides: {
    success: boolean;
    error?: string;
    errorCode?: string;
  }) {
    return newDebugEntry(
      'SWITCH_ACCOUNT',
      { name: '张三', username: 'zhangsan' },
      'https://app.example.com',
      buildDomainConfig({ loginMethod: 'custom-login' }),
      { success: overrides.success, error: overrides.error, errorCode: overrides.errorCode, duration: 12 },      buffer,
    );
  }

  beforeEach(() => {
    store = {};
  });

  it('非 dev 模式 + 失败 → 写入 error 级最小摘要（含错误码，无请求/响应）', async () => {
    await logEntry(
      buildEntry({ success: false, error: '密码错误', errorCode: ErrorCodes.LOGIN_FAILED }),
    );

    const logs = await getLogs({ categories: ['auth'] });
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe('error');
    expect(logs[0].message).toContain(`[${ErrorCodes.LOGIN_FAILED}]`);
    expect(logs[0].message).toContain('密码错误');
    expect(logs[0].extra?.failureSummary).toBe(true);
    expect(logs[0].extra?.errorCode).toBe(ErrorCodes.LOGIN_FAILED);
    // 脱敏：不含请求/响应详情
    expect(logs[0].extra?.request).toBeUndefined();
    expect(logs[0].extra?.response).toBeUndefined();
  });

  it('非 dev 模式 + 成功 → 不记录任何日志', async () => {
    await logEntry(buildEntry({ success: true }));

    const logs = await getLogs({ categories: ['auth'] });
    expect(logs).toHaveLength(0);
  });

  it('dev 模式 → 走完整调试日志（非 failureSummary）', async () => {
    store['devtools-dev-mode'] = true;

    await logEntry(
      buildEntry({ success: false, error: '密码错误', errorCode: ErrorCodes.LOGIN_FAILED }),
    );

    const logs = await getLogs({ categories: ['auth'] });
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe('info');
    expect(logs[0].extra?.failureSummary).toBeUndefined();
    expect(logs[0].message).toContain(`[${ErrorCodes.LOGIN_FAILED}]`);
  });
});

// ---------------------------------------------------------------------------
// showToast — action 按钮透传
// ---------------------------------------------------------------------------

describe('showToast — action 支持', () => {
  it('携带 action 的 toast 保留 label 与 onClick', () => {
    const onClick = vi.fn();
    showToast('登录失败：密码错误', 'error', 0, {
      label: '复制详情',
      onClick,
    });

    const { toasts } = useToast();
    const toast = toasts.value.find((t) => t.message === '登录失败：密码错误');
    expect(toast?.action?.label).toBe('复制详情');
    toast?.action?.onClick();
    expect(onClick).toHaveBeenCalledOnce();
  });
});
