/**
 * LoginSpec 执行器 `runSpec`（ADR-0015 D12）— 登录的唯一生产执行路径。
 *
 * 按 `ops[]` 顺序执行；算子产出的值进入绑定表（`$name`），逐算子轨迹记录
 * op / 下标 / 目标 / 耗时 / 状态 / 错误码。页面成功信号（`success` 中的
 * `page`）在算子结束后轮询，失败信号与验证码识别优先。
 *
 * 本票（03a–06）范围：导航与 DOM 算子、数据提取与脚本、成功信号轮询、
 * 会话算子（`clear.*` / `auth.*`）、HTTP 请求与改写（`http.execute` /
 * `apply.set`）、三类超时，数据变换（`digest` / `crypto.encrypt` /
 * `payload.build` / `map`），以及跨 origin 快照（`auth.capture` /
 * `auth.restore`，08）。
 *
 * tab 变更仍经 `login-tab-flow.applyNavigationIntent`（ADR-0004 D4）：
 * 「tab 变更收口在一个 module」的不变量不因算子化而改变。
 */

import type { AuthContext } from "../types";
import {
  ErrorCodes,
  LoginError,
  errorCodeOf,
  type ErrorCode,
} from "../utils/error-codes";
import { reloadTabAndWait, waitForTabLoaded } from "../utils/tab-load";
import {
  runDomAction,
  runDomRead,
  toTargetError,
  waitForDomTarget,
} from "../strategies/generic-dom";
import {
  currentUrl,
  describeCondition,
  detectCaptcha,
  evaluateCondition,
  snapshotPasswordField,
  waitForSettle,
  type BaselineState,
  type SettleContext,
} from "../strategies/generic-settle";
import { describeTarget } from "../strategies/generic-target";
import {
  resolveAutoLoginScan,
  scanLoginForm,
  type AutoLoginResolution,
} from "../strategies/login-form-scan";
import { applyNavigationIntent } from "../login-tab-flow";
import {
  autoLoginSpecShape,
  isAutoLoginTarget,
  loginFormTargetMode,
  projectLegacyDefaultSpec,
} from "./auto-login";
import { simpleSpecShape, type SimpleSpecShape } from "./editor";
import { buildInputNamespace } from "./namespace";
import {
  readBindingPath,
  resolveTemplate,
  resolveTemplateValue,
  TemplateError,
} from "./template";
import {
  DEFAULT_LIMITS,
  SPEC_OP_LABELS,
  type LoginSpec,
  type SettleCondition,
  type SpecLimits,
  type SpecOp,
  type SpecOpName,
  type SuccessSignal,
} from "./types";
import { collectRevealed, redactHeaders, redactTextBody } from "./redact";
import { runAuthWrite, runClearCookies, runClearStorage } from "./session";
import { runAuthCapture, runAuthRestore, isCapturedSnapshot } from "./snapshot";
import {
  runHttpExecute,
  type ApplySetChange,
  type HttpExecuteOp,
} from "./http";
import {
  runCryptoEncrypt,
  runDigest,
  runMap,
  runPayloadBuild,
  type TransformContext,
} from "./transform";

// ============================================================
// 结果形状
// ============================================================

/** 单个算子的执行轨迹（与 D12 的日志 `ops` 同形） */
export interface SpecOpTrace {
  index: number;
  op: SpecOpName | "auto.prepare";
  /** 目标描述（选择器 / URL / 条件），不含填充值等敏感内容 */
  target?: string;
  status: "success" | "error" | "skipped";
  duration: number;
  errorCode?: string;
  error?: string;
  /** 标准表单定位来源；高级自定义步骤缺省。 */
  resolution?: "auto" | "locked";
}

/**
 * 登录过程的日志素材（ADR-0015 D8）：最后一次 `http.execute` 的**已脱敏**
 * 请求 / 响应副本，供调试日志直接写入 `request` / `response`。
 * 只记录最后一次请求（多段式登录的中间请求已过时，不再逐条落 log）。
 */
export interface RunSpecLogView {
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
    /** `spec.log.reveal` 白名单命中的绑定原样值（黑名单优先，绝对不含敏感字段） */
    revealed?: Record<string, string>;
  };
  response: {
    status: number;
    body: string;
  };
}

export type RunSpecResult =
  | {
      success: true;
      bindings: Record<string, unknown>;
      trace: SpecOpTrace[];
      lastGotoUrl?: string;
      /** 最后一次 http.execute 的脱敏日志素材（无请求时缺省） */
      log?: RunSpecLogView;
      /** 试登录模式下逐条数据成功信号的状态 */
      trialSignals?: TrialSignalState[];
    }
  | {
      success: false;
      bindings: Record<string, unknown>;
      trace: SpecOpTrace[];
      lastGotoUrl?: string;
      error: string;
      errorCode: ErrorCode;
      /** 最后一次 http.execute 的脱敏日志素材（无请求时缺省） */
      log?: RunSpecLogView;
      /** 试登录模式下逐条数据成功信号的状态 */
      trialSignals?: TrialSignalState[];
    };

/**
 * 试登录模式下单条成功信号的状态。
 * 用于界面区分「请求已成功发出」与「成功信号未满足」并展示命中的信号。
 */
export interface TrialSignalState {
  /** 信号的可读描述 */
  description: string;
  met: boolean;
  /** true = 页面类信号，试登录不执行页面算子，无法验证（默认不算失败） */
  skipped?: boolean;
}

/**
 * 试登录模式选项：
 * - 缺省只执行 `http.execute`（含数据变换 `apply.set / digest / crypto.encrypt /
 *   payload.build / map`）与数据成功信号解析；不执行 `goto` / `auth.write` /
 *   页面 / 会话 / 跨 origin 算子，不接触用户当前标签页。
 * - `writeSession` 为 true 时才执行 `auth.write`（「能换到凭据」到「已登录」的分界）。
 */
export interface TrialOptions {
  /** true 时允许执行 `auth.write`（写会话）；缺省 false 不写 */
  writeSession?: boolean;
}

export interface RunSpecOpEvent {
  phase: "start" | "end";
  index: number;
  op: SpecOpName | "auto.prepare";
  trace?: SpecOpTrace;
}

export interface RunSpecOptions {
  /**
   * 算子开始 / 结束事件（调试日志与实时进度）。
   * 执行器会 `await` 返回值：日志写入是读-改-写，并发会丢条目。
   */
  onOp?: (event: RunSpecOpEvent) => void | Promise<void>;
  /**
   * 由引擎生成的输入（`aux.nonce` / `aux.timestamp`）。
   * 缺省时按当前时间与加密安全随机源生成；测试注入固定值以获得可断言请求。
   */
  aux?: { nonce: string; timestamp: number };
  /**
   * 仅测试使用的覆盖值（如缩短轮询间隔）
   */
  settle?: { pollingIntervalMs?: number };
  /** 试登录模式：默认零副作用 */
  trial?: TrialOptions;
  /**
   * 试登录模式下禁止执行的算子集合（默认成组禁止 goto / auth.write /
   * 页面 / 会话 / 快照算子）。测试注入以覆盖缺省行为；生产默认由 RunState
   * 计算，不依赖调用方传值。
   */
  deniedOps?: Set<SpecOpName>;
}

