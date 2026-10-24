/**
 * image-base64 上传反馈相关的纯逻辑：
 * - 粘贴文本分类（在线图片 URL / 普通文本 / 空）
 * - 在线转换失败的统一错误提示
 *
 * 拖拽高亮深度计数已内化进 shared/lib/codemirror-editor.ts 的 attachFileDrop（ADR-0004 D7）。
 */

export type PastedText =
  | { kind: 'image-url'; url: string }
  | { kind: 'text'; value: string }
  | { kind: 'empty' };

/** 在线图片转换失败时的统一错误提示（网络错误 / 非图片资源 / CORS 限制） */
export const ONLINE_CONVERT_ERROR_MESSAGE =
  '在线图片转换失败：无法加载该地址的图片（可能是网络错误、非图片资源或跨域限制）';

/**
 * 分类粘贴的文本：
 * - 合法 http/https URL → image-url（走在线转换）
 * - 其余非空文本（base64、data URI、无协议字符串等）→ text
 * - 空 / 纯空白 → empty
 *
 * 注意：data: URI 虽然能被 new URL 解析，但不走在线转换，
 * 交由 base64 通路处理，避免 canvas 重绘损失。
 */
export function classifyPastedText(raw: string): PastedText {
  const text = raw.trim();
  if (!text) return { kind: 'empty' };
  try {
    const url = new URL(text);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return { kind: 'image-url', url: text };
    }
  } catch {
    // 非 URL，按普通文本处理
  }
  return { kind: 'text', value: text };
}
