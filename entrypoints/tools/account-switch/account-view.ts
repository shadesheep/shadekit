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
import type { Account, DomainConfig } from './types';
import { ACCOUNT_COLORS, ACCOUNT_FALLBACK_COLOR, accountColorIndex } from './account-palette';
import { matchDomain } from './utils/env';

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

/** 配置中存储的账号原始形状（password 可选） */
export interface RawAccount {
  id: string;
  name: string;
  username: string;
  password?: string;
  roles?: string[];
  domains: string[];
}

/**
 * 归一化配置中的账号为 Account：
 * - roles 缺失/非数组时兜底 []
 * - password 缺失归一化为 ''
 */
export function normalizeAccount(raw: RawAccount): Account {
  const roles = Array.isArray(raw.roles) ? raw.roles : [];
  return { ...raw, password: raw.password ?? '', roles };
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

/** 三段过滤：域（origin）→ 角色（role）→ 搜索（query），各段独立可选 */
export function filterAccounts(accounts: Account[], filter: AccountFilter): Account[] {
  if (!Array.isArray(accounts)) return [];
  let result = accounts;

  if (filter.origin) {
    const origin = filter.origin;
    result = result.filter((acc) => acc.domains.some((d) => matchDomain(d, origin)));
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
export function collectRoles(accounts: Account[]): string[] {
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

export interface ResolvedEnvironment {
  /** 匹配到的 domains 配置 key(原样返回,供账号关联/去重使用) */
  domain: string;
  /** 匹配到的环境配置 */
  env: DomainConfig;
}

/**
 * 按 origin 匹配已配置环境:取第一个 matchDomain 命中的 domain。
 * 无匹配或 origin 为空返回 undefined(调用方静默降级)。
 */
export function resolveEnvironment(
  origin: string,
  domains: Record<string, DomainConfig>,
): ResolvedEnvironment | undefined {
  if (!origin) return undefined;
  for (const [domain, env] of Object.entries(domains ?? {})) {
    if (matchDomain(domain, origin)) return { domain, env };
  }
  return undefined;
}
