import { describe, expect, it } from "vitest";
import {
  idCardBirthDateForAge,
  idCardCheckCode,
} from "../entrypoints/tools/mock-data/lib/data-pools";
import {
  fieldDependencyErrors,
  generateRowBatches,
  generateRows,
  sanitizeFields,
} from "../entrypoints/tools/mock-data/lib/generators";
import { generateNumericTestCases } from "../entrypoints/tools/mock-data/lib/numeric-cases";
import {
  fieldsToTemplate,
  parseTemplateFile,
  serializeTemplateFile,
  templateToFields,
} from "../entrypoints/tools/mock-data/lib/template-files";
import { TEMPLATES } from "../entrypoints/tools/mock-data/lib/templates";
import type { MockField } from "../entrypoints/tools/mock-data/lib/types";

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

/** 2024-01-01T09:00Z 在上海与 UTC 下都是 2024-01-01；檀香山为 2023-12-31。 */
const SEED_REFERENCE: Record<string, CalendarDate> = {
  "Asia/Shanghai": { year: 2024, month: 1, day: 1 },
  UTC: { year: 2024, month: 1, day: 1 },
  "Pacific/Honolulu": { year: 2023, month: 12, day: 31 },
};

function ageOnDate(birth: CalendarDate, base: CalendarDate): number {
  let age = base.year - birth.year;
  if (
    base.month < birth.month ||
    (base.month === birth.month && base.day < birth.day)
  ) {
    age -= 1;
  }
  return age;
}

function idCardParts(idCard: string) {
  return {
    birth: {
      year: Number(idCard.slice(6, 10)),
      month: Number(idCard.slice(10, 12)),
      day: Number(idCard.slice(12, 14)),
    },
    male: Number(idCard[16]) % 2 === 1,
  };
}

function userFields(): MockField[] {
  const template = TEMPLATES.find((item) => item.id === "user");
  if (!template) throw new Error("缺少用户信息模板");
  const fields = templateToFields(template);
  const age = fields.find((field) => field.key === "age");
  if (!age) throw new Error("缺少年龄字段");
  age.params = { ...age.params, min: 30, max: 65 };
  age.numericRule = { min: 30, max: 65, precision: 1 };
  return fields;
}

function expectIdCardMatches(
  row: Record<string, unknown>,
  timeZone: string,
): void {
  const idCard = String(row.idCard);
  expect(idCard).toMatch(/^\d{17}[\dX]$/);
  expect(idCard.slice(17)).toBe(idCardCheckCode(idCard.slice(0, 17)));
  const parts = idCardParts(idCard);
  expect(ageOnDate(parts.birth, SEED_REFERENCE[timeZone])).toBe(row.age);
  expect(parts.male).toBe(row.gender === "男");
}

describe("用户信息身份证与年龄、性别一致", () => {
  it("按基准日反算的周岁和顺序码性别均与字段一致", () => {
    const fields = userFields();
    const rows = generateRows(fields, 40, {
      seed: "expert-identity",
      locale: "zh-CN",
      timeZone: "Asia/Shanghai",
    });
    for (const row of rows) {
      expect(row.age).toBeGreaterThanOrEqual(30);
      expect(row.age).toBeLessThanOrEqual(65);
      expectIdCardMatches(row, "Asia/Shanghai");
    }
  });

  it("不同时区按各自的基准日计算周岁", () => {
    const fields = userFields();
    for (const timeZone of ["UTC", "Pacific/Honolulu"]) {
      const rows = generateRows(fields, 12, {
        seed: "expert-zone",
        locale: "zh-CN",
        timeZone,
      });
      for (const row of rows) expectIdCardMatches(row, timeZone);
    }
  });

  it("边界场景取 30 与 65 岁时身份证同步重算", () => {
    const rows = generateRows(userFields(), 4, {
      seed: "expert-boundary",
      scenario: "boundary",
      timeZone: "Asia/Shanghai",
    });
    expect(rows.map((row) => row.age)).toEqual([30, 65, 30, 65]);
    for (const row of rows) expectIdCardMatches(row, "Asia/Shanghai");
  });

  it("基准日恰逢生日与生日前一天都得到相同周岁", () => {
    const base = { year: 2024, month: 1, day: 1 };
    const birthday = idCardBirthDateForAge(30, base, () => 0);
    expect(birthday).toEqual({ year: 1994, month: 1, day: 1 });
    expect(ageOnDate(birthday, base)).toBe(30);

    const dayBeforeBirthday = idCardBirthDateForAge(30, base, () => 0.999999);
    expect(dayBeforeBirthday).toEqual({ year: 1993, month: 12, day: 31 });
    expect(ageOnDate(dayBeforeBirthday, base)).toBe(30);
  });

  it("预览与分批下载在相同时区下一致", async () => {
    const fields = userFields();
    const options = { seed: "expert-repeat", timeZone: "Asia/Shanghai" };
    const preview = generateRows(fields, 4, options);
    const downloaded: Record<string, unknown>[] = [];
    for await (const batch of generateRowBatches(fields, 4, options, 1)) {
      downloaded.push(...batch);
    }
    expect(downloaded).toEqual(preview);
  });
});

