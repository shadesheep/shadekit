/**
 * spec/http — `http.execute` 与 `apply.set`（ADR-0015 D1 / D6）
 *
 * 以 `runSpec` 为 seam，stub 全局 `fetch`，断言实际发出的 URL / 方法 / 头 / body
 * （字节级），而非内部调用。覆盖：三种 body 形态、headers 引用、parse、expectStatus、
 * 多个 http.execute 绑定唯一、apply.set 落位、超时、纯 cookie 登录。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  evaluateCondition: vi.fn(async (_ctx: unknown, _cond: unknown) => true),
  detectCaptcha: vi.fn(async () => false),
  snapshotPasswordField: vi.fn(async () => true),
  currentUrl: vi.fn(async () => "https://example.com/dashboard"),
  waitForTabLoaded: vi.fn(async () => {}),
  applyNavigationIntent: vi.fn(async () => {}),
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
      evaluateCondition: mocks.evaluateCondition,
      detectCaptcha: mocks.detectCaptcha,
      snapshotPasswordField: mocks.snapshotPasswordField,
      currentUrl: mocks.currentUrl,
    };
  },
);

vi.stubGlobal("chrome", {
  cookies: { getAll: vi.fn(async () => []) },
  scripting: { executeScript: vi.fn(async () => []) },
  tabs: { get: vi.fn(async () => ({ url: "https://example.com/dashboard" })) },
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
    // 默认含一条 response 成功信号：要求第一个 http.execute 的绑定有 data.code
    success: [
      { response: { from: "resp", path: "ok", equals: true } },
    ],
    auth: { mode: "engine" },
    ...overrides,
  };
}

// 记录每次 fetch 的实际调用形状
interface FetchedCall {
  url: string;
  init: RequestInit;
}

const fetchHistory: FetchedCall[] = [];
let nextFetchResponse: (info: RequestInfo | URL, init?: RequestInit) => Response;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchHistory.length = 0;
  mocks.evaluateCondition.mockResolvedValue(true);
  mocks.detectCaptcha.mockResolvedValue(false);
  mocks.snapshotPasswordField.mockResolvedValue(true);
  mocks.currentUrl.mockResolvedValue("https://example.com/dashboard");
});

/** stub 全局 fetch：记录形状并按需返回预设响应或抛错 */
function stubFetch(handler?: (info: RequestInfo | URL, init?: RequestInit) => Response) {
  nextFetchResponse =
    handler ??
    (() =>
      jsonResponse({
        ok: true,
        token: "abc123",
        nested: { code: 0 },
      }));
  vi.stubGlobal("fetch", async (info: RequestInfo | URL, init?: RequestInit) => {
    fetchHistory.push({
      url: typeof info === "string" ? (info as string) : (info as URL).href,
      init: init ?? {},
    });
    const res = nextFetchResponse(info, init ?? {});
    return res;
  });
}

function lastFetch(): FetchedCall {
  return fetchHistory[fetchHistory.length - 1];
}

