import { type Extension, Prec } from '@codemirror/state';
import { type KeyBinding, keymap } from '@codemirror/view';

/**
 * 根据平台生成 Mod-Enter 快捷键的展示文案。
 * macOS 使用 ⌘↵，其他平台使用 Ctrl+↵。
 */
export function formatModEnterHint(platform: string): string {
  return platform.toLowerCase().startsWith('mac') ? '⌘↵' : 'Ctrl+↵';
}

/** 读取当前运行平台的 Mod-Enter 提示文案（仅浏览器环境调用）。 */
export function getModEnterHint(): string {
  if (typeof navigator === 'undefined') return 'Ctrl+↵';
  // navigator.platform 已废弃且在隐私模式下可能为空，优先 userAgentData
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || navigator.platform || '';
  return formatModEnterHint(platform);
}

/**
 * 构造 Mod-Enter 按键绑定：触发回调并拦截默认行为，
 * 避免向文档插入换行，不干扰 CodeMirror 其他默认编辑行为。
 */
export function modEnterBinding(run: () => void): KeyBinding {
  return {
    key: 'Mod-Enter',
    preventDefault: true,
    run: () => {
      run();
      return true;
    },
  };
}

/**
 * Mod-Enter 快捷键扩展（高优先级），仅在编辑器聚焦时生效。
 */
export function modEnterKeymap(run: () => void): Extension {
  return Prec.high(keymap.of([modEnterBinding(run)]));
}
