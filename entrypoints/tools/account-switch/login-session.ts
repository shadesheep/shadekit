/**
 * 登录会话（ADR-0004 D2）— 三条登录入口共享的 prelude + 会话日志 module。
 *
 * 拥有：
 * - 按 tab 的登录并发互斥锁
 * - 配置加载 → domain 解析 → 策略解析 → ctx 构建的 prelude 不变量
 *   （含「未配置策略」显式报错、debugRedirect 解析）
 * - AuthSession 会话日志生命周期（从 utils/debug-log.ts 迁入；
 *   debug-log 回归纯日志存储）
 *
 * 三条 handler 只剩：prepareLogin → 各自尾部（ADR-0003 D4 不合并）→ finalize。
 */

import {
  parseDebugRedirect,
  type DebugRedirectParts,
} from "./login-tab-flow";
import { readSpecFromConfig } from "./spec/migrate";
import type { LoginSpec } from "./spec/types";
import { ACCOUNT_SWITCH_CONFIG_DEFAULTS } from "./types";
import type {
  AccountSwitchConfig,
  AuthCredentials,
  DomainConfig,
} from "./types";
import {
  logEntry,
  newDebugEntry,
  type DebugAuthContext,
  type DebugBuffer,
} from "./utils/debug-log";
import type { DebugLogEntry } from "./types";
import { matchDomain } from "./utils/env";
import {
  ErrorCodes,
  errorCodeOf,
  LOGIN_BUSY_ERROR,
  type ErrorCode,
} from "./utils/error-codes";
import { RESTRICTED_PAGE_SCHEME, waitForTabLoaded } from "./utils/tab-load";
import { getConfig } from "../../shared/tool-config";

// ---------------------------------------------------------------------------
// 登录并发互斥锁（内化自 login-lock.ts）
//
// 基于 tabId 的内存锁：同一标签页同一时间只允许一个登录流程。
// 内存锁即可满足需求：background 是单例 service worker，所有登录请求都经过这里；
// worker 重启时进行中的异步流程本身也会被终止，锁随之一并清空。
// ---------------------------------------------------------------------------

const lockedTabs = new Set<number>();

// tryAcquire/release 导出仅供测试与调试；生产路径只经 prepareLogin / PreparedLogin.release
export function tryAcquireLoginLock(tabId: number): boolean {
  if (lockedTabs.has(tabId)) return false;
  lockedTabs.add(tabId);
  return true;
}

export function releaseLoginLock(tabId: number): void {
  lockedTabs.delete(tabId);
}

/** 查询指定 tab 是否正在登录（供测试与调试） */
export function isLoginLocked(tabId: number): boolean {
  return lockedTabs.has(tabId);
}

// ---------------------------------------------------------------------------
// AuthSession — 认证会话日志助手（从 debug-log.ts 迁入）
// ---------------------------------------------------------------------------

/** 认证会话日志助手 — 收敛 handler 中的日志样板代码 */
export class AuthSession {
  private readonly action: DebugLogEntry["action"];
  private readonly accountInfo: { name: string; username: string };
  private readonly origin: string;
  private readonly startTime: number;
  private readonly debugBuffer: DebugBuffer;
  private domainConfig: DomainConfig | null = null;
  private targetUrl: string;
  private debugRedirect?: string;

  constructor(
    action: DebugLogEntry["action"],
    accountInfo: { name: string; username: string },
    origin: string,
    targetUrl?: string,
    debugRedirect?: string,
  ) {
    this.action = action;
    this.accountInfo = accountInfo;
    this.origin = origin;
    this.targetUrl = targetUrl ?? origin;
    this.debugRedirect = debugRedirect;
    this.startTime = Date.now();
    this.debugBuffer = { startTime: this.startTime };
  }

  withDomain(config: DomainConfig): this {
    this.domainConfig = config;
    return this;
  }

  get buffer(): DebugBuffer {
    return this.debugBuffer;
  }

