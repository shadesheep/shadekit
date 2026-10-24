import { describe, it, expect, vi } from 'vitest';

/**
 * format-pipeline 测试（ADR-0004 D3）
 * doFormat 的纯数据编排：lint 预检 → 解析 → autoDecode / 嵌套解包 /
 * 排序 → HTML 树 + 缩进文本。lint 统一走 parseJsonError（lintJson 已删）。
 */

import { runFormatPipeline } from '../entrypoints/tools/json-formatter/lib/format-pipeline';

const BASE = {
  indent: 2,
  autoDecode: false,
  nestedEscapeParse: false,
  sortMode: 0,
  jsonLint: true,
};

describe('runFormatPipeline — 基础路径', () => {
  it('合法 JSON：返回 parsed / html / formatted', async () => {
    const result = await runFormatPipeline('{"a":1}', { ...BASE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed).toEqual({ a: 1 });
    expect(result.formatted).toBe('{\n  "a": 1\n}');
    expect(result.html).toContain('item-object');
  });

  it('indent 选项生效', async () => {
    const result = await runFormatPipeline('{"a":1}', { ...BASE, indent: 4 });
    if (!result.ok) throw new Error('expected ok');
    expect(result.formatted).toBe('{\n    "a": 1\n}');
  });
});

describe('runFormatPipeline — lint 预检（统一走 parseJsonError）', () => {
  it('jsonLint 开启且 JSON 非法：stage=lint，message 取自 parseJsonError', async () => {
    const result = await runFormatPipeline('{"a":}', { ...BASE });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe('lint');
    expect(result.message).toBeTruthy();
  });

  it('jsonLint 关闭时非法 JSON 落到 parse 阶段', async () => {
    const result = await runFormatPipeline('{"a":}', { ...BASE, jsonLint: false });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe('parse');
  });
});

describe('runFormatPipeline — 转换链', () => {
  it('nestedEscapeParse：嵌套 JSON 字符串解包', async () => {
    const result = await runFormatPipeline('{"s":"{\\"a\\":1}"}', {
      ...BASE,
      nestedEscapeParse: true,
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.parsed).toEqual({ s: { a: 1 } });
  });

  it('nestedEscapeParse 关闭时保留字符串原样', async () => {
    const result = await runFormatPipeline('{"s":"{\\"a\\":1}"}', { ...BASE });
    if (!result.ok) throw new Error('expected ok');
    expect(result.parsed).toEqual({ s: '{"a":1}' });
  });

  it('sortMode=1 升序排序 key', async () => {
    const result = await runFormatPipeline('{"b":1,"a":2}', { ...BASE, sortMode: 1 });
    if (!result.ok) throw new Error('expected ok');
    expect(Object.keys(result.parsed as object)).toEqual(['a', 'b']);
  });

  it('autoDecode：\\uXXXX 字符串解码', async () => {
    const result = await runFormatPipeline('{"s":"\\\\u5317\\\\u4eac"}', {
      ...BASE,
      autoDecode: true,
    });
    if (!result.ok) throw new Error('expected ok');
    expect((result.parsed as Record<string, string>).s).toBe('北京');
  });
});

describe('runFormatPipeline — 进度回调', () => {
  it('formatLargeJson 的 onProgress 透传', async () => {
    const onProgress = vi.fn();
    await runFormatPipeline('{"a":1}', { ...BASE }, onProgress);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'complete', percent: 100 }),
    );
  });
});
