import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planLoginPermissions } from "../../entrypoints/tools/account-switch/permissions/permission-planner";
import type { LoginSpec } from "../../entrypoints/tools/account-switch/spec/types";

const spec: LoginSpec = {
  version: 2,
  ops: [
    { op: "goto", url: "https://login.test/sso" },
    { op: "http.execute", url: "https://api.test/session", as: "response" },
  ],
  success: [],
  auth: { mode: "page" },
};

describe("权限规划与注入矩阵（契约 doubles，不代表真实浏览器通过）", () => {
  // 本分支保留 v1.1.7 的静态注入模型：<all_urls> 随安装授予，
  // 账号面板无需动态注册即可使用；权限网关只做运行时目标校验。
  it("保留全量 host 权限与静态 content script 注入", () => {
    const wxtConfig = readFileSync("wxt.config.ts", "utf8");
    expect(wxtConfig).toContain('host_permissions: ["http://*/*", "https://*/*"]');
    expect(wxtConfig).not.toContain("optional_host_permissions");
    const contentEntry = readFileSync("entrypoints/content/index.ts", "utf8");
    expect(contentEntry).toContain('matches: ["http://*/*", "https://*/*"]');
    expect(contentEntry).not.toContain("shadekit.invalid");
  });

  for (const browser of ["chrome", "edge", "firefox"]) {
    it(`${browser}: 完整目标和秘密隔离`, () => {
      const plan = planLoginPermissions({ name: "App", tags: [] }, spec, {
        username: "alice",
        password: "SECRET-91",
        origin: "https://app.test",
        debugRedirect: "https://debug.test:8443/callback?secret=hidden",
      });
      expect(plan.patterns).toEqual([
        "https://app.test/*", "https://login.test/*", "https://api.test/*", "https://debug.test/*",
      ]);
      expect(JSON.stringify(plan)).not.toMatch(/SECRET-91|hidden/);
    });
  }
});
