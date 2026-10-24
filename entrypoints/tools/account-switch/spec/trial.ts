/**
 * 试登录— 以 `runSpec` 的单算子模式安全执行一次登录请求。
 *
 * 默认零副作用：
 * - 只执行 HTTP `http.execute` 与数据变换（digest / crypto.encrypt /
 *   payload.build / map / apply.set），构造请求所需的插值都能跑
 * - 不执行 `auth.write`（除非显式勾选）、不执行 `goto` / 页面 / 会话 /
 *   跨 origin 算子、不触达用户当前标签页
 * - 对任意域名只能发出一次请求，返回值不暴露完整响应体
 *
 * *安全模型：试登录是有害的（向目标发真实登录请求、`writeSession` 时写入
 * 会话），必须由用户在有授权的环境手动触发——这里不设任何登录锁，因为
 * 无法可靠区分「用户主动试登录」与「被动请求」；调用方（UI）负责只在
 * 明确的用户点击时调用它。
 *
 * 结果区分「请求成功」与「成功信号未满足」，并逐条列出命中的信号：
 * - `requestOk`: 是否已成功发出（数据）请求、且所有数据成功信号满足或无
 *   数据信号；等价于 `runSpec` 的 `success`
 * - `signals`: 每条数据成功信号的状态（met / description）
 * - `signalUnmet`: 是否成功信号未满足（请求发出但条件不成立）
 */

import type { AuthContext } from "../types";
import { ErrorCodes } from "../utils/error-codes";
import { runSpec, trialAllowedOps, type TrialSignalState } from "./run";
import type { LoginSpec } from "./types";

export interface TrialResult {
  /** 是否已成功发出请求（含数据信号满足 / 无数据信号；不包含页面信号） */
  ok: boolean;
  /** 请求是否已实际发出（http.execute 已执行） */
  requestSent: boolean;
  /** 成功信号是否未满足（请求成功但条件不成立） */
  signalUnmet: boolean;
  /** 逐条数据成功信号的状态（空 = 无数据信号或全部是页面信号） */
  signals: TrialSignalState[];
  /** 会话是否已写入（writeSession 为 true 且 auth.write 已执行） */
  sessionWritten: boolean;
  /** runSpec 返回的错误码（请求 / 信号失败；零副作用重路由不算失败） */
  errorCode?: string;
  /** runSpec 返回的错误信息 */
  error?: string;
  /** 试登录产出的绑定表（失败信息 / 排障用；调用方不得原样展示敏感值） */
  bindings: Record<string, unknown>;
}

/**
 * 单算子模式：以试登录语义执行一次 spec。
 *
 * `ctx.credentials` 由调用方注入（UI 的试登录表单）；`ctx` 的其它字段
 * （tabId / origin / targetUrl）沿用环境配置推导——试登录按
 * 环境配置的地址发请求，不依赖任何已打开的标签页。
 *
 * 返回 `TrialResult`；与 `runSpec` 不同，这里不抛异常。
 */
export async function runTrialLogin(
  spec: LoginSpec,
  ctx: AuthContext,
  opts: { writeSession?: boolean } = {},
): Promise<TrialResult> {
  const writeSession = opts.writeSession === true;
  const result = await runSpec(spec, ctx, { trial: { writeSession } });

  const base: TrialResult = {
    ok: result.success,
    // 请求是否实际发出：http.execute 真正执行（成功或失败）即算发出；
    // 只有被拒（skipped）的 http.execute 才不计入。
    requestSent: result.trace.some(
      (t) => t.op === "http.execute" && t.status !== "skipped",
    ),
    signalUnmet: !result.success && result.errorCode === ErrorCodes.SUCCESS_CONDITION_UNMET,
    signals: result.trialSignals ?? [],
    sessionWritten: writeSession && result.trace.some((t) => t.op === "auth.write" && t.status === "success"),
    ...(!result.success ? { errorCode: result.errorCode, error: result.error } : {}),
    bindings: result.bindings,
  };
  return base;
}

/** re-export：UI 引用试登录算子白名单（用于标注哪些算子在试登录里会跳过） */
export { trialAllowedOps };