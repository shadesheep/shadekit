import { describe, expect, it } from "vitest";
import {
  USCC_CHARSET,
  generateIdCard,
  generateUscc,
  idCardCheckCode,
  toChineseCapital,
  usccCheckCode,
} from "../entrypoints/tools/mock-data/lib/data-pools";
import {
  FORMAT_META,
  exportData,
  toCSV,
  toSQL,
  toXML,
  xmlTagName,
} from "../entrypoints/tools/mock-data/lib/exporters";
import {
  createField,
  generateRows,
  getFieldType,
  nextKey,
  parseEnumValues,
  sanitizeFields,
} from "../entrypoints/tools/mock-data/lib/generators";
import { regionFromAddress } from "../entrypoints/tools/mock-data/lib/domains/tender";
import { TEMPLATES } from "../entrypoints/tools/mock-data/lib/templates";
import { templateToFields } from "../entrypoints/tools/mock-data/lib/template-files";

// ─── 身份证校验位（GB 11643） ───────────────────────────────

describe("身份证号生成", () => {
  it("生成的 100 个身份证号均通过校验位验证", () => {
    for (let i = 0; i < 100; i++) {
      const id = generateIdCard();
      expect(id).toMatch(/^\d{17}[\dX]$/);
      expect(idCardCheckCode(id.slice(0, 17))).toBe(id[17]);
    }
  });

  it("已知样本的校验码计算正确", () => {
    // 11010519491231002 → X（经典示例）
    expect(idCardCheckCode("11010519491231002")).toBe("X");
  });
});

// ─── 统一社会信用代码（GB 32100） ────────────────────────────

describe("统一社会信用代码生成", () => {
  it("生成的 100 个 USCC 均为 18 位且通过校验位验证", () => {
    for (let i = 0; i < 100; i++) {
      const code = generateUscc();
      expect(code).toHaveLength(18);
      for (const ch of code) {
        expect(USCC_CHARSET).toContain(ch);
      }
      expect(usccCheckCode(code.slice(0, 17))).toBe(code[17]);
    }
  });

  it("以 91（工商部门登记企业）开头", () => {
    expect(generateUscc().startsWith("91")).toBe(true);
  });
});

// ─── 人民币大写金额 ─────────────────────────────────────────

describe("toChineseCapital 金额大写", () => {
  const cases: Array<[number, string]> = [
    [0, "零圆整"],
    [10, "壹拾圆整"],
    [100, "壹佰圆整"],
    [105.3, "壹佰零伍圆叁角"],
    [1002.01, "壹仟零贰圆零壹分"],
    [12345678.9, "壹仟贰佰叁拾肆万伍仟陆佰柒拾捌圆玖角"],
    [100000, "壹拾万圆整"],
    [100001, "壹拾万零壹圆整"],
    [0.05, "伍分"],
    [0.5, "伍角"],
    [100000000, "壹亿圆整"],
  ];

  it.each(cases)("%s → %s", (input, expected) => {
    expect(toChineseCapital(input)).toBe(expected);
  });

  it("负数/非数值返回空串", () => {
    expect(toChineseCapital(-1)).toBe("");
    expect(toChineseCapital(Number.NaN)).toBe("");
  });
});

// ─── 字段创建与键名去重 ──────────────────────────────────────

describe("createField / nextKey", () => {
  it("键名冲突时自动追加序号", () => {
    const existing = new Set(["name", "name2"]);
    expect(nextKey("name", existing)).toBe("name3");
  });

  it("createField 产出默认参数与去重键名", () => {
    const a = createField("int", new Set());
    const b = createField("int", new Set([a!.key]));
    expect(a!.key).toBe("num");
    expect(b!.key).toBe("num2");
    expect(a!.params).toMatchObject({ min: 1, max: 1000 });
  });

  it("未知类型返回 null", () => {
    expect(createField("not-exist", new Set())).toBeNull();
  });
});

// ─── sanitizeFields ─────────────────────────────────────────

