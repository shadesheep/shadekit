import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChromeHostBridge } from "../entrypoints/tools/account-switch/chrome-host";
import { runSpec } from "../entrypoints/tools/account-switch/runtime";
import type { AuthContext } from "../entrypoints/tools/account-switch/types";
import type { LoginSpec } from "../entrypoints/tools/account-switch/spec/types";

const executeScript = vi.fn(async (_options: unknown) => [{ frameId: 0, result: { status: "ok", count: 1 } }]);
const cookieSet = vi.fn(async (_details: unknown) => undefined);

vi.stubGlobal("chrome", {
  permissions: { contains: async () => true, request: async () => true },
  tabs: {
    get: vi.fn(async () => ({ id: 5, url: "https://app.test/login", status: "complete" })),
    update: vi.fn(async () => undefined),
  },
  scripting: { executeScript: (options: unknown) => executeScript(options) },
  cookies: {
    getAll: vi.fn(async () => []),
    set: (details: unknown) => cookieSet(details),
    remove: vi.fn(async () => undefined),
  },
});

function ctx(): AuthContext {
  return {
    tabId: 5,
    origin: "https://app.test",
    domainConfig: { name: "App", tags: [] },
    credentials: { username: "alice", password: "CHROME-PASSWORD-88" },
    tokenData: null,
  };
}

function input(spec: LoginSpec) {
  const context = ctx();
  return {
    spec,
    inputs: {
      username: context.credentials.username,
      password: context.credentials.password ?? "",
      origin: context.origin,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Chrome HostBridge 适配器", () => {
  it("通过共享 page-agent 执行真实注入 DTO，秘密不进入 trace", async () => {
    const spec: LoginSpec = {
      version: 2,
      ops: [
        { op: "fill", target: "#username", value: "{username}" },
        { op: "fill", target: "#password", value: "{password}" },
        { op: "click", target: "#submit" },
      ],
      success: [],
      auth: { mode: "page" },
    };
    const result = await runSpec(input(spec), createChromeHostBridge(ctx()));
    expect(result.success).toBe(true);
    expect(executeScript).toHaveBeenCalledTimes(8);
    const fill = executeScript.mock.calls.map((call) => call[0] as {
      args: Array<{ action: string; value?: string }>;
    }).find((options) => options.args[0]?.action === "fill" && options.args[0].value === "alice");
    expect(fill).toBeDefined();
    expect(JSON.stringify(result.trace)).not.toContain("CHROME-PASSWORD-88");
  });

  it("通过共享 SessionPort 写入声明 Cookie", async () => {
    const spec: LoginSpec = {
      version: 2,
      ops: [{ op: "auth.write" }],
      success: [],
      auth: {
        mode: "engine",
        cookiesWrite: [{ name: "sid", value: "CHROME-PASSWORD-88", secure: "auto" }],
      },
    };
    const result = await runSpec(input(spec), createChromeHostBridge(ctx()));
    expect(result.success).toBe(true);
    expect(cookieSet).toHaveBeenCalledWith(expect.objectContaining({
      name: "sid", value: "CHROME-PASSWORD-88", secure: true, path: "/",
    }));
  });
});
