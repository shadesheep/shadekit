/**
 * Generic 登录配方（Recipe）— 纯数据模型与纯函数（ADR-0012 D1/D2/D3/D4/D6）。
 *
 * 本模块**零浏览器 API 依赖**：类型、默认值常量、legacy 迁移、归一化、结构校验。
 * 执行器（generic executor）与配置 UI 共用这里的唯一事实源。
 */

// ============================================================
// 元素定位 Target（D3）
// ============================================================

/**
 * 元素定位描述符。
 * - `string`：CSS 选择器简写（向后兼容旧配置）
 * - `{ css }` / `{ ariaLabel }` / `{ label }` / `{ name }` / `{ placeholder }` / `{ text }`
 *
 * 优先级：id/name → aria-label → label 文本 → placeholder → text
 * → 唯一属性组合 → nth-of-type。
 */
export type Target =
  | string
  | { css: string }
  | { ariaLabel: string }
  | { label: string }
  | { name: string }
  | { placeholder: string }
  | { text: string };

/**
 * 拾取器记录的元素所属 frame（D14）。
 * `frameId` 只在页面导航期间稳定，`frameUrl` 用于导航后重新定位同一子 frame；
 * 两者都没有命中时执行器报 `FRAME_NOT_FOUND`，不静默回退到全 frame 搜索。
 */
export interface FrameScope {
  frameId?: number;
  frameUrl?: string;
}

// ============================================================
// 成功判定（D4）
// ============================================================

export type SettleCondition =
  | { type: "formGone" }
  | { type: "urlChanged" }
  | { type: "url"; glob: string }
  | { type: "selector"; target: Target }
  | { type: "cookie"; name: string }
  | { type: "storage"; area: "local" | "session"; key: string }
  | { type: "fixed"; ms: number }
  | { type: "any"; of: SettleCondition[] }
  | { type: "all"; of: SettleCondition[] };

// ============================================================
// 认证规格（D6）
// ============================================================

/** 三态范围：全部 / 不清 / 白名单 */
export type AuthRange = "all" | "none" | string[];

export type AuthSpec =
  | { mode: "page" }
  | {
      mode: "snapshot";
      /** 需要恢复的 cookie；缺省 none */
      cookies?: AuthRange;
      /** 登录前需要清除的 cookie；缺省 "all"（精确 host） */
      cookiesClear?: AuthRange;
      /** 需要清除/恢复的 localStorage 键；缺省 none */
      localStorage?: "all" | string[];
      sessionStorage?: "all" | string[];
    };

/** 归一化后的快照规格（供 auth-snapshot 原语消费） */
export interface AuthSnapshotSpec {
  cookies: AuthRange;
  cookiesClear: AuthRange;
  localStorage: "all" | string[] | "none";
  sessionStorage: "all" | string[] | "none";
}

// ============================================================
// 配方（D1）
// ============================================================

export type RecipeStep =
  | { op: "goto"; url: string; waitForLoad?: boolean }
  | ({
      op: "fill";
      target: Target;
      value: string;
      clearFirst?: boolean;
    } & FrameScope)
  | ({ op: "click"; target: Target; onNotFound?: "fail" | "skip" } & FrameScope)
  | { op: "waitFor"; when: SettleCondition; timeoutMs?: number }
  | {
      op: "extract";
      source: "storage" | "dom" | "url";
      key?: string;
      as?: string;
    }
  | { op: "script"; code: string; as?: string };

/** 配方步骤操作的中文名（日志、进度显示） */
export const RECIPE_OP_LABELS: Record<RecipeStep["op"], string> = {
  goto: "导航",
  fill: "填充",
  click: "点击",
  waitFor: "等待",
  extract: "提取",
  script: "脚本",
};

export interface RecipeLimits {
  /** 单步骤上限（毫秒），默认 5000 */
  stepMs?: number;
  /** 成功判定轮询上限（毫秒），默认 10000 */
  settleMs?: number;
  /** 页面加载上限（毫秒），默认 15000 */
  pageLoadMs?: number;
}

