import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * 选项页配置保存 Toast 反馈测试
 *
 * 覆盖：
 * - setConfigWithFeedback：成功弹「已保存」成功 Toast；失败弹错误 Toast
 *   且绝不出现成功假反馈
 * - safeStorageSet 失败 Toast 附「复制详情」按钮：点击后复制错误详情
 *   （错误信息 + 存储键 + 配额判定 + 时间），并给出复制结果提示
 * - copyToClipboard：clipboard API 成功 / 无 DOM 环境回退失败返回 false
 */

// ---------------------------------------------------------------------------
// chrome.storage.local mock — set 的成败可编程控制（与 safe-storage.test.ts 同款）
// ---------------------------------------------------------------------------

let store: Record<string, unknown>;
/** 设置为非 null 时，storage.set 将以该错误 reject */
let setFailure: Error | null = null;

/** 安装 chrome.storage.local stub（afterEach 会 unstubAllGlobals，故每个用例前重装） */
function stubChromeStorage() {
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
}

/** clipboard.writeText mock，成败可编程 */
const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});

import { copyToClipboard } from '../entrypoints/shared/clipboard';
import { safeStorageSet } from '../entrypoints/shared/safe-storage';
import { setConfigWithFeedback, getConfig } from '../entrypoints/shared/tool-config';
import { useToast, dismissToast } from '../entrypoints/shared/use-toast';

/** 当前所有未关闭的 toast */
function currentToasts() {
  return useToast().toasts.value;
}

/** 等待 onClick 中的异步复制链（promise then）完成 */
async function flushMicrotasks() {
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  store = {};
  setFailure = null;
  stubChromeStorage();
  writeText.mockClear();
  writeText.mockImplementation(async () => {});
  vi.stubGlobal('navigator', { clipboard: { writeText } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  // 清空模块级 toast 状态，避免跨用例泄漏
  for (const t of currentToasts()) dismissToast(t.id);
});

// ---------------------------------------------------------------------------
// copyToClipboard
// ---------------------------------------------------------------------------

describe('copyToClipboard', () => {
  it('clipboard API 成功 → 返回 true 并写入目标文本', async () => {
    const ok = await copyToClipboard('hello');

    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('clipboard API 失败且环境无 DOM（后台/测试）→ 返回 false', async () => {
    writeText.mockRejectedValueOnce(new Error('NotAllowedError'));

    // vitest node 环境无 document，回退 execCommand 不可用
    const ok = await copyToClipboard('hello');

    expect(ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// safeStorageSet 失败 Toast 附「复制详情」
// ---------------------------------------------------------------------------

describe('safeStorageSet — 失败 Toast 附复制详情', () => {
  it('配额超限：错误 Toast 携带「复制详情」按钮，点击复制错误详情', async () => {
    setFailure = new Error('QUOTA_BYTES quota exceeded');

    const result = await safeStorageSet({ 'devtools-json-diff': { a: 1 } });

    expect(result.ok).toBe(false);
    const toasts = currentToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('error');
    expect(toasts[0].action?.label).toBe('复制详情');

    toasts[0].action!.onClick();
    await flushMicrotasks();

    expect(writeText).toHaveBeenCalledTimes(1);
    const detail = writeText.mock.calls[0][0];
    expect(detail).toContain('QUOTA_BYTES quota exceeded');
    expect(detail).toContain('devtools-json-diff');
    expect(detail).toMatch(/配额超限: 是/);
    // 复制成功后给出确认提示
    expect(currentToasts().some((t) => t.message === '错误详情已复制')).toBe(true);
  });

  it('通用写入异常：复制详情包含原始错误，且不误判为配额超限', async () => {
    setFailure = new Error('IO error: disk broken');

    await safeStorageSet({ 'devtools-x': 'v' });

    const toast = currentToasts()[0];
    expect(toast.action?.label).toBe('复制详情');

    toast.action!.onClick();
    await flushMicrotasks();

    const detail = writeText.mock.calls[0][0];
    expect(detail).toContain('IO error: disk broken');
    expect(detail).toMatch(/配额超限: 否/);
  });

  it('复制本身失败 → 提示复制失败而非已复制', async () => {
    setFailure = new Error('QUOTA_BYTES quota exceeded');
    writeText.mockRejectedValue(new Error('NotAllowedError'));

    await safeStorageSet({ 'devtools-x': 'v' });
    currentToasts()[0].action!.onClick();
    await flushMicrotasks();

    const messages = currentToasts().map((t) => t.message);
    expect(messages).toContain('复制失败，请查看控制台日志');
    expect(messages).not.toContain('错误详情已复制');
  });

  it('写入成功 → 不弹任何提示，也没有复制按钮', async () => {
    await safeStorageSet({ 'devtools-x': 'v' });

    expect(currentToasts()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// setConfigWithFeedback — 统一保存反馈
// ---------------------------------------------------------------------------

describe('setConfigWithFeedback — 统一保存反馈', () => {
  it('保存成功：返回 true，弹「已保存」成功 Toast，配置可正常读回', async () => {
    const ok = await setConfigWithFeedback('json-diff', { autoCompare: false });

    expect(ok).toBe(true);
    expect(await getConfig('json-diff')).toEqual({ autoCompare: false });
    const toasts = currentToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('success');
    expect(toasts[0].message).toBe('已保存');
  });

  it('自定义成功文案优先于默认「已保存」', async () => {
    const ok = await setConfigWithFeedback('code-beautify', { indentSize: 2 }, '缩进已保存');

    expect(ok).toBe(true);
    expect(currentToasts()[0].message).toBe('缩进已保存');
  });

  it('保存失败（配额满）：返回 false，弹错误 Toast（含复制详情），不出现成功假反馈', async () => {
    setFailure = new Error('QUOTA_BYTES quota exceeded');

    const ok = await setConfigWithFeedback('json-diff', { autoCompare: false });

    expect(ok).toBe(false);
    expect(store['devtools-json-diff']).toBeUndefined();
    const toasts = currentToasts();
    // 只有错误 Toast，绝无「已保存」假反馈
    expect(toasts.some((t) => t.type === 'success')).toBe(false);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('error');
    expect(toasts[0].action?.label).toBe('复制详情');
  });

  it('保存失败（通用异常）：同样只有错误 Toast', async () => {
    setFailure = new Error('IO error');

    const ok = await setConfigWithFeedback('code-beautify', { indentSize: 2 });

    expect(ok).toBe(false);
    const toasts = currentToasts();
    expect(toasts.some((t) => t.type === 'success')).toBe(false);
    expect(toasts[0].type).toBe('error');
  });
});
