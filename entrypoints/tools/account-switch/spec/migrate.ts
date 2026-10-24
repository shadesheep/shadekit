/**
 * LoginSpec 迁移链（ADR-0014 D11 / ADR-0015 D10）。
 *
 * 纯函数、零浏览器 API：把存量数据（旧扁平参数 / Recipe v1）逐级升到
 * 当前版本的 `LoginSpec`。每一段迁移只负责 `v → v+1`，入口按版本号顺序推进；
 * 版本高于当前扩展时**明确拒绝**，不尝试解释未来格式。
 *
 * 迁移说明（行为收紧，须在接入指南中单列）：
 * 1. 未解析引用从「原样发送」变为保存期报错（`validateLoginSpec` R4）。
 * 2. `extract` 不再在 local 与 session 之间静默回退，需显式选择。
 * 3. `script` 从「模板字符串 + `{success}` 约定」变为「函数 + `throw`」。
 */
import {
  DEFAULT_SETTLE,
  hasLegacyParams,
  migrateLegacyParams,
  normalizeRecipe,
  type RecipeStep,
} from "../strategies/generic-recipe";
import { LOGIN_SPEC_VERSION, type LoginSpec } from "./types";

export type MigrateSpecResult =
  | { ok: true; spec: LoginSpec; warnings: string[] }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 读取入口传入的上下文：不属于数据本身、但旧引擎实际使用的环境配置 */
export interface MigrateSpecOptions {
  /** `strategyParams.cookieClear`：非快照配方的清理三态 */
  cookieClear?: "all" | "none" | string[];
}

/**
 * 把任意存量数据迁移到当前 `LoginSpec` 版本。
 *
 * - `version === LOGIN_SPEC_VERSION`：原样返回（浅拷贝，调用方可安全修改）
 * - `version < LOGIN_SPEC_VERSION`：逐级执行 `v → v+1`
 * - `version > LOGIN_SPEC_VERSION`：拒绝，提示配置比扩展新
 */
export function migrateSpec(
  raw: unknown,
  options: MigrateSpecOptions = {},
): MigrateSpecResult {
  if (!isRecord(raw)) {
    return { ok: false, error: "登录配置必须是对象" };
  }
  const version = Number(raw.version);
  if (!Number.isInteger(version) || version < 1) {
    return {
      ok: false,
      error: `登录配置缺少有效版本号（收到 ${String(raw.version)}）`,
    };
  }
  if (version > LOGIN_SPEC_VERSION) {
    return {
      ok: false,
      error:
        `登录配置版本 ${version} 高于当前扩展支持的版本 ${LOGIN_SPEC_VERSION}，` +
        "请先升级扩展后再导入",
    };
  }
  if (version === LOGIN_SPEC_VERSION) {
    return { ok: true, spec: raw as unknown as LoginSpec, warnings: [] };
  }

  const warnings: string[] = [];
  let migrated = raw;
  for (let from = version; from < LOGIN_SPEC_VERSION; from++) {
    if (from === 1) {
      // 旧读取路径在原样执行前先经 `normalizeRecipe`（丢弃非法步骤、补
      // settle/auth 默认值）。迁移必须保持同样的容错，否则「升级后行为不变」
      // 对含少量脏数据的存量配置就不成立。
      const normalized = normalizeRecipe(migrated);
      if (normalized.invalid) {
        return {
          ok: false,
          error: `旧登录配方无法迁移：${normalized.invalid}`,
        };
      }
      warnings.push(...normalized.warnings);
      migrated = recipeV1ToSpecV2(
        normalized.recipe as unknown as Record<string, unknown>,
        warnings,
        options,
      );
      continue;
    }
    throw new Error(`尚无 ${from} → ${from + 1} 的迁移`);
  }
  return { ok: true, spec: migrated as unknown as LoginSpec, warnings };
}

/** Recipe v1 的认证声明（三态范围快照 / 页面自管） */
interface RecipeAuthV1 {
  mode: "page" | "snapshot";
  cookies?: "all" | "none" | string[];
  cookiesClear?: "all" | "none" | string[];
  localStorage?: "all" | string[];
  sessionStorage?: "all" | string[];
}

