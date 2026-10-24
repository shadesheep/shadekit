/**
 * spec/transform — `digest` / `crypto.encrypt` / `payload.build` / `map`
 * （ADR-0015 D1 / D6）
 *
 * 以 `runSpec` 为 seam 断言外部可观察行为：绑定表、发出的请求字节、错误码。
 * 覆盖：
 * - 归一化规则集（trim / upper / lower / numericString / base64 / base64url）
 * - payload.build 字符串模式（join 可为空串）与对象模式（有序、供 body.ref）
 * - 两种模式混用被校验器（R6）拦截
 * - digest 各算法 / 编码 / 大小写组合
 * - crypto.encrypt 两算法输出 base64；无效公钥报 `RSA_ENCRYPT_ERROR`
 * - 「先摘要再当字段拼进 body」与「先签名再放进 header」两条端到端链路
 * - 两段式登录（首个 http.execute 响应作为第二个输入）
 * - map 精确相等 + 默认值；无命中且无默认报错
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
import { validateLoginSpec } from "../entrypoints/tools/account-switch/spec/validate";
import type { LoginSpec, SpecOp } from "../entrypoints/tools/account-switch/spec/types";
import type { AuthContext } from "../entrypoints/tools/account-switch/types";
import { ErrorCodes } from "../entrypoints/tools/account-switch/utils/error-codes";

// 测试密钥在使用时独立生成，不内置任何目标系统的密钥材料。
let testPublicKey: Promise<string> | undefined;

function generateTestPublicKey(): Promise<string> {
  testPublicKey ??= globalThis.crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  ).then(({ publicKey }) =>
    globalThis.crypto.subtle.exportKey("spki", publicKey).then((spki) =>
      bytesToBase64(new Uint8Array(spki)),
    ),
  );
  return testPublicKey;
}

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
    // 纯数据变换用例：成功后绑定 sig / body 等即成功
    success: [{ response: { from: "resp", path: "ok", equals: true } }],
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
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(handler?: (info: RequestInfo | URL, init?: RequestInit) => Response) {
  const responder =
    handler ??
    (() =>
      jsonResponse({
        ok: true,
        token: "tok-123",
        data: { token: "tok-123", code: 0 },
      }));
  vi.stubGlobal("fetch", async (info: RequestInfo | URL, init?: RequestInit) => {
    fetchHistory.push({
      url: typeof info === "string" ? (info as string) : (info as URL).href,
      init: init ?? {},
    });
    return responder(info, init);
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

// ============================================================
// 端到端：先摘要再当字段拼进 body
// ============================================================

describe("crypto — 摘要 → 拼进请求体", () => {
  it("digest 产出 sha256 hex，拼进 http.execute 的 body 字段", async () => {
    stubFetch();
    const result = await runSpec(
      spec([
        {
          op: "digest",
          algorithm: "sha256",
          input: "{username}:{password}",
          outputEncoding: "hex",
          as: "sig",
        },
        {
          op: "payload.build",
          join: "",
          parts: [
            { value: '{username}' },
            { value: '{password}' },
          ],
          as: "str",
        },
        {
          op: "http.execute",
          url: "https://example.com/api/login",
          method: "POST",
          body: { json: { username: "{username}", sig: "$sig" } },
          as: "resp",
        },
      ]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );

    expect(result.success).toBe(true);
    const sent = fetchHistory[0];
    expect(JSON.parse(sent.init.body as string)).toEqual({
      username: "alice",
      sig: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("payload.build 字符串模式 join 为空串时按顺序直接拼接", async () => {
    stubFetch();
    const result = await runSpec(
      spec([
        {
          op: "payload.build",
          join: "",
          parts: [
            { value: "{username}", normalize: ["upper"] },
            { value: "{password}", normalize: ["lower"] },
          ],
          as: "p",
        },
        {
          op: "http.execute",
          url: "https://example.com/api/login",
          method: "POST",
          // 字符串模式的结果不能当作 body.ref（那是对象模式的约束）；用 raw 发送
          body: { raw: "$p" },
          as: "resp",
        },
      ]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    expect(fetchHistory[0].init.body).toBe("ALICEp@ss");
  });
});

// ============================================================
// 端到端：先签名再放进 header
// ============================================================

describe("crypto — 签名 → 放进 header", () => {
  it("digest 签名经 apply.set(header) 落在请求头", async () => {
    stubFetch();
    const result = await runSpec(
      spec([
        {
          op: "digest",
          algorithm: "sha1",
          input: "{username}{password}",
          outputEncoding: "base64url",
          as: "signed",
        },
        { op: "apply.set", target: "header", key: "X-Sign", value: "$signed" },
        {
          op: "http.execute",
          url: "https://example.com/api/login",
          method: "POST",
          body: { json: { u: "{username}" } },
          as: "resp",
        },
        { op: "auth.write" },
      ]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );

    expect(result.success).toBe(true);
    const headers = fetchHistory[0].init.headers as Record<string, string>;
    expect(headers["X-Sign"]).toMatch(/^[A-Za-z0-9_-]+$/); // base64url 字符集
  });

  it("crypto.encrypt rsa-pkcs1v15 加密密码输出 base64，拼进请求体", async () => {
    stubFetch();
    const result = await runSpec(
      spec(
        [
          {
            op: "crypto.encrypt",
            algorithm: "rsa-pkcs1v15",
            publicKey: "{pub}",
            input: "{password}",
            as: "cipher",
          },
          {
            op: "http.execute",
            url: "https://example.com/api/login",
            method: "POST",
            body: {
              json: { username: "{username}", xstr: "$cipher" },
            },
            as: "resp",
          },
        ],
        { vars: [{ name: "pub", default: await generateTestPublicKey() }] },
      ),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );

    expect(result.success).toBe(true);
    const sent = JSON.parse(fetchHistory[0].init.body as string);
    expect(sent.xstr).toMatch(/^[A-Za-z0-9+/=]+$/); // base64
    expect(sent.xstr).not.toContain("p@ss"); // 不是明文
  });

  it("crypto.encrypt 无效公钥报 RSA_ENCRYPT_ERROR", async () => {
    stubFetch();
    const result = await runSpec(
      spec(
        [
          {
            op: "crypto.encrypt",
            algorithm: "rsa-pkcs1v15",
            publicKey: "{pub}",
            input: "{password}",
            as: "cipher",
          },
        ],
        { vars: [{ name: "pub", default: "not-a-valid-key!" }] },
      ),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe(ErrorCodes.RSA_ENCRYPT_ERROR);
    }
  });

  it("crypto.encrypt rsa-oaep 输出 base64 密文（WebCrypto 路径）", async () => {
    // 用 WebCrypto 生成一对 RSA-OAEP 密钥，SPKI 导出公钥做输入，确保两端一致
    stubFetch();
    const subtle = globalThis.crypto.subtle;
    const kp = await subtle.generateKey(
      { name: "RSA-OAEP", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      false,
      ["encrypt", "decrypt"],
    );
    const spki = await subtle.exportKey("spki", kp.publicKey as CryptoKey);
    const publicKey = bytesToBase64(new Uint8Array(spki));

    const result = await runSpec(
      spec(
        [
          {
            op: "crypto.encrypt",
            algorithm: "rsa-oaep",
            publicKey: "{pub}",
            input: "{password}",
            as: "cipher",
          },
          {
            op: "http.execute",
            url: "https://example.com/api/login",
            method: "POST",
            body: { json: { xstr: "$cipher" } },
            as: "resp",
          },
        ],
        { vars: [{ name: "pub", default: publicKey }] },
      ),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    const sent = JSON.parse(fetchHistory[0].init.body as string);
    expect(sent.xstr).toMatch(/^[A-Za-z0-9+/=]+$/);

    // 解密回明文，确认真是 OAEP 密文而非明文
    const decoded = base64ToBytes(sent.xstr);
    const plain = await subtle.decrypt({ name: "RSA-OAEP" }, kp.privateKey, decoded);
    expect(new TextDecoder().decode(plain)).toBe("p@ss");
  });
});

// ============================================================
// payload.build 对象模式
// ============================================================

describe("payload.build — 对象模式", () => {
  it("对象模式产出有序对象，可作 http.execute 的 body.ref", async () => {
    stubFetch();
    const result = await runSpec(
      spec([
        {
          op: "payload.build",
          parts: [
            { key: "username", value: "{username}" },
            { key: "pwd", value: "{password}", normalize: ["upper"] },
          ],
          as: "body",
        },
        {
          op: "http.execute",
          url: "https://example.com/api/login",
          method: "POST",
          body: { ref: "$body" },
          as: "resp",
        },
        { op: "auth.write" },
      ]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    expect(JSON.parse(fetchHistory[0].init.body as string)).toEqual({
      username: "alice",
      pwd: "P@SS",
    });
  });

  it("两种模式混用被校验器拦截（R6）", () => {
    const issues = validateLoginSpec({
      version: 2,
      ops: [
        {
          op: "payload.build",
          parts: [
            { key: "a", value: "1" },
            { value: "2" }, // 混用：一个带 key 一个不带
          ],
          as: "body",
        },
      ],
      success: [{ response: { from: "x", path: "ok" } }],
      auth: { mode: "engine" },
    });
    const r6 = issues.find((i) => i.rule === "R6");
    expect(r6).toBeTruthy();
    expect(r6?.message).toContain("混用");
  });

  it("对象模式声明 join 被校验器拦截（R6）", () => {
    const issues = validateLoginSpec({
      version: 2,
      ops: [
        {
          op: "payload.build",
          parts: [{ key: "a", value: "1" }],
          join: "",
          as: "body",
        },
      ],
      success: [{ response: { from: "x", path: "ok" } }],
      auth: { mode: "engine" },
    });
    expect(issues.some((i) => i.rule === "R6")).toBe(true);
  });
});

// ============================================================
// 归一化规则集
// ============================================================

describe("归一化规则", () => {
  it("trim / upper / lower / numericString 按顺序逐个作用", async () => {
    stubFetch();
    const result = await runSpec(
      spec([
        {
          op: "payload.build",
          parts: [
            { value: "  mixed  ", normalize: ["trim", "upper"] },
            { value: "RMB 1,234.56", normalize: ["numericString"] },
          ],
          join: "|",
          as: "p",
        },
        {
          op: "http.execute",
          url: "https://example.com/api/login",
          method: "POST",
          body: { raw: "$p" },
          as: "resp",
        },
      ]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    expect(fetchHistory[0].init.body).toBe("MIXED|123456");
  });

  it("base64 / base64url 作为 base64 变体互转", async () => {
    stubFetch();
    const result = await runSpec(
      spec([
        {
          op: "payload.build",
          // "hello" 的 base64 = aGVsbG8=；把它转成 base64url
          parts: [{ value: "aGVsbG8=", normalize: ["base64url"] }],
          join: "",
          as: "p",
        },
        {
          op: "http.execute",
          url: "https://example.com/api/login",
          method: "POST",
          body: { raw: "$p" },
          as: "resp",
        },
      ]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    expect(fetchHistory[0].init.body).toBe("aGVsbG8"); // base64url：去 `=`
  });
});

// ============================================================
// digest 细节
// ============================================================

describe("digest", () => {
  it("sha1 以 hex 输出，长度 40", async () => {
    stubFetch();
    const result = await runSpec(
      spec([
        { op: "digest", algorithm: "sha1", input: "{password}", outputEncoding: "hex", as: "d" },
        { op: "http.execute", url: "https://example.com/api/login", method: "POST", body: { json: { d: "$d" } }, as: "resp" },
      ]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    const sent = JSON.parse(fetchHistory[0].init.body as string);
    expect(sent.d).toMatch(/^[0-9a-f]{40}$/);
  });

  it("sha256 base64 输出 + upperCase 转大写", async () => {
    stubFetch();
    const result = await runSpec(
      spec([
        { op: "digest", algorithm: "sha256", input: "{password}", outputEncoding: "base64", upperCase: true, as: "d" },
        { op: "http.execute", url: "https://example.com/api/login", method: "POST", body: { json: { d: "$d" } }, as: "resp" },
      ]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    const sent = JSON.parse(fetchHistory[0].init.body as string);
    expect(sent.d).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(sent.d).toBe(sent.d.toUpperCase());
  });

  it("ascii / latin1 输入编码与 utf8 不同（逐字节 0xFF 截断）", async () => {
    stubFetch();
    // "é" 在 latin1 里 = 单字节 0xE9；utf8 里是 0xC3 0xA9 → 摘要必然不同
    const latinResult = await runSpec(
      spec([
        { op: "digest", algorithm: "sha256", input: "{v}", inputEncoding: "latin1", outputEncoding: "hex", as: "d" },
        { op: "http.execute", url: "https://example.com/api/login", method: "POST", body: { json: { d: "$d" } }, as: "resp" },
      ], { vars: [{ name: "v", default: "é" }] }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(latinResult.success).toBe(true);
    const latinHex = JSON.parse(fetchHistory[0].init.body as string).d;
    expect(latinHex).toMatch(/^[0-9a-f]{64}$/);

    const utfResult = await runSpec(
      spec([
        { op: "digest", algorithm: "sha256", input: "{v}", outputEncoding: "hex", as: "d" },
        { op: "http.execute", url: "https://example.com/api/login", method: "POST", body: { json: { d: "$d" } }, as: "resp" },
      ], { vars: [{ name: "v", default: "é" }] }),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(utfResult.success).toBe(true);
    const utfHex = JSON.parse(fetchHistory[1].init.body as string).d;
    // 同一输入、不同编码 → 摘要不同，证明编码生效
    expect(latinHex).not.toBe(utfHex);
  });
});

// ============================================================
// map
// ============================================================

describe("map", () => {
  it("精确相等命中出对应值", async () => {
    stubFetch();
    const result = await runSpec(
      spec([
        {
          op: "map",
          input: "{username}",
          cases: [{ equals: "alice", value: "en-US" }],
          default: "zh-CN",
          as: "lang",
        },
        {
          op: "http.execute",
          url: "https://example.com/api/login",
          method: "POST",
          headers: { "Accept-Language": "$lang" },
          body: { json: { u: "{username}" } },
          as: "resp",
        },
      ]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    const headers = fetchHistory[0].init.headers as Record<string, string>;
    expect(headers["Accept-Language"]).toBe("en-US");
  });

  it("无命中用默认值", async () => {
    stubFetch();
    const result = await runSpec(
      spec([
        {
          op: "map",
          input: "{username}",
          cases: [{ equals: "bob", value: "en-US" }],
          default: "zh-CN",
          as: "lang",
        },
        {
          op: "http.execute",
          url: "https://example.com/api/login",
          method: "POST",
          headers: { "Accept-Language": "$lang" },
          body: { json: {} },
          as: "resp",
        },
      ]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(true);
    const headers = fetchHistory[0].init.headers as Record<string, string>;
    expect(headers["Accept-Language"]).toBe("zh-CN");
  });

  it("无命中且无默认报 CONFIG_INVALID", async () => {
    stubFetch();
    const result = await runSpec(
      spec([
        {
          op: "map",
          input: "{username}",
          cases: [{ equals: "bob", value: "en-US" }],
          as: "lang",
        },
      ]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe(ErrorCodes.CONFIG_INVALID);
      expect(result.error).toContain("无命中");
    }
  });
});

// ============================================================
// 两段式登录
// ============================================================

describe("两段式登录", () => {
  it("首个 http.execute 的响应作为第二个请求的输入", async () => {
    stubFetch((info, _init) => {
      const finalUrl = typeof info === "string" ? info : (info as URL).href;
      if (finalUrl.includes("/csrf")) {
        return jsonResponse({ csrf: "csrf-abc" });
      }
      return jsonResponse({ ok: true });
    });
    const result = await runSpec(
      spec([
        {
          op: "http.execute",
          url: "https://example.com/api/csrf",
          method: "GET",
          as: "csrfResp",
        },
        {
          op: "payload.build",
          parts: [{ key: "username", value: "{username}" }, { key: "token", value: "$csrfResp.csrf" }],
          as: "body",
        },
        {
          op: "http.execute",
          url: "https://example.com/api/login",
          method: "POST",
          body: { ref: "$body" },
          headers: { "X-CSRF": "$csrfResp.csrf" },
          as: "resp",
        },
        { op: "auth.write" },
      ]),
      buildCtx(),
      { settle: { pollingIntervalMs: 1 } },
    );

    expect(result.success).toBe(true);
    expect(fetchHistory).toHaveLength(2);
    // 第二个请求：header 与 body 都引用首个响应的 csrf
    const second = fetchHistory[1];
    const secondHeaders = second.init.headers as Record<string, string>;
    expect(secondHeaders["X-CSRF"]).toBe("csrf-abc");
    const body = JSON.parse(second.init.body as string);
    expect(body.token).toBe("csrf-abc");
    expect(body.username).toBe("alice");
  });
});

// ============================================================
// 辅助：base64 / bytes
// ============================================================

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}