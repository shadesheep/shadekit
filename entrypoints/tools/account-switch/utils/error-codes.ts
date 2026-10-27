/**
 * 统一错误码体系
 *
 * 登录及相关失败路径统一抛出/透传带错误码的结构化错误：
 * - 策略与工具函数抛出 LoginError（或可归一化的已知错误类型）
 * - runSpec / background-handler 的结果信封携带 errorCode 字段
 * - UI 错误 Toast 附「复制详情」，复制内容为错误码 + 关键上下文
 *
 * 归一化入口 errorCodeOf：任何异常（包括跨模块的普通 Error）都能映射到错误码，
 * 未识别的错误一律归为 UNKNOWN，保证 errorCode 字段永远有值。
 */

import { NetworkError } from "./fetch-retry";
import { RequestTimeoutError } from "./fetch-timeout";

// 复制到剪贴板的统一实现已上移到 shared/clipboard，
// 此处 re-export 保持既有调用方（SwitcherPanel 等）导入路径不变。
export { copyToClipboard } from "../../../shared/clipboard";

/** 错误码常量（字符串字面量即码值，日志/复制详情中直接可读） */
export const ErrorCodes = {
  // 配置 / 环境
  CONFIG_NOT_FOUND: "CONFIG_NOT_FOUND",
  ENV_NOT_MATCHED: "ENV_NOT_MATCHED",
  NO_STRATEGY: "NO_STRATEGY",
  STRATEGY_NOT_FOUND: "STRATEGY_NOT_FOUND",
  // 页面 / Tab
  TAB_RESTRICTED: "TAB_RESTRICTED",
  TAB_CLOSED: "TAB_CLOSED",
  TAB_LOAD_TIMEOUT: "TAB_LOAD_TIMEOUT",
  INVALID_URL: "INVALID_URL",
  INVALID_REDIRECT_URL: "INVALID_REDIRECT_URL",
  // 网络
  NETWORK_ERROR: "NETWORK_ERROR",
  REQUEST_TIMEOUT: "REQUEST_TIMEOUT",
  /** 单次 DOM 交互超时（`limits.stepMs`，ADR-0015 D6） */
  STEP_TIMEOUT: "STEP_TIMEOUT",
  // 认证
  RSA_ENCRYPT_ERROR: "RSA_ENCRYPT_ERROR",
  LOGIN_FAILED: "LOGIN_FAILED",
  CAPTCHA_REQUIRED: "CAPTCHA_REQUIRED",
  INJECT_AUTH_FAILED: "INJECT_AUTH_FAILED",
  EMPTY_RESPONSE: "EMPTY_RESPONSE",
  // 并发互斥
  LOGIN_BUSY: "LOGIN_BUSY",
  STRATEGY_INVALID: "STRATEGY_INVALID",
  // 配方（ADR-0012 D13）
  CONFIG_INVALID: "CONFIG_INVALID",
  SELECTOR_INVALID: "SELECTOR_INVALID",
  ELEMENT_NOT_FOUND: "ELEMENT_NOT_FOUND",
  AMBIGUOUS_TARGET: "AMBIGUOUS_TARGET",
  FRAME_NOT_FOUND: "FRAME_NOT_FOUND",
  LOGIN_FORM_NOT_FOUND: "LOGIN_FORM_NOT_FOUND",
  LOGIN_FORM_INCOMPLETE: "LOGIN_FORM_INCOMPLETE",
  LOGIN_FORM_AMBIGUOUS: "LOGIN_FORM_AMBIGUOUS",
  SUCCESS_CONDITION_UNMET: "SUCCESS_CONDITION_UNMET",
  LOGIN_REJECTED: "LOGIN_REJECTED",
  /** 运行期引用未解析（ADR-0015 D4），保存期同一问题为 CONFIG_INVALID */
  TEMPLATE_UNRESOLVED: "TEMPLATE_UNRESOLVED",
  // 兜底
  UNKNOWN: "UNKNOWN",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** 登录互斥拒绝时返回给调用方的用户可见错误信息（ADR-0004 D2：自 login-lock.ts 迁入） */
export const LOGIN_BUSY_ERROR = "该页面正在登录中，请等待当前登录完成";

/** 带错误码的结构化登录错误 */
export class LoginError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "LoginError";
    this.code = code;
  }
}

