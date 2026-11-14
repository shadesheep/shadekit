import { describe, expect, it } from "vitest";
import {
  exportDataChunks,
  toCSV,
  toSQL,
} from "../entrypoints/tools/mock-data/lib/exporters";
import {
  generateRowBatches,
  generateRows,
} from "../entrypoints/tools/mock-data/lib/generators";
import {
  fieldsFromJSONSample,
  parseSchemaImport,
} from "../entrypoints/tools/mock-data/lib/schema-import";
import {
  fieldsToTemplate,
  parseTemplateFile,
  serializeTemplateFile,
  templateToFields,
} from "../entrypoints/tools/mock-data/lib/template-files";
import type { MockField } from "../entrypoints/tools/mock-data/lib/types";

function field(
  key: string,
  type: string,
  params: Record<string, unknown> = {},
  extra: Partial<MockField> = {},
): MockField {
  return { id: `test_${key}`, key, type, params, ...extra };
}

const SEEDED_FIELDS = [
  field("id", "increment", { start: 1 }),
  field("value", "int", { min: 1, max: 1_000_000 }),
  field("uuid", "uuid"),
];

async function collectChunks(
  batches: AsyncIterable<readonly Record<string, unknown>[]>,
  format: "json" | "jsonl" | "csv" | "sql" | "xml",
): Promise<string> {
  let output = "";
  for await (const chunk of exportDataChunks(batches, format, "users")) {
    output += chunk;
  }
  return output;
}

describe("可复现与分批生成", () => {
  it("相同 seed 重建同批数据，分批结果与一次生成一致", async () => {
    const expected = generateRows(SEEDED_FIELDS, 23, { seed: "case-42" });
    expect(generateRows(SEEDED_FIELDS, 23, { seed: "case-42" })).toEqual(
      expected,
    );

    const batches: Record<string, unknown>[][] = [];
    for await (const batch of generateRowBatches(
      SEEDED_FIELDS,
      23,
      { seed: "case-42" },
      5,
    )) {
      batches.push(batch);
    }
    expect(batches.map((batch) => batch.length)).toEqual([5, 5, 5, 5, 3]);
    expect(batches.flat()).toEqual(expected);
  });

  it("空值策略与全批唯一约束对所有字段统一生效", () => {
    const nullable = generateRows(
      [field("value", "int", {}, { constraints: { nullRate: 1 } })],
      3,
      { seed: "nullable" },
    );
    expect(nullable).toEqual([
      { value: null },
      { value: null },
      { value: null },
    ]);

    expect(() =>
      generateRows(
        [
          field(
            "value",
            "fixed",
            { value: "x" },
            { constraints: { unique: true } },
          ),
        ],
        2,
        { seed: "unique" },
      ),
    ).toThrow(/唯一|冲突/);
  });
});

describe("派生与递归结构", () => {
  it("旧模板的派生来源改名和移位后仍可生成，并按编辑顺序预览和分批导出", async () => {
    const fields = templateToFields({
      id: "legacy",
      name: "金额",
      hint: "",
      rows: [
        { key: "amount", type: "increment", params: { start: 10, step: 10 } },
        {
          key: "amountCn",
          type: "derived",
          params: { sourceKey: "amount", transform: "chineseCapital" },
        },
      ],
    });
    fields[0].key = "budget";
    fields.reverse();

    const options = { seed: "budget" };
    const preview = generateRows(fields, 2, options);
    const downloaded = JSON.parse(
      await collectChunks(generateRowBatches(fields, 3, options, 1), "json"),
    );
    expect(preview).toEqual([
      { amountCn: "壹拾圆整", budget: 10 },
      { amountCn: "贰拾圆整", budget: 20 },
    ]);
    expect(downloaded.slice(0, 2)).toEqual(preview);
    expect(Object.keys(preview[0])).toEqual(["amountCn", "budget"]);
    expect(Object.keys(downloaded[2])).toEqual(["amountCn", "budget"]);
  });

  it("派生字段读取当前行来源值", () => {
    const [row] = generateRows(
      [
        field("amount", "fixed", { value: 1002.01 }),
        field("amountCn", "derived", {
          sourceKey: "amount",
          transform: "chineseCapital",
        }),
      ],
      1,
    );
    expect(row.amountCn).toBe("壹仟零贰圆零壹分");
  });

  it("按编辑顺序序列化数字字段名和嵌套字段", async () => {
    const fields = [
      field("object", "object", {}, {
        children: [
          field("10", "derived", { sourceKey: "2" }),
          field("2", "fixed", { value: 7 }),
        ],
      }),
      field("10", "fixed", { value: 1 }),
      field("2", "fixed", { value: 2 }),
    ];
    const [preview] = generateRows(fields, 1);
    expect(JSON.stringify(preview)).toBe('{"object":{"10":7,"2":7},"10":1,"2":2}');
    const file = await collectChunks(generateRowBatches(fields, 1), "jsonl");
    expect(file.trim()).toBe(JSON.stringify(preview));
  });

  it("对象和对象数组保留递归结构", () => {
    const [row] = generateRows(
      [
        field(
          "profile",
          "object",
          {},
          {
            children: [
              field("name", "fixed", { value: "Ada" }),
              field("nickname", "derived", {
                sourceKey: "name",
                transform: "uppercase",
              }),
            ],
          },
        ),
        field(
          "items",
          "array",
          { minItems: 2, maxItems: 2 },
          {
            children: [field("sku", "fixed", { value: "A-1" })],
          },
        ),
      ],
      1,
      { seed: "nested" },
    );
    expect(row).toEqual({
      profile: { name: "Ada", nickname: "ADA" },
      items: [{ sku: "A-1" }, { sku: "A-1" }],
    });
  });
});

