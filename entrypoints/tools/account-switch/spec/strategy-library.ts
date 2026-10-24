/**
 * 登录策略库 — 策略作为独立对象（ADR-0019，引用 + 镜像）。
 *
 * 在 ADR-0019 之前，策略只以「环境内联 `strategyConfig.spec`」的形态存在，
 * 于是导入一份登录策略包必然新增一条环境记录、删除环境也连带毁掉策略。
 * 本模块把策略提到环境之上：
 *
 * - **策略库**（`AccountSwitchConfig.strategies`）：`id → { name, spec }`；
 * - **绑定**（`DomainConfig.strategyId`）：环境引用库里的条目；
 * - **镜像**（无 `strategyConfig.spec`）：绑定的环境若从未改过声明，就不落
 *   私有拷贝——执行时 `readSpecFromConfig` 直接读库条目，库一改即对所有
 *   镜像环境生效；
 * - **私有声明**（`strategyConfig.spec` 存在）：用户在环境里改过声明后才
 *   落地，覆盖库条目（脱镜）。「同步」即把脱镜环境重置回镜像。
 *
 * 取消关联只清 `strategyId`；删除策略也**只摘绑定**——镜像环境没有私有
 * 声明兜底，删除后它们回到「未配置登录」，请先在环境里另选登录方式。
 *
 * 全部纯函数：零浏览器 API、零 storage、零 Vue，可单测。
 */

import type { DomainConfig, StrategyEntry } from "../types";
import { defaultLoginSpec } from "./editor";
import type { LoginSpec } from "./types";

/** 策略 id：`custom:` 前缀保持与旧动态预设 key 的视觉连续性 */
const STRATEGY_ID_PREFIX = "custom:";

