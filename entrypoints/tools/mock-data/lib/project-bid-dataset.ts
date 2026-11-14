/**
 * 「项目 → 投标记录」关联数据集。
 *
 * 父记录复用「招标项目」字段（项目编号、项目名称、预算），项目编号在数据集内唯一；
 * 子记录复用招投标与投标人业务字段，并通过项目编号引用父记录，名称与预算直接取自
 * 同一条父记录。生成顺序固定为：先生成全部项目，再按项目顺序逐个项目生成投标记录；
 * 每个项目使用由 Seed、项目序号与项目编号派生的独立随机流，因此相同 Seed 下预览、
 * 下载与不同批次大小得到相同的父子记录。
 */
import { createCaseSetSeed } from "./case-seed";
import {
  generateRows,
  generationReferenceTime,
  MAX_ROWS,
  sanitizeFields,
} from "./generators";
import type { TemplateRow } from "./templates";
import type {
  LocaleId,
  MockField,
  MockScenario,
  ProjectBidDatasetConfig,
} from "./types";

export const PROJECT_BID_PARENT_KEY = "projectCode";
export const PROJECT_BID_NAME_KEY = "projectName";
export const PROJECT_BID_BUDGET_KEY = "budget";

export const DATASET_MAX_PROJECTS = 1000;
export const DATASET_MAX_BIDS_PER_PROJECT = 1000;
export const DATASET_DEFAULT_PROJECTS = 2;
export const DATASET_DEFAULT_BIDS_PER_PROJECT = 3;

/** 子记录（投标记录）字段：复用现有招投标与企业字段类型。 */
export const BID_RECORD_ROWS: TemplateRow[] = [
  {
    key: "bidCode",
    type: "sectionCode",
    label: "投标编号",
    params: { prefix: "B" },
    constraints: { unique: true },
  },
  { key: "projectCode", type: "projectCode", label: "项目编号" },
  { key: "projectName", type: "projectName", label: "项目名称" },
  { key: "budget", type: "budget", label: "项目预算" },
  { key: "bidderName", type: "company", label: "投标单位" },
  { key: "uscc", type: "uscc", label: "统一社会信用代码" },
  { key: "contactName", type: "name", label: "联系人" },
  { key: "contactPhone", type: "phone", label: "联系电话" },
  { key: "bidAmount", type: "budget", label: "投标报价" },
  { key: "bondAmount", type: "bondAmount", label: "投标保证金" },
  {
    key: "bidStatus",
    type: "enum",
    label: "投标状态",
    params: { values: "已提交,已撤回,已中标" },
  },
];

export const BID_FIELD_LABELS: Record<string, string> = Object.fromEntries(
  BID_RECORD_ROWS.map((row) => [row.key, row.label ?? row.key]),
);

export interface ProjectBidDatasetOptions {
  seed?: string;
  locale?: LocaleId;
  scenario?: MockScenario;
  timeZone?: string;
  projectCount?: number;
  bidsPerProject?: number;
}

export interface ProjectBidGroup {
  /** 父记录本身；子记录共享其中的编号、名称与预算。 */
  project: Record<string, unknown>;
  projectCode: string;
  bids: Record<string, unknown>[];
}

export interface ProjectBidDataset {
  seed: string;
  generation: {
    locale: LocaleId;
    scenario: MockScenario;
    referenceTime: string;
    timeZone: string;
  };
  projects: Record<string, unknown>[];
  bids: Record<string, unknown>[];
  groups: ProjectBidGroup[];
  summary: {
    projects: number;
    bidsPerProject: number;
    bids: number;
  };
}

function normalizeCount(value: unknown, fallback: number, max: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), 1), max);
}

/** 数据集依赖的三个父字段；找不到时给出可直接操作的提示。 */
export function projectBidIssues(fields: readonly MockField[]): string[] {
  const enabled = fields.filter(
    (field) => field.enabled !== false && field.key.trim(),
  );
  const issues: string[] = [];
  const required: Array<{ key: string; type: string; label: string }> = [
    { key: PROJECT_BID_PARENT_KEY, type: "projectCode", label: "项目编号" },
    { key: PROJECT_BID_NAME_KEY, type: "projectName", label: "项目名称" },
    { key: PROJECT_BID_BUDGET_KEY, type: "budget", label: "预算金额" },
  ];
  for (const item of required) {
    const field = enabled.find(
      (candidate) => candidate.key.trim() === item.key,
    );
    if (!field) {
      issues.push(
        `关联数据集需要「${item.label}」字段（${item.key}）；请先载入「招标项目」场景`,
      );
    } else if (field.type !== item.type) {
      issues.push(`「${item.key}」必须是${item.label}类型`);
    }
  }
  return issues;
}

/** 数据集总量校验；预览与下载共用同一提示。 */
export function projectBidCountIssues(
  config: ProjectBidDatasetConfig | undefined,
): string[] {
  const projectCount = normalizeCount(
    config?.projectCount,
    DATASET_DEFAULT_PROJECTS,
    DATASET_MAX_PROJECTS,
  );
  const bidsPerProject = normalizeCount(
    config?.bidsPerProject,
    DATASET_DEFAULT_BIDS_PER_PROJECT,
    DATASET_MAX_BIDS_PER_PROJECT,
  );
  return projectCount * bidsPerProject > MAX_ROWS
    ? [`项目数与每项目投标记录数的乘积不能超过 ${MAX_ROWS}`]
    : [];
}