describe("身份证的来源配置", () => {
  it("自定义字段可选择年龄和性别来源", () => {
    const fields = sanitizeFields([
      { key: "age", type: "age", params: { min: 42, max: 42 } },
      { key: "gender", type: "gender" },
      {
        key: "idCard",
        type: "idCard",
        sources: { age: "age", gender: "gender" },
      },
    ]);
    const idCard = fields.find((field) => field.key === "idCard")!;
    expect(idCard.sourceFieldIds).toMatchObject({
      age: fields[0].id,
      gender: fields[1].id,
    });

    const [row] = generateRows(fields, 1, {
      seed: "custom-identity",
      timeZone: "Asia/Shanghai",
    });
    expect(row.age).toBe(42);
    expectIdCardMatches(row, "Asia/Shanghai");
  });

  it("自定义模板导出、导入后保留来源并生成一致记录", () => {
    const fields = sanitizeFields([
      { key: "age", type: "age", params: { min: 51, max: 51 } },
      { key: "gender", type: "gender" },
      {
        key: "idCard",
        type: "idCard",
        sources: { age: "age", gender: "gender" },
      },
    ]);
    const template = fieldsToTemplate(fields, "证件模板");
    expect(template.rows.find((row) => row.key === "idCard")?.sources).toEqual({
      age: "age",
      gender: "gender",
    });
    const restored = templateToFields(
      parseTemplateFile(serializeTemplateFile(template)),
    );
    expect(
      restored.find((field) => field.key === "idCard")?.sourceFieldIds,
    ).toBeDefined();

    const options = { seed: "roundtrip-identity", timeZone: "Asia/Shanghai" };
    expect(generateRows(restored, 2, options)).toEqual(
      generateRows(fields, 2, options),
    );
  });

  it("未配置来源的身份证仍可单独生成并通过校验位", () => {
    const [row] = generateRows(
      [{ id: "solo", key: "idCard", type: "idCard", params: {} }],
      1,
      { seed: "solo-id" },
    );
    const idCard = String(row.idCard);
    expect(idCard).toMatch(/^\d{17}[\dX]$/);
    expect(idCard.slice(17)).toBe(idCardCheckCode(idCard.slice(0, 17)));
  });

  it("不兼容的来源类型给出字段级错误", () => {
    const fields = sanitizeFields([
      { id: "name1", key: "name", type: "name" },
      {
        id: "card1",
        key: "idCard",
        type: "idCard",
        sourceFieldIds: { age: "name1" },
      },
    ]);
    expect(fieldDependencyErrors(fields).get("card1")?.message).toContain(
      "类型不兼容",
    );
    expect(() => generateRows(fields, 1, { seed: "bad-source" })).toThrow(
      /类型不兼容/,
    );
  });

  it("来源年龄无法生成时指出身份证字段", () => {
    const fields = sanitizeFields([
      { id: "age1", key: "age", type: "age", params: { min: 30, max: 30 } },
      {
        id: "card1",
        key: "idCard",
        type: "idCard",
        sourceFieldIds: { age: "age1" },
      },
    ]);
    expect(() =>
      generateRows(fields, 1, { seed: "bad-age", overrides: { age1: 200 } }),
    ).toThrow(/字段「idCard」：年龄来源/);
  });

  it("旧版 sourceFieldId 迁移为来源绑定", () => {
    const fields = sanitizeFields([
      { id: "a", key: "amount", type: "int", params: {} },
      {
        id: "b",
        key: "copy",
        type: "derived",
        params: {},
        sourceFieldId: "a",
      },
    ]);
    expect(fields[1].sourceFieldIds).toEqual({ source: "a" });
    expect(fields[1].params.sourceKey).toBeUndefined();
  });

  it("删除已选的年龄来源后指出身份证字段", () => {
    const fields = sanitizeFields([
      { key: "age", type: "age", params: { min: 30, max: 30 } },
      {
        key: "idCard",
        type: "idCard",
        sources: { age: "age" },
      },
    ]).filter((field) => field.key !== "age");
    const idCard = fields.find((field) => field.key === "idCard")!;
    expect(fieldDependencyErrors(fields).get(idCard.id)?.message).toContain(
      "年龄来源不存在",
    );
    expect(() => generateRows(fields, 1, { seed: "missing-age" })).toThrow(
      /年龄来源不存在/,
    );
  });
});

describe("年龄规则用例重算身份证", () => {
  it("29 与 30 岁、64 与 65 岁及越界值均带匹配身份证", () => {
    const set = generateNumericTestCases(userFields(), {
      seed: "expert-cases",
      locale: "zh-CN",
      timeZone: "Asia/Shanghai",
    });
    const ageCases = set.cases.filter((item) => item.fieldKey === "age");
    expect(ageCases.map((item) => item.value)).toEqual([
      29, 30, 31, 64, 65, 66,
    ]);
    expect(ageCases.map((item) => item.expected)).toEqual([
      "reject",
      "pass",
      "pass",
      "pass",
      "pass",
      "reject",
    ]);
    for (const item of ageCases) {
      expectIdCardMatches(item.request, "Asia/Shanghai");
    }
    expect(set.generation).toEqual({
      locale: "zh-CN",
      scenario: "normal",
      referenceTime: "2024-01-01T09:00:00.000Z",
      timeZone: "Asia/Shanghai",
    });
  });

  it("相同 Seed、基准日与时区可重建同一套用例", () => {
    const options = {
      seed: "expert-rebuild",
      locale: "zh-CN" as const,
      timeZone: "Asia/Shanghai",
    };
    const first = generateNumericTestCases(userFields(), options);
    const second = generateNumericTestCases(userFields(), options);
    expect(second.cases).toEqual(first.cases);
    expect(second.generation).toEqual(first.generation);
  });
});
