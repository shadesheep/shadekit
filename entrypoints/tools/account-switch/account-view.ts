/**
 * Account View Model(ADR-0004 D6)
 *
 * Config.vue、SwitcherPanel 与 background 共享的账号视图纯函数 module。
 * 收口的领域规则:三段过滤(域 → 角色 → 搜索)、密码回退优先级、
 * 角色色表(唯一来源)、账号形状归一化(adapter)、
 * 环境匹配链(origin → 环境 → 默认密码回退)。
 *
 * 全部为纯函数,不触碰 chrome.* / storage / DOM。
 */
import type {
  Account,
  AccountSwitchConfig,
  DomainConfig,
  EnvBadgeConfig,
  StrategyEntry,
} from './types';
import { ACCOUNT_COLORS, ACCOUNT_FALLBACK_COLOR, accountColorIndex } from './account-palette';
import { matchDomain } from './utils/env';
import {
  inspectLoginSpecSupport,
  type SpecSupportReport,
} from './spec/capabilities';
import {
  requireSupportedLoginSpec,
  type SpecDocument,
} from './spec/document';
import { migrateSpec, readSpecFromConfig } from './spec/migrate';
import { LOGIN_SPEC_VERSION, type LoginSpec } from './spec/types';

// ============================================================
// Content Script 公共面板 DTO
// ============================================================

export interface PublicAccount {
  id: string;
  name: string;
  username: string;
  roles: string[];
  /** 只表示是否存在已保存凭据，不包含引用 ID 或秘密值。 */
  hasSavedPassword: boolean;
}

export interface PublicEnvironment {
  name: string;
  tags: string[];
  loginMethod?: string;
  debugRedirect?: string;
  debugRedirectEnabled: boolean;
  hasDefaultPassword: boolean;
  /**
   * 仅在实际声明当前客户端无法执行时存在；每次读取从原始私有/镜像文档
   * 重新派生，只携带公开错误码与文案，不包含原始声明或绑定。
   */
  support?: SpecSupportReport;
}

// ============================================================
// 登录能力（公共投影 + 后台执行前置门）
// ============================================================

/** 环境中决定执行能力的原始文档及其本地版本来源。 */
export interface StoredLoginDocument {
  /** 原始存储文档；不支持时按原样保留，不做迁移或归一化。 */
  raw: SpecDocument;
  /** 策略包顶层 specVersion 的本地来源，不写回原始声明。 */
  declaredSpecVersion?: number;
}

/**
 * 解析环境实际使用的原始声明：环境私有声明优先，其次镜像的策略库条目。
 * 旧配方 / 扁平参数不在此返回（由既有迁移链负责）。
 */
export function resolveStoredLoginDocument(
  environment: DomainConfig,
  strategies?: Record<string, StrategyEntry>,
): StoredLoginDocument | null {
  const privateSpec = environment.strategyConfig?.spec;
  if (privateSpec !== undefined && privateSpec !== null) {
    const declaredSpecVersion = environment.strategyConfig?.declaredSpecVersion;
    return {
      raw: privateSpec,
      ...(declaredSpecVersion === undefined ? {} : { declaredSpecVersion }),
    };
  }
  const mirror = environment.strategyId
    ? strategies?.[environment.strategyId]
    : undefined;
  if (mirror?.spec === undefined || mirror.spec === null) return null;
  return {
    raw: mirror.spec,
    ...(mirror.declaredSpecVersion === undefined
      ? {}
      : { declaredSpecVersion: mirror.declaredSpecVersion }),
  };
}

/**
 * v1 是已知迁移输入（见 `migrateExecutableSpec`）：显式声明版本缺失时
 * 由读取链升级到当前版本，不能因当前客户端只执行 v2 而在迁移前拒绝。
 */
function isLegacyLoginDocument(document: StoredLoginDocument): boolean {
  const version = typeof document.raw === 'object' && document.raw !== null
    ? (document.raw as { version?: unknown }).version
    : undefined;
  return document.declaredSpecVersion === undefined
    && typeof version === 'number'
    && version < LOGIN_SPEC_VERSION;
}

