/**
 * 字段货架的纯函数模型：条目构建、分类分组、搜索、场景筛选与按 key 增删。
 *
 * 所有函数都不缓存模板或字段类型的派生结果，调用方每次拿到最新数据。
 */
import {
  CATEGORIES,
  FIELD_TYPES,
  createField,
  getFieldType,
  sanitizeFields,
} from "../../tools/mock-data/lib/generators";
import type {
  MockTemplate,
  TemplateRow,
} from "../../tools/mock-data/lib/templates";
import type { MockField } from "../../tools/mock-data/lib/types";

export const ALL_SCENARIOS = "all";

/** 只保留启用（enabled !== false）的字段；enabled 缺省视为启用。 */
export function enabledFields(fields: MockField[]): MockField[] {
  return fields.filter((field) => field.enabled !== false);
}

export interface ShelfEntry {
  key: string;
  label: string;
  typeId: string;
  scenarioId?: string;
  scenarioName?: string;
  row?: TemplateRow;
}

export interface ShelfGroup {
  id: string;
  label: string;
  entries: ShelfEntry[];
}

/** 字段展示名：业务 label 优先，其次类型名，最后输出 key。 */
export function fieldDisplayName(field: MockField): string {
  return field.label ?? getFieldType(field.type)?.label ?? field.key;
}

/** 「全部」场景的通用条目：每个字段类型一条，key 取类型的默认 key。 */
export function genericEntries(): ShelfEntry[] {
  return FIELD_TYPES.map((type) => ({
    key: type.defaultKey,
    label: type.label,
    typeId: type.id,
  }));
}

/** 场景条目：只保留顶层、key 非空且类型可知的行。 */
export function scenarioEntries(template: MockTemplate): ShelfEntry[] {
  const entries: ShelfEntry[] = [];
  for (const row of template.rows) {
    const key = row.key.trim();
    if (!key) continue;
    const type = getFieldType(row.type);
    if (!type) continue;
    entries.push({
      key,
      label: row.label ?? type.label ?? key,
      typeId: type.id,
      scenarioId: template.id,
      scenarioName: template.name,
      row,
    });
  }
  return entries;
}

function groupEntries(entries: ShelfEntry[]): ShelfGroup[] {
  const byCategory = new Map<string, ShelfEntry[]>();
  for (const entry of entries) {
    const category = getFieldType(entry.typeId)?.category;
    if (!category) continue;
    const bucket = byCategory.get(category);
    if (bucket) bucket.push(entry);
    else byCategory.set(category, [entry]);
  }
  const groups: ShelfGroup[] = [];
  for (const category of CATEGORIES) {
    const bucket = byCategory.get(category.id);
    if (bucket?.length) {
      groups.push({ id: category.id, label: category.label, entries: bucket });
    }
  }
  return groups;
}

export function genericGroups(): ShelfGroup[] {
  return groupEntries(genericEntries());
}

export function scenarioGroups(template: MockTemplate): ShelfGroup[] {
  return groupEntries(scenarioEntries(template));
}

export function findScenario(
  id: string,
  templates: MockTemplate[],
): MockTemplate | undefined {
  return templates.find((template) => template.id === id);
}

/** 启用字段数量，用于「已选 N 个字段」。 */
export function countEnabled(fields: MockField[]): number {
  return enabledFields(fields).length;
}

/** 切换单个字段的启用标志（缺省 undefined → 视为启用，首次勾掉记为 false）。 */
export function toggleFieldEnabled(
  fields: MockField[],
  id: string,
): MockField[] {
  return fields.map((field) => {
    if (field.id !== id) return field;
    const enabled = field.enabled !== false; // 缺省视为启用
    return { ...field, enabled: !enabled };
  });
}

/** 默认场景 id：用户信息。 */
export const DEFAULT_SCENARIO_ID = "user";

