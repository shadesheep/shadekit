/**
 * LoginSpec 编辑器纯逻辑（S2 纯函数 seam）。
 *
 * 组件的简单 / 高级视图只负责渲染；「默认模板 / 简易视图投影 / 算子工厂 /
 * 切换算子类型 / 可用引用清单 / 校验错误归位」都在这里用纯函数实现，
 * 零浏览器 API、零 chrome stub，便于单测与复用。
 *
 * 约定与 `recipe-editor-model` 一致：视图是 `ops[]` 的**投影**，不引入
 * 第二套数据；简易视图只读写四个算子，其余算子原样保留（往返无损）。
 */

import {
  AUTO_LOGIN_TARGET,
  BUILTIN_INPUT_NAMES,
  DEFAULT_AUTH,
  DEFAULT_LIMITS,
  LOGIN_SPEC_VERSION,
  SPEC_OP_LABELS,
  SPEC_OP_NAMES,
  type LoginSpec,
  type SpecAux,
  type SpecOp,
  type SpecOpName,
  type SpecVar,
} from "./types";
import type { SpecIssue } from "./validate";

// ============================================================
// 默认模板（ADR-0015 D11：只含创建与日志可读性，不参与执行语义）
// ============================================================

/**
 * 新建环境的默认登录声明（可直接保存通过 R1–R7）。
 *
 * 形态：`clear.cookies → fill{username} → fill{password} → click
 * → auth.write`。`clear.*` 与 `auth.write` 在简易视图判定中被剔除，
 * 因此默认模板恰好落在简易形态里。成功判定为默认的 `page`（表单消失 /
 * URL 变化），auth 走 engine 写会话。
 *
 * 不默认带 `goto`：并非所有系统都有 `/login` 路由，新建时更安全的假设
 * 是「用户已在登录页」，登录成功后由 login-tab-flow 原地 reload。需要
 * 导航的用户在简易视图填「登录页 URL」即会自动补一条 goto。
 *
 * D11 的不对称：默认模板含 `clear.storage(local, all)`，但存量配方迁移
 * 不追加该算子。这里**不**包含 clear.storage，新建后由用户在高级视图
 * 视需要添加 —— 与「迁移不添加」保持一致，避免新配置默认清空站点数据。
 */
export function defaultLoginSpec(): LoginSpec {
  return {
    version: LOGIN_SPEC_VERSION,
    template: "generic",
    ops: [
      { op: "clear.cookies", range: "all" },
      { op: "fill", target: AUTO_LOGIN_TARGET, value: "{username}", clearFirst: true },
      { op: "fill", target: AUTO_LOGIN_TARGET, value: "{password}", clearFirst: true },
      { op: "click", target: AUTO_LOGIN_TARGET, onNotFound: "fail" },
      { op: "auth.write" },
    ],
    success: [{ page: { type: "any", of: [{ type: "formGone" }, { type: "urlChanged" }] } }],
    auth: { ...DEFAULT_AUTH },
    limits: { ...DEFAULT_LIMITS },
  };
}

// ============================================================
// 简易视图投影（ADR-0013 D9 的 spec 版本）
// ============================================================

const USERNAME_VALUE = "{username}";
const PASSWORD_VALUE = "{password}";

/** 简易视图判定的剔除集：会话清理与写会话不算「登录表单步骤」 */
const SIMPLE_EXCLUDED = new Set<SpecOpName>(["clear.cookies", "clear.storage", "auth.write"]);

/** 简易形态的算子下标定位 */
export interface SimpleSpecShape {
  gotoIndex?: number;
  usernameIndex: number;
  passwordIndex: number;
  submitIndex: number;
}

function isFillWith(op: SpecOp, value: string): op is Extract<SpecOp, { op: "fill" }> {
  return op.op === "fill" && typeof op.value === "string" && op.value.trim() === value;
}

/**
 * 判定 spec 是否落在简易形态：剔除 `clear.*` 与 `auth.write` 后
 * 恰为 `[goto?] + fill{username} + fill{password} + click`，且不含其他算子。
 * 不满足返回 null（由 UI 引导进高级视图）。
 *
 * 返回的下标指向**原始 `spec.ops` 数组**（不是剔除后的临时数组），
 * 这样简易视图写回定位时能准确定位到被剔除算子之间的真实位置，
 * 保证「其余算子原样保留（往返无损）」。
 */
