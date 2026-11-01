import {
  inspectLoginSpecSupport,
  type SpecSupportIssue,
} from "./capabilities";
import type { LoginSpec } from "./types";
import { validateLoginSpec, type SpecIssue } from "./validate";

export type SpecDocument = Record<string, unknown> | LoginSpec;

function supportError(issue: SpecSupportIssue): Error {
  return Object.assign(new Error(issue.message), {
    code: issue.code,
    ...(issue.opIndex === undefined ? {} : { opIndex: issue.opIndex }),
  });
}

function validationError(issue: SpecIssue, issues: SpecIssue[]): Error {
  return Object.assign(new Error(issue.message), {
    code: "CONFIG_INVALID" as const,
    issues,
    ...(issue.rule === undefined ? {} : { rule: issue.rule }),
    ...(issue.opIndex === undefined ? {} : { opIndex: issue.opIndex }),
  });
}

/** Narrow a supported v2 document without cloning, migrating, or normalizing it. */
export function requireSupportedLoginSpec(
  raw: unknown,
  declaredSpecVersion?: unknown,
): LoginSpec {
  const support = inspectLoginSpecSupport(raw, declaredSpecVersion);
  if (!support.supported) throw supportError(support.issues[0]);
  const issues = validateLoginSpec(raw);
  if (issues.length > 0) throw validationError(issues[0], issues);
  return raw as LoginSpec;
}
