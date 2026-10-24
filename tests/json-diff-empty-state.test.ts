import { describe, expect, it } from 'vitest';
import {
  exampleSideFill,
  isEmptyDoc,
  shouldShowEmptyState,
} from '../entrypoints/tools/json-diff/lib/empty-state';

describe('isEmptyDoc', () => {
  it('空文本为空', () => {
    expect(isEmptyDoc('')).toBe(true);
  });

  it('仅空白字符视为空', () => {
    expect(isEmptyDoc('   \n\t  ')).toBe(true);
  });

  it('有内容不为空', () => {
    expect(isEmptyDoc('{}')).toBe(false);
    expect(isEmptyDoc('  {"a":1}  ')).toBe(false);
  });
});

describe('shouldShowEmptyState', () => {
  it('空文档且未拖拽时显示', () => {
    expect(shouldShowEmptyState(true, false)).toBe(true);
  });

  it('有内容不显示', () => {
    expect(shouldShowEmptyState(false, false)).toBe(false);
  });

  it('拖拽中不显示（让位给拖放遮罩）', () => {
    expect(shouldShowEmptyState(true, true)).toBe(false);
  });
});

describe('exampleSideFill', () => {
  const example = {
    left: { a: 1 },
    right: { a: 2 },
  };

  it('左侧取 example.left 并格式化为 2 空格缩进', () => {
    expect(exampleSideFill(example, 'left')).toBe(JSON.stringify(example.left, null, 2));
  });

  it('右侧取 example.right', () => {
    expect(exampleSideFill(example, 'right')).toBe(JSON.stringify(example.right, null, 2));
  });
});
