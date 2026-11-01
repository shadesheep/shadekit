import type { ToolDefinition, ToolBackgroundHandlers } from "./types";
import type { BackgroundMessages, ToolMessageType } from "./messages";
import { errorCodeOf } from "../tools/account-switch/utils/error-codes";

type MessageHandler = NonNullable<ToolBackgroundHandlers[ToolMessageType]>;

type LoginMessageType =
  | "SWITCH_ACCOUNT"
  | "QUICK_LOGIN"
  | "TRIAL_LOGIN"
  | "TRIAL_SAVED_ACCOUNT"
  | "GET_ACCOUNT_PANEL"
  | "REQUEST_ENVIRONMENT_PERMISSIONS";

const loginMessageTypes = new Set<LoginMessageType>([
  "SWITCH_ACCOUNT",
  "QUICK_LOGIN",
  "TRIAL_LOGIN",
  "TRIAL_SAVED_ACCOUNT",
  "GET_ACCOUNT_PANEL",
  "REQUEST_ENVIRONMENT_PERMISSIONS",
]);

type VaultMessageType =
  | "VAULT_GET_CONFIG"
  | "VAULT_SAVE_CONFIG"
  | "VAULT_PUT_SECRET"
  | "VAULT_DELETE_SECRET"
  | "VAULT_HAS_SECRET"
  | "VAULT_EXPORT_BACKUP"
  | "VAULT_PREPARE_BACKUP"
  | "VAULT_CONFIRM_BACKUP";

