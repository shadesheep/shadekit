import type { AuthContext } from "../types";
import { createChromeHostBridge } from "../chrome-host";
import {
  runSpec as runHostSpec,
  buildSpecInputs as buildHostSpecInputs,
  trialAllowedOps,
  type RunSpecOptions,
  type RunSpecResult,
} from "../runtime";
import { requireSupportedLoginSpec } from "./document";
import type { LoginSpec } from "./types";

const SUPPORT_ISSUE_CODES = new Set([
  "SPEC_VERSION_UNSUPPORTED",
  "OP_UNSUPPORTED",
  "ALGORITHM_UNSUPPORTED",
]);

/**
 * 第二道能力门：所有 execute 路径最终都经过 `runSpec`，即使调用方绕过了
 * 环境/试登录前置检查，也不能执行当前客户端不支持的声明。
 *
 * 已知 v2 的结构校验仍由保存/导入边界负责；直接调用执行器的测试与内部
 * 路径可能传入尚未做完整 R1–R7 校验的声明，运行时按既有逐算子语义报告。
 */
function assertExecutionSupported(spec: LoginSpec): void {
  try {
    requireSupportedLoginSpec(spec);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && SUPPORT_ISSUE_CODES.has(code)) {
      throw error;
    }
  }
}

export async function runSpec(
  spec: LoginSpec,
  ctx: AuthContext,
  options: RunSpecOptions = {},
): Promise<RunSpecResult> {
  assertExecutionSupported(spec);
  return runHostSpec({
    spec,
    inputs: {
      username: ctx.credentials.username,
      password: ctx.credentials.password,
      origin: ctx.origin,
      targetUrl: ctx.targetUrl,
      debugRedirect: ctx.debugRedirect,
      vars: ctx.domainConfig.vars,
    },
  }, createChromeHostBridge(ctx), options);
}

export function buildSpecInputs(
  spec: LoginSpec,
  ctx: AuthContext,
  aux: { nonce: string; timestamp: number },
): Record<string, unknown> {
  return buildHostSpecInputs(spec, {
    spec,
    inputs: {
      username: ctx.credentials.username,
      password: ctx.credentials.password,
      origin: ctx.origin,
      targetUrl: ctx.targetUrl,
      debugRedirect: ctx.debugRedirect,
      vars: ctx.domainConfig.vars,
    },
  }, aux);
}

export { trialAllowedOps };
export type {
  RunSpecLogView,
  RunSpecOpEvent,
  RunSpecOptions,
  RunSpecResult,
  SpecOpTrace,
  TrialOptions,
  TrialSignalState,
} from "../runtime";
