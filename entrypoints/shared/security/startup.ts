import { recoverInterruptedImport } from "./backup-service";
import { migratePlaintextSecrets, type SecretMigrationResult } from "../../tools/account-switch/secret-migration";

/** 扩展启动时的恢复顺序；只处理存储事务，不发起登录，也不依赖解锁状态。 */
export async function recoverSecurityState(): Promise<SecretMigrationResult> {
  await recoverInterruptedImport();
  return migratePlaintextSecrets();
}
