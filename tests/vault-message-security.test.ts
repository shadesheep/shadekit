import { beforeEach, describe, expect, it, vi } from "vitest";
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
const optionsSender = {
  id: extensionId,
  url: `chrome-extension://${extensionId}/options.html`,
  origin: `chrome-extension://${extensionId}`,
  frameId: 0,
} as chrome.runtime.MessageSender;
const optionsTabSender = {
  id: extensionId,
  url: `chrome-extension://${extensionId}/options.html`,
  origin: `chrome-extension://${extensionId}`,
  frameId: 0,
  tab: { id: 7, url: `chrome-extension://${extensionId}/options.html` },
} as chrome.runtime.MessageSender;

vi.stubGlobal("chrome", {
  permissions: { contains: async () => true, request: async () => true }, runtime: { id: extensionId } });
const handler = vi.fn(async () => ({ success: true }));
const vaultMessageTypes = [
  "VAULT_GET_CONFIG",
  "VAULT_SAVE_CONFIG",
  "VAULT_PUT_SECRET",
  "VAULT_DELETE_SECRET",
  "VAULT_HAS_SECRET",
  "VAULT_EXPORT_BACKUP",
  "VAULT_PREPARE_BACKUP",
  "VAULT_CONFIRM_BACKUP",
];
let listener: ReturnType<typeof createBackgroundMessageListener>;

beforeEach(() => {
  vi.clearAllMocks();
  listener = createBackgroundMessageListener(
    new Map(vaultMessageTypes.map((type) => [type, handler])),
    { openToolTab: vi.fn() },
  );
});

async function dispatch(message: unknown, sender = contentSender): Promise<any> {
  return new Promise((resolve) => {
    expect(listener(message, sender, resolve)).toBe(true);
  });
}

describe("保险库与备份消息来源", () => {
  it("Content Script 不能直接执行保险库或备份操作", async () => {
    for (const message of [
      { type: "VAULT_GET_CONFIG" },
      { type: "VAULT_SAVE_CONFIG", patch: { accounts: [] } },
      {
        type: "VAULT_SAVE_CONFIG",
        patch: {},
        clearCredentialRefs: ["global:default"],
      },
      { type: "VAULT_PUT_SECRET", credentialId: "account:a", plaintext: "secret" },
      { type: "VAULT_DELETE_SECRET", credentialId: "account:a" },
      { type: "VAULT_HAS_SECRET", credentialId: "account:a" },
      { type: "VAULT_EXPORT_BACKUP" },
      { type: "VAULT_PREPARE_BACKUP", text: "{\"__version\":3}" },
      { type: "VAULT_CONFIRM_BACKUP", acceptPlaintextWarning: true },
    ]) {
      await expect(dispatch(message)).resolves.toMatchObject({
        success: false,
        errorCode: "LOGIN_REJECTED",
      });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("扩展配置页可以执行受控保险库与明文备份操作", async () => {
    for (const message of [
      { type: "VAULT_GET_CONFIG" },
      { type: "VAULT_PUT_SECRET", credentialId: "account:a", plaintext: "secret" },
      { type: "VAULT_DELETE_SECRET", credentialId: "account:a" },
      { type: "VAULT_HAS_SECRET", credentialId: "account:a" },
      { type: "VAULT_EXPORT_BACKUP" },
      { type: "VAULT_PREPARE_BACKUP", text: "{\"__version\":3}" },
      { type: "VAULT_CONFIRM_BACKUP", acceptPlaintextWarning: true },
    ]) {
      await expect(dispatch(message, optionsSender)).resolves.toEqual({ success: true });
    }
    expect(handler).toHaveBeenCalledTimes(7);
  });

  it("以真实标签页承载的扩展配置页同样获授权（sender.tab 不影响判定）", async () => {
    for (const message of [
      { type: "VAULT_GET_CONFIG" },
      { type: "VAULT_SAVE_CONFIG", patch: { accounts: [] } },
      { type: "VAULT_EXPORT_BACKUP" },
    ]) {
      await expect(dispatch(message, optionsTabSender)).resolves.toEqual({ success: true });
    }
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("网页伪造扩展页 URL、扩展 ID 不匹配或扩展主机不符时拒绝", async () => {
    const forgedSenders = [
      {
        id: extensionId,
        url: `https://evil.example/chrome-extension://${extensionId}/options.html`,
        origin: "https://evil.example",
        frameId: 0,
        tab: { id: 8, url: "https://evil.example/chrome-extension://x/options.html" },
      },
      {
        id: "other-extension-id",
        url: `chrome-extension://${extensionId}/options.html`,
        origin: `chrome-extension://${extensionId}`,
        frameId: 0,
      },
      {
        id: extensionId,
        url: "chrome-extension://someone-else/options.html",
        origin: "chrome-extension://someone-else",
        frameId: 0,
        tab: { id: 9, url: "chrome-extension://someone-else/options.html" },
      },
    ] as chrome.runtime.MessageSender[];
    for (const sender of forgedSenders) {
      await expect(dispatch({ type: "VAULT_GET_CONFIG" }, sender)).resolves.toMatchObject({
        success: false,
        errorCode: "LOGIN_REJECTED",
      });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("扩展配置页可显式点名要清除的凭据引用", async () => {
    await expect(dispatch({
      type: "VAULT_SAVE_CONFIG",
      patch: {},
      clearCredentialRefs: ["global:default"],
    }, optionsSender)).resolves.toEqual({ success: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("旧主密码、解锁、锁屏与重置消息不再被路由", () => {
    for (const type of [
      "VAULT_GET_STATUS",
      "VAULT_ENABLE_MASTER",
      "VAULT_CHANGE_MASTER",
      "VAULT_DISABLE_MASTER",
      "VAULT_UNLOCK",
      "VAULT_CANCEL_INTENT",
      "VAULT_LOCK",
      "VAULT_RESET",
    ]) {
      expect(listener({ type }, optionsSender, vi.fn())).toBe(false);
    }
  });

  it("畸形字段和未知额外字段在 handler 前拒绝", async () => {
    for (const message of [
      { type: "VAULT_PUT_SECRET", credentialId: "", plaintext: "secret" },
      { type: "VAULT_DELETE_SECRET" },
      { type: "VAULT_HAS_SECRET", credentialId: 7 },
      { type: "VAULT_EXPORT_BACKUP", plaintext: "forbidden" },
      { type: "VAULT_PREPARE_BACKUP", text: null },
      { type: "VAULT_PREPARE_BACKUP", text: "{}", password: "forbidden" },
      { type: "VAULT_CONFIRM_BACKUP" },
      { type: "VAULT_CONFIRM_BACKUP", acceptPlaintextWarning: "yes" },
      { type: "VAULT_SAVE_CONFIG", patch: [] },
      { type: "VAULT_SAVE_CONFIG", patch: { accounts: [], vaultMeta: { wrappedDek: "forbidden" } } },
      { type: "VAULT_SAVE_CONFIG", patch: {}, clearCredentialRefs: "global:default" },
      { type: "VAULT_SAVE_CONFIG", patch: {}, clearCredentialRefs: [""] },
      { type: "VAULT_SAVE_CONFIG", patch: {}, clearCredentialRefs: [7] },
    ]) {
      await expect(dispatch(message, optionsSender)).resolves.toMatchObject({
        success: false,
        errorCode: "CONFIG_INVALID",
      });
    }
    expect(handler).not.toHaveBeenCalled();
  });
});
