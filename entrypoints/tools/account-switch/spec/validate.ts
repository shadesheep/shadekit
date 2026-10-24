/**
 * LoginSpec 静态校验器（ADR-0015 D3）。
 *
 * 纯函数，零浏览器 API。保存与导入均调用；任一问题即阻断（调用方按
 * `issues.length > 0` 判定），统一错误码 `CONFIG_INVALID`。
 *
 * 规则：
 * - R1 成功先行：`auth.write` / `auth.capture` 位于成功信号引用的绑定产出之后；
 *   `page` 信号还要求位于最后一个 DOM 交互算子之后
 * - R2 数据流可达：引用 `$x` 的算子必须位于产出 `x` 的算子之后
 * - R3 跨 origin 写入：**跨 origin** 的 `goto`（引用 `{targetUrl}` /
 *   `{debugRedirect}`）不得位于 `auth.write` 之前；`auth.restore` 必须在
 *   `goto` 之后，且快照由更早的 `auth.capture` 产出。
 *   同 origin 的登录页导航不受此约束（否则与 R1、D11 默认模板矛盾）
 * - R4 输入已声明：`{name}` 必须在输入命名空间中
 * - R5 绑定唯一：同一 spec 内 `as` 不得重复
 * - R6 算子前置：`apply.set` 之后有 `http.execute`；`auth.restore.snapshot`
 *   引用 `auth.capture`；`http.execute.body.ref` 引用对象模式 `payload.build`
 * - R7 成功信号至少一条
 */
import { buildInputNamespace } from "./namespace";
import { collectTemplateRefs, TemplateError } from "./template";
import {
  BUILTIN_INPUT_NAMES,
  isBindingProducer,
  isDomInteraction,
  LOGIN_SPEC_VERSION,
  type LoginSpec,
  type SettleCondition,
  SPEC_OP_NAMES,
  type SpecOp,
  type SpecOpName,
  type SuccessSignal,
} from "./types";

export type SpecRule = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7";

export interface SpecIssue {
  /** 统一错误码，保存与导入按此拦截 */
  code: "CONFIG_INVALID";
  /** 违反的规则（结构检查无规则号） */
  rule?: SpecRule;
  /** 算子下标（0 基）；spec 级问题缺省 */
  opIndex?: number;
  /** 可读错误信息 */
  message: string;
}

const OP_NAMES = new Set<string>(SPEC_OP_NAMES);

