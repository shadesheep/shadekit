import { beforeEach, describe, expect, it, vi } from "vitest";

const keyStore = vi.hoisted(() => ({ kek: undefined as CryptoKey | undefined }));
vi.mock("../entrypoints/shared/security/crypto-key-store", () => ({
  loadVaultKek: vi.fn(async () => keyStore.kek),
  saveVaultKek: vi.fn(async (kek: CryptoKey) => { keyStore.kek = kek; }),
  deleteVaultKek: vi.fn(async () => { keyStore.kek = undefined; }),
}));

import {
  commitPreparedBackupImport,
  exportPlaintextBackup,
  preparePlaintextBackupImport,
} from "../entrypoints/shared/security/backup-service";
import { CONFIG_VERSION } from "../entrypoints/shared/tool-config";
import {
  clearCachedDek,
  IMPORT_JOURNAL_KEY,
  putSecret,
  resolveSecret,
  VAULT_META_KEY,
  VAULT_STORAGE_KEY,
} from "../entrypoints/shared/security/vault-service";
import { accountCredentialId } from "../entrypoints/tools/account-switch/secret-migration";
import type { AccountSwitchConfig } from "../entrypoints/tools/account-switch/types";

const storage = new Map<string, unknown>();
const storageGet = vi.fn(async (keys: string[] | null) => {
  if (keys === null) return Object.fromEntries(storage);
  return Object.fromEntries(
    keys
      .filter((key) => storage.has(key))
      .map((key) => [key, structuredClone(storage.get(key))]),
  );
});
const storageSet = vi.fn(async (values: Record<string, unknown>) => {
  for (const [key, value] of Object.entries(values)) {
    storage.set(key, structuredClone(value));
  }
});
const storageRemove = vi.fn(async (keys: string | string[]) => {
  for (const key of Array.isArray(keys) ? keys : [keys]) storage.delete(key);
});
vi.stubGlobal("chrome", {
  permissions: { contains: async () => true, request: async () => true },
  storage: { local: { get: storageGet, set: storageSet, remove: storageRemove } },
});

function supportedSpec(): Record<string, unknown> {
  return {
    version: 2,
    ops: [
      {
        op: "http.execute",
        url: "{origin}/login",
        method: "POST",
        body: { json: { username: "{username}", password: "{password}" } },
        as: "resp",
      },
    ],
    success: [{ response: { from: "resp", path: "ok" } }],
    auth: { mode: "engine" },
  };
}

const futureSpec = {
  version: 3,
  futureTop: { keep: [1, 2] },
  ops: [{ op: "future.op", unknownField: "keep-me" }],
  success: [{ future: true }],
  auth: { mode: "future", unknownAuthField: "keep" },
};

function accountConfig(): AccountSwitchConfig {
  return {
    accounts: [
      {
        id: "bound-account",
        name: "Alice",
        username: "alice",
        password: "SAVED-PASSWORD-91",
        roles: [],
        domains: ["supported", "future"],
      },
    ],
    domains: {
      supported: {
        name: "Supported",
        tags: [],
        strategyConfig: { spec: supportedSpec() },
      },
      future: {
        name: "Future",
        tags: [],
        vars: { publicSetting: "keep" },
        strategyConfig: { spec: futureSpec, declaredSpecVersion: 3 },
      },
    },
    strategies: {},
  };
}

function fullBackup(config: AccountSwitchConfig = accountConfig()): string {
  return JSON.stringify({
    __version: CONFIG_VERSION,
    "account-switch": config,
    theme: "light",
  });
}

function snapshot(): Record<string, unknown> {
  return structuredClone(Object.fromEntries(storage));
}

beforeEach(async () => {
  storage.clear();
  keyStore.kek = undefined;
  clearCachedDek();
  storage.set("devtools-account-switch", {
    accounts: [],
    domains: {},
    strategies: {},
  });
  storage.set("devtools-theme", "dark");
  vi.clearAllMocks();
});