export function simpleSpecShape(spec: LoginSpec): SimpleSpecShape | null {
  // 按原始顺序收集「非剔除」算子及其在 ops 中的真实下标
  const kept: { op: SpecOp; index: number }[] = [];
  for (let i = 0; i < spec.ops.length; i++) {
    const op = spec.ops[i];
    if (!SIMPLE_EXCLUDED.has(op.op)) kept.push({ op, index: i });
  }
  if (kept.length < 3 || kept.length > 4) return null;

  const hasGoto = kept[0].op.op === "goto";
  const offset = hasGoto ? 1 : 0;
  if (kept.length !== offset + 3) return null;

  const username = kept[offset];
  const password = kept[offset + 1];
  const submit = kept[offset + 2];
  if (!isFillWith(username.op, USERNAME_VALUE)) return null;
  if (!isFillWith(password.op, PASSWORD_VALUE)) return null;
  if (submit.op.op !== "click") return null;

  return {
    ...(hasGoto ? { gotoIndex: kept[0].index } : {}),
    usernameIndex: username.index,
    passwordIndex: password.index,
    submitIndex: submit.index,
  };
}

// ============================================================
// 变量胶囊：可用引用（内置输入 + vars + aux）
// ============================================================

export interface VariableHint {
  /** 插入用的完整占位符：输入用 `{name}`，绑定用 `$name` */
  token: string;
  /** 界面上的中文说明 */
  label: string;
  /** 引用的命名空间（输入 / 绑定） */
  kind: "input" | "binding";
}

const BUILTIN_LABELS: Record<string, string> = {
  username: "账号",
  password: "密码",
  origin: "环境 origin",
  targetUrl: "目标跳转地址",
  debugRedirect: "Bug 复现地址",
};

const AUX_LABELS: Record<string, string> = {
  nonce: "随机数（自动生成）",
  timestamp: "时间戳（自动生成）",
};

/**
 * 当前 spec 可引用的输入清单：内置输入 + `vars` + 已声明的 `aux`。
 * 来源与校验器 / 执行器的 `buildInputNamespace` 同源，避免界面另存一份。
 */
export function specInputHints(spec: LoginSpec): VariableHint[] {
  const hints: VariableHint[] = BUILTIN_INPUT_NAMES.map((name) => ({
    token: `{${name}}`,
    label: BUILTIN_LABELS[name] ?? name,
    kind: "input",
  }));
  for (const v of spec.vars ?? []) {
    hints.push({ token: `{${v.name}}`, label: v.title ?? v.name, kind: "input" });
  }
  if (spec.aux?.nonce === "auto") {
    hints.push({ token: "{nonce}", label: AUX_LABELS.nonce, kind: "input" });
  }
  if (spec.aux?.timestamp === "auto") {
    hints.push({ token: "{timestamp}", label: AUX_LABELS.timestamp, kind: "input" });
  }
  return hints;
}

// ============================================================
// 校验错误归位（R1–R7 → opIndex / spec 级）
// ============================================================

export interface SpecEditorErrors {
  /** spec 级错误（无 opIndex） */
  general: string[];
  /** key = 算子下标 */
  ops: Record<number, string[]>;
}

/**
 * 把校验器返回的问题按算子下标归位。带 `opIndex` 的进 `ops[i]`，
 * 其余进 `general`。空对象表示可保存。
 */
export function bucketSpecErrors(issues: SpecIssue[]): SpecEditorErrors {
  const errors: SpecEditorErrors = { general: [], ops: {} };
  for (const issue of issues) {
    if (issue.opIndex !== undefined) {
      (errors.ops[issue.opIndex] ??= []).push(issue.message);
    } else {
      errors.general.push(issue.message);
    }
  }
  return errors;
}

export function hasSpecErrors(errors: SpecEditorErrors): boolean {
  return errors.general.length > 0 || Object.keys(errors.ops).length > 0;
}

// ============================================================
// 算子工厂与类型切换（高级视图）
// ============================================================

/**
 * 新算子的初始形态（按 op 给默认值）。空定位 / 空 url 由校验器在保存时拦截，
 * 这里先给出便于编辑的骨架。
 */
