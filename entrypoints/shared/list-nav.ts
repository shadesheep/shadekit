/**
 * 列表键盘导航（↑↓ 移动、Enter 选中）的纯逻辑。
 *
 * 语义与账号切换面板（SwitcherPanel）保持一致：
 * - current = -1 表示无选中；首次按 ↓/↑ 选中第 0 项
 * - 到达边界后停在边界（不循环）
 * - Enter 仅在有选中项时返回 select
 */

export type ListNavAction =
  | { type: 'move'; index: number }
  | { type: 'select'; index: number };

/**
 * 根据按键计算导航动作。
 * @param key - KeyboardEvent.key
 * @param current - 当前选中索引，-1 表示无选中
 * @param count - 列表项总数
 * @returns 导航动作；无需处理的按键返回 null
 */
export function listNavKeydown(
  key: string,
  current: number,
  count: number,
): ListNavAction | null {
  if (count <= 0) return null;
  if (key === 'ArrowDown') {
    return { type: 'move', index: Math.min(current + 1, count - 1) };
  }
  if (key === 'ArrowUp') {
    return { type: 'move', index: Math.max(current - 1, 0) };
  }
  if (key === 'Enter' && current >= 0 && current < count) {
    return { type: 'select', index: current };
  }
  return null;
}
