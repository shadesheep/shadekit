import { describe, it, expect } from 'vitest';

/**
 * 视图投影层测试（ADR-0017）
 *
 * account-env-view.ts 的纯函数投影：
 * - buildEnvGroups：扁平配置 → 主视图环境分组（S3 seam）
 * - deriveEnvTag：URL → 环境类型推断（local/test，不猜 prod）
 * - tagColor / normalizeEnvTag：tag 精确颜色映射
 *   （取代 ENV_COLORS 的 includes 子串匹配——「输入『本地』就是灰的」根因）
 */

import {
  buildEnvGroups,
  deriveEnvTag,
  normalizeEnvTag,
  removeEnvironment,
  tagColor,
  ENV_TAG_FALLBACK_COLOR,
} from '../entrypoints/tools/account-switch/account-env-view';
import type { Account, DomainConfig } from '../entrypoints/tools/account-switch/types';

function env(partial: Partial<DomainConfig> = {}): DomainConfig {
  return { name: 'env', tags: [], ...partial };
}

function acc(partial: Partial<Account> & { id: string }): Account {
  return {
    name: partial.id,
    username: partial.id,
    password: '',
    roles: [],
    domains: [],
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// buildEnvGroups
// ---------------------------------------------------------------------------

describe('buildEnvGroups — 主视图环境分组', () => {
  it('多环境多账号：按 domains key 插入顺序分组，账号归入绑定环境', () => {
    const cfg = {
      domains: {
        'https://b.example.com': env({ name: 'B' }),
        'http://localhost:8888': env({ name: 'A' }),
      },
      accounts: [
        acc({ id: 'a1', domains: ['http://localhost:8888'] }),
        acc({ id: 'a2', domains: ['https://b.example.com'] }),
        acc({ id: 'a3', domains: ['http://localhost:8888'] }),
      ],
    };
    const { groups, unbound } = buildEnvGroups(cfg);
    expect(groups.map((g) => g.key)).toEqual([
      'https://b.example.com',
      'http://localhost:8888',
    ]);
    expect(groups[0].accounts.map((a) => a.id)).toEqual(['a2']);
    expect(groups[1].accounts.map((a) => a.id)).toEqual(['a1', 'a3']);
    expect(unbound).toEqual([]);
  });

  it('多对多：一个账号绑定多个环境时出现在每个组', () => {
    const cfg = {
      domains: {
        'http://a.com': env(),
        'http://b.com': env(),
      },
      accounts: [acc({ id: 'a1', domains: ['http://a.com', 'http://b.com'] })],
    };
    const { groups, unbound } = buildEnvGroups(cfg);
    expect(groups[0].accounts.map((a) => a.id)).toEqual(['a1']);
    expect(groups[1].accounts.map((a) => a.id)).toEqual(['a1']);
    expect(unbound).toEqual([]);
  });

  it('未绑定账号（domains 为空）单列 unbound', () => {
    const cfg = {
      domains: { 'http://a.com': env() },
      accounts: [acc({ id: 'free' })],
    };
    const { groups, unbound } = buildEnvGroups(cfg);
    expect(groups[0].accounts).toEqual([]);
    expect(unbound.map((a) => a.id)).toEqual(['free']);
  });

  it('脏数据：绑定了不存在环境 key 的账号不丢、不崩，归入 unbound', () => {
    const cfg = {
      domains: { 'http://a.com': env() },
      accounts: [acc({ id: 'ghost', domains: ['http://gone.com'] })],
    };
    const { groups, unbound } = buildEnvGroups(cfg);
    expect(groups[0].accounts).toEqual([]);
    expect(unbound.map((a) => a.id)).toEqual(['ghost']);
  });

  it('部分绑定有效：归入有效组，不进 unbound', () => {
    const cfg = {
      domains: { 'http://a.com': env() },
      accounts: [acc({ id: 'a1', domains: ['http://gone.com', 'http://a.com'] })],
    };
    const { groups, unbound } = buildEnvGroups(cfg);
    expect(groups[0].accounts.map((a) => a.id)).toEqual(['a1']);
    expect(unbound).toEqual([]);
  });

  it('组内账号顺序沿用 config.accounts 顺序', () => {
    const cfg = {
      domains: { 'http://a.com': env() },
      accounts: [
        acc({ id: 'z', domains: ['http://a.com'] }),
        acc({ id: 'm', domains: ['http://a.com'] }),
        acc({ id: 'b', domains: ['http://a.com'] }),
      ],
    };
    const { groups } = buildEnvGroups(cfg);
    expect(groups[0].accounts.map((a) => a.id)).toEqual(['z', 'm', 'b']);
  });

  it('空配置返回空分组与空 unbound', () => {
    expect(buildEnvGroups({ accounts: [], domains: {} })).toEqual({
      groups: [],
      unbound: [],
    });
  });
});

describe('removeEnvironment — 删除环境与账号绑定', () => {
  it('同步清除账号引用且不改原数据，重建同地址环境不会恢复旧绑定', () => {
    const key = 'http://localhost:8888';
    const other = 'https://test.example.com';
    const original = {
      domains: { [key]: env({ name: '本地' }), [other]: env({ name: '测试' }) },
      accounts: [
        acc({ id: 'a1', domains: [key, other] }),
        acc({ id: 'a2', domains: [other] }),
      ],
    };

    const next = removeEnvironment(original, key);

    expect(next.domains).toEqual({ [other]: original.domains[other] });
    expect(next.accounts[0].domains).toEqual([other]);
    expect(next.accounts[1]).toBe(original.accounts[1]);
    expect(original.accounts[0].domains).toEqual([key, other]);

    next.domains[key] = env({ name: '重建的本地环境' });
    expect(buildEnvGroups(next).groups.find((group) => group.key === key)?.accounts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deriveEnvTag
// ---------------------------------------------------------------------------

describe('deriveEnvTag — 环境类型推断', () => {
  it('localhost / 回环 / 私有网段 → local', () => {
    expect(deriveEnvTag('http://localhost:8888')).toBe('local');
    expect(deriveEnvTag('https://localhost')).toBe('local');
    expect(deriveEnvTag('http://127.0.0.1:3000')).toBe('local');
    expect(deriveEnvTag('http://127.1.2.3')).toBe('local');
    expect(deriveEnvTag('http://10.0.0.5')).toBe('local');
    expect(deriveEnvTag('http://172.16.1.1')).toBe('local');
    expect(deriveEnvTag('http://172.31.255.1')).toBe('local');
    expect(deriveEnvTag('http://192.168.1.10')).toBe('local');
    expect(deriveEnvTag('http://[::1]:8080')).toBe('local');
    expect(deriveEnvTag('http://app.localhost')).toBe('local');
  });

  it('host 含 test / dev / staging → test', () => {
    expect(deriveEnvTag('https://test.example.com')).toBe('test');
    expect(deriveEnvTag('https://api.dev.example.com')).toBe('test');
    expect(deriveEnvTag('https://staging.example.com')).toBe('test');
  });

  it('host 含 uat → uat', () => {
    expect(deriveEnvTag('https://uat.example.com')).toBe('uat');
    expect(deriveEnvTag('https://api.uat.example.com')).toBe('uat');
  });

  it('其余可解析的 http(s) origin → undefined（不猜成 prod）', () => {
    expect(deriveEnvTag('https://api.example.com')).toBeUndefined();
    expect(deriveEnvTag('https://prod.example.com')).toBeUndefined();
  });

  it('省略协议按 http 解析；不可解析或非 http(s) → undefined', () => {
    expect(deriveEnvTag('localhost:8888')).toBe('local');
    expect(deriveEnvTag('')).toBeUndefined();
    expect(deriveEnvTag('not a url :::')).toBeUndefined();
    expect(deriveEnvTag('ftp://files.example.com')).toBeUndefined();
  });

  it('172.32 不是私有网段（掩码边界）', () => {
    expect(deriveEnvTag('http://172.32.0.1')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// tagColor / normalizeEnvTag
// ---------------------------------------------------------------------------

import { ACCOUNT_COLORS, accountColorIndex } from '../entrypoints/tools/account-switch/account-palette';

describe('tagColor — 按 tag 名哈希取 10 色池（prod 钉红色）', () => {
  const paletteFg = (tag: string) => ACCOUNT_COLORS[accountColorIndex(tag)].light.fg;

  it('prod / 生产 永远命中索引 0 的红色（警示语义 pin）', () => {
    expect(ACCOUNT_COLORS[0].label).toBe('红');
    expect(tagColor('prod')).toBe(ACCOUNT_COLORS[0].light.fg);
    expect(tagColor('生产')).toBe(ACCOUNT_COLORS[0].light.fg);
    expect(tagColor('PROD')).toBe(ACCOUNT_COLORS[0].light.fg);
  });

  it('其他预设 tag 按名字哈希取色池色', () => {
    expect(tagColor('local')).toBe(paletteFg('local'));
    expect(tagColor('test')).toBe(paletteFg('test'));
    expect(tagColor('uat')).toBe(paletteFg('uat'));
  });

  it('中文别名与英文同 tag → 同色', () => {
    expect(tagColor('本地')).toBe(paletteFg('local'));
    expect(tagColor('测试')).toBe(paletteFg('test'));
    expect(tagColor('预发')).toBe(paletteFg('uat'));
  });

  it('normalizeEnvTag 精确匹配：含 uat / 预发', () => {
    expect(normalizeEnvTag('uat')).toBe('uat');
    expect(normalizeEnvTag('UAT')).toBe('uat');
    expect(normalizeEnvTag('预发')).toBe('uat');
    expect(normalizeEnvTag('测试')).toBe('test');
    expect(normalizeEnvTag('生产')).toBe('prod');
  });

  it('英文 tag 大小写不敏感', () => {
    expect(tagColor('Local')).toBe(paletteFg('local'));
  });

  it('精确匹配取代 includes：「production」「local2」不再命中', () => {
    expect(tagColor('production')).toBe(ENV_TAG_FALLBACK_COLOR);
    expect(tagColor('local2')).toBe(ENV_TAG_FALLBACK_COLOR);
    expect(tagColor('contest')).toBe(ENV_TAG_FALLBACK_COLOR);
  });

  it('未识别与缺失 tag 回退默认灰', () => {
    expect(tagColor('别的')).toBe(ENV_TAG_FALLBACK_COLOR);
    expect(tagColor('')).toBe(ENV_TAG_FALLBACK_COLOR);
    expect(tagColor(undefined)).toBe(ENV_TAG_FALLBACK_COLOR);
  });
});
