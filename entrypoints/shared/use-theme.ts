/**
 * 全局主题管理：支持 light / dark / system（默认随系统）
 * 主题偏好存储在 chrome.storage.local 中。
 *
 * 使用方式：
 * 1. Vue 页面 main.ts 中调用 initTheme() 初始化
 * 2. Vue 组件中使用 useTheme() 响应式状态和切换器
 */

import { safeStorageSet } from './safe-storage';

export type ThemeMode = 'system' | 'light' | 'dark';

const THEME_KEY = 'devtools-theme';

function getSystemDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * 根据当前主题模式设置 html 的 data-dt-dark 属性。
 */
export function applyTheme(mode?: ThemeMode): ThemeMode {
  const current = mode || getStoredTheme();
  const isDark =
    current === 'dark' || (current === 'system' && getSystemDark());
  document.documentElement.toggleAttribute('data-dt-dark', isDark);
  // 设置 color-scheme，确保原生控件（checkbox 等）样式与主题一致
  // 亮色模式强制 light，暗色模式强制 dark，防止系统偏好干扰
  document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
  return current;
}

/**
 * 读取存储的主题偏好，首次使用返回 'system'。
 */
export function getStoredTheme(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    // localStorage 可能不可用（例如 content script）
  }
  return 'system';
}

/**
 * 保存主题偏好。
 */
export function setStoredTheme(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    // ignore
  }
  // 同步写入 chrome.storage.local，供 content script 读取。
  // 主题在 localStorage 已有副本，此处失败影响可忽略，静默处理
  // （顺带消除裸调用 promise rejection 无法被同步 try/catch 捕获的问题）
  void safeStorageSet({ [THEME_KEY]: mode }, { notify: false });
  applyTheme(mode);
  // 通过事件通知其他页面/组件主题已变更
  window.dispatchEvent(new CustomEvent('theme-changed', { detail: mode }));
}

/**
 * 在每个 Vue 页面的 main.ts 中调用，实现主题切换时全局组件即时响应。
 * 通过 html 元素的 data-dt-dark 属性控制暗色模式。
 * （ADR-0003 D6：原 watchThemeChanges 与本函数逐字重复，已合并为单一入口）
 */
export function initTheme(): void {
  // 初始应用
  applyTheme();
  // 监听同一 tab 内的切换（跨 tab 通过 storage 事件）
  window.addEventListener('theme-changed', (e: Event) => {
    const mode = (e as CustomEvent<ThemeMode>).detail;
    applyTheme(mode);
  });
  // 监听其他 tab 的变更
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key === THEME_KEY) {
      applyTheme(getStoredTheme());
    }
  });
}
