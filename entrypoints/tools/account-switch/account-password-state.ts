import type { Account, DomainConfig } from './types';

/** 只投影密码来源，不解析凭据内容；多环境视图不能将某个环境的默认值当作全部可用。 */
export function accountPasswordSummary(
  account: Account,
  environments: DomainConfig[],
  hasGlobalPassword: boolean,
): { label: string; missing: boolean; detail: string } {
  if (account.password) {
    return { label: '账号密码', missing: false, detail: '使用账号独立配置的密码' };
  }
  const sources = (environments.length ? environments : [undefined]).map(env =>
    env?.defaultPassword
      ? '环境默认'
      : hasGlobalPassword ? '全局默认' : '未配置',
  );
  const missing = sources.filter(source => source === '未配置').length;
  const mixed = new Set(sources).size > 1;
  return {
    label: mixed ? '按环境配置' : sources[0],
    missing: missing > 0,
    detail: mixed
      ? `${sources.length - missing} 个关联环境有可用密码，${missing} 个未配置；选择具体环境可查看来源`
      : sources[0] === '环境默认' ? '使用当前关联环境的默认密码'
        : sources[0] === '全局默认' ? '使用全局默认密码'
          : '未配置账号密码、环境默认密码或全局默认密码',
  };
}