function issue(
  message: string,
  extra: { rule?: SpecRule; opIndex?: number } = {},
): SpecIssue {
  return { code: "CONFIG_INVALID", message, ...extra };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** 模板字段：收集引用；语法错误即报 CONFIG_INVALID */
function refsOf(
  template: unknown,
  issues: SpecIssue[],
  opIndex: number | undefined,
  field: string,
): { inputs: string[]; bindings: string[] } {
  if (typeof template !== "string") return { inputs: [], bindings: [] };
  try {
    return collectTemplateRefs(template);
  } catch (e) {
    if (e instanceof TemplateError) {
      issues.push(issue(`${field}：${e.message}`, { opIndex }));
      return { inputs: [], bindings: [] };
    }
    throw e;
  }
}

// ============================================================
// 结构检查（逐算子字段）
// ============================================================

const NORMALIZE_RULES = new Set([
  "trim",
  "upper",
  "lower",
  "numericString",
  "base64",
  "base64url",
]);

function validateOpShape(
  raw: unknown,
  index: number,
  issues: SpecIssue[],
): raw is SpecOp {
  if (!isRecord(raw)) {
    issues.push(issue(`第 ${index + 1} 步不是对象`, { opIndex: index }));
    return false;
  }
  const op = raw.op;
  if (typeof op !== "string" || !OP_NAMES.has(op)) {
    issues.push(
      issue(`第 ${index + 1} 步的算子类型未知（${String(op)}）`, {
        opIndex: index,
      }),
    );
    return false;
  }
  const before = issues.length;
  const missing = (field: string) =>
    issues.push(
      issue(`第 ${index + 1} 步（${op}）缺少 ${field}`, { opIndex: index }),
    );

  switch (op as SpecOpName) {
    case "clear.cookies":
      if (!isAuthRange(raw.range)) missing("range");
      break;
    case "clear.storage":
      if (raw.area !== "local" && raw.area !== "session") missing("area");
      if (!isAuthRange(raw.range)) missing("range");
      break;
    case "goto":
      if (!nonEmptyString(raw.url)) missing("url");
      break;
    case "http.execute": {
      if (!nonEmptyString(raw.url)) missing("url");
      if (!nonEmptyString(raw.as)) missing("as");
      if (raw.method !== undefined && !HTTP_METHODS.has(raw.method as string)) {
        issues.push(
          issue(`第 ${index + 1} 步（http.execute）method 无效`, {
            opIndex: index,
          }),
        );
      }
      if (
        raw.parse !== undefined &&
        raw.parse !== "json" &&
        raw.parse !== "text"
      ) {
        issues.push(
          issue(`第 ${index + 1} 步（http.execute）parse 无效`, {
            opIndex: index,
          }),
        );
      }
      if (raw.expectStatus !== undefined && !isExpectStatus(raw.expectStatus)) {
        issues.push(
          issue(`第 ${index + 1} 步（http.execute）expectStatus 无效`, {
            opIndex: index,
          }),
        );
      }
      if (raw.body !== undefined) validateHttpBody(raw.body, index, issues);
      if (raw.headers !== undefined) {
        if (!isRecord(raw.headers)) {
          issues.push(
            issue(`第 ${index + 1} 步（http.execute）headers 必须是对象`, {
              opIndex: index,
            }),
          );
        } else {
          for (const [key, value] of Object.entries(raw.headers)) {
            if (typeof value !== "string") {
              issues.push(
                issue(
                  `第 ${index + 1} 步（http.execute）header「${key}」的值必须是模板字符串`,
                  {
                    opIndex: index,
                  },
                ),
              );
            }
          }
        }
      }
      break;
    }
    case "digest":
      if (raw.algorithm !== "sha1" && raw.algorithm !== "sha256")
        missing("algorithm");
      if (typeof raw.input !== "string") missing("input");
      if (!nonEmptyString(raw.as)) missing("as");
      if (
        raw.inputEncoding !== undefined &&
        !["utf8", "ascii", "latin1"].includes(raw.inputEncoding as string)
      ) {
        issues.push(
          issue(`第 ${index + 1} 步（digest）inputEncoding 无效`, {
            opIndex: index,
          }),
        );
      }
      if (
        raw.outputEncoding !== undefined &&
        !["hex", "base64", "base64url"].includes(raw.outputEncoding as string)
      ) {
        issues.push(
          issue(`第 ${index + 1} 步（digest）outputEncoding 无效`, {
            opIndex: index,
          }),
        );
      }
      break;
    case "crypto.encrypt":
      if (raw.algorithm !== "rsa-pkcs1v15" && raw.algorithm !== "rsa-oaep")
        missing("algorithm");
      if (typeof raw.publicKey !== "string") missing("publicKey");
      if (typeof raw.input !== "string") missing("input");
      if (!nonEmptyString(raw.as)) missing("as");
      break;
    case "payload.build": {
      if (!nonEmptyString(raw.as)) missing("as");
      if (!Array.isArray(raw.parts) || raw.parts.length === 0) {
        missing("parts");
        break;
      }
      for (const [partIndex, part] of raw.parts.entries()) {
        if (!isRecord(part) || typeof part.value !== "string") {
          issues.push(
            issue(
              `第 ${index + 1} 步（payload.build）第 ${partIndex + 1} 个 part 缺少 value`,
              {
                opIndex: index,
              },
            ),
          );
          continue;
        }
        if (part.key !== undefined && !nonEmptyString(part.key)) {
          issues.push(
            issue(
              `第 ${index + 1} 步（payload.build）第 ${partIndex + 1} 个 part 的 key 无效`,
              {
                opIndex: index,
              },
            ),
          );
        }
        if (part.normalize !== undefined) {
          if (!Array.isArray(part.normalize)) {
            issues.push(
              issue(
                `第 ${index + 1} 步（payload.build）第 ${partIndex + 1} 个 part 的 normalize 必须是数组`,
                { opIndex: index },
              ),
            );
          } else {
            for (const rule of part.normalize) {
              if (!NORMALIZE_RULES.has(rule as string)) {
                issues.push(
                  issue(
                    `第 ${index + 1} 步（payload.build）归一化规则无效（${String(rule)}）`,
                    { opIndex: index },
                  ),
                );
              }
            }
          }
        }
      }
      // 两种模式互斥（R6）
      const keyed = raw.parts.filter(
        (p) => isRecord(p) && p.key !== undefined,
      ).length;
      const hasJoin = typeof raw.join === "string";
      if (keyed === raw.parts.length) {
        if (hasJoin) {
          issues.push(
            issue(`第 ${index + 1} 步（payload.build）对象模式不能声明 join`, {
              rule: "R6",
              opIndex: index,
            }),
          );
        }
      } else if (keyed === 0) {
        if (!hasJoin) {
          issues.push(
            issue(
              `第 ${index + 1} 步（payload.build）字符串模式必须声明 join`,
              {
                rule: "R6",
                opIndex: index,
              },
            ),
          );
        }
      } else {
        issues.push(
          issue(
            `第 ${index + 1} 步（payload.build）不能混用带 key 与不带 key 的 part`,
            {
              rule: "R6",
              opIndex: index,
            },
          ),
        );
      }
      break;
    }
    case "map": {
      if (typeof raw.input !== "string") missing("input");
      if (!nonEmptyString(raw.as)) missing("as");
      if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
        missing("cases");
        break;
      }
      for (const [caseIndex, item] of raw.cases.entries()) {
        const validEquals =
          isRecord(item) &&
          (typeof item.equals === "string" ||
            typeof item.equals === "number" ||
            typeof item.equals === "boolean");
        if (
          !validEquals ||
          typeof (item as Record<string, unknown>).value !== "string"
        ) {
          issues.push(
            issue(
              `第 ${index + 1} 步（map）第 ${caseIndex + 1} 个 case 的 equals/value 无效`,
              {
                opIndex: index,
              },
            ),
          );
        }
      }
      if (raw.default !== undefined && typeof raw.default !== "string") {
        issues.push(
          issue(`第 ${index + 1} 步（map）default 必须是模板字符串`, {
            opIndex: index,
          }),
        );
      }
      break;
    }
    case "apply.set":
      if (!["header", "body", "query"].includes(raw.target as string))
        missing("target");
      if (!nonEmptyString(raw.key)) missing("key");
      if (typeof raw.value !== "string") missing("value");
      break;
    case "auth.write":
      break;
    case "auth.capture":
      if (!nonEmptyString(raw.as)) missing("as");
      for (const field of [
        "cookies",
        "localStorage",
        "sessionStorage",
      ] as const) {
        if (raw[field] !== undefined && !isAuthRange(raw[field])) {
          issues.push(
            issue(`第 ${index + 1} 步（auth.capture）${field} 范围无效`, {
              opIndex: index,
            }),
          );
        }
      }
      break;
    case "auth.restore":
      if (!nonEmptyString(raw.snapshot)) missing("snapshot");
      break;
    case "fill":
      if (typeof raw.value !== "string") missing("value");
      if (raw.target === undefined) missing("target");
      break;
    case "click":
      if (raw.target === undefined) missing("target");
      if (
        raw.onNotFound !== undefined &&
        raw.onNotFound !== "fail" &&
        raw.onNotFound !== "skip"
      ) {
        issues.push(
          issue(`第 ${index + 1} 步（click）onNotFound 无效`, {
            opIndex: index,
          }),
        );
      }
      break;
    case "waitFor":
      if (!isSettleConditionShape(raw.when)) missing("when（结算条件）");
      break;
    case "extract":
      if (
        !["local", "session", "dom", "url", "cookie"].includes(
          raw.source as string,
        )
      ) {
        missing("source");
      } else if (raw.source !== "url" && !nonEmptyString(raw.key)) {
        missing("key");
      }
      if (!nonEmptyString(raw.as)) missing("as");
      if (
        raw.parse !== undefined &&
        raw.parse !== "raw" &&
        raw.parse !== "jsonValue"
      ) {
        issues.push(
          issue(`第 ${index + 1} 步（extract）parse 无效`, { opIndex: index }),
        );
      }
      if (
        raw.default !== undefined &&
        typeof raw.default !== "string"
      ) {
        issues.push(
          issue(`第 ${index + 1} 步（extract）default 必须是字符串`, {
            opIndex: index,
          }),
        );
      }
      break;
    case "script":
      if (!nonEmptyString(raw.code)) missing("code");
      if (!nonEmptyString(raw.as)) missing("as");
      if (
        raw.world !== undefined &&
        raw.world !== "MAIN" &&
        raw.world !== "ISOLATED"
      ) {
        issues.push(
          issue(`第 ${index + 1} 步（script）world 无效`, { opIndex: index }),
        );
      }
      break;
  }
  return issues.length === before;
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH"]);

function isAuthRange(value: unknown): boolean {
  if (value === "all" || value === "none") return true;
  return Array.isArray(value) && value.every((v) => nonEmptyString(v));
}

function isExpectStatus(value: unknown): boolean {
  if (value === "2xx") return true;
  return Array.isArray(value) && value.every((v) => Number.isInteger(v));
}

function validateHttpBody(
  body: unknown,
  index: number,
  issues: SpecIssue[],
): void {
  if (!isRecord(body)) {
    issues.push(
      issue(`第 ${index + 1} 步（http.execute）body 必须是对象`, {
        opIndex: index,
      }),
    );
    return;
  }
  const forms = ["json", "raw", "ref"].filter((k) => body[k] !== undefined);
  if (forms.length !== 1) {
    issues.push(
      issue(
        `第 ${index + 1} 步（http.execute）body 必须且只能声明 json / raw / ref 之一`,
        {
          opIndex: index,
        },
      ),
    );
    return;
  }
  if (forms[0] === "json" && !isRecord(body.json)) {
    issues.push(
      issue(`第 ${index + 1} 步（http.execute）body.json 必须是对象`, {
        opIndex: index,
      }),
    );
  }
  if (forms[0] === "raw" && typeof body.raw !== "string") {
    issues.push(
      issue(`第 ${index + 1} 步（http.execute）body.raw 必须是模板字符串`, {
        opIndex: index,
      }),
    );
  }
  if (forms[0] === "ref" && !nonEmptyString(body.ref)) {
    issues.push(
      issue(`第 ${index + 1} 步（http.execute）body.ref 必须是绑定名`, {
        opIndex: index,
      }),
    );
  }
}

function validateAuthShape(auth: unknown, issues: SpecIssue[]): void {
  if (!isRecord(auth)) {
    issues.push(issue("缺少认证声明（auth）"));
    return;
  }
  if (auth.mode !== "engine" && auth.mode !== "page") {
    issues.push(issue("auth.mode 必须是 engine 或 page"));
  }
  for (const field of [
    "cookiesWrite",
    "localStorageWrite",
    "sessionStorageWrite",
  ] as const) {
    const list = auth[field];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      issues.push(issue(`auth.${field} 必须是数组`));
      continue;
    }
    for (const [i, item] of list.entries()) {
      if (!isRecord(item)) {
        issues.push(issue(`auth.${field}[${i}] 必须是对象`));
        continue;
      }
      if (field === "cookiesWrite") {
        if (!nonEmptyString(item.name))
          issues.push(issue(`auth.cookiesWrite[${i}] 缺少 name`));
        if (typeof item.value !== "string")
          issues.push(issue(`auth.cookiesWrite[${i}] 缺少 value`));
        if (
          item.sameSite !== undefined &&
          !["unspecified", "lax", "strict", "no_restriction"].includes(
            item.sameSite as string,
          )
        ) {
          issues.push(issue(`auth.cookiesWrite[${i}] sameSite 无效`));
        }
        if (item.expiresFrom !== undefined) {
          if (
            !isRecord(item.expiresFrom) ||
            !nonEmptyString(item.expiresFrom.from) ||
            typeof item.expiresFrom.path !== "string" ||
            !["epochMs", "epochS", "iso", "relativeSeconds"].includes(
              item.expiresFrom.unit as string,
            )
          ) {
            issues.push(issue(`auth.cookiesWrite[${i}] expiresFrom 无效`));
          }
        }
      } else {
        if (!nonEmptyString(item.key))
          issues.push(issue(`auth.${field}[${i}] 缺少 key`));
        if (typeof item.value !== "string")
          issues.push(issue(`auth.${field}[${i}] 缺少 value`));
      }
    }
  }
}

