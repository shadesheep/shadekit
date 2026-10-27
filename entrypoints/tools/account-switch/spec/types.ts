/**
 * LoginSpec 数据模型（ADR-0014 D2 / ADR-0015 D1-D7）。
 *
 * 纯类型模块：零浏览器 API、零运行时副作用，可被配置 UI、校验器、执行器
 * 与测试共同引用。DOM 子集（`Target` / `FrameScope` / `SettleCondition`）
 * 沿用既有 `generic-recipe` 的类型，避免第二份定义。
 */

import type {
  AuthRange,
  FrameScope,
  SettleCondition,
  Target,
} from "../strategies/generic-recipe";

export type { AuthRange, FrameScope, SettleCondition, Target };

/** 标准登录表单的整组自动定位标记；不进入通用 Target。 */
export const AUTO_LOGIN_TARGET = Object.freeze({ auto: "login" } as const);
export type AutoLoginTarget = typeof AUTO_LOGIN_TARGET;
export type LoginFormTarget = Target | AutoLoginTarget;

/** 可含 `{name}` 与 `$binding` 的模板字符串 */
export type Ref = string;

/** 当前 LoginSpec 版本 */
export const LOGIN_SPEC_VERSION = 2 as const;

/**
 * 归一化规则（`payload.build` 的 per-part）：
 * - `numericString`：去掉非数字字符（含小数后缀），保留前导负号
 * - `base64` / `base64url`：两种 base64 变体互转
 */
export type NormalizeRule =
  | "trim"
  | "upper"
  | "lower"
  | "numericString"
  | "base64"
  | "base64url";

// ============================================================
// 算子（D1）
// ============================================================

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

/** `http.execute` 的 body 三形态 */
export type HttpBody =
  | { json: Record<string, unknown> }
  | { raw: Ref }
  | { ref: string };

export type SpecOp =
  // —— 会话清理 ——
  | { op: "clear.cookies"; range: AuthRange; includeParent?: boolean }
  | { op: "clear.storage"; area: "local" | "session"; range: AuthRange }
  // —— 导航 ——
  | {
      op: "goto";
      url: Ref;
      waitForLoad?: boolean;
      /** 导航后等待实际登录表单目标出现，避免 SPA 渲染 / 重定向竞态 */
      waitForTarget?: Target;
      timeoutMs?: number;
      /** 值为假时跳过本算子，轨迹记 `skipped` */
      when?: Ref;
    }
  // —— HTTP ——
  | {
      op: "http.execute";
      url: Ref;
      method?: HttpMethod;
      headers?: Record<string, Ref>;
      body?: HttpBody;
      parse?: "json" | "text";
      expectStatus?: "2xx" | number[];
      as: string;
    }
  // —— 数据变换 ——
  | {
      op: "digest";
      algorithm: "sha1" | "sha256";
      input: Ref;
      inputEncoding?: "utf8" | "ascii" | "latin1";
      outputEncoding?: "hex" | "base64" | "base64url";
      upperCase?: boolean;
      as: string;
    }
  | {
      op: "crypto.encrypt";
      algorithm: "rsa-pkcs1v15" | "rsa-oaep";
      publicKey: Ref;
      input: Ref;
      as: string;
    }
  | {
      op: "payload.build";
      parts: Array<{ key?: string; value: Ref; normalize?: NormalizeRule[] }>;
      /** 字符串模式必填（可为空串）；对象模式必须缺省 */
      join?: string;
      as: string;
    }
  | {
      op: "map";
      input: Ref;
      cases: Array<{ equals: string | number | boolean; value: Ref }>;
      default?: Ref;
      as: string;
    }
  | {
      op: "apply.set";
      target: "header" | "body" | "query";
      key: string;
      value: Ref;
    }
  // —— 会话写入 ——
  | { op: "auth.write" }
  | {
      op: "auth.capture";
      cookies?: AuthRange;
      localStorage?: AuthRange;
      sessionStorage?: AuthRange;
      as: string;
    }
  | { op: "auth.restore"; snapshot: string }
  // —— DOM 子集（Recipe 的类型视图）——
  | ({
      op: "fill";
      target: LoginFormTarget;
      value: Ref;
      clearFirst?: boolean;
    } & FrameScope)
  | ({
      op: "click";
      target: LoginFormTarget;
      onNotFound?: "fail" | "skip";
    } & FrameScope)
  | { op: "waitFor"; when: SettleCondition; timeoutMs?: number }
  | {
      op: "extract";
      source: "local" | "session" | "dom" | "url" | "cookie";
      key?: string;
      parse?: "raw" | "jsonValue";
      /** 取到空值（null/undefined/""）时回退的字面量；缺省则抛 LOGIN_REJECTED */
      default?: string;
      as: string;
    }
  | { op: "script"; code: string; world?: "MAIN" | "ISOLATED"; as: string };

/** 算子名判别联合的成员名 */
export type SpecOpName = SpecOp["op"];

/**
 * 全部算子名（校验器与编辑器共用）。
 *
 * 注：spec / ticket 写作「18 个算子」，但 ADR-0015 D1 的判别联合实际列出
 * 17 个成员（下表同源）。以 ADR 的类型定义为准；新增算子时同步此表。
 */
export const SPEC_OP_NAMES = [
  "clear.cookies",
  "clear.storage",
  "goto",
  "http.execute",
  "digest",
  "crypto.encrypt",
  "payload.build",
  "map",
  "apply.set",
  "auth.write",
  "auth.capture",
  "auth.restore",
  "fill",
  "click",
  "waitFor",
  "extract",
  "script",
] as const satisfies readonly SpecOpName[];