// ============================================================
// 算子支持范围
// ============================================================

// ============================================================
// 输入 / 绑定
// ============================================================

/** 生成 aux 输入：nonce = 8 位十进制随机 + 毫秒时间戳（ADR-0015 D2） */
export function generateAuxInputs(now: number = Date.now()): {
  nonce: string;
  timestamp: number;
} {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  const digits = String(random[0]).padStart(10, "0").slice(0, 8);
  return { nonce: digits + now, timestamp: now };
}

/**
 * 构建输入命名空间的值表（摊平后的内置输入 / vars / aux）。
 *
 * 与校验器共用 `buildInputNamespace`：保存期认为可用的名字，运行期一定取得到值。
 *
 * `vars` 的取值优先级（ADR-0019）：**环境覆盖 > 声明默认值**。
 * 环境覆盖存在 `DomainConfig.vars`：同一份共享策略绑到多个环境时，
 * 环境差异（API 地址、公钥等）放这里，不必各存一份声明。
 */
export function buildSpecInputs(
  spec: LoginSpec,
  ctx: AuthContext,
  aux: { nonce: string; timestamp: number },
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {
    username: ctx.credentials.username,
    password: ctx.credentials.password,
    origin: ctx.origin,
    targetUrl: ctx.targetUrl ?? "",
    debugRedirect: ctx.debugRedirect ?? "",
  };
  const overrides = ctx.domainConfig?.vars ?? {};
  const { names } = buildInputNamespace(spec);
  for (const variable of spec.vars ?? []) {
    if (!names.has(variable.name)) continue;
    const override = overrides[variable.name];
    inputs[variable.name] =
      override !== undefined && override !== ""
        ? override
        : (variable.default ?? "");
  }
  if (spec.aux?.nonce === "auto") inputs.nonce = aux.nonce;
  if (spec.aux?.timestamp === "auto")
    inputs.timestamp = stringifyAux(aux.timestamp);
  return inputs;
}

/** `{timestamp}` 以字符串进入模板（与 `{name}` 的字符串语义一致） */
function stringifyAux(value: number): string {
  return String(value);
}

/** ADR-0015 D1 的 `goto.when` 假值集合：`""` / `0` / `false` / `null` / `undefined` */
function isTruthy(value: unknown): boolean {
  return !(
    value === undefined ||
    value === null ||
    value === false ||
    value === "" ||
    value === 0
  );
}

// ============================================================
// 试登录：request 平面算子白名单
// ============================================================

/**
 * 试登录默认允许执行的算子（「request 平面」）：只发请求、只变换数据，
 * 不产生写入 / 导航 / 页面副作用。
 *
 * 请求插值可能依赖的数据变换算子（digest / crypto.encrypt / payload.build /
 * map / apply.set）必须放行——否则多数登录请求在试登录里根本构造不出
 * （签名 / 密文 / 请求体都缺）。`extract` 一律排除：所有来源都要碰用户
 * 当前标签页 / cookie 存储 / 页面 DOM，违反「不碰当前标签页」。`auth.write`
 * 仅当用户显式勾选「写入会话」时才放行。
 */
export function trialAllowedOps(writeSession: boolean): Set<SpecOpName> {
  const allowed: SpecOpName[] = [
    "http.execute",
    "apply.set",
    "digest",
    "crypto.encrypt",
    "payload.build",
    "map",
  ];
  // 仅当用户显式勾选「写入会话」时才放行 auth.write
  if (writeSession) allowed.push("auth.write");
  return new Set(allowed);
}

/** 试登录模式下判断某算子是否允许执行（不合法的拒绝原因；null = 允许）。 */
function trialDenyReason(
  op: SpecOp,
  writeSession: boolean,
  deniedOps?: Set<SpecOpName>,
): string | null {
  // 显式覆盖（测试用）优先；覆盖为空集表示禁止一切
  if (deniedOps) {
    if (deniedOps.has(op.op)) return "试登录不执行该算子";
    return null;
  }
  const allowed = trialAllowedOps(writeSession);
  if (allowed.has(op.op)) return null;
  // 声明了 default 的 extract 在试登录里安全：不触达页面，直接回退字面量。
  // 可用它产出 pageLanguage（default:"zh"），后续 map 引用
  // $pageLanguage；不豁免会让「读改」链断开（第 2 步 map 报「未解析的绑定引用」）。
  if (
    op.op === "extract" &&
    typeof (op as SpecOp & { default?: unknown }).default === "string"
  ) {
    return null;
  }
  return "试登录不执行该算子";
}

// ============================================================
// 条件求值（成功 / 失败信号）
// ============================================================

function readSignalPath(
  signal: { from: string; path: string },
  bindings: Record<string, unknown>,
): { found: boolean; value: unknown } {
  if (!Object.hasOwn(bindings, signal.from)) {
    return { found: false, value: undefined };
  }
  return readBindingPath(bindings[signal.from], signal.path);
}

/** 单条成功信号，返回未满足的原因（满足时返回 null） */
function evaluateSuccessSignal(
  signal: SuccessSignal,
  bindings: Record<string, unknown>,
): string | null {
  if ("anyOf" in signal) {
    const reasons: string[] = [];
    for (const child of signal.anyOf) {
      const reason = evaluateSuccessSignal(child, bindings);
      // anyOf 是「任一成立」：任一子信号满足即整体满足
      if (reason === null) return null;
      reasons.push(reason);
    }
    return `任一条件均未满足（${reasons.join("；")}）`;
  }
  if ("page" in signal) return null;
  if ("response" in signal) {
    const { from, path, equals } = signal.response;
    const { found, value } = readSignalPath({ from, path }, bindings);
    if (!found) return `响应路径 $${from}.${path} 不存在`;
    if (equals !== undefined && value !== equals) {
      return `响应路径 $${from}.${path} 的值不等于 ${JSON.stringify(equals)}`;
    }
    if (equals === undefined && !isTruthy(value)) {
      return `响应路径 $${from}.${path} 的值为空`;
    }
    return null;
  }
  const { from, path } = signal.token;
  const { found, value } = readSignalPath({ from, path }, bindings);
  if (!found || !isTruthy(value)) return `未取到 token：$${from}.${path}`;
  return null;
}

