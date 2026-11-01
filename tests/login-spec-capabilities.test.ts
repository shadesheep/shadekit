import { describe, expect, it } from "vitest";
import {
  EXTENSION_SPEC_CAPABILITIES,
  inspectLoginSpecSupport,
} from "../entrypoints/tools/account-switch/spec/capabilities";
import { requireSupportedLoginSpec } from "../entrypoints/tools/account-switch/spec/document";
import {
  SPEC_OP_NAMES,
  type LoginSpec,
  type SpecOp,
} from "../entrypoints/tools/account-switch/spec/types";

const validV2: LoginSpec = {
  version: 2,
  ops: [{ op: "click", target: "#submit" }],
  success: [{ page: { type: "formGone" } }],
  auth: { mode: "page" },
};

function v2WithOp(op: string): Record<string, unknown> {
  return { ...validV2, ops: [{ op, future: { keep: true } }] };
}

function v2WithDigest(algorithm: string): Record<string, unknown> {
  return {
    ...validV2,
    ops: [{ op: "digest", algorithm, input: "{username}", as: "hash" }],
  };
}

function v2WithEncryption(algorithm: string): Record<string, unknown> {
  return {
    ...validV2,
    ops: [{
      op: "crypto.encrypt",
      algorithm,
      publicKey: "public-key",
      input: "{password}",
      as: "encrypted",
    }],
  };
}

describe("raw LoginSpec capability inspection", () => {
  it("distinguishes capability gaps from malformed known v2 declarations", () => {
    const future = inspectLoginSpecSupport({
      version: 3,
      ops: [{ op: "future.op", future: { keep: true } }],
    });
    expect(future.supported).toBe(false);
    expect(future.issues[0]).toMatchObject({ code: "SPEC_VERSION_UNSUPPORTED" });
    expect(future.issues).toContainEqual(
      expect.objectContaining({ code: "OP_UNSUPPORTED", opIndex: 0 }),
    );

    expect(inspectLoginSpecSupport(v2WithOp("future.op"))).toMatchObject({
      supported: false,
      issues: [{ code: "OP_UNSUPPORTED", opIndex: 0 }],
    });
    expect(inspectLoginSpecSupport(v2WithDigest("md5")).issues[0]?.code).toBe(
      "ALGORITHM_UNSUPPORTED",
    );
    expect(inspectLoginSpecSupport({ ...validV2, success: [] }).supported).toBe(true);
    expect(() => requireSupportedLoginSpec({ ...validV2, success: [] })).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
  });

  it("checks package provenance and algorithm lists independently", () => {
    expect(inspectLoginSpecSupport(validV2, 3).issues[0]?.code).toBe(
      "SPEC_VERSION_UNSUPPORTED",
    );

    const digest = inspectLoginSpecSupport({
      ...validV2,
      ops: [
        { op: "digest", algorithm: "md5", input: "{username}", as: "hash" },
        {
          op: "crypto.encrypt",
          algorithm: "rsa-oaep",
          publicKey: "key",
          input: "{password}",
          as: "encrypted",
        },
      ],
    });
    expect(digest.issues).toEqual([
      expect.objectContaining({ code: "ALGORITHM_UNSUPPORTED", opIndex: 0 }),
    ]);

    const encryption = inspectLoginSpecSupport(v2WithEncryption("rsa-unsupported"));
    expect(encryption.issues).toEqual([
      expect.objectContaining({ code: "ALGORITHM_UNSUPPORTED", opIndex: 0 }),
    ]);
  });

  it("does not bump the version for template-only changes and supports simulated upgrades", () => {
    expect(inspectLoginSpecSupport({ ...validV2, template: "renamed-template" }).supported).toBe(true);

    const futureV3 = {
      ...validV2,
      version: 3,
      futureTop: { keep: [1, 2] },
      ops: [{ op: "future.op", unknownField: "keep-me" }] as unknown as SpecOp[],
    };
    const original = structuredClone(futureV3);
    expect(inspectLoginSpecSupport(futureV3, undefined, {
      ...EXTENSION_SPEC_CAPABILITIES,
      specVersions: [2, 3],
      ops: [...SPEC_OP_NAMES, "future.op"],
    }).supported).toBe(true);
    expect(futureV3).toEqual(original);
  });

  it("narrows supported documents without cloning and throws the first support issue", () => {
    expect(requireSupportedLoginSpec(validV2)).toBe(validV2);
    expect(() => requireSupportedLoginSpec(v2WithOp("future.op"))).toThrowError(
      expect.objectContaining({ code: "OP_UNSUPPORTED", opIndex: 0 }),
    );
  });
});
