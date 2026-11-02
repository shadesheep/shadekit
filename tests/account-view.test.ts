import { describe, it, expect } from 'vitest';

/**
 * Account View Model 测试（ADR-0004 D6）
 *
 * Config.vue 与 SwitcherPanel 共享的账号视图纯函数：
 * - normalizeAccount：历史 `role` 单数字段兼容归一化
 * - filterAccounts：域 → 角色 → 搜索 三段过滤
 * - collectRoles：角色集合提取
 * - resolvePassword：密码回退优先级（输入 > 环境默认 > 全局默认）
 * - roleColor / roleColorStyle：角色色唯一来源（预设走 pin 表；自定义按名哈希取 10 色池）
 */

import {
  accountBoundToEnvironment,
  assertEnvironmentLoginSupported,
  buildAccountPanel,
  environmentLoginSupport,
  normalizeAccount,
  filterAccounts,
  collectRoles,
  collectRoleFilterOptions,
  resolvePassword,
  roleColor,
  roleColorStyle,
  ROLE_NAMES,
} from '../entrypoints/tools/account-switch/account-view';
import { ACCOUNT_COLORS, ACCOUNT_FALLBACK_COLOR, accountColorIndex } from '../entrypoints/tools/account-switch/account-palette';
import type { Account, DomainConfig } from '../entrypoints/tools/account-switch/types';
import * as accountView from '../entrypoints/tools/account-switch/account-view';

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

describe('normalizeAccount', () => {
  it('roles 数组优先，原样保留', () => {
    const a = normalizeAccount({
      id: 'a1', name: 'n', username: 'u', password: 'p',
      roles: ['管理员', '普通用户'], domains: [],
    });
    expect(a.roles).toEqual(['管理员', '普通用户']);
    expect(a.password).toBe('p');
  });

  it('roles 缺失时归一化为空数组', () => {
    const a = normalizeAccount({ id: 'a1', name: 'n', username: 'u', domains: [] });
    expect(a.roles).toEqual([]);
  });

  it('password 缺失时不凭空写入空明文字段', () => {
    const a = normalizeAccount({ id: 'a1', name: 'n', username: 'u', domains: [] });
    expect(a).not.toHaveProperty('password');
  });

  it('roles 非数组（脏数据）时归一化为空数组', () => {
    const a = normalizeAccount({
      id: 'a1', name: 'n', username: 'u',
      roles: '管理员' as unknown as string[], domains: [],
    });
    expect(a.roles).toEqual([]);
  });
});

describe('filterAccounts — 三段过滤', () => {
  const accounts: Account[] = [
    acc({ id: 'a1', name: '张三', username: 'zhangsan', roles: ['管理员'], domains: ['https://a.example.com'] }),
    acc({ id: 'a2', name: '李四', username: 'lisi', roles: ['普通用户'], domains: ['https://a.example.com', 'https://b.example.com'] }),
    acc({ id: 'a3', name: '王五', username: 'wangwu', roles: ['管理员', '访客'], domains: ['https://b.example.com'] }),
  ];

  it('无过滤条件时返回全部', () => {
    expect(filterAccounts(accounts, {})).toHaveLength(3);
  });

  it('按 origin 过滤（含通配符 domain）', () => {
    const withWildcard = [
      ...accounts,
      acc({ id: 'a4', username: 'wild', domains: ['https://*.example.com'] }),
    ];
    const result = filterAccounts(withWildcard, { origin: 'https://a.example.com' });
    expect(result.map((a) => a.id)).toEqual(['a1', 'a2', 'a4']);
  });

  it('origin 为空串时不做域过滤', () => {
    expect(filterAccounts(accounts, { origin: '' })).toHaveLength(3);
  });

  it('按角色过滤', () => {
    const result = filterAccounts(accounts, { role: '管理员' });
    expect(result.map((a) => a.id)).toEqual(['a1', 'a3']);
  });

  it('按搜索词过滤（name / username，大小写不敏感）', () => {
    expect(filterAccounts(accounts, { query: 'LISI' }).map((a) => a.id)).toEqual(['a2']);
    expect(filterAccounts(accounts, { query: '王' }).map((a) => a.id)).toEqual(['a3']);
  });

  it('三段组合：域 → 角色 → 搜索', () => {
    const result = filterAccounts(accounts, {
      origin: 'https://b.example.com',
      role: '管理员',
      query: 'wang',
    });
    expect(result.map((a) => a.id)).toEqual(['a3']);
  });

  it('输入非数组时返回空数组（脏配置防御）', () => {
    expect(filterAccounts(null as unknown as Account[], { query: 'x' })).toEqual([]);
  });

  it('路径作用域：具体绑定不跨路径，通配符绑定全家族可见', () => {
    const scopedDomains: Record<string, DomainConfig> = {
      'https://*.example.com': { name: '家族', tags: [] },
      'https://app.example.com': { name: '整站', tags: [] },
      'https://app.example.com/management': {
        name: '管理端',
        tags: [],
        matchPath: '/management',
      },
      'https://app.example.com/ebidding': {
        name: '招采端',
        tags: [],
        matchPath: '/ebidding',
      },
    };
    const scoped = [
      acc({ id: 'wild', domains: ['https://*.example.com'] }),
      acc({ id: 'mgmt', domains: ['https://app.example.com/management'] }),
      acc({ id: 'bid', domains: ['https://app.example.com/ebidding'] }),
      acc({ id: 'origin', domains: ['https://app.example.com'] }),
    ];
    const management = filterAccounts(scoped, {
      origin: 'https://app.example.com/management/dashboard',
      domains: scopedDomains,
    });
    // 整站绑定覆盖所有路径，具体路径绑定只在本路径可见
    expect(management.map((a) => a.id)).toEqual(['wild', 'mgmt', 'origin']);
  });
});

