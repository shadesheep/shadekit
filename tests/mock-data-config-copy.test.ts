// @vitest-environment jsdom
import { createApp, nextTick, type App as VueApp } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Config from "../entrypoints/tools/mock-data/Config.vue";
import { useToast, dismissToast } from "../entrypoints/shared/use-toast";

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

async function mountConfig() {
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(Config);
  app.mount(root);
  await flush();
}

describe("mock-data 选项页清空字段文案", () => {
  it("展示恢复默认用户场景的说明", async () => {
    await mountConfig();
    expect(root.textContent).toContain("用户信息");
  });

  it("清空字段只删 fields，保留其他设置并提示恢复默认用户场景", async () => {
    store["devtools-mock-data"] = {
      fields: [{ id: "f1", key: "name", type: "name", params: {} }],
      customTemplates: [{ id: "c1", name: "场景", hint: "", rows: [] }],
      activeScenarioId: "c1",
      count: 42,
    };
    await mountConfig();

    const btn = Array.from(root.querySelectorAll("button")).find(
      (item) => item.textContent?.trim() === "清空已保存的字段列表",
    );
    expect(btn).toBeTruthy();
    btn!.click();
    await flush();

    const saved = store["devtools-mock-data"] as Record<string, unknown>;
    expect(saved).toBeTruthy();
    expect(saved.fields).toBeUndefined();
    expect(saved.customTemplates).toBeTruthy();
    expect(saved.activeScenarioId).toBe("c1");
    expect(saved.count).toBe(42);
    expect(
      toast.toasts.value[toast.toasts.value.length - 1]?.message,
    ).toContain("用户信息");
  });
});