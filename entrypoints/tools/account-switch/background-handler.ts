/**
 * 账号切换工具的 background 消息处理
 * 声明驱动：执行环境里的 `strategyConfig.spec`（见 spec/run.ts）
 *
 * 架构：单一执行器 `runSpec`
 * - 登录 prelude（锁/配置/声明读取/ctx/会话日志）收口在 login-session.ts（ADR-0004 D2）
 * - tab 生命周期编排收口在 login-tab-flow.ts（ADR-0003 D4）
 * - 新增登录方式只需提供新的可序列化声明，无需修改此文件
 */

import { authLog } from "../../shared/logger";
import { runLoginSpec } from "./spec/login-run";
import type { FormScanFrame } from "./config/login-form-scan";
import {
  injectAndNavigate,
  refreshAfterSwitch,
  resolvePostLoginUrl,
  setupAuthTab,
} from "./login-tab-flow";
import { prepareLogin } from "./login-session";
import type { DryRunStepResult } from "./strategies/generic-dry-run";
import { normalizeRecipe } from "./strategies/generic-recipe";
import type { RecipeStepTrace } from "./strategies/generic-runner";
import type { Account, AuthContext } from "./types";
import type { ErrorCode } from "./utils/error-codes";
import { ErrorCodes, errorCodeOf } from "./utils/error-codes";
import { runTrialLogin } from "./spec/trial";
import type { TrialSignalState } from "./spec/run";
import type { LoginSpec } from "./spec/types";

type LoginResponse = {
  success: boolean;
  error?: string;
  errorCode?: ErrorCode;
  recipeSteps?: RecipeStepTrace[];
};

/** 获取当前 tabId，优先使用 sender.tab（content script 来源），否则回退到查询当前活动 tab。 */
async function getTabId(
  sender: chrome.runtime.MessageSender,
): Promise<number | undefined> {
  return (
    sender.tab?.id ??
    (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id
  );
}

/**
 * 从 extension 页面（options/popup）发起登录时，找账号第一个绑定环境的「可打开
 * URL」：环境 key 本身是具体地址（非通配符）直接用；通配符无法直接打开，返回
 * null（由调用方给明确提示，引导用户先手动打开目标页面或改配具体环境）。
 * 不做真实 URL 校验（交给 new URL 或在 new-tab prelude 里报错）。
 */
export async function resolveOpenableUrl(domainKey: string): Promise<string | null> {
  if (!domainKey) return null;
  // 环境 key 通常是「协议://host[:port][/path]」形态；含 * 是通配符，无法直接打开
  if (domainKey.includes("*")) return null;
  return domainKey.trim();
}

/**
 * 兼容旧 API 登录的会话注入（跨 origin 重定向时用）。
 *
 * `auth.write` 在登录 origin 的 tab 上写会话；跳转到目标 origin 的新 tab 时，
 * 该 origin 的文档没有 token——取绑定里的 `token`，连同整份绑定值注入目标
 * tab 的 localStorage。键名保持旧配置兼容，不应用于新策略。
 */
function createLegacyTokenInjector(): (tabId: number, tokenData: Record<string, unknown> | null) => Promise<void> {
  return async (tabId, tokenData) => {
    if (!tokenData) return;
    const token = typeof tokenData.token === "string" ? tokenData.token : "";
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (tk: string, dataStr: string) => {
        localStorage.setItem("auth", dataStr);
        localStorage.setItem("token", tk);
      },
      args: [token, JSON.stringify(tokenData)],
    });
  };
}

/**
 * 处理账号切换请求（来自 SwitcherPanel 面板的用户操作）。
 * prelude 归 login-session；本函数只剩：runLoginSpec → 记日志 → 返回。
 *
 * 从 extension 页面（options/popup，sender.tab 缺省、活动 tab 是扩展页自身）
 * 发起的登录无法在受限扩展页上执行（TAB_RESTRICTED）。此时若账号首环境可
 * 解析出具体 URL，改走「新建 tab + 登录」路径；否则返回明确提示（而非底层报错）。
 */
