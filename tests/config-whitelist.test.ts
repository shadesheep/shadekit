import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 「全部工具设置」导出/导入白名单（回归：导出配置里混入大量杂乱信息）
 *
 * 历史实现按 `devtools-` 前缀收全部 key，于是日志、迁移标记、已删子系统的
 * 残留键都被当作配置导出，导入时还会被回灌。现在改为注册表白名单。
 */

let store: Record<string, unknown>;

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

import {
  getAllConfig,
  isExportableConfigId,
  setAllConfig,
} from '../entrypoints/shared/config-transfer';
import { CONFIG_VERSION } from '../entrypoints/shared/tool-config';
import { allTools } from '../entrypoints/shared/tool-definitions';

beforeEach(() => {
  store = {};
});

/** 模拟一份被历史数据污染的真实存储 */
function seedPollutedStore() {
  store = {
    // ── 真配置 ──
    // envBadge 已就位 = v1 → v2 迁移跑过（启动顺序保证 cleanup 前完成）
    'devtools-account-switch': {
      accounts: [],
      domains: {},
      envBadge: { enabled: false, position: 'bottom-right', whitelist: [] },
    },
    'devtools-json-formatter': { indent: 2 },
    'devtools-state': { 'account-switch': true },
    'devtools-theme': 'light',
    // ── 日志（ADR-0016 D1 明确排除）──
    'devtools-logs': [{ id: 'log_1', message: 'token=secret' }],
    'devtools-account-switch-debug-logs': [{ id: 'dbg_1' }],
    'devtools-ext-debug-logs': [{ id: 'dbg_2' }],
    // ── 已删子系统 / 死键 ──
    'devtools-account-switch-extension-src': [{ extId: 'x', files: {} }],
    'devtools-account-switch-installed-extensions': [{ extId: 'x' }],
    'devtools-account-switch-enable-debug-log': true,
    'devtools-account-switch-ext-migration-v1': true,
    'devtools-account-recent': { recent: { 0: { id: 'acc_002' } } },
    'devtools-sync-migrated': true,
    'devtools-zentao-bridge': { domains: [] },
    'devtools-env-indicator': { domains: [], position: 'bottom-right' },
    // ── 迁移标记（本就不是配置）──
    'devtools-migrated': true,
    'devtools-config-version': 2,
    'devtools-dev-mode': true,
  };
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

describe('getAllConfig — 注册表白名单', () => {
  it('只导出各工具配置 + state + theme + __version', async () => {
    seedPollutedStore();

    const exported = await getAllConfig();

    expect(Object.keys(exported).sort()).toEqual(
      ['__version', 'account-switch', 'json-formatter', 'state', 'theme'].sort(),
    );
    expect(exported.__version).toBe(CONFIG_VERSION);
    expect(exported['account-switch']).toEqual({
      accounts: [],
      domains: {},
      envBadge: { enabled: false, position: 'bottom-right', whitelist: [] },
    });
  });

  it('日志与死键一律不进导出文件', async () => {
    seedPollutedStore();

    const exported = await getAllConfig();

    expect(exported).not.toHaveProperty('logs');
    expect(exported).not.toHaveProperty('account-switch-debug-logs');
    expect(exported).not.toHaveProperty('ext-debug-logs');
    expect(exported).not.toHaveProperty('account-switch-extension-src');
    expect(exported).not.toHaveProperty('account-recent');
    expect(exported).not.toHaveProperty('zentao-bridge');
    expect(exported).not.toHaveProperty('env-indicator');
    expect(exported).not.toHaveProperty('dev-mode');
    expect(exported).not.toHaveProperty('migrated');
  });

  it('注册表里每个工具 id 都算可导出', () => {
    for (const tool of allTools) {
      expect(isExportableConfigId(tool.id)).toBe(true);
    }
  });

  it('共享 key 可导出，未知 id 不可导出', () => {
    expect(isExportableConfigId('state')).toBe(true);
    expect(isExportableConfigId('theme')).toBe(true);
    expect(isExportableConfigId('logs')).toBe(false);
    expect(isExportableConfigId('whatever-cache')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

describe('setAllConfig — 导入侧同样过滤', () => {
  it('旧文件夹带的日志与死键不会回灌存储', async () => {
    await setAllConfig({
      __version: 2,
      'json-diff': { autoCompare: true },
      logs: [{ id: 'log_1' }],
      'account-switch-debug-logs': [{ id: 'dbg_1' }],
      'account-recent': { recent: {} },
      'zentao-bridge': { domains: [] },
    });

    expect(store['devtools-json-diff']).toEqual({ autoCompare: true });
    expect(store).not.toHaveProperty('devtools-logs');
    expect(store).not.toHaveProperty('devtools-account-switch-debug-logs');
    expect(store).not.toHaveProperty('devtools-account-recent');
    expect(store).not.toHaveProperty('devtools-zentao-bridge');
    expect(store).not.toHaveProperty('devtools-__version');
  });

  it('导入后再次导出得到同一份白名单（导出→导入→导出 收敛）', async () => {
    seedPollutedStore();
    const first = await getAllConfig();

    store = {};
    await setAllConfig(first);
    const second = await getAllConfig();

    expect(second).toEqual(first);
  });
});
