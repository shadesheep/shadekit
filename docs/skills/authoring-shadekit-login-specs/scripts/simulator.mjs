import { isDeepStrictEqual } from "node:util";
import {
  runDigest,
  runCryptoEncrypt,
  runPayloadBuild,
  runMap,
  resolveTemplate,
  readBindingPath,
} from "./simulator-runtime.mjs";

const SUPPORTED_OPS = new Set([
  "http.execute",
  "clear.cookies",
  "clear.storage",
  "apply.set",
  "digest",
  "crypto.encrypt",
  "payload.build",
  "map",
  "extract",
  "auth.write",
]);

class SimulationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function emptySession() {
  return { cookies: [], localStorage: {}, sessionStorage: {} };
}

function createInitialSession(fixture) {
  const session = emptySession();
  const initial = fixture.initialSession;
  if (!initial || typeof initial !== "object") return session;
  session.cookies = structuredClone(initial.cookies ?? []);
  for (const area of ["localStorage", "sessionStorage"]) {
    for (const [key, value] of Object.entries(initial[area] ?? {})) {
      Object.defineProperty(session[area], key, { value, writable: true, enumerable: true, configurable: true });
    }
  }
  return session;
}

function clearSession(op, session) {
  if (op.range === "none") return;
  if (op.op === "clear.cookies") {
    session.cookies = op.range === "all" ? [] : session.cookies.filter((cookie) => !op.range.includes(cookie.name));
    return;
  }
  const area = op.area === "local" ? "localStorage" : "sessionStorage";
  if (op.range === "all") {
    session[area] = {};
    return;
  }
  for (const key of op.range) delete session[area][key];
}

function unsupportedResult(reason) {
  return { status: "NOT_SIMULATED", requests: [], session: emptySession(), issues: [reason] };
}

function dataSignalsOnly(signal) {
  if (!signal || typeof signal !== "object") return false;
  if ("anyOf" in signal) return Array.isArray(signal.anyOf) && signal.anyOf.every(dataSignalsOnly);
  return "response" in signal || "token" in signal;
}

function preflight(spec) {
  if (!spec || !Array.isArray(spec.ops) || !Array.isArray(spec.success)) return "LoginSpec 结构无法模拟";
  if ((spec.failure?.length ?? 0) > 0) return "failure 页面轮询不属于数据平面模拟范围";
  if (!spec.success.every(dataSignalsOnly)) return "页面成功信号不属于数据平面模拟范围";
  for (const [index, op] of spec.ops.entries()) {
    if (!op || !SUPPORTED_OPS.has(op.op)) return `第 ${index + 1} 步 ${op?.op ?? "unknown"} 不属于数据平面模拟范围`;
    if (op.op === "extract" && typeof op.default !== "string") return `第 ${index + 1} 步 extract 只有字面量 default 可在离线模拟`;
    if (op.op === "clear.cookies" && op.includeParent === true) return `第 ${index + 1} 步 clear.cookies.includeParent 的真实浏览器域匹配不属于离线模拟范围`;
  }
  return undefined;
}

function buildInputs(spec, supplied) {
  const inputs = {};
  for (const variable of spec.vars ?? []) {
    if (variable && variable.default !== undefined) inputs[variable.name] = variable.default;
  }
  Object.assign(inputs, supplied ?? {});
  if (spec.aux?.nonce === "auto" && inputs.nonce === undefined) inputs.nonce = String(Math.floor(10000000 + Math.random() * 90000000));
  if (spec.aux?.timestamp === "auto" && inputs.timestamp === undefined) inputs.timestamp = String(Date.now());
  return inputs;
}

function resolveJson(value, ctx) {
  if (typeof value === "string") return resolveTemplate(value, ctx);
  if (Array.isArray(value)) return value.map((item) => resolveJson(item, ctx));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveJson(item, ctx)]));
  }
  return value;
}

function setByPath(root, path, value) {
  const segments = path.split(".");
  if (segments.some((segment) => segment === "__proto__" || segment === "prototype" || segment === "constructor")) {
    throw new SimulationError("CONFIG_INVALID", "Unsafe body path");
  }
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    if (!current[segment] || typeof current[segment] !== "object" || Array.isArray(current[segment])) current[segment] = {};
    current = current[segment];
  }
  current[segments.at(-1)] = value;
}