function validateLimitsShape(limits: unknown, issues: SpecIssue[]): void {
  if (limits === undefined) return;
  if (!isRecord(limits)) {
    issues.push(issue("limits 必须是对象"));
    return;
  }
  for (const key of ["requestMs", "stepMs", "settleMs"] as const) {
    const value = limits[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      issues.push(issue(`limits.${key} 必须是大于 0 的毫秒数`));
    }
  }
}

// ============================================================
// 引用收集（供 R2 / R4 使用）
// ============================================================

interface OpRefs {
  inputs: string[];
  bindings: string[];
}

/** 收集单个算子内的全部模板引用 */
function opRefs(op: SpecOp, index: number, issues: SpecIssue[]): OpRefs {
  const inputs: string[] = [];
  const bindings: string[] = [];
  const add = (template: unknown, field: string) => {
    const refs = refsOf(template, issues, index, field);
    inputs.push(...refs.inputs);
    bindings.push(...refs.bindings);
  };
  const addDeep = (value: unknown, field: string) => {
    if (typeof value === "string") {
      add(value, field);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => {
        addDeep(v, `${field}[${i}]`);
      });
    } else if (isRecord(value)) {
      for (const [k, v] of Object.entries(value)) addDeep(v, `${field}.${k}`);
    }
  };

  switch (op.op) {
    case "goto":
      add(op.url, "url");
      if (op.when !== undefined) add(op.when, "when");
      break;
    case "http.execute":
      add(op.url, "url");
      if (op.headers)
        for (const [k, v] of Object.entries(op.headers)) add(v, `headers.${k}`);
      if (op.body) {
        if ("raw" in op.body) add(op.body.raw, "body.raw");
        else if ("json" in op.body) addDeep(op.body.json, "body.json");
        // body.ref 不是模板，但仍是一条绑定引用（R2 / R6）
        else if (typeof op.body.ref === "string") bindings.push(op.body.ref);
      }
      break;
    case "digest":
      add(op.input, "input");
      break;
    case "crypto.encrypt":
      add(op.publicKey, "publicKey");
      add(op.input, "input");
      break;
    case "payload.build":
      op.parts.forEach((part, i) => {
        add(part.value, `parts[${i}].value`);
      });
      break;
    case "map":
      add(op.input, "input");
      op.cases.forEach((item, i) => {
        add(item.value, `cases[${i}].value`);
      });
      if (op.default !== undefined) add(op.default, "default");
      break;
    case "apply.set":
      add(op.value, "value");
      break;
    case "fill":
      add(op.value, "value");
      break;
    case "script":
      // script.code 豁免全部模板解析（ADR-0015 D1）；script 内的引用无法静态校验
      break;
    default:
      break;
  }

  return {
    inputs: [...new Set(inputs)],
    bindings: [...new Set(bindings)],
  };
}

