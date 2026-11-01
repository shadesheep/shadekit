import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  injectAndNavigate,
  refreshAfterSwitch,
  setupAuthTab,
} from "../entrypoints/tools/account-switch/login-tab-flow";

const origin = "https://current.example.com";
const tabsGet = vi.fn();
const tabsUpdate = vi.fn();
const tabsReload = vi.fn();
const tabsCreate = vi.fn();

vi.stubGlobal("chrome", {
  permissions: { contains: async () => true, request: async () => true },
  tabs: {
    get: (...args: unknown[]) => tabsGet(...args),
    update: (...args: unknown[]) => tabsUpdate(...args),
    reload: (...args: unknown[]) => tabsReload(...args),
    create: (...args: unknown[]) => tabsCreate(...args),
    remove: vi.fn(async () => undefined),
  },
  cookies: { set: vi.fn(), getAll: vi.fn(async () => []), remove: vi.fn() },
  scripting: { executeScript: vi.fn() },
});

beforeEach(() => {
  vi.clearAllMocks();
  tabsGet.mockResolvedValue({ id: 42, url: "https://evil.example.com/after-navigation", status: "complete" });
  tabsUpdate.mockResolvedValue({ id: 42 });
  tabsReload.mockResolvedValue(undefined);
});

describe("登录尾部 origin 防线", () => {
  it("账号切换后页面已换 origin 时不刷新或导航", async () => {
    await expect(refreshAfterSwitch(42, origin)).rejects.toMatchObject({
      code: "LOGIN_REJECTED",
    });
    expect(tabsReload).not.toHaveBeenCalled();
    expect(tabsUpdate).not.toHaveBeenCalled();
  });

  it("当前 tab 已换 origin 时不注入 token", async () => {
    const injectAuth = vi.fn(async () => undefined);
    const result = await injectAndNavigate({
      injectAuth,
      tokenData: { token: "tail-secret-token" },
      currentTabId: 42,
      targetUrl: `${origin}/dashboard`,
      hasUrl: false,
    });

    expect(result.success).toBe(false);
    expect(injectAuth).not.toHaveBeenCalled();
    expect(tabsReload).not.toHaveBeenCalled();
  });

  it("复用 tab 导航后仍未到目标 origin 时不恢复会话", async () => {
    const injectAuth = vi.fn(async () => undefined);
    await expect(setupAuthTab(
      injectAuth,
      origin,
      `${origin}/dashboard`,
      { token: "tail-secret-token" },
      { execTab: { tabId: 42 } },
    )).rejects.toMatchObject({ code: "LOGIN_REJECTED" });

    expect(injectAuth).not.toHaveBeenCalled();
    expect(tabsReload).not.toHaveBeenCalled();
  });
});