describe("Schema 与模板复用", () => {
  it("JSON 示例和 JSON Schema 均可还原为可生成的字段树", () => {
    const sampleFields = fieldsFromJSONSample({
      user: { name: "Ada" },
      roles: [{ id: 1 }],
    });
    const [sampleRow] = generateRows(sampleFields, 1, { seed: "sample" });
    expect(sampleRow.user).toHaveProperty("name");
    expect(sampleRow.roles).toHaveLength(1);

    const schemaFields = parseSchemaImport(
      JSON.stringify({
        type: "object",
        properties: {
          id: { type: "integer", minimum: 7, maximum: 7 },
          email: {
            anyOf: [{ type: "string", format: "email" }, { type: "null" }],
          },
        },
      }),
    );
    const [schemaRow] = generateRows(schemaFields, 1, { seed: "schema" });
    expect(schemaRow.id).toBe(7);
    expect(
      schemaFields.find((item) => item.key === "email")?.constraints?.nullRate,
    ).toBeGreaterThan(0);
  });

  it("版本化模板递归往返且派生配置不丢失", () => {
    const source = [
      field("amount", "fixed", { value: 10 }),
      field("amountCn", "derived", {
        sourceKey: "amount",
        transform: "chineseCapital",
      }),
    ];
    const template = fieldsToTemplate(source, "金额");
    const restored = parseTemplateFile(serializeTemplateFile(template));
    expect(generateRows(templateToFields(restored), 1)).toEqual([
      { amount: 10, amountCn: "壹拾圆整" },
    ]);
    expect(restored.name).toBe("金额");
  });

  it("自定义模板保存、导出和导入后，嵌套派生跟随已改名的同级字段", () => {
    const fields = templateToFields({
      id: "nested",
      name: "嵌套金额",
      hint: "",
      rows: ["object", "array"].map((type) => ({
        key: type,
        type,
        params: { minItems: 2, maxItems: 2 },
        children: [
          {
            key: "uppercase",
            type: "derived",
            params: { sourceKey: "name", transform: "uppercase" },
          },
          { key: "name", type: "fixed", params: { value: type } },
        ],
      })),
    });
    for (const field of fields) field.children![1].key = "label";

    const file = serializeTemplateFile(fieldsToTemplate(fields, "嵌套金额"));
    const restored = templateToFields(parseTemplateFile(file));
    for (const field of restored) field.children![1].key = "displayName";

    expect(generateRows(restored, 1, { seed: "nested" })).toEqual([
      {
        object: { uppercase: "OBJECT", displayName: "object" },
        array: [
          { uppercase: "ARRAY", displayName: "array" },
          { uppercase: "ARRAY", displayName: "array" },
        ],
      },
    ]);
  });

  it("旧配置优先绑定启用的同名来源，模板往返后仍可生成", () => {
    const fields = templateToFields({
      id: "legacy",
      name: "金额",
      hint: "",
      rows: [
        { key: "amount", type: "fixed", params: { value: 10 } },
        { key: "amount", type: "fixed", params: { value: 99 }, enabled: false },
        { key: "copy", type: "derived", params: { sourceKey: "amount" } },
      ],
    });
    fields[0].key = "expected";
    fields[1].key = "expected";

    const file = serializeTemplateFile(fieldsToTemplate(fields, "金额"));
    const restored = templateToFields(parseTemplateFile(file));
    expect(generateRows(restored, 1)).toEqual([{ expected: 10, copy: 10 }]);
  });
});
describe("通用与分块导出", () => {
  const rows = [
    { id: 1, name: "甲;乙", active: true, amount: 1.234567 },
    { id: 2, name: "丙", active: false, amount: 2 },
  ];

  async function* batches() {
    yield rows.slice(0, 1);
    yield rows.slice(1);
  }

  it("CSV 分隔符、BOM 与 SQL 方言和高精度生效", async () => {
    expect(toCSV(rows, { csvDelimiter: ";", csvBom: true })).toMatch(/^\uFEFF/);
    expect(toCSV(rows, { csvDelimiter: ";" })).toContain('"甲;乙"');
    const sql = toSQL(rows, "users", { sqlDialect: "postgres" });
    expect(sql).toContain('CREATE TABLE "users"');
    expect(sql).toContain("DECIMAL(7,6)");
    expect(sql).toContain("TRUE");

    const chunked = await collectChunks(batches(), "csv");
    expect(chunked.match(/^id,name,active,amount/gm)).toHaveLength(1);
    expect(chunked).toContain("2,丙,false,2");
  });

  it("各格式分块拼接均为完整输出", async () => {
    expect(JSON.parse(await collectChunks(batches(), "json"))).toEqual(rows);
    expect(
      (await collectChunks(batches(), "jsonl")).trim().split("\n"),
    ).toHaveLength(2);

    const sql = await collectChunks(batches(), "sql");
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(1);
    expect(sql.match(/INSERT INTO/g)).toHaveLength(2);

    const xml = await collectChunks(batches(), "xml");
    expect(xml).toContain("<list>");
    expect(xml.trim().endsWith("</list>")).toBe(true);
    expect(xml.match(/data-key="name"/g)).toHaveLength(2);
  });
});
