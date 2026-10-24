/**
 * 登录调试日志 — 统一 logger 的 auth 类别写入适配器（ADR-0004 D5）
 *
 * logger 是唯一日志存储，DevLogsViewer（options 页）是唯一查看器；
 * 本模块只负责把 DebugLogEntry 在途形状转换为 logger 的 auth 条目。
 * 旧 DebugLogEntry 存储 key 的数据已放弃迁移（内部工具）。
 */

import { isDevModeEnabled } from "../../../shared/dev-mode";
import { authLog } from "../../../shared/logger";
import type { AuthContext, DebugLogEntry, DomainConfig } from "../types";
import { ErrorCodes } from "./error-codes";

// ---------------------------------------------------------------------------
// 日志写入 — 统一 logger auth 类别
// ---------------------------------------------------------------------------

/** 添加一条调试日志，转换为统一格式 */
export async function logEntry(entry: DebugLogEntry): Promise<void> {
  // 开发者模式：记录完整调试日志（含请求/响应）
  if (await isDevModeEnabled()) {
    const message = formatDebugMessage(entry);

    await authLog.info(message, {
      account: entry.account,
      extra: {
        action: entry.action,
        domain: entry.domain,
        result: entry.result,
        ops: entry.ops,
        targetUrl: entry.targetUrl,
        debugRedirect: entry.debugRedirect,
        request: entry.request,
        response: entry.response,
      },
      error: entry.result.error,
    });
    return;
  }

  // 非 dev 模式：仅失败时记录最小摘要——
  // 错误码 + 时间 + 脱敏上下文（环境/策略/账号名），不含请求/响应/密码，
  // 事后可在日志页按错误码定位问题。
  if (!entry.result.success) {
    const code = entry.result.errorCode ?? ErrorCodes.UNKNOWN;
    await authLog.error(
      `${entry.action} 失败 [${code}] ${entry.result.error ?? "未知错误"}`,
      {
        account: entry.account,
        error: entry.result.error,
        extra: {
          action: entry.action,
          errorCode: code,
          domain: entry.domain?.name,
          loginMethod: entry.domain?.loginMethod,
          // 非 dev 模式也保留轨迹：失败定位「第几步哪个目标」的最小信息
          ops: entry.ops,
          failureSummary: true,
        },
      },
    );
  }
}

/** 格式化调试日志消息 */
function formatDebugMessage(entry: DebugLogEntry): string {
  const action = entry.action;
  const domain = entry.domain?.name ?? "未知";
  const account = entry.account?.name ?? "未知";
  const success = entry.result.success;
  const duration = entry.result.duration;

  if (success) {
    return `${action} 成功 [${domain}] ${account} (${duration}ms)`;
  } else {
    const code = entry.result.errorCode ? `[${entry.result.errorCode}] ` : "";
    return `${action} 失败 [${domain}] ${account}: ${code}${entry.result.error ?? "未知错误"} (${duration}ms)`;
  }
}

// ---------------------------------------------------------------------------
// 调试缓冲区（在途形状）
// ---------------------------------------------------------------------------

/** 调试数据缓冲区，在 pipeline 各步骤间传递 */
export interface DebugBuffer {
  request?: DebugLogEntry["request"];
  response?: DebugLogEntry["response"];
  /**
   * 逐算子轨迹（ADR-0015 D8，原 `recipeSteps` 升格）：执行器逐步写入，
   * 长流程中途异常时也能留下「走到第几步」。
   */
  ops?: DebugLogEntry["ops"];
  startTime: number;
}

/** 附带调试缓冲区的 AuthContext */
export interface DebugAuthContext extends AuthContext {
  debugBuffer?: DebugBuffer;
}

/** 创建调试日志条目的工厂函数 */
export function newDebugEntry(
  action: DebugLogEntry["action"],
  account: { name: string; username: string },
  origin: string,
  domainConfig: DomainConfig | null,
  result: DebugLogEntry["result"],
  debugBuffer: DebugBuffer,
  targetUrl?: string,
  debugRedirect?: string,
  ops?: DebugLogEntry["ops"],
): DebugLogEntry {
  const entry: DebugLogEntry = {
    id: "dbg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
    timestamp: Date.now(),
    action,
    account,
    domain: domainConfig
      ? {
          name: domainConfig.name,
          origin,
          loginMethod: domainConfig.loginMethod || "generic",
        }
      : { name: "未知", origin, loginMethod: "" },
    request: debugBuffer.request ?? null,
    response: debugBuffer.response ?? null,
    result,
    targetUrl,
    debugRedirect,
  };
  if (ops && ops.length > 0) entry.ops = ops;
  return entry;
}
