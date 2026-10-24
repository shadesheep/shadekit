/**
 * LoginSpec 模板解析 — `{name}` 输入引用 / `$name` 绑定引用 / 三种转义（ADR-0015 D4）。
 *
 * 纯函数，零浏览器 API。保存期用 `collectTemplateRefs` 静态收集引用供校验器使用，
 * 运行期用 `resolveTemplate` 求值。**未解析即错误** —— 不再保留旧 `interpolateTemplate`
 * 的「未命中原样保留」。
 *
 * 语法：
 * - `{name}` — 输入命名空间取值（内置输入 / vars / aux）
 * - `$name` — 绑定表取值，支持点路径（`$resp.data.token`、`$list.0.name`）
 * - `{{` → `{`，`}}` → `}`，`$$` → `$`
 */

/** 模板语法错误 / 未解析引用的错误码（运行期） */
export type TemplateErrorCode = "TEMPLATE_UNRESOLVED" | "TEMPLATE_SYNTAX";

export class TemplateError extends Error {
  readonly code: TemplateErrorCode;
  /** 出错的原始记号（如 `{usernam}` / `$resp.dat`） */
  readonly token: string;

  constructor(code: TemplateErrorCode, message: string, token: string) {
    super(message);
    this.name = "TemplateError";
    this.code = code;
    this.token = token;
  }
}

/** 模板求值上下文：输入命名空间（已摊平）与绑定表 */
export interface TemplateContext {
  inputs: Readonly<Record<string, unknown>>;
  bindings: Readonly<Record<string, unknown>>;
}

export interface CollectedRefs {
  /** `{name}` 引用，按出现顺序去重 */
  inputs: string[];
  /** `$name` 引用（含点路径），按出现顺序去重 */
  bindings: string[];
}

/** 扫描得到的记号 */
type Token =
  | { kind: "text"; text: string }
  | { kind: "input"; name: string; raw: string }
  | { kind: "binding"; path: string[]; raw: string };

const INPUT_NAME = /^[A-Za-z_]\w*$/;
const BINDING_REF = /^\$([A-Za-z_]\w*(?:\.[A-Za-z_]\w*|\.\d+)*)/;

/**
 * 把模板扫描为记号序列。转义在扫描阶段消解为字面量文本。
 * 孤立的 `}`、未闭合的 `{`、空引用与非法标识符均报 `TEMPLATE_SYNTAX`。
 */
function scan(template: string): Token[] {
  const tokens: Token[] = [];
  let text = "";
  const flush = () => {
    if (text) {
      tokens.push({ kind: "text", text });
      text = "";
    }
  };

  let i = 0;
  while (i < template.length) {
    const ch = template[i];

    if (ch === "{") {
      if (template[i + 1] === "{") {
        text += "{";
        i += 2;
        continue;
      }
      const end = template.indexOf("}", i + 1);
      if (end < 0) {
        throw new TemplateError(
          "TEMPLATE_SYNTAX",
          "模板中存在未闭合的 `{`",
          template.slice(i),
        );
      }
      const name = template.slice(i + 1, end);
      if (!INPUT_NAME.test(name)) {
        throw new TemplateError(
          "TEMPLATE_SYNTAX",
          `模板引用名无效：\`{${name}}\``,
          template.slice(i, end + 1),
        );
      }
      flush();
      tokens.push({ kind: "input", name, raw: template.slice(i, end + 1) });
      i = end + 1;
      continue;
    }

    if (ch === "}") {
      if (template[i + 1] === "}") {
        text += "}";
        i += 2;
        continue;
      }
      throw new TemplateError("TEMPLATE_SYNTAX", "模板中存在孤立的 `}`", "}");
    }

    if (ch === "$") {
      if (template[i + 1] === "$") {
        text += "$";
        i += 2;
        continue;
      }
      const match = BINDING_REF.exec(template.slice(i));
      if (!match) {
        throw new TemplateError("TEMPLATE_SYNTAX", "模板中存在孤立的 `$`", "$");
      }
      const raw = match[0];
      const segments = raw.slice(1).split(".");
      flush();
      tokens.push({ kind: "binding", path: segments, raw });
      i += raw.length;
      continue;
    }

    text += ch;
    i += 1;
  }

  flush();
  return tokens;
}

