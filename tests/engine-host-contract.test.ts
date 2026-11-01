import { describe, expect, it } from "vitest";
import { runSpec } from "../entrypoints/tools/account-switch/runtime";
import { assertHostCanRun } from "../entrypoints/tools/account-switch/runtime";
import { toPublicRunResult } from "../entrypoints/tools/account-switch/runtime";
import type { HostBridge, HostCapabilities } from "../entrypoints/tools/account-switch/runtime";
import type { LoginSpec } from "../entrypoints/tools/account-switch/spec/types";

const ALL_OPS = [
  "clear.cookies", "clear.storage", "goto", "http.execute", "digest",
  "crypto.encrypt", "payload.build", "map", "auth.write", "auth.capture",
  "auth.restore", "fill", "click", "waitFor", "extract", "script",
] as HostCapabilities["ops"];

function capabilities(overrides: Partial<HostCapabilities> = {}): HostCapabilities {
  return { specVersions: [2], ops: ALL_OPS, page: true, session: true, script: true, ...overrides };
}

function hostWith(capabilitiesOverrides: Partial<HostCapabilities> = {}) {
  const calls: string[] = [];
  const host: HostBridge = {
    capabilities: () => capabilities(capabilitiesOverrides),
    http: {
      execute: async (request) => {
        calls.push(`http:${request.method}:${request.url}`);
        return { status: 200, finalUrl: request.url, redirected: false, headers: {}, text: '{"token":"TOKEN-UNIQUE-22"}' };
      },
    },
  };
  return { host, calls };
}

const httpSpec: LoginSpec = {
  version: 2,
  ops: [{ op: "http.execute", url: "{origin}/login", method: "POST", headers: { "Content-Type": "application/json" }, body: { json: { username: "{username}", password: "{password}", tenant: "{tenant}" } }, as: "response" }],
  success: [{ token: { from: "response", path: "token" } }],
  auth: { mode: "page" },
  vars: [{ name: "tenant", default: "default-tenant" }],
};

const input = {
  spec: httpSpec,
  inputs: { username: "alice", password: "PASSWORD-UNIQUE-11", origin: "https://app.test", vars: { tenant: "override-tenant" } },
};

describe("HostBridge 扁平输入与能力预检", () => {
  it("请求字节保持确定性且环境变量覆盖声明默认值", async () => {
    const requests: unknown[] = [];
    const { host } = hostWith();
    host.http = { execute: async (request) => {
      requests.push(request);
      return { status: 200, finalUrl: request.url, redirected: false, headers: {}, text: '{"token":"TOKEN-UNIQUE-22"}' };
    } };
    const result = await runSpec(input, host, { aux: { nonce: "1", timestamp: 1 } });
    expect(result.success).toBe(true);
    expect(requests).toEqual([{
      url: "https://app.test/login", method: "POST", headers: { "Content-Type": "application/json" },
      body: '{"username":"alice","password":"PASSWORD-UNIQUE-11","tenant":"override-tenant"}', timeoutMs: 15000,
    }]);
    expect(result.bindings).toEqual({ response: { token: "TOKEN-UNIQUE-22" } });
  });

  it("未知版本、未知算子和缺失能力在任何宿主副作用前失败", async () => {
    for (const [spec, hostOverrides, code] of [
      [{ ...httpSpec, version: 3 }, {}, "SPEC_VERSION_UNSUPPORTED"],
      [{ ...httpSpec, ops: [{ op: "future.op" }] }, {}, "OP_UNSUPPORTED"],
      [{ ...httpSpec, ops: [{ op: "goto", url: "{origin}" }] }, { page: false }, "HOST_CAPABILITY_MISSING"],
      [{ ...httpSpec, ops: [{ op: "script", code: "() => null", as: "x" }] }, { script: false }, "OP_UNSUPPORTED"],
    ] as const) {
      const { host, calls } = hostWith(hostOverrides);
      const result = await runSpec({ ...input, spec: spec as unknown as LoginSpec }, host);
      expect(result).toMatchObject({ success: false, errorCode: code });
      expect(calls).toEqual([]);
    }
  });

  it("HTTP-only trial 不要求 PagePort 且导航零副作用", async () => {
    const { host, calls } = hostWith({ page: false, session: false, script: false });
    expect(() => assertHostCanRun(httpSpec, host, "trial")).not.toThrow();
    const result = await runSpec({
      spec: { ...httpSpec, ops: [{ op: "goto", url: "https://unused.test" }, ...httpSpec.ops] },
      inputs: input.inputs,
    }, host, { trial: {} });
    expect(result.success).toBe(true);
    expect(calls).toEqual(["http:POST:https://app.test/login"]);
  });

  it("公共结果不携带 bindings、秘密日志或快照", async () => {
    const result = await runSpec(input, hostWith().host);
    const publicResult = toPublicRunResult(result);
    expect(publicResult).not.toHaveProperty("bindings");
    expect(publicResult).not.toHaveProperty("log");
    expect(JSON.stringify(publicResult)).not.toMatch(/TOKEN-UNIQUE-22|PASSWORD-UNIQUE-11/);
  });
});
