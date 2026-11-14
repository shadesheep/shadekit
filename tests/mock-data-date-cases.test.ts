import { describe, expect, it } from "vitest";
import {
  collectDateRuleTargets,
  generateDateTestCases,
  validateDateRule,
} from "../entrypoints/tools/mock-data/lib/date-cases";
import {
  generateRows,
  parseDateTimeText,
  sanitizeFields,
} from "../entrypoints/tools/mock-data/lib/generators";
import {
  fieldsToTemplate,
  parseTemplateFile,
  serializeTemplateFile,
  templateToFields,
} from "../entrypoints/tools/mock-data/lib/template-files";
import { TEMPLATES } from "../entrypoints/tools/mock-data/lib/templates";
import {
  generateTestCases,
  serializeTestCaseSet,
} from "../entrypoints/tools/mock-data/lib/test-cases";
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

function midnightFields(timeZone: string) {
  const start =
    timeZone === "UTC" ? "2024-06-30T23:59:30Z" : "2024-06-30T15:59:30Z";
  return sanitizeFields([
    {
      id: "deadline",
      key: "deadline",
      type: "date",
      params: {
        start,
        end: start,
        format: "datetime",
        timezone: timeZone,
      },
    },
    {
      id: "openBidTime",
      key: "openBidTime",
      label: "开标时间",
      type: "derived",
      params: {
        transform: "dateAfter",
        amount: 1,
        unit: "minute",
        format: "datetime",
        timezone: timeZone,
      },
      sources: { source: "deadline" },
      dateRule: {
        fieldId: "deadline",
        direction: "after",
        precision: "minute",
      },
    },
  ]);
}

describe("日期比较规则", () => {
  it("项目模板声明开标时间严格晚于报名截止时间", () => {
    const fields = projectFields();
    const deadline = fields.find(
      (field) => field.key === "registrationDeadline",
    );
    const openBid = fields.find((field) => field.key === "openBidTime");
    expect(deadline?.type).toBe("registrationDeadline");
    expect(openBid?.type).toBe("derived");
    expect(openBid?.sourceFieldIds?.source).toBe(deadline?.id);
    expect(openBid?.dateRule).toEqual({
      fieldId: deadline?.id,
      direction: "after",
      precision: "minute",
    });
    const rows = generateRows(fields, 30, { seed: "daily" });
    for (const row of rows) {
      expect(String(row.openBidTime) > String(row.registrationDeadline)).toBe(
        true,
      );
    }
  });

  it("拒绝非日期字段、自引用和精度高于输出格式的规则", () => {
    const fields = sanitizeFields([
      {
        id: "deadline",
        key: "deadline",
        type: "date",
        params: {
          start: "2024-06-30T15:59:30Z",
          end: "2024-06-30T15:59:30Z",
          format: "date",
          timezone: "UTC",
        },
        dateRule: {
          fieldId: "deadline",
          direction: "after",
          precision: "minute",
        },
      },
      { id: "name", key: "name", type: "name" },
      {
        id: "openBidTime",
        key: "openBidTime",
        type: "derived",
        params: {
          transform: "dateAfter",
          amount: 1,
          unit: "day",
          format: "date",
          timezone: "UTC",
        },
        sources: { source: "deadline" },
        dateRule: { fieldId: "name", direction: "after", precision: "minute" },
      },
    ]);
    const deadline = fields.find((field) => field.id === "deadline")!;
    const openBid = fields.find((field) => field.id === "openBidTime")!;
    expect(validateDateRule(deadline, fields)).toEqual([
      "日期比较不能引用自身",
    ]);
    expect(validateDateRule(openBid, fields)).toEqual([
      "要比较的字段「name」不是日期字段",
    ]);
    const { issues } = collectDateRuleTargets(fields);
    expect(issues.map((issue) => issue.message)).toEqual([
      "日期比较不能引用自身",
      "要比较的字段「name」不是日期字段",
    ]);
  });

  it("日期输出只到天时拒绝分钟精度规则", () => {
    const fields = sanitizeFields([
      {
        id: "deadline",
        key: "deadline",
        type: "date",
        params: { format: "date", timezone: "UTC" },
      },
      {
        id: "openBidTime",
        key: "openBidTime",
        type: "derived",
        params: {
          transform: "dateAfter",
          amount: 1,
          unit: "day",
          format: "date",
          timezone: "UTC",
        },
        sources: { source: "deadline" },
        dateRule: {
          fieldId: "deadline",
          direction: "after",
          precision: "minute",
        },
      },
    ]);
    const openBid = fields.find((field) => field.id === "openBidTime")!;
    expect(validateDateRule(openBid, fields)).toEqual([
      "当前字段「openBidTime」输出格式只精确到天，无法按分钟比较",
      "参照字段「deadline」输出格式只精确到天，无法按分钟比较",
    ]);
    const set = generateDateTestCases(fields, { seed: "invalid" });
    expect(set.cases).toEqual([]);
    expect(set.issues).toHaveLength(2);
  });
});

