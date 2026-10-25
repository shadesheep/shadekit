import type { SnapshotIssue } from "./login-spec-validator.mjs";
import type { PackageIssue } from "./config-package.mjs";

export interface SessionGateIssue {
  code: "AUTH_SESSION_UNGATED";
  message: string;
  path: string;
  binding?: string;
}

export function validateDeliverables(input: { spec: unknown; package: unknown }): {
  specIssues: SnapshotIssue[];
  packageIssues: PackageIssue[];
  equalityIssues: PackageIssue[];
  gateIssues: SessionGateIssue[];
};
