import { getAllConfig, isExportableConfigId } from "../config-transfer";
import { CONFIG_VERSION, keyFor, migrateConfig } from "../tool-config";
import { SecurityError } from "./errors";
import { storageValuesEqual } from "./canonical-json";
import type { VaultRecord } from "./types";
import {
  cleanupOrphanSecrets,
  IMPORT_JOURNAL_KEY,
  openLocalPayload,
  putSecret,
  resetVaultState,
  resolveSecret,
  sealLocalPayload,
  VAULT_META_KEY,
  VAULT_STORAGE_KEY,
} from "./vault-service";
import {
  ACCOUNT_CONFIG_WRITE_LOCK,
  collectCredentialRefs,
  prepareSecretReferences,
} from "../../tools/account-switch/secret-migration";
import type { AccountSwitchConfig, DomainConfig } from "../../tools/account-switch/types";
import {
  inspectLoginSpecSupport,
  type SpecSupportReport,
} from "../../tools/account-switch/spec/capabilities";
import { requireSupportedLoginSpec } from "../../tools/account-switch/spec/document";

const IMPORT_FORMAT = "shadekit-import-journal/v1";
const ACCOUNT_CONFIG_ID = "account-switch";

interface ImportJournal {
  format: typeof IMPORT_FORMAT;
  stage: "prepared";
  recovery: VaultRecord;
  keys: string[];
}

export interface BackupImportSummary {
  plaintext: true;
  environments: Array<{ name: string; support: SpecSupportReport }>;
  accounts: number;
  strategies: number;
  secrets: number;
  overwrittenTools: string[];
}

export interface PreparedBackupImport {
  summary: BackupImportSummary;
  /** Background-only secret-reference config; never send this object to a page. */
  accountSwitch: AccountSwitchConfig;
  /** Background-only portable plaintext, held until the explicit confirmation. */
  secrets: Map<string, string>;
  configWrites: Record<string, unknown>;
  includesAccountSwitch: boolean;
}

