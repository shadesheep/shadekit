import type { MockTemplate } from "./templates";

export type CategoryId = "basic" | "person" | "business" | "tender" | "tech";
export type LocaleId = "zh-CN" | "en-US";
export type MockScenario = "normal" | "boundary" | "invalid" | "timeSeries";
export type NumberDistribution = "uniform" | "normal" | "exponential";
export type DerivedTransform =
  | "copy"
  | "uppercase"
  | "lowercase"
  | "stringify"
  | "chineseCapital"
  | "idCardBirthDate"
  | "idCardGender"
  | "dateAfter";

export interface CategoryDef {
  id: CategoryId;
  label: string;
  icon: string;
}

export type ParamKind = "number" | "text" | "select";

/** 字段类型的单个可调参数声明，UI 据此动态渲染控件。 */
export interface FieldParamDef {
  name: string;
  label: string;
  kind: ParamKind;
  default: string | number;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
  placeholder?: string;
}

/** 单行生成上下文；row 只包含当前行中已经生成的字段。 */
export interface GenContext {
  index: number;
  rng: () => number;
  row: Record<string, unknown>;
  previousRow?: Record<string, unknown>;
  locale: LocaleId;
  scenario: MockScenario;
  /** 本次生成固定的参考时间，seeded 生成使用固定值以保证完全可复现。 */
  now?: number;
}

export interface FieldTypeDef {
  id: string;
  label: string;
  category: CategoryId;
  defaultKey: string;
  params: FieldParamDef[];
  generate: (params: Record<string, unknown>, ctx: GenContext) => unknown;
}

export interface FieldConstraints {
  /** 生成 null 的概率，范围 0..1。 */
  nullRate?: number;
  /** 非 null 值在本次生成的所有行及所有 batch 中唯一。 */
  unique?: boolean;
  /** 生成格式错误值的概率，范围 0..1；独立于 scenario。 */
  invalidRate?: number;
}

/** 一行字段配置（可序列化，持久化到 chrome.storage）。 */
export interface MockField {
  id: string;
  key: string;
  /** 业务显示名；不填时回退到类型名。 */
  label?: string;
  type: string;
  params: Record<string, unknown>;
  constraints?: FieldConstraints;
  /** 缺省 true；false 表示已勾掉不生成（配置保留，仅跳过）。 */
  enabled?: boolean;
  /** object 的子字段；array 提供 children 时每个元素均为对象。 */
  children?: MockField[];
}

export type OutputFormat = "json" | "jsonl" | "csv" | "sql" | "xml";
export type LeftMode = "batch" | "quick";

export interface GenerateOptions {
  seed?: string;
  locale?: LocaleId;
  scenario?: MockScenario;
  startIndex?: number;
}

export interface ExportOptions {
  sqlDialect?: "mysql" | "postgres" | "sqlite";
  csvDelimiter?: string;
  csvBom?: boolean;
  xmlRoot?: string;
  xmlItem?: string;
}

/** mock-data 工具的持久化配置（storage key: devtools-mock-data）。 */
export interface MockDataConfig {
  schemaVersion?: number;
  fields?: MockField[];
  count?: number;
  format?: OutputFormat;
  tableName?: string;
  seed?: string;
  locale?: LocaleId;
  scenario?: MockScenario;
  customTemplates?: MockTemplate[];
  exportOptions?: ExportOptions;
  batchSize?: number;
  viewMode?: "card" | "table" | "code";
  quickCount?: number;
  tablePreviewLimit?: number;
  autoGenerate?: boolean;
  leftMode?: LeftMode;
  /** 当前字段货架的业务场景筛选："all" 或模板 id。 */
  activeScenarioId?: string;
  /** @deprecated 新 UI 不再读写。 */
  editorMode?: "simple" | "advanced";
  allowMultiple?: boolean;
}