describe('collectRoles', () => {
  it('汇总全部账号角色并去重', () => {
    const roles = collectRoles([
      acc({ id: 'a1', roles: ['管理员', '普通用户'] }),
      acc({ id: 'a2', roles: ['普通用户', '访客'] }),
      acc({ id: 'a3', roles: [] }),
    ]);
    expect(roles).toEqual(['管理员', '普通用户', '访客']);
  });
});

describe('collectRoleFilterOptions — 角色筛选项按现有数据生成', () => {
  it('只展示账号数据中实际出现的角色', () => {
    const options = collectRoleFilterOptions([
      acc({ id: 'a1', roles: ['管理员'] }),
      acc({ id: 'a2', roles: ['访客', '自定义角色'] }),
    ]);
    expect(options).toEqual(['管理员', '访客', '自定义角色']);
  });

  it('预设角色按 ROLE_NAMES 顺序在前，自定义角色按首次出现顺序在后', () => {
    const options = collectRoleFilterOptions([
      acc({ id: 'a1', roles: ['自定义A', '访客'] }),
      acc({ id: 'a2', roles: ['普通用户', '自定义B'] }),
    ]);
    expect(options).toEqual(['普通用户', '访客', '自定义A', '自定义B']);
  });

  it('账号无角色时返回空列表（不展示空筛选条）', () => {
    expect(collectRoleFilterOptions([])).toEqual([]);
    expect(collectRoleFilterOptions([acc({ id: 'a1', roles: [] })])).toEqual([]);
  });

  it('非数组输入返回空列表（脏配置防御）', () => {
    expect(collectRoleFilterOptions(null as unknown as Account[])).toEqual([]);
  });
});

describe('resolvePassword — 回退优先级', () => {
  it('用户输入优先于一切', () => {
    expect(resolvePassword({ input: 'typed', envDefault: 'env', globalDefault: 'global' })).toBe('typed');
  });

  it('无输入时回退到环境默认密码', () => {
    expect(resolvePassword({ input: '', envDefault: 'env', globalDefault: 'global' })).toBe('env');
    expect(resolvePassword({ envDefault: 'env' })).toBe('env');
  });

  it('无环境默认时回退到全局默认密码', () => {
    expect(resolvePassword({ input: '', globalDefault: 'global' })).toBe('global');
  });

  it('三级全缺时返回 undefined', () => {
    expect(resolvePassword({})).toBeUndefined();
    expect(resolvePassword({ input: '', envDefault: '', globalDefault: '' })).toBeUndefined();
  });
});

