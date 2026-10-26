/**
 * 登录声明执行— `runSpec` 的唯一生产接线。
 *
 * 自旧 `GenericStrategy.executeLoginScript`（已随策略注册表删除）迁入：
 * 读取环境 spec → `runSpec` → 算子轨迹写调试缓冲区 → 尾部脱敏日志。
 *
 * 返回与旧 `runAuthFlow` 结果同形的信封（success / error / errorCode /
 * recipeSteps / data / capturedAuth），使三条登录 handler 无需改动消费逻辑。
 */

import { authLog } from "../../../shared/logger";
import { isDevModeEnabled } from "../../../shared/dev-mode";
import type { DebugAuthContext } from "../utils/debug-log";
import type { ErrorCode } from "../utils/error-codes";
import {
  runSpec,
  type RunSpecResult,
  type RunSpecOpEvent,
  type SpecOpTrace,
} from "./run";
import type { LoginSpec, SpecOp, RecipeStepTrace } from "./types";
import type { CapturedAuth, AuthSnapshot } from "../utils/auth-snapshot";
import type { AuthRange, AuthSpec } from "../strategies/generic-recipe";

/** runLoginSpec 结果信封（对旧 runAuthFlow 的兼容形态） */
export interface LoginRunResult {
  success: boolean;
  error?: string;
  errorCode?: ErrorCode;
  /** 绑定表（旧 `data`：token 或任意绑定结构；空表也是有效成功信号） */
  data?: Record<string, unknown>;
  /** 逐算子轨迹（失败定位「第几步哪个目标」） */
  recipeSteps?: RecipeStepTrace[];
  /** 登录 origin 捕获的认证快照（spec 声明 `auth.capture` 时产生） */
  capturedAuth?: CapturedAuth;
}

/**
 * 执行一次登录声明并装配调试日志。
 *
 * - 算子开始/结束事件同步进 `debugBuffer.ops`（中途异常日志也看得到走到第几步）；
 *   dev 模式下实时落一条日志；非 dev 只在失败时写摘要。
 * - 最后一次请求/响应的脱敏副本写 `buffer.request` / `buffer.response`。
 * - 失败归入 `{ success:false, errorCode, error }`，不抛（由调用方写会话日志）。
 * - 快照：spec 声明 `auth.capture` 时，把捕获绑定转成旧 `CapturedAuth` 形态，
 *   供目标 origin tab 恢复（login-tab-flow consume）。
 */
export async function runLoginSpec(
  spec: LoginSpec,
  ctx: DebugAuthContext,
): Promise<LoginRunResult> {
  const buffer = ctx.debugBuffer;
  const liveLog = await isDevModeEnabled();

  const result: RunSpecResult = await runSpec(spec, ctx, {
    onOp: async (event) => {
      if (event.phase === "end" && event.trace) {
        if (buffer) {
          buffer.ops = [
            ...(buffer.ops ?? []),
            toCompat(event.trace) as RecipeStepTrace & { op: string },
          ];
        }
      }
      if (!liveLog) return;
      const trace = toCompat(event.trace ?? undefined);
      await logOpEvent(event, trace, ctx.credentials.username);
    },
  });

  if (buffer && result.log) {
    buffer.request = result.log.request;
    buffer.response = result.log.response;
  }

  const recipeSteps = result.trace.map(toCompat).filter(
    (t): t is RecipeStepTrace => t !== undefined,
  );
  const capturedAuth = captureFromSpec(spec, result);

  if (!result.success) {
    return {
      success: false,
      error: result.error,
      errorCode: result.errorCode,
      recipeSteps,
    };
  }
  return {
    success: true,
    data: result.bindings,
    recipeSteps,
    ...(capturedAuth ? { capturedAuth } : {}),
  };
}

/** 算子日志（dev 模式逐步可见；长流程进行中即可看到当前步骤与结果） */
async function logOpEvent(
  event: RunSpecOpEvent,
  trace: RecipeStepTrace | undefined,
  username: string,
): Promise<void> {
  const opLabel = event.op;
  const target = trace?.target ? ` → ${trace.target}` : "";
  const outcome = trace
    ? ` ${trace.status}${trace.errorCode ? ` [${trace.errorCode}]` : ""} (${trace.duration}ms)`
    : "";
  await authLog.info(
    event.phase === "start"
      ? `算子第 ${event.index + 1} 步开始：${opLabel}`
      : `算子第 ${event.index + 1} 步结束：${opLabel}${target}${outcome}`,
    {
      account: { name: username, username },
      extra: {
        action: event.phase === "start" ? "OP_START" : "OP_END",
        recipeStep: trace ?? {
          index: event.index,
          op: event.op,
          phase: "start",
        } as unknown,
      },
    },
  );
}

/** 找 spec 里的 `auth.capture` 算子，把捕获绑定转成旧 CapturedAuth 形态 */
function captureFromSpec(
  spec: LoginSpec,
  result: RunSpecResult,
): CapturedAuth | undefined {
  const capOp = spec.ops.find(
    (o): o is Extract<SpecOp, { op: "auth.capture" }> => o.op === "auth.capture",
  );
  if (!capOp) return undefined;
  const snapshot = result.bindings[capOp.as];
  if (!isAuthSnapshot(snapshot)) return undefined;
  return { spec: toAuthSpec(capOp), snapshot };
}

/** auth.capture 的捕获结果判定（AuthSnapshot 形态） */
function isAuthSnapshot(v: unknown): v is AuthSnapshot {
  return (
    typeof v === "object" &&
    v !== null &&
    "origin" in v &&
    "cookies" in v
  );
}

/** 把 auth.capture 算子的范围声明转成旧 AuthSpec 快照形态（restoreAuth 消费） */
function toAuthSpec(op: Extract<SpecOp, { op: "auth.capture" }>): AuthSpec {
  const st = (r: AuthRange | undefined): "all" | string[] | undefined =>
    r === undefined || r === "none" ? undefined : r;
  return {
    mode: "snapshot",
    ...(op.cookies !== undefined && op.cookies !== "none"
      ? { cookies: op.cookies }
      : {}),
    ...(st(op.localStorage) !== undefined
      ? { localStorage: st(op.localStorage) }
      : {}),
    ...(st(op.sessionStorage) !== undefined
      ? { sessionStorage: st(op.sessionStorage) }
      : {}),
  } as AuthSpec;
}

/** SpecOpTrace → 兼容旧 RecipeStepTrace 的扁平记录 */
function toCompat(trace: SpecOpTrace | undefined): RecipeStepTrace | undefined {
  if (!trace) return undefined;
  return {
    index: trace.index,
    op: trace.op,
    ...(trace.target !== undefined ? { target: trace.target } : {}),
    status: trace.status,
    duration: trace.duration,
    ...(trace.errorCode !== undefined ? { errorCode: trace.errorCode } : {}),
    ...(trace.error !== undefined ? { error: trace.error } : {}),
    ...(trace.resolution !== undefined ? { resolution: trace.resolution } : {}),
  };
}