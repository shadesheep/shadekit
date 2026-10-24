/**
 * 配方试跑
 *
 * 目的：在不提交登录、不写认证态的前提下，验证定位写没写对。
 *
 * 白名单：只执行 `goto` / `fill` / `waitFor`；`click` / `extract` / `script`
 * 一律标记为 `skipped`，绝不执行——试跑没有用户确认，点击提交或跑脚本都可能
 * 产生真实副作用。
 *
 * 与正式执行的差异（刻意为之）：
 * - 不等待页面加载完成（避免配置页长时间阻塞）
 * - 填充使用占位值 `devtools-dryrun`，永不写入真实密码
 * - 不写 tab、不落调试日志、不返回 tokenData
 * - 单步失败不中断：逐行返回状态，用户一次就能看到所有错的定位
 */

import { LoginError, errorCodeOf } from "../utils/error-codes";
import { runDomAction, toTargetError } from "./generic-dom";
import {
  DEFAULT_LIMITS,
  type Recipe,
  type RecipeStep,
} from "./generic-recipe";
import { interpolateTemplate } from "./generic-runner";
import { describeCondition, waitForSettle } from "./generic-settle";
import { describeTarget } from "./generic-target";

/** 试跑允许执行的步骤类型 */
export const DRY_RUN_OPS = ["goto", "fill", "waitFor"] as const;

/** 试跑期间写入表单的占位值（绝不使用真实密码） */
export const DRY_RUN_PLACEHOLDER = "devtools-dryrun";

export function isDryRunnable(step: RecipeStep): boolean {
  return (DRY_RUN_OPS as readonly string[]).includes(step.op);
}

/**
 * 解析 `only` 为待跑下标（升序、去重、只保留合法下标）。
 * 未指定或为空数组 → 整条配方。
 */
export function selectSteps(recipe: Recipe, only?: number[]): number[] {
  const all = recipe.steps.map((_, index) => index);
  if (!only || only.length === 0) return all;
  const valid = new Set(
    only.filter(
      (index) =>
        Number.isInteger(index) && index >= 0 && index < recipe.steps.length,
    ),
  );
  if (valid.size === 0) return all;
  return all.filter((index) => valid.has(index));
}

/** 单步骤试跑结果（与 RecipeStepTrace 同形，界面直接复用状态渲染） */
export interface DryRunStepResult {
  index: number;
  op: RecipeStep["op"];
  target?: string;
  status: "success" | "skipped" | "error";
  duration: number;
  errorCode?: string;
  error?: string;
}

export interface DryRunResult {
  steps: DryRunStepResult[];
  /** 试跑永不产出 token（与正式执行区分） */
  tokenData?: undefined;
}

function stepDescription(step: RecipeStep): string | undefined {
  switch (step.op) {
    case "fill":
    case "click":
      return describeTarget(step.target);
    case "waitFor":
      return describeCondition(step.when);
    case "goto":
      return step.url;
    default:
      return undefined;
  }
}

/** 试跑用的变量表：账号密码一律占位 */
function dryRunVariables(origin: string): Record<string, string> {
  return {
    origin,
    username: DRY_RUN_PLACEHOLDER,
    password: DRY_RUN_PLACEHOLDER,
    debugRedirect: "",
  };
}

/**
 * 按配方顺序试跑当前 tab，返回逐步骤状态。
 *
 * 签名与正式执行器保持一致的入参风格：`password` 仅为对称保留，**不参与插值**，
 * 试跑永远填占位值。
 *
 * `only` 只跑指定下标（ADR-0013 D11 单步试跑）：未列出的步骤不执行、也不出现在
 * 结果里。越界 / 非整数下标忽略；`only` 为空数组时等同整条试跑——「只跑零步」
 * 没有可展示的结果，静默返回空集合只会让人以为出了故障。
 */
export async function runRecipeDryRun(
  tabId: number,
  origin: string,
  _password: string,
  recipe: Recipe,
  only?: number[],
): Promise<DryRunResult> {
  const vars = dryRunVariables(origin);
  const limits = { ...DEFAULT_LIMITS, ...(recipe.limits ?? {}) };
  const steps: DryRunStepResult[] = [];
  const selected = selectSteps(recipe, only);

  for (const index of selected) {
    const step = recipe.steps[index];
    const startedAt = Date.now();
    const base = {
      index,
      op: step.op,
      target: stepDescription(step),
      duration: 0,
    };

    if (!isDryRunnable(step)) {
      // click / extract / script：拒绝执行，界面按「跳过」展示
      steps.push({ ...base, status: "skipped", duration: Date.now() - startedAt });
      continue;
    }

    try {
      switch (step.op) {
        case "goto": {
          const url = interpolateTemplate(step.url, vars);
          try {
            await chrome.tabs.update(tabId, { url });
          } catch (e: unknown) {
            throw new LoginError(
              errorCodeOf(e),
              `导航失败: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          // 刻意不等待加载完成：试跑不阻塞配置页
          break;
        }

        case "fill": {
          const outcome = await runDomAction(
            tabId,
            {
              action: "fill",
              target: step.target,
              value: DRY_RUN_PLACEHOLDER,
              clearFirst: step.clearFirst !== false,
            },
            step,
          );
          const error = toTargetError(outcome, describeTarget(step.target));
          if (error) throw error;
          break;
        }

        case "waitFor": {
          const when = step.when;
          if (when.type === "fixed") {
            await new Promise((r) => setTimeout(r, when.ms));
            break;
          }
          await waitForSettle({
            tabId,
            settle: when,
            failWhen: recipe.failWhen,
            timeoutMs: step.timeoutMs ?? limits.settleMs,
            // 试跑不额外探测密码框：formGone 在没有基准时恒不成立，
            // 由同一配方里的其他条件兜底
            passwordFieldPresent: false,
          });
          break;
        }
      }

      steps.push({ ...base, status: "success", duration: Date.now() - startedAt });
    } catch (e: unknown) {
      steps.push({
        ...base,
        status: "error",
        duration: Date.now() - startedAt,
        errorCode: e instanceof LoginError ? e.code : errorCodeOf(e),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { steps };
}

/** 汇总试跑结果：是否有错（界面据此决定整体提示色） */
export function hasDryRunFailure(result: DryRunResult): boolean {
  return result.steps.some((s) => s.status === "error");
}
