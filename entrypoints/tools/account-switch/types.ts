/**
 * account-switch 类型定义
 * 登录策略接口、认证凭据、Domain 配置等
 */

// ============================================================
// 策略配置声明（动态参数系统）
// ============================================================

/** 配置项类型（对齐 manifest.json settings） */
export type SettingType =
  | "string"
  | "number"
  | "boolean"
  | "textarea"
  | "select";

/** 配置项定义 — 策略声明自己需要的参数 */
export interface SettingDefinition {
  /** 参数键名 */
  name: string;
  /** 显示名称 */
  title: string;
  /** 说明文字 */
  description?: string;
  /** 输入类型 */
  type: SettingType;
  /** 默认值 */
  default?: unknown;
  /** 是否必填 */
  required?: boolean;
  /** 占位提示 */
  placeholder?: string;
  /** select 类型的选项列表 */
  options?: { label: string; value: string }[];
  /** 配置分组：basic（基础，始终显示）、advanced（高级，可折叠） */
  group?: "basic" | "advanced";
}

import type { RecipeStepTrace } from "./spec/types";

/** 步骤脚本的结构化返回契约（ADR-0012 D11 / ADR-0015 D12） */
export interface LoginScriptResult {
  success: boolean;
  tokenData?: TokenData;
  /**
   * 算子绑定表（ADR-0015 D12 的 `$name`）。
   * generic spec 成功时**总是**携带（空表为 `{}`）；引擎据此跳过
   * `parseLoginResult` —— 成功与否已由 spec 的成功信号判定。
   */
  bindings?: Record<string, unknown>;
  /** 失败原因（success === false 时） */
  error?: string;
  /** 配方步骤轨迹（ADR-0012 D13），由配方执行器产出 */
  recipeSteps?: RecipeStepTrace[];
}

/**
 * 认证结果载荷 — 策略返回的原始数据，结构由各策略自行定义。
 * 不做强制字段映射，保证任意返回格式都能正确传递到 afterLogin。
 *
 * 使用场景：
 * - 策略在 parseLoginResult / buildLogin 中返回任意结构
 * - AuthContext.tokenData 透传原始数据
 */
export type TokenData = Record<string, unknown> | null;

/** 认证流程共享上下文 */
export interface AuthContext {
  tabId: number;
  origin: string;
  domainConfig: DomainConfig;
  credentials: AuthCredentials;
  tokenData: TokenData;
  /**
   * 本次登录的原始响应（per-call 瞬时数据，ADR-0003 D2）。
   * 由 spec 引擎在 http.execute / script 的解析点统一赋值。
   * 规则：谁持有 raw 谁写 ctx，runSpec 只读一次。
   */
  rawResponse?: unknown;
  /**
   * afterLogin 决策所需的当前 tab URL（ADR-0004 D4）。
   * 由引擎在执行 afterLogin 前注入；策略只读，不自行 chrome.tabs.get。
   */
  currentTabUrl?: string;
  /**
   * 登录后要落地的目标 URL（ADR-0015 D4 输入命名空间）。
   * 供 spec 以 `{targetUrl}` 拼跨 origin 导航；无明确目标时为空。
   */
  targetUrl?: string;
  /** Bug 复现地址（输入命名空间 `{debugRedirect}`）：登录成功后自动进入的页面，通常来自测试反馈 */
  debugRedirect?: string;
}

/**
 * 导航意图（ADR-0004 D4）— 策略 afterLogin 的返回值。
 * 策略只做决策；tab 变更由 Login Tab Flow 的 applyNavigationIntent 统一执行。
 */
export type NavigationIntent =
  | { action: "navigate"; url: string }
  | { action: "reload" }
  | { action: "none" };

/** 认证凭据 — 不同策略使用不同字段 */
export interface AuthCredentials {
  username: string;
  password: string;
  token?: string; // bearer-token 模式
  clientId?: string; // oauth2 模式
  clientSecret?: string; // oauth2 模式
  extra?: Record<string, string>;
}

/** Domain 环境配置 */
export interface DomainConfig {
  // ===== 基础配置项（所有策略共享） =====
  name: string;
  tags: string[];
  /**
   * 登录方式标识。仅作为 `SpecTemplate.id`：用于新建环境时
   * 生成默认登录声明、以及日志里的人类可读名称；**不参与执行分派**。
   * 实际执行只认 `strategyConfig.spec`（引擎不再据此选择策略）。新建默认 'generic'；
   * 导入的具名策略（如 custom-login）用自己的 `spec.template` 作显示名。
   */
  loginMethod?: string;
  debugRedirect?: string; // Bug 复现地址：登录成功后自动进入的页面，如 http://localhost:8888/#/bug/123
  debugRedirectEnabled?: boolean; // 「登录后自动进入」开关默认值
  defaultPassword?: string; // 快进登录默认密码
  /** 「清除本域 Cookie」是否包含父域（默认 false，仅精确 host；ADR-0012 D8） */
  cookieClearIncludeParent?: boolean;

  // ===== 策略动态参数（由策略声明、UI 动态渲染） =====
  /**
   * 策略参数键值对，键为 SettingDefinition.name，值为用户输入
   * 例: { publicKey: "xxx", loginEndpoint: "/login" }
   */
  strategyParams?: Record<string, unknown>;

