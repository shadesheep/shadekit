import { describe, expect, it } from "vitest";
import { runSpec } from "../entrypoints/tools/account-switch/runtime";
import { toPublicRunResult } from "../entrypoints/tools/account-switch/runtime";
import type { HostBridge } from "../entrypoints/tools/account-switch/runtime";
import type { LoginSpec, SpecOpName } from "../entrypoints/tools/account-switch/spec/types";

const OPS: SpecOpName[] = ["digest", "http.execute"];

function host(): HostBridge {
  return {
    capabilities: () => ({ specVersions: [2], ops: OPS, page: false, session: false, script: false }),
    http: {
      execute: async (request) => ({
        status: 200,
        finalUrl: request.url,
        redirected: false,
        headers: {},
        text: "ok",
      }),
    },
  };
}

describe("秘密 taint 与日志脱敏", () => {
  it("摘要派生值保持 taint，log.reveal 不能揭示且请求日志精确脱敏", async () => {
    const spec: LoginSpec = {
      version: 2,
      ops: [
        { op: "digest", algorithm: "sha256", input: "{password}", as: "sessionToken" },
        { op: "http.execute", url: "{origin}/login", method: "POST", body: { raw: "$sessionToken" }, parse: "text", as: "response" },
      ],
      success: [],
      auth: { mode: "page" },
      log: { reveal: ["sessionToken"] },
    };
    const result = await runSpec({
      spec,
      inputs: { username: "alice", password: "PASSWORD-UNIQUE-77", origin: "https://app.test" },
    }, host());
    expect(result.success).toBe(true);
    expect(result.taint?.bindings.sessionToken).toBe(true);
    const derived = result.bindings.sessionToken;
    expect(typeof derived).toBe("string");
    expect(result.log?.request.revealed).toBeUndefined();
    expect(JSON.stringify(result.log)).not.toContain("PASSWORD-UNIQUE-77");
    expect(JSON.stringify(result.log)).not.toContain(String(derived));
    const publicResult = toPublicRunResult(result);
    expect(publicResult).not.toHaveProperty("taint");
    expect(publicResult).not.toHaveProperty("bindings");
  });
});
