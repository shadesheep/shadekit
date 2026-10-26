import { sendBgMessage } from "../../shared/messages";
import { getConfig, updateConfigTransaction } from "../../shared/tool-config";
import { rankPickerTabs } from "./config/target-picker";
import {
  applyLoginFormFrame,
  autoLoginSpecShape,
  loginSpecEquals,
} from "./spec/auto-login";
import { readSpecFromConfig } from "./spec/migrate";
import type { LoginSpec } from "./spec/types";
import {
  resolveAutoLoginScan,
  scanLoginForm,
  type AutoLoginResolution,
  type ScanLoginFormResult,
} from "./strategies/login-form-scan";
import type { AccountSwitchConfig, DomainConfig } from "./types";

const TOOL_ID = "account-switch";
export const LOGIN_FORM_PREPARE_TIMEOUT_MS = 1500;

export interface PreparedLoginFormLock {
  operationId: string;
  envKey: string;
  expectedSpec: LoginSpec;
  tabId: number;
}

export type LoginFormLockResult = {
  status: "locked" | "skipped" | "failed";
  reason?: string;
};

interface ScannedCandidate {
  tabId: number;
  scan: ScanLoginFormResult;
  resolution: AutoLoginResolution;
}

function cloneSpec(spec: LoginSpec): LoginSpec {
  return JSON.parse(JSON.stringify(spec)) as LoginSpec;
}

function environmentUrl(envKey: string): URL | null {
  try {
    const url = new URL(envKey);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

async function scanCandidate(tabId: number): Promise<ScannedCandidate> {
  const scan = await scanLoginForm(tabId);
  return { tabId, scan, resolution: resolveAutoLoginScan(scan) };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** 新建保存前的只读短准备；迟到结果没有写权限，也不会直接改 storage。 */
export async function prepareLoginFormLock(input: {
  envKey: string;
  spec: LoginSpec;
  timeoutMs?: number;
}): Promise<PreparedLoginFormLock | null> {
  if (!autoLoginSpecShape(input.spec)) return null;
  const envUrl = environmentUrl(input.envKey);
  if (!envUrl) return null;

  const preparing = (async (): Promise<PreparedLoginFormLock | null> => {
    const own = await chrome.tabs.getCurrent().catch(() => undefined);
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const candidates = rankPickerTabs(tabs, envUrl.origin, own?.id)
      .filter((tab) => {
        if (tab.id === undefined || (tab.status !== undefined && tab.status !== "complete")) return false;
        const url = tab.url ? environmentUrl(tab.url) : null;
        return url?.origin === envUrl.origin;
      })
      .sort((left, right) => {
        const leftPath = left.url ? environmentUrl(left.url)?.pathname : undefined;
        const rightPath = right.url ? environmentUrl(right.url)?.pathname : undefined;
        return Number(rightPath === envUrl.pathname) - Number(leftPath === envUrl.pathname);
      });
    if (candidates.length === 0) return null;

    const scanned = await Promise.all(candidates.map((tab) => scanCandidate(tab.id!)));
    const resolved = scanned.filter((item) => item.resolution.status === "resolved");
    if (resolved.length !== 1) return null;
    return {
      operationId: crypto.randomUUID(),
      envKey: input.envKey,
      expectedSpec: cloneSpec(input.spec),
      tabId: resolved[0].tabId,
    };
  })();
  return withTimeout(
    preparing,
    Math.max(1, Math.min(input.timeoutMs ?? LOGIN_FORM_PREPARE_TIMEOUT_MS, LOGIN_FORM_PREPARE_TIMEOUT_MS)),
  );
}

function specForEnvironment(
  config: AccountSwitchConfig,
  env: DomainConfig,
): LoginSpec | null {
  const read = readSpecFromConfig(env, config.strategies);
  return read.spec && !read.invalid ? read.spec : null;
}

function expectedAutoSpec(config: AccountSwitchConfig | undefined, input: PreparedLoginFormLock): LoginSpec | null {
  const env = config?.domains[input.envKey];
  if (!config || !env) return null;
  const current = specForEnvironment(config, env);
  return current && loginSpecEquals(current, input.expectedSpec) && autoLoginSpecShape(current)
    ? current
    : null;
}

/** 后台条件回写：页面读取在锁外，最终修订检查和最小 patch 在锁内。 */
export async function lockPreparedLoginForm(
  input: PreparedLoginFormLock,
): Promise<LoginFormLockResult> {
  const initial = await getConfig<AccountSwitchConfig>(TOOL_ID);
  if (!expectedAutoSpec(initial, input)) {
    return { status: "skipped", reason: "环境已删除或声明已变化" };
  }

  const envUrl = environmentUrl(input.envKey);
  if (!envUrl) return { status: "skipped", reason: "环境 URL 无效" };
  try {
    const tab = await chrome.tabs.get(input.tabId);
    const tabUrl = tab.url ? environmentUrl(tab.url) : null;
    if (!tabUrl || tabUrl.origin !== envUrl.origin) {
      return { status: "skipped", reason: "候选页面已变化" };
    }
  } catch {
    return { status: "skipped", reason: "候选页面已关闭" };
  }

  const candidate = await scanCandidate(input.tabId);
  if (candidate.resolution.status !== "resolved" || candidate.scan.status !== "found") {
    return { status: "skipped", reason: "候选表单已不再唯一完整" };
  }
  const frame = candidate.scan.frames[0];
  let skipReason = "环境已删除或声明已变化";
  const transaction = await updateConfigTransaction<AccountSwitchConfig>(TOOL_ID, (latest) => {
    const currentSpec = expectedAutoSpec(latest, input);
    if (!latest || !currentSpec) return null;
    const lockedSpec = applyLoginFormFrame(currentSpec, frame);
    if (!lockedSpec) return null;
    const currentEnv = latest.domains[input.envKey];
    const nextEnv: DomainConfig = {
      ...currentEnv,
      strategyConfig: { ...currentEnv.strategyConfig, spec: lockedSpec },
    };
    skipReason = "";
    return { domains: { ...latest.domains, [input.envKey]: nextEnv } };
  });
  if (!transaction.ok) return { status: "failed", reason: "配置写入失败" };
  if (!transaction.changed) return { status: "skipped", reason: skipReason };
  return { status: "locked" };
}

/** 基础保存与可选回写严格排序；基础保存失败时不发后台消息。 */
export async function finalizeNewEnvironmentSave(input: {
  candidate?: PreparedLoginFormLock;
  saveBase: () => Promise<boolean>;
  reload: () => Promise<void>;
}): Promise<{ saved: boolean; lockStatus?: LoginFormLockResult["status"] }> {
  if (!(await input.saveBase())) return { saved: false };
  let lockStatus: LoginFormLockResult["status"] | undefined;
  if (input.candidate) {
    try {
      const result = await sendBgMessage("LOCK_LOGIN_FORM", input.candidate);
      lockStatus = result.status;
    } catch (error: unknown) {
      lockStatus = "failed";
    }
  }
  await input.reload();
  return { saved: true, ...(lockStatus ? { lockStatus } : {}) };
}

export function newEnvironmentSaveMessage(
  lockStatus?: LoginFormLockResult["status"],
): string {
  return lockStatus === "locked"
    ? "环境已保存，登录表单已锁定"
    : "环境已保存，将自动定位登录表单";
}