describe('ROLE_NAMES — 预定义角色单源', () => {
  it('三个预定义角色，顺序固定', () => {
    expect(ROLE_NAMES).toEqual(['管理员', '普通用户', '访客']);
  });
});

describe('roleColor / roleColorStyle — 预设走 pin 表，自定义按名哈希', () => {
  it('管理员 → 琥珀（pin 索引 1）', () => {
    const style = roleColorStyle('管理员');
    expect(style['--role-light-bg']).toBe('#fef3c7');
    expect(style['--role-light-fg']).toBe('#92400e');
    expect(roleColor('管理员')).toBe('#92400e');
  });

  it('普通用户 → 蓝（pin 索引 6）', () => {
    const style = roleColorStyle('普通用户');
    expect(style['--role-light-bg']).toBe('#dbeafe');
    expect(style['--role-light-fg']).toBe('#1e40af');
    expect(roleColor('普通用户')).toBe('#1e40af');
  });

  it('访客 → 石板回退（pin fallback）', () => {
    const style = roleColorStyle('访客');
    expect(style['--role-light-bg']).toBe('#e2e8f0');
    expect(style['--role-light-fg']).toBe('#1e293b');
    expect(roleColor('访客')).toBe('#1e293b');
    expect(roleColor('访客')).toBe(ACCOUNT_FALLBACK_COLOR.light.fg);
  });

  it('自定义角色按名哈希取色池索引 1–9（不落在琥珀/蓝/石板）', () => {
    // '自定义abc' 哈希到索引 8 洋红，避开 pin 占用的 1 琥珀 / 6 蓝 / 石板回退
    const style = roleColorStyle('自定义abc');
    const fg = style['--role-light-fg'];
    expect(fg).not.toBe('#92400e'); // 琥珀
    expect(fg).not.toBe('#1e40af'); // 蓝
    expect(fg).not.toBe('#1e293b'); // 石板
    const idx = accountColorIndex('自定义abc'.toLowerCase());
    expect(idx).toBeGreaterThanOrEqual(1);
    expect(idx).toBeLessThanOrEqual(9);
    expect(style['--role-light-bg']).toBe(ACCOUNT_COLORS[idx].light.bg);
    expect(style['--role-light-fg']).toBe(ACCOUNT_COLORS[idx].light.fg);
  });

  it('同名恒同色：不同大小写/首尾空白不影响取色', () => {
    expect(roleColor('管理员')).toBe(roleColor('管理员'));
    expect(roleColor('管理员')).toBe(roleColor(' 管理员 '));
    expect(roleColorStyle('Admin')).toEqual(roleColorStyle('admin'));
  });

  it('空角色回退石板（专用回退槽，不参与哈希）', () => {
    expect(roleColor('')).toBe(ACCOUNT_FALLBACK_COLOR.light.fg);
    expect(roleColorStyle('')).toEqual({
      '--role-light-bg': ACCOUNT_FALLBACK_COLOR.light.bg,
      '--role-light-fg': ACCOUNT_FALLBACK_COLOR.light.fg,
      '--role-dark-bg': ACCOUNT_FALLBACK_COLOR.dark.bg,
      '--role-dark-fg': ACCOUNT_FALLBACK_COLOR.dark.fg,
    });
  });

  it('roleColor 与 roleColorStyle 同源（accent = 亮色 fg）', () => {
    for (const role of [...ROLE_NAMES, '自定义']) {
      expect(roleColor(role)).toBe(roleColorStyle(role)['--role-light-fg']);
    }
  });
});

