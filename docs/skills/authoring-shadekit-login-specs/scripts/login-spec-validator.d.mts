export interface SnapshotIssue {
  code: "CONFIG_INVALID";
  message: string;
  rule?: "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7";
  opIndex?: number;
  path?: string;
}

export function validateLoginSpecSnapshot(raw: unknown): SnapshotIssue[];
