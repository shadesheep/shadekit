import { describe, expect, it } from "vitest";
import { toChineseCapital } from "../entrypoints/tools/mock-data/lib/data-pools";
import {
  createField,
  generateRows,
  localTimeZone,
  sanitizeFields,
} from "../entrypoints/tools/mock-data/lib/generators";
import {
  collectNumericRuleTargets,
  generateNumericTestCases,
  validateNumericRule,
} from "../entrypoints/tools/mock-data/lib/numeric-cases";
import {
  fieldsToTemplate,
  parseTemplateFile,
  serializeTemplateFile,
  templateToFields,
} from "../entrypoints/tools/mock-data/lib/template-files";
import { TEMPLATES } from "../entrypoints/tools/mock-data/lib/templates";
import { serializeTestCaseSet } from "../entrypoints/tools/mock-data/lib/test-cases";
import type { MockField } from "../entrypoints/tools/mock-data/lib/types";

function projectFields(): MockField[] {
  const template = TEMPLATES.find((item) => item.id === "project");
  if (!template) throw new Error("缺少招标项目模板");
  return templateToFields(template);
}

function withBudgetRule(fields: MockField[]): MockField[] {
  const budget = fields.find((field) => field.key === "budget");
  if (!budget) throw new Error("缺少预算字段");
  budget.numericRule = { min: 100, max: 200, precision: 0.01 };
  return fields;
}

describe("数值校验规则", () => {
  it("接受合法区间并拒绝反向区间、精度超限和缺失区间", () => {
    const field = createField("budget", new Set())!;
    field.numericRule = { min: 100, max: 200, precision: 0.01 };
    expect(validateNumericRule(field)).toEqual([]);

    field.numericRule = { min: 200, max: 100 };
    expect(validateNumericRule(field)).toContain("校验下限不能大于校验上限");

    field.numericRule = { min: 100.001, max: 200, precision: 0.01 };
    expect(validateNumericRule(field)).toContain(
      "校验下限必须对齐校验精度 0.01",
    );
    field.numericRule = { precision: 0.01 };
    expect(validateNumericRule(field)).toContain(
      "请至少填写校验下限或校验上限",
    );
    field.numericRule = { min: 1, max: 2, precision: 0 };
    expect(validateNumericRule(field)).toContain(
      "校验精度必须是大于 0 的步长（如 0.01）",
    );

    field.numericRule = { min: 1, max: 2, precision: 0.0000001 };
    expect(validateNumericRule(field)).toContain("校验精度最多允许 6 位小数");
  });

  it("收集对象和对象数组内的同级数值规则", () => {
    const fields = sanitizeFields([
      {
        key: "meta",
        type: "object",
        children: [
          {
            key: "amount",
            type: "float",
            params: {},
            numericRule: { min: 1, max: 2, precision: 0.01 },
          },
        ],
      },
      {
        key: "items",
        type: "array",
        params: { minItems: 1, maxItems: 2 },
        children: [
          {
            key: "score",
            type: "score",
            params: {},
            numericRule: { min: 0, max: 10, precision: 1 },
          },
        ],
      },
    ]);
    const { targets, issues } = collectNumericRuleTargets(fields);
    expect(issues).toEqual([]);
    expect(targets.map((target) => target.path)).toEqual([
      "meta.amount",
      "items[].score",
    ]);
  });
});

