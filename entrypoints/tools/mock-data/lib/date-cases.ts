/**
 * 日期字段的显式比较规则与时间边界测试用例生成。
 *
 * 规则与随机取样独立：批量生成仍按字段参数取值；这里固定参照字段的基准值，
 * 再把目标字段设为早一个精度单位、相等、晚一个精度单位，并整行重算依赖字段。
 */

import type { PathSegment } from "./case-paths";
import { valuesAtPath } from "./case-paths";
import { createCaseSetSeed } from "./case-seed";
import {
  formatDateTime,
  generateRows,
  generationReferenceTime,
  getFieldType,
  normalizeTimeZone,
  parseDateTimeText,
} from "./generators";
import type {
  CaseRuleSource,
  DateCompareDirection,
  DateComparePrecision,
  GenerateOptions,
  LocaleId,
  MockField,
  MockScenario,
} from "./types";

export interface DateOutput {
  /** date / datetime / timestamp / timestamp_s / auto */
  format: string;
  timeZone: string;
}

export interface DateRuleTarget {
  kind: "date";
  fieldId: string;
  fieldKey: string;
  fieldLabel: string;
  path: string;
  segments: PathSegment[];
  otherFieldId: string;
  otherFieldKey: string;
  otherFieldLabel: string;
  otherPath: string;
  otherSegments: PathSegment[];
  direction: DateCompareDirection;
  precision: DateComparePrecision;
  output: DateOutput;
  referenceOutput: DateOutput;
  source: CaseRuleSource;
}

export interface DateRuleIssue {
  fieldId?: string;
  path?: string;
  message: string;
}

export interface DateTestCase {
  kind: "date";
  id: string;
  fieldKey: string;
  fieldPath: string;
  fieldLabel: string;
  /** 本用例写入目标字段的序列化值。 */
  value: string | number;
  rule: {
    referenceKey: string;
    referencePath: string;
    referenceLabel: string;
    referenceValue: string | number;
    direction: DateCompareDirection;
    precision: DateComparePrecision;
  };
  source: CaseRuleSource;
  expected: "pass" | "reject";
  coverage: string;
  reason: string;
  request: Record<string, unknown>;
}

export interface DateTestCaseSet {
  seed: string;
  generation: {
    locale: LocaleId;
    scenario: MockScenario;
    referenceTime: string;
    timeZone: string;
  };
  templateId?: string;
  templateName?: string;
  targets: DateRuleTarget[];
  cases: DateTestCase[];
  issues: DateRuleIssue[];
  summary: {
    total: number;
    pass: number;
    reject: number;
  };
}

export interface DateTestCaseOptions {
  seed?: string;
  locale?: LocaleId;
  timeZone?: string;
  templateId?: string;
  templateName?: string;
  /** 合并入口启用取样推导时，不再提示「未配置日期比较规则」。 */
  inferFromSampling?: boolean;
}

const DATE_TYPES: Record<string, true> = {
  date: true,
  registrationDeadline: true,
  openBidTime: true,
};
const DIRECTIONS: Record<DateCompareDirection, true> = {
  after: true,
  before: true,
  notBefore: true,
  notAfter: true,
};
const PRECISIONS: Record<DateComparePrecision, true> = {
  day: true,
  hour: true,
  minute: true,
  second: true,
};
const PRECISION_RANK: Record<DateComparePrecision, number> = {
  day: 0,
  hour: 1,
  minute: 2,
  second: 3,
};
const PRECISION_MS: Record<DateComparePrecision, number> = {
  day: 86400000,
  hour: 3600000,
  minute: 60000,
  second: 1000,
};
const PRECISION_LABEL: Record<DateComparePrecision, string> = {
  day: "天",
  hour: "小时",
  minute: "分钟",
  second: "秒",
};
const DIRECTION_LABEL: Record<DateCompareDirection, string> = {
  after: "严格晚于",
  before: "严格早于",
  notBefore: "不早于",
  notAfter: "不晚于",
};

