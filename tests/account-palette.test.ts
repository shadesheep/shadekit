import { describe, it, expect } from 'vitest';
import {
  ACCOUNT_COLORS,
  ACCOUNT_COLOR_COUNT,
  ACCOUNT_COLOR_HASH_COUNT,
  accountColor,
  accountColorIndex,
  accountColorKey,
  accountColorStyle,
  accountInitial,
} from '../entrypoints/tools/account-switch/account-palette';

/**
 * 账号识别色板测试
 *
 * - 色池固定 10 色 + 1 个「石板」回退槽（不参与哈希）
 * - 亮/暗成对且 WCAG AA 可读
 * - 取色由「名称 + 用户名」字符编码稳定决定，不受大小写/首尾空白影响
 * - 头像首字按码点截取
 */

/** WCAG 相对亮度 */
function luminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/../g)!
    .map((h) => Number.parseInt(h, 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** WCAG 对比度 */
function contrast(a: string, b: string): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

describe('ACCOUNT_COLORS — 10 色池', () => {
  it('固定 10 色', () => {
    expect(ACCOUNT_COLOR_COUNT).toBe(10);
    expect(ACCOUNT_COLORS).toHaveLength(10);
  });

  it('哈希池 9 色（索引 0 红保留）', () => {
    expect(ACCOUNT_COLOR_HASH_COUNT).toBe(9);
  });

  it('每色都有亮/暗两套十六进制 token，且底/字不相同', () => {
    for (const color of ACCOUNT_COLORS) {
      for (const theme of [color.light, color.dark]) {
        expect(theme.bg).toMatch(/^#[0-9a-f]{6}$/i);
        expect(theme.fg).toMatch(/^#[0-9a-f]{6}$/i);
        expect(theme.bg).not.toBe(theme.fg);
      }
    }
  });

  it('亮色与暗色底色互不重复（10 个可区分槽位）', () => {
    expect(new Set(ACCOUNT_COLORS.map((c) => c.light.bg)).size).toBe(10);
    expect(new Set(ACCOUNT_COLORS.map((c) => c.dark.bg)).size).toBe(10);
  });

  it('亮/暗两套配色均满足 WCAG AA（文字对比度 ≥ 4.5）', () => {
    for (const color of ACCOUNT_COLORS) {
      expect(contrast(color.light.bg, color.light.fg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(color.dark.bg, color.dark.fg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('索引 0 固定为红（prod 环境 pin 用）', () => {
    expect(ACCOUNT_COLORS[0].label).toBe('红');
  });
});

describe('accountColorKey / accountColorIndex', () => {
  it('识别键包含名称与用户名', () => {
    const key = accountColorKey({ name: '张三', username: 'zhangsan' });
    expect(key).toContain('张三');
    expect(key).toContain('zhangsan');
  });

  it('不会把「ab+c」与「a+bc」拼成同一个键（分隔符防歧义）', () => {
    expect(accountColorKey({ name: 'ab', username: 'c' })).not.toBe(
      accountColorKey({ name: 'a', username: 'bc' }),
    );
  });

  it('大小写与首尾空白不影响取色', () => {
    expect(accountColorKey({ name: '  Zhang ', username: ' San ' })).toBe(
      accountColorKey({ name: 'zhang', username: 'san' }),
    );
  });

  it('对任意字符串（含空串、emoji、超长文本）落在 [1, 9]', () => {
    const seeds = ['', ' ', '张三', '🙂', 'a'.repeat(500), '中文😀mixed'];
    for (const seed of seeds) {
      const idx = accountColorIndex(seed);
      expect(Number.isInteger(idx)).toBe(true);
      expect(idx).toBeGreaterThanOrEqual(1);
      expect(idx).toBeLessThan(10);
    }
  });

  it('连续 100 个种子均不命中索引 0（红保留）', () => {
    for (let i = 0; i < 100; i++) {
      expect(accountColorIndex(`seed-${i}`)).not.toBe(0);
    }
  });

  it('同一账号多次取色结果一致（跨页面稳定）', () => {
    const account = { name: '张三', username: 'zhangsan' };
    expect(accountColor(account)).toBe(accountColor({ ...account }));
    expect(accountColorIndex(accountColorKey(account))).toBe(
      accountColorIndex(accountColorKey({ ...account })),
    );
  });

  it('同角色批量账号能分散到多个颜色（10 个账号至少 4 色）', () => {
    const accounts = Array.from({ length: 10 }, (_, i) => ({
      name: `测试账号${i + 1}`,
      username: `test${i + 1}`,
    }));
    const used = new Set(accounts.map((a) => accountColorIndex(accountColorKey(a))));
    expect(used.size).toBeGreaterThanOrEqual(4);
  });
});

describe('accountInitial — 头像首字', () => {
  it('中文取第一个字', () => {
    expect(accountInitial({ name: '张三', username: 'zhangsan' })).toBe('张');
  });

  it('名称为空时回退用户名，拉丁字母转大写', () => {
    expect(accountInitial({ name: '', username: 'admin' })).toBe('A');
  });

  it('emoji 按完整码点截取，不裂开代理对', () => {
    expect(accountInitial({ name: '🙂测试', username: 'x' })).toBe('🙂');
  });

  it('名称与用户名都为空时显示占位符', () => {
    expect(accountInitial({ name: '  ', username: '' })).toBe('?');
  });
});

describe('accountColorStyle — 渲染用 CSS 变量', () => {
  it('四个变量与色板项一一对应', () => {
    const account = { name: '张三', username: 'zhangsan' };
    const color = accountColor(account);
    expect(accountColorStyle(account)).toEqual({
      '--acc-light-bg': color.light.bg,
      '--acc-light-fg': color.light.fg,
      '--acc-dark-bg': color.dark.bg,
      '--acc-dark-fg': color.dark.fg,
    });
  });
});