const IDENT_START = /[A-Za-z_]/;
const INPUT_NAME_REF = /^[A-Za-z_]\w*?}/;

/**
 * 规范化「字面 JSON 对象」式模板（导入侧容错，ADR-0015 D4 转义的补充）。
 *
 * 用户常把真实 JSON 对象整个写进 `cookiesWrite[].value`（`{"token":"$resp…"}`），
 * 但 D4 规定字面花括号必须写成 `{{`/`}}`。模板扫描是确定的：一个合法 `{name}`
 * 引用恰好是 `{` + `[A-Za-z_]\w*` + `}`。因此本函数把「不构成完整引用」的结构
 * 花括号转义为 `{{`/`}}`，真正的 `{name}` 输入引用、`$bind` 绑定与已转义形式
 * （`{{`/`}}`/`$$`）保持原样（幂等，不解引用、不校验）。
 *
 * 例：`{"token":"$resp.data.token"}` → `{{"token":"$resp.data.token"}}`；
 *     `{"token":"{username}"}`      → `{{"token":"{username}"}}`（引用保持）；
 *     `{username}-$obj`             → 原样（无字面括号）。
 *
 * 不改变运行期语义：仍「未解析即错误」。只用于导入落地前的规范化。
 */
export function escapeLiteralBraces(template: string): string {
  let out = "";
  let i = 0;
  const n = template.length;
  while (i < n) {
    const ch = template[i];

    if (ch === "{") {
      // 已转义 `{{` → 原样保留
      if (template[i + 1] === "{") {
        out += "{{";
        i += 2;
        continue;
      }
      // 后跟标识符首字符 → 判定是否完整引用 `{ident}`；命中则逐字保留
      if (template[i + 1] !== undefined && IDENT_START.test(template[i + 1])) {
        const m = INPUT_NAME_REF.exec(template.slice(i + 1));
        if (m) {
          out += template[i] + m[0];
          i += 1 + m[0].length;
          continue;
        }
      }
      // 否则是结构花括号（`{"…`、`{ `、不成引用的 `{x…`）→ 转义
      out += "{{";
      i += 1;
      continue;
    }

    if (ch === "}") {
      // 已转义 `}}` → 原样保留
      if (template[i + 1] === "}") {
        out += "}}";
        i += 2;
        continue;
      }
      // 结构闭合括号 → 转义
      out += "}}";
      i += 1;
      continue;
    }

    // `$` / 其余字符原样（`$$`、`$bind` 都照抄；不做引用判定）
    out += ch;
    i += 1;
  }
  return out;
}

/** 收集模板中的引用（保存期校验用）。转义不产生引用。 */
export function collectTemplateRefs(template: string): CollectedRefs {
  const inputs: string[] = [];
  const bindings: string[] = [];
  for (const token of scan(template)) {
    if (token.kind === "input" && !inputs.includes(token.name)) {
      inputs.push(token.name);
    }
    if (token.kind === "binding") {
      const path = token.path.join(".");
      if (!bindings.includes(path)) bindings.push(path);
    }
  }
  return { inputs, bindings };
}

function hasOwn(
  record: Readonly<Record<string, unknown>>,
  key: string,
): boolean {
  return Object.hasOwn(record, key);
}

/**
 * 按路径取值。中间路径缺失 → `undefined`（调用方据此判定未解析）；
 * 末值为 `null` / `undefined` 时返回空串（合法但无内容）。
 */
function readPath(
  root: unknown,
  path: string[],
): { found: boolean; value: unknown } {
  let current: unknown = root;
  for (const segment of path) {
    if (current === null || current === undefined)
      return { found: false, value: undefined };
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { found: false, value: undefined };
      }
      current = current[index];
      continue;
    }
    if (
      typeof current !== "object" ||
      !hasOwn(current as Record<string, unknown>, segment)
    ) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

