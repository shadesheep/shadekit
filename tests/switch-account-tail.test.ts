/**
 * SWITCH_ACCOUNT 成功后的尾部动作（ADR-0012 D10 回归）。
 *
 * 旧引擎在 `afterLogin` 阶段对账号切换执行 `applyNavigationIntent`：
 * 无 redirect 时刷新当前 tab，generic 无 debugRedirect 时同样刷新。收敛为
 * 单一 spec 执行器后，`handleSwitchAccount` 只跑 spec、不再做尾部导航，
 * 声明以 `auth.write` 收尾——登录成功但页面不刷新。
 *
 * 这里把执行器替换为「必定成功」的闸门，断言 handler 的外部可观察行为：
 * 成功后必须对执行 tab 发起刷新。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storageGetMock = vi.fn();
const storageSetMock = vi.fn().mockResolvedValue(undefined);

const tabsMock = {
  query: vi.fn().mockResolvedValue([]),
  get: vi.fn(),
  create: vi.fn(),
  reload: vi.fn().mockResolvedValue(undefined),
  update: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
};

vi.stubGlobal("chrome", {
  storage: {
    local: {
      get: (...args: unknown[]) => storageGetMock(...args),
      set: (...args: unknown[]) => storageSetMock(...args),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  },
  tabs: tabsMock,
});

const runLoginSpecMock = vi.fn();

vi.mock("../entrypoints/tools/account-switch/spec/login-run", () => ({
  runLoginSpec: (...args: unknown[]) => runLoginSpecMock(...args),
}));

import { handleSwitchAccount } from "../entrypoints/tools/account-switch/background-handler";
import { releaseLoginLock } from "../entrypoints/tools/account-switch/login-session";
import type { Account } from "../entrypoints/tools/account-switch/types";

const account = {
  id: "a1",
  name: "测试账号",
  username: "user1",
  password: "pass1",
  roles: [],
  domains: ["example.com"],
} as Account;

/** 环境声明：执行器已 mock，这里只需要能通过 prelude 读取 */
function seedConfig() {
  storageGetMock.mockImplementation(async (keys: string[]) => {
    if (keys.includes("devtools-account-switch")) {
      return {
        "devtools-account-switch": {
          domains: {
            "http://example.com": {
              name: "测试环境",
              loginMethod: "generic",
              strategyConfig: {
                spec: {
                  version: 2,
                  template: "generic",
                  ops: [
                    { op: "http.execute", url: "{origin}/login", as: "resp" },
                    { op: "auth.write" },
                  ],
                  success: [
                    {
                      response: { from: "resp", path: "success", equals: true },
                    },
                  ],
                  auth: { mode: "engine" },
                },
              },
            },
          },
        },
      };
    }
    return {};
  });
  tabsMock.get.mockResolvedValue({
    id: 1,
    url: "http://example.com/dashboard",
    status: "complete",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  storageSetMock.mockResolvedValue(undefined);
  runLoginSpecMock.mockResolvedValue({ success: true });
  seedConfig();
});

afterEach(() => {
  releaseLoginLock(1);
});

describe("handleSwitchAccount — 登录成功后的尾部刷新", () => {
  it("成功后刷新执行 tab（旧 afterLogin 的 reload 兜底）", async () => {
    const result = await handleSwitchAccount(account, "http://example.com", {
      tab: { id: 1 },
    } as chrome.runtime.MessageSender);

    expect(result.success).toBe(true);
    expect(tabsMock.reload).toHaveBeenCalledWith(1);
  });

  it("当前地址带 ?redirect= 时导航过去而不是原地刷新（旧 afterLogin 约定）", async () => {
    tabsMock.get.mockResolvedValue({
      id: 1,
      url: "http://example.com/login?redirect=/dashboard",
      status: "complete",
    });

    const result = await handleSwitchAccount(account, "http://example.com", {
      tab: { id: 1 },
    } as chrome.runtime.MessageSender);

    expect(result.success).toBe(true);
    expect(tabsMock.update).toHaveBeenCalledWith(1, {
      url: "http://example.com/dashboard",
    });
    expect(tabsMock.reload).not.toHaveBeenCalled();
  });

  it("刷新失败不把已成功的登录判成失败", async () => {
    tabsMock.reload.mockRejectedValueOnce(new Error("No tab with id: 1"));

    const result = await handleSwitchAccount(account, "http://example.com", {
      tab: { id: 1 },
    } as chrome.runtime.MessageSender);

    expect(result.success).toBe(true);
  });
});