const vaultMessageTypes = new Set<VaultMessageType>([
  "VAULT_GET_CONFIG",
  "VAULT_SAVE_CONFIG",
  "VAULT_PUT_SECRET",
  "VAULT_DELETE_SECRET",
  "VAULT_HAS_SECRET",
  "VAULT_EXPORT_BACKUP",
  "VAULT_PREPARE_BACKUP",
  "VAULT_CONFIRM_BACKUP",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  message: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set(["type", ...required, ...optional]);
  if (Object.keys(message).some((key) => !allowed.has(key))) return false;
  return required.every((key) => Object.hasOwn(message, key));
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function validLoginPayload(type: LoginMessageType, message: Record<string, unknown>): boolean {
  switch (type) {
    case "SWITCH_ACCOUNT":
      return (
        hasExactKeys(message, ["accountId", "environmentId"]) &&
        isString(message.accountId) && message.accountId.length > 0 &&
        isString(message.environmentId) && message.environmentId.length > 0
      );
    case "REQUEST_ENVIRONMENT_PERMISSIONS":
      return hasExactKeys(message, ["environmentId"]) &&
        isString(message.environmentId) && message.environmentId.length > 0;
    case "QUICK_LOGIN":
      return (
        hasExactKeys(
          message,
          ["url", "username"],
          ["password", "hasUrl", "debugRedirect"],
        ) &&
        isString(message.url) && message.url.length > 0 &&
        isString(message.username) && message.username.length > 0 &&
        (message.password === undefined || isString(message.password)) &&
        (message.hasUrl === undefined || typeof message.hasUrl === "boolean") &&
        (message.debugRedirect === undefined || isString(message.debugRedirect))
      );
    case "TRIAL_LOGIN":
      return (
        hasExactKeys(
          message,
          ["spec", "origin", "username", "password"],
          ["writeSession"],
        ) &&
        isRecord(message.spec) && Array.isArray(message.spec.ops) &&
        isString(message.origin) && message.origin.length > 0 &&
        isString(message.username) &&
        isString(message.password) &&
        (message.writeSession === undefined || typeof message.writeSession === "boolean")
      );
    case "TRIAL_SAVED_ACCOUNT":
      return hasExactKeys(message, ["accountId", "environmentId"])
        && isString(message.accountId) && message.accountId.length > 0
        && isString(message.environmentId) && message.environmentId.length > 0;
    case "GET_ACCOUNT_PANEL":
      return hasExactKeys(message, []);
  }
}

function validVaultPayload(type: VaultMessageType, message: Record<string, unknown>): boolean {
  switch (type) {
    case "VAULT_SAVE_CONFIG": {
      const allowedPatchKeys = new Set([
        "accounts", "domains", "strategies", "quickLoginDefaultDomain",
        "tabOrder", "envBadge", "globalDefaultPassword",
      ]);
      return hasExactKeys(message, ["patch"], ["clearCredentialRefs"]) && isRecord(message.patch)
        && Object.keys(message.patch).every((key) => allowedPatchKeys.has(key))
        && (message.clearCredentialRefs === undefined
          || (Array.isArray(message.clearCredentialRefs)
            && message.clearCredentialRefs.every(
              (ref) => isString(ref) && ref.length > 0,
            )));
    }
    case "VAULT_PUT_SECRET":
      return hasExactKeys(message, ["credentialId", "plaintext"])
        && isString(message.credentialId) && message.credentialId.length > 0
        && isString(message.plaintext);
    case "VAULT_DELETE_SECRET":
    case "VAULT_HAS_SECRET":
      return hasExactKeys(message, ["credentialId"])
        && isString(message.credentialId) && message.credentialId.length > 0;
    case "VAULT_PREPARE_BACKUP":
      return hasExactKeys(message, ["text"]) && isString(message.text);
    case "VAULT_CONFIRM_BACKUP":
      return hasExactKeys(message, ["acceptPlaintextWarning"])
        && typeof message.acceptPlaintextWarning === "boolean";
    case "VAULT_EXPORT_BACKUP":
    case "VAULT_GET_CONFIG":
      return hasExactKeys(message, []);
  }
}

function urlOrigin(value: unknown): string {
  if (!isString(value)) return "";
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function isOwnExtensionPage(sender: chrome.runtime.MessageSender, id: string): boolean {
  if (!isString(sender.url)) return false;
  try {
    const url = new URL(sender.url);
    return (
      (url.protocol === "chrome-extension:" || url.protocol === "moz-extension:") &&
      url.host === id
    );
  } catch {
    return false;
  }
}

function authorizeLoginMessage(
  type: LoginMessageType,
  sender: chrome.runtime.MessageSender,
): boolean {
  const extensionId = chrome.runtime.id;
  if (!extensionId || sender.id !== extensionId) return false;
  if (sender.frameId !== undefined && sender.frameId !== 0) return false;
  if (isOwnExtensionPage(sender, extensionId)) return true;

  if (type === "TRIAL_LOGIN" || type === "TRIAL_SAVED_ACCOUNT" || sender.frameId !== 0 || !sender.tab) return false;
  if (!Number.isInteger(sender.tab.id) || (sender.tab.id ?? 0) <= 0) return false;
  const senderOrigin = urlOrigin(sender.url);
  return (
    senderOrigin !== "" &&
    senderOrigin === urlOrigin(sender.tab.url) &&
    (sender.origin === undefined || sender.origin === senderOrigin)
  );
}

function loginMessageError(
  message: unknown,
  sender: chrome.runtime.MessageSender,
): { success: false; error: string; errorCode: string } | null {
  if (!isRecord(message) || !isString(message.type)) {
    return { success: false, error: "消息格式无效", errorCode: "CONFIG_INVALID" };
  }
  if (!loginMessageTypes.has(message.type as LoginMessageType)) return null;
  const type = message.type as LoginMessageType;
  if (!validLoginPayload(type, message)) {
    return { success: false, error: "登录消息字段无效", errorCode: "CONFIG_INVALID" };
  }
  if (!authorizeLoginMessage(type, sender)) {
    return { success: false, error: "登录消息来源未获授权", errorCode: "LOGIN_REJECTED" };
  }
  return null;
}

function vaultMessageError(
  message: unknown,
  sender: chrome.runtime.MessageSender,
): { success: false; error: string; errorCode: string } | null {
  if (!isRecord(message) || !isString(message.type)) return null;
  if (!vaultMessageTypes.has(message.type as VaultMessageType)) return null;
  const type = message.type as VaultMessageType;
  if (!validVaultPayload(type, message)) {
    return { success: false, error: "保险库消息字段无效", errorCode: "CONFIG_INVALID" };
  }
  const extensionId = chrome.runtime.id;
  // 配置页本身也可能以真实标签页打开（options.html），因此 tab 的存在与否
  // 不构成安全边界：只认发送方扩展 ID + 自带扩展页 URL。
  const ownPage =
    Boolean(extensionId) &&
    sender.id === extensionId &&
    isOwnExtensionPage(sender, extensionId);
  if (!ownPage) {
    return { success: false, error: "保险库消息来源未获授权", errorCode: "LOGIN_REJECTED" };
  }
  return null;
}


function handlerFailure(error: unknown): {
  success: false;
  error: string;
  errorCode: ReturnType<typeof errorCodeOf>;
} {
  return {
    success: false,
    error: error instanceof Error ? error.message : "后台处理失败",
    errorCode: errorCodeOf(error),
  };
}

/**
 * 按消息 type 构建全局路由表（ADR-0003 D1）。
 *
 * 跨所有工具的 backgroundHandlers 汇总：router 不再依赖消息中的 toolId，
 * 发送方无需知道自己属于哪个工具（扩展市场消息不带 toolId 曾因此被丢弃）。
 *
 * 启动期校验 type 唯一性：两个工具声明同一 type 时立即抛错（fail fast），
 * 避免路由结果取决于 allTools 数组顺序。
 */
export function buildMessageRouteTable(
  tools: ToolDefinition[],
): Map<string, MessageHandler> {
  const table = new Map<string, MessageHandler>();
  const owner = new Map<string, string>();
  for (const tool of tools) {
    for (const [type, handler] of Object.entries(tool.backgroundHandlers ?? {})) {
      const existing = owner.get(type);
      if (existing) {
        throw new Error(
          `[devtools] 消息路由冲突: type "${type}" 同时被工具 "${existing}" 和 "${tool.id}" 声明`,
        );
      }
      table.set(type, handler);
      owner.set(type, tool.id);
    }
  }
  return table;
}

/**
 * background 核心消息的处理能力（无属主工具，不进路由表）。
 * 由 background.ts 注入实现（涉及 tabs 等仅 background 可用的 API）。
 */
export interface CoreMessageHandlers {
  openToolTab(
    tool: string,
    params: Record<string, string>,
    forceNew: boolean,
  ): Promise<void>;
}

/**
 * 创建 chrome.runtime.onMessage 监听回调（ADR-0003 D1 的测试 seam）。
 *
 * 路由顺序：先查工具路由表，再落 background 核心消息（OPEN_TOOL_TAB）。
 * 注意：工具不应在 backgroundHandlers 中声明核心消息 type——否则工具
 * handler 会抢先命中路由表，静默遮蔽核心路径（类型层已由 ToolMessageType
 * 排除，见 types.ts）。
 *
 * 未注册 type 返回 false：Chrome 侧 sendMessage 会以
 * 「Receiving end does not exist」显性 reject，而非静默吞掉。
 *
 * 提取为独立工厂以便 round-trip 测试跨过真实调用链：
 * sendBgMessage → chrome.runtime.sendMessage → 本监听 → 路由表 → handler。
 */
export function createBackgroundMessageListener(
  routeTable: Map<string, MessageHandler>,
  core: CoreMessageHandlers,
): (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean {
  return (message, sender, sendResponse) => {
    const type = isRecord(message) && isString(message.type) ? message.type : undefined;
    const handler = type ? routeTable.get(type) : undefined;
    if (handler) {
      const rejected = loginMessageError(message, sender) ?? vaultMessageError(message, sender);
      if (rejected) {
        sendResponse(rejected);
        return true;
      }
      // handler 拒绝（如权限校验失败）也必须回包，否则发送方永远收不到响应。
      handler(message as never, sender).then(
        sendResponse,
        (error: unknown) => sendResponse(handlerFailure(error)),
      );
      return true;
    }
    if (!type && (message === null || typeof message !== "string")) {
      sendResponse({ success: false, error: "消息格式无效", errorCode: "CONFIG_INVALID" });
      return true;
    }
    // background 核心消息：打开工具标签页（popup 调用，走统一复用逻辑）
    if (type === "OPEN_TOOL_TAB") {
      const msg = message as Extract<BackgroundMessages, { type: "OPEN_TOOL_TAB" }>;
      core
        .openToolTab(msg.tool, msg.params ?? {}, msg.forceNew ?? false)
        .then(() => sendResponse({ success: true }));
      return true;
    }
    return false;
  };
}
