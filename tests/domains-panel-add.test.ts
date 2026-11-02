// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, ref, type App as VueApp } from "vue";
import DomainsPanel, {
  type EnvSavePayload,
} from "../entrypoints/tools/account-switch/config/DomainsPanel.vue";
import type { LoginSpec } from "../entrypoints/tools/account-switch/spec/types";

vi.mock("../entrypoints/tools/account-switch/login-form-lock", () => ({
  prepareLoginFormLock: vi.fn(async () => null),
}));

let app: VueApp<Element> | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

describe("DomainsPanel 添加环境", () => {
  it("完整登录页地址：环境 key 收敛为 origin，登录页写入声明", async () => {
    const saves: EnvSavePayload[] = [];
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
          onSaveWithAccounts: (payload: EnvSavePayload) => saves.push(payload),
        }),
    });
    app.mount(root);
    panel.value?.openCreate();
    await nextTick();

    const input = root.querySelector<HTMLInputElement>("#domain-url");
    expect(input).toBeTruthy();
    const pageUrl = "http://jfv2.dev.ebidding.net.cn:8880/management/#/login";
    input!.value = pageUrl;
    input!.dispatchEvent(new Event("input"));
    input!.dispatchEvent(new Event("blur"));
    await nextTick();

    // 输入原样保留：它是登录页入口，失焦不静默改写
    expect(input!.value).toBe(pageUrl);

    const submit = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "添加环境",
    );
    expect(submit).toBeTruthy();
    submit!.click();
    await vi.waitFor(() => expect(saves).toHaveLength(1));

    const envKey = "http://jfv2.dev.ebidding.net.cn:8880";
    expect(saves[0]!.envKey).toBe(envKey);
    expect(Object.keys(saves[0]!.domains)).toEqual([envKey]);
    const spec = saves[0]!.domains[envKey]!.strategyConfig?.spec as LoginSpec;
    expect(spec.ops.find((op) => op.op === "goto")).toMatchObject({
      url: "{origin}/management/#/login",
    });
  });

  it("路径作用域：环境 key = origin + matchPath，入口地址随环境落盘", async () => {
    const saves: EnvSavePayload[] = [];
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
          onSaveWithAccounts: (payload: EnvSavePayload) => saves.push(payload),
        }),
    });
    app.mount(root);
    panel.value?.openCreate();
    await nextTick();

    const urlInput = root.querySelector<HTMLInputElement>("#domain-url")!;
    urlInput.value = "http://jfv2.dev.ebidding.net.cn:8880";
    urlInput.dispatchEvent(new Event("input"));
    urlInput.dispatchEvent(new Event("blur"));
    const pathInput = root.querySelector<HTMLInputElement>("#domain-match-path")!;
    pathInput.value = "/management";
    pathInput.dispatchEvent(new Event("input"));
    const entryInput = root.querySelector<HTMLInputElement>("#domain-entry-url")!;
    entryInput.value = "http://jfv2.dev.ebidding.net.cn:8880/management/#/login";
    entryInput.dispatchEvent(new Event("input"));
    await nextTick();

    const submit = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "添加环境",
    );
    expect(submit).toBeTruthy();
    submit!.click();
    await vi.waitFor(() => expect(saves).toHaveLength(1));

    const envKey = "http://jfv2.dev.ebidding.net.cn:8880/management";
    expect(saves[0]!.envKey).toBe(envKey);
    expect(Object.keys(saves[0]!.domains)).toEqual([envKey]);
    expect(saves[0]!.domains[envKey]).toMatchObject({
      matchPath: "/management",
      entryUrl: "http://jfv2.dev.ebidding.net.cn:8880/management/#/login",
    });
  });

  it("粘贴带路径的地址：可一键填成页面路径，环境 key 随之带上该路径", async () => {
    const saves: EnvSavePayload[] = [];
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
          onSaveWithAccounts: (payload: EnvSavePayload) => saves.push(payload),
        }),
    });
    app.mount(root);
    panel.value?.openCreate();
    await nextTick();

    const fillButton = () =>
      Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === "填入",
      );
    // 没填地址时无可填入的路径
    expect(fillButton()).toBeUndefined();

    const input = root.querySelector<HTMLInputElement>("#domain-url")!;
    input.value = "http://jfv2.dev.ebidding.net.cn:8880/management/#/login";
    input.dispatchEvent(new Event("input"));
    await nextTick();

    // 路径只作提示，不自动改写：留空仍是整个网站
    const pathInput = root.querySelector<HTMLInputElement>("#domain-match-path")!;
    expect(pathInput.value).toBe("");
    expect(fillButton()).toBeTruthy();

    fillButton()!.click();
    await nextTick();
    expect(pathInput.value).toBe("/management");
    expect(fillButton()).toBeUndefined();

    const submit = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "添加环境",
    );
    submit!.click();
    await vi.waitFor(() => expect(saves).toHaveLength(1));

    expect(saves[0]!.envKey).toBe(
      "http://jfv2.dev.ebidding.net.cn:8880/management",
    );
    const spec = saves[0]!.domains[saves[0]!.envKey]!.strategyConfig
      ?.spec as LoginSpec;
    expect(spec.ops.find((op) => op.op === "goto")).toMatchObject({
      url: "{origin}/management/#/login",
    });
  });
});
