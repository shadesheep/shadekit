/**
 * 数值字段的显式校验规则与边界测试用例生成。
 *
 * 规则与随机取样范围独立：批量生成仍按 params.min/max/precision 取样；
 * 这里只读取 numericRule，从同一份基准样本派生每条请求。
 */

import type { PathSegment } from "./case-paths";
import { valuesAtPath } from "./case-paths";

import { createCaseSetSeed } from "./case-seed";
import {
  generateRows,
  generationReferenceTime,
  getFieldType,
  isNumericFieldType,
  normalizeTimeZone,
  numericDefaults,
} from "./generators";
import type {
  CaseRuleSource,
  GenerateOptions,
  LocaleId,
  MockField,
  MockScenario,
} from "./types";

export type { PathSegment } from "./case-paths";

export interface NumericRuleTarget {
  kind: "numeric";
  fieldId: string;
  key: string;
  label: string;
  /** 展示用路径，如 budget、items[].amount。 */
  path: string;
  segments: PathSegment[];
  min?: number;
  max?: number;
  precision: number;
  source: CaseRuleSource;
}

export interface NumericRuleIssue {
  fieldId?: string;
  path?: string;
  message: string;
}

export interface NumericTestCase {
  kind: "numeric";
  id: string;
  fieldKey: string;
  fieldPath: string;
  fieldLabel: string;
  /** 本用例覆盖的目标值。 */
  value: number;
  rule: { min?: number; max?: number; precision: number };
  source: CaseRuleSource;
  expected: "pass" | "reject";
  coverage: string;
  reason: string;
  request: Record<string, unknown>;
}

export interface NumericTestCaseSet {
  seed: string;
  generation: {
    locale: LocaleId;
    scenario: MockScenario;
    /** 计算周岁等按日字段所用的基准时刻（ISO 8601）。 */
    referenceTime: string;
    /** 基准时刻所属时区（IANA 名称或 local）。 */
    timeZone: string;
  };
  templateId?: string;
  templateName?: string;
  targets: NumericRuleTarget[];
  cases: NumericTestCase[];
  issues: NumericRuleIssue[];
  summary: {
    total: number;
    pass: number;
    reject: number;
  };
}

export interface NumericTestCaseOptions {
  seed?: string;
  locale?: LocaleId;
  timeZone?: string;
  templateId?: string;
  templateName?: string;
  /** 未配置 numericRule 时，按取样上下限推导边界用例。 */
  inferFromSampling?: boolean;
}

interface Candidate {
  units: number;
  coverage: string;
}

/** 规则步长；缺省时由取样小数位换算（如 2 位 → 0.01）。 */
function ruleStep(field: MockField): number {
  const raw = field.numericRule?.precision;
  if (raw !== undefined) return raw;
  const fallback = numericDefaults(field.type)?.precision ?? 0;
  const configured = Number(field.params.precision);
  const samplePrecision = Number.isFinite(configured) ? configured : fallback;
  return 10 ** -Math.min(Math.max(Math.trunc(samplePrecision), 0), 6);
}

function stepDecimals(step: number): number {
  for (let decimals = 0; decimals <= 6; decimals += 1) {
    const scaled = step * 10 ** decimals;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9) return decimals;
  }
  return 6;
}

