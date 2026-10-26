import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  waitForTabLoaded: vi.fn(async () => {}),
  reloadTabAndWait: vi.fn(async () => {}),
  applyNavigationIntent: vi.fn(async () => {}),
  snapshotPasswordField: vi.fn(async () => true),
  currentUrl: vi.fn(async () => "https://example.com/login"),
  evaluateCondition: vi.fn(async () => true),
  detectCaptcha: vi.fn(async () => false),
  runDomAction: vi.fn(),
}));

vi.mock("../entrypoints/tools/account-switch/utils/tab-load", () => ({
  waitForTabLoaded: mocks.waitForTabLoaded,
  reloadTabAndWait: mocks.reloadTabAndWait,
}));
vi.mock("../entrypoints/tools/account-switch/login-tab-flow", () => ({
  applyNavigationIntent: mocks.applyNavigationIntent,
}));
vi.mock("../entrypoints/tools/account-switch/strategies/generic-dom", async () => {
  const actual = await vi.importActual<typeof import("../entrypoints/tools/account-switch/strategies/generic-dom")>(
    "../entrypoints/tools/account-switch/strategies/generic-dom",
  );
  return { ...actual, runDomAction: mocks.runDomAction };
});
vi.mock("../entrypoints/tools/account-switch/strategies/generic-settle", async () => {
  const actual = await vi.importActual<typeof import("../entrypoints/tools/account-switch/strategies/generic-settle")>(
    "../entrypoints/tools/account-switch/strategies/generic-settle",
  );
  return {
    ...actual,
    snapshotPasswordField: mocks.snapshotPasswordField,
    currentUrl: mocks.currentUrl,
    evaluateCondition: mocks.evaluateCondition,
    detectCaptcha: mocks.detectCaptcha,
  };
});

const executeScript = vi.fn();
const scanQueue: unknown[] = [];
const domCalls: Array<{ action: string; target: unknown; scope: unknown }> = [];
let scanCalls = 0;

vi.stubGlobal("chrome", {
  tabs: { get: vi.fn(async () => ({ url: "https://example.com/login" })) },
  scripting: { executeScript },
  cookies: {
    getAll: vi.fn(async () => []),
    remove: vi.fn(async () => ({})),
  },
});

import { AUTO_LOGIN_TARGET, LEGACY_EMPTY_DEFAULT_SPEC } from "../entrypoints/tools/account-switch/spec/auto-login";
import { defaultLoginSpec } from "../entrypoints/tools/account-switch/spec/editor";
import { runSpec } from "../entrypoints/tools/account-switch/spec/run";
import type { LoginSpec } from "../entrypoints/tools/account-switch/spec/types";
import type { AuthContext } from "../entrypoints/tools/account-switch/types";
import { ErrorCodes } from "../entrypoints/tools/account-switch/utils/error-codes";

const resolvedFrames = [{
  frameId: 2,
  result: {
    found: true,
    frameUrl: "https://example.test/frame",
    username: { target: { name: "user" }, count: 1, rank: 0, note: "" },
    password: { target: { css: "#p" }, count: 1, rank: 0, note: "" },
    submit: { target: { text: "登录" }, count: 1, rank: 0, note: "" },
  },
}];
const noPasswordFrames = [{ frameId: 0, result: { found: false } }];

function ctx(): AuthContext {
  return {
    tabId: 5,
    origin: "https://example.com",
    domainConfig: { name: "env", tags: [] },
    credentials: { username: "alice", password: "p@ss" },
    tokenData: null,
    targetUrl: "",
    debugRedirect: "",
  };
}

function automaticSpec(): LoginSpec {
  const spec = defaultLoginSpec();
  spec.auth = { mode: "page" };
  spec.success = [{ page: { type: "fixed", ms: 0 } }];
  return spec;
}

function lockedSpec(): LoginSpec {
  const spec = automaticSpec();
  spec.ops[1] = { op: "fill", target: "#u", value: "{username}", clearFirst: true };
  spec.ops[2] = { op: "fill", target: "#p", value: "{password}", clearFirst: true };
  spec.ops[3] = { op: "click", target: "#go", onNotFound: "fail" };
  return spec;
}

