import { beforeEach, describe, expect, it, vi } from "vitest";

const storageGet = vi.fn();
const storageSet = vi.fn(async (..._args: unknown[]) => undefined);
const tabsGet = vi.fn();
const tabsCreate = vi.fn();
const tabsQuery = vi.fn();
const runLoginSpec = vi.fn<(
  spec: unknown,
  ctx: { credentials: { username: string; password: string }; origin: string },
) => Promise<{ success: boolean }>>();

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
    query: (...args: unknown[]) => tabsQuery(...args),
    reload: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  },
  scripting: { executeScript: vi.fn() },
  cookies: { set: vi.fn(), getAll: vi.fn(), remove: vi.fn() },
});

vi.mock("../entrypoints/tools/account-switch/spec/login-run", () => ({
  runLoginSpec: (
    spec: unknown,
    ctx: { credentials: { username: string; password: string }; origin: string },
  ) => runLoginSpec(spec, ctx),
}));
vi.mock("../entrypoints/tools/account-switch/login-tab-flow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../entrypoints/tools/account-switch/login-tab-flow")>();
  return {
    ...actual,
    injectAndNavigate: vi.fn(async () => ({ success: true })),
    refreshAfterSwitch: vi.fn(async () => undefined),
    setupAuthTab: vi.fn(async () => undefined),
  };
});

import {
  handleQuickLogin,
  handleQuickLoginInNewTab,
  handleSwitchAccount,
  handleTrialSavedAccount,
} from "../entrypoints/tools/account-switch/background-handler";
import { releaseLoginLock } from "../entrypoints/tools/account-switch/login-session";
import { resolveLoginPassword } from "../entrypoints/tools/account-switch/secret-resolver";
import type { AccountSwitchConfig } from "../entrypoints/tools/account-switch/types";
import { logger } from "../entrypoints/shared/logger";

const origin = "https://current.example.com";
const pageUrl = `${origin}/login`;
const sender = {
  id: "shadekit-test-extension",
  url: pageUrl,
  origin,
  frameId: 0,
  tab: { id: 42, url: pageUrl },
} as chrome.runtime.MessageSender;

const spec = {
  version: 2 as const,
  ops: [
    { op: "digest" as const, algorithm: "sha256" as const, input: "{username}", as: "sessionToken" },
  ],
  success: [{ page: { type: "fixed" as const, ms: 0 } }],
  auth: { mode: "page" as const },
};
const config = {
  accounts: [
    {
      id: "acc-current",
      name: "当前账号",
      username: "alice",
      password: "saved-current-password-52d8",
      roles: [],
      domains: [origin],
    },
    {
      id: "acc-other",
      name: "跨环境账号",
      username: "mallory",
      password: "saved-other-password-19c3",
      roles: [],
      domains: ["https://other.example.com"],
    },
  ],
  domains: {
    [origin]: {
      name: "当前环境",
      tags: [],
      defaultPassword: "saved-env-password-81f4",
      strategyConfig: { spec },
    },
    "https://other.example.com": {
      name: "其他环境",
      tags: [],
      strategyConfig: { spec },
    },
  },
  globalDefaultPassword: "saved-global-password-37b6",
};

beforeEach(() => {
  vi.clearAllMocks();
  releaseLoginLock(42);
  storageGet.mockImplementation(async (keys: string[]) =>
    keys.includes("devtools-account-switch")
      ? { "devtools-account-switch": config }
      : {},
  );
  tabsGet.mockResolvedValue({ id: 42, url: pageUrl, status: "complete" });
  tabsQuery.mockResolvedValue([]);
  runLoginSpec.mockResolvedValue({ success: true });
});

