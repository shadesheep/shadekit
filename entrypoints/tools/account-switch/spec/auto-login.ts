import { defaultLoginSpec, simpleSpecShape, type SimpleSpecShape } from "./editor";
import {
  AUTO_LOGIN_TARGET,
  DEFAULT_AUTH,
  DEFAULT_LIMITS,
  LOGIN_SPEC_VERSION,
  type AutoLoginTarget,
  type FrameScope,
  type LoginFormTarget,
  type LoginSpec,
  type SpecOp,
  type Target,
} from "./types";
import type { FormScanFrame } from "../strategies/login-form-scan";

export { AUTO_LOGIN_TARGET } from "./types";

/** 仅接受精确的自动标记，拒绝未知值和额外字段。 */
export function isAutoLoginTarget(value: unknown): value is AutoLoginTarget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "auto" &&
    (value as Record<string, unknown>).auto === "login";
}

/** 当前版本之前允许保存的原版默认模板；只用于精确兼容判断。 */
export const LEGACY_EMPTY_DEFAULT_SPEC: Readonly<LoginSpec> = {
  version: LOGIN_SPEC_VERSION,
  template: "generic",
  ops: [
    { op: "clear.cookies", range: "all" },
    { op: "fill", target: "", value: "{username}", clearFirst: true },
    { op: "fill", target: "", value: "{password}", clearFirst: true },
    { op: "click", target: "", onNotFound: "fail" },
    { op: "auth.write" },
  ],
  success: [{ page: { type: "any", of: [{ type: "formGone" }, { type: "urlChanged" }] } }],
  auth: { ...DEFAULT_AUTH },
  limits: { ...DEFAULT_LIMITS },
};

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  return deepEqual(aKeys, bKeys) && aKeys.every((key) => deepEqual(a[key], b[key]));
}

export function isLegacyEmptyDefaultSpec(value: unknown): value is LoginSpec {
  return deepEqual(value, LEGACY_EMPTY_DEFAULT_SPEC);
}

/** 编辑器与运行时共用的只读兼容投影；不改写传入对象或 storage。 */
export function projectLegacyDefaultSpec(spec: LoginSpec): LoginSpec {
  return isLegacyEmptyDefaultSpec(spec) ? defaultLoginSpec() : spec;
}

/** 只有标准三步且三项均为自动标记时，才启用整组运行时解析。 */
export function autoLoginSpecShape(spec: LoginSpec): SimpleSpecShape | null {
  const shape = simpleSpecShape(spec);
  if (!shape) return null;
  const targets = [shape.usernameIndex, shape.passwordIndex, shape.submitIndex].map((index) => {
    const op = spec.ops[index];
    return op && (op.op === "fill" || op.op === "click") ? op.target : undefined;
  });
  return targets.every(isAutoLoginTarget) ? shape : null;
}

function isNonEmptyConcreteTarget(target: LoginFormTarget): target is Target {
  if (isAutoLoginTarget(target)) return false;
  if (typeof target === "string") return target.trim() !== "";
  if (typeof target !== "object" || target === null) return false;
  const values = Object.values(target);
  return values.length === 1 && typeof values[0] === "string" && values[0].trim() !== "";
}

/** 把用户选定的扫描 frame 无损投影到现有标准三步；不重排高级声明。 */
export function applyLoginFormFrame(spec: LoginSpec, frame: FormScanFrame): LoginSpec | null {
  const shape = simpleSpecShape(spec);
  if (!shape) return null;
  const scope: FrameScope = frame.frameId !== undefined && frame.frameId !== 0
    ? { frameId: frame.frameId, ...(frame.frameUrl ? { frameUrl: frame.frameUrl } : {}) }
    : {};
  const replacements = new Map<number, { target: Target | undefined }>([
    [shape.usernameIndex, { target: frame.username?.target }],
    [shape.passwordIndex, { target: frame.password?.target }],
    [shape.submitIndex, { target: frame.submit?.target }],
  ]);
  const ops = spec.ops.map((op, index): SpecOp => {
    const replacement = replacements.get(index);
    if (!replacement || (op.op !== "fill" && op.op !== "click")) return op;
    const { frameId: _frameId, frameUrl: _frameUrl, ...withoutScope } = op;
    return { ...withoutScope, target: replacement.target ?? "", ...scope } as SpecOp;
  });
  return { ...spec, ops };
}

export function loginFormTargetMode(spec: LoginSpec): "auto" | "locked" | "custom" | "advanced" {
  const shape = simpleSpecShape(spec);
  if (!shape) return "advanced";
  const targets = [shape.usernameIndex, shape.passwordIndex, shape.submitIndex].map((index) => {
    const op = spec.ops[index];
    return (op && (op.op === "fill" || op.op === "click") ? op.target : "") as LoginFormTarget;
  });
  if (targets.every(isAutoLoginTarget)) return "auto";
  if (targets.every(isNonEmptyConcreteTarget)) return "locked";
  return "custom";
}
