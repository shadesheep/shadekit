/**
 * 成功 / 失败判定与验证码识别（ADR-0012 D4 / D5）
 *
 * - 支持全部 SettleCondition 类型与 any / all 组合
 * - `formGone`：以登录前的「密码框是否存在」快照为基准；没有密码框的页面
 *   该条件恒 false（由 urlChanged 兜底），不会误判成功
 * - 轮询每个周期先查 failWhen 再查 settle，失败优先
 * - 验证码文案 `/验证码|captcha|slider/i` 命中 → CAPTCHA_REQUIRED
 */

import { ErrorCodes, LoginError } from "../utils/error-codes";
import { runDomAction } from "./generic-dom";
import type { SettleCondition } from "./generic-recipe";

/** 每个轮询周期的条件状态（用于超时报错时说明「差在哪」） */
export interface ConditionState {
  description: string;
  met: boolean;
}

export interface SettleContext {
  tabId: number;
  /** 登录前页面是否存在密码框（formGone 的基准） */
  passwordFieldPresent: boolean;
}

/** 内置验证码文案识别（D4） */
export const CAPTCHA_PATTERN = "验证码|captcha|slider";

/** 密码框选择器（用于 formGone 基准快照） */
export const PASSWORD_FIELD_SELECTOR = 'input[type="password"]';

/** 判定条件的可读描述（日志与错误信息） */
export function describeCondition(cond: SettleCondition): string {
  switch (cond.type) {
    case "formGone":
      return "登录表单消失";
    case "urlChanged":
      return "URL 发生变化";
    case "url":
      return `URL 匹配 ${cond.glob}`;
    case "selector":
      return `元素出现 ${typeof cond.target === "string" ? cond.target : JSON.stringify(cond.target)}`;
    case "cookie":
      return `Cookie 存在 ${cond.name}`;
    case "storage":
      return `${cond.area === "local" ? "localStorage" : "sessionStorage"} 存在 ${cond.key}`;
    case "fixed":
      return `固定等待 ${cond.ms}ms`;
    case "any":
      return `任一成立（${cond.of.map(describeCondition).join(" / ")}）`;
    case "all":
      return `全部成立（${cond.of.map(describeCondition).join(" / ")}）`;
  }
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** 读取 tab 当前 URL（执行器在 click 前预采 settle 基准也用它） */
export async function currentUrl(tabId: number): Promise<string> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.url ?? "";
  } catch {
    return "";
  }
}

/** 取当前 tab 的登录前 URL 基准（由上下文持有，避免每次轮询重取） */
export interface BaselineState {
  initialUrl?: string;
}

/**
 * 求值单个条件。`baseline.initialUrl` 在首次调用时填充，
 * 之后的 urlChanged 都以它为准（而不是每次轮询都刷新基准）。
 */
export async function evaluateCondition(
  ctx: SettleContext,
  cond: SettleCondition,
  baseline: BaselineState = {},
): Promise<boolean> {
  switch (cond.type) {
    case "formGone": {
      if (!ctx.passwordFieldPresent) return false;
      const outcome = await runDomAction(ctx.tabId, {
        action: "locate",
        target: PASSWORD_FIELD_SELECTOR,
      });
      return outcome.status === "notFound";
    }
    case "urlChanged": {
      const url = await currentUrl(ctx.tabId);
      if (baseline.initialUrl === undefined) baseline.initialUrl = url;
      return url !== "" && url !== baseline.initialUrl;
    }
    case "url": {
      const url = await currentUrl(ctx.tabId);
      return globToRegex(cond.glob).test(url);
    }
    case "selector": {
      const outcome = await runDomAction(ctx.tabId, {
        action: "locate",
        target: cond.target,
      });
      if (outcome.status === "invalid") {
        throw new LoginError(
          ErrorCodes.SELECTOR_INVALID,
          `成功判定选择器不合法: ${outcome.message}`,
        );
      }
      // 歧义说明「已经出现」，但定位本身仍需用户修正——按「已满足 + 告警」处理
      return outcome.status === "ok";
    }
    case "cookie": {
      try {
        const cookies = await chrome.cookies.getAll({ name: cond.name });
        return cookies.length > 0;
      } catch {
        return false;
      }
    }
    case "storage": {
      const area = cond.area === "local" ? "localStorage" : "sessionStorage";
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: ctx.tabId, allFrames: true },
          func: (areaName: string, key: string) => {
            const store = areaName === "local" ? localStorage : sessionStorage;
            return store.getItem(key) !== null;
          },
          args: [area, cond.key],
        });
        return (results ?? []).some((r) => r.result === true);
      } catch {
        return false;
      }
    }
    case "fixed":
      // 固定等待由执行器 sleep 处理，这里视为「立即满足」
      return true;
    case "any": {
      let index = 0;
      for (const item of cond.of) {
        // any 的 urlChanged 需要各自独立的基准
        const childBaseline = index === 0 ? baseline : { ...baseline };
        if (await evaluateCondition(ctx, item, childBaseline)) return true;
        index++;
      }
      return false;
    }
    case "all": {
      for (const item of cond.of) {
        if (!(await evaluateCondition(ctx, item, baseline))) return false;
      }
      return true;
    }
  }
}