export function createSpecOp(op: SpecOpName): SpecOp {
  switch (op) {
    case "clear.cookies":
      return { op, range: "all" };
    case "clear.storage":
      return { op, area: "local", range: "all" };
    case "goto":
      // 默认留空而非 {origin}/login：并非所有系统都有 /login 路由，
      // 留空时简易视图直接省略 goto，登录成功后由 login-tab-flow 原地 reload。
      return { op, url: "" };
    case "http.execute":
      return { op, url: "{origin}/api", method: "POST", as: "resp" };
    case "digest":
      return { op, algorithm: "sha256", input: "", as: "sign" };
    case "crypto.encrypt":
      return { op, algorithm: "rsa-pkcs1v15", publicKey: "{publicKey}", input: "{password}", as: "enc" };
    case "payload.build":
      return { op, parts: [], as: "payload" };
    case "map":
      return { op, input: "", cases: [], as: "mapped" };
    case "apply.set":
      return { op, target: "header", key: "", value: "" };
    case "auth.write":
      return { op };
    case "auth.capture":
      return { op, as: "snapshot" };
    case "auth.restore":
      return { op, snapshot: "snapshot" };
    case "fill":
      return { op, target: "", value: "" };
    case "click":
      return { op, target: "", onNotFound: "fail" };
    case "waitFor":
      return { op, when: { type: "urlChanged" } };
    case "extract":
      return { op, source: "url", as: "extract" };
    case "script":
      return { op, code: "", as: "result" };
  }
}

/** 算子名 → 下拉选项（label 来自 shared，新增算子自动出现） */
export const SPEC_OP_OPTIONS: { label: string; value: SpecOpName }[] =
  SPEC_OP_NAMES.map((name) => ({ label: SPEC_OP_LABELS[name], value: name }));

/**
 * 切换算子类型时保留可跨 op 复用的字段（跟 `changeStepOp` 同思路）：
 * - fill / click 之间互切保留 target、value 与 frame 范围（frameId/frameUrl）
 * - 其余按新 op 的默认值重建
 */
export function changeSpecOp(step: SpecOp, op: SpecOpName): SpecOp {
  if (step.op === op) return step;
  const base = createSpecOp(op);
  // fill / click 家族互切：保留定位与 frame 范围（ADR-0013 D12）
  const fromDom = step.op === "fill" || step.op === "click";
  const toDom = base.op === "fill" || base.op === "click";
  if (!fromDom || !toDom) {
    // 跨家族（如 fill → http.execute）：按新 op 的默认值重建，不迁移定位
    return base;
  }
  const source = step as Extract<SpecOp, { op: "fill" | "click" }>;
  const frameScope: { frameId?: number; frameUrl?: string } = {
    ...(source.frameId !== undefined ? { frameId: source.frameId } : {}),
    ...(source.frameUrl !== undefined ? { frameUrl: source.frameUrl } : {}),
  };
  if (base.op === "fill") {
    // fill 之间保留 value（含 frame 范围）；click → fill 时 value 重建为空
    const value = step.op === "fill" ? step.value : "";
    return { ...base, target: source.target, value, ...frameScope } as SpecOp;
  }
  return { ...base, target: source.target, ...frameScope } as SpecOp;
}

/** 深拷贝算子列表（编辑器内部状态，避免污染 props / reactive Proxy） */
export function cloneSpecOps(ops: SpecOp[]): SpecOp[] {
  return JSON.parse(JSON.stringify(ops)) as SpecOp[];
}