/** 三态范围归一化：非法/缺失时取 `fallback`，空数组视为 `none` */
export function parseAuthRange(
  value: unknown,
  fallback: "all" | "none" = "none",
): "all" | "none" | string[] {
  if (value === "all" || value === "none") return value;
  if (Array.isArray(value)) {
    const names = value.filter(
      (v): v is string => typeof v === "string" && v.trim() !== "",
    );
    return names.length > 0 ? names : "none";
  }
  return fallback;
}

/**
 * 第一段：Recipe v1 → LoginSpec v2（ADR-0015 D10 迁移表）。
 *
 * - `steps[]` 一一对应到 `ops[]`；`extract.source: "storage"` 拆为 `local`（告警）
 * - `settle` → `success: [{ page }]`；`failWhen` → `failure: [failWhen]`
 * - `auth.mode: "snapshot"` → `clear.cookies` + `clear.storage`（命中的范围）+
 *   `auth.capture` + `goto` + `auth.restore`；`page` → `auth.mode: "page"`
 * - `limits.pageLoadMs` 删除（`goto.timeoutMs` 缺省 settleMs）；其余同名保留
 * - `script.code` 模板字符串 → 函数形态（破坏性变更，逐条告警）
 * - `extract.as` / `script.as` 缺省补为 `"extract"` / `"script"`
 *
 * 清理算子对应旧管线的隐式 `clearCookies` / `clearStorage` 阶段：D11 所说
 * 「迁移不添加 `clear.storage`」指默认模板不会清空 localStorage，而存量配方
 * 在快照模式白名单里已声明过的 storage 清理属于**原有行为**，必须保留。
 */
interface RecipeToSpecOptions {
  /** non-snapshot 的清理范围（legacy 的 cookieClear 三态） */
  cookieClear?: "all" | "none" | string[];
  /** legacy 的 authSource 转换出的 extract 算子（Recipe 无法表达 cookie 源） */
  extractOp?: Record<string, unknown>;
}

function recipeV1ToSpecV2(
  raw: Record<string, unknown>,
  warnings: string[],
  options: RecipeToSpecOptions = {},
): Record<string, unknown> {
  const auth = (isRecord(raw.auth)
    ? raw.auth
    : { mode: "page" }) as unknown as RecipeAuthV1;
  const snapshot = auth.mode === "snapshot";
  const cookieClear = options.cookieClear ?? "all";

  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  const migratedSteps = steps
    .map((step, index) => recipeStepToSpecOp(step, index, warnings))
    .filter((op): op is Record<string, unknown> => op !== null);

  // 清理与捕获是算子。旧管线的步骤顺序是
  //   clearCookies → clearStorage → login(配方步骤) → setAuth → afterLogin
  // 迁移后保持同样顺序：清理在前，配方步骤居中，捕获在登录完成之后。
  const ops: Record<string, unknown>[] = [
    {
      op: "clear.cookies",
      range: snapshot ? parseAuthRange(auth.cookiesClear, "all") : cookieClear,
    },
  ];
  // 旧 `clearAuth` 的清理语义：任一 storage 范围是 all 即清空两种 storage；
  // 否则按各自白名单逐键清除。范围缺省 none 时不动 storage。
  const localRange = snapshot ? parseAuthRange(auth.localStorage) : "none";
  const sessionRange = snapshot ? parseAuthRange(auth.sessionStorage) : "none";
  if (localRange === "all" || sessionRange === "all") {
    ops.push({ op: "clear.storage", area: "local", range: "all" });
    ops.push({ op: "clear.storage", area: "session", range: "all" });
  } else {
    if (localRange !== "none") {
      ops.push({ op: "clear.storage", area: "local", range: localRange });
    }
    if (sessionRange !== "none") {
      ops.push({ op: "clear.storage", area: "session", range: sessionRange });
    }
  }
  ops.push(...migratedSteps);
  if (options.extractOp) ops.push(options.extractOp);
  if (snapshot) {
    // 捕获发生在登录 origin；恢复必须在目标 origin 的文档内，因此中间隔一次 goto。
    // `targetUrl` 为空时跳过导航，restore 落在当前文档——与旧引擎「无目标 URL
    // 时不导航、就地恢复」一致。debugRedirect 优先的落地规则属于
    // login-tab-flow 的 URL 推导（D12），不在 spec 里重复表达。
    const capture: Record<string, unknown> = {
      op: "auth.capture",
      as: "snapshot",
    };
    if (auth.cookies !== undefined)
      capture.cookies = parseAuthRange(auth.cookies);
    if (auth.localStorage !== undefined) {
      capture.localStorage = parseAuthRange(auth.localStorage);
    }
    if (auth.sessionStorage !== undefined) {
      capture.sessionStorage = parseAuthRange(auth.sessionStorage);
    }
    ops.push(capture);
    ops.push({ op: "goto", url: "{targetUrl}", when: "{targetUrl}" });
    ops.push({ op: "auth.restore", snapshot: "snapshot" });
  }

  const spec: Record<string, unknown> = {
    version: LOGIN_SPEC_VERSION,
    template: "generic",
    ops,
    success: [{ page: isRecord(raw.settle) ? raw.settle : DEFAULT_SETTLE }],
    // 迁移后的 spec 不含 auth.write：认证态由页面 cookie 或 capture/restore 承载
    auth: { mode: "page" },
  };
  if (isRecord(raw.failWhen)) spec.failure = [raw.failWhen];
  const limits = recipeLimitsToSpecLimits(raw.limits);
  if (limits) spec.limits = limits;
  return spec;
}

