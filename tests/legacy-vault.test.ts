import { beforeEach, describe, expect, it, vi } from "vitest";

const keyStore = vi.hoisted(() => ({ kek: undefined as CryptoKey | undefined }));
vi.mock("../entrypoints/shared/security/crypto-key-store", () => ({
  loadVaultKek: vi.fn(async () => keyStore.kek),
  saveVaultKek: vi.fn(async (kek: CryptoKey) => { keyStore.kek = kek; }),
  deleteVaultKek: vi.fn(async () => { keyStore.kek = undefined; }),
}));

import { materializeLegacyVault } from "../entrypoints/tools/account-switch/legacy-vault";
import {
  putSecret,
  VAULT_META_KEY,
  VAULT_STORAGE_KEY,
} from "../entrypoints/shared/security/vault-service";

const storage = new Map<string, unknown>();
const storageGet = vi.fn(async (keys: string[] | null) => {
  if (keys === null) return Object.fromEntries(storage);
  return Object.fromEntries(
    keys.filter((key) => storage.has(key)).map((key) => [key, structuredClone(storage.get(key))]),
  );
});
const storageSet = vi.fn(async (values: Record<string, unknown>) => {
  for (const [key, value] of Object.entries(values)) storage.set(key, structuredClone(value));
});
const storageRemove = vi.fn(async (keys: string | string[]) => {
  for (const key of Array.isArray(keys) ? keys : [keys]) storage.delete(key);
});

vi.stubGlobal("chrome", {
  storage: { local: { get: storageGet, set: storageSet, remove: storageRemove } },
});
vi.stubGlobal("navigator", {
  locks: { request: <T>(_name: string, operation: () => Promise<T>) => operation() },
});

beforeEach(() => {
  storage.clear();
  keyStore.kek = undefined;
  vi.clearAllMocks();
});

describe("旧版保险库明文迁移", () => {
  it("把账号/环境/全局密码与 secret 变量还原为明文并清理保险库", async () => {
    await putSecret("account:a", "ACCOUNT-PASSWORD");
    await putSecret("environment:https%3A%2F%2Fenv.test:default", "ENV-PASSWORD");
    await putSecret("global:default", "GLOBAL-PASSWORD");
    await putSecret("environment:https%3A%2F%2Fenv.test:var:apiSecret", "VAR-OVERRIDE");
    await putSecret("environment:https%3A%2F%2Fenv.test:default-var:apiSecret", "PRIVATE-DEFAULT");

    storage.set("devtools-account-switch", {
      accounts: [
        { id: "a", name: "A", username: "a", credentialRef: "account:a", roles: [], domains: [] },
      ],
      domains: {
        "https://env.test": {
          name: "Env",
          tags: [],
          defaultCredentialRef: "environment:https%3A%2F%2Fenv.test:default",
          secretVarRefs: { apiSecret: "environment:https%3A%2F%2Fenv.test:var:apiSecret" },
          strategyConfig: {
            spec: { version: 2, ops: [], vars: [{ name: "apiSecret", secret: true }] },
            secretVarRefs: {
              apiSecret: "environment:https%3A%2F%2Fenv.test:default-var:apiSecret",
            },
          },
        },
      },
      globalDefaultCredentialRef: "global:default",
    });

    await expect(materializeLegacyVault()).resolves.toBe(true);

    const migrated = storage.get("devtools-account-switch") as Record<string, unknown>;
    expect(migrated.accounts).toEqual([
      { id: "a", name: "A", username: "a", password: "ACCOUNT-PASSWORD", roles: [], domains: [] },
    ]);
    const domain = (migrated.domains as Record<string, Record<string, unknown>>)["https://env.test"];
    expect(domain.defaultPassword).toBe("ENV-PASSWORD");
    expect(domain.vars).toEqual({ apiSecret: "VAR-OVERRIDE" });
    expect(domain.secretVarRefs).toBeUndefined();
    const strategyConfig = domain.strategyConfig as { secretVarRefs?: unknown } | undefined;
    expect(strategyConfig?.secretVarRefs).toBeUndefined();
    expect(migrated.globalDefaultPassword).toBe("GLOBAL-PASSWORD");
    expect(migrated.globalDefaultCredentialRef).toBeUndefined();
    expect(storage.has(VAULT_STORAGE_KEY)).toBe(false);
    expect(storage.has(VAULT_META_KEY)).toBe(false);
  });

  it("没有引用时只清理遗留保险库数据", async () => {
    storage.set("devtools-account-switch", {
      accounts: [{ id: "a", name: "A", username: "a", password: "PLAIN", roles: [], domains: [] }],
      domains: {},
    });
    storage.set(VAULT_STORAGE_KEY, { stale: true });

    await expect(materializeLegacyVault()).resolves.toBe(false);
    expect(storage.has(VAULT_STORAGE_KEY)).toBe(false);
    expect(storage.get("devtools-account-switch")).toMatchObject({
      accounts: [{ password: "PLAIN" }],
    });
  });
});
