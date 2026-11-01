// @vitest-environment jsdom
import { createApp, nextTick, type App as VueApp } from "vue";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import App from "../entrypoints/mock-data/App.vue";
import { serializeTemplateFile } from "../entrypoints/tools/mock-data/lib/template-files";
import { dismissToast, useToast } from "../entrypoints/shared/use-toast";
import { setupCodemirrorJsdom } from "./helpers/codemirror-jsdom";

let store: Record<string, unknown>;

function stubChromeStorage() {
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async (keys: string[] | null) => {
          if (keys === null) return { ...store };
          const out: Record<string, unknown> = {};
          for (const key of keys) if (key in store) out[key] = store[key];
          return out;
        }),
        set: vi.fn(async (items: Record<string, unknown>) =>
          Object.assign(store, items),
        ),
        remove: vi.fn(async (keys: string[]) => {
          for (const key of keys) delete store[key];
        }),
      },
    },
  });
}

let app: VueApp<Element> | null = null;
let root: HTMLDivElement;
const toast = useToast();

beforeAll(() => {
  setupCodemirrorJsdom();
});

beforeEach(() => {
  store = {};
  stubChromeStorage();
});

afterEach(async () => {
  app?.unmount();
  app = null;
  await new Promise((resolve) => setTimeout(resolve, 0));
  document.body.innerHTML = "";
  for (const item of [...toast.toasts.value]) dismissToast(item.id);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function flush() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

async function mountApp() {
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(App);
  app.mount(root);
  await flush();
  await flush();
}

async function unmountApp() {
  app?.unmount();
  app = null;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  document.body.innerHTML = "";
}

function findButton(text: string, scope: ParentNode = root) {
  const btn = Array.from(scope.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === text,
  );
  expect(btn, `按钮「${text}」应存在`).toBeTruthy();
  return btn as HTMLButtonElement;
}

async function clickButton(text: string, scope: ParentNode = root) {
  findButton(text, scope).click();
  await flush();
}

async function clickTab(name: string) {
  const tab = Array.from(
    root.querySelectorAll<HTMLButtonElement>(".scenario-tab"),
  ).find((item) => item.textContent?.trim() === name);
  expect(tab, `场景标签「${name}」应存在`).toBeTruthy();
  tab!.click();
  await flush();
}

function selectedChips(): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(".selected-chip"));
}

function selectedTitles(): string[] {
  return selectedChips().map((chip) => chip.getAttribute("title") ?? "");
}

function activeTabText(): string {
  return (
    root.querySelector(".scenario-tab.active")?.textContent?.trim() ?? ""
  );
}

/** 交互 ConfirmDialog：confirm=true 用「继续」，false 用「取消」。 */
async function settleConfirm(confirm: boolean) {
  const dialog = root.querySelector<HTMLElement>(".confirm-dialog");
  expect(dialog, "切换场景确认弹窗应出现").toBeTruthy();
  const buttons = Array.from(
    dialog!.querySelectorAll<HTMLButtonElement>(".dt-button"),
  );
  // 布局：先「取消」，后「继续」。
  const target = confirm ? buttons[buttons.length - 1] : buttons[0];
  target!.click();
  await flush();
}

function typeInto(selector: string, value: string) {
  const input = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    selector,
  );
  expect(input, `输入框 ${selector} 应存在`).toBeTruthy();
  input!.value = value;
  input!.dispatchEvent(new Event("input", { bubbles: true }));
}

function toastMessages(): string[] {
  return Array.from(root.querySelectorAll(".toast-message")).map(
    (item) => item.textContent?.trim() ?? "",
  );
}

