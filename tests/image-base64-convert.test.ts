import { describe, expect, it } from 'vitest';
import {
  dataUrlExtension,
  DEFAULT_IMAGE_BASE64_CONFIG,
  effectiveQuality,
  imageMimeType,
} from '../entrypoints/tools/image-base64/lib/convert-settings';

describe('imageMimeType', () => {
  it('按格式拼接 MIME 类型', () => {
    expect(imageMimeType('jpeg')).toBe('image/jpeg');
    expect(imageMimeType('png')).toBe('image/png');
    expect(imageMimeType('webp')).toBe('image/webp');
  });
});

describe('effectiveQuality', () => {
  it('jpeg / webp 透传质量', () => {
    expect(effectiveQuality('jpeg', 0.92)).toBe(0.92);
    expect(effectiveQuality('webp', 0.5)).toBe(0.5);
  });

  it('png 为无损格式，忽略质量参数', () => {
    expect(effectiveQuality('png', 0.92)).toBeUndefined();
  });

  it('质量超出范围时收敛到 [0.1, 1]', () => {
    expect(effectiveQuality('jpeg', 0)).toBe(0.1);
    expect(effectiveQuality('jpeg', -1)).toBe(0.1);
    expect(effectiveQuality('webp', 2)).toBe(1);
  });

  it('非法质量值回退默认质量', () => {
    expect(effectiveQuality('jpeg', Number.NaN)).toBe(
      DEFAULT_IMAGE_BASE64_CONFIG.imageQuality,
    );
    expect(effectiveQuality('jpeg', Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_IMAGE_BASE64_CONFIG.imageQuality,
    );
  });
});

describe('dataUrlExtension', () => {
  it('从 data URL 的 MIME 推导常见图片后缀', () => {
    expect(dataUrlExtension('data:image/png;base64,iVBOR')).toBe('png');
    expect(dataUrlExtension('data:image/webp;base64,UklGR')).toBe('webp');
    expect(dataUrlExtension('data:image/gif;base64,R0lGO')).toBe('gif');
    expect(dataUrlExtension('data:image/bmp;base64,Qk0=')).toBe('bmp');
    expect(dataUrlExtension('data:image/svg+xml;base64,PHN2Zz4=')).toBe('svg');
    expect(dataUrlExtension('data:image/x-icon;base64,AAAB')).toBe('ico');
  });

  it('jpeg / jpg 统一归一为 jpg', () => {
    expect(dataUrlExtension('data:image/jpeg;base64,/9j/4')).toBe('jpg');
    expect(dataUrlExtension('data:image/jpg;base64,/9j/4')).toBe('jpg');
  });

  it('MIME 大小写不敏感', () => {
    expect(dataUrlExtension('data:image/PNG;base64,iVBOR')).toBe('png');
    expect(dataUrlExtension('data:image/JPEG;base64,/9j/4')).toBe('jpg');
  });

  it('非 data URL 或未知类型回退 png', () => {
    expect(dataUrlExtension('')).toBe('png');
    expect(dataUrlExtension('hello world')).toBe('png');
    expect(dataUrlExtension('data:text/plain;base64,aGVsbG8=')).toBe('png');
    expect(dataUrlExtension('data:image/tiff;base64,SUkq')).toBe('png');
  });
});

describe('DEFAULT_IMAGE_BASE64_CONFIG', () => {
  it('默认 jpeg + 0.92 + 允许多开', () => {
    expect(DEFAULT_IMAGE_BASE64_CONFIG).toEqual({
      imageFormat: 'jpeg',
      imageQuality: 0.92,
      allowMultiple: true,
    });
  });
});
