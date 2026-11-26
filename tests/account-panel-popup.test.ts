import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleGetAccountPanel } from "../entrypoints/tools/account-switch/background-handler";

const { readConfig, queryTabs } = vi.hoisted(() => ({
  readConfig: vi.fn(),
  queryTabs: vi.fn(),
}));
vi.mock("../entrypoints/tools/account-switch/config-store", () => ({
  readAccountSwitchConfig: readConfig,
}));

const extensionUrl = "chrome-extension://shadekit-test/popup.html";
const pageUrl = "https://app.example.test/ebidding/home";
const environmentId = "https://*.example.test/ebidding";
const contentSender = {
  url: pageUrl,
  tab: { id: 42, url: pageUrl },
} as chrome.runtime.MessageSender;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("chrome", {
    permissions: { contains: vi.fn(async () => true) },
    tabs: { query: queryTabs },
  });
  queryTabs.mockResolvedValue([{ id: 42, url: pageUrl }]);
  readConfig.mockResolvedValue({
    accounts: [{
      id: "acc-project",
      name: "项目经理",
      username: "project-manager",
      roles: ["项目经理"],
      domains: [environmentId],
    }],
    domains: {
      [environmentId]: { name: "JYPT", tags: [], matchPath: "/ebidding" },
    },
  });
});

describe("账号面板入口一致性", () => {
  it("插件弹窗与快捷键面板对同一活动页面返回相同账号和路径环境", async () => {
    const contentPanel = await handleGetAccountPanel(contentSender);
    expect(contentPanel.accounts.map((account) => account.id)).toEqual(["acc-project"]);

    const popupPanel = await handleGetAccountPanel({ url: extensionUrl });
    expect(popupPanel.accounts).toEqual(contentPanel.accounts);
    expect(popupPanel.matchedEnvKey).toBe(environmentId);
    expect(queryTabs).toHaveBeenCalledWith({ active: true, currentWindow: true });
  });

  it("Content Script 按发送页面匹配，不受另一个活动标签页影响", async () => {
    queryTabs.mockResolvedValue([{ id: 99, url: "https://other.example.test/" }]);
    expect((await handleGetAccountPanel(contentSender)).accounts).toHaveLength(1);
    expect(queryTabs).not.toHaveBeenCalled();
  });

  it("弹窗作为独立扩展标签页发送消息时，仍按活动网页匹配", async () => {
    const panel = await handleGetAccountPanel({
      url: extensionUrl,
      tab: { id: 99, url: extensionUrl },
    } as chrome.runtime.MessageSender);
    expect(panel.accounts.map((account) => account.id)).toEqual(["acc-project"]);
    expect(panel.matchedEnvKey).toBe(environmentId);
  });

  it("没有活动网页时不展示其他环境的账号", async () => {
    queryTabs.mockResolvedValue([]);
    const panel = await handleGetAccountPanel({ url: extensionUrl });
    expect(panel.accounts).toEqual([]);
    expect(panel.matchedEnvKey).toBe("");
  });
});
