/**
 * 与对象键顺序无关的 JSON 序列化，用于比较写入值与 chrome.storage 的读回值。
 *
 * chrome.storage.local 在写入/读回时会按字典序重排对象键（Chrome 实测：
 * 写入 {"z":1,"a":2}，读回 {"a":2,"z":1}）。直接比较 JSON.stringify 会把
 * 内容相同、键序不同的配置误判为不同，导致迁移/保存/导入的读回校验失败。
 *
 * 递归排序对象键；undefined 属性按 storage 语义视为不存在。
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item !== undefined) result[key] = canonicalize(item);
    }
    return result;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? "undefined";
}

export function storageValuesEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
