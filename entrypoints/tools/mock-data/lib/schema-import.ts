import { nextRowId } from "./generators";
import type { FieldConstraints, MockField } from "./types";

interface JSONSchema {
  type?: unknown;
  properties?: unknown;
  required?: unknown;
  items?: unknown;
  enum?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  minLength?: unknown;
  maxLength?: unknown;
  format?: unknown;
  anyOf?: unknown;
}

const SCHEMA_TYPES: Record<string, true> = {
  object: true,
  array: true,
  string: true,
  number: true,
  integer: true,
  boolean: true,
  null: true,
};
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

function fieldFromSample(key: string, value: unknown): MockField {
  const base = { id: nextRowId(), key, params: {} };

  if (Array.isArray(value)) {
    const first = value.find((item) => item !== null && item !== undefined);
    if (first && typeof first === "object" && !Array.isArray(first)) {
      return {
        ...base,
        type: "array",
        params: { minItems: value.length, maxItems: value.length },
        children: Object.entries(first).map(([childKey, childValue]) =>
          fieldFromSample(childKey, childValue),
        ),
      };
    }
    const item = first === undefined ? null : fieldFromSample("item", first);
    return {
      ...base,
      type: "array",
      params: {
        itemType:
          item && item.type !== "array" && item.type !== "object"
            ? item.type
            : "string",
        minItems: value.length,
        maxItems: value.length,
      },
    };
  }

  if (typeof value === "object" && value !== null) {
    return {
      ...base,
      type: "object",
      children: Object.entries(value).map(([childKey, childValue]) =>
        fieldFromSample(childKey, childValue),
      ),
    };
  }

  if (typeof value === "number") {
    return { ...base, type: Number.isInteger(value) ? "int" : "float" };
  }
  if (typeof value === "boolean") return { ...base, type: "boolean" };
  if (typeof value === "string") {
    if (UUID_PATTERN.test(value)) return { ...base, type: "uuid" };
    if (EMAIL_PATTERN.test(value)) return { ...base, type: "email" };
    if (DATE_PATTERN.test(value)) {
      return { ...base, type: "date", params: { format: "date" } };
    }
    if (DATETIME_PATTERN.test(value)) {
      return { ...base, type: "date", params: { format: "datetime" } };
    }
  }
  return { ...base, type: "string" };
}

/** 从 JSON 示例对象（或对象数组的首项）递归推断字段树。 */
export function fieldsFromJSONSample(sample: unknown): MockField[] {
  let model = sample;
  if (Array.isArray(model)) {
    if (model.length === 0)
      throw new Error("JSON 示例根数组为空，无法取得首元素作为行模型");
    model = model[0];
  }
  if (typeof model !== "object" || model === null || Array.isArray(model)) {
    throw new Error("JSON 示例根节点必须是对象，根数组的首元素也必须是对象");
  }
  return Object.entries(model).map(([key, value]) =>
    fieldFromSample(key, value),
  );
}