export async function handleSwitchAccount(
  account: Account,
  origin: string,
  sender: chrome.runtime.MessageSender,
): Promise<LoginResponse> {
  // options/popup 环境：sender.tab 缺省（非 content script 来源）
  if (!sender.tab) {
    const openableUrl = await resolveOpenableUrl(origin);
    if (openableUrl) {
      return handleQuickLoginInNewTab(
        openableUrl,
        account.username,
        account.password,
        true,
      );
    }
    return {
      success: false,
      error:
        `执行目标受限 (chrome-extension://)：请先打开目标系统页面再点登录。` +
        `该账号绑定的环境「${origin}」是通配符，无法自动打开，` +
        `请先手动打开目标页面后用内容面板登录，或改配具体环境地址。`,
      errorCode: ErrorCodes.TAB_RESTRICTED,
    };
  }
  const tabId = await getTabId(sender);
  const outcome = await prepareLogin({
    action: "SWITCH_ACCOUNT",
    account: { name: account.name, username: account.username },
    credentials: { username: account.username, password: account.password },
    target: origin,
    targetKind: "origin",
    execTarget: { kind: "existing", tabId: tabId ?? 0 },
  });
  if (!outcome.ok) {
    return { success: false, error: outcome.error, errorCode: outcome.errorCode };
  }
  const { prepared } = outcome;
  let success = false;

  try {
    const loginResult = await runLoginSpec(prepared.spec, prepared.ctx);
    await prepared.session.logFinal(
      loginResult,
      prepared.ctx.debugBuffer ?? prepared.session.buffer,
    );

    if (!loginResult.success) {
      return {
        success: false,
        error: loginResult.error,
        errorCode: loginResult.errorCode,
        recipeSteps: loginResult.recipeSteps,
      };
    }

    // 尾部刷新/跳转（旧 afterLogin 阶段的等价物）：spec 只负责把会话写进去，
    // SPA 必须整页重启才能读到新 token（ADR-0012 D18 / ADR-0015 D12）。
    // 刷新失败不把已成功的登录判死——会话已落库，用户手动刷新即可恢复。
    try {
      await refreshAfterSwitch(prepared.execTabId, prepared.origin);
    } catch (e: unknown) {
      authLog.warn(
        `账号切换成功后刷新页面失败：${e instanceof Error ? e.message : "未知错误"}`,
        {
          account: { name: account.name, username: account.username },
          extra: { action: "SWITCH_ACCOUNT_REFRESH" },
        },
      );
    }
    success = true;
    return { success: true };
  } catch (e: unknown) {
    return prepared.session.fail(e instanceof Error ? e.message : "未知错误", {
      code: errorCodeOf(e),
    });
  } finally {
    prepared.release({ closeExecTab: !success });
  }
}

/**
 * 试登录：在后台上下文执行一次 spec，默认零副作用。
 *
 * 不申请登录锁、不创建 tab、不触达用户当前标签页——它只按环境配置的地址
 * 发请求并判定数据成功信号。仅当 `writeSession` 为 true 时才执行 `auth.write`
 * （「能换到凭据」→「已登录」的分界）。返回值不暴露完整响应体。
 */
export async function handleTrialLogin(input: {
  spec: LoginSpec;
  origin: string;
  username: string;
  password: string;
  writeSession?: boolean;
}): Promise<{
  ok: boolean;
  error?: string;
  errorCode?: ErrorCode;
  signals: TrialSignalState[];
  requestSent: boolean;
  sessionWritten: boolean;
}> {
  const { spec, origin, username, password } = input;
  if (!spec || !Array.isArray(spec.ops)) {
    return {
      ok: false,
      error: "登录声明无效",
      errorCode: ErrorCodes.CONFIG_INVALID,
      signals: [],
      requestSent: false,
      sessionWritten: false,
    };
  }
  const ctx: AuthContext = {
    tabId: -1,
    origin,
    domainConfig: {
      name: "trial",
      tags: [],
    },
    credentials: { username, password },
    tokenData: null,
    targetUrl: "",
    debugRedirect: "",
  };
  try {
    const result = await runTrialLogin(spec, ctx, {
      writeSession: input.writeSession === true,
    });
    return {
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
      ...(result.errorCode ? { errorCode: result.errorCode as ErrorCode } : {}),
      signals: result.signals,
      requestSent: result.requestSent,
      sessionWritten: result.sessionWritten,
    };
  } catch (e: unknown) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      errorCode: errorCodeOf(e),
      signals: [],
      requestSent: false,
      sessionWritten: false,
    };
  }
}
export async function handleTestRecipe(
  recipeInput: unknown,
  origin: string,
  sender: chrome.runtime.MessageSender,
  tabId?: number,
  only?: number[],
): Promise<{
  success: boolean;
  error?: string;
  errorCode?: ErrorCode;
  steps: DryRunStepResult[];
}> {
  const { recipe, invalid } = normalizeRecipe(recipeInput);
  if (invalid) {
    return { success: false, error: invalid, errorCode: ErrorCodes.CONFIG_INVALID, steps: [] };
  }

  const targetTabId = tabId ?? (await getTabId(sender));
  if (targetTabId === undefined || targetTabId <= 0) {
    return {
      success: false,
      error: "找不到用于试跑的标签页",
      errorCode: ErrorCodes.CONFIG_INVALID,
      steps: [],
    };
  }

  const { runRecipeDryRun } = await import("./strategies/generic-dry-run");
  try {
    const result = await runRecipeDryRun(targetTabId, origin, "", recipe, only);
    const failed = result.steps.find((s) => s.status === "error");
    return {
      success: !failed,
      ...(failed
        ? { error: failed.error, errorCode: failed.errorCode as ErrorCode }
        : {}),
      steps: result.steps,
    };
  } catch (e: unknown) {
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
      errorCode: errorCodeOf(e),
      steps: [],
    };
  }
}

