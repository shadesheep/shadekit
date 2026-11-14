import { sanitizeFields } from "./generators";
import type { MockTemplate, TemplateRow } from "./templates";
import type {
  DateCompareDirection,
  DateComparePrecision,
  InputFormat,
  InputRule,
  InputValueType,
  LengthRule,
  MockField,
} from "./types";

const DATE_DIRECTIONS: Record<DateCompareDirection, true> = {
  after: true,
  before: true,
  notBefore: true,
  notAfter: true,
};
const DATE_PRECISIONS: Record<DateComparePrecision, true> = {
  day: true,
  hour: true,
  minute: true,
  second: true,
};
const INPUT_TYPES: Record<InputValueType, true> = {
  string: true,
  number: true,
  integer: true,
  boolean: true,
  object: true,
  array: true,
};
const INPUT_FORMATS: Record<InputFormat, true> = { email: true };

export const TEMPLATE_FILE_KIND = "shadekit-mock-template";
export const TEMPLATE_SCHEMA_VERSION = 2;

interface TemplateFile {
  schemaVersion: typeof TEMPLATE_SCHEMA_VERSION;
  kind: typeof TEMPLATE_FILE_KIND;
  template: MockTemplate;
}

let customTemplateSeq = 0;
interface TemplateFileShape {
  kind?: unknown;
  schemaVersion?: unknown;
  template?: unknown;
}

interface TemplateShape {
  id?: unknown;
  name?: unknown;
  hint?: unknown;
  rows?: unknown;
}

interface TemplateRowShape {
  key?: unknown;
  type?: unknown;
  label?: unknown;
  enabled?: unknown;
  params?: unknown;
  sources?: unknown;
  constraints?: unknown;
  numericRule?: unknown;
  lengthRule?: unknown;
  dateRule?: unknown;
  inputRule?: unknown;
  children?: unknown;
}

function nextCustomTemplateId(): string {
  customTemplateSeq += 1;
  return `custom_${Date.now().toString(36)}_${customTemplateSeq}`;
}

function toTemplateRow(field: MockField | TemplateRow): TemplateRow {
  const row: TemplateRow = {
    key: field.key,
    type: field.type,
    params: { ...(field.params ?? {}) },
  };
  if (typeof field.label === "string" && field.label.trim()) {
    row.label = field.label.trim();
  }
  if (field.enabled === false) row.enabled = false;
  if (
    "sources" in field &&
    field.sources &&
    Object.keys(field.sources).length
  ) {
    row.sources = { ...field.sources };
  }
  if (field.constraints) row.constraints = { ...field.constraints };
  if (field.numericRule) row.numericRule = { ...field.numericRule };
  if (field.lengthRule) row.lengthRule = { ...field.lengthRule };
  if (field.inputRule) {
    row.inputRule = { ...field.inputRule };
    if (field.inputRule.enumValues) {
      row.inputRule.enumValues = [...field.inputRule.enumValues];
    }
  }
  if (field.dateRule && "fieldKey" in field.dateRule) {
    row.dateRule = { ...field.dateRule };
  }
  return row;
}

function copyTemplateRows(rows: TemplateRow[]): TemplateRow[] {
  return rows.map((source) => {
    const row = toTemplateRow(source);
    if (source.children) row.children = copyTemplateRows(source.children);
    return row;
  });
}

/** 用来源的当前 key 保存引用，加载时重新绑定到新行 ID。 */
function fieldsToTemplateRows(fields: MockField[]): TemplateRow[] {
  const byId = new Map(fields.map((field) => [field.id, field]));
  return fields.map((field) => {
    const row = toTemplateRow(field);
    const sources: Record<string, string> = {};
    for (const [role, id] of Object.entries(field.sourceFieldIds ?? {})) {
      const key = byId.get(id)?.key.trim();
      if (key) sources[role] = key;
    }
    if (Object.keys(sources).length) row.sources = sources;
    if (field.dateRule) {
      const referenceKey = byId.get(field.dateRule.fieldId)?.key.trim();
      if (referenceKey) {
        row.dateRule = {
          fieldKey: referenceKey,
          direction: field.dateRule.direction,
          precision: field.dateRule.precision,
        };
      }
    }
    if (field.children) row.children = fieldsToTemplateRows(field.children);
    return row;
  });
}

