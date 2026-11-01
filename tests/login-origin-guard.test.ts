import { beforeEach, describe, expect, it, vi } from "vitest";
import { runSpec } from "../entrypoints/tools/account-switch/spec/run";
import { assertPageOnExactOrigin } from "../entrypoints/tools/account-switch/runtime/origin-guard";
import type { PagePort } from "../entrypoints/tools/account-switch/runtime/host";
import type { AuthContext } from "../entrypoints/tools/account-switch/types";
import type { LoginSpec } from "../entrypoints/tools/account-switch/spec/types";

const origin = "https://current.example.com";
const tabsGet = vi.fn();
const executeScript = vi.fn();
const cookieSet = vi.fn();

vi.stubGlobal("chrome", {
  permissions: { contains: async () => true, request: async () => true },
  tabs: {
    get: (...args: unknown[]) => tabsGet(...args),
    update: vi.fn(),
    reload: vi.fn(),
  },
  scripting: {
    executeScript: (...args: unknown[]) => executeScript(...args),
  },
  cookies: {
    set: (...args: unknown[]) => cookieSet(...args),
    getAll: vi.fn(async () => []),
    remove: vi.fn(),
  },
});

const ctx: AuthContext = {
  tabId: 42,
  origin,
  domainConfig: { name: "当前环境", tags: [] },
  credentials: { username: "alice", password: "origin-test-password" },
  tokenData: null,
};

function specWith(op: LoginSpec["ops"][number], auth: LoginSpec["auth"] = { mode: "page" }): LoginSpec {
  return { version: 2, ops: [op], success: [], auth };
}

beforeEach(() => {
  vi.clearAllMocks();
  tabsGet.mockResolvedValue({ id: 42, url: "https://evil.test/after-navigation" });
  executeScript.mockResolvedValue([{ result: false }]);
  cookieSet.mockResolvedValue(null);
});

