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
// 用户提示（技术错误仅进入日志与「复制详情」）
// ---------------------------------------------------------------------------

const LOGIN_ERROR_MESSAGES: Record<ErrorCode, string> = {
  [ErrorCodes.CONFIG_NOT_FOUND]: "登录配置不存在，请打开设置检查当前环境",
  [ErrorCodes.ENV_NOT_MATCHED]: "当前地址未配置登录环境，请在设置中添加该环境",
  [ErrorCodes.NO_STRATEGY]: "当前环境尚未设置登录方式，请在设置中完成配置",
  [ErrorCodes.STRATEGY_NOT_FOUND]: "当前登录方式不可用，请在设置中重新选择",
  [ErrorCodes.TAB_RESTRICTED]: "当前页面不支持自动登录，请打开目标系统页面后重试",
  [ErrorCodes.TAB_CLOSED]: "登录页面已关闭或无法打开，请重新打开目标页面后重试",
  [ErrorCodes.TAB_LOAD_TIMEOUT]: "登录页面加载超时，请检查网络和目标服务状态后重试",
  [ErrorCodes.INVALID_URL]: "登录地址无效，请检查选中的地址或环境配置",
  [ErrorCodes.INVALID_REDIRECT_URL]: "跳转地址无效，请检查当前环境的 Bug 页配置",
  [ErrorCodes.NETWORK_ERROR]: "无法连接服务器，请检查网络连接和目标服务状态后重试",
  [ErrorCodes.REQUEST_TIMEOUT]: "登录请求超时，请检查网络后重试",
  [ErrorCodes.STEP_TIMEOUT]: "页面响应超时，请刷新目标页面后重试",
  [ErrorCodes.RSA_ENCRYPT_ERROR]: "登录凭据处理失败，请检查当前环境的加密配置",
  [ErrorCodes.LOGIN_FAILED]: "登录未通过，请核对账号和密码后重试",
  [ErrorCodes.CAPTCHA_REQUIRED]: "需要完成验证码，请在登录页面手动验证后重试",
  [ErrorCodes.INJECT_AUTH_FAILED]: "登录状态未能保存，请确认已打开目标系统页面后重试",
  [ErrorCodes.EMPTY_RESPONSE]: "服务器未返回登录结果，请稍后重试或联系系统管理员",
  [ErrorCodes.LOGIN_BUSY]: LOGIN_BUSY_ERROR,
  [ErrorCodes.STRATEGY_INVALID]: "登录配置有误，请在设置中检查当前环境的登录方式",
  [ErrorCodes.CONFIG_INVALID]: "登录配置有误，请在设置中检查并修复当前环境",
  [ErrorCodes.SELECTOR_INVALID]: "登录表单位置配置无效，请在设置中重新定位",
  [ErrorCodes.ELEMENT_NOT_FOUND]: "未找到登录输入框或按钮，请确认页面已加载，或重新定位登录表单",
  [ErrorCodes.AMBIGUOUS_TARGET]: "找到多个相同的登录元素，请在设置中重新定位",
  [ErrorCodes.FRAME_NOT_FOUND]: "登录页面结构已变化，请刷新页面或重新定位登录表单",
  [ErrorCodes.LOGIN_FORM_NOT_FOUND]: "未找到登录表单，请确认页面已打开并完成加载后重试",
  [ErrorCodes.LOGIN_FORM_INCOMPLETE]: "登录表单不完整，请重新定位或检查页面",
  [ErrorCodes.LOGIN_FORM_AMBIGUOUS]: "无法确定使用哪个登录表单，请手动定位",
  [ErrorCodes.SUCCESS_CONDITION_UNMET]: "服务器已响应，但未确认登录成功，请核对账号密码或检查登录配置",
  [ErrorCodes.LOGIN_REJECTED]: "登录未通过，请核对账号密码；如确认无误，请检查登录配置",
  [ErrorCodes.TEMPLATE_UNRESOLVED]: "登录配置缺少必要信息，请在设置中检查当前环境",
  [ErrorCodes.UNKNOWN]: "登录未完成，请稍后重试；如仍失败，请复制详情并联系技术支持",
};

/** 将内部错误转换为普通用户可理解、可执行的提示。 */
export function formatLoginError(
  code: ErrorCode | string | undefined,
  technicalMessage = "",
): string {
  if (/showing error page/i.test(technicalMessage)) {
    const origin = technicalMessage.match(/https?:\/\/[^\s，；（）()]+/)?.[0];
    return `无法打开登录页面${origin ? ` ${origin}` : ""}，请确认服务已启动并检查网络连接`;
  }
  if (/Failed to fetch|NetworkError|ERR_CONNECTION_|ERR_NAME_NOT_RESOLVED/i.test(technicalMessage)) {
    return LOGIN_ERROR_MESSAGES[ErrorCodes.NETWORK_ERROR];
  }
  if (/Cannot access (?:a )?chrome:|Cannot access contents of url|extensions gallery cannot be scripted/i.test(technicalMessage)) {
    return LOGIN_ERROR_MESSAGES[ErrorCodes.TAB_RESTRICTED];
  }
  if (/No tab with id|Invalid tab ID|tab was closed/i.test(technicalMessage)) {
    return LOGIN_ERROR_MESSAGES[ErrorCodes.TAB_CLOSED];
  }
  if (/Could not establish connection|Receiving end does not exist|请求发送失败/i.test(technicalMessage)) {
    return "登录请求未能发送，请重新打开账号面板后重试";
  }
  return Object.hasOwn(LOGIN_ERROR_MESSAGES, code ?? "")
    ? LOGIN_ERROR_MESSAGES[code as ErrorCode]
    : LOGIN_ERROR_MESSAGES[ErrorCodes.UNKNOWN];
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
