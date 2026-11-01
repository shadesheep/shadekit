import { describe, expect, it } from "vitest";
import {
  addShelfEntry,
  countEnabled,
  deselectScenario,
  fieldDisplayName,
  genericGroups,
  preloadScenario,
  resolveFallbackScenarioId,
  scenarioEntries,
  scenarioGroups,
  searchShelf,
  selectScenario,
  toggleShelfEntry,
} from "../entrypoints/mock-data/lib/field-shelf";
import { sanitizeFields } from "../entrypoints/tools/mock-data/lib/generators";
import {
  TEMPLATES,
  type MockTemplate,
} from "../entrypoints/tools/mock-data/lib/templates";
import type { MockField } from "../entrypoints/tools/mock-data/lib/types";

const bidder = TEMPLATES.find((template) => template.id === "bidder")!;
const user = TEMPLATES.find((template) => template.id === "user")!;
const project = TEMPLATES.find((template) => template.id === "project")!;

describe("货架条目与分组", () => {
  it("全部场景按分类分组，包含通用身份证字段", () => {
    const groups = genericGroups();
    expect(groups.map((group) => group.label)).toEqual(
      expect.arrayContaining(["基础", "人员", "企业", "招投标", "技术"]),
    );
    expect(groups.flatMap((group) => group.entries)).toContainEqual(
      expect.objectContaining({
        key: "idCard",
        label: "身份证号",
        typeId: "idCard",
      }),
    );
  });

  it("场景条目保留 key、label、params 与来源场景", () => {
    const contact = scenarioEntries(bidder).find(
      (entry) => entry.key === "contactName",
    )!;
    expect(contact).toMatchObject({
      key: "contactName",
      label: "联系人",
      typeId: "name",
      scenarioId: "bidder",
      scenarioName: "投标人信息",
    });
    expect(contact.row).toBeTruthy();
    expect(scenarioGroups(bidder).map((group) => group.label)).toEqual([
      "人员",
      "企业",
    ]);
  });

  it("未知类型行被过滤，不产生不可选条目", () => {
    const ghost: MockTemplate = {
      id: "ghost",
      name: "幽灵场景",
      hint: "",
      rows: [{ key: "x", type: "missing" }],
    };
    expect(scenarioEntries(ghost)).toEqual([]);
    expect(selectScenario([], ghost)).toEqual({ fields: [], added: 0 });
  });

  it("搜索同时覆盖通用字段与场景字段", () => {
    const idCard = searchShelf("身份证", TEMPLATES).find(
      (group) => group.id === "types",
    );
    expect(idCard?.entries.map((entry) => entry.key)).toContain("idCard");

    const contact = searchShelf("联系人", TEMPLATES).find(
      (group) => group.id === "scenario",
    );
    expect(contact?.entries).toContainEqual(
      expect.objectContaining({ key: "contactName", scenarioName: "投标人信息" }),
    );
    expect(
      searchShelf("contactName", TEMPLATES).some(
        (group) => group.id === "scenario",
      ),
    ).toBe(true);
  });

  it("不存在的场景 id 回退到用户信息", () => {
    expect(resolveFallbackScenarioId(undefined, TEMPLATES)).toBe("user");
    expect(resolveFallbackScenarioId("gone", TEMPLATES)).toBe("user");
    expect(resolveFallbackScenarioId("bidder", TEMPLATES)).toBe("bidder");
  });
});

