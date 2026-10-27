/**
 * 配方编辑器纯逻辑（ADR-0012 D1 / D2 / D4）
 *
 * 组件只负责渲染，所有「增删排序 / Target 折返 / settle 与 auth 的表单映射 /
 * 错误定位」都在这里用纯函数实现，便于单测与复用。
 */

import {
  DEFAULT_AUTH_SPEC,
  DEFAULT_SETTLE,
  RECIPE_VERSION,
  RECIPE_VARIABLE_NAMES,
  normalizeTarget,
  type AuthRange,
  type AuthSpec,
  type FrameScope,
  type Recipe,
  type RecipeStep,
  type RecipeVariableName,
  type SettleCondition,
  type Target,
  validateRecipe,
} from "../strategies/generic-recipe";
import { isAutoLoginTarget } from "../spec/auto-login";
import type { LoginFormTarget } from "../spec/types";
import { validateStrategyParams } from "../utils/validate-strategy";
import { containsVolatileId } from "./volatile-id";

// ============================================================
// 步骤
// ============================================================

export const STEP_OP_OPTIONS: { label: string; value: RecipeStep["op"] }[] = [
  { label: "导航（goto）", value: "goto" },
  { label: "填充（fill）", value: "fill" },
  { label: "点击（click）", value: "click" },
  { label: "等待（waitFor）", value: "waitFor" },
  { label: "提取（extract）", value: "extract" },
  { label: "脚本（script）", value: "script" },
];

/**
 * 新步骤的初始形态（按 op 给默认值）。
 * 切换 op 时**不要**直接替换整步：用 `changeStepOp` 保留定位与 frame 范围（D12）。
 */
export function createStep(op: RecipeStep["op"]): RecipeStep {
  switch (op) {
    case "goto":
      // 默认留空而非 {origin}/login：并非所有系统都有 /login 路由，
      // 留空时简易视图会省略 goto，登录后由 login-tab-flow 原地 reload。
      return { op: "goto", url: "" };
    case "fill":
      return { op: "fill", target: "", value: "" };
    case "click":
      return { op: "click", target: "", onNotFound: "fail" };
    case "waitFor":
      return { op: "waitFor", when: { type: "urlChanged" } };
    case "extract":
      return { op: "extract", source: "url", as: "extract" };
    case "script":
      return { op: "script", code: "", as: "script" };
  }
}

/**
 * 切换 op 时保留可跨 op 复用的字段（ADR-0013 D12）。
 *
 * - `target`：fill / click 之间互切时定位不丢（最常见的「选错 op」场景）
 * - `frameId` / `frameUrl`：同一次拾取记录的 frame 范围，与 op 无关
 * - `value`：fill → fill 之外的 op 不保留（click 没有值），但 fill 之间保留
 *
 * 其余字段按新 op 的默认值重建，避免残留上一个 op 的语义。
 */
export function changeStepOp(step: RecipeStep, op: RecipeStep["op"]): RecipeStep {
  if (step.op === op) return step;
  const base = createStep(op);
  const hadTarget = step.op === "fill" || step.op === "click";
  if (!hadTarget || (base.op !== "fill" && base.op !== "click")) return base;

  // fill / click 家族内互切：定位与 frame 范围原样保留
  const scope: FrameScope = {
    ...(step.frameId !== undefined ? { frameId: step.frameId } : {}),
    ...(step.frameUrl !== undefined ? { frameUrl: step.frameUrl } : {}),
  };
  if (base.op === "fill") {
    return {
      ...base,
      target: step.target,
      ...(step.op === "fill" ? { value: step.value } : {}),
      ...scope,
    };
  }
  return { ...base, target: step.target, ...scope };
}

/**
 * 复制步骤（ADR-0013 D12）：深拷贝后插入到原步骤之后。
 * 复制的是「同一种定位再来一次」这个高频操作，值 / frame 范围一并带走。
 */
