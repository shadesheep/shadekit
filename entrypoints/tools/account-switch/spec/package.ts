/**
 * 配置包导入导出。
 *
 * 配置包是把一套登录声明分享给同事的载体：格式 `dt-login-config/v1`，
 * 含 `environments[]` 与 `requiredVars`。**不含账号绑定、不含可执行代码**——
 * 导出时逐算子检查 `script`，命中即拒绝并指出第几步；`secret: true` 的变量
 * 声明不能进包，v1 导入直接拒绝。
 *
 * 纯函数模块：零浏览器 API、零运行时副作用，可被 Config UI、后台消息
 * 与测试共同引用。
 *
 * 与「备份整份账号切换配置（含明文密码）」是两个不同入口
 * （ADR-0015 D9）：备份走 Config.vue 的全局导出（改名加二次确认），
 * 配置包走环境编辑区。
 */

import type { DomainConfig, StrategyEntry } from "../types";
import { LOGIN_SPEC_VERSION, type LoginSpec, type SpecOp } from "./types";

/** 配置包格式标识 */
export const CONFIG_PACKAGE_FORMAT = "dt-login-config/v1" as const;

/** 配置包需要填写的变量名（不含 `{}`；必为 `spec.vars` 的子集，导出前校验） */
export type ConfigPackageVar = { name: string; title?: string };

/** 配置包中的一个环境（仅环境相关的声明 + 变量声明，不含账号与明文密码） */
export interface ConfigPackageEnvironment {
  /** 环境名（新装时作为待创建环境的 name） */
  name: string;
  /** 环境地址（origin） */
  url: string;
  loginMethod?: string;
  /** 该环境的登录声明（不含 script / secret 变量的 spec） */
  spec: LoginSpec;
  /** 需要填写 / 覆盖的变量（必为 spec.vars 子集） */
  requiredVars: ConfigPackageVar[];
}

export interface ConfigPackage {
  format: typeof CONFIG_PACKAGE_FORMAT;
  /** 生成包时的扩展 LoginSpec 版本（供导入方校验版本不过高） */
  specVersion: typeof LOGIN_SPEC_VERSION;
  /** 每个环境渲染后的变量（不含 `{ }`），可整体勾选 */
  requiredVars: ConfigPackageVar[];
  /** 单一环境导出时 = 1（支持多环境时扩展） */
  environments: ConfigPackageEnvironment[];
}

/** 配置包校验 / 导出问题（导出拒绝、导入 `CONFIG_INVALID` 共用一种形状） */
export interface PackageIssue {
  code?: "CONFIG_INVALID";
  message: string;
  /** 命中 `script` 的算子下标（0 基） */
  opIndex?: number;
  /** 命中的变量名（secret / requiredVars 越界） */
  varName?: string;
}

const PACKAGE_PATTERN = /^dt-login-config\/v(\d+)$/;

/** 从 `format` 解析配置包版本；非配置包返回 undefined */
export function configPackageVersion(format: unknown): number | undefined {
  if (typeof format !== "string") return undefined;
  const match = PACKAGE_PATTERN.exec(format);
  return match ? Number(match[1]) : undefined;
}

/** 当前扩展支持的配置包版本（与 LoginSpec 版本解耦） */
export const SUPPORTED_PACKAGE_VERSION = 1 as const;

/**
 * 导出前逐算子检查：任一 `op.op === "script"` 即拒绝并指出第几步。
 * 返回空数组 = 可安全分发。
 */
export function findScriptOps(spec: LoginSpec): PackageIssue[] {
  const issues: PackageIssue[] = [];
  spec.ops.forEach((op: SpecOp, index) => {
    if (op.op === "script") {
      issues.push({
        opIndex: index,
        message:
          `第 ${index + 1} 步（script）包含可执行代码，不能随配置包分发`,
      });
    }
  });
  return issues;
}

/** 收集 spec 里 `secret: true` 的变量名（这些不能进包） */
export function findSecretVars(spec: LoginSpec): string[] {
  return (spec.vars ?? [])
    .filter((variable) => variable.secret === true)
    .map((variable) => variable.name);
}

/**
 * 校验 `requiredVars ⊆ spec.vars`：声明填写的变量名必须都在 spec 已声明的
 * vars 里。导出（选需填写的变量）与导入（读取包）各校验一次（ADR-0015 D9）。
 * 命中的 requireVar 名若不在 spec.vars → 报 `CONFIG_INVALID` 级错误。
 */
