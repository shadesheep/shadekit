export interface PackageIssue {
  code?: "CONFIG_INVALID";
  message: string;
  opIndex?: number;
  varName?: string;
  path?: string;
}

export interface ConfigPackageVar { name: string; title?: string }
export interface ConfigPackage {
  format: "dt-login-config/v1";
  specVersion: 2;
  requiredVars: ConfigPackageVar[];
  environments: Array<{
    name: string;
    url: string;
    loginMethod?: string;
    spec: unknown;
    requiredVars: ConfigPackageVar[];
  }>;
}

export function buildConfigPackageSnapshot(input: {
  spec: unknown;
  name: string;
  url: string;
  loginMethod?: string;
  requiredVars?: string[];
}): { package?: ConfigPackage; issues: PackageIssue[] };

export function validateConfigPackageSnapshot(raw: unknown): PackageIssue[];
