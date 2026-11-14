/**
 * 字段请求校验规则与缺失、空值、类型、枚举、格式测试用例生成。
 *
 * 规则只用于用例判定，不改变随机取样；每条请求从同一份合法基准样本派生，
 * 依赖字段按正常生成逻辑重算，未受影响字段保留基准值。
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
  InputFormat,
  InputRule,
  InputValueType,
  LocaleId,
  MockField,
  MockScenario,
} from "./types";

const INPUT_TYPES: Record<InputValueType, true> = {
  string: true,
  number: true,
  integer: true,
  boolean: true,
  object: true,
  array: true,
};
const INPUT_FORMATS: Record<InputFormat, true> = { email: true };
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface InputRuleTarget {
  kind: "input";
  label: string;
  fieldId: string;
  key: string;
  fieldType: string;
  fieldParams: Record<string, unknown>;
  path: string;
  segments: PathSegment[];
  rule: InputRule;
  source: CaseRuleSource;
}

export interface InputRuleIssue {
  fieldId?: string;
  path?: string;
  message: string;
  level?: "info" | "error";
}

export interface InputTestCase {
  kind: "input";
  id: string;
  fieldKey: string;
  fieldPath: string;
  fieldLabel: string;
  /** false 表示该用例刻意移除了属性。 */
  present: boolean;
  value: unknown;
  rule: InputRule;
  source: CaseRuleSource;
  expected: "pass" | "reject";
  coverage: string;
  reason: string;
  request: Record<string, unknown>;
}

export interface InputTestCaseSet {
  seed: string;
  generation: {
    locale: LocaleId;
    scenario: MockScenario;
    referenceTime: string;
    timeZone: string;
  };
  templateId?: string;
  templateName?: string;
  targets: InputRuleTarget[];
  cases: InputTestCase[];
  issues: InputRuleIssue[];
  summary: {
    total: number;
    pass: number;
    reject: number;
  };
}

export interface InputTestCaseOptions {
  seed?: string;
  locale?: LocaleId;
  timeZone?: string;
  templateId?: string;
  templateName?: string;
  /** 未配置 inputRule 时，按字段类型推导类型不符用例。 */
  inferFromSampling?: boolean;
}

/** 校验字段上的请求校验规则；返回面向用户的错误文案。 */
export function validateInputRule(field: MockField): string[] {
  const rule = field.inputRule;
  if (!rule) return [];
  const issues: string[] = [];
  if (rule.type !== undefined && !INPUT_TYPES[rule.type]) {
    issues.push("请求类型必须是受支持的 JSON 值类型");
  }
  if (rule.format !== undefined && !INPUT_FORMATS[rule.format]) {
    issues.push("格式规则必须是受支持的格式（当前支持邮箱）");
  }
  if (rule.enumValues !== undefined) {
    if (!Array.isArray(rule.enumValues) || !rule.enumValues.length) {
      issues.push("枚举规则至少需要一个允许值");
    }
  }
  return issues;
}

function copyRule(rule: InputRule): InputRule {
  return {
    ...rule,
    ...(rule.enumValues ? { enumValues: cloneJson(rule.enumValues) } : {}),
  };
}

