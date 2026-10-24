/**
 * Target 定位器（ADR-0012 D3 / D12）
 *
 * 设计约束：
 * - 页面内自包含：`domActionInPage` 的**全部辅助函数都定义在函数体内**，
 *   不引用任何模块级变量。`chrome.scripting.executeScript({ func })` 会序列化
 *   函数源码，闭包引用会在页面里丢失。
 * - 递归 open shadowRoot 深查询；隐藏元素一律忽略。
 * - 多个可见命中 → `ambiguous`，绝不静默取第一个。
 *
 * 本模块同时导出 `describeTarget`（纯函数，UI/日志用）与 `domActionInPage`
 * （页面内执行，happy-dom 单测直接调用）。
 */

import type { Target } from "./generic-recipe";

/** 页面内动作描述（跨执行边界，必须可结构化克隆） */
export type DomAction =
  | { action: "locate"; target: Target }
  | {
      action: "fill";
      target: Target;
      value: string;
      clearFirst: boolean;
    }
  | { action: "click"; target: Target }
  /** 读取唯一命中元素的文本内容 / 输入值（`extract` 的 dom 源） */
  | { action: "read"; target: Target }
  | { action: "scan"; patterns: string[] };

export interface DomActionResult {
  status: "ok" | "notFound" | "ambiguous" | "invalid" | "error";
  /** 命中数量（locate）或 1（其他动作） */
  count: number;
  /** 可读描述/错误信息 */
  message?: string;
  /** 读取到的文本（仅 `read` 动作） */
  value?: string;
  /**
   * 执行该动作的 frame 地址。拾取器记录 frameUrl 后，执行器用它
   * 在页面导航后重新锁定同一子 frame（frameId 会变，URL 不会）。
   */
  frameUrl?: string;
}

/** 人类可读的定位描述（日志、UI、错误信息） */
export function describeTarget(target: Target): string {
  if (typeof target === "string") return target;
  if ("css" in target) return target.css;
  if ("ariaLabel" in target) return `aria-label「${target.ariaLabel}」`;
  if ("label" in target) return `label「${target.label}」`;
  if ("name" in target) return `name=${target.name}`;
  if ("placeholder" in target) return `placeholder「${target.placeholder}」`;
  return `文本「${target.text}」`;
}

/* eslint-disable complexity -- 页面内函数需要单体内聚，不能拆成模块级函数 */
/**
 * 页面内执行体：定位 / 填充 / 点击 / 文本扫描。
 *
 * ⚠️ 本函数会被 `executeScript` 序列化注入页面，**禁止引用函数外部任何标识符**
 * （包括 import 的常量、工具函数）。所有辅助函数必须写在函数体内。
 */