describe("Background 按 ID 解析已保存账号", () => {
  it.each([false, true])("弹窗对无入口地址的通配符环境在匹配的活动网页直接切换账号（sender 带 tab：%s）", async (withTab) => {
    const environmentId = "https://*.example.com/ebidding";
    const currentUrl = `${origin}/ebidding/home`;
    const stored: AccountSwitchConfig = {
      ...config,
      accounts: [{ ...config.accounts[0]!, domains: [environmentId] }],
      domains: { [environmentId]: { ...config.domains[origin]!, matchPath: "/ebidding" } },
    };
    storageGet.mockImplementation(async (keys: string[]) =>
      keys.includes("devtools-account-switch") ? { "devtools-account-switch": stored } : {},
    );
    tabsQuery.mockResolvedValue([{ id: 42, url: currentUrl }]);
    tabsGet.mockResolvedValue({ id: 42, url: currentUrl, status: "complete" });

    await expect(handleSwitchAccount("acc-current", environmentId, {
      url: "chrome-extension://shadekit-test-extension/popup.html",
      ...(withTab ? { tab: { id: 99, url: "chrome-extension://shadekit-test-extension/popup.html" } as chrome.tabs.Tab } : {}),
    })).resolves.toMatchObject({ success: true });
    expect(runLoginSpec).toHaveBeenCalledOnce();
    expect(runLoginSpec.mock.calls[0]![1]).toMatchObject({ tabId: 42, origin });
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it.each(["https://other.example.com/ebidding/home", `${origin}/management/home`])(
    "弹窗登录前页面已离开环境时拒绝执行：%s", async (currentUrl) => {
      const environmentId = `${origin}/ebidding`;
      const stored: AccountSwitchConfig = {
        ...config,
        accounts: [{ ...config.accounts[0]!, domains: [environmentId] }],
        domains: { [environmentId]: { ...config.domains[origin]!, matchPath: "/ebidding" } },
      };
      storageGet.mockImplementation(async (keys: string[]) =>
        keys.includes("devtools-account-switch") ? { "devtools-account-switch": stored } : {},
      );
      tabsQuery.mockResolvedValue([{ id: 42, url: currentUrl }]);

      await expect(handleSwitchAccount("acc-current", environmentId, {
        url: "chrome-extension://shadekit-test-extension/popup.html",
      })).resolves.toMatchObject({ success: false, errorCode: "LOGIN_REJECTED" });
      expect(runLoginSpec).not.toHaveBeenCalled();
      expect(tabsCreate).not.toHaveBeenCalled();
      expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    },
  );

  it("当前活动页仍是扩展页时保留按具体环境入口新建标签页登录", async () => {
    const extensionUrl = "chrome-extension://shadekit-test-extension/options.html";
    tabsQuery.mockResolvedValue([{ id: 99, url: extensionUrl }]);
    tabsCreate.mockResolvedValue({ id: 43, url: origin, status: "complete" });
    tabsGet.mockResolvedValue({ id: 43, url: origin, status: "complete" });

    await expect(handleSwitchAccount("acc-current", origin, {
      url: extensionUrl,
      tab: { id: 99, url: extensionUrl } as chrome.tabs.Tab,
    })).resolves.toMatchObject({ success: true });
    expect(tabsCreate).toHaveBeenCalledWith({ url: origin, active: false });
    expect(runLoginSpec.mock.calls[0]![1]).toMatchObject({ tabId: 43, origin });
  });

  it("已停用环境拒绝账号切换、快捷登录和试登录，且不执行登录或新建标签页", async () => {
    const stored: AccountSwitchConfig = structuredClone(config);
    stored.domains[origin].enabled = false;
    storageGet.mockImplementation(async () => ({ "devtools-account-switch": stored }));
    await expect(handleSwitchAccount("acc-current", origin, sender)).resolves.toMatchObject({
      success: false, errorCode: "LOGIN_REJECTED",
    });
    await expect(handleQuickLogin(pageUrl, "alice", "one-shot-password", true, sender)).resolves.toMatchObject({
      success: false, errorCode: "LOGIN_REJECTED",
    });
    await expect(handleQuickLoginInNewTab(pageUrl, "alice", "one-shot-password", true)).resolves.toMatchObject({
      success: false, errorCode: "LOGIN_REJECTED",
    });
    await expect(handleTrialSavedAccount("acc-current", origin)).resolves.toMatchObject({
      ok: false, errorCode: "LOGIN_REJECTED", requestSent: false, sessionWritten: false,
    });
    expect(runLoginSpec).not.toHaveBeenCalled();
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it("只把本次账号与环境的凭据交给受控执行器", async () => {
    await expect(handleSwitchAccount("acc-current", origin, sender)).resolves.toMatchObject({
      success: true,
    });
    expect(runLoginSpec).toHaveBeenCalledOnce();
    expect(runLoginSpec.mock.calls[0][1].credentials).toEqual({
      username: "alice",
      password: "saved-current-password-52d8",
    });
  });

  it("账号无密码时回退环境默认密码", async () => {
    const noAccountPassword = {
      ...config,
      accounts: [{ ...config.accounts[0]!, password: "" }],
    };
    storageGet.mockImplementation(async (keys: string[]) =>
      keys.includes("devtools-account-switch")
        ? { "devtools-account-switch": noAccountPassword }
        : {},
    );
    await expect(handleSwitchAccount("acc-current", origin, sender)).resolves.toMatchObject({
      success: true,
    });
    expect(runLoginSpec.mock.calls[0]![1].credentials.password).toBe(
      "saved-env-password-81f4",
    );
  });

  it("环境无默认密码时回退全局默认密码", async () => {
    const globalOnly = {
      ...config,
      accounts: [{ ...config.accounts[0]!, password: "" }],
      domains: {
        ...config.domains,
        [origin]: { ...config.domains[origin]!, defaultPassword: undefined },
      },
    };
    storageGet.mockImplementation(async (keys: string[]) =>
      keys.includes("devtools-account-switch")
        ? { "devtools-account-switch": globalOnly }
        : {},
    );
    await expect(handleSwitchAccount("acc-current", origin, sender)).resolves.toMatchObject({
      success: true,
    });
    expect(runLoginSpec.mock.calls[0]![1].credentials.password).toBe(
      "saved-global-password-37b6",
    );
  });

  it("三级密码来源全缺时拒绝登录且不执行登录声明", async () => {
    const noPassword = {
      ...config,
      accounts: [{ ...config.accounts[0]!, password: "" }],
      domains: {
        ...config.domains,
        [origin]: { ...config.domains[origin]!, defaultPassword: undefined },
      },
      globalDefaultPassword: undefined,
    };
    storageGet.mockImplementation(async (keys: string[]) =>
      keys.includes("devtools-account-switch")
        ? { "devtools-account-switch": noPassword }
        : {},
    );
    await expect(handleSwitchAccount("acc-current", origin, sender)).resolves.toMatchObject({
      success: false,
      errorCode: "CONFIG_INVALID",
    });
    expect(runLoginSpec).not.toHaveBeenCalled();
  });

  it("运行中的密码即使放入普通日志字段也不会持久化", async () => {
    runLoginSpec.mockImplementation(async (_spec, ctx) => {
      await logger.info("受控运行调试", {
        category: "auth",
        extra: { opaque: ctx.credentials.password },
      });
      return { success: true };
    });

    await handleSwitchAccount("acc-current", origin, sender);
    const logWrites = storageSet.mock.calls
      .map((call) => call[0])
      .filter((value) => typeof value === "object" && value !== null && "devtools-logs" in value);
    expect(logWrites.length).toBeGreaterThan(0);
    expect(JSON.stringify(logWrites)).not.toContain("saved-current-password-52d8");
  });

  it("跨环境账号在任何登录执行或建 tab 前拒绝", async () => {
    await expect(handleSwitchAccount("acc-other", origin, sender)).resolves.toMatchObject({
      success: false,
      errorCode: "LOGIN_REJECTED",
    });
    expect(runLoginSpec).not.toHaveBeenCalled();
    expect(tabsCreate).not.toHaveBeenCalled();
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(chrome.cookies.set).not.toHaveBeenCalled();
  });

  it("环境 key 是完整登录页地址（含路径/hash）时仍按 origin 执行", async () => {
    const legacyKey = `${origin}/management/#/login`;
    const legacyConfig: AccountSwitchConfig = {
      ...config,
      accounts: [{ ...config.accounts[0]!, domains: [legacyKey] }],
      domains: { [legacyKey]: config.domains[origin]! },
    };
    storageGet.mockImplementation(async (keys: string[]) =>
      keys.includes("devtools-account-switch")
        ? { "devtools-account-switch": legacyConfig }
        : {},
    );

    await expect(
      handleSwitchAccount("acc-current", legacyKey, sender),
    ).resolves.toMatchObject({ success: true });
    expect(runLoginSpec.mock.calls[0]![1]).toMatchObject({ origin });
  });
  it("配置页已保存账号试跑由 Background 解析，不返回密码或 bindings", async () => {
    const result = await handleTrialSavedAccount("acc-current", origin);
    expect(result).toMatchObject({ ok: true, requestSent: false, sessionWritten: false });
    expect(JSON.stringify(result)).not.toContain("saved-current-password-52d8");
    expect(result).not.toHaveProperty("bindings");
  });

  it("账号密码为显式空值时按未设置处理，回退环境默认密码", async () => {
    const account = { ...config.accounts[0]!, password: "" };
    await expect(
      resolveLoginPassword(account, config as AccountSwitchConfig, origin),
    ).resolves.toBe("saved-env-password-81f4");
    await expect(
      resolveLoginPassword(
        config.accounts[0]!,
        config as AccountSwitchConfig,
        origin,
      ),
    ).resolves.toBe("saved-current-password-52d8");
  });
});

describe("Background 快捷登录秘密解析", () => {
  it("面板省略密码时使用目标环境默认密码", async () => {
    await expect(handleQuickLogin(
      pageUrl,
      "alice",
      undefined as unknown as string,
      true,
      sender,
    )).resolves.toMatchObject({ success: true });
    expect(runLoginSpec.mock.calls[0][1].credentials).toEqual({
      username: "alice",
      password: "saved-env-password-81f4",
    });
  });

  it("新 tab 快捷登录复用同一 Background 默认密码解析", async () => {
    tabsCreate.mockResolvedValue({ id: 43, url: pageUrl, status: "complete" });
    tabsGet.mockImplementation(async (tabId: number) => ({
      id: tabId,
      url: pageUrl,
      status: "complete",
    }));

    await expect(handleQuickLoginInNewTab(
      pageUrl,
      "alice",
      undefined as unknown as string,
      true,
    )).resolves.toMatchObject({ success: true });
    expect(runLoginSpec.mock.calls[0][1].credentials).toEqual({
      username: "alice",
      password: "saved-env-password-81f4",
    });
  });

  it("用户一次性输入优先，且不会写回普通配置存储", async () => {
    const temporary = "one-shot-password-66e2";
    await expect(handleQuickLogin(
      pageUrl,
      "alice",
      temporary,
      true,
      sender,
    )).resolves.toMatchObject({ success: true });
    expect(runLoginSpec.mock.calls[0][1].credentials.password).toBe(temporary);
    for (const call of storageSet.mock.calls) {
      expect(JSON.stringify(call[0])).not.toContain(temporary);
    }
  });

  it("显式目标 URL 与当前页面不同源时改为在新标签页登录", async () => {
    const targetUrl = "https://other.example.com/login";
    tabsCreate.mockResolvedValue({ id: 43, url: targetUrl, status: "complete" });
    tabsGet.mockImplementation(async (tabId: number) => ({
      id: tabId,
      url: tabId === 43 ? targetUrl : pageUrl,
      status: "complete",
    }));

    await expect(
      handleQuickLogin(
        targetUrl,
        "alice",
        "one-shot-password-66e2",
        true,
        sender,
      ),
    ).resolves.toMatchObject({ success: true });

    expect(tabsCreate).toHaveBeenCalledOnce();
    expect(tabsCreate).toHaveBeenCalledWith({ url: targetUrl, active: false });
    expect(runLoginSpec).toHaveBeenCalledOnce();
    expect(runLoginSpec.mock.calls[0][1]).toMatchObject({
      tabId: 43,
      origin: "https://other.example.com",
    });
  });

  it("目标 URL 与当前页面同源时仍在当前 tab 登录", async () => {
    await expect(
      handleQuickLogin(`${origin}/other-path`, "alice", "one-shot-password", true, sender),
    ).resolves.toMatchObject({ success: true });

    expect(tabsCreate).not.toHaveBeenCalled();
    expect(runLoginSpec.mock.calls[0][1]).toMatchObject({ tabId: 42, origin });
  });
});