describe("日期边界测试用例", () => {
  it("以分钟生成早一分钟、相等、晚一分钟并依次拒绝、拒绝、通过", () => {
    const fields = projectFields();
    const openBid = fields.find((field) => field.key === "openBidTime")!;
    fields.push({
      id: "openBidReminder",
      key: "openBidReminder",
      type: "derived",
      params: {
        transform: "dateAfter",
        amount: 1,
        unit: "hour",
        format: "datetime",
        timezone: "local",
      },
      sourceFieldIds: { source: openBid.id },
      constraints: { unique: false },
    });
    const set = generateDateTestCases(fields, { seed: "minute-seed" });
    expect(set.issues).toEqual([]);
    expect(set.cases).toHaveLength(3);
    expect(set.cases.map((item) => item.expected)).toEqual([
      "reject",
      "reject",
      "pass",
    ]);
    expect(set.cases.map((item) => item.coverage)).toEqual([
      "早 1 分钟",
      "相等",
      "晚 1 分钟",
    ]);
    for (const item of set.cases) {
      const request = item.request as {
        registrationDeadline: string;
        openBidTime: string;
        openBidReminder: string;
      };
      expect(item.rule.referenceValue).toBe(request.registrationDeadline);
      expect(item.value).toBe(request.openBidTime);
      expect(
        parseDateTimeText(request.openBidReminder)! -
          parseDateTimeText(request.openBidTime)!,
      ).toBe(3600000);
    }
  });

  it("跨日请求保留一分钟差，复制与重建得到同一时间点", () => {
    const fields = midnightFields("UTC");
    const first = generateDateTestCases(fields, {
      seed: "midnight",
      timeZone: "UTC",
    });
    const second = generateDateTestCases(fields, {
      seed: "midnight",
      timeZone: "UTC",
    });
    expect(second.cases).toEqual(first.cases);
    expect(first.issues).toEqual([]);
    const values = first.cases.map((item) => item.value);
    expect(values).toEqual([
      "2024-06-30 23:58:30",
      "2024-06-30 23:59:30",
      "2024-07-01 00:00:30",
    ]);
    expect(first.cases.map((item) => item.request.deadline)).toEqual([
      "2024-06-30 23:59:30",
      "2024-06-30 23:59:30",
      "2024-06-30 23:59:30",
    ]);
    expect(first.cases.map((item) => item.expected)).toEqual([
      "reject",
      "reject",
      "pass",
    ]);
  });

  it("显式时区按墙上时间比较并保持跨日差", () => {
    const fields = midnightFields("Asia/Shanghai");
    const set = generateDateTestCases(fields, {
      seed: "shanghai",
      timeZone: "Asia/Shanghai",
    });
    expect(set.issues).toEqual([]);
    expect(set.cases.map((item) => item.value)).toEqual([
      "2024-06-30 23:58:30",
      "2024-06-30 23:59:30",
      "2024-07-01 00:00:30",
    ]);
  });

  it("整套导出包含日期规则、请求和复现参数", () => {
    const fields = projectFields();
    const set = generateTestCases(fields, { seed: "export-seed" });
    const file = JSON.parse(serializeTestCaseSet(set));
    expect(file.schemaVersion).toBe(3);
    expect(file.seed).toBe("export-seed");
    expect(file.generation.referenceTime).toBe("2024-01-01T09:00:00.000Z");
    expect(file.summary).toEqual({ total: 3, pass: 1, reject: 2 });
    const dateCase = file.cases.find(
      (item: { kind: string }) => item.kind === "date",
    );
    expect(dateCase.rule).toMatchObject({
      direction: "after",
      precision: "minute",
    });
    expect(dateCase.request.openBidTime).toBe(dateCase.value);
  });

  it("自定义模板保存、导出并重新导入后仍能生成同一套日期用例", () => {
    const fields = midnightFields("UTC");
    const template = fieldsToTemplate(fields, "报名开标");
    const restored = templateToFields(
      parseTemplateFile(serializeTemplateFile(template)),
    );
    const deadline = restored.find((field) => field.key === "deadline")!;
    const openBid = restored.find((field) => field.key === "openBidTime")!;
    expect(openBid.dateRule).toEqual({
      fieldId: deadline.id,
      direction: "after",
      precision: "minute",
    });
    const first = generateDateTestCases(fields, {
      seed: "roundtrip",
      timeZone: "UTC",
    });
    const second = generateDateTestCases(restored, {
      seed: "roundtrip",
      timeZone: "UTC",
    });
    expect(second.cases).toEqual(first.cases);
  });

  it("数值与日期用例合并到同一入口和同一份导出", () => {
    const fields = withBudgetRule(projectFields());
    const set = generateTestCases(fields, { seed: "combined" });
    expect(set.issues).toEqual([]);
    expect(set.cases.map((item) => item.kind)).toEqual([
      ...Array(6).fill("numeric"),
      ...Array(3).fill("date"),
    ]);
    expect(set.summary).toEqual({ total: 9, pass: 5, reject: 4 });
    expect(set.targets.map((target) => target.kind)).toEqual([
      "numeric",
      "date",
    ]);
  });
});