describe("数值边界测试用例", () => {
  it("招标项目预算生成 6 个边界值且大写金额逐条一致", () => {
    const fields = withBudgetRule(projectFields());
    const set = generateNumericTestCases(fields, { seed: "budget-seed" });
    const budgetCases = set.cases.filter((item) => item.fieldKey === "budget");
    expect(budgetCases.map((item) => item.value)).toEqual([
      99.99, 100, 100.01, 199.99, 200, 200.01,
    ]);
    expect(budgetCases.map((item) => item.expected)).toEqual([
      "reject",
      "pass",
      "pass",
      "pass",
      "pass",
      "reject",
    ]);
    for (const item of budgetCases) {
      expect(item.request.budgetCn).toBe(
        toChineseCapital(item.request.budget as number),
      );
    }
  });

  it("同一 Seed 与规则可复现，整套导出包含请求、规则和预期结果", () => {
    const fields = withBudgetRule(projectFields());
    const first = generateNumericTestCases(fields, { seed: "repeat-seed" });
    const second = generateNumericTestCases(fields, { seed: "repeat-seed" });
    expect(second.cases).toEqual(first.cases);

    const file = JSON.parse(serializeTestCaseSet(first));
    expect(file.seed).toBe("repeat-seed");
    expect(file.generation).toEqual({
      locale: "zh-CN",
      scenario: "normal",
      referenceTime: "2024-01-01T09:00:00.000Z",
      timeZone: localTimeZone(),
    });
    expect(file.cases[0]).toMatchObject({
      id: "case-1",
      expected: "reject",
      rule: { min: 100, max: 200, precision: 0.01 },
    });
    expect(file.cases[0].request.budget).toBe(99.99);
  });

  it("自定义数值字段可与预算同时覆盖", () => {
    const fields = withBudgetRule(projectFields());
    const amount = createField(
      "float",
      new Set(fields.map((field) => field.key)),
    )!;
    amount.key = "customAmount";
    amount.params = { ...amount.params, min: 0, max: 1000, precision: 2 };
    amount.numericRule = { min: 1, max: 2, precision: 0.01 };
    fields.push(amount);

    const set = generateNumericTestCases(fields, { seed: "custom-seed" });
    const customCases = set.cases.filter(
      (item) => item.fieldKey === "customAmount",
    );
    expect(customCases.map((item) => item.value)).toEqual([
      0.99, 1, 1.01, 1.99, 2, 2.01,
    ]);
    expect(customCases.map((item) => item.expected)).toEqual([
      "reject",
      "pass",
      "pass",
      "pass",
      "pass",
      "reject",
    ]);
  });

  it("普通批量生成仍按随机取样范围取值，不受校验规则影响", () => {
    const fields = withBudgetRule(projectFields());
    const budget = fields.find((field) => field.key === "budget")!;
    budget.params = { ...budget.params, min: 1, max: 2, precision: 2 };
    const rows = generateRows(fields, 40, { seed: "sample-seed" });
    const values = rows.map((row) => row.budget as number);
    expect(values.every((value) => value >= 1 && value <= 2)).toBe(true);
    expect(values.some((value) => value < 100)).toBe(true);
  });

  it("无效规则返回具体原因且不生成用例", () => {
    const fields = projectFields();
    const budget = fields.find((field) => field.key === "budget")!;
    budget.numericRule = { min: 200, max: 100 };
    const set = generateNumericTestCases(fields, { seed: "invalid" });
    expect(set.cases).toEqual([]);
    expect(set.issues.map((issue) => issue.message)).toContain(
      "校验下限不能大于校验上限",
    );
  });

  it("自定义模板保存、导出并重新导入后仍能生成同一套用例", () => {
    const fields = withBudgetRule(projectFields());
    const sourceBudget = fields.find((field) => field.key === "budget")!;
    sourceBudget.constraints = { unique: true };
    const template = fieldsToTemplate(fields, "预算校验");
    const restored = templateToFields(
      parseTemplateFile(serializeTemplateFile(template)),
    );
    const budget = restored.find((field) => field.key === "budget")!;
    expect(budget.numericRule).toEqual({
      min: 100,
      max: 200,
      precision: 0.01,
    });
    const first = generateNumericTestCases(fields, { seed: "roundtrip" });
    const second = generateNumericTestCases(restored, { seed: "roundtrip" });
    expect(budget.constraints).toEqual({ unique: true });
    expect(second.cases).toEqual(first.cases);
  });
});
