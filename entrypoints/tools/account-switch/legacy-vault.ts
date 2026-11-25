/**
 * 旧版「保险库」一次性迁移：把加密保存的密码/秘密还原成普通配置里的明文。
 *
 * 新版本不再加密本地密码，配置直接保存明文；本模块只在读取配置前运行一次，
 * 迁移成功后删除保险库密文、元数据与遗留日志。迁移失败时配置保持原样，
 * 不会丢引用（后续可重试）。
 */
import {
  MIGRATION_RECOVERY_KEY,
  resolveSecret,
  VAULT_META_KEY,
  VAULT_STORAGE_KEY,
} from "../../shared/security/vault-service";
import { SecurityError } from "../../shared/security/errors";
import type { AccountSwitchConfig, Account, DomainConfig, StrategyEntry } from "./types";

const CONFIG_KEY = "devtools-account-switch";
const MIGRATION_JOURNAL_KEY = "devtools-account-switch-migration-journal";
const IMPORT_JOURNAL_KEY = "devtools-account-switch-import-journal";

type LegacyStrategyEntry = StrategyEntry & {
  secretVarRefs?: Record<string, string>;
};

type LegacyDomainConfig = Omit<DomainConfig, "strategyConfig"> & {
  defaultCredentialRef?: string;
  secretVarRefs?: Record<string, string>;
  strategyConfig?: NonNullable<DomainConfig["strategyConfig"]> & {
    secretVarRefs?: Record<string, string>;
  };
};

type LegacyAccountSwitchConfig = Omit<
  AccountSwitchConfig,
  "accounts" | "domains" | "strategies"
> & {
  accounts: Array<Account & { credentialRef?: string }>;
  domains: Record<string, LegacyDomainConfig>;
  strategies?: Record<string, LegacyStrategyEntry>;
  globalDefaultCredentialRef?: string;
};

function specVariables(spec: unknown): Record<string, unknown>[] {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) return [];
  if (!("vars" in spec) || !Array.isArray(spec.vars)) return [];
  return spec.vars.filter(
    (value): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value),
  );
}

async function resolveRefs(
  refs: Record<string, string> | undefined,
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const [name, ref] of Object.entries(refs ?? {})) {
    const value = await resolveSecret(ref);
    if (value === undefined) {
      throw new SecurityError("VAULT_UNAVAILABLE", `保险库引用缺少对应秘密：${name}`);
    }
    values[name] = value;
  }
  return values;
}

/** 把策略声明里 secret 变量的默认值从保险库引用还原为明文。 */
async function materializeStrategy(
  strategy: LegacyStrategyEntry,
  changed: { value: boolean },
): Promise<void> {
  if (!strategy.secretVarRefs) return;
  const values = await resolveRefs(strategy.secretVarRefs);
  for (const variable of specVariables(strategy.spec)) {
    if (variable.secret !== true || typeof variable.name !== "string") continue;
    const value = values[variable.name];
    if (value !== undefined) variable.default = value;
  }
  delete strategy.secretVarRefs;
  changed.value = true;
}

export async function materializeLegacyVault(): Promise<boolean> {
  const stored = (await chrome.storage.local.get([CONFIG_KEY])) ?? {};
  const config = stored[CONFIG_KEY] as LegacyAccountSwitchConfig | undefined;
  if (!config) {
    await chrome.storage.local.remove?.([
      VAULT_STORAGE_KEY,
      VAULT_META_KEY,
      MIGRATION_RECOVERY_KEY,
      MIGRATION_JOURNAL_KEY,
      IMPORT_JOURNAL_KEY,
    ]);
    return false;
  }

  const changed = { value: false };

  for (const account of config.accounts ?? []) {
    if (!account.credentialRef) continue;
    if (account.password === undefined) {
      const value = await resolveSecret(account.credentialRef);
      if (value === undefined) {
        throw new SecurityError("VAULT_UNAVAILABLE", "账号密码缺少保险库记录，无法还原明文");
      }
      account.password = value;
    }
    delete account.credentialRef;
    changed.value = true;
  }

  for (const domain of Object.values(config.domains ?? {})) {
    if (domain.defaultCredentialRef) {
      if (domain.defaultPassword === undefined) {
        const value = await resolveSecret(domain.defaultCredentialRef);
        if (value === undefined) {
          throw new SecurityError("VAULT_UNAVAILABLE", "环境默认密码缺少保险库记录，无法还原明文");
        }
        domain.defaultPassword = value;
      }
      delete domain.defaultCredentialRef;
      changed.value = true;
    }

    const envVarValues = await resolveRefs(domain.secretVarRefs);
    if (Object.keys(envVarValues).length > 0) {
      domain.vars = { ...(domain.vars ?? {}), ...envVarValues };
    }
    if (domain.secretVarRefs) {
      delete domain.secretVarRefs;
      changed.value = true;
    }

    const privateRefs = domain.strategyConfig?.secretVarRefs;
    if (privateRefs) {
      if (!domain.strategyConfig?.spec) {
        throw new SecurityError("CONFIG_INVALID", "环境私有秘密缺少登录声明，无法还原明文");
      }
      const values = await resolveRefs(privateRefs);
      for (const variable of specVariables(domain.strategyConfig.spec)) {
        if (variable.secret !== true || typeof variable.name !== "string") continue;
        const value = values[variable.name];
        if (value !== undefined) variable.default = value;
      }
      delete domain.strategyConfig.secretVarRefs;
      changed.value = true;
    }
  }

  for (const strategy of Object.values(config.strategies ?? {})) {
    await materializeStrategy(strategy, changed);
  }

  if (config.globalDefaultCredentialRef) {
    if (config.globalDefaultPassword === undefined) {
      const value = await resolveSecret(config.globalDefaultCredentialRef);
      if (value === undefined) {
        throw new SecurityError("VAULT_UNAVAILABLE", "全局默认密码缺少保险库记录，无法还原明文");
      }
      config.globalDefaultPassword = value;
    }
    delete config.globalDefaultCredentialRef;
    changed.value = true;
  }

  if (changed.value) {
    await chrome.storage.local.set({ [CONFIG_KEY]: config as AccountSwitchConfig });
  }
  await chrome.storage.local.remove?.([
    VAULT_STORAGE_KEY,
    VAULT_META_KEY,
    MIGRATION_RECOVERY_KEY,
    MIGRATION_JOURNAL_KEY,
    IMPORT_JOURNAL_KEY,
  ]);
  return changed.value;
}
