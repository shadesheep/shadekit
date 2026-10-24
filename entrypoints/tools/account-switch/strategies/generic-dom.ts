/**
 * DOM 步骤的跨 frame 执行与归并（ADR-0012 D12）
 *
 * 所有 DOM 类步骤都以 `allFrames: true` 注入，按 frame 收集结果后归并：
 * - 恰好一个 frame 命中唯一可见元素 → 成功
 * - 多于一个 frame 命中 → `AMBIGUOUS_TARGET`（多 frame 冲突），绝不猜测
 * - 命中但同 frame 内不唯一 → `AMBIGUOUS_TARGET`
 * - 选择器写错 → `SELECTOR_INVALID`
 * - 全部未命中 → `ELEMENT_NOT_FOUND`
 * - 步骤记录了拾取时的 frame（D14），但页面里已找不到该 frame →
 *   `FRAME_NOT_FOUND`（不静默回退到全 frame 搜索）
 *
 * frame 匹配顺序（ADR-0013 D7）：frameId 优先，其次 origin+pathname 精确比较。
 * 只比到 origin+pathname 是因为 query / hash 变化（SPA 路由、埋点参数）不该
 * 让定位失效；同 origin 的同路径 iframe 仍会命中（已知边界，优于全 origin 比较）。
 */

import { ErrorCodes, LoginError } from "../utils/error-codes";
import type { FrameScope, Target } from "./generic-recipe";
import {
  describeTarget,
  domActionInPage,
  type DomAction,
  type DomActionResult,
} from "./generic-target";

/** 跨 frame 执行后的归一结果 */
export type DomOutcome =
  /** `value` 仅 `read` 动作携带（选中元素的文本 / 输入值） */
  | { status: "ok"; frameId: number; value?: string }
  | {
      status: "ambiguous";
      frameId: number;
      count: number;
      message: string;
    }
  | { status: "invalid"; message: string }
  | { status: "error"; message: string }
  | { status: "frameMissing"; message: string }
  | { status: "notFound" };

interface FrameResult {
  frameId?: number;
  result?: DomActionResult;
}

/**
 * 在所有 frame 中执行 DOM 动作并归并结果。
 * 注入失败（受限页面等）归一为 error，由调用方决定是否忽略。
 *
 * `scope` 来自拾取器（D14）：记录过 frame 的步骤只在该 frame 内判定命中，
 * 页面跳转后 frameId 会变，因此优先用 frameUrl 重新锁定。
 */
