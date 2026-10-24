import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchWithRetry,
  NetworkError,
  computeBackoffDelay,
  GIT_API_TIMEOUT,
  GIT_API_MAX_RETRIES,
} from '../entrypoints/tools/account-switch/utils/fetch-retry';
import { RequestTimeoutError } from '../entrypoints/tools/account-switch/utils/fetch-timeout';

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

/** 网络层失败（断网/DNS 失败等），浏览器 fetch 以 TypeError 拒绝 */
function networkFailure() {
  return new TypeError('Failed to fetch');
}

const FAST = { timeoutMs: 30, maxRetries: 2, baseDelayMs: 1 };

describe('常量约定', () => {
  it('git API 默认超时 10 秒、最多重试 2 次', () => {
    expect(GIT_API_TIMEOUT).toBe(10000);
    expect(GIT_API_MAX_RETRIES).toBe(2);
  });
});

describe('computeBackoffDelay — 指数退避', () => {
  it('第 1 次重试等待 baseDelay，之后每次翻倍', () => {
    expect(computeBackoffDelay(1, 500)).toBe(500);
    expect(computeBackoffDelay(2, 500)).toBe(1000);
    expect(computeBackoffDelay(3, 500)).toBe(2000);
  });
});

describe('fetchWithRetry', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('首次成功直接返回 Response，不重试', async () => {
    const response = new Response('ok', { status: 200 });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchWithRetry('http://example.com/a', {}, FAST);
    expect(result).toBe(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('网络错误后自动重试，重试成功则返回', async () => {
    const response = new Response('ok', { status: 200 });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(networkFailure())
      .mockResolvedValueOnce(response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchWithRetry('http://example.com/a', {}, FAST);
    expect(result).toBe(response);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('超时后自动重试，重试成功则返回', async () => {
    const hanging = stubHangingFetch();
    const response = new Response('ok', { status: 200 });
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, options?: RequestInit) => {
        call += 1;
        if (call === 1) return hanging(url, options);
        return Promise.resolve(response);
      }),
    );

    const result = await fetchWithRetry('http://example.com/a', {}, FAST);
    expect(result).toBe(response);
    expect(call).toBe(2);
  });

  it('5xx 响应视为服务端抖动并重试', async () => {
    const ok = new Response('ok', { status: 200 });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('err', { status: 502 }))
      .mockResolvedValueOnce(ok);
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchWithRetry('http://example.com/a', {}, FAST);
    expect(result).toBe(ok);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('4xx 响应不重试，直接返回由调用方处理', async () => {
    const notFound = new Response('nope', { status: 404 });
    const fetchMock = vi.fn().mockResolvedValue(notFound);
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchWithRetry('http://example.com/a', {}, FAST);
    expect(result).toBe(notFound);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('网络错误重试耗尽后抛出可识别的 NetworkError', async () => {
    const fetchMock = vi.fn().mockRejectedValue(networkFailure());
    vi.stubGlobal('fetch', fetchMock);

    const error = await fetchWithRetry('http://example.com/a', {}, FAST).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as Error).name).toBe('NetworkError');
    // 1 次首发 + 2 次重试
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((error as NetworkError).attempts).toBe(3);
  });

  it('超时重试耗尽后抛出 NetworkError（可通过 message 识别超时原因）', async () => {
    vi.stubGlobal('fetch', stubHangingFetch());

    const error = await fetchWithRetry('http://example.com/a', {}, FAST).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as Error).message).toContain('超时');
  });

  it('5xx 重试耗尽后抛出 NetworkError，message 含状态码', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('err', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const error = await fetchWithRetry('http://example.com/a', {}, FAST).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as Error).message).toContain('503');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('调用方主动 abort 不重试，透传原始中断错误', async () => {
    vi.stubGlobal('fetch', stubHangingFetch());

    const callerController = new AbortController();
    const promise = fetchWithRetry(
      'http://example.com/a',
      { signal: callerController.signal },
      { timeoutMs: 60000, maxRetries: 2, baseDelayMs: 1 },
    );
    callerController.abort();

    await expect(promise).rejects.not.toBeInstanceOf(NetworkError);
    await expect(promise).rejects.not.toBeInstanceOf(RequestTimeoutError);
  });

  it('重试间隔按指数退避增长', async () => {
    const fetchMock = vi.fn().mockRejectedValue(networkFailure());
    vi.stubGlobal('fetch', fetchMock);

    const start = Date.now();
    await fetchWithRetry('http://example.com/a', {}, {
      timeoutMs: 1000,
      maxRetries: 2,
      baseDelayMs: 30,
    }).catch(() => undefined);
    const elapsed = Date.now() - start;

    // 退避等待约 30 + 60 = 90ms；给足抖动下限即可
    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
