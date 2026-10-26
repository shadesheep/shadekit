import { describe, expect, it } from "vitest";
import {
  AUTO_LOGIN_TARGET,
  autoLoginSpecShape,
  isAutoLoginTarget,
  LEGACY_EMPTY_DEFAULT_SPEC,
  loginFormTargetMode,
  projectLegacyDefaultSpec,
} from "../entrypoints/tools/account-switch/spec/auto-login";
import { defaultLoginSpec } from "../entrypoints/tools/account-switch/spec/editor";
import {
  DEFAULT_LIMITS,
  type LoginSpec,
  type SpecOp,
} from "../entrypoints/tools/account-switch/spec/types";
import { validateLoginSpec } from "../entrypoints/tools/account-switch/spec/validate";

function legacySpec(): LoginSpec {
  return structuredClone(LEGACY_EMPTY_DEFAULT_SPEC as LoginSpec);
}

function lockedSpec(): LoginSpec {
  const spec = defaultLoginSpec();
  spec.ops[1] = { op: "fill", target: "#u", value: "{username}", clearFirst: true };
  spec.ops[2] = { op: "fill", target: "#p", value: "{password}", clearFirst: true };
  spec.ops[3] = { op: "click", target: "#go", onNotFound: "fail" };
  return spec;
}

describe("automatic login target and standard shape", () => {
  it("uses explicit automatic targets in the default spec", () => {
    const targets = defaultLoginSpec().ops
      .filter((op) => op.op === "fill" || op.op === "click")
      .map((op) => op.target);

    expect(targets).toEqual([AUTO_LOGIN_TARGET, AUTO_LOGIN_TARGET, AUTO_LOGIN_TARGET]);
    expect(isAutoLoginTarget(AUTO_LOGIN_TARGET)).toBe(true);
    expect(isAutoLoginTarget({ auto: "other" })).toBe(false);
    expect(validateLoginSpec(defaultLoginSpec())).toEqual([]);
  });

  it("recognizes only the complete automatic standard shape", () => {
    expect(autoLoginSpecShape(defaultLoginSpec())).toEqual({
      usernameIndex: 1,
      passwordIndex: 2,
      submitIndex: 3,
    });

    const withHttp: LoginSpec = {
      ...defaultLoginSpec(),
      ops: [
        { op: "http.execute", url: "{origin}/api", as: "r" },
        ...defaultLoginSpec().ops,
      ],
    };
    expect(autoLoginSpecShape(withHttp)).toBeNull();
    expect(autoLoginSpecShape(lockedSpec())).toBeNull();
  });

  it("returns original op indices with goto and session operations", () => {
    const ops: SpecOp[] = [...defaultLoginSpec().ops];
    ops.splice(1, 0,
      { op: "goto", url: "{origin}/login" },
      { op: "clear.storage", area: "local", range: "all" },
    );

    expect(autoLoginSpecShape({ ...defaultLoginSpec(), ops })).toEqual({
      gotoIndex: 1,
      usernameIndex: 3,
      passwordIndex: 4,
      submitIndex: 5,
    });
  });
});

describe("legacy empty default projection", () => {
  it("projects the exact historical default to explicit automatic targets", () => {
    expect(projectLegacyDefaultSpec(legacySpec())).toEqual(defaultLoginSpec());
  });

  it("ignores JSON object key order when matching the historical default", () => {
    const legacy = legacySpec();
    const reordered = {
      ...Object.fromEntries(Object.entries(legacy).reverse()),
      ops: legacy.ops.map((op) => Object.fromEntries(Object.entries(op).reverse())),
    } as LoginSpec;

    expect(projectLegacyDefaultSpec(reordered)).toEqual(defaultLoginSpec());
  });

  it("does not generalize compatibility to modified or custom empty specs", () => {
    const modified = legacySpec();
    modified.limits = { ...DEFAULT_LIMITS, stepMs: 4999 };
    expect(projectLegacyDefaultSpec(modified)).toBe(modified);
    expect(validateLoginSpec(modified).some((issue) => issue.code === "CONFIG_INVALID")).toBe(true);

    const custom = { ...legacySpec(), template: "custom" };
    expect(projectLegacyDefaultSpec(custom)).toBe(custom);
    expect(validateLoginSpec(custom).some((issue) => issue.code === "CONFIG_INVALID")).toBe(true);
  });

  it("accepts the untouched historical default without rewriting it", () => {
    const legacy = legacySpec();
    expect(validateLoginSpec(legacy)).toEqual([]);
    expect(projectLegacyDefaultSpec(legacy)).not.toBe(legacy);
    expect(legacy.ops[1]).toMatchObject({ target: "" });
  });
});

describe("login form target mode", () => {
  it("distinguishes automatic, locked, custom and advanced declarations", () => {
    expect(loginFormTargetMode(defaultLoginSpec())).toBe("auto");
    expect(loginFormTargetMode(lockedSpec())).toBe("locked");

    const partial = lockedSpec();
    partial.ops[2] = { op: "fill", target: AUTO_LOGIN_TARGET, value: "{password}", clearFirst: true };
    expect(loginFormTargetMode(partial)).toBe("custom");

    const advanced = lockedSpec();
    advanced.ops.splice(4, 0, { op: "waitFor", when: { type: "fixed", ms: 1 } });
    expect(loginFormTargetMode(advanced)).toBe("advanced");
  });

  it("treats an explicitly cleared target as custom rather than automatic", () => {
    const cleared = lockedSpec();
    cleared.ops[1] = { op: "fill", target: "", value: "{username}", clearFirst: true };
    expect(loginFormTargetMode(cleared)).toBe("custom");
    expect(projectLegacyDefaultSpec(cleared)).toBe(cleared);
  });
});
