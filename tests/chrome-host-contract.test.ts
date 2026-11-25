import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChromeHostBridge } from "../entrypoints/tools/account-switch/chrome-host";
import { runSpec } from "../entrypoints/tools/account-switch/runtime";
import type { AuthContext } from "../entrypoints/tools/account-switch/types";
import type { LoginSpec } from "../entrypoints/tools/account-switch/spec/types";

type ScriptInvocation = { args: Array<{ action?: string }> };
const executeScript = vi.fn(async (_options: ScriptInvocation) => [{ frameId: 0, result: { status: "ok", count: 1 } }]);
const cookieSet = vi.fn(async (_details: unknown) => undefined);
const tabGet = vi.fn(async () => ({ id: 5, url: "https://app.test/login", status: "complete" }));

vi.stubGlobal("chrome", {
  permissions: { contains: async () => true, request: async () => true },
  tabs: {
    get: tabGet,
    update: vi.fn(async () => undefined),
  },
  scripting: { executeScript: (options: ScriptInvocation) => executeScript(options) },
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

  it("urlChanged 只认已提交地址，提交中的 pendingUrl 不算登录成功", async () => {
    const spec: LoginSpec = {
      version: 2,
      ops: [{ op: "click", target: "#submit" }],
      success: [{ page: { type: "any", of: [{ type: "urlChanged" }] } }],
      auth: { mode: "page" },
      limits: { settleMs: 3_000 },
    };
    // 真实时序：点击表单提交按钮的瞬间 pendingUrl 变成 action 地址，登录响应
    // 与 302 跳转尚未提交；这段窗口里 urlChanged 必须保持未满足，否则尾部
    // 刷新会中断仍在途的登录请求。
    let committedUrl = "https://app.test/login";
    let pendingUrl: string | undefined;
    executeScript.mockImplementation(async (options) => {
      const action = options.args[0]?.action;
      if (action === "click") pendingUrl = "https://app.test/j_spring_security_check";
      return [{ frameId: 0, result: action === "scan" ? { status: "notFound", count: 0 } : { status: "ok", count: 1 } }];
    });
    tabGet.mockImplementation(async () => ({
      id: 5,
      url: committedUrl,
      ...(pendingUrl ? { pendingUrl } : {}),
      status: "loading",
    }));
    vi.useFakeTimers();
    try {
      let settled = false;
      const pending = runSpec(input(spec), createChromeHostBridge(ctx()), {
        settle: { pollingIntervalMs: 50 },
      }).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(settled).toBe(false);

      // 302 落地：提交地址成为已提交文档，此时才算 URL 变化
      committedUrl = "https://app.test/jenkins/";
      pendingUrl = undefined;
      await vi.advanceTimersByTimeAsync(200);
      expect((await pending).success).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