/** 探测页面是否出现验证码类文案 */
export async function detectCaptcha(tabId: number): Promise<boolean> {
  const outcome = await runDomAction(tabId, {
    action: "scan",
    patterns: [CAPTCHA_PATTERN],
  });
  return outcome.status === "ok";
}

/** 快照「登录前是否存在密码框」，作为 formGone 的基准 */
export async function snapshotPasswordField(tabId: number): Promise<boolean> {
  const outcome = await runDomAction(tabId, {
    action: "locate",
    target: PASSWORD_FIELD_SELECTOR,
  });
  // 歧义也算「存在」
  return outcome.status === "ok" || outcome.status === "ambiguous";
}

export interface WaitForSettleOptions {
  tabId: number;
  settle: SettleCondition;
  failWhen?: SettleCondition;
  timeoutMs: number;
  pollingIntervalMs?: number;
  passwordFieldPresent: boolean;
  /**
   * urlChanged 的预采基准 URL（执行器在 click 前采集）。
   * 缺省时沿用旧行为：第一次轮询时才采基准——快速站点上此时跳转可能已完成，
   * 基准会被采成终点地址导致永不满足，因此执行器应尽量预采。
   */
  baselineUrl?: string;
}

export interface WaitForSettleResult {
  /** 最后一次各条件状态（超时错误信息用） */
  states: ConditionState[];
}

/**
 * 轮询等待 settle 成立；每个周期先 failWhen。
 *
 * 失败优先（D4）：命中 failWhen → LOGIN_REJECTED；
 * 命中验证码文案 → CAPTCHA_REQUIRED。
 * 超时 → SUCCESS_CONDITION_UNMET，message 携带最后一次条件状态。
 */
export async function waitForSettle(
  opts: WaitForSettleOptions,
): Promise<WaitForSettleResult> {
  const pollingInterval = opts.pollingIntervalMs ?? 200;
  const deadline = Date.now() + opts.timeoutMs;
  const baseline: BaselineState = { initialUrl: opts.baselineUrl };
  let lastStates: ConditionState[] = [];
  const settle = opts.settle;

  // 固定等待：真实 sleep 后直接判定成功（D5）
  if (settle.type === "fixed") {
    await new Promise((r) => setTimeout(r, settle.ms));
    return { states: [{ description: describeCondition(settle), met: true }] };
  }

  const ctx: SettleContext = {
    tabId: opts.tabId,
    passwordFieldPresent: opts.passwordFieldPresent,
  };

  while (Date.now() < deadline) {
    if (opts.failWhen && (await evaluateCondition(ctx, opts.failWhen, baseline))) {
      throw new LoginError(
        ErrorCodes.LOGIN_REJECTED,
        `登录被拒绝：命中失败条件「${describeCondition(opts.failWhen)}」`,
      );
    }
    if (await detectCaptcha(opts.tabId)) {
      throw new LoginError(
        ErrorCodes.CAPTCHA_REQUIRED,
        "登录需要验证码：请在弹出的页面中完成验证后重试",
      );
    }

    const met = await evaluateCondition(ctx, settle, baseline);
    lastStates = [{ description: describeCondition(settle), met }];
    if (met) return { states: lastStates };

    await new Promise((r) => setTimeout(r, pollingInterval));
  }

  const detail = lastStates
    .map((s) => `${s.description}: ${s.met ? "已满足" : "未满足"}`)
    .join("；");
  throw new LoginError(
    ErrorCodes.SUCCESS_CONDITION_UNMET,
    `等待超时 (${opts.timeoutMs}ms)：成功判定条件未满足${detail ? `（${detail}）` : ""}`,
  );
}