export interface Recipe {
  version: 1;
  steps: RecipeStep[];
  settle: SettleCondition;
  auth: AuthSpec;
  failWhen?: SettleCondition;
  limits?: RecipeLimits;
}

// ============================================================
// 默认值（集中定义，禁止散落）
// ============================================================

/** 零配置默认可用的成功判定：表单消失或 URL 变化任一成立 */
export const DEFAULT_SETTLE: SettleCondition = {
  type: "any",
  of: [{ type: "formGone" }, { type: "urlChanged" }],
};

export const DEFAULT_AUTH_SPEC: AuthSpec = { mode: "page" };

/**
 * 配方插值可用的基础变量（ADR-0013 D10）。
 *
 * 执行器（`buildRecipeVariables`）与配置页的变量胶囊共用这份清单，
 * 界面不硬编码变量名，新增变量只需在此登记。
 */
export const RECIPE_VARIABLE_NAMES = [
  "username",
  "password",
  "origin",
  "debugRedirect",
] as const;

export type RecipeVariableName = (typeof RECIPE_VARIABLE_NAMES)[number];

export const DEFAULT_LIMITS: Required<RecipeLimits> = {
  stepMs: 5000,
  settleMs: 10000,
  pageLoadMs: 15000,
};

export const RECIPE_VERSION = 1 as const;

/** 配方认证规格的默认快照语义（snapshot 模式） */
export const DEFAULT_SNAPSHOT_SPEC: AuthSnapshotSpec = {
  cookies: "all",
  cookiesClear: "all",
  localStorage: "none",
  sessionStorage: "none",
};

// ============================================================
// legacy 迁移（D2 / §1 迁移表）
// ============================================================

/** generic 扁平参数中与配方相关的字段 */
export interface LegacyGenericParams {
  loginPageUrl?: string;
  pageLoadSelector?: string;
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  successType?: string;
  successValue?: string;
  successTimeout?: number;
  authSource?: string;
  authKey?: string;
}

const LEGACY_DEFAULT_USERNAME =
  'input[name="username"], input[name="account"], #username';
const LEGACY_DEFAULT_PASSWORD = 'input[type="password"], #password';
const LEGACY_DEFAULT_SUBMIT =
  'button[type="submit"], input[type="submit"], .login-btn';

/** 判断参数对象是否包含任何 legacy 字段（用于「静默迁移」检测） */
export function hasLegacyParams(params: unknown): boolean {
  if (!params || typeof params !== "object") return false;
  const p = params as Record<string, unknown>;
  return [
    "loginPageUrl",
    "pageLoadSelector",
    "usernameSelector",
    "passwordSelector",
    "submitSelector",
    "successType",
    "successValue",
    "successTimeout",
    "authSource",
    "authKey",
  ].some((key) => str(p[key]) !== undefined);
}

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** 把 legacy 成功判定转换为 SettleCondition */
export function migrateLegacySettle(
  successType: string | undefined,
  successValue: string | undefined,
): SettleCondition {
  const value = str(successValue);
  switch (successType) {
    case "selector":
      return value
        ? { type: "selector", target: value }
        : DEFAULT_SETTLE;
    case "cookie":
      return value ? { type: "cookie", name: value } : DEFAULT_SETTLE;
    case "localStorage":
      return value
        ? { type: "storage", area: "local", key: value }
        : DEFAULT_SETTLE;
    case "timeout": {
      const ms = Number(value);
      return Number.isFinite(ms) && ms > 0
        ? { type: "fixed", ms }
        : DEFAULT_SETTLE;
    }
    case "url":
      return value ? { type: "url", glob: value } : DEFAULT_SETTLE;
    default:
      return DEFAULT_SETTLE;
  }
}

