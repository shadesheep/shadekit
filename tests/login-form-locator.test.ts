import { describe, expect, it } from "vitest";
import {
  applyLoginFormFrame,
  LEGACY_EMPTY_DEFAULT_SPEC,
  projectLegacyDefaultSpec,
} from "../entrypoints/tools/account-switch/spec/auto-login";
import { defaultLoginSpec } from "../entrypoints/tools/account-switch/spec/editor";
import type { LoginSpec } from "../entrypoints/tools/account-switch/spec/types";
import { loginFormLocatorView } from "../entrypoints/tools/account-switch/config/login-form-locator-model";
import type { FormScanFrame } from "../entrypoints/tools/account-switch/strategies/login-form-scan";

function lockedSpec(): LoginSpec {
  const spec = defaultLoginSpec();
  spec.ops[1] = { op: "fill", target: "#u", value: "{username}", clearFirst: true };
  spec.ops[2] = { op: "fill", target: "#p", value: "{password}", clearFirst: true };
  spec.ops[3] = { op: "click", target: "#go", onNotFound: "fail" };
  return spec;
}

const frame: FormScanFrame = {
  found: true,
  frameId: 0,
  username: { target: "#new-u", count: 1, rank: 0, note: "" },
  password: { target: "#new-p", count: 1, rank: 0, note: "" },
  submit: { target: "#new-go", count: 1, rank: 0, note: "" },
};

describe("loginFormLocatorView", () => {
  it("derives automatic state including the exact legacy default projection", () => {
    expect(loginFormLocatorView(defaultLoginSpec())).toEqual({
      mode: "auto",
      label: "自动定位",
      canScan: true,
    });
    const legacy = structuredClone(LEGACY_EMPTY_DEFAULT_SPEC as LoginSpec);
    expect(loginFormLocatorView(projectLegacyDefaultSpec(legacy)).mode).toBe("auto");
  });

  it("derives locked state only when all three standard targets are concrete", () => {
    expect(loginFormLocatorView(lockedSpec())).toEqual({
      mode: "locked",
      label: "已锁定",
      canScan: true,
    });
  });

  it("derives custom state for partial or explicitly cleared targets", () => {
    const partial = lockedSpec();
    partial.ops[2] = { op: "fill", target: { auto: "login" }, value: "{password}", clearFirst: true };
    expect(loginFormLocatorView(partial)).toEqual({
      mode: "custom",
      label: "自定义定位",
      canScan: true,
    });

    const cleared = lockedSpec();
    cleared.ops[1] = { op: "fill", target: "", value: "{username}", clearFirst: true };
    expect(loginFormLocatorView(cleared).mode).toBe("custom");
    expect(loginFormLocatorView(cleared).mode).not.toBe("auto");
  });

  it("disables the ordinary whole-form action for advanced declarations", () => {
    const advanced = lockedSpec();
    advanced.ops.splice(4, 0, { op: "waitFor", when: { type: "fixed", ms: 1 } });
    expect(loginFormLocatorView(advanced)).toEqual({
      mode: "advanced",
      label: "自定义登录流程",
      canScan: false,
    });
  });
});

describe("locator frame application", () => {
  it("replaces the three standard targets without touching other declarations", () => {
    const original = lockedSpec();
    const next = applyLoginFormFrame(original, frame);

    expect(next?.ops.slice(1, 4).map((op) => op.op === "fill" || op.op === "click" ? op.target : null))
      .toEqual(["#new-u", "#new-p", "#new-go"]);
    expect(next?.ops[0]).toBe(original.ops[0]);
    expect(next?.ops[4]).toBe(original.ops[4]);
    expect(next?.success).toBe(original.success);
  });

  it("returns null for advanced declarations instead of reordering them", () => {
    const advanced = lockedSpec();
    advanced.ops.splice(4, 0, { op: "script", code: "() => true", as: "probe" });
    expect(applyLoginFormFrame(advanced, frame)).toBeNull();
    expect(advanced.ops.map((op) => op.op)).toEqual([
      "clear.cookies", "fill", "fill", "click", "script", "auth.write",
    ]);
  });
});
