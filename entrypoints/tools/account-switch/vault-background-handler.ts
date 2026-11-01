import {
  hasSecret,
  putSecret,
  removeSecret,
} from "../../shared/security/vault-service";
import { migratePlaintextSecrets, saveAccountSwitchConfig } from "./secret-migration";
import { errorCodeOf } from "./utils/error-codes";
import type { AccountSwitchConfig } from "./types";
import type { PreparedBackupImport } from "../../shared/security/backup-service";

function failure(error: unknown): {
  success: false;
  error: string;
  errorCode: ReturnType<typeof errorCodeOf>;
} {
  return {
    success: false,
    error: error instanceof Error ? error.message : "保险库操作失败",
    errorCode: errorCodeOf(error),
  };
}

async function operation(operation: () => Promise<void>): Promise<{
  success: boolean;
  error?: string;
  errorCode?: ReturnType<typeof errorCodeOf>;
}> {
  try {
    await operation();
    return { success: true };
  } catch (error) {
    return failure(error);
  }
}

export async function handleVaultGetConfig(): Promise<{
  success: boolean;
  config?: AccountSwitchConfig;
  error?: string;
  errorCode?: ReturnType<typeof errorCodeOf>;
}> {
  try {
    await migratePlaintextSecrets();
    const stored = await chrome.storage.local.get(["devtools-account-switch"]);
    const config = (stored["devtools-account-switch"] as AccountSwitchConfig | undefined) ?? {
      accounts: [],
      domains: {},
      strategies: {},
    };
    return { success: true, config };
  } catch (error) {
    return failure(error);
  }
}

export async function handleVaultSaveConfig(
  patch: Partial<AccountSwitchConfig>,
  clearCredentialRefs: readonly string[] = [],
): Promise<{
  success: boolean;
  config?: AccountSwitchConfig;
  error?: string;
  errorCode?: ReturnType<typeof errorCodeOf>;
}> {
  try {
    return {
      success: true,
      config: await saveAccountSwitchConfig(patch, clearCredentialRefs),
    };
  } catch (error) {
    return failure(error);
  }
}

export const handleVaultPutSecret = (credentialId: string, plaintext: string) =>
  operation(() => putSecret(credentialId, plaintext));
export const handleVaultDeleteSecret = (credentialId: string) =>
  operation(() => removeSecret(credentialId));


let pendingBackup: PreparedBackupImport | undefined;

export async function handleVaultExportBackup() {
  try {
    const { exportPlaintextBackup } = await import("../../shared/security/backup-service");
    return { success: true as const, backup: await exportPlaintextBackup() };
  } catch (error) {
    return failure(error);
  }
}

export async function handleVaultPrepareBackup(text: string) {
  pendingBackup = undefined;
  try {
    const { preparePlaintextBackupImport } = await import("../../shared/security/backup-service");
    const prepared = await preparePlaintextBackupImport(text);
    pendingBackup = prepared;
    return { success: true as const, summary: prepared.summary };
  } catch (error) {
    return failure(error);
  }
}

export async function handleVaultConfirmBackup(acceptPlaintextWarning: boolean) {
  if (!acceptPlaintextWarning) {
    return {
      success: false as const,
      error: "导入明文备份前必须确认风险",
      errorCode: "CONFIG_INVALID" as const,
    };
  }
  const prepared = pendingBackup;
  pendingBackup = undefined;
  if (!prepared) {
    return {
      success: false as const,
      error: "备份预览已失效，请重新选择文件",
      errorCode: "CONFIG_INVALID" as const,
    };
  }
  try {
    const { commitPreparedBackupImport } = await import("../../shared/security/backup-service");
    return await commitPreparedBackupImport(prepared);
  } catch (error) {
    return failure(error);
  }
}

export async function handleVaultHasSecret(credentialId: string): Promise<{
  success: boolean;
  hasSecret?: boolean;
  error?: string;
  errorCode?: ReturnType<typeof errorCodeOf>;
}> {
  try {
    return { success: true, hasSecret: await hasSecret(credentialId) };
  } catch (error) {
    return failure(error);
  }
}