  /**
   * 结构化策略配置（ADR-0012 D2）。
   * generic 登录的配方存放于此；`strategyParams` 对 generic 仅保留只读兼容。
   */
  strategyConfig?: {
    /** LoginSpec（ADR-0015 D2）；通用登录读取时优先于 `recipe` */
    spec?: import("./spec/types").LoginSpec;
    /** 旧配方（v1）；读取时经迁移链升到当前 spec 版本 */
    recipe?: import("./strategies/generic-recipe").Recipe;
  };

  /**
   * 关联的登录策略库条目 id（ADR-0019，修订：引用 + 镜像）。
   * 关联时**不强制**落 `strategyConfig.spec`：未持有 spec 的绑定环境是
   * 「镜像」——执行时实时读库条目，库更新即时生效；只有在环境里改过声明
   * 才把 `strategyConfig.spec` 落盘为私有声明（脱镜）。库条目被删后，镜像
   * 环境回到「未配置登录」，脱镜环境照常工作。
   */
  strategyId?: string;

  /**
   * 环境级变量覆盖（ADR-0019）：键为 `spec.vars[].name`，出现在此处的值
   * 优先于声明里的 `default`。同一份策略复用到多个环境时，环境差异放这里，
   * 不改进共享的声明本身。
   */
  vars?: Record<string, string>;
}

/** 账号配置 */
export interface Account {
  id: string;
  name: string;
  username: string;
  password: string;
  roles: string[];
  domains: string[];
}

/** badge 停靠位置（页面四角） */
export type EnvBadgePosition =
  | "bottom-right"
  | "bottom-left"
  | "top-right"
  | "top-left";

/**
 * 环境指示器配置（ADR-0017 D1：env-indicator 并入 account-switch）。
 * `enabled` 取自原工具启用状态（devtools-state['env-indicator']），
 * `position` / `whitelist` 语义沿用原 devtools-env-indicator 配置。
 */
export interface EnvBadgeConfig {
  enabled: boolean;
  position: EnvBadgePosition;
  /** 非空时仅这些环境显示角标；空数组表示全部已配置环境 */
  whitelist: string[];
}

/**
 * 登录策略库条目（ADR-0019）。
 *
 * 策略从环境里独立出来，成为可分享、可复用的一等对象；环境通过
 * `DomainConfig.strategyId` 引用它。库与「全部工具设置」/ WebDAV 同步
 * 同住 `devtools-account-switch` key，因此备份与同步天然覆盖。
 */
export interface StrategyEntry {
  /** 展示名：`spec.template` 优先，其次导入包里的 environment.name */
  name: string;
  spec: import("./spec/types").LoginSpec;
  /** 创建 / 最近一次更新时间（毫秒），列表排序用 */
  createdAt: number;
  updatedAt: number;
}

/** 完整工具配置 */
export interface AccountSwitchConfig {
  accounts: Account[];
  domains: Record<string, DomainConfig>;
  /**
   * 登录策略库（ADR-0019）：`id → 策略`。
   * 配置中没有此字段时由 `collectStrategyPresets` 从环境内联 spec 归纳，
   * 不强制迁移。
   */
  strategies?: Record<string, StrategyEntry>;
  debug?: boolean;
  quickLoginDefaultDomain?: string;
  /** 全局默认密码：环境未配置默认密码时的最后回退 */
  globalDefaultPassword?: string;
  tabOrder?: ("users" | "quicklogin")[];
  /** 环境指示器（合并自原 env-indicator 工具）；缺省视为关闭 */
  envBadge?: EnvBadgeConfig;
}

/**
 * 读取侧默认配置（ADR-0003 D5）：getConfig 的 defaults 入参，
 * 用于补齐配置中缺失的顶层字段。只含结构性空值，不注入任何
 * 示例账号/示例环境数据。
 */
export const ACCOUNT_SWITCH_CONFIG_DEFAULTS: Pick<
  AccountSwitchConfig,
  "accounts" | "domains"
> = {
  accounts: [],
  domains: {},
};

/**
 * 登录请求 — buildLogin 的返回契约：策略构建 HTTP 请求，
 * 引擎 fetch 后把响应交 parseLoginResult。
 */
export type LoginRequest = { url: string; options: RequestInit };

/** 认证结果 */
export interface AuthResult {
  success: boolean;
  data?: TokenData;
  error?: string;
}

/** 调试日志条目 */
export interface DebugLogEntry {
  id: string;
  timestamp: number;
  action: "SWITCH_ACCOUNT" | "QUICK_LOGIN" | "QUICK_LOGIN_NEW_TAB" | "AUTO";
  account: { name: string; username: string };
  domain: {
    name: string;
    origin: string;
    loginMethod: string;
  };
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
    encryptedPassword?: string;
    /** `spec.log.reveal` 白名单命中值的原样拷贝（ADR-0015 D8），黑名单优先 */
    revealed?: Record<string, string>;
  } | null;
  response: {
    status?: number;
    statusText?: string;
    body?: string;
    parsed?: string;
  } | null;
  result: {
    success: boolean;
    error?: string;
    /** 统一错误码，见 utils/error-codes.ts */
    errorCode?: string;
    duration: number;
  };
  /**
   * 逐算子轨迹（ADR-0015 D8，原 `recipeSteps` 升格）：op / index / target /
   * duration / status / errorCode。spec 驱动登录时存在，用于定位
   * 「第几步哪个目标失败」。表的清理与写入自身就是算子，不再有独立管线阶段。
   */
  ops?: (RecipeStepTrace & { op: string })[];
  targetUrl?: string;
  debugRedirect?: string;
}
