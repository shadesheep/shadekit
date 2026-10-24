import type { ToolDefinition, ToolBackgroundHandlers } from "./types";
import type { BackgroundMessages, ToolMessageType } from "./messages";

type MessageHandler = NonNullable<ToolBackgroundHandlers[ToolMessageType]>;

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
    const { type } = message as { type?: string };
    const handler = type ? routeTable.get(type) : undefined;
    if (handler) {
      handler(message as never, sender).then(sendResponse);
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
