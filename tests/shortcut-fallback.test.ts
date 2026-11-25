/**
 * 快捷键兜底（content/shortcut-fallback.ts）
 *
 * 契约：
 * - 只认 Alt+Shift+物理 A（macOS ⌥⇧A 的 key 是 'Å'，必须按 code 判定）；
 * - 仅在命令未绑定时挂监听；已绑定不挂（避免与原生通道双开）；
 * - 触发后 background 回 handled=false 时立即卸载（绑定已在别处生效）；
 * - 子 frame 不参与。
 */

import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  initShortcutFallback,
  isShortcutFallbackEvent,
} from "../entrypoints/content/shortcut-fallback";

const extensionId = "shadekit-test-extension";

function keyEvent(overrides: Record<string, unknown> = {}): KeyboardEvent {
  return {
    altKey: true,
    shiftKey: true,
    ctrlKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
    code: "KeyA",
    key: "Å",
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent;
}

type KeydownHandler = (event: KeyboardEvent) => void;

let keydownHandler: KeydownHandler | null;
let win: Record<string, unknown>;
let sendMessage: Mock;

beforeEach(() => {
  keydownHandler = null;
  sendMessage = vi.fn(async () => ({ shortcut: "" }));
  win = {
    addEventListener: vi.fn((type: string, fn: KeydownHandler) => {
      if (type === "keydown") keydownHandler = fn;
    }),
    removeEventListener: vi.fn((type: string, fn: KeydownHandler) => {
      if (type === "keydown" && keydownHandler === fn) keydownHandler = null;
    }),
  };
  win.top = win;
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", {
    addEventListener: vi.fn(),
    visibilityState: "visible",
  });
  vi.stubGlobal("chrome", { runtime: { id: extensionId, sendMessage } });
});

describe("isShortcutFallbackEvent", () => {
  it("接受 Alt+Shift+A（macOS key='Å' 也命中）", () => {
    expect(isShortcutFallbackEvent(keyEvent())).toBe(true);
    expect(isShortcutFallbackEvent(keyEvent({ key: "A" }))).toBe(true);
  });

  it("拒绝多余修饰键与非常规事件", () => {
    for (const override of [
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: false },
      { altKey: false },
      { repeat: true },
      { isComposing: true },
      { code: "KeyB" },
    ]) {
      expect(
        isShortcutFallbackEvent(keyEvent(override)),
        JSON.stringify(override),
      ).toBe(false);
    }
  });
});

describe("initShortcutFallback", () => {
  it("命令未绑定时挂 keydown 监听", async () => {
    sendMessage.mockImplementation(async () => ({ shortcut: "" }));

    await initShortcutFallback();

    expect(sendMessage).toHaveBeenCalledWith({
      type: "GET_ACCOUNT_SWITCHER_SHORTCUT",
    });
    expect(keydownHandler).not.toBeNull();
  });

  it("命令已绑定时不挂监听", async () => {
    sendMessage.mockImplementation(async () => ({ shortcut: "Alt+Shift+A" }));

    await initShortcutFallback();

    expect(keydownHandler).toBeNull();
  });

  it("子 frame 不查询也不监听", async () => {
    sendMessage.mockImplementation(async () => ({ shortcut: "" }));
    win.top = {};

    await initShortcutFallback();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(keydownHandler).toBeNull();
  });

  it("按下组合键时吞掉默认行为并请求后台执行", async () => {
    sendMessage.mockImplementation(async (message: { type: string }) =>
      message.type === "GET_ACCOUNT_SWITCHER_SHORTCUT"
        ? { shortcut: "" }
        : { handled: true },
    );
    await initShortcutFallback();

    const event = keyEvent();
    keydownHandler?.(event);
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: "TRIGGER_ACCOUNT_SWITCHER",
      });
    });

    expect(event.preventDefault).toHaveBeenCalled();
    // handled=true 仍保持兜底生效
    expect(keydownHandler).not.toBeNull();
  });

  it("后台回 handled=false 时卸载监听（绑定已在别处生效）", async () => {
    sendMessage.mockImplementation(async (message: { type: string }) =>
      message.type === "GET_ACCOUNT_SWITCHER_SHORTCUT"
        ? { shortcut: "" }
        : { handled: false },
    );
    await initShortcutFallback();

    keydownHandler?.(keyEvent());
    await vi.waitFor(() => {
      expect(win.removeEventListener).toHaveBeenCalled();
    });
    expect(keydownHandler).toBeNull();
  });
});
