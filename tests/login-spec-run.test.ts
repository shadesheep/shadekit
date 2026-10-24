/**
 * spec/run — `runSpec` 执行器（ADR-0015 D12）
 *
 * 以 `runSpec` 为 seam 断言外部可观察行为：发出的 tab 变更、原生 DOM 动作、
 * 绑定表、逐算子轨迹与错误码。settle 判定本身由 `tests/generic-settle.test.ts`
 * 覆盖，这里 mock 掉轮询，只验证编排与信号判定。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  waitForTabLoaded: vi.fn(async () => {}),
  applyNavigationIntent: vi.fn(async () => {}),
  waitForSettle: vi.fn(async (_opts: unknown) => ({ states: [] })),
  snapshotPasswordField: vi.fn(async () => true),
  currentUrl: vi.fn(async () => "https://example.com/login"),
  evaluateCondition: vi.fn(async (_ctx: unknown, _cond: unknown) => false),
  detectCaptcha: vi.fn(async () => false),
}));

vi.mock("../entrypoints/tools/account-switch/utils/tab-load", () => ({
  waitForTabLoaded: mocks.waitForTabLoaded,
}));

vi.mock("../entrypoints/tools/account-switch/login-tab-flow", () => ({
  applyNavigationIntent: mocks.applyNavigationIntent,
}));

vi.mock(
  "../entrypoints/tools/account-switch/strategies/generic-settle",
  async () => {
    const actual = await vi.importActual<
      typeof import("../entrypoints/tools/account-switch/strategies/generic-settle")
    >("../entrypoints/tools/account-switch/strategies/generic-settle");
    return {
      ...actual,
      waitForSettle: mocks.waitForSettle,
      snapshotPasswordField: mocks.snapshotPasswordField,
      currentUrl: mocks.currentUrl,
      evaluateCondition: mocks.evaluateCondition,
      detectCaptcha: mocks.detectCaptcha,
    };
  },
);

const executeScript = vi.fn();
const tabsGet = vi.fn(async () => ({ url: "https://example.com/home" }));
const cookiesGetAll = vi.fn(
  async () =>
    [] as Array<{ name: string; value: string; domain: string; path: string }>,
);

vi.stubGlobal("chrome", {
  tabs: { get: tabsGet },
  scripting: { executeScript },
  cookies: { getAll: cookiesGetAll },
});

import { runSpec } from "../entrypoints/tools/account-switch/spec/run";
import type {
  LoginSpec,
  SpecOp,
} from "../entrypoints/tools/account-switch/spec/types";
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

function spec(ops: SpecOp[], overrides: Partial<LoginSpec> = {}): LoginSpec {
  return {
    version: 2,
    ops,
    success: [{ page: { type: "formGone" } }],
    auth: { mode: "page" },
    ...overrides,
  };
}

const FORM_OPS: SpecOp[] = [
  { op: "goto", url: "{origin}/login" },
  { op: "fill", target: "#u", value: "{username}", clearFirst: true },
  { op: "fill", target: "#p", value: "{password}", clearFirst: true },
  { op: "click", target: "#go" },
];

/** 原生 DOM 动作的 playbook：按顺序返回预设结果 */
function domPlaybook(results: Array<Record<string, unknown>>) {
  const actions: string[] = [];
  executeScript.mockImplementation(
    async (injection: { args: Array<{ action: string }> }) => {
      const action = injection.args[0].action;
      actions.push(action);
      const next = results.shift() ?? { status: "ok", count: 1 };
      return [{ frameId: 0, result: next }];
    },
  );
  return actions;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.snapshotPasswordField.mockResolvedValue(true);
  mocks.currentUrl.mockResolvedValue("https://example.com/login");
  // 页面条件默认已满足：编排类用例不必等满 settleMs
  mocks.evaluateCondition.mockResolvedValue(true);
  mocks.detectCaptcha.mockResolvedValue(false);
  mocks.waitForSettle.mockResolvedValue({ states: [] });
  tabsGet.mockResolvedValue({ url: "https://example.com/home" });
  cookiesGetAll.mockResolvedValue([]);
  executeScript.mockResolvedValue([
    { frameId: 0, result: { status: "ok", count: 1 } },
  ]);
});

