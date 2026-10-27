import { beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig, updateConfigTransaction } from "../entrypoints/shared/tool-config";

let store: Record<string, unknown>;
const storageSet = vi.fn();

beforeEach(() => {
  store = {
    "devtools-account-switch": {
      accounts: [{ id: "keep" }],
      domains: { old: { name: "old" } },
    },
  };
  storageSet.mockReset();
  storageSet.mockImplementation(async (items: Record<string, unknown>) => {
    Object.assign(store, items);
  });
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.map((key) => [key, store[key]]))),
        set: storageSet,
      },
    },
  });
});

describe("updateConfigTransaction", () => {
  it("skips the write when the guarded mutation returns null", async () => {
    const result = await updateConfigTransaction("account-switch", () => null);

    expect(result).toEqual({ ok: true, changed: false });
    expect(storageSet).not.toHaveBeenCalled();
  });

  it("builds a minimal patch from the latest config inside the transaction", async () => {
    const result = await updateConfigTransaction<{
      accounts: Array<{ id: string }>;
      domains: Record<string, { name: string }>;
    }>("account-switch", (latest) => ({
      domains: { ...latest?.domains, fresh: { name: "fresh" } },
    }));

    expect(result).toEqual({ ok: true, changed: true });
    expect(await getConfig("account-switch")).toEqual({
      accounts: [{ id: "keep" }],
      domains: { old: { name: "old" }, fresh: { name: "fresh" } },
    });
    expect(storageSet).toHaveBeenCalledTimes(1);
  });
});
