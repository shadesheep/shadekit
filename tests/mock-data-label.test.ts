import { describe, expect, it } from "vitest";
import { sanitizeFields } from "../entrypoints/tools/mock-data/lib/generators";
import {
  fieldsToTemplate,
  parseTemplateFile,
  serializeTemplateFile,
  templateToFields,
} from "../entrypoints/tools/mock-data/lib/template-files";
import { TEMPLATES } from "../entrypoints/tools/mock-data/lib/templates";

describe("label 透传", () => {
  it("sanitizeFields 保留 trim 后的 label，空白 label 丢弃", () => {
    const [withLabel, blank] = sanitizeFields([
      { key: "contactName", type: "name", label: "  联系人  ", params: {} },
      { key: "name", type: "name", label: "   ", params: {} },
    ]);
    expect(withLabel.label).toBe("联系人");
    expect(blank.label).toBeUndefined();
  });

  it("模板文件往返保留 label", () => {
    const fields = sanitizeFields([
      { key: "contactName", type: "name", label: "联系人", params: {} },
    ]);
    const template = fieldsToTemplate(fields, "投标人");
    expect(template.rows[0].label).toBe("联系人");

    const restored = parseTemplateFile(serializeTemplateFile(template));
    expect(templateToFields(restored)[0].label).toBe("联系人");
  });

  it("旧模板文件没有 label 仍可解析", () => {
    const text = JSON.stringify({
      schemaVersion: 2,
      kind: "shadekit-mock-template",
      template: {
        id: "legacy",
        name: "旧模板",
        hint: "",
        rows: [{ key: "name", type: "name", params: {} }],
      },
    });
    expect(templateToFields(parseTemplateFile(text))[0]).toMatchObject({
      key: "name",
      type: "name",
    });
  });

  it("label 不是字符串时拒绝模板文件", () => {
    const text = JSON.stringify({
      schemaVersion: 2,
      kind: "shadekit-mock-template",
      template: {
        id: "bad",
        name: "坏模板",
        hint: "",
        rows: [{ key: "name", type: "name", label: 123 }],
      },
    });
    expect(() => parseTemplateFile(text)).toThrow(/label 必须是字符串/);
  });

  it("内置模板包含业务显示名", () => {
    const bidder = TEMPLATES.find((template) => template.id === "bidder")!;
    expect(bidder.rows.find((row) => row.key === "contactName")!.label).toBe(
      "联系人",
    );
    const project = TEMPLATES.find((template) => template.id === "project")!;
    expect(project.rows.find((row) => row.key === "budgetCn")!.label).toBe(
      "预算金额（大写）",
    );
  });
});
