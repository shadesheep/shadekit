/** 测试用例在请求 JSON 中的定位：对象逐级下钻，数组标记为列表。 */
export interface PathSegment {
  key: string;
  list: boolean;
}

/** 按路径收集请求中的值；数组段展开所有元素。 */
export function valuesAtPath(
  value: unknown,
  segments: PathSegment[],
  index = 0,
): unknown[] {
  if (!value || typeof value !== "object") return [];
  const segment = segments[index];
  const current = (value as Record<string, unknown>)[segment.key];
  if (index === segments.length - 1) {
    if (segment.list) return Array.isArray(current) ? current : [];
    return current === undefined ? [] : [current];
  }
  const children = segment.list
    ? Array.isArray(current)
      ? current
      : []
    : [current];
  return children.flatMap((child) => valuesAtPath(child, segments, index + 1));
}
