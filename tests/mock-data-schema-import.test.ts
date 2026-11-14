import { describe, expect, it } from "vitest";
import {
  analyzeSchemaImport,
  parseSchemaImport,
} from "../entrypoints/tools/mock-data/lib/schema-import";
import {
  fieldsToTemplate,
  parseTemplateFile,
  serializeTemplateFile,
  templateToFields,
} from "../entrypoints/tools/mock-data/lib/template-files";
import {
  generateTestCases,
  type TestCaseSet,
} from "../entrypoints/tools/mock-data/lib/test-cases";
import type { MockField } from "../entrypoints/tools/mock-data/lib/types";

const SCHEMA = {
  type: "object",
  required: ["id", "nickname"],
  properties: {
    id: { type: "integer", minimum: 1, maximum: 100 },
    nickname: {
      type: "string",
      minLength: 2,
      maxLength: 20,
      pattern: "^[a-z]+$",
    },
    tags: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: { type: "string" },
    },
    email: {
      anyOf: [{ type: "string", format: "email" }, { type: "null" }],
    },
    profile: {
      type: "object",
      required: ["age"],
      properties: {
        age: { type: "integer", minimum: 18, maximum: 60 },
      },
    },
    orders: {
      type: "array",
      minItems: 1,
      maxItems: 2,
      items: {
        type: "object",
        required: ["amount"],
        properties: {
          amount: { type: "number", minimum: 0.01, maximum: 9.99 },
        },
      },
    },
  },
};

function fieldByPath(fields: MockField[], ...keys: string[]): MockField {
  let list = fields;
  let field: MockField | undefined;
  for (const key of keys) {
    field = list.find((item) => item.key === key);
    if (!field) throw new Error(`缺少字段 ${keys.join(".")}`);
    list = field.children ?? [];
  }
  return field!;
}

function caseValues(
  set: TestCaseSet,
  kind: "numeric" | "length",
  fieldKey: string,
) {
  return set.cases
    .filter((item) => item.kind === kind && item.fieldKey === fieldKey)
    .map((item) => item.value);
}

describe("JSON Schema 导入规则映射", () => {
  it("把必填、可空、数值、长度、类型与格式映射到字段规则", () => {
    const report = analyzeSchemaImport(JSON.stringify(SCHEMA));
    expect(report.source).toBe("schema");
    expect(report.fields.map((field) => field.key)).toEqual([
      "id",
      "nickname",
      "tags",
      "email",
      "profile",
      "orders",
    ]);

    const id = fieldByPath(report.fields, "id");
    expect(id.type).toBe("int");
    expect(id.params).toMatchObject({ min: 1, max: 100 });
    expect(id.numericRule).toEqual({ min: 1, max: 100 });
    expect(id.inputRule).toMatchObject({ required: true, type: "integer" });

    const nickname = fieldByPath(report.fields, "nickname");
    expect(nickname.type).toBe("string");
    expect(nickname.params.length).toBe("2-20");
    expect(nickname.lengthRule).toEqual({ min: 2, max: 20 });
    expect(nickname.inputRule).toMatchObject({
      required: true,
      type: "string",
    });

    const tags = fieldByPath(report.fields, "tags");
    expect(tags.inputRule).toMatchObject({ type: "array" });
    expect(tags.lengthRule).toEqual({ min: 1, max: 3 });
    expect(tags.params).toMatchObject({ minItems: 1, maxItems: 3 });

    const email = fieldByPath(report.fields, "email");
    expect(email.type).toBe("email");
    expect(email.inputRule).toMatchObject({
      nullable: true,
      type: "string",
      format: "email",
    });

    const age = fieldByPath(report.fields, "profile", "age");
    expect(age.inputRule).toMatchObject({ required: true, type: "integer" });

    const orders = fieldByPath(report.fields, "orders");
    expect(orders.lengthRule).toEqual({ min: 1, max: 2 });
    const amount = fieldByPath(report.fields, "orders", "amount");
    expect(amount).toBeDefined();
    expect(amount.numericRule).toEqual({ min: 0.01, max: 9.99 });
    expect(amount.inputRule).toMatchObject({
      required: true,
      type: "number",
    });
  });

  it("列出已识别字段并标明待处理关键词所在路径", () => {
    const report = analyzeSchemaImport(
      JSON.stringify({
        type: "object",
        properties: {
          id: { type: "integer", exclusiveMinimum: 0 },
          name: { type: "string", pattern: "^[a-z]+$" },
          nested: {
            type: "object",
            properties: {
              code: { type: "string", format: "uri" },
            },
          },
        },
      }),
    );

    expect(report.recognized.map((item) => item.path)).toEqual([
      "id",
      "name",
      "nested",
      "nested.code",
    ]);
    const pending = report.pending.map(
      (item) => `${item.path}:${item.keyword}`,
    );
    expect(pending).toContain("id:exclusiveMinimum");
    expect(pending).toContain("name:pattern");
    expect(pending).toContain("nested.code:format");
  });

  it("保留枚举值的原始 JSON 类型并接受 JSON 示例", () => {
    const report = analyzeSchemaImport(
      JSON.stringify({
        type: "object",
        properties: {
          level: { enum: [1, 2, 3] },
          status: { type: "string", enum: ["active", "disabled"] },
          sample: { type: "string" },
        },
      }),
    );
    const level = fieldByPath(report.fields, "level");
    expect(level.type).toBe("enum");
    expect(level.params.values).toEqual([1, 2, 3]);
    expect(level.inputRule?.enumValues).toEqual([1, 2, 3]);
    expect(level.inputRule?.type).toBe("integer");

    const status = fieldByPath(report.fields, "status");
    expect(status.inputRule?.enumValues).toEqual(["active", "disabled"]);
    expect(status.inputRule?.type).toBe("string");

    const restored = templateToFields(
      parseTemplateFile(
        serializeTemplateFile(fieldsToTemplate(report.fields, "枚举")),
      ),
    );
    const restoredLevel = fieldByPath(restored, "level");
    expect(restoredLevel.params.values).toEqual([1, 2, 3]);
    expect(restoredLevel.inputRule?.enumValues).toEqual([1, 2, 3]);

    const sampleReport = analyzeSchemaImport('{"name":"张三","age":28}');
    expect(sampleReport.source).toBe("sample");
    expect(sampleReport.recognized.map((item) => item.path)).toEqual([
      "name",
      "age",
    ]);
    expect(sampleReport.pending).toEqual([]);
    expect(parseSchemaImport('{"name":"张三"}')[0].key).toBe("name");
  });
});

