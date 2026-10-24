/**
 * 一键识别登录表单（ADR-0013 D8）
 *
 * 只读：读 DOM、算候选，**不点击、不提交、不写存储**。识别结果是启发式的，
 * 因此永远由用户在确认卡片里拍板后才回填配方。
 *
 * 结构同 `target-picker.ts`：页面内自包含函数 + 扩展侧 `executeScript`
 * 跨 frame 归并。页面内函数**禁止引用模块级标识符**（会被序列化注入），
 * 候选生成与 `pickCandidates` 同源，一致性由 `tests/login-form-scan.test.ts` 固化。
 */

import type { Target } from "../strategies/generic-recipe";
import type { TargetCandidate } from "./target-picker";

/** 页面内扫描结果（可结构化克隆） */
export interface FormScanPageResult {
  /** 是否找到可见密码框 */
  found: boolean;
  frameUrl?: string;
  username?: TargetCandidate;
  password?: TargetCandidate;
  submit?: TargetCandidate;
}

/** 扩展侧归并后的单 frame 结果 */
export interface FormScanFrame extends FormScanPageResult {
  frameId?: number;
}

/** 扫描失败的类型（与拾取器同口径：受限页面立刻报错，不空转） */
export type ScanErrorCode = "NO_TAB" | "INJECT_FAILED";

export type ScanLoginFormResult =
  | {
      status: "found";
      /** 命中 frame（按 frameId 升序，主 frame 在前） */
      frames: FormScanFrame[];
      /** 命中 frame 数量；> 1 时 UI 要求用户选一个 */
      matches: number;
      /** 至少有一个 frame 三项齐全 */
      complete: boolean;
    }
  | { status: "notFound" }
  | { status: "error"; code: ScanErrorCode; message: string };

/** 扫描失败文案（界面直接展示） */
export const SCAN_ERROR_TEXT: Record<ScanErrorCode, string> = {
  NO_TAB: "没有可用于识别的网页标签页：请先在目标环境页面打开一个标签页",
  INJECT_FAILED: "无法识别此页面（浏览器限制注入）：请切换到目标登录页后重试",
};

// ============================================================
// 页面内执行体（注入 MAIN world；自包含）
// ============================================================

