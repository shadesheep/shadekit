import { getAllConfig, isExportableConfigId } from "../config-transfer";
import { CONFIG_VERSION, keyFor, migrateConfig } from "../tool-config";
import { isRecord } from "../type-guards";
import { ACCOUNT_CONFIG_WRITE_LOCK } from "../../tools/account-switch/config-store";
import { SecurityError } from "./errors";
import { storageValuesEqual } from "./canonical-json";
import type {
  AccountSwitchConfig,
  DomainConfig,
} from "../../tools/account-switch/types";
import {
  inspectLoginSpecSupport,
  type SpecSupportReport,
} from "../../tools/account-switch/spec/capabilities";
import { requireSupportedLoginSpec } from "../../tools/account-switch/spec/document";

const ACCOUNT_CONFIG_ID = "account-switch";

export interface BackupImportSummary {
  plaintext: true;
  environments: Array<{ name: string; support: SpecSupportReport }>;
  accounts: number;
  strategies: number;
  overwrittenTools: string[];
}

export interface PreparedBackupImport {
  summary: BackupImportSummary;
  configWrites: Record<string, unknown>;
}

export interface ImportResult {
  success: true;
}

/** 完整备份直接导出存储里的明文配置（不含弃用的保险库密文）。 */
export async function exportPlaintextBackup(): Promise<Record<string, unknown>> {
  return getAllConfig();
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

/** 旧备份可能只带保险库引用；新版本无法解密，必须显式拒绝而不是导入死引用。 */
const LEGACY_REF_KEYS = new Set([
  "credentialRef",
  "defaultCredentialRef",
  "globalDefaultCredentialRef",
  "secretVarRefs",
]);

function assertNoVaultRefs(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoVaultRefs(item);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (LEGACY_REF_KEYS.has(key)) {
      throw new SecurityError("CONFIG_INVALID", "备份包含已弃用的加密密码引用，请改用新版导出的明文备份");
    }
    assertNoVaultRefs(child);
  }
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

/** 解析、校验并准备写入；不产生副作用。 */
export async function preparePlaintextBackupImport(
  text: string,
): Promise<PreparedBackupImport> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SecurityError("CONFIG_INVALID", "备份 JSON 无法解析");
  }
  const payload = validatePayload(parsed);
  const source = payload[ACCOUNT_CONFIG_ID] as AccountSwitchConfig | undefined;
  let environments: BackupImportSummary["environments"] = [];
  if (source) {
    environments = validateAccountConfig(source);
    assertNoVaultRefs(source);
  }
  const overwrittenTools = Object.keys(payload).filter(
    (key) => key !== "__version" && isExportableConfigId(key),
  );
  const configWrites: Record<string, unknown> = {};
  for (const id of overwrittenTools) {
    configWrites[keyFor(id)] = payload[id];
  }
  return {
    summary: {
      plaintext: true,
      environments,
      accounts: source?.accounts.length ?? 0,
      strategies: Object.keys(source?.strategies ?? {}).length,
      overwrittenTools,
    },
    configWrites,
  };
}

export async function commitPreparedBackupImport(
  prepared: PreparedBackupImport,
): Promise<ImportResult> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  const operation = async (): Promise<ImportResult> => {
    await chrome.storage.local.set(prepared.configWrites);
    const readback = await chrome.storage.local.get(Object.keys(prepared.configWrites));
    for (const [key, value] of Object.entries(prepared.configWrites)) {
      // chrome.storage 读回时会重排对象键，必须按内容而非键序比较。
      if (!storageValuesEqual(readback[key], value)) {
        throw new SecurityError("CONFIG_INVALID", "导入配置读回校验失败");
      }
    }
    return { success: true };
  };
  return locks ? locks.request(ACCOUNT_CONFIG_WRITE_LOCK, operation) : operation();
}