function executeHttp(op, changes, ctx, fixture, responseState, requests) {
  let url = resolveTemplate(op.url, ctx);
  const headers = Object.fromEntries(Object.entries(op.headers ?? {}).map(([key, value]) => [key, resolveTemplate(value, ctx)]));
  let object;
  let raw = "";
  if (op.body && "json" in op.body) object = resolveJson(op.body.json, ctx);
  else if (op.body && "raw" in op.body) raw = resolveTemplate(op.body.raw, ctx);
  else if (op.body && "ref" in op.body) {
    const value = resolveBound(ctx.bindings, op.body.ref);
    if (value && typeof value === "object" && !Array.isArray(value)) object = structuredClone(value);
    else raw = typeof value === "string" ? value : String(value ?? "");
  }
  for (const change of changes) {
    if (change.target === "header") headers[change.key] = change.value;
    if (change.target === "query") {
      const parsed = new URL(url);
      parsed.searchParams.set(change.key, change.value);
      url = parsed.toString();
    }
    if (change.target === "body") {
      if (!object) throw new SimulationError("CONFIG_INVALID", "apply.set(body) requires an object body");
      setByPath(object, change.key, change.value);
    }
  }
  const method = op.method ?? "GET";
  const body = object !== undefined ? JSON.stringify(object) : raw;
  const request = { url, method, headers, ...(method !== "GET" && body !== "" ? { body } : {}) };
  requests.push(request);
  const fixtureResponse = fixture.responses[responseState.index];
  if (!fixtureResponse) throw new SimulationError("FIXTURE_RESPONSE_MISSING", "No injected response");
  responseState.index += 1;
  const status = fixtureResponse.status ?? 200;
  const expected = op.expectStatus ?? "2xx";
  const statusOk = expected === "2xx" ? status >= 200 && status < 300 : Array.isArray(expected) && expected.includes(status);
  if (!statusOk) throw new SimulationError("LOGIN_FAILED", "Unexpected fixture status");
  const text = fixtureResponse.text !== undefined
    ? String(fixtureResponse.text)
    : fixtureResponse.body !== undefined ? JSON.stringify(fixtureResponse.body) : "";
  if ((op.parse ?? "json") === "text" || text.length === 0) return text;
  try { return JSON.parse(text); } catch { return text; }
}

function resolveBound(bindings, path) {
  const clean = path.replace(/^\$/, "");
  const [root, ...segments] = clean.split(".");
  if (!Object.hasOwn(bindings, root)) throw new SimulationError("TEMPLATE_UNRESOLVED", "Missing binding");
  const result = readBindingPath(bindings[root], segments.join("."));
  if (!result.found) throw new SimulationError("TEMPLATE_UNRESOLVED", "Missing binding path");
  return result.value;
}

function truthy(value) {
  return !(value === undefined || value === null || value === false || value === "" || value === 0);
}

function evaluateSignal(signal, bindings) {
  if ("anyOf" in signal) return signal.anyOf.some((child) => evaluateSignal(child, bindings));
  const source = signal.response ?? signal.token;
  if (!source || typeof source.from !== "string" || !Object.hasOwn(bindings, source.from)) return false;
  const { found, value } = readBindingPath(bindings[source.from], source.path);
  if (!found) return false;
  if (signal.response && source.equals !== undefined) return value === source.equals;
  return truthy(value);
}

function expiration(write, bindings) {
  if (!write.expiresFrom) return undefined;
  const { from, path, unit } = write.expiresFrom;
  if (!Object.hasOwn(bindings, from)) throw new SimulationError("LOGIN_REJECTED", "Missing expiry binding");
  const { found, value } = readBindingPath(bindings[from], path);
  if (!found) throw new SimulationError("LOGIN_REJECTED", "Missing expiry path");
  if (unit === "epochMs") return value / 1000;
  if (unit === "epochS") return value;
  if (unit === "relativeSeconds") return Math.floor(Date.now() / 1000) + Number(value);
  const milliseconds = new Date(String(value)).getTime();
  if (Number.isNaN(milliseconds)) throw new SimulationError("LOGIN_REJECTED", "Invalid expiry");
  return milliseconds / 1000;
}