export function checkRequiredVars(
  requiredNames: string[],
  spec: LoginSpec,
): PackageIssue[] {
  const declared = new Set((spec.vars ?? []).map((v) => v.name));
  return requiredNames
    .filter((name) => !declared.has(name))
    .map((name) => ({
      varName: name,
      message: `需要填写的变量「${name}」不在登录声明的 vars 中`,
    }));
}

/**
 * 导出配置包。逐算子检查脚本、剔除 `secret` 变量、校验 `requiredVars ⊆
 * spec.vars`，任一失败即拒绝（返回 empty 包 + issues）。导出结果**只含环境
 * 声明与变量声明**——不含账号绑定、不含明文密码、不含可执行代码。
 *
 * @param environment 绑定的环境（DomainConfig）
 * @param origin 环境地址（即 DomainConfig 的 key）；包内 `environments[].url` 由此给出
 * @param requiredVars 该环境导出时希望接收方填写的变量名（不含 `{}`）
 * @param strategies 登录策略库：镜像环境（ADR-0019）不持私有声明，
 *   需从 `strategyId` 指向的库条目回落读取
 */
export function buildConfigPackage(
  environment: DomainConfig,
  origin: string,
  requiredVars: string[],
  strategies?: Record<string, StrategyEntry | undefined>,
): { package?: ConfigPackage; issues: PackageIssue[] } {
  // 与 `readSpecFromConfig` 同一条读取链：私有声明优先，其次镜像库条目
  const spec =
    environment.strategyConfig?.spec ??
    (environment.strategyId
      ? strategies?.[environment.strategyId]?.spec
      : undefined);
  if (!spec) {
    return {
      issues: [{ message: "该环境没有可导出的登录声明（spec）" }],
    };
  }

  const issues: PackageIssue[] = [];
  // —— 导出前逐算子检查脚本；命中即拒绝 ——
  issues.push(...findScriptOps(spec));
  // —— secret 变量不能进包 ——
  const secretVars = findSecretVars(spec);
  issues.push(
    ...secretVars.map((name) => ({
      varName: name,
      message: `变量「${name}」标记为敏感（secret），不能随配置包分发`,
    })),
  );

  // —— 环境自身的变量声明剔除 secret，留 name/title ——
  const packageVars: ConfigPackageVar[] = (spec.vars ?? [])
    .filter((variable) => variable.secret !== true)
    .map((variable) => ({ name: variable.name, title: variable.title }));

  // requiredVars 去重后，仍须是 spec.vars 子集（且不得命中 secret 变量）
  const uniqueRequired = Array.from(new Set(requiredVars));
  issues.push(...checkRequiredVars(uniqueRequired, spec));
  for (const name of uniqueRequired) {
    if (secretVars.includes(name)) {
      issues.push({
        varName: name,
        message: `需要填写的变量「${name}」是敏感变量（secret），不能进包`,
      });
    }
  }

  // 导出时把 spec 里的变量声明（剔除 secret）也一并交给释义：requiredVars
  // 是其中「必须填写」的子集；接收方填写的变量必须落在这个包里。
  if (issues.length > 0) {
    return { issues };
  }

  const requiredVarDefs: ConfigPackageVar[] = uniqueRequired.map((name) => ({
    name,
    title: packageVars.find((v) => v.name === name)?.title,
  }));

  const packageObj: ConfigPackage = {
    format: CONFIG_PACKAGE_FORMAT,
    specVersion: LOGIN_SPEC_VERSION,
    requiredVars: requiredVarDefs,
    environments: [
      {
        name: environment.name,
        url: origin,
        loginMethod: environment.loginMethod,
        spec,
        requiredVars: requiredVarDefs,
      },
    ],
  };
  return { package: packageObj, issues: [] };
}

// ============================================================
// 导入校验
// ============================================================

