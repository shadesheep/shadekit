/**
 * 定位拾取器（ADR-0012 D14）
 *
 * 在目标标签页里悬停高亮、点击捕获、Esc 取消，把元素转成**结构化** `Target`
 * （`{ css }` / `{ name }` / `{ label }` / `{ placeholder }` / `{ text }`），
 * 而不是裸 CSS 字符串；同时记录命中元素所在的 frameId。
 *
 * 为什么用「注入 + 轮询」而不是等 executeScript 的返回：
 * `allFrames: true` 会等**所有** frame 的 Promise 结束，某一帧没被点中就永远
 * 挂着。这里让页面内函数立即返回、把状态挂在 `window` 上，扩展侧每 200ms
 * 轮询一次；任一 frame 命中即整体停止（stop 幂等，重复调用无副作用）。
 *
 * ⚠️ `pickerInPage` 会被序列化注入页面，**禁止引用任何模块级标识符**；
 * 它的定位优先级与测试用的 `pickTargetFromElement` 保持一致（见文件末尾说明）。
 */

import type { Target } from "../strategies/generic-recipe";
import { isVolatileId } from "./volatile-id";

export { isVolatileId } from "./volatile-id";

/** 注入指令 */
export type PickerCommand = "start" | "state" | "stop";

/**
 * 页面内状态（可结构化克隆）。
 *
 * `idle` 表示「没有拾取会话」——页面导航 / 刷新会让会话丢失，
 * 与用户按 Esc 产生的 `cancelled` 必须区分（ADR-0013 D1）。
 */
export type PickerStatus = "idle" | "active" | "picked" | "cancelled";

/**
 * 一个候选定位（ADR-0013 D4）。
 * `target` 是可直接写进配方的结构化定位；`count` 是**当前文档**内的命中数
 * （不含可见性过滤），界面据此提示歧义。
 */
export interface TargetCandidate {
  target: Target;
  /** 当前文档内命中数 */
  count: number;
  /** 稳定性评级：0 = 最稳（id），数值越大越脆弱 */
  rank: number;
  /** 生成该候选的依据（界面直接显示） */
  note: string;
}

/**
 * 拾取元素的受限元信息（ADR-0013 D6）。
 * 只用于「建议填充值 / 元素类型与步骤是否匹配」的提示，不做硬校验。
 */
export interface ElementMeta {
  tag: string;
  type?: string;
  role?: string;
  contentEditable?: boolean;
}

export interface PickerState {
  status: PickerStatus;
  target?: Target;
  /** 全部候选（按稳定性排序），首个即 `target` */
  candidates?: TargetCandidate[];
  /** 命中元素的受限元信息 */
  meta?: ElementMeta;
  /** 命中元素所在 frame 的地址 */
  frameUrl?: string;
  /** 命中元素的简短描述（界面提示用） */
  label?: string;
}

/** 拾取失败的类型（界面据此给出可操作文案） */
export type PickErrorCode = "NO_TAB" | "INJECT_FAILED" | "TIMEOUT";

/**
 * 扩展侧拿到的拾取结果（ADR-0013 D1 / D4 / D6）。
 * `cancelled` 仅由用户 Esc 产生；其余失败各自可辨识。
 */
export type PickResult =
  | {
      status: "picked";
      target: Target;
      /**
       * 全部候选（含非唯一项）。恒等于 `pickCandidates` 的输出，
       * 首个唯一项即 `target`；页面脚本未返回时为空数组。
       */
      candidates: TargetCandidate[];
      /** 命中元素的受限元信息；页面脚本未返回时为 `{ tag: "" }` */
      meta: ElementMeta;
      frameId?: number;
      frameUrl?: string;
    }
  | { status: "cancelled" }
  /** 页面导航 / 刷新导致会话丢失 */
  | { status: "lost"; message: string }
  | { status: "error"; code: PickErrorCode; message: string };

/** 拾取失败的错误文案（ADR-0013 D1：按 code 给可操作的一句话） */
export const PICK_ERROR_TEXT: Record<PickErrorCode, string> = {
  NO_TAB: "没有可用于拾取的网页标签页：请先在目标环境页面打开一个标签页",
  INJECT_FAILED: "无法在此页面拾取（浏览器限制注入）：请切换到目标登录页后重试",
  TIMEOUT: "拾取未收到响应，请重试",
};

