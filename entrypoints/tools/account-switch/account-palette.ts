/**
 * 账号识别色板（10 色，亮/暗双主题）
 *
 * 同角色账号在列表中视觉上完全同质（角色 pill 相同），靠账号名文本区分成本高。
 * 本模块为每个账号按其「名称 + 用户名」的字符编码稳定取一个色：
 * 同一账号任何页面/任何时间都得到同一颜色，不同账号大概率落在不同颜色上。
 *
 * - 色板成对给出亮色（浅底深字）与暗色（深底亮字）token，
 *   渲染层用 CSS 变量切换，无需运行时感知主题。
 * - 全部 token 经 WCAG AA 校验：文字与其底色对比度 ≥ 4.5。
 * - 纯函数，零 DOM / storage 依赖，可单测。
 */
import type { Account } from './types';

/** 单个色板项：light/dark 各自是一对「底 + 字」 */
export interface AccountColor {
  /** 色名（仅调试/测试可读，不参与渲染） */
  label: string;
  light: { bg: string; fg: string };
  dark: { bg: string; fg: string };
}

/**
 * 10 色识别色板（从 20 色精简：色相均布、剔除红/玫红、蓝/靛蓝、翠绿/蓝绿等邻近对）。
 * 亮色取 100 级浅底 + 800 级深字；暗色取深色底 + 300 级亮字。
 * 「石板」保留为「空字符串 / 未识别」专用回退，不参与哈希取色。
 *
 * 语义 pin：生产环境（prod / 生产）由调用方钉到索引 0「红」，
 * 其他名字一律走 FNV-1a 哈希均布到剩余 10 色。
 */
export const ACCOUNT_COLORS: readonly AccountColor[] = [
  { label: '红',     light: { bg: '#fee2e2', fg: '#991b1b' }, dark: { bg: '#3f1a1a', fg: '#fca5a5' } },
  { label: '琥珀',   light: { bg: '#fef3c7', fg: '#92400e' }, dark: { bg: '#3a2e10', fg: '#fcd34d' } },
  { label: '青柠',   light: { bg: '#ecfccb', fg: '#3f6212' }, dark: { bg: '#26360f', fg: '#bef264' } },
  { label: '绿',     light: { bg: '#dcfce7', fg: '#166534' }, dark: { bg: '#14331d', fg: '#86efac' } },
  { label: '蓝绿',   light: { bg: '#ccfbf1', fg: '#115e59' }, dark: { bg: '#0f3532', fg: '#5eead4' } },
  { label: '青',     light: { bg: '#cffafe', fg: '#155e75' }, dark: { bg: '#11343d', fg: '#67e8f9' } },
  { label: '蓝',     light: { bg: '#dbeafe', fg: '#1e40af' }, dark: { bg: '#1b3153', fg: '#93c5fd' } },
  { label: '紫罗兰', light: { bg: '#ede9fe', fg: '#5b21b6' }, dark: { bg: '#2c2050', fg: '#c4b5fd' } },
  { label: '洋红',   light: { bg: '#fae8ff', fg: '#86198f' }, dark: { bg: '#3d1545', fg: '#f0abfc' } },
  { label: '棕',     light: { bg: '#f5e9d7', fg: '#6f3a0e' }, dark: { bg: '#3a2a17', fg: '#e8c49a' } },
];

/** 「空字符串 / 未识别」专用回退（石板）：不参与哈希取色 */
export const ACCOUNT_FALLBACK_COLOR: AccountColor = {
  label: '石板',
  light: { bg: '#e2e8f0', fg: '#1e293b' },
  dark: { bg: '#2a323d', fg: '#cbd5e1' },
};

/** 色池大小（渲染层与测试共享，避免魔法数字） */
export const ACCOUNT_COLOR_COUNT = ACCOUNT_COLORS.length;

/** 哈希池大小：索引 0（红）保留给 prod 环境 pin，哈希取色只用索引 1..9 */
export const ACCOUNT_COLOR_HASH_COUNT = ACCOUNT_COLOR_COUNT - 1;

/** 分隔符 U+001F（单元分隔符），名称/用户名里不可能出现 */
const KEY_SEP = '\u001f';

/**
 * 账号识别键：名称 + 用户名（大小写与首尾空白不影响取色）。
 *
 * 用不可见分隔符拼接，避免「ab + c」与「a + bc」拼出同一个键。
 * 不含 id：同一账号即使重建（id 变化）也保持同色；
 * 名称与用户名完全一致的重复账号本来就是同一条账号信息，共用颜色。
 */
export function accountColorKey(account: Pick<Account, 'name' | 'username'>): string {
  return `${account.name.trim()}${KEY_SEP}${account.username.trim()}`.toLowerCase();
}

/**
 * 取色索引：FNV-1a（逐 UTF-16 码元）+ murmur3 fmix32 雪崩。
 *
 * - FNV-1a 保证字符编码 → 32 位哈希稳定且实现极简；
 * - fmix32 打散低位，避免「张三/张三2」这类相邻文本在 `% 9` 后落在相邻槽；
 * - 返回 [1, 9]；索引 0 红保留给 prod 环境 pin，不参与哈希。
 */
export function accountColorIndex(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return 1 + ((h >>> 0) % (ACCOUNT_COLOR_COUNT - 1));
}

/** 账号 → 色板项（稳定、无副作用） */
export function accountColor(account: Pick<Account, 'name' | 'username'>): AccountColor {
  return ACCOUNT_COLORS[accountColorIndex(accountColorKey(account))];
}

/** 头像首字：优先名称，其次用户名；按码点截取（emoji 不裂开），拉丁字母转大写 */
export function accountInitial(account: Pick<Account, 'name' | 'username'>): string {
  const source = account.name.trim() || account.username.trim();
  if (!source) return '?';
  const first = Array.from(source)[0];
  return /[a-z]/i.test(first) ? first.toUpperCase() : first;
}

/**
 * 头像用的亮/暗 CSS 变量集合；渲染层据此在 `[data-dt-dark]` 下换色。
 * 带 `--${string}` 索引签名，才能直接作为 Vue `:style` 的 CSSProperties 使用。
 */
export type AccountColorStyle = {
  '--acc-light-bg': string;
  '--acc-light-fg': string;
  '--acc-dark-bg': string;
  '--acc-dark-fg': string;
  [key: `--${string}`]: string;
};

export function accountColorStyle(
  account: Pick<Account, 'name' | 'username'>,
): AccountColorStyle {
  const color = accountColor(account);
  return {
    '--acc-light-bg': color.light.bg,
    '--acc-light-fg': color.light.fg,
    '--acc-dark-bg': color.dark.bg,
    '--acc-dark-fg': color.dark.fg,
  };
}
