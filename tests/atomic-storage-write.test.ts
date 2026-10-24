import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * 存储原子写 / 增量合并测试
 *
 * 覆盖：
 * - updateConfig：读最新 → 字段级合并 → 写回，未修改字段不被覆盖
 * - 双 options 页场景：A 页加载后，B 页改了别的字段，A 页保存自己的字段，
 *   双方修改都保留（不再整体写回导致互踩）
 * - updateConfig 写入失败返回 false 且不破坏已有数据
 * - setToolEnabled 落在同一增量合并封装上：只改目标工具，保留其他工具状态
 */

// ---------------------------------------------------------------------------
// chrome.storage.local mock
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

import { getConfig, setConfig, updateConfig } from '../entrypoints/shared/tool-config';
import { isToolEnabled, setToolEnabled } from '../entrypoints/shared/tool-state';
import { useToast, dismissToast } from '../entrypoints/shared/use-toast';

const TOOL_KEY = 'devtools-account-switch';
const STATE_KEY = 'devtools-state';

function currentToasts() {
  return useToast().toasts.value;
}

beforeEach(() => {
  store = {};
  setFailure = null;
});

afterEach(() => {
  for (const t of currentToasts()) dismissToast(t.id);
});

// ---------------------------------------------------------------------------
// updateConfig — 字段级增量合并
// ---------------------------------------------------------------------------