/**
 * 试登录：把 `success[]` 里的页面类信号剔除，只保留可静态判定的数据信号
 * （response / token / 纯 anyOf）。页面算子不在试登录中执行，页面条件
 * 无法验证，因此从信号集里剥掉——它们既不算失败也不算命中。
 */
function stripPageSignals(signals: SuccessSignal[]): SuccessSignal[] {
  const out: SuccessSignal[] = [];
  const keep = (signal: SuccessSignal) => {
    if ("page" in signal) return;
    if ("anyOf" in signal) {
      const children = signal.anyOf.filter((child) => !("page" in child));
      if (children.length > 0) out.push({ anyOf: children });
      return;
    }
    out.push(signal);
  };
  signals.forEach(keep);
  return out;
}

/** 试登录：为每条数据成功信号求值并生成界面可展示的状态。 */
function evaluateDataSignals(
  signals: SuccessSignal[],
  bindings: Record<string, unknown>,
): TrialSignalState[] {
  return signals.map((signal) => ({
    description: describeSignal(signal),
    met: evaluateSuccessSignal(signal, bindings) === null,
  }));
}

/**
 * 试登录：成功信号状态 + 是否满足的报告。
 * - 页面信号被剥掉（trial 不执行页面算子）
 * - 剥离后无数据信号时，请求成功即视为「可换到凭据」试验通过
 * - 数据信号任一未满足 → 试登录未通过（请求成功但成功条件未满足）
 */
interface TrialSignalStateResult {
  signals: TrialSignalState[];
  /**
   * ALL = 全部（数据）信号满足（或无数据信号，请求成功即通过）；
   * PARTIAL = 存在未满足的数据信号；
   * NONE = 没有可判定的数据信号（响应结构未知，不能因缺信号判失败）。
   */
  status: "ALL" | "PARTIAL" | "NONE";
}

function evaluateTrialSignals(
  spec: LoginSpec,
  bindings: Record<string, unknown>,
): TrialSignalStateResult {
  const data = stripPageSignals(spec.success);
  if (data.length === 0) return { signals: [], status: "NONE" };
  const states = evaluateDataSignals(data, bindings);
  const unmet = states.filter((s) => !s.met);
  return {
    signals: states,
    status: unmet.length === 0 ? "ALL" : "PARTIAL",
  };
}

/**
 * `failure[]` 是 OR：包装成单个条件交给 `waitForSettle`，
 * 避免只取首条而漏掉其余中止信号（ADR-0015 D5）。
 */
function failureConditionOf(spec: LoginSpec): SettleCondition | undefined {
  const failures = spec.failure ?? [];
  if (failures.length === 0) return undefined;
  return failures.length === 1 ? failures[0] : { type: "any", of: failures };
}

/** 信号的可读描述（超时错误信息里逐条列出） */
function describeSignal(signal: SuccessSignal): string {
  if ("page" in signal) return describeCondition(signal.page);
  if ("anyOf" in signal) {
    return `任一成立（${signal.anyOf.map(describeSignal).join(" / ")}）`;
  }
  if ("response" in signal) {
    return `响应路径 $${signal.response.from}.${signal.response.path}`;
  }
  return `token $${signal.token.from}.${signal.token.path}`;
}

/**
 * 求值单条成功信号。
 *
 * 轮询阶段所有算子已执行完，绑定表是完整的，因此 response / token 信号
 * 也能在同一周期静态判定；`anyOf` 是 OR，其余数组层级是 AND。
 */
async function evaluateSignal(
  signal: SuccessSignal,
  bindings: Record<string, unknown>,
  ctx: SettleContext,
  baseline: BaselineState,
): Promise<boolean> {
  if ("page" in signal) return evaluateCondition(ctx, signal.page, baseline);
  if ("anyOf" in signal) {
    for (const child of signal.anyOf) {
      if (await evaluateSignal(child, bindings, ctx, baseline)) return true;
    }
    return false;
  }
  return evaluateSuccessSignal(signal, bindings) === null;
}

// ============================================================
// 页面轮询
// ============================================================

interface PagePollOptions {
  tabId: number;
  spec: LoginSpec;
  limits: Required<SpecLimits>;
  /** 已执行算子的绑定表（response / token 信号据此静态判定） */
  bindings: Record<string, unknown>;
  /** 点击前预采的密码框基准（formGone） */
  passwordFieldPresent: boolean;
  /** 点击前预采的 URL 基准（urlChanged） */
  baselineUrl?: string;
  pollingIntervalMs?: number;
}

/**
 * 轮询成功信号直到全部成立。
 *
 * - 每个周期先查失败信号（失败优先，ADR-0012 D4）与验证码文案
 * - 数组即 AND：`success` 里所有信号都成立才算成功；`anyOf` 是 OR
 * - 页面条件随后轮询；纯数据信号每周期静态求值，算子结束后必然已可判定
 * - 超时 → `SUCCESS_CONDITION_UNMET`，消息区分页面条件与响应路径
 *
 * 即使 `success` 只有 response / token（无页面条件）也要跑一个周期：
 * D5 的失败信号与验证码识别挂在轮询阶段，不能因「没有页面条件」而跳过。
 */
async function pollPageSignals(opts: PagePollOptions): Promise<void> {
  const signals = opts.spec.success;
  // R7 保证至少一条；空数组时无事可判（避免 Math.max(...[]) 取到 -Infinity）
  if (signals.length === 0) return;
  const pageConditions = collectPageConditions(signals);
  const interval = opts.pollingIntervalMs ?? 200;
  const deadline = Date.now() + opts.limits.settleMs;
  const baseline: BaselineState = { initialUrl: opts.baselineUrl };
  const settleCtx: SettleContext = {
    tabId: opts.tabId,
    passwordFieldPresent: opts.passwordFieldPresent,
  };
  const bindings = opts.bindings;
  /** 失败信号 + 验证码（D5：失败优先，验证码同周期检查） */
  const assertNotRejected = async (): Promise<void> => {
    for (const failure of opts.spec.failure ?? []) {
      if (await evaluateCondition(settleCtx, failure, baseline)) {
        throw new LoginError(
          ErrorCodes.LOGIN_REJECTED,
          `登录被拒绝：命中失败条件「${describeCondition(failure)}」`,
        );
      }
    }
    if (await detectCaptcha(opts.tabId)) {
      throw new LoginError(
        ErrorCodes.CAPTCHA_REQUIRED,
        "登录需要验证码：请在弹出的页面中完成验证后重试",
      );
    }
  };

  // 固定等待（legacy `successType: "timeout"` 的迁移形态）：真实 sleep 后成功。
  // 只有全部信号都是固定等待时才走这条快路径；混有数据 / 其他页面条件时
  // `fixed` 由 evaluateCondition 视为立即满足，与旧引擎一致。
  const fixedOnly =
    signals.every(isFixedPageSignal) &&
    pageConditions.every((c) => c.type === "fixed");
  if (fixedOnly) {
    const ms = Math.max(
      ...pageConditions.map((c) => (c.type === "fixed" ? c.ms : 0)),
    );
    await new Promise((r) => setTimeout(r, ms));
    // sleep 期间页面也可能报错：成功判定前仍要先看失败信号
    await assertNotRejected();
    return;
  }

  // 纯数据信号（response / token）：重试不会改变已取到的绑定，
  // 但仍要跑一个周期，让失败信号 / 验证码拿到「失败优先」的机会。
  const staticOnly = pageConditions.length === 0;
  let last: Array<{ description: string; met: boolean }> = [];

  while (Date.now() < deadline) {
    await assertNotRejected();

    last = [];
    let allMet = true;
    for (const signal of signals) {
      const met = await evaluateSignal(signal, bindings, settleCtx, baseline);
      last.push({ description: describeSignal(signal), met });
      if (!met) allMet = false;
    }
    if (allMet) return;
    if (staticOnly) break;
    await new Promise((r) => setTimeout(r, interval));
  }

  const detail = last
    .map((s) => `${s.description}: ${s.met ? "已满足" : "未满足"}`)
    .join("；");
  // 区分「等页面」与「数据不对」：D5 要求消息能分辨响应路径与页面条件
  const hasData = signals.some((s) => !isPageOnlySignal(s));
  const kind = staticOnly
    ? "响应路径条件未满足"
    : hasData
      ? "成功条件未满足"
      : "页面成功条件未满足";
  const waited = staticOnly ? "" : `等待超时 (${opts.limits.settleMs}ms)：`;
  throw new LoginError(
    ErrorCodes.SUCCESS_CONDITION_UNMET,
    `${waited}${kind}${detail ? `（${detail}）` : ""}`,
  );
}

