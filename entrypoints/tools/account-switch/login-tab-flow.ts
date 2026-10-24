/**
 * quick-login 标签页编排
 *
 * 两条 quick-login 路径（当前 tab / 新 tab）共享的 tab 编排逻辑收口于此：
 * - parseDebugRedirect / resolvePostLoginUrl：纯函数，URL 推导规则的唯一来源
 * - setupAuthTab：create-at-url → wait → restore → injectAuth → reload（新 tab 路径尾部）。
 *   复用已加载 tab 时同 URL 不再导航，刷新在后台完成后再激活（D18）
 * - injectAndNavigate：注入后导航 + 失败回滚（当前 tab 路径尾部），
 *   拥有「注入登录态失败必须关闭新建 tab 回滚、绝不静默导航成假登录」不变量
 *
 * 认证快照（ADR-0012 D6/D7）：capture 由 spec 的 `auth.capture` 算子在
 * **登录 origin** 执行；restore 只在本模块内、目标 origin 的文档上执行——
 * spec 层不得自行挑选 tab 写 storage。
 */

import type {
  NavigationIntent,
  TokenData,
} from "./types";
import { restoreAuth, type CapturedAuth } from "./utils/auth-snapshot";
import {
  ErrorCodes,
  errorCodeOf,
  type ErrorCode,
} from "./utils/error-codes";
import { reloadTabAndWait, waitForTabLoaded } from "./utils/tab-load";

/**
 * 复用 tab 路径上「刷新后等待可见」的上限。
 * 超时不报错——刷新已经发起，页面慢不该把已成功的登录判成失败，到点直接激活。
 */
const ACTIVATE_WAIT_TIMEOUT = 10000;

/** 读取 tab 当前地址；失败（已关闭/无权限）时返回 null，由调用方降级为「需要导航」 */
async function currentTabUrl(tabId: number): Promise<string | null> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.pendingUrl || tab.url || null;
  } catch {
    return null;
  }
}

/** debugRedirect 解析结果：跳转站点 + 保留自 targetUrl 的路径部分 + 完整目标 */
export interface DebugRedirectParts {
  /** debugRedirect 的 origin（登录与最终导航的站点） */
  origin: string;
  /** targetUrl 的 path + query + hash（保证以 / 开头） */
  hashPath: string;
  /** origin + hashPath 拼出的完整跳转目标 */
  fullUrl: string;
}

/**
 * 解析 debugRedirect：取其 origin（如 debugRedirect 指定的本地服务地址），
 * 但保留 targetUrl 的 path + query + hash（如 /#/develop/dbm/script/page?pId=...），
 * 两者拼接为最终的跳转目标。
 * debugRedirect 不是合法 URL 时返回 null，由调用方报 INVALID_REDIRECT_URL。
 */
export function parseDebugRedirect(
  debugRedirect: string,
  target: Pick<URL, "pathname" | "search" | "hash">,
): DebugRedirectParts | null {
  let redirectObj: URL;
  try {
    redirectObj = new URL(debugRedirect);
  } catch {
    return null;
  }
  let hashPath = target.pathname + target.search + (target.hash || "");
  if (hashPath && !hashPath.startsWith("/")) {
    hashPath = "/" + hashPath;
  }
  const origin = redirectObj.origin;
  return { origin, hashPath, fullUrl: origin + hashPath };
}

/**
 * 推导登录后的落地 URL（新 tab 路径、无 debugRedirect 时）。
 * ADR-0015 D12：debugRedirect > targetUrl > lastGotoUrl > origin。
 * 调用方在 debugRedirect 命中时不会走此函数，因此这里只剩 targetUrl / origin 两档。
 */
export function resolvePostLoginUrl(opts: {
  hasUrl: boolean;
  targetUrl: string;
  origin: string;
}): string {
  return opts.hasUrl ? opts.targetUrl : opts.origin;
}

/**
 * 在目标 tab 上设置认证数据并刷新。
 *
 * 不变量（ADR-0012 D7）：localStorage/sessionStorage 是 origin 作用域的，
 * 必须在**目标 origin 的文档内**写入，序列固定为：
 *   (create tab @ targetOrigin) → waitForTabLoaded → restore → injectAuth → reload
 * `set storage` 包含两步：先按快照规格恢复（restoreAuth），再显式注入 token
 * （跨 origin 场景；同 origin 的会话已由 spec 的 `clear.*` / `auth.write` 写就）。
 *
 * 调用方传入 `execTab` 时复用该 tab（新 tab 快捷登录路径：prelude 已创建并加载完成），
 * 不再二次 `tabs.create`；未传入时按 createUrl 新建。
 *
 * 复用路径的两条补充规则（ADR-0012 D18）：
 * - **同 URL 不导航**：tab 由 prelude 建在该 URL 上并已加载完成，再
 *   `tabs.update({ url: 同一 URL })` 是一次多余的整页加载；只有目标 URL 与
 *   当前地址不同（如 debugRedirect 换了 origin、或页面 boot 时自行跳走）才导航。
 * - **激活延后到刷新之后**：用户看到的第一次加载应当是最终结果页，而不是
 *   一次中间态白屏。reload 仍必要（SPA 启动早于注入，必须重启才能读到新 token），
 *   但它发生在后台，等待完成后再激活。
 *
 * 返回实际使用的 tab id。
 */
