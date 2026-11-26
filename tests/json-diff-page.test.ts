// @vitest-environment jsdom

import { EditorView } from "@codemirror/view";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApp, nextTick, type App as VueApp } from "vue";
import App from "../entrypoints/json-diff/App.vue";
import { setupCodemirrorJsdom } from "./helpers/codemirror-jsdom";

let app: VueApp;
let root: HTMLDivElement;
let views: EditorView[];
const flush = async () => {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
};
function click(label: string) {
  const button = Array.from(root.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );
  expect(button, label).toBeTruthy();
  button!.click();
}
function setSide(index: number, text: string) {
  views[index].dispatch({
    changes: { from: 0, to: views[index].state.doc.length, insert: text },
  });
}
beforeAll(setupCodemirrorJsdom);
beforeEach(async () => {
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async () => ({ "devtools-json-diff": { autoCompare: false } }),
      },
    },
  });
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(App);
  app.mount(root);
  await flush();
  views = Array.from(root.querySelectorAll<HTMLElement>(".cm-editor")).map(
    (el) => EditorView.findFromDOM(el)!,
  );
});
afterEach(async () => {
  app.unmount();
  await flush();
  root.remove();
  vi.unstubAllGlobals();
});
describe("内容对比页面", () => {
  it("keeps input unchanged during comparison and formats large integers losslessly on demand", async () => {
    const text = '{"id":9007199254740993}';
    setSide(0, text);
    setSide(1, '{"id":9007199254740992}');
    click("对比");
    await flush();
    expect(views[0].state.doc.toString()).toBe(text);
    expect(root.querySelector('[role="status"]')?.textContent).toContain(
      "1 处字段差异",
    );
    click("格式化");
    await flush();
    expect(views[0].state.doc.toString()).toBe(
      '{\n  "id": 9007199254740993\n}',
    );
  });
  it("compares arbitrary text with an empty side and retains text when switching modes", async () => {
    setSide(1, "# 标题\nhello world\n");
    click("文本");
    await flush();
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(root.querySelector('[role="status"]')?.textContent).toContain(
      "差异块",
    );
    expect(root.querySelectorAll(".diff-mark-right").length).toBeGreaterThan(0);
    click("JSON");
    await flush();
    expect(root.querySelector('[role="alert"]')).toBeTruthy();
    expect(views[1].state.doc.toString()).toBe("# 标题\nhello world\n");
  });
  it("shows removed array items and their navigation count", async () => {
    setSide(0, "[1,2,3]");
    setSide(1, "[1,2]");
    click("对比");
    await flush();
    expect(root.querySelector(".diff-counter")?.textContent).toBe("0/1");
    expect(root.querySelector(".diff-mark-left")?.textContent).toBe("3");
  });
  it("does not evaluate expressions as JSON", async () => {
    setSide(0, "(globalThis.__diffProbe = 1, {})");
    setSide(1, "{}");
    click("格式化");
    await flush();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      "格式化失败",
    );
    expect((globalThis as Record<string, unknown>).__diffProbe).toBeUndefined();
  });
});