/** 信号是否只由页面条件构成（anyOf 的成员也必须全是 page） */
function isPageOnlySignal(signal: SuccessSignal): boolean {
  if ("page" in signal) return true;
  if ("anyOf" in signal) return signal.anyOf.every(isPageOnlySignal);
  return false;
}

/** 信号是否为「固定等待」页面条件（legacy `successType: "timeout"`） */
function isFixedPageSignal(signal: SuccessSignal): boolean {
  if ("page" in signal) return signal.page.type === "fixed";
  if ("anyOf" in signal) return signal.anyOf.every(isFixedPageSignal);
  return false;
}

/** 收集全部页面条件（递归展开 anyOf） */
function collectPageConditions(signals: SuccessSignal[]): SettleCondition[] {
  const out: SettleCondition[] = [];
  const walk = (signal: SuccessSignal) => {
    if ("page" in signal) {
      out.push(signal.page);
      return;
    }
    if ("anyOf" in signal) signal.anyOf.forEach(walk);
  };
  signals.forEach(walk);
  return out;
}

// ============================================================
// 页面脚本
// ============================================================

/**
 * 在页面内执行 spec 的 `script` 算子。
 *
 * - `code` 是函数表达式 `(bindings) => …`；不做模板解析（D1）
 * - `bindings` 是只读副本；返回值整体成为 `$<as>`
 * - 失败靠 `throw`，引擎归一为 `LOGIN_REJECTED`，不再识别 `success` 字段
 * - 默认 `MAIN`（保持存量行为）；`ISOLATED` 不是安全边界
 */
async function runPageScript(
  tabId: number,
  code: string,
  bindings: Record<string, unknown>,
  world: "MAIN" | "ISOLATED",
): Promise<unknown> {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world,
    func: (source: string, serializedBindings: string) => {
      try {
        const factory = new Function(`return (${source});`)() as (
          b: unknown,
        ) => unknown;
        if (typeof factory !== "function") {
          return { ok: false as const, error: "脚本必须是函数表达式" };
        }
        const input = JSON.parse(serializedBindings) as Record<string, unknown>;
        const copy = Object.freeze({ ...input });
        const value = factory(copy);
        return { ok: true as const, value: value === undefined ? null : value };
      } catch (e) {
        return {
          ok: false as const,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    },
    args: [code, JSON.stringify(bindings)],
  });
  // 跨 frame 执行：任一 frame 成功即取该 frame 的返回值。
  // 其他 frame 的失败（如 iframe 无权限、脚本不适用）不得掩盖成功结果；
  // 全部失败才抛错——错误优先取主 frame（结果列表首项）。
  let firstError: string | undefined;
  for (const result of results ?? []) {
    const value = result.result as
      | { ok: true; value: unknown }
      | { ok: false; error: string }
      | null;
    if (value && typeof value === "object" && "ok" in value) {
      if (value.ok) return value.value;
      firstError ??= value.error;
    }
  }
  if (firstError !== undefined) {
    throw new LoginError(
      ErrorCodes.LOGIN_REJECTED,
      `脚本执行失败: ${firstError}`,
    );
  }
  return null;
}

// ============================================================
// extract
// ============================================================

/** 在页面内读取 storage（`extract` 的 local / session 源） */
async function extractInPage(
  tabId: number,
  source: "local" | "session",
  key: string,
): Promise<unknown> {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "MAIN",
    func: (src: string, k: string) => {
      const store = src === "local" ? localStorage : sessionStorage;
      return store.getItem(k);
    },
    args: [source, key],
  });
  for (const result of results ?? []) {
    if (result.result !== null && result.result !== undefined) {
      return result.result;
    }
  }
  return null;
}

/**
 * cookie 的 domain 是否覆盖当前登录 origin（host-only 时 domain 即 host）。
 * 前导点表示子域通配（`.example.com` 覆盖 `a.example.com`）。
 */
function cookieMatchesOrigin(
  cookie: { domain?: string },
  origin: string,
): boolean {
  if (typeof cookie.domain !== "string" || !cookie.domain) return false;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  const domain = cookie.domain.replace(/^\./, "").toLowerCase();
  const target = host.toLowerCase();
  return target === domain || target.endsWith(`.${domain}`);
}

