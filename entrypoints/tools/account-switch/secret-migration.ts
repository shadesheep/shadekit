import {
  hasSecret,
  cleanupOrphanSecrets,
  MIGRATION_RECOVERY_KEY,
  openLocalPayload,
  putSecret,
  removeSecret,
  resolveSecret,
  sealLocalPayload,
} from "../../shared/security/vault-service";
import { SecurityError } from "../../shared/security/errors";
import { storageValuesEqual } from "../../shared/security/canonical-json";
import type { AccountSwitchConfig } from "./types";
import type { SpecDocument } from "./spec/document";

function specVariables(spec: SpecDocument): Array<Record<string, unknown>> {
  const vars = (spec as Record<string, unknown>).vars;
  return Array.isArray(vars)
    ? vars.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value))
    : [];
}

function migrateSpecDefaults(
  spec: SpecDocument,
  refs: Record<string, string>,
  credentialId: (name: string) => string,
  secrets: Map<string, string>,
): void {
  for (const variable of specVariables(spec)) {
    if (
      variable.secret !== true ||
      typeof variable.name !== "string" ||
      typeof variable.default !== "string"
    ) continue;
    const id = credentialId(variable.name);
    refs[variable.name] = id;
    secrets.set(id, variable.default);
    delete variable.default;
  }
}

const ACCOUNT_CONFIG_KEY = "devtools-account-switch";
export const MIGRATION_JOURNAL_KEY = "devtools-account-switch-migration-journal";
const MIGRATION_FORMAT = "shadekit-secret-migration/v1";
export const ACCOUNT_CONFIG_WRITE_LOCK = "devtools-lock-devtools-account-switch";

interface MigrationJournal {
  format: typeof MIGRATION_FORMAT;
  stage: "started" | "prepared" | "committed";
  config?: AccountSwitchConfig;
}

export interface SecretMigrationResult {
  migrated: boolean;
  count: number;
}

export const accountCredentialId = (accountId: string): string => `account:${accountId}`;
export const domainDefaultCredentialId = (environmentId: string): string =>
  `environment:${encodeURIComponent(environmentId)}:default`;
export const globalDefaultCredentialId = (): string => "global:default";
export const strategyVarCredentialId = (strategyId: string, name: string): string =>
  `strategy:${encodeURIComponent(strategyId)}:var:${encodeURIComponent(name)}`;
export const domainVarCredentialId = (environmentId: string, name: string): string =>
  `environment:${encodeURIComponent(environmentId)}:var:${encodeURIComponent(name)}`;

async function readConfig(): Promise<AccountSwitchConfig | undefined> {
  const result = await chrome.storage.local.get([ACCOUNT_CONFIG_KEY]);
  return result[ACCOUNT_CONFIG_KEY] as AccountSwitchConfig | undefined;
}

async function withConfigLock<T>(operation: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  return locks ? locks.request(ACCOUNT_CONFIG_WRITE_LOCK, operation) : operation();
}

async function writeConfig(config: AccountSwitchConfig): Promise<void> {
  await chrome.storage.local.set({ [ACCOUNT_CONFIG_KEY]: config });
}

async function readJournal(): Promise<MigrationJournal | undefined> {
  const result = await chrome.storage.local.get([MIGRATION_JOURNAL_KEY]);
  return result[MIGRATION_JOURNAL_KEY] as MigrationJournal | undefined;
}

async function writeJournal(journal: MigrationJournal): Promise<void> {
  await chrome.storage.local.set({ [MIGRATION_JOURNAL_KEY]: journal });
}

/**
 * 迁移 committed 且引用校验通过后，加密的迁移前副本不再需要。
 * 删除失败不影响已完成迁移；下次启动的 committed 分支会再次清理。
 */
async function clearMigrationRecovery(): Promise<void> {
  try {
    await chrome.storage.local.remove(MIGRATION_RECOVERY_KEY);
  } catch {
    // best effort：用户数据已经提交，残留副本可由下次启动继续清理。
  }
}