beforeEach(() => {
  vi.clearAllMocks();
  scanQueue.length = 0;
  scanQueue.push(structuredClone(resolvedFrames));
  domCalls.length = 0;
  scanCalls = 0;
  mocks.snapshotPasswordField.mockResolvedValue(true);
  mocks.currentUrl.mockResolvedValue("https://example.com/login");
  mocks.evaluateCondition.mockResolvedValue(true);
  mocks.detectCaptcha.mockResolvedValue(false);
  mocks.applyNavigationIntent.mockResolvedValue(undefined);
  mocks.reloadTabAndWait.mockResolvedValue(undefined);
  executeScript.mockImplementation(async () => {
    scanCalls++;
    return scanQueue.length > 0 ? scanQueue.shift() : structuredClone(noPasswordFrames);
  });
  mocks.runDomAction.mockImplementation(async (
    _tabId: number,
    action: { action: string; target: unknown },
    scope: unknown,
  ) => {
    domCalls.push({ action: action.action, target: action.target, scope });
    return { status: "ok", frameId: 2 };
  });
});

describe("runSpec automatic login form", () => {
  it("scans once, executes actual targets in order and records redacted auto traces", async () => {
    const result = await runSpec(automaticSpec(), ctx(), { settle: { pollingIntervalMs: 1 } });

    expect(result.success).toBe(true);
    expect(scanCalls).toBe(1);
    expect(domCalls.map((call) => call.action)).toEqual(["fill", "fill", "click"]);
    expect(domCalls.map((call) => call.target)).toEqual([{ name: "user" }, { css: "#p" }, { text: "登录" }]);
    expect(domCalls.map((call) => {
      const scope = call.scope as { frameId?: number; frameUrl?: string };
      return { frameId: scope.frameId, frameUrl: scope.frameUrl };
    })).toEqual([
      { frameId: 2, frameUrl: "https://example.test/frame" },
      { frameId: 2, frameUrl: "https://example.test/frame" },
      { frameId: 2, frameUrl: "https://example.test/frame" },
    ]);
    expect(result.trace.filter((step) => step.resolution === "auto" && step.op !== "auto.prepare").map((step) => step.target)).toEqual([
      "auto → name=user",
      "auto → #p",
      "auto → 文本「登录」",
    ]);
    expect(JSON.stringify(result.trace)).not.toContain("p@ss");
    expect(result.trace.some((step) => step.op === "auto.prepare")).toBe(true);
  });

  it("runs an untouched legacy default through runtime compatibility", async () => {
    const legacy = structuredClone(LEGACY_EMPTY_DEFAULT_SPEC as LoginSpec);

    const result = await runSpec(legacy, ctx(), { settle: { pollingIntervalMs: 1 } });

    expect(result.success).toBe(true);
    expect(scanCalls).toBe(1);
    expect(legacy.ops[1]).toMatchObject({ target: "" });
  });

  it("never scans locked targets and marks their traces locked", async () => {
    const result = await runSpec(lockedSpec(), ctx(), { settle: { pollingIntervalMs: 1 } });

    expect(result.success).toBe(true);
    expect(scanCalls).toBe(0);
    expect(result.trace.filter((step) => step.resolution === "locked")).toHaveLength(3);
  });

  it("rejects partial or advanced automatic declarations before DOM work", async () => {
    const partial = automaticSpec();
    partial.ops[1] = { op: "fill", target: "#u", value: "{username}", clearFirst: true };

    const result = await runSpec(partial, ctx());

    expect(result).toMatchObject({ success: false, errorCode: ErrorCodes.CONFIG_INVALID });
    expect(scanCalls).toBe(0);
    expect(domCalls).toHaveLength(0);
  });
});