function sampleNumber(value: unknown, fallback: number): number {
  if (typeof value === "string" && !value.trim()) return fallback;
  const parsed =
    typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 用取样上下限推导边界；步长按取样精度换算，整数类型固定为 1。 */
function inferredNumericRule(
  field: MockField,
): { min: number; max: number; precision: number } | undefined {
  // 金额大写按数值取样但输出字符串，不能把取样区间当数值边界。
  const defaults =
    field.type === "moneyCn" ? undefined : numericDefaults(field.type);
  if (!defaults) return undefined;
  const first = sampleNumber(field.params.min, defaults.min);
  const last = sampleNumber(field.params.max, defaults.max);
  const rawMin = Math.min(first, last);
  const rawMax = Math.max(first, last);
  const precision = defaults.integer
    ? 1
    : 10 **
      -Math.min(
        Math.max(
          Math.trunc(sampleNumber(field.params.precision, defaults.precision)),
          0,
        ),
        6,
      );
  let min = fromUnits(Math.ceil(toUnits(rawMin, precision)), precision);
  let max = fromUnits(Math.floor(toUnits(rawMax, precision)), precision);
  if (min > max) {
    min = fromUnits(Math.round(toUnits(rawMin, precision)), precision);
    max = min;
  }
  return { min, max, precision };
}

/**
 * 校验字段上的显式数值规则；返回面向用户的错误文案。
 * 没有 numericRule 或类型不是数值字段时返回空数组。
 */
export function validateNumericRule(field: MockField): string[] {
  if (!field.numericRule) return [];
  if (!isNumericFieldType(field.type)) {
    return ["当前字段类型不支持数值校验规则"];
  }
  const { min, max } = field.numericRule;
  const issues: string[] = [];
  const step = ruleStep(field);
  if (min === undefined && max === undefined) {
    issues.push("请至少填写校验下限或校验上限");
  }
  for (const [name, value] of [
    ["校验下限", min],
    ["校验上限", max],
  ] as const) {
    if (value !== undefined && !Number.isFinite(value)) {
      issues.push(`${name}必须是数字`);
    }
  }
  if (!Number.isFinite(step) || step <= 0) {
    issues.push("校验精度必须是大于 0 的步长（如 0.01）");
  } else if (Math.abs(step * 1e6 - Math.round(step * 1e6)) > 1e-6) {
    issues.push("校验精度最多允许 6 位小数");
  } else {
    for (const [name, value] of [
      ["校验下限", min],
      ["校验上限", max],
    ] as const) {
      if (
        value !== undefined &&
        Number.isFinite(value) &&
        Math.abs(value / step - Math.round(value / step)) > 1e-6
      ) {
        issues.push(`${name}必须对齐校验精度 ${step}`);
      }
    }
  }
  if (min !== undefined && max !== undefined && min > max) {
    issues.push("校验下限不能大于校验上限");
  }
  return issues;
}

function collectTargets(
  fields: readonly MockField[],
  issues: NumericRuleIssue[],
  inferFromSampling: boolean,
  prefix = "",
  segments: PathSegment[] = [],
): NumericRuleTarget[] {
  const targets: NumericRuleTarget[] = [];
  for (const field of fields) {
    if (field.enabled === false || !field.key.trim()) continue;
    const path = prefix ? `${prefix}.${field.key}` : field.key;
    const fieldSegments = [...segments, { key: field.key, list: false }];

    if (field.numericRule) {
      const messages = validateNumericRule(field);
      if (messages.length) {
        for (const message of messages) {
          issues.push({ fieldId: field.id, path, message });
        }
      } else {
        targets.push({
          kind: "numeric",
          fieldId: field.id,
          key: field.key,
          label: field.label ?? getFieldType(field.type)?.label ?? field.key,
          path,
          segments: fieldSegments,
          min: field.numericRule.min,
          max: field.numericRule.max,
          precision: ruleStep(field),
          source: "rule",
        });
      }
    } else if (inferFromSampling && isNumericFieldType(field.type)) {
      const inferred = inferredNumericRule(field);
      if (inferred) {
        targets.push({
          kind: "numeric",
          fieldId: field.id,
          key: field.key,
          label: field.label ?? getFieldType(field.type)?.label ?? field.key,
          path,
          segments: fieldSegments,
          ...inferred,
          source: "inferred",
        });
      }
    }

    if (!field.children?.length) continue;
    if (field.type !== "object" && field.type !== "array") continue;
    const childPrefix = field.type === "array" ? `${path}[].` : `${path}.`;
    const childSegments =
      field.type === "array"
        ? [...segments, { key: field.key, list: true }]
        : fieldSegments;
    targets.push(
      ...collectTargets(
        field.children,
        issues,
        inferFromSampling,
        childPrefix.slice(0, -1),
        childSegments,
      ),
    );
  }
  return targets;
}

/** 收集所有已启用字段上的有效数值规则；无效规则以 issues 返回。 */
export function collectNumericRuleTargets(
  fields: readonly MockField[],
  options: { inferFromSampling?: boolean } = {},
): {
  targets: NumericRuleTarget[];
  issues: NumericRuleIssue[];
} {
  const issues: NumericRuleIssue[] = [];
  return {
    targets: collectTargets(fields, issues, options.inferFromSampling === true),
    issues,
  };
}

function toUnits(value: number, step: number): number {
  return Math.round(value / step);
}

function fromUnits(units: number, step: number): number {
  return Number((units * step).toFixed(stepDecimals(step)));
}

function baselineUnits(target: NumericRuleTarget): number {
  const min =
    target.min === undefined
      ? undefined
      : toUnits(target.min, target.precision);
  const max =
    target.max === undefined
      ? undefined
      : toUnits(target.max, target.precision);
  if (min !== undefined && max !== undefined)
    return Math.round((min + max) / 2);
  return min ?? max ?? 0;
}

function candidatesFor(target: NumericRuleTarget): Candidate[] {
  const step = target.precision;
  const min = target.min === undefined ? undefined : toUnits(target.min, step);
  const max = target.max === undefined ? undefined : toUnits(target.max, step);
  if (target.source === "inferred") {
    const units: Candidate[] = [];
    if (min !== undefined) {
      units.push({
        units: min,
        coverage: min === max ? "取样下限/上限" : "取样下限",
      });
    }
    if (max !== undefined && max !== min) {
      units.push({ units: max, coverage: "取样上限" });
    }
    return units.sort((a, b) => a.units - b.units);
  }
  const units: Candidate[] = [];
  const push = (value: number, coverage: string) => {
    if (!units.some((item) => item.units === value)) {
      units.push({ units: value, coverage });
    }
  };
  if (min !== undefined) {
    push(min - 1, "低于下限");
    push(min, "下限");
    push(min + 1, "下限 + 1 单位");
  }
  if (max !== undefined) {
    push(max - 1, "上限 - 1 单位");
    push(max, "上限");
    push(max + 1, "高于上限");
  }
  if (min !== undefined && max !== undefined && min === max) {
    const first = units.findIndex((item) => item.units === min);
    if (first >= 0) units[first].coverage = "下限/上限";
    for (const item of units) {
      if (item.units > min) item.coverage = "高于上限";
      else if (item.units < min) item.coverage = "低于下限";
    }
  }
  return units.sort((a, b) => a.units - b.units);
}

function violationReason(
  value: unknown,
  target: NumericRuleTarget,
): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "不是有效数值";
  }
  const units = value / target.precision;
  if (Math.abs(units - Math.round(units)) > 1e-6) {
    return `不符合校验精度 ${target.precision} 的步长`;
  }
  if (target.min !== undefined && value < target.min) {
    return `低于校验下限 ${target.min}`;
  }
  if (target.max !== undefined && value > target.max) {
    return `高于校验上限 ${target.max}`;
  }
  return undefined;
}

