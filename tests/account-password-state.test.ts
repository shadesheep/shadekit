import { describe, expect, it } from 'vitest';
import { accountPasswordSummary } from '../entrypoints/tools/account-switch/account-password-state';
import type { Account, DomainConfig } from '../entrypoints/tools/account-switch/types';

const account: Account = { id: 'a', name: 'A', username: 'a', roles: [], domains: [] };
const empty: DomainConfig = { name: '空环境', tags: [] };
const configured: DomainConfig = { ...empty, defaultPassword: 'fixture-environment-password' };

describe('账号表格密码来源', () => {
  it('优先显示账号自己的凭据，不受环境默认值影响', () => {
    expect(accountPasswordSummary({ ...account, password: 'fixture-account-password' }, [configured, empty], true).label).toBe('账号密码');
  });
  it('多个绑定中只有一个有默认密码时，提示部分环境未配置', () => {
    expect(accountPasswordSummary(account, [configured, empty], false)).toMatchObject({ label: '按环境配置', missing: true });
  });
  it('选中无默认密码的环境时，不借用其他环境的默认密码', () => {
    expect(accountPasswordSummary(account, [empty], false)).toMatchObject({ label: '未配置', missing: true });
  });
  it('单环境按环境默认、全局默认的顺序回退', () => {
    expect(accountPasswordSummary(account, [configured], true).label).toBe('环境默认');
    expect(accountPasswordSummary(account, [empty], true).label).toBe('全局默认');
  });
  it('环境和全局默认混用时保留来源差异，但不标为缺失', () => {
    expect(accountPasswordSummary(account, [configured, empty], true)).toMatchObject({ label: '按环境配置', missing: false });
  });
  it('全部关联环境有默认密码时显示环境默认', () => {
    expect(accountPasswordSummary(account, [configured, configured], false)).toMatchObject({ label: '环境默认', missing: false });
  });
  it('未关联环境的账号仍可准确显示全局默认或未配置', () => {
    expect(accountPasswordSummary(account, [], true).label).toBe('全局默认');
    expect(accountPasswordSummary(account, [], false).missing).toBe(true);
  });
});
