/**
 * LoginSpec 日志脱敏。
 *
 * 纯函数、零浏览器 API、零运行时副作用，可被调试日志链路与测试共同引用。
 *
 * 黑名单：password / passwd / pwd / token / refresh_token / authorization /
 * cookie / set-cookie / secret / x-*-token。命中即替换为 `***`，**优先级高于**
 * `spec.log.reveal` 白名单。`sign` **刻意不在黑名单**——它是一次性请求签名
 * （绑定 nonce），是排查签名失败的主要线索，旧引擎也一直把它记进日志。
 *
 * 应用于 request.headers / request.body / response.body：可解析为 JSON 的
 * 逐字段处理（含深路径与字符串化 JSON 叶子），否则整串替换。
 */

/** 敏感值替换占位符 */
export const REDACTED = "***";

/**
 * 统一小写的敏感字段名精确集合（黑名单）
 */
const SENSITIVE_DICT: ReadonlySet<string> = new Set([
  "password",
  "passwd",
  "pwd",
  "token",
  "refresh_token",
  "authorization",
  "cookie",
  "set-cookie",
  "secret",
]);

/**
 * 黑名单判定：
 * - 精确命中基础集合（大小写不敏感）
 * - `x-…-token` 通配：`x-` 前缀 + `-token` 后缀
 *
 * `sign` 不在黑名单（ADR-0015 D8）。
 */
export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  if (SENSITIVE_DICT.has(normalized)) return true;
  // x-*-token：x- 开头、-token 结尾，且中间非空
  if (
    normalized.startsWith("x-") &&
    normalized.endsWith("-token") &&
    normalized.length > "-token".length + 2
  ) {
    return true;
  }
  return false;
}

/**
 * 对可写对象逐字段脱敏（就地修改），黑名单 key 的值替换为 `REDACTED`。
 * 供请求头与对象形态的请求 / 响应体复用。
 */
export function redactObjectValues(target: Record<string, unknown>): void {
  for (const key of Object.keys(target)) {
    if (isSensitiveKey(key)) {
      target[key] = REDACTED;
    }
  }
}

/**
 * 请求头脱敏：遍历 header 键值，命中黑名单的键替换整值，非敏感保留。
 * 返回新对象，不改入参。
 */
export function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) =>
      isSensitiveKey(key) ? [key, REDACTED] : [key, value],
    ),
  );
}

/**
 * 尝试把字符串按 JSON 解析并递归脱敏；成功返回脱敏后的 JSON 字符串，
 * 失败返回 null（调用方决定整串替换还是原样返回）。
 */
function redactParsedJson(text: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return JSON.stringify(redactValue(value));
}

/** 递归脱敏一个已解析 JSON 值 */
function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value !== null && typeof value === "object") {
    const target = value as Record<string, unknown>;
    redactObjectValues(target);
    for (const key of Object.keys(target)) {
      const v = target[key];
      if (typeof v === "string") {
        // 值本身是字符串且内部又是一段 JSON：递归处理（如响应体里字符串化的 token）
        const inner = redactParsedJson(v);
        if (inner !== null) target[key] = inner;
      } else {
        // 非字符串子值：递归对象 / 数组
        target[key] = redactValue(v);
      }
    }
    return target;
  }
  return value;
}

/**
 * 请求体 / 响应体脱敏（字符串形态）：
 * - 可解析为 JSON → 递归逐字段处理（含深路径与字符串化 JSON 叶子）
 * - 否则 → 整串替换为 `REDACTED`（无法安全区分数据与非数据）
 * - 空串保持为空
 */
export function redactTextBody(body: string): string {
  if (body === "") return "";
  const redacted = redactParsedJson(body);
  if (redacted !== null) return redacted;
  return REDACTED;
}

/**
 * 便捷包装：把「对象形态」的请求体（已解析 json / ref 引用的对象）脱敏为
 * 展示用字符串。`object === null`（无 body / raw 形态）时交给 `redactTextBody`
 * 处理原始串。
 */
export function redactBodyObject(
  object: Record<string, unknown> | null,
  raw: string,
): string {
  if (object === null) return redactTextBody(raw);
  const clone = JSON.parse(JSON.stringify(object)) as Record<string, unknown>;
  redactObjectValues(clone);
  return JSON.stringify(clone);
}

/**
 * `spec.log.reveal` 白名单收集（ADR-0015 D8）。
 *
 * 只把当前绑定表里命中的值放入返回映射——其余 body / header 字段仍按黑名单
 * 脱敏。**黑名单优先**：白名单里的绑定名若本身是敏感键（如 `token`），
 * 照样被压制，不进入 `revealed`——白名单不能用来泄露黑名单字段。
 *
 * @param revealNames spec.log.reveal（绑定名，不含 `$`）
 * @param bindings    runSpec 执行完的绑定表
 */
export function collectRevealed(
  revealNames: string[] | undefined,
  bindings: Record<string, unknown>,
): Record<string, string> | undefined {
  if (!revealNames || revealNames.length === 0) return undefined;
  const revealed: Record<string, string> = {};
  let any = false;
  for (const name of revealNames) {
    if (isSensitiveKey(name)) continue; // 黑名单优先，禁止泄露敏感绑定名
    if (!Object.hasOwn(bindings, name)) continue;
    const value = bindings[name];
    if (value === undefined) continue;
    revealed[name] =
      typeof value === "string" ? value : JSON.stringify(value);
    any = true;
  }
  return any ? revealed : undefined;
}