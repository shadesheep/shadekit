import { describe, expect, it } from "vitest";
import {
  collectInputRuleTargets,
  generateInputTestCases,
  inputRuleSummary,
  validateInputRule,
} from "../entrypoints/tools/mock-data/lib/invalid-cases";
import {
  createField,
  sanitizeFields,
} from "../entrypoints/tools/mock-data/lib/generators";
import {
  generateTestCases,
  serializeTestCaseSet,
} from "../entrypoints/tools/mock-data/lib/test-cases";
import {
  fieldsToTemplate,
  parseTemplateFile,
  serializeTemplateFile,
  templateToFields,
} from "../entrypoints/tools/mock-data/lib/template-files";
import type { MockField } from "../entrypoints/tools/mock-data/lib/types";

function emailField(rule: MockField["inputRule"]): MockField {
  const field = createField("email", new Set())!;
  field.key = "email";
  field.label = "邮箱";
  field.inputRule = rule;
  return field;
}

function statusField(): MockField {
  const field = createField("enum", new Set(["email"]))!;
  field.key = "status";
  field.label = "状态";
  field.params = { ...field.params, values: "active,disabled" };
  field.inputRule = { enumValues: ["active", "disabled"] };
  return field;
}

function fields(): MockField[] {
  return sanitizeFields([
    emailField({
      required: true,
      nullable: false,
      nonEmpty: true,
      type: "string",
      format: "email",
    }),
    statusField(),
  ]);
}

function withoutKey(
  request: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(request)) as Record<string, unknown>;
  delete copy[key];
  return copy;
}

