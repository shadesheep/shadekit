/**
 * JSON 键排序模块
 * 从 FeHelper json-abc.js 改写为 TypeScript
 */

import { isBigNumberLike } from './json-utils';

/**
 * 递归排序 JSON 对象的键
 * @param obj 需要排序的对象
 * @param asc 排序方向: 1 = 升序, -1 = 降序
 * @param noArray 是否跳过数组排序
 */
export function sortObj(obj: unknown, asc: number, noArray = false): unknown {
  const direction = asc !== -1 ? 1 : -1;

  // BigNumber 对象不参与排序
  if (isBigNumberLike(obj)) return obj;

  if (Array.isArray(obj)) {
    const sorted = noArray ? [...obj] : [...obj].sort();

    const result = sorted.map((v) => sortObj(v, asc, noArray));

    if (!noArray) {
      result.sort((a, b) => {
        const sa =
          typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a);
        const sb =
          typeof b === 'object' && b !== null ? JSON.stringify(b) : String(b);
        return sa < sb ? -1 * direction : sa > sb ? 1 * direction : 0;
      });
    }

    return result;
  }

  if (typeof obj === 'object' && obj !== null && !isBigNumberLike(obj)) {
    const sorted: Record<string, unknown> = {};
    Object.keys(obj as Record<string, unknown>)
      .sort((a, b) => {
        const la = a.toLowerCase();
        const lb = b.toLowerCase();
        return la < lb ? -1 * direction : la > lb ? 1 * direction : 0;
      })
      .forEach((key) => {
        sorted[key] = sortObj(
          (obj as Record<string, unknown>)[key],
          asc,
          noArray,
        );
      });
    return sorted;
  }

  return obj;
}