/** 上移 / 下移；越界时原样返回 */
export function moveSpecOp(ops: SpecOp[], index: number, delta: -1 | 1): SpecOp[] {
  const target = index + delta;
  if (index < 0 || index >= ops.length) return ops;
  if (target < 0 || target >= ops.length) return ops;
  const next = [...ops];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** 删除第 index 个算子 */
export function removeSpecOp(ops: SpecOp[], index: number): SpecOp[] {
  return ops.filter((_, i) => i !== index);
}

/** 在某位置后插入；index 为 -1 表示插到末尾 */
export function insertSpecOp(ops: SpecOp[], index: number, op: SpecOp): SpecOp[] {
  const next = [...ops];
  next.splice(index + 1, 0, op);
  return next;
}

/** 复制算子：深拷贝后插入到原算子之后 */
export function duplicateSpecOp(ops: SpecOp[], index: number): SpecOp[] {
  if (index < 0 || index >= ops.length) return ops;
  const copy = cloneSpecOps([ops[index]])[0];
  return insertSpecOp(ops, index, copy);
}

/**
 * 智能识别回填后的算子重排（ADR-0013 D8 配套）。
 *
 * `applyScan` 用识别到的 fill/fill/click 替换原表单算子，但要保留 spec
 * 中已声明的清理 / 写会话 / 提取等辅助算子。这些辅助算子有强顺序语义：
 * - `clear.cookies` / `clear.storage` 必须在最前——先清掉旧会话再登录，
 *   否则旧 session 会让 `goto /login` 被重定向回主页，fill 找不到输入框
 * - `auth.write` / `auth.capture` / `auth.restore` 必须在最后——登录成功
 *   后才能写会话或拍快照，放前面会拿到空会话
 * - 其余算子（extract / script / waitFor 等）保持原相对顺序，接在表单段后
 *
 * `formOps` 是已构造好的 fill/fill/click 序列；本函数只负责重排，不修改
 * 单个算子内容。
 */
export function reorderOpsAroundForm(existing: SpecOp[], formOps: SpecOp[]): SpecOp[] {
  const CLEAN = new Set<SpecOpName>(["clear.cookies", "clear.storage"]);
  const WRITE = new Set<SpecOpName>(["auth.write", "auth.capture", "auth.restore"]);
  const FORM = new Set<SpecOpName>(["fill", "click"]);

  const goto = existing.find((o) => o.op === "goto");
  const cleaning: SpecOp[] = [];
  const writing: SpecOp[] = [];
  const middle: SpecOp[] = [];
  for (const op of existing) {
    if (op.op === "goto") continue; // 只保留首个 goto，已单独收集
    if (FORM.has(op.op)) continue; // 原表单算子由 formOps 替换
    if (CLEAN.has(op.op)) cleaning.push(op);
    else if (WRITE.has(op.op)) writing.push(op);
    else middle.push(op);
  }
  return [
    ...cleaning,
    ...(goto ? [goto] : []),
    ...formOps,
    ...middle,
    ...writing,
  ];
}

/**
 * 更新单个算子字段（immutable）。patch 键存在时才更新，防止把无关字段
 * 清空。返回新数组；无变化时返回原引用。
 */
export function updateSpecOp(
  ops: SpecOp[],
  index: number,
  patch: Record<string, unknown>,
): SpecOp[] {
  if (index < 0 || index >= ops.length) return ops;
  return ops.map((op, i) =>
    i === index ? ({ ...op, ...patch } as SpecOp) : op,
  );
}

// ============================================================
// 引用类型声明（供 UI 构造 vars 表单的骨架）
// ============================================================

/** 一个待填变量的编辑视图 */
export interface SpecVarEdit {
  name: string;
  title: string;
  default: string;
}

/** 从 spec 构造 vars 编辑清单（丢失的删除、新增的保留） */
export function specVarsToEdit(spec: LoginSpec): SpecVarEdit[] {
  return (spec.vars ?? []).map((v) => ({
    name: v.name,
    title: v.title ?? "",
    default: v.default ?? "",
  }));
}

/** 从 vars 编辑清单构造回 `vars`（空 name 丢弃） */
export function specsVariables(
  edit: SpecVarEdit[],
): SpecVar[] {
  return edit
    .filter((v) => v.name.trim())
    .map((v) => ({
      name: v.name.trim(),
      ...(v.title.trim() ? { title: v.title.trim() } : {}),
      ...(v.default ? { default: v.default } : {}),
    }));
}

/** aux 编辑视图（把声明映射为布尔开关） */
export interface SpecAuxEdit {
  nonce: boolean;
  timestamp: boolean;
}

export function specAuxToEdit(spec: LoginSpec): SpecAuxEdit {
  return {
    nonce: spec.aux?.nonce === "auto",
    timestamp: spec.aux?.timestamp === "auto",
  };
}

export function specsAux(edit: SpecAuxEdit): SpecAux {
  const aux: SpecAux = {};
  if (edit.nonce) aux.nonce = "auto";
  if (edit.timestamp) aux.timestamp = "auto";
  return aux;
}