interface Violation {
  target: NumericRuleTarget;
  value: unknown;
  reason: string;
}

function inspectRow(
  request: Record<string, unknown>,
  targets: readonly NumericRuleTarget[],
): Violation[] {
  const violations: Violation[] = [];
  for (const target of targets) {
    for (const value of valuesAtPath(request, target.segments)) {
      const reason = violationReason(value, target);
      if (reason) violations.push({ target, value, reason });
    }
  }
  return violations;
}

/** 规则文案；用例操作面板与导出说明共用。 */
export function numericRuleSummary(target: NumericRuleTarget): string {
  const precision = `精度 ${target.precision}`;
  if (target.min !== undefined && target.max !== undefined) {
    return `${target.min} ≤ 值 ≤ ${target.max}（${precision}）`;
  }
  if (target.min !== undefined) return `值 ≥ ${target.min}（${precision}）`;
  if (target.max !== undefined) return `值 ≤ ${target.max}（${precision}）`;
  return precision;
}

function emptySet(
  seed: string,
  options: NumericTestCaseOptions,
  targets: NumericRuleTarget[],
  issues: NumericRuleIssue[],
): NumericTestCaseSet {
  return {
    seed,
    generation: {
      locale: options.locale ?? "zh-CN",
      scenario: "normal",
      referenceTime: new Date(generationReferenceTime(seed)).toISOString(),
      timeZone: normalizeTimeZone(options.timeZone),
    },
    targets,
    cases: [],
    issues,
    summary: { total: 0, pass: 0, reject: 0 },
  };
}

/**
 * 从同一份基准样本生成所有数值规则的边界用例。
 * 每条用例覆盖目标值后整行重算，派生字段因此始终与来源一致。
 */
