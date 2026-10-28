// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, ref, type App as VueApp } from "vue";
import DomainsPanel, {
  type EnvSavePayload,
} from "../entrypoints/tools/account-switch/config/DomainsPanel.vue";
import { defaultLoginSpec } from "../entrypoints/tools/account-switch/spec";
import type {
  Account,
  DomainConfig,
} from "../entrypoints/tools/account-switch/types";

vi.mock("../entrypoints/tools/account-switch/login-form-lock", () => ({
  prepareLoginFormLock: vi.fn(async () => null),
}));

let app: VueApp<Element> | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

describe("DomainsPanel 克隆环境", () => {
  it("创建绑定相同账号的独立副本，不修改原环境或解除原账号绑定", async () => {
    const originalKey = "https://env.example.com";
    const original: DomainConfig = {
      name: "测试环境",
      tags: ["test"],
      loginMethod: "generic",
      strategyConfig: { spec: defaultLoginSpec() },
    };
    const accounts: Account[] = [
      {
        id: "account-1",
        name: "账号一",
        username: "one",
        password: "secret",
        roles: [],
        domains: [originalKey],
      },
      {
        id: "account-2",
        name: "账号二",
        username: "two",
        password: "secret",
        roles: [],
        domains: [originalKey, "https://other.example.com"],
      },
    ];
    const originalSnapshot = structuredClone(original);
    const accountsSnapshot = structuredClone(accounts);
    const saves: EnvSavePayload[] = [];
    const panel = ref<{ openClone: (url: string) => void } | null>(null);
    const root = document.createElement("div");
    document.body.appendChild(root);
    app = createApp({
      render: () =>
        h(DomainsPanel, {
          ref: panel,
          domains: { [originalKey]: original },
          strategies: {},
          accounts,
          onSaveWithAccounts: (payload: EnvSavePayload) => saves.push(payload),
        }),
    });
    app.mount(root);

    panel.value?.openClone(originalKey);
    await nextTick();

    const accountButtons = root.querySelectorAll<HTMLButtonElement>(
      'button[aria-label^="关联账号："]',
    );
    expect(Array.from(accountButtons).map((button) => button.ariaPressed)).toEqual([
      "true",
      "true",
    ]);

    const submit = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "创建副本",
    );
    expect(submit).toBeTruthy();
    submit!.click();
    await nextTick();
    await vi.waitFor(() => expect(saves).toHaveLength(1));

    const payload = saves[0];
    const cloneKey = `${originalKey}-clone`;
    expect(payload.previousEnvKey).toBeNull();
    expect(payload.envKey).toBe(cloneKey);
    expect(payload.domains[originalKey]).toEqual(originalSnapshot);
    expect(payload.domains[cloneKey]).toBeDefined();
    expect(payload.domains[cloneKey]).not.toBe(original);
    expect(payload.boundAccountIds).toEqual(["account-1", "account-2"]);
    expect(payload.unboundAccountIds).toEqual([]);
    expect(original).toEqual(originalSnapshot);
    expect(accounts).toEqual(accountsSnapshot);
  });
});
