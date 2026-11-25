/** 账号切换配置的明文读写（旧版保险库迁移见 legacy-vault.ts）。 */
import { materializeLegacyVault } from "./legacy-vault";
import type { AccountSwitchConfig } from "./types";

const ACCOUNT_CONFIG_KEY = "devtools-account-switch";
export const ACCOUNT_CONFIG_WRITE_LOCK = "devtools-lock-devtools-account-switch";

async function withConfigLock<T>(operation: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  return locks ? locks.request(ACCOUNT_CONFIG_WRITE_LOCK, operation) : operation();
}

export async function readAccountSwitchConfig(): Promise<AccountSwitchConfig | undefined> {
  try {
    await materializeLegacyVault();
  } catch (error) {
    // 旧保险库可能来自不支持的历史格式；不能因此阻断整个配置页。
    // 保留原配置（含旧引用）在存储里，后续仍可手工处理或重试迁移。
    console.warn("[account-switch] 旧版保险库迁移跳过：", error);
  }
  const stored = await chrome.storage.local.get([ACCOUNT_CONFIG_KEY]);
  return (stored?.[ACCOUNT_CONFIG_KEY] as AccountSwitchConfig | undefined) ?? undefined;
}

export async function readAccountSwitchConfigOrDefaults(): Promise<AccountSwitchConfig> {
  return (await readAccountSwitchConfig()) ?? {
    accounts: [],
    domains: {},
    strategies: {},
  };
}

/** 字段级增量保存：读最新 → 只覆盖 patch 中的字段 → 写回。 */
export async function saveAccountSwitchConfig(
  patch: Partial<AccountSwitchConfig>,
): Promise<AccountSwitchConfig> {
  return withConfigLock(async () => {
    const current = (await readAccountSwitchConfig()) ?? {
      accounts: [],
      domains: {},
      strategies: {},
    };
    const next = structuredClone({ ...current, ...patch }) as AccountSwitchConfig;
    await chrome.storage.local.set({ [ACCOUNT_CONFIG_KEY]: next });
    return next;
  });
}