describe("runSpec 异步 origin 防线", () => {
  it("页面已导航到其他 origin 时，在认证 Cookie 写入前拒绝", async () => {
    const result = await runSpec(specWith(
      { op: "auth.write" },
      { mode: "engine", cookiesWrite: [{ name: "session", value: "secret-session-value" }] },
    ), ctx);

    expect(result).toMatchObject({ success: false, errorCode: "INJECT_AUTH_FAILED" });
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("页面已导航到其他 origin 时，在页面脚本副作用前拒绝", async () => {
    const result = await runSpec(specWith({
      op: "script",
      code: "globalThis.__originGuardSideEffect = true",
      as: "result",
      world: "MAIN",
    }), ctx, {
      onOp: (event) => {
        if (event.phase === "start") executeScript.mockClear();
      },
    });

    expect(result).toMatchObject({ success: false, errorCode: "LOGIN_REJECTED" });
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("实际 origin 未变化时保留既有会话写入行为", async () => {
    tabsGet.mockResolvedValue({ id: 42, url: `${origin}/login` });
    const result = await runSpec(specWith(
      { op: "auth.write" },
      { mode: "engine", cookiesWrite: [{ name: "session", value: "secret-session-value" }] },
    ), ctx);

    expect(result.success).toBe(true);
    expect(cookieSet).toHaveBeenCalledOnce();
  });

  it("通配符环境在匹配的具体子域上继续执行", async () => {
    tabsGet.mockResolvedValue({ id: 42, url: "https://app.example.com/home" });
    const wildcardCtx: AuthContext = {
      ...ctx,
      origin: "https://*.example.com",
    };
    const result = await runSpec(specWith({
      op: "script",
      code: "globalThis.__wildcardSideEffect = true",
      as: "result",
      world: "MAIN",
    }), wildcardCtx);

    expect(result.success).toBe(true);
    expect(executeScript).toHaveBeenCalled();
  });

  it("非默认端口一致（含 path/hash）时继续执行", async () => {
    tabsGet.mockResolvedValue({
      id: 42,
      url: "http://app.dev.example.com:16800/app/#/index",
    });
    const portCtx: AuthContext = {
      ...ctx,
      origin: "http://app.dev.example.com:16800",
    };
    const result = await runSpec(specWith({
      op: "script",
      code: "globalThis.__portSideEffect = true",
      as: "result",
      world: "MAIN",
    }), portCtx);

    expect(result.success).toBe(true);
    expect(executeScript).toHaveBeenCalled();
  });

  it("回归：端口一致时第 1 步 extract local:language 可正常执行", async () => {
    tabsGet.mockResolvedValue({
      id: 42,
      url: "http://app.dev.example.com:16800/app/#/dashboard/index",
    });
    executeScript.mockResolvedValue([{ result: { language: "zh-CN" } }]);
    const portCtx: AuthContext = {
      ...ctx,
      origin: "http://app.dev.example.com:16800",
    };
    const result = await runSpec({
      version: 2,
      ops: [
        {
          op: "extract",
          source: "local",
          key: "language",
          as: "language",
        },
      ],
      success: [{ page: { type: "fixed", ms: 0 } }],
      auth: { mode: "page" },
    }, portCtx);

    expect(result.success).toBe(true);
  });

  it("页面端口漂移时在副作用前拒绝", async () => {
    tabsGet.mockResolvedValue({
      id: 42,
      url: "http://app.dev.example.com:16801/app/#/index",
    });
    const portCtx: AuthContext = {
      ...ctx,
      origin: "http://app.dev.example.com:16800",
    };
    const result = await runSpec(specWith({
      op: "script",
      code: "globalThis.__portSideEffect = true",
      as: "result",
      world: "MAIN",
    }), portCtx, {
      onOp: (event) => {
        if (event.phase === "start") executeScript.mockClear();
      },
    });

    expect(result).toMatchObject({ success: false, errorCode: "LOGIN_REJECTED" });
    expect(executeScript).not.toHaveBeenCalled();
  });
});

describe("origin 防线通配符匹配", () => {
  const pageAt = (url: string) =>
    ({ currentUrl: async () => url }) as unknown as PagePort;

  it("允许匹配的具体子域", async () => {
    await expect(
      assertPageOnExactOrigin(
        pageAt("https://app.example.com/home"),
        "https://*.example.com",
      ),
    ).resolves.toBeUndefined();
  });

  it("拒绝不匹配的站点", async () => {
    await expect(
      assertPageOnExactOrigin(
        pageAt("https://evil.test/home"),
        "https://*.example.com",
      ),
    ).rejects.toMatchObject({ code: "LOGIN_REJECTED" });
  });

  it("允许端口一致的具体子域（通配符 + 非默认端口）", async () => {
    await expect(
      assertPageOnExactOrigin(
        pageAt("http://app.dev.example.com:16800/app/#/index"),
        "http://*.dev.example.com:16800",
      ),
    ).resolves.toBeUndefined();
  });

  it("拒绝端口不一致的具体子域", async () => {
    await expect(
      assertPageOnExactOrigin(
        pageAt("http://app.dev.example.com:16801/app/#/index"),
        "http://*.dev.example.com:16800",
      ),
    ).rejects.toMatchObject({ code: "LOGIN_REJECTED" });
  });

  it("拒绝协议不一致的具体子域", async () => {
    await expect(
      assertPageOnExactOrigin(
        pageAt("https://app.dev.example.com:16800/home"),
        "http://*.dev.example.com:16800",
      ),
    ).rejects.toMatchObject({ code: "LOGIN_REJECTED" });
  });

  it("拒绝多级子域（单层通配符只匹配一级）", async () => {
    await expect(
      assertPageOnExactOrigin(
        pageAt("https://a.b.example.com/home"),
        "https://*.example.com",
      ),
    ).rejects.toMatchObject({ code: "LOGIN_REJECTED" });
  });
});