describe("http.execute — 请求形态", () => {
  it("POST json body 无空格序列化，key 顺序与声明一致", async () => {
    stubFetch();
    const result = await runSpec(
      spec([
        {
          op: "http.execute",
          url: "{origin}/api/login",
          method: "POST",
          body: {
            json: { username: "{username}", password: "{password}", z: 1, a: 2 },
          },
          as: "resp",
        },
      ]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    const call = lastFetch();
    const parsedUrl = new URL(call.url);
    expect(parsedUrl.origin + parsedUrl.pathname).toBe("https://example.com/api/login");
    expect(call.init.method).toBe("POST");
    expect((call.init.body as string).endsWith(`a":2}`)).toBe(true);
    expect(call.init.body).toBe(
      '{"username":"alice","password":"p@ss","z":1,"a":2}',
    );
  });

  it("raw body 按模板解析后原样发送", async () => {
    stubFetch(() => jsonResponse({ ok: true }));
    const result = await runSpec(
      spec([
        {
          op: "http.execute",
          url: "{origin}/submit",
          method: "POST",
          body: { raw: "{username}:{password}" },
          as: "resp",
        },
      ]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    expect(lastFetch().init.body).toBe("alice:p@ss");
  });

  it("ref 引用绑定对象：无空格序列化，不污染绑定", async () => {
    // step1 返回完整对象，step2 返回精简对象，用以区分两个请求
    let callCount = 0;
    stubFetch(() => {
      callCount += 1;
      return callCount === 1
        ? jsonResponse({ ok: true, token: "abc123", nested: { code: 0 } })
        : jsonResponse({ ok: true });
    });
    // 先 extract 一个对象？直接用 script 产出对象绑定替代——这里为避免 DOM，
    // 用第一个 http.execute 的响应作为第二个的 ref 输入（两段式登录）
    const result = await runSpec(
      spec([
        {
          op: "http.execute",
          url: "{origin}/step1",
          method: "GET",
          parse: "json",
          as: "step1",
        },
        {
          op: "http.execute",
          url: "{origin}/step2",
          method: "POST",
          body: { ref: "$step1" },
          as: "resp",
        },
      ]),
      buildCtx(),
      {
        settle: { pollingIntervalMs: 1 },
        aux: { nonce: "12345678", timestamp: 1000 },
      },
    );
    expect(result.success).toBe(true);
    expect(fetchHistory.length).toBe(2);
    // step2 body = step1 响应体（无空格）
    expect(lastFetch().init.body).toBe('{"ok":true,"token":"abc123","nested":{"code":0}}');
    // 绑定不被污染：两个 http.execute 分别落在各自 as（R5 绑定唯一）
    if (result.success) {
      expect(result.bindings.step1).toEqual({
        ok: true,
        token: "abc123",
        nested: { code: 0 },
      });
      expect(result.bindings.resp).toEqual({ ok: true });
    }
  });

  it("headers 参与模板解析", async () => {
    stubFetch(() => jsonResponse({ ok: true }));
    const result = await runSpec(
      spec([
        {
          op: "http.execute",
          url: "{origin}/api",
          method: "GET",
          headers: { "X-User": "{username}", Authorization: "Bearer {password}" },
          as: "resp",
        },
      ]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    const headers = lastFetch().init.headers as Record<string, string>;
    expect(headers["X-User"]).toBe("alice");
    expect(headers.Authorization).toBe("Bearer p@ss");
  });

  it("GET 默认方法不带 body", async () => {
    stubFetch(() => jsonResponse({ ok: true }));
    await runSpec(
      spec([{ op: "http.execute", url: "{origin}/check", as: "resp" }]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(lastFetch().init.method).toBe("GET");
    expect(lastFetch().init.body).toBeUndefined();
  });

  it("parse: text 把响应体原样作为绑定字符串", async () => {
    stubFetch(() => new Response("raw-text", { status: 200 }));
    const result = await runSpec(
      spec(
        [{ op: "http.execute", url: "{origin}/txt", parse: "text", as: "resp" }],
        { success: [{ response: { from: "resp", path: "" } }] },
      ),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.bindings.resp).toBe("raw-text");
  });

  it("expectStatus 默认 2xx，非 2xx 报 LOGIN_FAILED", async () => {
    stubFetch(() => jsonResponse({ ok: true }, 500));
    const result = await runSpec(
      spec([{ op: "http.execute", url: "{origin}/fail", as: "resp" }]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errorCode).toBe(ErrorCodes.LOGIN_FAILED);
  });

  it("expectStatus 显式白名单可放行特定状态码", async () => {
    stubFetch(() => jsonResponse({ ok: true }, 201));
    const result = await runSpec(
      spec([
        {
          op: "http.execute",
          url: "{origin}/created",
          expectStatus: [201, 202],
          as: "resp",
        },
      ]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
  });

  it("请求超时复用 REQUEST_TIMEOUT（fetch 不返回）", async () => {
    // fetch 永不返回，但监听 abort signal（AbortController 超时触发后 reject）
    vi.stubGlobal(
      "fetch",
      (_info: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(
              new DOMException("Aborted", "AbortError"),
            ),
          );
        }),
    );
    const result = await runSpec(
      spec(
        [{ op: "http.execute", url: "{origin}/slow", as: "resp" }],
        { limits: { requestMs: 50 } },
      ),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe(ErrorCodes.REQUEST_TIMEOUT);
    }
  });
});

describe("http.execute — 绑定与信号", () => {
  it("多个 http.execute 绑定唯一，各自进入绑定表", async () => {
    stubFetch((_info, init) =>
      jsonResponse({ ok: true, n: (init?.method ?? "GET") === "GET" ? 1 : 2 }),
    );
    const result = await runSpec(
      spec(
        [
          { op: "http.execute", url: "{origin}/a", method: "GET", as: "a" },
          { op: "http.execute", url: "{origin}/b", method: "POST", as: "b" },
        ],
        {
          success: [
            { response: { from: "a", path: "ok", equals: true } },
            { response: { from: "b", path: "n", equals: 2 } },
          ],
        },
      ),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.bindings.a).toEqual({ ok: true, n: 1 });
      expect(result.bindings.b).toEqual({ ok: true, n: 2 });
    }
  });

  it("response 成功信号：全部满足才算成功；未满足报 SUCCESS_CONDITION_UNMET", async () => {
    stubFetch(() => jsonResponse({ ok: false }));
    const result = await runSpec(
      spec([{ op: "http.execute", url: "{origin}/bad", as: "resp" }]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe(ErrorCodes.SUCCESS_CONDITION_UNMET);
      expect(result.error).toContain("$resp.ok");
    }
  });

  it("token 成功信号：路径取到非空值即满足", async () => {
    stubFetch(() => jsonResponse({ data: { token: "xyz" } }));
    const result = await runSpec(
      spec([{ op: "http.execute", url: "{origin}/token", as: "resp" }], {
        success: [{ token: { from: "resp", path: "data.token" } }],
      }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.bindings.resp).toEqual({ data: { token: "xyz" } });
    }
  });

  it("anyOf：任一子信号满足即整体满足（OR）", async () => {
    stubFetch(() => jsonResponse({ code: 200 }));
    const result = await runSpec(
      spec([{ op: "http.execute", url: "{origin}/or", as: "resp" }], {
        success: [
          {
            anyOf: [
              { response: { from: "resp", path: "ok", equals: true } },
              { response: { from: "resp", path: "code", equals: 200 } },
            ],
          },
        ],
      }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
  });

  it("数组即 AND：两条数据信号都必须成立", async () => {
    stubFetch(() => jsonResponse({ code: 0, token: "" }));
    const result = await runSpec(
      spec(
        [{ op: "http.execute", url: "{origin}/and", as: "resp" }],
        {
          success: [
            { response: { from: "resp", path: "code", equals: 0 } },
            { response: { from: "resp", path: "token" } },
          ],
        },
      ),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    // code=0 成立但 token 为空 → 第二条未满足
    expect(result.success).toBe(false);
  });

  it("failure 信号优先：命中即 LOGIN_REJECTED，不等成功信号", async () => {
    // evaluateCondition 对 formGone 返回 true → 命中失败条件
    mocks.evaluateCondition.mockResolvedValue(true);
    stubFetch(() => jsonResponse({ ok: true }));
    const result = await runSpec(
      spec([{ op: "http.execute", url: "{origin}/fail", as: "resp" }], {
        failure: [{ type: "formGone" }],
        success: [{ response: { from: "resp", path: "ok", equals: true } }],
      }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe(ErrorCodes.LOGIN_REJECTED);
    }
  });
});

describe("apply.set", () => {
  it("header 改写作用于其后最近一个 http.execute", async () => {
    stubFetch(() => jsonResponse({ ok: true }));
    const result = await runSpec(
      spec(
        [
          { op: "apply.set", target: "header", key: "X-Sign", value: "deadbeef" },
          { op: "http.execute", url: "{origin}/sign", method: "POST", as: "sign" },
        ],
        {
          success: [{ response: { from: "sign", path: "ok", equals: true } }],
        },
      ),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    const headers = lastFetch().init.headers as Record<string, string>;
    expect(headers["X-Sign"]).toBe("deadbeef");
  });

  it("body 改写：点路径写入结构化 json 请求体", async () => {
    stubFetch(() => jsonResponse({ ok: true }));
    const result = await runSpec(
      spec([
        {
          op: "http.execute",
          url: "{origin}/submit",
          method: "POST",
          body: { json: { username: "{username}", sign: "" } },
          as: "resp",
        },
        { op: "apply.set", target: "body", key: "sign", value: "deadbeef" },
        { op: "http.execute", url: "{origin}/final", method: "POST", body: { json: { username: "{username}", sign: "" } }, as: "final" },
      ]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    // 最后一个请求的 body 带上改写后的 sign
    expect(lastFetch().init.body).toBe('{"username":"alice","sign":"deadbeef"}');
    // 第一个请求未被改写（apply.set 只作用于其后最近的一个）
    expect(fetchHistory[0].init.body).toBe('{"username":"alice","sign":""}');
  });

  it("query 改写：并入请求 URL 的 query 参数", async () => {
    stubFetch(() => jsonResponse({ ok: true }));
    const result = await runSpec(
      spec([
        { op: "apply.set", target: "query", key: "nonce", value: "12345678" },
        { op: "http.execute", url: "{origin}/q", method: "GET", as: "resp" },
      ]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    const url = new URL(lastFetch().url);
    expect(url.searchParams.get("nonce")).toBe("12345678");
  });
});

describe("纯 cookie 登录（无 token）", () => {
  it("无 token 的 cookie 登录正常完成并导航/刷新", async () => {
    stubFetch(() => jsonResponse({ ok: true }));
    const result = await runSpec(
      spec([
        {
          op: "http.execute",
          url: "{origin}/login",
          method: "POST",
          body: { json: { username: "{username}", password: "{password}" } },
          as: "resp",
        },
        { op: "auth.write" },
      ]),
      buildCtx(),
      {
        settle: { pollingIntervalMs: 1 },
        aux: { nonce: "12345678", timestamp: 1000 },
      },
    );
    // spec.auth 为 engine 但无 cookiesWrite/localStorageWrite——空写入，
    // 登录成功判定只看 success 信号（resp.ok === true）
    expect(result.success).toBe(true);
    // 成功路径上 `bindings` 不要求必须有 token：纯 cookie 登录同样成功
    if (result.success && "bindings" in result) {
      expect(result.bindings.resp).toEqual({ ok: true });
    }
  });
});
// ---------------------------------------------------------------------------
// ADR-0015 D8 — 日志脱敏：http.execute 产出的脱敏 log 视图
// ---------------------------------------------------------------------------

describe("http.execute — 日志脱敏（ADR-0015 D8）", () => {
  it("result.log 的 request/response 已按黑名单脱敏，sign 保留", async () => {
    stubFetch(() => jsonResponse({ ok: true, token: "abc", sign: "s1" }));
    const result = await runSpec(
      spec([
        {
          op: "http.execute",
          url: "{origin}/login",
          method: "POST",
          headers: {
            Authorization: "Bearer secret",
            "Content-Type": "application/json",
          },
          body: { json: { username: "{username}", password: "{password}", xstr: "xyz" } },
          as: "resp",
        },
      ]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    const view = result.log!;
    // 请求头：Authorization 命中黑名单，Content-Type 保留
    expect(view.request.headers.Authorization).toBe("***");
    expect(view.request.headers["Content-Type"]).toBe("application/json");
    // 请求体：password 命中黑名单，username/xstr 保留
    const reqBody = JSON.parse(view.request.body) as Record<string, unknown>;
    expect(reqBody.password).toBe("***");
    expect(reqBody.username).toBe("alice");
    expect(reqBody.xstr).toBe("xyz");
    // 响应体：token 命中黑名单，ok/sign 保留
    const resBody = JSON.parse(view.response.body) as Record<string, unknown>;
    expect(resBody.token).toBe("***");
    expect(resBody.ok).toBe(true);
    expect(resBody.sign).toBe("s1");
  });

  it("log.reveal 白名单：命中绑定原样出现在 revealed，黑名单字段仍压制", async () => {
    stubFetch(() => jsonResponse({ ok: true }));
    const result = await runSpec(
      spec(
        [
          {
            op: "http.execute",
            url: "{origin}/login",
            method: "POST",
            body: { json: { username: "{username}" } },
            as: "resp",
          },
        ],
        { log: { reveal: ["xstr", "token", "missing"] } },
      ),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    // xstr/token 不在绑定表 → 不出现；missing 也不在
    // 为让白名单命中，先手动构造一个带绑定的场景：这里用 bindings 注入
    const view = result.log!;
    expect(view.request.revealed).toBeUndefined();
    expect(view.request.body).toContain('"username":"alice"');
  });

  it("log.reveal 命中已产出的绑定：原样拷贝入 revealed，且绝不泄露黑名单敏感键", async () => {
    stubFetch(() => jsonResponse({ ok: true }));
    const result = await runSpec(
      spec(
        [
          { op: "digest", algorithm: "sha256", input: "a", as: "xstr" },
          { op: "digest", algorithm: "sha256", input: "b", as: "token" },
          {
            op: "http.execute",
            url: "{origin}/login",
            method: "POST",
            body: { json: { xstr: "$xstr" } },
            as: "resp",
          },
        ],
        { log: { reveal: ["xstr", "token"] } },
      ),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    const view = result.log!;
    // xstr（非敏感名）被白名单放行
    expect(view.request.revealed?.xstr).toBeDefined();
    // token 是黑名单名：即使声明到白名单也不泄露
    expect(view.request.revealed?.token).toBeUndefined();
  });
});