export function isDateComparable(field: MockField): boolean {
  if (field.type === "derived") {
    return String(field.params.transform ?? "") === "dateAfter";
  }
  return Boolean(DATE_TYPES[field.type]);
}

function fieldOutput(field: MockField): DateOutput {
  const timeZone = String(field.params.timezone ?? "local");
  if (field.type === "date") {
    return { format: String(field.params.format ?? "date"), timeZone };
  }
  if (field.type === "derived") {
    return { format: String(field.params.format ?? "auto"), timeZone };
  }
  return { format: "datetime", timeZone };
}

/** 校验日期比较规则；返回面向用户的错误文案。 */
export function validateDateRule(
  field: MockField,
  siblings: readonly MockField[],
): string[] {
  const rule = field.dateRule;
  if (!rule) return [];
  const issues: string[] = [];
  if (!isDateComparable(field)) {
    issues.push("当前字段类型不支持日期比较规则");
  }
  if (!rule.fieldId) {
    issues.push("请选择要比较的日期字段");
  }
  if (!DIRECTIONS[rule.direction]) {
    issues.push("日期比较方向无效");
  }
  if (!PRECISIONS[rule.precision]) {
    issues.push("日期比较精度无效");
    return issues;
  }
  const other = siblings.find((item) => item.id === rule.fieldId);
  if (!other) {
    if (rule.fieldId) issues.push("要比较的日期字段不存在");
  } else if (other.id === field.id) {
    issues.push("日期比较不能引用自身");
  } else if (other.enabled === false) {
    issues.push(`要比较的日期字段「${other.key}」已禁用`);
  } else if (!isDateComparable(other)) {
    issues.push(`要比较的字段「${other.key}」不是日期字段`);
  } else {
    for (const [name, target] of [
      ["当前字段", field],
      ["参照字段", other],
    ] as const) {
      const format = fieldOutput(target).format;
      const limit: DateComparePrecision = format === "date" ? "day" : "second";
      if (PRECISION_RANK[rule.precision] > PRECISION_RANK[limit]) {
        issues.push(
          `${name}「${target.key}」输出格式只精确到${PRECISION_LABEL[limit]}，无法按${PRECISION_LABEL[rule.precision]}比较`,
        );
      }
    }
  }
  return issues;
}

function collectTargets(
  fields: readonly MockField[],
  issues: DateRuleIssue[],
  prefix = "",
  segments: PathSegment[] = [],
): DateRuleTarget[] {
  const targets: DateRuleTarget[] = [];
  for (const field of fields) {
    if (field.enabled === false || !field.key.trim()) continue;
    const path = prefix ? `${prefix}.${field.key}` : field.key;
    const fieldSegments = [...segments, { key: field.key, list: false }];

    if (field.dateRule) {
      const messages = validateDateRule(field, fields);
      if (messages.length) {
        for (const message of messages) {
          issues.push({ fieldId: field.id, path, message });
        }
      } else {
        const other = fields.find(
          (item) => item.id === field.dateRule?.fieldId,
        );
        if (other) {
          targets.push({
            kind: "date",
            fieldId: field.id,
            fieldKey: field.key,
            fieldLabel:
              field.label ?? getFieldType(field.type)?.label ?? field.key,
            path,
            segments: fieldSegments,
            otherFieldId: other.id,
            otherFieldKey: other.key,
            otherFieldLabel:
              other.label ?? getFieldType(other.type)?.label ?? other.key,
            otherPath: prefix ? `${prefix}.${other.key}` : other.key,
            otherSegments: [...segments, { key: other.key, list: false }],
            direction: field.dateRule.direction,
            precision: field.dateRule.precision,
            output: fieldOutput(field),
            referenceOutput: fieldOutput(other),
            source: "rule",
          });
        }
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
        childPrefix.slice(0, -1),
        childSegments,
      ),
    );
  }
  return targets;
}

/** 收集所有已启用字段上的有效日期比较规则；无效规则以 issues 返回。 */
export function collectDateRuleTargets(fields: readonly MockField[]): {
  targets: DateRuleTarget[];
  issues: DateRuleIssue[];
} {
  const issues: DateRuleIssue[] = [];
  return { targets: collectTargets(fields, issues), issues };
}

