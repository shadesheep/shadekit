import { createApp, watch } from "vue";
import { defineContentScript } from "wxt/utils/define-content-script";
import {
  readThemeMode,
  resolveDark,
  watchDarkMode,
} from "../shared/content-theme";
import { systemLog } from "../shared/logger";
import type { ContentMessages } from "../shared/messages";
import ToastContainer from "../shared/ToastContainer.vue";
import { allTools } from "../shared/tool-definitions";
import { useToast } from "../shared/use-toast";
import {
  initEnvIndicator,
  loadEnvBadgeConfig,
} from "../tools/account-switch/EnvIndicator";
import {
  injectStylesIntoShadowRoot,
  preloadShadowStyles,
} from "./shadow-style-injector";
import { getFloatPanelPosition } from "./float-panel-position";
// 样式经标准 Vite 管线打包为 content-scripts/content.css
// （cssInjectionMode: 'ui' → 不注入页面，由 shadow-style-injector 运行时
// fetch 后注入各 Shadow Root）。导入顺序即最终 CSS 级联顺序。
import "../shared/dark-mode.css";
import "virtual:uno.css";
import "./style.scss";

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  cssInjectionMode: "ui",
  async main() {
    await waitForBody();
    if (!document.body) return;

    // 预热 Shadow DOM 共享样式表，避免首次弹出面板/Toast 时 FOUC
    preloadShadowStyles();

    // 在 body 级别创建 Toast 根节点（Shadow Host）
    const toastHost = document.createElement("div");
    toastHost.id = "devtools-toast-root";
    toastHost.className = "toast-host";

    // 创建 Shadow Root 并注入样式
    const toastShadowRoot = toastHost.attachShadow({ mode: "open" });

    // 在 Shadow Root 内创建挂载点（同时作为暗色模式属性载体：
    // UnoCSS dark: 与 SFC scoped 的 [data-dt-dark] 选择器需要 shadow 内的祖先元素）
    const toastMountPoint = document.createElement("div");
    toastMountPoint.className = "dt-shadow-ui";
    toastShadowRoot.appendChild(toastMountPoint);
    void injectStylesIntoShadowRoot(toastShadowRoot);

    // 惰性挂载：首个 toast 出现时才把 host 附加到 body，
    // 避免向从不触发 toast 的页面注入常驻节点（宿主页面零侵入）
    const { toasts } = useToast();
    let toastHostAttached = false;
    watch(
      () => toasts.value.length,
      async (len) => {
        if (!toastHostAttached && len > 0 && document.body) {
          document.body.appendChild(toastHost);
          toastHostAttached = true;
          // 同步当前主题到后挂载的 host（applyThemeToContainers 只处理已在 DOM 中的节点）
          const isDark = resolveDark(await readThemeMode());
          toastHost.toggleAttribute("data-dt-dark", isDark);
          toastMountPoint.toggleAttribute("data-dt-dark", isDark);
        }
      },
    );

    // 挂载 ToastContainer
    const toastApp = createApp(ToastContainer);
    toastApp.mount(toastMountPoint);

    // 环境指示器（ADR-0017 D1：并入账号切换，envBadge.enabled 控制）
    if ((await loadEnvBadgeConfig()).enabled) {
      initEnvIndicator();
    }

    // 主题管理（不影响宿主页面）
    void watchDarkMode(applyThemeToContainers);
  },
});

