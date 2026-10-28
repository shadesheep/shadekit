/**
 * 环境与账号视图投影层（ADR-0017）
 *
 * account-view.ts 的兄弟模块：承载「扁平配置 / 存储快照 → 用户可见视图」的
 * 纯函数投影：主视图环境分组（S3）、环境类型推断与颜色映射、导入识别与预览
 * 计划（S5：detectImportKind / planImport）。
 *
 * 全部纯函数：零浏览器 API、零 DOM、零 storage，可单测。
 */
import { ACCOUNT_COLORS, accountColorIndex } from "./account-palette";
// 直引纯函数子模块而非 spec 桶式入口：保持本模块「零浏览器 API」的投影层约束
import type { LoginSpec } from "./spec/types";
import {
  configPackageVersion,
  validateConfigPackage,
  type ConfigPackage,
  type PackageIssue,
} from "./spec/package";
import { validateLoginSpec, type SpecRule } from "./spec/validate";
import { normalizeAuthWriteTemplates } from "./spec/template";
import type {
  Account,
  AccountSwitchConfig,
  DomainConfig,
} from "./types";

// ============================================================
// 主视图分组（S3）
// ============================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 一个环境 + 该环境下的账号（主视图环境卡片的唯一数据来源） */
export interface EnvGroup {
  /** domains 配置 key（origin 或通配符形态） */
  key: string;
  env: DomainConfig;
  accounts: Account[];
}

/** 主视图投影：环境分组 + 未绑定账号（未绑定账号在面板里不出现） */
export interface EnvGroups {
  groups: EnvGroup[];
  unbound: Account[];
}

/**
 * 扁平配置 → 环境分组投影：
 * - 环境顺序稳定（按 config.domains 的 key 插入顺序）；
 * - 账号按 Account.domains 归入对应环境组，一个账号可出现在多组（保留多对多）；
 * - 组内账号顺序沿用 config.accounts 顺序；
 * - 绑定了不存在环境 key 的引用静默忽略；没有任何有效绑定的账号归入 unbound
 *   （不丢、不崩）；
 * - 空配置返回 { groups: [], unbound: [] }。
 */
export function buildEnvGroups(
  config: Pick<AccountSwitchConfig, "accounts" | "domains">,
): EnvGroups {
  const domains = config.domains ?? {};
  const accounts = config.accounts ?? [];

  const groups: EnvGroup[] = Object.keys(domains).map((key) => ({
    key,
    env: domains[key],
    accounts: [],
  }));
  const byKey = new Map(groups.map((g) => [g.key, g]));

  const unbound: Account[] = [];
  for (const account of accounts) {
    let bound = false;
    for (const key of account.domains) {
      const group = byKey.get(key);
      if (!group) continue; // 脏数据（指向不存在的环境）：忽略该引用
      group.accounts.push(account);
      bound = true;
    }
    if (!bound) unbound.push(account);
  }
  return { groups, unbound };
}

/** 删除环境时同步清除账号引用，避免重建同地址环境后旧绑定复活。 */
export function removeEnvironment(
  config: Pick<AccountSwitchConfig, "accounts" | "domains">,
  key: string,
): Pick<AccountSwitchConfig, "accounts" | "domains"> {
  const domains = { ...config.domains };
  delete domains[key];
  return {
    domains,
    accounts: config.accounts.map((account) =>
      account.domains.includes(key)
        ? { ...account, domains: account.domains.filter((domain) => domain !== key) }
        : account,
    ),
  };
}

// ============================================================
// 环境类型（tag）推断与颜色
// ============================================================

/** 预设环境类型：UI 只暴露这四个值（本地 / 测试 / 预发 / 生产），存储层 tags 仍是 string[] */
export type EnvTag = "local" | "test" | "uat" | "prod";

/**
 * 环境色：按 tag 名从 10 色池取色（与角色 pill 同源 accountColorIndex），
 * 返回 light.fg（色板的亮色主题文字色）作为徽章/色条的单色。
 *
 * 语义 pin：prod / 生产 永远命中索引 0「红」（警示语义最强），不走哈希；
 * 其他 tag 均布到 10 色。未识别 tag 回退灰色。
 */
const ENV_TAG_FALLBACK = "#6b7280";

/** 未识别 tag 的默认灰色（导出供测试断言） */
export const ENV_TAG_FALLBACK_COLOR = ENV_TAG_FALLBACK;

