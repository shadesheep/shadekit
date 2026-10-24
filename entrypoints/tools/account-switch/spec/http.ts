/**
 * LoginSpec HTTP 算子（ADR-0015 D1 / D6）— `http.execute` 与 `apply.set`。
 *
 * - `http.execute`：三种 body 形态（结构化 JSON / 原始字符串 / 引用绑定对象），
 *   结构化与引用形态按无空格序列化，key 顺序与声明一致；headers 引用参与模板解析；
 *   `parse: json | text`（默认 json）；`expectStatus` 缺省 "2xx"，不匹配报 `LOGIN_FAILED`。
 *   单次请求超时用 `limits.requestMs`（复用 `fetch-timeout.ts`），超时报 `REQUEST_TIMEOUT`。
 * - `apply.set` 作用于其后最近的一个 `http.execute`（header / body / query），
 *   由 `runSpec` 暂存并在下一个请求落位；其后没有请求由校验器预警，
 *   运行期一旦真的缺请求也报 `CONFIG_INVALID`（绝不留一个悬空改写）。
 *
 * 本模块只依赖浏览器 `fetch` 与纯函数，以 `runSpec` 为 seam 可单测：
 * 测试 stub 全局 `fetch`，断言实际发出的 URL / 方法 / 头 / body，而非内部调用。
 */

import { LoginError, ErrorCodes } from "../utils/error-codes";
import { fetchWithTimeout, RequestTimeoutError } from "../utils/fetch-timeout";
import { resolveTemplate, readBindingPath, TemplateError } from "./template";
import type { HttpBody, SpecOp } from "./types";

// ============================================================
// apply.set（暂存于 runSpec，此处仅定义请求改写类型）
// ============================================================

export interface ApplySetChange {
  target: "header" | "body" | "query";
  key: string;
  /** 已解析为字面量的值 */
  value: string;
}

// ============================================================
// http.execute
// ============================================================

export interface HttpExecuteOp extends Extract<SpecOp, { op: "http.execute" }> {}

/** 模板上下文：`http.execute` 的 url / headers / body 都参与模板解析 */
export interface HttpExecuteContext {
  inputs: Record<string, unknown>;
  bindings: Record<string, unknown>;
}

/** 解析单个字符串值：参与模板解析（url / header 值 / raw body 值）。 */
function resolveString(ctx: HttpExecuteContext, template: string): string {
  try {
    return resolveTemplate(template, ctx);
  } catch (e) {
    if (e instanceof TemplateError) {
      throw new LoginError(
        e.code === "TEMPLATE_UNRESOLVED"
          ? ErrorCodes.TEMPLATE_UNRESOLVED
          : ErrorCodes.CONFIG_INVALID,
        e.message,
      );
    }
    throw e;
  }
}

/** 递归解析结构化 body 的叶子字符串值（支持 `{name}` / `$binding`），保留类型与 key 顺序。 */
function resolveJsonValue(
  ctx: HttpExecuteContext,
  value: unknown,
): unknown {
  // 叶子字符串：作为模板解析（空串保留），非字符串原样透传
  if (typeof value === "string") return resolveString(ctx, value);
  if (Array.isArray(value)) {
    return value.map((item) => resolveJsonValue(ctx, item));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    // 保持 key 声明顺序（对象遍历序）
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolveJsonValue(ctx, item);
    }
    return out;
  }
  return value;
}

/**
 * 解析请求体为「对象 + 是否结构化」。`rebuild` 为 false 时返回字符串形态
 * （raw / 空），无法承载 `apply.set(body)` 改写。
 */
function resolveBodyObject(
  ctx: HttpExecuteContext,
  body: HttpBody | undefined,
): { object: Record<string, unknown> | null; raw: string } {
  if (!body) return { object: null, raw: "" };
  if ("json" in body) {
    const object = resolveJsonValue(ctx, body.json);
    if (object === null || typeof object !== "object" || Array.isArray(object)) {
      throw new LoginError(
        ErrorCodes.CONFIG_INVALID,
        "http.execute body.json 必须是对象",
      );
    }
    return { object: object as Record<string, unknown>, raw: "" };
  }
  if ("raw" in body) return { object: null, raw: resolveString(ctx, body.raw) };
  // ref：引用绑定对象，深拷贝一份以便 apply.set(body) 改写、不污染绑定
  const refValue = resolveBoundValue(ctx, body.ref).value;
  if (refValue !== null && typeof refValue === "object" && !Array.isArray(refValue)) {
    const cloned = JSON.parse(JSON.stringify(refValue)) as Record<string, unknown>;
    return { object: cloned, raw: "" };
  }
  // 引用了非对象（字符串等）：按原值透传
  return { object: null, raw: typeof refValue === "string" ? refValue : String(refValue ?? "") };
}

/** 按点路径向对象写入（中间缺失的路径自动创建为对象）。 */
function setByPath(
  root: Record<string, unknown>,
  segments: string[],
  value: string,
): void {
  let current: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i];
    const next = current[seg];
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      const created: Record<string, unknown> = {};
      current[seg] = created;
      current = created;
    } else {
      current = next as Record<string, unknown>;
    }
  }
  current[segments[segments.length - 1]] = value;
}

/** `body.ref` 引用绑定对象：引用求值后必须是对象 / 可序列化值。 */
function resolveBoundValue(
  ctx: HttpExecuteContext,
  ref: string,
): { value: unknown } {
  const path = ref.replace(/^\$/, "");
  const { found, value } = readBindingPath(ctx.bindings, path);
  if (!found) {
    throw new LoginError(
      ErrorCodes.TEMPLATE_UNRESOLVED,
      `未解析的绑定引用：$${path}`,
    );
  }
  return { value };
}