describe("runSpec automatic refresh and failure boundaries", () => {
  it("reloads once after noPassword and waits before rescanning", async () => {
    scanQueue.length = 0;
    scanQueue.push(structuredClone(noPasswordFrames), structuredClone(resolvedFrames));

    const result = await runSpec(automaticSpec(), ctx(), { settle: { pollingIntervalMs: 1 } });

    expect(result.success).toBe(true);
    expect(mocks.reloadTabAndWait).toHaveBeenCalledTimes(1);
    expect(mocks.reloadTabAndWait).toHaveBeenCalledWith(5, 10000);
    expect(scanCalls).toBe(2);
    expect(domCalls.map((call) => call.action)).toEqual(["fill", "fill", "click"]);
  });

  it("fails after a second noPassword without another reload", async () => {
    scanQueue.length = 0;
    scanQueue.push(structuredClone(noPasswordFrames), structuredClone(noPasswordFrames));

    const result = await runSpec(automaticSpec(), ctx());

    expect(result).toMatchObject({ success: false, errorCode: ErrorCodes.LOGIN_FORM_NOT_FOUND });
    expect(mocks.reloadTabAndWait).toHaveBeenCalledTimes(1);
    expect(scanCalls).toBe(2);
    expect(result.trace.some((step) => step.op === "auto.prepare" && step.target?.includes("未发现密码框，刷新后重试（1/1）"))).toBe(true);
  });

  it("does not reload incomplete or ambiguous scans", async () => {
    const incomplete = automaticSpec();
    scanQueue[0] = [{
      frameId: 0,
      result: { ...resolvedFrames[0].result, submit: undefined },
    }];
    const incompleteResult = await runSpec(incomplete, ctx());
    expect(incompleteResult).toMatchObject({ success: false, errorCode: ErrorCodes.LOGIN_FORM_INCOMPLETE });

    scanQueue[0] = [...structuredClone(resolvedFrames), ...structuredClone(resolvedFrames)];
    const ambiguousResult = await runSpec(automaticSpec(), ctx());
    expect(ambiguousResult).toMatchObject({ success: false, errorCode: ErrorCodes.LOGIN_FORM_AMBIGUOUS });
    expect(mocks.reloadTabAndWait).not.toHaveBeenCalled();
  });

  it("does not reload injection or goto failures", async () => {
    executeScript.mockRejectedValueOnce(new Error("denied"));
    const scanFailure = await runSpec(automaticSpec(), ctx());
    expect(scanFailure).toMatchObject({ success: false, errorCode: ErrorCodes.TAB_RESTRICTED });

    mocks.applyNavigationIntent.mockRejectedValueOnce(new Error("navigation denied"));
    const withGoto = automaticSpec();
    withGoto.ops.splice(1, 0, { op: "goto", url: "{origin}/login" });
    const gotoFailure = await runSpec(withGoto, ctx());
    expect(gotoFailure.success).toBe(false);
    expect(mocks.reloadTabAndWait).not.toHaveBeenCalled();
  });

  it("does not reload after a DOM action fails or success conditions are unmet", async () => {
    const domFailureSpec = automaticSpec();
    domFailureSpec.ops[2] = { op: "fill", target: AUTO_LOGIN_TARGET, value: "{password}", clearFirst: true };
    mocks.runDomAction.mockImplementation(async (
      _tabId: number,
      action: { action: string; target: unknown },
      scope: unknown,
    ) => {
      domCalls.push({ action: action.action, target: action.target, scope });
      return action.action === "fill" && action.target && typeof action.target === "object" && "css" in action.target
        ? { status: "notFound" }
        : { status: "ok", frameId: 2 };
    });
    const domFailure = await runSpec(domFailureSpec, ctx());
    expect(domFailure).toMatchObject({ success: false, errorCode: ErrorCodes.ELEMENT_NOT_FOUND });

    scanQueue.push(structuredClone(resolvedFrames));
    mocks.runDomAction.mockImplementation(async (
      _tabId: number,
      action: { action: string; target: unknown },
      scope: unknown,
    ) => {
      domCalls.push({ action: action.action, target: action.target, scope });
      return { status: "ok", frameId: 2 };
    });
    const unmet = automaticSpec();
    unmet.success = [{ page: { type: "urlChanged" } }];
    unmet.limits = { settleMs: 5 };
    mocks.evaluateCondition.mockResolvedValue(false);
    const unmetResult = await runSpec(unmet, ctx(), { settle: { pollingIntervalMs: 1 } });
    expect(unmetResult).toMatchObject({ success: false, errorCode: ErrorCodes.SUCCESS_CONDITION_UNMET });
    expect(mocks.reloadTabAndWait).not.toHaveBeenCalled();
  });
});
