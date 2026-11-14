import { getFieldType, nextRowId, numericDefaults } from "./generators";
import type {
  InputRule,
  InputValueType,
  LengthRule,
  MockField,
  NumericRule,
} from "./types";

type SchemaNode = Record<string, unknown>;

/** 导入预览中的单个字段及其已识别规则。 */
export interface SchemaImportField {
  path: string;
  key: string;
  rules: string[];
}

/** 无法自动映射、需要用户手动配置的关键词或结构。 */
export interface SchemaImportPending {
  path: string;
  keyword: string;
  message: string;
}

export interface SchemaImportReport {
  source: "sample" | "schema";
  fields: MockField[];
  recognized: SchemaImportField[];
  pending: SchemaImportPending[];
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

const INPUT_TYPES_BY_SCHEMA_TYPE: Record<string, InputValueType> = {
  integer: "integer",
  number: "number",
  string: "string",
  boolean: "boolean",
  object: "object",
  array: "array",
};
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

/** 首版未映射的 JSON Schema 关键词；值仅用于预览提示。 */
const PENDING_KEYWORDS: Record<string, string> = {
  $ref: "引用未展开，字段按结构推断",
  $defs: "未展开 $defs 中的定义",
  definitions: "未展开 definitions 中的定义",
  oneOf: "组合规则未合并，按首个可用分支导入",
  allOf: "组合规则未合并",
  not: "排除规则未处理",
  if: "条件规则未处理",
  exclusiveMinimum: "排他下限未导入，请改用 minimum",
  exclusiveMaximum: "排他上限未导入，请改用 maximum",
  multipleOf: "数值步长未导入，请在字段设置中填写精度",
  pattern: "正则约束未导入",
  uniqueItems: "数组元素唯一性未导入",
  contains: "数组包含约束未导入",
  minContains: "数组包含数量未导入",
  maxContains: "数组包含数量未导入",
  prefixItems: "元组元素结构未导入",
  additionalProperties: "额外属性约束未导入",
  patternProperties: "模式属性未展开",
  propertyNames: "属性名约束未导入",
  minProperties: "对象属性数量约束未导入",
  maxProperties: "对象属性数量约束未导入",
  dependentRequired: "属性依赖未导入",
  dependentSchemas: "属性依赖未导入",
  dependencies: "属性依赖未导入",
  const: "固定值未映射",
  contentEncoding: "内容编码未导入",
  contentMediaType: "内容类型未导入",
  unevaluatedProperties: "未求值属性约束未导入",
  unevaluatedItems: "未求值元素约束未导入",
};

interface Analyzer {
  pending: SchemaImportPending[];
  seen: Set<string>;
}

function isSchemaNode(value: unknown): value is SchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJSONPrimitive(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function cloneJSON<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function addPending(
  analyzer: Analyzer,
  path: string,
  keyword: string,
  message: string,
) {
  const at = path || "$";
  const id = `${at}\u0000${keyword}\u0000${message}`;
  if (analyzer.seen.has(id)) return;
  analyzer.seen.add(id);
  analyzer.pending.push({ path: at, keyword, message });
}

function scanUnsupported(schema: SchemaNode, path: string, analyzer: Analyzer) {
  for (const [keyword, message] of Object.entries(PENDING_KEYWORDS)) {
    if (schema[keyword] === undefined) continue;
    if (keyword === "additionalProperties" && schema[keyword] === true) {
      continue;
    }
    addPending(analyzer, path, keyword, message);
  }
}

function isNullVariant(schema: SchemaNode): boolean {
  if (schema.const === null) return true;
  return (
    schema.type === "null" ||
    (Array.isArray(schema.type) &&
      schema.type.length === 1 &&
      schema.type[0] === "null")
  );
}

function typeIncludesNull(raw: unknown): boolean {
  return Array.isArray(raw) && raw.includes("null");
}

function selectSchema(
  input: SchemaNode,
  path: string,
  analyzer: Analyzer,
): { schema: SchemaNode; nullable: boolean } {
  let nullable = input.nullable === true || typeIncludesNull(input.type);
  scanUnsupported(input, path, analyzer);
  let schema = input;

  if (Array.isArray(input.anyOf)) {
    const variants = input.anyOf.filter(isSchemaNode);
    if (variants.some(isNullVariant)) nullable = true;
    const nonNull = variants.filter((item) => !isNullVariant(item));
    if (nonNull.length > 1) {
      addPending(
        analyzer,
        path,
        "anyOf",
        "anyOf 有多个非 null 分支，仅导入第一个分支",
      );
    }
    if (nonNull.length) schema = nonNull[0];
    else if (variants.length) {
      addPending(analyzer, path, "anyOf", "anyOf 未包含可生成的非 null 分支");
    }
    scanUnsupported(schema, path, analyzer);
  }

  nullable ||= typeIncludesNull(schema.type) || schema.nullable === true;
  return { schema, nullable };
}

function resolveSchemaType(
  schema: SchemaNode,
  path: string,
  analyzer: Analyzer,
): string {
  let type = "";
  const raw = schema.type;
  if (typeof raw === "string") {
    type = raw;
  } else if (Array.isArray(raw)) {
    const names = raw.filter(
      (item): item is string => typeof item === "string",
    );
    const nonNull = names.filter((item) => item !== "null");
    if (nonNull.length > 1) {
      addPending(
        analyzer,
        path,
        "type",
        `多类型字段仅导入第一个类型（${nonNull[0]}）`,
      );
    }
    type = nonNull[0] ?? "";
  } else if (raw !== undefined) {
    addPending(analyzer, path, "type", "type 必须是字符串或数组，已按结构推断");
  }

  if (!type) {
    if (Array.isArray(schema.enum)) type = "enum";
    else if (isSchemaNode(schema.properties)) type = "object";
    else if (schema.items !== undefined) type = "array";
    else if (
      schema.minLength !== undefined ||
      schema.maxLength !== undefined ||
      schema.format !== undefined
    )
      type = "string";
    else if (
      schema.minimum !== undefined ||
      schema.maximum !== undefined ||
      schema.exclusiveMinimum !== undefined ||
      schema.exclusiveMaximum !== undefined
    )
      type = "number";
    else if (schema.minItems !== undefined || schema.maxItems !== undefined)
      type = "array";
  }

  if (type && !SCHEMA_TYPES[type]) {
    addPending(analyzer, path, "type", `类型 ${type} 暂不支持，按字符串导入`);
    return "";
  }
  return type;
}

function requiredKeysOf(
  schema: SchemaNode,
  path: string,
  analyzer: Analyzer,
): Set<string> {
  const raw = schema.required;
  if (raw === undefined) return new Set();
  if (!Array.isArray(raw)) {
    addPending(analyzer, path, "required", "required 必须是字符串数组，已忽略");
    return new Set();
  }
  const keys = new Set<string>();
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) keys.add(item.trim());
    else {
      addPending(
        analyzer,
        path,
        "required",
        "required 中存在非字符串项，已忽略",
      );
    }
  }
  return keys;
}

