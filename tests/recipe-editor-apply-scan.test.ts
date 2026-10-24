// @vitest-environment jsdom
/**
 * 一键识别 → 确认替换的回归测试（v1.1.4 用户反馈：识别成功后点「替换步骤」卡死）。
 *
 * 根因：`RecipeEditor` 的 `recipe` 是 computed，每次求值都返回**新对象**；
 * 父组件（DomainsPanel 的 `@change`）把 emit 的值原样写回 props 后，computed
 * 重算并再次触发 `watch(recipe, { deep: true })`，而 emit 侧没有值比较，
 * 于是 emit → props 变化 → 重算 → emit 无限循环，Vue 报
 * 「Maximum recursive updates exceeded」，页面卡死。
 *
 * 断言策略：按 DomainsPanel 的真实形状（父组件回写 props）挂载，
 * 点「识别」→「替换步骤」后必须能继续交互，且只 emit 有限次。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApp,
  defineComponent,
  h,
  nextTick,
  ref,
  type App as VueApp,
} from "vue";
import type { FormScanFrame } from "../entrypoints/tools/account-switch/config/login-form-scan";
import RecipeEditor from "../entrypoints/tools/account-switch/config/RecipeEditor.vue";
import { emptyRecipe } from "../entrypoints/tools/account-switch/config/recipe-editor-model";
import type { Recipe } from "../entrypoints/tools/account-switch/strategies/generic-recipe";

/**
 * 识别结果按 example.com/admin/login 的真实形态构造：
 * Element Plus 渲染，无 id / name，只有 placeholder 与按钮文本。
 */
const SCAN_FRAME: FormScanFrame = {
  found: true,
  frameId: 0,
  frameUrl: "https://example.com/admin/login",
  username: {
    target: { placeholder: "请输入手机号" },
    count: 1,
    rank: 4,
    note: "placeholder「请输入手机号」",
  },
  password: {
    target: { placeholder: "请输入密码" },
    count: 1,
    rank: 4,
    note: "placeholder「请输入密码」",
  },
  submit: {
    target: { text: "登 录" },
    count: 1,
    rank: 5,
    note: "文本「登 录」",
  },
};

let app: VueApp<Element> | null = null;
let root: HTMLDivElement;

function stubChrome(): void {
  vi.stubGlobal("chrome", {
    tabs: {
      getCurrent: vi.fn(async () => ({ id: 99, windowId: 1 })),
      query: vi.fn(async () => [
        { id: 99, windowId: 1, url: "chrome-extension://x/options.html" },
        {
          id: 7,
          windowId: 1,
          url: "https://example.com/admin/login",
          lastAccessed: 1,
        },
      ]),
    },
    runtime: {
      sendMessage: vi.fn(async (msg: { type: string }) => {
        if (msg.type === "SCAN_LOGIN_FORM") {
          return {
            success: true,
            frames: [SCAN_FRAME],
            matches: 1,
            complete: true,
          };
        }
        return { success: true };
      }),
    },
  });
}

async function flush(): Promise<void> {
  await nextTick();
  await new Promise((r) => setTimeout(r, 0));
  await nextTick();
}

function buttonByText(text: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll("button")).find((b) =>
    b.textContent?.trim().includes(text),
  );
  expect(found, `按钮「${text}」应存在`).toBeTruthy();
  return found as HTMLButtonElement;
}

/**
 * 按 DomainsPanel 的方式挂载：父组件持有配方，`@change` 原样写回 ——
 * 正是这条回写路径触发了无限循环。
 */
async function mountWithParent(
  initial: Recipe,
): Promise<{ changeCount: () => number }> {
  const recipe = ref<Recipe>(initial);
  let changes = 0;

  const Wrapper = defineComponent({
    setup() {
      return () =>
        h(RecipeEditor, {
          recipe: recipe.value,
          origin: "https://example.com",
          onChange: (next: Recipe) => {
            changes += 1;
            recipe.value = next;
          },
        });
    },
  });

  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(Wrapper);
  app.mount(root);
  await flush();
  return { changeCount: () => changes };
}

/** 点「识别」并确认结果卡片出现 */
async function runScan(): Promise<void> {
  buttonByText("识别").click();
  await flush();
  await flush();
  expect(root.querySelector(".scan-card")).toBeTruthy();
}

beforeEach(() => stubChrome());

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("RecipeEditor 识别 → 替换步骤", () => {
  it("空白配方：确认替换后不进入无限更新", async () => {
    await mountWithParent(emptyRecipe());
    await runScan();

    buttonByText("替换步骤").click();
    await flush();
    await flush();

    // 结果卡片关闭、落回简易模式，说明渲染循环已收敛
    expect(root.querySelector(".scan-card")).toBeFalsy();
    expect(root.querySelector(".simple-form")).toBeTruthy();
    // 登录页 + 用户名 + 密码 + 登录四行
    expect(root.querySelectorAll(".simple-row")).toHaveLength(4);
  });

  it("已有 goto 的标准配方：替换后保留登录页 URL 且不卡死", async () => {
    const { changeCount } = await mountWithParent({
      version: 1,
      steps: [
        { op: "goto", url: "{origin}/admin/login" },
        { op: "fill", target: "", value: "{username}" },
        { op: "fill", target: "", value: "{password}" },
        { op: "click", target: "", onNotFound: "fail" },
      ],
      settle: { type: "urlChanged" },
      auth: { mode: "page" },
    });
    await runScan();

    buttonByText("替换步骤").click();
    await flush();
    await flush();

    expect(root.querySelector(".scan-card")).toBeFalsy();
    // 登录页 URL 保留（识别结果提示语承诺的语义）
    const loginUrl = root.querySelector<HTMLInputElement>(
      ".simple-form .simple-row input.dt-input",
    );
    expect(loginUrl?.value).toBe("{origin}/admin/login");
    // emit 应是有限次：回写不再引发新一轮 emit
    expect(changeCount()).toBeLessThan(10);
  });

  it("识别结果回填后父组件收到三步定位", async () => {
    const recipe = ref<Recipe>(emptyRecipe());
    const Wrapper = defineComponent({
      setup() {
        return () =>
          h(RecipeEditor, {
            recipe: recipe.value,
            origin: "https://example.com",
            onChange: (next: Recipe) => {
              recipe.value = next;
            },
          });
      },
    });
    root = document.createElement("div");
    document.body.appendChild(root);
    app = createApp(Wrapper);
    app.mount(root);
    await flush();
    await runScan();

    buttonByText("替换步骤").click();
    await flush();

    expect(recipe.value.steps).toEqual([
      {
        op: "fill",
        target: { placeholder: "请输入手机号" },
        value: "{username}",
      },
      {
        op: "fill",
        target: { placeholder: "请输入密码" },
        value: "{password}",
      },
      { op: "click", target: { text: "登 录" }, onNotFound: "fail" },
    ]);
  });
});
