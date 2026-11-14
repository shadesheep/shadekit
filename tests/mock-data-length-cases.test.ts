import { describe, expect, it } from "vitest";
import {
  MAX_CASE_LENGTH,
  generateLengthTestCases,
  validateLengthRule,
} from "../entrypoints/tools/mock-data/lib/length-cases";
import type { LengthTestCaseSet } from "../entrypoints/tools/mock-data/lib/length-cases";
import { generateTestCases } from "../entrypoints/tools/mock-data/lib/test-cases";
import {
  charLength,
  createField,
  sanitizeFields,
} from "../entrypoints/tools/mock-data/lib/generators";
import {
  fieldsToTemplate,
  parseTemplateFile,
  serializeTemplateFile,
  templateToFields,
} from "../entrypoints/tools/mock-data/lib/template-files";
import type { MockField } from "../entrypoints/tools/mock-data/lib/types";

function caseLengths(set: LengthTestCaseSet): number[] {
  return set.cases.map((item) => item.value);
}

describe("长度规则校验", () => {
  it("接受字符串与数组的非负整数区间，拒绝反向、非整数与缺失区间", () => {
    const stringField = createField("string", new Set())!;
    stringField.lengthRule = { min: 2, max: 20 };
    expect(validateLengthRule(stringField)).toEqual([]);

    const arrayField = createField("array", new Set())!;
    arrayField.lengthRule = { min: 0, max: 3 };
    expect(validateLengthRule(arrayField)).toEqual([]);

    stringField.lengthRule = { min: 20, max: 2 };
    expect(validateLengthRule(stringField)).toContain(
      "最小长度不能大于最大长度",
    );
    stringField.lengthRule = { min: 2.5, max: 20 };
    expect(validateLengthRule(stringField)).toContain("最小长度必须是非负整数");
    stringField.lengthRule = { min: -1 };
    expect(validateLengthRule(stringField)).toContain("最小长度必须是非负整数");
    stringField.lengthRule = {};
    expect(validateLengthRule(stringField)).toContain(
      "请至少填写最小长度或最大长度",
    );

    const intField = createField("int", new Set())!;
    intField.lengthRule = { min: 1 };
    expect(validateLengthRule(intField)).toContain(
      "当前字段类型不支持长度校验规则",
    );
  });
});

describe("字符串长度用例", () => {
  const fields = () =>
    sanitizeFields([
      {
        key: "nickname",
        type: "string",
        params: { length: "8", charset: "cn" },
        lengthRule: { min: 2, max: 20 },
      },
    ]);

  it("昵称长度 2–20 生成 1、2、3、19、20、21，越界值预期拒绝", () => {
    const set = generateLengthTestCases(fields(), { seed: "nickname" });
    expect(set.issues).toEqual([]);
    expect(caseLengths(set)).toEqual([1, 2, 3, 19, 20, 21]);
    expect(set.cases.map((item) => item.expected)).toEqual([
      "reject",
      "pass",
      "pass",
      "pass",
      "pass",
      "reject",
    ]);
    for (const item of set.cases) {
      expect(charLength(String(item.request.nickname))).toBe(item.value);
    }
  });

  it("允许 0 时生成空字符串，中文与 emoji 都按字符计数", () => {
    const emptySet = generateLengthTestCases(
      sanitizeFields([
        {
          key: "nickname",
          type: "string",
          params: { length: "8", charset: "cn" },
          lengthRule: { min: 0, max: 0 },
        },
      ]),
      { seed: "empty" },
    );
    expect(caseLengths(emptySet)).toEqual([0, 1]);
    expect(emptySet.cases[0].request.nickname).toBe("");
    expect(emptySet.cases[0].expected).toBe("pass");

    const emojiSet = generateLengthTestCases(
      sanitizeFields([
        {
          key: "emoji",
          type: "string",
          params: { length: "8", charset: "emoji" },
          lengthRule: { min: 2, max: 3 },
        },
      ]),
      { seed: "emoji" },
    );
    for (const item of emojiSet.cases) {
      expect(charLength(String(item.request.emoji))).toBe(item.value);
    }
  });

  it("超出单条用例上限的候选值报告覆盖缺口", () => {
    const set = generateLengthTestCases(
      sanitizeFields([
        {
          key: "text",
          type: "string",
          params: { length: "8" },
          lengthRule: { min: 1, max: MAX_CASE_LENGTH + 500 },
        },
      ]),
      { seed: "too-long" },
    );
    expect(caseLengths(set)).toEqual([0, 1, 2]);
    expect(set.issues).toHaveLength(3);
    for (const issue of set.issues) {
      expect(issue.message).toContain("超出单条用例生成上限");
    }
  });
});