export interface ImportResult {
  success: true;
  importedSecretCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requiredSecret(ref: string): Promise<string> {
  const value = await resolveSecret(ref);
  if (value === undefined) {
    throw new SecurityError("VAULT_UNAVAILABLE", "备份引用的秘密不存在");
  }
  return value;
}

function rawVariables(spec: unknown): Record<string, unknown>[] {
  if (!isRecord(spec) || !Array.isArray(spec.vars)) return [];
  return spec.vars.filter(isRecord);
}

async function portableAccountConfig(
  source: AccountSwitchConfig,
): Promise<AccountSwitchConfig> {
  const config = structuredClone(source);
  for (const account of config.accounts) {
    if (!account.credentialRef) continue;
    account.password = await requiredSecret(account.credentialRef);
    delete account.credentialRef;
  }
  for (const domain of Object.values(config.domains)) {
    if (domain.defaultCredentialRef) {
      domain.defaultPassword = await requiredSecret(domain.defaultCredentialRef);
      delete domain.defaultCredentialRef;
    }
    for (const [name, ref] of Object.entries(domain.secretVarRefs ?? {})) {
      domain.vars = { ...(domain.vars ?? {}), [name]: await requiredSecret(ref) };
    }
    delete domain.secretVarRefs;
    const privateRefs = domain.strategyConfig?.secretVarRefs;
    if (privateRefs && domain.strategyConfig?.spec) {
      for (const variable of rawVariables(domain.strategyConfig.spec)) {
        const name = typeof variable.name === "string" ? variable.name : undefined;
        const ref = name ? privateRefs[name] : undefined;
        if (variable.secret === true && ref) {
          variable.default = await requiredSecret(ref);
        }
      }
      delete domain.strategyConfig.secretVarRefs;
    }
    if (domain.strategyConfig) delete domain.strategyConfig.declaredSpecVersion;
  }
  for (const strategy of Object.values(config.strategies ?? {})) {
    for (const variable of rawVariables(strategy.spec)) {
      const name = typeof variable.name === "string" ? variable.name : undefined;
      const ref = name ? strategy.secretVarRefs?.[name] : undefined;
      if (variable.secret === true && ref) {
        variable.default = await requiredSecret(ref);
      }
    }
    delete strategy.secretVarRefs;
    delete strategy.declaredSpecVersion;
  }
  if (config.globalDefaultCredentialRef) {
    config.globalDefaultPassword = await requiredSecret(
      config.globalDefaultCredentialRef,
    );
    delete config.globalDefaultCredentialRef;
  }
  return config;
}

/** The explicit plaintext-backup path is the only bulk secret materialization API. */
export async function exportPlaintextBackup(): Promise<Record<string, unknown>> {
  const payload = await getAllConfig();
  const account = payload[ACCOUNT_CONFIG_ID] as AccountSwitchConfig | undefined;
  if (account) payload[ACCOUNT_CONFIG_ID] = await portableAccountConfig(account);
  return payload;
}

function specSupport(
  raw: unknown,
  declaredSpecVersion: unknown,
  label: string,
): SpecSupportReport {
  if (
    !isRecord(raw) ||
    typeof raw.version !== "number" ||
    !Number.isInteger(raw.version) ||
    !Array.isArray(raw.ops)
  ) {
    throw new SecurityError("CONFIG_INVALID", `${label}缺少可保留的登录声明结构`);
  }
  const support = inspectLoginSpecSupport(raw, declaredSpecVersion);
  if (!support.supported) return support;
  try {
    requireSupportedLoginSpec(raw, declaredSpecVersion);
  } catch (error) {
    throw new SecurityError(
      "CONFIG_INVALID",
      `${label}无效：${error instanceof Error ? error.message : "未知错误"}`,
    );
  }
  return support;
}

function effectiveDomainSpec(
  domain: DomainConfig,
  config: AccountSwitchConfig,
): { spec: unknown; declaredSpecVersion: unknown } | undefined {
  if (domain.strategyConfig?.spec !== undefined) {
    return {
      spec: domain.strategyConfig.spec,
      declaredSpecVersion: domain.strategyConfig.declaredSpecVersion,
    };
  }
  if (!domain.strategyId) return undefined;
  const strategy = config.strategies?.[domain.strategyId];
  if (!strategy) return undefined;
  return {
    spec: strategy.spec,
    declaredSpecVersion: strategy.declaredSpecVersion,
  };
}

function validateAccountConfig(config: AccountSwitchConfig): BackupImportSummary["environments"] {
  if (
    !Array.isArray(config.accounts) ||
    !isRecord(config.domains) ||
    (config.strategies !== undefined && !isRecord(config.strategies))
  ) {
    throw new SecurityError("CONFIG_INVALID", "备份账号配置结构无效");
  }
  const ids = new Set<string>();
  for (const account of config.accounts) {
    if (
      !isRecord(account) ||
      typeof account.id !== "string" ||
      !account.id ||
      ids.has(account.id) ||
      !Array.isArray(account.domains) ||
      !account.domains.every((domain) => typeof domain === "string")
    ) {
      throw new SecurityError("CONFIG_INVALID", "备份账号 ID、绑定缺失或重复");
    }
    ids.add(account.id);
  }
  const strategySupport = new Map<string, SpecSupportReport>();
  for (const [id, strategy] of Object.entries(config.strategies ?? {})) {
    if (!isRecord(strategy)) {
      throw new SecurityError("CONFIG_INVALID", `策略 ${id} 结构无效`);
    }
    strategySupport.set(
      id,
      specSupport(
        strategy.spec,
        strategy.declaredSpecVersion,
        `策略 ${id} 的登录声明`,
      ),
    );
  }
  return Object.entries(config.domains).map(([id, domain], index) => {
    if (!isRecord(domain) || typeof domain.name !== "string") {
      throw new SecurityError(
        "CONFIG_INVALID",
        `第 ${index + 1} 个环境不是可保留的环境记录`,
      );
    }
    const effective = effectiveDomainSpec(domain, config);
    let support: SpecSupportReport = { supported: true, issues: [] };
    if (effective) {
      support = domain.strategyConfig?.spec !== undefined
        ? specSupport(
            effective.spec,
            effective.declaredSpecVersion,
            `环境 ${domain.name} 的登录声明`,
          )
        : strategySupport.get(domain.strategyId!) ?? support;
    }
    return { name: domain.name || id, support };
  });
}

function validatePayload(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) throw new SecurityError("CONFIG_INVALID", "备份配置必须是对象");
  const version = raw.__version;
  if (version !== undefined && (!Number.isInteger(version) || (version as number) < 0)) {
    throw new SecurityError("CONFIG_INVALID", "备份配置版本无效");
  }
  if (typeof version === "number" && version > CONFIG_VERSION) {
    throw new SecurityError("CONFIG_INVALID", "备份配置版本高于当前扩展");
  }
  const data = migrateConfig(raw);
  const exportable = Object.keys(data).filter(
    (key) => key !== "__version" && isExportableConfigId(key),
  );
  if (exportable.length === 0) {
    throw new SecurityError("CONFIG_INVALID", "备份不包含可导入配置");
  }
  return data;
}

