/**
 * 命令快捷键状态（Vue 组合式）— 检测 + 恢复。
 *
 * 纯函数（常量 / getAll / 格式化 / 能力探测）在 `command-shortcut.ts`：
 * background 也要查绑定状态，不能把 Vue 打进 service worker 包。
 *
 * 为什么不"后台自愈"：
 * - Chrome/Edge 没有 chrome.commands.update（只有 getAll + onCommand），
 *   空绑定无法编程式写入；
 * - Firefox 有 commands.reset，可恢复成 manifest 的 suggested_key；
 * - Chrome/Edge 的「装完即用」由 content/shortcut-fallback.ts 在页面内补齐。
 */
import { ref } from 'vue';
import {
  canRestoreShortcut,
  getCommandShortcut,
  restoreShortcut,
  SHORTCUT_COMMAND_NAME,
} from './command-shortcut';

export function useCommandShortcut(name: string = SHORTCUT_COMMAND_NAME) {
  /** null = 尚未查询；'' = 未注册 */
  const shortcut = ref<string | null>(null);
  const restoring = ref(false);
  const canRestore = canRestoreShortcut();

  async function refresh() {
    try {
      shortcut.value = await getCommandShortcut(name);
    } catch {
      shortcut.value = '';
    }
  }

  /** 恢复为建议快捷键（用户手势内调用；仅 Firefox 有效） */
  async function restoreSuggested() {
    restoring.value = true;
    try {
      await restoreShortcut(name);
      await refresh();
    } finally {
      restoring.value = false;
    }
  }

  return { shortcut, restoring, canRestore, refresh, restoreSuggested };
}
