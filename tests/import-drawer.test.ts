// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, type App as VueApp } from "vue";
import ImportDrawer from "../entrypoints/tools/account-switch/config/ImportDrawer.vue";
import type {
  AccountSwitchConfig,
  DomainConfig,
} from "../entrypoints/tools/account-switch/types";

let app: VueApp<Element> | null = null;
let root: HTMLDivElement;

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

function supportedSpec(): Record<string, unknown> {
  return {
    version: 2,
    ops: [
      {
        op: "http.execute",
        url: "{origin}/login",
        method: "POST",
        body: { json: { username: "{username}", password: "{password}" } },
        as: "resp",
      },
    ],
    success: [{ response: { from: "resp", path: "ok" } }],
    auth: { mode: "engine" },
  };
}

describe("ImportDrawer 不支持环境的导入预览", () => {
  it("保留勾选与导入能力，显示具体原因而不是结构错误", async () => {
    const rawSpec = supportedSpec();
    const saves: Partial<AccountSwitchConfig>[] = [];
    root = document.createElement("div");
    document.body.appendChild(root);
    app = createApp({
      render: () =>
        h(ImportDrawer, {
          accounts: [],
          domains: {} as Record<string, DomainConfig>,
          onSave: (patch: Partial<AccountSwitchConfig>) => saves.push(patch),
        }),
    });
    app.mount(root);

    const file = new File(
      [
        JSON.stringify({
          format: "dt-login-config/v1",
          specVersion: 3,
          requiredVars: [],
          environments: [
            {
              name: "future",
              url: "https://future.example.com",
              spec: rawSpec,
              requiredVars: [],
            },
          ],
        }),
      ],
      "policy.json",
      { type: "application/json" },
    );
    const input = root.querySelector<HTMLInputElement>("input[type=file]");
    expect(input).toBeTruthy();
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input!.dispatchEvent(new Event("change"));

    await vi.waitFor(() => {
      expect(root.querySelector(".drawer-env-item")?.textContent).toContain(
        "当前客户端不支持",
      );
    });
    const row = root.querySelector(".drawer-env-item");
    expect(row?.textContent).toContain("LoginSpec 版本 3");
    expect(root.querySelector(".drawer-issues")).toBeNull();

    const confirm = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("确认导入"),
    );
    expect(confirm).toBeTruthy();
    expect(confirm!.disabled).toBe(false);
    confirm!.click();
    await nextTick();

    expect(saves).toHaveLength(1);
    const landed = saves[0].domains?.["https://future.example.com"];
    expect(landed?.strategyConfig?.spec).toEqual(rawSpec);
    expect(landed?.strategyConfig?.declaredSpecVersion).toBe(3);
  });
});
