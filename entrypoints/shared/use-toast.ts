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
  /** 旧单操作兼容字段，指向首个操作。 */
  action?: ToastAction;
  actions: ToastAction[];
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
  action?: ToastAction | ToastAction[],
) {
  const id = ++nextId;
  const actions = Array.isArray(action) ? action : action ? [action] : [];
  toasts.value.push({ id, message, type, actions, ...(actions[0] ? { action: actions[0] } : {}) });
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
