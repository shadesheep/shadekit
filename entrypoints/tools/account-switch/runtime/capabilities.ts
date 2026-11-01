import { LOGIN_SPEC_VERSION, SPEC_OP_NAMES, type LoginSpec, type SettleCondition, type SpecOp, type SpecOpName, type SuccessSignal } from "../spec/types";
import { ErrorCodes, LoginError } from "../utils/error-codes";
import type { HostBridge } from "./host";

const PAGE_OPS: Partial<Record<SpecOpName, true>> = {
  goto: true, fill: true, click: true, waitFor: true, "clear.storage": true, script: true,
};
const SESSION_OPS: Partial<Record<SpecOpName, true>> = {
  "clear.cookies": true, "auth.write": true, "auth.capture": true, "auth.restore": true,
};
const TRIAL_OPS: Partial<Record<SpecOpName, true>> = {
  "http.execute": true, "apply.set": true, digest: true,
  "crypto.encrypt": true, "payload.build": true, map: true,
};

function executedOps(spec: LoginSpec, mode: "login" | "trial", writeSession: boolean): SpecOp[] {
  if (mode === "login") return spec.ops;
  return spec.ops.filter((op) =>
    TRIAL_OPS[op.op] === true ||
    (op.op === "extract" && typeof op.default === "string") ||
    (op.op === "auth.write" && writeSession));
}

function conditionNeedsPage(condition: SettleCondition): boolean {
  if (condition.type === "any" || condition.type === "all") return condition.of.some(conditionNeedsPage);
  return true;
}

function conditionNeedsSession(condition: SettleCondition): boolean {
  if (condition.type === "any" || condition.type === "all") return condition.of.some(conditionNeedsSession);
  return condition.type === "cookie";
}

function successNeedsPage(signals: SuccessSignal[]): boolean {
  return signals.some((signal) => {
    if ("page" in signal) return conditionNeedsPage(signal.page);
    if ("anyOf" in signal) return successNeedsPage(signal.anyOf);
    return false;
  });
}
function successNeedsSession(signals: SuccessSignal[]): boolean {
  return signals.some((signal) => {
    if ("page" in signal) return conditionNeedsSession(signal.page);
    if ("anyOf" in signal) return successNeedsSession(signal.anyOf);
    return false;
  });
}

export function assertHostCanRun(
  spec: LoginSpec,
  host: HostBridge,
  mode: "login" | "trial" = "login",
  writeSession = false,
): void {
  const capabilities = host.capabilities();
  if (spec.version !== LOGIN_SPEC_VERSION || !capabilities.specVersions.includes(spec.version)) {
    throw new LoginError(ErrorCodes.SPEC_VERSION_UNSUPPORTED, `不支持 LoginSpec 版本 ${spec.version}`);
  }
  const engineOps = new Set<string>(SPEC_OP_NAMES);
  const supported = new Set<SpecOpName>(capabilities.ops);
  for (const op of spec.ops) {
    if (!engineOps.has(op.op) || !supported.has(op.op) || (op.op === "script" && !capabilities.script)) {
      throw new LoginError(ErrorCodes.OP_UNSUPPORTED, `宿主不支持算子 ${op.op}`);
    }
  }
  const ops = executedOps(spec, mode, writeSession);

  const signalsNeedPage = mode === "login" && (
    successNeedsPage(spec.success) || (spec.failure ?? []).some(conditionNeedsPage)
  );
  const signalsNeedSession = mode === "login" && (
    successNeedsSession(spec.success) || (spec.failure ?? []).some(conditionNeedsSession)
  );
  if ((signalsNeedPage && (!capabilities.page || !host.page)) ||
    (signalsNeedSession && (!capabilities.session || !host.session))) {
    throw new LoginError(ErrorCodes.HOST_CAPABILITY_MISSING, "成功或失败信号缺少所需宿主能力");
  }

  for (const op of ops) {
    const needsPage = PAGE_OPS[op.op] === true ||
      (op.op === "extract" && op.source !== "cookie") ||
      (op.op === "auth.write" && spec.auth.mode !== "page" &&
        ((spec.auth.localStorageWrite?.length ?? 0) > 0 || (spec.auth.sessionStorageWrite?.length ?? 0) > 0));
    const needsSession = SESSION_OPS[op.op] === true ||
      (op.op === "extract" && op.source === "cookie") ||
      (op.op === "waitFor" && conditionNeedsSession(op.when));
    if (needsPage && (!capabilities.page || !host.page)) {
      throw new LoginError(ErrorCodes.HOST_CAPABILITY_MISSING, `算子 ${op.op} 缺少 PagePort`);
    }
    if (needsSession && (!capabilities.session || !host.session)) {
      throw new LoginError(ErrorCodes.HOST_CAPABILITY_MISSING, `算子 ${op.op} 缺少 SessionPort`);
    }
    if (op.op === "script" && !host.script) {
      throw new LoginError(ErrorCodes.HOST_CAPABILITY_MISSING, "script 缺少 ScriptPort");
    }
  }
}
