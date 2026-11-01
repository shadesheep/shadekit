import { beforeEach, describe, expect, it, vi } from "vitest";

const keyStore = vi.hoisted(() => ({ kek: undefined as CryptoKey | undefined }));
vi.mock("../entrypoints/shared/security/crypto-key-store", () => ({
  loadVaultKek: vi.fn(async () => keyStore.kek),
  saveVaultKek: vi.fn(async (kek: CryptoKey) => { keyStore.kek = kek; }),
  deleteVaultKek: vi.fn(async () => { keyStore.kek = undefined; }),
}));

import {
  ACCOUNT_CONFIG_WRITE_LOCK,
  accountCredentialId,
  domainDefaultCredentialId,
  domainVarCredentialId,
  globalDefaultCredentialId,
  migratePlaintextSecrets,
  MIGRATION_JOURNAL_KEY,
  saveAccountSwitchConfig,
  strategyVarCredentialId,
} from "../entrypoints/tools/account-switch/secret-migration";
import { resolveLoginSecrets } from "../entrypoints/tools/account-switch/secret-resolver";
import {
  clearCachedDek,
  MIGRATION_RECOVERY_KEY,
  resolveSecret,
  VAULT_STORAGE_KEY,
} from "../entrypoints/shared/security/vault-service";
import type { AccountSwitchConfig } from "../entrypoints/tools/account-switch/types";
import type { LoginSpec } from "../entrypoints/tools/account-switch/spec/types";
import { handleVaultGetConfig } from "../entrypoints/tools/account-switch/vault-background-handler";

const storage = new Map<string, unknown>();
const storageGet = vi.fn(async (keys: string[] | null) => {
  if (keys === null) return Object.fromEntries(storage);
  return Object.fromEntries(keys.filter((key) => storage.has(key)).map((key) => [key, structuredClone(storage.get(key))]));
});
const storageSet = vi.fn(async (values: Record<string, unknown>) => {
  for (const [key, value] of Object.entries(values)) storage.set(key, structuredClone(value));
});
const storageRemove = vi.fn(async (keys: string | string[]) => {
  for (const key of Array.isArray(keys) ? keys : [keys]) storage.delete(key);
});
const tabsCreate = vi.fn();
const cookieSet = vi.fn();
const fetchSpy = vi.fn();

vi.stubGlobal("chrome", {
  permissions: { contains: async () => true, request: async () => true },
  storage: { local: { get: storageGet, set: storageSet, remove: storageRemove } },
  tabs: { create: tabsCreate },
  cookies: { set: cookieSet },
});
vi.stubGlobal("fetch", fetchSpy);

const lockRequests: string[] = [];
const lockQueues = new Map<string, Promise<unknown>>();
function requestLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
  lockRequests.push(name);
  const previous = lockQueues.get(name) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  lockQueues.set(name, next.catch(() => undefined));
  return next;
}
vi.stubGlobal("navigator", { locks: { request: requestLock } });

function spec(secretDefault?: string): LoginSpec {
  return {
    version: 2,
    vars: [
      { name: "token", title: "Token", secret: true, ...(secretDefault === undefined ? {} : { default: secretDefault }) },
      { name: "locale", default: "zh" },
    ],
    ops: [{ op: "goto", url: "{origin}/" }],
    success: [{ page: { type: "fixed", ms: 0 } }],
    auth: { mode: "page" },
  };
}

function legacyConfig(): AccountSwitchConfig {
  return {
    accounts: [
      { id: "acc-1", name: "Alice", username: "alice", password: "ACCOUNT-SECRET-1", roles: [], domains: ["https://private.test"] },
      { id: "acc-empty", name: "Empty", username: "empty", password: "", roles: [], domains: [] },
    ],
    domains: {
      "https://private.test": {
        name: "Private",
        tags: [],
        defaultPassword: "环境密码",
        strategyConfig: { spec: spec("PRIVATE-DEFAULT") },
        vars: { token: "ENV-TOKEN", locale: "en" },
      },
      "https://mirror.test": {
        name: "Mirror",
        tags: [],
        strategyId: "s1",
        vars: { token: "ENV-OVERRIDE" },
      },
    },
    strategies: {
      s1: { name: "Shared", spec: spec("STRATEGY-SECRET"), createdAt: 1, updatedAt: 1 },
    },
    globalDefaultPassword: "GLOBAL-SECRET",
  };
}