/** 原始文档能力；旧版本先做仅升级用途的迁移，再判断当前客户端能否执行。 */
function inspectStoredLoginSupport(
  document: StoredLoginDocument,
): SpecSupportReport {
  const support = inspectLoginSpecSupport(
    document.raw,
    document.declaredSpecVersion,
  );
  if (support.supported || !isLegacyLoginDocument(document)) return support;

  try {
    const migrated = migrateSpec(document.raw);
    if (!migrated.ok) return support;
    requireSupportedLoginSpec(migrated.spec, document.declaredSpecVersion);
    return { supported: true, issues: [] };
  } catch {
    return support;
  }
}

/**
 * 环境声明的执行能力（每次读取重新派生，绝不持久化 support 标志）。
 * 未配置原始声明时返回 supported=true，交由既有配置读取链报告具体原因。
 */
export function environmentLoginSupport(
  environment: DomainConfig,
  strategies?: Record<string, StrategyEntry>,
): SpecSupportReport {
  const document = resolveStoredLoginDocument(environment, strategies);
  return document
    ? inspectStoredLoginSupport(document)
    : { supported: true, issues: [] };
}

/** 公共文案：逐条列出能力缺口（算子/算法附带步骤号）。 */
export function supportReason(support: SpecSupportReport): string {
  return support.issues
    .map((issue) =>
      issue.opIndex === undefined
        ? issue.message
        : `${issue.message}（第 ${issue.opIndex + 1} 步）`,
    )
    .join("；");
}

/**
 * 执行前置门：在任何权限、tab、导航、HTTP、会话写入或秘密解析之前，
 * 确认环境声明的原始文档可由当前客户端执行，并返回窄化后的 LoginSpec。
 *
 * 私有声明优先于镜像策略；支持后才交给 `requireSupportedLoginSpec`
 * 做结构校验。旧配方/扁平参数走既有迁移链（迁移链自身带能力门）。
 */
export function assertEnvironmentLoginSupported(
  environment: DomainConfig,
  strategies?: Record<string, StrategyEntry>,
): LoginSpec {
  const document = resolveStoredLoginDocument(environment, strategies);
  if (document) {
    // 旧版本声明先走既有迁移链升级；迁移后的结果仍由能力/结构门窄化。
    if (isLegacyLoginDocument(document)) {
      const { spec } = readSpecFromConfig(environment, strategies);
      if (spec) return spec;
    }
    return requireSupportedLoginSpec(document.raw, document.declaredSpecVersion);
  }
  const { spec, invalid } = readSpecFromConfig(environment, strategies);
  if (spec) return spec;
  const legacy = (environment.loginMethod ?? "").includes("@");
  throw Object.assign(
    new Error(invalid ?? "未配置登录策略：请在环境配置中为该域名选择登录方式"),
    { code: legacy ? "STRATEGY_NOT_FOUND" : "NO_STRATEGY" },
  );
}

export interface AccountPanelData {
  origin: string;
  matchedEnvKey: string;
  accounts: PublicAccount[];
  domains: Record<string, PublicEnvironment>;
  tabOrder: ('users' | 'quicklogin')[];
  quickLoginDefaultDomain: string;
  hasGlobalDefaultPassword: boolean;
  envBadge: EnvBadgeConfig;
}

/**
 * Background → Content Script 的唯一面板投影。完整配置留在受控运行层；
 * 其他环境只提供快捷登录匹配所需的公开摘要，账号只投影当前 origin。
 */
