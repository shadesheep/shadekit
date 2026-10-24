/**
 * 工具类型定义
 * 所有工具的元数据、操作、配置统一通过此接口描述
 */

import type {
  BgPayload,
  BgResponse,
  ToolMessageType,
} from "./messages";

// Options 配置页的侧边栏配置段
export interface ToolConfigSection {
  id: string;
  label: string;
  icon?: string;
  component: () => Promise<any>;
}

// Content Script 面板配置
export interface ToolContentPanel {
  title: string;
  component: () => Promise<any>;
}

// Content Script 能力声明
export interface ToolContentScript {
  inject: boolean;
  panel?: ToolContentPanel;
  matches?: string[]; // 默认覆盖 manifest matches
}

// Background 消息处理器映射（ADR-0003 D1 ②）
// key 限定为协议中的工具消息 type；msg 按 type 自动收窄为对应 payload，
// 返回值须匹配协议声明的 response 形状。OPEN_TOOL_TAB 等核心消息被排除，
// 工具无法声明（避免抢先命中路由表、静默遮蔽 background 核心路径）。
export type ToolBackgroundHandlers = {
  [K in ToolMessageType]?: (
    msg: { type: K } & BgPayload<K>,
    sender: chrome.runtime.MessageSender,
  ) => Promise<BgResponse<K>>;
};

// 新标签页打开能力
export interface ToolOpenInTab {
  url: string; // 标签页 URL，如 'json-format.html'
  allowMultiple?: boolean; // 是否允许多开（默认 false = 聚焦已有标签）
}

// 统一的工具定义
export interface ToolDefinition {
  id: string; // 唯一标识
  name: string; // 显示名称
  description: string; // 工具描述
  icon: string; // 图标
  enabledByDefault: boolean; // 默认启用状态

  popupAction?: {
    label: string;
    onClick?: (tabUrl?: string) => void;
  };

  openInTab?: ToolOpenInTab;

  contentScript?: ToolContentScript;

  configSection?: ToolConfigSection;

  backgroundHandlers?: ToolBackgroundHandlers;

  defaultConfig?: Record<string, unknown>;
}
