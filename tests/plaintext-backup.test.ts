import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  commitPreparedBackupImport,
  exportPlaintextBackup,
  preparePlaintextBackupImport,
} from "../entrypoints/shared/security/backup-service";
import { CONFIG_VERSION } from "../entrypoints/shared/tool-config";

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

vi.stubGlobal("chrome", {
  storage: { local: { get: storageGet, set: storageSet, remove: vi.fn(async () => {}) } },
});
vi.stubGlobal("navigator", {
  locks: { request: <T>(_name: string, operation: () => Promise<T>) => operation() },
});

const plaintextConfig = {
  accounts: [
    { id: "acc-1", name: "Alice", username: "alice", password: "SAVED-PASSWORD", roles: [], domains: [] },
  ],
  domains: {
    "https://env.test": { name: "Env", tags: [], defaultPassword: "ENV-PASSWORD" },
  },
  strategies: {},
  globalDefaultPassword: "GLOBAL-PASSWORD",
};

beforeEach(() => {
  storage.clear();
  vi.clearAllMocks();
});

describe("明文完整备份", () => {
  it("导出直接使用存储里的明文配置", async () => {
    storage.set("devtools-account-switch", structuredClone(plaintextConfig));
    const backup = await exportPlaintextBackup();
    expect(backup["account-switch"]).toEqual(plaintextConfig);
    expect(backup.__version).toBe(CONFIG_VERSION);
    expect(JSON.stringify(backup)).toContain("SAVED-PASSWORD");
  });

  it("预览统计环境/账号/策略，确认后写入明文", async () => {
    const prepared = await preparePlaintextBackupImport(
      JSON.stringify({ __version: CONFIG_VERSION, "account-switch": plaintextConfig }),
    );
    expect(prepared.summary).toMatchObject({ accounts: 1, strategies: 0 });
    expect(prepared.summary.environments.map((env) => env.name)).toEqual(["Env"]);

    await expect(commitPreparedBackupImport(prepared)).resolves.toEqual({ success: true });
    expect(storage.get("devtools-account-switch")).toEqual(plaintextConfig);
  });

  it("拒绝仍带旧版保险库引用的备份", async () => {
    await expect(
      preparePlaintextBackupImport(
        JSON.stringify({
          __version: CONFIG_VERSION,
          "account-switch": {
            accounts: [{ id: "a", name: "A", username: "a", credentialRef: "account:a", roles: [], domains: [] }],
            domains: {},
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("拒绝高于当前版本的备份", async () => {
    await expect(
      preparePlaintextBackupImport(JSON.stringify({ __version: CONFIG_VERSION + 1, theme: "dark" })),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});