beforeEach(async () => {
  storage.clear();
  keyStore.kek = undefined;
  lockRequests.length = 0;
  lockQueues.clear();
  vi.clearAllMocks();
  clearCachedDek();
});

describe("明文秘密迁移与运行时解析", () => {
  it("迁移全部来源并回读核对，普通配置与恢复副本不泄露明文", async () => {
    storage.set("devtools-account-switch", structuredClone(legacyConfig()));
    const result = await migratePlaintextSecrets();
    expect(result.migrated).toBe(true);
    expect(result.count).toBeGreaterThanOrEqual(8);

    expect(await resolveSecret(accountCredentialId("acc-1"))).toBe("ACCOUNT-SECRET-1");
    expect(await resolveSecret(accountCredentialId("acc-empty"))).toBe("");
    expect(await resolveSecret(domainDefaultCredentialId("https://private.test"))).toBe("环境密码");
    expect(await resolveSecret(globalDefaultCredentialId())).toBe("GLOBAL-SECRET");
    expect(await resolveSecret(domainVarCredentialId("https://private.test", "token"))).toBe("ENV-TOKEN");
    expect(await resolveSecret(domainVarCredentialId("https://mirror.test", "token"))).toBe("ENV-OVERRIDE");
    expect(await resolveSecret(strategyVarCredentialId("s1", "token"))).toBe("STRATEGY-SECRET");

    const raw = storage.get("devtools-account-switch") as AccountSwitchConfig;
    const serialized = JSON.stringify(raw);
    expect(serialized).not.toMatch(/ACCOUNT-SECRET-1|环境密码|GLOBAL-SECRET|ENV-TOKEN|ENV-OVERRIDE|STRATEGY-SECRET|PRIVATE-DEFAULT/);
    expect(raw.accounts[0]?.credentialRef).toBe(accountCredentialId("acc-1"));
    expect(raw.accounts[0]).not.toHaveProperty("password");
    expect(raw.domains["https://private.test"]).not.toHaveProperty("defaultPassword");
    const privateSpec = raw.domains["https://private.test"]?.strategyConfig?.spec as
      | { vars?: Array<Record<string, unknown>> }
      | undefined;
    expect(privateSpec?.vars?.[0]).not.toHaveProperty("default");
    const strategySpec = raw.strategies?.s1?.spec as
      | { vars?: Array<Record<string, unknown>> }
      | undefined;
    expect(strategySpec?.vars?.[0]).not.toHaveProperty("default");

    // committed 且引用校验通过后，加密的迁移前副本被删除，不再长期保留。
    expect(storage.has(MIGRATION_RECOVERY_KEY)).toBe(false);
    expect(storage.get(MIGRATION_JOURNAL_KEY)).toMatchObject({ stage: "committed" });

    const privateRun = await resolveLoginSecrets("acc-1", "https://private.test");
    expect(privateRun.password).toBe("ACCOUNT-SECRET-1");
    expect(privateRun.domainConfig.vars).toMatchObject({ token: "ENV-TOKEN", locale: "en" });
    expect(tabsCreate).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("配置页读取先完成迁移，只返回引用配置", async () => {
    storage.set("devtools-account-switch", structuredClone(legacyConfig()));
    const response = await handleVaultGetConfig();
    expect(response.success).toBe(true);
    expect(response.config?.accounts[0]?.credentialRef).toBe(accountCredentialId("acc-1"));
    expect(JSON.stringify(response)).not.toMatch(/ACCOUNT-SECRET-1|环境密码|GLOBAL-SECRET|ENV-TOKEN|PRIVATE-DEFAULT/);
  });

  it("回读认证失败时保留旧配置，重试复用稳定引用且保持幂等", async () => {
    const before = structuredClone(legacyConfig());
    storage.set("devtools-account-switch", structuredClone(before));
    const originalSet = storageSet.getMockImplementation();
    let tampered = false;
    storageSet.mockImplementation(async (values: Record<string, unknown>) => {
      if (!tampered && Object.hasOwn(values, VAULT_STORAGE_KEY)) {
        tampered = true;
        for (const [key, value] of Object.entries(values)) {
          const records = structuredClone(value) as Record<string, { ciphertext: string }>;
          const first = Object.values(records)[0];
          if (first) first.ciphertext = "AAAA";
          storage.set(key, records);
        }
        return;
      }
      await originalSet?.(values);
    });
    await expect(migratePlaintextSecrets()).rejects.toThrow();
    expect(storage.get("devtools-account-switch")).toEqual(before);
    storageSet.mockImplementation(originalSet!);

    await expect(migratePlaintextSecrets()).resolves.toMatchObject({ migrated: true });
    const committed = structuredClone(storage.get("devtools-account-switch"));
    const records = structuredClone(storage.get(VAULT_STORAGE_KEY));
    await expect(migratePlaintextSecrets()).resolves.toMatchObject({ migrated: false });
    expect(storage.get("devtools-account-switch")).toEqual(committed);
    expect(storage.get(VAULT_STORAGE_KEY)).toEqual(records);
  });

  it("配置提交前崩溃保留旧配置，恢复后不生成第二套引用", async () => {
    const before = structuredClone(legacyConfig());
    storage.set("devtools-account-switch", structuredClone(before));
    const originalSet = storageSet.getMockImplementation();
    storageSet.mockImplementation(async (values: Record<string, unknown>) => {
      if (Object.hasOwn(values, "devtools-account-switch")) throw new Error("crash before config commit");
      await originalSet?.(values);
    });
    await expect(migratePlaintextSecrets()).rejects.toThrow("crash before config commit");
    expect(storage.get("devtools-account-switch")).toEqual(before);
    expect(storage.get(MIGRATION_JOURNAL_KEY)).toMatchObject({ stage: "prepared" });

    storageSet.mockImplementation(originalSet!);
    await expect(migratePlaintextSecrets()).resolves.toMatchObject({ migrated: true });
    const refs = JSON.stringify(storage.get("devtools-account-switch")).match(/credentialRef|secretVarRefs/g);
    expect(refs).not.toBeNull();
    await expect(migratePlaintextSecrets()).resolves.toMatchObject({ migrated: false });
  });

  it("引用配置已提交时不重复迁移，引用缺失必须失败而不是重新生成", async () => {
    storage.set("devtools-account-switch", structuredClone(legacyConfig()));
    await migratePlaintextSecrets();
    const committed = structuredClone(storage.get("devtools-account-switch"));
    const records = structuredClone(storage.get(VAULT_STORAGE_KEY)) as Record<string, unknown>;
    delete records[accountCredentialId("acc-1")];
    storage.set(VAULT_STORAGE_KEY, records);
    await expect(migratePlaintextSecrets()).rejects.toMatchObject({ code: "VAULT_UNAVAILABLE" });
    expect(storage.get("devtools-account-switch")).toEqual(committed);
  });

  it("未点名凭证的保存不会移除已存储密码", async () => {
    storage.set("devtools-account-switch", structuredClone(legacyConfig()));
    await migratePlaintextSecrets();

    await saveAccountSwitchConfig({ quickLoginDefaultDomain: "https://private.test" });

    const saved = storage.get("devtools-account-switch") as AccountSwitchConfig;
    expect(saved.quickLoginDefaultDomain).toBe("https://private.test");
    expect(saved.accounts[0]?.credentialRef).toBe(accountCredentialId("acc-1"));
    expect(saved.domains["https://private.test"]?.defaultCredentialRef)
      .toBe(domainDefaultCredentialId("https://private.test"));
    expect(saved.globalDefaultCredentialRef).toBe(globalDefaultCredentialId());
    expect(await resolveSecret(accountCredentialId("acc-1"))).toBe("ACCOUNT-SECRET-1");
    expect(await resolveSecret(domainDefaultCredentialId("https://private.test"))).toBe("环境密码");
    expect(await resolveSecret(globalDefaultCredentialId())).toBe("GLOBAL-SECRET");

    // 空的表单值只表示「本次不写明文」，不再被当成隐式清除。
    await saveAccountSwitchConfig({ globalDefaultPassword: "" });
    const afterEmptyField = storage.get("devtools-account-switch") as AccountSwitchConfig;
    expect(afterEmptyField.globalDefaultCredentialRef).toBe(globalDefaultCredentialId());
    expect(await resolveSecret(globalDefaultCredentialId())).toBe("GLOBAL-SECRET");
  });

  it("显式 clearCredentialRefs 只删除点名密码，其余引用保持可用", async () => {
    storage.set("devtools-account-switch", structuredClone(legacyConfig()));
    await migratePlaintextSecrets();
    const migrated = storage.get("devtools-account-switch") as AccountSwitchConfig;
    const accountRef = migrated.accounts[0]?.credentialRef as string;
    const envRef = migrated.domains["https://private.test"]
      ?.defaultCredentialRef as string;
    const globalRef = migrated.globalDefaultCredentialRef as string;

    await saveAccountSwitchConfig({}, [globalRef, envRef]);

    const saved = storage.get("devtools-account-switch") as AccountSwitchConfig;
    expect(saved.globalDefaultCredentialRef).toBeUndefined();
    expect(saved.domains["https://private.test"]?.defaultCredentialRef).toBeUndefined();
    expect(saved.accounts[0]?.credentialRef).toBe(accountRef);
    expect(await resolveSecret(globalRef)).toBeUndefined();
    expect(await resolveSecret(envRef)).toBeUndefined();
    expect(await resolveSecret(accountRef)).toBe("ACCOUNT-SECRET-1");
    expect(
      await resolveSecret(domainVarCredentialId("https://private.test", "token")),
    ).toBe("ENV-TOKEN");

    await saveAccountSwitchConfig({}, [accountRef]);

    const accountCleared = storage.get("devtools-account-switch") as AccountSwitchConfig;
    expect(accountCleared.accounts[0]?.credentialRef).toBeUndefined();
    expect(await resolveSecret(accountRef)).toBeUndefined();
    expect(
      await resolveSecret(strategyVarCredentialId("s1", "token")),
    ).toBe("STRATEGY-SECRET");
  });

  it("同一保存里的新密码优先于显式清除，不会被清除动作丢掉", async () => {
    storage.set("devtools-account-switch", structuredClone(legacyConfig()));
    await migratePlaintextSecrets();
    const migrated = storage.get("devtools-account-switch") as AccountSwitchConfig;
    const ref = migrated.accounts[0]?.credentialRef as string;

    const nextAccounts = structuredClone(migrated.accounts);
    nextAccounts[0]!.password = "NEW-ACCOUNT-SECRET-42";
    await saveAccountSwitchConfig({ accounts: nextAccounts }, [ref]);

    expect(await resolveSecret(ref)).toBe("NEW-ACCOUNT-SECRET-42");
    const saved = storage.get("devtools-account-switch") as AccountSwitchConfig;
    expect(saved.accounts[0]?.credentialRef).toBe(ref);
    expect(saved.accounts[0]).not.toHaveProperty("password");
  });

  it("启动迁移与配置保存共用同一把写锁，避免并发覆盖", async () => {
    storage.set("devtools-account-switch", structuredClone(legacyConfig()));

    await Promise.all([
      migratePlaintextSecrets(),
      saveAccountSwitchConfig({ quickLoginDefaultDomain: "https://private.test" }),
    ]);

    expect(
      lockRequests.filter((name) => name === ACCOUNT_CONFIG_WRITE_LOCK),
    ).toHaveLength(2);
    const saved = storage.get("devtools-account-switch") as AccountSwitchConfig;
    expect(saved.quickLoginDefaultDomain).toBe("https://private.test");
    expect(saved.accounts[0]?.credentialRef).toBe(accountCredentialId("acc-1"));
    expect(await resolveSecret(accountCredentialId("acc-1"))).toBe("ACCOUNT-SECRET-1");
  });
});
