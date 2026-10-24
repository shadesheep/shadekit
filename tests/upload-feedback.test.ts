import { describe, expect, it } from 'vitest';
import { classifyPastedText } from '../entrypoints/tools/image-base64/lib/upload-feedback';

describe('classifyPastedText', () => {
  it('http/https 地址识别为在线图片 URL', () => {
    expect(classifyPastedText('https://example.com/a.png')).toEqual({
      kind: 'image-url',
      url: 'https://example.com/a.png',
    });
    expect(classifyPastedText('http://example.com/a.png')).toEqual({
      kind: 'image-url',
      url: 'http://example.com/a.png',
    });
  });

  it('首尾空白先 trim 再判断', () => {
    expect(classifyPastedText('  https://example.com/a.png \n')).toEqual({
      kind: 'image-url',
      url: 'https://example.com/a.png',
    });
  });

  it('空文本与纯空白为 empty', () => {
    expect(classifyPastedText('')).toEqual({ kind: 'empty' });
    expect(classifyPastedText('   \n\t ')).toEqual({ kind: 'empty' });
  });

  it('data URI 不当作在线 URL（避免走 canvas 重绘）', () => {
    const result = classifyPastedText('data:image/png;base64,iVBORw0KGgo=');
    expect(result.kind).toBe('text');
  });

  it('非 http 协议（ftp 等）按普通文本处理', () => {
    const result = classifyPastedText('ftp://example.com/a.png');
    expect(result.kind).toBe('text');
  });

  it('无协议字符串按普通文本（base64 等）处理', () => {
    expect(classifyPastedText('iVBORw0KGgoAAAANSUhEUg')).toEqual({
      kind: 'text',
      value: 'iVBORw0KGgoAAAANSUhEUg',
    });
    expect(classifyPastedText('example.com/a.png').kind).toBe('text');
  });
});
