import { describe, expect, it } from 'vitest';
import { listNavKeydown } from '../entrypoints/shared/list-nav';

describe('listNavKeydown', () => {
  describe('ArrowDown', () => {
    it('无选中时按 ↓ 选中第一项', () => {
      expect(listNavKeydown('ArrowDown', -1, 3)).toEqual({ type: 'move', index: 0 });
    });

    it('中间位置按 ↓ 移到下一项', () => {
      expect(listNavKeydown('ArrowDown', 0, 3)).toEqual({ type: 'move', index: 1 });
    });

    it('末项按 ↓ 停在末项（不循环）', () => {
      expect(listNavKeydown('ArrowDown', 2, 3)).toEqual({ type: 'move', index: 2 });
    });
  });

  describe('ArrowUp', () => {
    it('无选中时按 ↑ 选中第一项', () => {
      expect(listNavKeydown('ArrowUp', -1, 3)).toEqual({ type: 'move', index: 0 });
    });

    it('中间位置按 ↑ 移到上一项', () => {
      expect(listNavKeydown('ArrowUp', 2, 3)).toEqual({ type: 'move', index: 1 });
    });

    it('首项按 ↑ 停在首项（不循环）', () => {
      expect(listNavKeydown('ArrowUp', 0, 3)).toEqual({ type: 'move', index: 0 });
    });
  });

  describe('Enter', () => {
    it('有选中时 Enter 返回 select 动作', () => {
      expect(listNavKeydown('Enter', 1, 3)).toEqual({ type: 'select', index: 1 });
    });

    it('无选中时 Enter 不动作', () => {
      expect(listNavKeydown('Enter', -1, 3)).toBeNull();
    });
  });

  describe('边界情况', () => {
    it('其他按键返回 null', () => {
      expect(listNavKeydown('a', 0, 3)).toBeNull();
      expect(listNavKeydown('Escape', 0, 3)).toBeNull();
      expect(listNavKeydown('Tab', 0, 3)).toBeNull();
    });

    it('空列表任何按键都返回 null', () => {
      expect(listNavKeydown('ArrowDown', -1, 0)).toBeNull();
      expect(listNavKeydown('ArrowUp', -1, 0)).toBeNull();
      expect(listNavKeydown('Enter', 0, 0)).toBeNull();
    });
  });
});