/** 生成一个稳定、可读的策略 id（同名策略追加序号避免撞车） */
export function makeStrategyId(
  title: string,
  existing: Record<string, StrategyEntry> | undefined,
): string {
  const base = `${STRATEGY_ID_PREFIX}${slugify(title)}`;
  const taken = existing ?? {};
  if (!Object.hasOwn(taken, base)) return base;
  let n = 2;
  while (Object.hasOwn(taken, `${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** 与 `strategy-presets.ts` 的 slugifyKey 同规则；此处本地实现避免循环依赖 */
function slugify(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unnamed";
}

/** 策略的展示名：`spec.template` 优先，其次传入的兜底名，最后「自定义登录」 */
export function strategyTitle(spec: LoginSpec, fallbackName?: string): string {
  const template = spec.template?.trim();
  if (template && template !== "generic") return template;
  const name = fallbackName?.trim();
  return name || "自定义登录";
}

/** 语义相等的策略内容（用于「同名同内容合并」判断） */
function sameSpec(a: LoginSpec, b: LoginSpec): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 环境是否在「镜像」某条库策略：绑定存在且**没有**环境私有声明。
 * 镜像环境不持 spec 拷贝，执行时由 `readSpecFromConfig` 实时读库条目。
 */
export function isMirroring(env: DomainConfig): boolean {
  return (
    env.strategyId !== undefined && env.strategyConfig?.spec === undefined
  );
}

export interface UpsertResult {
  id: string;
  strategies: Record<string, StrategyEntry>;
  /** 命中已有同内容条目时为 false（不新增、不写时间） */
  created: boolean;
}

/**
 * 把一份声明放进策略库：内容完全相同则复用已有条目（幂等），
 * 否则新建一条。返回新的 `strategies` 记录，不修改入参。
 *
 * 「内容相同」按 spec 全量比较，不看名字——同一份声明重复导入
 * 不该堆出多条同名策略。
 */
export function upsertStrategy(
  strategies: Record<string, StrategyEntry> | undefined,
  spec: LoginSpec,
  title: string,
  now: number = Date.now(),
): UpsertResult {
  const current = strategies ?? {};
  for (const [id, entry] of Object.entries(current)) {
    if (sameSpec(entry.spec, spec)) {
      return { id, strategies: current, created: false };
    }
  }
  const id = makeStrategyId(title, current);
  return {
    id,
    created: true,
    strategies: {
      ...current,
      [id]: { name: title, spec, createdAt: now, updatedAt: now },
    },
  };
}

/** 覆盖库条目内容（编辑共享策略）：更新 updatedAt，不触碰绑定关系 */
export function updateStrategy(
  strategies: Record<string, StrategyEntry> | undefined,
  id: string,
  spec: LoginSpec,
  now: number = Date.now(),
): Record<string, StrategyEntry> {
  const current = strategies ?? {};
  const existing = current[id];
  if (!existing) return current;
  return {
    ...current,
    [id]: {
      name: strategyTitle(spec, existing.name),
      spec,
      createdAt: existing.createdAt,
      updatedAt: now,
    },
  };
}

/** 引用某条策略的环境列表（删除策略前提示「已关联 N 个环境」） */
export function boundEnvironments(
  domains: Record<string, DomainConfig> | undefined,
  strategyId: string,
): string[] {
  return Object.entries(domains ?? {})
    .filter(([, env]) => env?.strategyId === strategyId)
    .map(([url]) => url);
}

export type UnbindMode = "keep-spec" | "revert-generic";

/**
 * 把环境与策略解绑。`keep-spec` 保留当前环境私有声明（若有；镜像环境解绑后
 * 即为「未配置」，因为镜像本就不持拷贝），`revert-generic` 回落到通用登录默认
 * 声明。
 *
 * 两种模式都**只改这一条环境的字段**：不新增环境、不删除策略库条目。
 * `genericSpec` 仅在 `revert-generic` 时使用，默认取 `defaultLoginSpec`。
 */
export function unbindEnvironment(
  env: DomainConfig,
  mode: UnbindMode,
  genericSpec: () => LoginSpec = defaultLoginSpec,
): DomainConfig {
  const next: DomainConfig = { ...env };
  delete next.strategyId;
  if (mode === "revert-generic") {
    next.strategyConfig = { spec: genericSpec() };
    next.loginMethod = "generic";
  }
  return next;
}

/**
 * 把库条目绑到环境：只写 `strategyId` 与显示名，**不拷贝声明**——绑定的
 * 默认形态就是「镜像库条目」。环境若已有自己的私有声明（`strategyConfig.spec`
 * 存在），保留它：绑定不丢用户已做的修改，此时为脱镜态。
 */
export function bindEnvironment(
  env: DomainConfig,
  id: string,
  entry: StrategyEntry,
): DomainConfig {
  return {
    ...env,
    strategyId: id,
    loginMethod: strategyTitle(entry.spec, entry.name),
  };
}

/**
 * 把环境重置回「镜像库条目」：丢弃环境私有声明，仅保留绑定。
 *
 * ADR-0019（修订）：绑定环境默认就是镜像，库更新即时生效；只有当用户在
 * 环境里改过声明（`strategyConfig.spec` 存在）才需要这个显式动作把它拉回
 * 到镜像。已是镜像 / 未绑定的环境返回 `undefined` 表示无需变更。
 */
export function syncEnvironment(
  env: DomainConfig,
  _entry: StrategyEntry,
): DomainConfig | undefined {
  if (env.strategyId === undefined) return undefined;
  if (env.strategyConfig?.spec === undefined) return undefined;
  const next: DomainConfig = { ...env };
  delete next.strategyConfig;
  return next;
}

/** 批量重置：返回新 domains 与「从脱镜拉回镜像」的环境数 */
export function syncBoundEnvironments(
  domains: Record<string, DomainConfig>,
  id: string,
  entry: StrategyEntry,
): { domains: Record<string, DomainConfig>; updated: number } {
  const next = { ...domains };
  let updated = 0;
  for (const [url, env] of Object.entries(domains)) {
    if (env?.strategyId !== id) continue;
    const patched = syncEnvironment(env, entry);
    if (patched) {
      next[url] = patched;
      updated += 1;
    }
  }
  return { domains: next, updated };
}

/**
 * 删除策略库条目：从库里移除，并摘掉所有绑定环境的 `strategyId`。
 *
 * 镜像环境没有私有声明，删除后回到「未配置登录」；脱镜环境的私有声明原样
 * 保留为环境私有，登录行为不变。绝不删环境。
 */
export function removeStrategy(
  strategies: Record<string, StrategyEntry> | undefined,
  domains: Record<string, DomainConfig> | undefined,
  id: string,
): {
  strategies: Record<string, StrategyEntry>;
  domains: Record<string, DomainConfig>;
  detached: string[];
} {
  const nextStrategies = { ...(strategies ?? {}) };
  delete nextStrategies[id];
  const nextDomains = { ...(domains ?? {}) };
  const detached: string[] = [];
  for (const [url, env] of Object.entries(nextDomains)) {
    if (env?.strategyId !== id) continue;
    // 只摘绑定：镜像环境失去声明（未配置），脱镜环境保留私有声明
    nextDomains[url] = unbindEnvironment(env, "keep-spec");
    detached.push(url);
  }
  return { strategies: nextStrategies, domains: nextDomains, detached };
}

/** 策略库列表项：条目本身 + 已关联环境数（删除前的提示依据） */
export interface StrategyListItem extends StrategyEntry {
  id: string;
  boundCount: number;
}

/** 策略库的一次性投影：按最近更新排序，并统计每个条目的关联环境数 */
export function listStrategies(
  strategies: Record<string, StrategyEntry> | undefined,
  domains?: Record<string, DomainConfig>,
): StrategyListItem[] {
  const counts = new Map<string, number>();
  for (const env of Object.values(domains ?? {})) {
    const id = env?.strategyId;
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return Object.entries(strategies ?? {})
    .map(([id, entry]) => ({
      ...entry,
      id,
      boundCount: counts.get(id) ?? 0,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 保存环境时的统一收口：把表单选中的策略写回 `strategyId` 与镜像关系。
 *
 * - `strategyId` 指向库里存在的条目 → 绑定；若环境私有声明与库一致则丢弃
 *   （回到镜像），不同则保留（脱镜，由调用方在更上游决定）；
 * - `strategyId` 为空 / 不存在 → 清除绑定，保留表单里的 spec（私有声明）。
 */
export function resolveEnvironmentBinding(
  env: DomainConfig,
  strategies: Record<string, StrategyEntry> | undefined,
): DomainConfig {
  const id = env.strategyId;
  if (!id) {
    if (env.strategyId === undefined) return env;
    const { strategyId: _drop, ...rest } = env;
    return rest;
  }
  const entry = strategies?.[id];
  if (!entry) {
    const { strategyId: _drop, ...rest } = env;
    return rest;
  }
  return bindEnvironment(env, id, entry);
}