// ============================================================
// 纯函数：元素 → Target（可单测）
// ============================================================

function cssEscape(value: string): string {
  const css = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
  if (css && typeof css.escape === "function") return css.escape(value);
  return value.replace(/([^\w-])/g, "\\$1");
}

function labelTextOf(el: Element): string | undefined {
  const id = el.getAttribute("id");
  if (id) {
    const forLabel = document.querySelector(
      `label[for="${cssEscape(id)}"]`,
    );
    const text = forLabel?.textContent?.trim();
    if (text) return text;
  }
  const wrapper = el.closest("label");
  const wrapped = wrapper?.textContent?.trim();
  return wrapped || undefined;
}

function cssPathOf(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  for (let depth = 0; node && depth < 6; depth++) {
    const id = node.getAttribute("id");
    // 自动生成的 id 不能作为路径锚点，否则整条路径同样会失效
    if (id && !isVolatileId(id)) {
      parts.unshift(`#${cssEscape(id)}`);
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

/** 候选稳定的评级（越小越稳），与生成顺序一致 */
const RANK = {
  id: 0,
  name: 1,
  ariaLabel: 2,
  label: 3,
  placeholder: 4,
  text: 5,
  cssPath: 6,
} as const;

function targetKey(target: Target): string {
  return typeof target === "string"
    ? `css:${target}`
    : `${Object.keys(target)[0]}:${Object.values(target)[0]}`;
}

/** 元素是否为可交互控件（用于 text 候选与 D6 的类型提示） */
export function isClickableElement(meta: ElementMeta): boolean {
  if (meta.tag === "button" || meta.tag === "a" || meta.tag === "summary") {
    return true;
  }
  if (meta.role === "button" || meta.role === "link") return true;
  if (meta.tag === "input") {
    return /^(button|submit|reset|image)$/.test(meta.type ?? "");
  }
  return false;
}

/** 元素是否可接收输入（D6：fill 步骤的类型提示） */
export function isFillableElement(meta: ElementMeta): boolean {
  if (meta.contentEditable) return true;
  if (meta.tag === "textarea" || meta.tag === "select") return true;
  if (meta.tag !== "input") return false;
  return !/^(button|submit|reset|checkbox|radio|image|file|range)$/.test(
    meta.type ?? "text",
  );
}

/** 普通文本输入（用户名候选；不含 password） */
export function isTextEntryElement(meta: ElementMeta): boolean {
  if (meta.contentEditable) return true;
  if (meta.tag === "textarea") return true;
  if (meta.tag !== "input") return false;
  return /^(text|email|tel|search|url|)$/i.test(meta.type ?? "");
}

/** 拾取元素的受限元信息（ADR-0013 D6），只读属性，不做类型校验 */
export function elementMetaOf(el: Element): ElementMeta {
  const type = el.getAttribute("type")?.trim().toLowerCase();
  const role = el.getAttribute("role")?.trim();
  const contentEditable =
    el.getAttribute("contenteditable") !== null &&
    el.getAttribute("contenteditable") !== "false";
  return {
    tag: el.tagName.toLowerCase(),
    ...(type ? { type } : {}),
    ...(role ? { role } : {}),
    ...(contentEditable ? { contentEditable: true } : {}),
  };
}

/**
 * 可见文本候选的命中数（与执行器 `byText` 同口径）：精确优先，精确命中
 * 不存在时才退回子串包含。不带可见性过滤——本函数只做「这套定位在当前
 * 文档里独一无二吗」的提示，可见性由执行器判定。
 *
 * ⚠️ `pickerInPage` 内有一份同源内联实现（页面内不能引用模块级标识符），
 * 一致性由 `tests/target-picker.test.ts` 固化。
 */
function countTextMatches(root: ParentNode, text: string): number {
  const needle = text.replace(/\s+/g, "");
  if (!needle) return 0;
  let exact = 0;
  let partial = 0;
  const all = root.querySelectorAll("*");
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
}

/** 某个 Target 在当前文档的命中数（不含可见性过滤，与悬停浮层同口径） */
export function countTargetMatches(
  target: Target,
  root: ParentNode = document,
): number {
  try {
    if (typeof target === "string") return root.querySelectorAll(target).length;
    if ("css" in target) return root.querySelectorAll(target.css).length;
    if ("name" in target) {
      return root.querySelectorAll(`[name="${cssEscape(target.name)}"]`).length;
    }
    if ("ariaLabel" in target) {
      return root.querySelectorAll(
        `[aria-label="${cssEscape(target.ariaLabel)}"]`,
      ).length;
    }
    if ("placeholder" in target) {
      return root.querySelectorAll(
        `[placeholder="${cssEscape(target.placeholder)}"]`,
      ).length;
    }
    if ("label" in target) {
      let n = 0;
      const labels = root.querySelectorAll("label");
      for (let i = 0; i < labels.length; i++) {
        if ((labels[i].textContent ?? "").trim() === target.label) n++;
      }
      return n;
    }
    return countTextMatches(root, target.text);
  } catch {
    return 0;
  }
}

/**
 * 生成**有序候选**（ADR-0013 D4）：id → name → aria-label → label 文本 →
 * placeholder → 文本 → CSS 路径（与 DOM 解析器 D3 的优先级一致）。
 *
 * 每个候选都带当前文档命中数，**全部返回**（含非唯一项），由界面标黄提示、
 * 用户改选；推荐项见 `preferredCandidate`。
 */
export function pickCandidates(el: Element): TargetCandidate[] {
  const all: TargetCandidate[] = [];
  const seen = new Set<string>();
  const push = (target: Target, rank: number, note: string): void => {
    const key = targetKey(target);
    if (seen.has(key)) return;
    seen.add(key);
    all.push({ target, count: countTargetMatches(target), rank, note });
  };

  const id = el.getAttribute("id");
  // 自动生成的 id 跳过：它的「唯一」只在当前文档成立，保存后必失效
  if (id && !isVolatileId(id)) {
    push({ css: `#${cssEscape(id)}` }, RANK.id, `id="${id}"`);
  }

  const name = el.getAttribute("name");
  if (name) push({ name }, RANK.name, `name="${name}"`);

  const ariaLabel = el.getAttribute("aria-label")?.trim();
  if (ariaLabel) {
    push({ ariaLabel }, RANK.ariaLabel, `aria-label「${ariaLabel}」`);
  }

  const label = labelTextOf(el);
  if (label) push({ label }, RANK.label, `label「${label}」`);

  const placeholder = el.getAttribute("placeholder");
  if (placeholder) {
    push({ placeholder }, RANK.placeholder, `placeholder「${placeholder}」`);
  }

  const meta = elementMetaOf(el);
  const text = (el.textContent ?? "").trim();
  if (isClickableElement(meta) && text) {
    push({ text }, RANK.text, `文本「${text.slice(0, 24)}」`);
  }

  const path = cssPathOf(el);
  if (path) push({ css: path }, RANK.cssPath, "CSS 路径");

  return all.sort((a, b) => a.rank - b.rank);
}

/**
 * 候选中的推荐项（ADR-0013 D4）：
 * 1. 在语义候选（id → name → aria → label → placeholder → text，不含 CSS 路径）
 *    里取第一个**唯一**项；
 * 2. 语义候选全部非唯一时取其中优先级最高项，并在界面标黄提示歧义；
 * 3. 没有语义候选时才用 CSS 路径。
 *
 * CSS 路径由 nth-of-type 拼出、天然唯一，若直接参与「唯一优先」会让
 * 重复 placeholder 之类的情况被静默换成脆弱路径，反而看不出歧义。
 */
export function preferredCandidate(
  candidates: TargetCandidate[],
): TargetCandidate | undefined {
  const semantic = candidates.filter((c) => c.rank < RANK.cssPath);
  const pool = semantic.length > 0 ? semantic : candidates;
  return pool.find((c) => c.count === 1) ?? pool[0];
}

/**
 * 从元素生成**推荐**定位。需要展示备选时用 `pickCandidates`。
 */
export function pickTargetFromElement(el: Element): Target | null {
  return preferredCandidate(pickCandidates(el))?.target ?? null;
}

// ============================================================
// 页面内执行体（注入 MAIN world；自包含）
// ============================================================

/* eslint-disable complexity -- 页面内函数需单体内聚，不能拆成模块级函数 */
export function pickerInPage(command: PickerCommand): PickerState {
  type PickerEl = Element & {
    style?: CSSStyleDeclaration;
    focus?: () => void;
  };

  const KEY = "__devtools_picker__";
  const HOST = window as unknown as Record<string, unknown>;
  const HIGHLIGHT = "2px solid #6366f1";
  /** 页面内自超时（必须内联：本函数禁止引用模块级标识符） */
  const PAGE_TIMEOUT_MS = 60_000;

  const existing = HOST[KEY] as
    | {
        state: PickerState;
        cleanup: () => void;
      }
    | undefined;

  if (command === "state") {
    return existing ? existing.state : { status: "idle" };
  }

  if (command === "stop") {
    if (existing) {
      existing.cleanup();
      delete HOST[KEY];
    }
    return { status: "idle" };
  }

  // start：幂等——已在拾取中直接复用；已结束的旧会话（超时/取消）丢弃重建
  if (existing) {
    if (existing.state.status === "active") return existing.state;
    existing.cleanup();
    delete HOST[KEY];
  }

  function esc(value: string): string {
    const css = (window as unknown as { CSS?: { escape?: (v: string) => string } })
      .CSS;
    if (css && typeof css.escape === "function") return css.escape(value);
    return value.replace(/([^\w-])/g, "\\$1");
  }

  /**
   * id 是否由框架自动生成（与模块级 `isVolatileId` 同源；页面内不能引用
   * 模块级标识符，故内联一份，一致性由 `tests/target-picker.test.ts` 固化）。
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

  /** Target → 可读文案（页面内自包含，不能引用模块级 describeTarget） */
  function describeText(target: Target): string {
    if (typeof target === "string") return target;
    if ("css" in target) return target.css;
    if ("ariaLabel" in target) return `aria-label「${target.ariaLabel}」`;
    if ("label" in target) return `label「${target.label}」`;
    if ("name" in target) return `name=${target.name}`;
    if ("placeholder" in target) return `placeholder「${target.placeholder}」`;
    return `文本「${target.text}」`;
  }

  /**
   * 有序候选（与模块级 `pickCandidates` 同源；页面内不能引用模块级标识符）。
   * 两份实现的一致性由 `tests/target-picker.test.ts` 固化。
   */
  function candidatesOf(el: Element): Array<{
    target: Target;
    count: number;
    rank: number;
    note: string;
  }> {
    const all: Array<{
      target: Target;
      count: number;
      rank: number;
      note: string;
    }> = [];
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

  /**
   * 推荐候选（与模块级 `preferredCandidate` 同义）：语义候选里首个唯一项，
   * 全部非唯一时取优先级最高项；CSS 路径不参与「唯一优先」。
   */
  function preferred<T extends { count: number; rank: number }>(
    list: T[],
  ): T | undefined {
    const semantic = list.filter((item) => item.rank < 6);
    const pool = semantic.length > 0 ? semantic : list;
    for (let i = 0; i < pool.length; i++) {
      if (pool[i].count === 1) return pool[i];
    }
    return pool[0];
  }

  /** 受限元信息（ADR-0013 D6） */
  function metaOf(el: Element): {
    tag: string;
    type?: string;
    role?: string;
    contentEditable?: boolean;
  } {
    const type = el.getAttribute("type")?.trim().toLowerCase();
    const role = el.getAttribute("role")?.trim();
    const editable =
      el.getAttribute("contenteditable") !== null &&
      el.getAttribute("contenteditable") !== "false";
    const meta: {
      tag: string;
      type?: string;
      role?: string;
      contentEditable?: boolean;
    } = { tag: el.tagName.toLowerCase() };
    if (type) meta.type = type;
    if (role) meta.role = role;
    if (editable) meta.contentEditable = true;
    return meta;
  }

  /** 按 Target 类型统计当前文档命中数（仅用于悬停预览，不含可见性过滤） */
  function countOf(target: Target | null): number {
    if (!target) return 0;
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
      // text：精确优先，精确不存在时才退回子串（与模块级 countTextMatches 同源）
      const needle = target.text.replace(/\s+/g, "");
      if (!needle) return 0;
      let exact = 0;
      let partial = 0;
      const all = document.querySelectorAll("*");
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;
        const content = (el.textContent ?? "").replace(/\s+/g, "");
        const isExact = content === needle;
        if (!isExact && !content.includes(needle)) continue;
        let inner = false;
        for (let c = 0; c < el.children.length; c++) {
          const child = (el.children[c].textContent ?? "").replace(/\s+/g, "");
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

  // ----------------------------------------------------------
  // 悬停预览浮层（ADR-0013 D3）：让用户点之前就知道会得到什么
  // ----------------------------------------------------------
  const OVERLAY_ATTR = "data-dt-picker-overlay";
  let overlay: HTMLElement | null = null;

  function hideOverlay(): void {
    overlay?.remove();
    overlay = null;
  }

  function showOverlay(el: Element): void {
    const candidates = candidatesOf(el);
    const best = preferred(candidates);
    if (!best) {
      hideOverlay();
      return;
    }
    const count = best.count;
    const description = describeText(best.target);
    const alternates = candidates.length - 1;

    if (!overlay) {
      overlay = document.createElement("div");
      overlay.setAttribute(OVERLAY_ATTR, "");
      overlay.style.cssText =
        "position:fixed;z-index:2147483647;pointer-events:none;" +
        "max-width:320px;padding:8px 10px;border-radius:8px;" +
        "background:rgba(15,23,42,0.94);color:#f8fafc;" +
        "font:12px/1.5 ui-monospace,'SF Mono',Menlo,Consolas,monospace;" +
        "box-shadow:0 6px 20px rgba(0,0,0,0.35);white-space:pre-wrap;" +
        "word-break:break-all;";
      document.documentElement.appendChild(overlay);
    }

    // 文本一律用 textContent 写入：页面文案不可信，不能当 HTML 解析
    const lines: Array<{ text: string; color?: string }> = [
      { text: describeElement(el), color: "#94a3b8" },
      { text: `将使用：${description}` },
      count > 1
        ? { text: `命中 ${count} 个，执行时会报歧义`, color: "#fbbf24" }
        : { text: `命中 ${count} 个元素`, color: "#4ade80" },
      alternates > 0
        ? { text: `另有 ${alternates} 个候选，拾取后可改选`, color: "#94a3b8" }
        : { text: "" },
    ];
    overlay.textContent = "";
    for (const line of lines) {
      if (!line.text) continue;
      const row = document.createElement("div");
      row.textContent = line.text;
      if (line.color) row.style.color = line.color;
      overlay.appendChild(row);
    }

    positionOverlay(el);
  }

  /** 元素的最简标识：tag#id 或 tag.class */
  function describeElement(el: Element): string {
    const tag = el.tagName.toLowerCase();
    const id = el.getAttribute("id");
    if (id) return `${tag}#${id}`;
    const cls = (el.getAttribute("class") ?? "").trim().split(/\s+/)[0];
    return cls ? `${tag}.${cls}` : tag;
  }

  /** 浮层定位：默认在元素下方，空间不足翻到上方，水平 clamp 到视口内 */
  function positionOverlay(el: Element): void {
    if (!overlay) return;
    const rect = el.getBoundingClientRect();
    const box = overlay.getBoundingClientRect();
    const margin = 8;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    let top = rect.bottom + margin;
    if (top + box.height > viewportH) top = rect.top - margin - box.height;
    if (top < margin) top = margin;

    let left = rect.left;
    if (left + box.width > viewportW - margin) {
      left = viewportW - margin - box.width;
    }
    if (left < margin) left = margin;

    overlay.style.top = `${Math.round(top)}px`;
    overlay.style.left = `${Math.round(left)}px`;
  }

  const state: PickerState = { status: "active" };
  let highlighted: PickerEl | null = null;
  let previousOutline = "";

  function clearHighlight(): void {
    if (!highlighted) return;
    if (highlighted.style) highlighted.style.outline = previousOutline;
    highlighted = null;
    previousOutline = "";
  }

  function onOver(event: Event): void {
    const target = event.target as PickerEl | null;
    if (!target?.style) return;
    if (highlighted === target) return;
    clearHighlight();
    highlighted = target;
    previousOutline = target.style.outline;
    target.style.outline = HIGHLIGHT;
    showOverlay(target);
  }

  function onViewportChange(): void {
    hideOverlay();
  }

  let autoTimeout: ReturnType<typeof setTimeout> | undefined;

  function onAutoTimeout(): void {
    if (state.status !== "active") return;
    state.status = "cancelled";
    cleanup();
  }

  function onClick(event: Event): void {
    // 捕获阶段拦下：绝不触发页面的真实点击 / 表单提交 / 导航
    event.preventDefault();
    event.stopPropagation();
    const el = event.target as Element | null;
    if (!el) return;
    const candidates = candidatesOf(el);
    const best = preferred(candidates);
    if (!best) return;
    state.status = "picked";
    state.target = best.target;
    state.candidates = candidates;
    state.meta = metaOf(el);
    state.frameUrl = location.href;
    state.label = (el.textContent ?? "").trim().slice(0, 40) || el.tagName;
    cleanup();
  }

  function onKey(event: Event): void {
    const key = (event as KeyboardEvent).key;
    if (key !== "Escape") return;
    event.preventDefault();
    state.status = "cancelled";
    state.frameUrl = location.href;
    cleanup();
  }

  function cleanup(): void {
    clearHighlight();
    hideOverlay();
    if (autoTimeout !== undefined) {
      clearTimeout(autoTimeout);
      autoTimeout = undefined;
    }
    document.removeEventListener("mouseover", onOver, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("scroll", onViewportChange, true);
    window.removeEventListener("resize", onViewportChange);
  }

  document.addEventListener("mouseover", onOver, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("scroll", onViewportChange, true);
  window.addEventListener("resize", onViewportChange);

  // 页面内自超时：会话在 60s 后结束，让扩展侧能拿到明确结果而不是干等
  autoTimeout = setTimeout(onAutoTimeout, PAGE_TIMEOUT_MS);

  HOST[KEY] = { state, cleanup };
  return state;
}
/* eslint-enable complexity */

// ============================================================
// 扩展侧编排
// ============================================================

/**
 * 扩展侧轮询上限。页面内自超时是 60s（见 `pickerInPage` 的 PAGE_TIMEOUT_MS），
 * 这里故意放宽，保证**页面侧的结论先到**——这样用户看到的总是“已取消”而不是
 * 无从下手的“拾取超时”。
 */
const PICKER_STATE_TIMEOUT_MS = 70_000;
const PICKER_POLL_INTERVAL_MS = 200;
/** 连续多少次“没有会话”就判定页面已导航（lost） */
const PICKER_IDLE_STRIKES = 3;

interface FrameResult {
  frameId?: number;
  result?: PickerState;
}

type PickerRun =
  | { ok: true; frames: FrameResult[] }
  | { ok: false; message: string };

/** 页面内三态调用的统一入口（保留原始异常，供 INJECT_FAILED 提示） */
async function runPicker(
  tabId: number,
  command: PickerCommand,
): Promise<PickerRun> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: pickerInPage,
      args: [command],
    });
    return { ok: true, frames: (results ?? []) as FrameResult[] };
  } catch (e: unknown) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 选出用于拾取的标签页：优先与目标 origin 相同的标签页，
 * 否则回退到最近访问过的普通网页标签（排除扩展页与配置页自身）。
 */
export function rankPickerTabs<T extends { id?: number; url?: string; lastAccessed?: number }>(
  tabs: T[],
  origin: string | undefined,
  ownTabId: number | undefined,
): T[] {
  const isWeb = (tab: T) =>
    typeof tab.id === "number" &&
    tab.id > 0 &&
    tab.id !== ownTabId &&
    typeof tab.url === "string" &&
    /^https?:\/\//i.test(tab.url);

  return tabs
    .filter(isWeb)
    .sort((a, b) => {
      const aMatch = origin && a.url?.startsWith(origin) ? 1 : 0;
      const bMatch = origin && b.url?.startsWith(origin) ? 1 : 0;
      if (aMatch !== bMatch) return bMatch - aMatch;
      return (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0);
    });
}

/**
 * 从一组 frame 结果里取出命中项（同一时刻只可能有一个 frame 命中）。
 * 候选与元信息可能缺失（页面脚本版本落后 / 手写注入），此时不编造，
 * 交由调用方按空处理。
 */
function findPicked(frames: FrameResult[]): Omit<
  Extract<PickResult, { status: "picked" }>,
  "status"
> | null {
  const hit = frames.find((f) => f.result?.status === "picked" && f.result.target);
  if (!hit?.result?.target) return null;
  const frameId = hit.frameId;
  const picked: Omit<Extract<PickResult, { status: "picked" }>, "status"> = {
    target: hit.result.target,
    candidates: hit.result.candidates ?? [],
    meta: hit.result.meta ?? { tag: "" },
    ...(frameId !== undefined ? { frameId } : {}),
  };
  // ADR-0013 D7：主 frame（frameId === 0）的身份由 tab 本身保证，
  // 记录 URL 只会在 SPA 路由 / query 变化后误判为 FRAME_NOT_FOUND。
  if (frameId !== 0 && hit.result.frameUrl) {
    picked.frameUrl = hit.result.frameUrl;
  }
  return picked;
}

/** 所有 frame 都没有会话（页面导航 / 刷新导致） */
function allIdle(frames: FrameResult[]): boolean {
  return (
    frames.length > 0 &&
    frames.every((f) => !f.result || f.result.status === "idle")
  );
}

/** 已取消：至少一个 frame 报了 cancelled，且没有任何 frame 还在活动 */
function allStopped(frames: FrameResult[]): boolean {
  return (
    frames.length > 0 &&
    frames.some((f) => f.result?.status === "cancelled") &&
    frames.every((f) => f.result?.status !== "active")
  );
}

/**
 * 启动拾取：切到目标标签页 → 轮询结果 → **切回来源标签页**（ADR-0013 D1/D2）。
 *
 * 结束时（命中 / Esc / 会话丢失 / 超时）必定解绑。`pollIntervalMs` / `timeoutMs`
 * 可注入，便于单测不真的等 60 秒。
 */
export async function startTargetPicker(options: {
  origin?: string;
  ownTabId?: number;
  /** 来源窗口：结束时空标签页所在窗口不会被聚焦 */
  ownWindowId?: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
} = {}): Promise<PickResult> {
  const pollInterval = options.pollIntervalMs ?? PICKER_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? PICKER_STATE_TIMEOUT_MS;

  let tabs: chrome.tabs.Tab[] = [];
  try {
    tabs = await chrome.tabs.query({ currentWindow: true });
  } catch {
    tabs = [];
  }
  const [candidate] = rankPickerTabs(tabs, options.origin, options.ownTabId);
  if (!candidate || candidate.id === undefined) {
    return {
      status: "error",
      code: "NO_TAB",
      message: "没有可用于拾取的网页标签页",
    };
  }
  const tabId = candidate.id;

  try {
    await chrome.tabs.update(tabId, { active: true });
    if (candidate.windowId !== undefined) {
      await chrome.windows.update(candidate.windowId, { focused: true });
    }
  } catch {
    /* 聚焦失败不阻断拾取 */
  }

  try {
    const started = await runPicker(tabId, "start");
    if (!started.ok) {
      // 受限页面（chrome://、PDF、应用商店）：立刻报错，不再空转轮询
      return {
        status: "error",
        code: "INJECT_FAILED",
        message: started.message,
      };
    }
    const alreadyPicked = findPicked(started.frames);
    if (alreadyPicked) return { status: "picked", ...alreadyPicked };

    const deadline = Date.now() + timeoutMs;
    let idleStrikes = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollInterval));
      const polled = await runPicker(tabId, "state");
      // 页面正在跳转时注入会短暂失败，计入 strike；恢复后清零
      idleStrikes = !polled.ok || allIdle(polled.frames) ? idleStrikes + 1 : 0;
      if (idleStrikes >= PICKER_IDLE_STRIKES) {
        return {
          status: "lost",
          message: "页面已跳转或刷新，拾取已中断",
        };
      }
      if (!polled.ok) continue;

      const picked = findPicked(polled.frames);
      if (picked) return { status: "picked", ...picked };
      if (allStopped(polled.frames)) return { status: "cancelled" };
    }
    return {
      status: "error",
      code: "TIMEOUT",
      message: "拾取未收到响应",
    };
  } finally {
    // 幂等：无论成功、失败还是异常，都保证监听被解绑
    await runPicker(tabId, "stop");
    // 切回来源标签页：拾取在另一个页面发生，停在那里等于丢失上下文
    if (options.ownTabId !== undefined) {
      try {
        await chrome.tabs.update(options.ownTabId, { active: true });
        if (options.ownWindowId !== undefined) {
          await chrome.windows.update(options.ownWindowId, { focused: true });
        }
      } catch {
        /* 配置页已关闭，静默 */
      }
    }
  }
}
