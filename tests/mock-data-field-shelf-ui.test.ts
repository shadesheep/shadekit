// @vitest-environment jsdom
import { createApp, h, nextTick, reactive, type App as VueApp } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import FieldShelf from "../entrypoints/mock-data/components/FieldShelf.vue";
import { sanitizeFields } from "../entrypoints/tools/mock-data/lib/generators";
import {
  TEMPLATES,
  type MockTemplate,
} from "../entrypoints/tools/mock-data/lib/templates";
import { dismissToast, useToast } from "../entrypoints/shared/use-toast";
import type { MockField } from "../entrypoints/tools/mock-data/lib/types";

let app: VueApp<Element> | null = null;
let root: HTMLDivElement;
let events: string[] = [];
const toast = useToast();

interface MountOptions {
  fields?: MockField[];
  activeScenarioId?: string;
  search?: string;
  customTemplates?: MockTemplate[];
  errors?: Record<string, string>;
}

async function flush() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

async function mountShelf(options: MountOptions = {}) {
  events = [];
  const state = reactive({
    fields: options.fields ?? [],
    activeScenarioId: options.activeScenarioId ?? "user",
    search: options.search ?? "",
  });
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp({
    render: () =>
      h(FieldShelf, {
        fields: state.fields,
        templates: TEMPLATES,
        customTemplates: options.customTemplates ?? [],
        activeScenarioId: state.activeScenarioId,
        search: state.search,
        errors: options.errors,
        "onUpdate:fields": (next: MockField[]) => {
          state.fields = next;
        },
        "onUpdate:activeScenarioId": (id: string) => {
          state.activeScenarioId = id;
        },
        "onUpdate:search": (value: string) => {
          state.search = value;
        },
        "onRequestScenarioLoad": (id: string) => {
          events.push(`load:${id}`);
        },
        onManage: () => events.push("manage"),
        onImportJson: () => events.push("json"),
      }),
  });
  app.mount(root);
  await flush();
  return state;
}

function unmountShelf() {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
}

function buttonByText(text: string): HTMLButtonElement {
  const btn = Array.from(root.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === text,
  );
  expect(btn, `按钮「${text}」应存在`).toBeTruthy();
  return btn as HTMLButtonElement;
}

function checkboxes(): HTMLInputElement[] {
  return Array.from(root.querySelectorAll<HTMLInputElement>(".field-checkbox"));
}

function scenarioTabByText(text: string): HTMLButtonElement {
  const tab = Array.from(
    root.querySelectorAll<HTMLButtonElement>(".scenario-tab"),
  ).find((item) => item.textContent?.trim() === text);
  expect(tab, `场景标签「${text}」应存在`).toBeTruthy();
  return tab!;
}

afterEach(() => {
  unmountShelf();
  for (const item of [...toast.toasts.value]) dismissToast(item.id);
});