/** 把 legacy authSource/authKey 转换为 AuthSpec */
export function migrateLegacyAuth(
  authSource: string | undefined,
  authKey: string | undefined,
): AuthSpec {
  const key = str(authKey);
  const source = str(authSource);
  if (!source || !key) return { mode: "page" };
  // 迁移后的快照规格显式写全：只捕获白名单键，清理沿用默认「全部（精确 host）」，
  // 避免默认值后续变动导致旧配置语义漂移（D8）。
  switch (source) {
    case "cookie":
      return {
        mode: "snapshot",
        cookies: [key],
        cookiesClear: "all",
      };
    case "localStorage":
      return {
        mode: "snapshot",
        cookies: "none",
        cookiesClear: "all",
        localStorage: [key],
      };
    case "sessionStorage":
      return {
        mode: "snapshot",
        cookies: "none",
        cookiesClear: "all",
        sessionStorage: [key],
      };
    default:
      return { mode: "page" };
  }
}

/**
 * 把既有 8 个扁平参数无损转换为 Recipe（纯函数、可重入）。
 * 未配置任何 legacy 字段时返回零配置配方。
 */
export function migrateLegacyParams(params: unknown): Recipe {
  const p = (params && typeof params === "object" ? params : {}) as Record<
    string,
    unknown
  >;

  const steps: RecipeStep[] = [];

  const loginPageUrl = str(p.loginPageUrl);
  if (loginPageUrl) {
    steps.push({ op: "goto", url: loginPageUrl, waitForLoad: true });
  }

  const pageLoadSelector = str(p.pageLoadSelector);
  if (pageLoadSelector) {
    steps.push({
      op: "waitFor",
      when: { type: "selector", target: pageLoadSelector },
    });
  }

  steps.push({
    op: "fill",
    target: str(p.usernameSelector) ?? LEGACY_DEFAULT_USERNAME,
    value: "{username}",
    clearFirst: true,
  });
  steps.push({
    op: "fill",
    target: str(p.passwordSelector) ?? LEGACY_DEFAULT_PASSWORD,
    value: "{password}",
    clearFirst: true,
  });
  steps.push({
    op: "click",
    target: str(p.submitSelector) ?? LEGACY_DEFAULT_SUBMIT,
    onNotFound: "fail",
  });

  const auth = migrateLegacyAuth(
    str(p.authSource),
    str(p.authKey),
  );
  // legacy 的 extract 步骤：从认证来源读取
  const authKey = str(p.authKey);
  const authSource = str(p.authSource);
  if (authSource && authKey) {
    steps.push({
      op: "extract",
      source:
        authSource === "cookie"
          ? "storage"
          : authSource === "localStorage" || authSource === "sessionStorage"
            ? "storage"
            : "dom",
      key: authSource === "cookie" ? undefined : authKey,
      as: "auth",
    });
  }

  const settle = migrateLegacySettle(
    str(p.successType),
    str(p.successValue),
  );

  const timeout = Number(p.successTimeout);
  const limits: RecipeLimits = Number.isFinite(timeout) && timeout > 0
    ? { settleMs: timeout }
    : {};

  const recipe: Recipe = {
    version: RECIPE_VERSION,
    steps,
    settle,
    auth,
  };
  if (Object.keys(limits).length > 0) recipe.limits = limits;
  return recipe;
}

// ============================================================
// 归一化（读取时补默认值、丢弃未知步骤）
// ============================================================

/** 配方归一化结果：合法配方 + 被丢弃/修正项的告警 */
export interface NormalizeRecipeResult {
  recipe: Recipe;
  warnings: string[];
  /** 输入是非法结构（无法得到可用配方），由调用方决定是否拒绝 */
  invalid?: string;
}

const STEP_OPS = new Set([
  "goto",
  "fill",
  "click",
  "waitFor",
  "extract",
  "script",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 归一化 Target：只保留受支持的形状 */
export function normalizeTarget(raw: unknown): Target | null {
  if (typeof raw === "string") {
    return raw.trim() ? raw.trim() : null;
  }
  if (!isRecord(raw)) return null;
  for (const key of [
    "css",
    "ariaLabel",
    "label",
    "name",
    "placeholder",
    "text",
  ] as const) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) {
      return { [key]: value.trim() } as Target;
    }
  }
  return null;
}