describe("mock-data 页面编排", () => {
  it("首次打开默认用户信息场景、整组 6 字段勾选并生成预览", async () => {
    await mountApp();

    expect(selectedChips().map((chip) => chip.textContent?.trim())).toEqual([
      "姓名",
      "性别",
      "年龄",
      "手机号",
      "邮箱",
      "地址",
    ]);
    expect(activeTabText()).toBe("用户信息");
    expect(
      root.querySelector(".result-panel .count-badge")?.textContent ?? "",
    ).toMatch(/10 \/ 10 条/);
    expect(root.querySelector(".simple-template-card")).toBeNull();
  });

  it("保存的空字段列表不会被默认字段覆盖", async () => {
    store["devtools-mock-data"] = { fields: [] };
    await mountApp();

    expect(selectedChips()).toHaveLength(0);
    expect(root.querySelector(".shelf-empty")?.textContent).toContain(
      "还没有字段",
    );
    expect(root.querySelector(".dt-empty-state")).toBeTruthy();
    expect(root.querySelector(".shelf-hint")).toBeNull();
  });

  it("恢复字段并在 chip 与表头显示 label", async () => {
    store["devtools-mock-data"] = {
      fields: [
        {
          id: "f1",
          key: "contactName",
          type: "name",
          label: "联系人",
          params: {},
        },
      ],
      count: 3,
    };
    await mountApp();

    expect(selectedChips()[0].textContent).toContain("联系人");
    expect(selectedChips()[0].getAttribute("title")).toBe("contactName");
    expect(root.querySelector(".rf-label")?.textContent).toContain("联系人");

    await clickButton("表格");
    expect(root.querySelector(".th-label")?.textContent).toBe("联系人");
    expect(root.querySelector(".th-key")?.textContent).toBe("contactName");
  });

  it("点场景标签替换为整组勾选字段；全选/全不选批量开关", async () => {
    await mountApp();

    await clickTab("招标项目");
    const projectTitles = selectedTitles().sort();
    expect(projectTitles).toEqual(
      ["projectCode", "projectName", "tenderMethod", "evalMethod", "budget", "budgetCn", "openBidTime", "region"].sort(),
    );

    // 全不选：所有勾选置为未勾选
    await clickButton("全不选");
    expect(selectedChips()).toHaveLength(8);
    expect(
      Array.from(root.querySelectorAll<HTMLInputElement>(".field-checkbox")),
    ).toHaveLength(8);
    expect(
      Array.from(
        root.querySelectorAll<HTMLInputElement>(".field-checkbox"),
      ).every((cb) => !cb.checked),
    ).toBe(true);

    // 全选恢复
    await clickButton("全选");
    expect(
      Array.from(
        root.querySelectorAll<HTMLInputElement>(".field-checkbox"),
      ).every((cb) => cb.checked),
    ).toBe(true);
  });

  it("搜索覆盖场景……搜索字段类型不显示场景筛选", async () => {
    await mountApp();
    // 旧货架搜索已移除；「添加其他字段」面板支持类型搜索。
    await clickButton("添加其他字段");
    typeInto(".add-search input", "身份证");
    await flush();

    const groupTitles = Array.from(
      root.querySelectorAll<HTMLElement>(".shelf-group-title"),
    ).map((item) => item.textContent?.trim());
    expect(groupTitles.some((t) => t === "人员")).toBe(true);
  });

  it("更多设置只显示数据用途与当前格式导出项（语言已移至顶栏）", async () => {
    await mountApp();

    expect(root.querySelector<HTMLElement>(".settings-panel")?.style.display).toBe(
      "none",
    );
    await clickButton("更多设置（可选）");
    const panelText = root.querySelector(".settings-panel")?.textContent ?? "";
    expect(panelText).not.toContain("语言");
    expect(panelText).toContain("数据用途");
    expect(panelText).toContain("日常联调");
    expect(panelText).not.toContain("随机种子");
    expect(panelText).not.toContain("下载批大小");
    expect(panelText).not.toContain("模板管理");

    await clickButton("CSV");
    expect(root.querySelector(".settings-panel")?.textContent).toContain(
      "Excel 兼容",
    );
    expect(root.querySelector(".settings-panel")?.textContent).toContain(
      "分隔符",
    );

    await clickButton("SQL");
    expect(root.querySelector(".settings-panel")?.textContent).toContain(
      "表名",
    );
    expect(root.querySelector(".settings-panel")?.textContent).toContain(
      "数据库",
    );

    await clickButton("XML");
    expect(root.querySelector(".settings-panel")?.textContent).toContain(
      "根节点",
    );
    expect(root.querySelector(".settings-panel")?.textContent).toContain(
      "记录节点",
    );

    await clickButton("JSON");
    expect(root.querySelector(".settings-panel")?.textContent).toContain(
      "当前格式无需额外设置",
    );
  });

  it("生成即换一批数据，保留字段与格式但更新数据", async () => {
    await mountApp();

    const before = root.querySelector(".record-fields")?.textContent;
    const chipsBefore = selectedChips().map((chip) => chip.textContent);
    const toolbar = root.querySelector(".toolbar-actions")!;
    const genBtn = Array.from(
      toolbar.querySelectorAll<HTMLButtonElement>("button"),
    ).find((btn) => btn.textContent?.trim().startsWith("生成"))!;
    genBtn.click();
    await flush();

    expect(root.querySelector(".record-fields")?.textContent).not.toBe(before);
    expect(selectedChips().map((chip) => chip.textContent)).toEqual(
      chipsBefore,
    );
    // 换一批按钮已并入「生成」：顶栏不再有独立「换一批」按钮
    expect(
      Array.from(root.querySelectorAll(".toolbar-actions button")).some(
        (btn) => btn.textContent?.trim() === "换一批",
      ),
    ).toBe(false);
  });

  it("页面内清空后重开保持空字段", async () => {
    await mountApp();

    await clickButton("清空", root.querySelector(".toolbar-actions")!);
    await unmountApp();
    await mountApp();

    expect(selectedChips()).toHaveLength(0);
    expect(root.querySelector(".dt-empty-state")).toBeTruthy();
  });

  it("已删除场景的 activeScenarioId 回退到用户信息并加载其字段", async () => {
    store["devtools-mock-data"] = {
      activeScenarioId: "gone",
      fields: [{ id: "f1", key: "name", type: "name", params: {} }],
    };
    await mountApp();

    expect(activeTabText()).toBe("用户信息");
    // 回退时整组加载用户场景字段（不再残留已删除场景的字段）
    expect(selectedTitles()).toEqual(
      ["name", "gender", "age", "phone", "email", "address"],
    );
  });

  it("管理场景保存当前字段后切换场景且字段不变", async () => {
    await mountApp();
    const before = selectedTitles();

    await clickButton("管理场景");
    expect(root.querySelector(".dt-drawer-title")?.textContent).toBe(
      "管理场景",
    );
    typeInto(".scenario-name", "我的场景");
    await flush();
    await clickButton("保存为场景");

    expect(root.querySelector(".scenario-name")).toBeNull();
    expect(activeTabText()).toBe("我的场景");
    expect(toastMessages().some((text) => text.includes("已保存并切换到「我的场景」"))).toBe(
      true,
    );
    expect(selectedTitles()).toEqual(before);
  });

  it("删除正在激活的自定义场景后回退用户信息", async () => {
    store["devtools-mock-data"] = {
      customTemplates: [
        {
          id: "custom_1",
          name: "旧场景",
          hint: "",
          rows: [{ key: "foo", type: "fixed", params: { value: "1" } }],
        },
      ],
      activeScenarioId: "custom_1",
      fields: [],
    };
    await mountApp();

    await clickButton("管理场景");
    await clickButton("删除");
    await settleConfirm(true);

    expect(activeTabText()).toBe("用户信息");
    // 删除激活场景后整组回到用户场景字段（不留已删除场景的字段/空态）
    expect(selectedTitles()).toEqual(
      ["name", "gender", "age", "phone", "email", "address"],
    );
    expect(
      Array.from(root.querySelectorAll(".scenario-tab")).some(
        (tab) => tab.textContent?.trim() === "旧场景",
      ),
    ).toBe(false);
  });

  it("从 JSON 导入替换字段并保持用户场景；失败保留原字段", async () => {
    await mountApp();

    await clickButton("从 JSON 导入");
    typeInto(".import-text", '{"foo":"bar"}');
    await flush();
    await clickButton("导入并替换字段");

    expect(root.querySelector(".import-text")).toBeNull();
    expect(activeTabText()).toBe("用户信息");
    expect(selectedTitles()).toEqual(["foo"]);

    await clickButton("从 JSON 导入");
    typeInto(".import-text", "{");
    await flush();
    await clickButton("导入并替换字段");

    expect(root.querySelector(".import-error")).toBeTruthy();
    expect(selectedTitles()).toEqual(["foo"]);
  });

  it("JSON 导入的字段全部默认勾选", async () => {
    await mountApp();
    await clickButton("从 JSON 导入");
    typeInto(".import-text", '{"a":1,"b":2,"c":3}');
    await flush();
    await clickButton("导入并替换字段");
    expect(
      Array.from(
        root.querySelectorAll<HTMLInputElement>(".field-checkbox"),
      ).every((cb) => cb.checked),
    ).toBe(true);
  });

  it("切到含未知类型的自定义场景时只载入可用字段", async () => {
    store["devtools-mock-data"] = {
      customTemplates: [
        {
          id: "custom_2",
          name: "混合场景",
          hint: "",
          rows: [
            { key: "ok", type: "fixed", params: { value: "x" } },
            { key: "ghost", type: "missing" },
          ],
        },
      ],
      activeScenarioId: "user",
      fields: [],
    };
    await mountApp();

    expect(activeTabText()).toBe("用户信息");
    await clickTab("混合场景");
    // templateToFields 经 sanitizeFields 过滤未知类型，只剩可用字段
    expect(selectedTitles()).toEqual(expect.arrayContaining(["ok"]));
  });

  it("旧配置的 editorMode 被忽略且不再新写入", async () => {
    store["devtools-mock-data"] = {
      editorMode: "advanced",
      fields: [{ id: "f1", key: "name", type: "name", params: {} }],
    };
    await mountApp();
    expect(root.querySelector(".field-shelf")).toBeTruthy();
    expect(root.querySelector(".advanced-builder")).toBeNull();

    await unmountApp();
    store = {};
    stubChromeStorage();
    store["devtools-mock-data"] = {
      fields: [{ id: "f1", key: "name", type: "name", params: {} }],
    };
    await mountApp();
    await unmountApp();

    const saved = store["devtools-mock-data"] as Record<string, unknown>;
    expect(saved).toBeTruthy();
    expect(saved.editorMode).toBeUndefined();
  });

  it("重新打开后恢复字段、场景与设置", async () => {
    await mountApp();

    // 添加一个额外字段
    await clickButton("添加其他字段");
    await clickButton("邮箱", root);
    await flush();
    // 关闭添加面板再去切场景
    await clickButton("添加其他字段");
    await clickTab("投标人信息");
    await clickButton("CSV");
    await unmountApp();
    await mountApp();

    expect(
      selectedChips().some((chip) => chip.textContent?.includes("邮箱")),
    ).toBe(true);
    expect(activeTabText()).toBe("投标人信息");
    const csvButton = Array.from(
      root.querySelectorAll<HTMLButtonElement>(".dt-segmented-btn"),
    ).find((btn) => btn.textContent?.trim() === "CSV");
    expect(csvButton?.classList.contains("active")).toBe(true);
  });

  it("管理场景导入文件后切换并提示可用字段数", async () => {
    await mountApp();
    const before = selectedTitles();

    await clickButton("管理场景");
    const text = serializeTemplateFile({
      id: "file",
      name: "导入场景",
      hint: "",
      rows: [
        { key: "ok", type: "fixed", params: { value: "x" } },
        { key: "ghost", type: "missing" },
      ],
    });
    const file = new File([text], "scene.json", { type: "application/json" });
    const input = root.querySelector<HTMLInputElement>(".scenario-file")!;
    Object.defineProperty(input, "files", {
      value: [file],
      configurable: true,
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      expect(root.querySelector(".scenario-name")).toBeNull();
    });
    await flush();

    expect(activeTabText()).toBe("导入场景");
    expect(toastMessages().some((text) => text.includes("1 个可用字段"))).toBe(
      true,
    );
    // 导入即替换字段：只剩可用字段 ok
    expect(selectedTitles()).toEqual(["ok"]);
    void before;
  });
});