describe("FieldShelf（A 方向：场景预勾 + 勾选清单）", () => {
  it("勾选清单每行渲染勾选框，取消勾选保留配置且 enabled=false", async () => {
    const state = await mountShelf({
      fields: sanitizeFields([
        { key: "name", type: "name", params: {} },
        { key: "age", type: "age", params: {} },
      ]),
    });

    const boxes = checkboxes();
    expect(boxes).toHaveLength(2);
    expect(boxes[0]!.checked).toBe(true);

    boxes[1]!.click();
    await flush();

    expect(checkboxes()[1]!.checked).toBe(false);
    // 配置保留：仍两行
    expect(checkboxes()).toHaveLength(2);
    // enabled=false 的字段不参与计数
    expect(root.querySelector(".selected-count")?.textContent).toContain("1");
    expect(state.fields).toHaveLength(2);
    expect(state.fields[1]!.enabled).toBe(false);
  });

  it("全选/全不选批量开关所有字段", async () => {
    await mountShelf({
      fields: sanitizeFields([
        { key: "name", type: "name", params: {} },
        { key: "age", type: "age", params: {} },
        { key: "phone", type: "phone", params: {} },
      ]),
    });

    buttonByText("全不选").click();
    await flush();
    expect(checkboxes().every((cb) => !cb.checked)).toBe(true);

    buttonByText("全选").click();
    await flush();
    expect(checkboxes().every((cb) => cb.checked)).toBe(true);
  });

  it("已选 chip 显示业务名并以 key 作 title，可单个删除", async () => {
    const state = await mountShelf({
      fields: sanitizeFields([
        { key: "contactName", type: "name", label: "联系人", params: {} },
      ]),
    });

    const chip = root.querySelector<HTMLElement>(".selected-chip");
    expect(chip).toBeTruthy();
    expect(chip!.textContent).toContain("联系人");
    expect(chip!.getAttribute("title")).toBe("contactName");

    chip!.querySelector<HTMLButtonElement>(".chip-remove")!.click();
    await flush();
    expect(state.fields).toEqual([]);
  });

  it("点场景标签发 request-scenario-load 并清空搜索", async () => {
    const state = await mountShelf({ search: "身份证" });

    scenarioTabByText("投标人信息").click();
    await flush();

    expect(events).toContain("load:bidder");
    expect(state.search).toBe("");
  });

  it("「添加其他字段」按分类展示字段类型，点击追加且默认勾选", async () => {
    const state = await mountShelf();

    buttonByText("添加其他字段").click();
    await flush();
    // 点一个通用字段类型（如邮箱，人员/基础分类）
    const addChip = Array.from(
      root.querySelectorAll<HTMLButtonElement>(".add-chip"),
    ).find((item) => item.textContent?.includes("邮箱"));
    expect(addChip, "「邮箱」类型应可添加").toBeTruthy();
    addChip!.click();
    await flush();

    expect(state.fields.some((field) => field.key === "email")).toBe(true);
    expect(state.fields.find((field) => field.key === "email")?.enabled).toBe(
      true,
    );
    expect(checkboxes().every((cb) => cb.checked)).toBe(true);
  });

  it("「添加其他字段」搜索过滤类型", async () => {
    await mountShelf();

    buttonByText("添加其他字段").click();
    await flush();

    const input = root.querySelector<HTMLInputElement>(".add-search input");
    expect(input).toBeTruthy();
    input!.value = "身份证";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();

    const chips = Array.from(root.querySelectorAll<HTMLElement>(".add-chip"));
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.every((chip) => chip.textContent?.includes("身份证"))).toBe(
      true,
    );
  });

  it("管理场景入口发事件；场景标签触发 load", async () => {
    await mountShelf();

    buttonByText("管理场景").click();
    await flush();
    scenarioTabByText("用户信息").click();

    expect(events).toEqual(["manage", "load:user"]);
  });

  it("字段行默认折叠，点击行头展开后行内编辑（改 key）保留", async () => {
    const state = await mountShelf({
      fields: sanitizeFields([{ key: "name", type: "name", params: {} }]),
    });

    expect(root.querySelector(".checklist")).toBeTruthy();
    // 默认折叠：行内编辑不可见
    expect(root.querySelector(".key-input")).toBeNull();
    // 点击行头展开
    root.querySelector<HTMLElement>(".check-head")!.click();
    await flush();
    const keyInput = root.querySelector<HTMLInputElement>(".key-input");
    expect(keyInput).toBeTruthy();
    keyInput!.value = "fullName";
    keyInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();

    expect(state.fields[0]!.key).toBe("fullName");
  });

  it("勾选清单行内的删除与上移按钮可用", async () => {
    const state = await mountShelf({
      fields: sanitizeFields([
        { key: "name", type: "name", params: {} },
        { key: "age", type: "age", params: {} },
      ]),
    });

    expect(state.fields).toHaveLength(2);

    // 展开 age 所在行（data-row-id 定位）
    const ageItem = Array.from(
      root.querySelectorAll<HTMLElement>(".check-item"),
    ).find(
      (item) => item.querySelector(".check-key")?.textContent === "age",
    )!;
    ageItem.querySelector<HTMLElement>(".check-head")!.click();
    await flush();

    const rows = Array.from(root.querySelectorAll<HTMLElement>(".field-row"));
    // 按 age 字段找第二行（name,age）
    const ageRow = rows.find(
      (row) =>
        row.querySelector<HTMLSelectElement>(".row-type")?.value === "age",
    )!;
    const delBtn = ageRow.querySelector<HTMLButtonElement>(
      'button[aria-label="删除字段"]',
    );
    expect(delBtn).toBeTruthy();
    delBtn!.click();
    await flush();
    expect(state.fields.map((f) => f.key)).toEqual(["name"]);
  });

  it("勾选清单行内上移调换字段顺序", async () => {
    const state = await mountShelf({
      fields: sanitizeFields([
        { key: "a", type: "name", params: {} },
        { key: "b", type: "phone", params: {} },
      ]),
    });

    // 展开 b（phone）所在行
    const bItem = Array.from(
      root.querySelectorAll<HTMLElement>(".check-item"),
    ).find(
      (item) => item.querySelector(".check-key")?.textContent === "b",
    )!;
    bItem.querySelector<HTMLElement>(".check-head")!.click();
    await flush();

    const rows = Array.from(root.querySelectorAll<HTMLElement>(".field-row"));
    // b 是第二行，点它的上移 → 顺序变为 b,a
    const bRow = rows.find(
      (row) =>
        row.querySelector<HTMLSelectElement>(".row-type")?.value === "phone",
    )!;
    const upBtn = bRow.querySelector<HTMLButtonElement>(
      'button[aria-label="上移字段"]',
    );
    expect(upBtn).toBeTruthy();
    upBtn!.click();
    await flush();

    expect(state.fields.map((f) => f.key)).toEqual(["b", "a"]);
  });
});