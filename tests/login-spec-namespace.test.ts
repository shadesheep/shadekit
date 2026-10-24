/**
 * login-spec/namespace — 输入命名空间摊平与重名（ADR-0015 D4）
 */
import { describe, expect, it } from "vitest";

import { buildInputNamespace } from "../entrypoints/tools/account-switch/spec/namespace";
import { BUILTIN_INPUT_NAMES } from "../entrypoints/tools/account-switch/spec/types";

describe("buildInputNamespace", () => {
  it("内置输入始终可用", () => {
    const ns = buildInputNamespace({});
    expect(ns.errors).toEqual([]);
    for (const name of BUILTIN_INPUT_NAMES) {
      expect(ns.names.has(name), name).toBe(true);
    }
  });

  it("vars 与 aux 摊平进同一命名空间，无 vars. 前缀", () => {
    const ns = buildInputNamespace({
      vars: [{ name: "publicKey" }, { name: "tenant" }],
      aux: { nonce: "auto", timestamp: "auto" },
    });
    expect(ns.errors).toEqual([]);
    expect(ns.names.has("publicKey")).toBe(true);
    expect(ns.names.has("tenant")).toBe(true);
    expect(ns.names.has("nonce")).toBe(true);
    expect(ns.names.has("timestamp")).toBe(true);
    expect(ns.names.has("vars.publicKey")).toBe(false);
  });

  it("未声明 aux 时 nonce 不在命名空间", () => {
    const ns = buildInputNamespace({ aux: { timestamp: "auto" } });
    expect(ns.names.has("nonce")).toBe(false);
    expect(ns.names.has("timestamp")).toBe(true);
  });

  it("vars 与内置输入重名报错", () => {
    const ns = buildInputNamespace({ vars: [{ name: "password" }] });
    expect(ns.errors).toHaveLength(1);
    expect(ns.errors[0]).toContain("password");
    expect(ns.errors[0]).toContain("内置输入");
  });

  it("vars 与 aux 重名报错", () => {
    const ns = buildInputNamespace({
      vars: [{ name: "nonce" }],
      aux: { nonce: "auto" },
    });
    expect(ns.errors).toHaveLength(1);
    expect(ns.errors[0]).toContain("aux");
  });

  it("vars 内部重复声明报错（不静默覆盖）", () => {
    const ns = buildInputNamespace({
      vars: [{ name: "pk" }, { name: "pk" }],
    });
    expect(ns.errors).toHaveLength(1);
    expect(ns.errors[0]).toContain("重复");
  });

  it("非法变量名报错", () => {
    const ns = buildInputNamespace({ vars: [{ name: "a.b" }, { name: "" }] });
    expect(ns.errors).toHaveLength(2);
  });
});
