// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App as VueApp } from "vue";
import SwitcherPanel from "../entrypoints/tools/account-switch/SwitcherPanel.vue";
import type * as EnvUtils from "../entrypoints/tools/account-switch/utils/env";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  sendBgMessage: vi.fn(),
  showToast: vi.fn(),
  showLoginRecoveryToast: vi.fn(),
  closePanel: vi.fn(),
  getCurrentOrigin: vi.fn(),
  getCurrentUrl: vi.fn(),
}));

vi.mock("../entrypoints/shared/tool-config", () => ({
  getConfig: mocks.getConfig,
}));
vi.mock("../entrypoints/shared/messages", () => ({
  sendBgMessage: mocks.sendBgMessage,
}));
vi.mock("../entrypoints/shared/use-toast", () => ({
  showToast: mocks.showToast,
}));
vi.mock("../entrypoints/tools/account-switch/login-recovery-toast", () => ({
  showLoginRecoveryToast: mocks.showLoginRecoveryToast,
}));
vi.mock("../entrypoints/tools/account-switch/utils/env", async (importOriginal) => {
  const original = await importOriginal<typeof EnvUtils>();
  return {
    ...original,
    closePanel: mocks.closePanel,
    getCurrentOrigin: mocks.getCurrentOrigin,
    getCurrentUrl: mocks.getCurrentUrl,
  };
});

let app: VueApp<Element> | null = null;
let root: HTMLDivElement;
const renderErrors: unknown[] = [];

const config = {
  accounts: [],
  domains: {
    "https://target.example.com": {
      name: "目标环境",
      tags: [],
      defaultPassword: "env-secret",
      debugRedirect: "http://localhost:3000/bugs",
      debugRedirectEnabled: true,
    },
  },
  strategies: {},
  tabOrder: ["quicklogin", "users"],
  quickLoginDefaultDomain: "",
  globalDefaultPassword: "global-secret",
};

const panelData = {
  origin: "https://current.example.com",
  matchedEnvKey: "",
  accounts: [],
  domains: {
    "https://target.example.com": {
      name: "目标环境",
      tags: [],
      debugRedirect: "http://localhost:3000/bugs",
      debugRedirectEnabled: true,
      hasDefaultPassword: true,
    },
  },
  tabOrder: ["quicklogin", "users"],
  quickLoginDefaultDomain: "",
  hasGlobalDefaultPassword: true,
};

async function flush() {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

async function mountPanel() {
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(SwitcherPanel);
  app.config.errorHandler = (error) => {
    renderErrors.push(error);
  };
  app.mount(root);
  await flush();
  await flush();
}

function keydown(target: Element, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}
beforeEach(() => {
  vi.clearAllMocks();
  renderErrors.length = 0;
  mocks.getCurrentOrigin.mockResolvedValue("https://current.example.com");
  mocks.getCurrentUrl.mockResolvedValue("https://current.example.com/");
  mocks.getConfig.mockResolvedValue(config);
  mocks.sendBgMessage.mockImplementation((type: string) =>
    type === "GET_ACCOUNT_PANEL"
      ? Promise.resolve(structuredClone(panelData))
      : Promise.withResolvers<unknown>().promise,
  );
});

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

describe("SwitcherPanel 配置读取失败", () => {
  it("结构化拒绝信封渲染错误态，不让 undefined 状态进入渲染", async () => {
    mocks.sendBgMessage.mockImplementation((type: string) =>
      type === "GET_ACCOUNT_PANEL"
        ? Promise.resolve({
            success: false,
            error: "缺少目标环境访问权限",
            errorCode: "HOST_PERMISSION_REQUIRED",
          })
        : Promise.withResolvers<unknown>().promise,
    );

    await mountPanel();

    expect(renderErrors).toEqual([]);
    expect(root.querySelector('[role="alert"]')?.textContent)
      .toContain("账号配置加载失败");
    expect(root.querySelector(".as-tab-env-label")?.textContent)
      .toContain("配置加载失败");
    expect(root.querySelector(".as-account-card")).toBeNull();
  });
});

describe("SwitcherPanel 键盘行为", () => {
  it("输入框和可编辑区域保留字符输入与光标移动，Mod+Enter 仍触发快捷登录", async () => {
    await mountPanel();
    const textarea = root.querySelector("textarea")!;
    textarea.value = "https://target.example.com/login\nadmin";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();

    for (const key of ["/", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"]) {
      expect(keydown(textarea, key).defaultPrevented, key).toBe(false);
    }

    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    root.querySelector(".as-panel")!.appendChild(editable);
    expect(keydown(editable, "/").defaultPrevented).toBe(false);
    expect(keydown(editable, "ArrowDown").defaultPrevented).toBe(false);

    const submit = keydown(textarea, "Enter", { ctrlKey: true });
    await flush();
    expect(submit.defaultPrevented).toBe(true);
    expect(mocks.sendBgMessage).toHaveBeenCalledWith(
      "QUICK_LOGIN",
      expect.objectContaining({ username: "admin" }),
    );
  });
});

describe("SwitcherPanel 零账号快捷登录", () => {
  it("仍按输入 URL 匹配环境，使用默认密码并展示 Bug 页开关", async () => {
    await mountPanel();
    const textarea = root.querySelector("textarea")!;
    textarea.value = "https://target.example.com/login\nadmin";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();

    expect(root.querySelector(".as-ql-password-hint")?.textContent).toContain(
      "目标环境",
    );
    expect(root.querySelector('[role="switch"]')).toBeTruthy();

    root.querySelector<HTMLButtonElement>(".as-ql-btn")!.click();
    await flush();

    expect(mocks.sendBgMessage).toHaveBeenCalledWith("QUICK_LOGIN", {
      url: "https://target.example.com/login",
      username: "admin",
      hasUrl: true,
      debugRedirect: "http://localhost:3000/bugs",
    });
    expect(mocks.getConfig).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.sendBgMessage.mock.calls)).not.toContain("env-secret");
    expect(JSON.stringify(mocks.sendBgMessage.mock.calls)).not.toContain("global-secret");
  });
});