export async function setupAuthTab(
  injectAuth: ((tabId: number, tokenData: TokenData) => Promise<void>) | undefined,
  origin: string,
  createUrl: string,
  tokenData: TokenData,
  options?: {
    /** 复用已有 tab（跳过 create） */
    execTab?: { tabId: number };
    /**
     * 登录 origin 上捕获的认证快照（D6）。
     * 提供时在**目标 origin 的文档内**恢复（D7 的第 3.5 步）。
     * 会话清理与写入已由 spec 的 `clear.*` / `auth.write` 算子完成，
     * 尾部只需恢复跨 origin 快照与显式注入 token。
     */
    capturedAuth?: CapturedAuth;
  },
): Promise<number> {
  let tabId = options?.execTab?.tabId;
  const reuseTab = tabId !== undefined;
  if (tabId === undefined) {
    const newTab = await chrome.tabs.create({ url: createUrl, active: true });
    tabId = newTab.id!;
    await waitForTabLoaded(tabId);
  } else if ((await currentTabUrl(tabId)) !== createUrl) {
    // 仅当地址真的不同才导航；不带 active，激活统一放到最后
    await chrome.tabs.update(tabId, { url: createUrl });
    await waitForTabLoaded(tabId);
  }

  // D7：目标 origin 文档内恢复登录态。顺序在导航/reload 之前，避免被整页
  // 加载冲掉；storage 写入必须在目标 origin 文档内（origin 不符报错）。
  if (options?.capturedAuth) {
    await restoreAuth(
      origin,
      tabId,
      options.capturedAuth.spec,
      options.capturedAuth.snapshot,
    );
  }
  // 跨 origin 场景：登录 origin 的 `auth.write` 无法写到目标 tab，显式注入 token
  if (injectAuth && tokenData) {
    await injectAuth(tabId, tokenData);
  }

  if (!reuseTab) {
    await chrome.tabs.reload(tabId);
    return tabId;
  }

  // 复用路径：刷新在后台完成后再激活。超时/失焦都不算登录失败——刷新已发起，
  // 页面慢只是白屏久一点，结果仍由页面自身决定。
  try {
    await reloadTabAndWait(tabId, ACTIVATE_WAIT_TIMEOUT);
  } catch (e: unknown) {
    const code = errorCodeOf(e);
    // tab 真的没了才算失败；超时/受限页面一律降级为「直接激活」
    if (code === ErrorCodes.TAB_CLOSED) throw e;
  }
  await chrome.tabs.update(tabId, { active: true });
  return tabId;
}

export interface InjectAndNavigateOptions {
  /** 跨 origin 登录态注入（登录 origin 的 auth.write 无法写到目标 tab 时用） */
  injectAuth?: (tabId: number, tokenData: TokenData) => Promise<void>;
  /** 登录结果数据（runSpec 的绑定表）；为空时不注入不导航 */
  tokenData: TokenData | undefined;
  /** 当前 tab（无 redirect 时的注入/导航目标）；无法解析时可缺省 */
  currentTabId?: number;
  /** debugRedirect 解析结果；为 null/缺省时在当前 tab 注入 */
  redirect?: DebugRedirectParts | null;
  targetUrl: string;
  hasUrl: boolean;
  /**
   * 策略 afterLogin 收集到的导航决策（ADR-0012 D10）。
   * 仅在「无明确目标 URL」（`hasUrl === false` 且无 redirect）时生效，
   * 优先级低于 redirect / targetUrl。
   */
  fallbackIntent?: NavigationIntent;
  /**
   * 登录 origin 上捕获的认证快照（D6）。注入目标 tab 位于目标 origin 时恢复；
   * 不在此 origin 的 tab 上恢复（D7：写错 origin 等于没写）。
   */
  capturedAuth?: CapturedAuth;
  /**
   * 快照恢复的目标 origin（通常即登录 origin = `prepared.origin`）。
   * 注入 tab 不在该 origin 且规格声明了 storage 时，restoreAuth 会抛
   * `INJECT_AUTH_FAILED` 说明原因，绝不静默写错 origin。
   */
  capturedAuthOrigin?: string;
  /**
   * 注入之后、导航之前的钩子（如持久化调试日志）。
   * 保持「注入 → 记日志 → 导航」的既有顺序：导航抛错时日志已落盘。
   */
  onBeforeNavigate?: () => Promise<void>;
}

