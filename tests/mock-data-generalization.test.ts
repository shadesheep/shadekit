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
    expect(templateToFields(restored)[1].params).toMatchObject(
      source[1].params,
    );
    expect(restored.name).toBe("金额");
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
