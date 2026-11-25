/**
 * 快捷键兜底（Chrome/Edge 的「装完即用」补偿）。
 *
 * 背景：manifest 的 suggested_key 在 install/update 时由浏览器写入 profile；
 * 若那一刻组合已被其他扩展或浏览器保留键占用，Chromium 直接放弃
 * （CommandService::AddKeybindingPref，allow_overrides = false），而 Chrome/Edge
 * 不提供 chrome.commands.update，扩展自身无法补绑。
 *
 * 因此：命令未绑定时在页面内监听同一组合（默认 Alt+Shift+A / macOS ⌥⇧A），
 * 按下后请求 background 执行与原生 onCommand 完全相同的动作。
 *
 * 正确性约束：
 * - 只认顶层 frame（子 frame 会与顶层重复触发，background 侧也会拒绝）；
 * - 已绑定时不挂监听（否则浏览器原生通道 + 兜底各执行一次，面板双开）；
 * - 每次触发前 background 会再查一次绑定，用户刚在快捷键页设置完、页面尚未
 *   重载时不会重复执行；此时返回 handled=false，本模块立即卸载监听；
 * - 绑定状态在页面重新可见时刷新（改绑/清空后无需刷新页面）。
 */
import { SHORTCUT_SUGGESTED_CODE } from "../shared/command-shortcut";
import { sendBgMessage } from "../shared/messages";

/** Alt+Shift+A（macOS ⌥⇧A）。按 code 判定：⌥⇧A 在 macOS 上 key 是 'Å' */
export function isShortcutFallbackEvent(event: KeyboardEvent): boolean {
  if (event.repeat || event.isComposing) return false;
  if (!event.altKey || !event.shiftKey) return false;
  // Ctrl 同时为 true 覆盖 Windows 的 AltGr（AltGraph）组合
  return (
    !event.ctrlKey && !event.metaKey && event.code === SHORTCUT_SUGGESTED_CODE
  );
}

export async function initShortcutFallback(): Promise<void> {
  if (window.top !== window) return;

  let attached = false;
  let busy = false;

  const detach = () => {
    if (!attached) return;
    attached = false;
    window.removeEventListener("keydown", onKeyDown, true);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!isShortcutFallbackEvent(event)) return;
    // 绑定存在与否都必须同步吞掉默认行为：原生命令不受页面 preventDefault
    // 影响，若这里是过期状态，浏览器仍然会执行命令，用户可见结果正确。
    event.preventDefault();
    if (busy) return;
    busy = true;
    sendBgMessage("TRIGGER_ACCOUNT_SWITCHER")
      .then(({ handled }) => {
        // handled=false：绑定已存在，交给原生通道，卸载兜底避免双开
        if (!handled) detach();
      })
      .catch(() => {
        // 后台不可用（扩展重载中）：卸载，等页面重新可见时再判定
        detach();
      })
      .finally(() => {
        busy = false;
      });
  };

  const sync = async () => {
    try {
      const { shortcut } = await sendBgMessage("GET_ACCOUNT_SWITCHER_SHORTCUT");
      if (shortcut) {
        detach();
      } else if (!attached) {
        attached = true;
        window.addEventListener("keydown", onKeyDown, true);
      }
    } catch {
      // 查询失败保持现状：宁可不触发，也不要和原生通道重复执行
    }
  };

  await sync();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void sync();
  });
}
