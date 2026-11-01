import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBackgroundMessageListener } from "../entrypoints/shared/message-router";
import { PermissionError } from "../entrypoints/tools/account-switch/permissions/permission-error";

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

vi.stubGlobal("chrome", {
  permissions: { contains: async () => true, request: async () => true }, runtime: { id: extensionId } });

const handler = vi.fn(async () => ({ success: true }));
const core = { openToolTab: vi.fn(async () => undefined) };
let listener: ReturnType<typeof createBackgroundMessageListener>;

beforeEach(() => {
  vi.clearAllMocks();
  listener = createBackgroundMessageListener(new Map([
    ["SWITCH_ACCOUNT", handler],
    ["QUICK_LOGIN", handler],
    ["TRIAL_LOGIN", handler],
    ["TRIAL_SAVED_ACCOUNT", handler],
    ["GET_ACCOUNT_PANEL", handler],
  ]), core);
});

async function dispatch(
  message: unknown,
  sender: chrome.runtime.MessageSender = contentSender,
): Promise<unknown> {
  return new Promise((resolve) => {
    const claimed = listener(message, sender, resolve);
    expect(claimed).toBe(true);
  });
}

describe("登录消息运行时 schema", () => {
  it("SWITCH_ACCOUNT 接受 ID-only payload", async () => {
    const message = {
      type: "SWITCH_ACCOUNT",
      accountId: "acc-current",
      environmentId: "https://current.example.com",
    };
    await expect(dispatch(message)).resolves.toEqual({ success: true });
    expect(handler).toHaveBeenCalledWith(message, contentSender);
  });

  it("旧 Account 明文和额外 tabId 在 handler 前拒绝", async () => {
    const legacy = await dispatch({
      type: "SWITCH_ACCOUNT",
      account: { id: "acc", username: "alice", password: "must-not-cross" },
      domain: "https://current.example.com",
    });
    const forgedTab = await dispatch({
      type: "QUICK_LOGIN",
      url: pageUrl,
      username: "alice",
      password: "one-shot-password",
      tabId: 999,
    });

    expect(legacy).toMatchObject({ success: false, errorCode: "CONFIG_INVALID" });
    expect(forgedTab).toMatchObject({ success: false, errorCode: "CONFIG_INVALID" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("null、数组和错误字段类型返回结构化错误而非抛出", async () => {
    for (const message of [
      null,
      [],
      { type: "QUICK_LOGIN", url: pageUrl, username: 7 },
      { type: "TRIAL_LOGIN", spec: {}, origin: pageUrl, username: "alice", password: "pw" },
    ]) {
      await expect(dispatch(message, optionsSender)).resolves.toMatchObject({
        success: false,
        errorCode: "CONFIG_INVALID",
      });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("handler 拒绝时仍返回结构化错误，调用方不会收不到响应", async () => {
    handler.mockRejectedValueOnce(
      new PermissionError(
        "HOST_PERMISSION_REQUIRED",
        "缺少目标环境访问权限",
        ["https://current.example.com/*"],
      ),
    );

    await expect(
      dispatch({ type: "GET_ACCOUNT_PANEL" }, optionsSender),
    ).resolves.toMatchObject({
      success: false,
      error: "缺少目标环境访问权限",
      errorCode: "HOST_PERMISSION_REQUIRED",
    });
  });
});

describe("登录消息来源授权", () => {
  it.each([
    ["错误扩展 sender", { ...contentSender, id: "other-extension" }],
    ["非顶层 frame", { ...contentSender, frameId: 3 }],
    ["sender 与 tab origin 不一致", { ...contentSender, url: "https://evil.example.com/" }],
  ])("%s 在 handler 前拒绝", async (_name, sender) => {
    await expect(dispatch({
      type: "SWITCH_ACCOUNT",
      accountId: "acc-current",
      environmentId: "https://current.example.com",
    }, sender as chrome.runtime.MessageSender)).resolves.toMatchObject({
      success: false,
      errorCode: "LOGIN_REJECTED",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("TRIAL_LOGIN 只接受扩展配置页，Content Script 不能提交 spec", async () => {
    const message = {
      type: "TRIAL_LOGIN",
      spec: { version: 2, ops: [], success: [], auth: { mode: "page" } },
      origin: "https://current.example.com",
      username: "alice",
      password: "one-shot-password",
    };
    await expect(dispatch(message)).resolves.toMatchObject({ success: false, errorCode: "LOGIN_REJECTED" });
    expect(handler).not.toHaveBeenCalled();
    await expect(dispatch(message, optionsSender)).resolves.toEqual({ success: true });
    expect(handler).toHaveBeenCalledWith(message, optionsSender);
  });

  it("已保存账号试跑只接受扩展页 ID-only 消息", async () => {
    const message = {
      type: "TRIAL_SAVED_ACCOUNT",
      accountId: "acc-current",
      environmentId: "https://current.example.com",
    };
    await expect(dispatch(message)).resolves.toMatchObject({ success: false, errorCode: "LOGIN_REJECTED" });
    await expect(dispatch({ ...message, password: "forbidden" }, optionsSender)).resolves.toMatchObject({
      success: false,
      errorCode: "CONFIG_INVALID",
    });
    await expect(dispatch(message, optionsSender)).resolves.toEqual({ success: true });
    expect(handler).toHaveBeenCalledOnce();
  });
});
