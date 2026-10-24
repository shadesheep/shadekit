/**
 * content script 侧主题 adapter(ADR-0004 D7):
 * content/ 与 json-page-format.content/ 共用,不再各自直读 devtools-theme。
 * 与 use-theme.ts(extension 页面侧)共用同一存储 key,只管读取/监听/写入,不管 DOM。
 */

import { safeStorageSet } from './safe-storage';

export type ContentThemeMode = 'system' | 'light' | 'dark';

const THEME_KEY = 'devtools-theme';

export function getSystemDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export async function readThemeMode(): Promise<ContentThemeMode> {
  try {
    const r = await chrome.storage.local.get(THEME_KEY);
    const v = r[THEME_KEY] as string;
    if (v === 'light' || v === 'dark' || v === 'system') return v;
    return 'system';
  } catch {
    return 'system';
  }
}

export function resolveDark(mode: ContentThemeMode): boolean {
  return mode === 'dark' || (mode === 'system' && getSystemDark());
}

/**
 * 解析当前明暗并立即回调一次,随后监听 storage 与系统偏好变化持续回调。
 * 返回停止监听函数。
 */
export async function watchDarkMode(
  onChange: (isDark: boolean) => void,
): Promise<() => void> {
  let mode = await readThemeMode();
  onChange(resolveDark(mode));

  const storageListener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== 'local' || !changes[THEME_KEY]) return;
    const v = changes[THEME_KEY].newValue as string;
    mode = v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
    onChange(resolveDark(mode));
  };
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const mediaListener = () => onChange(resolveDark(mode));

  chrome.storage.onChanged.addListener(storageListener);
  media.addEventListener('change', mediaListener);

  return () => {
    chrome.storage.onChanged.removeListener(storageListener);
    media.removeEventListener('change', mediaListener);
  };
}

/** content script 侧写入主题偏好(如页面内 toggle);静默失败仅影响跨页同步 */
export async function writeThemeMode(mode: ContentThemeMode): Promise<void> {
  await safeStorageSet({ [THEME_KEY]: mode }, { notify: false });
}