/** `parse: "jsonValue"`：把取到的字符串再解析一次（如 `"en"` → `en`） */
function parseExtracted(value: unknown, parse: "raw" | "jsonValue"): unknown {
  if (parse === "jsonValue" && typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

async function extractOpValue(
  op: Extract<SpecOp, { op: "extract" }>,
  ctx: AuthContext,
  inputs: Record<string, unknown>,
  bindings: Record<string, unknown>,
): Promise<unknown> {
  const key =
    op.key === undefined ? "" : resolveTemplate(op.key, { inputs, bindings });
  const parse = op.parse ?? "raw";
  let raw: unknown;
  switch (op.source) {
    case "url": {
      const url = await currentUrl(ctx.tabId);
      if (!key) {
        raw = url;
        break;
      }
      try {
        raw = new URL(url).searchParams.get(key);
      } catch {
        raw = null;
      }
      break;
    }
    case "cookie": {
      // ADR-0015 D1：读取**当前登录 origin** 的 cookie，取第一个匹配值。
      // 不用 `{ url }` 过滤（那会按 path 收窄、漏掉登录 origin 的其它路径），
      // 改为按 cookie domain 与 origin host 匹配，再按 name 取首个。
      const scopeOrigin = ctx.currentTabUrl ?? ctx.origin;
      const cookies = await chrome.cookies.getAll({ name: key });
      raw =
        cookies.find((cookie) => cookieMatchesOrigin(cookie, scopeOrigin))
          ?.value ?? null;
      break;
    }
    case "dom": {
      // 跨 frame / Shadow DOM 定位；歧义与找不到按算子错误报出。
      // （extract 不带 FrameScope：全 frame 搜索，唯一命中才读值）
      const read = await runDomRead(ctx.tabId, key);
      if (!read.ok) throw read.error;
      raw = read.value;
      break;
    }
    case "local":
    case "session":
      raw = await extractInPage(ctx.tabId, op.source, key);
      break;
  }
  // `parse` 对五个来源一致生效（ADR-0015 D1 的 extract 契约）
  return parseExtracted(raw, parse);
}

// ============================================================
// 算子执行
// ============================================================

function describeOp(op: SpecOp): string | undefined {
  switch (op.op) {
    case "goto":
      return op.url;
    case "fill":
    case "click":
      return isAutoLoginTarget(op.target)
        ? "自动（登录表单）"
        : describeTarget(op.target);
    case "waitFor":
      return describeCondition(op.when);
    case "extract":
      return op.source === "url" ? op.key : `${op.source}:${op.key ?? ""}`;
    case "clear.cookies":
      return op.range === "all"
        ? `all${op.includeParent ? " (+父域)" : ""}`
        : Array.isArray(op.range)
          ? op.range.join(",")
          : op.range;
    case "clear.storage":
      return `${op.area}:${op.range === "all" ? "all" : Array.isArray(op.range) ? op.range.join(",") : op.range}`;
    case "auth.write":
      return undefined;
    case "auth.capture":
      return `→ ${op.as}`;
    case "auth.restore":
      return `快照 ${op.snapshot}`;
    case "script":
      return undefined;
    case "http.execute":
      return `${op.method ?? "GET"} ${op.url}`;
    case "apply.set":
      return `${op.target}.${op.key}`;
    case "digest":
      return `${op.algorithm}`;
    case "crypto.encrypt":
      return op.algorithm;
    case "payload.build":
      return op.parts.every((p) => p.key !== undefined) ? "对象" : "字符串";
    case "map":
      return `→ ${op.as}`;
    default:
      return undefined;
  }
}

interface RunState {
  spec: LoginSpec;
  ctx: AuthContext;
  limits: Required<SpecLimits>;
  inputs: Record<string, unknown>;
  bindings: Record<string, unknown>;
  lastGotoUrl?: string;
  /** 待落位的 apply.set 改写（作用于其后最近一个 http.execute） */
  applySet: ApplySetChange[];
  /** settle 基准：click / script 执行前刷新 */
  baseline: { passwordFieldPresent: boolean; initialUrl?: string };
  /** 最后一次 http.execute 的脱敏日志素材（ADR-0015 D8） */
  logView?: RunSpecLogView;
  /** 试登录：为 true 时按缺省白名单执行，默认零副作用 */
  trial: boolean;
  /** 标准表单下标与本次唯一的自动解析结果。 */
  formShape: SimpleSpecShape | null;
  autoShape: SimpleSpecShape | null;
  autoResolution?: Extract<AutoLoginResolution, { status: "resolved" }>;
  autoRefreshAttempts: 0 | 1;
}

/** 试登录模式下：算子是否被拒（被拒返回原因；允许返回 null）。 */
function trialRejectsOp(op: SpecOp, options: RunSpecOptions): string | null {
  if (!options.trial) return null;
  return trialDenyReason(
    op,
    options.trial.writeSession === true,
    options.deniedOps,
  );
}

function wrapTemplateError(e: unknown): LoginError {
  if (e instanceof TemplateError) {
    return new LoginError(
      e.code === "TEMPLATE_UNRESOLVED"
        ? ErrorCodes.TEMPLATE_UNRESOLVED
        : ErrorCodes.CONFIG_INVALID,
      e.message,
    );
  }
  return e instanceof LoginError
    ? e
    : new LoginError(
        errorCodeOf(e),
        e instanceof Error ? e.message : String(e),
      );
}

/** Chrome 拒绝向错误页注入时，将底层异常翻译成可操作的登录提示。 */
function wrapExecutionError(e: unknown, origin: string): LoginError {
  const error = wrapTemplateError(e);
  if (!/showing error page/i.test(error.message)) return error;
  return new LoginError(
    error.code,
    `无法访问登录页面 ${origin}，请确认服务已启动且地址可访问（${error.message}）`,
  );
}

/** 模板求值：未解析引用 → TEMPLATE_UNRESOLVED（D4） */
function resolveRef(state: RunState, template: string): string {
  try {
    return resolveTemplate(template, {
      inputs: state.inputs,
      bindings: state.bindings,
    });
  } catch (e) {
    throw wrapTemplateError(e);
  }
}

/** 解析并登记一条 apply.set 改写（等到下一个 http.execute 落位）。 */
function collectApplySet(
  state: RunState,
  op: Extract<SpecOp, { op: "apply.set" }>,
): void {
  const value = resolveRef(state, op.value);
  state.applySet.push({ target: op.target, key: op.key, value });
}

/**
 * 单次 DOM 交互超时（ADR-0015 D6）：fill / click / extract / script 共用
 * `limits.stepMs`，超时报 `STEP_TIMEOUT`。用 Promise 竞速实现真正的中断回退。
 */
async function withStepTimeout<T>(
  state: RunState,
  promise: Promise<T>,
  label: string,
): Promise<T> {
  const stepMs = state.limits.stepMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new LoginError(ErrorCodes.STEP_TIMEOUT, `${label} 超时（${stepMs}ms）`),
      );
    }, stepMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function refreshSettleBaseline(state: RunState): Promise<void> {
  state.baseline.passwordFieldPresent = await snapshotPasswordField(
    state.ctx.tabId,
  );
  state.baseline.initialUrl = await currentUrl(state.ctx.tabId);
}

function automaticResolutionError(resolution: AutoLoginResolution): LoginError {
  switch (resolution.status) {
    case "noPassword":
      return new LoginError(
        ErrorCodes.LOGIN_FORM_NOT_FOUND,
        "未找到可用的登录表单",
      );
    case "incomplete":
      return new LoginError(
        ErrorCodes.LOGIN_FORM_INCOMPLETE,
        `未找到完整登录表单：${resolution.reason}`,
      );
    case "ambiguous":
      return new LoginError(
        ErrorCodes.LOGIN_FORM_AMBIGUOUS,
        `检测到多个候选，无法确定：${resolution.reason}`,
      );
    case "error":
      return new LoginError(
        ErrorCodes.TAB_RESTRICTED,
        `无法扫描登录表单：${resolution.message}`,
      );
    default:
      throw new Error("resolved 不是定位失败");
  }
}

function frameUrlForLog(frameUrl: string): string {
  try {
    const url = new URL(frameUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return frameUrl.split(/[?#]/, 1)[0];
  }
}

function resolutionSummary(resolution: AutoLoginResolution): string {
  if (resolution.status === "resolved") {
    return `自动定位成功：${resolution.status}，frame ${resolution.frameId}${resolution.frameUrl ? `（${frameUrlForLog(resolution.frameUrl)}）` : ""}`;
  }
  if (resolution.status === "noPassword") return "自动定位：noPassword";
  if (resolution.status === "error")
    return `自动定位失败：${resolution.status}`;
  return `自动定位失败：${resolution.status}（${resolution.reason}）`;
}

/** 首个自动算子前解析一次；后续三个算子只复用本次 RunState。 */
async function resolveAutomaticOp(
  state: RunState,
  op: Extract<SpecOp, { op: "fill" | "click" }>,
  index: number,
  recordPreparation: (message: string) => Promise<void>,
): Promise<SpecOp> {
  if (!state.autoShape) {
    throw new LoginError(
      ErrorCodes.CONFIG_INVALID,
      "自动定位只适用于连续的用户名、密码、登录按钮",
    );
  }
  if (!state.autoResolution) {
    let resolution = resolveAutoLoginScan(await scanLoginForm(state.ctx.tabId));
    await recordPreparation(resolutionSummary(resolution));
    if (resolution.status === "noPassword" && state.autoRefreshAttempts === 0) {
      state.autoRefreshAttempts = 1;
      await recordPreparation("未发现密码框，刷新后重试（1/1）");
      await reloadTabAndWait(state.ctx.tabId, state.limits.settleMs);
      resolution = resolveAutoLoginScan(await scanLoginForm(state.ctx.tabId));
      await recordPreparation(resolutionSummary(resolution));
    }
    if (resolution.status !== "resolved")
      throw automaticResolutionError(resolution);
    state.autoResolution = resolution;
  }
  const role =
    index === state.autoShape.usernameIndex
      ? "username"
      : index === state.autoShape.passwordIndex
        ? "password"
        : "submit";
  const resolved = state.autoResolution;
  const { frameId: _frameId, frameUrl: _frameUrl, ...withoutScope } = op;
  return {
    ...withoutScope,
    target: resolved.targets[role],
    ...resolved.scope,
  } as SpecOp;
}

/** 执行一个算子；返回 `skipped` 表示未执行（轨迹不记 error） */
async function executeOp(
  state: RunState,
  op: SpecOp,
  deny: string | null,
): Promise<"done" | "skipped"> {
  const { ctx } = state;

  // 试登录：被拒的算子一律 `skipped`，绝不抛错——
  // 页面 / 写会话 / 导航算子在默认试登录里不执行，但 spec 仍按原顺序继续
  // 跑完，好让后面的 http.execute 能发出请求、让结果区分「请求成功」与
  // 「成功信号未满足」。
  if (deny !== null) return "skipped";

  switch (op.op) {
    // —— 会话清理与写入（03b 实现，D7）——
    case "clear.cookies": {
      await runClearCookies(ctx.origin, op);
      return "done";
    }

    case "clear.storage": {
      await runClearStorage(ctx.tabId, op);
      return "done";
    }

    case "auth.write": {
      await runAuthWrite(ctx.tabId, ctx.origin, state.spec.auth, {
        inputs: state.inputs,
        bindings: state.bindings,
      });
      return "done";
    }

    // auth.capture / auth.restore（跨 origin，08 实现）
    case "auth.capture": {
      state.bindings[op.as] = await runAuthCapture(ctx.tabId, ctx.origin, op);
      return "done";
    }

    case "auth.restore": {
      const snapshot = state.bindings[op.snapshot];
      if (snapshot === undefined || !isCapturedSnapshot(snapshot)) {
        throw new LoginError(
          ErrorCodes.CONFIG_INVALID,
          `快照「${op.snapshot}」不是有效的 auth.capture 产出`,
        );
      }
      await runAuthRestore(ctx.tabId, snapshot);
      return "done";
    }

    case "goto": {
      if (op.when !== undefined) {
        const gate = resolveTemplateValue(op.when, {
          inputs: state.inputs,
          bindings: state.bindings,
        });
        if (!isTruthy(gate)) return "skipped";
      }
      const url = resolveRef(state, op.url);
      try {
        await applyNavigationIntent(ctx.tabId, { action: "navigate", url });
      } catch (e: unknown) {
        throw new LoginError(
          errorCodeOf(e),
          `导航失败: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      state.lastGotoUrl = url;
      if (op.waitForLoad !== false) {
        await waitForTabLoaded(
          ctx.tabId,
          op.timeoutMs ?? state.limits.settleMs,
        );
      }
      if (op.waitForTarget) {
        const error = await waitForDomTarget(
          ctx.tabId,
          op.waitForTarget,
          op.timeoutMs ?? state.limits.settleMs,
        );
        if (error) throw error;
      }
      return "done";
    }

    case "fill": {
      if (isAutoLoginTarget(op.target)) {
        throw new LoginError(ErrorCodes.CONFIG_INVALID, "自动登录表单尚未解析");
      }
      const value = resolveRef(state, op.value);
      const outcome = await withStepTimeout(
        state,
        runDomAction(
          ctx.tabId,
          {
            action: "fill",
            target: op.target,
            value,
            clearFirst: op.clearFirst !== false,
          },
          op,
        ),
        `填充 ${describeTarget(op.target)}`,
      );
      const error = toTargetError(outcome, describeTarget(op.target));
      if (error) throw error;
      return "done";
    }

    case "click": {
      if (isAutoLoginTarget(op.target)) {
        throw new LoginError(ErrorCodes.CONFIG_INVALID, "自动登录表单尚未解析");
      }
      // 点击可能触发表单提交跳转：先把 settle 基准刷新到「提交前一刻」
      await refreshSettleBaseline(state);
      const outcome = await withStepTimeout(
        state,
        runDomAction(ctx.tabId, { action: "click", target: op.target }, op),
        `点击 ${describeTarget(op.target)}`,
      );
      const error = toTargetError(
        outcome,
        describeTarget(op.target),
        op.onNotFound ?? "fail",
      );
      if (error) throw error;
      return outcome.status === "ok" ? "done" : "skipped";
    }

    case "waitFor": {
      const when = op.when;
      if (when.type === "fixed") {
        await new Promise((r) => setTimeout(r, when.ms));
        return "done";
      }
      // waitFor 归 settleMs（D6）：waitForSettle 内部已按 timeoutMs 收口，
      // 不再套 stepMs——stepMs 只约束 fill/click/extract/script 单次 DOM 交互。
      await waitForSettle({
        tabId: ctx.tabId,
        settle: when,
        failWhen: failureConditionOf(state.spec),
        timeoutMs: op.timeoutMs ?? state.limits.settleMs,
        passwordFieldPresent: state.baseline.passwordFieldPresent,
        baselineUrl: state.baseline.initialUrl,
      });
      return "done";
    }

    case "extract": {
      // 试登录（无页面上下文，tabId=-1）：只回退声明里的 default，不触达页面。
      // 声明了 default 的 extract 因此允许执行（见 trialDenyReason）；未声明
      // default 的 extract 仍被拒（skipped），保持「试登录零副作用」不变量。
      if (state.trial && op.default !== undefined) {
        state.bindings[op.as] = op.default;
        return "done";
      }
      let value: unknown;
      try {
        value = await withStepTimeout(
          state,
          extractOpValue(op, ctx, state.inputs, state.bindings),
          `提取 ${op.source}${op.key ? `/${op.key}` : ""}`,
        );
      } catch (e) {
        // dom 源的定位错误（找不到 / 歧义 / 选择器非法）已带专属错误码，原样上抛
        throw wrapTemplateError(e);
      }
      if (value === null || value === undefined || value === "") {
        // 声明了 default 字面量时回退，而非抛错——让「缺失语言回 zh」这类
        // 静默兜底的场景可声明（ADR-0015「静默回退」here 特指 extract 的
        // storage 回退，不排除显式 default）。
        if (op.default !== undefined) {
          state.bindings[op.as] = op.default;
          return "done";
        }
        throw new LoginError(
          ErrorCodes.LOGIN_REJECTED,
          `提取认证数据失败：${op.source}${op.key ? `/${op.key}` : ""} 为空`,
        );
      }
      state.bindings[op.as] = value;
      return "done";
    }

    case "script": {
      // 与 click 同理：脚本可能提交表单 / 触发跳转，先刷新 settle 基准
      await refreshSettleBaseline(state);
      const value = await withStepTimeout(
        state,
        runPageScript(ctx.tabId, op.code, state.bindings, op.world ?? "MAIN"),
        "执行脚本",
      );
      state.bindings[op.as] = value;
      return "done";
    }

    case "apply.set": {
      collectApplySet(state, op);
      return "done";
    }

    case "http.execute": {
      const result = await runHttpExecute(
        { inputs: state.inputs, bindings: state.bindings },
        op as HttpExecuteOp,
        state.applySet,
        state.limits.requestMs,
      );
      state.bindings[op.as] = result.body;
      // 请求落位后清空待改写，保证 apply.set 只作用于其后最近的一个请求
      state.applySet = [];
      // 记录脱敏的日志素材：headers / body / response.body 逐字段脱敏，
      // `log.reveal` 白名单命中值单独放入 `revealed`（黑名单优先）。
      const logRequest = result.forLog.request;
      const revealed = collectRevealed(state.spec.log?.reveal, state.bindings);
      state.logView = {
        request: {
          url: logRequest.url,
          method: logRequest.method,
          headers: redactHeaders(logRequest.headers),
          body: redactTextBody(logRequest.body),
          ...(revealed ? { revealed } : {}),
        },
        response: {
          status: result.forLog.response.status,
          body: redactTextBody(result.forLog.response.body),
        },
      };
      return "done";
    }

    case "digest": {
      const transformCtx: TransformContext = {
        inputs: state.inputs,
        bindings: state.bindings,
      };
      state.bindings[op.as] = await runDigest(transformCtx, op);
      return "done";
    }

    case "crypto.encrypt": {
      const transformCtx: TransformContext = {
        inputs: state.inputs,
        bindings: state.bindings,
      };
      state.bindings[op.as] = await runCryptoEncrypt(transformCtx, op);
      return "done";
    }

    case "payload.build": {
      const transformCtx: TransformContext = {
        inputs: state.inputs,
        bindings: state.bindings,
      };
      state.bindings[op.as] = runPayloadBuild(transformCtx, op);
      return "done";
    }

    case "map": {
      const transformCtx: TransformContext = {
        inputs: state.inputs,
        bindings: state.bindings,
      };
      state.bindings[op.as] = runMap(transformCtx, op);
      return "done";
    }

    default: {
      // 新增算子未在本执行器实现时：显式失败，绝不静默跳过——
      // 漏执行一步而「看起来成功」比直接失败更难排查。
      throw new LoginError(
        ErrorCodes.CONFIG_INVALID,
        "该算子在当前版本尚未实现",
      );
    }
  }
}

// ============================================================
// 入口
// ============================================================

/**
 * 执行 LoginSpec。
 *
 * 失败不抛异常，而是返回 `success: false` + 错误码 + 已执行的完整轨迹
 * （D12 的结果形状）；调用方（`GenericStrategy` / 试登录）据此落日志。
 */
export async function runSpec(
  inputSpec: LoginSpec,
  ctx: AuthContext,
  options: RunSpecOptions = {},
): Promise<RunSpecResult> {
  const spec = projectLegacyDefaultSpec(inputSpec);
  const limits: Required<SpecLimits> = {
    ...DEFAULT_LIMITS,
    ...(spec.limits ?? {}),
  };
  const aux = options.aux ?? generateAuxInputs();
  const state: RunState = {
    spec,
    ctx,
    limits,
    inputs: buildSpecInputs(spec, ctx, aux),
    bindings: {},
    applySet: [],
    baseline: { passwordFieldPresent: false },
    trial: options.trial !== undefined,
    formShape: simpleSpecShape(spec),
    autoShape: autoLoginSpecShape(spec),
    autoRefreshAttempts: 0,
  };
  const trace: SpecOpTrace[] = [];

  const invalidAutoIndex = spec.ops.findIndex(
    (op) =>
      (op.op === "fill" || op.op === "click") && isAutoLoginTarget(op.target),
  );
  if (invalidAutoIndex >= 0 && !state.autoShape) {
    const op = spec.ops[invalidAutoIndex];
    const error = new LoginError(
      ErrorCodes.CONFIG_INVALID,
      "自动定位只适用于连续的用户名、密码、登录按钮",
    );
    const entry: SpecOpTrace = {
      index: invalidAutoIndex,
      op: op.op,
      target: describeOp(op),
      status: "error",
      duration: 0,
      errorCode: error.code,
      error: error.message,
      resolution: "auto",
    };
    trace.push(entry);
    await options.onOp?.({
      phase: "start",
      index: invalidAutoIndex,
      op: op.op,
    });
    await options.onOp?.({
      phase: "end",
      index: invalidAutoIndex,
      op: op.op,
      trace: entry,
    });
    return {
      success: false,
      bindings: {},
      trace,
      error: `第 ${invalidAutoIndex + 1} 步（${SPEC_OP_LABELS[op.op]}）：${error.message}`,
      errorCode: error.code,
      ...(state.trial
        ? { trialSignals: evaluateTrialSignals(spec, {}).signals }
        : {}),
    };
  }

  // 起步基准：非试登录时先采一次兜底基准（快捷登录可从任意页选中起步）。
  // 试登录不假设目标 tab，也不碰当前标签页——跳过口令框基准采样。
  if (!state.trial) {
    state.baseline.passwordFieldPresent = await snapshotPasswordField(
      ctx.tabId,
    );
    state.baseline.initialUrl = await currentUrl(ctx.tabId);
  }

  const record = async (
    index: number,
    op: SpecOp,
    status: SpecOpTrace["status"],
    extra: Partial<SpecOpTrace> = {},
  ): Promise<void> => {
    const entry: SpecOpTrace = {
      index,
      op: op.op,
      target: describeOp(op),
      status,
      duration: 0,
      ...extra,
    };
    trace.push(entry);
    await options.onOp?.({ phase: "end", index, op: op.op, trace: entry });
  };

  const recordPreparation = async (message: string): Promise<void> => {
    const index = state.autoShape?.usernameIndex ?? 0;
    const entry: SpecOpTrace = {
      index,
      op: "auto.prepare",
      target: message,
      status: "success",
      duration: 0,
      resolution: "auto",
    };
    trace.push(entry);
    await options.onOp?.({
      phase: "end",
      index,
      op: "auto.prepare",
      trace: entry,
    });
  };

  for (let index = 0; index < spec.ops.length; index++) {
    const op = spec.ops[index];
    let effectiveOp = op;
    let resolution: "auto" | "locked" | undefined;
    const startedAt = Date.now();
    await options.onOp?.({ phase: "start", index, op: op.op });
    try {
      const deny = trialRejectsOp(op, options);
      if (
        deny === null &&
        (op.op === "fill" || op.op === "click") &&
        isAutoLoginTarget(op.target)
      ) {
        effectiveOp = await resolveAutomaticOp(
          state,
          op,
          index,
          recordPreparation,
        );
        resolution = "auto";
      } else if (
        state.formShape &&
        [
          state.formShape.usernameIndex,
          state.formShape.passwordIndex,
          state.formShape.submitIndex,
        ].includes(index) &&
        loginFormTargetMode(state.spec) === "locked"
      ) {
        resolution = "locked";
      }
      const status = await executeOp(state, effectiveOp, deny);
      const actualTarget = describeOp(effectiveOp);
      await record(index, op, status === "done" ? "success" : "skipped", {
        duration: Date.now() - startedAt,
        ...(actualTarget !== undefined
          ? {
              target:
                resolution === "auto" ? `auto → ${actualTarget}` : actualTarget,
            }
          : {}),
        ...(resolution ? { resolution } : {}),
      });
    } catch (e: unknown) {
      const error = wrapExecutionError(e, ctx.origin);
      const actualTarget = describeOp(effectiveOp);
      await record(index, op, "error", {
        duration: Date.now() - startedAt,
        ...(actualTarget !== undefined
          ? {
              target:
                resolution === "auto" ? `auto → ${actualTarget}` : actualTarget,
            }
          : {}),
        ...(resolution ? { resolution } : {}),
        errorCode: error.code,
        error: error.message,
      });
      return {
        success: false,
        bindings: state.bindings,
        trace,
        ...(state.lastGotoUrl ? { lastGotoUrl: state.lastGotoUrl } : {}),
        ...(state.logView ? { log: state.logView } : {}),
        ...(state.trial
          ? { trialSignals: evaluateTrialSignals(spec, state.bindings).signals }
          : {}),
        error: `第 ${index + 1} 步（${SPEC_OP_LABELS[op.op]}）：${error.message}`,
        errorCode: error.code,
      };
    }
  }

  // —— 成功信号：页面条件轮询优先，响应 / token 信号在算子结束后静态判定 ——
  const resultBase = {
    bindings: state.bindings,
    trace,
    ...(state.lastGotoUrl ? { lastGotoUrl: state.lastGotoUrl } : {}),
    ...(state.logView ? { log: state.logView } : {}),
  };

  // 试登录：不执行页面轮询（没有页面算子、不产生副作用），
  // 只对数据成功信号做静态判定。页面信号被剥掉、不算失败也不计入命中。
  if (state.trial) {
    const trial = evaluateTrialSignals(spec, state.bindings);
    // 无数据信号（空 / 全页面）时，请求发出成功即视为试登录通过（NONE）。
    if (trial.status === "PARTIAL") {
      const detail = trial.signals
        .map((s) => `${s.description}: ${s.met ? "已满足" : "未满足"}`)
        .join("；");
      return {
        success: false,
        ...resultBase,
        trialSignals: trial.signals,
        error: `请求已成功发出，但成功信号未满足：${detail}`,
        errorCode: ErrorCodes.SUCCESS_CONDITION_UNMET,
      };
    }
    return {
      success: true,
      ...resultBase,
      trialSignals: trial.signals.length > 0 ? trial.signals : undefined,
    };
  }

  try {
    await pollPageSignals({
      tabId: ctx.tabId,
      spec,
      limits,
      bindings: state.bindings,
      passwordFieldPresent: state.baseline.passwordFieldPresent,
      baselineUrl: state.baseline.initialUrl,
      pollingIntervalMs: options.settle?.pollingIntervalMs,
    });
  } catch (e: unknown) {
    const error = wrapExecutionError(e, ctx.origin);
    return {
      success: false,
      ...resultBase,
      error: error.message,
      errorCode: error.code,
    };
  }

  // `success` 数组即 AND：顶层每条信号都必须成立（组内 anyOf 是 OR）。
  // 轮询只保证页面条件满足；含 page 的 anyOf 需要在这里用数据信号重新判定。
  const unmet: string[] = [];
  for (const signal of spec.success) {
    if (isPageOnlySignal(signal)) continue; // 已由轮询保证
    const reason = evaluateSuccessSignal(signal, state.bindings);
    if (reason !== null) unmet.push(reason);
  }
  if (unmet.length > 0) {
    return {
      success: false,
      ...resultBase,
      error: `响应路径条件未满足：${unmet.join("；")}`,
      errorCode: ErrorCodes.SUCCESS_CONDITION_UNMET,
    };
  }

  return { success: true, ...resultBase };
}
