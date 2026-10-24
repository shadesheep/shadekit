/**
 * LoginSpec 数据变换算子（ADR-0015 D1 / D6）— `digest` / `crypto.encrypt` /
 * `payload.build` / `map`。
 *
 * - `digest`：sha1 / sha256，输入编码 utf8 / ascii / latin1，输出 hex / base64 /
 *   base64url（可大写），行内实现 base16 / base64 编码（WebCrypto 只给原始字节，
 *   浏览器无 `Buffer` / `atob` 不可靠，行内编码零依赖、可单测）。
 * - `crypto.encrypt`：rsa-pkcs1v15（WebCrypto 不实现，走 `jsencrypt`，输出 base64）
 *   与 rsa-oaep（webcrypto `SHA-256`，输出 base64）；加密失败报 `RSA_ENCRYPT_ERROR`。
 * - `payload.build`：字符串模式（parts 按声明序 + `join`，空串也合法）与对象模式
 *   （part 带 `key`、无 join，产出有序对象）；两种模式混用由校验器（R6）拦截。
 *   每 part 可带归一化规则（该顺序逐个作用）。
 * - `map`：`input` 与 `cases[].equals` 精确相等匹配，命中出对应 `value`；
 *   无命中用 `default`；无命中且无默认报 `CONFIG_INVALID`。
 *
 * 本模块只依赖 `jsencrypt` 与 WebCrypto 的 `crypto.subtle`，纯逻辑可单测。
 * 归一化与 base64 编码是纯函数，`map` 是纯函数。RSA 加密在 Node / 浏览器一致。
 */
import { JSEncrypt } from "jsencrypt";
import { ErrorCodes, LoginError } from "../utils/error-codes";
import {
  resolveTemplate,
  resolveTemplateValue,
  TemplateError,
} from "./template";
import type { NormalizeRule, SpecOp } from "./types";

/** 模板上下文：数据算子字段都参与模板解析 */
export interface TransformContext {
  inputs: Record<string, unknown>;
  bindings: Record<string, unknown>;
}

/** 解析模板字符串；未解析引用按运行期语义归一为 `TEMPLATE_UNRESOLVED`。 */
function resolveString(ctx: TransformContext, template: string): string {
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

/**
 * 解析引用或模板为「值」：整串恰为一个引用时保留对象 / 数字类型
 * （`payload.parts[].value` / `map` 的 case 值），否则按模板字符串解析。
 */
function resolveValue(ctx: TransformContext, template: string): unknown {
  try {
    return resolveTemplateValue(template, ctx);
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

/** 未知值转字符串（`digest.input` / 归一化的输入），对象按无空格 JSON。 */
export function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// ============================================================
// payload.build 归一化（ADR-0015 D1）
// ============================================================

const HEX = "0123456789abcdef";

/** base64 编码（标准，带 `+` `/` `=`）。输入为任意字节数组。 */
function toBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += BASE64_CHARS[b0 >> 2];
    out += BASE64_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)];
    // 剩余字节数决定后两位（不足时用 `=`）
    if (i + 1 < bytes.length) {
      out += BASE64_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)];
      if (i + 2 < bytes.length) {
        out += BASE64_CHARS[b2 & 0x3f];
      } else {
        out += "=";
      }
    } else {
      out += "==";
    }
    i += 3;
  }
  return out;
}

const BASE64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += HEX[b >> 4] + HEX[b & 0x0f];
  return out;
}