describe('accountBoundToEnvironment — 绑定语义', () => {
  const domains: Record<string, DomainConfig> = {
    'https://*.example.com': { name: '家族', tags: [] },
    'https://app.example.com': { name: '应用', tags: [] },
    'https://app.example.com/management': {
      name: '管理端',
      tags: [],
      matchPath: '/management',
    },
    'https://app.example.com/ebidding': {
      name: '招采端',
      tags: [],
      matchPath: '/ebidding',
    },
  };

  it('精确环境 key → true', () => {
    expect(
      accountBoundToEnvironment(
        'https://app.example.com/management',
        'https://app.example.com/management',
        domains,
      ),
    ).toBe(true);
  });

  it('通配符绑定可以在任意具体子环境（含路径子环境）使用', () => {
    expect(
      accountBoundToEnvironment(
        'https://*.example.com',
        'https://app.example.com/management',
        domains,
      ),
    ).toBe(true);
  });

  it('具体路径绑定不跨路径泄漏', () => {
    expect(
      accountBoundToEnvironment(
        'https://app.example.com/ebidding',
        'https://app.example.com/management',
        domains,
      ),
    ).toBe(false);
  });

  it('整站绑定覆盖具体路径环境（与面板可见性同规则）', () => {
    expect(
      accountBoundToEnvironment(
        'https://app.example.com',
        'https://app.example.com/management',
        domains,
      ),
    ).toBe(true);
  });

  it('脏 key（环境不存在）回退 origin 匹配', () => {
    expect(
      accountBoundToEnvironment('https://app.example.com/legacy', 'https://app.example.com', domains),
    ).toBe(true);
  });
});

