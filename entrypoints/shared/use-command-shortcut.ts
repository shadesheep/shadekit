/**
 * 命令快捷键状态检测与设置
 *
 * 背景(2026-08 实测,Edge 151 / Chromium 151):
 * - manifest suggested_key 仅在安装时生效;若安装时快捷键被其他扩展/程序占用,
 *   浏览器会静默放弃注册(shortcut 为空),之后也不会自动补上;
 * - chrome.commands.update 需要 Chrome 131+,Edge 未实现;
 *   且只能覆盖"非用户显式设置"的快捷键,无法零交互强制注册。
 * 因此采用"检测 + 引导/一键设置"策略,而非启动时自动注册。
 */
import { ref } from 'vue';

export const SHORTCUT_COMMAND_NAME = 'open-account-switcher';
export const SHORTCUT_SUGGESTED = 'Alt+Shift+A';

type CommandsApi = typeof chrome.commands & {
  update?: (options: { name: string; shortcut: string }) => Promise<void>;
};

/** 浏览器是否支持编程式设置快捷键(Chrome 131+;Edge 暂不支持) */
export function canUpdateShortcut(): boolean {
  return typeof (chrome.commands as CommandsApi).update === 'function';
}

/** 查询命令当前快捷键,空串 = 未注册 */
export async function getCommandShortcut(
  name: string = SHORTCUT_COMMAND_NAME,
): Promise<string> {
  const all = await chrome.commands.getAll();
  return all.find((c) => c.name === name)?.shortcut ?? '';
}

/** 编程式设置快捷键(需在用户手势中调用,如按钮点击) */
export async function setCommandShortcut(
  shortcut: string = SHORTCUT_SUGGESTED,
  name: string = SHORTCUT_COMMAND_NAME,
): Promise<void> {
  const update = (chrome.commands as CommandsApi).update;
  if (!update) throw new Error('当前浏览器不支持编程式设置快捷键');
  await update({ name, shortcut });
}

/** getAll 在 macOS 返回符号形式(如 "⌥⇧A"),转换为可读文本 */
export function formatShortcut(shortcut: string): string {
  return shortcut
    .replace(/⌥/g, 'Alt+')
    .replace(/⇧/g, 'Shift+')
    .replace(/⌃/g, 'Ctrl+')
    .replace(/⌘/g, 'Command+');
}

export function useCommandShortcut(name: string = SHORTCUT_COMMAND_NAME) {
  /** null = 尚未查询;'' = 未注册 */
  const shortcut = ref<string | null>(null);
  const updating = ref(false);
  const updateSupported = canUpdateShortcut();

  async function refresh() {
    try {
      shortcut.value = await getCommandShortcut(name);
    } catch {
      shortcut.value = '';
    }
  }

  /** 一键设置为建议快捷键(用户手势内调用) */
  async function enableSuggested() {
    updating.value = true;
    try {
      await setCommandShortcut(SHORTCUT_SUGGESTED, name);
      await refresh();
    } finally {
      updating.value = false;
    }
  }

  return { shortcut, updating, updateSupported, refresh, enableSuggested };
}
