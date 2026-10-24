/**
 * json-diff 空态引导的判定逻辑（与 UI 解耦，便于单测）。
 */

/** 文档是否为空（仅空白字符也算空）。 */
export function isEmptyDoc(text: string): boolean {
  return text.trim().length === 0;
}

/**
 * 是否显示空态：文档为空且未处于拖拽悬停中。
 * 拖拽悬停时让位给 drop-overlay，避免两层遮罩叠加。
 */
export function shouldShowEmptyState(isEmpty: boolean, isDragging: boolean): boolean {
  return isEmpty && !isDragging;
}

/** 「填入示例」：生成指定侧示例的格式化 JSON。 */
export function exampleSideFill(
  example: { left: unknown; right: unknown },
  side: 'left' | 'right',
): string {
  return JSON.stringify(side === 'left' ? example.left : example.right, null, 2);
}