describe("runSpec — 算子编排与轨迹", () => {
  it("按 ops[] 顺序执行，轨迹逐算子记录 op / 下标 / 目标 / 状态", async () => {
    const actions = domPlaybook([]);
    const result = await runSpec(spec(FORM_OPS), buildCtx(), {
      settle: { pollingIntervalMs: 1 },
    });

    expect(result.success).toBe(true);
    expect(mocks.applyNavigationIntent).toHaveBeenCalledWith(5, {
      action: "navigate",
      url: "https://example.com/login",
    });
    expect(mocks.waitForTabLoaded).toHaveBeenCalledWith(5, 10000);
    expect(actions).toEqual(["fill", "fill", "click"]);
    expect(
      result.trace.map((t) => [t.index, t.op, t.status, t.target]),
    ).toEqual([
      [0, "goto", "success", "{origin}/login"],
      [1, "fill", "success", "#u"],
      [2, "fill", "success", "#p"],
      [3, "click", "success", "#go"],
    ]);
    expect(result.trace.every((t) => typeof t.duration === "number")).toBe(true);
  });

  it("填充值经过模板解析：原生动作收到真实账号密码", async () => {
    domPlaybook([]);
    await runSpec(spec(FORM_OPS), buildCtx(), {
      settle: { pollingIntervalMs: 1 },
    });
    const payloads = executeScript.mock.calls.map(
      (call) => (call[0] as { args: Array<Record<string, unknown>> }).args[0],
    );
    expect(payloads[0]).toMatchObject({ value: "alice", clearFirst: true });
    // 密码只出现在注入参数里，不进轨迹
    expect(payloads[1]).toMatchObject({ value: "p@ss" });
  });

  it("中途失败立即停止，轨迹标记 error 且错误信息带「第几步」与错误码", async () => {
    const actions = domPlaybook([
      { status: "ok", count: 1 },
      { status: "notFound", count: 0 },
    ]);
    const result = await runSpec(spec(FORM_OPS), buildCtx(), {
      settle: { pollingIntervalMs: 1 },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorCode).toBe(ErrorCodes.ELEMENT_NOT_FOUND);
    expect(result.error).toContain("第 3 步");
    // 第四步没有执行
    expect(actions).toHaveLength(2);
    expect(result.trace).toHaveLength(3);
    expect(result.trace[2]).toMatchObject({
      index: 2,
      op: "fill",
      status: "error",
      errorCode: ErrorCodes.ELEMENT_NOT_FOUND,
      target: "#p",
    });
  });

  it("单次 DOM 交互超时（limits.stepMs）→ STEP_TIMEOUT", async () => {
    // executeScript 永不 resolve → withStepTimeout 竞速触发 STEP_TIMEOUT
    executeScript.mockImplementation(
      () => new Promise<unknown>(() => {}),
    );
    const result = await runSpec(
      spec(
        [{ op: "fill", target: "#u", value: "a" }],
        { limits: { stepMs: 30 } },
      ),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe(ErrorCodes.STEP_TIMEOUT);
    }
  });

  it("点击可声明「未找到则跳过」，流程继续且轨迹记 skipped", async () => {
    domPlaybook([
      { status: "notFound", count: 0 },
      { status: "ok", count: 1 },
    ]);
    const result = await runSpec(
      spec([
        { op: "click", target: "#dismiss", onNotFound: "skip" },
        { op: "fill", target: "#u", value: "a" },
      ]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.trace.map((t) => t.status)).toEqual(["skipped", "success"]);
    expect(result.success).toBe(true);
  });

  it("定位歧义 / 非法选择器映射到专属错误码", async () => {
    domPlaybook([{ status: "ambiguous", count: 2, message: "命中 2 个" }]);
    const ambiguous = await runSpec(
      spec([{ op: "fill", target: "input", value: "x" }]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(ambiguous.success).toBe(false);
    if (!ambiguous.success) {
      expect(ambiguous.errorCode).toBe(ErrorCodes.AMBIGUOUS_TARGET);
    }

    domPlaybook([{ status: "invalid", count: 0, message: "bad" }]);
    const invalid = await runSpec(
      spec([{ op: "fill", target: "[[[", value: "x" }]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.errorCode).toBe(ErrorCodes.SELECTOR_INVALID);
    }
  });

  it("定位记录的 frame 已不在页面 → FRAME_NOT_FOUND（不回退全 frame 搜索）", async () => {
    executeScript.mockResolvedValue([
      { frameId: 0, result: { status: "ok", count: 1, frameUrl: "https://example.com/" } },
    ]);
    const result = await runSpec(
      spec([
        {
          op: "fill",
          target: "#u",
          value: "a",
          frameUrl: "https://login.example.com/form",
        },
      ]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe(ErrorCodes.FRAME_NOT_FOUND);
      expect(result.error).toContain("login.example.com/form");
    }
  });

  it("跨 frame 命中唯一点击照常成功（allFrames 结果可取）", async () => {
    executeScript.mockResolvedValue([
      { frameId: 0, result: { status: "notFound", count: 0 } },
      { frameId: 4, result: { status: "ok", count: 1 } },
    ]);
    const result = await runSpec(
      spec([{ op: "click", target: { label: "登录" } }]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
  });

  it("goto 失败报导航错误，不再继续执行后续算子", async () => {
    mocks.applyNavigationIntent.mockRejectedValueOnce(new Error("No tab with id: 5"));
    domPlaybook([]);
    const result = await runSpec(spec(FORM_OPS), buildCtx(), {
      settle: { pollingIntervalMs: 1 },
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("导航失败");
    expect(executeScript).not.toHaveBeenCalled();
    expect(result.trace).toHaveLength(1);
  });

  it("goto.when 按 D1 假值集合判定：字符串 \"0\" / \"false\" 视为真", async () => {
    const result = await runSpec(
      spec([
        {
          op: "goto",
          url: "https://a.example.com/login",
          when: "0",
          waitForLoad: false,
        },
        {
          op: "goto",
          url: "https://b.example.com/login",
          when: "false",
          waitForLoad: false,
        },
      ]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    expect(mocks.applyNavigationIntent).toHaveBeenCalledTimes(2);
    expect(result.trace.map((t) => t.status)).toEqual(["success", "success"]);
  });

  it("goto.when 为假时跳过算子，轨迹记 skipped 且 lastGotoUrl 不更新", async () => {
    const result = await runSpec(
      spec([
        { op: "goto", url: "https://a.example.com/login" },
        {
          op: "goto",
          url: "{targetUrl}",
          when: "{debugRedirect}",
          waitForLoad: false,
        },
      ]),
      buildCtx({ targetUrl: "https://b.example.com/home", debugRedirect: "" }),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    expect(mocks.applyNavigationIntent).toHaveBeenCalledTimes(1);
    expect(result.trace[1]).toMatchObject({ op: "goto", status: "skipped" });
    expect(result.lastGotoUrl).toBe("https://a.example.com/login");
  });

  it("goto.when 为真时执行，lastGotoUrl 更新为跳转后的地址", async () => {
    const result = await runSpec(
      spec([
        {
          op: "goto",
          url: "{targetUrl}",
          when: "{targetUrl}",
          waitForLoad: false,
        },
      ]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    expect(result.lastGotoUrl).toBe("https://example.com/dashboard");
  });

  it("算子开始 / 结束事件成对发出", async () => {
    domPlaybook([]);
    const events: Array<{ phase: string; index: number }> = [];
    await runSpec(
      spec([
        { op: "fill", target: "#u", value: "a" },
        { op: "click", target: "#go" },
      ]),
      buildCtx(),
      {
        settle: { pollingIntervalMs: 1 },
        onOp: (event) => {
          events.push({ phase: event.phase, index: event.index });
        },
      },
    );
    expect(events).toEqual([
      { phase: "start", index: 0 },
      { phase: "end", index: 0 },
      { phase: "start", index: 1 },
      { phase: "end", index: 1 },
    ]);
  });

  it("waitFor 走既有结算判定，单条 failure 原样传 failWhen", async () => {
    await runSpec(
      spec(
        [{ op: "waitFor", when: { type: "selector", target: ".welcome" } }],
        { failure: [{ type: "selector", target: ".error" }] },
      ),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(mocks.waitForSettle).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 5,
        settle: { type: "selector", target: ".welcome" },
        failWhen: { type: "selector", target: ".error" },
        timeoutMs: 10000,
      }),
    );
  });

  it("waitFor 遇到多条 failure 时按 OR 合并，不再只取首条", async () => {
    await runSpec(
      spec(
        [{ op: "waitFor", when: { type: "selector", target: ".welcome" } }],
        {
          failure: [
            { type: "selector", target: ".error" },
            { type: "url", glob: "*/locked*" },
          ],
        },
      ),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(mocks.waitForSettle).toHaveBeenCalledWith(
      expect.objectContaining({
        failWhen: {
          type: "any",
          of: [
            { type: "selector", target: ".error" },
            { type: "url", glob: "*/locked*" },
          ],
        },
      }),
    );
  });

  it("success.anyOf 是 OR：一条数据信号成立即成功，不等页面条件", async () => {
    executeScript.mockImplementation(async (injection: { args: unknown[] }) => {
      const [source] = injection.args as [string, string];
      return source === "cookie" ? [] : [{ frameId: 0, result: "sid-1" }];
    });
    cookiesGetAll.mockResolvedValue([{ name: "sid", value: "sid-1", domain: "example.com", path: "/" }]);
    mocks.evaluateCondition.mockResolvedValue(false);

    const result = await runSpec(
      spec([
        { op: "extract", source: "cookie", key: "sid", as: "session" },
      ], {
        success: [
          {
            anyOf: [
              { token: { from: "session", path: "" } },
              { page: { type: "selector", target: ".never" } },
            ],
          },
        ],
      }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );

    expect(result.success).toBe(true);
    expect(result.bindings.session).toBe("sid-1");
    // anyOf 的 OR 短路：token 信号先成立，页面条件不再求值
    expect(mocks.evaluateCondition).not.toHaveBeenCalled();
  });

  it("会话算子执行：clear / auth.write 顺序即声明顺序，轨迹记 success", async () => {
    domPlaybook([]);
    const result = await runSpec(
      spec([
        { op: "clear.cookies", range: "all", includeParent: true },
        { op: "clear.storage", area: "local", range: "all" },
        { op: "auth.write" },
        ...FORM_OPS,
      ]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    expect(result.trace.map((t) => t.status)).toEqual([
      "success",
      "success",
      "success",
      "success",
      "success",
      "success",
      "success",
    ]);
    // 会话算子执行后不产生错误码（非 skipped，也不再是失败）
    expect(result.trace.every((t) => t.errorCode === undefined)).toBe(true);
    // clear 清 cookie 走 chrome.cookies；auth.write 在 page 模式是空操作
    expect(cookiesGetAll).toHaveBeenCalled();
  });

  it("数据变换算子（digest）执行并写入绑定表", async () => {
    domPlaybook([]);
    const result = await runSpec(
      spec([
        {
          op: "digest",
          algorithm: "sha256",
          input: "{password}",
          outputEncoding: "hex",
          as: "sig",
        },
      ]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(typeof result.bindings.sig).toBe("string");
      // SHA-256 hex，64 字符——确认真在绑定表产出了摘要而非跳过
      expect(result.bindings.sig).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(result.trace[0]).toMatchObject({
      op: "digest",
      status: "success",
      target: "sha256",
    });
    expect(executeScript).not.toHaveBeenCalled();
  });
});

describe("runSpec — 页面成功信号", () => {
  it("失败信号优先：命中即 LOGIN_REJECTED，不等页面成功", async () => {
    mocks.evaluateCondition.mockImplementation(
      async (_ctx: unknown, condition: unknown) =>
        (condition as { type: string }).type === "selector",
    );
    const result = await runSpec(
      spec(FORM_OPS, { failure: [{ type: "selector", target: ".error" }] }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe(ErrorCodes.LOGIN_REJECTED);
      expect(result.error).toContain("失败条件");
    }
  });

  it("验证码文案命中 → CAPTCHA_REQUIRED", async () => {
    mocks.detectCaptcha.mockResolvedValue(true);
    const result = await runSpec(spec(FORM_OPS), buildCtx(), {
      settle: { pollingIntervalMs: 1 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe(ErrorCodes.CAPTCHA_REQUIRED);
    }
  });

  it("页面条件满足后才判定成功（formGone 基准取 click 前快照）", async () => {
    domPlaybook([]);
    mocks.evaluateCondition.mockResolvedValue(true);
    const result = await runSpec(spec(FORM_OPS), buildCtx(), {
      settle: { pollingIntervalMs: 1 },
    });
    expect(result.success).toBe(true);
    // click 前刷新基准：初始一次 + click 前一次
    expect(mocks.snapshotPasswordField).toHaveBeenCalledTimes(2);
    expect(mocks.evaluateCondition).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 5, passwordFieldPresent: true }),
      { type: "formGone" },
      expect.anything(),
    );
  });

  it("页面条件超时 → SUCCESS_CONDITION_UNMET，消息列出未满足的条件", async () => {
    mocks.evaluateCondition.mockResolvedValue(false);
    const result = await runSpec(
      spec(FORM_OPS, {
        limits: { settleMs: 20 },
        success: [{ page: { type: "formGone" } }],
      }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe(ErrorCodes.SUCCESS_CONDITION_UNMET);
      expect(result.error).toContain("页面成功条件未满足");
      expect(result.error).toContain("登录表单消失");
    }
  });

  it("纯数据成功信号：算子结束后静态判定，未满足报 SUCCESS_CONDITION_UNMET", async () => {
    executeScript.mockImplementation(
      async (injection: { func?: (code: string, bindings: string) => unknown; args: [string, string] }) => {
        if (!injection.func) return [{ frameId: 0, result: { status: "ok", count: 1 } }];
        const [code, bindings] = injection.args;
        return [{ frameId: 0, result: injection.func(code, bindings) }];
      },
    );

    const result = await runSpec(
      spec(
        [{ op: "script", code: "() => ({ data: { token: '' } })", as: "resp" }],
        { success: [{ token: { from: "resp", path: "data.token" } }] },
      ),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe(ErrorCodes.SUCCESS_CONDITION_UNMET);
      expect(result.error).toContain("$resp.data.token");
    }
    // 没有页面条件：不进入轮询开销
    expect(mocks.evaluateCondition).not.toHaveBeenCalled();
  });

  it("固定等待（legacy timeout）直接 sleep 后成功，不轮询", async () => {
    const result = await runSpec(
      spec(FORM_OPS, { success: [{ page: { type: "fixed", ms: 1 } }] }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    expect(mocks.evaluateCondition).not.toHaveBeenCalled();
  });
});

describe("runSpec — extract / script / 模板", () => {
  it("extract 的 local 不静默回退 session：local 缺失即失败", async () => {
    executeScript.mockImplementation(async (injection: { args: unknown[] }) => {
      const [source] = injection.args as [string, string];
      if (source === "local") return [{ frameId: 0, result: null }];
      if (source === "session") return [{ frameId: 0, result: "session-token" }];
      return [{ frameId: 0, result: null }];
    });

    const result = await runSpec(
      spec([
        { op: "extract", source: "local", key: "token", as: "localToken" },
      ]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );

    // local 键不存在 → 失败（不再回退 session）
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("local/token 为空");
      expect(result.errorCode).toBe(ErrorCodes.LOGIN_REJECTED);
    }
    expect(result.bindings).toEqual({});
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it("extract 声明 default 时，空值回退缺省而非抛错", async () => {
    executeScript.mockResolvedValue([{ frameId: 0, result: null }]);
    const result = await runSpec(
      spec([
        {
          op: "extract",
          source: "local",
          key: "language",
          default: "zh",
          as: "lang",
        },
      ]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    expect(result.bindings.lang).toBe("zh");
  });

  it("extract dom 源走定位器：跨 frame 读取文本，保留歧义 / 找不到错误", async () => {
    executeScript.mockImplementation(
      async (injection: { args: Array<Record<string, unknown>> }) => {
        const action = injection.args[0];
        if (action.action === "read") {
          return [
            { frameId: 0, result: { status: "ok", count: 1, value: "欢迎回来" } },
          ];
        }
        return [{ frameId: 0, result: { status: "ok", count: 1 } }];
      },
    );

    const read = await runSpec(
      spec([{ op: "extract", source: "dom", key: ".welcome", as: "text" }]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(read.success).toBe(true);
    expect(read.bindings.text).toBe("欢迎回来");

    executeScript.mockResolvedValue([
      {
        frameId: 0,
        result: { status: "ambiguous", count: 2, message: "命中 2 个" },
      },
    ]);
    const ambiguous = await runSpec(
      spec([{ op: "extract", source: "dom", key: ".item", as: "text" }]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(ambiguous.success).toBe(false);
    if (!ambiguous.success) {
      expect(ambiguous.errorCode).toBe(ErrorCodes.AMBIGUOUS_TARGET);
    }

    executeScript.mockResolvedValue([
      { frameId: 0, result: { status: "notFound", count: 0 } },
    ]);
    const missing = await runSpec(
      spec([{ op: "extract", source: "dom", key: ".gone", as: "text" }]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(missing.success).toBe(false);
    if (!missing.success) {
      expect(missing.errorCode).toBe(ErrorCodes.ELEMENT_NOT_FOUND);
    }
  });

  it("extract cookie 按 name 取首个匹配值（ADR-0015 D1）", async () => {
    cookiesGetAll.mockResolvedValue([{ name: "sid", value: "cookie-value", domain: "example.com", path: "/" }]);
    const result = await runSpec(
      spec([{ op: "extract", source: "cookie", key: "sid", as: "cookieValue" }]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    expect(result.bindings.cookieValue).toBe("cookie-value");
    expect(cookiesGetAll).toHaveBeenCalledWith({ name: "sid" });
  });

  it("extract 取到值后进入绑定表，parse: jsonValue 解一次 JSON", async () => {
    executeScript.mockImplementation(async (injection: { args: unknown[] }) => {
      const [source, key] = injection.args as [string, string];
      if (source === "local") return [{ frameId: 0, result: '"en"' }];
      if (source === "session" && key === "sid2") {
        return [{ frameId: 0, result: "session-value" }];
      }
      return [{ frameId: 0, result: null }];
    });
    cookiesGetAll.mockResolvedValue([{ name: "sid", value: "cookie-value", domain: "example.com", path: "/" }]);
    mocks.currentUrl.mockResolvedValue(
      "https://example.com/cb?code=abc%20123",
    );

    const result = await runSpec(
      spec(
        [
          {
            op: "extract",
            source: "local",
            key: "lang",
            parse: "jsonValue",
            as: "lang",
          },
          { op: "extract", source: "session", key: "sid2", as: "sessionValue" },
          { op: "extract", source: "cookie", key: "sid", as: "cookieValue" },
          { op: "extract", source: "url", key: "code", as: "query" },
          { op: "extract", source: "url", as: "fullUrl" },
        ],
        { success: [{ page: { type: "formGone" } }] },
      ),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );

    expect(result.success).toBe(true);
    expect(result.bindings).toMatchObject({
      lang: "en",
      sessionValue: "session-value",
      cookieValue: "cookie-value",
      query: "abc 123",
      fullUrl: "https://example.com/cb?code=abc%20123",
    });
  });

  it("script 以函数形态注入，绑定表作为参数，返回值进入绑定", async () => {
    executeScript.mockImplementation(
      async (injection: {
        func?: (code: string, bindings: string) => unknown;
        args: [string, string];
      }) => {
        if (!injection.func) return [{ frameId: 0, result: { status: "ok", count: 1 } }];
        const [code, bindings] = injection.args;
        const value = injection.func(code, bindings);
        return [{ frameId: 0, result: value }];
      },
    );

    const result = await runSpec(
      spec([
        // 前一步产出的绑定必须是下一步脚本的参数（`$name` 只读副本）
        { op: "script", code: "() => ({ seed: 'S' })", as: "first" },
        {
          op: "script",
          code: "(b) => ({ token: b.first.seed + '-x' })",
          as: "out",
        },
      ]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );

    expect(result.success).toBe(true);
    expect(result.bindings.out).toEqual({ token: "S-x" });
  });

  it("script throw → LOGIN_REJECTED，不再识别返回值里的 success 字段", async () => {
    executeScript.mockImplementation(
      async (injection: {
        func?: (code: string, bindings: string) => unknown;
        args: [string, string];
      }) => {
        if (!injection.func) return [{ frameId: 0, result: { status: "ok", count: 1 } }];
        const [code, bindings] = injection.args;
        return [{ frameId: 0, result: injection.func(code, bindings) }];
      },
    );

    const thrown = await runSpec(
      spec([{ op: "script", code: '() => { throw new Error("接口契约变了"); }', as: "out" }]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(thrown.success).toBe(false);
    if (!thrown.success) {
      expect(thrown.errorCode).toBe(ErrorCodes.LOGIN_REJECTED);
      expect(thrown.error).toContain("接口契约变了");
    }

    // 返回 {success:false} 不再视为失败：返回值整体进入绑定
    const returned = await runSpec(
      spec([{ op: "script", code: "() => ({ success: false })", as: "out" }]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(returned.success).toBe(true);
    expect(returned.bindings.out).toEqual({ success: false });
  });

  it("script.code 不做模板解析：花括号原样保留", async () => {
    executeScript.mockImplementation(
      async (injection: {
        func?: (code: string, bindings: string) => unknown;
        args: [string, string];
      }) => {
        if (!injection.func) return [{ frameId: 0, result: { status: "ok", count: 1 } }];
        const [code, bindings] = injection.args;
        return [{ frameId: 0, result: injection.func(code, bindings) }];
      },
    );

    const result = await runSpec(
      spec([{ op: "script", code: "() => ({ user: { name: 'a' } })", as: "out" }]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    expect(result.bindings.out).toEqual({ user: { name: "a" } });
  });

  it("未解析的输入引用 → TEMPLATE_UNRESOLVED（运行期，不静默保留）", async () => {
    domPlaybook([]);
    const result = await runSpec(
      spec([{ op: "fill", target: "#u", value: "{usernam}" }]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe(ErrorCodes.TEMPLATE_UNRESOLVED);
    }
  });

  it("vars 默认值进入输入命名空间；targetUrl / debugRedirect 可用", async () => {
    domPlaybook([]);
    const result = await runSpec(
      spec(
        [
          { op: "fill", target: "#u", value: "{tenant}" },
          { op: "fill", target: "#d", value: "{debugRedirect}" },
        ],
        { vars: [{ name: "tenant", default: "acme" }] },
      ),
      buildCtx({ debugRedirect: "http://localhost:8888" }),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    const payloads = executeScript.mock.calls.map(
      (call) => (call[0] as { args: Array<Record<string, unknown>> }).args[0],
    );
    expect(payloads[0]).toMatchObject({ value: "acme" });
    expect(payloads[1]).toMatchObject({ value: "http://localhost:8888" });
  });
});
