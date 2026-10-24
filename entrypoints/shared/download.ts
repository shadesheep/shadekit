/**
 * 内容下载为本地文件的辅助函数。
 *
 * buildDownloadName 为纯函数（可单测）；downloadTextAsFile /
 * downloadDataUrlAsFile 封装 Blob / data URL + <a download> 的
 * DOM 副作用，供各工具页复用。
 */

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 生成下载文件名：`{base}[-YYYYMMDD-HHmmss].{ext}`。
 * - base 为空时回退为 'download'
 * - 剔除文件系统非法字符 \ / : * ? " < > |
 * - 传入 now 时追加本地时间戳
 */
export function buildDownloadName(
  base: string,
  ext: string,
  now?: Date,
): string {
  const safeBase = base.replace(/[\\/:*?"<>|]/g, '').trim() || 'download';
  const stamp = now
    ? `-${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
    : '';
  return `${safeBase}${stamp}.${ext}`;
}

/**
 * 将 data URL（如 canvas 导出的图片）触发为浏览器下载。
 */
export function downloadDataUrlAsFile(dataUrl: string, filename: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

/**
 * 将文本内容触发为浏览器下载。
 */
export function downloadTextAsFile(
  text: string,
  filename: string,
  mimeType = 'application/json',
): void {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // 延迟回收：click 后同步 revoke 在 Firefox 下可能中断大文件下载
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
