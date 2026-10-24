/**
 * 试登录 — 默认零副作用。
 *
 * 以 `runSpec` 的 `trial` 模式为 seam（S1），断言：
 * - 默认不执行 `auth.write` / `goto` / 页面 / 会话 / 跨 origin 算子（无关算子记 skipped）
 * - 显式勾选 `writeSession` 后才执行 `auth.write`
 * - 结果区分「请求成功」与「成功信号未满足」，并逐条展示命中的信号
 * - 页面类算子不在试登录中执行
 * - 纯页面信号的 spec 在请求成功后视为试登录通过
 *
 * 不触达浏览器的判据：trial 模式跳过起步基准采样（snapshotPasswordField /
 * currentUrl 不调用），被拒算子不调用其 chrome API。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  snapshotPasswordField: vi.fn(async () => true),
  currentUrl: vi.fn(async () => "https://example.com/dashboard"),
  evaluateCondition: vi.fn(async () => true),
  detectCaptcha: vi.fn(async () => false),
  waitForTabLoaded: vi.fn(async () => {}),
  applyNavigationIntent: vi.fn(async () => {}),
}));

vi.mock("../entrypoints/tools/account-switch/utils/tab-load", () => ({
  waitForTabLoaded: mocks.waitForTabLoaded,
}));
vi.mock("../entrypoints/tools/account-switch/login-tab-flow", () => ({
  applyNavigationIntent: mocks.applyNavigationIntent,
}));
vi.mock("../entrypoints/tools/account-switch/strategies/generic-settle", async () => {
  const actual = await vi.importActual<
    typeof import("../entrypoints/tools/account-switch/strategies/generic-settle")
  >("../entrypoints/tools/account-switch/strategies/generic-settle");
  return {
    ...actual,
    snapshotPasswordField: mocks.snapshotPasswordField,
    currentUrl: mocks.currentUrl,
    evaluateCondition: mocks.evaluateCondition,
    detectCaptcha: mocks.detectCaptcha,
  };
});

const chromeStub = {
  cookies: { getAll: vi.fn(async () => []), set: vi.fn(async () => {}) },
  scripting: { executeScript: vi.fn(async () => []) },
  tabs: { get: vi.fn(async () => ({ url: "https://example.com/dashboard" })) },
};
vi.stubGlobal("chrome", chromeStub);

import { runSpec } from "../entrypoints/tools/account-switch/spec/run";
import { runTrialLogin } from "../entrypoints/tools/account-switch/spec/trial";
import { trialAllowedOps } from "../entrypoints/tools/account-switch/spec/run";
import type { LoginSpec, SpecOp } from "../entrypoints/tools/account-switch/spec/types";
import type { AuthContext } from "../entrypoints/tools/account-switch/types";
import { ErrorCodes } from "../entrypoints/tools/account-switch/utils/error-codes";

function buildCtx(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    tabId: 5,
    origin: "https://example.com",
    domainConfig: { name: "env", tags: [] },
    credentials: { username: "alice", password: "p@ss" },
    tokenData: null,
    targetUrl: "https://example.com/dashboard",
    debugRedirect: "",
    ...overrides,
  };
}

function spec(
  ops: SpecOp[],
  success: LoginSpec["success"] = [{ response: { from: "resp", path: "ok", equals: true } }],
  overrides: Partial<LoginSpec> = {},
): LoginSpec {
  return {
    version: 2,
    ops,
    success,
    auth: { mode: "engine" },
    ...overrides,
  };
}

interface FetchedCall {
  url: string;
  init: RequestInit;
}
const fetchHistory: FetchedCall[] = [];
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function stubFetch(handler?: (info: RequestInfo | URL, init?: RequestInit) => Response) {
  vi.stubGlobal("fetch", async (info: RequestInfo | URL, init?: RequestInit) => {
    fetchHistory.push({ url: typeof info === "string" ? (info as string) : (info as URL).href, init: init ?? {} });
    return (handler ?? (() => jsonResponse({ ok: true })))(info, init ?? {});
  });
}
function lastFetch(): FetchedCall {
  return fetchHistory[fetchHistory.length - 1];
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchHistory.length = 0;
  mocks.snapshotPasswordField.mockResolvedValue(true);
  mocks.currentUrl.mockResolvedValue("https://example.com/dashboard");
  mocks.evaluateCondition.mockResolvedValue(true);
  mocks.detectCaptcha.mockResolvedValue(false);
});

describe("试登录 — 默认零副作用", () => {
  it("不执行 auth.write / goto / 页面 / 会话算子，记 skipped 而非报错", async () => {
    stubFetch();
    const result = await runSpec(
      spec([
        { op: "goto", url: "{origin}/login" },
        { op: "fill", target: "#u", value: "{username}" },
        { op: "fill", target: "#p", value: "{password}" },
        { op: "http.execute", url: "{origin}/login", method: "POST", as: "resp" },
        { op: "auth.write" },
      ]),
      buildCtx(),
      { trial: { writeSession: false }, settle: { pollingIntervalMs: 1 } },
    );
    // 请求成功：数据信号 resp.ok 满足
    expect(result.success).toBe(true);
    // 无关算子全部 skipped，只有 http.execute 真正执行
    const skipOps = result.trace.filter((t) => t.status === "skipped").map((t) => t.op);
    expect(skipOps).toEqual(expect.arrayContaining(["goto", "fill", "fill", "auth.write"]));
    expect(result.trace.find((t) => t.op === "http.execute")?.status).toBe("success");
    // auth.write 未执行：chrome.cookies.set / scripting 未被调用
    expect(chromeStub.cookies.set).not.toHaveBeenCalled();
    // 请求确实发出
    expect(fetchHistory.length).toBe(1);
    expect(lastFetch().url).toContain("/login");
  });

  it("不触达当前标签页：跳过起步基准采样，applyNavigationIntent 未调用", async () => {
    stubFetch();
    const result = await runSpec(
      spec([
        { op: "goto", url: "{origin}/login" },
        { op: "http.execute", url: "{origin}/ping", as: "resp" },
      ]),
      buildCtx(),
      { trial: {}, settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    // 跳过起步基准：trial 模式不调用 snapshotPasswordField / currentUrl
    expect(mocks.snapshotPasswordField).not.toHaveBeenCalled();
    expect(mocks.currentUrl).not.toHaveBeenCalled();
    // goto 被跳过，导航不执行
    expect(mocks.applyNavigationIntent).not.toHaveBeenCalled();
  });
});

describe("试登录 — 勾选写入会话", () => {
  it("writeSession 为 true 时才执行 auth.write", async () => {
    stubFetch();
    const result = await runSpec(
      spec(
        [
          { op: "http.execute", url: "{origin}/login", method: "POST", as: "resp" },
          { op: "auth.write" },
        ],
        [{ response: { from: "resp", path: "ok", equals: true } }],
        {
          auth: { mode: "engine", cookiesWrite: [{ name: "sid", value: "xyz" }] },
        },
      ),
      buildCtx(),
      { trial: { writeSession: true }, settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    expect(chromeStub.cookies.set).toHaveBeenCalled();
    expect(result.trace.find((t) => t.op === "auth.write")?.status).toBe("success");
  });
});

describe("试登录 — 成功信号区分", () => {
  it("请求成功但成功信号未满足：success=false + SUCCESS_CONDITION_UNMET + signals", async () => {
    stubFetch(() => jsonResponse({ ok: false }));
    const result = await runSpec(
      spec([{ op: "http.execute", url: "{origin}/bad", as: "resp" }]),
      buildCtx(),
      { trial: {}, settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe(ErrorCodes.SUCCESS_CONDITION_UNMET);
      expect(result.error).toContain("$resp.ok");
      expect(result.trialSignals).toBeDefined();
      expect(result.trialSignals?.[0]?.met).toBe(false);
    }
  });

  it("runTrialLogin：请求成功 + 数据信号满足 → ok，requestSent，signalUnmet=false", async () => {
    stubFetch(() => jsonResponse({ ok: true, token: "t" }));
    const res = await runTrialLogin(
      spec([{ op: "http.execute", url: "{origin}/login", as: "resp" }]),
      buildCtx(),
    );
    expect(res.ok).toBe(true);
    expect(res.requestSent).toBe(true);
    expect(res.signalUnmet).toBe(false);
    expect(res.sessionWritten).toBe(false);
    expect(res.signals[0]?.met).toBe(true);
  });

  it("runTrialLogin：请求成功但信号未满足 → ok=false, signalUnmet=true", async () => {
    stubFetch(() => jsonResponse({ ok: false }));
    const res = await runTrialLogin(
      spec([{ op: "http.execute", url: "{origin}/login", as: "resp" }]),
      buildCtx(),
    );
    expect(res.ok).toBe(false);
    expect(res.signalUnmet).toBe(true);
    expect(res.requestSent).toBe(true);
    expect(res.errorCode).toBe(ErrorCodes.SUCCESS_CONDITION_UNMET);
  });

  it("runTrialLogin：请求失败（非 2xx）→ ok=false, signalUnmet=false, 带错误码", async () => {
    stubFetch(() => jsonResponse({}, 500));
    const res = await runTrialLogin(
      spec([{ op: "http.execute", url: "{origin}/fail", as: "resp" }]),
      buildCtx(),
    );
    expect(res.ok).toBe(false);
    expect(res.signalUnmet).toBe(false);
    expect(res.requestSent).toBe(true);
    expect(res.errorCode).toBe(ErrorCodes.LOGIN_FAILED);
  });

  it("纯页面信号的 spec：请求成功后视为试登录通过（NONE）", async () => {
    stubFetch(() => jsonResponse({ ok: true }));
    const res = await runTrialLogin(
      spec(
        [{ op: "http.execute", url: "{origin}/login", as: "resp" }],
        [{ page: { type: "formGone" } }],
      ),
      buildCtx(),
    );
    // 页面信号被剥掉、不算失败；请求成功即通过
    expect(res.ok).toBe(true);
    expect(res.signals.length).toBe(0);
    expect(res.requestSent).toBe(true);
  });

  it("页面类算子不在试登录中执行（任一页面算子都记 skipped）", async () => {
    stubFetch(() => jsonResponse({ ok: true }));
    const res = await runTrialLogin(
      spec([
        { op: "goto", url: "{origin}/login" },
        { op: "waitFor", when: { type: "urlChanged" } },
        { op: "click", target: "#submit" },
        { op: "clear.storage", area: "local", range: "all" },
        { op: "auth.capture", cookies: "all", as: "snap" },
        { op: "http.execute", url: "{origin}/login", as: "resp" },
      ]),
      buildCtx(),
    );
    expect(res.ok).toBe(true);
    const executed = res.bindings; // 请求平面算子产出绑定
    expect(executed).toHaveProperty("resp");
    // 无关算子不执行：goto/waitFor/click/clear.storage/auth.capture 没有副作用
    expect(mocks.applyNavigationIntent).not.toHaveBeenCalled();
    expect(chromeStub.scripting.executeScript).not.toHaveBeenCalled();
    expect(chromeStub.cookies.getAll).not.toHaveBeenCalled();
  });
});

describe("试登录 — 算子白名单", () => {
  it("默认允许 http.execute 与数据变换，不放行 auth.write / extract", () => {
    const allowed = trialAllowedOps(false);
    expect(allowed.has("http.execute")).toBe(true);
    expect(allowed.has("digest")).toBe(true);
    expect(allowed.has("crypto.encrypt")).toBe(true);
    expect(allowed.has("payload.build")).toBe(true);
    expect(allowed.has("map")).toBe(true);
    expect(allowed.has("apply.set")).toBe(true);
    expect(allowed.has("auth.write")).toBe(false);
    expect(allowed.has("extract")).toBe(false);
    expect(allowed.has("goto")).toBe(false);
    expect(allowed.has("fill")).toBe(false);
  });

  it("声明了 default 的 extract 可执行：试登录回退字面量，不触达页面（custom-login 读改链）", async () => {
    // custom-login 策略第 1 步 extract→pageLanguage(default)、第 2 步 map 引用 $pageLanguage。
    // 过去 extract 被拒 (skipped) 会让第 2 步 map 报「未解析的绑定引用」；这里验证
    // 声明 default 的 extract 在 trial 里直接回退 default，map 能继续解析、请求正常发出。
    stubFetch(() => jsonResponse({ ok: true, token: "t" }));
    const res = await runTrialLogin(
      spec([
        { op: "extract", source: "local", key: "language", parse: "jsonValue", default: "zh", as: "pageLanguage" },
        {
          op: "map",
          input: "$pageLanguage",
          cases: [{ equals: "en", value: "en-US,en" }],
          default: "zh-CN,zh",
          as: "acceptLanguage",
        },
        {
          op: "http.execute",
          url: "{origin}/login",
          method: "POST",
          headers: { "Accept-Language": "$acceptLanguage" },
          as: "resp",
        },
      ]),
      buildCtx(),
    );
    expect(res.ok).toBe(true);
    expect(chromeStub.scripting.executeScript).not.toHaveBeenCalled();
    // map 正常解析 $pageLanguage → default 分支 → zh-CN,zh
    expect(lastFetch().init.headers).toMatchObject({ "Accept-Language": "zh-CN,zh" });
  });

  it("未声明 default 的 extract 仍被拒（不放行，保持零副作用）", async () => {
    stubFetch(() => jsonResponse({ ok: true }));
    const res = await runTrialLogin(
      spec([
        { op: "extract", source: "local", key: "language", as: "lang" },
      ]),
      buildCtx(),
    );
    // extract 被拒 → skipped；不触达页面
    expect(chromeStub.scripting.executeScript).not.toHaveBeenCalled();
    expect(res.bindings).not.toHaveProperty("lang");
  });

  it("writeSession 为 true 时放行 auth.write", () => {
    const allowed = trialAllowedOps(true);
    expect(allowed.has("auth.write")).toBe(true);
  });

  it("请求需要的 digest 仍执行（签名构造）", async () => {
    stubFetch(() => jsonResponse({ ok: true }));
    const res = await runTrialLogin(
      spec([
        { op: "digest", algorithm: "sha256", input: "{username}",
          as: "sign" },
        {
          op: "http.execute",
          url: "{origin}/login",
          method: "POST",
          headers: { "X-Sign": "$sign" },
          as: "resp",
        },
      ]),
      buildCtx(),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((lastFetch().init.headers as Record<string, string>)["X-Sign"]).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// S3（消息）试登录：后台 handler 默认零副作用，未调用 tabs.*
// ---------------------------------------------------------------------------
describe("试登录 — 后台 handler（S3）", () => {
  it("发出请求但不触碰任何标签页 API（默认不写会话）", async () => {
    stubFetch(() => jsonResponse({ ok: true }));
    const { handleTrialLogin } =
      await import("../entrypoints/tools/account-switch/background-handler");

    const res = await handleTrialLogin({
      spec: spec([{ op: "http.execute", url: "{origin}/login", method: "POST", as: "resp" }]),
      origin: "https://example.com",
      username: "alice",
      password: "p@ss",
    });

    expect(res.ok).toBe(true);
    expect(res.requestSent).toBe(true);
    expect(res.sessionWritten).toBe(false);
    expect(fetchHistory.length).toBe(1);
    // 不触达标签页：handler 不调用 tabs.query / tabs.create / tabs.get / tabs.update
    expect(chromeStub.tabs.get).not.toHaveBeenCalled();
    // sessionStub 未覆盖 tabs.query/create/update → 断言没有调用也成立
  });
});