describe("A 方向：场景预勾与勾选清单", () => {
  it("首次打开默认用户信息场景、整组 6 字段勾选", async () => {
    await mountApp();
    expect(selectedChips()).toHaveLength(6);
    expect(activeTabText()).toBe("用户信息");
  });

  it("勾选清单渲染每行勾选框，可开关字段且 enabled=false 不参与生成", async () => {
    store["devtools-mock-data"] = {
      fields: [
        { id: "f1", key: "name", type: "name", params: {} },
        { id: "f2", key: "age", type: "age", params: {} },
      ],
      count: 3,
    };
    await mountApp();

    const checkboxes = Array.from(
      root.querySelectorAll<HTMLInputElement>(".field-checkbox"),
    );
    expect(checkboxes).toHaveLength(2);

    expect(root.querySelector(".selected-count")?.textContent).toContain(
      "2",
    );

    // 关掉第二个勾选框（age）—— 渲染与勾选计数应实时更新；
    // enabled=false 不参与生成的过滤由 doGenerate 用 enabledFields 处理。
    checkboxes[1]!.click();
    await flush();

    expect(root.querySelector(".selected-count")?.textContent).toContain(
      "1",
    );
    // 生成结果不再包含被勾掉的字段（age 中文名带「龄」）
    expect(
      root.querySelector(".result-panel .record-fields")?.textContent,
    ).not.toContain("龄");
    // 配置保留：行仍在清单里
    expect(
      root.querySelectorAll<HTMLInputElement>(".field-checkbox"),
    ).toHaveLength(2);
  });

  it("点场景标签直接替换字段，无需确认弹窗", async () => {
    await mountApp();
    const before = selectedTitles();

    await clickTab("投标人信息");
    const titles = selectedTitles();
    expect(titles).toEqual(
      expect.arrayContaining(["companyName", "contactName", "uscc", "bankCard"]),
    );
    expect(titles).not.toEqual(before); // 整组替换
    expect(root.querySelector(".confirm-dialog")).toBeNull(); // 无确认弹窗
    expect(root.querySelector(".result-panel .count-badge")?.textContent).toMatch(
      /条/,
    );
  });
});