/** Parse, validate, derive support, and prepare every write without side effects. */
export async function preparePlaintextBackupImport(
  text: string,
): Promise<PreparedBackupImport> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SecurityError("CONFIG_INVALID", "明文备份 JSON 无法解析");
  }
  const payload = validatePayload(parsed);
  const source = payload[ACCOUNT_CONFIG_ID] as AccountSwitchConfig | undefined;
  const environments = source ? validateAccountConfig(source) : [];
  const prepared = source ? prepareSecretReferences(source) : undefined;
  if (prepared) {
    for (const ref of collectCredentialRefs(prepared.config)) {
      if (!prepared.secrets.has(ref)) {
        throw new SecurityError(
          "VAULT_UNAVAILABLE",
          "完整备份缺少引用对应的 portable 秘密",
        );
      }
    }
  }

  const overwrittenTools = Object.keys(payload).filter(
    (key) => key !== "__version" && isExportableConfigId(key),
  );
  const configWrites: Record<string, unknown> = {};
  for (const id of overwrittenTools) {
    configWrites[keyFor(id)] =
      id === ACCOUNT_CONFIG_ID && prepared ? prepared.config : payload[id];
  }
  const accountSwitch = prepared?.config ?? { accounts: [], domains: {}, strategies: {} };
  return {
    summary: {
      plaintext: true,
      environments,
      accounts: accountSwitch.accounts.length,
      strategies: Object.keys(accountSwitch.strategies ?? {}).length,
      secrets: prepared?.secrets.size ?? 0,
      overwrittenTools,
    },
    accountSwitch,
    secrets: prepared?.secrets ?? new Map(),
    configWrites,
    includesAccountSwitch: prepared !== undefined,
  };
}

async function readJournal(): Promise<ImportJournal | undefined> {
  const result = await chrome.storage.local.get([IMPORT_JOURNAL_KEY]);
  return result[IMPORT_JOURNAL_KEY] as ImportJournal | undefined;
}

export async function recoverInterruptedImport(): Promise<void> {
  const journal = await readJournal();
  if (!journal) return;
  if (
    journal.format !== IMPORT_FORMAT ||
    journal.stage !== "prepared" ||
    !journal.recovery ||
    !Array.isArray(journal.keys)
  ) {
    throw new SecurityError("VAULT_UNAVAILABLE", "导入恢复日志格式不受支持");
  }
  const snapshot = (await openLocalPayload("import-recovery", journal.recovery)) as {
    values?: Record<string, unknown>;
  };
  if (!snapshot.values) {
    throw new SecurityError("VAULT_UNAVAILABLE", "导入恢复快照无效");
  }
  await chrome.storage.local.set(snapshot.values);
  const missing = journal.keys.filter((key) => !Object.hasOwn(snapshot.values!, key));
  if (missing.length > 0) await chrome.storage.local.remove(missing);
  // 快照可能删除了导入期间新建的保险库元数据（首次使用保险库的失败导入）：
  // 必须同时丢弃内存 DEK，否则同一 worker 生命周期的后续写入会加密在
  // 一份已不存在的 wrappedDek 下，重启后无法解密。
  resetVaultState();
  await chrome.storage.local.remove(IMPORT_JOURNAL_KEY);
}

async function commitUnlocked(prepared: PreparedBackupImport): Promise<ImportResult> {
  const affectedKeys = [
    ...new Set([
      ...Object.keys(prepared.configWrites),
      VAULT_META_KEY,
      VAULT_STORAGE_KEY,
    ]),
  ];
  const before = await chrome.storage.local.get(affectedKeys);
  const recovery = await sealLocalPayload("import-recovery", { values: before });
  const journal: ImportJournal = {
    format: IMPORT_FORMAT,
    stage: "prepared",
    recovery,
    keys: affectedKeys,
  };

  try {
    await chrome.storage.local.set({ [IMPORT_JOURNAL_KEY]: journal });
    for (const [id, plaintext] of prepared.secrets) {
      await putSecret(id, plaintext);
      if ((await resolveSecret(id)) !== plaintext) {
        throw new SecurityError("VAULT_UNAVAILABLE", "导入秘密回读核对失败");
      }
    }
    await chrome.storage.local.set(prepared.configWrites);
    const readback = await chrome.storage.local.get(Object.keys(prepared.configWrites));
    for (const [key, value] of Object.entries(prepared.configWrites)) {
      // chrome.storage 读回时会重排对象键，必须按内容而非键序比较。
      if (!storageValuesEqual(readback[key], value)) {
        throw new SecurityError("VAULT_UNAVAILABLE", "导入配置读回校验失败");
      }
    }
    if (prepared.includesAccountSwitch) {
      await cleanupOrphanSecrets(
        new Set(collectCredentialRefs(prepared.accountSwitch)),
      );
    }
    await chrome.storage.local.remove(IMPORT_JOURNAL_KEY);
    return { success: true, importedSecretCount: prepared.secrets.size };
  } catch (error) {
    await recoverInterruptedImport();
    throw error;
  }
}

export async function commitPreparedBackupImport(
  prepared: PreparedBackupImport,
): Promise<ImportResult> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  const operation = () => commitUnlocked(prepared);
  return locks ? locks.request(ACCOUNT_CONFIG_WRITE_LOCK, operation) : operation();
}