  fail(
    error: string,
    options?: { domainConfig?: DomainConfig | null; code?: ErrorCode },
  ): { success: false; error: string; errorCode?: ErrorCode } {
    const dc = options?.domainConfig ?? this.domainConfig;
    const entry = newDebugEntry(
      this.action,
      this.accountInfo,
      this.origin,
      dc,
      {
        success: false,
        error,
        errorCode: options?.code,
        duration: Date.now() - this.startTime,
      },
      this.debugBuffer,
      this.targetUrl,
      this.debugRedirect,
      this.debugBuffer.ops,
    );
    void logEntry(entry);
    return { success: false, error, errorCode: options?.code };
  }

  async logFinal(
    result: {
      success: boolean;
      error?: string;
      errorCode?: string;
      /** 逐算子轨迹（ADR-0015 D8）；缺省回退到 in-flight buffer 已累积的 */
      ops?: DebugLogEntry["ops"];
    },
    buffer: DebugBuffer,
  ): Promise<void> {
    const entry = newDebugEntry(
      this.action,
      this.accountInfo,
      this.origin,
      this.domainConfig,
      {
        success: result.success,
        error: result.error,
        errorCode: result.errorCode,
        duration: Date.now() - this.startTime,
      },
      buffer,
      this.targetUrl,
      this.debugRedirect,
      result.ops ?? buffer.ops,
    );
    await logEntry(entry);
  }
}

// ---------------------------------------------------------------------------
// prepareLogin — 登录 prelude
// ---------------------------------------------------------------------------

/**
 * 登录执行目标（ADR-0012 D9）。
 * - existing：在调用方已有的 tab 上执行（账号切换 / 当前 tab 快捷登录）
 * - new：先创建 tab 并等待加载，再用真实 id 构建 ctx（新标签页快捷登录）
 */
export type ExecTarget =
  | { kind: "existing"; tabId: number }
  | { kind: "new"; url: string };

export interface PrepareLoginInput {
  action: DebugLogEntry["action"];
  account: { name: string; username: string };
  credentials: AuthCredentials;
  /** targetKind 为 'origin' 时传 origin；为 'url' 时传完整目标 URL */
  target: string;
  targetKind: "origin" | "url";
  debugRedirect?: string;
  /** 登录步骤的执行目标（ADR-0012 D9） */
  execTarget: ExecTarget;
}

export interface PreparedLogin {
  session: AuthSession;
  spec: LoginSpec;
  ctx: DebugAuthContext;
  domainConfig: DomainConfig;
  /** quick-login 且 debugRedirect 合法时的解析结果；否则 null */
  redirect: DebugRedirectParts | null;
  /** 实际执行登录的 origin（debugRedirect origin 优先） */
  origin: string;
  /** 实际执行登录的 tab（new 路径为本次新建的 tab） */
  execTabId: number;
  /** new 路径本次新建的 tab id；existing 路径为 undefined */
  createdTabId?: number;
  /**
   * 释放登录锁（幂等）。
   * 失败路径传 `{ closeExecTab: true }`：关闭本次新建的 tab，不留空标签页。
   */
  release(options?: { closeExecTab?: boolean }): void;
}

export type PrepareLoginOutcome =
  | { ok: true; prepared: PreparedLogin }
  | { ok: false; error: string; errorCode?: ErrorCode };

/**
 * 登录 prelude：执行 tab 准备 → 互斥锁 → 配置 → URL/domain 解析 → 策略解析 → ctx 构建。
 *
 * execTarget（ADR-0012 D9）：
 * - `new`：先后台创建 tab 并等待加载，用真实 id 构建 ctx；后续任何失败都关闭该 tab。
 * - `existing`：沿用调用方 tab；tabId 缺失时显式报错，绝不把 0 当作执行 tab。
 * 登录锁以**执行 tab** 为键（来源 tab 只用于回滚与日志）。
 *
 * 失败路径已写会话日志（锁占用拒绝除外——不形成会话，不打日志），
 * 并释放锁、关闭本次新建的 tab。
 */