describe("明文完整备份 prepare / commit / export", () => {
  it("未知外层 __version 在任何写入前拒绝", async () => {
    await expect(
      preparePlaintextBackupImport(
        JSON.stringify({ __version: 999, "account-switch": accountConfig() }),
      ),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(storageSet).not.toHaveBeenCalled();
  });

  it("未来环境只禁用自身，原始声明、变量和账号绑定不丢失", async () => {
    const prepared = await preparePlaintextBackupImport(fullBackup());
    expect(prepared.summary.environments.map((item) => item.support.supported)).toEqual([
      true,
      false,
    ]);
    expect(prepared.summary.environments[1]?.support.issues[0]?.code).toBe(
      "SPEC_VERSION_UNSUPPORTED",
    );
    expect(prepared.accountSwitch.domains.future?.strategyConfig?.spec).toEqual(
      futureSpec,
    );
    expect(prepared.accountSwitch.domains.future?.vars).toEqual({
      publicSetting: "keep",
    });
    expect(
      prepared.accountSwitch.accounts.find((account) => account.id === "bound-account")
        ?.domains,
    ).toContain("future");
    expect(prepared.summary.accounts).toBe(1);
    expect(prepared.summary.secrets).toBe(1);
    expect(prepared.summary.overwrittenTools).toEqual(
      expect.arrayContaining(["account-switch", "theme"]),
    );
    expect(storageSet).not.toHaveBeenCalled();
  });

  it("支持的已知 v2 结构损坏仍是整包错误", async () => {
    const config = accountConfig();
    config.domains.supported!.strategyConfig!.spec = {
      ...supportedSpec(),
      success: [],
    };
    await expect(preparePlaintextBackupImport(fullBackup(config))).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    expect(storageSet).not.toHaveBeenCalled();
  });

  it("确认后秘密进入保险库，普通配置只保留引用", async () => {
    const prepared = await preparePlaintextBackupImport(fullBackup());
    await expect(commitPreparedBackupImport(prepared)).resolves.toMatchObject({
      success: true,
      importedSecretCount: 1,
    });
    const raw = storage.get("devtools-account-switch");
    expect(JSON.stringify(raw)).not.toContain("SAVED-PASSWORD-91");
    expect(await resolveSecret(accountCredentialId("bound-account"))).toBe(
      "SAVED-PASSWORD-91",
    );
    expect(storage.get("devtools-theme")).toBe("light");
  });

  it("保险库写入后配置提交失败会恢复配置和密文", async () => {
    const beforeImport = snapshot();
    const prepared = await preparePlaintextBackupImport(fullBackup());
    let failOnce = true;
    const originalSet = storageSet.getMockImplementation();
    storageSet.mockImplementation(async (values: Record<string, unknown>) => {
      if (failOnce && Object.hasOwn(values, "devtools-account-switch")) {
        failOnce = false;
        throw new Error("simulated config write failure");
      }
      await originalSet?.(values);
    });

    await expect(commitPreparedBackupImport(prepared)).rejects.toThrow(
      "simulated config write failure",
    );
    storageSet.mockImplementation(originalSet!);
    expect(snapshot()).toEqual(beforeImport);
  });

  it("首次使用保险库的失败导入回滚后，同生命周期保存的秘密在重启后仍可读取", async () => {
    // 全新配置：导入前没有任何保险库元数据/密文。封存恢复快照本身会创建
    // 保险库，因此回滚会把这份「导入期间新建」的元数据一并删除。
    const prepared = await preparePlaintextBackupImport(fullBackup());
    const originalSet = storageSet.getMockImplementation();
    let tampered = false;
    storageSet.mockImplementation(async (values: Record<string, unknown>) => {
      if (!tampered && Object.hasOwn(values, VAULT_STORAGE_KEY)) {
        tampered = true;
        const records = structuredClone(
          values[VAULT_STORAGE_KEY],
        ) as Record<string, { ciphertext: string }>;
        const first = Object.values(records)[0];
        if (first) first.ciphertext = "AAAA";
        storage.set(VAULT_STORAGE_KEY, records);
        return;
      }
      await originalSet?.(values);
    });

    await expect(commitPreparedBackupImport(prepared)).rejects.toBeTruthy();
    storageSet.mockImplementation(originalSet!);
    expect(storage.has(VAULT_META_KEY)).toBe(false);
    expect(storage.has(VAULT_STORAGE_KEY)).toBe(false);
    expect(storage.has(IMPORT_JOURNAL_KEY)).toBe(false);

    // 同一 Service Worker 生命周期内继续保存：不得复用已被回滚删除的 DEK。
    const ref = accountCredentialId("after-rollback");
    await putSecret(ref, "PASSWORD-AFTER-ROLLBACK-57");
    expect(storage.has(VAULT_META_KEY)).toBe(true);

    // 模拟 worker 重启：只能依靠新写入的元数据重新解包。
    clearCachedDek();
    await expect(resolveSecret(ref)).resolves.toBe("PASSWORD-AFTER-ROLLBACK-57");
  });

  it("仅显式完整备份导出物化明文，并排除保险库与本地版本元数据", async () => {
    const config = accountConfig();
    const account = config.accounts[0]!;
    delete account.password;
    account.credentialRef = accountCredentialId(account.id);
    storage.set("devtools-account-switch", structuredClone(config));
    await putSecret(account.credentialRef, "SAVED-PASSWORD-91");

    const backup = await exportPlaintextBackup();
    expect(backup.__version).toBe(CONFIG_VERSION);
    expect(JSON.stringify(backup)).toContain("SAVED-PASSWORD-91");
    expect(backup).not.toHaveProperty("devtools-account-switch-vault");
    expect(backup).not.toHaveProperty("account-switch-vault");
    expect(JSON.stringify(backup)).not.toContain("wrappedDek");
    expect(JSON.stringify(backup)).not.toContain("declaredSpecVersion");
    const portable = backup["account-switch"] as AccountSwitchConfig;
    expect(portable.domains.future?.strategyConfig?.spec).toEqual(futureSpec);
  });
});
