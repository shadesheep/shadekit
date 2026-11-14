import type { MockTemplate } from "./templates";

export type CategoryId = "basic" | "person" | "business" | "tender" | "tech";
export type LocaleId = "zh-CN" | "en-US";
export type MockScenario = "normal" | "boundary" | "invalid";

/** 测试用例来源：显式校验规则，或按字段取样范围/类型推导。 */
export type CaseRuleSource = "rule" | "inferred";

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
  /** 按参考时间换算日历日期所用的时区（IANA 名称或 local）。 */
  timeZone: string;
}

/** 字段类型声明的同级来源：解析顺序、选择范围与错误文案共用。 */
export interface FieldSourceDef {
  /** 持久化在 sourceFieldIds 中的角色名。 */
  name: string;
  /** 界面标签与错误文案中的角色说明。 */
  label: string;
  /** 允许的来源字段类型；缺省不限制。 */
  types?: string[];
  /** 必填来源缺失时阻断生成。 */
  required?: boolean;
}

export interface FieldTypeDef {
  id: string;
  label: string;
  category: CategoryId;
  defaultKey: string;
  params: FieldParamDef[];
  /** 依赖的同级字段；生成前统一解析顺序与兼容性。 */
  sources?: FieldSourceDef[];
  generate: (params: Record<string, unknown>, ctx: GenContext) => unknown;
}

export interface FieldConstraints {
  /** 非 null 值在本次生成的所有行及所有 batch 中唯一。 */
  unique?: boolean;
}

/** 数值字段的显式校验规则；与随机取样范围独立，用于生成接口测试用例。 */
export interface NumericRule {
  /** 校验下限（含）。 */
  min?: number;
  /** 校验上限（含）。 */
  max?: number;
  /** 校验步长（相邻可取值间隔），如 0.01；缺省时按字段取样精度推导。 */
  precision?: number;
}

/** 请求校验规则支持的 JSON 值类型。 */
export type InputValueType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array";

/** 首批支持的格式校验；未列出的格式不参与用例生成。 */
export type InputFormat = "email";

/** 字段的请求校验规则；用于生成缺失、空值、类型、枚举与格式用例。 */
export interface InputRule {
  required?: boolean;
  nullable?: boolean;
  nonEmpty?: boolean;
  type?: InputValueType;
  enumValues?: unknown[];
  format?: InputFormat;
}

/** 字符串与数组字段的显式长度规则；与随机取样设置独立，用于长度测试用例。 */
export interface LengthRule {
  /** 最小长度（含，非负整数）。 */
  min?: number;
  /** 最大长度（含，非负整数）。 */
  max?: number;
}

/** 日期字段的比较方向；after/before 为严格比较。 */
export type DateCompareDirection =
  | "after"
  | "before"
  | "notBefore"
  | "notAfter";

export type DateComparePrecision = "day" | "hour" | "minute" | "second";

/** 日期字段的显式比较规则；用于生成时间边界测试用例。 */
export interface DateComparisonRule {
  /** 同级的参照字段 ID。 */
  fieldId: string;
  direction: DateCompareDirection;
  precision: DateComparePrecision;
}

/** 一行字段配置（可序列化，持久化到 chrome.storage）。 */
export interface MockField {
  id: string;
  key: string;
  /** 业务显示名；不填时回退到类型名。 */
  label?: string;
  type: string;
  params: Record<string, unknown>;
  /** 字段类型声明的来源绑定：角色名 → 同级字段 ID。 */
  sourceFieldIds?: Record<string, string>;
  /** 数值字段的校验规则；配置后可用于生成边界测试用例。 */
  numericRule?: NumericRule;
  constraints?: FieldConstraints;
  /** 请求校验规则；配置后可用于生成缺失、空值、类型、枚举与格式用例。 */
  inputRule?: InputRule;
  /** 字符串或数组字段的长度规则；配置后可用于生成长度边界测试用例。 */
  lengthRule?: LengthRule;
  /** 缺省 true；false 表示已勾掉不生成（配置保留，仅跳过）。 */
  enabled?: boolean;
  /** object 的子字段；array 提供 children 时每个元素均为对象。 */
  /** 日期字段的比较规则；配置后可用于生成时间边界测试用例。 */
  dateRule?: DateComparisonRule;
  children?: MockField[];
}

export type OutputFormat = "json" | "jsonl" | "csv" | "sql" | "xml";
export type LeftMode = "batch" | "quick";

export interface GenerateOptions {
  seed?: string;
  locale?: LocaleId;
  scenario?: MockScenario;
  startIndex?: number;
  /** 按字段 id 覆盖生成值，用于从同一基准样本派生测试用例。 */
  overrides?: Record<string, unknown>;
  /** 按字段 id 省略属性，用于生成缺失字段用例。 */
  omitFieldIds?: string[];
  /** 按字段 id 强制字符串长度或数组元素个数，用于长度用例。 */
  lengthOverrides?: Record<string, number>;
  /** 参考时间与周岁计算所用的时区；缺省按本机时区。 */
  timeZone?: string;
}

export interface ExportOptions {
  sqlDialect?: "mysql" | "postgres" | "sqlite";
  csvDelimiter?: string;
  csvBom?: boolean;
  xmlRoot?: string;
  xmlItem?: string;
}

/** 项目 → 投标记录关联数据集配置。 */
export interface ProjectBidDatasetConfig {
  enabled?: boolean;
  /** 父记录（项目）数量。 */
  projectCount?: number;
  /** 每个项目生成的投标记录数。 */
  bidsPerProject?: number;
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
  /** 项目 → 投标记录关联数据集配置。 */
  projectBid?: ProjectBidDatasetConfig;
}
