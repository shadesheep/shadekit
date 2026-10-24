/**
 * Toast 图标与类型常量，供 Vue ToastContainer 和 Page Toast 共用。
 */
export const TOAST_ICONS = {
  success: { char: '✓', lucide: 'i-lucide-check-circle' },
  error: { char: '✕', lucide: 'i-lucide-x-circle' },
  info: { char: 'ℹ', lucide: 'i-lucide-info' },
} as const;

export type ToastType = keyof typeof TOAST_ICONS;

/**
 * Toast 共享样式字符串。供 showPageToast 注入页面，ToastContainer.vue 使用相同类名。
 */
export const TOAST_CSS = `
.devtools-toast-container {
  position: fixed; top: 16px; right: 16px; z-index: 999999;
  display: flex; flex-direction: column; gap: 8px; max-width: 360px; pointer-events: none;
}
.devtools-toast {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 14px; border-radius: 8px;
  font-size: 13px; font-weight: 500; line-height: 1.4;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
  font-family: system-ui, -apple-system, sans-serif;
  pointer-events: auto;
  opacity: 0; transform: translateX(100%);
  transition: all 0.25s ease-out;
}
.devtools-toast.devtools-toast-visible {
  opacity: 1; transform: translateX(0);
}
.devtools-toast.devtools-toast-hiding {
  opacity: 0; transform: translateX(100%);
}
.devtools-toast-icon { width: 16px; height: 16px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 16px; }
.devtools-toast-message { flex: 1; }
.devtools-toast-close {
  display: flex; align-items: center; justify-content: center;
  border: none; background: transparent; cursor: pointer; padding: 2px;
  border-radius: 4px; color: inherit; opacity: 0.5; transition: opacity 0.15s ease-out; flex-shrink: 0;
}
.devtools-toast-close:hover { opacity: 1; }
.devtools-toast-success { background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; }
.devtools-toast-success .devtools-toast-icon { color: #16a34a; }
.devtools-toast-error { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
.devtools-toast-error .devtools-toast-icon { color: #dc2626; }
.devtools-toast-info { background: #eff6ff; color: #1e40af; border: 1px solid #bfdbfe; }
.devtools-toast-info .devtools-toast-icon { color: #3b82f6; }
[data-dt-dark] .devtools-toast-success { background: #052e16; color: #6ee7b7; border-color: #064e3b; }
[data-dt-dark] .devtools-toast-success .devtools-toast-icon { color: #4ade80; }
[data-dt-dark] .devtools-toast-error { background: #450a0a; color: #fca5a5; border-color: #7f1d1d; }
[data-dt-dark] .devtools-toast-error .devtools-toast-icon { color: #f87171; }
[data-dt-dark] .devtools-toast-info { background: #1e3a5f; color: #93c5fd; border-color: #1e40af; }
[data-dt-dark] .devtools-toast-info .devtools-toast-icon { color: #60a5fa; }
`;
