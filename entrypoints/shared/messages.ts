/**
 * 消息协议（ADR-0003 D1 ②）— background 通信的唯一事实源
 *
 * 以判别联合声明全部消息类型：
 * - BackgroundMessageMap：页面/content script → background（chrome.runtime.sendMessage）
 *   含 9 类工具消息（registry handler）+ OPEN_TOOL_TAB 核心消息（background 自处理）
 * - ContentMessageMap：background → content script（chrome.tabs.sendMessage）
 *
 * 所有发送点统一经 sendBgMessage / sendContentMessage，编译期校验
 * type、payload、response 形状；registry handler 签名按 type 收窄（见 types.ts）。
 *
 * 消息中不再有 toolId 字段——router 按 type 全局路由（见 message-router.ts）。
 */

import type { FormScanFrame } from "../tools/account-switch/strategies/login-form-scan";
import type { AuthStorageSelection } from "../tools/account-switch/strategies/auth-storage";
import type { DryRunStepResult } from "../tools/account-switch/strategies/generic-dry-run";
import type { Recipe } from "../tools/account-switch/strategies/generic-recipe";
import type { RecipeStepTrace } from "../tools/account-switch/spec/types";
import type { Account } from "../tools/account-switch/types";
import type {
  LoginFormLockResult,
  PreparedLoginFormLock,
} from "../tools/account-switch/login-form-lock";
import type { ErrorCode } from "../tools/account-switch/utils/error-codes";
import type { TrialSignalState } from "../tools/account-switch/spec/run";

// ---------------------------------------------------------------------------
// 响应形状
// ---------------------------------------------------------------------------

/** 登录类操作响应（附错误码与配方轨迹，ADR-0012 D13） */
interface LoginResponse {
  success: boolean;
  error?: string;
  errorCode?: ErrorCode;
  /** 配方步骤轨迹：失败时用于定位「第几步哪个目标」 */
  recipeSteps?: RecipeStepTrace[];
}

// ---------------------------------------------------------------------------
// 页面/content script → background
// ---------------------------------------------------------------------------

export interface BackgroundMessageMap {
  // --- background 核心消息（无属主工具，不进 registry 路由表） ---
  OPEN_TOOL_TAB: {
    payload: {
      tool: string;
      params?: Record<string, string>;
      forceNew?: boolean;
    };
    response: { success: boolean };
  };

  // --- 账号切换 ---
  SWITCH_ACCOUNT: {
    payload: { account: Account; domain: string };
    response: LoginResponse;
  };
  QUICK_LOGIN: {
    payload: {
      url: string;
      username: string;
      password: string;
      hasUrl?: boolean;
      debugRedirect?: string;
    };
    response: LoginResponse;
  };
  /**
   * 配方试跑：在当前 tab 验证定位，不提交登录。
   * 只执行导航 / 填充 / 等待；点击与脚本被拒绝（返回 skipped）。
   * `only` 只跑指定下标（ADR-0013 D11 单步试跑），缺省为整条配方。
   */
  TEST_RECIPE: {
    payload: {
      tabId?: number;
      origin: string;
      recipe: Recipe;
      /** 只试跑这些步骤下标（缺失 / 空数组以外的未指定语义见执行器） */
      only?: number[];
    };
    response: {
      success: boolean;
      error?: string;
      errorCode?: ErrorCode;
      steps: DryRunStepResult[];
    };
  };
  /**
   * 一键识别登录表单（ADR-0013 D8）：只读扫描所有 frame，返回各候选。
   * 不点击、不提交、不写存储，因此不需要登录锁。
   */
  SCAN_LOGIN_FORM: {
    payload: { tabId?: number; origin: string };
    response: {
      success: boolean;
      error?: string;
      errorCode?: ErrorCode;
      /** 命中密码框的 frame（主 frame 在前）；多 frame 时由 UI 选择 */
      frames: FormScanFrame[];
      /** 只读枚举并筛选出的认证存储键名；不包含任何存储值 */
      authStorage?: AuthStorageSelection;
    };
  };

  /** 新建环境基础保存成功后，按最新配置条件回写当前环境的表单定位。 */
  LOCK_LOGIN_FORM: {
    payload: PreparedLoginFormLock;
    response: LoginFormLockResult;
  };

  /**
   * 打开设置页（账号切换 section）。content script 无法调用
   * chrome.runtime.openOptionsPage，需 background 代开。
   */
  OPEN_ACCOUNT_SETTINGS: {
    payload: Record<string, never>;
    response: { success: boolean; error?: string };
  };

  OPEN_ACCOUNT_ENVIRONMENT: {
    payload: { envKey: string };
    response: { success: boolean; error?: string };
  };

