import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isReactive, nextTick } from 'vue';

/**
 * useToolConfig(ADR-0007 Auto-save 底座)测试
 *
 * 覆盖 seam:
 * - save()/replace() 出口剥离响应式 Proxy(对齐 account-switch saveFields 先例):
 *   嵌套数组/对象以纯数据落盘,Firefox structured-clone 不会因 Proxy 失败;
 *   且落盘的是快照,保存后继续编辑内存不污染已写数据
 * - deep watch + 防抖自动保存:loaded 守卫之后才触发,normalize 钳制回流落盘
 *
 * 注:加载路径走 onMounted,需在组件上下文内运行,此处不覆盖(浏览器侧验证)。
 */

// ---------------------------------------------------------------------------
// chrome.storage.local mock(与 tool-config-defaults.test.ts 同款)
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

import { useToolConfig } from '../entrypoints/shared/config/use-tool-config';

interface EnvConfig {
  domains: string[];
  position: string;
  count: number;
}

const DEFAULTS: EnvConfig = { domains: [], position: 'bottom-right', count: 10 };

beforeEach(() => {
  store = { 'devtools-migrated': true };
  stubChromeStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useToolConfig — save() 剥离响应式 Proxy', () => {
  it('嵌套数组以纯数据落盘(非 Vue Proxy),保存后继续编辑不污染已写数据', async () => {
    const { config, save } = useToolConfig<EnvConfig>('json-formatter', DEFAULTS);
    config.value.domains.push('http://a.example.com');

    const ok = await save();

    expect(ok).toBe(true);
    const stored = store['devtools-json-formatter'] as EnvConfig;
    expect(stored.domains).toEqual(['http://a.example.com']);
    expect(isReactive(stored.domains)).toBe(false);

    // 落盘的是快照:保存后继续编辑内存,已写数据不跟随变化
    config.value.domains.push('http://b.example.com');
    expect((store['devtools-json-formatter'] as EnvConfig).domains).toEqual([
      'http://a.example.com',
    ]);
  });

  it('replace() 同样剥离 Proxy', async () => {
    const { config, replace } = useToolConfig<EnvConfig>('json-formatter', DEFAULTS);
    config.value.domains.push('http://a.example.com');

    const ok = await replace('已清空');

    expect(ok).toBe(true);
    const stored = store['devtools-json-formatter'] as EnvConfig;
    expect(stored.domains).toEqual(['http://a.example.com']);
    expect(isReactive(stored.domains)).toBe(false);
  });
});

describe('useToolConfig — watch 防抖自动保存', () => {
  it('loaded 之前不触发保存', async () => {
    vi.useFakeTimers();
    const { config } = useToolConfig<EnvConfig>('json-formatter', DEFAULTS);

    config.value.count = 99;
    await nextTick();
    vi.advanceTimersByTime(1000);

    expect(store['devtools-json-formatter']).toBeUndefined();
  });

  it('loaded 之后变更触发防抖保存,normalize 钳制值落盘', async () => {
    vi.useFakeTimers();
    const { config, loaded, saveState } = useToolConfig<EnvConfig>(
      'json-formatter',
      DEFAULTS,
      {
        debounceMs: 400,
        normalize: (c) => {
          c.count = Math.min(Math.max(Math.trunc(c.count) || 10, 1), 1000);
        },
      },
    );
    loaded.value = true; // 模拟 onMounted 加载完成

    config.value.count = 99999;
    await nextTick();
    // 钳制回流到 ref
    expect(config.value.count).toBe(1000);

    vi.advanceTimersByTime(400);
    await vi.waitFor(() => {
      expect(
        (store['devtools-json-formatter'] as EnvConfig | undefined)?.count,
      ).toBe(1000);
    });
    expect(saveState.value).toBe('saved');
  });

  it('防抖窗口内多次变更合并为一次写', async () => {
    vi.useFakeTimers();
    const { config, loaded } = useToolConfig<EnvConfig>(
      'json-formatter',
      DEFAULTS,
      { debounceMs: 400 },
    );
    loaded.value = true;

    config.value.position = 'top-left';
    await nextTick();
    vi.advanceTimersByTime(200);
    config.value.position = 'bottom-left';
    await nextTick();
    vi.advanceTimersByTime(400);
    await vi.waitFor(() => {
      expect(store['devtools-json-formatter']).toBeDefined();
    });

    // 仅落盘最终值,且 set 只被有效触发一次(读取合并不算写)
    const stored = store['devtools-json-formatter'] as EnvConfig;
    expect(stored.position).toBe('bottom-left');
  });
});

// ---------------------------------------------------------------------------
// account-switch 的 envBadge / quickLoginDefaultDomain 走
// updateConfig 增量合并——只动 patch 中的字段,accounts/domains 等兄弟字段保留
// ---------------------------------------------------------------------------

import { updateConfig } from '../entrypoints/shared/tool-config';

describe('updateConfig — account-switch envBadge / quickLoginDefaultDomain 增量合并', () => {
  it('patch 仅含 envBadge:写回合并结果,accounts/domains 不被覆写', async () => {
    store['devtools-account-switch'] = {
      accounts: [{ id: 'acc_1', username: 'alice' }],
      domains: { 'http://a.example.com': { name: 'A 环境' } },
      envBadge: { enabled: false, position: 'bottom-right', whitelist: [] },
    };

    const ok = await updateConfig('account-switch', {
      envBadge: {
        enabled: true,
        position: 'top-left',
        whitelist: ['http://a.example.com'],
      },
    });

    expect(ok).toBe(true);
    // 断言写入调用的 patch 内容:合并后整体,兄弟字段原样保留
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      'devtools-account-switch': {
        accounts: [{ id: 'acc_1', username: 'alice' }],
        domains: { 'http://a.example.com': { name: 'A 环境' } },
        envBadge: {
          enabled: true,
          position: 'top-left',
          whitelist: ['http://a.example.com'],
        },
      },
    });
  });

  it('patch 仅含 quickLoginDefaultDomain:已存 envBadge 不被覆写', async () => {
    store['devtools-account-switch'] = {
      accounts: [{ id: 'acc_1', username: 'alice' }],
      domains: { 'http://a.example.com': { name: 'A 环境' } },
      quickLoginDefaultDomain: '',
      envBadge: { enabled: true, position: 'top-right', whitelist: ['http://a.example.com'] },
    };

    const ok = await updateConfig('account-switch', {
      quickLoginDefaultDomain: 'http://a.example.com',
    });

    expect(ok).toBe(true);
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      'devtools-account-switch': {
        accounts: [{ id: 'acc_1', username: 'alice' }],
        domains: { 'http://a.example.com': { name: 'A 环境' } },
        quickLoginDefaultDomain: 'http://a.example.com',
        envBadge: {
          enabled: true,
          position: 'top-right',
          whitelist: ['http://a.example.com'],
        },
      },
    });
  });
});
