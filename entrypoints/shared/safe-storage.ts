/**
 * 安全存储写入封装— 所有 chrome.storage.local 写入的统一入口
 *
 * 解决的问题：
 * chrome.storage.local 有配额上限（QUOTA_BYTES，通常 10MB），写满后
 * storage.set 会 reject。裸调用若不 catch，写入静默丢失而 UI 仍可能
 * 展示「保存成功」假反馈；散落各处的 try/catch 又口径不一。
 *
 * 本模块提供唯一写入入口：
 * - 捕获配额超限（QuotaExceededError / QUOTA_BYTES）与其他写入异常
 * - 失败时向用户弹出明确提示（默认），静默场景可 notify: false
 * - 返回可判断的结果，调用方据此决定是否展示「保存成功」
 *
 * 注意：notify 依赖 use-toast 的模块级状态，仅在挂载了 ToastContainer 的
 * 页面（options/popup/工具页）可见；后台 service worker 中 toast 静默无效，
 * 后台调用方应根据返回结果向消息调用方传播错误。
 */

import { copyToClipboard } from './clipboard';
import { showToast } from './use-toast';

/** 写入结果 */
export interface SafeStorageSetResult {
  /** 是否写入成功 */
  ok: boolean;
  /** 失败原因是否为存储配额超限 */
  quotaExceeded: boolean;
  /** 原始错误信息（失败时存在，用于日志/错误传播） */
  error?: string;
}

/** 写入选项 */
export interface SafeStorageSetOptions {
  /**
   * 失败时是否向用户弹出提示（默认 true）。
   * 后台批处理、启动迁移、日志自写等场景传 false，避免干扰或递归。
   */
  notify?: boolean;
  /** 自定义失败提示文案（优先于按错误类型生成的默认文案） */
  message?: string;
}

/** 配额超限的默认用户提示 */
const QUOTA_EXCEEDED_MESSAGE =
  '存储空间已满，数据未能保存。请清理日志或卸载不用的扩展后重试。';

/**
 * 失败 Toast 停留时长（ms）。
 * 携带「复制详情」按钮，需给用户留足点击时间（与登录失败 Toast 口径一致）。
 */
const ERROR_TOAST_DURATION = 8000;

/**
 * 生成失败 Toast「复制详情」的复制文本：
 * 错误信息 + 存储键 + 配额判定 + 时间。
 * 只含诊断元信息，不写入配置内容本身（避免泄露账号等敏感数据）。
 */
function buildStorageErrorDetail(
  items: Record<string, unknown>,
  quotaExceeded: boolean,
  error: string,
  now: Date = new Date(),
): string {
  return [
    '操作: 扩展数据写入',
    `错误信息: ${error}`,
    `存储键: ${Object.keys(items).join(', ')}`,
    `配额超限: ${quotaExceeded ? '是' : '否'}`,
    `时间: ${now.toLocaleString()}`,
  ].join('\n');
}

/**
 * 由写入结果生成统一的用户可读失败文案
 *
 * 所有需要把失败原因抛给上层（throw / 消息响应 / toast）的模块共用此函数，
 * 避免各处文案口径漂移。
 *
 * @param result  safeStorageSet 的返回值（仅 ok=false 时有意义）
 * @param subject 被写入对象的名词（如「扩展数据」「设置」），嵌入文案
 */
export function storageWriteFailureMessage(
  result: SafeStorageSetResult,
  subject: string,
): string {
  return result.quotaExceeded
    ? `存储空间已满，${subject}未能保存。请清理日志或卸载不用的扩展后重试。`
    : `${subject}写入失败: ${result.error ?? '未知错误'}`;
}

/**
 * 判断错误是否为存储配额超限
 *
 * chrome 的配额错误没有统一类型，可能出现为：
 * - Error("QUOTA_BYTES quota exceeded") / QUOTA_BYTES_PER_ITEM
 * - DOMException name = QuotaExceededError
 * - 各类包含 "quota" 字样的 message
 */
export function isQuotaExceededError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'QuotaExceededError') {
    return true;
  }
  if (!(err instanceof Error)) return false;
  return /quota/i.test(err.message);
}

/**
 * 安全写入 chrome.storage.local
 *
 * @param items 要写入的 key-value
 * @param opts  notify/message，见 SafeStorageSetOptions
 * @returns 可判断的写入结果；调用方应在 ok=false 时避免展示「保存成功」
 */
export async function safeStorageSet(
  items: Record<string, unknown>,
  opts: SafeStorageSetOptions = {},
): Promise<SafeStorageSetResult> {
  const { notify = true, message } = opts;
  try {
    await chrome.storage.local.set(items);
    return { ok: true, quotaExceeded: false };
  } catch (err: unknown) {
    const quotaExceeded = isQuotaExceededError(err);
    const error = err instanceof Error ? err.message : String(err);

    console.warn('[devtools] storage 写入失败:', error);

    if (notify) {
      const detail = buildStorageErrorDetail(items, quotaExceeded, error);
      // 错误 Toast 附「复制详情」：一键复制诊断信息，便于反馈排查
      showToast(message ?? (quotaExceeded ? QUOTA_EXCEEDED_MESSAGE : `保存失败: ${error}`), 'error', ERROR_TOAST_DURATION, {
        label: '复制详情',
        onClick: () => {
          void copyToClipboard(detail).then((copied) => {
            showToast(
              copied ? '错误详情已复制' : '复制失败，请查看控制台日志',
              copied ? 'success' : 'info',
            );
          });
        },
      });
    }

    return { ok: false, quotaExceeded, error };
  }
}
