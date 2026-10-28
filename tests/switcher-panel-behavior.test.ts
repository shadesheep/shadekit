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
  };
});

let app: VueApp<Element> | null = null;
let root: HTMLDivElement;

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
  mocks.getCurrentOrigin.mockResolvedValue("https://current.example.com");
  mocks.getConfig.mockResolvedValue(config);
  mocks.sendBgMessage.mockImplementation(() => Promise.withResolvers<unknown>().promise);
});

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
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
      password: "env-secret",
      hasUrl: true,
      debugRedirect: "http://localhost:3000/bugs",
    });
  });
});
