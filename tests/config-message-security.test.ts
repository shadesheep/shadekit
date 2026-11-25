import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBackgroundMessageListener,
  buildMessageRouteTable,
} from "../entrypoints/shared/message-router";
import type { ToolDefinition } from "../entrypoints/shared/types";

const handler = vi.fn(async () => ({ success: true }));
const extensionId = "test-extension-id";

const tool = {
  id: "account-switch",
  name: "Account Switch",
  description: "",
  icon: "",
  enabledByDefault: true,
  backgroundHandlers: {
    ACCOUNT_CONFIG_GET: handler,
    ACCOUNT_CONFIG_SAVE: handler,
    BACKUP_EXPORT: handler,
    BACKUP_PREPARE: handler,
    BACKUP_CONFIRM: handler,
  },
} satisfies ToolDefinition;

const optionsSender = {
  id: extensionId,
  url: `chrome-extension://${extensionId}/options.html`,
  frameId: 0,
} as chrome.runtime.MessageSender;

let listener: ReturnType<typeof createBackgroundMessageListener>;

function dispatch(message: unknown, sender: chrome.runtime.MessageSender = optionsSender): Promise<unknown> {
  return new Promise((resolve) => {
    listener(message, sender, resolve);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("chrome", { runtime: { id: extensionId } });
  listener = createBackgroundMessageListener(buildMessageRouteTable([tool]), {
    openToolTab: vi.fn(async () => {}),
    getAccountSwitcherShortcut: vi.fn(async () => ""),
    triggerAccountSwitcher: vi.fn(async () => false),
  });
});

describe("配置消息来源与字段校验", () => {
  it("自带扩展页可发送全部配置消息", async () => {
    for (const message of [
      { type: "ACCOUNT_CONFIG_GET" },
      { type: "ACCOUNT_CONFIG_SAVE", patch: { accounts: [], showPasswords: false } },
      { type: "BACKUP_EXPORT" },
      { type: "BACKUP_PREPARE", text: "{}" },
      { type: "BACKUP_CONFIRM", acceptPlaintextWarning: true },
    ]) {
      await expect(dispatch(message)).resolves.toEqual({ success: true });
    }
    expect(handler).toHaveBeenCalledTimes(5);
  });

  it("网页或非扩展页发送时拒绝", async () => {
    for (const sender of [
      { id: extensionId, url: "https://evil.example/", frameId: 0 },
      { id: "other-extension", url: `chrome-extension://${extensionId}/options.html`, frameId: 0 },
      { id: extensionId, url: `chrome-extension://other/options.html`, frameId: 0 },
    ]) {
      await expect(dispatch({ type: "ACCOUNT_CONFIG_GET" }, sender)).resolves.toMatchObject({
        success: false,
        errorCode: "LOGIN_REJECTED",
      });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("字段无效或混入未知键时拒绝", async () => {
    for (const message of [
      { type: "ACCOUNT_CONFIG_SAVE", patch: [] },
      { type: "ACCOUNT_CONFIG_SAVE", patch: { accounts: [], vaultMeta: {} } },
      { type: "ACCOUNT_CONFIG_SAVE", patch: {}, clearCredentialRefs: ["account:a"] },
      { type: "ACCOUNT_CONFIG_GET", extra: true },
      { type: "BACKUP_PREPARE", text: null },
      { type: "BACKUP_PREPARE", text: "{}", password: "forbidden" },
      { type: "BACKUP_CONFIRM", acceptPlaintextWarning: "yes" },
    ]) {
      await expect(dispatch(message)).resolves.toMatchObject({
        success: false,
        errorCode: "CONFIG_INVALID",
      });
    }
    expect(handler).not.toHaveBeenCalled();
  });
});