// ============================================================
// 请求执行
// ============================================================

export interface RunHttpResult {
  /** 绑定到 `$as` 的响应体（`parse: json` 为解析后的对象；`text` 为字符串） */
  body: unknown;
  status: number;
  /** 日志用请求/响应素材（未脱敏的原始形状；脱敏由 run.ts 在拥有 spec 时施加） */
  forLog: {
    request: HttpLogRequest;
    /** 响应原文（bodyValue 的字符串形态，供日志脱敏） */
    response: HttpLogResponse;
  };
}

/**
 * 日志用请求描述（ADR-0015 D8）：由执行器在拥有 spec / 绑定表的上下文里
 * 构造出**已脱敏**的副本（headers / body 按黑名单 + `log.reveal` 处理）。
 */
export interface HttpLogRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * 日志用响应描述（ADR-0015 D8）：body 为**已脱敏**的字符串。
 */
export interface HttpLogResponse {
  status: number;
  body: string;
}

/**
 * 执行一次 `http.execute`。
 *
 * - url / headers 经模板解析；method 缺省 GET；body 按三形态序列化
 * - apply.set 的改写（header / query / body）在此落位
 * - 单次请求超时 `requestMs` → `REQUEST_TIMEOUT`（fetchWithTimeout 抛）
 * - `expectStatus` 缺省 "2xx"；不匹配报 `LOGIN_FAILED`
 */
export async function runHttpExecute(
  ctx: HttpExecuteContext,
  op: HttpExecuteOp,
  changes: ApplySetChange[],
  requestTimeoutMs: number,
): Promise<RunHttpResult> {
  const url = resolveString(ctx, op.url);

  // header / query / body 改写分桶
  const headerChanges = new Map<string, string>();
  const queryChanges = new Map<string, string>();
  const bodyChanges: Array<[string, string]> = [];
  for (const change of changes ?? []) {
    if (change.target === "header") headerChanges.set(change.key, change.value);
    else if (change.target === "query") queryChanges.set(change.key, change.value);
    else bodyChanges.push([change.key, change.value]);
  }

  // query 改写：并入 URL 的 searchParams
  let finalUrl = url;
  if (queryChanges.size > 0) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new LoginError(ErrorCodes.INVALID_URL, `无法解析请求 URL: ${url}`);
    }
    for (const [key, value] of queryChanges) u.searchParams.set(key, value);
    finalUrl = u.toString();
  }

  // headers：先按声明解析，再套 apply.set(header) 改写（改写优先）
  const headers: Record<string, string> = {};
  if (op.headers) {
    for (const [key, value] of Object.entries(op.headers)) {
      headers[key] = resolveString(ctx, value);
    }
  }
  for (const [key, value] of headerChanges) headers[key] = value;

  const method = op.method ?? "GET";
  const params: RequestInit = { method, headers };

  // body：先解析为「对象 + 原始串」两态，apply.set(body) 落到对象上再序列化
  const { object, raw } = resolveBodyObject(ctx, op.body);
  for (const [path, value] of bodyChanges) {
    if (object === null) {
      throw new LoginError(
        ErrorCodes.CONFIG_INVALID,
        "apply.set(body) 要求请求体为 json / ref 形态，不能改写 raw 请求体",
      );
    }
    setByPath(object, path.split("."), value);
  }
  let body: string;
  if (object !== null) body = JSON.stringify(object);
  else body = raw; // 无 body / raw 形态
  // GET / HEAD 不带请求体；其余方法才有 body
  if (method !== "GET" && body !== "") {
    params.body = body;
  }

  // 发起请求；fetchWithTimeout 超时抛 RequestTimeoutError → REQUEST_TIMEOUT
  let response: Response;
  try {
    response = await fetchWithTimeout(finalUrl, params, requestTimeoutMs);
  } catch (e: unknown) {
    if (e instanceof RequestTimeoutError) {
      throw new LoginError(ErrorCodes.REQUEST_TIMEOUT, e.message);
    }
    if (e instanceof LoginError) throw e;
    const code =
      e instanceof TypeError ? ErrorCodes.NETWORK_ERROR : ErrorCodes.UNKNOWN;
    throw new LoginError(
      code,
      `请求失败: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // expectStatus（缺省 2xx）
  const expect = op.expectStatus ?? "2xx";
  const ok =
    expect === "2xx"
      ? response.status >= 200 && response.status < 300
      : expect.includes(response.status);
  if (!ok) {
    throw new LoginError(
      ErrorCodes.LOGIN_FAILED,
      `请求预期状态 ${expectLabel(expect)}，实际 ${response.status}（${finalUrl}）`,
    );
  }

  // 解析响应体：json（默认）| text
  const text = await response.text().catch(() => "");
  let bodyValue: unknown = text;
  if ((op.parse ?? "json") === "json" && text.length > 0) {
    try {
      bodyValue = JSON.parse(text);
    } catch {
      bodyValue = text; // 非 JSON 响应降级为原始文本（键仍为响应体）
    }
  }
  return {
    body: bodyValue,
    status: response.status,
    forLog: {
      request: { url: finalUrl, method, headers, body },
      response: { status: response.status, body: text },
    },
  };
}

/** `expect` 的可读描述（错误信息用） */
function expectLabel(expect: "2xx" | number[]): string {
  return expect === "2xx" ? "2xx" : expect.join(" / ");
}