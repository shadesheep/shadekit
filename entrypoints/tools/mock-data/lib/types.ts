/**
 * 模拟数据（mock-data）工具的类型定义。
 *
 * 设计要点：
 * - FieldTypeDef 以「声明式参数 schema」描述每种字段的可调参数，
 *   UI（App.vue）据此动态渲染参数控件，新增字段类型无需改动界面代码。
 * - MockField 是存储在 chrome.storage 中的可序列化行配置
 *   （key 可改名、params 按类型裁剪）。
 */

export type CategoryId = 'basic' | 'person' | 'business' | 'tender' | 'tech';

export interface CategoryDef {
  id: CategoryId;
  label: string;
  icon: string;
}

export type ParamKind = 'number' | 'text' | 'select';

/** 字段类型的单个可调参数声明 */
export interface FieldParamDef {
  /** 参数名（存入 MockField.params 的键） */
  name: string;
  /** 参数显示名 */
  label: string;
  kind: ParamKind;
  /** 默认值（number/text/select 统一用 string|number 表达） */
  default: string | number;
  min?: number;
  max?: number;
  /** kind = select 时的候选项 */
  options?: { value: string; label: string }[];
  placeholder?: string;
}

/** 单行生成上下文：index 为当前行序号（0 起），供自增/序号类字段使用 */
export interface GenContext {
  index: number;
}

/** 一种可生成的字段类型 */
export interface FieldTypeDef {
  /** 类型唯一标识（存入 MockField.type） */
  id: string;
  /** 显示名（如「姓名」「统一社会信用代码」） */
  label: string;
  category: CategoryId;
  /** 添加字段时的默认输出键名（重复时自动追加序号） */
  defaultKey: string;
  params: FieldParamDef[];
  /** 生成单条值；实现须容忍 params 缺失/非法（UI 输入为字符串） */
  generate: (params: Record<string, unknown>, ctx: GenContext) => unknown;
}

/** 一行字段配置（可序列化，持久化到 chrome.storage） */
export interface MockField {
  /** 稳定行 id（v-for key / 去重用） */
  id: string;
  /** 输出属性名（可编辑） */
  key: string;
  /** FieldTypeDef.id */
  type: string;
  /** 类型参数覆盖值（缺省参数由生成器回退默认值） */
  params: Record<string, unknown>;
}

export type OutputFormat = 'json' | 'jsonl' | 'csv' | 'sql' | 'xml';

/** 左侧面板模式：batch 批量生成 / quick 快速取数 */
export type LeftMode = 'batch' | 'quick';

/** mock-data 工具的持久化配置（storage key: devtools-mock-data） */
export interface MockDataConfig {
  fields?: MockField[];
  count?: number;
  format?: OutputFormat;
  tableName?: string;
  /** 结果视图：card 单条卡片 / table 表格 / code 源码 */
  viewMode?: 'card' | 'table' | 'code';
  /** 快速取数候选条数（默认 6，选项页可配） */
  quickCount?: number;
  /** 表格视图预览上限（默认 200，选项页可配） */
  tablePreviewLimit?: number;
  /** 字段/参数变化后自动重新生成（防抖） */
  autoGenerate?: boolean;
  /** 左侧面板模式（ADR-0008：顶栏归属当前模式作用域），重开页面恢复上次模式 */
  leftMode?: LeftMode;
  /** 允许多开标签页（background OPEN_TOOL_TAB 读取） */
  allowMultiple?: boolean;
}