describe("sanitizeFields 存储恢复清洗", () => {
  it("丢弃未知类型并补齐默认参数", () => {
    const rows = sanitizeFields([
      { id: "x", key: "n", type: "int", params: { min: 5 } },
      { id: "y", key: "ghost", type: "removed-type", params: {} },
      { id: "z", key: "", type: "name", params: {} },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].params).toMatchObject({ min: 5, max: 1000 });
    expect(rows[1].key).toBe("name"); // 空键名回退为类型默认键
  });

  it("非数组输入返回空数组", () => {
    expect(sanitizeFields(undefined)).toEqual([]);
    expect(sanitizeFields("x")).toEqual([]);
  });
});

// ─── 生成器行为 ─────────────────────────────────────────────

describe("generateRows", () => {
  it("生成指定行数且键名透传", () => {
    const fields = [
      { id: "a", key: "name", type: "name", params: {} },
      { id: "b", key: "age", type: "age", params: { min: 20, max: 20 } },
    ];
    const rows = generateRows(fields, 5);
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(Object.keys(row)).toEqual(["name", "age"]);
      expect(typeof row.name).toBe("string");
      expect(row.age).toBe(20);
    }
  });

  it("自增序号支持起始/步长/补零", () => {
    const fields = [
      {
        id: "a",
        key: "seq",
        type: "increment",
        params: { start: 10, step: 5, pad: 4 },
      },
    ];
    const rows = generateRows(fields, 3);
    expect(rows.map((r) => r.seq)).toEqual(["0010", "0015", "0020"]);
  });

  it("固定值解析 JSON 字面量，非法 JSON 回退为字符串", () => {
    const fields = [
      { id: "a", key: "n", type: "fixed", params: { value: "123" } },
      { id: "b", key: "b", type: "fixed", params: { value: "true" } },
      { id: "c", key: "s", type: "fixed", params: { value: "hello" } },
      { id: "d", key: "arr", type: "fixed", params: { value: "[1,2]" } },
    ];
    const [row] = generateRows(fields, 1);
    expect(row.n).toBe(123);
    expect(row.b).toBe(true);
    expect(row.s).toBe("hello");
    expect(row.arr).toEqual([1, 2]);
  });

  it("行数 clamp 到 1-100000", () => {
    const fields = [{ id: "a", key: "x", type: "boolean", params: {} }];
    expect(generateRows(fields, 0)).toHaveLength(1);
    expect(generateRows(fields, 100001)).toHaveLength(100000);
  });
});

describe("parseEnumValues", () => {
  it("支持中英文逗号/顿号/竖线/空白分隔，并解析字面量", () => {
    expect(parseEnumValues("草稿，已提交,已审核")).toEqual([
      "草稿",
      "已提交",
      "已审核",
    ]);
    expect(parseEnumValues("1、2|3 4")).toEqual([1, 2, 3, 4]);
    expect(parseEnumValues("true,false")).toEqual([true, false]);
    expect(parseEnumValues("")).toEqual([]);
  });
});

// ─── 导出器 ─────────────────────────────────────────────────

const SAMPLE_ROWS = [
  { id: 1, name: "王伟", score: 95.5, vip: true, note: "含,逗号" },
  { id: 2, name: "李'娜", score: 88, vip: false, note: '含"引号"' },
];

describe("CSV 导出", () => {
  it("转义逗号与引号", () => {
    const csv = toCSV(SAMPLE_ROWS);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("id,name,score,vip,note");
    expect(lines[1]).toContain('"含,逗号"');
    expect(lines[2]).toContain("李'娜");
    expect(lines[2]).toContain('"含""引号"""');
  });
});