export function generateNumericTestCases(
  fields: readonly MockField[],
  options: NumericTestCaseOptions = {},
): NumericTestCaseSet {
  const seed = createCaseSetSeed(options.seed);
  const locale = options.locale ?? "zh-CN";
  const { targets, issues } = collectNumericRuleTargets(fields, {
    inferFromSampling: options.inferFromSampling,
  });
  if (issues.length)
    return emptySet(seed, { ...options, locale }, targets, issues);
  if (!targets.length) {
    return emptySet(
      seed,
      { ...options, locale },
      targets,
      options.inferFromSampling
        ? []
        : [
            {
              message:
                "当前字段没有配置数值校验规则，请先在数值字段中填写校验下限或上限",
            },
          ],
    );
  }

  const baselineOverrides: Record<string, unknown> = {};
  for (const target of targets) {
    baselineOverrides[target.fieldId] = fromUnits(
      baselineUnits(target),
      target.precision,
    );
  }
  const timeZone = normalizeTimeZone(options.timeZone);
  const generation: GenerateOptions = {
    seed,
    locale,
    scenario: "normal",
    timeZone,
    overrides: baselineOverrides,
  };

  let baseline: Record<string, unknown>;
  try {
    [baseline] = generateRows(fields, 1, generation);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return emptySet(seed, { ...options, locale }, targets, [
      { message: `无法构造基准样本：${message}` },
    ]);
  }
  if (!baseline) {
    return emptySet(seed, { ...options, locale }, targets, [
      { message: "无法构造基准样本：生成器未返回数据" },
    ]);
  }
  const baselineViolations = inspectRow(baseline, targets);
  if (baselineViolations.length) {
    return emptySet(seed, { ...options, locale }, targets, [
      {
        message: `无法构造满足规则的基准样本：字段「${baselineViolations[0].target.path}」${baselineViolations[0].reason}`,
      },
    ]);
  }
  const missingTarget = targets.find(
    (target) => valuesAtPath(baseline, target.segments).length === 0,
  );
  if (missingTarget) {
    return emptySet(seed, { ...options, locale }, targets, [
      {
        message: `无法构造基准样本：字段「${missingTarget.path}」未出现在生成结果中（数组可能为空）`,
      },
    ]);
  }

  const cases: NumericTestCase[] = [];
  const caseIssues: NumericRuleIssue[] = [];
  for (const target of targets) {
    for (const candidate of candidatesFor(target)) {
      const value = fromUnits(candidate.units, target.precision);
      const request = generateRows(fields, 1, {
        ...generation,
        overrides: { ...baselineOverrides, [target.fieldId]: value },
      })[0];
      if (!request) continue;
      if (!valuesAtPath(request, target.segments).length) {
        caseIssues.push({
          path: target.path,
          message: "请求中没有该字段的值，无法单独验证目标规则",
        });
        continue;
      }
      const violations = inspectRow(request, targets);
      const targetViolation = violations.find(
        (item) => item.target.fieldId === target.fieldId,
      );
      const otherViolations = violations.filter(
        (item) => item.target.fieldId !== target.fieldId,
      );
      const reasons: string[] = [];
      if (targetViolation) {
        reasons.push(`目标规则未通过：${targetViolation.reason}`);
      } else {
        reasons.push("通过目标规则");
      }
      if (otherViolations.length) {
        reasons.push(
          `同时触发其他规则：${otherViolations
            .map((item) => `字段「${item.target.path}」${item.reason}`)
            .join("；")}`,
        );
      }
      cases.push({
        kind: "numeric",
        id: `case-${cases.length + 1}`,
        fieldKey: target.key,
        fieldPath: target.path,
        fieldLabel: target.label,
        value,
        rule: {
          min: target.min,
          max: target.max,
          precision: target.precision,
        },
        source: target.source,
        expected: violations.length ? "reject" : "pass",
        coverage: candidate.coverage,
        reason: `${reasons.join("；")}。${
          target.source === "inferred" ? "取样范围" : "规则"
        }：${numericRuleSummary(target)}`,
        request,
      });
    }
  }

  const pass = cases.filter((item) => item.expected === "pass").length;
  return {
    seed,
    generation: {
      locale,
      scenario: "normal",
      referenceTime: new Date(generationReferenceTime(seed)).toISOString(),
      timeZone,
    },
    templateId: options.templateId,
    templateName: options.templateName,
    targets,
    cases,
    issues: caseIssues,
    summary: { total: cases.length, pass, reject: cases.length - pass },
  };
}