export function buildAccountPanel(
  config: AccountSwitchConfig,
  origin: string,
): AccountPanelData {
  const resolved = resolveEnvironment(origin, config.domains ?? {});
  const domains = Object.fromEntries(
    Object.entries(config.domains ?? {}).map(([id, env]) => {
      const support = environmentLoginSupport(env, config.strategies);
      return [
        id,
        {
          name: env.name,
          tags: Array.isArray(env.tags) ? [...env.tags] : [],
          ...(env.loginMethod ? { loginMethod: env.loginMethod } : {}),
          ...(env.debugRedirect ? { debugRedirect: env.debugRedirect } : {}),
          debugRedirectEnabled: env.debugRedirectEnabled === true,
          hasDefaultPassword: Boolean(env.defaultCredentialRef || env.defaultPassword),
          // 只在不支持时出现；支持的声明不携带任何多余标志。
          ...(support.supported ? {} : { support }),
        },
      ];
    }),
  );
  const accounts = filterAccounts(
    (config.accounts ?? []).map(normalizeAccount),
    { origin },
  ).map((account) => ({
    id: account.id,
    name: account.name,
    username: account.username,
    roles: [...account.roles],
    hasSavedPassword: Boolean(account.credentialRef || account.password),
  }));
  const tabOrder: AccountPanelData['tabOrder'] =
    Array.isArray(config.tabOrder) && config.tabOrder.length === 2
      ? [...config.tabOrder]
      : ['users', 'quicklogin'];
  return {
    origin,
    matchedEnvKey: resolved?.domain ?? '',
    accounts,
    domains,
    tabOrder,
    quickLoginDefaultDomain: config.quickLoginDefaultDomain ?? '',
    hasGlobalDefaultPassword: Boolean(config.globalDefaultCredentialRef || config.globalDefaultPassword),
    envBadge: config.envBadge ?? { enabled: false, position: "bottom-right", whitelist: [] },
  };
}

// ============================================================
// 角色色（唯一来源）
// ============================================================

/**
 * 预定义角色名列表（角色选择器等 UI 使用）。
 * 顺序即展示顺序；取色由 ROLE_COLOR_PIN pin 表固定（管理员→琥珀、普通用户→蓝、访客→石板）。
 */
export const ROLE_NAMES: string[] = ['管理员', '普通用户', '访客'];

/** 未知/空角色的回退色（石板，专用回退槽，不参与哈希） */
const ROLE_FALLBACK = ACCOUNT_FALLBACK_COLOR;

/** 预设角色 → 色板索引 pin（同名恒同色；自定义角色走哈希） */
const ROLE_COLOR_PIN: Readonly<Record<string, number | 'fallback'>> = {
  '管理员': 1,      // 琥珀（警示）
  '普通用户': 6,    // 蓝（中性主色）
  '访客': 'fallback', // 石板（中性灰）
};

/**
 * 预设角色走 pin 表（管理员→琥珀、普通用户→蓝、访客→石板）；
 * 自定义角色按名哈希取色池索引 1–9。
 */
function rolePaletteColor(role: string) {
  const key = role.trim();
  if (!key) return ROLE_FALLBACK;
  const pinned = ROLE_COLOR_PIN[key];
  if (pinned === 'fallback') return ROLE_FALLBACK;
  if (typeof pinned === 'number') return ACCOUNT_COLORS[pinned];
  return ACCOUNT_COLORS[accountColorIndex(key.toLowerCase())];
}

/** 角色强调色（取色板亮色主题的 fg，未知角色回退石板） */
export function roleColor(role: string): string {
  return rolePaletteColor(role).light.fg;
}

/**
 * 角色标签用的亮/暗 CSS 变量集合；渲染层据此在 `[data-dt-dark]` 下换色。
 * 与账号头像同色板，保证「同色板、同哈希、同观感」。
 */
export type RoleColorStyle = {
  '--role-light-bg': string;
  '--role-light-fg': string;
  '--role-dark-bg': string;
  '--role-dark-fg': string;
  [key: `--${string}`]: string;
};

export function roleColorStyle(role: string): RoleColorStyle {
  const color = rolePaletteColor(role);
  return {
    '--role-light-bg': color.light.bg,
    '--role-light-fg': color.light.fg,
    '--role-dark-bg': color.dark.bg,
    '--role-dark-fg': color.dark.fg,
  };
}

// ============================================================
// 归一化（adapter：配置原始形状 → Account）
// ============================================================

/** 配置中存储的账号原始形状（password 为旧版可选字段） */
export interface RawAccount {
  id: string;
  name: string;
  username: string;
  password?: string;
  credentialRef?: string;
  roles?: string[];
  domains: string[];
}