function writeSession(spec, ctx, session, origin) {
  if (spec.auth.mode === "page") return;
  for (const write of spec.auth.cookiesWrite ?? []) {
    const secure = write.secure === undefined || write.secure === "auto" ? new URL(origin).protocol === "https:" : write.secure;
    const cookie = {
      name: write.name,
      value: resolveTemplate(write.value, ctx),
      ...(write.domain !== undefined ? { domain: write.domain } : {}),
      path: write.path ?? "/",
      secure,
      httpOnly: write.httpOnly ?? false,
      sameSite: write.sameSite ?? "unspecified",
    };
    const expirationDate = expiration(write, ctx.bindings);
    if (expirationDate !== undefined) cookie.expirationDate = expirationDate;
    session.cookies.push(cookie);
  }
  for (const [field, area] of [["localStorageWrite", "localStorage"], ["sessionStorageWrite", "sessionStorage"]]) {
    const values = (spec.auth[field] ?? []).map((write) => [write.key, resolveTemplate(write.value, ctx)]);
    for (const [key, value] of values) {
      Object.defineProperty(session[area], key, { value, writable: true, enumerable: true, configurable: true });
    }
  }
}

function executionError(error) {
  if (error instanceof SimulationError) return error;
  if (error && typeof error.code === "string") return new SimulationError(error.code, error.message);
  if (error?.code === "TEMPLATE_SYNTAX") return new SimulationError("CONFIG_INVALID", error.message);
  if (error instanceof TypeError) return new SimulationError("INVALID_URL", error.message);
  return new SimulationError("UNKNOWN", error instanceof Error ? error.message : String(error));
}

function compareExpectation(result, expect, consumed, total) {
  const issues = result.issues;
  if (result.success !== expect.success) issues.push(`实际 success=${String(result.success)}，与预期不符`);
  if (expect.errorCode !== undefined && result.errorCode !== expect.errorCode) issues.push(`实际 errorCode=${result.errorCode ?? "undefined"}，与预期不符`);
  if (expect.requests !== undefined && !isDeepStrictEqual(result.requests, expect.requests)) issues.push("实际请求与夹具预期不一致");
  if (expect.session !== undefined && !isDeepStrictEqual(result.session, expect.session)) issues.push("实际内存会话与夹具预期不一致");
  if (consumed !== total) issues.push("存在未消费的 HTTP 响应夹具");
  result.status = issues.length === 0 ? "PASS" : "FAIL";
  return result;
}

export async function simulateLoginSpec(spec, fixture) {
  const unsupported = preflight(spec);
  if (unsupported) return unsupportedResult(unsupported);
  const result = { status: "FAIL", success: false, requests: [], session: createInitialSession(fixture), issues: [] };
  const bindings = {};
  const inputs = buildInputs(spec, fixture.inputs);
  const ctx = { inputs, bindings };
  const changes = [];
  const responseState = { index: 0 };
  try {
    for (const op of spec.ops) {
      if (op.op === "http.execute") {
        bindings[op.as] = executeHttp(op, changes, ctx, fixture, responseState, result.requests);
        changes.length = 0;
      } else if (op.op === "apply.set") {
        changes.push({ target: op.target, key: op.key, value: resolveTemplate(op.value, ctx) });
      } else if (op.op === "digest") bindings[op.as] = await runDigest(ctx, op);
      else if (op.op === "crypto.encrypt") bindings[op.as] = await runCryptoEncrypt(ctx, op);
      else if (op.op === "payload.build") bindings[op.as] = runPayloadBuild(ctx, op);
      else if (op.op === "map") bindings[op.as] = runMap(ctx, op);
      else if (op.op === "extract") bindings[op.as] = op.default;
      else if (op.op === "clear.cookies" || op.op === "clear.storage") clearSession(op, result.session);
      else if (op.op === "auth.write") writeSession(spec, ctx, result.session, inputs.origin);
    }
    result.success = spec.success.every((signal) => evaluateSignal(signal, bindings));
    if (!result.success) result.errorCode = "SUCCESS_CONDITION_UNMET";
  } catch (error) {
    const normalized = executionError(error);
    result.success = false;
    result.errorCode = normalized.code;
  }
  return compareExpectation(result, fixture.expect ?? {}, responseState.index, fixture.responses?.length ?? 0);
}
