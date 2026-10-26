import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  finalizeNewEnvironmentSave,
  lockPreparedLoginForm,
  newEnvironmentSaveMessage,
  prepareLoginFormLock,
  type PreparedLoginFormLock,
} from "../entrypoints/tools/account-switch/login-form-lock";
import { defaultLoginSpec } from "../entrypoints/tools/account-switch/spec/editor";
import type { LoginSpec } from "../entrypoints/tools/account-switch/spec/types";
import type { AccountSwitchConfig, DomainConfig } from "../entrypoints/tools/account-switch/types";

const ENV_KEY = "https://example.test/login";
const STORAGE_KEY = "devtools-account-switch";
let store: Record<string, unknown>;
let setFailure: Error | null;

const tabsQuery = vi.fn();
const tabsGetCurrent = vi.fn();
const tabsGet = vi.fn();
const executeScript = vi.fn();
const storageSet = vi.fn();
const sendMessage = vi.fn();

vi.stubGlobal("chrome", {
  storage: {
    local: {
      get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.map((key) => [key, store[key]]))),
      set: storageSet,
    },
  },
  tabs: { query: tabsQuery, getCurrent: tabsGetCurrent, get: tabsGet },
  scripting: { executeScript },
  runtime: { sendMessage },
});

function autoSpec(): LoginSpec {
  return defaultLoginSpec();
}

function domain(spec: LoginSpec): DomainConfig {
  return { name: "Example", tags: ["test"], loginMethod: "generic", strategyConfig: { spec } };
}

function writeConfig(config: AccountSwitchConfig): void {
  store[STORAGE_KEY] = config;
}

function readConfig(): AccountSwitchConfig {
  return store[STORAGE_KEY] as AccountSwitchConfig;
}

function resolvedInjection(frameId = 0) {
  return [{
    frameId,
    result: {
      found: true,
      ...(frameId ? { frameUrl: "https://example.test/frame" } : {}),
      username: { target: "#u", count: 1, rank: 0, note: "" },
      password: { target: "#p", count: 1, rank: 0, note: "" },
      submit: { target: "#go", count: 1, rank: 0, note: "" },
    },
  }];
}

function prepared(overrides: Partial<PreparedLoginFormLock> = {}): PreparedLoginFormLock {
  return { operationId: "op-1", envKey: ENV_KEY, expectedSpec: autoSpec(), tabId: 7, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  store = {};
  setFailure = null;
  tabsQuery.mockResolvedValue([]);
  tabsGetCurrent.mockResolvedValue({ id: 999 });
  tabsGet.mockResolvedValue({ id: 7, url: ENV_KEY, status: "complete" });
  executeScript.mockResolvedValue(resolvedInjection());
  sendMessage.mockResolvedValue({ status: "locked" });
  storageSet.mockImplementation(async (items: Record<string, unknown>) => {
    if (setFailure) throw setFailure;
    Object.assign(store, items);
  });
});

