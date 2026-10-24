/**
 * 带超时防护的 fetch 封装
 * 登录相关请求统一通过此模块发起，超过超时时间自动中断并报「请求超时」，
 * 避免无响应服务器导致登录流程永远转圈。
 */

/** 默认可识别的超时错误：调用方可用 instanceof 或 name === 'RequestTimeoutError' 识别 */
export class RequestTimeoutError extends Error {
  readonly url: string;
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    super(`请求超时 (${timeoutMs}ms): ${url}`);
    this.name = "RequestTimeoutError";
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

/** 登录相关请求的默认超时时间（毫秒） */
export const DEFAULT_REQUEST_TIMEOUT = 15000;

/** 提取请求 URL 的展示形式（用于错误信息） */
export function displayUrlOf(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

/**
 * fetch + AbortController 超时封装。
 * - 超时后中断请求并抛出 RequestTimeoutError
 * - 调用方传入的 AbortSignal 仍然生效（主动取消透传原始错误，不误报为超时）
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT,
): Promise<Response> {
  const displayUrl = displayUrlOf(input);
  const controller = new AbortController();

  // 桥接调用方的 signal：外部取消应原样传播
  const callerSignal = options.signal ?? null;
  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort();
    } else {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, { ...options, signal: controller.signal });
  } catch (e: unknown) {
    if (timedOut) {
      throw new RequestTimeoutError(displayUrl, timeoutMs);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}
