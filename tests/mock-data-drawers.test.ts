// @vitest-environment jsdom
import { createApp, h, nextTick, type App as VueApp } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import JsonImportDrawer from "../entrypoints/mock-data/components/JsonImportDrawer.vue";
import ScenarioManagerDrawer from "../entrypoints/mock-data/components/ScenarioManagerDrawer.vue";
import { serializeTemplateFile } from "../entrypoints/tools/mock-data/lib/template-files";
import {
  TEMPLATES,
  type MockTemplate,
} from "../entrypoints/tools/mock-data/lib/templates";
import { sanitizeFields } from "../entrypoints/tools/mock-data/lib/generators";
import type { MockField } from "../entrypoints/tools/mock-data/lib/types";

let app: VueApp<Element> | null = null;
let root: HTMLDivElement;
let events: Array<[string, unknown]> = [];

const customTemplate: MockTemplate = {
  id: "custom_1",
  name: "自定义场景",
  hint: "自定义",
  rows: [{ key: "foo", type: "fixed", params: { value: "1" } }],
};

interface ScenarioOptions {
  templates?: MockTemplate[];
  customTemplates?: MockTemplate[];
  fields?: MockField[];
  hasFieldErrors?: boolean;
  show?: boolean;
}

async function flush() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

async function mountScenarioDrawer(options: ScenarioOptions = {}) {
  events = [];
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp({
    render: () =>
      h(ScenarioManagerDrawer, {
        show: options.show ?? true,
        templates: options.templates ?? TEMPLATES,
        customTemplates: options.customTemplates ?? [],
        fields: options.fields ?? [],
        hasFieldErrors: options.hasFieldErrors ?? false,
        onClose: () => events.push(["close", null]),
        onSave: (template: MockTemplate) => events.push(["save", template]),
        onImport: (template: MockTemplate) =>
          events.push(["import", template]),
        onDelete: (id: string) => events.push(["delete", id]),
      }),
  });
  app.mount(root);
  await flush();
}

function unmountDrawer() {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
}

function buttonByText(text: string, scope: ParentNode = root) {
  const btn = Array.from(scope.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === text,
  );
  expect(btn, `按钮「${text}」应存在`).toBeTruthy();
  return btn as HTMLButtonElement;
}

function typeInto(selector: string, value: string) {
  const input = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    selector,
  );
  expect(input, `输入框 ${selector} 应存在`).toBeTruthy();
  input!.value = value;
  input!.dispatchEvent(new Event("input", { bubbles: true }));
}

async function mountJsonDrawer(options: { show?: boolean } = {}) {
  events = [];
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp({
    render: () =>
      h(JsonImportDrawer, {
        show: options.show ?? true,
        onClose: () => events.push(["close", null]),
        onImport: (fields: MockField[]) => events.push(["import", fields]),
      }),
  });
  app.mount(root);
  await flush();
}

afterEach(() => {
  unmountDrawer();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ScenarioManagerDrawer", () => {
  it("展示内置场景与自定义场景操作", async () => {
    await mountScenarioDrawer({ customTemplates: [customTemplate] });

    const items = Array.from(root.querySelectorAll(".scenario-item"));
    const builtin = items.find((item) =>
      item.textContent?.includes("用户信息"),
    );
    expect(builtin).toBeTruthy();

    const custom = items.find((item) =>
      item.textContent?.includes("自定义场景"),
    );
    expect(custom).toBeTruthy();
    expect(
      Array.from(custom!.querySelectorAll("button")).map((btn) =>
        btn.textContent?.trim(),
      ),
    ).toEqual(["导出", "删除"]);
  });

  it("另存当前字段为场景并保留 label", async () => {
    await mountScenarioDrawer({
      fields: sanitizeFields([
        { key: "contactName", type: "name", label: "联系人", params: {} },
      ]),
    });

    typeInto(".scenario-name", "我的场景");
    await flush();
    buttonByText("保存为场景").click();
    await flush();

    const saved = events.find(([name]) => name === "save")?.[1] as MockTemplate;
    expect(saved.name).toBe("我的场景");
    expect(saved.rows[0].label).toBe("联系人");

    unmountDrawer();
    await mountScenarioDrawer({ fields: [] });
    expect(buttonByText("保存为场景").disabled).toBe(true);

    unmountDrawer();
    await mountScenarioDrawer({
      fields: sanitizeFields([{ key: "name", type: "name", params: {} }]),
      hasFieldErrors: true,
    });
    expect(buttonByText("保存为场景").disabled).toBe(true);
  });

  it("删除自定义场景发 id", async () => {
    await mountScenarioDrawer({ customTemplates: [customTemplate] });

    const custom = Array.from(root.querySelectorAll(".scenario-item")).find(
      (item) => item.textContent?.includes("自定义场景"),
    )!;
    buttonByText("删除", custom).click();
    await flush();

    expect(events).toEqual([["delete", "custom_1"]]);
  });

  it("导入场景文件发解析结果", async () => {
    await mountScenarioDrawer();

    const text = serializeTemplateFile({
      id: "file",
      name: "导入场景",
      hint: "",
      rows: [{ key: "foo", type: "fixed", params: { value: "1" } }],
    });
    const file = new File([text], "scene.json", { type: "application/json" });
    const input = root.querySelector<HTMLInputElement>(".file-input")!;
    Object.defineProperty(input, "files", {
      value: [file],
      configurable: true,
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      expect(events.some(([name]) => name === "import")).toBe(true);
    });
    const imported = events.find(([name]) => name === "import")?.[1] as
      | MockTemplate
      | undefined;
    expect(imported?.name).toBe("导入场景");
  });

  it("导出触发下载", async () => {
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:mock",
      revokeObjectURL: () => {},
    });
    let downloaded = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      function (this: HTMLAnchorElement) {
        downloaded = this.download;
      },
    );

    await mountScenarioDrawer({ customTemplates: [customTemplate] });

    const custom = Array.from(root.querySelectorAll(".scenario-item")).find(
      (item) => item.textContent?.includes("自定义场景"),
    )!;
    buttonByText("导出", custom).click();
    await flush();

    expect(downloaded).toContain("自定义场景");
    expect(downloaded.endsWith(".json")).toBe(true);
  });
});

describe("JsonImportDrawer", () => {
  it("有效 JSON 示例导入字段", async () => {
    await mountJsonDrawer();

    typeInto(".import-text", '{"foo":"bar"}');
    await flush();
    buttonByText("导入并替换字段").click();
    await flush();

    const imported = events.find(([name]) => name === "import")?.[1] as
      | MockField[]
      | undefined;
    expect(imported?.map((field) => field.key)).toEqual(["foo"]);
  });

  it("无效 JSON 保留抽屉并显示错误", async () => {
    await mountJsonDrawer();

    typeInto(".import-text", "{");
    await flush();
    buttonByText("导入并替换字段").click();
    await flush();

    expect(events.some(([name]) => name === "import")).toBe(false);
    expect(root.querySelector(".import-error")?.textContent).toContain(
      "导入失败",
    );
  });

  it("选择文件只填充文本域", async () => {
    await mountJsonDrawer();

    const file = new File(['{"age":18}'], "sample.json", {
      type: "application/json",
    });
    const input = root.querySelector<HTMLInputElement>(".file-input")!;
    Object.defineProperty(input, "files", {
      value: [file],
      configurable: true,
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      expect(
        root.querySelector<HTMLTextAreaElement>(".import-text")?.value,
      ).toContain("age");
    });
    expect(events.some(([name]) => name === "import")).toBe(false);
  });
});