/**
 * 按点路径从任意根值取值（`a.b.0.c`）。
 *
 * 供执行器判定成功信号的 `{ from, path }` 使用：与 `$name` 的取值规则
 * 完全一致，避免第二份路径语义。
 */
export function readBindingPath(
  root: unknown,
  path: string,
): { found: boolean; value: unknown } {
  return readPath(root, path === "" ? [] : path.split("."));
}

/** 标量转字符串；对象/数组按无空格 JSON 序列化（ADR-0015 D4） */
function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** 解析模板，返回字符串结果。任一引用未解析即抛 `TEMPLATE_UNRESOLVED`。 */
export function resolveTemplate(
  template: string,
  ctx: TemplateContext,
): string {
  let result = "";
  for (const token of scan(template)) {
    switch (token.kind) {
      case "text":
        result += token.text;
        break;
      case "input": {
        if (!hasOwn(ctx.inputs, token.name)) {
          throw new TemplateError(
            "TEMPLATE_UNRESOLVED",
            `未声明的输入引用：${token.raw}`,
            token.raw,
          );
        }
        result += stringify(ctx.inputs[token.name]);
        break;
      }
      case "binding": {
        const { found, value } = readPath(ctx.bindings, token.path);
        if (!found) {
          throw new TemplateError(
            "TEMPLATE_UNRESOLVED",
            `未解析的绑定引用：${token.raw}`,
            token.raw,
          );
        }
        result += stringify(value);
        break;
      }
    }
  }
  return result;
}

/**
 * 解析模板为原始值：整串恰为一个引用时返回引用值本身（保留对象/数字类型），
 * 否则与 `resolveTemplate` 行为一致返回字符串。
 */
export function resolveTemplateValue(
  template: string,
  ctx: TemplateContext,
): unknown {
  const tokens = scan(template);
  if (tokens.length === 1 && tokens[0].kind === "input") {
    const name = tokens[0].name;
    if (!hasOwn(ctx.inputs, name)) {
      throw new TemplateError(
        "TEMPLATE_UNRESOLVED",
        `未声明的输入引用：${tokens[0].raw}`,
        tokens[0].raw,
      );
    }
    return ctx.inputs[name];
  }
  if (tokens.length === 1 && tokens[0].kind === "binding") {
    const { found, value } = readPath(ctx.bindings, tokens[0].path);
    if (!found) {
      throw new TemplateError(
        "TEMPLATE_UNRESOLVED",
        `未解析的绑定引用：${tokens[0].raw}`,
        tokens[0].raw,
      );
    }
    return value;
  }
  return resolveTemplate(template, ctx);
}

/**
 * 规范化一个 spec 的 `auth.write` 各 `value` 字段（cookiesWrite / localStorageWrite /
 * sessionStorageWrite）：对每处模板字符串套 `escapeLiteralBraces`。纯函数，不修改
 * 入参；仅 auth 相关数组做浅拷贝，spec 其余字段与结构原样共享。
 *
 * 用于两个导入路径的落地前：让「cookie value 是字面 JSON 对象」这类手写包自动变
 * 得合法，再交给 `validateLoginSpec` / 存盘。
 */
export function normalizeAuthWriteTemplates(
  spec: { auth?: unknown },
): { auth?: unknown } {
  const auth = spec.auth;
  if (typeof auth !== "object" || auth === null) return spec;
  const next = { ...(auth as Record<string, unknown>) };
  for (const field of [
    "cookiesWrite",
    "localStorageWrite",
    "sessionStorageWrite",
  ] as const) {
    const list = next[field];
    if (!Array.isArray(list)) continue;
    next[field] = list.map((item) => {
      if (typeof item !== "object" || item === null) return item;
      const rec = { ...(item as Record<string, unknown>) };
      if (typeof rec.value === "string") {
        rec.value = escapeLiteralBraces(rec.value);
      }
      return rec;
    });
  }
  return { ...spec, auth: next };
}