function cloneJson<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function collectTargets(
  fields: readonly MockField[],
  issues: InputRuleIssue[],
  inferFromSampling: boolean,
  prefix = "",
  segments: PathSegment[] = [],
): InputRuleTarget[] {
  const targets: InputRuleTarget[] = [];
  for (const field of fields) {
    if (field.enabled === false || !field.key.trim()) continue;
    const path = prefix ? `${prefix}.${field.key}` : field.key;
    const fieldSegments = [...segments, { key: field.key, list: false }];
    if (field.inputRule) {
      const messages = validateInputRule(field);
      if (messages.length) {
        for (const message of messages) {
          issues.push({ fieldId: field.id, path, message });
        }
      } else {
        targets.push({
          kind: "input",
          fieldId: field.id,
          key: field.key,
          label: field.label ?? getFieldType(field.type)?.label ?? field.key,
          fieldType: field.type,
          fieldParams: field.params,
          path,
          segments: fieldSegments,
          rule: copyRule(field.inputRule),
          source: "rule",
        });
      }
    } else if (inferFromSampling) {
      const type = generatedType(field.type, field.params);
      if (type) {
        targets.push({
          kind: "input",
          fieldId: field.id,
          key: field.key,
          label: field.label ?? getFieldType(field.type)?.label ?? field.key,
          fieldType: field.type,
          fieldParams: field.params,
          path,
          segments: fieldSegments,
          rule: { type },
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

/** 收集所有已启用字段上的有效请求校验规则；无效规则以 issues 返回。 */
export function collectInputRuleTargets(
  fields: readonly MockField[],
  options: { inferFromSampling?: boolean } = {},
): {
  targets: InputRuleTarget[];
  issues: InputRuleIssue[];
} {
  const issues: InputRuleIssue[] = [];
  return {
    targets: collectTargets(fields, issues, options.inferFromSampling === true),
    issues,
  };
}

function sampleOfType(type: InputValueType): unknown {
  if (type === "string") return "value";
  if (type === "number") return 1;
  if (type === "integer") return 1;
  if (type === "boolean") return true;
  if (type === "object") return {};
  return ["value"];
}

function matchesType(value: unknown, type: InputValueType): boolean {
  if (type === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (type === "integer") {
    return typeof value === "number" && Number.isInteger(value);
  }
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "object") {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  return Array.isArray(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function canHoldValue(rule: InputRule, value: unknown): boolean {
  if (rule.type && !matchesType(value, rule.type)) return false;
  if (
    rule.format === "email" &&
    (typeof value !== "string" || !EMAIL_PATTERN.test(value))
  ) {
    return false;
  }
  if (
    rule.nonEmpty === true &&
    ((typeof value === "string" && value.length === 0) ||
      (Array.isArray(value) && value.length === 0))
  ) {
    return false;
  }
  return true;
}

/** 字段常规生成值对应的 JSON 类型；未知类型不强制基准覆盖。 */
function generatedType(
  fieldType: string,
  params: Record<string, unknown> = {},
): InputValueType | undefined {
  if (fieldType === "boolean") return "boolean";
  if (fieldType === "object") return "object";
  if (fieldType === "array") return "array";
  // 金额大写按数值取样，但输出字符串。
  if (fieldType === "moneyCn") return "string";
  if (fieldType === "date") {
    const format = String(params.format ?? "date");
    return format === "timestamp" || format === "timestamp_s"
      ? "number"
      : "string";
  }
  if (isNumericFieldType(fieldType)) {
    return numericDefaults(fieldType)?.integer ? "integer" : "number";
  }
  if (
    !getFieldType(fieldType) ||
    fieldType === "enum" ||
    fieldType === "fixed" ||
    fieldType === "derived"
  ) {
    return undefined;
  }
  return "string";
}

function typeMatchesGenerated(
  ruleType: InputValueType,
  fieldType: string,
  fieldParams: Record<string, unknown>,
): boolean {
  const generated = generatedType(fieldType, fieldParams);
  if (!generated) return false;
  if (ruleType === "number") {
    return generated === "number" || generated === "integer";
  }
  return generated === ruleType;
}

/** 基准样本优先采用能同时满足类型与格式的枚举值。 */
function baselineValueFor(target: InputRuleTarget): unknown {
  const { rule } = target;
  if (rule.enumValues?.length) {
    const allowed = rule.enumValues.find((value) => canHoldValue(rule, value));
    return allowed === undefined ? rule.enumValues[0] : allowed;
  }
  if (rule.format === "email") {
    return target.fieldType === "email" ? undefined : "user@example.com";
  }
  if (rule.type) {
    return typeMatchesGenerated(rule.type, target.fieldType, target.fieldParams)
      ? undefined
      : sampleOfType(rule.type);
  }
  return undefined;
}

function wrongTypeValue(type: InputValueType): unknown {
  if (type === "string" || type === "object") return 123;
  if (type === "number" || type === "integer") return "not-a-number";
  if (type === "boolean") return "not-a-boolean";
  return "not-an-array";
}

/** 枚举外值尽量保持允许值的 JSON 类型，避免同时触发类型规则。 */
function outsideEnumValue(rule: InputRule): unknown {
  const values = rule.enumValues ?? [];
  const type = rule.type;
  const textCandidates =
    rule.format === "email"
      ? ["outside@example.com", "__not_in_enum__"]
      : ["__not_in_enum__", "outside@example.com"];
  const candidates: unknown[] =
    type === "number" || type === "integer"
      ? [0, 1, -1, 999999]
      : type === "boolean"
        ? [true, false]
        : type === "object"
          ? [{ __outside: true }]
          : type === "array"
            ? [["__outside__"]]
            : textCandidates;

  for (const candidate of candidates) {
    if (!values.some((value) => sameValue(value, candidate))) return candidate;
  }
  return type === "boolean" ? "not-a-boolean" : "__not_in_enum__";
}

function emptyValue(
  rule: InputRule,
  baseline: unknown,
): { value: unknown; coverage: string } | undefined {
  if (Array.isArray(baseline) || rule.type === "array") {
    return { value: [], coverage: "空数组" };
  }
  if (typeof baseline === "string" || rule.type === "string") {
    return { value: "", coverage: "空字符串" };
  }
  return undefined;
}

function ruleViolations(value: unknown, rule: InputRule): string[] {
  const reasons: string[] = [];
  if (value === null) {
    return rule.nullable === true ? [] : ["不允许 null"];
  }
  if (rule.type && !matchesType(value, rule.type)) {
    reasons.push(`不是 ${rule.type} 类型（实际为 ${jsonType(value)}）`);
  }
  if (
    rule.nonEmpty === true &&
    ((typeof value === "string" && value.length === 0) ||
      (Array.isArray(value) && value.length === 0))
  ) {
    reasons.push("不能为空");
  }
  if (
    rule.enumValues?.length &&
    !rule.enumValues.some((allowed) => sameValue(allowed, value))
  ) {
    reasons.push("不在枚举允许集合内");
  }
  if (rule.format === "email") {
    if (typeof value !== "string" || !EMAIL_PATTERN.test(value)) {
      reasons.push("不是有效邮箱");
    }
  }
  return reasons;
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

interface Violation {
  target: InputRuleTarget;
  reason: string;
}

function inspectRequest(
  request: Record<string, unknown>,
  targets: readonly InputRuleTarget[],
): Violation[] {
  const violations: Violation[] = [];
  for (const target of targets) {
    const values = valuesAtPath(request, target.segments);
    if (!values.length) {
      if (target.rule.required === true) {
        violations.push({ target, reason: "缺少必填字段" });
      }
      continue;
    }
    for (const value of values) {
      for (const reason of ruleViolations(value, target.rule)) {
        violations.push({ target, reason });
      }
    }
  }
  return violations;
}

function affectedFieldIds(
  fields: readonly MockField[],
  targetId: string,
): Set<string> {
  const affected = new Set<string>([targetId]);
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (list: readonly MockField[]) => {
      for (const field of list) {
        if (
          field.enabled !== false &&
          !affected.has(field.id) &&
          Object.values(field.sourceFieldIds ?? {}).some((id) =>
            affected.has(id),
          )
        ) {
          affected.add(field.id);
          changed = true;
        }
        if (field.children?.length) visit(field.children);
      }
    };
    visit(fields);
  }
  return affected;
}

function ancestorFieldIds(
  fields: readonly MockField[],
  affected: ReadonlySet<string>,
): Set<string> {
  const ancestors = new Set<string>();

  function visit(list: readonly MockField[], trail: MockField[]): boolean {
    let contains = false;
    for (const field of list) {
      const childContains =
        field.enabled !== false && field.children?.length
          ? visit(field.children, [...trail, field])
          : false;
      if (childContains || affected.has(field.id)) {
        for (const parent of trail) ancestors.add(parent.id);
        contains = true;
      }
    }
    return contains;
  }

  visit(fields, []);
  return ancestors;
}

interface Preserved {
  overrides: Record<string, unknown>;
  lengthOverrides: Record<string, number>;
}

function collectPreserved(
  fields: readonly MockField[],
  baseline: Record<string, unknown>,
  affected: ReadonlySet<string>,
  ancestors: ReadonlySet<string>,
  prefix = "",
  segments: PathSegment[] = [],
  insideAffectedArray = false,
  out: Preserved = { overrides: {}, lengthOverrides: {} },
): Preserved {
  for (const field of fields) {
    if (field.enabled === false || !field.key.trim()) continue;
    const path = prefix ? `${prefix}.${field.key}` : field.key;
    const fieldSegments = [...segments, { key: field.key, list: false }];
    const isAncestor = ancestors.has(field.id);
    const isAffected = affected.has(field.id);
    const baselineValue = valuesAtPath(baseline, fieldSegments)[0];

    if (isAncestor) {
      if (field.type === "array") {
        if (Array.isArray(baselineValue)) {
          out.lengthOverrides[field.id] = baselineValue.length;
        }
        collectPreserved(
          field.children ?? [],
          baseline,
          affected,
          ancestors,
          `${path}[].`,
          [...segments, { key: field.key, list: true }],
          true,
          out,
        );
      } else {
        collectPreserved(
          field.children ?? [],
          baseline,
          affected,
          ancestors,
          `${path}.`,
          fieldSegments,
          insideAffectedArray,
          out,
        );
      }
      continue;
    }
    if (isAffected) continue;
    if (insideAffectedArray) continue;
    if (baselineValue === undefined) continue;
    out.overrides[field.id] = cloneJson(baselineValue);
  }
  return out;
}

/** 规则文案；用例操作面板与导出说明共用。 */
export function inputRuleSummary(rule: InputRule): string {
  const parts: string[] = [];
  if (rule.required !== undefined) {
    parts.push(rule.required ? "必填" : "非必填");
  }
  if (rule.nullable !== undefined) {
    parts.push(rule.nullable ? "允许 null" : "不允许 null");
  }
  if (rule.nonEmpty !== undefined) {
    parts.push(rule.nonEmpty ? "非空" : "允许空值");
  }
  if (rule.type) parts.push(`类型 ${rule.type}`);
  if (rule.enumValues?.length) {
    parts.push(
      `枚举 ${rule.enumValues
        .map((value) => JSON.stringify(value))
        .join(", ")}`,
    );
  }
  if (rule.format) parts.push("邮箱格式");
  return parts.length ? parts.join("；") : "未配置校验规则";
}

function emptySet(
  seed: string,
  options: InputTestCaseOptions,
  targets: InputRuleTarget[],
  issues: InputRuleIssue[],
): InputTestCaseSet {
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

interface Candidate {
  coverage: string;
  present: boolean;
  value?: unknown;
}

function candidatesFor(
  target: InputRuleTarget,
  baseline: unknown,
): Candidate[] {
  const candidates: Candidate[] = [];
  const rule = target.rule;
  if (target.source === "inferred") {
    // 推导规则只知道字段类型；缺失、null 与空值是否合法取决于服务端规则，不能推断。
    return rule.type
      ? [
          {
            coverage: `错误类型（${rule.type} → ${jsonType(wrongTypeValue(rule.type))}）`,
            present: true,
            value: wrongTypeValue(rule.type),
          },
        ]
      : [];
  }
  if (rule.required !== undefined) {
    candidates.push({ coverage: "属性缺失", present: false });
  }
  candidates.push({ coverage: "属性值为 null", present: true, value: null });
  if (rule.nonEmpty !== undefined) {
    const empty = emptyValue(rule, baseline);
    if (empty) {
      candidates.push({
        coverage: empty.coverage,
        present: true,
        value: empty.value,
      });
    }
  }
  if (rule.type) {
    candidates.push({
      coverage: `错误类型（${rule.type} → ${jsonType(wrongTypeValue(rule.type))}）`,
      present: true,
      value: wrongTypeValue(rule.type),
    });
  }
  if (rule.enumValues?.length) {
    candidates.push({
      coverage: "枚举外值",
      present: true,
      value: outsideEnumValue(rule),
    });
  }
  if (rule.format === "email") {
    candidates.push({
      coverage: "格式错误",
      present: true,
      value: "not-an-email",
    });
  }
  return candidates;
}

/**
 * 从同一份合法基准样本生成请求校验用例。
 * 每条请求只改动目标字段，并按依赖顺序重算受影响的派生字段。
 */
export function generateInputTestCases(
  fields: readonly MockField[],
  options: InputTestCaseOptions = {},
): InputTestCaseSet {
  const seed = createCaseSetSeed(options.seed);
  const locale = options.locale ?? "zh-CN";
  const { targets, issues } = collectInputRuleTargets(fields, {
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
                "当前字段没有配置请求校验规则，请先在字段设置中启用必填、可空、类型、枚举或格式规则",
            },
          ],
    );
  }

  const baselineOverrides: Record<string, unknown> = {};
  for (const target of targets) {
    const value = baselineValueFor(target);
    if (value !== undefined) baselineOverrides[target.fieldId] = value;
  }
  const baselineLengths: Record<string, number> = {};
  for (const target of targets) {
    if (target.rule.nonEmpty === true) {
      baselineLengths[target.fieldId] = 1;
    }
  }
  const timeZone = normalizeTimeZone(options.timeZone);
  const generation: GenerateOptions = {
    seed,
    locale,
    scenario: "normal",
    timeZone,
    overrides: baselineOverrides,
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

  const cases: InputTestCase[] = [];
  const caseIssues: InputRuleIssue[] = [];
  for (const target of targets) {
    const baselineValue = valuesAtPath(baseline, target.segments)[0];
    const affected = affectedFieldIds(fields, target.fieldId);
    const ancestors = ancestorFieldIds(fields, affected);
    const preserved = collectPreserved(fields, baseline, affected, ancestors);
    for (const candidate of candidatesFor(target, baselineValue)) {
      const overrides = {
        ...preserved.overrides,
        ...(candidate.present
          ? { [target.fieldId]: cloneJson(candidate.value) }
          : {}),
      };
      let request: Record<string, unknown> | undefined;
      try {
        [request] = generateRows(fields, 1, {
          ...generation,
          overrides,
          omitFieldIds: candidate.present ? undefined : [target.fieldId],
          lengthOverrides: {
            ...baselineLengths,
            ...preserved.lengthOverrides,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        caseIssues.push({
          fieldId: target.fieldId,
          path: target.path,
          message: `无法重算受影响的依赖字段：${message}`,
          level: target.source === "inferred" ? "info" : "error",
        });
        continue;
      }
      if (!request) continue;
      const actual = valuesAtPath(request, target.segments);
      if (candidate.present ? !actual.length : actual.length) {
        caseIssues.push({
          path: target.path,
          message: candidate.present
            ? "请求中没有该字段的值，无法单独验证目标规则"
            : "请求中仍存在该字段，无法验证属性缺失",
          level: target.source === "inferred" ? "info" : "error",
        });
        continue;
      }
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
          `目标规则未通过：${[...new Set(targetViolations.map((item) => item.reason))].join("；")}`,
        );
      } else {
        reasons.push("通过目标规则");
      }
      if (otherViolations.length) {
        const seen = new Set<string>();
        const details: string[] = [];
        for (const item of otherViolations) {
          const text = `字段「${item.target.path}」${item.reason}`;
          if (seen.has(text)) continue;
          seen.add(text);
          details.push(text);
        }
        reasons.push(`同时触发其他规则：${details.join("；")}`);
      }
      cases.push({
        kind: "input",
        id: `input-${cases.length + 1}`,
        fieldKey: target.key,
        fieldPath: target.path,
        fieldLabel: target.label,
        present: candidate.present,
        value: candidate.value,
        rule: copyRule(target.rule),
        source: target.source,
        expected: violations.length ? "reject" : "pass",
        coverage: candidate.coverage,
        reason: `${reasons.join("；")}。${
          target.source === "inferred" ? "类型推导" : "规则"
        }：${inputRuleSummary(target.rule)}`,
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
