// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, type App as VueApp } from "vue";
import LoginFormLocator from "../entrypoints/tools/account-switch/config/LoginFormLocator.vue";
import { defaultLoginSpec } from "../entrypoints/tools/account-switch/spec/editor";

const pageUrl = "http://jfv2.dev.ebidding.net.cn:8880/management/#/login";
const origin = "http://jfv2.dev.ebidding.net.cn:8880";

const tabsCreate = vi.fn(async (options: { url: string }) => ({
  id: 7,
  url: options.url,
  status: "complete",
}));
const tabsGet = vi.fn(async (tabId: number) => ({
  id: tabId,
  url: pageUrl,
  status: "complete",
}));
const sendMessage = vi.fn(async () => ({
  success: true,
  frames: [],
  authStorage: { local: [], session: [] },
}));

vi.stubGlobal("chrome", {
  tabs: {
    getCurrent: vi.fn(async () => ({ id: 99, url: "chrome-extension://test/options.html" })),
    query: vi.fn(async () => []),
    create: tabsCreate,
    get: tabsGet,
    onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  runtime: { sendMessage },
});

let app: VueApp<Element> | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("LoginFormLocator 识别登录表单", () => {
  it("声明未配置登录页时打开环境表单里填写的完整登录页地址", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    app = createApp({
      render: () =>
        h(LoginFormLocator, {
          spec: defaultLoginSpec(),
          origin,
          entryUrl: pageUrl,
          mirrored: false,
        }),
    });
    app.mount(root);
    await nextTick();

    // 地址里的登录页会被写进声明，不应再提示「未配置登录页」
    expect(root.textContent).not.toContain("未配置登录页");

    const scan = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("识别登录表单"),
    );
    expect(scan).toBeTruthy();
    scan!.click();

    await vi.waitFor(() =>
      expect(tabsCreate).toHaveBeenCalledWith({ url: pageUrl, active: false }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SCAN_LOGIN_FORM", tabId: 7, origin }),
    );
  });
});