  /**
   * 试登录：在后台以单算子模式试跑一次登录请求，默认零副作用。
   * 只发请求 + 判定数据成功信号；不执行 `auth.write` / `goto` / 页面算子，
   * 不触达当前标签页。勾选 `writeSession` 后才写入会话。
   */
  TRIAL_LOGIN: {
    payload: {
      /** 待试跑的登录声明 */
      spec: import("../tools/account-switch/spec/types").LoginSpec;
      /** 环境 origin（请求基线 + 输入命名空间 `{origin}`） */
      origin: string;
      /** 试登录表单的账号（输入 `{username}` / `{password}`） */
      username: string;
      password: string;
      /** 是否写入会话（缺省 false 不写） */
      writeSession?: boolean;
    };
    response: {
      /** 请求已成功发出且数据信号满足 / 无数据信号 */
      ok: boolean;
      error?: string;
      errorCode?: ErrorCode;
      /** 逐条数据成功信号的状态 */
      signals: TrialSignalState[];
      /** 请求是否已实际发出 */
      requestSent: boolean;
      /** 会话是否已写入（writeSession + auth.write 已执行） */
      sessionWritten: boolean;
    };
  };
}

export type BackgroundMessageType = keyof BackgroundMessageMap;

/**
 * background 核心消息 type——由 background.ts 直接处理，
 * 工具不得在 backgroundHandlers 中声明同名 type（见 types.ts 的排除）。
 */
export type CoreMessageType = "OPEN_TOOL_TAB";

/** 工具可声明的消息 type（registry handler 的合法 key） */
export type ToolMessageType = Exclude<BackgroundMessageType, CoreMessageType>;

/** 判别联合：全部 background 消息（type 字段判别） */
export type BackgroundMessages = {
  [K in BackgroundMessageType]: {
    type: K;
  } & BackgroundMessageMap[K]["payload"];
}[BackgroundMessageType];

export type BgPayload<K extends BackgroundMessageType> =
  BackgroundMessageMap[K]["payload"];
export type BgResponse<K extends BackgroundMessageType> =
  BackgroundMessageMap[K]["response"];

// ---------------------------------------------------------------------------
// background → content script
// ---------------------------------------------------------------------------

export interface ContentMessageMap {
  OPEN_ACCOUNT_SWITCHER: {
    payload: Record<string, never>;
    response: { success: boolean };
  };
}

export type ContentMessageType = keyof ContentMessageMap;

/** 判别联合：全部 content script 消息（spec 要求双向协议均显式声明） */
export type ContentMessages = {
  [K in ContentMessageType]: { type: K } & ContentMessageMap[K]["payload"];
}[ContentMessageType];

// ---------------------------------------------------------------------------
// 发送辅助
// ---------------------------------------------------------------------------

// 无 payload 的消息（payload 为 Record<string, never>）省略第二参。
// 注意：不能用 {} 表示空 payload——keyof {} 为 never 之外的边缘情形会让
// 条件类型判断失真；Record<string, never> 的 keyof 为 string，需显式判断。
type PayloadArgs<P> = [P] extends [Record<string, never>] ? [] : [payload: P];

/**
 * 向 background 发送消息（编译期校验 type / payload / response）。
 *
 *   sendBgMessage('QUICK_LOGIN', { url, username, password })
 *
 * 未注册的 type 不会 reject：Chrome 会 resolve(undefined)。dev 模式下选项页
 * 走 Vite 热更新、service worker 却要手动重新加载，极易出现「新 UI 发消息、
 * 旧后台没 handler」，调用方随后在 `res.success` 上撞 TypeError。这里统一换成
 * 可操作的错误，避免把「扩展版本不一致」误读成功能故障。
 */
export async function sendBgMessage<K extends BackgroundMessageType>(
  type: K,
  ...args: PayloadArgs<BgPayload<K>>
): Promise<BgResponse<K>> {
  const [payload] = args;
  const response: BgResponse<K> | undefined = await chrome.runtime.sendMessage({
    type,
    ...payload,
  });
  if (response === undefined) {
    throw new Error(
      `后台未响应消息 ${type}：扩展版本可能已更新，请到 edge://extensions（或 chrome://extensions）重新加载扩展`,
    );
  }
  return response;
}

/**
 * 向指定 tab 的 content script 发送消息（background 侧）。
 */
export function sendContentMessage<K extends ContentMessageType>(
  tabId: number,
  type: K,
  ...args: PayloadArgs<ContentMessageMap[K]["payload"]>
): Promise<ContentMessageMap[K]["response"]> {
  const [payload] = args;
  return chrome.tabs.sendMessage(tabId, { type, ...payload });
}