/** 成功信号内的全部绑定引用（`from`） */
function successRefs(signal: SuccessSignal): OpRefs {
  const bindings: string[] = [];
  const walk = (s: SuccessSignal) => {
    if (!isRecord(s)) return;
    if ("anyOf" in s && Array.isArray(s.anyOf)) {
      s.anyOf.forEach(walk);
      return;
    }
    if ("response" in s && isRecord(s.response)) {
      bindings.push(String(s.response.from));
      return;
    }
    if ("token" in s && isRecord(s.token)) {
      bindings.push(String(s.token.from));
    }
  };
  walk(signal);
  return { inputs: [], bindings: [...new Set(bindings)] };
}

/** 成功信号中是否含 page 条件 */
function hasPageSignal(signal: SuccessSignal): boolean {
  if (!isRecord(signal)) return false;
  if ("page" in signal) return true;
  if ("anyOf" in signal && Array.isArray(signal.anyOf)) {
    return signal.anyOf.some(hasPageSignal);
  }
  return false;
}

/**
 * auth 写入声明里需要校验可达性的绑定名：
 * - `cookiesWrite[].value` 等模板字段的 `$binding` 引用
 * - `cookiesWrite[].expiresFrom.from`（非模板，直接是绑定名；D7）
 */
function authWriteRefs(spec: LoginSpec, issues: SpecIssue[]): OpRefs {
  const inputs: string[] = [];
  const bindings: string[] = [];
  if (!isRecord(spec.auth)) return { inputs, bindings };
  const fields = [
    "cookiesWrite",
    "localStorageWrite",
    "sessionStorageWrite",
  ] as const;
  for (const field of fields) {
    const list = (spec.auth as Record<string, unknown>)[field];
    if (!Array.isArray(list)) continue;
    for (const [i, item] of list.entries()) {
      if (!isRecord(item)) continue;
      const where = `auth.${field}[${i}]`;
      if (typeof item.value === "string") {
        const refs = refsOf(item.value, issues, undefined, `${where}.value`);
        inputs.push(...refs.inputs);
        bindings.push(...refs.bindings);
      }
      if (isRecord(item.expiresFrom) && nonEmptyString(item.expiresFrom.from)) {
        bindings.push(item.expiresFrom.from);
      }
    }
  }
  return { inputs, bindings: [...new Set(bindings)] };
}

