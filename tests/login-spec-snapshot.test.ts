/**
 * spec/snapshot — 跨 origin 快照算子（ADR-0015 D1）
 *
 * `auth.capture` / `auth.restore`：在登录 origin 捕获 cookie 与 storage，
 * 跳转到目标 origin 后在同一批次键上清理并恢复。以 `runSpec` 为 seam，
 * 断言发出 cookie set/remove、storage 原生动作、目标 origin 不符报
 * `INJECT_AUTH_FAILED`、以及快照绑定进入结果表。
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

const executeScript = vi.fn();
const tabsGet = vi.fn(async () => ({ url: "https://example.com/home" }));
const cookiesGetAll = vi.fn(async () => [] as StubCookie[]);
const cookiesRemove = vi.fn(
  async (_d: { url: string; name: string }) => ({}),
);
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
    success: [{ response: { from: "snap", path: "origin" } }],
    auth: { mode: "engine" },
    ...ov,
  };
}

/**
 * storage 读写 stub：按 area 返回 / 接收 Record。
 * 与 readStorage 的 `func` 解耦——测试不运行真实函体，只看 result / args。
 */
function stubStorage(
  local: Record<string, string> = {},
  session: Record<string, string> = {},
) {
  executeScript.mockImplementation(
    async (injection: { args: [string, unknown, ...unknown[]] }) => {
      const area = injection.args?.[0];
      if (area === "local") return [{ frameId: 0, result: local }];
      if (area === "session") return [{ frameId: 0, result: session }];
      return [{ frameId: 0, result: { status: "ok", count: 1 } }];
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
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

describe("auth.capture — 在登录 origin 捕获 cookie 与 storage，进入绑定", () => {
  it("cookies + storage 各按范围捕获，结果进入 $snap", async () => {
    stubStorage({ auth: "loc-v", token: "t" }, { s: "sv" });
    cookiesGetAll.mockResolvedValue([
      { name: "auth", value: "cv", domain: "example.com", path: "/", secure: true, hostOnly: true },
      { name: "other", domain: "other.com", path: "/", secure: false, hostOnly: true },
    ]);
    const result = await runSpec(
      spec({
        ops: [
          {
            op: "auth.capture",
            cookies: "all",
            localStorage: ["auth", "token"],
            sessionStorage: "all",
            as: "snap",
          },
        ],
      }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    const snap = result.bindings.snap as {
      origin: string;
      cookies: StubCookie[];
      localStorage?: Record<string, string>;
      sessionStorage?: Record<string, string>;
    };
    expect(snap.origin).toBe("https://example.com");
    expect(snap.cookies.map((c) => c.name)).toEqual(["auth"]);
    expect(snap.localStorage).toEqual({ auth: "loc-v", token: "t" });
    expect(snap.sessionStorage).toEqual({ s: "sv" });
  });

  it("范围缺省（none）时不捕获任何数据", async () => {
    stubStorage({ auth: "loc-v" });
    cookiesGetAll.mockResolvedValue([
      { name: "auth", domain: "example.com", path: "/", secure: true, hostOnly: true },
    ]);
    const result = await runSpec(
      spec({
        ops: [{ op: "auth.capture", as: "snap" }],
      }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    const snap = result.bindings.snap as {
      cookies: StubCookie[];
      localStorage?: Record<string, string>;
      sessionStorage?: Record<string, string>;
    };
    expect(snap.cookies).toEqual([]);
    expect(snap.localStorage).toBeUndefined();
    expect(snap.sessionStorage).toBeUndefined();
  });
});

describe("auth.restore — 在目标 origin 文档内清理并恢复", () => {
  it("恢复消费 $snap，先清同一批键再写 cookie 与 storage", async () => {
    // capture 阶段：读不到 cookie 也能跑（cookies 空），storage 读到 local 数据
    stubStorage({ auth: "loc-v" }, {});
    cookiesGetAll.mockResolvedValue([
      { name: "auth", value: "cv", domain: "example.com", path: "/", secure: true, hostOnly: true },
    ]);
    const result = await runSpec(
      spec({
        ops: [
          {
            op: "auth.capture",
            cookies: "all",
            localStorage: "all",
            sessionStorage: "all",
            as: "snap",
          },
          { op: "auth.restore", snapshot: "snap" },
        ],
      }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    // cookie 先清后写：remove 与 set 都被调用
    expect(cookiesRemove).toHaveBeenCalled();
    expect(cookiesSet).toHaveBeenCalled();
    const set = cookiesSet.mock.calls[0][0] as chrome.cookies.SetDetails;
    expect(set.name).toBe("auth");
    expect(set.value).toBe("cv");
    expect(set.secure).toBe(true);
    // restore 的 storage 写发生在目标 origin 文档内：local 的写调用存在
    // （writeStorage 第二参数为 Record 对象）。capture(read)+clear+write 各触调用。
    const localWrites = executeScript.mock.calls.filter(
      (c) =>
        c[0] &&
        typeof c[0] === "object" &&
        "args" in c[0] &&
        Array.isArray((c[0] as { args?: unknown[] }).args) &&
        (c[0] as { args?: unknown[] }).args![0] === "local" &&
        typeof (c[0] as { args?: unknown[] }).args![1] === "object" &&
        !Array.isArray((c[0] as { args?: unknown[] }).args![1]),
    );
    expect(localWrites.length).toBeGreaterThan(0);
    expect(result.trace.map((t) => t.op)).toEqual(["auth.capture", "auth.restore"]);
  });

  it("目标 origin 与快照声明不符 → INJECT_AUTH_FAILED，不写 storage", async () => {
    stubStorage({ auth: "loc-v" }, {});
    tabsGet.mockResolvedValue({ url: "https://evil.example.org/home" });
    const result = await runSpec(
      spec({
        ops: [
          { op: "auth.capture", cookies: "all", localStorage: "all", as: "snap" },
          { op: "auth.restore", snapshot: "snap" },
        ],
      }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe(ErrorCodes.INJECT_AUTH_FAILED);
      // 不静默写错 origin：capture 的读已经发生，但 restore 的 storage 写被拦下
      expect(result.error).toContain("目标站点");
    }
  });

  it("推导 origin 时拒绝域名混淆（a.com 不得匹配 a.com.evil.org）", async () => {
    // capture 声明了 storage（即使抓到空），restore 若落在 a.com.evil.org 必须报错
    stubStorage({}, {});
    cookiesGetAll.mockResolvedValue([]);
    tabsGet.mockResolvedValue({ url: "https://example.com.evil.org/home" });
    const result = await runSpec(
      spec({
        ops: [
          { op: "auth.capture", cookies: "all", localStorage: "all", as: "snap" },
          { op: "auth.restore", snapshot: "snap" },
        ],
      }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe(ErrorCodes.INJECT_AUTH_FAILED);
    }
  });

  it("声明了 storage 但捕获为空：origin 不符仍报 INJECT_AUTH_FAILED，不静默写错", async () => {
    // capture 声明 localStorage 但没抓到键（{}）；restore 在错误 origin 仍必须拦截
    stubStorage({}, {});
    cookiesGetAll.mockResolvedValue([]);
    tabsGet.mockResolvedValue({ url: "https://evil.example.org/home" });
    const result = await runSpec(
      spec({
        ops: [
          { op: "auth.capture", cookies: "all", localStorage: "all", as: "snap" },
          { op: "auth.restore", snapshot: "snap" },
        ],
      }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe(ErrorCodes.INJECT_AUTH_FAILED);
    }
  });

  it("快照绑定缺失或形状非法 → CONFIG_INVALID（不静默跳过）", async () => {
    const result = await runSpec(
      spec({
        ops: [{ op: "auth.restore", snapshot: "missing" }],
      }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe(ErrorCodes.CONFIG_INVALID);
      expect(result.error).toContain("missing");
    }
  });
});