describe("请求校验规则", () => {
  it("校验类型、格式并收集字段路径", () => {
    const field = createField("email", new Set())!;
    field.inputRule = { type: "date" as never };
    expect(validateInputRule(field)).toContain(
      "请求类型必须是受支持的 JSON 值类型",
    );
    field.inputRule = { format: "username" as never };
    expect(validateInputRule(field)).toContain(
      "格式规则必须是受支持的格式（当前支持邮箱）",
    );
    field.inputRule = { enumValues: [] };
    expect(validateInputRule(field)).toContain("枚举规则至少需要一个允许值");
    const optionals = sanitizeFields([
      { key: "profile", type: "object", children: [emailField({ required: true })] },
    ]);
    const { targets, issues } = collectInputRuleTargets(optionals);
    expect(issues).toEqual([]);
    expect(targets.map((target) => target.path)).toEqual(["profile.email"]);
  });

  it("从同一基准生成缺失、null、空字符串、错误类型与格式错误请求", () => {
    const set = generateInputTestCases(fields(), { seed: "invalid-seed" });
    expect(set.issues).toEqual([]);
    const emailCases = set.cases.filter((item) => item.fieldKey === "email");
    expect(emailCases.map((item) => item.coverage)).toEqual([
      "属性缺失",
      "属性值为 null",
      "空字符串",
      "错误类型（string → number）",
      "格式错误",
    ]);
    expect(emailCases.map((item) => item.expected)).toEqual([
      "reject",
      "reject",
      "reject",
      "reject",
      "reject",
    ]);
    expect("email" in emailCases[0].request).toBe(false);
    expect(emailCases[1].request.email).toBeNull();
    expect(emailCases[2].request.email).toBe("");
    expect(emailCases[3].request.email).toBe(123);
    expect(emailCases[4].request.email).toBe("not-an-email");

    const formatCase = emailCases[4];
    expect(withoutKey(formatCase.request, "email")).toEqual(
      withoutKey(emailCases[1].request, "email"),
    );

    const statusCase = set.cases.find(
      (item) => item.fieldKey === "status" && item.coverage === "枚举外值",
    )!;
    expect(statusCase.value).toBe("__not_in_enum__");
    expect(statusCase.expected).toBe("reject");
    expect(statusCase.request.status).toBe("__not_in_enum__");
  });

  it("关闭必填或允许 null 后预期结果随规则变化", () => {
    const [email] = fields();
    email.inputRule = {
      ...email.inputRule,
      required: false,
      nullable: true,
    };
    const set = generateInputTestCases([email], { seed: "toggle" });
    const missing = set.cases.find((item) => item.coverage === "属性缺失")!;
    const nullCase = set.cases.find(
      (item) => item.coverage === "属性值为 null",
    )!;
    expect(missing.expected).toBe("pass");
    expect(nullCase.expected).toBe("pass");

    email.inputRule = { ...email.inputRule, required: true, nullable: false };
    const strict = generateInputTestCases([email], { seed: "toggle" });
    expect(
      strict.cases.find((item) => item.coverage === "属性缺失")!.expected,
    ).toBe("reject");
    expect(
      strict.cases.find((item) => item.coverage === "属性值为 null")!.expected,
    ).toBe("reject");
  });

  it("同时触发类型与格式规则时列出两条原因", () => {
    const field = emailField({ type: "string", format: "email" });
    const set = generateInputTestCases([field], { seed: "combined" });
    const wrongType = set.cases.find((item) =>
      item.coverage.startsWith("错误类型"),
    )!;
    expect(wrongType.expected).toBe("reject");
    expect(wrongType.reason).toContain("不是 string 类型");
    expect(wrongType.reason).toContain("不是有效邮箱");
    expect(inputRuleSummary(wrongType.rule)).toContain("邮箱格式");
  });

  it("派生来源无法重算时报告受影响字段", () => {
    const budget = createField("budget", new Set())!;
    budget.key = "budget";
    budget.inputRule = { required: true };
    const budgetCn = createField("derived", new Set(["budget"]))!;
    budgetCn.key = "budgetCn";
    budgetCn.params = { ...budgetCn.params, transform: "chineseCapital" };
    budgetCn.sourceFieldIds = { source: budget.id };
    const set = generateInputTestCases([budget, budgetCn], {
      seed: "dependency",
    });
    expect(set.cases.map((item) => item.coverage)).toEqual([
      "属性值为 null",
    ]);
    expect(set.cases[0].expected).toBe("reject");
    expect(set.issues).toHaveLength(1);
    expect(set.issues[0].path).toBe("budget");
    expect(set.issues[0].message).toContain("无法重算受影响的依赖字段");
    expect(set.issues[0].message).toContain("budgetCn");
  });

  it("同一 Seed 重建结果一致，模板往返保留规则", () => {
    const source = fields();
    const first = generateInputTestCases(source, { seed: "repeat" });
    const second = generateInputTestCases(source, { seed: "repeat" });
    expect(second.cases).toEqual(first.cases);
    expect(second.targets).toEqual(first.targets);

    const template = fieldsToTemplate(source, "输入规则");
    const restored = templateToFields(template);
    const email = restored.find((field) => field.key === "email")!;
    expect(email.inputRule).toEqual(source[0].inputRule);
    const status = restored.find((field) => field.key === "status")!;
    expect(status.inputRule).toEqual({ enumValues: ["active", "disabled"] });
    expect(
      generateInputTestCases(restored, { seed: "repeat" }).cases,
    ).toEqual(first.cases);

    const parsed = parseTemplateFile(serializeTemplateFile(template));
    const fromFile = templateToFields(parsed);
    expect(
      fromFile.find((field) => field.key === "email")?.inputRule,
    ).toEqual(source[0].inputRule);
  });

  it("用例集合并后可按字段筛选输入规则", () => {
    const set = generateTestCases(fields(), { seed: "merged" });
    expect(set.targets.map((target) => target.kind)).toContain("input");
    expect(set.cases.some((item) => item.kind === "input")).toBe(true);
    expect(set.issues).toEqual([]);
  });

  it("导出文件保留输入规则与预期结果", () => {
    const set = generateInputTestCases(fields(), { seed: "export" });
    const file = JSON.parse(serializeTestCaseSet(set));
    expect(file.cases[0].kind).toBe("input");
    expect(file.cases[0].present).toBe(false);
    expect(file.targets[0].rule).toEqual(fields()[0].inputRule);
    expect(
      file.cases.map((item: { expected: string }) => item.expected),
    ).toEqual(set.cases.map((item) => item.expected));
  });
});
