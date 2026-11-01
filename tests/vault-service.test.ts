import { beforeEach, describe, expect, it, vi } from "vitest";

const keyStore = vi.hoisted(() => ({
  kek: undefined as CryptoKey | undefined,
  failRead: false,
}));

vi.mock("../entrypoints/shared/security/crypto-key-store", () => ({
  loadVaultKek: vi.fn(async () => {
    if (keyStore.failRead) throw new Error("indexeddb unavailable");
    return keyStore.kek;
  }),
  saveVaultKek: vi.fn(async (kek: CryptoKey) => { keyStore.kek = kek; }),
  deleteVaultKek: vi.fn(async () => { keyStore.kek = undefined; }),
}));

import { loadVaultKek, saveVaultKek } from "../entrypoints/shared/security/crypto-key-store";
import {
  clearCachedDek,
  cleanupOrphanSecrets,
  hasSecret,
  openLocalPayload,
  putSecret,
  removeSecret,
  sealLocalPayload,
  resolveSecret,
  VAULT_META_KEY,
  VAULT_STORAGE_KEY,
} from "../entrypoints/shared/security/vault-service";
import type { VaultRecord } from "../entrypoints/shared/security/types";

const storage = new Map<string, unknown>();
const lockQueues = new Map<string, Promise<unknown>>();

function requestLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const previous = lockQueues.get(name) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  lockQueues.set(name, next.catch(() => undefined));
  return next;
}

vi.stubGlobal("navigator", { locks: { request: requestLock } });

vi.stubGlobal("chrome", {
  permissions: { contains: async () => true, request: async () => true },
  storage: {
    local: {
      get: vi.fn(async (keys: string[] | null) => {
        if (keys === null) return Object.fromEntries(storage);
        return Object.fromEntries(keys.filter((key) => storage.has(key)).map((key) => [key, storage.get(key)]));
      }),
      set: vi.fn(async (values: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(values)) storage.set(key, structuredClone(value));
      }),
      remove: vi.fn(async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) storage.delete(key);
      }),
    },
  },
});

beforeEach(async () => {
  storage.clear();
  keyStore.kek = undefined;
  keyStore.failRead = false;
  lockQueues.clear();
  vi.clearAllMocks();
  clearCachedDek();
});

describe("本地恢复副本", () => {
  it("调用方指定的 credential ID 必须参与 AAD 校验", async () => {
    const recovery = await sealLocalPayload("migration-recovery", {
      values: { config: "snapshot" },
    });

    await expect(openLocalPayload("import-recovery", recovery)).rejects.toMatchObject({
      code: "VAULT_AUTH_FAILED",
    });
  });
});