function successSignalShape(
  signal: unknown,
  issues: SpecIssue[],
): SuccessSignal | null {
  if (!isRecord(signal)) {
    issues.push(issue("成功信号必须是对象"));
    return null;
  }
  if ("anyOf" in signal) {
    if (!Array.isArray(signal.anyOf)) {
      issues.push(issue("成功信号 anyOf 必须是数组"));
      return null;
    }
    const items = signal.anyOf
      .map((s) => successSignalShape(s, issues))
      .filter((s): s is SuccessSignal => s !== null);
    return { anyOf: items };
  }
  if ("response" in signal) {
    const r = signal.response;
    if (!isRecord(r) || !nonEmptyString(r.from) || typeof r.path !== "string") {
      issues.push(issue("成功信号 response 必须包含 from 与 path"));
      return null;
    }
    return { response: { from: r.from, path: r.path, equals: r.equals } };
  }
  if ("token" in signal) {
    const t = signal.token;
    if (!isRecord(t) || !nonEmptyString(t.from) || typeof t.path !== "string") {
      issues.push(issue("成功信号 token 必须包含 from 与 path"));
      return null;
    }
    return { token: { from: t.from, path: t.path } };
  }
  if ("page" in signal) {
    if (!isSettleConditionShape(signal.page)) {
      issues.push(issue("成功信号 page 必须是结算条件"));
      return null;
    }
    return { page: signal.page as SettleCondition };
  }
  issues.push(issue("成功信号必须是 response / token / page / anyOf 之一"));
  return null;
}

/** 绑定路径首段（`resp.data.token` → `resp`） */
function rootBinding(path: string): string {
  return path.split(".")[0];
}

/** `body.ref` 是否引用一个对象模式的 `payload.build` 产出 */
function isObjectPayloadRef(
  ref: unknown,
  ops: unknown[],
  producerIndex: Map<string, number>,
): boolean {
  if (typeof ref !== "string") return false;
  const producer = producerIndex.get(ref);
  const producerOp = producer === undefined ? undefined : ops[producer];
  return (
    isRecord(producerOp) &&
    producerOp.op === "payload.build" &&
    Array.isArray(producerOp.parts) &&
    producerOp.parts.length > 0 &&
    producerOp.parts.every((p) => isRecord(p) && p.key !== undefined) &&
    producerOp.join === undefined
  );
}

/** 跨 origin 输入：只有这两个内置输入会在声明里表达「跳到另一个 origin」 */
const CROSS_ORIGIN_INPUTS = new Set(["targetUrl", "debugRedirect"]);

/**
 * 该 goto 是否属于「落地到 restore」的一段：它之后、下一个 goto 之前的首个
 * `auth.restore` 存在，且中间没有新的 goto 打断（连续两个落地 goto 时两者都算）。
 */