export function domActionInPage(payload: DomAction): DomActionResult {
  const frameUrl =
    typeof location === "undefined" ? undefined : location.href;

  type AnyEl = Element & {
    value?: string;
    hidden?: boolean;
    disabled?: boolean;
    click?: () => void;
    control?: Element | null;
    htmlFor?: string;
    shadowRoot?: ShadowRoot | null;
    focus?: () => void;
    scrollIntoView?: (opts?: unknown) => void;
    checkVisibility?: (opts?: unknown) => boolean;
  };

  const TAG_TIMEOUT_MS = 0;
  void TAG_TIMEOUT_MS;

  /** 收集文档 + 所有 open shadow root 的查询作用域 */
  function collectScopes(): ParentNode[] {
    const scopes: ParentNode[] = [];
    const visit = (scope: ParentNode) => {
      scopes.push(scope);
      const els = scope.querySelectorAll("*");
      for (let i = 0; i < els.length; i++) {
        const shadow = (els[i] as AnyEl).shadowRoot;
        if (shadow) visit(shadow);
      }
    };
    visit(document);
    return scopes;
  }

  function styleOf(el: Element): CSSStyleDeclaration | null {
    try {
      return window.getComputedStyle(el);
    } catch {
      return null;
    }
  }

  /**
   * 隐藏元素忽略：display/visibility/opacity/hidden 任一生效都不可用，
   * 自身与祖先都要检查（`[hidden]` 在部分实现里不会反映到 computed style，
   * 因此显式判属性，不只依赖 display:none）。
   */
  function isVisible(el: Element): boolean {
    let node: Element | null = el;
    while (node) {
      if ((node as AnyEl).hidden) return false;
      const style = styleOf(node);
      if (style) {
        if (style.display === "none") return false;
        if (style.visibility === "hidden" || style.visibility === "collapse") {
          return false;
        }
        // happy-dom 等环境可能返回空串，不能把「未声明」当成 0
        const rawOpacity = style.opacity;
        if (rawOpacity !== "" && Number(rawOpacity) === 0) return false;
      }
      node = node.parentElement;
    }
    return true;
  }

  function cssEscape(value: string): string {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(value);
    }
    return value.replace(/["\\]/g, "\\$&");
  }

  function queryAll(selector: string): Element[] {
    const out: Element[] = [];
    for (const scope of collectScopes()) {
      let found: NodeListOf<Element>;
      try {
        found = scope.querySelectorAll(selector);
      } catch (e) {
        throw { invalid: true, message: (e as Error).message };
      }
      for (let i = 0; i < found.length; i++) out.push(found[i]);
    }
    return out;
  }

  /**
   * 通过 aria-label 找元素。
   * 同时兼容 `aria-labelledby` 指向的文本：两者语义都是「无障碍名称」，
   * 用户从 ShadeKit 读到的往往就是其中一个。
   */
  function byAriaLabel(ariaLabel: string): Element[] {
    const direct = queryAll(`[aria-label="${cssEscape(ariaLabel)}"]`);
    if (direct.length > 0) return direct;
    const referenced = queryAll("[aria-labelledby]").filter((el) => {
      const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/);
      return ids.some((id) => {
        for (const scope of collectScopes()) {
          const doc = scope as Document;
          const node =
            typeof doc.getElementById === "function"
              ? doc.getElementById(id)
              : null;
          if (node && (node.textContent || "").trim() === ariaLabel) return true;
        }
        return false;
      });
    });
    return referenced;
  }

  /** 通过 label 文本找控件：label[for] → label 内控件 → label 的 aria-labelledby */
  function byLabel(labelText: string): Element[] {
    const labels = queryAll("label").filter(
      (el) => (el.textContent || "").trim() === labelText,
    );
    const controls: Element[] = [];
    for (const label of labels) {
      const anyLabel = label as AnyEl;
      let control: Element | null = null;
      if (anyLabel.control) {
        control = anyLabel.control;
      } else if (anyLabel.htmlFor) {
        for (const scope of collectScopes()) {
          const doc = scope as Document;
          const byId =
            typeof doc.getElementById === "function"
              ? doc.getElementById(anyLabel.htmlFor)
              : null;
          if (byId) {
            control = byId;
            break;
          }
        }
      }
      if (!control) {
        control = label.querySelector("input, textarea, select, button");
      }
      if (control) controls.push(control);
    }
    return controls;
  }

  /**
   * 文本归一化：去掉全部空白。
   *
   * CSS 没有「文本等于」这种表达式，而同一句文案在页面上有多种写法——
   * 部分中文界面会在两个汉字之间插空格（`登 录`），用户手写定位时
   * 只可能写 `登录`。比较前两侧统一去空白，两种写法才能互认。
   */
  function normalizeText(value: string): string {
    return value.replace(/\s+/g, "");
  }

  /** 只保留最内层元素：子元素也命中时，父元素不算独立命中 */
  function leavesOf(matched: Element[], needle: string): Element[] {
    return matched.filter(
      (el) =>
        !Array.from(el.children).some((child) =>
          normalizeText(child.textContent || "").includes(needle),
        ),
    );
  }

  /**
   * 通过可见文本找元素：**精确优先**，取文本匹配的最内层元素。
   *
   * 先按归一化后的「完全相等」找；一个可见的精确命中都没有时，才退回子串
   * 包含。否则 `登录` 会把 `密码登录` / `CA登录` / `短信登录` 这些页签一并
   * 算成命中（多页签登录弹窗回归：4 个可见元素 → `AMBIGUOUS_TARGET`）。
   *
   * 退回条件是「精确命中**全部不可见**」而不是「没有精确命中」：PC / 移动
   * 两套布局并存、只显示一套的站点里，隐藏那套的按钮文案往往才是精确的，
   * 此时应当回退到可见的那套子串命中，而不是直接 `ELEMENT_NOT_FOUND`。
   */
  function byText(text: string): Element[] {
    const needle = normalizeText(text);
    if (!needle) return [];

    const exact: Element[] = [];
    const partial: Element[] = [];
    for (const el of queryAll("*")) {
      if (el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;
      const content = normalizeText(el.textContent || "");
      if (content === needle) exact.push(el);
      else if (content.includes(needle)) partial.push(el);
    }

    const exactLeaves = leavesOf(exact, needle);
    const partialLeaves = leavesOf(partial, needle);
    let candidates: Element[];
    if (exactLeaves.length === 0) {
      candidates = partialLeaves;
    } else if (exactLeaves.some(isVisible)) {
      candidates = exactLeaves;
    } else {
      candidates = partialLeaves;
    }

    // 可交互元素优先（按钮/链接/带 role 的元素）
    const interactive = candidates.filter(
      (el) =>
        /^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(el.tagName) ||
        el.getAttribute("role") === "button",
    );
    return interactive.length > 0 ? interactive : candidates;
  }

  /** 按 Target 查出全部命中（未过滤可见性） */
  function rawMatch(target: Target): Element[] {
    if (typeof target === "string") return queryAll(target);
    if ("css" in target) return queryAll(target.css);
    if ("ariaLabel" in target) return byAriaLabel(target.ariaLabel);
    if ("label" in target) return byLabel(target.label);
    if ("name" in target) {
      return queryAll(`[name="${cssEscape(target.name)}"]`);
    }
    if ("placeholder" in target) {
      return queryAll(`[placeholder="${cssEscape(target.placeholder)}"]`);
    }
    return byText((target as { text: string }).text);
  }

  function resolve(target: Target): {
    status: DomActionResult["status"];
    elements: AnyEl[];
    message?: string;
  } {
    let matched: Element[];
    try {
      matched = rawMatch(target);
    } catch (e) {
      if (e && typeof e === "object" && "invalid" in e) {
        return {
          status: "invalid",
          elements: [],
          message: (e as { message?: string }).message,
        };
      }
      return {
        status: "error",
        elements: [],
        message: e instanceof Error ? e.message : String(e),
      };
    }

    // 去重（label 路径可能重复命中同一控件）
    const visible: AnyEl[] = [];
    for (const el of matched) {
      if (visible.indexOf(el as AnyEl) !== -1) continue;
      if (!isVisible(el)) continue;
      visible.push(el as AnyEl);
    }

    if (visible.length === 0) {
      return { status: "notFound", elements: [] };
    }
    if (visible.length > 1) {
      return {
        status: "ambiguous",
        elements: visible,
        message: `匹配到 ${visible.length} 个可见元素，无法确定唯一目标`,
      };
    }
    return { status: "ok", elements: visible };
  }

  function setNativeValue(el: AnyEl, value: string): void {
    const tag = el.tagName;
    const proto =
      tag === "TEXTAREA"
        ? window.HTMLTextAreaElement?.prototype
        : tag === "SELECT"
          ? window.HTMLSelectElement?.prototype
          : window.HTMLInputElement?.prototype;
    const descriptor = proto
      ? Object.getOwnPropertyDescriptor(proto, "value")
      : undefined;
    if (descriptor?.set) {
      descriptor.set.call(el, value);
    } else {
      el.value = value;
    }
  }

  function dispatch(el: Element, type: string): void {
    const Ctor =
      type === "input" && typeof window.InputEvent === "function"
        ? window.InputEvent
        : window.Event;
    el.dispatchEvent(new Ctor(type, { bubbles: true }));
  }

  if (payload.action === "scan") {
    /**
     * 按**可见叶子文本**扫描，而不是整页 `innerText`。
     *
     * 整页文本会把两类「不是提示」的东西算成验证码命中：
     * - 隐藏面板 / 未激活 tab 的内容（如登录页的「邮箱验证码」表单）
     * - 可交互的切换入口本身（`<span class="tab-item">邮箱验证码</span>`，
     *   站点默认停在账号密码页，这句话始终可见）
     *
     * 因此：自身可见 → 不含任何元素子节点（叶子）→ 且不是可点击入口。
     * 真正的风控提示是静态文本（如 `.captcha` 里的「请输入验证码」），仍会命中。
     */
    function isClickable(el: Element): boolean {
      if (el.tagName === "A" || el.tagName === "BUTTON" || el.tagName === "SUMMARY") {
        return true;
      }
      const role = el.getAttribute("role");
      if (role === "button" || role === "tab" || role === "link") return true;
      if (el.tagName === "INPUT") {
        return /^(button|submit|reset|image)$/.test(
          (el.getAttribute("type") || "").toLowerCase(),
        );
      }
      // 带 cursor:pointer 的普通元素（tab 常用 span / div 实现）
      const style = styleOf(el);
      return !!style && style.cursor === "pointer";
    }

    const texts: string[] = [];
    for (const scope of collectScopes()) {
      const all = scope.querySelectorAll("*");
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;
        // 非叶子（内部还有元素）交给内层负责，避免整段正文 / 容器文本命中
        if (el.children.length > 0) continue;
        const text = (el.textContent || "").trim();
        if (!text) continue;
        if (!isVisible(el)) continue;
        if (isClickable(el)) continue;
        texts.push(text);
      }
    }

    const text = texts.join("\n");
    for (const pattern of payload.patterns) {
      try {
        if (new RegExp(pattern, "i").test(text)) {
          return { status: "ok", count: 1, message: pattern, frameUrl };
        }
      } catch {
        /* 非法正则忽略 */
      }
    }
    return { status: "notFound", count: 0, frameUrl };
  }

  const located = resolve(payload.target);
  if (located.status !== "ok") {
    return {
      status: located.status,
      count: located.elements.length,
      message: located.message,
      frameUrl,
    };
  }
  const el = located.elements[0];

  if (payload.action === "locate") {
    return { status: "ok", count: 1, frameUrl };
  }

  if (payload.action === "read") {
    const html = el as AnyEl & { innerText?: string };
    return {
      status: "ok",
      count: 1,
      value: html.innerText || html.value || "",
      frameUrl,
    };
  }

  if (payload.action === "fill") {
    try {
      el.scrollIntoView?.({ block: "center", inline: "nearest" });
    } catch {
      /* ignore */
    }
    try {
      el.focus?.();
    } catch {
      /* ignore */
    }
    if (payload.clearFirst) setNativeValue(el, "");
    setNativeValue(el, payload.value);
    dispatch(el, "input");
    dispatch(el, "change");
    return { status: "ok", count: 1, frameUrl };
  }

  // click
  try {
    el.scrollIntoView?.({ block: "center", inline: "nearest" });
  } catch {
    /* ignore */
  }
  if (typeof el.click === "function") {
    el.click();
  } else {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  }
  return { status: "ok", count: 1, frameUrl };
}
/* eslint-enable complexity */