/** 场景 id 无效或指向已删除模板时，回退到默认用户场景；默认场景不可用时回退「全部」。 */
export function resolveFallbackScenarioId(
  id: string | undefined,
  templates: MockTemplate[],
): string {
  if (id && id !== ALL_SCENARIOS && findScenario(id, templates)) return id;
  if (findScenario(DEFAULT_SCENARIO_ID, templates)) return DEFAULT_SCENARIO_ID;
  return ALL_SCENARIOS;
}

/** 把场景中尚未开启（key 缺失或 enabled=false）的条目补齐/开启；已启用同 key 跳过。 */
export function preloadScenario(
  fields: MockField[],
  template: MockTemplate,
): { fields: MockField[]; added: number } {
  let next = fields;
  let added = 0;
  for (const entry of scenarioEntries(template)) {
    const existing = next.find((f) => f.key === entry.key);
    if (existing) {
      if (existing.enabled === false) {
        existing.enabled = true;
        added += 1;
      }
      continue;
    }
    const result = addShelfEntry(next, entry);
    if (result.added) {
      added += 1;
      next = result.fields;
    }
  }
  return { fields: next, added };
}

function matchesQuery(entry: ShelfEntry, query: string): boolean {
  const typeLabel = getFieldType(entry.typeId)?.label ?? "";
  return [entry.label, entry.key, entry.typeId, typeLabel].some((value) =>
    value.toLowerCase().includes(query),
  );
}

/** 搜索覆盖通用字段与所有场景字段；空查询返回空结果。 */
export function searchShelf(
  query: string,
  templates: MockTemplate[],
): ShelfGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const groups: ShelfGroup[] = [];
  const types = genericEntries().filter((entry) =>
    matchesQuery(entry, needle),
  );
  if (types.length) {
    groups.push({ id: "types", label: "字段类型", entries: types });
  }
  const scenario = templates
    .flatMap(scenarioEntries)
    .filter((entry) => matchesQuery(entry, needle));
  if (scenario.length) {
    groups.push({ id: "scenario", label: "场景字段", entries: scenario });
  }
  return groups;
}

export function isEntrySelected(
  fields: MockField[],
  entry: ShelfEntry,
): boolean {
  return fields.some((field) => field.key === entry.key);
}

export function addShelfEntry(
  fields: MockField[],
  entry: ShelfEntry,
): { fields: MockField[]; added: boolean } {
  if (entry.row) {
    if (isEntrySelected(fields, entry)) return { fields, added: false };
    const [field] = sanitizeFields([entry.row]);
    if (!field) return { fields, added: false };
    return { fields: [...fields, field], added: true };
  }

  const field = createField(
    entry.typeId,
    new Set(fields.map((item) => item.key)),
  );
  if (!field) return { fields, added: false };
  return { fields: [...fields, field], added: true };
}

export function removeShelfEntry(fields: MockField[], key: string): MockField[] {
  return fields.filter((field) => field.key !== key);
}

export type ShelfToggleAction = "added" | "removed" | "skipped";

export function toggleShelfEntry(
  fields: MockField[],
  entry: ShelfEntry,
): { fields: MockField[]; action: ShelfToggleAction } {
  if (isEntrySelected(fields, entry)) {
    return { fields: removeShelfEntry(fields, entry.key), action: "removed" };
  }
  const result = addShelfEntry(fields, entry);
  return { fields: result.fields, action: result.added ? "added" : "skipped" };
}

/** 全选本场景：只补缺失的 key。 */
export function selectScenario(
  fields: MockField[],
  template: MockTemplate,
): { fields: MockField[]; added: number } {
  let next = fields;
  let added = 0;
  for (const entry of scenarioEntries(template)) {
    const result = addShelfEntry(next, entry);
    if (result.added) added += 1;
    next = result.fields;
  }
  return { fields: next, added };
}

/** 全不选：只删除 key 命中本场景顶层条目的字段。 */
export function deselectScenario(
  fields: MockField[],
  template: MockTemplate,
): { fields: MockField[]; removed: number } {
  const keys = new Set(scenarioEntries(template).map((entry) => entry.key));
  const next = fields.filter((field) => !keys.has(field.key));
  return { fields: next, removed: fields.length - next.length };
}