/** prod 钉死红色（ACCOUNT_COLORS[0]），保证生产环境在任何主题下第一眼可辨 */
const PROD_COLOR = ACCOUNT_COLORS[0].light.fg;

/**
 * 归一化手输/历史 tag 到预设类型：精确匹配（英文大小写不敏感 + 中文别名），
 * 不做子串匹配——「production」不再是红色、「本地」不再是灰色。
 */
export function normalizeEnvTag(tag: string): EnvTag | undefined {
  switch (tag.trim().toLowerCase()) {
    case "local":
    case "本地":
      return "local";
    case "test":
    case "测试":
      return "test";
    case "uat":
    case "预发":
      return "uat";
    case "prod":
    case "生产":
      return "prod";
    default:
      return undefined;
  }
}

/** tag → 颜色值。prod 钉红色；其他按 tag 名哈希取 10 色池的 light.fg；未识别回退灰色。 */
export function tagColor(tag: string | undefined): string {
  const normalized = tag === undefined ? undefined : normalizeEnvTag(tag);
  if (!normalized) return ENV_TAG_FALLBACK;
  if (normalized === "prod") return PROD_COLOR;
  return ACCOUNT_COLORS[accountColorIndex(normalized)].light.fg;
}

/** 取 URL 的 hostname（小写）；非 http(s) 或不可解析返回 undefined */
function parseHttpHostname(url: string): string | undefined {
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    // 允许省略协议（粘贴框形态，如 localhost:8888），默认按 http 解析；
    // 只认显式 http(s)://，避免把 "localhost:" 误当作 URL scheme
    parsed = new URL(
      /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`,
    );
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }
  return parsed.hostname.toLowerCase();
}

/** 回环（127.0.0.0/8）与私有网段（10/8、172.16/12、192.168/16） */
function isLoopbackOrPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return a === 192 && b === 168;
}

/**
 * 从 URL 推断环境类型：
 * - localhost / 127.0.0.0/8 / ::1 / 私有网段 → 'local'
 * - host 含 test / dev / staging → 'test'
 * - 其余可解析的 http(s) origin → undefined（不猜成 prod）
 */
export function deriveEnvTag(url: string): EnvTag | undefined {
  const host = parseHttpHostname(url);
  if (!host) return undefined;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    isLoopbackOrPrivateIpv4(host)
  ) {
    return "local";
  }
  if (/test|dev|staging/.test(host)) return "test";
  if (/uat/.test(host)) return "uat";
  return undefined;
}

/** 环境默认名：取 URL 的 hostname（小写）；非 http(s) 或不可解析返回 undefined */
export function deriveEnvName(url: string): string | undefined {
  return parseHttpHostname(url);
}

// ============================================================
// 导入识别与预览计划（S5：ADR-0017 D2 三轴）
// ============================================================

/** 导入对象（三轴分类，按内容识别，不靠文件名） */
export type ImportKind = "strategy" | "accounts" | "full" | "unknown";

/** 落地轴：登录策略 / 账号与绑定 */
export type ImportAxis = "strategy" | "accounts";

/** 落地方式：新建环境（冲突跳过）/ 覆盖已有环境 */
export type ImportLandMode = "create" | "overwrite";

/**
 * 导入问题：复用 `PackageIssue` 形状（含 `opIndex`，校验逻辑复用
 * `validateConfigPackage`），扩展 `rule` 承载 R1–R7 结构校验规则号
 * （来自 `validateLoginSpec`），UI 据此渲染「R3 · 第 5 步 · …」式定位。
 */
export interface ImportIssue extends PackageIssue {
  /** 违反的结构校验规则（R1–R7；包级/结构问题缺省） */
  rule?: SpecRule;
}

/** 一个落地轴的可用性与内容计数（预览「里面有什么」的唯一事实源） */
export interface ImportAxisInfo {
  /** 文件中存在该轴内容且可落地 */
  available: boolean;
  /** strategy = 环境声明数；accounts = 账号数（含明文密码） */
  count: number;
  /** 默认勾选态（full 两轴全勾；冲突环境另有逐条默认不勾选） */
  defaultChecked: boolean;
}

/** 待落地的一个环境条目：含冲突标记与默认勾选态（UI 可改 checked） */
export interface ImportEnvItem {
  /** 环境地址（落盘 key，trim 后） */
  url: string;
  name: string;
  /** 待落地的完整环境配置（策略包：由 name/url/spec 构造；备份：原样） */
  domain: DomainConfig;
  /** 与现有环境地址冲突（覆盖会替换正在用的配置） */
  conflict: boolean;
  /** 默认勾选：非冲突 true；冲突 false（避免误覆盖，可手动勾） */
  checked: boolean;
}

/** 落地方式选项：有冲突才提供「覆盖已有环境」，默认一律安全的「新建」 */
export interface ImportLandOptions {
  modes: ImportLandMode[];
  defaultMode: ImportLandMode;
}

/** 导入预览计划：识别结论 + 内容清单 + 冲突 + 校验问题 + 落地方式 */
export interface ImportPlan {
  kind: ImportKind;
  axes: Record<ImportAxis, ImportAxisInfo>;
  /** 待落地环境条目（strategy 轴的全部候选，含冲突条目的默认勾选态） */
  envs: ImportEnvItem[];
  /** envs 中的冲突子集（默认不勾选） */
  conflicts: ImportEnvItem[];
  /** 校验问题：非空即禁止落地（确认按钮禁用的事实源，零半成品不变量） */
  issues: ImportIssue[];
  landOptions: ImportLandOptions;
  /** 账号轴待落地的账号（accounts/full；含明文密码，仅供落盘，UI 不展示密码） */
  accountsToLand: Account[];
}

/**
 * 按内容识别导入对象（不靠文件名）：
 * - `format` 为 `dt-login-config/vN` → `strategy`（登录策略包）。
 *   不支持的版本也识别为 strategy，由 validateConfigPackage 给出精确拒绝，
 *   而不是笼统的「无法识别」；
 * - 存在 `accounts` → `accounts`（账号备份）；含 `__version` 则 `full`；
 * - 存在 `__version` → `full`（全部工具设置导出）；
 * - 其余 → `unknown`。
 */
export function detectImportKind(raw: unknown): ImportKind {
  if (!isRecord(raw)) return "unknown";
  if (configPackageVersion(raw.format) !== undefined) return "strategy";
  const hasAccounts = Array.isArray(raw.accounts);
  const hasVersion = typeof raw.__version === "number";
  if (hasAccounts) return hasVersion ? "full" : "accounts";
  if (hasVersion) return "full";
  return "unknown";
}

function emptyAxes(): Record<ImportAxis, ImportAxisInfo> {
  return {
    strategy: { available: false, count: 0, defaultChecked: false },
    accounts: { available: false, count: 0, defaultChecked: false },
  };
}

function toEnvItem(
  url: string,
  name: string,
  domain: DomainConfig,
  existing: Record<string, DomainConfig>,
): ImportEnvItem {
  const conflict = Object.hasOwn(existing, url);
  return { url, name, domain, conflict, checked: !conflict };
}

/**
 * 导入预览计划（纯函数，零浏览器 API / storage；落盘由 UI 调既有
 * `updateConfig` 完成）。识别 → 校验 → 内容清单 + 冲突 + 落地方式：
 * - `strategy`：`validateConfigPackage` 复用既有拒绝逻辑（格式 / 版本过高 /
 *   `script` 算子（含 opIndex）/ `secret` 变量 / requiredVars 越界），
 *   通过后再补 R1–R7 结构校验（导出侧拦一次，导入侧防手工构造再拦一次）；
 * - `accounts` / `full`：账号备份直接取顶层切片；全部工具设置只取
 *   `account-switch` 子键（其余工具设置不在本工具落地）；
 * - 冲突环境（地址已存在）标出并默认不勾选，有冲突才提供「覆盖已有环境」。
 */
export function planImport(
  raw: unknown,
  config: Pick<AccountSwitchConfig, "accounts" | "domains">,
): ImportPlan {
  const kind = detectImportKind(raw);
  const axes = emptyAxes();
  const issues: ImportIssue[] = [];
  let envs: ImportEnvItem[] = [];
  let accountsToLand: Account[] = [];
  const existing = config.domains ?? {};

  if (kind === "unknown") {
    issues.push({
      code: "CONFIG_INVALID",
      message:
        "无法识别的文件：既不是登录策略包（dt-login-config/v1），" +
        "也不是账号备份或全部工具设置导出",
    });
  } else if (kind === "strategy") {
    issues.push(...validateConfigPackage(raw));
    if (issues.length === 0) {
      const pkg = raw as ConfigPackage;
      // 导入容错：把「cookie value 为字面 JSON 对象」这类手写包的结构花括号自动
      // 转义（{{/}}），再校验与落地，保证存盘的是合法模板（escapeLiteralBraces）
      const normalizedEnvs = pkg.environments.map((env) => ({
        ...env,
        spec: normalizeAuthWriteTemplates(env.spec) as LoginSpec,
      }));
      // R1–R7 结构校验（SpecIssue → ImportIssue：保留 rule + opIndex）
      normalizedEnvs.forEach((env, envIndex) => {
        for (const si of validateLoginSpec(env.spec)) {
          issues.push({
            code: si.code,
            message: `第 ${envIndex + 1} 个环境：${si.message}`,
            ...(si.rule === undefined ? {} : { rule: si.rule }),
            ...(si.opIndex === undefined ? {} : { opIndex: si.opIndex }),
          });
        }
      });
      envs = normalizedEnvs.map((env) => {
        const url = env.url.trim();
        return toEnvItem(
          url,
          env.name,
          {
            name: env.name,
            tags: [],
            // loginMethod 仅作显示名：用声明自己的名称，让导入的策略在日志与
            // 下拉里可辨认；执行始终认 strategyConfig.spec。
            loginMethod: env.spec.template?.trim() || "generic",
            strategyConfig: { spec: env.spec },
          },
          existing,
        );
      });
      axes.strategy = {
        available: envs.length > 0,
        count: envs.length,
        defaultChecked: envs.length > 0,
      };
    }
  } else if (isRecord(raw)) {
    // accounts / full：账号备份 = 顶层切片；全部工具设置 = account-switch 子键
    const slice =
      kind === "full"
        ? isRecord(raw["account-switch"])
          ? (raw["account-switch"] as Record<string, unknown>)
          : undefined
        : raw;
    if (!slice) {
      issues.push({
        code: "CONFIG_INVALID",
        message:
          "这份全部工具设置导出中不含「环境与账号」的数据；" +
          "其余工具设置请在选项页顶部「全部工具设置」导入",
      });
    } else {
      // 账号与绑定轴
      if (Array.isArray(slice.accounts)) {
        // domains 缺失/非数组/含非字符串一律判为坏记录（拒绝整条而非补 []）：
        // 落盘后 buildEnvGroups 会遍历 account.domains，非可迭代值直接白屏
        // （final review 回归）
        const badIndex = slice.accounts.findIndex(
          (a) =>
            !isRecord(a) ||
            typeof a.username !== "string" ||
            !Array.isArray(a.domains) ||
            !(a.domains as unknown[]).every((d) => typeof d === "string"),
        );
        if (badIndex >= 0) {
          issues.push({
            code: "CONFIG_INVALID",
            message: `第 ${badIndex + 1} 个账号不是有效的账号记录`,
          });
        } else {
          accountsToLand = slice.accounts as unknown as Account[];
          axes.accounts = {
            available: true,
            count: slice.accounts.length,
            // 空列表默认不勾：避免默认动作清空现有账号
            // （沿用旧「从文件导入」confirm 硬门槛的语义）
            defaultChecked: slice.accounts.length > 0,
          };
        }
      } else {
        issues.push({
          code: "CONFIG_INVALID",
          message: "账号备份缺少账号列表（accounts）",
        });
      }
      // 登录策略轴（备份里的 domains 即环境声明）
      if (isRecord(slice.domains)) {
        const entries = Object.entries(slice.domains);
        const badEnv = entries.findIndex(([, d]) => !isRecord(d));
        if (badEnv >= 0) {
          issues.push({
            code: "CONFIG_INVALID",
            message: `第 ${badEnv + 1} 个环境不是有效的环境记录`,
          });
        } else {
          envs = entries.map(([url, d]) => {
            const domain = d as unknown as DomainConfig;
            return toEnvItem(
              url,
              typeof domain.name === "string" && domain.name ? domain.name : url,
              domain,
              existing,
            );
          });
          axes.strategy = {
            available: envs.length > 0,
            count: envs.length,
            defaultChecked: envs.length > 0,
          };
        }
      }
    }
  }

  const conflicts = envs.filter((e) => e.conflict);
  const landOptions: ImportLandOptions =
    conflicts.length > 0
      ? { modes: ["create", "overwrite"], defaultMode: "create" }
      : { modes: ["create"], defaultMode: "create" };

  return { kind, axes, envs, conflicts, issues, landOptions, accountsToLand };
}
