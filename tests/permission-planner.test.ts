import { describe, expect, it } from "vitest";
import { originToMatchPattern, planLoginPermissions } from "../entrypoints/tools/account-switch/permissions/permission-planner";
import type { DomainConfig } from "../entrypoints/tools/account-switch/types";
import type { LoginSpec } from "../entrypoints/tools/account-switch/spec/types";

const environment: DomainConfig = { name: "App", tags: [], debugRedirect: "https://debug.test:8443/callback?secret=not-a-permission" };
const spec: LoginSpec = {
  version: 2,
  ops: [
    { op: "goto", url: "https://login.test/{tenant}/sso" },
    { op: "http.execute", url: "https://api.test/session", as: "response" },
  ],
  success: [],
  auth: { mode: "page" },
  vars: [{ name: "tenant", default: "default" }],
};

describe("环境权限规划器", () => {
  it("精确包含页面、goto、HTTP 和 debugRedirect origins，不泄露 query 或端口到 pattern", () => {
    const plan = planLoginPermissions(environment, spec, {
      username: "alice", password: "SECRET-91", origin: "https://app.test",
      debugRedirect: environment.debugRedirect,
      vars: { tenant: "tenant-a" },
    });
    expect(plan.patterns).toEqual([
      "https://app.test/*", "https://login.test/*", "https://api.test/*", "https://debug.test/*",
    ]);
    expect(plan.displayOrigins).toContain("https://debug.test:8443");
    expect(plan.dynamicTargets.map((target) => target.url)).toContain("https://login.test/tenant-a/sso");
    expect(JSON.stringify(plan)).not.toMatch(/not-a-permission|SECRET-91/);
  });

  it("拒绝不支持的 scheme 并标记通配环境", () => {
    expect(() => originToMatchPattern(new URL("file:///tmp/a"))).toThrow("ORIGIN_UNSUPPORTED");
    const plan = planLoginPermissions(environment, spec, {
      username: "alice", password: "", origin: "https://*.test",
    });
    expect(plan.warnings).toContain("WILDCARD_ENVIRONMENT");
    expect(plan.patterns).not.toContain("https://*.test/*");
  });

  it("支持 IPv4、IPv6 和 HTTP-only spec，并去重 origins", () => {
    expect(originToMatchPattern(new URL("http://127.0.0.1:8080/a"))).toBe("http://127.0.0.1/*");
    expect(originToMatchPattern(new URL("http://[::1]:8080/a"))).toBe("http://[::1]/*");
    const plan = planLoginPermissions(environment, { ...spec, ops: [spec.ops[1]] }, {
      username: "alice", password: "", origin: "https://api.test",
    });
    expect(plan.patterns).toEqual(["https://api.test/*", "https://debug.test/*"]);
  });
});
