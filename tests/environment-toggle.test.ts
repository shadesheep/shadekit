// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import Config from "../entrypoints/tools/account-switch/Config.vue";
import type { AccountSwitchConfig } from "../entrypoints/tools/account-switch/types";
import { buildAccountPanel } from "../entrypoints/tools/account-switch/account-view";
import { evaluateEnv } from "../entrypoints/tools/account-switch/EnvIndicator";

const mocks = vi.hoisted(() => ({ sendBgMessage: vi.fn(), showToast: vi.fn() }));
vi.mock("../entrypoints/shared/messages", () => ({ sendBgMessage: mocks.sendBgMessage }));
vi.mock("../entrypoints/shared/use-toast", () => ({ showToast: mocks.showToast }));

const current = "https://current.example.com";
const other = "https://other.example.com";
let config: AccountSwitchConfig;
let app: App | undefined;
let root: HTMLDivElement;

async function flush() {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

async function mountConfig() {
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(Config);
  app.mount(root);
  await flush();
  root.querySelector<HTMLButtonElement>(`.rail-environment`)!.click();
  await flush();
}

function toggle() {
  return root.querySelector<HTMLButtonElement>('.env-context-bar [role="switch"]')!;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("chrome", { commands: { getAll: async () => [] } });
  config = {
    accounts: [{ id: "one", name: "账号一", username: "one", roles: [], domains: [current] }],
    domains: {
      [current]: { name: "当前环境", tags: [] },
      [other]: { name: "其他环境", tags: [] },
    },
    envBadge: { enabled: false, position: "bottom-right", whitelist: [] },
  };
  mocks.sendBgMessage.mockImplementation(async (type: string, payload?: { patch: Partial<AccountSwitchConfig> }) => {
    if (type === "ACCOUNT_CONFIG_SAVE") config = { ...config, ...payload!.patch };
    return { success: true, config: structuredClone(config) };
  });
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("当前环境启停开关", () => {
  it("角标总开关关闭时仍能停用当前环境，保留其他环境、账号与角标设置", async () => {
    const original = structuredClone(config);
    await mountConfig();
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    toggle().click();
    await flush();

    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(toggle().textContent).toContain("已停用");
    expect(config.domains[current].enabled).toBe(false);
    expect(config.domains[other]).toEqual(original.domains[other]);
    expect(config.accounts).toEqual(original.accounts);
    expect(config.envBadge).toEqual(original.envBadge);
    expect(root.querySelector(".badge-summary")?.textContent).toContain("1 / 2 个已启用");

    // 实际面板与角标消费同一启停状态；重新启用即可恢复。
    expect(buildAccountPanel(config, current).accounts).toEqual([]);
    expect(evaluateEnv(config, current)).toBeNull();
    toggle().click();
    await flush();
    expect(buildAccountPanel(config, current).accounts).toHaveLength(1);
    expect(evaluateEnv(config, current)?.name).toBe("当前环境");
  });

  it("允许停用最后一个环境，重新加载后仍可启用", async () => {
    delete config.domains[other];
    await mountConfig();
    toggle().click();
    await flush();
    expect(config.domains[current].enabled).toBe(false);
    expect(root.querySelector(".badge-summary")?.textContent).toContain("0 / 1 个已启用");
    app!.unmount();
    await mountConfig();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    toggle().click();
    await flush();
    expect(config.domains[current].enabled).toBe(true);
  });

  it("等待保存期间禁用重复点击，保存失败保留原状态", async () => {
    await mountConfig();
    let resolveSave!: (value: { success: boolean; error: string }) => void;
    const pending = new Promise<{ success: boolean; error: string }>((resolve) => { resolveSave = resolve; });
    mocks.sendBgMessage.mockImplementation(() => pending);
    toggle().click();
    await flush();
    expect(toggle().disabled).toBe(true);
    toggle().click();
    expect(mocks.sendBgMessage.mock.calls.filter(([type]) => type === "ACCOUNT_CONFIG_SAVE")).toHaveLength(1);
    resolveSave({ success: false, error: "保存失败" });
    await flush();
    expect(toggle().disabled).toBe(false);
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(mocks.showToast).toHaveBeenCalledWith("保存失败", "error");
  });
});