function leadsToRestore(ops: unknown[], index: number): boolean {
  for (let i = index + 1; i < ops.length; i++) {
    const next = ops[i];
    if (!isRecord(next)) continue;
    if (next.op === "auth.restore") return true;
    // 落地导航与 restore 之间只允许连续的落地 goto；其余算子说明这是登录流程
    if (next.op !== "goto") return false;
  }
  return false;
}

/** goto 是否为显式跨 origin 导航（URL 引用 targetUrl / debugRedirect） */
function isCrossOriginGoto(op: unknown): boolean {
  if (!isRecord(op) || typeof op.url !== "string") return false;
  try {
    const refs = collectTemplateRefs(op.url);
    return refs.inputs.some((name) => CROSS_ORIGIN_INPUTS.has(name));
  } catch {
    return false;
  }
}

// ============================================================
// 入口
// ============================================================

/**
 * 校验 LoginSpec。返回空数组 = 合法；否则每条问题都带 `CONFIG_INVALID`
 * 与（算子级问题）`opIndex`。
 */
export function validateLoginSpec(raw: unknown): SpecIssue[] {
  const issues: SpecIssue[] = [];
  if (!isRecord(raw)) return [issue("登录声明必须是对象")];

  if (raw.version !== LOGIN_SPEC_VERSION) {
    issues.push(
      issue(
        `登录声明版本必须是 ${LOGIN_SPEC_VERSION}（收到 ${String(raw.version)}）`,
      ),
    );
    return issues;
  }

  // —— 顶层结构 ——
  if (!Array.isArray(raw.ops) || raw.ops.length === 0) {
    issues.push(issue("登录声明至少需要一个算子"));
  }
  if (!Array.isArray(raw.success)) {
    issues.push(issue("成功信号（success）必须是数组"));
  } else if (raw.success.length === 0) {
    issues.push(issue("至少需要一条成功信号", { rule: "R7" }));
  }
  validateAuthShape(raw.auth, issues);
  validateLimitsShape(raw.limits, issues);

  const namespace = buildInputNamespace({
    vars: Array.isArray(raw.vars) ? (raw.vars as LoginSpec["vars"]) : undefined,
    aux: isRecord(raw.aux) ? (raw.aux as LoginSpec["aux"]) : undefined,
  });
  for (const message of namespace.errors) issues.push(issue(message));

  const ops: unknown[] = Array.isArray(raw.ops) ? raw.ops : [];
  const shapeOk: boolean[] = ops.map((op, index) =>
    validateOpShape(op, index, issues),
  );

  // —— 成功信号形状 ——
  const successSignals: SuccessSignal[] = [];
  if (Array.isArray(raw.success)) {
    for (const signal of raw.success) {
      const shaped = successSignalShape(signal, issues);
      if (shaped) successSignals.push(shaped);
    }
  }

  const spec = raw as unknown as LoginSpec;
  // auth 缺失时 validateAuthShape 已报错；后续规则按「未声明」处理，不抛异常
  const authMode = isRecord(spec.auth) ? spec.auth.mode : undefined;

  // —— failure 形状（D2 / D5）——
  if (raw.failure !== undefined && raw.failure !== null) {
    if (!Array.isArray(raw.failure)) {
      issues.push(issue("failure 必须是数组"));
    } else {
      raw.failure.forEach((condition, index) => {
        if (!isSettleConditionShape(condition)) {
          issues.push(issue(`failure[${index}] 不是合法的结算条件`));
        }
      });
    }
  }

  // —— R5 绑定唯一 ——
  const producerIndex = new Map<string, number>();
  ops.forEach((op, index) => {
    if (!shapeOk[index] || !isRecord(op) || !isBindingProducer(op as SpecOp))
      return;
    const as = (op as { as?: unknown }).as;
    if (typeof as !== "string" || !as) return;
    if (producerIndex.has(as)) {
      issues.push(
        issue(
          `绑定名「${as}」重复（首次出现于第 ${producerIndex.get(as)! + 1} 步）`,
          {
            rule: "R5",
            opIndex: index,
          },
        ),
      );
      return;
    }
    producerIndex.set(as, index);
  });

  // —— R2 数据流可达 + R4 输入已声明 ——
  const checkBinding = (path: string, atIndex: number, where: string) => {
    const root = rootBinding(path);
    const produced = producerIndex.get(root);
    if (produced === undefined) {
      issues.push(
        issue(
          `${where}引用了不存在的绑定 ${path.startsWith("$") ? path : `$${path}`}`,
          {
            rule: "R2",
            opIndex: atIndex,
          },
        ),
      );
      return;
    }
    if (produced >= atIndex) {
      issues.push(
        issue(
          `${where}引用了尚未产出的绑定 $${path}（由第 ${produced + 1} 步产出）`,
          { rule: "R2", opIndex: atIndex },
        ),
      );
    }
  };
  const checkInputs = (
    inputs: string[],
    atIndex: number | undefined,
    where: string,
  ) => {
    for (const name of inputs) {
      if (!namespace.names.has(name)) {
        issues.push(
          issue(`${where}引用了未声明的输入 {${name}}`, {
            rule: "R4",
            ...(atIndex === undefined ? {} : { opIndex: atIndex }),
          }),
        );
      }
    }
  };

  ops.forEach((op, index) => {
    if (!shapeOk[index]) return;
    const refs = opRefs(op as SpecOp, index, issues);
    checkInputs(
      refs.inputs,
      index,
      `第 ${index + 1} 步（${(op as SpecOp).op}）`,
    );
    for (const binding of refs.bindings) {
      checkBinding(
        binding,
        index,
        `第 ${index + 1} 步（${(op as SpecOp).op}）`,
      );
    }
  });

  // 成功信号与 auth 写入值的引用在「全部算子执行完」之后解析
  const endIndex = ops.length;
  for (const signal of successSignals) {
    const refs = successRefs(signal);
    checkInputs(refs.inputs, undefined, "成功信号");
    for (const binding of refs.bindings) {
      checkBinding(binding, endIndex, "成功信号");
    }
  }
  // auth 写入值在 `auth.write` 算子处求值：引用必须先于该算子产出。
  // 没有 auth.write 算子时（声明未被使用）按 spec 末尾校验。
  const authWriteIndex = ops.findIndex(
    (op, index) =>
      shapeOk[index] &&
      isRecord(op) &&
      op.op === "auth.write" &&
      spec.auth?.mode !== "page",
  );
  const authEvalIndex = authWriteIndex >= 0 ? authWriteIndex : endIndex;
  const authRefs = authWriteRefs(spec, issues);
  checkInputs(authRefs.inputs, undefined, "auth 写入声明");
  for (const binding of authRefs.bindings) {
    checkBinding(binding, authEvalIndex, "auth 写入声明");
  }

  // —— R1 成功先行 ——
  const referencedBindings = new Set(
    successSignals.flatMap((signal) =>
      successRefs(signal).bindings.map(rootBinding),
    ),
  );
  const pageSignal = successSignals.some(hasPageSignal);
  let lastDom = -1;
  ops.forEach((op, index) => {
    if (!shapeOk[index]) return;
    // 跨 origin 的落地 goto 是「跳到目标 origin 恢复会话」的导航，不是登录页
    // 交互。把它计入 DOM 基线会让 D10 的迁移形态
    // （capture → goto({targetUrl}) → restore）永远无法通过 R1。
    // 只豁免通往 auth.restore 的那一段：登录页本身的跨 origin goto 仍受约束。
    if (isCrossOriginGoto(op) && leadsToRestore(ops, index)) {
      return;
    }
    if (isDomInteraction(op as SpecOp)) lastDom = index;
  });

  // `mode: "page"` 只豁免 auth.write（空操作）；auth.capture 仍受 R1 约束（D3）
  ops.forEach((op, index) => {
    if (!shapeOk[index] || !isRecord(op)) return;
    const name = op.op;
    if (name !== "auth.write" && name !== "auth.capture") return;
    if (name === "auth.write" && authMode === "page") return;

    // 成功信号引用的绑定必须已产出
    for (const as of referencedBindings) {
      const produced = producerIndex.get(as);
      if (produced !== undefined && produced >= index) {
        issues.push(
          issue(
            `第 ${index + 1} 步（${name}）必须位于产出成功信号绑定「${as}」的第 ${produced + 1} 步之后`,
            { rule: "R1", opIndex: index },
          ),
        );
      }
    }
    // page 信号：必须位于最后一个 DOM 交互之后
    if (pageSignal && lastDom >= index) {
      issues.push(
        issue(
          `第 ${index + 1} 步（${name}）必须位于最后一个 DOM 交互算子（第 ${lastDom + 1} 步）之后`,
          { rule: "R1", opIndex: index },
        ),
      );
    }
  });

  // —— R3 跨 origin 写入 ——
  //
  // 只约束**显式跨 origin** 的 goto（引用 {targetUrl} / {debugRedirect}）。
  // 同 origin 的登录页导航（如默认模板的 `goto({origin}/login)`）可以出现在
  // auth.write 之前——否则「DOM 登录 + engine 写会话」在 R1 下无解（ADR-0015 D11）。
  const firstWrite = ops.findIndex(
    (op, index) =>
      shapeOk[index] &&
      isRecord(op) &&
      op.op === "auth.write" &&
      spec.auth?.mode !== "page",
  );
  if (firstWrite >= 0) {
    ops.forEach((op, index) => {
      if (index >= firstWrite) return;
      if (!shapeOk[index] || !isRecord(op) || op.op !== "goto") return;
      if (!isCrossOriginGoto(op)) return;
      issues.push(
        issue(
          `第 ${index + 1} 步（goto）是跨 origin 导航，不得位于 auth.write（第 ${firstWrite + 1} 步）之前`,
          { rule: "R3", opIndex: index },
        ),
      );
    });
  }

  const captureIndices = new Map<string, number>();
  ops.forEach((op, index) => {
    if (!shapeOk[index] || !isRecord(op) || op.op !== "auth.capture") return;
    if (nonEmptyString(op.as) && !captureIndices.has(op.as)) {
      captureIndices.set(op.as, index);
    }
  });
  let sawGotoBefore = false;
  ops.forEach((op, index) => {
    if (!shapeOk[index] || !isRecord(op)) return;
    if (op.op === "goto") {
      sawGotoBefore = true;
      return;
    }
    if (op.op !== "auth.restore") return;
    const snapshot = typeof op.snapshot === "string" ? op.snapshot : "";
    const captured = captureIndices.get(snapshot);
    if (captured === undefined) {
      issues.push(
        issue(
          `第 ${index + 1} 步（auth.restore）的快照「${snapshot}」不是任何 auth.capture 的产出`,
          {
            rule: "R6",
            opIndex: index,
          },
        ),
      );
    } else if (captured >= index) {
      issues.push(
        issue(
          `第 ${index + 1} 步（auth.restore）的快照「${snapshot}」由更晚的第 ${captured + 1} 步捕获`,
          { rule: "R3", opIndex: index },
        ),
      );
    }
    if (!sawGotoBefore) {
      issues.push(
        issue(`第 ${index + 1} 步（auth.restore）必须位于一次 goto 之后`, {
          rule: "R3",
          opIndex: index,
        }),
      );
    }
  });

  // —— R6 算子前置 ——
  ops.forEach((op, index) => {
    if (!shapeOk[index] || !isRecord(op)) return;
    if (op.op === "apply.set") {
      const next = ops.findIndex(
        (later, laterIndex) =>
          laterIndex > index &&
          shapeOk[laterIndex] &&
          isRecord(later) &&
          later.op === "http.execute",
      );
      if (next < 0) {
        issues.push(
          issue(`第 ${index + 1} 步（apply.set）之后没有 http.execute`, {
            rule: "R6",
            opIndex: index,
          }),
        );
        return;
      }
      if (op.target === "body") {
        const target = ops[next];
        const body = isRecord(target) ? target.body : undefined;
        const writable =
          isRecord(body) &&
          ("json" in body ||
            ("ref" in body &&
              isObjectPayloadRef(body.ref, ops, producerIndex)));
        if (!writable) {
          issues.push(
            issue(
              `第 ${index + 1} 步（apply.set）的 target 为 body，但第 ${next + 1} 步（http.execute）的 body 不是 { json } 或对象绑定 { ref }`,
              { rule: "R6", opIndex: index },
            ),
          );
        }
      }
      return;
    }
    if (op.op === "http.execute" && isRecord(op.body) && "ref" in op.body) {
      const ref = op.body.ref;
      if (typeof ref !== "string") return;
      if (!isObjectPayloadRef(ref, ops, producerIndex)) {
        issues.push(
          issue(
            `第 ${index + 1} 步（http.execute）的 body.ref「${ref}」必须引用对象模式的 payload.build 产出`,
            { rule: "R6", opIndex: index },
          ),
        );
      }
    }
  });

  // —— R7 成功信号至少一条 ——
  // 形状检查已经报过空数组；这里覆盖「数组非空但 anyOf 递归为空」的组合
  const effectiveSignals = successSignals.filter(isEffectiveSignal);
  if (
    Array.isArray(raw.success) &&
    raw.success.length > 0 &&
    effectiveSignals.length === 0
  ) {
    issues.push(issue("成功信号没有有效条件", { rule: "R7" }));
  }

  return issues;
}