describe('updateConfig — 增量合并', () => {
  it('只覆盖 patch 中的字段，其余字段保留', async () => {
    store[TOOL_KEY] = {
      accounts: [{ id: 'a1' }],
      domains: { 'http://x': { name: 'X' } },
      quickLoginDefaultDomain: 'http://x',
    };

    const ok = await updateConfig('account-switch', {
      accounts: [{ id: 'a1' }, { id: 'a2' }],
    });

    expect(ok).toBe(true);
    expect(store[TOOL_KEY]).toEqual({
      accounts: [{ id: 'a1' }, { id: 'a2' }],
      domains: { 'http://x': { name: 'X' } },
      quickLoginDefaultDomain: 'http://x',
    });
  });

  it('配置不存在时直接写入 patch 内容', async () => {
    const ok = await updateConfig('account-switch', { accounts: [] });

    expect(ok).toBe(true);
    expect(store[TOOL_KEY]).toEqual({ accounts: [] });
  });

  it('写入失败（配额超限）返回 false，已有数据不被破坏', async () => {
    store[TOOL_KEY] = { accounts: [{ id: 'a1' }], domains: {} };
    setFailure = new Error('QUOTA_BYTES quota exceeded');

    const ok = await updateConfig('account-switch', { accounts: [] });

    expect(ok).toBe(false);
    expect(store[TOOL_KEY]).toEqual({ accounts: [{ id: 'a1' }], domains: {} });
    expect(currentToasts().some((t) => t.type === 'error')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 双 options 页场景 — 双方修改都保留
// ---------------------------------------------------------------------------

describe('updateConfig — 多开页面不互踩', () => {
  it('A 页改 accounts、B 页改 domains，两次保存都生效', async () => {
    store[TOOL_KEY] = {
      accounts: [{ id: 'a1' }],
      domains: { 'http://x': { name: 'X' } },
    };

    // B 页先保存 domains（A 页内存中的 domains 仍是旧的）
    await updateConfig('account-switch', {
      domains: { 'http://x': { name: 'X' }, 'http://y': { name: 'Y' } },
    });
    // A 页随后保存自己改的 accounts（整体写回时代会丢掉 B 的 domains）
    await updateConfig('account-switch', {
      accounts: [{ id: 'a1' }, { id: 'a2' }],
    });

    expect(store[TOOL_KEY]).toEqual({
      accounts: [{ id: 'a1' }, { id: 'a2' }],
      domains: { 'http://x': { name: 'X' }, 'http://y': { name: 'Y' } },
    });
  });

  it('A 页改账号、B 页改快捷登录设置（Config.vue 字段级 patch 模式），双方保留', async () => {
    // 模拟 Config.vue 的字段级保存：accounts 与设置项分属不同 patch
    store[TOOL_KEY] = {
      accounts: [{ id: 'a1' }],
      domains: {},
      quickLoginDefaultDomain: 'http://old',
      globalDefaultPassword: 'old-pass',
    };

    // B 页保存设置字段（只 patch 自己改的那个）
    await updateConfig('account-switch', { quickLoginDefaultDomain: 'http://new' });
    // A 页保存账号（patch 不含设置字段，不会用本页过期值覆盖 B 的修改）
    await updateConfig('account-switch', {
      accounts: [{ id: 'a1' }, { id: 'a2' }],
    });

    expect(store[TOOL_KEY]).toEqual({
      accounts: [{ id: 'a1' }, { id: 'a2' }],
      domains: {},
      quickLoginDefaultDomain: 'http://new',
      globalDefaultPassword: 'old-pass',
    });
  });

  it('JSON 导入只覆盖 accounts/domains，不动其他字段（回归：导出→清空→导入）', async () => {
    store[TOOL_KEY] = {
      accounts: [],
      domains: {},
      quickLoginDefaultDomain: 'http://keep',
      tabOrder: ['quicklogin', 'users'],
    };

    // 导入文件只含 accounts/domains（exportToFile 只导出这两个字段）
    await updateConfig('account-switch', {
      accounts: [{ id: 'imported' }],
      domains: { 'http://imp': { name: 'IMP' } },
    });

    expect(store[TOOL_KEY]).toEqual({
      accounts: [{ id: 'imported' }],
      domains: { 'http://imp': { name: 'IMP' } },
      quickLoginDefaultDomain: 'http://keep',
      tabOrder: ['quicklogin', 'users'],
    });
  });
});

// ---------------------------------------------------------------------------
// setConfig 保持整体覆盖语义（导入等场景），updateConfig 读回一致性
// ---------------------------------------------------------------------------

describe('updateConfig — 与 setConfig/getConfig 协作', () => {
  it('updateConfig 后的数据可被 getConfig 读回', async () => {
    await setConfig('account-switch', { accounts: [], domains: {} });
    await updateConfig('account-switch', { quickLoginDefaultDomain: 'http://x' });

    const cfg = await getConfig<Record<string, unknown>>('account-switch');
    expect(cfg).toEqual({
      accounts: [],
      domains: {},
      quickLoginDefaultDomain: 'http://x',
    });
  });
});

// ---------------------------------------------------------------------------
// tool-state — 启用状态字段级合并（多开页面同时开关不同工具互不丢）
// ---------------------------------------------------------------------------

describe('setToolEnabled — 增量合并', () => {
  it('只更新目标工具，保留其他工具的已有状态', async () => {
    store[STATE_KEY] = { 'json-diff': false, 'json-formatter': true };

    const ok = await setToolEnabled('code-beautify', false);

    expect(ok).toBe(true);
    expect(store[STATE_KEY]).toEqual({
      'json-diff': false,
      'json-formatter': true,
      'code-beautify': false,
    });
  });

  it('覆盖已有工具状态时不影响其他工具', async () => {
    store[STATE_KEY] = { 'json-diff': false, 'json-formatter': true };

    await setToolEnabled('json-formatter', false);

    expect(store[STATE_KEY]).toEqual({
      'json-diff': false,
      'json-formatter': false,
    });
    expect(await isToolEnabled('json-diff', true)).toBe(false);
    expect(await isToolEnabled('json-formatter', true)).toBe(false);
  });

  it('状态不存在时创建仅含目标工具的记录', async () => {
    await setToolEnabled('json-diff', true);

    expect(store[STATE_KEY]).toEqual({ 'json-diff': true });
  });

  it('写入失败返回 false，已有状态不变', async () => {
    store[STATE_KEY] = { 'json-diff': false };
    setFailure = new Error('QUOTA_BYTES quota exceeded');

    const ok = await setToolEnabled('json-formatter', false);

    expect(ok).toBe(false);
    expect(store[STATE_KEY]).toEqual({ 'json-diff': false });
  });
});