/**
 * 校验待导入的配置包。
 *
 * 拒绝条件：
 * - 非 `dt-login-config/v1` 格式 / 未知格式 → 结构错误
 * - 包内任一环境 spec 含 `script` → `CONFIG_INVALID`（指出第几步）
 * - 任一变量 `secret: true` → `CONFIG_INVALID`（v1 直接拒绝）
 * - `specVersion > LOGIN_SPEC_VERSION` → 版本过高，请先升级扩展
 * - 包 `requiredVars` 或环境 `requiredVars` 里的名字不在对应 spec.vars
 *
 * 返回空数组 = 可导入。不修改任何输入（纯函数）。
 */
export function validateConfigPackage(raw: unknown): PackageIssue[] {
  const issues: PackageIssue[] = [];
  if (!isRecord(raw) || typeof raw.format !== "string") {
    return [{ code: "CONFIG_INVALID", message: "配置包格式无效" }];
  }
  if (raw.format !== CONFIG_PACKAGE_FORMAT) {
    return [
      {
        code: "CONFIG_INVALID",
        message:
          `配置包格式 ${raw.format} 不被支持（需要 ${CONFIG_PACKAGE_FORMAT}）`,
      },
    ];
  }

  // 版本过高拒绝（导入成功但行为诡异 < 明确拒绝并告知原因）
  if (
    typeof raw.specVersion === "number" &&
    raw.specVersion > LOGIN_SPEC_VERSION
  ) {
    return [
      {
        code: "CONFIG_INVALID",
        message:
          `配置包 spec 版本 ${raw.specVersion} 高于当前扩展支持的 ` +
          `${LOGIN_SPEC_VERSION}，请先升级扩展后再导入`,
      },
    ];
  }

  const envs: unknown[] = Array.isArray(raw.environments)
    ? raw.environments
    : [];
  if (envs.length === 0) {
    issues.push({ code: "CONFIG_INVALID", message: "配置包不含任何环境" });
  }

  // 包级 requiredVars（所有环境通用的变量集合）
  const packageRequired: string[] = [];
  if (Array.isArray(raw.requiredVars)) {
    for (const item of raw.requiredVars as unknown[]) {
      if (isRecord(item) && typeof item.name === "string") {
        packageRequired.push(item.name);
      }
    }
  }

  envs.forEach((env, envIndex) => {
    if (!isRecord(env)) {
      issues.push({
        code: "CONFIG_INVALID",
        message: `第 ${envIndex + 1} 个环境不是对象`,
      });
      return;
    }
    const spec = (env as { spec?: unknown }).spec;
    if (!isRecord(spec)) {
      issues.push({
        code: "CONFIG_INVALID",
        message: `第 ${envIndex + 1} 个环境缺少登录声明（spec）`,
      });
      return;
    }
    if ((spec as { version?: unknown }).version !== LOGIN_SPEC_VERSION) {
      issues.push({
        code: "CONFIG_INVALID",
        message:
          `第 ${envIndex + 1} 个环境的 spec 版本不支持` +
          `（需要 ${LOGIN_SPEC_VERSION}）`,
      });
      return;
    }

    const loginSpec = spec as unknown as LoginSpec;

    // 逐算子检查 script
    const scriptOps = findScriptOps(loginSpec);
    for (const s of scriptOps) {
      issues.push({
        code: "CONFIG_INVALID",
        message: s.message,
        ...(s.opIndex === undefined ? {} : { opIndex: s.opIndex }),
      });
    }

    // secret 变量直接拒绝（v1）
    const secretVars = findSecretVars(loginSpec);
    for (const name of secretVars) {
      issues.push({
        code: "CONFIG_INVALID",
        varName: name,
        message:
          `第 ${envIndex + 1} 个环境含敏感变量「${name}」（secret），` +
          "v1 配置包不允许分发敏感变量",
      });
    }

    // 环境级 requiredVars ⊆ spec.vars
    const envRequired = Array.isArray(
      (env as { requiredVars?: unknown }).requiredVars,
    )
      ? ((env as { requiredVars: unknown[] }).requiredVars
          .filter((item) => isRecord(item) && typeof item.name === "string")
          .map((item) => (item as { name: string }).name))
      : [];
    const overflow = checkRequiredVars(
      Array.from(new Set([...packageRequired, ...envRequired])),
      loginSpec,
    );
    for (const o of overflow) {
      issues.push({
        code: "CONFIG_INVALID",
        message: `第 ${envIndex + 1} 个环境：${o.message}`,
        ...(o.varName === undefined ? {} : { varName: o.varName }),
      });
    }
  });

  return issues;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}