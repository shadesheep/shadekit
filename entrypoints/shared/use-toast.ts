import { computed, ref } from 'vue';

export type ToastType = 'success' | 'error' | 'info';

/** Toast 上的操作按钮（如错误 Toast 的「复制详情」） */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
  action?: ToastAction;
}

const toasts = ref<Toast[]>([]);

let nextId = 0;

/**
 * 显示一条 Toast 通知
 * @param message - 提示文本
 * @param type - 类型：success / error / info
 * @param duration - 自动消失时间（ms），0 表示不自动消失
 * @param action - 可选操作按钮（如「复制详情」）
 */
export function showToast(
  message: string,
  type: ToastType = 'info',
  duration = 2000,
  action?: ToastAction,
) {
  const id = ++nextId;
  toasts.value.push({ id, message, type, action });
  if (duration > 0) {
    setTimeout(() => {
      dismissToast(id);
    }, duration);
  }
}

/**
 * 手动关闭一条 Toast
 */
export function dismissToast(id: number) {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

/**
 * Composable 形式（用于 ToastContainer 组件内部）
 */
export function useToast() {
  return {
    toasts: computed(() => toasts.value),
    dismissToast,
  };
}
