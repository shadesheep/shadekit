import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  waitForTabLoaded,
  reloadTabAndWait,
  DEFAULT_TAB_LOAD_TIMEOUT,
} from '../entrypoints/tools/account-switch/utils/tab-load';

type UpdatedListener = (tabId: number, changeInfo: { status?: string }) => void;
type RemovedListener = (tabId: number) => void;

const tabsGetMock = vi.fn();
const tabsReloadMock = vi.fn();
const updatedListeners = new Set<UpdatedListener>();
const removedListeners = new Set<RemovedListener>();

vi.stubGlobal('chrome', {
  tabs: {
    get: tabsGetMock,
    reload: tabsReloadMock,
    onUpdated: {
      addListener: (fn: UpdatedListener) => updatedListeners.add(fn),
      removeListener: (fn: UpdatedListener) => updatedListeners.delete(fn),
    },
    onRemoved: {
      addListener: (fn: RemovedListener) => removedListeners.add(fn),
      removeListener: (fn: RemovedListener) => removedListeners.delete(fn),
    },
  },
});

function fireComplete(tabId: number) {
  for (const fn of [...updatedListeners]) fn(tabId, { status: 'complete' });
}

function fireRemoved(tabId: number) {
  for (const fn of [...removedListeners]) fn(tabId);
}

/** 等待 waitForTabLoaded 内部的 chrome.tabs.get 异步完成、事件监听注册就绪 */
function waitForListenerRegistration() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('waitForTabLoaded', () => {
  beforeEach(() => {
    tabsGetMock.mockReset();
    tabsReloadMock.mockReset();
    updatedListeners.clear();
    removedListeners.clear();
  });

  it('默认超时时间为 15 秒', () => {
    expect(DEFAULT_TAB_LOAD_TIMEOUT).toBe(15000);
  });

  it('tab 已加载完成时直接 resolve，不注册监听', async () => {
    tabsGetMock.mockResolvedValue({ id: 1, url: 'http://a.com/', status: 'complete' });

    await waitForTabLoaded(1, 50);
    expect(updatedListeners.size).toBe(0);
    expect(removedListeners.size).toBe(0);
  });

  it('tab 触发 complete 事件后 resolve 并清理监听', async () => {
    tabsGetMock.mockResolvedValue({ id: 1, url: 'http://a.com/', status: 'loading' });

    const promise = waitForTabLoaded(1, 1000);
    await waitForListenerRegistration();
    expect(updatedListeners.size).toBe(1);
    fireComplete(1);

    await expect(promise).resolves.toBeUndefined();
    expect(updatedListeners.size).toBe(0);
    expect(removedListeners.size).toBe(0);
  });

  it('忽略其他 tab 的 complete 事件', async () => {
    tabsGetMock.mockResolvedValue({ id: 1, url: 'http://a.com/', status: 'loading' });

    const promise = waitForTabLoaded(1, 50);
    fireComplete(999);

    await expect(promise).rejects.toThrow('超时');
  });

  it('超时后 reject 且清理 tabs.onUpdated 监听，不泄漏', async () => {
    tabsGetMock.mockResolvedValue({ id: 1, url: 'http://a.com/', status: 'loading' });

    const promise = waitForTabLoaded(1, 30);
    await expect(promise).rejects.toThrow('超时');
    expect(updatedListeners.size).toBe(0);
    expect(removedListeners.size).toBe(0);
  });

  it('tab 在等待期间被关闭时提前 reject 并清理监听', async () => {
    tabsGetMock.mockResolvedValue({ id: 1, url: 'http://a.com/', status: 'loading' });

    const promise = waitForTabLoaded(1, 60000);
    await waitForListenerRegistration();
    fireRemoved(1);

    await expect(promise).rejects.toThrow('关闭');
    expect(updatedListeners.size).toBe(0);
    expect(removedListeners.size).toBe(0);
  });

  it.each(['chrome://newtab/', 'edge://settings', 'about:blank'])(
    '受限页面 %s 立即报明确错误而非无限等待',
    async (url) => {
      tabsGetMock.mockResolvedValue({ id: 1, url, status: 'loading' });

      await expect(waitForTabLoaded(1, 60000)).rejects.toThrow('受限');
      expect(updatedListeners.size).toBe(0);
    },
  );

  it('竞态：注册监听期间页面已完成加载时也能 resolve', async () => {
    // 第一次 get（前置检查）返回 loading，第二次 get（注册监听后复查）返回 complete
    tabsGetMock
      .mockResolvedValueOnce({ id: 1, url: 'http://a.com/', status: 'loading' })
      .mockResolvedValue({ id: 1, url: 'http://a.com/', status: 'complete' });

    await expect(waitForTabLoaded(1, 50)).resolves.toBeUndefined();
    expect(updatedListeners.size).toBe(0);
    expect(removedListeners.size).toBe(0);
  });

  it('tab 不存在时报明确错误', async () => {
    tabsGetMock.mockRejectedValue(new Error('No tab with id: 1'));

    await expect(waitForTabLoaded(1, 50)).rejects.toThrow('不存在或已关闭');
  });
});

