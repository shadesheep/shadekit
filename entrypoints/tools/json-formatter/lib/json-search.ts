/**
 * json-search（ADR-0004 D3）
 * 格式化输出树内的搜索：匹配收集 / 高亮清除 / 当前匹配激活 / 环形索引。
 * 直接操作输出容器 DOM（.item 节点），但不依赖任何 Vue 状态。
 */

/** 按 textContent 大小写不敏感匹配 .item；命中项加 search-match 类并返回。调用时自动清除旧高亮。 */
export function findMatches(container: HTMLElement, term: string): HTMLElement[] {
  clearHighlights(container);

  const q = term.toLowerCase();
  const matches: HTMLElement[] = [];
  container.querySelectorAll('.item').forEach((item) => {
    const text = item.textContent || '';
    if (text.toLowerCase().includes(q)) {
      item.classList.add('search-match');
      matches.push(item as HTMLElement);
    }
  });
  return matches;
}

/** 清除容器内全部搜索高亮（search-match / current-match） */
export function clearHighlights(container: HTMLElement): void {
  container.querySelectorAll('.search-match, .current-match').forEach((el) => {
    el.classList.remove('search-match', 'current-match');
  });
}

/** 激活第 index 个匹配：滚动到可视区中央并独占 current-match 类 */
export function activateMatch(matches: HTMLElement[], index: number): void {
  if (matches.length === 0) return;
  const match = matches[index];
  if (!match) return;
  match.scrollIntoView({ behavior: 'smooth', block: 'center' });
  for (const el of matches) el.classList.remove('current-match');
  match.classList.add('current-match');
}

/** 环形步进：delta=±1 在 [0, length) 内回绕 */
export function stepIndex(current: number, delta: 1 | -1, length: number): number {
  return (current + delta + length) % length;
}