/** 算子名 → 中文名（轨迹日志与进度显示） */
export const SPEC_OP_LABELS: Record<SpecOpName, string> = {
  "clear.cookies": "清理 Cookie",
  "clear.storage": "清理存储",
  goto: "导航",
  "http.execute": "请求",
  digest: "摘要",
  "crypto.encrypt": "加密",
  "payload.build": "构造载荷",
  map: "映射",
  "apply.set": "改写请求",
  "auth.write": "写会话",
  "auth.capture": "捕获会话",
  "auth.restore": "恢复会话",
  fill: "填充",
  click: "点击",
  waitFor: "等待",
  extract: "提取",
  script: "脚本",
};

/** 产出或使用绑定名（`as`）的算子 */
export type BoundSpecOp = Extract<SpecOp, { as: string }>;

/** 产出绑定的算子名（`auth.restore` 使用既有快照，不产出新绑定） */
const BINDING_PRODUCER_OPS = new Set<SpecOpName>([
  "http.execute",
  "digest",
  "crypto.encrypt",
  "payload.build",
  "map",
  "auth.capture",
  "extract",
  "script",
]);

export function isBindingProducer(op: SpecOp): op is BoundSpecOp {
  return BINDING_PRODUCER_OPS.has(op.op);
}

/** DOM 交互算子（R1 的 `page` 信号定位基准） */
const DOM_INTERACTION_OPS = new Set<SpecOpName>([
  "fill",
  "click",
  "waitFor",
  "goto",
  "script",
]);

export function isDomInteraction(op: SpecOp): boolean {
  return DOM_INTERACTION_OPS.has(op.op);
}

// ============================================================
// 成功 / 失败信号（D5）
// ============================================================

export type SuccessSignal =
  | { response: { from: string; path: string; equals?: unknown } }
  | { token: { from: string; path: string } }
  | { page: SettleCondition }
  | { anyOf: SuccessSignal[] };

// ============================================================
// 认证声明（D7）
// ============================================================

export interface CookieWrite {
  name: string;
  value: Ref;
  /** 缺省 = host-only */
  domain?: string;
  /** 默认 "/" */
  path?: string;
  /** 默认 "auto"：https → true */
  secure?: boolean | "auto";
  /** 默认 false */
  httpOnly?: boolean;
  /** 默认 "unspecified"：不写 SameSite 属性 */
  sameSite?: "unspecified" | "lax" | "strict" | "no_restriction";
  expiresFrom?: {
    from: string;
    path: string;
    /** 默认 epochMs */
    unit: "epochMs" | "epochS" | "iso" | "relativeSeconds";
  };
}

export interface StorageWrite {
  key: string;
  value: Ref;
}

export interface AuthSpec {
  mode: "engine" | "page";
  cookiesWrite?: CookieWrite[];
  localStorageWrite?: StorageWrite[];
  sessionStorageWrite?: StorageWrite[];
}

// ============================================================
// LoginSpec（D2）
// ============================================================

export interface SpecVar {
  /** 进入输入命名空间，引用形式 `{name}` */
  name: string;
  title?: string;
  /** 非敏感默认值 */
  default?: string;
  /**
   * 敏感变量标记（ADR-0015 D9）：`true` 时不得进入配置包
   * （密钥 / 口令等不能随包分发），v1 导入直接拒绝。
   */
  secret?: boolean;
}

export interface SpecAux {
  nonce?: "auto";
  timestamp?: "auto";
}

export interface SpecLimits {
  /** 默认 15000，仅 `http.execute` */
  requestMs?: number;
  /** 默认 5000，仅单次 DOM 交互（fill/click/extract/script） */
  stepMs?: number;
  /** 默认 10000，页面条件轮询；也是 `goto.timeoutMs` 的缺省值 */
  settleMs?: number;
}

export interface SpecLog {
  /** 允许原样进日志的绑定名（不含 `$`） */
  reveal?: string[];
}

export interface LoginSpec {
  version: typeof LOGIN_SPEC_VERSION;
  /** 仅新建与日志可读性，引擎不据此分派 */
  template?: string;
  vars?: SpecVar[];
  /** 声明由引擎生成的输入 */
  aux?: SpecAux;
  ops: SpecOp[];
  /** 至少一条（R7） */
  success: SuccessSignal[];
  /** 任一命中即中止 */
  failure?: SettleCondition[];
  auth: AuthSpec;
  limits?: SpecLimits;
  log?: SpecLog;
}

// ============================================================
// 默认值（集中定义）
// ============================================================

/** 逐算子执行轨迹（trace 展示用的扁平记录；op 以字符串承载，兼容 spec/旧来源） */
export interface RecipeStepTrace {
  index: number;
  op: string;
  target?: string;
  status: "success" | "error" | "skipped";
  duration: number;
  errorCode?: string;
  error?: string;
  /** 标准表单定位来源（自动解析或已锁定）。 */
  resolution?: "auto" | "locked";
}

export const DEFAULT_LIMITS: Required<SpecLimits> = {
  requestMs: 15000,
  stepMs: 5000,
  settleMs: 10000,
};

export const DEFAULT_AUTH: AuthSpec = { mode: "engine" };

/**
 * 内置输入（摊平进输入命名空间，ADR-0015 D4 / D13 C7）。
 *
 * `tabId` 是旧执行器的内部变量，不进入 LoginSpec 的输入命名空间。
 */
export const BUILTIN_INPUT_NAMES = [
  "username",
  "password",
  "origin",
  "targetUrl",
  "debugRedirect",
] as const;

export type BuiltinInputName = (typeof BUILTIN_INPUT_NAMES)[number];