function parseSerializedDate(
  value: unknown,
  output: DateOutput,
): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    return output.format === "timestamp_s" ? value * 1000 : value;
  }
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (/^-?\d+$/.test(text)) {
    const numeric = Number(text);
    return output.format === "timestamp_s" ? numeric * 1000 : numeric;
  }
  return parseDateTimeText(text, output.timeZone);
}

function serializeDateValue(
  instant: number,
  output: DateOutput,
  baseline: unknown,
): string | number {
  const date = new Date(instant);
  if (output.format === "timestamp") return instant;
  if (output.format === "timestamp_s") return Math.floor(instant / 1000);
  if (output.format === "date") {
    return formatDateTime(date, "date", output.timeZone);
  }
  if (output.format === "datetime") {
    return formatDateTime(date, "datetime", output.timeZone);
  }
  if (typeof baseline === "number") return instant;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(baseline))) {
    return formatDateTime(date, "date", output.timeZone);
  }
  return formatDateTime(date, "datetime", output.timeZone);
}

function compareDirection(
  direction: DateCompareDirection,
  target: number,
  reference: number,
): boolean {
  if (direction === "after") return target > reference;
  if (direction === "before") return target < reference;
  if (direction === "notBefore") return target >= reference;
  return target <= reference;
}

function deltaText(
  target: number,
  reference: number,
  precision: DateComparePrecision,
): string {
  const diff = target - reference;
  if (diff === 0) return "时间相同";
  const amount = Math.abs(diff) / PRECISION_MS[precision];
  const unit = PRECISION_LABEL[precision];
  return `${diff > 0 ? "晚" : "早"} ${Number(amount.toFixed(3))} ${unit}`;
}

interface DateViolation {
  target: DateRuleTarget;
  reason: string;
}

/** 在请求上复验所有日期规则；数组元素超出当前支持范围时忽略该条。 */
function inspectRequest(
  request: Record<string, unknown>,
  targets: readonly DateRuleTarget[],
): DateViolation[] {
  const violations: DateViolation[] = [];
  for (const target of targets) {
    const targetValues = valuesAtPath(request, target.segments);
    const referenceValues = valuesAtPath(request, target.otherSegments);
    if (!targetValues.length || !referenceValues.length) {
      violations.push({ target, reason: "请求中缺少目标字段或参照字段" });
      continue;
    }
    for (let index = 0; index < targetValues.length; index += 1) {
      const targetInstant = parseSerializedDate(
        targetValues[index],
        target.output,
      );
      const referenceInstant = parseSerializedDate(
        referenceValues[index],
        target.referenceOutput,
      );
      if (targetInstant === undefined || referenceInstant === undefined) {
        violations.push({ target, reason: "不是有效日期" });
        continue;
      }
      if (
        !compareDirection(target.direction, targetInstant, referenceInstant)
      ) {
        violations.push({
          target,
          reason: `${deltaText(targetInstant, referenceInstant, target.precision)} ${target.otherFieldLabel}`,
        });
      }
    }
  }
  return violations;
}

/** 规则文案；用例操作面板与导出说明共用。 */
export function dateRuleSummary(target: DateRuleTarget): string {
  return `${target.fieldKey} ${DIRECTION_LABEL[target.direction]} ${target.otherFieldKey}（精度 ${PRECISION_LABEL[target.precision]}）`;
}

