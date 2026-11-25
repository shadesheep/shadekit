import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  readAccountSwitchConfig,
  readAccountSwitchConfigOrDefaults,
  saveAccountSwitchConfig,
} from "../entrypoints/tools/account-switch/config-store";

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
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("配置读取与旧版保险库迁移", () => {
  it("迁移失败时不阻断配置页，保留原配置与旧引用", async () => {
    const legacy = {
      accounts: [
        { id: "a", name: "A", username: "a", credentialRef: "account:a", roles: [], domains: [] },
      ],
      domains: {},
    };
    storage.set("devtools-account-switch", structuredClone(legacy));

    await expect(readAccountSwitchConfig()).resolves.toEqual(legacy);
    expect(storage.get("devtools-account-switch")).toEqual(legacy);
    await expect(readAccountSwitchConfigOrDefaults()).resolves.toEqual(legacy);
  });

  it("保存时保留未能迁移的旧引用，只覆盖提交的字段", async () => {
    const legacy = {
      accounts: [
        { id: "a", name: "A", username: "a", credentialRef: "account:a", roles: [], domains: [] },
      ],
      domains: {},
    };
    storage.set("devtools-account-switch", structuredClone(legacy));

    const saved = await saveAccountSwitchConfig({ showPasswords: false });
    expect(saved).toMatchObject({ showPasswords: false });
    expect(storage.get("devtools-account-switch")).toMatchObject({
      accounts: [{ credentialRef: "account:a" }],
      showPasswords: false,
    });
  });
});
