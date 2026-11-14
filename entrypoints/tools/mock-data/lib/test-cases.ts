/**
 * 测试用例集：把数值、日期、长度与请求校验用例合并为同一入口、同一导出文件。
 */
import { createCaseSetSeed } from "./case-seed";
import type {
  DateRuleIssue,
  DateRuleTarget,
  DateTestCase,
  DateTestCaseOptions,
} from "./date-cases";
import { generateDateTestCases } from "./date-cases";
import type {
  InputRuleIssue,
  InputRuleTarget,
  InputTestCase,
  InputTestCaseOptions,
} from "./invalid-cases";
import { generateInputTestCases } from "./invalid-cases";
import type {
  LengthRuleIssue,
  LengthRuleTarget,
  LengthTestCase,
  LengthTestCaseOptions,
} from "./length-cases";
import { generateLengthTestCases } from "./length-cases";
import type {
  NumericRuleIssue,
  NumericRuleTarget,
  NumericTestCase,
  NumericTestCaseOptions,
} from "./numeric-cases";
import { generateNumericTestCases } from "./numeric-cases";
import type { LocaleId, MockField, MockScenario } from "./types";

export type TestCase =
  | NumericTestCase
  | DateTestCase
  | LengthTestCase
  | InputTestCase;
export type TestCaseTarget =
  | NumericRuleTarget
  | DateRuleTarget
  | LengthRuleTarget
  | InputRuleTarget;
export type TestCaseIssue = (
  | NumericRuleIssue
  | DateRuleIssue
  | LengthRuleIssue
  | InputRuleIssue
) & { level?: "info" | "error" };

export interface TestCaseSet {
  seed: string;
  generation: {
    locale: LocaleId;
    scenario: MockScenario;
    referenceTime: string;
    timeZone: string;
  };
  templateId?: string;
  templateName?: string;
  targets: TestCaseTarget[];
  cases: TestCase[];
  issues: TestCaseIssue[];
  summary: {
    total: number;
    pass: number;
    reject: number;
  };
}

export interface TestCaseOptions {
  seed?: string;
  locale?: LocaleId;
  timeZone?: string;
  templateId?: string;
  templateName?: string;
  /** 未配置显式校验规则时，按字段取样范围与类型推导用例。 */
  inferFromSampling?: boolean;
}

const NO_RULES_MESSAGE =
  "当前字段没有配置数值校验、日期比较、长度或请求校验规则；请展开左侧字段，在「请求校验规则」等校验项中填写";

const NOTHING_INFERRED_MESSAGE =
  "当前字段没有可推导的测试用例：枚举、固定值与派生字段需要先配置校验规则；数值、字符串、数组、对象及常规字段可直接按取样范围推导";

function hasConfiguredRules(
  fields: readonly MockField[],
  kinds: "numericRule" | "dateRule" | "lengthRule" | "inputRule",
): boolean {
  for (const field of fields) {
    if (field.enabled === false) continue;
    if (field[kinds]) return true;
    if (field.children?.length && hasConfiguredRules(field.children, kinds)) {
      return true;
    }
  }
  return false;
}

/** 生成全部可用测试用例；各类规则共用 Seed、基准日与时区。 */
export function generateTestCases(
  fields: readonly MockField[],
  options: TestCaseOptions = {},
): TestCaseSet {
  const seed = createCaseSetSeed(options.seed);
  const shared: NumericTestCaseOptions &
    DateTestCaseOptions &
    LengthTestCaseOptions &
    InputTestCaseOptions = {
    ...options,
    seed,
  };
  const numeric = generateNumericTestCases(fields, shared);
  const date = generateDateTestCases(fields, shared);
  const length = generateLengthTestCases(fields, shared);
  const input = generateInputTestCases(fields, shared);
  const cases: TestCase[] = [
    ...numeric.cases,
    ...date.cases,
    ...length.cases,
    ...input.cases,
  ];
  const issues: TestCaseIssue[] = [];
  if (options.inferFromSampling) {
    issues.push(
      ...numeric.issues,
      ...date.issues,
      ...length.issues,
      ...input.issues,
    );
  } else {
    const hasNumeric = hasConfiguredRules(fields, "numericRule");
    const hasDate = hasConfiguredRules(fields, "dateRule");
    const hasLength = hasConfiguredRules(fields, "lengthRule");
    const hasInput = hasConfiguredRules(fields, "inputRule");
    if (!hasNumeric && !hasDate && !hasLength && !hasInput) {
      issues.push({ message: NO_RULES_MESSAGE, level: "info" });
    } else {
      if (hasNumeric) issues.push(...numeric.issues);
      if (hasDate) issues.push(...date.issues);
      if (hasLength) issues.push(...length.issues);
      if (hasInput) issues.push(...input.issues);
    }
  }
  if (options.inferFromSampling && !cases.length && !issues.length) {
    issues.push({ message: NOTHING_INFERRED_MESSAGE, level: "info" });
  }

  const pass = cases.filter((item) => item.expected === "pass").length;
  return {
    seed,
    generation: numeric.generation,
    templateId: options.templateId,
    targets: [
      ...numeric.targets,
      ...date.targets,
      ...length.targets,
      ...input.targets,
    ],
    cases,
    issues,
    summary: { total: cases.length, pass, reject: cases.length - pass },
  };
}

/** 导出用例集所需的可复现参数；包含目标规则与每条请求。 */
export function serializeTestCaseSet(set: TestCaseSet): string {
  const file = {
    kind: "shadekit-mock-test-cases",
    schemaVersion: 3,
    seed: set.seed,
    generation: set.generation,
    templateId: set.templateId,
    templateName: set.templateName,
    targets: set.targets,
    summary: set.summary,
    issues: set.issues,
    cases: set.cases,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}