export function duplicateStep<T>(steps: T[], index: number): T[] {
  if (index < 0 || index >= steps.length) return steps;
  const copy = JSON.parse(JSON.stringify(steps[index])) as T;
  return insertStep(steps, index, copy);
}

/**
 * 深拷贝步骤列表。
 *
 * 编辑器的 `recipe` prop 来自父组件的 reactive 状态，步骤是 Vue Proxy，
 * `structuredClone` 无法克隆 Proxy（DataCloneError）。配方本身只是 JSON 数据
 * （要写入 chrome.storage），因此用 JSON 往返拷贝。
 */
export function cloneSteps(steps: RecipeStep[]): RecipeStep[] {
  return JSON.parse(JSON.stringify(steps)) as RecipeStep[];
}

/** 上移 / 下移；越界时原样返回（不产生空档） */
export function moveStep<T>(steps: T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (index < 0 || index >= steps.length) return steps;
  if (target < 0 || target >= steps.length) return steps;
  const next = [...steps];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** 删除第 index 步 */
export function removeStep<T>(steps: T[], index: number): T[] {
  return steps.filter((_, i) => i !== index);
}

/** 在某位置后插入 */
export function insertStep<T>(steps: T[], index: number, step: T): T[] {
  const next = [...steps];
  next.splice(index + 1, 0, step);
  return next;
}

// ============================================================
// 简易模式（ADR-0013 D9：steps 的视图投影，不是第二套数据）
// ============================================================

/**
 * 简易模式能表达的标准形态：`[goto?] + fill{username} + fill{password} + click`。
 * 这是**投影**：没有 `simple` 配置字段，读写都直接落在 `recipe.steps` 上
 * （ADR-0012 D1 单一事实源）。
 */
export interface SimpleRecipeShape {
  /** 登录页 URL 所在的 goto 步骤下标；没有 goto 时为 undefined */
  gotoIndex?: number;
  usernameIndex: number;
  passwordIndex: number;
  submitIndex: number;
}

/** 简易模式的三行表单（值固定为变量，只有定位可编辑） */
export interface SimpleForm {
  /** 登录页 URL；空串表示配方不导航 */
  loginUrl: string;
  /** 空 URL 时保留的「等待页面加载」开关 */
  waitForLoad: boolean;
  username: Target;
  password: Target;
  submit: Target;
}

const USERNAME_VALUE = "{username}";
const PASSWORD_VALUE = "{password}";

function isFillWith(step: RecipeStep, value: string): step is Extract<RecipeStep, { op: "fill" }> {
  return step.op === "fill" && step.value.trim() === value;
}

/**
 * 判定配方是否落在简易模式的形态里；不满足返回 null（由 UI 引导进高级模式）。
 *
 * 严格匹配：只允许 `[goto?] + fill({username}) + fill({password}) + click`，
 * 出现 waitFor / extract / script 或多出来的 fill / click 都视为「不适用」——
 * 投影必须无损，含糊的形态宁可不简化。
 */
export function simpleShapeOf(recipe: Recipe): SimpleRecipeShape | null {
  const steps = recipe.steps;
  if (steps.length < 3 || steps.length > 4) return null;
  if (steps.some((s) => s.op === "waitFor" || s.op === "extract" || s.op === "script")) {
    return null;
  }

  const hasGoto = steps[0].op === "goto";
  const offset = hasGoto ? 1 : 0;
  if (steps.length !== offset + 3) return null;

  const username = steps[offset];
  const password = steps[offset + 1];
  const submit = steps[offset + 2];
  if (!isFillWith(username, USERNAME_VALUE)) return null;
  if (!isFillWith(password, PASSWORD_VALUE)) return null;
  if (submit.op !== "click") return null;

  return {
    ...(hasGoto ? { gotoIndex: 0 } : {}),
    usernameIndex: offset,
    passwordIndex: offset + 1,
    submitIndex: offset + 2,
  };
}

/** 配方 → 简易表单；不满足标准形态时返回 null */
export function toSimpleForm(recipe: Recipe): SimpleForm | null {
  const shape = simpleShapeOf(recipe);
  if (!shape) return null;
  const gotoStep = shape.gotoIndex === undefined ? null : recipe.steps[shape.gotoIndex];
  const goto = gotoStep?.op === "goto" ? gotoStep : null;
  return {
    loginUrl: goto?.url ?? "",
    waitForLoad: goto?.waitForLoad !== false,
    username: (recipe.steps[shape.usernameIndex] as Extract<RecipeStep, { op: "fill" }>).target,
    password: (recipe.steps[shape.passwordIndex] as Extract<RecipeStep, { op: "fill" }>).target,
    submit: (recipe.steps[shape.submitIndex] as Extract<RecipeStep, { op: "click" }>).target,
  };
}

/**
 * 简易表单 → 完整配方：只重建 `steps`，`settle` / `failWhen` / `auth` / `limits`
 * 原样保留（简易模式不碰这些）。
 */
export function fromSimpleForm(recipe: Recipe, form: SimpleForm): Recipe {
  // 简易模式不暴露 frame 范围 / clearFirst / onNotFound，但往返必须无损：
  // 有原步骤时只替换「定位」与「值」，其余字段原样保留
  const shape = simpleShapeOf(recipe);
  const original = (index: number | undefined): RecipeStep | undefined =>
    index === undefined ? undefined : recipe.steps[index];

  const steps: RecipeStep[] = [];
  const url = form.loginUrl.trim();
  const originalGoto = original(shape?.gotoIndex);
  if (url) {
    const goto: RecipeStep = { op: "goto", url };
    if (
      (originalGoto?.op === "goto" && originalGoto.waitForLoad === false) ||
      !form.waitForLoad
    ) {
      goto.waitForLoad = false;
    }
    steps.push(goto);
  }

  const originalUsername = original(shape?.usernameIndex);
  steps.push(
    originalUsername?.op === "fill"
      ? { ...originalUsername, target: form.username, value: USERNAME_VALUE }
      : { op: "fill", target: form.username, value: USERNAME_VALUE },
  );

  const originalPassword = original(shape?.passwordIndex);
  steps.push(
    originalPassword?.op === "fill"
      ? { ...originalPassword, target: form.password, value: PASSWORD_VALUE }
      : { op: "fill", target: form.password, value: PASSWORD_VALUE },
  );

  const originalClick = original(shape?.submitIndex);
  steps.push(
    originalClick?.op === "click"
      ? { ...originalClick, target: form.submit }
      : { op: "click", target: form.submit, onNotFound: "fail" },
  );

  return { ...recipe, steps };
}

// ============================================================
// 变量胶囊（ADR-0013 D10）
// ============================================================

/** 变量标签；key 用 `RecipeVariableName` 收窄，新增变量时编译期强制补文案 */
const VARIABLE_LABELS: Record<RecipeVariableName, string> = {
  username: "账号",
  password: "密码",
  origin: "环境 origin",
  debugRedirect: "本地 Bug 复现地址",
};

export interface VariableHint {
  /** 插入用的完整占位符，如 `{username}` */
  token: string;
  /** 界面上的中文说明 */
  label: string;
}

/**
 * `value` 输入框下方的变量胶囊。清单来自 `RECIPE_VARIABLE_NAMES`
 * （执行器 `buildRecipeVariables` 同源），界面不硬编码变量名。
 */
export const VARIABLE_HINTS: VariableHint[] = RECIPE_VARIABLE_NAMES.map(
  (name) => ({ token: `{${name}}`, label: VARIABLE_LABELS[name] }),
);

/** 在光标处插入变量；无光标信息时追加到末尾（纯函数，便于单测） */
export function insertAtCursor(
  text: string,
  token: string,
  selectionStart?: number | null,
  selectionEnd?: number | null,
): { value: string; cursor: number } {
  const start = selectionStart ?? text.length;
  const end = selectionEnd ?? start;
  return {
    value: text.slice(0, start) + token + text.slice(end),
    cursor: start + token.length,
  };
}

/**
 * 密码明文告警（D10）：定位看起来是密码框、值非空且不含 `{password}` 时提示。
 * **只提示不拦截**——测试环境确实可能用固定串。
 */
export function passwordPlaintextWarning(
  target: Target | null,
  value: string,
): string | null {
  if (!value.trim() || value.includes("{password}")) return null;
  if (!isPasswordLikeTarget(target)) return null;
  return "密码建议使用 {password} 变量，避免把明文写入配置";
}

/** 定位是否指向密码框：CSS / name / placeholder / label 里出现 password 或「密码」 */
export function isPasswordLikeTarget(target: Target | null): boolean {
  if (!target) return false;
  const text = targetValue(target).toLowerCase();
  if (!text) return false;
  return text.includes("password") || text.includes("密码");
}

// ============================================================
// Target 表单
// ============================================================

export type TargetKind =
  | "css"
  | "ariaLabel"
  | "label"
  | "name"
  | "placeholder"
  | "text";

export const TARGET_KIND_OPTIONS: { label: string; value: TargetKind }[] = [
  { label: "CSS 选择器", value: "css" },
  { label: "aria-label", value: "ariaLabel" },
  { label: "label 文本", value: "label" },
  { label: "name 属性", value: "name" },
  { label: "placeholder", value: "placeholder" },
  { label: "可见文本", value: "text" },
];

/** 从 Target 取编辑用 kind；字符串简写按 CSS 处理 */
export function targetKind(target: Target | null | undefined): TargetKind {
  if (!target || typeof target === "string") return "css";
  if ("css" in target) return "css";
  if ("ariaLabel" in target) return "ariaLabel";
  if ("label" in target) return "label";
  if ("name" in target) return "name";
  if ("placeholder" in target) return "placeholder";
  return "text";
}

/** 从 Target 取编辑用值（不含前缀，界面统一用 kind + value 两个控件） */
export function targetValue(target: Target | null | undefined): string {
  if (!target) return "";
  if (typeof target === "string") return target;
  if ("css" in target) return target.css;
  if ("ariaLabel" in target) return target.ariaLabel;
  if ("label" in target) return target.label;
  if ("name" in target) return target.name;
  if ("placeholder" in target) return target.placeholder;
  return target.text;
}

/** kind + value → Target；空值返回空串（保存时由结构校验拦截） */
export function makeTarget(kind: TargetKind, value: string): Target {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return kind === "css" ? trimmed : ({ [kind]: trimmed } as Target);
}

// ============================================================
// 拾取建议与类型提示（ADR-0013 D6）
// ============================================================

/** TargetField 的使用场景：决定拾取后建议什么、按什么校验元素类型 */
export type TargetContext = "fill" | "click" | "locate";

/** 拾取元素的受限元信息（结构同 `target-picker` 的 `ElementMeta`，此处避免循环依赖） */
export interface TargetMeta {
  tag: string;
  type?: string;
  role?: string;
  contentEditable?: boolean;
}

function isClickableMeta(meta: TargetMeta): boolean {
  if (meta.tag === "button" || meta.tag === "a" || meta.tag === "summary") {
    return true;
  }
  if (meta.role === "button" || meta.role === "link") return true;
  if (meta.tag === "input") {
    return /^(button|submit|reset|image)$/.test(meta.type ?? "");
  }
  return false;
}

function isFillableMeta(meta: TargetMeta): boolean {
  if (meta.contentEditable) return true;
  if (meta.tag === "textarea" || meta.tag === "select") return true;
  if (meta.tag !== "input") return false;
  return !/^(button|submit|reset|checkbox|radio|image|file|range)$/.test(
    meta.type ?? "text",
  );
}

function isTextEntryMeta(meta: TargetMeta): boolean {
  if (meta.contentEditable) return true;
  if (meta.tag === "textarea") return true;
  if (meta.tag !== "input") return false;
  return /^(text|email|tel|search|url|)$/i.test(meta.type ?? "");
}

/**
 * 拾取后建议的填充值（ADR-0013 D6）：
 * - `type=password` → `{password}`
 * - 文本输入框，且配方里没有别的 fill 已在用 `{username}` → `{username}`
 *
 * 只用于**值为空**的 fill；不自动改写用户已填的内容。
 */
export function suggestFillValue(
  meta: TargetMeta,
  otherFillValues: string[],
): string | null {
  if (meta.type === "password") return "{password}";
  if (!isTextEntryMeta(meta)) return null;
  const usernameUsed = otherFillValues.some((value) =>
    value.includes("{username}"),
  );
  return usernameUsed ? null : "{username}";
}

/** 元素类型与步骤是否匹配的提示（不拦截保存，返回 null 表示无提示） */
export function targetTypeWarning(
  context: TargetContext,
  meta: TargetMeta,
): string | null {
  if (context === "fill" && !isFillableMeta(meta)) {
    return "该元素不像可输入控件，仍可保存，但执行时可能填不进去";
  }
  if (context === "click" && !isClickableMeta(meta)) {
    return "该元素不是可点击控件，仍可保存，但执行时可能点不到";
  }
  return null;
}

/** 结构化 Target 的可读描述（与执行器日志一致） */
export function describeTargetForUi(target: LoginFormTarget | null | undefined): string {
  if (!target) return "";
  if (isAutoLoginTarget(target)) return "自动（登录表单）";
  if (typeof target === "string") return target;
  if ("css" in target) return target.css;
  if ("ariaLabel" in target) return `aria-label「${target.ariaLabel}」`;
  if ("label" in target) return `label「${target.label}」`;
  if ("name" in target) return `name=${target.name}`;
  if ("placeholder" in target) return `placeholder「${target.placeholder}」`;
  return `文本「${target.text}」`;
}

// ============================================================
// 成功判定 / 失败判定表单
// ============================================================

/**
 * `default` 表示零配置默认 `any[formGone, urlChanged]`；
 * `timeout` 对应 `{ type: "fixed" }`（沿用旧的「固定等待」叫法）。
 */
export type SettleKind =
  | "default"
  | "formGone"
  | "urlChanged"
  | "url"
  | "selector"
  | "cookie"
  | "localStorage"
  | "sessionStorage"
  | "timeout"
  | "custom";

export const SETTLE_KIND_OPTIONS: { label: string; value: SettleKind }[] = [
  { label: "默认（表单消失或 URL 变化）", value: "default" },
  { label: "登录表单消失", value: "formGone" },
  { label: "URL 发生变化", value: "urlChanged" },
  { label: "URL 通配符", value: "url" },
  { label: "元素出现", value: "selector" },
  { label: "Cookie 存在", value: "cookie" },
  { label: "localStorage 键存在", value: "localStorage" },
  { label: "sessionStorage 键存在", value: "sessionStorage" },
  { label: "固定等待（毫秒）", value: "timeout" },
];

export interface SettleForm {
  kind: SettleKind;
  value: string;
  /**
   * 条件为 `selector` 时的结构化定位（ADR-0013 D5）。
   * 缺省时由 `value` 按 CSS 简写解析，兼容旧调用与测试。
   */
  target?: Target;
}

function isDefaultSettle(cond: SettleCondition): boolean {
  return (
    cond.type === "any" &&
    cond.of.length === 2 &&
    cond.of[0].type === "formGone" &&
    cond.of[1].type === "urlChanged"
  );
}

/** SettleCondition → 表单；组合条件保留为 custom（只读展示） */
export function settleToForm(cond: SettleCondition | null | undefined): SettleForm {
  if (!cond) return { kind: "default", value: "" };
  switch (cond.type) {
    case "formGone":
      return { kind: "formGone", value: "" };
    case "urlChanged":
      return { kind: "urlChanged", value: "" };
    case "url":
      return { kind: "url", value: cond.glob };
    case "selector":
      return {
        kind: "selector",
        value: targetValue(cond.target),
        target: cond.target,
      };
    case "cookie":
      return { kind: "cookie", value: cond.name };
    case "storage":
      return {
        kind: cond.area === "session" ? "sessionStorage" : "localStorage",
        value: cond.key,
      };
    case "fixed":
      return { kind: "timeout", value: String(cond.ms) };
    case "any":
    case "all":
      return isDefaultSettle(cond)
        ? { kind: "default", value: "" }
        : { kind: "custom", value: describeSettle(cond) };
  }
}

/** 表单 → SettleCondition；值缺失/非法返回 null（由校验提示） */
export function formToSettle(form: SettleForm): SettleCondition | null {
  const value = form.value.trim();
  switch (form.kind) {
    case "default":
      return { ...DEFAULT_SETTLE } as SettleCondition;
    case "formGone":
      return { type: "formGone" };
    case "urlChanged":
      return { type: "urlChanged" };
    case "url":
      return value ? { type: "url", glob: value } : null;
    case "selector": {
      // 保留结构化定位（label / name 等），只有手填时才退回 CSS 简写
      const target = form.target ?? normalizeTarget(value);
      return target ? { type: "selector", target } : null;
    }
    case "cookie":
      return value ? { type: "cookie", name: value } : null;
    case "localStorage":
      return value ? { type: "storage", area: "local", key: value } : null;
    case "sessionStorage":
      return value ? { type: "storage", area: "session", key: value } : null;
    case "timeout": {
      const ms = Number(value);
      return Number.isFinite(ms) && ms > 0 ? { type: "fixed", ms } : null;
    }
    case "custom":
      return null;
  }
}

/** 可读描述（与 generic-settle 的 describeCondition 同文案，避免 import 浏览器侧模块） */
export function describeSettle(cond: SettleCondition): string {
  switch (cond.type) {
    case "formGone":
      return "登录表单消失";
    case "urlChanged":
      return "URL 发生变化";
    case "url":
      return `URL 匹配 ${cond.glob}`;
    case "selector":
      return `元素出现 ${describeTargetForUi(cond.target)}`;
    case "cookie":
      return `Cookie 存在 ${cond.name}`;
    case "storage":
      return `${cond.area === "local" ? "localStorage" : "sessionStorage"} 存在 ${cond.key}`;
    case "fixed":
      return `固定等待 ${cond.ms}ms`;
    case "any":
      return `任一成立（${cond.of.map(describeSettle).join(" / ")}）`;
    case "all":
      return `全部成立（${cond.of.map(describeSettle).join(" / ")}）`;
  }
}

// ============================================================
// 认证规格表单
// ============================================================

export type StorageRangeKind = "none" | "all" | "names";

export interface AuthForm {
  mode: "page" | "snapshot";
  /** cookie 恢复范围 */
  cookiesKind: AuthRange | "names";
  cookiesNames: string;
  /** cookie 清除范围（三态） */
  clearKind: AuthRange | "names";
  clearNames: string;
  localKind: StorageRangeKind;
  localNames: string;
  sessionKind: StorageRangeKind;
  sessionNames: string;
}

export function authToForm(auth: AuthSpec | null | undefined): AuthForm {
  const spec = auth ?? DEFAULT_AUTH_SPEC;
  if (spec.mode === "page") {
    return {
      mode: "page",
      cookiesKind: "all",
      cookiesNames: "",
      clearKind: "all",
      clearNames: "",
      localKind: "none",
      localNames: "",
      sessionKind: "none",
      sessionNames: "",
    };
  }
  return {
    mode: "snapshot",
    ...rangeToForm(spec.cookies, "none", "cookies"),
    ...rangeToForm(spec.cookiesClear, "all", "clear"),
    localKind: storageKind(spec.localStorage),
    localNames: namesText(spec.localStorage),
    sessionKind: storageKind(spec.sessionStorage),
    sessionNames: namesText(spec.sessionStorage),
  } as AuthForm;
}

function rangeToForm(
  range: AuthRange | undefined,
  fallback: AuthRange,
  key: "cookies" | "clear",
): Pick<AuthForm, "cookiesKind" | "cookiesNames"> | Pick<AuthForm, "clearKind" | "clearNames"> {
  const value = range ?? fallback;
  if (Array.isArray(value)) {
    return key === "cookies"
      ? { cookiesKind: "names", cookiesNames: value.join(", ") }
      : { clearKind: "names", clearNames: value.join(", ") };
  }
  return key === "cookies"
    ? { cookiesKind: value, cookiesNames: "" }
    : { clearKind: value, clearNames: "" };
}

function storageKind(range: "all" | string[] | undefined): StorageRangeKind {
  if (range === "all") return "all";
  if (Array.isArray(range)) return "names";
  return "none";
}

function namesText(range: "all" | string[] | undefined): string {
  return Array.isArray(range) ? range.join(", ") : "";
}

function parseNames(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function toRange(kind: AuthRange | "names", names: string): AuthRange {
  if (kind === "names") return parseNames(names);
  return kind;
}

/** 表单 → AuthSpec；names 为空时降级为 none（避免「白名单但什么都没写」） */
export function formToAuth(form: AuthForm): AuthSpec {
  if (form.mode === "page") return { mode: "page" };
  const cookies = toRange(form.cookiesKind, form.cookiesNames);
  const clear = toRange(form.clearKind, form.clearNames);
  const spec: AuthSpec = {
    mode: "snapshot",
    cookies: Array.isArray(cookies) && cookies.length === 0 ? "none" : cookies,
    cookiesClear: Array.isArray(clear) && clear.length === 0 ? "none" : clear,
  };
  if (form.localKind !== "none") {
    spec.localStorage =
      form.localKind === "all" ? "all" : parseNames(form.localNames);
  }
  if (form.sessionKind !== "none") {
    spec.sessionStorage =
      form.sessionKind === "all" ? "all" : parseNames(form.sessionNames);
  }
  return spec;
}

// ============================================================
// 校验：结构错误 + 组合错误，按行归位
// ============================================================

export interface RecipeEditorErrors {
  general: string[];
  /** key = 步骤下标 */
  steps: Record<number, string[]>;
  settle: string[];
  auth: string[];
}

/**
 * 扁平参数形态下可表达的 settle 判定方式。`formGone` / `urlChanged` / `sessionStorage`
 * 是配方新增的能力，没有对应的扁平值——投影时留空，避免复用扁平规则误报。
 */
const FLAT_EXPRESSIBLE_SETTLE_KINDS = new Set<SettleKind>([
  "url",
  "selector",
  "cookie",
  "localStorage",
  "timeout",
]);

/**
 * 把 recipe 投影为扁平参数形状，复用 `validateStrategyParams` 的组合校验规则
 * （settle.kind/value 必填配对、auth 来源与键名配对、loginPageUrl 合法性）。
 * 只有扁平形态能表达的部分参与投影，其余由 `validateRecipe` 自身负责。
 */
export function recipeToFlatParams(recipe: Recipe): Record<string, unknown> {
  const settle = settleToForm(recipe.settle);
  const auth = authToForm(recipe.auth);
  const firstGoto = recipe.steps.find((s) => s.op === "goto");
  const flatSettle = FLAT_EXPRESSIBLE_SETTLE_KINDS.has(settle.kind);
  return {
    loginPageUrl: firstGoto && firstGoto.op === "goto" ? firstGoto.url : "",
    successType: flatSettle ? settle.kind : "",
    successValue: flatSettle ? settle.value : "",
    authSource:
      auth.mode === "page"
        ? ""
        : auth.cookiesKind === "names" && parseNames(auth.cookiesNames).length === 1
          ? "cookie"
          : auth.localKind === "names" && parseNames(auth.localNames).length === 1
            ? "localStorage"
            : auth.sessionKind === "names" && parseNames(auth.sessionNames).length === 1
              ? "sessionStorage"
              : "",
    authKey:
      auth.mode === "page"
        ? ""
        : (parseNames(auth.cookiesNames)[0] ??
          parseNames(auth.localNames)[0] ??
          parseNames(auth.sessionNames)[0] ??
          ""),
  };
}

/** 汇总全部错误并归位到行；空对象表示可保存 */
export function collectRecipeErrors(recipe: Recipe): RecipeEditorErrors {
  const errors: RecipeEditorErrors = {
    general: [],
    steps: {},
    settle: [],
    auth: [],
  };

  for (const message of validateRecipe(recipe)) {
    const match = /^第 (\d+) 步/.exec(message);
    if (match) {
      const index = Number(match[1]) - 1;
      (errors.steps[index] ??= []).push(message);
      continue;
    }
    if (message.includes("settle")) errors.settle.push(message);
    else if (message.includes("auth")) errors.auth.push(message);
    else errors.general.push(message);
  }

  // 组合校验：复用扁平参数的同源规则，错误归到 settle / auth 行
  const params = recipeToFlatParams(recipe);
  for (const error of validateStrategyParams("generic", params)) {
    if (error.field === "authKey" || error.field === "authSource") {
      errors.auth.push(error.message);
    } else if (error.field === "loginPageUrl") {
      // 登录页 URL 就在第一步 goto 上
      (errors.steps[recipe.steps.findIndex((s) => s.op === "goto")] ??= []).push(
        error.message,
      );
    } else {
      errors.settle.push(error.message);
    }
  }

  // 写死了框架自动生成的 id（如 `#el-id-9759-21`）：语法合法、保存不拦，
  // 但执行时必然 ELEMENT_NOT_FOUND —— 必须就地提示用户重新拾取。
  recipe.steps.forEach((step, index) => {
    for (const target of targetsOfStep(step)) {
      if (targetVolatileId(target)) {
        (errors.steps[index] ??= []).push(
          `定位写死了自动生成的 id（${targetValue(target)}），刷新页面后会失效，请重新拾取`,
        );
        break;
      }
    }
  });

  return errors;
}

/** 步骤里所有可能写进配方的定位（fill / click / waitFor / extract） */
function targetsOfStep(step: RecipeStep): Target[] {
  switch (step.op) {
    case "fill":
    case "click":
      return [step.target];
    case "waitFor":
      return step.when.type === "selector" ? [step.when.target] : [];
    default:
      return [];
  }
}

/** 定位是否写死了框架自动生成的 id */
export function targetVolatileId(target: Target | null | undefined): boolean {
  if (!target) return false;
  if (typeof target === "string") return containsVolatileId(target);
  if ("css" in target) return containsVolatileId(target.css);
  return false;
}

export function hasRecipeErrors(errors: RecipeEditorErrors): boolean {
  return (
    errors.general.length > 0 ||
    errors.settle.length > 0 ||
    errors.auth.length > 0 ||
    Object.keys(errors.steps).length > 0
  );
}

// ============================================================
// 组装 / 拆分
// ============================================================

/** 空白配方（新增 generic 环境时的初始值） */
export function emptyRecipe(): Recipe {
  return {
    version: RECIPE_VERSION,
    steps: [
      { op: "fill", target: "", value: "{username}" },
      { op: "fill", target: "", value: "{password}" },
      { op: "click", target: "", onNotFound: "fail" },
    ],
    settle: { ...DEFAULT_SETTLE } as SettleCondition,
    auth: { mode: "page" },
  };
}
