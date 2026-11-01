export type PermissionErrorCode =
  | "HOST_PERMISSION_REQUIRED"
  | "HOST_PERMISSION_DENIED"
  | "HOST_PERMISSION_REVOKED"
  | "WILDCARD_ENVIRONMENT"
  | "ORIGIN_UNSUPPORTED";

export class PermissionError extends Error {
  constructor(
    public readonly code: PermissionErrorCode,
    message: string,
    public readonly missingOrigins: string[] = [],
  ) {
    super(message);
    this.name = "PermissionError";
  }
}