describe("无感保险库宿主生命周期", () => {
  it("Background 内存丢失后无需任何解锁消息即可解包，KEK 不可提取", async () => {
    await putSecret("cred-A", "SAVED-PASSWORD-91");
    clearCachedDek();
    expect(await resolveSecret("cred-A")).toBe("SAVED-PASSWORD-91");
    expect((await loadVaultKek())?.extractable).toBe(false);
    expect(JSON.stringify(Object.fromEntries(storage))).not.toContain("SAVED-PASSWORD-91");
  });

  it("空秘密与普通秘密都完整往返", async () => {
    await putSecret("cred-A", "SAVED-PASSWORD-91");
    await putSecret("cred-empty", "");
    clearCachedDek();
    expect(await resolveSecret("cred-A")).toBe("SAVED-PASSWORD-91");
    expect(await resolveSecret("cred-empty")).toBe("");
  });

  it("并发首次使用只生成一套元数据与 KEK", async () => {
    await Promise.all([
      putSecret("cred-A", "A"),
      putSecret("cred-B", "B"),
    ]);

    expect(saveVaultKek).toHaveBeenCalledTimes(1);
    clearCachedDek();
    expect(await resolveSecret("cred-A")).toBe("A");
    expect(await resolveSecret("cred-B")).toBe("B");
  });

  it("旧主密码或未知元数据返回 VAULT_UNAVAILABLE，绝不转换或删除", async () => {
    await putSecret("cred-A", "SAVED-PASSWORD-91");
    const records = structuredClone(storage.get(VAULT_STORAGE_KEY));
    const legacyMetas = [
      {
        mode: "master",
        wrappedDek: "LEGACY-WRAPPED-DEK",
        kdf: { name: "PBKDF2-SHA-256", iterations: 600_000, salt: "c2FsdA==" },
      },
      { mode: "master", wrappedDek: "LEGACY-WRAPPED-DEK" },
      { wrappedDek: "UNKNOWN-SHAPE" },
    ];
    for (const legacy of legacyMetas) {
      storage.set(VAULT_META_KEY, structuredClone(legacy));
      clearCachedDek();
      await expect(resolveSecret("cred-A")).rejects.toMatchObject({ code: "VAULT_UNAVAILABLE" });
      await expect(hasSecret("cred-A")).rejects.toMatchObject({ code: "VAULT_UNAVAILABLE" });
      await expect(removeSecret("cred-A")).rejects.toMatchObject({ code: "VAULT_UNAVAILABLE" });
      await expect(cleanupOrphanSecrets(new Set())).rejects.toMatchObject({ code: "VAULT_UNAVAILABLE" });
      await expect(putSecret("cred-B", "B")).rejects.toMatchObject({ code: "VAULT_UNAVAILABLE" });
      expect(storage.get(VAULT_META_KEY)).toEqual(legacy);
      expect(storage.get(VAULT_STORAGE_KEY)).toEqual(records);
    }
  });

  it("已缓存 DEK 也不能绕过旧元数据守卫写入", async () => {
    await putSecret("cred-A", "SAVED-PASSWORD-91");
    storage.set(VAULT_META_KEY, {
      mode: "master",
      wrappedDek: "LEGACY-WRAPPED-DEK",
    });
    await expect(putSecret("cred-B", "B")).rejects.toMatchObject({
      code: "VAULT_UNAVAILABLE",
    });
    expect(storage.get(VAULT_STORAGE_KEY)).not.toHaveProperty("cred-B");
  });

  it("显式删除只清理指定秘密", async () => {
    await putSecret("cred-A", "A");
    await putSecret("cred-B", "B");
    await removeSecret("cred-A");
    expect(await resolveSecret("cred-A")).toBeUndefined();
    expect(await resolveSecret("cred-B")).toBe("B");
    expect(await hasSecret("cred-A")).toBe(false);
    expect(await hasSecret("cred-B")).toBe(true);
  });

  it("孤儿清理只移除不再被引用的秘密", async () => {
    await putSecret("cred-A", "A");
    await putSecret("cred-B", "B");
    await cleanupOrphanSecrets(new Set(["cred-A"]));
    expect(await hasSecret("cred-A")).toBe(true);
    expect(await hasSecret("cred-B")).toBe(false);
  });

  it("IndexedDB 不可用时返回 VAULT_UNAVAILABLE，不写明文 DEK 降级", async () => {
    await putSecret("cred-A", "SAVED-PASSWORD-91");
    keyStore.failRead = true;
    clearCachedDek();
    await expect(resolveSecret("cred-A")).rejects.toMatchObject({ code: "VAULT_UNAVAILABLE" });
    const meta = storage.get(VAULT_META_KEY) as Record<string, unknown>;
    const records = storage.get(VAULT_STORAGE_KEY) as Record<string, VaultRecord>;
    expect(meta.wrappedDek).not.toBe("SAVED-PASSWORD-91");
    expect(records["cred-A"].ciphertext).not.toBe("SAVED-PASSWORD-91");
    expect(JSON.stringify(Object.fromEntries(storage))).not.toContain("SAVED-PASSWORD-91");
  });
});
