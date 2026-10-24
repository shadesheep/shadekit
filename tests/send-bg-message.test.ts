/**
 * sendBgMessage 的响应契约
 *
 * dev 模式下选项页走 Vite 热更新、service worker 却要手动重新加载，
 * 于是「新 UI 发消息、旧后台没有 handler」是高频现象。Chrome 对未注册的
 * type 不 reject，而是 resolve(undefined)（已在 Edge 155 实测）；调用方若直接
 * 读 `res.success` 会撞 `Cannot read properties of undefined`，把版本不一致
 * 误读成功能故障。这里固化「undefined → 可操作报错」的契约。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendBgMessage } from '../entrypoints/shared/messages';

function stubSendMessage(impl: (message: unknown) => Promise<unknown>) {
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: vi.fn(impl) },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sendBgMessage', () => {
  it('后台无响应（未注册 type）→ 抛出可操作错误，而不是返回 undefined', async () => {
    stubSendMessage(async () => undefined);

    await expect(
      sendBgMessage('SCAN_LOGIN_FORM', { tabId: 1, origin: 'http://a.test' }),
    ).rejects.toThrow(/SCAN_LOGIN_FORM/);
    await expect(
      sendBgMessage('SCAN_LOGIN_FORM', { tabId: 1, origin: 'http://a.test' }),
    ).rejects.toThrow(/重新加载/);
  });

  it('正常响应原样透传', async () => {
    stubSendMessage(async () => ({ success: true, frames: [] }));

    await expect(
      sendBgMessage('SCAN_LOGIN_FORM', { tabId: 1, origin: 'http://a.test' }),
    ).resolves.toEqual({ success: true, frames: [] });
  });
});
