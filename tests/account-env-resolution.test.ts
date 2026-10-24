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
});
