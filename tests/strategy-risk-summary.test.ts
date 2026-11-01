import { describe, expect, it } from "vitest";
import { summarizeLoginSpecRisk } from "../entrypoints/tools/account-switch/spec/risk-summary";
import type { LoginSpec } from "../entrypoints/tools/account-switch/spec/types";

const spec: LoginSpec = {
  version: 2,
  vars: [{ name: "tenant" }, { name: "region", default: "cn" }],
  ops: [
    { op: "goto", url: "https://sso.example.com/login" },
    { op: "goto", url: "https://app.example.com/home" },
    { op: "goto", url: "{nextUrl}" },
    { op: "http.execute", url: "https://api.example.com/login", as: "response" },
    { op: "clear.cookies", range: "all", includeParent: true },
    { op: "clear.storage", area: "local", range: "all" },
    { op: "auth.capture", as: "snapshot" },
    { op: "auth.restore", snapshot: "snapshot" },
  ],
  success: [],
  auth: {
    mode: "engine",
    cookiesWrite: [{ name: "session", value: "$response.token" }],
    localStorageWrite: [{ key: "tenant", value: "app" }],
  },
};

describe("策略包导入风险摘要", () => {
  it("列出 origins、跨 origin goto、清理、会话写入和所需变量", () => {
    expect(summarizeLoginSpecRisk(spec, "https://app.example.com")).toEqual({
      origins: ["https://api.example.com", "https://app.example.com", "https://sso.example.com"],
      crossOriginGotos: ["https://sso.example.com/login"],
      cookieClearCount: 1,
      storageClearCount: 1,
      includesParentCookieClear: true,
      sessionWriteCount: 3,
      sessionCaptureCount: 1,
      requiredVariables: ["tenant", "region"],
    });
  });

  it("未提供环境 origin 时不把显式 goto 错报为已确认跨 origin", () => {
    expect(summarizeLoginSpecRisk(spec).crossOriginGotos).toEqual([]);
  });
});
