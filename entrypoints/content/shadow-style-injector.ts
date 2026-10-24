/**
 * Shadow DOM 样式注入工具
 *
 * content script 声明了 cssInjectionMode: 'ui'，WXT 将入口 CSS
 * （dark-mode.css + UnoCSS + style.scss + Vue SFC 样式）打包为
 * content-scripts/content.css 并自动加入 web_accessible_resources，
 * 此处运行时 fetch 后通过 adoptedStyleSheets 注入各 Shadow Root。
 *
 * 暗色模式：样式中同时存在两种选择器形式——
 * - `:host([data-dt-dark])`：匹配 shadow host 上的属性（dark-mode.css、style.scss）
 * - `[data-dt-dark] .xxx`：匹配 shadow 内挂载容器上的属性（UnoCSS dark:、SFC scoped）
 * 因此 host 与其内部挂载容器都需要设置 data-dt-dark（见 content/index.ts）。
 */

// 共享的 CSSStyleSheet（多个 Shadow Root 复用，减少内存占用）
let sharedSheetPromise: Promise<CSSStyleSheet> | null = null;

function loadSharedStyleSheet(): Promise<CSSStyleSheet> {
  sharedSheetPromise ??= (async () => {
    const url = chrome.runtime.getURL('content-scripts/content.css');
    const css = await (await fetch(url)).text();
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    return sheet;
  })();
  return sharedSheetPromise;
}

/**
 * 预热样式表：content script 启动时调用，
 * 避免首次打开面板/Toast 时等待 fetch 导致未样式化闪烁（FOUC）。
 */
export function preloadShadowStyles(): void {
  void loadSharedStyleSheet().catch((e) => {
    console.warn('[ShadeKit] Failed to preload content.css:', e);
  });
}

/**
 * 将样式注入到 Shadow Root
 * 使用 adoptedStyleSheets API（性能最优，可共享样式表）
 *
 * @param shadowRoot - Shadow Root 实例
 */
export async function injectStylesIntoShadowRoot(shadowRoot: ShadowRoot): Promise<void> {
  try {
    shadowRoot.adoptedStyleSheets = [await loadSharedStyleSheet()];
  } catch (e) {
    console.warn('[ShadeKit] Failed to inject content.css into shadow root:', e);
  }
}