async function waitForBody(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (document.body) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

// 当前打开的面板
let activePanel: { toolId: string; el: HTMLDivElement } | null = null;

// 鼠标位置追踪（用于快捷键唤出面板定位）
let lastMousePosition = { x: 0, y: 0 };
document.addEventListener("mousemove", (e: MouseEvent) => {
  lastMousePosition = { x: e.clientX, y: e.clientY };
});

// ============================================================
// 主题管理（仅在插件容器上设置 data-dt-dark 属性，不影响宿主页面）
// 读取/监听收口在 shared/content-theme.ts（ADR-0004 D7）
// ============================================================

function applyThemeToContainers(isDark: boolean): void {
  // data-dt-dark 需要同时设置在两层：
  // - Shadow Host：供 `:host([data-dt-dark])` 选择器匹配（dark-mode.css、style.scss）
  // - Shadow 内挂载容器（.dt-shadow-ui）：供 `[data-dt-dark] .xxx` 后代选择器匹配
  //   （UnoCSS dark: 工具类、Vue SFC scoped 暗色覆盖）
  for (const hostId of ["devtools-panel", "devtools-toast-root"]) {
    const host = document.getElementById(hostId);
    host?.toggleAttribute("data-dt-dark", isDark);
    host?.shadowRoot
      ?.querySelector(".dt-shadow-ui")
      ?.toggleAttribute("data-dt-dark", isDark);
  }
}

// ============================================================
// 快捷键唤出账号切换面板
// ============================================================

chrome.runtime.onMessage.addListener(
  (message: ContentMessages, _sender, sendResponse) => {
    if (message.type === "OPEN_ACCOUNT_SWITCHER") {
      void openAccountSwitcherAtMouse();
      sendResponse({ success: true });
    }
  },
);

/** 浮动面板监听器与动态定位资源（关闭时统一清理） */
let floatPanelOutsideClick: ((e: MouseEvent) => void) | null = null;
let floatPanelEscHandler: ((e: KeyboardEvent) => void) | null = null;
let floatPanelRepositionHandler: (() => void) | null = null;
let floatPanelResizeObserver: ResizeObserver | null = null;
let floatPanelPositionFrame: number | null = null;

function positionFloatPanel(
  panelHost: HTMLDivElement,
  anchor: { x: number; y: number },
): void {
  // offsetWidth/Height 不受入场 scale 动画影响，避免动画期间测得偏小。
  const position = getFloatPanelPosition(
    anchor,
    { width: panelHost.offsetWidth, height: panelHost.offsetHeight },
    { width: window.innerWidth, height: window.innerHeight },
  );
  panelHost.style.left = `${position.x}px`;
  panelHost.style.top = `${position.y}px`;
}

async function openAccountSwitcherAtMouse() {
  const tool = allTools.find((t) => t.id === "account-switch");
  if (!tool?.contentScript?.panel) return;

  // Toggle：已打开则关闭
  if (activePanel && activePanel.toolId === "account-switch-float") {
    closeFloatPanel();
    return;
  }

  // 清理上一次的浮动面板监听
  closeFloatPanel();

  const x = lastMousePosition.x || window.innerWidth / 2;
  const y = lastMousePosition.y || window.innerHeight / 2;

  // 创建 Shadow Host
  const panelHost = document.createElement("div");
  panelHost.id = "devtools-panel";
  panelHost.className = "panel-host devtools-panel devtools-panel-float";
  panelHost.style.left = `${x + 12}px`;
  panelHost.style.top = `${Math.max(y - 10, 8)}px`;

  // 创建 Shadow Root 并注入样式
  const shadowRoot = panelHost.attachShadow({ mode: "open" });

  // Shadow 内的 UI 容器：承载 data-dt-dark 属性（暗色后代选择器需要）
  const uiRoot = document.createElement("div");
  uiRoot.className = "dt-shadow-ui";
  shadowRoot.appendChild(uiRoot);

  // 防宿主页面全局按键拦截：部分遗留页面在 document 层对「非编辑目标」的
  // Backspace/Delete 做 preventDefault（防后退导航）。Shadow DOM 内的键盘事件
  // 冒泡到 document 层时 target 会被重定向为 shadow host（普通 div），导致面板
  // 内输入框无法删除内容。在 Shadow Root 内对编辑目标阻断冒泡即可（此处能看到
  // 真实 target）。
  shadowRoot.addEventListener("keydown", (e) => {
    if (!(e instanceof KeyboardEvent)) return;
    if (e.key !== "Backspace" && e.key !== "Delete") return;
    const t = e.target as HTMLElement | null;
    const editable =
      !!t &&
      (t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.isContentEditable);
    if (editable) e.stopPropagation();
  });

  // 在 Shadow Root 内创建面板结构
  const titleBar = document.createElement("div");
  titleBar.className = "devtools-panel-title";
  titleBar.innerHTML = `<span>${tool.contentScript.panel.title}</span><button type="button" class="devtools-panel-close" title="关闭账号切换面板" aria-label="关闭账号切换面板">&times;</button>`;
  (titleBar.querySelector(
    ".devtools-panel-close",
  ) as HTMLButtonElement)!.onclick = () => {
    closeFloatPanel();
  };

  const content = document.createElement("div");
  content.className = "devtools-panel-content";
  content.textContent = "加载中...";

  // 在 Shadow Root 内创建 Toast 挂载点
  const toastRoot = document.createElement("div");
  toastRoot.id = "shadow-toast-root";
  uiRoot.appendChild(toastRoot);

  uiRoot.appendChild(titleBar);
  uiRoot.appendChild(content);

  // 同步主题属性到 Shadow Host 与内部容器
  const isDark = resolveDark(await readThemeMode());
  panelHost.toggleAttribute("data-dt-dark", isDark);
  uiRoot.toggleAttribute("data-dt-dark", isDark);

  // 样式注入完成后再上屏，避免未样式化闪烁
  await injectStylesIntoShadowRoot(shadowRoot);
  document.body.appendChild(panelHost);

  activePanel = { toolId: "account-switch-float", el: panelHost };

  // 内容异步加载、搜索过滤和窗口缩放都会改变可用空间，统一合并到下一帧定位。
  const anchor = { x, y };
  const reposition = () => {
    if (floatPanelPositionFrame !== null) {
      cancelAnimationFrame(floatPanelPositionFrame);
    }
    floatPanelPositionFrame = requestAnimationFrame(() => {
      floatPanelPositionFrame = null;
      if (panelHost.isConnected) positionFloatPanel(panelHost, anchor);
    });
  };
  floatPanelRepositionHandler = reposition;
  window.addEventListener("resize", reposition);
  floatPanelResizeObserver = new ResizeObserver(reposition);
  floatPanelResizeObserver.observe(panelHost);
  reposition();

  // 点击外部关闭 — 使用 composedPath 穿透 Shadow DOM 边界
  floatPanelOutsideClick = (e: MouseEvent) => {
    const path = e.composedPath();
    const isInsidePanel = path.some((node) => node === panelHost);
    if (isInsidePanel) return;
    closeFloatPanel();
  };
  document.addEventListener("mousedown", floatPanelOutsideClick);

  // ESC 关闭
  floatPanelEscHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      closeFloatPanel();
    }
  };
  document.addEventListener("keydown", floatPanelEscHandler);

  // 动态加载组件并渲染
  try {
    const mod = await tool.contentScript.panel.component();
    const comp = mod.default || mod.__default;
    if (activePanel?.el !== panelHost) return;
    if (!comp || (typeof comp !== "function" && typeof comp !== "object")) {
      content.textContent = "组件加载失败";
      return;
    }
    const app = createApp(comp);
    app.mount(content);
    reposition();
  } catch (e) {
    content.textContent = "加载失败";
    systemLog.error("Float panel load error", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** 关闭浮动面板并清理监听器 */
function closeFloatPanel() {
  if (activePanel && activePanel.toolId === "account-switch-float") {
    activePanel.el.remove();
  }
  activePanel = null;
  if (floatPanelPositionFrame !== null) {
    cancelAnimationFrame(floatPanelPositionFrame);
    floatPanelPositionFrame = null;
  }
  floatPanelResizeObserver?.disconnect();
  floatPanelResizeObserver = null;
  if (floatPanelRepositionHandler) {
    window.removeEventListener("resize", floatPanelRepositionHandler);
    floatPanelRepositionHandler = null;
  }
  if (floatPanelOutsideClick) {
    document.removeEventListener("mousedown", floatPanelOutsideClick);
    floatPanelOutsideClick = null;
  }
  if (floatPanelEscHandler) {
    document.removeEventListener("keydown", floatPanelEscHandler);
    floatPanelEscHandler = null;
  }
}