export function prepareSecretReferences(source: AccountSwitchConfig): {
  config: AccountSwitchConfig;
  secrets: Map<string, string>;
} {
  const config = structuredClone(source);
  const secrets = new Map<string, string>();
  for (const account of config.accounts) {
    if (account.password === undefined) continue;
    if (account.password === "" && account.credentialRef) {
      delete account.password;
      continue;
    }
    const id = accountCredentialId(account.id);
    secrets.set(id, account.password);
    account.credentialRef = id;
    delete account.password;
  }
  for (const [strategyId, entry] of Object.entries(config.strategies ?? {})) {
    const refs = { ...(entry.secretVarRefs ?? {}) };
    migrateSpecDefaults(entry.spec, refs, (name) => strategyVarCredentialId(strategyId, name), secrets);
    if (Object.keys(refs).length > 0) entry.secretVarRefs = refs;
  }
  for (const [environmentId, domain] of Object.entries(config.domains)) {
    if (domain.defaultPassword !== undefined) {
      if (domain.defaultPassword === "" && domain.defaultCredentialRef) {
        delete domain.defaultPassword;
      } else {
        const id = domainDefaultCredentialId(environmentId);
        secrets.set(id, domain.defaultPassword);
        domain.defaultCredentialRef = id;
        delete domain.defaultPassword;
      }
    }
    if (domain.strategyConfig?.spec) {
      const refs = { ...(domain.strategyConfig.secretVarRefs ?? {}) };
      migrateSpecDefaults(
        domain.strategyConfig.spec,
        refs,
        (name) => `environment:${encodeURIComponent(environmentId)}:default-var:${encodeURIComponent(name)}`,
        secrets,
      );
      if (Object.keys(refs).length > 0) domain.strategyConfig.secretVarRefs = refs;
    }
    const strategy = domain.strategyId ? config.strategies?.[domain.strategyId] : undefined;
    const spec = domain.strategyConfig?.spec ?? strategy?.spec;
    if (!spec) continue;
    const refs = { ...(domain.secretVarRefs ?? {}) };
    const publicVars = { ...(domain.vars ?? {}) };
    for (const variable of specVariables(spec)) {
      if (
        variable.secret !== true ||
        typeof variable.name !== "string" ||
        publicVars[variable.name] === undefined
      ) continue;
      const value = publicVars[variable.name];
      if (value !== "") {
        const id = domainVarCredentialId(environmentId, variable.name);
        refs[variable.name] = id;
        secrets.set(id, value);
      }
      delete publicVars[variable.name];
    }
    if (Object.keys(refs).length > 0) domain.secretVarRefs = refs;
    if (domain.vars) domain.vars = publicVars;
  }
  if (config.globalDefaultPassword !== undefined) {
    if (config.globalDefaultPassword === "" && config.globalDefaultCredentialRef) {
      delete config.globalDefaultPassword;
    } else {
      const id = globalDefaultCredentialId();
      secrets.set(id, config.globalDefaultPassword);
      config.globalDefaultCredentialRef = id;
      delete config.globalDefaultPassword;
    }
  }
  return { config, secrets };
}

function hasReplacementPassword(value: unknown): boolean {
  return typeof value === "string" && value !== "";
}

/**
 * 只删除用户显式点名的凭据引用。
 *
 * 保存补丁缺少字段表示「保持现状」（例如另一页只改环境时，账号数组
 * 里不会带明文）；只有 UI 的显式清除动作才会把引用放进 clearCredentialRefs。
 */
function applyCredentialClears(
  config: AccountSwitchConfig,
  refs: readonly string[],
): void {
  if (refs.length === 0) return;
  const cleared = new Set(refs);
  for (const account of config.accounts) {
    if (!account.credentialRef || !cleared.has(account.credentialRef)) continue;
    // 同一保存里带了新的非空明文密码时以新密码为准：先应用清除会把
    // 用户刚输入的密码一并丢掉（清除只用于「只删不换」的显式动作）。
    if (hasReplacementPassword(account.password)) continue;
    delete account.credentialRef;
    delete account.password;
  }
  for (const domain of Object.values(config.domains)) {
    if (!domain.defaultCredentialRef || !cleared.has(domain.defaultCredentialRef)) {
      continue;
    }
    if (hasReplacementPassword(domain.defaultPassword)) continue;
    delete domain.defaultCredentialRef;
    delete domain.defaultPassword;
  }
  if (
    config.globalDefaultCredentialRef &&
    cleared.has(config.globalDefaultCredentialRef) &&
    !hasReplacementPassword(config.globalDefaultPassword)
  ) {
    delete config.globalDefaultCredentialRef;
    delete config.globalDefaultPassword;
  }
}

export function collectCredentialRefs(config: AccountSwitchConfig): string[] {
  const refs = new Set<string>();
  for (const account of config.accounts) {
    if (account.credentialRef) refs.add(account.credentialRef);
  }
  for (const domain of Object.values(config.domains)) {
    if (domain.defaultCredentialRef) refs.add(domain.defaultCredentialRef);
    for (const ref of Object.values(domain.secretVarRefs ?? {})) refs.add(ref);
    for (const ref of Object.values(domain.strategyConfig?.secretVarRefs ?? {})) refs.add(ref);
  }
  for (const strategy of Object.values(config.strategies ?? {})) {
    for (const ref of Object.values(strategy.secretVarRefs ?? {})) refs.add(ref);
  }
  if (config.globalDefaultCredentialRef) refs.add(config.globalDefaultCredentialRef);
  return [...refs];
}

async function validateReferences(config: AccountSwitchConfig): Promise<void> {
  for (const ref of collectCredentialRefs(config)) {
    if (await resolveSecret(ref) === undefined) {
      throw new SecurityError("VAULT_UNAVAILABLE", "保险库引用完整性校验失败");
    }
  }
}

