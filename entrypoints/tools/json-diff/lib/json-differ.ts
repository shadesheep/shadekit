/**
 * JSON 对比核心模块
 * 基于 fast-json-patch (RFC 6902) 和 json-source-map
 */

import { compare } from 'fast-json-patch';
import { parse as parseSourceMap } from 'json-source-map';
import { parseJsonError } from '../../../shared/json-error-parser';

export interface DiffEntry {
  op: 'add' | 'remove' | 'replace';
  path: string;
  value?: unknown;
  oldValue?: unknown;
}

export interface DiffResult {
  diffs: DiffEntry[];
  error?: string | null;
  differenceCount: number;
  isDifferent: boolean;
}

export interface DiffMarker {
  editor: 'left' | 'right';
  startLine: number;
  startCh: number;
  endLine: number;
  endCh: number;
  color: string;
  className: string;
  /** 来源 diff 在 diffs 数组中的下标，用于按差异（而非按标记）导航 */
  diffIndex: number;
}

/**
 * 对比两个 JSON 文本
 */
export function compareJson(leftText: string, rightText: string): DiffResult {
  let leftJson: unknown;
  let rightJson: unknown;

  try {
    leftJson = leftText.trim() ? JSON.parse(leftText) : undefined;
  } catch (e) {
    const jsonError = parseJsonError(e, leftText);
    const errorMsg = jsonError
      ? `左侧 JSON 不合法 (第 ${jsonError.line} 行，第 ${jsonError.column} 列): ${jsonError.message}\n上下文: ${jsonError.context}`
      : `左侧 JSON 不合法: ${e instanceof Error ? e.message : String(e)}`;
    return {
      diffs: [],
      error: errorMsg,
      differenceCount: 0,
      isDifferent: false,
    };
  }

  try {
    rightJson = rightText.trim() ? JSON.parse(rightText) : undefined;
  } catch (e) {
    const jsonError = parseJsonError(e, rightText);
    const errorMsg = jsonError
      ? `右侧 JSON 不合法 (第 ${jsonError.line} 行，第 ${jsonError.column} 列): ${jsonError.message}\n上下文: ${jsonError.context}`
      : `右侧 JSON 不合法: ${e instanceof Error ? e.message : String(e)}`;
    return {
      diffs: [],
      error: errorMsg,
      differenceCount: 0,
      isDifferent: false,
    };
  }

  if (!leftJson && !rightJson) {
    return {
      diffs: [],
      error: null,
      differenceCount: 0,
      isDifferent: false,
    };
  }

  if (!leftJson) {
    return {
      diffs: [],
      error: '请在左侧填入待比对的 JSON 内容',
      differenceCount: 0,
      isDifferent: false,
    };
  }

  if (!rightJson) {
    return {
      diffs: [],
      error: '请在右侧填入待比对的 JSON 内容',
      differenceCount: 0,
      isDifferent: false,
    };
  }

  try {
    const diffs = compare(
      leftJson as Record<string, unknown>,
      rightJson as Record<string, unknown>,
    ) as DiffEntry[];
    return {
      diffs,
      error: null,
      differenceCount: diffs.length,
      isDifferent: diffs.length > 0,
    };
  } catch (e) {
    return {
      diffs: [],
      error: `对比失败: ${e instanceof Error ? e.message : String(e)}`,
      differenceCount: 0,
      isDifferent: false,
    };
  }
}

/**
 * 根据 diff 结果生成编辑器高亮标记
 * 使用 json-source-map 将 JSON Pointer 路径映射到源码位置
 */
export function getDiffMarkers(
  diffs: DiffEntry[],
  leftText: string,
  rightText: string,
): DiffMarker[] {
  const markers: DiffMarker[] = [];

  let leftMap: { pointers: Record<string, any> };
  let rightMap: { pointers: Record<string, any> };

  try {
    leftMap = parseSourceMap(leftText);
  } catch {
    return markers;
  }

  try {
    rightMap = parseSourceMap(rightText);
  } catch {
    return markers;
  }

  for (let i = 0; i < diffs.length; i++) {
    const diff = diffs[i];
    try {
      if (diff.op === 'remove') {
        const ptr = diff.path === '' ? '' : diff.path;
        const pointer = leftMap.pointers[ptr];
        if (pointer?.key) {
          markers.push({
            editor: 'left',
            startLine: pointer.key.line,
            startCh: pointer.key.column,
            endLine: pointer.valueEnd.line,
            endCh: pointer.valueEnd.column,
            color: '#DD4444',
            className: 'diff-mark-left',
            diffIndex: i,
          });
        }
      } else if (diff.op === 'add') {
        const ptr = diff.path === '' ? '' : diff.path;
        const pointer = rightMap.pointers[ptr];
        if (pointer) {
          const startPos = pointer.key || pointer.value;
          const endPos = pointer.valueEnd;
          if (startPos && endPos) {
            markers.push({
              editor: 'right',
              startLine: startPos.line,
              startCh: startPos.column,
              endLine: endPos.line,
              endCh: endPos.column,
              color: '#4ba2ff',
              className: 'diff-mark-right',
              diffIndex: i,
            });
          }
        }
      } else if (diff.op === 'replace') {
        const ptr = diff.path === '' ? '' : diff.path;
        // 左侧标记为修改
        const leftPointer = leftMap.pointers[ptr];
        if (leftPointer?.value) {
          markers.push({
            editor: 'left',
            startLine: leftPointer.value.line,
            startCh: leftPointer.value.column,
            endLine: leftPointer.valueEnd.line,
            endCh: leftPointer.valueEnd.column,
            color: '#E5E833',
            className: 'diff-mark-replace',
            diffIndex: i,
          });
        }
        // 右侧标记为修改
        const rightPointer = rightMap.pointers[ptr];
        if (rightPointer?.value) {
          markers.push({
            editor: 'right',
            startLine: rightPointer.value.line,
            startCh: rightPointer.value.column,
            endLine: rightPointer.valueEnd.line,
            endCh: rightPointer.valueEnd.column,
            color: '#E5E833',
            className: 'diff-mark-replace',
            diffIndex: i,
          });
        }
      }
    } catch {
      // 单条 diff 标记失败不影响其他条目
    }
  }

  return markers;
}
