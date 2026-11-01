import { buildSpecInputs, type LoginRunInput } from "../runtime";
import { resolveTemplate } from "../spec/template";
import type { LoginSpec } from "../spec/types";
import type { DomainConfig } from "../types";
import { originToMatchPattern } from "./origin-pattern";
import { PermissionError } from "./permission-error";
export { originToMatchPattern } from "./origin-pattern";

export type PermissionWarning = "WILDCARD_ENVIRONMENT" | "ORIGIN_UNSUPPORTED";

export interface ResolvedTarget {
  kind: "goto" | "http" | "debugRedirect";
  url: string;
}

export interface PermissionPlan {
  patterns: string[];
  displayOrigins: string[];
  dynamicTargets: ResolvedTarget[];
  warnings: PermissionWarning[];
}

export function planLoginPermissions(
  environment: DomainConfig,
  spec: LoginSpec,
  inputs: LoginRunInput["inputs"],
): PermissionPlan {
  const patterns = new Set<string>();
  const displayOrigins = new Set<string>();
  const dynamicTargets: ResolvedTarget[] = [];
  const warnings = new Set<PermissionWarning>();
  if (inputs.origin.includes("*")) warnings.add("WILDCARD_ENVIRONMENT");

  const flatInputs = buildSpecInputs(spec, { spec, inputs }, { nonce: "", timestamp: 0 });
  const addTarget = (template: string, kind: ResolvedTarget["kind"]) => {
    let resolved: string;
    try {
      resolved = resolveTemplate(template, { inputs: flatInputs, bindings: {} });
    } catch {
      throw new PermissionError("ORIGIN_UNSUPPORTED", "权限目标缺少必要输入");
    }
    let url: URL;
    try {
      url = new URL(resolved);
    } catch {
      throw new PermissionError("ORIGIN_UNSUPPORTED", "权限目标不是有效 URL");
    }
    const pattern = originToMatchPattern(url);
    patterns.add(pattern);
    displayOrigins.add(url.origin);
    dynamicTargets.push({ kind, url: `${url.origin}${url.pathname}` });
  };

  if (!inputs.origin.includes("*")) addTarget(inputs.origin, "goto");
  for (const op of spec.ops) {
    if (op.op === "goto") addTarget(op.url, "goto");
    if (op.op === "http.execute") addTarget(op.url, "http");
  }
  if (inputs.targetUrl) addTarget(inputs.targetUrl, "goto");
  const debugRedirect = inputs.debugRedirect ??
    (environment.debugRedirectEnabled === false ? undefined : environment.debugRedirect);
  if (debugRedirect) addTarget(debugRedirect, "debugRedirect");
  return {
    patterns: [...patterns],
    displayOrigins: [...displayOrigins],
    dynamicTargets,
    warnings: [...warnings],
  };
}
