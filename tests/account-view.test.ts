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
import type { Account } from '../entrypoints/tools/account-switch/types';

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

  it('password 缺失时归一化为空字符串', () => {
    const a = normalizeAccount({ id: 'a1', name: 'n', username: 'u', domains: [] });
    expect(a.password).toBe('');
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