export async function prepareLogin(
  input: PrepareLoginInput,
): Promise<PrepareLoginOutcome> {
  const session = new AuthSession(
    input.action,
    input.account,
    input.target,
    input.target,
    input.debugRedirect,
  );

  let lockedTabId: number | undefined;
  let createdTabId: number | undefined;

  const releaseLock = () => {
    if (lockedTabId !== undefined) releaseLoginLock(lockedTabId);
    lockedTabId = undefined;
  };
  const closeCreatedTab = () => {
    if (createdTabId === undefined) return;
    const tabId = createdTabId;
    createdTabId = undefined;
    void chrome.tabs.remove(tabId).catch(() => {
      // tab 可能已被用户关闭：关闭失败无需打断登录结果
    });
  };
  const fail = (
    error: string,
    options?: { domainConfig?: DomainConfig | null; code?: ErrorCode },
  ): PrepareLoginOutcome => {
    releaseLock();
    closeCreatedTab();
    const r = session.fail(error, options);
    return { ok: false, error: r.error, errorCode: r.errorCode };
  };

  // ---- 1. 执行目标：先校验，再准备 tab / 锁 ----
  if (input.execTarget.kind === "existing") {
    const tabId = input.execTarget.tabId;
    if (!Number.isInteger(tabId) || tabId <= 0) {
      return fail("无法确定执行页面：请先在目标页面打开账号切换", {
        code: ErrorCodes.TAB_CLOSED,
      });
    }
    // 执行 tab 是扩展页/浏览器内置页（如 options 页被当成执行目标）时，
    // 无权对其注入/导航，提前给出明确错误而非底层抛 [UNKNOWN]
    let execTabUrl = "";
    try {
      const execTab = await chrome.tabs.get(tabId);
      execTabUrl = execTab.url || execTab.pendingUrl || "";
    } catch {
      // tab 已关闭或 chrome.tabs.get 不可用（测试 stub）：留给后续步骤处理
    }
    if (execTabUrl && RESTRICTED_PAGE_SCHEME.test(execTabUrl)) {
      const scheme = execTabUrl.slice(0, execTabUrl.indexOf(":"));
      return fail(
        `执行目标受限 (${scheme}://)：请先打开目标系统页面再点登录/验证，而不是在浏览器内置页或扩展页上操作`,
        { code: ErrorCodes.TAB_RESTRICTED },
      );
    }
    if (!tryAcquireLoginLock(tabId)) {
      return {
        ok: false,
        error: LOGIN_BUSY_ERROR,
        errorCode: ErrorCodes.LOGIN_BUSY,
      };
    }
    lockedTabId = tabId;
  } else {
    try {
      // eslint-disable-next-line no-new
      new URL(input.execTarget.url);
    } catch {
      return fail("目标 URL 格式无效", { code: ErrorCodes.INVALID_URL });
    }
  }

  try {
    // quick-login 传完整 URL：解析出 origin；switch 直接给 origin
    let urlObj: URL | null = null;
    let origin = input.target;
    if (input.targetKind === "url") {
      try {
        urlObj = new URL(input.target);
      } catch {
        return fail("目标 URL 格式无效", { code: ErrorCodes.INVALID_URL });
      }
      origin = urlObj.origin;
    }

    // 解析 debugRedirect（ADR-0003 D4：URL 推导规则收口至 login-tab-flow）
    let redirect: DebugRedirectParts | null = null;
    if (input.targetKind === "url" && input.debugRedirect && urlObj) {
      redirect = parseDebugRedirect(input.debugRedirect, urlObj);
      if (!redirect) {
        return fail("跳转地址格式无效", {
          code: ErrorCodes.INVALID_REDIRECT_URL,
        });
      }
    }

    // 新 tab 路径：登录在 redirect origin（若有）完成；先建 tab 再构建 ctx
    if (input.execTarget.kind === "new") {
      const createUrl = redirect?.origin || input.execTarget.url;
      let newTabId: number | undefined;
      try {
        const created = await chrome.tabs.create({
          url: createUrl,
          active: false,
        });
        newTabId = created.id;
      } catch {
        newTabId = undefined;
      }
      if (!newTabId) {
        return fail("无法打开登录页面：新建标签页失败", {
          code: ErrorCodes.TAB_CLOSED,
        });
      }
      createdTabId = newTabId;
      await waitForTabLoaded(newTabId);
      if (!tryAcquireLoginLock(newTabId)) {
        return fail(LOGIN_BUSY_ERROR, { code: ErrorCodes.LOGIN_BUSY });
      }
      lockedTabId = newTabId;
    }

    const config = await getConfig<AccountSwitchConfig>(
      "account-switch",
      ACCOUNT_SWITCH_CONFIG_DEFAULTS,
    );
    if (!config) {
      return fail("配置未找到", { code: ErrorCodes.CONFIG_NOT_FOUND });
    }

    const domainResult = resolveDomain(config, origin);
    if (!domainResult) {
      return fail("未找到匹配的环境配置", {
        code: ErrorCodes.ENV_NOT_MATCHED,
      });
    }
    const { domainConfig } = domainResult;

    const { spec, invalid } = readSpecFromConfig(domainConfig, config.strategies);
    if (!spec) {
      // NO_STRATEGY / STRATEGY_NOT_FOUND 语义保留（自旧 resolveStrategy）：
      // legacy 扩展 key（形如 author@name，已随插件市场移除）→ STRATEGY_NOT_FOUND；
      // 其余未配置 → NO_STRATEGY。
      const key = domainConfig.loginMethod || "";
      const legacy = key.includes("@");
      return fail(
        legacy
          ? `登录策略不可用: ${key}（该扩展已随插件市场移除，请在环境配置中改选内置登录方式）`
          : (invalid ?? "未配置登录策略：请在环境配置中为该域名选择登录方式"),
        {
          domainConfig,
          code: legacy ? ErrorCodes.STRATEGY_NOT_FOUND : ErrorCodes.NO_STRATEGY,
        },
      );
    }

    session.withDomain(domainConfig);

    const effectiveOrigin = redirect?.origin || origin;
    const execTabId = lockedTabId!;
    // ADR-0015 D4 的 `targetUrl` / `debugRedirect` 输入暂不在 prelude 填充：
    // 迁移出的快照 spec 以 `goto {targetUrl}` 结尾，03a 期间 capture / restore
    // 仍由既有阶段执行；提前填值会让这次 goto 在 capture 之前落地，改变快照
    // 捕获的 origin。待快照算子接进 runSpec 时一并接线。
    const ctx: DebugAuthContext = {
      tabId: execTabId,
      origin: effectiveOrigin,
      domainConfig,
      credentials: input.credentials,
      tokenData: null,
      debugBuffer: session.buffer,
    };

    let released = false;
    const preparedCreatedTabId = createdTabId;
    return {
      ok: true,
      prepared: {
        session,
        spec,
        ctx,
        domainConfig,
        redirect,
        origin: effectiveOrigin,
        execTabId,
        createdTabId: preparedCreatedTabId,
        release: (options?: { closeExecTab?: boolean }) => {
          if (released) return;
          released = true;
          releaseLock();
          if (options?.closeExecTab) closeCreatedTab();
        },
      },
    };
  } catch (e: unknown) {
    return fail(e instanceof Error ? e.message : "未知错误", {
      code: errorCodeOf(e),
    });
  }
}

/**
 * 解析 origin 对应的 domain 配置。
 * v1.1.4：`apiBase` 字段已从 DomainConfig 删除；spec 模板变量只剩 `{origin}`。
 */
function resolveDomain(
  config: AccountSwitchConfig,
  origin: string,
): { domainConfig: DomainConfig } | null {
  const domains =
    config.domains && typeof config.domains === "object" ? config.domains : {};
  for (const [domain, env] of Object.entries(domains)) {
    if (matchDomain(domain, origin)) {
      return { domainConfig: env };
    }
  }
  return null;
}
