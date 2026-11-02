import { getConfig } from "../../../shared/tool-config";
import { readSpecFromConfig } from "../spec/migrate";
import type { AccountSwitchConfig } from "../types";
import { normalizeDomain } from "../utils/env";
import { planLoginPermissions, type PermissionPlan } from "./permission-planner";
import { originToMatchPattern } from "./origin-pattern";
import { PermissionError } from "./permission-error";

const environmentPlans = new Map<string, PermissionPlan>();

function displayOrigin(pattern: string): string {
  return pattern.replace(/\/\*$/, "");
}

export function registerEnvironmentPlan(environmentId: string, plan: PermissionPlan): void {
  environmentPlans.set(environmentId, plan);
}

export async function getEnvironmentPermissionPlan(environmentId: string): Promise<PermissionPlan> {
  const existing = environmentPlans.get(environmentId);
  if (existing) return existing;
  const config = await getConfig<AccountSwitchConfig>("account-switch");
  const environment = config?.domains[environmentId];
  if (!environment) throw new PermissionError("ORIGIN_UNSUPPORTED", "环境不存在或已删除");
  const { spec } = readSpecFromConfig(environment, config?.strategies);
  const plan = planLoginPermissions(environment, spec ?? { version: 2, ops: [], success: [], auth: { mode: "page" } }, {
    username: "",
    password: "",
    // 存量环境 key 可能带路径/hash；权限规划只认 origin（与登录执行一致）。
    origin: normalizeDomain(environmentId),
    debugRedirect: environment.debugRedirect,
    vars: environment.vars,
  });
  environmentPlans.set(environmentId, plan);
  return plan;
}

export async function getMissingPermissions(plan: PermissionPlan): Promise<string[]> {
  const missing: string[] = [];
  for (const pattern of plan.patterns) {
    const granted = await chrome.permissions.contains({ origins: [pattern] }).catch(() => false);
    if (!granted) missing.push(displayOrigin(pattern));
  }
  return missing;
}

export async function assertLoginPermissions(plan: PermissionPlan): Promise<void> {
  const missingOrigins = await getMissingPermissions(plan);
  if (missingOrigins.length > 0) {
    throw new PermissionError(
      "HOST_PERMISSION_REQUIRED",
      `缺少环境访问权限：${missingOrigins.join("、")}`,
      missingOrigins,
    );
  }
}

export async function assertRuntimeTarget(url: string): Promise<void> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new PermissionError("ORIGIN_UNSUPPORTED", "ORIGIN_UNSUPPORTED: 登录目标不是有效 URL");
  }
  const pattern = originToMatchPattern(target);
  const granted = await chrome.permissions.contains({ origins: [pattern] }).catch(() => false);
  if (!granted) {
    throw new PermissionError(
      "HOST_PERMISSION_REQUIRED",
      `登录目标权限已被撤回或未授权：${target.origin}`,
      [target.origin],
    );
  }
}

export async function requestEnvironmentPermissions(environmentId: string): Promise<boolean> {
  const plan = await getEnvironmentPermissionPlan(environmentId);
  // 扩展声明了 <all_urls> 时权限已随安装授予；无需再次进入 request
  // （消息处理器没有用户手势，Chrome 会直接拒绝）。
  if ((await getMissingPermissions(plan)).length === 0) return true;
  const granted = await chrome.permissions.request({ origins: plan.patterns });
  if (!granted) {
    throw new PermissionError("HOST_PERMISSION_DENIED", "用户未授予环境访问权限", plan.displayOrigins);
  }
  return true;
}
