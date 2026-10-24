// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

/**
 * json-search 测试（ADR-0004 D3）
 * 输出树内的搜索：匹配收集 / 高亮清除 / 当前匹配激活 / 环形索引。
 */

import {
  findMatches,
  clearHighlights,
  activateMatch,
  stepIndex,
} from '../entrypoints/tools/json-formatter/lib/json-search';

function makeContainer(): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = `
    <div class="item">{"name": "张三"}</div>
    <div class="item">{"name": "李四"}</div>
    <div class="item">{"city": "北京"}</div>
  `;
  document.body.appendChild(container);
  return container;
}

beforeAll(() => {
  // jsdom 未实现 scrollIntoView
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('findMatches', () => {
  it('按 textContent 大小写不敏感匹配 .item，命中项加 search-match 类', () => {
    const container = makeContainer();
    const matches = findMatches(container, 'NAME');
    expect(matches).toHaveLength(2);
    for (const m of matches) expect(m.classList.contains('search-match')).toBe(true);
  });

  it('无命中返回空数组', () => {
    const container = makeContainer();
    expect(findMatches(container, '不存在')).toEqual([]);
  });

  it('调用前清除旧高亮（重复搜索不残留）', () => {
    const container = makeContainer();
    findMatches(container, 'name');
    const matches = findMatches(container, '北京');
    expect(matches).toHaveLength(1);
    expect(container.querySelectorAll('.search-match')).toHaveLength(1);
  });
});

describe('clearHighlights', () => {
  it('移除 search-match 与 current-match 类', () => {
    const container = makeContainer();
    const matches = findMatches(container, 'name');
    activateMatch(matches, 0);
    clearHighlights(container);
    expect(container.querySelectorAll('.search-match, .current-match')).toHaveLength(0);
  });
});

describe('activateMatch', () => {
  it('目标项加 current-match，其余移除', () => {
    const container = makeContainer();
    const matches = findMatches(container, 'name');
    activateMatch(matches, 1);
    expect(matches[0].classList.contains('current-match')).toBe(false);
    expect(matches[1].classList.contains('current-match')).toBe(true);
  });

  it('空匹配列表为 no-op', () => {
    expect(() => activateMatch([], 0)).not.toThrow();
  });
});

describe('stepIndex — 环形导航', () => {
  it('前进到末尾回绕到 0', () => {
    expect(stepIndex(2, 1, 3)).toBe(0);
  });

  it('后退到 0 之前回绕到末尾', () => {
    expect(stepIndex(0, -1, 3)).toBe(2);
  });

  it('常规步进', () => {
    expect(stepIndex(0, 1, 3)).toBe(1);
    expect(stepIndex(2, -1, 3)).toBe(1);
  });
});
