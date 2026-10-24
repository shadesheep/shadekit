/**
 * 带超时 + 指数退避重试的 fetch 封装
 * Git 平台 API（GitHub/Gitee）请求统一通过此模块发起：
 * - 单次请求超过超时时间自动中断（复用 fetchWithTimeout）
 * - 网络错误 / 超时 / 5xx 服务端抖动按指数退避自动重试
 * - 重试耗尽后抛出可识别的 NetworkError，调用方可向用户展示明确提示
 * - 4xx 响应与调用方主动 abort 不重试，原样透传
 */

import { displayUrlOf, fetchWithTimeout, RequestTimeoutError } from "./fetch-timeout";

/** 重试耗尽后抛出的网络错误：调用方可用 instanceof 或 name === 'NetworkError' 识别 */
export class NetworkError extends Error {
  readonly url: string;
  /** 总尝试次数（含首发请求） */
  readonly attempts: number;

  constructor(url: string, attempts: number, reason: string) {
    super(`网络请求失败（已尝试 ${attempts} 次）: ${reason} — ${url}`);
    this.name = "NetworkError";
    this.url = url;
    this.attempts = attempts;
  }
}

/** git 平台 API 请求的单次超时时间（毫秒） */
export const GIT_API_TIMEOUT = 10000;

/** git 平台 API 请求的最大重试次数（不含首发请求） */
export const GIT_API_MAX_RETRIES = 2;

/** 指数退避基准间隔（毫秒） */
const DEFAULT_BASE_DELAY = 500;

export interface FetchRetryOptions {
  /** 单次请求超时（毫秒），默认 GIT_API_TIMEOUT */
  timeoutMs?: number;
  /** 最大重试次数（不含首发），默认 GIT_API_MAX_RETRIES */
  maxRetries?: number;
  /** 指数退避基准间隔（毫秒），默认 500 */
  baseDelayMs?: number;
}

/** 计算第 n 次重试（从 1 开始）前的等待时长：base × 2^(n-1) */
export function computeBackoffDelay(
  retryIndex: number,
  baseDelayMs: number,
): number {
  return baseDelayMs * 2 ** (retryIndex - 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 5xx 视为服务端抖动，值得重试；4xx 是确定性结果，重试无意义 */
function isRetryableStatus(status: number): boolean {
  return status >= 500 && status < 600;
}

/**
 * fetch + 超时 + 指数退避重试封装（行为约定见文件头注释）。
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  options: RequestInit = {},
  retryOptions: FetchRetryOptions = {},
): Promise<Response> {
  const {
    timeoutMs = GIT_API_TIMEOUT,
    maxRetries = GIT_API_MAX_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY,
  } = retryOptions;
  const url = displayUrlOf(input);
  const maxAttempts = maxRetries + 1;

  let lastReason = "未知错误";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(input, options, timeoutMs);
      if (!isRetryableStatus(response.status)) {
        return response;
      }
      lastReason = `服务器错误 ${response.status}`;
    } catch (e: unknown) {
      // 调用方主动取消：不重试、不包装，原样透传
      if (options.signal?.aborted && !(e instanceof RequestTimeoutError)) {
        throw e;
      }
      lastReason = e instanceof Error ? e.message : String(e);
    }

    if (attempt < maxAttempts) {
      await sleep(computeBackoffDelay(attempt, baseDelayMs));
    }
  }

  throw new NetworkError(url, maxAttempts, lastReason);
}
