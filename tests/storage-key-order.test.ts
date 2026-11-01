import { beforeEach, describe, expect, it, vi } from "vitest";

const keyStore = vi.hoisted(() => ({ kek: undefined as CryptoKey | undefined }));
vi.mock("../entrypoints/shared/security/crypto-key-store", () => ({
  loadVaultKek: vi.fn(async () => keyStore.kek),
  saveVaultKek: vi.fn(async (kek: CryptoKey) => { keyStore.kek = kek; }),
  deleteVaultKek: vi.fn(async () => { keyStore.kek = undefined; }),
}));

import {
  accountCredentialId,
  migratePlaintextSecrets,
  saveAccountSwitchConfig,
} from "../entrypoints/tools/account-switch/secret-migration";
import {
  commitPreparedBackupImport,
  preparePlaintextBackupImport,
} from "../entrypoints/shared/security/backup-service";
import {
  clearCachedDek,
  resolveSecret,
} from "../entrypoints/shared/security/vault-service";
import { storageValuesEqual } from "../entrypoints/shared/security/canonical-json";
import { CONFIG_VERSION } from "../entrypoints/shared/tool-config";
import type { AccountSwitchConfig } from "../entrypoints/tools/account-switch/types";

/**
 * 模拟 Chrome 的 chrome.storage.local：对象键在写入/读回时按字典序重排。
 * 实测（Chrome + CDP）读回值形如 {"a":2,"z":1}，与写入顺序无关。
 */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortDeep((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function stored(value: unknown): unknown {
  return JSON.parse(JSON.stringify(sortDeep(value)));
}

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
    storage.set(key, stored(value));
  }
});
const storageRemove = vi.fn(async (keys: string | string[]) => {
  for (const key of Array.isArray(keys) ? keys : [keys]) storage.delete(key);
});

vi.stubGlobal("chrome", {
  permissions: { contains: async () => true, request: async () => true },
  storage: { local: { get: storageGet, set: storageSet, remove: storageRemove } },
});
vi.stubGlobal("navigator", {
  locks: { request: <T>(_name: string, operation: () => Promise<T>) => operation() },
});

function emptyConfig(): AccountSwitchConfig {
  return { accounts: [], domains: {}, strategies: {} };
}

function legacyAccountConfig(): AccountSwitchConfig {
  return {
    accounts: [
      {
        id: "acc-1",
        name: "Alice",
        username: "alice",
        password: "SAVED-PASSWORD-91",
        roles: [],
        domains: ["https://private.test"],
      },
    ],
    domains: {
      "https://private.test": { name: "Private", tags: [] },
    },
    strategies: {},
  };
}

function fullBackup(): string {
  return JSON.stringify({
    __version: CONFIG_VERSION,
    "account-switch": {
      accounts: [
        {
          id: "bound-account",
          name: "Alice",
          username: "alice",
          password: "SAVED-PASSWORD-91",
          roles: [],
          domains: [],
        },
      ],
      domains: {},
      strategies: {},
    },
  });
}

beforeEach(() => {
  storage.clear();
  keyStore.kek = undefined;
  clearCachedDek();
  vi.clearAllMocks();
});

describe("storageValuesEqual", () => {
  it("忽略任意层级的对象键顺序", () => {
    expect(
      storageValuesEqual(
        { z: 1, a: { y: 2, x: [{ b: 3, a: 4 }] } },
        { a: { x: [{ a: 4, b: 3 }], y: 2 }, z: 1 },
      ),
    ).toBe(true);
  });

  it("数组顺序和值差异仍然敏感", () => {
    expect(storageValuesEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(storageValuesEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(storageValuesEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it("undefined 属性按 storage 语义视为不存在", () => {
    expect(storageValuesEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
  });
});

describe("Chrome storage key ordering", () => {
  it("迁移明文密码不受读回键序影响", async () => {
    storage.set("devtools-account-switch", stored(legacyAccountConfig()));

    await expect(migratePlaintextSecrets()).resolves.toMatchObject({
      migrated: true,
      count: 1,
    });
    expect(await resolveSecret(accountCredentialId("acc-1"))).toBe(
      "SAVED-PASSWORD-91",
    );
    const raw = storage.get("devtools-account-switch") as AccountSwitchConfig;
    expect(raw.accounts[0]).not.toHaveProperty("password");
    expect(raw.accounts[0]?.credentialRef).toBe(accountCredentialId("acc-1"));
  });

  it("保存公共配置不受读回键序影响", async () => {
    storage.set("devtools-account-switch", stored(emptyConfig()));

    await expect(
      saveAccountSwitchConfig({ quickLoginDefaultDomain: "https://private.test" }),
    ).resolves.toMatchObject({
      quickLoginDefaultDomain: "https://private.test",
    });
  });

  it("导入明文完整备份不受读回键序影响", async () => {
    storage.set("devtools-account-switch", stored(emptyConfig()));
    const prepared = await preparePlaintextBackupImport(fullBackup());

    await expect(commitPreparedBackupImport(prepared)).resolves.toMatchObject({
      success: true,
      importedSecretCount: 1,
    });
    expect(await resolveSecret(accountCredentialId("bound-account"))).toBe(
      "SAVED-PASSWORD-91",
    );
  });
});