describe('reloadTabAndWait', () => {
  beforeEach(() => {
    tabsGetMock.mockReset();
    tabsReloadMock.mockReset();
    updatedListeners.clear();
    removedListeners.clear();
    tabsReloadMock.mockResolvedValue(undefined);
  });

  it('先注册监听再发起刷新，等待刷新后的 complete（不复用旧文档的 complete）', async () => {
    // 前置 get 读到旧文档仍是 complete —— 若直接复用 waitForTabLoaded 会立即返回
    tabsGetMock.mockResolvedValue({ id: 1, url: 'http://a.com/', status: 'complete' });
    tabsReloadMock.mockImplementation(async () => {
      // reload 发起时必须已经挂上监听，否则会漏掉紧随其后的 complete
      expect(updatedListeners.size).toBe(1);
    });

    const promise = reloadTabAndWait(1, 1000);
    await waitForListenerRegistration();
    expect(tabsReloadMock).toHaveBeenCalledWith(1);

    fireComplete(1);
    await expect(promise).resolves.toBeUndefined();
    expect(updatedListeners.size).toBe(0);
  });

  it('超时后 reject 并清理监听，不泄漏', async () => {
    tabsGetMock.mockResolvedValue({ id: 1, url: 'http://a.com/', status: 'complete' });

    await expect(reloadTabAndWait(1, 30)).rejects.toThrow('超时');
    expect(updatedListeners.size).toBe(0);
    expect(removedListeners.size).toBe(0);
  });

  it('刷新期间 tab 被关闭时提前 reject', async () => {
    tabsGetMock.mockResolvedValue({ id: 1, url: 'http://a.com/', status: 'complete' });

    const promise = reloadTabAndWait(1, 60000);
    await waitForListenerRegistration();
    fireRemoved(1);

    await expect(promise).rejects.toThrow('关闭');
    expect(updatedListeners.size).toBe(0);
  });

  it('刷新调用本身失败时 reject', async () => {
    tabsGetMock.mockResolvedValue({ id: 1, url: 'http://a.com/', status: 'complete' });
    tabsReloadMock.mockRejectedValue(new Error('reload failed'));

    await expect(reloadTabAndWait(1, 1000)).rejects.toThrow('reload failed');
    expect(updatedListeners.size).toBe(0);
  });

  it('受限页面直接报错，不发起刷新', async () => {
    tabsGetMock.mockResolvedValue({ id: 1, url: 'chrome://settings', status: 'complete' });

    await expect(reloadTabAndWait(1, 60000)).rejects.toThrow('受限');
    expect(tabsReloadMock).not.toHaveBeenCalled();
  });
});