function emptySet(
  seed: string,
  options: DateTestCaseOptions,
  targets: DateRuleTarget[],
  issues: DateRuleIssue[],
): DateTestCaseSet {
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
 * 固定参照字段的基准值，再生成早一个单位、相等、晚一个单位的请求。
 * 每条请求都会整行重算，依赖目标字段的派生字段随用例值更新。
 */
export function generateDateTestCases(
  fields: readonly MockField[],
  options: DateTestCaseOptions = {},
): DateTestCaseSet {
  const seed = createCaseSetSeed(options.seed);
  const locale = options.locale ?? "zh-CN";
  const { targets, issues } = collectDateRuleTargets(fields);
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
                "当前字段没有配置日期比较规则，请先在日期字段中选择要比较的字段、方向和精度",
            },
          ],
    );
  }

  const timeZone = normalizeTimeZone(options.timeZone);
  const generation: GenerateOptions = {
    seed,
    locale,
    scenario: "normal",
    timeZone,
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

  const cases: DateTestCase[] = [];
  const caseIssues: DateRuleIssue[] = [];
  for (const target of targets) {
    const referenceValues = valuesAtPath(baseline, target.otherSegments);
    const targetValues = valuesAtPath(baseline, target.segments);
    if (referenceValues.length !== 1 || targetValues.length !== 1) {
      caseIssues.push({
        path: target.path,
        message:
          "日期比较暂只支持每个请求中的单个目标值与参照值（数组元素暂不生成用例）",
      });
      continue;
    }
    const referenceValue = referenceValues[0];
    const referenceInstant = parseSerializedDate(
      referenceValue,
      target.referenceOutput,
    );
    if (referenceInstant === undefined) {
      caseIssues.push({
        path: target.otherPath,
        message: `无法解析参照字段「${target.otherFieldKey}」的日期值`,
      });
      continue;
    }

    for (const offset of [-1, 0, 1]) {
      const instant =
        referenceInstant + offset * PRECISION_MS[target.precision];
      const value = serializeDateValue(instant, target.output, targetValues[0]);
      const request = generateRows(fields, 1, {
        ...generation,
        overrides: {
          [target.otherFieldId]: referenceValue,
          [target.fieldId]: value,
        },
      })[0];
      if (!request) continue;

      const targetValuesInRequest = valuesAtPath(request, target.segments);
      const referenceValuesInRequest = valuesAtPath(
        request,
        target.otherSegments,
      );
      if (!targetValuesInRequest.length || !referenceValuesInRequest.length) {
        caseIssues.push({
          path: target.path,
          message: "请求中没有该字段的值，无法验证目标规则",
        });
        continue;
      }
      const actualTarget = parseSerializedDate(
        targetValuesInRequest[0],
        target.output,
      );
      const actualReference = parseSerializedDate(
        referenceValuesInRequest[0],
        target.referenceOutput,
      );
      const violations = inspectRequest(request, targets);
      const targetViolations = violations.filter(
        (item) => item.target.fieldId === target.fieldId,
      );
      const otherViolations = violations.filter(
        (item) => item.target.fieldId !== target.fieldId,
      );
      const reasons: string[] = [];
      if (targetViolations.length) {
        reasons.push(
          `目标规则未通过：字段「${target.fieldKey}」${targetViolations
            .map((item) => item.reason)
            .join("；")}`,
        );
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
      if (
        actualTarget === undefined ||
        actualReference === undefined ||
        actualTarget - actualReference !==
          offset * PRECISION_MS[target.precision]
      ) {
        caseIssues.push({
          path: target.path,
          message: `序列化精度无法保留${PRECISION_LABEL[target.precision]}差，重建请求与目标偏移不一致`,
        });
      }
      const coverage =
        offset === 0
          ? "相等"
          : `${offset < 0 ? "早" : "晚"} 1 ${PRECISION_LABEL[target.precision]}`;
      cases.push({
        kind: "date",
        id: `date-${cases.length + 1}`,
        fieldKey: target.fieldKey,
        fieldPath: target.path,
        fieldLabel: target.fieldLabel,
        value,
        rule: {
          referenceKey: target.otherFieldKey,
          referencePath: target.otherPath,
          referenceLabel: target.otherFieldLabel,
          referenceValue: referenceValuesInRequest[0] as string | number,
          direction: target.direction,
          precision: target.precision,
        },
        source: target.source,
        expected: targetViolations.length ? "reject" : "pass",
        coverage,
        reason: `${reasons.join("；")}。规则：${dateRuleSummary(target)}`,
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