/** 归一化拾取器记录的 frame 范围（D14）：两者都没有时视为「全 frame 搜索」 */
function normalizeFrameScope(raw: Record<string, unknown>): FrameScope {
  const scope: FrameScope = {};
  const frameId = Number(raw.frameId);
  if (Number.isInteger(frameId) && frameId >= 0) scope.frameId = frameId;
  if (typeof raw.frameUrl === "string" && raw.frameUrl.trim()) {
    scope.frameUrl = raw.frameUrl.trim();
  }
  return scope;
}

function normalizeCondition(raw: unknown): SettleCondition | null {
  if (!isRecord(raw)) return null;
  const type = raw.type;
  switch (type) {
    case "formGone":
    case "urlChanged":
      return { type };
    case "url": {
      const glob = typeof raw.glob === "string" ? raw.glob.trim() : "";
      return glob ? { type: "url", glob } : null;
    }
    case "selector": {
      const target = normalizeTarget(raw.target);
      return target ? { type: "selector", target } : null;
    }
    case "cookie": {
      const name = typeof raw.name === "string" ? raw.name.trim() : "";
      return name ? { type: "cookie", name } : null;
    }
    case "storage": {
      const area = raw.area === "session" ? "session" : "local";
      const key = typeof raw.key === "string" ? raw.key.trim() : "";
      return key ? { type: "storage", area, key } : null;
    }
    case "fixed": {
      const ms = Number(raw.ms);
      return Number.isFinite(ms) && ms >= 0
        ? { type: "fixed", ms }
        : null;
    }
    case "any":
    case "all": {
      const of = Array.isArray(raw.of)
        ? raw.of
            .map(normalizeCondition)
            .filter((c): c is SettleCondition => c !== null)
        : [];
      return of.length > 0 ? { type, of } : null;
    }
    default:
      return null;
  }
}

function normalizeStep(raw: unknown, warnings: string[], index: number): RecipeStep | null {
  if (!isRecord(raw)) {
    warnings.push(`第 ${index + 1} 步不是对象，已丢弃`);
    return null;
  }
  const op = raw.op;
  if (typeof op !== "string" || !STEP_OPS.has(op)) {
    warnings.push(`第 ${index + 1} 步的操作类型未知（${String(op)}），已丢弃`);
    return null;
  }
  switch (op) {
    case "goto": {
      const url = typeof raw.url === "string" ? raw.url.trim() : "";
      if (!url) {
        warnings.push(`第 ${index + 1} 步缺少 URL，已丢弃`);
        return null;
      }
      return {
        op: "goto",
        url,
        ...(raw.waitForLoad === false ? { waitForLoad: false } : {}),
      };
    }
    case "fill": {
      const target = normalizeTarget(raw.target);
      const value = typeof raw.value === "string" ? raw.value : undefined;
      if (!target || value === undefined) {
        warnings.push(`第 ${index + 1} 步（fill）缺少定位或值，已丢弃`);
        return null;
      }
      return {
        op: "fill",
        target,
        value,
        ...(raw.clearFirst === false ? { clearFirst: false } : {}),
        ...normalizeFrameScope(raw),
      };
    }
    case "click": {
      const target = normalizeTarget(raw.target);
      if (!target) {
        warnings.push(`第 ${index + 1} 步（click）缺少定位，已丢弃`);
        return null;
      }
      return {
        op: "click",
        target,
        ...(raw.onNotFound === "skip" ? { onNotFound: "skip" as const } : {}),
        ...normalizeFrameScope(raw),
      };
    }
    case "waitFor": {
      const when = normalizeCondition(raw.when);
      if (!when) {
        warnings.push(`第 ${index + 1} 步（waitFor）等待条件无效，已丢弃`);
        return null;
      }
      const timeoutMs = Number(raw.timeoutMs);
      return {
        op: "waitFor",
        when,
        ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
      };
    }
    case "extract": {
      const source = raw.source;
      if (source !== "storage" && source !== "dom" && source !== "url") {
        warnings.push(`第 ${index + 1} 步（extract）来源无效，已丢弃`);
        return null;
      }
      const key = typeof raw.key === "string" ? raw.key : undefined;
      const as = typeof raw.as === "string" ? raw.as : undefined;
      if (source !== "url" && !key) {
        warnings.push(`第 ${index + 1} 步（extract）缺少 key，已丢弃`);
        return null;
      }
      return {
        op: "extract",
        source,
        ...(key ? { key } : {}),
        ...(as ? { as } : {}),
      };
    }
    case "script": {
      const code = typeof raw.code === "string" ? raw.code : "";
      if (!code.trim()) {
        warnings.push(`第 ${index + 1} 步（script）缺少代码，已丢弃`);
        return null;
      }
      return {
        op: "script",
        code,
        ...(typeof raw.as === "string" && raw.as ? { as: raw.as } : {}),
      };
    }
    default:
      return null;
  }
}