/** fetch 网络层失败（断网 / DNS / CORS）在浏览器中表现为 TypeError */
function isFetchTypeError(e: TypeError): boolean {
  return /fetch|network/i.test(e.message);
}

/**
 * 从任意异常归一化出错误码。
 * - LoginError → 携带的码
 * - RequestTimeoutError → REQUEST_TIMEOUT
 * - NetworkError（fetch-retry）→ NETWORK_ERROR
 * - fetch 原生 TypeError → NETWORK_ERROR
 * - 其他 → UNKNOWN
 */
export function errorCodeOf(e: unknown): ErrorCode {
  if (e instanceof LoginError) return e.code;
  if (e instanceof RequestTimeoutError) return ErrorCodes.REQUEST_TIMEOUT;
  if (e instanceof NetworkError) return ErrorCodes.NETWORK_ERROR;
  if (e instanceof Error) {
    // name 兜底：跨模块/跨包实例 instanceof 失效时仍可识别
    if (e.name === "RequestTimeoutError") return ErrorCodes.REQUEST_TIMEOUT;
    if (e.name === "NetworkError") return ErrorCodes.NETWORK_ERROR;
    if (e instanceof TypeError && isFetchTypeError(e)) {
      return ErrorCodes.NETWORK_ERROR;
    }
  }
  return ErrorCodes.UNKNOWN;
}

// ---------------------------------------------------------------------------
// 复制详情（错误 Toast 的「复制详情」按钮）
// ---------------------------------------------------------------------------

/** 复制详情里的配方步骤（结构对齐 RecipeStepTrace，避免循环依赖） */
export interface ErrorDetailRecipeStep {
  index: number;
  op: string;
  target?: string;
  status: string;
  duration?: number;
  errorCode?: string;
  error?: string;
}

/** 复制详情上下文——只允许非敏感字段，严禁传入密码/token */
export interface ErrorDetailContext {
  /** 操作名（如 SWITCH_ACCOUNT / QUICK_LOGIN） */
  action?: string;
  /** 环境名 */
  envName?: string;
  /** 目标地址 */
  origin?: string;
  /** 登录策略 */
  strategy?: string;
  /** 账号显示名 */
  accountName?: string;
  /** 登录用户名 */
  username?: string;
  /** 配方步骤轨迹（ADR-0012 D13）：失败时直接看出第几步哪个目标 */
  recipeSteps?: ErrorDetailRecipeStep[];
}

/**
 * 生成「复制详情」文本：错误码 + 错误信息 + 关键上下文 + 配方步骤轨迹 + 时间。
 *
 * 轨迹只含 op / 序号 / 目标描述 / 状态 / 错误码，不含填充值（D13 / 安全约束）。
 */
export function buildErrorDetail(
  code: ErrorCode | string,
  message: string,
  ctx: ErrorDetailContext = {},
  now: Date = new Date(),
): string {
  const lines = [`错误码: ${code}`, `错误信息: ${message}`];
  if (ctx.action) lines.push(`操作: ${ctx.action}`);
  if (ctx.envName) lines.push(`环境: ${ctx.envName}`);
  if (ctx.origin) lines.push(`地址: ${ctx.origin}`);
  if (ctx.strategy) lines.push(`登录策略: ${ctx.strategy}`);
  if (ctx.accountName) {
    const suffix =
      ctx.username && ctx.username !== ctx.accountName
        ? ` (${ctx.username})`
        : "";
    lines.push(`账号: ${ctx.accountName}${suffix}`);
  }
  if (ctx.recipeSteps && ctx.recipeSteps.length > 0) {
    lines.push("配方步骤:");
    for (const step of ctx.recipeSteps) {
      const target = step.target ? ` → ${step.target}` : "";
      const duration =
        step.duration === undefined ? "" : ` (${step.duration}ms)`;
      const failed =
        step.status === "error" && step.errorCode
          ? ` [${step.errorCode}]`
          : "";
      lines.push(
        `  ${step.index + 1}. ${step.op}${target}${duration} ${step.status}${failed}`,
      );
    }
  }
  lines.push(`时间: ${now.toLocaleString()}`);
  return lines.join("\n");
}
