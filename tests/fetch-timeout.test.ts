import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchWithTimeout,
  RequestTimeoutError,
  DEFAULT_REQUEST_TIMEOUT,
} from '../entrypoints/tools/account-switch/utils/fetch-timeout';

/** 模拟真实 fetch：尊重 AbortSignal，abort 时以 AbortError 拒绝 */
function stubHangingFetch() {
  return vi.fn(
    (_url: string, options?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = options?.signal;
        if (signal) {
          if (signal.aborted) {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
            return;
          }
          signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }
        // 永不 resolve —— 模拟无响应的服务器
      }),
  );
}

describe('fetchWithTimeout', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('默认超时时间为 15 秒', () => {
    expect(DEFAULT_REQUEST_TIMEOUT).toBe(15000);
  });

  it('请求超过超时时间后以 RequestTimeoutError 拒绝', async () => {
    vi.stubGlobal('fetch', stubHangingFetch());

    const promise = fetchWithTimeout('http://example.com/api/login', {}, 30);
    await expect(promise).rejects.toBeInstanceOf(RequestTimeoutError);
    await expect(promise).rejects.toThrow('请求超时');
  });

  it('超时错误可通过 name 属性识别', async () => {
    vi.stubGlobal('fetch', stubHangingFetch());

    const error = await fetchWithTimeout('http://example.com/api', {}, 30).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect((error as Error).name).toBe('RequestTimeoutError');
  });

  it('超时前正常响应时透传 Response', async () => {
    const response = new Response('{"success":true}', { status: 200 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    const result = await fetchWithTimeout('http://example.com/api', {}, 1000);
    expect(result).toBe(response);
  });

  it('调用方主动 abort 时透传原始错误而非超时错误', async () => {
    vi.stubGlobal('fetch', stubHangingFetch());

    const callerController = new AbortController();
    const promise = fetchWithTimeout(
      'http://example.com/api',
      { signal: callerController.signal },
      60000,
    );
    callerController.abort();

    await expect(promise).rejects.not.toBeInstanceOf(RequestTimeoutError);
  });
});