/** 解码 base64（标准）为字节数组；含非法字符 / 对齐时按原始字符串失败。 */
function fromBase64(input: string): Uint8Array | null {
  const cleaned = input.replace(/[\r\n]+/g, "").replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]+$/.test(cleaned)) return null;
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of cleaned) {
    const index = BASE64_CHARS.indexOf(ch);
    if (index < 0) return null;
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** base64 → base64url（把 `+` → `-`、`/` → `_`，去尾部 `=`）。 */
function toBase64Url(base64: string): string {
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 归一化规则：每个返回一个字符串（输入先转字符串）。
 * - `numericString`：去非数字字符，保留前导负号（`-` 前的给数字去伪前缀）
 */
export function applyNormalizeRules(
  value: unknown,
  rules: NormalizeRule[] | undefined,
): string {
  let current = stringifyValue(value);
  if (!rules) return current;
  for (const rule of rules) {
    switch (rule) {
      case "trim":
        current = current.trim();
        break;
      case "upper":
        current = current.toUpperCase();
        break;
      case "lower":
        current = current.toLowerCase();
        break;
      case "numericString": {
        // 保留前导负号：若原串以 `-` 开头且首个数字存在，则保留一个负号
        const digits = current.replace(/[^0-9]/g, "");
        current = current.startsWith("-") && digits !== "" ? `-${digits}` : digits;
        break;
      }
      case "base64": {
        // base64url → base64：`-_` → `+/`，补齐到 4 的倍数长度。
        // 已含标准 base64 时保持不变（纯变体互转，不对文本做编码）。
        current = current.replace(/-/g, "+").replace(/_/g, "/");
        const pad = (4 - (current.length % 4)) % 4;
        if (pad > 0) current += "=".repeat(pad);
        break;
      }
      case "base64url": {
        // base64 → base64url：`+/` → `-_`，去尾部 `=`。
        current = current.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
        break;
      }
    }
  }
  return current;
}

function utf8Bytes(str: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(str);
}

// ============================================================
// digest（ADR-0015 D1 —— sha1 / sha256）
// ============================================================

const ALGO_MAP = { sha1: "SHA-1", sha256: "SHA-256" } as const;

/** ASCII / latin1 编码：每字符一字节（>0xFF 字符截断为低 8 位，与 latin1 一致）。 */
function encodeInput(
  str: string,
  encoding: "utf8" | "ascii" | "latin1",
): Uint8Array<ArrayBuffer> {
  switch (encoding) {
    case "utf8":
      return utf8Bytes(str);
    case "ascii":
    case "latin1": {
      const bytes = new Uint8Array(str.length);
      for (let i = 0; i < str.length; i += 1) bytes[i] = str.charCodeAt(i) & 0xff;
      return bytes;
    }
  }
}

function encodeDigestOutput(
  bytes: Uint8Array,
  outputEncoding: "hex" | "base64" | "base64url",
): string {
  switch (outputEncoding) {
    case "hex":
      return toHex(bytes);
    case "base64":
      return toBase64(bytes);
    case "base64url":
      return toBase64Url(toBase64(bytes));
  }
}

/** `digest`：对 `input` 求摘要。input 未解析绑定 → 报错；空输入允许。 */
export async function runDigest(
  ctx: TransformContext,
  op: Extract<SpecOp, { op: "digest" }>,
): Promise<string> {
  // digest.input 是模板字符串（可含 `{name}` / `$binding`）
  const input = resolveString(ctx, op.input);
  const encoding = op.inputEncoding ?? "utf8";
  const bytes = encodeInput(input, encoding);
  const algo = ALGO_MAP[op.algorithm];
  const digest = await crypto.subtle.digest(algo, bytes);
  const raw = new Uint8Array(digest);
  let out = encodeDigestOutput(raw, op.outputEncoding ?? "hex");
  if (op.upperCase) out = out.toUpperCase();
  return out;
}

// ============================================================
// crypto.encrypt（ADR-0015 D1 —— rsa-pkcs1v15 / rsa-oaep）
// ============================================================

/**
 * rsa-pkcs1v15：WebCrypto 不实现 PKCS#1 v1.5 ─ 加密，复用 lib 的 `jsencrypt`。
 * 公钥为 PEM / base64 DER，均可被 setPublicKey 接受。
 */
function encryptPkcs1v15(publicKey: string, input: string): string {
  const encryptor = new JSEncrypt();
  try {
    encryptor.setPublicKey(publicKey);
  } catch {
    throw new LoginError(ErrorCodes.RSA_ENCRYPT_ERROR, "RSA 公钥无效");
  }
  // jsencrypt 对空 / 失败返回 false；也可能返回空串
  let cipher: string | false;
  try {
    cipher = encryptor.encrypt(input);
  } catch {
    throw new LoginError(ErrorCodes.RSA_ENCRYPT_ERROR, "RSA 加密失败");
  }
  if (typeof cipher !== "string" || cipher === "") {
    throw new LoginError(ErrorCodes.RSA_ENCRYPT_ERROR, "RSA 加密失败");
  }
  return cipher; // jsencrypt 输出已是 base64
}

/** 把 PEM 包装的 RSA 公钥剥离为 base64 DER（供 importKey spki 使用）。 */
function pemToBase64Der(pem: string): string {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  return body;
}

/**
 * rsa-oaep：WebCrypto `RSA-OAEP` + `SHA-256`。公钥可为 PEM 或裸 base64 DER。
 * 输出 base64。密钥太短 / 输入超限等原因的加密失败统一报 `RSA_ENCRYPT_ERROR`。
 */
async function encryptOaep(publicKey: string, input: string): Promise<string> {
  const der = publicKey.includes("BEGIN") ? pemToBase64Der(publicKey) : publicKey;
  let key: CryptoKey;
  try {
    const derBytes = fromBase64(der);
    if (!derBytes) throw new Error("not base64");
    key = await crypto.subtle.importKey(
      "spki",
      derBytes.buffer as ArrayBuffer,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    );
  } catch {
    throw new LoginError(ErrorCodes.RSA_ENCRYPT_ERROR, "RSA 公钥无效");
  }
  try {
    const cipher = await crypto.subtle.encrypt(
      { name: "RSA-OAEP" },
      key,
      utf8Bytes(input),
    );
    return toBase64(new Uint8Array(cipher));
  } catch {
    throw new LoginError(
      ErrorCodes.RSA_ENCRYPT_ERROR,
      "RSA 加密失败（明文过长或密钥不符）",
    );
  }
}

/** `crypto.encrypt`：公钥来自模板引用（`{publicKey}` 变量），输出 base64。 */
export async function runCryptoEncrypt(
  ctx: TransformContext,
  op: Extract<SpecOp, { op: "crypto.encrypt" }>,
): Promise<string> {
  const publicKey = resolveString(ctx, op.publicKey);
  const input = resolveString(ctx, op.input);
  if (op.algorithm === "rsa-pkcs1v15") return encryptPkcs1v15(publicKey, input);
  return encryptOaep(publicKey, input);
}

// ============================================================
// payload.build（字符串 / 对象两种模式）
// ============================================================

/**
 * `payload.build`。返回字符串（字符串模式）或有序对象（对象模式）。
 *
 * - 字符串模式：parts 按声明序拼接 `value`（每个先过归一化），用 `join` 相连，
 *   `join` 可为空串（直接拼接）。
 * - 对象模式：part 带 `key`（无 join），产出 `{ [key]: normalizedValue }`；
 *   对象可直接作请求体（`http.body.ref`）或供摘要字段引用。
 * - 两种模式混用由校验器（R6）拦截，运行期只按校验过的形态执行。
 */
export function runPayloadBuild(
  ctx: TransformContext,
  op: Extract<SpecOp, { op: "payload.build" }>,
): string | Record<string, string> {
  const keyed = op.parts.every((part) => part.key !== undefined);
  if (keyed) {
    const out: Record<string, string> = {};
    for (const part of op.parts) {
      const value = resolveValue(ctx, part.value);
      out[part.key!] = applyNormalizeRules(value, part.normalize);
    }
    return out;
  }
  const pieces = op.parts.map((part) =>
    applyNormalizeRules(resolveValue(ctx, part.value), part.normalize),
  );
  return pieces.join(op.join ?? "");
}

// ============================================================
// map（ADR-0015 D1）—— 精确相等匹配 + 默认值
// ============================================================

/**
 * `map`：`input` 与 `cases[].equals` 精确相等（严格 `===`，规格「精确相等匹配」）。
 * 命中返回对应 `value`；无命中用 `default`；无命中且无默认报 `CONFIG_INVALID`。
 */
export function runMap(
  ctx: TransformContext,
  op: Extract<SpecOp, { op: "map" }>,
): unknown {
  const input = resolveValue(ctx, op.input);
  for (const item of op.cases) {
    if (equalsExact(input, item.equals)) return resolveValue(ctx, item.value);
  }
  if (op.default !== undefined) return resolveValue(ctx, op.default);
  throw new LoginError(
    ErrorCodes.CONFIG_INVALID,
    `map 输入 ${JSON.stringify(stringifyValue(input))} 无命中且未声明 default`,
  );
}

/** 精确相等：严格 `===`（规格「精确相等匹配」）。 */
function equalsExact(actual: unknown, expected: string | number | boolean): boolean {
  return actual === expected;
}