/**
 * 一键识别登录表单（ADR-0013 D8）。
 *
 * 只读扫描：不点击、不提交、不写存储，识别结果由配置页确认后才回填配方。
 * 失败时把「未找到」也作为正常结果返回（success: true + 空 frames），
 * 只有注入失败 / 找不到 tab 才是错误。
 */
export async function handleScanLoginForm(
  sender: chrome.runtime.MessageSender,
  tabId?: number,
): Promise<{
  success: boolean;
  error?: string;
  errorCode?: ErrorCode;
  frames: FormScanFrame[];
}> {
  const targetTabId = tabId ?? (await getTabId(sender));
  if (targetTabId === undefined || targetTabId <= 0) {
    return {
      success: false,
      error: "找不到用于识别的标签页",
      errorCode: ErrorCodes.CONFIG_INVALID,
      frames: [],
    };
  }

  const { scanLoginForm } = await import("./config/login-form-scan");
  const result = await scanLoginForm(targetTabId);
  switch (result.status) {
    case "found":
      return { success: true, frames: result.frames };
    case "notFound":
      return { success: true, frames: [] };
    case "error":
      return {
        success: false,
        error: result.message,
        errorCode:
          result.code === "NO_TAB"
            ? ErrorCodes.CONFIG_INVALID
            : ErrorCodes.TAB_RESTRICTED,
        frames: [],
      };
  }
}

/**
 * 快速登录（在当前 tab 执行）。
 * debugRedirect 存在时：使用该 origin 登录，注入 token 后导航到 debugRedirect origin + path/hash。
 * 否则：在当前 tab 刷新或导航到 targetUrl。
 */
export async function handleQuickLogin(
  targetUrl: string,
  username: string,
  password: string,
  hasUrl: boolean,
  sender: chrome.runtime.MessageSender,
  debugRedirect?: string,
): Promise<LoginResponse> {
  const tabId = await getTabId(sender);
  const outcome = await prepareLogin({
    action: "QUICK_LOGIN",
    account: { name: username, username },
    credentials: { username, password },
    target: targetUrl,
    targetKind: "url",
    debugRedirect,
    execTarget: { kind: "existing", tabId: tabId ?? 0 },
  });
  if (!outcome.ok) {
    return { success: false, error: outcome.error, errorCode: outcome.errorCode };
  }
  const { prepared } = outcome;
  const { session } = prepared;
  let success = false;

  try {
    // afterLogin 导航由 spec 的 `goto` / 尾部导航唯一执行点承担（login-tab-flow）。
    const loginResult = await runLoginSpec(prepared.spec, prepared.ctx);
    if (!loginResult.success) {
      await session.logFinal(loginResult, session.buffer);
      return {
        success: false,
        error: loginResult.error,
        errorCode: loginResult.errorCode,
        recipeSteps: loginResult.recipeSteps,
      };
    }

    // 登录成功后注入 token 再导航；注入失败由 login-tab-flow 关闭新建 tab 回滚，
    // 绝不静默导航成「假登录」。onBeforeNavigate 保持「注入 → 记日志 → 导航」
    // 的既有顺序：导航抛错时成功日志已落盘。
    const navResult = await injectAndNavigate({
      injectAuth: createLegacyTokenInjector(),
      tokenData: loginResult.data ?? null,
      currentTabId: prepared.execTabId,
      redirect: prepared.redirect,
      targetUrl,
      hasUrl,
      // 快照模式（D6）：登录 origin 上捕获的认证态在目标 origin 的 tab 上恢复。
      // 恢复目标遵循与导航相同的 origin 推导：redirect origin 优先。
      capturedAuth: loginResult.capturedAuth,
      capturedAuthOrigin: prepared.redirect?.origin ?? prepared.origin,
      onBeforeNavigate: () =>
        session.logFinal(loginResult, session.buffer),
    });

    if (!navResult.success) {
      await session.logFinal(
        {
          success: false,
          error: navResult.error,
          errorCode: navResult.errorCode,
        },
        session.buffer,
      );
      return {
        success: false,
        error: navResult.error,
        errorCode: navResult.errorCode,
      };
    }
    success = true;
    return { success: true };
  } catch (e: unknown) {
    return session.fail(e instanceof Error ? e.message : "未知错误", {
      code: errorCodeOf(e),
    });
  } finally {
    prepared.release({ closeExecTab: !success });
  }
}