/** 父记录编号在数据集内唯一；其余字段沿用模板参数。 */
function parentFields(fields: readonly MockField[]): MockField[] {
  const cloned = JSON.parse(JSON.stringify(fields)) as MockField[];
  for (const field of cloned) {
    if (field.key.trim() !== PROJECT_BID_PARENT_KEY) continue;
    field.constraints = { ...field.constraints, unique: true };
  }
  return cloned;
}

function sharedProjectValues(
  fields: readonly MockField[],
  project: Record<string, unknown>,
  codeFieldId: string,
  nameFieldId: string,
  budgetFieldId: string,
): Record<string, unknown> {
  const codeField = fields.find(
    (field) => field.key === PROJECT_BID_PARENT_KEY,
  );
  const nameField = fields.find((field) => field.key === PROJECT_BID_NAME_KEY);
  const budgetField = fields.find(
    (field) => field.key === PROJECT_BID_BUDGET_KEY,
  );
  if (!codeField || !nameField || !budgetField) {
    throw new Error("关联数据集缺少项目编号、项目名称或预算字段");
  }
  return {
    [codeFieldId]: project[codeField.key],
    [nameFieldId]: project[nameField.key],
    [budgetFieldId]: project[budgetField.key],
  };
}

/**
 * 生成整套关联数据集。相同 Seed、字段与数量总是得到相同结果；
 * 返回的 seed 在未指定 Seed 时生成一次，供预览与下载复用。
 */
export function generateProjectBidDataset(
  fields: readonly MockField[],
  options: ProjectBidDatasetOptions = {},
): ProjectBidDataset {
  const fieldIssues = projectBidIssues(fields);
  if (fieldIssues.length) throw new Error(fieldIssues.join("；"));

  const projectCount = normalizeCount(
    options.projectCount,
    DATASET_DEFAULT_PROJECTS,
    DATASET_MAX_PROJECTS,
  );
  const bidsPerProject = normalizeCount(
    options.bidsPerProject,
    DATASET_DEFAULT_BIDS_PER_PROJECT,
    DATASET_MAX_BIDS_PER_PROJECT,
  );
  if (projectCount * bidsPerProject > MAX_ROWS) {
    throw new Error(`项目数与每项目投标记录数的乘积不能超过 ${MAX_ROWS}`);
  }

  const seed = createCaseSetSeed(options.seed);
  const common = {
    locale: options.locale,
    scenario: options.scenario,
    timeZone: options.timeZone,
  } as const;

  const parents = parentFields(fields);
  const projects = generateRows(parents, projectCount, {
    ...common,
    seed,
  });

  const children = sanitizeFields(BID_RECORD_ROWS);
  const childByKey = new Map(
    children.map((field) => [field.key.trim(), field]),
  );
  const codeField = childByKey.get(PROJECT_BID_PARENT_KEY);
  const nameField = childByKey.get(PROJECT_BID_NAME_KEY);
  const budgetField = childByKey.get(PROJECT_BID_BUDGET_KEY);
  if (!codeField || !nameField || !budgetField) {
    throw new Error("投标记录模板缺少项目编号、项目名称或预算字段");
  }

  const groups: ProjectBidGroup[] = [];
  const bids: Record<string, unknown>[] = [];
  for (const [index, project] of projects.entries()) {
    const projectCode = String(project[PROJECT_BID_PARENT_KEY] ?? "");
    const rows = generateRows(children, bidsPerProject, {
      ...common,
      seed: `${seed}|bids|${index}|${projectCode}`,
      overrides: sharedProjectValues(
        parents,
        project,
        codeField.id,
        nameField.id,
        budgetField.id,
      ),
    });
    groups.push({ project, projectCode, bids: rows });
    bids.push(...rows);
  }

  return {
    seed,
    generation: {
      locale: options.locale === "en-US" ? "en-US" : "zh-CN",
      scenario: options.scenario ?? "normal",
      referenceTime: new Date(generationReferenceTime(seed)).toISOString(),
      timeZone: options.timeZone ?? "local",
    },
    projects,
    bids,
    groups,
    summary: {
      projects: projectCount,
      bidsPerProject,
      bids: projectCount * bidsPerProject,
    },
  };
}

export const PROJECT_BID_DATASET_KIND = "shadekit-mock-project-bids";

/** 整套数据集 JSON：项目与投标记录并列，投标记录通过项目编号引用父记录。 */
export function serializeProjectBidDataset(dataset: ProjectBidDataset): string {
  return `${JSON.stringify(
    {
      kind: PROJECT_BID_DATASET_KIND,
      schemaVersion: 1,
      seed: dataset.seed,
      generation: dataset.generation,
      summary: dataset.summary,
      projects: dataset.projects,
      bids: dataset.bids,
    },
    null,
    2,
  )}\n`;
}