function sameConfig(left: AccountSwitchConfig, right: AccountSwitchConfig): boolean {
  // chrome.storage 读回时会重排对象键，必须按内容而非键序比较。
  return storageValuesEqual(left, right);
}

export async function migratePlaintextSecrets(): Promise<SecretMigrationResult> {
  // 启动迁移与配置保存必须共用同一把写锁：否则迁移读取旧配置后，
  // 并发保存写入的新字段会被迁移提交覆盖，失败补偿也可能交错执行。
  return withConfigLock(async () => {
    let source = await readConfig();
    if (!source) return { migrated: false, count: 0 };
    const journal = await readJournal();
    if (journal?.stage === "committed") {
      await validateReferences(source);
      await clearMigrationRecovery();
      return { migrated: false, count: 0 };
    }
    if (journal?.stage === "prepared" && journal.config) {
      if (sameConfig(source, journal.config)) {
        await validateReferences(source);
        await writeJournal({ format: MIGRATION_FORMAT, stage: "committed" });
        await clearMigrationRecovery();
        return { migrated: false, count: 0 };
      }
      const recovery = (await chrome.storage.local.get([MIGRATION_RECOVERY_KEY]))[MIGRATION_RECOVERY_KEY];
      if (recovery) {
        const payload = await openLocalPayload("migration-recovery", recovery) as {
          config?: AccountSwitchConfig;
        };
        if (payload.config) {
          source = payload.config;
          await writeConfig(source);
        }
      }
    }

    const prepared = prepareSecretReferences(source);
    return commitPreparedConfig(source, prepared, false);
  });
}

async function commitPreparedConfig(
  source: AccountSwitchConfig,
  prepared: ReturnType<typeof prepareSecretReferences>,
  writeWithoutSecrets: boolean,
): Promise<SecretMigrationResult & { config: AccountSwitchConfig }> {
  if (prepared.secrets.size === 0) {
    await validateReferences(prepared.config);
    if (writeWithoutSecrets) {
      await writeConfig(prepared.config);
      const readback = await readConfig();
      if (!readback || !sameConfig(readback, prepared.config)) {
        throw new SecurityError("VAULT_UNAVAILABLE", "公共配置提交后读回校验失败");
      }
    }
    if (collectCredentialRefs(prepared.config).length > 0) {
      await writeJournal({ format: MIGRATION_FORMAT, stage: "committed" });
      await clearMigrationRecovery();
    }
    return { migrated: false, count: 0, config: prepared.config };
  }

  const newIds: string[] = [];
  let committed = false;
  try {
    await writeJournal({ format: MIGRATION_FORMAT, stage: "started" });
    for (const [id, plaintext] of prepared.secrets) {
      if (!await hasSecret(id)) newIds.push(id);
      await putSecret(id, plaintext);
      if (await resolveSecret(id) !== plaintext) {
        throw new SecurityError("VAULT_UNAVAILABLE", "秘密迁移回读核对失败");
      }
    }
    await validateReferences(prepared.config);
    const recovery = await sealLocalPayload("migration-recovery", {
      format: "shadekit-migration-recovery/v1",
      config: source,
    });
    const verified = await openLocalPayload("migration-recovery", recovery) as {
      config?: AccountSwitchConfig;
    };
    if (!verified.config || !sameConfig(verified.config, source)) {
      throw new SecurityError("VAULT_UNAVAILABLE", "迁移恢复副本校验失败");
    }
    await chrome.storage.local.set({ [MIGRATION_RECOVERY_KEY]: recovery });
    await writeJournal({
      format: MIGRATION_FORMAT,
      stage: "prepared",
      config: prepared.config,
    });
    await writeConfig(prepared.config);
    committed = true;
    const readback = await readConfig();
    if (!readback || !sameConfig(readback, prepared.config)) {
      throw new SecurityError("VAULT_UNAVAILABLE", "引用配置提交后读回校验失败");
    }
    await validateReferences(readback);
    await writeJournal({ format: MIGRATION_FORMAT, stage: "committed" });
    await clearMigrationRecovery();
    return { migrated: true, count: prepared.secrets.size, config: prepared.config };
  } catch (error) {
    if (committed) await writeConfig(source);
    for (const id of newIds) await removeSecret(id);
    throw error;
  }
}

export async function saveAccountSwitchConfig(
  patch: Partial<AccountSwitchConfig>,
  clearCredentialRefs: readonly string[] = [],
): Promise<AccountSwitchConfig> {
  return withConfigLock(async () => {
    const current = await readConfig() ?? { accounts: [], domains: {} };
    // 先深拷贝再应用清除，确保失败补偿写回的 source 仍是清除前的配置。
    const merged = structuredClone({ ...current, ...patch }) as AccountSwitchConfig;
    applyCredentialClears(merged, clearCredentialRefs);
    const prepared = prepareSecretReferences(merged);
    const result = await commitPreparedConfig(current, prepared, true);
    await cleanupOrphanSecrets(new Set(collectCredentialRefs(result.config)));
    return result.config;
  });
}
