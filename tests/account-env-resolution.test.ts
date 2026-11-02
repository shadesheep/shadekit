import { describe, it, expect } from 'vitest';

/**
 * 环境匹配链测试(第 5 轮架构评审 候选 #1)
 *
 * resolveEnvironment:origin → 环境匹配(SwitcherPanel / background 共用)
 */

import {
  resolveEnvironment,
} from '../entrypoints/tools/account-switch/account-view';
import type { DomainConfig } from '../entrypoints/tools/account-switch/types';

function env(partial: Partial<DomainConfig> = {}): DomainConfig {
  return { name: '测试环境', tags: [], ...partial };
}

describe('resolveEnvironment', () => {
  const domains: Record<string, DomainConfig> = {
    'https://prod.example.com': env({ name: '生产' }),
    '*.dev.example.com': env({ name: '开发', defaultPassword: 'dev123' }),
  };

  it('精确匹配命中并返回 domain key 与 env', () => {
    const r = resolveEnvironment('https://prod.example.com', domains);
    expect(r?.domain).toBe('https://prod.example.com');
    expect(r?.env.name).toBe('生产');
  });

  it('通配符匹配命中', () => {
    const r = resolveEnvironment('https://a.dev.example.com', domains);
    expect(r?.domain).toBe('*.dev.example.com');
    expect(r?.env.defaultPassword).toBe('dev123');
  });

  it('无匹配返回 undefined', () => {
    expect(resolveEnvironment('https://other.com', domains)).toBeUndefined();
  });

  it('origin 为空返回 undefined', () => {
    expect(resolveEnvironment('', domains)).toBeUndefined();
  });

  it('通配符 + 非默认端口命中具体子域', () => {
    const devDomains: Record<string, DomainConfig> = {
      'http://*.dev.example.com:16800': env({
        name: '开发',
        defaultPassword: 'dev-password',
      }),
    };
    const r = resolveEnvironment(
      'http://app.dev.example.com:16800',
      devDomains,
    );
    expect(r?.domain).toBe('http://*.dev.example.com:16800');
    expect(r?.env.defaultPassword).toBe('dev-password');
  });

  it('通配符 + 端口不一致不命中', () => {
    const devDomains: Record<string, DomainConfig> = {
      'http://*.dev.example.com:16800': env({ name: '开发' }),
    };
    expect(
      resolveEnvironment('http://app.dev.example.com:16801', devDomains),
    ).toBeUndefined();
  });

  it('通配符 + 协议不一致不命中', () => {
    const devDomains: Record<string, DomainConfig> = {
      'https://*.dev.example.com:16800': env({ name: '开发' }),
    };
    expect(
      resolveEnvironment('http://app.dev.example.com:16800', devDomains),
    ).toBeUndefined();
  });

  it('同一 origin 按路径作用域选中各自的环境', () => {
    const pathDomains: Record<string, DomainConfig> = {
      'https://app.example.com/management': env({
        name: '管理端',
        matchPath: '/management',
      }),
      'https://app.example.com/ebidding': env({
        name: '招采端',
        matchPath: '/ebidding',
      }),
    };
    expect(
      resolveEnvironment('https://app.example.com/management/#/home', pathDomains)?.env.name,
    ).toBe('管理端');
    expect(
      resolveEnvironment('https://app.example.com/ebidding/list', pathDomains)?.env.name,
    ).toBe('招采端');
    expect(
      resolveEnvironment('https://app.example.com/other', pathDomains),
    ).toBeUndefined();
  });

  it('路径按段边界匹配：/management 不命中 /management2', () => {
    const pathDomains: Record<string, DomainConfig> = {
      'https://app.example.com/management': env({ matchPath: '/management' }),
    };
    expect(
      resolveEnvironment('https://app.example.com/management2', pathDomains),
    ).toBeUndefined();
  });

  it('具体子域优先于通配符，即使通配符先配置', () => {
    const mixed: Record<string, DomainConfig> = {
      'https://*.example.com': env({ name: '家族兜底' }),
      'https://app.example.com': env({ name: '具体应用' }),
    };
    expect(
      resolveEnvironment('https://app.example.com/management', mixed)?.env.name,
    ).toBe('具体应用');
  });

  it('同 origin 下更长的路径作用域优先', () => {
    const nested: Record<string, DomainConfig> = {
      'https://app.example.com/management': env({
        name: '管理端',
        matchPath: '/management',
      }),
      'https://app.example.com/management/audit': env({
        name: '审计',
        matchPath: '/management/audit',
      }),
    };
    expect(
      resolveEnvironment('https://app.example.com/management/audit/log', nested)?.env.name,
    ).toBe('审计');
  });
});
