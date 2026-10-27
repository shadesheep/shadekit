import { describe, expect, it } from "vitest";
import { applyLoginFormFrame } from "../entrypoints/tools/account-switch/spec/auto-login";
import { defaultLoginSpec } from "../entrypoints/tools/account-switch/spec/editor";
import type { LoginSpec } from "../entrypoints/tools/account-switch/spec/types";
import {
  resolveAutoLoginScan,
  type FormScanFrame,
  type ScanLoginFormResult,
} from "../entrypoints/tools/account-switch/strategies/login-form-scan";
import type { Target } from "../entrypoints/tools/account-switch/strategies/generic-recipe";

function candidate(target: Target, count = 1) {
  return { target, count, rank: 0, note: "fixture" };
}

function frame(overrides: Partial<FormScanFrame> = {}): FormScanFrame {
  return {
    found: true,
    frameId: 0,
    username: candidate({ name: "user" }),
    password: candidate({ css: "#p" }),
    submit: candidate({ text: "登录" }),
    ...overrides,
  };
}

function found(frames: FormScanFrame[]): ScanLoginFormResult {
  return {
    status: "found",
    frames,
    matches: frames.length,
    complete: frames.some((item) => item.username && item.password && item.submit),
  };
}

const uniqueCompleteUniqueTargets = found([frame({
  frameId: 2,
  frameUrl: "https://example.test/frame",
})]);

const twoCompleteFrames = found([
  frame({ frameId: 0 }),
  frame({ frameId: 2, frameUrl: "https://example.test/frame" }),
]);

const oneFrameWithDuplicateUsername = found([frame({
  username: candidate({ name: "user" }, 2),
})]);

const oneFrameMissingSubmit = found([frame({ submit: undefined })]);

describe("resolveAutoLoginScan", () => {
  it("distinguishes no password from injection errors", () => {
    expect(resolveAutoLoginScan({ status: "notFound" })).toEqual({ status: "noPassword" });
    expect(resolveAutoLoginScan({ status: "error", code: "INJECT_FAILED", message: "denied" }))
      .toEqual({ status: "error", message: "denied" });
  });

  it("resolves one complete frame with three unique targets and one scope", () => {
    expect(resolveAutoLoginScan(uniqueCompleteUniqueTargets)).toEqual({
      status: "resolved",
      frameId: 2,
      frameUrl: "https://example.test/frame",
      targets: {
        username: { name: "user" },
        password: { css: "#p" },
        submit: { text: "登录" },
      },
      scope: { frameId: 2, frameUrl: "https://example.test/frame" },
    });
  });

  it("uses an empty scope for the main frame", () => {
    expect(resolveAutoLoginScan(found([frame()]))).toMatchObject({
      status: "resolved",
      frameId: 0,
      scope: {},
    });
  });

  it("rejects multiple frames and non-unique preferred targets as ambiguous", () => {
    expect(resolveAutoLoginScan(twoCompleteFrames).status).toBe("ambiguous");
    expect(resolveAutoLoginScan(oneFrameWithDuplicateUsername).status).toBe("ambiguous");
  });

  it("rejects an incomplete form without guessing", () => {
    expect(resolveAutoLoginScan(oneFrameMissingSubmit)).toMatchObject({ status: "incomplete" });
  });
});

describe("applyLoginFormFrame", () => {
  it("replaces only standard form targets and frame scopes without mutation", () => {
    const original: LoginSpec = {
      ...defaultLoginSpec(),
      vars: [{ name: "tenant", default: "example" }],
      failure: [{ type: "fixed", ms: 10 }],
      ops: [
        { op: "clear.cookies", range: "all" },
        { op: "clear.storage", area: "local", range: "all" },
        { op: "goto", url: "{origin}/login" },
        ...defaultLoginSpec().ops.slice(1),
      ],
    };
    const before = structuredClone(original);
    const selected = frame({ frameId: 3, frameUrl: "https://example.test/login-frame" });

    const next = applyLoginFormFrame(original, selected);

    expect(next).not.toBeNull();
    expect(original).toEqual(before);
    expect(next?.ops.slice(0, 3)).toEqual(original.ops.slice(0, 3));
    expect(next?.ops[6]).toEqual(original.ops[6]);
    expect(next?.success).toBe(original.success);
    expect(next?.failure).toBe(original.failure);
    expect(next?.vars).toBe(original.vars);
    expect(next?.ops.slice(3, 6)).toEqual([
      { op: "fill", target: { name: "user" }, value: "{username}", clearFirst: true, frameId: 3, frameUrl: "https://example.test/login-frame" },
      { op: "fill", target: { css: "#p" }, value: "{password}", clearFirst: true, frameId: 3, frameUrl: "https://example.test/login-frame" },
      { op: "click", target: { text: "登录" }, onNotFound: "fail", frameId: 3, frameUrl: "https://example.test/login-frame" },
    ]);
  });

  it("clears stale child-frame scope when the selected frame is main", () => {
    const original = defaultLoginSpec();
    original.ops[1] = { ...original.ops[1], frameId: 8, frameUrl: "https://example.test/old" } as never;

    const next = applyLoginFormFrame(original, frame({ frameId: 0 }));

    expect(next?.ops[1]).toEqual({
      op: "fill", target: { name: "user" }, value: "{username}", clearFirst: true,
    });
  });

  it("returns null rather than reordering an advanced declaration", () => {
    const advanced = defaultLoginSpec();
    advanced.ops.splice(4, 0, { op: "waitFor", when: { type: "fixed", ms: 1 } });
    expect(applyLoginFormFrame(advanced, frame())).toBeNull();
  });
});
