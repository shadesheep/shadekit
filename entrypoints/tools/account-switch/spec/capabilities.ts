import {
  LOGIN_SPEC_VERSION,
  SPEC_OP_NAMES,
} from "./types";

export interface LoginSpecCapabilities {
  specVersions: readonly number[];
  ops: readonly string[];
  digestAlgorithms: readonly string[];
  encryptionAlgorithms: readonly string[];
}

export interface SpecSupportIssue {
  code: "SPEC_VERSION_UNSUPPORTED" | "OP_UNSUPPORTED" | "ALGORITHM_UNSUPPORTED";
  message: string;
  opIndex?: number;
}

export interface SpecSupportReport {
  supported: boolean;
  issues: SpecSupportIssue[];
}

export const EXTENSION_SPEC_CAPABILITIES = {
  specVersions: [LOGIN_SPEC_VERSION],
  ops: SPEC_OP_NAMES,
  digestAlgorithms: ["sha1", "sha256"],
  encryptionAlgorithms: ["rsa-pkcs1v15", "rsa-oaep"],
} as const satisfies LoginSpecCapabilities;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Inspect only execution capabilities; structural validation is a separate step. */
export function inspectLoginSpecSupport(
  raw: unknown,
  declaredSpecVersion?: unknown,
  capabilities: LoginSpecCapabilities = EXTENSION_SPEC_CAPABILITIES,
): SpecSupportReport {
  const issues: SpecSupportIssue[] = [];
  const versions = new Set<number>();
  if (isRecord(raw) && typeof raw.version === "number") versions.add(raw.version);
  if (typeof declaredSpecVersion === "number") versions.add(declaredSpecVersion);
  for (const version of versions) {
    if (!capabilities.specVersions.includes(version)) {
      issues.push({
        code: "SPEC_VERSION_UNSUPPORTED",
        message: `当前客户端不支持 LoginSpec 版本 ${version}`,
      });
    }
  }

  if (!isRecord(raw) || !Array.isArray(raw.ops)) {
    return { supported: issues.length === 0, issues };
  }

  const supportedOps = new Set(capabilities.ops);
  const digestAlgorithms = new Set(capabilities.digestAlgorithms);
  const encryptionAlgorithms = new Set(capabilities.encryptionAlgorithms);
  for (const [opIndex, candidate] of raw.ops.entries()) {
    if (!isRecord(candidate)) continue;
    if (typeof candidate.op === "string" && !supportedOps.has(candidate.op)) {
      issues.push({
        code: "OP_UNSUPPORTED",
        message: `当前客户端不支持算子 ${candidate.op}`,
        opIndex,
      });
    }
    if (candidate.op === "digest" &&
      typeof candidate.algorithm === "string" &&
      !digestAlgorithms.has(candidate.algorithm)) {
      issues.push({
        code: "ALGORITHM_UNSUPPORTED",
        message: `当前客户端不支持 digest 算法 ${candidate.algorithm}`,
        opIndex,
      });
    }
    if (candidate.op === "crypto.encrypt" &&
      typeof candidate.algorithm === "string" &&
      !encryptionAlgorithms.has(candidate.algorithm)) {
      issues.push({
        code: "ALGORITHM_UNSUPPORTED",
        message: `当前客户端不支持 crypto.encrypt 算法 ${candidate.algorithm}`,
        opIndex,
      });
    }
  }
  return { supported: issues.length === 0, issues };
}
