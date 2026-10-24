/**
 * image-base64 转换输出配置相关的纯逻辑：
 * - 配置类型与默认值（Config.vue / App.vue 共用，避免两处定义漂移）
 * - 输出格式 → canvas.toDataURL 的 MIME 与质量参数换算
 * - data URL → 下载文件后缀推导
 */

export type ImageOutputFormat = 'jpeg' | 'png' | 'webp';

export interface ImageBase64Config {
  imageFormat: ImageOutputFormat;
  imageQuality: number;
  allowMultiple: boolean;
}

export const DEFAULT_IMAGE_BASE64_CONFIG: ImageBase64Config = {
  imageFormat: 'jpeg',
  imageQuality: 0.92,
  allowMultiple: true,
};

/** 读到的配置与默认值合并（缺字段自动补全） */
export function normalizeImageBase64Config(
  saved: Partial<ImageBase64Config> | undefined,
): ImageBase64Config {
  return { ...DEFAULT_IMAGE_BASE64_CONFIG, ...saved };
}

/** 输出格式对应的 canvas.toDataURL type 参数 */
export function imageMimeType(format: ImageOutputFormat): string {
  return `image/${format}`;
}

const QUALITY_MIN = 0.1;
const QUALITY_MAX = 1;

/**
 * 换算 canvas.toDataURL 的 quality 参数：
 * - png 为无损格式，toDataURL 会忽略 quality，显式返回 undefined 不传
 * - jpeg / webp 下收敛到 [0.1, 1]；非法值（NaN/Infinity）回退默认质量
 */
export function effectiveQuality(
  format: ImageOutputFormat,
  quality: number,
): number | undefined {
  if (format === 'png') return undefined;
  if (!Number.isFinite(quality)) return DEFAULT_IMAGE_BASE64_CONFIG.imageQuality;
  return Math.min(QUALITY_MAX, Math.max(QUALITY_MIN, quality));
}

/** MIME 子类型 → 下载文件后缀（jpeg/jpg 统一归一为 jpg） */
const EXTENSION_BY_SUBTYPE: Record<string, string> = {
  jpeg: 'jpg',
  jpg: 'jpg',
  png: 'png',
  webp: 'webp',
  gif: 'gif',
  bmp: 'bmp',
  'svg+xml': 'svg',
  'x-icon': 'ico',
  'vnd.microsoft.icon': 'ico',
};

/**
 * 从 data URL（如 data:image/jpeg;base64,...）推导下载文件后缀。
 * 非图片 data URL / 未知子类型 / 非 data URL 一律回退 png。
 */
export function dataUrlExtension(dataUrl: string): string {
  const subtype = /^data:image\/([a-z0-9+.-]+);/i
    .exec(dataUrl)?.[1]
    ?.toLowerCase();
  return (subtype && EXTENSION_BY_SUBTYPE[subtype]) || 'png';
}
