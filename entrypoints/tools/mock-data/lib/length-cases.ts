/**
 * 字符串与数组字段的显式长度规则与边界测试用例生成。
 *
 * 规则与随机取样独立：批量生成仍按字符串长度集合 / 数组取样范围取值；
 * 这里只读取 lengthRule，从同一份基准样本按目标长度重建整行。
 */

import type { PathSegment } from "./case-paths";
import { valuesAtPath } from "./case-paths";
import { createCaseSetSeed } from "./case-seed";
import {
  charLength,
  generateRows,
  generationReferenceTime,
  getFieldType,
  normalizeTimeZone,
  parseLengths,
} from "./generators";
import type {
  CaseRuleSource,
  GenerateOptions,
  LengthRule,
  LocaleId,
  MockField,
  MockScenario,
} from "./types";

/** 单条用例允许构造的最大长度，避免一次生成超大字符串或数组。 */
export const MAX_CASE_LENGTH = 1000;

export interface LengthRuleTarget {
  kind: "length";
  fieldId: string;
  key: string;
  label: string;
  path: string;
  segments: PathSegment[];
  /** string 按字符计数，array 按元素个数计数。 */
  unit: "string" | "array";
  min?: number;
  max?: number;
  source: CaseRuleSource;
}

export interface LengthRuleIssue {
  fieldId?: string;
  path?: string;
  message: string;
}

export interface LengthTestCase {
  kind: "length";
  id: string;
  fieldKey: string;
  fieldPath: string;
  fieldLabel: string;
  /** 本用例的目标长度。 */
  value: number;
  rule: LengthRule & { unit: "string" | "array" };
  source: CaseRuleSource;
  expected: "pass" | "reject";
  coverage: string;
  reason: string;
  request: Record<string, unknown>;
}

export interface LengthTestCaseSet {
  seed: string;
  generation: {
    locale: LocaleId;
    scenario: MockScenario;
    referenceTime: string;
    timeZone: string;
  };
  templateId?: string;
  templateName?: string;
  targets: LengthRuleTarget[];
  cases: LengthTestCase[];
  issues: LengthRuleIssue[];
  summary: {
    total: number;
    pass: number;
    reject: number;
  };
}

export interface LengthTestCaseOptions {
  seed?: string;
  locale?: LocaleId;
  timeZone?: string;
  templateId?: string;
  templateName?: string;
  /** 未配置 lengthRule 时，按取样长度/元素个数推导边界用例。 */
  inferFromSampling?: boolean;
}

function lengthUnit(field: MockField): "string" | "array" | undefined {
  if (field.type === "string") return "string";
  if (field.type === "array") return "array";
  return undefined;
}

function sampleLength(value: unknown, fallback: number): number {
  if (typeof value === "string" && !value.trim()) return fallback;
  const parsed =
    typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : fallback;
}

/** 未配置长度规则时，从取样参数推导最小/最大长度。 */
function inferredLengthBounds(
  field: MockField,
  unit: "string" | "array",
): { min: number; max: number } {
  if (unit === "string") {
    const lengths = parseLengths(field.params.length);
    return {
      min: Math.min(...lengths),
      max: Math.max(...lengths),
    };
  }
  const first = sampleLength(field.params.minItems, 1);
  const last = sampleLength(field.params.maxItems, 3);
  return { min: Math.min(first, last), max: Math.max(first, last) };
}

/** 校验字段上的显式长度规则；返回面向用户的错误文案。 */
export function validateLengthRule(field: MockField): string[] {
  if (!field.lengthRule) return [];
  if (!lengthUnit(field)) {
    return ["当前字段类型不支持长度校验规则"];
  }
  const { min, max } = field.lengthRule;
  const issues: string[] = [];
  if (min === undefined && max === undefined) {
    issues.push("请至少填写最小长度或最大长度");
  }
  for (const [name, value] of [
    ["最小长度", min],
    ["最大长度", max],
  ] as const) {
    if (
      value !== undefined &&
      (!Number.isFinite(value) || !Number.isInteger(value) || value < 0)
    ) {
      issues.push(`${name}必须是非负整数`);
    }
  }
  if (min !== undefined && max !== undefined && min > max) {
    issues.push("最小长度不能大于最大长度");
  }
  return issues;
}

