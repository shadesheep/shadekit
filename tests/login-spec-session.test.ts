/**
 * spec/session — 清理与写会话算子（ADR-0015 D7）
 *
 * 以 `runSpec`（会话算子）为 seam，断言外部可观察行为：发出的 cookie
 * set/remove、storage 原生动作、origin 不符报错、过期时间四种 unit 换算。
 * cookie 写入参数化 setCookie 是本票核心。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface StubCookie {
  name: string;
  value?: string;
  domain: string;
  path: string;
  secure: boolean;
  hostOnly: boolean;
}
interface CookieRemoveDetails {
  url: string;
  name: string;
}

const executeScript = vi.fn();
const tabsGet = vi.fn(async () => ({ url: "https://example.com/home" }));
const cookiesGetAll = vi.fn(
  async () => [] as StubCookie[],
);
const cookiesRemove = vi.fn(async (_d: CookieRemoveDetails) => ({}));
const cookiesSet = vi.fn(async (_d: chrome.cookies.SetDetails) => ({}));

const settleMocks = vi.hoisted(() => ({
  snapshotPasswordField: vi.fn(async () => true),
  currentUrl: vi.fn(async () => "https://example.com/login"),
  evaluateCondition: vi.fn(async () => true),
  detectCaptcha: vi.fn(async () => false),
  waitForSettle: vi.fn(async () => ({ states: [] })),
}));

vi.stubGlobal("chrome", {
  tabs: { get: tabsGet },
  scripting: { executeScript },
  cookies: {
    getAll: cookiesGetAll,
    remove: cookiesRemove,
    set: cookiesSet,
  },
});

import { runSpec } from "../entrypoints/tools/account-switch/spec/run";
import type { LoginSpec } from "../entrypoints/tools/account-switch/spec/types";
import type { AuthContext } from "../entrypoints/tools/account-switch/types";
import { ErrorCodes } from "../entrypoints/tools/account-switch/utils/error-codes";

vi.mock("../entrypoints/tools/account-switch/utils/tab-load", () => ({
  waitForTabLoaded: vi.fn(async () => {}),
}));
vi.mock("../entrypoints/tools/account-switch/login-tab-flow", () => ({
  applyNavigationIntent: vi.fn(async () => {}),
}));
vi.mock(
  "../entrypoints/tools/account-switch/strategies/generic-settle",
  async () => {
    const actual = await vi.importActual<
      typeof import("../entrypoints/tools/account-switch/strategies/generic-settle")
    >("../entrypoints/tools/account-switch/strategies/generic-settle");
    return { ...actual, ...settleMocks };
  },
);

function buildCtx(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    tabId: 5,
    origin: "https://example.com",
    domainConfig: { name: "env", tags: [] },
    credentials: { username: "alice", password: "p@ss" },
    tokenData: null,
    targetUrl: "https://example.com/dashboard",
    debugRedirect: "",
    ...overrides,
  };
}

function spec(ov: Partial<LoginSpec> = {}): LoginSpec {
  return {
    version: 2,
    ops: [],
    vars: [{ name: "token", default: "abc123" }],
    success: [{ page: { type: "formGone" } }],
    auth: { mode: "engine" },
    ...ov,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks 不清实现：重置 executeScript 以防前一个用例的 script 桩泄漏
  executeScript.mockReset();
  executeScript.mockImplementation(async () => [
    { frameId: 0, result: { status: "ok", count: 1 } },
  ]);
  tabsGet.mockReset();
  tabsGet.mockResolvedValue({ url: "https://example.com/home" });
  cookiesGetAll.mockReset();
  cookiesGetAll.mockResolvedValue([]);
  settleMocks.snapshotPasswordField.mockResolvedValue(true);
  settleMocks.currentUrl.mockResolvedValue("https://example.com/login");
  settleMocks.evaluateCondition.mockResolvedValue(true);
  settleMocks.detectCaptcha.mockResolvedValue(false);
});

describe("clear.cookies — 三态范围与 includeParent", () => {
  it("all + includeParent：清除同名域与父域 cookie，无关 host 不受影响", async () => {
    cookiesGetAll.mockResolvedValue([
      { name: "a", domain: "example.com", path: "/", secure: false, hostOnly: true },
      { name: "b", domain: ".example.com", path: "/", secure: false, hostOnly: false },
      { name: "c", domain: "other.com", path: "/", secure: false, hostOnly: true },
    ]);
    const result = await runSpec(
      spec({
        ops: [{ op: "clear.cookies", range: "all", includeParent: true }],
      }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    const removedNames = cookiesRemove.mock.calls.map((c) => c[0].name);
    expect(removedNames.sort()).toEqual(["a", "b"]);
    expect(removedNames).not.toContain("c");
    expect(result.trace[0].status).toBe("success");
    expect(result.trace[0].target).toBe("all (+父域)");
  });

  it("string[] 白名单只清声明的名字", async () => {
    cookiesGetAll.mockResolvedValue([
      { name: "auth", domain: "example.com", path: "/", secure: false, hostOnly: true },
      { name: "sid", domain: "example.com", path: "/", secure: false, hostOnly: true },
    ]);
    const result = await runSpec(
      spec({ ops: [{ op: "clear.cookies", range: ["auth"] }] }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    const removedNames = cookiesRemove.mock.calls.map((c) => c[0].name);
    expect(removedNames).toEqual(["auth"]);
    expect(result.trace[0].target).toBe("auth");
  });

  it("none：不清任何 cookie", async () => {
    const result = await runSpec(
      spec({ ops: [{ op: "clear.cookies", range: "none" }] }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    expect(cookiesRemove).not.toHaveBeenCalled();
    expect(result.trace[0].status).toBe("success");
  });

  it("string[] 白名单 + includeParent：父域同名 cookie 一并清除", async () => {
    cookiesGetAll.mockResolvedValue([
      { name: "auth", domain: "www.example.com", path: "/", secure: false, hostOnly: true },
      { name: "auth", domain: "example.com", path: "/", secure: false, hostOnly: false },
      { name: "auth", domain: "other.com", path: "/", secure: false, hostOnly: true },
    ]);
    const result = await runSpec(
      spec({
        ops: [{ op: "clear.cookies", range: ["auth"], includeParent: true }],
      }),
      buildCtx({ origin: "https://www.example.com" }),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    // 白名单 + includeParent：父域（example.com）的同名 cookie 也被清除
    expect(cookiesRemove).toHaveBeenCalledTimes(2);
  });
});

describe("clear.storage — local / session 与范围", () => {
  it("all 清空两个区，none 不动", async () => {
    const result = await runSpec(
      spec({
        ops: [
          { op: "clear.storage", area: "local", range: "all" },
          { op: "clear.storage", area: "session", range: "none" },
        ],
      }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    const injection = executeScript.mock.calls[0][0] as { args: [string, unknown] };
    expect(injection.args[0]).toBe("local");
    expect(injection.args[1]).toBe("all");
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it("string[] 白名单只删声明键", async () => {
    await runSpec(
      spec({ ops: [{ op: "clear.storage", area: "local", range: ["auth", "token"] }] }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    const call = executeScript.mock.calls[0][0] as unknown as { args: [string, unknown] };
    expect(call.args[1]).toEqual(["auth", "token"]);
  });
});

describe("auth.write — cookie 写入参数化 setCookie", () => {
  it("host-only / path=/ / secure auto / 不写 sameSite（缺省 unspecified）", async () => {
    const result = await runSpec(
      spec({
        ops: [{ op: "auth.write" }],
        auth: {
          mode: "engine",
          cookiesWrite: [{ name: "auth", value: "{token}" }],
        },
      }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    const details = cookiesSet.mock.calls[0][0] as chrome.cookies.SetDetails;
    expect(details.name).toBe("auth");
    expect(details.value).toBe("abc123");
    expect(details.url).toBe("https://example.com/");
    expect(details.secure).toBe(true); // https origin → auto
    expect(details.sameSite).toBeUndefined(); // unspecified 不写
    expect(details.httpOnly).toBeUndefined(); // 默认 false
    expect(details.path).toBe("/");
  });

  it("custom domain / path / httpOnly / sameSite=lax 都能声明", async () => {
    const result = await runSpec(
      spec({
        ops: [{ op: "auth.write" }],
        auth: {
          mode: "engine",
          cookiesWrite: [
            {
              name: "sid",
              value: "{token}",
              domain: ".example.com",
              path: "/app",
              httpOnly: true,
              sameSite: "lax",
              secure: false,
            },
          ],
        },
      }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    const details = cookiesSet.mock.calls[0][0] as chrome.cookies.SetDetails;
    expect(details.domain).toBe(".example.com");
    expect(details.path).toBe("/app");
    expect(details.httpOnly).toBe(true);
    expect(details.sameSite).toBe("lax");
    expect(details.secure).toBe(false);
  });
});

describe("auth.write — expiresFrom 四种 unit", () => {
  it("epochMs → 毫秒转 epoch 秒", async () => {
    executeScript.mockImplementation(
      async (injection: {
        func?: (code: string, bindings: string) => unknown;
        args: [string, string];
      }) => {
        if (injection.func) {
          const [code, bindings] = injection.args;
          return [{ frameId: 0, result: injection.func(code, bindings) }];
        }
        return [{ frameId: 0, result: { status: "ok", count: 1 } }];
      },
    );
    const result = await runSpec(
      spec({
        ops: [
          { op: "script", code: "() => ({ exp: 1700000000000 })", as: "resp" },
          { op: "auth.write" },
        ],
        auth: {
          mode: "engine",
          cookiesWrite: [
            { name: "auth", value: "{token}", expiresFrom: { from: "resp", path: "exp", unit: "epochMs" } },
          ],
        },
      }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    const details = cookiesSet.mock.calls[0][0] as chrome.cookies.SetDetails;
    expect(details.expirationDate).toBe(1700000000);
  });

  it("epochS 原样；iso 解析；relativeSeconds 相对当前时间", async () => {
    // epochS
    executeScript.mockImplementation(
      async (injection: {
        func?: (code: string, bindings: string) => unknown;
        args: [string, string];
      }) => {
        if (injection.func) {
          const [code, bindings] = injection.args;
          return [{ frameId: 0, result: injection.func(code, bindings) }];
        }
        return [{ frameId: 0, result: { status: "ok", count: 1 } }];
      },
    );
    await runSpec(
      spec({
        ops: [{ op: "script", code: "() => ({ exp: 1700000000 })", as: "resp" }, { op: "auth.write" }],
        auth: {
          mode: "engine",
          cookiesWrite: [
            { name: "e", value: "x", expiresFrom: { from: "resp", path: "exp", unit: "epochS" } },
          ],
        },
      }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect((cookiesSet.mock.calls[0][0] as chrome.cookies.SetDetails).expirationDate).toBe(1700000000);

    // iso
    executeScript.mockImplementation(
      async (injection: { func?: (code: string, bindings: string) => unknown; args: [string, string] }) => {
        if (injection.func) {
          const [code, bindings] = injection.args;
          return [{ frameId: 0, result: injection.func(code, bindings) }];
        }
        return [{ frameId: 0, result: { status: "ok", count: 1 } }];
      },
    );
    cookiesSet.mockClear();
    await runSpec(
      spec({
        ops: [{ op: "script", code: "() => ({ exp: '2023-11-14T22:13:20.000Z' })", as: "resp" }, { op: "auth.write" }],
        auth: {
          mode: "engine",
          cookiesWrite: [
            { name: "i", value: "x", expiresFrom: { from: "resp", path: "exp", unit: "iso" } },
          ],
        },
      }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    const isoDate = cookiesSet.mock.calls[0][0] as chrome.cookies.SetDetails;
    expect(isoDate.expirationDate).toBe(1700000000);

    // relativeSeconds
    cookiesSet.mockClear();
    await runSpec(
      spec({
        ops: [{ op: "script", code: "() => ({ exp: 3600 })", as: "resp" }, { op: "auth.write" }],
        auth: {
          mode: "engine",
          cookiesWrite: [
            { name: "r", value: "x", expiresFrom: { from: "resp", path: "exp", unit: "relativeSeconds" } },
          ],
        },
      }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    const relDate = cookiesSet.mock.calls[0][0] as chrome.cookies.SetDetails;
    expect(relDate.expirationDate).toBeCloseTo(Math.floor(Date.now() / 1000) + 3600, 0);
  });

  it("expiresFrom 来源绑定不存在 → LOGIN_REJECTED", async () => {
    executeScript.mockImplementation(
      async (injection: { func?: (code: string, bindings: string) => unknown; args: [string, string] }) => {
        if (injection.func) {
          const [code, bindings] = injection.args;
          return [{ frameId: 0, result: injection.func(code, bindings) }];
        }
        return [{ frameId: 0, result: { status: "ok", count: 1 } }];
      },
    );
    const result = await runSpec(
      spec({
        ops: [{ op: "script", code: "() => ({ other: 1 })", as: "resp" }, { op: "auth.write" }],
        auth: {
          mode: "engine",
          cookiesWrite: [
            { name: "auth", value: "x", expiresFrom: { from: "resp", path: "missing", unit: "epochS" } },
          ],
        },
      }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe(ErrorCodes.LOGIN_REJECTED);
      expect(result.error).toContain("过期时间来源");
    }
  });
});

describe("auth.write — storage 写入 origin 校验", () => {
  it("tab 不在目标 origin 报 INJECT_AUTH_FAILED，不静默写错", async () => {
    tabsGet.mockResolvedValue({ url: "https://evil.example.org/home" });
    const result = await runSpec(
      spec({
        ops: [{ op: "auth.write" }],
        auth: { mode: "engine", localStorageWrite: [{ key: "auth", value: "{token}" }] },
      }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe(ErrorCodes.INJECT_AUTH_FAILED);
    }
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("tab 在目标 origin：storage 写入在文档内执行", async () => {
    const result = await runSpec(
      spec({
        ops: [{ op: "auth.write" }],
        auth: { mode: "engine", localStorageWrite: [{ key: "auth", value: "{token}" }] },
      }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    const call = executeScript.mock.calls[0][0] as unknown as { args: [string, Record<string, string>] };
    expect(call.args[0]).toBe("local");
    expect(call.args[1]).toEqual({ auth: "abc123" });
  });

  it("mode: page 是空操作：不写 cookie 也不写 storage", async () => {
    const result = await runSpec(
      spec({
        ops: [{ op: "auth.write" }],
        auth: {
          mode: "page",
          cookiesWrite: [{ name: "auth", value: "{token}" }],
          localStorageWrite: [{ key: "auth", value: "{token}" }],
        },
      }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    expect(cookiesSet).not.toHaveBeenCalled();
    expect(executeScript).not.toHaveBeenCalled();
  });
});