describe("按 key 增删", () => {
  it("通用条目 toggle：先加后删", () => {
    const entry = genericGroups()
      .flatMap((group) => group.entries)
      .find((item) => item.typeId === "name")!;
    const added = toggleShelfEntry([], entry);
    expect(added.action).toBe("added");
    expect(added.fields.map((field) => field.key)).toEqual(["name"]);

    const removed = toggleShelfEntry(added.fields, entry);
    expect(removed.action).toBe("removed");
    expect(removed.fields).toEqual([]);
  });

  it("通用条目重名时 createField 自动加后缀", () => {
    const nameField = sanitizeFields([
      { key: "name", type: "name", params: {} },
    ])[0];
    const entry = genericGroups()
      .flatMap((group) => group.entries)
      .find((item) => item.typeId === "name")!;
    const result = addShelfEntry([nameField], entry);
    expect(result.added).toBe(true);
    expect(result.fields.map((field) => field.key)).toEqual(["name", "name2"]);
  });

  it("场景条目保留 label 与嵌套子树，重复 key 跳过", () => {
    const contact = scenarioEntries(bidder).find(
      (entry) => entry.key === "contactName",
    )!;
    const nested: MockTemplate = {
      id: "nested",
      name: "嵌套场景",
      hint: "",
      rows: [
        {
          key: "profile",
          type: "object",
          label: "资料",
          children: [{ key: "nick", type: "name" }],
        },
      ],
    };
    const [profile] = scenarioEntries(nested);
    const result = addShelfEntry([], profile);
    expect(result.fields[0]).toMatchObject({ key: "profile", label: "资料" });
    expect(result.fields[0].children?.[0].key).toBe("nick");

    const first = addShelfEntry([], contact);
    const second = addShelfEntry(first.fields, contact);
    expect(first.fields[0].label).toBe("联系人");
    expect(second.added).toBe(false);
    expect(second.fields).toHaveLength(1);
  });

  it("全选只补缺失字段，全不选只删场景 key；改过 key 的字段不受影响", () => {
    const existing = sanitizeFields([
      { key: "name", type: "name", params: {} },
      { key: "renamed", type: "name", params: {} },
    ]);
    const selected = selectScenario(existing, user);
    expect(selected.fields.filter((field) => field.key === "name")).toHaveLength(
      1,
    );
    expect(selected.added).toBe(user.rows.length - 1);

    const removed = deselectScenario(selected.fields, user);
    expect(removed.removed).toBe(user.rows.length);
    expect(removed.fields.map((field) => field.key)).toEqual(["renamed"]);
  });

  it("场景全选对项目模板逐项添加", () => {
    const result = selectScenario([], project);
    expect(result.added).toBe(project.rows.length);
    expect(result.fields.map((field) => field.key)).toEqual(
      project.rows.map((row) => row.key),
    );
  });
});

describe("字段显示名与默认字段", () => {
  it("label 优先，其次类型名，最后 key", () => {
    const [labelled] = sanitizeFields([
      { key: "contactName", type: "name", label: "联系人", params: {} },
    ]);
    const [plain] = sanitizeFields([
      { key: "name", type: "name", params: {} },
    ]);
    const unknown: MockField = {
      id: "x",
      key: "mystery",
      type: "removed",
      params: {},
    };
    expect(fieldDisplayName(labelled)).toBe("联系人");
    expect(fieldDisplayName(plain)).toBe("姓名");
    expect(fieldDisplayName(unknown)).toBe("mystery");
  });
});

describe("A 方向：场景预勾与勾选计数", () => {
  it("countEnabled 只统计启用字段", () => {
    expect(
      countEnabled([
        { id: "1", key: "a", type: "name", params: {} },
        { id: "2", key: "b", type: "age", params: {}, enabled: false },
      ]),
    ).toBe(1);
  });

  it("preloadScenario 补齐缺失或禁用的 key，保留已启用同 key", () => {
    const start: MockField[] = [
      { id: "1", key: "name", type: "name", params: {}, enabled: true },
    ];
    const { fields, added } = preloadScenario(start, user);
    expect(added).toBe(5); // user 场景 6 字段，name 已启用 → 补 5
    expect(fields.filter((f) => f.enabled !== false)).toHaveLength(6);
    expect(countEnabled(fields)).toBe(6);
  });

  it("resolveFallbackScenarioId 失效 id 回退到 user", () => {
    expect(resolveFallbackScenarioId(undefined, TEMPLATES)).toBe("user");
    expect(resolveFallbackScenarioId("gone", TEMPLATES)).toBe("user");
    expect(resolveFallbackScenarioId("bidder", TEMPLATES)).toBe("bidder");
  });
});
