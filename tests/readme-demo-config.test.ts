import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateLoginSpec } from '../entrypoints/tools/account-switch/spec/validate';
import type { Account, DomainConfig } from '../entrypoints/tools/account-switch/types';
import type { LoginSpec } from '../entrypoints/tools/account-switch/spec/types';

interface DemoConfig {
  origin: string;
  accounts: Account[];
  environment: DomainConfig;
  envBadge: { enabled: boolean; whitelist: string[] };
}

const config = JSON.parse(readFileSync(new URL('../docs/readme-demo/demo-config.json', import.meta.url), 'utf8')) as DemoConfig;

describe('README 虚构演示配置', () => {
  it('使用保留的 .test 域名，并让账号只属于该演示环境', () => {
    expect(new URL(config.origin).hostname).toBe('studio.shadesheep.test');
    expect(config.accounts).toHaveLength(2);
    expect(new Set(config.accounts.map((account) => account.username))).toEqual(new Set(['admin@shadesheep.test', 'tester@shadesheep.test']));
    for (const account of config.accounts) {
      expect(account.domains).toEqual([config.origin]);
      expect(account.password).toBe('shadesheep-demo');
      expect(['管理员', '普通用户']).toContain(account.roles[0]);
    }
  });

  it('用真实通用登录声明填充两个虚构凭据并进入登录页', () => {
    const spec: LoginSpec | undefined = config.environment.strategyConfig?.spec;
    expect(spec).toBeDefined();
    if (!spec) throw new Error('Demo config must include a LoginSpec');
    expect(validateLoginSpec(spec)).toEqual([]);
    expect(spec.ops.some((op) => op.op === 'goto' && op.url === '{origin}/login')).toBe(true);
    expect(spec.ops.some((op) => op.op === 'fill' && op.value === '{username}')).toBe(true);
    expect(spec.ops.some((op) => op.op === 'fill' && op.value === '{password}')).toBe(true);
    expect(spec.auth.mode).toBe('page');
  });

  it('启用仅当前演示环境的环境指示器', () => {
    expect(config.envBadge).toMatchObject({ enabled: true, whitelist: [config.origin] });
  });
});
