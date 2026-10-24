import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * safeStorageSet 配额异常捕获测试
 *
 * 覆盖：
 * - 写入成功：返回 { ok: true }，不弹提示
 * - 配额超限（QuotaExceededError / QUOTA_BYTES）：返回 { ok: false, quotaExceeded: true }，
 *   并弹出「存储已满」类用户提示（不出现静默丢数据）
 * - 其他写入异常：返回 { ok: false, quotaExceeded: false }，弹出通用失败提示
 * - notify: false 时任何失败都不弹提示（后台/迁移等静默场景）
 * - 自定义提示文案优先于默认文案
 * - isQuotaExceededError 对各类错误形态的判定
 */

// ---------------------------------------------------------------------------
// chrome.storage.local mock — set 的成败可编程控制
// ---------------------------------------------------------------------------

let store: Record<string, unknown>;
/** 设置为非 null 时，storage.set 将以该错误 reject */
let setFailure: Error | null = null;

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn(async (keys: string[] | null) => {
        if (keys === null) return { ...store };
        const out: Record<string, unknown> = {};
        for (const k of keys) {
          if (k in store) out[k] = store[k];
        }
        return out;
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        if (setFailure) throw setFailure;
        Object.assign(store, items);
      }),
      remove: vi.fn(async (keys: string[]) => {
        for (const k of keys) delete store[k];
      }),
    },
  },
});

import { isQuotaExceededError, safeStorageSet, storageWriteFailureMessage } from '../entrypoints/shared/safe-storage';
import { setConfig, getConfig } from '../entrypoints/shared/tool-config';
import { setAllConfig } from '../entrypoints/shared/config-transfer';
import { useToast, dismissToast } from '../entrypoints/shared/use-toast';

/** 当前所有未关闭的 toast */
function currentToasts() {
  return useToast().toasts.value;
}

beforeEach(() => {
  store = {};
  setFailure = null;
});

afterEach(() => {
  // 清空模块级 toast 状态，避免跨用例泄漏
  for (const t of currentToasts()) dismissToast(t.id);
});

// ---------------------------------------------------------------------------
// 成功路径
// ---------------------------------------------------------------------------