/** `limits.pageLoadMs` 删除；`stepMs` / `settleMs` 同名保留 */
function recipeLimitsToSpecLimits(
  raw: unknown,
): Record<string, number> | undefined {
  if (!isRecord(raw)) return undefined;
  const limits: Record<string, number> = {};
  for (const key of ["stepMs", "settleMs"] as const) {
    const value = Number(raw[key]);
    if (Number.isFinite(value) && value > 0) limits[key] = value;
  }
  return Object.keys(limits).length > 0 ? limits : undefined;
}

function recipeStepToSpecOp(
  raw: unknown,
  index: number,
  warnings: string[],
): Record<string, unknown> | null {
  if (!isRecord(raw)) {
    warnings.push(`第 ${index + 1} 步不是对象，已丢弃`);
    return null;
  }
  switch (raw.op) {
    case "goto": {
      const goto: Record<string, unknown> = {
        op: "goto",
        url: String(raw.url ?? ""),
      };
      // 旧执行器 `waitForLoad !== false` 才等待；缺省语义与 spec 一致，只在显式 false 时保留
      if (raw.waitForLoad === false) goto.waitForLoad = false;
      return goto;
    }
    case "fill":
    case "click":
      return { ...raw };
    case "waitFor":
      return { ...raw };
    case "extract":
      return migrateExtractStep(raw, index, warnings);
    case "script":
      return migrateScriptStep(raw, index, warnings);
    default:
      warnings.push(
        `第 ${index + 1} 步的操作类型未知（${String(raw.op)}），已丢弃`,
      );
      return null;
  }
}

function migrateExtractStep(
  raw: Record<string, unknown>,
  index: number,
  warnings: string[],
): Record<string, unknown> {
  const source = raw.source === "storage" ? "local" : raw.source;
  if (raw.source === "storage") {
    warnings.push(
      `第 ${index + 1} 步（extract）的 storage 来源已迁移为 local：` +
        "原实现会先读 localStorage 再回退 sessionStorage，如需读 session 请显式改为 session",
    );
  }
  const step: Record<string, unknown> = {
    op: "extract",
    source,
    as: typeof raw.as === "string" && raw.as ? raw.as : "extract",
  };
  if (raw.key !== undefined) step.key = raw.key;
  return step;
}