describe('buildAccountPanel — Content Script 公共 DTO', () => {
  it('同一 origin 按页面路径投影当前环境与账号', () => {
    const panel = buildAccountPanel({
      accounts: [
        acc({ id: 'mgmt', domains: ['https://app.example.com/management'] }),
        acc({ id: 'bid', domains: ['https://app.example.com/ebidding'] }),
        acc({ id: 'family', domains: ['https://*.example.com'] }),
      ],
      domains: {
        'https://app.example.com/management': {
          name: '管理端',
          tags: [],
          matchPath: '/management',
        },
        'https://app.example.com/ebidding': {
          name: '招采端',
          tags: [],
          matchPath: '/ebidding',
        },
      },
    }, 'https://app.example.com/ebidding/#/list');
    expect(panel.matchedEnvKey).toBe('https://app.example.com/ebidding');
    expect(panel.origin).toBe('https://app.example.com');
    expect(panel.accounts.map((a) => a.id)).toEqual(['bid', 'family']);
    expect(panel.domains['https://app.example.com/ebidding'].matchPath).toBe('/ebidding');
  });

  it('只公开当前环境账号和布尔密码提示，不泄露秘密、变量或策略库', () => {
    const build = (accountView as unknown as {
      buildAccountPanel?: (
        config: import('../entrypoints/tools/account-switch/types').AccountSwitchConfig,
        origin: string,
      ) => Record<string, unknown>;
    }).buildAccountPanel;
    expect(build).toBeTypeOf('function');

    const password = 'panel-account-password-91c7';
    const envPassword = 'panel-env-password-63b2';
    const globalPassword = 'panel-global-password-28d4';
    const secretVar = 'panel-secret-var-77e1';
    const panel = build!({
      accounts: [
        acc({ id: 'current', name: '当前账号', username: 'alice', password, roles: ['管理员'], domains: ['https://current.example.com'] }),
        acc({ id: 'other', name: '无关账号', username: 'bob', password: 'other-password', domains: ['https://other.example.com'] }),
      ],
      domains: {
        'https://current.example.com': {
          name: '当前环境', tags: ['test'], loginMethod: 'generic',
          defaultPassword: envPassword,
          debugRedirect: 'http://localhost:3000/bugs', debugRedirectEnabled: true,
          vars: { clientSecret: secretVar },
          strategyConfig: { spec: { version: 2, ops: [], success: [], auth: { mode: 'page' } } },
        },
        'https://other.example.com': { name: '其他环境', tags: [], defaultPassword: 'other-env-password' },
      },
      strategies: {
        private: { name: '私有策略', spec: { version: 2, ops: [], success: [], auth: { mode: 'page' } }, createdAt: 1, updatedAt: 1 },
      },
      globalDefaultPassword: globalPassword,
      quickLoginDefaultDomain: 'https://current.example.com',
      tabOrder: ['quicklogin', 'users'],
    }, 'https://current.example.com');

    expect(panel.accounts).toEqual([
      { id: 'current', name: '当前账号', username: 'alice', roles: ['管理员'], hasSavedPassword: true },
    ]);
    expect(panel.matchedEnvKey).toBe('https://current.example.com');
    expect(panel.tabOrder).toEqual(['quicklogin', 'users']);
    expect(panel.hasGlobalDefaultPassword).toBe(true);
    expect(panel.domains).toMatchObject({
      'https://current.example.com': {
        name: '当前环境', hasDefaultPassword: true,
        debugRedirect: 'http://localhost:3000/bugs', debugRedirectEnabled: true,
      },
    });
    const serialized = JSON.stringify(panel);
    for (const secret of [password, envPassword, globalPassword, secretVar, 'other-password', 'other-env-password']) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain('私有策略');
    expect(serialized).not.toContain('strategyConfig');
    expect(serialized).not.toContain('vars');
  });

  it('每次读取都从私有或镜像原始声明派生支持度，且只暴露不支持项', () => {
    const futureSpec = {
      version: 2,
      ops: [{ op: 'future.op', keep: true }],
      success: [{ page: { type: 'formGone' } }],
      auth: { mode: 'page' },
    };
    const supportedSpec = {
      version: 2,
      ops: [{ op: 'http.execute', url: '{origin}/login', as: 'resp' }],
      success: [{ response: { from: 'resp', path: 'ok' } }],
      auth: { mode: 'page' },
    };
    const config = {
      accounts: [],
      domains: {
        'https://supported.example.com': {
          name: '可用环境', tags: [],
          strategyConfig: { spec: supportedSpec },
        },
        'https://private-future.example.com': {
          name: '私有未来环境', tags: [],
          strategyConfig: { spec: futureSpec, declaredSpecVersion: 3 },
        },
        'https://mirror-future.example.com': {
          name: '镜像未来环境', tags: [], strategyId: 'future',
        },
      },
      strategies: {
        future: {
          name: '未来策略', spec: futureSpec,
          declaredSpecVersion: 3, createdAt: 1, updatedAt: 1,
        },
      },
    };

    const first = buildAccountPanel(config as never, '');
    expect(first.domains['https://supported.example.com']).not.toHaveProperty('support');
    expect(first.domains['https://private-future.example.com'].support).toMatchObject({
      supported: false,
    });
    expect(first.domains['https://private-future.example.com'].support?.issues[0]).toMatchObject({
      code: 'SPEC_VERSION_UNSUPPORTED',
    });
    expect(first.domains['https://mirror-future.example.com'].support).toMatchObject({
      supported: false,
    });
    expect(first.domains['https://mirror-future.example.com'].support?.issues[0]).toMatchObject({
      code: 'SPEC_VERSION_UNSUPPORTED',
    });
    expect(JSON.stringify(first)).not.toContain('"futureTop"');
    expect(JSON.stringify(first)).not.toContain('"ops"');

    // 支持度不落盘：持有人保持原样，升级策略后可立即重新派生。
    expect(config.domains['https://mirror-future.example.com']).not.toHaveProperty('support');
    expect(config.strategies.future).not.toHaveProperty('support');
    config.strategies.future.spec = supportedSpec as unknown as typeof futureSpec;
    delete (config.strategies.future as { declaredSpecVersion?: number }).declaredSpecVersion;
    expect(buildAccountPanel(config as never, '').domains['https://mirror-future.example.com'])
      .not.toHaveProperty('support');
  });
});

describe('assertEnvironmentLoginSupported — 旧版本迁移输入', () => {
  const legacySpec = {
    version: 1,
    template: 'legacy',
    steps: [
      { op: 'goto', url: '{origin}/login' },
      { op: 'fill', target: '#u', value: '{username}' },
      { op: 'fill', target: '#p', value: '{password}' },
      { op: 'click', target: '#go' },
    ],
    settle: { type: 'any', of: [{ type: 'formGone' }] },
    auth: { mode: 'page' },
  };

  it('可迁移的 v1 不标记为不支持，且不写回原始声明', () => {
    const environment = {
      name: '旧版环境',
      tags: [],
      strategyConfig: { spec: legacySpec },
    };

    expect(environmentLoginSupport(environment)).toEqual({
      supported: true,
      issues: [],
    });
    const executable = assertEnvironmentLoginSupported(environment);
    expect(executable.version).toBe(2);
    expect(environment.strategyConfig.spec).toEqual(legacySpec);
  });
});
