import { resolveEnvironment } from "./account-view";
import type { LoginSpec } from "./spec/types";
import type {
  Account,
  AccountSwitchConfig,
  DomainConfig,
} from "./types";

/** 账号密码 → 环境默认密码 → 全局默认密码，空字符串视为未设置。 */
export async function resolveAccountPassword(account: Account): Promise<string> {
  return account.password ?? "";
}

export async function resolveDefaultPassword(
  config: AccountSwitchConfig,
  target: string,
): Promise<string | undefined> {
  const environment = resolveEnvironment(target, config.domains);
  if (environment?.env.defaultPassword) return environment.env.defaultPassword;
  return config.globalDefaultPassword || undefined;
}

export async function resolveLoginPassword(
  account: Account,
  config: AccountSwitchConfig,
  target: string,
): Promise<string> {
  return (
    (await resolveAccountPassword(account)) ||
    (await resolveDefaultPassword(config, target)) ||
    ""
  );
}

export interface ResolvedSpecSecrets {
  domainConfig: DomainConfig;
  secrets: string[];
}

/**
 * 收集声明里 secret 变量的明文值，仅用于日志脱敏。
 * 取值优先级与执行器一致：环境覆盖 > 声明默认值。
 */
export async function resolveSpecSecrets(
  domainConfig: DomainConfig,
  spec: LoginSpec,
): Promise<ResolvedSpecSecrets> {
  const secrets: string[] = [];
  for (const variable of spec.vars ?? []) {
    if (variable.secret !== true) continue;
    const value = domainConfig.vars?.[variable.name] ?? variable.default;
    if (typeof value === "string" && value !== "") secrets.push(value);
  }
  return { domainConfig, secrets };
}