export type InjectAndNavigateResult =
  | { success: true }
  | { success: false; error: string; errorCode: ErrorCode };

/**
 * 注入登录态并导航（当前 tab 路径尾部）。
 *
 * 不变量：注入失败必须显性化并回滚——redirect 模式下刚创建的新 tab
 * 未注入成功，导航过去也是未登录页，必须直接关闭；绝不静默导航成「假登录」。
 */
export async function injectAndNavigate(
  opts: InjectAndNavigateOptions,
): Promise<InjectAndNavigateResult> {
  const { injectAuth, tokenData, currentTabId, redirect, targetUrl, hasUrl } =
    opts;
  // redirect 模式：先建 tab 到 redirect origin，注入 token 后再导航到完整 URL
  let newTabId: number | undefined;
  if (redirect && tokenData) {
    const newTab = await chrome.tabs.create({
      url: redirect.origin,
      active: true,
    });
    newTabId = newTab.id!;
    await waitForTabLoaded(newTabId);
  }

  // 注入失败必须显性化：不再静默导航导致「假登录」
  const injectTabId = newTabId ?? (tokenData ? currentTabId : undefined);
  if (injectTabId && tokenData) {
    try {
      await injectAuth?.(injectTabId, tokenData);
      // 快照恢复：与 injectAuth 同属「注入登录态」，失败走同一回滚路径。
      // 与 injectAuth 同属「注入登录态」，失败走同一回滚路径。
      if (opts.capturedAuth && opts.capturedAuthOrigin) {
        await restoreAuth(
          opts.capturedAuthOrigin,
          injectTabId,
          opts.capturedAuth.spec,
          opts.capturedAuth.snapshot,
        );
      }
    } catch (e: unknown) {
      // 刚创建的新 tab 未注入成功，导航过去也是未登录页，直接关闭
      if (newTabId) {
        await chrome.tabs.remove(newTabId);
      }
      return {
        success: false,
        error: `注入登录状态失败: ${e instanceof Error ? e.message : "未知错误"}`,
        errorCode: ErrorCodes.INJECT_AUTH_FAILED,
      };
    }
  }

  // 注入之后、导航之前：调用方落盘调试日志（导航抛错时日志已持久化）
  await opts.onBeforeNavigate?.();

  if (newTabId && redirect) {
    await chrome.tabs.update(newTabId, { url: redirect.fullUrl });
  } else if (tokenData && currentTabId) {
    if (hasUrl) {
      await chrome.tabs.update(currentTabId, { url: targetUrl });
    } else if (opts.fallbackIntent) {
      // 无明确目标 URL：策略的 afterLogin 决策作为 fallback（ADR-0012 D10）
      await applyNavigationIntent(currentTabId, opts.fallbackIntent);
    } else {
      await chrome.tabs.reload(currentTabId);
    }
  }

  return { success: true };
}

/**
 * 导航意图的唯一执行点（ADR-0004 D4）。
 * 策略 afterLogin 只返回意图；tab 变更收口在本 module，
 * 与「注入失败必须关 tab 回滚」不变量同一 owner。
 */
export async function applyNavigationIntent(
  tabId: number,
  intent: NavigationIntent,
): Promise<void> {
  switch (intent.action) {
    case "navigate":
      await chrome.tabs.update(tabId, { url: intent.url });
      break;
    case "reload":
      await chrome.tabs.reload(tabId);
      break;
    case "none":
      break;
  }
}

/**
 * 账号切换（SWITCH_ACCOUNT）成功后的尾部：让页面用新会话重新加载。
 *
 * 旧引擎由 `afterLogin` 阶段承担（无 redirect 时返回 `{ action: "reload" }`，
 * 有 `?redirect=` 时导航过去）。执行收敛到 `runSpec` 后该阶段被删除，spec
 * 也不负责刷新，于是「登录成功但页面停在旧会话」。
 *
 * 沿用旧 `afterLogin` 的决策：优先解析当前 tab 的 `?redirect=` 登录页回跳约定，
 * 没有则原地刷新。刷新是 SPA 读到新 token 的唯一手段（ADR-0012 D18）。
 */
export async function refreshAfterSwitch(
  tabId: number,
  origin: string,
): Promise<void> {
  let redirectUrl: string | null = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    const current = tab.url || tab.pendingUrl || "";
    if (current) {
      const target = new URL(current).searchParams.get("redirect");
      if (target) {
        redirectUrl = target.startsWith("http")
          ? target
          : `${origin}${target.startsWith("/") ? "" : "/"}${target}`;
      }
    }
  } catch {
    // tab 已关闭 / 地址不可解析：按无 redirect 降级为刷新
  }

  await applyNavigationIntent(
    tabId,
    redirectUrl ? { action: "navigate", url: redirectUrl } : { action: "reload" },
  );
}