const SETTLE_TYPES = new Set([
  "formGone",
  "urlChanged",
  "url",
  "selector",
  "cookie",
  "storage",
  "fixed",
  "any",
  "all",
]);

/** 结算条件形状检查（`waitFor.when` / `success.page` / `failure[]` 共用） */
function isSettleConditionShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const type = value.type;
  if (typeof type !== "string" || !SETTLE_TYPES.has(type)) return false;
  switch (type) {
    case "url":
      return nonEmptyString(value.glob);
    case "selector":
      return value.target !== undefined;
    case "cookie":
      return nonEmptyString(value.name);
    case "storage":
      return (
        (value.area === "local" || value.area === "session") &&
        nonEmptyString(value.key)
      );
    case "fixed":
      return typeof value.ms === "number" && value.ms >= 0;
    case "any":
    case "all":
      return (
        Array.isArray(value.of) &&
        value.of.length > 0 &&
        value.of.every(isSettleConditionShape)
      );
    default:
      return true;
  }
}

function isEffectiveSignal(signal: SuccessSignal): boolean {
  if ("anyOf" in signal) return signal.anyOf.some(isEffectiveSignal);
  return true;
}

/** 内置输入清单（供配置 UI 的变量胶囊复用） */
export { BUILTIN_INPUT_NAMES };