describe('safeStorageSet — 成功路径', () => {
  it('写入成功返回 ok: true，且不弹任何提示', async () => {
    const result = await safeStorageSet({ 'devtools-x': { a: 1 } });

    expect(result).toEqual({ ok: true, quotaExceeded: false });
    expect(store['devtools-x']).toEqual({ a: 1 });
    expect(currentToasts()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 配额超限
// ---------------------------------------------------------------------------

describe('safeStorageSet — 配额超限', () => {
  const QUOTA_ERRORS = [
    new Error('QUOTA_BYTES quota exceeded'),
    new Error("Failed to execute 'set' on 'Storage': quota exceeded"),
    new DOMException('The quota has been exceeded.', 'QuotaExceededError'),
  ];

  it.each(QUOTA_ERRORS.map((e, i) => [i, e] as const))(
    '配额错误形态 #%#：返回可判断的失败结果并弹出存储已满提示',
    async (_idx, err) => {
      setFailure = err;

      const result = await safeStorageSet({ 'devtools-x': 'v' });

      expect(result.ok).toBe(false);
      expect(result.quotaExceeded).toBe(true);
      expect(result.error).toBeTruthy();
      // 数据未写入
      expect(store['devtools-x']).toBeUndefined();
      // 用户看到「存储已满，请清理」类提示
      const toasts = currentToasts();
      expect(toasts).toHaveLength(1);
      expect(toasts[0].type).toBe('error');
      expect(toasts[0].message).toMatch(/存储.*满|空间不足/);
      expect(toasts[0].message).toMatch(/清理/);
    },
  );

  it('notify: false 时配额失败不弹提示，但仍返回失败结果', async () => {
    setFailure = new Error('QUOTA_BYTES quota exceeded');

    const result = await safeStorageSet({ 'devtools-x': 'v' }, { notify: false });

    expect(result.ok).toBe(false);
    expect(result.quotaExceeded).toBe(true);
    expect(currentToasts()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 其他写入异常
// ---------------------------------------------------------------------------

describe('safeStorageSet — 通用写入异常', () => {
  it('非配额错误返回 ok: false / quotaExceeded: false，并弹出通用失败提示', async () => {
    setFailure = new Error('IO error: disk broken');

    const result = await safeStorageSet({ 'devtools-x': 'v' });

    expect(result.ok).toBe(false);
    expect(result.quotaExceeded).toBe(false);
    expect(result.error).toContain('disk broken');
    const toasts = currentToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('error');
    expect(toasts[0].message).toMatch(/保存失败|写入失败/);
  });

  it('自定义 message 优先于默认文案', async () => {
    setFailure = new Error('whatever');

    const result = await safeStorageSet(
      { 'devtools-x': 'v' },
      { message: '日志写入失败，请清理日志' },
    );

    expect(result.ok).toBe(false);
    const toasts = currentToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe('日志写入失败，请清理日志');
  });
});

// ---------------------------------------------------------------------------
// isQuotaExceededError
// ---------------------------------------------------------------------------

describe('isQuotaExceededError', () => {
  it('识别各种配额错误形态', () => {
    expect(isQuotaExceededError(new Error('QUOTA_BYTES quota exceeded'))).toBe(true);
    expect(isQuotaExceededError(new Error('QUOTA_BYTES_PER_ITEM quota exceeded'))).toBe(true);
    expect(isQuotaExceededError(new DOMException('x', 'QuotaExceededError'))).toBe(true);
    expect(isQuotaExceededError(new Error('The quota has been exceeded'))).toBe(true);
  });

  it('不误判非配额错误', () => {
    expect(isQuotaExceededError(new Error('network timeout'))).toBe(false);
    expect(isQuotaExceededError(new Error('IO error'))).toBe(false);
    expect(isQuotaExceededError('just a string')).toBe(false);
    expect(isQuotaExceededError(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// storageWriteFailureMessage — 统一失败文案生成
// ---------------------------------------------------------------------------

describe('storageWriteFailureMessage', () => {
  it('配额失败生成「存储已满 + 清理」文案，并嵌入业务名词', () => {
    const msg = storageWriteFailureMessage(
      { ok: false, quotaExceeded: true, error: 'QUOTA_BYTES' },
      '扩展源码',
    );
    expect(msg).toContain('存储空间已满');
    expect(msg).toContain('扩展源码');
    expect(msg).toContain('清理');
  });

  it('非配额失败生成通用写入失败文案，附带原始错误', () => {
    const msg = storageWriteFailureMessage(
      { ok: false, quotaExceeded: false, error: 'IO error' },
      '设置',
    );
    expect(msg).toBe('设置写入失败: IO error');
  });
});

// ---------------------------------------------------------------------------
// 下游封装传播（tool-config）：写入失败返回 false，调用方可避免假成功反馈
// ---------------------------------------------------------------------------

describe('tool-config 写入结果传播', () => {
  it('setConfig 成功返回 true，配置可正常读回（读写回归）', async () => {
    const ok = await setConfig('json-diff', { autoCompare: true });

    expect(ok).toBe(true);
    expect(await getConfig('json-diff')).toEqual({ autoCompare: true });
    expect(currentToasts()).toHaveLength(0);
  });

  it('setConfig 配额写满返回 false，且弹出存储已满提示（无「保存成功」假反馈）', async () => {
    setFailure = new Error('QUOTA_BYTES quota exceeded');

    const ok = await setConfig('json-diff', { autoCompare: true });

    expect(ok).toBe(false);
    expect(store['devtools-json-diff']).toBeUndefined();
    const toasts = currentToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('error');
    expect(toasts[0].message).toMatch(/存储空间已满/);
  });

  it('setAllConfig 配额写满返回 false 并提示', async () => {
    setFailure = new Error('QUOTA_BYTES_PER_ITEM quota exceeded');

    const ok = await setAllConfig({ 'mock-data': { count: 5 } });

    expect(ok).toBe(false);
    expect(store['devtools-mock-data']).toBeUndefined();
    expect(currentToasts().some((t) => /存储空间已满/.test(t.message))).toBe(true);
  });
});