function normalizeAuthRange(raw: unknown, fallback: AuthRange): AuthRange {
  if (raw === "all" || raw === "none") return raw;
  if (Array.isArray(raw)) {
    const names = raw.filter(
      (v): v is string => typeof v === "string" && v.trim() !== "",
    );
    return names.length > 0 ? names : "none";
  }
  return fallback;
}

function normalizeAuth(raw: unknown): AuthSpec {
  if (!isRecord(raw) || raw.mode !== "snapshot") return DEFAULT_AUTH_SPEC;
  const result: AuthSpec = {
    mode: "snapshot",
    cookies: normalizeAuthRange(raw.cookies, "none"),
    cookiesClear: normalizeAuthRange(raw.cookiesClear, "all"),
  };
  const local = raw.localStorage;
  if (local === "all" || Array.isArray(local)) {
    result.localStorage =
      local === "all"
        ? "all"
        : local.filter((v): v is string => typeof v === "string" && !!v);
  }
  const session = raw.sessionStorage;
  if (session === "all" || Array.isArray(session)) {
    result.sessionStorage =
      session === "all"
        ? "all"
        : session.filter((v): v is string => typeof v === "string" && !!v);
  }
  return result;
}

/**
 * 归一化配方：补默认值、丢弃未知/非法步骤并记录告警。
 * `invalid` 仅用于「结构上完全不可用」的输入（缺 steps / 版本不符）。
 */
export function normalizeRecipe(raw: unknown): NormalizeRecipeResult {
  const warnings: string[] = [];
  if (!isRecord(raw)) {
    return { recipe: emptyRecipe(), warnings, invalid: "配方不是对象" };
  }
  const version = Number(raw.version);
  if (version !== RECIPE_VERSION) {
    warnings.push(
      `配方版本 ${String(raw.version)} 与当前引擎 (${RECIPE_VERSION}) 不匹配，已按当前版本解释`,
    );
  }
  if (!Array.isArray(raw.steps)) {
    return { recipe: emptyRecipe(), warnings, invalid: "配方缺少步骤列表" };
  }
  const steps = raw.steps
    .map((step, index) => normalizeStep(step, warnings, index))
    .filter((s): s is RecipeStep => s !== null);

  if (steps.length === 0) {
    return { recipe: emptyRecipe(), warnings, invalid: "配方至少需要一步" };
  }

  const settle = normalizeCondition(raw.settle) ?? DEFAULT_SETTLE;
  const failWhen = normalizeCondition(raw.failWhen);
  const limits = isRecord(raw.limits) ? raw.limits : {};
  const normalizedLimits: RecipeLimits = {};
  for (const key of ["stepMs", "settleMs", "pageLoadMs"] as const) {
    const value = Number(limits[key]);
    if (Number.isFinite(value) && value > 0) normalizedLimits[key] = value;
  }

  const recipe: Recipe = {
    version: RECIPE_VERSION,
    steps,
    settle,
    auth: normalizeAuth(raw.auth),
  };
  if (failWhen) recipe.failWhen = failWhen;
  if (Object.keys(normalizedLimits).length > 0) recipe.limits = normalizedLimits;
  return { recipe, warnings };
}

function emptyRecipe(): Recipe {
  return {
    version: RECIPE_VERSION,
    steps: [],
    settle: DEFAULT_SETTLE,
    auth: DEFAULT_AUTH_SPEC,
  };
}