/** 将当前字段树转换为可保存的模板，递归剥离所有行 id。 */
export function fieldsToTemplate(
  fields: MockField[],
  name: string,
  hint = "",
): MockTemplate {
  return {
    id: nextCustomTemplateId(),
    name: name.trim() || "自定义模板",
    hint: hint.trim(),
    rows: fieldsToTemplateRows(fields),
  };
}

/** 从模板重建字段树；未知类型及参数清洗统一交给 sanitizeFields。 */
export function templateToFields(template: MockTemplate): MockField[] {
  return sanitizeFields(template.rows);
}

/** 序列化版本化模板文件，不执行或保留任何函数字段。 */
export function serializeTemplateFile(template: MockTemplate): string {
  const file: TemplateFile = {
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
    kind: TEMPLATE_FILE_KIND,
    template: {
      id: template.id,
      name: template.name,
      hint: template.hint,
      rows: copyTemplateRows(template.rows),
    },
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

function parseRows(value: unknown, path: string): TemplateRow[] {
  if (!Array.isArray(value)) throw new Error(`${path}必须是数组`);

  return value.map((item, index) => {
    const rowPath = `${path}[${index}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`${rowPath}必须是字段对象`);
    }
    const source = item as TemplateRowShape;
    if (typeof source.key !== "string" || !source.key.trim()) {
      throw new Error(`${rowPath}.key 必须是非空字符串`);
    }
    if (typeof source.type !== "string" || !source.type.trim()) {
      throw new Error(`${rowPath}.type 必须是非空字符串`);
    }
    if (source.label !== undefined && typeof source.label !== "string") {
      throw new Error(`${rowPath}.label 必须是字符串`);
    }
    if (source.enabled !== undefined && typeof source.enabled !== "boolean") {
      throw new Error(`${rowPath}.enabled 必须是布尔值`);
    }
    if (
      source.params !== undefined &&
      (typeof source.params !== "object" ||
        source.params === null ||
        Array.isArray(source.params))
    ) {
      throw new Error(`${rowPath}.params 必须是对象`);
    }
    if (
      source.sources !== undefined &&
      (typeof source.sources !== "object" ||
        source.sources === null ||
        Array.isArray(source.sources))
    ) {
      throw new Error(`${rowPath}.sources 必须是对象`);
    }
    if (
      source.constraints !== undefined &&
      (typeof source.constraints !== "object" ||
        source.constraints === null ||
        Array.isArray(source.constraints))
    ) {
      throw new Error(`${rowPath}.constraints 必须是对象`);
    }
    if (source.children !== undefined && !Array.isArray(source.children)) {
      throw new Error(`${rowPath}.children 必须是数组`);
    }

    const row: TemplateRow = {
      key: source.key.trim(),
      type: source.type.trim(),
      params: { ...((source.params ?? {}) as Record<string, unknown>) },
    };
    if (typeof source.label === "string" && source.label.trim()) {
      row.label = source.label.trim();
    }
    if (source.enabled === false) row.enabled = false;
    if (source.sources) {
      const sources: Record<string, string> = {};
      for (const [role, key] of Object.entries(source.sources)) {
        if (typeof key !== "string" || !key.trim()) {
          throw new Error(`${rowPath}.sources.${role} 必须是非空字符串`);
        }
        sources[role] = key.trim();
      }
      row.sources = sources;
    }
    if (source.constraints) {
      row.constraints = {
        ...(source.constraints as TemplateRow["constraints"]),
      };
    }
    if (source.dateRule !== undefined) {
      if (
        typeof source.dateRule !== "object" ||
        source.dateRule === null ||
        Array.isArray(source.dateRule)
      ) {
        throw new Error(`${rowPath}.dateRule 必须是对象`);
      }
      const rule = source.dateRule as Record<string, unknown>;
      if (typeof rule.fieldKey !== "string" || !rule.fieldKey.trim()) {
        throw new Error(`${rowPath}.dateRule.fieldKey 必须是非空字符串`);
      }
      if (
        typeof rule.direction !== "string" ||
        !DATE_DIRECTIONS[rule.direction as DateCompareDirection]
      ) {
        throw new Error(`${rowPath}.dateRule.direction 必须是有效比较方向`);
      }
      if (
        typeof rule.precision !== "string" ||
        !DATE_PRECISIONS[rule.precision as DateComparePrecision]
      ) {
        throw new Error(`${rowPath}.dateRule.precision 必须是有效时间精度`);
      }
      row.dateRule = {
        fieldKey: rule.fieldKey.trim(),
        direction: rule.direction as DateCompareDirection,
        precision: rule.precision as DateComparePrecision,
      };
    }
    if (source.numericRule !== undefined) {
      if (
        typeof source.numericRule !== "object" ||
        source.numericRule === null ||
        Array.isArray(source.numericRule)
      ) {
        throw new Error(`${rowPath}.numericRule 必须是对象`);
      }
      const rule = source.numericRule as Record<string, unknown>;
      for (const name of ["min", "max", "precision"] as const) {
        if (rule[name] !== undefined && typeof rule[name] !== "number") {
          throw new Error(`${rowPath}.numericRule.${name} 必须是数字`);
        }
      }
      row.numericRule = {
        ...(source.numericRule as TemplateRow["numericRule"]),
      };
    }
    if (source.lengthRule !== undefined) {
      if (
        typeof source.lengthRule !== "object" ||
        source.lengthRule === null ||
        Array.isArray(source.lengthRule)
      ) {
        throw new Error(`${rowPath}.lengthRule 必须是对象`);
      }
      const rule = source.lengthRule as Record<string, unknown>;
      for (const name of ["min", "max"] as const) {
        if (rule[name] !== undefined && typeof rule[name] !== "number") {
          throw new Error(`${rowPath}.lengthRule.${name} 必须是数字`);
        }
      }
      row.lengthRule = { ...(source.lengthRule as LengthRule) };
    }
    if (source.inputRule !== undefined) {
      if (
        typeof source.inputRule !== "object" ||
        source.inputRule === null ||
        Array.isArray(source.inputRule)
      ) {
        throw new Error(`${rowPath}.inputRule 必须是对象`);
      }
      const raw = source.inputRule as Record<string, unknown>;
      const rule: InputRule = {};
      for (const name of ["required", "nullable", "nonEmpty"] as const) {
        if (raw[name] !== undefined && typeof raw[name] !== "boolean") {
          throw new Error(`${rowPath}.inputRule.${name} 必须是布尔值`);
        }
        if (typeof raw[name] === "boolean") rule[name] = raw[name];
      }
      if (raw.type !== undefined) {
        if (
          typeof raw.type !== "string" ||
          !INPUT_TYPES[raw.type as InputValueType]
        ) {
          throw new Error(`${rowPath}.inputRule.type 必须是有效 JSON 值类型`);
        }
        rule.type = raw.type as InputValueType;
      }
      if (raw.format !== undefined) {
        if (
          typeof raw.format !== "string" ||
          !INPUT_FORMATS[raw.format as InputFormat]
        ) {
          throw new Error(`${rowPath}.inputRule.format 必须是受支持的格式`);
        }
        rule.format = raw.format as InputFormat;
      }
      if (raw.enumValues !== undefined) {
        if (!Array.isArray(raw.enumValues)) {
          throw new Error(`${rowPath}.inputRule.enumValues 必须是数组`);
        }
        rule.enumValues = raw.enumValues;
      }
      row.inputRule = rule;
    }
    if (source.children)
      row.children = parseRows(source.children, `${rowPath}.children`);
    return row;
  });
}

/** 解析并严格校验模板文件的版本、标识及递归字段结构。 */
export function parseTemplateFile(text: string): MockTemplate {
  if (!text.trim()) throw new Error("模板文件内容不能为空");

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`模板文件不是有效的 JSON：${detail}`);
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("模板文件根节点必须是对象");
  }
  const file = value as TemplateFileShape;
  if (file.kind !== TEMPLATE_FILE_KIND) {
    throw new Error(`模板文件 kind 必须是 ${TEMPLATE_FILE_KIND}`);
  }
  if (file.schemaVersion !== TEMPLATE_SCHEMA_VERSION) {
    throw new Error(`模板文件 schemaVersion 必须是 ${TEMPLATE_SCHEMA_VERSION}`);
  }
  if (
    typeof file.template !== "object" ||
    file.template === null ||
    Array.isArray(file.template)
  ) {
    throw new Error("模板文件缺少有效的 template 对象");
  }
  const template = file.template as TemplateShape;
  if (typeof template.name !== "string" || !template.name.trim()) {
    throw new Error("模板 template.name 必须是非空字符串");
  }
  if (!Array.isArray(template.rows)) {
    throw new Error("模板 template.rows 必须是数组");
  }

  return {
    id:
      typeof template.id === "string" && template.id.trim()
        ? template.id.trim()
        : nextCustomTemplateId(),
    name: template.name.trim(),
    hint: typeof template.hint === "string" ? template.hint : "",
    rows: parseRows(template.rows, "template.rows"),
  };
}
