/**
 * json-tree（ADR-0004 D3）
 * 格式化输出树的节点纯函数 CRUD：路径切分 / 取值 / 不可变删除。
 * 路径约定：'$' 开头，属性段 '.key'，下标段 '[n]'（根可为数组：'$[0].a'）。
 */

/**
 * 将 '$' 开头的路径切分为带前缀的分段。
 * 支持根节点为对象（'$.a.b' → ['.a', '.b']）和数组（'$[0].a' → ['[0]', '.a']）。
 */
export function splitPath(path: string): string[] {
  return path
    .slice(1)
    .split(/(?=\.|\[)/)
    .filter(Boolean);
}

/** 按路径取值；路径不存在或类型不匹配返回 undefined */
export function getValueAtPath(obj: unknown, path: string): unknown {
  if (path === '$') return obj;
  const parts = splitPath(path);
  if (parts.length === 0) return obj;
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (part.startsWith('[')) {
      const idx = parseInt(part.slice(1, -1), 10);
      if (Array.isArray(current)) current = current[idx];
      else return undefined;
    } else {
      const key = part.startsWith('.') ? part.slice(1) : part;
      if (typeof current === 'object' && !Array.isArray(current)) {
        current = (current as Record<string, unknown>)[key];
      } else return undefined;
    }
  }
  return current;
}

/** 不可变删除路径处节点；路径类型不匹配时原样返回 */
export function deleteValueAtPath(obj: unknown, path: string): unknown {
  const parts = splitPath(path);
  if (parts.length === 0) return obj;
  return deleteDeep(obj, parts, 0);
}

function deleteDeep(obj: unknown, parts: string[], idx: number): unknown {
  if (idx >= parts.length - 1) {
    // 到达倒数第二层，执行删除
    const lastPart = parts[parts.length - 1];
    if (lastPart.startsWith('[')) {
      const i = parseInt(lastPart.slice(1, -1), 10);
      if (Array.isArray(obj)) {
        const arr = [...obj];
        arr.splice(i, 1);
        return arr;
      }
    } else if (lastPart.startsWith('.')) {
      const key = lastPart.slice(1);
      if (isPlainObject(obj)) {
        const o = { ...(obj as Record<string, unknown>) };
        delete o[key];
        return o;
      }
    } else {
      // 无前缀首段（如 "$.code" 中的 "code"）
      if (isPlainObject(obj)) {
        const o = { ...(obj as Record<string, unknown>) };
        delete o[lastPart];
        return o;
      }
    }
    return obj;
  }

  const part = parts[idx];
  if (part.startsWith('[')) {
    const i = parseInt(part.slice(1, -1), 10);
    if (Array.isArray(obj)) {
      const arr = [...obj];
      arr[i] = deleteDeep(arr[i], parts, idx + 1);
      return arr;
    }
  } else if (part.startsWith('.')) {
    const key = part.slice(1);
    if (isPlainObject(obj)) {
      const o = { ...(obj as Record<string, unknown>) };
      o[key] = deleteDeep(o[key], parts, idx + 1);
      return o;
    }
  } else {
    // 无前缀首段
    if (isPlainObject(obj)) {
      const o = { ...(obj as Record<string, unknown>) };
      o[part] = deleteDeep(o[part], parts, idx + 1);
      return o;
    }
  }
  return obj;
}

function isPlainObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