export async function runDomAction(
  tabId: number,
  action: DomAction,
  scope?: FrameScope,
): Promise<DomOutcome> {
  let frames: FrameResult[];
  try {
    frames = (await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: domActionInPage,
      args: [action],
    })) as FrameResult[];
  } catch (e: unknown) {
    return {
      status: "error",
      message: e instanceof Error ? e.message : String(e),
    };
  }

  /**
   * 记录过 frame 的步骤只在该 frame 内判定命中。
   * 匹配顺序（ADR-0013 D7）：frameId → origin+pathname。
   * 主 frame（frameId === 0）的身份由 tab 保证，不记录 frameUrl，因此只需比 frameId。
   */
  const sameOriginAndPath = (a: string, b: string): boolean => {
    try {
      const left = new URL(a);
      const right = new URL(b);
      return left.origin === right.origin && left.pathname === right.pathname;
    } catch {
      return a === b;
    }
  };

  const hasScope =
    !!scope && (scope.frameId !== undefined || scope.frameUrl !== undefined);
  const inScope = (frameId: number, url: string | undefined): boolean => {
    // 没记录过 frame（步骤上不带 frameId / frameUrl）→ 全 frame 搜索
    if (!hasScope) return true;
    if (scope!.frameId !== undefined && frameId === scope!.frameId) return true;
    if (scope!.frameUrl && url) return sameOriginAndPath(url, scope!.frameUrl);
    return false;
  };

  // 记录的 frame 是否还在页面里（任一 frame 落在范围内即可）
  if (hasScope) {
    const present = (frames ?? []).some((frame) =>
      inScope(frame.frameId ?? 0, frame.result?.frameUrl),
    );
    if (!present) {
      return {
        status: "frameMissing",
        message: `定位记录的 frame 已不存在（${
          scope!.frameUrl ?? `frame ${scope!.frameId}`
        }）`,
      };
    }
  }

  const hits: Array<{ frameId: number; count: number; value?: string }> = [];
  let ambiguous: { frameId: number; count: number; message: string } | null =
    null;
  let invalid: string | null = null;

  for (const frame of frames ?? []) {
    const result = frame.result;
    if (!result) continue;
    const frameId = frame.frameId ?? 0;
    if (!inScope(frameId, result.frameUrl)) continue;
    switch (result.status) {
      case "ok":
        hits.push({ frameId, count: result.count || 1, value: result.value });
        break;
      case "ambiguous":
        if (!ambiguous) {
          ambiguous = {
            frameId,
            count: result.count,
            message: result.message ?? "定位歧义",
          };
        }
        break;
      case "invalid":
        invalid = result.message ?? "定位语法不合法";
        break;
      default:
        break;
    }
  }

  if (hits.length > 1) {
    return {
      status: "ambiguous",
      frameId: -1,
      count: hits.length,
      message: `多个 frame 同时命中（${hits
        .map((h) => `frame ${h.frameId}`)
        .join(", ")}），无法确定唯一目标`,
    };
  }
  if (hits.length === 1) {
    return {
      status: "ok",
      frameId: hits[0].frameId,
      ...(hits[0].value !== undefined ? { value: hits[0].value } : {}),
    };
  }
  if (ambiguous) return { status: "ambiguous", ...ambiguous };
  if (invalid) return { status: "invalid", message: invalid };
  return { status: "notFound" };
}

/**
 * 读取目标元素的文本（`extract` 的 dom 源）。
 *
 * 与 `runDomAction` 同样的跨 frame 归并：全局恰好一个 frame 命中才返回其文本；
 * 多 frame 冲突 / 同 frame 多命中 → `AMBIGUOUS_TARGET`，选择器写错 →
 * `SELECTOR_INVALID`，全部未命中 → `ELEMENT_NOT_FOUND`。绝不静默取第一个。
 */
export async function runDomRead(
  tabId: number,
  target: Target,
  frame?: FrameScope,
): Promise<{ ok: true; value: string } | { ok: false; error: LoginError }> {
  const outcome = await runDomAction(
    tabId,
    { action: "read", target },
    frame,
  );
  if (outcome.status === "ok") return { ok: true, value: outcome.value ?? "" };
  return {
    ok: false,
    error:
      toTargetError(outcome, describeTarget(target)) ??
      new LoginError(ErrorCodes.ELEMENT_NOT_FOUND, "未找到元素"),
  };
}

/** 把定位失败归一为带错误码的异常（供配方执行器抛出） */
export function toTargetError(
  outcome: DomOutcome,
  description: string,
  onNotFound: "fail" | "skip" = "fail",
): LoginError | null {
  switch (outcome.status) {
    case "ok":
      return null;
    case "notFound":
      return onNotFound === "skip"
        ? null
        : new LoginError(
            ErrorCodes.ELEMENT_NOT_FOUND,
            `未找到元素: ${description}`,
          );
    case "ambiguous":
      return new LoginError(
        ErrorCodes.AMBIGUOUS_TARGET,
        `定位不唯一（${outcome.message}）: ${description}`,
      );
    case "invalid":
      return new LoginError(
        ErrorCodes.SELECTOR_INVALID,
        `定位语法不合法（${outcome.message}）: ${description}`,
      );
    case "frameMissing":
      return new LoginError(
        ErrorCodes.FRAME_NOT_FOUND,
        `${outcome.message}，请重新拾取: ${description}`,
      );
    default:
      return new LoginError(
        ErrorCodes.ELEMENT_NOT_FOUND,
        `无法在页面中查找元素: ${description}（${outcome.message}）`,
      );
  }
}
