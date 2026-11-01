import { getConfig } from "../../shared/tool-config";
import { resolveSecret } from "../../shared/security/vault-service";
import { SecurityError } from "../../shared/security/errors";
import { resolveEnvironment } from "./account-view";
import { readSpecFromConfig } from "./spec/migrate";
import type { LoginSpec } from "./spec/types";
import type {
  Account,
  AccountSwitchConfig,
  DomainConfig,
  StrategyEntry,
} from "./types";

async function requiredSecret(credentialRef: string): Promise<string> {
  const value = await resolveSecret(credentialRef);
  if (value === undefined) {
    throw new SecurityError("VAULT_UNAVAILABLE", "保险库引用缺少对应秘密");
  }
  return value;
}

export async function resolveAccountPassword(account: Account): Promise<string> {
  return account.credentialRef
    ? requiredSecret(account.credentialRef)
    : (account.password ?? "");
}

export async function resolveDefaultPassword(
  config: AccountSwitchConfig,
  origin: string,
): Promise<string | undefined> {
  const environment = resolveEnvironment(origin, config.domains);
  if (environment?.env.defaultCredentialRef) {
    const value = await requiredSecret(environment.env.defaultCredentialRef);
    if (value) return value;
  } else if (environment?.env.defaultPassword) {
    return environment.env.defaultPassword;
  }
  if (config.globalDefaultCredentialRef) {
    const value = await requiredSecret(config.globalDefaultCredentialRef);
    if (value) return value;
  } else if (config.globalDefaultPassword) {
    return config.globalDefaultPassword;
  }
  return undefined;
}

/**
 * 账号密码 → 环境默认密码 → 全局默认密码，与 account-view.resolvePassword
 * 保持同一语义：空字符串视为「未设置」，账号的显式空密码会继续回退；
 * 要真正停用账号密码应清除 credentialRef。
 */
export async function resolveLoginPassword(
  account: Account,
  config: AccountSwitchConfig,
  origin: string,
): Promise<string> {
  return (
    (await resolveAccountPassword(account)) ||
    (await resolveDefaultPassword(config, origin)) ||
    ""
  );
}

export interface ResolvedSpecSecrets {
  domainConfig: DomainConfig;
  secrets: string[];
}

export async function resolveSpecSecrets(
  domainConfig: DomainConfig,
  spec: LoginSpec,
  strategies: Record<string, StrategyEntry> | undefined,
): Promise<ResolvedSpecSecrets> {
  const secretVariables = (spec.vars ?? []).filter((variable) => variable.secret);
  if (secretVariables.length === 0) return { domainConfig, secrets: [] };
  const strategy = domainConfig.strategyId ? strategies?.[domainConfig.strategyId] : undefined;
  const declarationRefs = domainConfig.strategyConfig?.spec
    ? domainConfig.strategyConfig.secretVarRefs
    : strategy?.secretVarRefs;
  const vars = { ...(domainConfig.vars ?? {}) };
  const secrets: string[] = [];
  for (const variable of secretVariables) {
    const overrideRef = domainConfig.secretVarRefs?.[variable.name];
    const defaultRef = declarationRefs?.[variable.name];
    const override = overrideRef ? await requiredSecret(overrideRef) : undefined;
    const fallback = override === undefined && defaultRef
      ? await requiredSecret(defaultRef)
      : undefined;
    if (override !== undefined) secrets.push(override);
    if (fallback !== undefined) secrets.push(fallback);
    const value = override !== undefined && override !== "" ? override : fallback;
    if (value !== undefined) vars[variable.name] = value;
  }
  return { domainConfig: { ...domainConfig, vars }, secrets };
}

export async function resolveLoginSecrets(
  accountId: string,
  environmentId: string,
): Promise<ResolvedSpecSecrets & { password: string; spec: LoginSpec }> {
  const config = await getConfig<AccountSwitchConfig>("account-switch");
  const account = config?.accounts.find((candidate) => candidate.id === accountId);
  const domainConfig = config?.domains[environmentId];
  if (!config || !account || !domainConfig) {
    throw new SecurityError("CONFIG_INVALID", "账号或环境不存在");
  }
  const { spec } = readSpecFromConfig(domainConfig, config.strategies);
  if (!spec) throw new SecurityError("CONFIG_INVALID", "环境缺少有效登录声明");
  const [password, resolved] = await Promise.all([
    resolveAccountPassword(account),
    resolveSpecSecrets(domainConfig, spec, config.strategies),
  ]);
  return { password, spec, ...resolved };
}