describe("SQL 导出", () => {
  it("按列推断类型并合并为单条 INSERT", () => {
    const sql = toSQL(SAMPLE_ROWS, "users");
    expect(sql).toContain("CREATE TABLE `users`");
    expect(sql).toContain("`id` INT");
    expect(sql).toContain("`score` DECIMAL(3,1)");
    expect(sql).toContain("`vip` TINYINT(1)");
    expect(sql).toContain("`name` VARCHAR(255)");
    // 单条 INSERT、两行 VALUES
    expect(sql.match(/INSERT INTO/g)).toHaveLength(1);
    expect(sql).toContain("(1, '王伟', 95.5, 1, '含,逗号')");
    // 单引号转义
    expect(sql).toContain("'李''娜'");
  });

  it("长文本列推断为 TEXT", () => {
    const rows = [{ content: "x".repeat(300) }];
    expect(toSQL(rows, "t")).toContain("`content` TEXT");
  });
});

describe("XML 导出", () => {
  it("生成合法且互不冲突的标签，并保留原始键名", () => {
    expect(xmlTagName("项目名称")).not.toBe(xmlTagName("项目编号"));
    expect(xmlTagName("1st")).toMatch(/^[A-Za-z_]/);

    const xml = toXML([{ 项目名称: "<b>&\"'", 项目编号: "x" }]);
    expect(xml).toContain("&lt;b&gt;&amp;&quot;&apos;");
    expect(xml).toContain('data-key="项目名称"');
    expect(xml).toContain('data-key="项目编号"');
  });
});

describe("JSON / JSONL 导出", () => {
  it("JSONL 每行一个可解析对象", () => {
    const out = exportData(SAMPLE_ROWS, "jsonl");
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).name).toBe("王伟");
  });

  it("统一入口按格式分发", () => {
    for (const fmt of Object.keys(FORMAT_META)) {
      const out = exportData(SAMPLE_ROWS, fmt as keyof typeof FORMAT_META);
      expect(out.length).toBeGreaterThan(0);
    }
  });
});

// ─── 模板完整性 ─────────────────────────────────────────────

describe("预设模板", () => {
  it("所有模板行引用的类型都存在，且键名不重复", () => {
    for (const tpl of TEMPLATES) {
      const keys = new Set<string>();
      for (const row of tpl.rows) {
        expect(createField(row.type, new Set())).not.toBeNull();
        expect(keys.has(row.key)).toBe(false);
        keys.add(row.key);
      }
    }
  });

  it("模板可直接生成数据", () => {
    for (const tpl of TEMPLATES) {
      const rows = generateRows(templateToFields(tpl), 3);
      expect(rows).toHaveLength(3);
      expect(Object.keys(rows[0])).toEqual(tpl.rows.map((r) => r.key));
    }
  });
});

// ─── 模板字段关系 ───────────────────────────────────────────

describe("预设模板关系", () => {
  it("招标项目名称中的地区与地区地址一致", () => {
    const project = TEMPLATES.find((template) => template.id === "project")!;
    const rows = generateRows(templateToFields(project), 20, {
      seed: "project-region",
    });
    for (const row of rows) {
      const region = regionFromAddress(String(row.region));
      expect(region).not.toBe("");
      expect(String(row.projectName).startsWith(region)).toBe(true);
    }
  });

  it("用户信息身份证关联年龄性别，评标专家与评标办法已移除", () => {
    expect(TEMPLATES.some((template) => template.id === "expert")).toBe(false);
    expect(getFieldType("evalMethod")).toBeUndefined();
    const project = TEMPLATES.find((template) => template.id === "project")!;
    expect(project.rows.some((row) => row.key === "evalMethod")).toBe(false);

    const user = TEMPLATES.find((template) => template.id === "user")!;
    const fields = templateToFields(user);
    const idCard = fields.find((field) => field.key === "idCard")!;
    const age = fields.find((field) => field.key === "age")!;
    const gender = fields.find((field) => field.key === "gender")!;
    expect(idCard.sourceFieldIds).toMatchObject({
      age: age.id,
      gender: gender.id,
    });
    const [row] = generateRows(fields, 1, { seed: "user-card" });
    expect(String(row.idCard)).toMatch(/^\d{17}[\dX]$/);
  });
});
