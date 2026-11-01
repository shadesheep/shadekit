import type { LoginSpec } from "./types";

export interface LoginSpecRiskSummary {
  origins: string[];
  crossOriginGotos: string[];
  cookieClearCount: number;
  storageClearCount: number;
  includesParentCookieClear: boolean;
  sessionWriteCount: number;
  sessionCaptureCount: number;
  requiredVariables: string[];
}

function literalOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/** 只描述声明中可见的能力，不代表策略来源可信或执行安全。 */
export function summarizeLoginSpecRisk(
  spec: LoginSpec,
  environmentOrigin?: string,
): LoginSpecRiskSummary {
  const origins = new Set<string>();
  const crossOriginGotos: string[] = [];
  const baseOrigin = environmentOrigin ? literalOrigin(environmentOrigin) : undefined;
  let cookieClearCount = 0;
  let storageClearCount = 0;
  let includesParentCookieClear = false;
  let sessionWriteCount =
    (spec.auth.cookiesWrite?.length ?? 0) +
    (spec.auth.localStorageWrite?.length ?? 0) +
    (spec.auth.sessionStorageWrite?.length ?? 0);
  let sessionCaptureCount = 0;

  for (const op of spec.ops) {
    if (op.op === "goto" || op.op === "http.execute") {
      const origin = literalOrigin(op.url);
      if (origin) origins.add(origin);
      if (op.op === "goto" && origin && baseOrigin && origin !== baseOrigin) {
        crossOriginGotos.push(op.url);
      }
    }
    if (op.op === "clear.cookies") {
      cookieClearCount += 1;
      if (op.includeParent) includesParentCookieClear = true;
    }
    if (op.op === "clear.storage") storageClearCount += 1;
    if (op.op === "auth.write" || op.op === "auth.restore") sessionWriteCount += 1;
    if (op.op === "auth.capture") sessionCaptureCount += 1;
  }

  return {
    origins: [...origins].sort(),
    crossOriginGotos,
    cookieClearCount,
    storageClearCount,
    includesParentCookieClear,
    sessionWriteCount,
    sessionCaptureCount,
    requiredVariables: (spec.vars ?? []).map((variable) => variable.name),
  };
}