function fieldFromSchema(key: string, input: JSONSchema): MockField {
  let schema = input;
  let nullable = false;

  if (Array.isArray(schema.anyOf)) {
    const variants = schema.anyOf.filter(
      (item): item is JSONSchema =>
        typeof item === "object" && item !== null && !Array.isArray(item),
    );
    nullable = variants.some((item) => item.type === "null");
    schema = variants.find((item) => item.type !== "null") ?? {};
  }

  let type = typeof schema.type === "string" ? schema.type : "";
  if (Array.isArray(schema.type)) {
    nullable ||= schema.type.includes("null");
    type =
      schema.type.find(
        (item): item is string => typeof item === "string" && item !== "null",
      ) ?? "";
  }
  if (!type) {
    if (Array.isArray(schema.enum)) type = "enum";
    else if (
      typeof schema.properties === "object" &&
      schema.properties !== null
    )
      type = "object";
    else if (schema.items !== undefined) type = "array";
  }

  const base = { id: nextRowId(), key, params: {} as Record<string, unknown> };
  const constraints: FieldConstraints | undefined =
    nullable || type === "null" ? { nullRate: 0.2 } : undefined;

  if (Array.isArray(schema.enum)) {
    return {
      ...base,
      type: "enum",
      params: {
        values: schema.enum
          .filter(
            (item) =>
              item === null ||
              ["string", "number", "boolean"].includes(typeof item),
          )
          .map((item) =>
            typeof item === "string" ? item : JSON.stringify(item),
          )
          .join(","),
      },
      ...(constraints ? { constraints } : {}),
    };
  }

  if (type === "object") {
    const children: MockField[] = [];
    if (
      typeof schema.properties === "object" &&
      schema.properties !== null &&
      !Array.isArray(schema.properties)
    ) {
      for (const [childKey, childSchema] of Object.entries(schema.properties)) {
        if (
          typeof childSchema !== "object" ||
          childSchema === null ||
          Array.isArray(childSchema)
        )
          continue;
        children.push(fieldFromSchema(childKey, childSchema as JSONSchema));
      }
    }
    return {
      ...base,
      type: "object",
      children,
      ...(constraints ? { constraints } : {}),
    };
  }

  if (type === "array") {
    if (
      typeof schema.items === "object" &&
      schema.items !== null &&
      !Array.isArray(schema.items)
    ) {
      const item = fieldFromSchema("item", schema.items as JSONSchema);
      if (item.type === "object") {
        return {
          ...base,
          type: "array",
          children: item.children ?? [],
          ...(constraints ? { constraints } : {}),
        };
      }
      return {
        ...base,
        type: "array",
        params: { itemType: item.type === "array" ? "string" : item.type },
        ...(constraints ? { constraints } : {}),
      };
    }
    return {
      ...base,
      type: "array",
      params: { itemType: "string" },
      ...(constraints ? { constraints } : {}),
    };
  }

  if (type === "integer" || type === "number") {
    const params: Record<string, unknown> = {};
    if (typeof schema.minimum === "number" && Number.isFinite(schema.minimum)) {
      params.min = schema.minimum;
    }
    if (typeof schema.maximum === "number" && Number.isFinite(schema.maximum)) {
      params.max = schema.maximum;
    }
    return {
      ...base,
      type: type === "integer" ? "int" : "float",
      params,
      ...(constraints ? { constraints } : {}),
    };
  }

  if (type === "boolean") {
    return {
      ...base,
      type: "boolean",
      ...(constraints ? { constraints } : {}),
    };
  }

  if (type === "string") {
    if (schema.format === "date-time" || schema.format === "date") {
      return {
        ...base,
        type: "date",
        params: { format: schema.format === "date" ? "date" : "datetime" },
        ...(constraints ? { constraints } : {}),
      };
    }
    if (schema.format === "email") {
      return {
        ...base,
        type: "email",
        ...(constraints ? { constraints } : {}),
      };
    }
    if (schema.format === "uuid") {
      return { ...base, type: "uuid", ...(constraints ? { constraints } : {}) };
    }
    const params: Record<string, unknown> = {};
    const length =
      typeof schema.maxLength === "number" && Number.isFinite(schema.maxLength)
        ? schema.maxLength
        : typeof schema.minLength === "number" &&
            Number.isFinite(schema.minLength)
          ? schema.minLength
          : undefined;
    if (length !== undefined) params.length = Math.max(0, Math.trunc(length));
    return {
      ...base,
      type: "string",
      params,
      ...(constraints ? { constraints } : {}),
    };
  }

  // 未支持的 type/format 不阻断整个导入，退化为普通字符串字段。
  return { ...base, type: "string", ...(constraints ? { constraints } : {}) };
}

/** 导入 JSON Schema 的对象属性子集；无法表示的特性会被忽略。 */
export function fieldsFromJSONSchema(schema: unknown): MockField[] {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new Error("JSON Schema 根节点必须是对象");
  }
  const root = fieldFromSchema("root", schema as JSONSchema);
  return root.type === "object" ? (root.children ?? []) : [];
}

function looksLikeJSONSchema(value: object): boolean {
  const schema = value as JSONSchema & { $schema?: unknown };
  if (
    schema.$schema !== undefined ||
    schema.properties !== undefined ||
    schema.anyOf !== undefined
  ) {
    return true;
  }
  if (Array.isArray(schema.enum)) return true;
  if (typeof schema.type === "string")
    return SCHEMA_TYPES[schema.type] === true;
  return (
    Array.isArray(schema.type) &&
    schema.type.some(
      (item) => typeof item === "string" && SCHEMA_TYPES[item] === true,
    )
  );
}

/** 自动识别 JSON 示例或 JSON Schema，并转换为完整递归字段树。 */
export function parseSchemaImport(text: string): MockField[] {
  if (!text.trim())
    throw new Error("导入内容不能为空，请粘贴 JSON 示例或 JSON Schema");

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`导入内容不是有效的 JSON：${detail}`);
  }

  if (Array.isArray(value)) return fieldsFromJSONSample(value);
  if (typeof value !== "object" || value === null) {
    throw new Error(
      "导入内容根节点必须是 JSON 示例对象、对象数组或 JSON Schema 对象",
    );
  }
  return looksLikeJSONSchema(value)
    ? fieldsFromJSONSchema(value)
    : fieldsFromJSONSample(value);
}