function collectTargets(
  fields: readonly MockField[],
  issues: LengthRuleIssue[],
  inferFromSampling: boolean,
  prefix = "",
  segments: PathSegment[] = [],
): LengthRuleTarget[] {
  const targets: LengthRuleTarget[] = [];
  for (const field of fields) {
    if (field.enabled === false || !field.key.trim()) continue;
    const path = prefix ? `${prefix}.${field.key}` : field.key;
    const fieldSegments = [...segments, { key: field.key, list: false }];

    const unit = lengthUnit(field);
    if (field.lengthRule && unit) {
      const messages = validateLengthRule(field);
      if (messages.length) {
        for (const message of messages) {
          issues.push({ fieldId: field.id, path, message });
        }
      } else {
        targets.push({
          kind: "length",
          fieldId: field.id,
          key: field.key,
          label: field.label ?? getFieldType(field.type)?.label ?? field.key,
          path,
          segments: fieldSegments,
          unit,
          min: field.lengthRule.min,
          max: field.lengthRule.max,
          source: "rule",
        });
      }
    } else if (field.lengthRule) {
      for (const message of validateLengthRule(field)) {
        issues.push({ fieldId: field.id, path, message });
      }
    } else if (inferFromSampling && unit) {
      targets.push({
        kind: "length",
        fieldId: field.id,
        key: field.key,
        label: field.label ?? getFieldType(field.type)?.label ?? field.key,
        path,
        segments: fieldSegments,
        unit,
        ...inferredLengthBounds(field, unit),
        source: "inferred",
      });
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

/** 收集所有已启用字段上的有效长度规则；无效规则以 issues 返回。 */
export function collectLengthRuleTargets(
  fields: readonly MockField[],
  options: { inferFromSampling?: boolean } = {},
): {
  targets: LengthRuleTarget[];
  issues: LengthRuleIssue[];
} {
  const issues: LengthRuleIssue[] = [];
  return {
    targets: collectTargets(fields, issues, options.inferFromSampling === true),
    issues,
  };
}

interface Candidate {
  length: number;
  coverage: string;
}

/** 基准长度优先取区间中点；只有上限时取上限的一半。 */
function baselineLength(target: LengthRuleTarget): number {
  const min = target.min ?? 0;
  const max = target.max ?? min;
  return Math.max(min, Math.min(Math.floor((min + max) / 2), max));
}

function candidatesFor(target: LengthRuleTarget): Candidate[] {
  const { min, max } = target;
  if (target.source === "inferred") {
    const candidates: Candidate[] = [];
    if (min !== undefined) {
      candidates.push({
        length: min,
        coverage: min === max ? "取样最小/最大长度" : "取样最小长度",
      });
    }
    if (max !== undefined && max !== min) {
      candidates.push({ length: max, coverage: "取样最大长度" });
    }
    return candidates.sort((a, b) => a.length - b.length);
  }
  const candidates: Candidate[] = [];
  const push = (length: number, coverage: string) => {
    if (length < 0) return;
    const existing = candidates.find((item) => item.length === length);
    if (existing) {
      if (existing.coverage !== coverage && min === max) {
        existing.coverage = "最小/最大长度";
      }
      return;
    }
    candidates.push({ length, coverage });
  };
  if (min !== undefined) {
    push(min - 1, "低于最小长度");
    push(min, "最小长度");
    push(min + 1, "最小长度 + 1");
  }
  if (max !== undefined) {
    push(max - 1, "最大长度 - 1");
    push(max, "最大长度");
    push(max + 1, "高于最大长度");
  }
  if (min !== undefined && max !== undefined && min === max) {
    for (const item of candidates) {
      if (item.length < min) item.coverage = "低于最小长度";
      else if (item.length > max) item.coverage = "高于最大长度";
      else item.coverage = "最小/最大长度";
    }
  }
  return candidates.sort((a, b) => a.length - b.length);
}

function actualLength(
  value: unknown,
  unit: "string" | "array",
): number | undefined {
  if (unit === "array") return Array.isArray(value) ? value.length : undefined;
  return typeof value === "string" ? charLength(value) : undefined;
}

function violationReason(
  value: unknown,
  target: LengthRuleTarget,
): string | undefined {
  const length = actualLength(value, target.unit);
  if (length === undefined) {
    return target.unit === "array" ? "不是数组" : "不是字符串";
  }
  if (target.min !== undefined && length < target.min) {
    return `长度 ${length} 低于最小长度 ${target.min}`;
  }
  if (target.max !== undefined && length > target.max) {
    return `长度 ${length} 高于最大长度 ${target.max}`;
  }
  return undefined;
}

interface Violation {
  target: LengthRuleTarget;
  length: number;
  reason: string;
}

function inspectRequest(
  request: Record<string, unknown>,
  targets: readonly LengthRuleTarget[],
): Violation[] {
  const violations: Violation[] = [];
  for (const target of targets) {
    for (const value of valuesAtPath(request, target.segments)) {
      const reason = violationReason(value, target);
      const length = actualLength(value, target.unit);
      if (reason && length !== undefined) {
        violations.push({ target, length, reason });
      } else if (reason) {
        violations.push({ target, length: -1, reason });
      }
    }
  }
  return violations;
}

/** 规则文案；用例操作面板与导出说明共用。 */
export function lengthRuleSummary(target: LengthRuleTarget): string {
  const unit = target.unit === "array" ? "元素" : "字符";
  if (target.min !== undefined && target.max !== undefined) {
    return `${target.min} ≤ ${unit}数 ≤ ${target.max}`;
  }
  if (target.min !== undefined) return `${unit}数 ≥ ${target.min}`;
  if (target.max !== undefined) return `${unit}数 ≤ ${target.max}`;
  return `${unit}数不受限`;
}

function emptySet(
  seed: string,
  options: LengthTestCaseOptions,
  targets: LengthRuleTarget[],
  issues: LengthRuleIssue[],
): LengthTestCaseSet {
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
 * 从同一份基准样本生成所有长度规则的边界用例。
 * 每条用例只覆盖目标长度，整行重算依赖字段与对象数组元素。
 */
export function generateLengthTestCases(
  fields: readonly MockField[],
  options: LengthTestCaseOptions = {},
): LengthTestCaseSet {
  const seed = createCaseSetSeed(options.seed);
  const locale = options.locale ?? "zh-CN";
  const { targets, issues } = collectLengthRuleTargets(fields, {
    inferFromSampling: options.inferFromSampling,
  });
  if (issues.length) {
    return emptySet(seed, { ...options, locale }, targets, issues);
  }
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
                "当前字段没有配置长度校验规则，请先在字符串或数组字段中填写最小、最大长度",
            },
          ],
    );
  }

  const tooLong = targets.find(
    (target) => target.min !== undefined && target.min > MAX_CASE_LENGTH,
  );
  if (tooLong) {
    return emptySet(seed, { ...options, locale }, targets, [
      {
        path: tooLong.path,
        message: `最小长度 ${tooLong.min} 超出单条用例生成上限 ${MAX_CASE_LENGTH}，无法构造基准样本`,
      },
    ]);
  }

  const baselineLengths: Record<string, number> = {};
  for (const target of targets) {
    baselineLengths[target.fieldId] = Math.min(
      Math.max(baselineLength(target), target.min ?? 0),
      Math.min(target.max ?? MAX_CASE_LENGTH, MAX_CASE_LENGTH),
    );
  }
  const timeZone = normalizeTimeZone(options.timeZone);
  const generation: GenerateOptions = {
    seed,
    locale,
    scenario: "normal",
    timeZone,
    lengthOverrides: baselineLengths,
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
  const baselineViolations = inspectRequest(baseline, targets);
  if (baselineViolations.length) {
    return emptySet(seed, { ...options, locale }, targets, [
      {
        path: baselineViolations[0].target.path,
        message: `无法构造满足规则的基准样本：${baselineViolations[0].reason}`,
      },
    ]);
  }
  const missingTarget = targets.find(
    (target) => valuesAtPath(baseline, target.segments).length === 0,
  );
  if (missingTarget) {
    return emptySet(seed, { ...options, locale }, targets, [
      {
        path: missingTarget.path,
        message: "无法构造基准样本：字段未出现在生成结果中（所在数组可能为空）",
      },
    ]);
  }

  const cases: LengthTestCase[] = [];
  const caseIssues: LengthRuleIssue[] = [];
  for (const target of targets) {
    for (const candidate of candidatesFor(target)) {
      if (candidate.length > MAX_CASE_LENGTH) {
        caseIssues.push({
          path: target.path,
          message: `目标长度 ${candidate.length} 超出单条用例生成上限 ${MAX_CASE_LENGTH}，未生成该候选`,
        });
        continue;
      }
      const request = generateRows(fields, 1, {
        ...generation,
        lengthOverrides: {
          ...baselineLengths,
          [target.fieldId]: candidate.length,
        },
      })[0];
      if (!request) continue;
      if (!valuesAtPath(request, target.segments).length) {
        caseIssues.push({
          path: target.path,
          message: "请求中没有该字段的值，无法单独验证目标规则",
        });
        continue;
      }
      const violations = inspectRequest(request, targets);
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
        kind: "length",
        id: `length-${cases.length + 1}`,
        fieldKey: target.key,
        fieldPath: target.path,
        fieldLabel: target.label,
        value: candidate.length,
        rule: {
          unit: target.unit,
          min: target.min,
          max: target.max,
        },
        source: target.source,
        expected: violations.length ? "reject" : "pass",
        coverage: candidate.coverage,
        reason: `${reasons.join("；")}。${
          target.source === "inferred" ? "取样范围" : "规则"
        }：${lengthRuleSummary(target)}`,
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