describe("Schema 导入后的测试用例", () => {
  it("直接生成范围、缺失、空值与长度用例", () => {
    const fields = parseSchemaImport(JSON.stringify(SCHEMA));
    const set = generateTestCases(fields, { seed: "schema-import" });
    expect(set.issues).toEqual([]);

    const idCases = set.cases.filter(
      (item) => item.kind === "numeric" && item.fieldKey === "id",
    );
    expect(idCases.map((item) => item.value)).toEqual([0, 1, 2, 99, 100, 101]);
    expect(
      idCases
        .filter((item) => item.expected === "reject")
        .map((item) => item.value),
    ).toEqual([0, 101]);

    expect(caseValues(set, "length", "nickname")).toEqual([
      1, 2, 3, 19, 20, 21,
    ]);
    expect(caseValues(set, "length", "tags")).toEqual([0, 1, 2, 3, 4]);

    const idMissing = set.cases.find(
      (item) =>
        item.kind === "input" && item.fieldKey === "id" && !item.present,
    );
    expect(idMissing?.expected).toBe("reject");

    const nicknameMissing = set.cases.find(
      (item) =>
        item.kind === "input" && item.fieldKey === "nickname" && !item.present,
    );
    expect(nicknameMissing?.expected).toBe("reject");

    const emailNull = set.cases.find(
      (item) =>
        item.kind === "input" &&
        item.fieldKey === "email" &&
        item.present &&
        item.value === null,
    );
    expect(emailNull?.expected).toBe("pass");

    const emailMissing = set.cases.find(
      (item) =>
        item.kind === "input" && item.fieldKey === "email" && !item.present,
    );
    expect(emailMissing?.expected).toBe("pass");
  });

  it("自定义模板往返后保留规则，同 Seed 复现用例", () => {
    const fields = parseSchemaImport(JSON.stringify(SCHEMA));
    const original = generateTestCases(fields, { seed: "roundtrip" });
    const template = fieldsToTemplate(fields, "Schema 导入");
    const restored = templateToFields(
      parseTemplateFile(serializeTemplateFile(template)),
    );

    const nickname = fieldByPath(restored, "nickname");
    expect(nickname.lengthRule).toEqual({ min: 2, max: 20 });
    const id = fieldByPath(restored, "id");
    expect(id.numericRule).toEqual({ min: 1, max: 100 });
    const email = fieldByPath(restored, "email");
    expect(email.inputRule).toMatchObject({
      nullable: true,
      format: "email",
    });

    const replay = generateTestCases(restored, { seed: "roundtrip" });
    expect(replay.cases).toEqual(original.cases);
  });
});
