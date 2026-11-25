import {
  readAccountSwitchConfigOrDefaults,
  saveAccountSwitchConfig,
} from "./config-store";
import {
  commitPreparedBackupImport,
  exportPlaintextBackup,
  preparePlaintextBackupImport,
  type PreparedBackupImport,
} from "../../shared/security/backup-service";
import { errorCodeOf, type ErrorCode } from "./utils/error-codes";
import type { AccountSwitchConfig } from "./types";

interface ConfigResponse {
  success: boolean;
  config?: AccountSwitchConfig;
  error?: string;
  errorCode?: ErrorCode;
}

function failure(error: unknown): {
  success: false;
  error: string;
  errorCode: ErrorCode;
} {
  return {
    success: false,
    error: error instanceof Error ? error.message : "配置操作失败",
    errorCode: errorCodeOf(error),
  };
}

export async function handleAccountConfigGet(): Promise<ConfigResponse> {
  try {
    return { success: true, config: await readAccountSwitchConfigOrDefaults() };
  } catch (error) {
    return failure(error);
  }
}

export async function handleAccountConfigSave(
  patch: Partial<AccountSwitchConfig>,
): Promise<ConfigResponse> {
  try {
    return { success: true, config: await saveAccountSwitchConfig(patch) };
  } catch (error) {
    return failure(error);
  }
}

let pendingBackup: PreparedBackupImport | undefined;

export async function handleBackupExport() {
  try {
    return { success: true as const, backup: await exportPlaintextBackup() };
  } catch (error) {
    return failure(error);
  }
}

export async function handleBackupPrepare(text: string) {
  pendingBackup = undefined;
  try {
    const prepared = await preparePlaintextBackupImport(text);
    pendingBackup = prepared;
    return { success: true as const, summary: prepared.summary };
  } catch (error) {
    return failure(error);
  }
}

export async function handleBackupConfirm(acceptPlaintextWarning: boolean) {
  if (!acceptPlaintextWarning) {
    return {
      success: false as const,
      error: "导入明文备份前必须确认风险",
      errorCode: "CONFIG_INVALID" as ErrorCode,
    };
  }
  const prepared = pendingBackup;
  pendingBackup = undefined;
  if (!prepared) {
    return {
      success: false as const,
      error: "备份预览已失效，请重新选择文件",
      errorCode: "CONFIG_INVALID" as ErrorCode,
    };
  }
  try {
    return await commitPreparedBackupImport(prepared);
  } catch (error) {
    return failure(error);
  }
}
