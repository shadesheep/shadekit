import { sanitizeFields } from "./generators";
import type { MockTemplate, TemplateRow } from "./templates";
import type { MockField } from "./types";

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
  params?: unknown;
  constraints?: unknown;
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
  if (field.constraints) row.constraints = { ...field.constraints };
  if (field.children) row.children = field.children.map(toTemplateRow);
  return row;
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
    rows: fields.map(toTemplateRow),
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
      rows: template.rows.map(toTemplateRow),
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
    if (
      source.params !== undefined &&
      (typeof source.params !== "object" ||
        source.params === null ||
        Array.isArray(source.params))
    ) {
      throw new Error(`${rowPath}.params 必须是对象`);
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
    if (source.constraints) {
      row.constraints = {
        ...(source.constraints as TemplateRow["constraints"]),
      };
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
