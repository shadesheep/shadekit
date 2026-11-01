// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App as VueApp } from "vue";

const { sendBgMessage } = vi.hoisted(() => ({ sendBgMessage: vi.fn() }));
vi.mock("../entrypoints/shared/messages", () => ({ sendBgMessage }));

import PlaintextBackupControls from "../entrypoints/options/components/PlaintextBackupControls.vue";

let app: VueApp<Element> | null = null;
let root: HTMLDivElement;
let downloadedName = "";

const summary = {
  plaintext: true as const,
  environments: [
    {
      name: "Supported",
      support: { supported: true, issues: [] },
    },
    {
      name: "Future",
      support: {
        supported: false,
        issues: [
          {
            code: "OP_UNSUPPORTED",
            message: "当前客户端不支持算子 future.op",
            opIndex: 0,
          },
        ],
      },
    },
  ],
  accounts: 1,
  strategies: 1,
  secrets: 2,
  overwrittenTools: ["account-switch", "theme"],
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:backup"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  downloadedName = "";
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloadedName = this.download;
  });
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(PlaintextBackupControls);
  app.mount(root);
});

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function click(selector: string): Promise<void> {
  const element = root.querySelector<HTMLElement>(selector);
  expect(element, selector).toBeTruthy();
  element!.click();
  await nextTick();
}

describe("选项页明文完整备份", () => {
  it("预览展示计数、覆盖范围、不支持原因和明文警告，正文不渲染", async () => {
    sendBgMessage.mockImplementation(async (type: string) => {
      if (type === "VAULT_PREPARE_BACKUP") return { success: true, summary };
      return { success: true, importedSecretCount: 2 };
    });
    const file = new File(
      [
        JSON.stringify({
          __version: 3,
          "account-switch": {
            accounts: [{ password: "DO-NOT-RENDER" }],
            domains: {},
          },
        }),
      ],
      "shadekit-config-old.json",
      { type: "application/json" },
    );
    const input = root.querySelector<HTMLInputElement>("input[type=file]");
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input!.dispatchEvent(new Event("change"));

    await vi.waitFor(() => {
      expect(root.textContent).toContain("当前客户端不支持算子 future.op");
    });
    expect(sendBgMessage).toHaveBeenCalledWith("VAULT_PREPARE_BACKUP", {
      text: expect.any(String),
    });
    expect(root.textContent).toContain("2 个环境");
    expect(root.textContent).toContain("1 个账号");
    expect(root.textContent).toContain("1 条策略");
    expect(root.textContent).toContain("2 个秘密");
    expect(root.textContent).toContain("account-switch");
    expect(root.textContent).toContain("theme");
    expect(root.textContent).toContain("明文");
    expect(root.textContent).toContain("覆盖");
    expect(root.textContent).not.toContain("DO-NOT-RENDER");
    expect(root.querySelector("[data-backup-password]")).toBeNull();
    expect(root.textContent).not.toContain("shadekit-backup/v1");

    await click("[data-backup-confirm]");
    await vi.waitFor(() => {
      expect(sendBgMessage).toHaveBeenCalledWith("VAULT_CONFIRM_BACKUP", {
        acceptPlaintextWarning: true,
      });
    });
  });

  it("导出先确认明文风险，再下载 shadekit-config 文件且消息不带密码", async () => {
    sendBgMessage.mockResolvedValue({
      success: true,
      backup: { __version: 3, "account-switch": { accounts: [], domains: {} } },
    });
    await click(".btn-export");
    expect(sendBgMessage).not.toHaveBeenCalled();
    expect(root.textContent).toContain("明文");
    expect(root.querySelector("[data-backup-password]")).toBeNull();

    await click("[data-backup-confirm]");
    await vi.waitFor(() => {
      expect(sendBgMessage).toHaveBeenCalledWith("VAULT_EXPORT_BACKUP");
    });
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(downloadedName).toMatch(/^shadekit-config-\d{4}-\d{2}-\d{2}\.json$/);
    expect(root.textContent).not.toContain("shadekit-backup/v1");
  });
});