function migrateScriptStep(
  raw: Record<string, unknown>,
  index: number,
  warnings: string[],
): Record<string, unknown> {
  const code = typeof raw.code === "string" ? raw.code : "";
  warnings.push(
    `第 ${index + 1} 步（script）是破坏性变更：脚本改为函数形态 (bindings) => …，` +
      "不再做模板插值，失败需 throw；请人工改写该步骤的代码",
  );
  if (!code.trim()) {
    // 旧执行器会在运行时直接失败；新校验要求 code 非空，留空会让整条配置无法保存
    warnings.push(`第 ${index + 1} 步（script）没有代码，请补全后再保存`);
  }
  return {
    op: "script",
    code: `// 迁移自 v1 模板字符串，需人工改写为函数形态\n(bindings) => {\n${indent(code)}\n}`,
    as: typeof raw.as === "string" && raw.as ? raw.as : "script",
  };
}

function indent(code: string): string {
  return code
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

// ============================================================
// 读取入口：spec 优先，其次 recipe，最后 legacy 扁平参数
// ============================================================

export interface ReadSpecResult {
  spec: LoginSpec | null;
  warnings: string[];
  /** 输入是旧形态（recipe 或 legacy 参数），已被迁移 */
  migrated: boolean;
  /** 无法得到可用 spec（未配置 / 版本过高 / 结构损坏） */
  invalid?: string;
}

/**
 * 从环境配置读取登录声明（ADR-0015 D10 / ADR-0019 修订：镜像）。
 *
 * 优先级：
 * 1. `strategyConfig.spec`（环境私有声明，含「脱镜」后的覆盖）；
 * 2. 策略库条目（`strategyId` 指向 `strategies[strategyId]`，镜像读取）；
 * 3. `strategyConfig.recipe` / 旧扁平 `strategyParams`（经迁移链升到当前版本）。
 *
 * 镜像环境只记 `strategyId` 不持声明，库条目是它们唯一的数据源；库条目
 * 被删除后回到「未配置」并提示重新选择登录方式。版本高于当前扩展时返回
 * `invalid`，不尝试解释。
 *
 * 已移除的内置登录策略不会静默回退到仓库内声明。缺少内联声明时，
 * 返回可操作的 `invalid`，指引用户导入自己的登录策略包。
 */
export function readSpecFromConfig(
  domainConfig: {
    loginMethod?: string;
    strategyConfig?: { spec?: unknown; recipe?: unknown };
    strategyParams?: Record<string, unknown>;
    strategyId?: string;
  },
  strategies?: Record<string, { spec?: unknown } | undefined>,
): ReadSpecResult {
  const storedSpec = domainConfig.strategyConfig?.spec;
  if (storedSpec !== undefined && storedSpec !== null) {
    const result = migrateSpec(storedSpec);
    if (!result.ok) {
      return {
        spec: null,
        warnings: [],
        migrated: false,
        invalid: result.error,
      };
    }
    return { spec: result.spec, warnings: result.warnings, migrated: false };
  }

  // 镜像（ADR-0019 修订）：绑定库条目且环境没有私有声明时，直接读库。
  // 库条目内容损坏按「未配置」处理，不在此额外报错——`invalid` 文案由下方
  // 「尚未配置登录声明」兜底，并提示用户去环境里另选登录方式。
  const mirrorId = domainConfig.strategyId;
  if (mirrorId) {
    const mirrorSpec = strategies?.[mirrorId]?.spec;
    if (mirrorSpec !== undefined && mirrorSpec !== null) {
      const result = migrateSpec(mirrorSpec);
      if (result.ok) {
        return { spec: result.spec, warnings: result.warnings, migrated: false };
      }
    }
  }

  const storedRecipe = domainConfig.strategyConfig?.recipe;
  if (storedRecipe !== undefined && storedRecipe !== null) {
    const result = migrateSpec(storedRecipe, {
      cookieClear: legacyCookieClear(domainConfig.strategyParams?.cookieClear),
    });
    if (!result.ok) {
      return {
        spec: null,
        warnings: [],
        migrated: false,
        invalid: result.error,
      };
    }
    return { spec: result.spec, warnings: result.warnings, migrated: true };
  }

  if (hasLegacyParams(domainConfig.strategyParams)) {
    return migrateLegacyConfig(domainConfig.strategyParams ?? {});
  }

  // 历史存储中的旧内置策略 id 仅用于识别迁移，不代表公开策略包。
  if (
    domainConfig.loginMethod === "legacy-builtin" ||
    domainConfig.loginMethod === "ebs-rsa"
  ) {
    return {
      spec: null,
      warnings: [],
      migrated: false,
      invalid:
        "该环境原先使用的内置登录已移除。请在「环境与账号」中导入登录策略包，或重新配置通用登录",
    };
  }

  return {
    spec: null,
    warnings: [],
    migrated: false,
    invalid: "该环境尚未配置登录声明",
  };
}

/**
 * 旧 8 个扁平参数 → LoginSpec。
 *
 * 复用既有的 `migrateLegacyParams`（v1 recipe）后进入同一迁移链，再补两处
 * Recipe 表达不了、但旧引擎实际执行了的行为：
 * - `authSource: "cookie"`：旧映射误写成 storage 提取，这里改为
 *   `extract(source: "cookie")`，并补 `auth.capture` 供跨 origin 恢复
 * - `strategyParams.cookieClear`：非快照模式的清理三态
 */
function migrateLegacyConfig(params: Record<string, unknown>): ReadSpecResult {
  const recipe = migrateLegacyParams(params) as unknown as Record<
    string,
    unknown
  >;
  const warnings: string[] = [];

  const authSource = trimString(params.authSource);
  const authKey = trimString(params.authKey);
  const cookieSource = authSource === "cookie" && !!authKey;
  const cookieClear = legacyCookieClear(params.cookieClear);

  // `migrateLegacyParams` 会把 authSource 一律映射成 storage 提取（旧缺陷），
  // 这里用正确的来源替换那一步，避免留下一个 source: "local" 的错提取。
  if (authSource && authKey) {
    recipe.steps = (recipe.steps as RecipeStep[]).filter(
      (step) => step.op !== "extract",
    );
  }

  const spec = recipeV1ToSpecV2(recipe, warnings, {
    ...(cookieClear ? { cookieClear } : {}),
    ...(authSource && authKey
      ? { extractOp: legacyExtractOp(authSource, authKey, warnings) }
      : {}),
  });

  // cookie 源无法由 Recipe 的快照规格表达：补一个只捕获 cookie 的 capture，
  // 保持「登录后跨 origin 恢复登录态」的旧行为。快照模式已自带 capture，不重复。
  const recipeAuth = isRecord(recipe.auth) ? recipe.auth : undefined;
  if (cookieSource && recipeAuth?.mode !== "snapshot") {
    const ops = spec.ops as Record<string, unknown>[];
    ops.push({ op: "auth.capture", as: "snapshot", cookies: [authKey] });
  }

  return { spec: spec as unknown as LoginSpec, warnings, migrated: true };
}

function trimString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function legacyExtractOp(
  source: string | undefined,
  key: string | undefined,
  warnings: string[],
): Record<string, unknown> | undefined {
  if (!source || !key) return undefined;
  const map = {
    cookie: "cookie",
    localStorage: "local",
    sessionStorage: "session",
  } as const;
  const mapped = map[source as keyof typeof map];
  if (!mapped) return undefined;
  // storage 提取先读 local 再回退 session。
  // 新模型必须显式选一个，键实际在 session 里的配置会因此失效 —— 必须告警。
  if (mapped === "local") {
    warnings.push(
      "认证数据提取已迁移为 localStorage：原实现会先读 localStorage 再回退 sessionStorage，" +
        "若目标键实际存在 sessionStorage 中，请把 extract 的来源改为 session",
    );
  }
  return { op: "extract", source: mapped, key, as: "auth" };
}

/** `strategyParams.cookieClear` 三态；未声明返回 undefined（沿用默认 all） */
function legacyCookieClear(
  raw: unknown,
): "all" | "none" | string[] | undefined {
  if (raw === "none") return "none";
  if (Array.isArray(raw)) return parseAuthRange(raw, "none");
  return undefined;
}
