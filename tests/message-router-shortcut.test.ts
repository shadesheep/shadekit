/**
 * 快捷键兜底核心消息（GET_ACCOUNT_SWITCHER_SHORTCUT / TRIGGER_ACCOUNT_SWITCHER）
 *
 * 安全与去重边界：
 * - 只接受本扩展顶层 frame 的 content script 触发（子 frame 会与顶层重复）；
 * - 触发结果必须回包，content script 依据 handled=false 卸载兜底；
 * - 查询结果对非本扩展来源返回空串（等价于"未绑定"，不会泄露绑定信息）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundMessageListener } from "../entrypoints/shared/message-router";
import { createBackgroundMessageListener } from "../entrypoints/shared/message-router";

const extensionId = "shadekit-test-extension";
const pageUrl = "https://current.example.com/path";
const contentSender = {
  id: extensionId,
  url: pageUrl,
  origin: "https://current.example.com",
  frameId: 0,
  tab: { id: 42, url: pageUrl },
} as chrome.runtime.MessageSender;

const getAccountSwitcherShortcut = vi.fn(async () => "Alt+Shift+A");
const triggerAccountSwitcher = vi.fn(async () => true);
let listener: BackgroundMessageListener;

type Dispatched = { routed: boolean; response?: unknown };

function dispatch(
  message: unknown,
  sender: chrome.runtime.MessageSender = contentSender,
): Promise<Dispatched> {
  // Node 20（package.json engines）没有 Promise.withResolvers，沿用回调形态
  return new Promise((resolve) => {
    const routed = listener(message, sender, (response) => {
      resolve({ routed: true, response });
    });
    if (!routed) resolve({ routed: false });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("chrome", { runtime: { id: extensionId } });
  listener = createBackgroundMessageListener(new Map(), {
    openToolTab: async () => undefined,
    getAccountSwitcherShortcut,
    triggerAccountSwitcher,
  });
});

describe("GET_ACCOUNT_SWITCHER_SHORTCUT", () => {
  it("content script 能读到绑定状态", async () => {
    await expect(
      dispatch({ type: "GET_ACCOUNT_SWITCHER_SHORTCUT" }),
    ).resolves.toEqual({
      routed: true,
      response: { shortcut: "Alt+Shift+A" },
    });
  });

  it("非本扩展来源读不到绑定（返回空串）", async () => {
    await expect(
      dispatch({ type: "GET_ACCOUNT_SWITCHER_SHORTCUT" }, {
        ...contentSender,
        id: "other-extension",
      } as chrome.runtime.MessageSender),
    ).resolves.toEqual({ routed: true, response: { shortcut: "" } });
  });
});

describe("TRIGGER_ACCOUNT_SWITCHER", () => {
  it("顶层 frame 触发时把 tab 交给 core handler", async () => {
    await expect(
      dispatch({ type: "TRIGGER_ACCOUNT_SWITCHER" }),
    ).resolves.toEqual({
      routed: true,
      response: { handled: true },
    });
    expect(triggerAccountSwitcher).toHaveBeenCalledWith(42, pageUrl);
  });

  it("子 frame 触发被拒绝（避免与顶层重复执行）", async () => {
    await expect(
      dispatch({ type: "TRIGGER_ACCOUNT_SWITCHER" }, {
        ...contentSender,
        frameId: 3,
      } as chrome.runtime.MessageSender),
    ).resolves.toEqual({ routed: true, response: { handled: false } });
    expect(triggerAccountSwitcher).not.toHaveBeenCalled();
  });

  it("没有 tab 的扩展页触发被拒绝", async () => {
    await expect(
      dispatch({ type: "TRIGGER_ACCOUNT_SWITCHER" }, {
        id: extensionId,
        url: `chrome-extension://${extensionId}/popup.html`,
        frameId: 0,
      } as chrome.runtime.MessageSender),
    ).resolves.toEqual({ routed: true, response: { handled: false } });
    expect(triggerAccountSwitcher).not.toHaveBeenCalled();
  });
});