describe("数组长度用例", () => {
  it("数组长度 1–3 生成 0、1、2、3、4，重合候选只出现一次", () => {
    const set = generateLengthTestCases(
      sanitizeFields([
        {
          key: "items",
          type: "array",
          params: { minItems: 1, maxItems: 3, itemType: "string" },
          lengthRule: { min: 1, max: 3 },
        },
      ]),
      { seed: "array-length" },
    );
    expect(caseLengths(set)).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(caseLengths(set)).size).toBe(5);
    expect(set.cases.map((item) => item.expected)).toEqual([
      "reject",
      "pass",
      "pass",
      "pass",
      "reject",
    ]);
    for (const item of set.cases) {
      expect(item.request.items).toHaveLength(item.value);
    }
  });

  it("对象数组按目标长度新增元素，子字段及其依赖照常生成", () => {
    const fields: MockField[] = sanitizeFields([
      {
        key: "items",
        type: "array",
        params: { minItems: 1, maxItems: 2 },
        lengthRule: { min: 1, max: 2 },
        children: [
          { key: "code", type: "fixed", params: { value: "A" } },
          {
            key: "copy",
            type: "derived",
            params: { transform: "copy" },
            sources: { source: "code" },
          },
          { key: "age", type: "age", params: { min: 30, max: 40 } },
        ],
      },
    ]);
    const set = generateLengthTestCases(fields, { seed: "object-array" });
    expect(caseLengths(set)).toEqual([0, 1, 2, 3]);
    for (const item of set.cases) {
      const items = item.request.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(item.value);
      for (const entry of items) {
        expect(entry.code).toBe("A");
        expect(entry.copy).toBe("A");
        expect(entry.age).toBeGreaterThanOrEqual(30);
        expect(entry.age).toBeLessThanOrEqual(40);
      }
    }
  });

  it("对象数组内的字符串长度规则按元素逐个生效", () => {
    const set = generateLengthTestCases(
      sanitizeFields([
        {
          key: "items",
          type: "array",
          params: { minItems: 2, maxItems: 2 },
          children: [
            {
              key: "nickname",
              type: "string",
              params: { length: "4", charset: "cn" },
              lengthRule: { min: 2, max: 3 },
            },
          ],
        },
      ]),
      { seed: "nested-length" },
    );
    expect(caseLengths(set)).toEqual([1, 2, 3, 4]);
    for (const item of set.cases) {
      const items = item.request.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(2);
      for (const entry of items) {
        expect(charLength(String(entry.nickname))).toBe(item.value);
      }
    }
  });
});

describe("长度用例复用与复现", () => {
  it("同一配置与 Seed 可复现，模板往返后仍能重新生成", () => {
    const fields = sanitizeFields([
      {
        key: "nickname",
        type: "string",
        params: { length: "8", charset: "cn" },
        lengthRule: { min: 2, max: 20 },
      },
      {
        key: "items",
        type: "array",
        params: { minItems: 1, maxItems: 3, itemType: "string" },
        lengthRule: { min: 1, max: 3 },
      },
    ]);
    const options = { seed: "length-roundtrip" };
    const first = generateLengthTestCases(fields, options);
    expect(generateLengthTestCases(fields, options).cases).toEqual(first.cases);

    const template = fieldsToTemplate(fields, "长度模板");
    expect(template.rows.map((row) => row.lengthRule)).toEqual([
      { min: 2, max: 20 },
      { min: 1, max: 3 },
    ]);
    const restored = templateToFields(
      parseTemplateFile(serializeTemplateFile(template)),
    );
    expect(generateLengthTestCases(restored, options).cases).toEqual(
      first.cases,
    );
  });

  it("合并入口同时包含长度与数值用例", () => {
    const fields = sanitizeFields([
      {
        key: "nickname",
        type: "string",
        params: { length: "8" },
        lengthRule: { min: 2, max: 20 },
      },
      {
        key: "amount",
        type: "int",
        params: { min: 1, max: 10 },
        numericRule: { min: 1, max: 10, precision: 1 },
      },
    ]);
    const set = generateTestCases(fields, { seed: "combined" });
    expect(set.cases.filter((item) => item.kind === "length")).toHaveLength(6);
    expect(set.cases.some((item) => item.kind === "numeric")).toBe(true);
    expect(set.targets.map((target) => target.kind)).toEqual(
      expect.arrayContaining(["length", "numeric"]),
    );
  });
});