/**
 * 快速登录（始终打开新 tab）。
 * 与 handleQuickLogin 的区别：不依赖 sender.tab，由自己创建新 tab 并在其上设置认证。
 * debugRedirect 存在时：在新 tab 中使用 debugRedirect origin 登录，直接导航到完整目标 URL。
 * 否则：在新 tab 中导航到 targetUrl（无 targetUrl 时回 origin）。
 */
export async function handleQuickLoginInNewTab(
  targetUrl: string,
  username: string,
  password: string,
  hasUrl: boolean,
  debugRedirect?: string,
  _sourceTabId?: number,
): Promise<LoginResponse> {
  // 新标签页路径：execTarget.kind = "new"，由 prelude 先建 tab 再构建 ctx（ADR-0012 D9）。
  // 登录发生在新 tab 上；debugRedirect 存在时 prelude 会直接在 redirect origin 建 tab。
  const outcome = await prepareLogin({
    action: "QUICK_LOGIN_NEW_TAB",
    account: { name: username, username },
    credentials: { username, password },
    target: targetUrl,
    targetKind: "url",
    debugRedirect,
    execTarget: { kind: "new", url: targetUrl },
  });
  if (!outcome.ok) {
    return { success: false, error: outcome.error, errorCode: outcome.errorCode };
  }
  const { prepared } = outcome;
  const { session } = prepared;
  let success = false;

  try {
    const loginResult = await runLoginSpec(prepared.spec, prepared.ctx);
    await session.logFinal(loginResult, session.buffer);

    if (!loginResult.success) {
      return {
        success: false,
        error: loginResult.error,
        errorCode: loginResult.errorCode,
        recipeSteps: loginResult.recipeSteps,
      };
    }
    // 注意：这里不校验 loginResult.data 是否为空。
    // - 旧 API 策略在 token 为 null 时 login 步骤已抛错，到不了这里；
    // - executeLoginScript 策略（generic）页面自管 / 快照模式按设计就没有 tokenData
    //   （旧引擎「无 token 的纯表单登录同样成功」），认证态由页面 cookie 或
    //   capturedAuth 承载。曾有的 EMPTY_RESPONSE 检查会把已登录成功的 tab 误杀。

    // 在新 tab 中设置认证并导航（复用 prelude 创建的 tab，不再二次 create）：
    // - redirect 存在：导航到 redirect origin + targetUrl 的 path/query/hash。
    // - 否则：targetUrl > origin（ADR-0015 D12）。
    //   login 后的跳转由 spec 的 `goto` / `auth.restore` 算子表达，此处无独立 fallbackIntent。
    let finalUrl: string;
    let finalOrigin: string;
    if (prepared.redirect) {
      finalOrigin = prepared.redirect.origin;
      finalUrl = prepared.redirect.fullUrl;
    } else {
      finalOrigin = prepared.origin;
      finalUrl = resolvePostLoginUrl({
        hasUrl,
        targetUrl,
        origin: prepared.origin,
      });
    }

    await setupAuthTab(
      createLegacyTokenInjector(),
      finalOrigin,
      finalUrl,
      loginResult.data ?? null,
      {
        execTab: { tabId: prepared.execTabId },
        // 快照模式（D6）：在目标 origin 的文档内恢复（D7 顺序由 setupAuthTab 固化）
        ...(loginResult.capturedAuth
          ? { capturedAuth: loginResult.capturedAuth }
          : {}),
      },
    );
    success = true;
    return { success: true };
  } catch (e: unknown) {
    return session.fail(e instanceof Error ? e.message : "未知错误", {
      code: errorCodeOf(e),
    });
  } finally {
    // 失败时关闭本次新建的 tab，不留空标签页（ADR-0012 D9 不变量）
    prepared.release({ closeExecTab: !success });
  }
}