describe("prepareLoginFormLock", () => {
  it("returns immediately without scanning when no http(s) environment tab matches", async () => {
    tabsQuery.mockResolvedValue([
      { id: 1, url: "chrome-extension://abc/options.html" },
      { id: 2, url: "https://other.test/login" },
    ]);

    await expect(prepareLoginFormLock({ envKey: ENV_KEY, spec: autoSpec() })).resolves.toBeNull();
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("does not prepare locked specs", async () => {
    const locked = autoSpec();
    locked.ops[1] = { op: "fill", target: "#u", value: "{username}" };
    locked.ops[2] = { op: "fill", target: "#p", value: "{password}" };
    locked.ops[3] = { op: "click", target: "#go" };

    await expect(prepareLoginFormLock({ envKey: ENV_KEY, spec: locked })).resolves.toBeNull();
    expect(tabsQuery).not.toHaveBeenCalled();
  });

  it("prioritizes the exact login path over another same-origin tab", async () => {
    tabsQuery.mockResolvedValue([
      { id: 8, url: "https://example.test/", lastAccessed: 20 },
      { id: 7, url: ENV_KEY, lastAccessed: 10 },
    ]);
    executeScript.mockResolvedValue([{ frameId: 0, result: { found: false } }]);

    await prepareLoginFormLock({ envKey: ENV_KEY, spec: autoSpec() });

    expect(executeScript.mock.calls[0][0]).toMatchObject({ target: { tabId: 7 } });
  });

  it("prepares only one uniquely resolved candidate across matching tabs", async () => {
    tabsQuery.mockResolvedValue([{ id: 7, url: ENV_KEY }]);

    const result = await prepareLoginFormLock({ envKey: ENV_KEY, spec: autoSpec() });

    expect(result).toMatchObject({ envKey: ENV_KEY, tabId: 7, expectedSpec: autoSpec() });
    expect(result?.operationId).toEqual(expect.any(String));
  });

  it("rejects multiple resolved, incomplete and injection-failed candidates", async () => {
    tabsQuery.mockResolvedValue([
      { id: 7, url: ENV_KEY },
      { id: 8, url: "https://example.test/other" },
    ]);
    await expect(prepareLoginFormLock({ envKey: ENV_KEY, spec: autoSpec() })).resolves.toBeNull();

    tabsQuery.mockResolvedValue([{ id: 7, url: ENV_KEY }]);
    executeScript.mockResolvedValue([{ frameId: 0, result: { found: true, password: { target: "#p", count: 1, rank: 0, note: "" } } }]);
    await expect(prepareLoginFormLock({ envKey: ENV_KEY, spec: autoSpec() })).resolves.toBeNull();

    executeScript.mockRejectedValue(new Error("denied"));
    await expect(prepareLoginFormLock({ envKey: ENV_KEY, spec: autoSpec() })).resolves.toBeNull();
  });

  it("caps tab discovery as well as scanning at 1500ms", async () => {
    vi.useFakeTimers();
    tabsQuery.mockImplementation(() => new Promise(() => {}));

    const pending = prepareLoginFormLock({ envKey: ENV_KEY, spec: autoSpec() });
    await vi.advanceTimersByTimeAsync(1500);

    await expect(pending).resolves.toBeNull();
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("times out at 1500ms and ignores a late scan without writing", async () => {
    vi.useFakeTimers();
    tabsQuery.mockResolvedValue([{ id: 7, url: ENV_KEY }]);
    let finish: ((value: unknown) => void) | undefined;
    executeScript.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));

    const pending = prepareLoginFormLock({ envKey: ENV_KEY, spec: autoSpec(), timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(1500);
    await expect(pending).resolves.toBeNull();

    finish?.(resolvedInjection());
    await Promise.resolve();
    expect(storageSet).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("lockPreparedLoginForm", () => {
  it("rescans and updates only the current env form targets and scope", async () => {
    const spec = autoSpec();
    writeConfig({
      accounts: [{ id: "a", name: "A", username: "alice", password: "secret", roles: [], domains: [ENV_KEY] }],
      domains: { [ENV_KEY]: { ...domain(spec), vars: { tenant: "one" } } },
      strategies: {},
    });
    executeScript.mockResolvedValue(resolvedInjection(4));

    const result = await lockPreparedLoginForm(prepared());

    expect(result).toEqual({ status: "locked" });
    const current = readConfig().domains[ENV_KEY];
    const ops = current.strategyConfig!.spec!.ops;
    expect(ops[0]).toEqual(spec.ops[0]);
    expect(ops[4]).toEqual(spec.ops[4]);
    expect(ops.slice(1, 4)).toEqual([
      { op: "fill", target: "#u", value: "{username}", clearFirst: true, frameId: 4, frameUrl: "https://example.test/frame" },
      { op: "fill", target: "#p", value: "{password}", clearFirst: true, frameId: 4, frameUrl: "https://example.test/frame" },
      { op: "click", target: "#go", onNotFound: "fail", frameId: 4, frameUrl: "https://example.test/frame" },
    ]);
    expect(current.vars).toEqual({ tenant: "one" });
    expect(readConfig().accounts[0].password).toBe("secret");
  });

  it("detaches only the current mirror and preserves the library and other mirror", async () => {
    const shared = autoSpec();
    const library = { shared: { name: "Shared", spec: shared, createdAt: 1, updatedAt: 1 } };
    const other = { name: "Other", tags: [], strategyId: "shared" };
    writeConfig({
      accounts: [],
      domains: {
        [ENV_KEY]: { name: "Current", tags: [], strategyId: "shared" },
        "https://other.test": other,
      },
      strategies: library,
    });
    const libraryBefore = structuredClone(library);
    const otherBefore = structuredClone(other);

    const result = await lockPreparedLoginForm(prepared());

    expect(result.status).toBe("locked");
    const current = readConfig().domains[ENV_KEY];
    expect(current.strategyId).toBe("shared");
    expect(current.strategyConfig?.spec?.ops[1]).toMatchObject({ target: "#u" });
    expect(readConfig().strategies).toEqual(libraryBefore);
    expect(readConfig().domains["https://other.test"]).toEqual(otherBefore);
  });

  it("skips deleted, URL-missing or concurrently modified environments", async () => {
    writeConfig({ accounts: [], domains: {}, strategies: {} });
    expect((await lockPreparedLoginForm(prepared())).status).toBe("skipped");

    const changed = autoSpec();
    changed.template = "edited";
    writeConfig({ accounts: [], domains: { [ENV_KEY]: domain(changed) }, strategies: {} });
    expect((await lockPreparedLoginForm(prepared())).status).toBe("skipped");
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("rechecks expectedSpec after scanning so a late result cannot overwrite edits", async () => {
    writeConfig({ accounts: [], domains: { [ENV_KEY]: domain(autoSpec()) }, strategies: {} });
    executeScript.mockImplementation(async () => {
      const latest = readConfig();
      latest.domains[ENV_KEY].strategyConfig!.spec!.template = "edited-by-another-window";
      return resolvedInjection();
    });

    expect((await lockPreparedLoginForm(prepared())).status).toBe("skipped");
    expect(storageSet).not.toHaveBeenCalled();
    expect(readConfig().domains[ENV_KEY].strategyConfig?.spec?.template).toBe("edited-by-another-window");
  });

  it("skips a closed candidate tab and reports storage failure without erasing the base env", async () => {
    writeConfig({ accounts: [], domains: { [ENV_KEY]: domain(autoSpec()) }, strategies: {} });
    tabsGet.mockRejectedValueOnce(new Error("closed"));
    expect((await lockPreparedLoginForm(prepared())).status).toBe("skipped");

    setFailure = new Error("quota");
    expect((await lockPreparedLoginForm(prepared())).status).toBe("failed");
    expect(readConfig().domains[ENV_KEY].strategyConfig?.spec?.ops[1]).toMatchObject({ target: { auto: "login" } });
  });
});

describe("finalizeNewEnvironmentSave", () => {
  it("does not lock or reload after a failed base save", async () => {
    const reload = vi.fn(async () => {});
    const result = await finalizeNewEnvironmentSave({ candidate: prepared(), saveBase: async () => false, reload });

    expect(result).toEqual({ saved: false });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("keeps a successful base save when locking fails and uses honest messages", async () => {
    sendMessage.mockResolvedValue({ status: "failed", reason: "quota" });
    const reload = vi.fn(async () => {});
    const result = await finalizeNewEnvironmentSave({ candidate: prepared(), saveBase: async () => true, reload });

    expect(result).toEqual({ saved: true, lockStatus: "failed" });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(newEnvironmentSaveMessage("failed")).toBe("环境已保存，将自动定位登录表单");
    expect(newEnvironmentSaveMessage("skipped")).not.toContain("已锁定");
    expect(newEnvironmentSaveMessage("locked")).toBe("环境已保存，登录表单已锁定");
    expect(sendMessage.mock.calls[0][0]).toEqual({ type: "LOCK_LOGIN_FORM", ...prepared() });
  });
});