describe("SwitcherPanel 零配置快捷登录", () => {
  it("保留快捷登录 Tab，隐藏环境空状态并直接展示完整表单", async () => {
    await mountPanel();

    expect(root.querySelectorAll(".as-tab-bar .as-tab-btn")).toHaveLength(1);
    expect(root.querySelector(".as-tab-bar")?.textContent).toContain(
      "快捷登录",
    );
    expect(root.textContent).not.toContain("当前站点未配置环境");
    expect(root.textContent).not.toContain("打开设置添加环境");
    expect(root.querySelector(".as-ql-header")?.textContent).toContain(
      "快捷登录",
    );
    expect(root.querySelector<HTMLTextAreaElement>("textarea")?.rows).toBe(5);
    expect(root.querySelector(".as-ql-btn")?.textContent).toContain(
      "登录并跳转",
    );
  });
});

describe("SwitcherPanel 不支持的环境", () => {
  it("展示版本/算子原因，但登录仍交给 Background 能力门（不做事先禁用）", async () => {
    mocks.getCurrentOrigin.mockResolvedValue("https://target.example.com");
    mocks.getCurrentUrl.mockResolvedValue("https://target.example.com/");
    const unsupportedPanel = {
      ...structuredClone(panelData),
      origin: "https://target.example.com",
      matchedEnvKey: "https://target.example.com",
      accounts: [{
        id: "acc-unsupported",
        name: "未来账号",
        username: "alice",
        roles: [],
        hasSavedPassword: true,
      }],
      domains: {
        "https://target.example.com": {
          name: "目标环境",
          tags: [],
          debugRedirectEnabled: false,
          hasDefaultPassword: true,
          support: {
            supported: false,
            issues: [
              {
                code: "SPEC_VERSION_UNSUPPORTED",
                message: "当前客户端不支持 LoginSpec 版本 3",
              },
              {
                code: "OP_UNSUPPORTED",
                message: "当前客户端不支持算子 future.op",
                opIndex: 0,
              },
            ],
          },
        },
      },
    };
    mocks.sendBgMessage.mockImplementation((type: string) =>
      type === "GET_ACCOUNT_PANEL"
        ? Promise.resolve(unsupportedPanel)
        : Promise.resolve({ success: false, errorCode: "OP_UNSUPPORTED" }),
    );

    await mountPanel();

    const note = root.querySelector(".as-support-note");
    expect(note?.textContent).toContain("当前客户端不支持 LoginSpec 版本 3");
    expect(note?.textContent).toContain("当前客户端不支持算子 future.op");

    root.querySelector<HTMLButtonElement>(".as-ql-btn")?.remove();
    Array.from(root.querySelectorAll<HTMLButtonElement>(".as-tab-btn"))
      .find((button) => button.textContent?.includes("选择账号"))
      ?.click();
    await flush();
    const card = root.querySelector<HTMLButtonElement>(".as-account-card")!;
    expect(card.disabled).toBe(false);
    card.click();
    await flush();

    // 客户端不禁用登录入口：由 Background 的 assertEnvironmentLoginSupported
    // 在任何副作用前拒绝，并使用结构化的 OP_UNSUPPORTED 错误码。
    expect(mocks.sendBgMessage).toHaveBeenCalledWith("SWITCH_ACCOUNT", {
      accountId: "acc-unsupported",
      environmentId: "https://target.example.com",
    });
  });
});

