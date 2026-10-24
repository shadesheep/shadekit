/**
 * 登录方式（策略）预设 — 内置 + 用户导入的动态策略。
 *
 * 登录只有一个执行器（`runSpec`），`loginMethod` 不再参与执行
 * 分派，只承担两件事：**新建环境时选用哪份默认声明**、**界面上显示什么名字**。
 *
 * 本模块把这两件事抽成纯函数：
 * - 内置预设：只剩 `generic`（通用登录）
 * - 动态预设：策略库条目（ADR-0019）+ 未入库的存量环境声明。名称取自 spec 的
 *   `template`（skill 产出的声明通常带可读名称），退化为库条目名 / 环境名。
 *
 * 用户自行导入的策略包以动态预设的身份出现，与任何用户声明同构。
 *
 * 策略库条目的预设 key 直接是库 id（`custom:<slug>`），因此下拉选中的 key
 * 与环境的 `strategyId` 是同一个值；存量环境声明仍按内容归纳出一个
 * `custom:<slug>` 形式的只读预设，不做强制迁移。
 *
 * 零浏览器 API：调用方把环境列表与策略库传进来。
 */

import type { DomainConfig, StrategyEntry } from "../types";
import { defaultLoginSpec } from "./editor";
import { strategyTitle } from "./strategy-library";
import type { LoginSpec } from "./types";

/** 内置预设标识（即 `SpecTemplate.id`） */
export const BUILTIN_GENERIC = "generic";

export interface StrategyPreset {
  /** 稳定标识：内置为固定 key；动态为 `custom:<slug>` */
  key: string;
  /** 下拉展示名 */
  title: string;
  /** 选中该预设时套用的登录声明 */
  spec: LoginSpec;
  /** 是否内置（内置不可删除） */
  builtin: boolean;
  /** 来源环境地址（动态预设用于展示与去重） */
  sourceUrl?: string;
}

/** 内置通用登录的展示名 */
export const GENERIC_TITLE = "通用登录";

/** 把任意字符串压成稳定的 key 片段（中文等非 ASCII 保留可读部分，非法字符归一） */
export function slugifyKey(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unnamed";
}

/**
 * 从登录声明推导展示名：`template` 优先（skill 产出会写可读名），
 * 否则用环境名，最后退化为「自定义登录」。
 */
export function presetTitleOf(spec: LoginSpec, envName?: string): string {
  const template = spec.template?.trim();
  if (template && template !== BUILTIN_GENERIC) {
    return template;
  }
  const name = envName?.trim();
  return name || "自定义登录";
}

/**
 * 归纳动态预设：策略库条目优先，其次才是环境自带的内联声明。
 * 同名 / 同内容声明只保留第一个（后导入的重复策略不刷屏）。
 *
 * 跳过项：
 * - spec 与内置 generic 默认模板完全一致的（那就是通用登录，不该多一条）
 * - 没有 `strategyConfig.spec` 的环境（旧配方/扁平参数不算可复用策略）
 * - 已绑定策略库的环境（由库条目代表，不重复收录）
 */
export function collectStrategyPresets(
  domains: Record<string, DomainConfig> | undefined,
  strategies?: Record<string, StrategyEntry>,
): StrategyPreset[] {
  const presets: StrategyPreset[] = [];
  const seenTitles = new Set<string>();
  const seenSpecs = new Set<string>();
  const genericSpecJson = JSON.stringify(defaultLoginSpec());

  // —— 先收录策略库条目（ADR-0019）——
  // 库是策略的正式住处；预设 key 直接用库 id（形如 `custom:<slug>`），
  // 使「下拉里选中的 key」与「环境绑定的 strategyId」是同一个值。
  for (const [id, entry] of Object.entries(strategies ?? {})) {
    const spec = entry?.spec;
    if (!spec) continue;
    if (JSON.stringify(spec) === genericSpecJson) continue;
    if (spec.template === BUILTIN_GENERIC) continue;
    const title = strategyTitle(spec, entry.name);
    const specJson = JSON.stringify(spec);
    if (seenTitles.has(title) || seenSpecs.has(specJson)) continue;
    seenTitles.add(title);
    seenSpecs.add(specJson);
    presets.push({ key: id, title, spec, builtin: false });
  }

  // —— 再归纳没有入库的存量环境声明（ADR-0019 前的数据）——
  // 保持只读兼容：不强制迁移，用户把环境「存入策略库」后才进入正式条目。
  for (const [url, env] of Object.entries(domains ?? {})) {
    // 已绑定策略库的环境由库条目代表，不重复收录
    if (env?.strategyId && strategies?.[env.strategyId]) continue;
    const spec = env?.strategyConfig?.spec;
    if (!spec) continue;
    // 内置模板不重复收录：与 generic 默认模板完全一致
    if (JSON.stringify(spec) === genericSpecJson) continue;
    if (spec.template === BUILTIN_GENERIC) continue;

    const title = presetTitleOf(spec, env.name);
    const specJson = JSON.stringify(spec);
    if (seenTitles.has(title) || seenSpecs.has(specJson)) continue;
    seenTitles.add(title);
    seenSpecs.add(specJson);
    presets.push({
      key: `custom:${slugifyKey(title)}`,
      title,
      spec,
      builtin: false,
      sourceUrl: url,
    });
  }
  return presets;
}

/**
 * 全部可选登录方式：内置（generic 恒有）+ 策略库 + 未入库的存量环境声明。
 *
 * 编辑某个环境时它自己也在 `domains` 里，因此它的具名策略一定在列表中，
 * 不需要额外的「保留当前 key」参数。
 */
export function listStrategyPresets(
  domains: Record<string, DomainConfig> | undefined,
  strategies?: Record<string, StrategyEntry>,
): StrategyPreset[] {
  const list: StrategyPreset[] = [
    {
      key: BUILTIN_GENERIC,
      title: GENERIC_TITLE,
      spec: defaultLoginSpec(),
      builtin: true,
    },
  ];
  for (const preset of collectStrategyPresets(domains, strategies)) {
    if (!list.some((p) => p.key === preset.key)) list.push(preset);
  }
  return list;
}

/**
 * 已保存环境的登录方式归属：优先匹配现有预设（按 spec 内容），
 * 匹配不上时归为动态预设（用环境自己保存的 spec）。
 *
 * 这保证「编辑一个已导入环境」时下拉能选中它对应的那条策略，
 * 而不是回落到 generic 并把用户声明覆盖掉。
 */
export function matchPresetKey(
  spec: LoginSpec,
  envName: string | undefined,
  presets: StrategyPreset[],
): string {
  const specJson = JSON.stringify(spec);
  const exact = presets.find((p) => JSON.stringify(p.spec) === specJson);
  if (exact) return exact.key;
  const title = presetTitleOf(spec, envName);
  const byTitle = presets.find((p) => p.title === title);
  if (byTitle) return byTitle.key;
  return `custom:${slugifyKey(title)}`;
}

/** 按 key 取预设；取不到返回 undefined（由调用方决定兜底声明） */
export function findPreset(
  presets: StrategyPreset[],
  key: string,
): StrategyPreset | undefined {
  return presets.find((p) => p.key === key);
}