/**
 * 归一化配置中的账号为 Account：
 * - roles 缺失/非数组时兜底 []
 * - password 仅在旧配置实际存在时保留；新账号不凭空写入空明文密码
 */
export function normalizeAccount(raw: RawAccount): Account {
  const roles = Array.isArray(raw.roles) ? raw.roles : [];
  return {
    ...raw,
    ...(raw.password !== undefined ? { password: raw.password } : {}),
    roles,
  };
}

// ============================================================
// 三段过滤（域 → 角色 → 搜索）
// ============================================================

export interface AccountFilter {
  /** 当前页面 origin；空值不做域过滤 */
  origin?: string;
  /** 角色筛选；null/undefined 不过滤 */
  role?: string | null;
  /** 搜索关键词（匹配 name / username，大小写不敏感） */
  query?: string;
}

export interface FilterableAccount {
  name: string;
  username: string;
  roles: string[];
  domains?: string[];
}

/** 三段过滤：域（origin）→ 角色（role）→ 搜索（query），各段独立可选 */
export function filterAccounts<T extends FilterableAccount>(accounts: T[], filter: AccountFilter): T[] {
  if (!Array.isArray(accounts)) return [];
  let result = accounts;

  if (filter.origin) {
    const origin = filter.origin;
    result = result.filter((acc) => acc.domains?.some((d) => matchDomain(d, origin)));
  }

  if (filter.role) {
    const role = filter.role;
    result = result.filter((acc) => acc.roles.includes(role));
  }

  if (filter.query) {
    const q = filter.query.toLowerCase();
    result = result.filter(
      (acc) =>
        acc.name.toLowerCase().includes(q) ||
        acc.username.toLowerCase().includes(q),
    );
  }

  return result;
}

/** 从账号列表提取去重后的角色集合（保持出现顺序；脏数据 roles 非数组时跳过） */
export function collectRoles(accounts: { roles: string[] }[]): string[] {
  const roleSet = new Set<string>();
  for (const acc of accounts) {
    if (!Array.isArray(acc.roles)) continue;
    for (const r of acc.roles) roleSet.add(r);
  }
  return Array.from(roleSet);
}

/**
 * 角色筛选选项：只保留账号数据中实际出现的角色（没有账号使用的预设不展示），
 * 预设角色按 ROLE_NAMES 顺序在前，自定义角色按首次出现顺序在后。
 */
export function collectRoleFilterOptions(accounts: Account[]): string[] {
  if (!Array.isArray(accounts)) return [];
  const used = collectRoles(accounts);
  const usedSet = new Set(used);
  return [
    ...ROLE_NAMES.filter((r) => usedSet.has(r)),
    ...used.filter((r) => !ROLE_NAMES.includes(r)),
  ];
}

// ============================================================
// 密码回退优先级
// ============================================================

export interface PasswordSources {
  /** 用户显式输入（表单） */
  input?: string;
  /** 匹配环境的默认密码 */
  envDefault?: string;
  /** 全局默认密码（最后回退） */
  globalDefault?: string;
}

/**
 * 密码回退优先级：用户输入 > 环境默认 > 全局默认。
 * 空字符串视为未提供；三级全缺返回 undefined。
 */
export function resolvePassword(sources: PasswordSources): string | undefined {
  return sources.input || sources.envDefault || sources.globalDefault || undefined;
}

// ============================================================
// 环境匹配链(origin → 环境 → 默认密码回退)
// ============================================================

export interface ResolvedEnvironment<T = DomainConfig> {
  /** 匹配到的 domains 配置 key(原样返回,供账号关联/去重使用) */
  domain: string;
  /** 匹配到的环境配置 */
  env: T;
}

/**
 * 按 origin 匹配已配置环境:取第一个 matchDomain 命中的 domain。
 * 无匹配或 origin 为空返回 undefined(调用方静默降级)。
 */
export function resolveEnvironment<T>(
  origin: string,
  domains: Record<string, T>,
): ResolvedEnvironment<T> | undefined {
  if (!origin) return undefined;
  for (const [domain, env] of Object.entries(domains ?? {})) {
    if (matchDomain(domain, origin)) return { domain, env };
  }
  return undefined;
}
