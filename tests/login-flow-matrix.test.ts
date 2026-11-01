/**
 * 登录入口路由矩阵（QUICK_LOGIN / QUICK_LOGIN_NEW_TAB / SWITCH_ACCOUNT）。
 *
 * 这些用例覆盖「登录请求最终在哪个页面执行」这一层：
 * - 目标 URL 与当前页面同源 → 当前 tab；
 * - 目标 URL 跨源 → 新 tab（不能在错误 origin 上执行配方）；
 * - 通配符环境 → ctx.origin 必须是执行页面的具体 origin（含端口），
 *   不能是 `https://*.example.com` 或 Chromium 编码后的 `%2A` 形式；
 * - 当前页面已离开绑定环境（裸域 / 其他域 / 端口不符 / 协议不符）→ 副作用前拒绝；
 * - 扩展页（无 sender.tab）→ 具体环境走新 tab，通配符环境给出明确提示。
 *
 * 这里把 runLoginSpec 与 tab 尾部导航替换为受控桩，只断言 handler 的外部
 * 可观察行为；配方内部的 origin 防线由 login-origin-guard / session-origin-guard
 * 的用例负责。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NEW_TAB_ID = 88;

const storageGet = vi.fn();
const storageSet = vi.fn(async (..._args: unknown[]) => undefined);
const tabsGet = vi.fn();
const tabsCreate = vi.fn();
const tabsRemove = vi.fn(async (..._args: unknown[]) => undefined);

type LoginCtx = {
  tabId: number;
  origin: string;
  credentials: { username: string; password: string };
};
const runLoginSpec = vi.fn<
  (spec: unknown, ctx: LoginCtx) => Promise<{ success: boolean }>
>();

vi.stubGlobal("chrome", {
  permissions: { contains: async () => true, request: async () => true },
  storage: {
    local: {
      get: (...args: unknown[]) => storageGet(...args),
      set: (...args: unknown[]) => storageSet(...args),
      remove: vi.fn(async () => undefined),
    },
  },
  tabs: {
    get: (...args: unknown[]) => tabsGet(...args),
    create: (...args: unknown[]) => tabsCreate(...args),
    query: vi.fn(async () => []),
    reload: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    remove: (...args: unknown[]) => tabsRemove(...args),
    onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  scripting: { executeScript: vi.fn() },
  cookies: {
    set: vi.fn(),
    getAll: vi.fn(async () => []),
    remove: vi.fn(),
  },
});

vi.mock("../entrypoints/tools/account-switch/spec/login-run", () => ({
  runLoginSpec: (spec: unknown, ctx: LoginCtx) => runLoginSpec(spec, ctx),
}));
vi.mock("../entrypoints/tools/account-switch/login-tab-flow", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../entrypoints/tools/account-switch/login-tab-flow")>();
  return {
    ...actual,
    injectAndNavigate: vi.fn(async () => ({ success: true })),
    refreshAfterSwitch: vi.fn(async () => undefined),
    setupAuthTab: vi.fn(async () => undefined),
  };
});

import {
  handleQuickLogin,
  handleSwitchAccount,
} from "../entrypoints/tools/account-switch/background-handler";
import { releaseLoginLock } from "../entrypoints/tools/account-switch/login-session";
import type { AccountSwitchConfig } from "../entrypoints/tools/account-switch/types";

const CHN_ORIGIN = "https://app.example.com";
const CHN_PAGE = `${CHN_ORIGIN}/#/index`;
const DEV_ORIGIN = "http://app.dev.example.com:16800";
const DEV_PAGE = `${DEV_ORIGIN}/app/#/dashboard/index?packageId=1&qualMode=20&type=1&reviewStep=`;
const MAIN_KEY = "https://*.example.com";
const DEV_KEY = "http://*.dev.example.com:16800";
const OPS_KEY = "https://ops.example.com:10008/";

const loginSpec = {
  version: 2 as const,
  template: "test",
  ops: [
    { op: "extract" as const, source: "local" as const, key: "language", as: "language" },
  ],
  success: [{ page: { type: "fixed" as const, ms: 0 } }],
  auth: { mode: "page" as const },
};

function environment(name: string, defaultPassword?: string) {
  return {
    name,
    tags: [],
    ...(defaultPassword ? { defaultPassword } : {}),
    strategyConfig: { spec: loginSpec },
  };
}

function buildConfig(): AccountSwitchConfig {
  return {
    accounts: [
      {
        id: "acc-main",
        name: "示例环境账号",
        username: "demo-user",
        password: "demo-pass",
        roles: [],
        domains: [MAIN_KEY],
      },
      {
        id: "acc-dev",
        name: "开发环境账号",
        username: "demo-user",
        password: "demo-password",
        roles: [],
        domains: [DEV_KEY],
      },
      {
        id: "acc-ops",
        name: "运维账号",
        username: "ops-user",
        password: "ops-pass",
        roles: [],
        domains: [OPS_KEY],
      },
    ],
    domains: {
      [MAIN_KEY]: environment("示例环境", "demo-default-pass"),
      [DEV_KEY]: environment("开发环境", "dev-default-pass"),
      [OPS_KEY]: environment("运维环境"),
    },
  } as AccountSwitchConfig;
}

let currentTabUrl = CHN_PAGE;
let createdTabUrl = "";

function openPage(url: string): void {
  currentTabUrl = url;
}

function senderAt(url: string, tabId = 1): chrome.runtime.MessageSender {
  return {
    id: "shadekit-test-extension",
    url,
    origin: new URL(url).origin,
    frameId: 0,
    tab: { id: tabId, url },
  } as chrome.runtime.MessageSender;
}

const extensionSender = {
  id: "shadekit-test-extension",
  url: "chrome-extension://test-extension/options.html",
  origin: "chrome-extension://test-extension",
  frameId: 0,
} as chrome.runtime.MessageSender;

beforeEach(() => {
  vi.clearAllMocks();
  storageSet.mockResolvedValue(undefined);
  runLoginSpec.mockResolvedValue({ success: true });
  storageGet.mockImplementation(async (keys: string[]) =>
    keys.includes("devtools-account-switch")
      ? { "devtools-account-switch": buildConfig() }
      : {},
  );
  currentTabUrl = CHN_PAGE;
  createdTabUrl = "";
  tabsGet.mockImplementation(async (tabId: number) => {
    if (tabId === NEW_TAB_ID) {
      return { id: tabId, url: createdTabUrl, status: "complete" };
    }
    return { id: tabId, url: currentTabUrl, status: "complete" };
  });
  tabsCreate.mockImplementation(async (options: { url?: string }) => {
    createdTabUrl = options.url || "";
    return { id: NEW_TAB_ID, url: createdTabUrl, status: "complete" };
  });
});

afterEach(() => {
  releaseLoginLock(1);
  releaseLoginLock(NEW_TAB_ID);
});

describe("QUICK_LOGIN — 按目标 origin 选择执行页面", () => {
  it("回归：当前在 app.example.com，输入另一站点的完整 URL → 在新 tab 登录", async () => {
    const result = await handleQuickLogin(
      DEV_PAGE,
      "demo-user",
      "demo-password",
      true,
      senderAt(CHN_PAGE),
    );

    expect(result.success).toBe(true);
    expect(tabsCreate).toHaveBeenCalledOnce();
    expect(tabsCreate).toHaveBeenCalledWith({ url: DEV_PAGE, active: false });
    expect(runLoginSpec).toHaveBeenCalledOnce();
    expect(runLoginSpec.mock.calls[0]![1]).toMatchObject({
      tabId: NEW_TAB_ID,
      origin: DEV_ORIGIN,
      credentials: { username: "demo-user", password: "demo-password" },
    });
  });

  it("跨源且省略密码时，按目标通配符环境的默认密码登录", async () => {
    await expect(
      handleQuickLogin(DEV_PAGE, "demo-user", undefined, true, senderAt(CHN_PAGE)),
    ).resolves.toMatchObject({ success: true });

    expect(runLoginSpec.mock.calls[0]![1]).toMatchObject({
      origin: DEV_ORIGIN,
      credentials: { username: "demo-user", password: "dev-default-pass" },
    });
  });

  it("同源（仅 path/query/hash 不同）→ 仍在当前 tab 登录", async () => {
    openPage(CHN_PAGE);
    await expect(
      handleQuickLogin(
        `${CHN_ORIGIN}/other?tab=1#section`,
        "demo-user",
        "demo-pass",
        true,
        senderAt(CHN_PAGE),
      ),
    ).resolves.toMatchObject({ success: true });

    expect(tabsCreate).not.toHaveBeenCalled();
    expect(runLoginSpec.mock.calls[0]![1]).toMatchObject({
      tabId: 1,
      origin: CHN_ORIGIN,
    });
  });

  it("同源且环境是通配符 → ctx.origin 使用当前具体子域，而不是通配符 key", async () => {
    openPage(CHN_PAGE);
    await expect(
      handleQuickLogin(
        `${CHN_ORIGIN}/other`,
        "demo-user",
        "demo-pass",
        true,
        senderAt(CHN_PAGE),
      ),
    ).resolves.toMatchObject({ success: true });

    const ctx = runLoginSpec.mock.calls[0]![1];
    expect(ctx.origin).toBe(CHN_ORIGIN);
    expect(ctx.origin).not.toContain("*");
    expect(ctx.origin).not.toContain("%2A");
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it("同源但带非默认端口：端口相同才留在当前 tab", async () => {
    openPage(DEV_PAGE);
    await expect(
      handleQuickLogin(
        `${DEV_ORIGIN}/app/#/other`,
        "demo-user",
        "demo-password",
        true,
        senderAt(DEV_PAGE),
      ),
    ).resolves.toMatchObject({ success: true });

    expect(tabsCreate).not.toHaveBeenCalled();
    expect(runLoginSpec.mock.calls[0]![1]).toMatchObject({
      tabId: 1,
      origin: DEV_ORIGIN,
    });
  });

  it("跨源 + debugRedirect → 在新 tab 的 redirect origin 登录", async () => {
    await expect(
      handleQuickLogin(
        DEV_PAGE,
        "demo-user",
        "demo-password",
        true,
        senderAt(CHN_PAGE),
        "http://localhost:8888",
      ),
    ).resolves.toMatchObject({ success: true });

    expect(tabsCreate).toHaveBeenCalledWith({
      url: "http://localhost:8888",
      active: false,
    });
    expect(runLoginSpec.mock.calls[0]![1]).toMatchObject({
      tabId: NEW_TAB_ID,
      origin: "http://localhost:8888",
    });
  });

  it("目标 URL 非法 → INVALID_URL，不建 tab、不执行配方", async () => {
    const result = await handleQuickLogin(
      "not-a-url",
      "u",
      "p",
      true,
      senderAt(CHN_PAGE),
    );

    expect(result).toMatchObject({ success: false, errorCode: "INVALID_URL" });
    expect(tabsCreate).not.toHaveBeenCalled();
    expect(runLoginSpec).not.toHaveBeenCalled();
  });

  it("跨源新 tab 创建失败 → TAB_CLOSED，不执行配方", async () => {
    tabsCreate.mockRejectedValueOnce(new Error("cannot create tab"));

    const result = await handleQuickLogin(
      DEV_PAGE,
      "demo-user",
      "demo-password",
      true,
      senderAt(CHN_PAGE),
    );

    expect(result).toMatchObject({ success: false, errorCode: "TAB_CLOSED" });
    expect(runLoginSpec).not.toHaveBeenCalled();
  });
});

describe("SWITCH_ACCOUNT — 通配符环境与页面校验", () => {
  it("通配符环境命中当前子域 → 用具体 origin 执行（含非默认端口）", async () => {
    openPage(DEV_PAGE);
    await expect(
      handleSwitchAccount("acc-dev", DEV_KEY, senderAt(DEV_PAGE)),
    ).resolves.toMatchObject({ success: true });

    expect(runLoginSpec).toHaveBeenCalledOnce();
    expect(runLoginSpec.mock.calls[0]![1]).toMatchObject({
      tabId: 1,
      origin: DEV_ORIGIN,
      credentials: { username: "demo-user", password: "demo-password" },
    });
  });

  it("通配符环境命中普通子域 → 用具体 origin 执行", async () => {
    openPage(CHN_PAGE);
    await expect(
      handleSwitchAccount("acc-main", MAIN_KEY, senderAt(CHN_PAGE)),
    ).resolves.toMatchObject({ success: true });

    expect(runLoginSpec.mock.calls[0]![1]).toMatchObject({
      origin: CHN_ORIGIN,
    });
  });

  it("通配符环境不匹配裸域 → 副作用前拒绝", async () => {
    openPage("https://example.com/home");
    const result = await handleSwitchAccount(
      "acc-main",
      MAIN_KEY,
      senderAt("https://example.com/home"),
    );

    expect(result).toMatchObject({ success: false, errorCode: "LOGIN_REJECTED" });
    expect(result.error).toContain("当前页面已离开账号绑定环境");
    expect(runLoginSpec).not.toHaveBeenCalled();
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it("通配符环境不匹配其他站点 → 副作用前拒绝", async () => {
    openPage("https://evil.test/home");
    const result = await handleSwitchAccount(
      "acc-main",
      MAIN_KEY,
      senderAt("https://evil.test/home"),
    );

    expect(result).toMatchObject({ success: false, errorCode: "LOGIN_REJECTED" });
    expect(runLoginSpec).not.toHaveBeenCalled();
  });

  it("具体环境但当前页面已离开 → 副作用前拒绝", async () => {
    const otherPage = "https://other.example.com/home";
    openPage(otherPage);
    const result = await handleSwitchAccount(
      "acc-ops",
      OPS_KEY,
      senderAt(otherPage),
    );

    expect(result).toMatchObject({ success: false, errorCode: "LOGIN_REJECTED" });
    expect(result.error).toContain("当前页面已离开账号绑定环境");
    expect(runLoginSpec).not.toHaveBeenCalled();
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it("通配符环境端口不一致 → 副作用前拒绝", async () => {
    const wrongPortPage = "http://app.dev.example.com:16801/app/#/index";
    openPage(wrongPortPage);
    const result = await handleSwitchAccount(
      "acc-dev",
      DEV_KEY,
      senderAt(wrongPortPage),
    );

    expect(result).toMatchObject({ success: false, errorCode: "LOGIN_REJECTED" });
    expect(runLoginSpec).not.toHaveBeenCalled();
  });

  it("通配符环境协议不一致（https 环境 vs http 页面）→ 拒绝", async () => {
    const httpPage = "http://app.example.com/home";
    openPage(httpPage);
    const result = await handleSwitchAccount(
      "acc-main",
      MAIN_KEY,
      senderAt(httpPage),
    );

    expect(result).toMatchObject({ success: false, errorCode: "LOGIN_REJECTED" });
    expect(runLoginSpec).not.toHaveBeenCalled();
  });

  it("扩展页发起 + 具体环境 → 在新 tab 打开环境地址登录", async () => {
    await expect(
      handleSwitchAccount("acc-ops", OPS_KEY, extensionSender),
    ).resolves.toMatchObject({ success: true });

    expect(tabsCreate).toHaveBeenCalledWith({ url: OPS_KEY, active: false });
    expect(runLoginSpec.mock.calls[0]![1]).toMatchObject({
      tabId: NEW_TAB_ID,
      origin: "https://ops.example.com:10008",
    });
  });

  it("扩展页发起 + 通配符环境 → 明确拒绝，不建 tab、不执行配方", async () => {
    const result = await handleSwitchAccount(
      "acc-main",
      MAIN_KEY,
      extensionSender,
    );

    expect(result).toMatchObject({ success: false, errorCode: "TAB_RESTRICTED" });
    expect(result.error).toContain("通配符");
    expect(tabsCreate).not.toHaveBeenCalled();
    expect(runLoginSpec).not.toHaveBeenCalled();
  });
});