describe("SwitcherPanel 已配置环境", () => {
  it("保留快捷登录和选择账号 Tab", async () => {
    mocks.getCurrentOrigin.mockResolvedValue("https://target.example.com");
    mocks.getCurrentUrl.mockResolvedValue("https://target.example.com/");
    await mountPanel();

    const labels = Array.from(root.querySelectorAll(".as-tab-btn")).map(
      (button) => button.textContent?.trim(),
    );
    expect(labels).toEqual(["快捷登录", "选择账号"]);
  });

  it("账号切换只发送 accountId/environmentId，不读取或传播保存密码", async () => {
    mocks.getCurrentOrigin.mockResolvedValue("https://target.example.com");
    mocks.getCurrentUrl.mockResolvedValue("https://target.example.com/");
    mocks.sendBgMessage.mockImplementation((type: string) =>
      type === "GET_ACCOUNT_PANEL"
        ? Promise.resolve({
            ...structuredClone(panelData),
            origin: "https://target.example.com",
            matchedEnvKey: "https://target.example.com",
            accounts: [{
              id: "acc-current",
              name: "当前账号",
              username: "alice",
              roles: ["管理员"],
            }],
          })
        : Promise.withResolvers<unknown>().promise,
    );
    await mountPanel();
    root.querySelector<HTMLButtonElement>(".as-ql-btn")?.remove();
    const usersTab = Array.from(root.querySelectorAll<HTMLButtonElement>(".as-tab-btn"))
      .find((button) => button.textContent?.includes("选择账号"));
    usersTab?.click();
    await flush();
    root.querySelector<HTMLButtonElement>(".as-account-card")!.click();
    await flush();

    expect(mocks.sendBgMessage).toHaveBeenCalledWith("SWITCH_ACCOUNT", {
      accountId: "acc-current",
      environmentId: "https://target.example.com",
    });
    expect(mocks.getConfig).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.sendBgMessage.mock.calls)).not.toContain("password");
  });

  it("无保存密码账号使用当次临时密码且不重新保存", async () => {
    mocks.getCurrentOrigin.mockResolvedValue("https://target.example.com");
    mocks.getCurrentUrl.mockResolvedValue("https://target.example.com/");
    mocks.sendBgMessage.mockImplementation((type: string) => {
      if (type === "GET_ACCOUNT_PANEL") return Promise.resolve({
        ...structuredClone(panelData),
        origin: "https://target.example.com",
        matchedEnvKey: "https://target.example.com",
        accounts: [{ id: "acc-temp", name: "临时账号", username: "temp", roles: [], hasSavedPassword: false }],
      });
      return Promise.resolve({ success: true });
    });
    await mountPanel();
    root.querySelector<HTMLButtonElement>(".as-ql-btn")?.remove();
    Array.from(root.querySelectorAll<HTMLButtonElement>(".as-tab-btn")).find((button) => button.textContent?.includes("选择账号"))?.click();
    await flush();
    root.querySelector<HTMLButtonElement>(".as-account-card")!.click();
    await flush();
    const input = root.querySelector<HTMLInputElement>("[data-temporary-password]");
    expect(input).toBeTruthy();
    input!.value = "one-shot-password";
    input!.dispatchEvent(new Event("input"));
    await flush();
    root.querySelector<HTMLButtonElement>("[data-temporary-submit]")!.click();
    await flush();
    expect(mocks.sendBgMessage).toHaveBeenCalledWith("QUICK_LOGIN", {
      url: "https://target.example.com",
      username: "temp",
      password: "one-shot-password",
      hasUrl: false,
    });
    expect(mocks.sendBgMessage).not.toHaveBeenCalledWith("SWITCH_ACCOUNT", expect.anything());
    expect(mocks.sendBgMessage).not.toHaveBeenCalledWith("VAULT_PUT_SECRET", expect.anything());
  });
});
