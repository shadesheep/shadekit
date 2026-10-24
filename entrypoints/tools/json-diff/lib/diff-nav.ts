/**
 * 差异导航位置构建
 * 从 DiffMarker 列表生成「上一处/下一处差异」导航用的位置表。
 */

import type { DiffMarker } from './json-differ';

export interface DiffPosition {
  diffIndex: number;
  /** 左侧编辑器中的行号（0 起始）；该差异在左侧无标记时缺省 */
  left?: number;
  /** 右侧编辑器中的行号（0 起始）；该差异在右侧无标记时缺省 */
  right?: number;
}

/**
 * 按 diffIndex 聚合 marker：一处差异（尤其 replace）会同时产生左右两个 marker，
 * 导航时需要两侧行号，以便同时滚动/高亮左右编辑器。
 */
export function buildDiffPositions(markers: DiffMarker[]): DiffPosition[] {
  const byDiffIndex = new Map<number, DiffPosition>();
  for (const m of markers) {
    let pos = byDiffIndex.get(m.diffIndex);
    if (!pos) {
      pos = { diffIndex: m.diffIndex };
      byDiffIndex.set(m.diffIndex, pos);
    }
    const line = m.startLine;
    if (m.editor === 'left') {
      pos.left = pos.left === undefined ? line : Math.min(pos.left, line);
    } else {
      pos.right = pos.right === undefined ? line : Math.min(pos.right, line);
    }
  }
  return [...byDiffIndex.values()].sort((a, b) => {
    const aLine = a.left ?? a.right ?? 0;
    const bLine = b.left ?? b.right ?? 0;
    return aLine - bLine;
  });
}