function readNonNegativeInteger(
  raw: unknown,
  keyword: string,
  path: string,
  analyzer: Analyzer,
): number | undefined {
  if (raw === undefined) return undefined;
  if (
    typeof raw !== "number" ||
    !Number.isFinite(raw) ||
    !Number.isInteger(raw) ||
    raw < 0
  ) {
    addPending(analyzer, path, keyword, `${keyword} 必须是非负整数，已忽略`);
    return undefined;
  }
  return raw;
}

function readFiniteNumber(
  raw: unknown,
  keyword: string,
  path: string,
  analyzer: Analyzer,
): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    addPending(analyzer, path, keyword, `${keyword} 必须是数字，已忽略`);
    return undefined;
  }
  return raw;
}

function readLengthRule(
  schema: SchemaNode,
  minKey: string,
  maxKey: string,
  path: string,
  analyzer: Analyzer,
): LengthRule | undefined {
  const min = readNonNegativeInteger(schema[minKey], minKey, path, analyzer);
  const max = readNonNegativeInteger(schema[maxKey], maxKey, path, analyzer);
  if (min === undefined && max === undefined) return undefined;
  return { min, max };
}
function noteUnmappedLength(
  schema: SchemaNode,
  path: string,
  analyzer: Analyzer,
) {
  const keyword = ["minLength", "maxLength"].find(
    (name) => schema[name] !== undefined,
  );
  if (!keyword) return;
  addPending(
    analyzer,
    path,
    keyword,
    "格式化或枚举字段的长度约束未导入，请在字段设置中手动配置",
  );
}

function sampleLengthText(min?: number, max?: number): string | undefined {
  if (min === undefined && max === undefined) return undefined;
  if (min !== undefined && max !== undefined) {
    const low = Math.max(1, min);
    const high = Math.max(low, max);
    return low === high ? String(low) : `${low}-${high}`;
  }
  if (min !== undefined) return String(Math.max(1, min));
  return `1-${Math.max(1, max ?? 1)}`;
}

