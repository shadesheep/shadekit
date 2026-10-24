/**
 * ADR-0003 D1 — Background Router round-trip 集成测试
 *
 * 跨过「调用方真正使用的 seam」的完整链路：
 *   sendBgMessage → chrome.runtime.sendMessage → onMessage 监听
 *   → 路由表（真实 allTools 注册表）→ 工具 handler → response 回传
 *
 * 由此「handler 测试全绿但路由断裂」这类事故（扩展市场 bug 的形态，
 * 消息在 registry 与 router 之间丢失）会被本测试直接拦住。
 *
 * chrome.runtime 以最小 fake 实现，模拟 Chrome 的消息分发语义：
 * - 监听返回 true 表示异步响应（经 sendResponse 回传）
 * - 无任何监听认领时，sendMessage 以「Receiving end does not exist」reject
 *
 * registry handler 委托的 background-handler 模块整体 mock，
 * 断言落在「正确的 handler 被以收窄后的 payload 调用、response 形状正确」。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { sendBgMessage } from '../entrypoints/shared/messages';
import {
  buildMessageRouteTable,
  createBackgroundMessageListener,
} from '../entrypoints/shared/message-router';
import { allTools } from '../entrypoints/shared/tool-definitions';
import type { Account } from '../entrypoints/tools/account-switch/types';
import {
  handleSwitchAccount,
  handleQuickLogin,
} from '../entrypoints/tools/account-switch/background-handler';

vi.mock('../entrypoints/tools/account-switch/background-handler', () => ({
  handleSwitchAccount: vi.fn(),
  handleQuickLogin: vi.fn(),
}));

// ---------------------------------------------------------------------------
// 最小 chrome.runtime fake：模拟 Chrome 的消息分发语义
// ---------------------------------------------------------------------------

type MessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean;

const messageListeners = new Set<MessageListener>();
const fakeSender = { tab: { id: 42 } } as chrome.runtime.MessageSender;

vi.stubGlobal('chrome', {
  runtime: {
    onMessage: {
      addListener: (fn: MessageListener) => messageListeners.add(fn),
      removeListener: (fn: MessageListener) => messageListeners.delete(fn),
    },
    sendMessage: (message: unknown) =>
      new Promise((resolve, reject) => {
        let keepAlive = false;
        for (const fn of [...messageListeners]) {
          if (fn(message, fakeSender, resolve) === true) keepAlive = true;
        }
        // Chrome 语义：无任何监听认领（未返回 true）时 sendMessage 显性 reject
        if (!keepAlive) {
          reject(
            new Error(
              'Could not establish connection. Receiving end does not exist.',
            ),
          );
        }
      }),
  },
});

// ---------------------------------------------------------------------------
// 被测链路：真实注册表建表 + 真实监听工厂（与 background.ts 同一 seam）
// ---------------------------------------------------------------------------

const openToolTab = vi.fn<(tool: string, params: Record<string, string>, forceNew: boolean) => Promise<void>>();

function registerRouter() {
  messageListeners.clear();
  const routeTable = buildMessageRouteTable(allTools);
  messageListeners.add(
    createBackgroundMessageListener(routeTable, { openToolTab }),
  );
}

const mocked = <T>(fn: T) => fn as unknown as Mock;

beforeEach(() => {
  vi.clearAllMocks();
  registerRouter();
  openToolTab.mockResolvedValue(undefined);
});

const ACCOUNT: Account = {
  id: 'acc_1',
  name: '测试账号',
  username: 'user01',
  password: 'pw',
  roles: ['管理员'],
  domains: ['https://demo.example.com'],
};

describe('Background Router round-trip', () => {
  it('SWITCH_ACCOUNT 到达账号切换 handler，sender 透传，response 回传', async () => {
    mocked(handleSwitchAccount).mockResolvedValue({ success: true });

    const res = await sendBgMessage('SWITCH_ACCOUNT', {
      account: ACCOUNT,
      domain: 'https://demo.example.com',
    });

    expect(handleSwitchAccount).toHaveBeenCalledWith(
      ACCOUNT,
      'https://demo.example.com',
      fakeSender,
    );
    expect(res).toEqual({ success: true });
  });

  it('QUICK_LOGIN 到达快捷登录 handler，hasUrl 缺省补 true，debugRedirect 透传', async () => {
    mocked(handleQuickLogin).mockResolvedValue({
      success: false,
      error: 'x',
      errorCode: 'E_X',
    });

    const res = await sendBgMessage('QUICK_LOGIN', {
      url: 'https://demo.example.com',
      username: 'user01',
      password: 'pw',
      debugRedirect: 'http://debug.local',
    });

    expect(handleQuickLogin).toHaveBeenCalledWith(
      'https://demo.example.com',
      'user01',
      'pw',
      true,
      fakeSender,
      'http://debug.local',
    );
    expect(res).toEqual({ success: false, error: 'x', errorCode: 'E_X' });
  });

  it('OPEN_TOOL_TAB 核心消息不落路由表，走注入的核心 handler', async () => {
    const res = await sendBgMessage('OPEN_TOOL_TAB', {
      tool: 'json-formatter',
      params: { text: '{}' },
      forceNew: true,
    });

    expect(openToolTab).toHaveBeenCalledWith(
      'json-formatter',
      { text: '{}' },
      true,
    );
    expect(res).toEqual({ success: true });
    // 核心消息不应触达任何工具 handler
    expect(handleSwitchAccount).not.toHaveBeenCalled();
    expect(handleQuickLogin).not.toHaveBeenCalled();
  });

  it('OPEN_TOOL_TAB 缺省 params/forceNew 时补空对象与 false', async () => {
    await sendBgMessage('OPEN_TOOL_TAB', { tool: 'json-diff' });

    expect(openToolTab).toHaveBeenCalledWith('json-diff', {}, false);
  });

  it('未注册 type：监听返回 false，sendMessage 显性 reject，而非静默吞掉', async () => {
    // 模拟协议外消息（如存量页面代码在新版扩展上发送已删除的 type）。
    // 类型层已封堵此类发送，这里以 cast 构造运行时越界场景；
    // 故意使用从未存在过的 type，避免引用任何已删除的协议成员。
    const bogusType = 'NO_SUCH_MESSAGE_TYPE';

    // 直接可观察行为：监听对未注册 type 返回 false（不认领、不回 response）
    const routeTable = buildMessageRouteTable(allTools);
    const listener = createBackgroundMessageListener(routeTable, {
      openToolTab,
    });
    const sendResponse = vi.fn();
    expect(listener({ type: bogusType }, fakeSender, sendResponse)).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();

    // 完整链路：无监听认领时 Chrome 语义下 sendMessage 显性 reject
    await expect(sendBgMessage(bogusType as never)).rejects.toThrow(
      /Receiving end does not exist/,
    );
  });

  it('协议与注册表一致性：每个工具消息 type 都有 handler 可达', () => {
    // 协议与注册表的漂移守护：BackgroundMessageMap 中每个工具消息 type
    // 必须真实存在于路由表（防止「协议声明了但 registry 忘了挂 handler」）。
    const routeTable = buildMessageRouteTable(allTools);
    for (const type of ['SWITCH_ACCOUNT', 'QUICK_LOGIN']) {
      expect(routeTable.has(type), `协议 type 未注册 handler: ${type}`).toBe(
        true,
      );
    }
  });
});