/* eslint-disable complexity -- 页面内函数需单体内聚，不能拆成模块级函数 */
export function scanLoginFormInPage(): FormScanPageResult {
  const frameUrl = typeof location === "undefined" ? undefined : location.href;

  type AnyEl = Element & {
    hidden?: boolean;
    value?: string;
    control?: Element | null;
    htmlFor?: string;
    shadowRoot?: ShadowRoot | null;
  };

  function esc(value: string): string {
    const css = (window as unknown as { CSS?: { escape?: (v: string) => string } })
      .CSS;
    if (css && typeof css.escape === "function") return css.escape(value);
    return value.replace(/([^\w-])/g, "\\$1");
  }

  function styleOf(el: Element): CSSStyleDeclaration | null {
    try {
      return window.getComputedStyle(el);
    } catch {
      return null;
    }
  }

  /** 可见性：自身与祖先都不能被隐藏（与执行器 `isVisible` 同口径） */
  function isVisible(el: Element): boolean {
    if ((el as AnyEl).hidden) return false;
    let node: Element | null = el;
    while (node) {
      const style = styleOf(node);
      if (style) {
        if (style.display === "none") return false;
        if (style.visibility === "hidden" || style.visibility === "collapse") {
          return false;
        }
        const opacity = style.opacity;
        if (opacity !== "" && Number(opacity) === 0) return false;
      }
      node = node.parentElement;
    }
    return true;
  }

  function typeOf(el: Element): string {
    return (el.getAttribute("type") ?? "").trim().toLowerCase();
  }

  /**
   * id 是否由框架自动生成（与 `target-picker` 的 `isVolatileId` 同源；
   * 页面内不能引用模块级标识符，故内联一份，一致性由测试固化）。
   * Element Plus 的 `el-id-9759-21` 之类刷新即变，不能写进配方。
   */
  function volatileId(id: string): boolean {
    const patterns = [
      /^el-id-\d+(-\d+)?$/, // Element Plus
      /^:r[0-9a-z]+:$/i, // React 18+ useId
      /^«r[0-9a-z]+»$/i, // Radix / React 19
      /^(radix|mui|ember|ext-gen|ui-id|yui|react-select|downshift|headlessui|a11y)[-_:«]*r?\d+/i,
      /^[a-z][a-z_-]{0,16}\d{5,}([-_]\d+)*$/i,
    ];
    return patterns.some((pattern) => pattern.test(id.trim()));
  }

  function pathOf(el: Element): string {
    const parts: string[] = [];
    let node: Element | null = el;
    for (let depth = 0; node && depth < 6; depth++) {
      const id = node.getAttribute("id");
      // 自动生成的 id 不能作为路径锚点，否则整条路径同样会失效
      if (id && !volatileId(id)) {
        parts.unshift(`#${esc(id)}`);
        break;
      }
      let part = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter(
          (child) => child.tagName === node!.tagName,
        );
        if (sameTag.length > 1) {
          part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
        }
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  }

  function labelOf(el: Element): string | undefined {
    const id = el.getAttribute("id");
    if (id) {
      const forLabel = document.querySelector(`label[for="${esc(id)}"]`);
      const text = forLabel?.textContent?.trim();
      if (text) return text;
    }
    return el.closest("label")?.textContent?.trim() || undefined;
  }

  function countOf(target: Target): number {
    try {
      if (typeof target === "string") {
        return document.querySelectorAll(target).length;
      }
      if ("css" in target) return document.querySelectorAll(target.css).length;
      if ("name" in target) {
        return document.querySelectorAll(`[name="${esc(target.name)}"]`).length;
      }
      if ("ariaLabel" in target) {
        return document.querySelectorAll(
          `[aria-label="${esc(target.ariaLabel)}"]`,
        ).length;
      }
      if ("placeholder" in target) {
        return document.querySelectorAll(
          `[placeholder="${esc(target.placeholder)}"]`,
        ).length;
      }
      if ("label" in target) {
        const text = target.label;
        let n = 0;
        const labels = document.querySelectorAll("label");
        for (let i = 0; i < labels.length; i++) {
          if ((labels[i].textContent ?? "").trim() === text) n++;
        }
        return n;
      }
      // text：精确优先，精确不存在时才退回子串（与执行器 byText 同口径）
      const needle = target.text.replace(/\s+/g, "");
      if (!needle) return 0;
      let exact = 0;
      let partial = 0;
      const all = document.querySelectorAll("*");
      for (let i = 0; i < all.length; i++) {
        const node = all[i];
        if (node.tagName === "SCRIPT" || node.tagName === "STYLE") continue;
        const content = (node.textContent ?? "").replace(/\s+/g, "");
        const isExact = content === needle;
        if (!isExact && !content.includes(needle)) continue;
        let inner = false;
        for (let c = 0; c < node.children.length; c++) {
          const child = (node.children[c].textContent ?? "").replace(/\s+/g, "");
          if (child === needle || child.includes(needle)) {
            inner = true;
            break;
          }
        }
        if (inner) continue;
        if (isExact) exact++;
        else partial++;
      }
      return exact > 0 ? exact : partial;
    } catch {
      return 0;
    }
  }

  /**
   * 有序候选（与 `pickCandidates` 同源；页面内不能引用模块级标识符）。
   * 一致性由 `tests/login-form-scan.test.ts` 固化。
   */
  function candidatesOf(el: Element): TargetCandidate[] {
    const all: TargetCandidate[] = [];
    const seen: string[] = [];
    const push = (target: Target, rank: number, note: string): void => {
      const key =
        typeof target === "string"
          ? `css:${target}`
          : `${Object.keys(target)[0]}:${Object.values(target)[0]}`;
      if (seen.indexOf(key) !== -1) return;
      seen.push(key);
      all.push({ target, count: countOf(target), rank, note });
    };

    const id = el.getAttribute("id");
    // 自动生成的 id 跳过：它的「唯一」只在当前文档成立，保存后必失效
    if (id && !volatileId(id)) push({ css: `#${esc(id)}` }, 0, `id="${id}"`);
    const name = el.getAttribute("name");
    if (name) push({ name }, 1, `name="${name}"`);
    const ariaLabel = el.getAttribute("aria-label")?.trim();
    if (ariaLabel) push({ ariaLabel }, 2, `aria-label「${ariaLabel}」`);
    const label = labelOf(el);
    if (label) push({ label }, 3, `label「${label}」`);
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) push({ placeholder }, 4, `placeholder「${placeholder}」`);

    const interactive =
      /^(BUTTON|A)$/.test(el.tagName) ||
      el.getAttribute("role") === "button" ||
      (el.tagName === "INPUT" &&
        /^(button|submit|reset)$/i.test(el.getAttribute("type") ?? ""));
    const text = (el.textContent ?? "").trim();
    if (interactive && text) push({ text }, 5, `文本「${text.slice(0, 24)}」`);

    const path = pathOf(el);
    if (path) push({ css: path }, 6, "CSS 路径");

    return all;
  }

  /** 推荐候选：语义候选里首个唯一项，全部非唯一时取优先级最高项 */
  function preferred(list: TargetCandidate[]): TargetCandidate | undefined {
    const semantic = list.filter((item) => item.rank < 6);
    const pool = semantic.length > 0 ? semantic : list;
    for (let i = 0; i < pool.length; i++) {
      if (pool[i].count === 1) return pool[i];
    }
    return pool[0];
  }

  function bestOf(el: Element | null): TargetCandidate | undefined {
    return el ? preferred(candidatesOf(el)) : undefined;
  }

  /** 密码框：可见的 `input[type=password]`，文档序第一个 */
  function findPassword(): HTMLInputElement | null {
    const inputs = document.querySelectorAll("input");
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      if (typeOf(input) !== "password") continue;
      if (isVisible(input)) return input;
    }
    return null;
  }

  /**
   * 登录容器：最近的 `form`，没有则从密码框上溯（最多 4 层）取第一个
   * 同时包含密码框与提交/输入控件祖先。
   */
  function findContainer(password: Element): Element {
    const form = password.closest("form");
    if (form) return form;
    let node: Element | null = password.parentElement;
    let fallback: Element = password.parentElement ?? password;
    for (let depth = 0; node && depth < 4; depth++) {
      fallback = node;
      if (node.querySelector("input, button")) return node;
      node = node.parentElement;
    }
    return fallback;
  }

  /** 容器内、密码框之前的可见文本输入框 */
  function findUsername(
    container: Element,
    password: Element,
  ): HTMLInputElement | null {
    const inputs = container.querySelectorAll("input");
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      if (input === password) break;
      const type = typeOf(input);
      if (type === "password" || type === "hidden") continue;
      if (!/^(text|email|tel|search|url|)$/.test(type)) continue;
      if (!isVisible(input)) continue;
      return input;
    }
    return null;
  }

  /** 控件上的可见文案（input 取 value，其余取 textContent） */
  function controlText(el: Element): string {
    const value = (el as AnyEl).value;
    const text = typeof value === "string" && value.trim() ? value : el.textContent;
    return (text ?? "").trim();
  }

  /** 容器内的提交控件：submit 按钮 → 文本匹配「登录 / login / sign in」→ 首个可见按钮 */
  function findSubmit(container: Element): Element | null {
    const candidates = container.querySelectorAll(
      "button, input[type=submit], input[type=button], a",
    );
    let byText: Element | null = null;
    let first: Element | null = null;
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (!isVisible(el)) continue;
      const type = typeOf(el);
      if (el.tagName === "INPUT" && type === "submit") return el;
      if (el.tagName === "INPUT" && type !== "button") continue;
      if (!first) first = el;
      if (!byText && /登\s*录|login|sign\s*in/i.test(controlText(el))) byText = el;
    }
    return byText ?? first;
  }

  const password = findPassword();
  if (!password) return { found: false, ...(frameUrl ? { frameUrl } : {}) };

  const container = findContainer(password);
  const username = bestOf(findUsername(container, password));
  const passwordField = bestOf(password);
  const submit = bestOf(findSubmit(container));

  return {
    found: true,
    ...(frameUrl ? { frameUrl } : {}),
    ...(username ? { username } : {}),
    ...(passwordField ? { password: passwordField } : {}),
    ...(submit ? { submit } : {}),
  };
}
/* eslint-enable complexity */