function decimalPlaces(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const text = String(value);
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

function commonInputType(
  values: readonly unknown[],
): InputValueType | undefined {
  const types = values.map((value) =>
    typeof value === "number"
      ? Number.isInteger(value)
        ? "integer"
        : "number"
      : typeof value,
  );
  if (types.every((type) => type === "string")) return "string";
  if (types.every((type) => type === "boolean")) return "boolean";
  if (types.every((type) => type === "integer")) return "integer";
  if (types.every((type) => type === "number" || type === "integer"))
    return "number";
  return undefined;
}

function finalizeRule(rule: InputRule): InputRule | undefined {
  return Object.keys(rule).length ? rule : undefined;
}

function fieldFromSchema(
  key: string,
  input: SchemaNode,
  parentRequired: ReadonlySet<string>,
  path: string,
  analyzer: Analyzer,
): MockField {
  const selected = selectSchema(input, path, analyzer);
  const schema = selected.schema;
  const nullable = selected.nullable;
  const type = resolveSchemaType(schema, path, analyzer);
  const base = { id: nextRowId(), key, params: {} as Record<string, unknown> };
  const rule: InputRule = {};
  rule.required = parentRequired.has(key);
  if (nullable || type === "null") rule.nullable = true;

  if (Array.isArray(schema.enum)) {
    const values = schema.enum;
    const allowsNull = values.includes(null);
    const allowed = values.filter(isJSONPrimitive);
    if (values.some((item) => item !== null && !isJSONPrimitive(item))) {
      addPending(analyzer, path, "enum", "存在非标量枚举值，已忽略该值");
    }
    if (allowsNull) rule.nullable = true;
    if (!allowed.length) {
      addPending(analyzer, path, "enum", "没有可生成的非 null 枚举值");
      rule.type = INPUT_TYPES_BY_SCHEMA_TYPE[type] ?? "string";
      const inputRule = finalizeRule(rule);
      return {
        ...base,
        type: "string",
        ...(inputRule ? { inputRule } : {}),
      };
    }
    noteUnmappedLength(schema, path, analyzer);
    const enumType = commonInputType(allowed);
    if (enumType) rule.type = enumType;
    rule.enumValues = cloneJSON(allowed);
    const inputRule = finalizeRule(rule);
    return {
      ...base,
      type: "enum",
      params: { values: cloneJSON(allowed) },
      ...(inputRule ? { inputRule } : {}),
    };
  }

  if (type === "object") {
    rule.type = "object";
    const requiredKeys = requiredKeysOf(schema, path, analyzer);
    const children: MockField[] = [];
    const properties = schema.properties;
    if (isSchemaNode(properties)) {
      for (const [childKey, childSchema] of Object.entries(properties)) {
        const childPath = path ? `${path}.${childKey}` : childKey;
        if (!isSchemaNode(childSchema)) {
          addPending(
            analyzer,
            childPath,
            "properties",
            "属性定义必须是对象，已忽略",
          );
          continue;
        }
        children.push(
          fieldFromSchema(
            childKey,
            childSchema,
            requiredKeys,
            childPath,
            analyzer,
          ),
        );
      }
    }
    const inputRule = finalizeRule(rule);
    return {
      ...base,
      type: "object",
      children,
      ...(inputRule ? { inputRule } : {}),
    };
  }

  if (type === "array") {
    rule.type = "array";
    const lengthRule = readLengthRule(
      schema,
      "minItems",
      "maxItems",
      path,
      analyzer,
    );
    const params: Record<string, unknown> = {};
    if (lengthRule) {
      const min = lengthRule.min ?? 0;
      params.minItems = min;
      params.maxItems = lengthRule.max ?? Math.max(min, 3);
    }
    if (Array.isArray(schema.items)) {
      addPending(
        analyzer,
        path,
        "items",
        "元组元素结构未导入，按字符串元素生成",
      );
      params.itemType = "string";
    } else if (isSchemaNode(schema.items)) {
      const itemPath = `${path}[]`;
      const itemField = fieldFromSchema(
        "item",
        schema.items,
        new Set(),
        itemPath,
        analyzer,
      );
      if (itemField.type === "object") {
        params.itemType = "object";
        const inputRule = finalizeRule(rule);
        return {
          ...base,
          type: "array",
          params,
          children: itemField.children ?? [],
          ...(lengthRule ? { lengthRule } : {}),
          ...(inputRule ? { inputRule } : {}),
        };
      }
      if (itemField.type === "array" || itemField.type === "enum") {
        addPending(
          analyzer,
          path,
          "items",
          "嵌套数组或枚举元素无法单独配置，按字符串元素生成",
        );
        params.itemType = "string";
      } else {
        params.itemType = itemField.type;
      }
    } else {
      addPending(
        analyzer,
        path,
        "items",
        "数组未声明元素结构，按字符串元素生成",
      );
      params.itemType = "string";
    }
    const inputRule = finalizeRule(rule);
    return {
      ...base,
      type: "array",
      params,
      ...(lengthRule ? { lengthRule } : {}),
      ...(inputRule ? { inputRule } : {}),
    };
  }

  if (type === "integer" || type === "number") {
    rule.type = type;
    const rawMin = readFiniteNumber(schema.minimum, "minimum", path, analyzer);
    const rawMax = readFiniteNumber(schema.maximum, "maximum", path, analyzer);
    const min =
      type === "integer" && rawMin !== undefined ? Math.ceil(rawMin) : rawMin;
    const max =
      type === "integer" && rawMax !== undefined ? Math.floor(rawMax) : rawMax;
    const numericRule: NumericRule | undefined =
      min !== undefined || max !== undefined
        ? {
            ...(min !== undefined ? { min } : {}),
            ...(max !== undefined ? { max } : {}),
          }
        : undefined;
    const fieldType = type === "integer" ? "int" : "float";
    const defaults = numericDefaults(fieldType);
    const params: Record<string, unknown> = {};
    if (defaults && (min !== undefined || max !== undefined)) {
      params.min =
        min !== undefined ? min : Math.min(defaults.min, max ?? defaults.min);
      params.max =
        max !== undefined ? max : Math.max(defaults.max, min ?? defaults.max);
    }
    if (type === "number" && defaults) {
      const precision = Math.min(
        Math.max(2, decimalPlaces(rawMin ?? 0), decimalPlaces(rawMax ?? 0)),
        6,
      );
      params.precision = precision;
    }
    const inputRule = finalizeRule(rule);
    return {
      ...base,
      type: fieldType,
      params,
      ...(numericRule ? { numericRule } : {}),
      ...(inputRule ? { inputRule } : {}),
    };
  }

  if (type === "boolean") {
    rule.type = "boolean";
    const inputRule = finalizeRule(rule);
    return {
      ...base,
      type: "boolean",
      ...(inputRule ? { inputRule } : {}),
    };
  }

  if (type === "string") {
    rule.type = "string";
    const format =
      typeof schema.format === "string" ? schema.format : undefined;
    if (format === "email") {
      noteUnmappedLength(schema, path, analyzer);
      rule.format = "email";
      const inputRule = finalizeRule(rule);
      return {
        ...base,
        type: "email",
        ...(inputRule ? { inputRule } : {}),
      };
    }
    if (format === "date-time" || format === "date") {
      noteUnmappedLength(schema, path, analyzer);
      const inputRule = finalizeRule(rule);
      return {
        ...base,
        type: "date",
        params: { format: format === "date" ? "date" : "datetime" },
        ...(inputRule ? { inputRule } : {}),
      };
    }
    if (format === "uuid") {
      noteUnmappedLength(schema, path, analyzer);
      const inputRule = finalizeRule(rule);
      return {
        ...base,
        type: "uuid",
        ...(inputRule ? { inputRule } : {}),
      };
    }
    if (format) {
      addPending(
        analyzer,
        path,
        "format",
        `格式 ${format} 暂不支持，按普通字符串导入`,
      );
    }
    const lengthRule = readLengthRule(
      schema,
      "minLength",
      "maxLength",
      path,
      analyzer,
    );
    const params: Record<string, unknown> = {};
    const length = sampleLengthText(lengthRule?.min, lengthRule?.max);
    if (length !== undefined) params.length = length;
    const inputRule = finalizeRule(rule);
    return {
      ...base,
      type: "string",
      params,
      ...(lengthRule ? { lengthRule } : {}),
      ...(inputRule ? { inputRule } : {}),
    };
  }

  if (type === "null") {
    rule.nullable = true;
    addPending(
      analyzer,
      path,
      "type",
      "仅允许 null 的字段无法生成非空基准，按可空字符串导入",
    );
  }
  if (schema.pattern !== undefined) rule.type = "string";
  const inputRule = finalizeRule(rule);
  return {
    ...base,
    type: "string",
    ...(inputRule ? { inputRule } : {}),
  };
}

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

/** 导入 JSON Schema 的对象属性子集；无法表示的特性会被忽略。 */
export function fieldsFromJSONSchema(schema: unknown): MockField[] {
  if (!isSchemaNode(schema)) {
    throw new Error("JSON Schema 根节点必须是对象");
  }
  const analyzer: Analyzer = { pending: [], seen: new Set() };
  const root = fieldFromSchema("root", schema, new Set(), "", analyzer);
  return root.type === "object" ? (root.children ?? []) : [];
}

function looksLikeJSONSchema(value: object): boolean {
  const schema = value as SchemaNode & { $schema?: unknown };
  if (
    schema.$schema !== undefined ||
    schema.properties !== undefined ||
    schema.anyOf !== undefined ||
    schema.oneOf !== undefined ||
    schema.allOf !== undefined
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

function describeField(field: MockField): string[] {
  const rules = [`类型：${getFieldType(field.type)?.label ?? field.type}`];
  if (field.inputRule?.required !== undefined) {
    rules.push(field.inputRule.required ? "必填" : "非必填");
  }
  if (field.inputRule?.nullable) rules.push("允许 null");
  if (field.inputRule?.nonEmpty) rules.push("非空");
  if (field.inputRule?.type) {
    rules.push(`请求类型：${field.inputRule.type}`);
  }
  if (field.inputRule?.format) rules.push("邮箱格式");
  if (field.inputRule?.enumValues?.length) {
    rules.push(
      `枚举：${field.inputRule.enumValues
        .map((value) => JSON.stringify(value))
        .join("、")}`,
    );
  }
  if (field.numericRule) {
    const { min, max } = field.numericRule;
    if (min !== undefined && max !== undefined) {
      rules.push(`数值范围：${min}–${max}`);
    } else if (min !== undefined) {
      rules.push(`数值下限：${min}`);
    } else if (max !== undefined) {
      rules.push(`数值上限：${max}`);
    }
  }
  if (field.lengthRule) {
    const unit = field.type === "array" ? "元素" : "字符";
    const { min, max } = field.lengthRule;
    if (min !== undefined && max !== undefined) {
      rules.push(`${unit}数：${min}–${max}`);
    } else if (min !== undefined) {
      rules.push(`${unit}数 ≥ ${min}`);
    } else if (max !== undefined) {
      rules.push(`${unit}数 ≤ ${max}`);
    }
  }
  if (field.children?.length) {
    rules.push(
      field.type === "array"
        ? `元素字段 ${field.children.length} 个`
        : `子字段 ${field.children.length} 个`,
    );
  }
  return rules;
}

function collectRecognized(
  fields: readonly MockField[],
  prefix = "",
): SchemaImportField[] {
  const recognized: SchemaImportField[] = [];
  for (const field of fields) {
    if (!field.key.trim()) continue;
    const path = prefix ? `${prefix}.${field.key}` : field.key;
    recognized.push({ path, key: field.key, rules: describeField(field) });
    if (field.children?.length) {
      recognized.push(
        ...collectRecognized(
          field.children,
          field.type === "array" ? `${path}[]` : path,
        ),
      );
    }
  }
  return recognized;
}

/** 解析 JSON 示例或 JSON Schema，并返回字段、已识别规则与待处理关键词。 */
export function analyzeSchemaImport(text: string): SchemaImportReport {
  if (!text.trim())
    throw new Error("导入内容不能为空，请粘贴 JSON 示例或 JSON Schema");

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`导入内容不是有效的 JSON：${detail}`);
  }

  if (Array.isArray(value)) {
    const fields = fieldsFromJSONSample(value);
    return {
      source: "sample",
      fields,
      recognized: collectRecognized(fields),
      pending: [],
    };
  }
  if (typeof value !== "object" || value === null) {
    throw new Error(
      "导入内容根节点必须是 JSON 示例对象、对象数组或 JSON Schema 对象",
    );
  }

  if (!looksLikeJSONSchema(value)) {
    const fields = fieldsFromJSONSample(value);
    return {
      source: "sample",
      fields,
      recognized: collectRecognized(fields),
      pending: [],
    };
  }

  const analyzer: Analyzer = { pending: [], seen: new Set() };
  const root = fieldFromSchema(
    "root",
    value as SchemaNode,
    new Set(),
    "",
    analyzer,
  );
  const fields = root.type === "object" ? (root.children ?? []) : [];
  return {
    source: "schema",
    fields,
    recognized: collectRecognized(fields),
    pending: analyzer.pending,
  };
}

/** 自动识别 JSON 示例或 JSON Schema，并转换为完整递归字段树。 */
export function parseSchemaImport(text: string): MockField[] {
  return analyzeSchemaImport(text).fields;
}
