/**
 * 命令快捷键：常量、状态查询、展示格式化、能力探测（无 Vue 依赖）。
 *
 * 与 `use-command-shortcut.ts` 分开的原因：background service worker 也要查
 * 绑定状态（快捷键兜底逻辑），不能把 Vue 打进 SW 包。
 *
 * 事实基准（Chromium `chrome/browser/extensions/commands/command_service.cc`）：
 * - suggested_key 在 install **和 update** 时都会尝试写入（CommandService::
 *   OnExtensionWillBeInstalled → UpdateKeybindings → AssignKeybindings），
 *   只有用户改过绑定才跳过；
 * - 写入时组合已被占用（其他扩展 / 浏览器保留键）则静默放弃：
 *   AddKeybindingPref(..., allow_overrides = false) 直接返回 false。
 * - Chrome/Edge **没有** chrome.commands.update：Chromium 的 commands.json 只有
 *   getAll + onCommand。`commands.reset` / `update` / `openShortcutSettings`
 *   仅 Firefox 提供。
 *
 * 因此 Chrome/Edge 只能靠页面内兜底（content/shortcut-fallback.ts），
 * Firefox 可以编程式恢复（restoreShortcut）。
 */

export const SHORTCUT_COMMAND_NAME = "open-account-switcher";
/** manifest 语法；macOS 上 Alt 即 Option，实际按键为 ⌥⇧A */
export const SHORTCUT_SUGGESTED = "Alt+Shift+A";
/** 建议键的物理键位：macOS 上 ⌥⇧A 的 `key` 是 'Å'，只有 `code` 稳定 */
export const SHORTCUT_SUGGESTED_CODE = "KeyA";

type CommandsApi = typeof chrome.commands & {
  reset?: (name: string) => Promise<void>;
};

/** 查询命令当前快捷键，空串 = 未注册（安装时被占用或用户清空） */
export async function getCommandShortcut(
  name: string = SHORTCUT_COMMAND_NAME,
): Promise<string> {
  const all = await chrome.commands.getAll();
  return all.find((c) => c.name === name)?.shortcut ?? "";
}

/** 浏览器是否支持编程式恢复默认快捷键（Firefox 的 commands.reset） */
export function canRestoreShortcut(): boolean {
  return typeof (chrome.commands as CommandsApi).reset === "function";
}

/** 恢复为 manifest 声明的建议键（Firefox 专有；Chrome/Edge 会抛错） */
export async function restoreShortcut(
  name: string = SHORTCUT_COMMAND_NAME,
): Promise<void> {
  const reset = (chrome.commands as CommandsApi).reset;
  if (!reset) {
    throw new Error("当前浏览器不支持编程式设置快捷键，请手动设置");
  }
  await reset.call(chrome.commands, name);
}

const MAC_SYMBOLS: Record<string, string> = {
  Command: "⌘",
  Cmd: "⌘",
  Ctrl: "⌃",
  Control: "⌃",
  MacCtrl: "⌃",
  Alt: "⌥",
  Option: "⌥",
  Shift: "⇧",
};

const TOKEN_NAMES: Record<string, string> = {
  "⌘": "Command",
  "⌃": "Ctrl",
  "⌥": "Alt",
  "⇧": "Shift",
};

/**
 * 快捷键展示文案：macOS 用符号（⌥⇧A），其他平台用文本（Alt+Shift+A）。
 * 入参可以是 getAll() 的返回值（已按平台格式化），也可以是 manifest 语法常量。
 */
export function formatShortcut(shortcut: string): string {
  if (!shortcut) return "";
  if (/Mac|iPhone|iPad/.test(navigator.userAgent)) {
    return shortcut
      .split("+")
      .map((token) => MAC_SYMBOLS[token] ?? token)
      .join("");
  }
  return shortcut.replace(/[⌘⌃⌥⇧]/g, (symbol) => `${TOKEN_NAMES[symbol]}+`);
}

/** 快捷键设置页地址；chrome:// 与 edge:// 不允许编程式打开，只能让用户粘贴访问 */
export function getShortcutSettingsPageUrl(): string {
  const ua = navigator.userAgent;
  if (ua.includes("Edg/")) return "edge://extensions/shortcuts";
  if (ua.includes("Firefox/")) return "about:addons";
  return "chrome://extensions/shortcuts";
}
