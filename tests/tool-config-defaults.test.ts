import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * getConfig(toolId, defaults) 默认值补齐测试（ADR-0003 D5）
 *
 * 覆盖：
 * - 传入 defaults：历史配置缺失的顶层字段被补齐
 * - 已有字段不被 defaults 覆盖（stored 优先）
 * - 不传 defaults：行为与旧版完全一致（原样返回、缺失不补）
 * - 存储中无配置时仍返回 undefined（保留调用方的缺省/报错分支）
 * - 旧版 devtools 根 key 迁移在带 defaults 的读取路径上同样触发
 */

// ---------------------------------------------------------------------------
// chrome.storage.local mock（与 config-save-toast.test.ts 同款）
// ---------------------------------------------------------------------------

let store: Record<string, unknown>;

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
          Object.assign(store, items);
        }),
        remove: vi.fn(async (keys: string[]) => {
          for (const k of keys) delete store[k];
        }),
      },
    },
  });
}

import { getConfig } from '../entrypoints/shared/tool-config';
import type { AccountSwitchConfig } from '../entrypoints/tools/account-switch/types';

interface FormatterConfig {
  indent: number;
  autoParseJson: boolean;
}

const DEFAULTS: FormatterConfig = { indent: 2, autoParseJson: true };

beforeEach(() => {
  store = { 'devtools-migrated': true };
  stubChromeStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getConfig(toolId, defaults) — 默认值补齐', () => {
  it('历史配置缺失新增字段 → defaults 补齐缺失字段', async () => {
    // 旧版本写入的配置没有 autoParseJson 字段
    store['devtools-json-formatter'] = { indent: 4 };

    const cfg = await getConfig<FormatterConfig>('json-formatter', DEFAULTS);

    expect(cfg).toEqual({ indent: 4, autoParseJson: true });
  });

  it('已有字段不被 defaults 覆盖（stored 优先）', async () => {
    store['devtools-json-formatter'] = { indent: 8, autoParseJson: false };

    const cfg = await getConfig<FormatterConfig>('json-formatter', DEFAULTS);

    expect(cfg).toEqual({ indent: 8, autoParseJson: false });
  });

  it('不传 defaults → 行为不变：原样返回，不补齐缺失字段', async () => {
    store['devtools-json-formatter'] = { indent: 4 };

    const cfg = await getConfig<Partial<FormatterConfig>>('json-formatter');

    expect(cfg).toEqual({ indent: 4 });
    expect(cfg).not.toHaveProperty('autoParseJson');
  });

  it('存储中无配置 → 即使传 defaults 仍返回 undefined（保留调用方缺省分支）', async () => {
    const cfg = await getConfig<FormatterConfig>('json-formatter', DEFAULTS);

    expect(cfg).toBeUndefined();
  });

  it('合并结果是新对象：不污染传入的 defaults，也不引用存储中的对象', async () => {
    const stored = { indent: 4 };
    store['devtools-json-formatter'] = stored;
    const defaults = { ...DEFAULTS };

    const cfg = await getConfig<FormatterConfig>('json-formatter', defaults);

    expect(cfg).not.toBe(stored);
    expect(defaults).toEqual(DEFAULTS); // defaults 未被写入 stored 字段
  });

  it('envBadge 缺省补齐（ADR-0017）：defaults 含 envBadge 时缺失即补', async () => {
    // v2 前的存量 account-switch 配置没有 envBadge 字段
    store['devtools-account-switch'] = { accounts: [], domains: {} };

    const cfg = await getConfig<AccountSwitchConfig>('account-switch', {
      accounts: [],
      domains: {},
      envBadge: { enabled: false, position: 'bottom-right', whitelist: [] },
    });

    expect(cfg?.envBadge).toEqual({
      enabled: false,
      position: 'bottom-right',
      whitelist: [],
    });
  });
});