// ============================================================
// 结构校验（保存时拦截）
// ============================================================

/** 校验配方，返回可读错误列表（空数组 = 合法） */
export function validateRecipe(raw: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(raw)) return ["配方必须是对象"];
  if (Number(raw.version) !== RECIPE_VERSION) {
    errors.push(`配方版本必须是 ${RECIPE_VERSION}`);
  }
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    errors.push("配方至少需要一步");
  } else {
    raw.steps.forEach((step, index) => {
      if (!isRecord(step)) {
        errors.push(`第 ${index + 1} 步必须是对象`);
        return;
      }
      const op = step.op;
      if (typeof op !== "string" || !STEP_OPS.has(op)) {
        errors.push(`第 ${index + 1} 步的操作类型无效`);
        return;
      }
      if (op === "goto" && !str(step.url)) {
        errors.push(`第 ${index + 1} 步（goto）缺少 URL`);
      }
      if ((op === "fill" || op === "click") && !normalizeTarget(step.target)) {
        errors.push(`第 ${index + 1} 步（${op}）缺少元素定位`);
      }
      if (op === "fill" && typeof step.value !== "string") {
        errors.push(`第 ${index + 1} 步（fill）缺少填充值`);
      }
      if (op === "waitFor" && !normalizeCondition(step.when)) {
        errors.push(`第 ${index + 1} 步（waitFor）等待条件无效`);
      }
      if (op === "extract") {
        if (step.source !== "storage" && step.source !== "dom" && step.source !== "url") {
          errors.push(`第 ${index + 1} 步（extract）来源无效`);
        } else if (step.source !== "url" && !str(step.key)) {
          errors.push(`第 ${index + 1} 步（extract）缺少 key`);
        }
      }
      if (op === "script" && !str(step.code)) {
        errors.push(`第 ${index + 1} 步（script）缺少代码`);
      }
    });
  }

  if (!raw.settle) {
    errors.push("缺少成功判定（settle）");
  } else if (!normalizeCondition(raw.settle)) {
    errors.push("成功判定（settle）无效");
  }
  if (raw.failWhen !== undefined && raw.failWhen !== null) {
    if (!normalizeCondition(raw.failWhen)) errors.push("失败判定（failWhen）无效");
  }
  if (raw.auth !== undefined) {
    if (!isRecord(raw.auth) || (raw.auth.mode !== "page" && raw.auth.mode !== "snapshot")) {
      errors.push("认证规格（auth）无效");
    }
  }
  if (raw.limits !== undefined) {
    if (!isRecord(raw.limits)) {
      errors.push("limits 必须是对象");
    } else {
      for (const key of ["stepMs", "settleMs", "pageLoadMs"] as const) {
        const value = raw.limits[key];
        if (value !== undefined) {
          const ms = Number(value);
          if (!Number.isFinite(ms) || ms <= 0) {
            errors.push(`limits.${key} 必须是大于 0 的毫秒数`);
          }
        }
      }
    }
  }
  return errors;
}

/** 读取环境的配方：优先 strategyConfig.recipe，否则由 legacy 参数迁移 */
export function readRecipeFromConfig(domainConfig: {
  strategyConfig?: { recipe?: unknown };
  strategyParams?: Record<string, unknown>;
}): { recipe: Recipe; warnings: string[]; migrated: boolean; invalid?: string } {
  const raw = domainConfig.strategyConfig?.recipe;
  if (raw !== undefined && raw !== null) {
    const normalized = normalizeRecipe(raw);
    if (normalized.invalid) {
      return { ...normalized, migrated: false };
    }
    return { ...normalized, migrated: false };
  }
  if (hasLegacyParams(domainConfig.strategyParams)) {
    const migrated = migrateLegacyParams(domainConfig.strategyParams);
    const normalized = normalizeRecipe(migrated);
    return { ...normalized, migrated: true };
  }
  return {
    recipe: emptyRecipe(),
    warnings: [],
    migrated: false,
    invalid: "该环境尚未配置登录配方",
  };
}