// ============================================================
// 扩展侧编排
// ============================================================

interface FrameResult {
  frameId?: number;
  result?: FormScanPageResult;
}

/** 三项齐全（提交按钮可单独缺失，由 UI 提示手动拾取） */
export function isCompleteScan(frame: FormScanFrame): boolean {
  return !!(frame.username && frame.password && frame.submit);
}

/**
 * 扫描指定 tab 的所有 frame（只读）。受限页面直接报 `INJECT_FAILED`，
 * 不轮询、不等待。
 */
export async function scanLoginForm(tabId: number): Promise<ScanLoginFormResult> {
  let frames: FrameResult[];
  try {
    frames = (await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: scanLoginFormInPage,
    })) as FrameResult[];
  } catch (e: unknown) {
    return {
      status: "error",
      code: "INJECT_FAILED",
      message: e instanceof Error ? e.message : String(e),
    };
  }

  const hits = (frames ?? [])
    .filter((frame) => frame.result?.found)
    .map<FormScanFrame>((frame) => ({
      ...(frame.result as FormScanPageResult),
      frameId: frame.frameId,
    }))
    .sort((a, b) => (a.frameId ?? 0) - (b.frameId ?? 0));

  if (hits.length === 0) return { status: "notFound" };
  return {
    status: "found",
    frames: hits,
    matches: hits.length,
    complete: hits.some(isCompleteScan),
  };
}
