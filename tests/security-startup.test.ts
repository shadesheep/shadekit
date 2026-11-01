import { beforeEach, describe, expect, it, vi } from "vitest";

const { recoverInterruptedImport, migratePlaintextSecrets } = vi.hoisted(() => ({
  recoverInterruptedImport: vi.fn(async () => undefined),
  migratePlaintextSecrets: vi.fn(async () => ({ migrated: false, count: 0 })),
}));
vi.mock("../entrypoints/shared/security/backup-service", () => ({ recoverInterruptedImport }));
vi.mock("../entrypoints/tools/account-switch/secret-migration", () => ({ migratePlaintextSecrets }));

import { recoverSecurityState } from "../entrypoints/shared/security/startup";

beforeEach(() => {
  vi.clearAllMocks();
  recoverInterruptedImport.mockResolvedValue(undefined);
  migratePlaintextSecrets.mockResolvedValue({ migrated: false, count: 0 });
});

describe("扩展启动安全恢复", () => {
  it("先恢复中断导入，再迁移旧明文，且不触发登录", async () => {
    const order: string[] = [];
    recoverInterruptedImport.mockImplementation(async () => { order.push("import"); });
    migratePlaintextSecrets.mockImplementation(async () => {
      order.push("migration");
      return { migrated: true, count: 2 };
    });
    await expect(recoverSecurityState()).resolves.toEqual({ migrated: true, count: 2 });
    expect(order).toEqual(["import", "migration"]);
  });

  it("导入恢复失败时不继续迁移", async () => {
    recoverInterruptedImport.mockRejectedValue(new Error("locked"));
    await expect(recoverSecurityState()).rejects.toThrow("locked");
    expect(migratePlaintextSecrets).not.toHaveBeenCalled();
  });
});
