/**
 * 复制文本到剪贴板（统一入口）
 *
 * 错误 Toast 的「复制详情」等场景共用：
 * - 优先 navigator.clipboard（需安全上下文 / 用户手势触发）
 * - 失败时回退 execCommand('copy')（权限受限页面）
 * - 无 DOM 的环境（后台 service worker、node 测试）回退不可用，直接返回 false
 *
 * @returns 是否复制成功；调用方据此提示「已复制」或「复制失败」
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (typeof document === 'undefined') return false;
    if (execCommandCopy(text)) return true;
    // clipboard API 与 execCommand 都要求 document 聚焦；
    // 失焦场景（窗口切换、连续点击、通知抢焦点）两者会同时失败，
    // 尝试恢复焦点后重试一次 clipboard API 兜底
    try {
      window.focus();
      document.body?.focus();
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
}

/** execCommand('copy') 回退：必须 focus + 显式选区，否则失焦/移动端场景静默失败 */
function execCommandCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText =
      'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:none;opacity:0;';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
