// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createApp, h, nextTick, ref, type App as VueApp } from "vue";
import DomainsPanel from "../entrypoints/tools/account-switch/config/DomainsPanel.vue";

let app: VueApp<Element> | null = null;

async function mountCreateDrawer(): Promise<HTMLDivElement> {
  const panel = ref<{ openCreate: () => void } | null>(null);
  const root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp({
    render: () =>
      h(DomainsPanel, {
        ref: panel,
        domains: {},
        strategies: {},
        accounts: [],
      }),
  });
  app.mount(root);
  panel.value?.openCreate();
  await nextTick();
  return root;
}

function styleOf(root: HTMLElement, selector: string): CSSStyleDeclaration {
  const element = root.querySelector<HTMLElement>(selector);
  expect(element, `元素 ${selector} 应存在`).toBeTruthy();
  return window.getComputedStyle(element!);
}

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

describe("DomainsPanel 添加环境布局", () => {
  it("字段使用统一的纵向间距和控件高度", async () => {
    const root = await mountCreateDrawer();
    const rows = root.querySelectorAll(".form-card > .form-row");
    for (const row of Array.from(rows)) {
      expect(window.getComputedStyle(row).marginBottom).toBe("16px");
    }

    const controls = root.querySelectorAll(
      ".form-card input.dt-input, .form-card select.dt-input",
    );
    expect(controls.length).toBeGreaterThan(3);
    for (const control of Array.from(controls)) {
      expect(window.getComputedStyle(control).minHeight).toBe("32px");
    }
  });

  it("局部操作与底部提交均右对齐", async () => {
    const root = await mountCreateDrawer();

    expect(
      styleOf(root, ".locator-head .dt-button").marginLeft,
    ).toBe("auto");
    expect(styleOf(root, ".env-account-actions").justifyContent).toBe(
      "flex-end",
    );
    expect(styleOf(root, ".spec-editor .scan-bar").justifyContent).toBe(
      "flex-end",
    );
    expect(
      styleOf(root, ".dt-drawer-footer .domain-form-actions").justifyContent,
    ).toBe("flex-end");
  });

  it("简易模式的标签、提示和控件沿同一网格对齐", async () => {
    const root = await mountCreateDrawer();

    expect(styleOf(root, ".simple-row").display).toBe("grid");
    expect(styleOf(root, ".simple-row").alignItems).toBe("start");
    expect(styleOf(root, ".simple-label").lineHeight).toBe("32px");
    expect(styleOf(root, ".login-page-warning").marginLeft).toBe("60px");

    const hint = styleOf(root, ".target-hint");
    expect(hint.marginTop).toBe("0px");
    expect(hint.marginBottom).toBe("0px");
  });

  it("开关和状态文字保持在同一行", async () => {
    const root = await mountCreateDrawer();
    const toggle = styleOf(root, ".strategy-bool-toggle");

    expect(toggle.display).toBe("flex");
    expect(toggle.alignItems).toBe("center");
    expect(styleOf(root, ".strategy-bool-toggle .toggle-switch").marginBottom).toBe(
      "0px",
    );
  });
});
