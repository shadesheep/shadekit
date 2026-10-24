// @vitest-environment jsdom
/**
 * 错误 Decoration 扩展工厂测试（ADR-0004 D3）
 * shared/lib/codemirror-error-decoration.ts — CodeMirror 错误下划线收口，
 * json-format 使用，json-diff 后续可复用。
 */
import { EditorState } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createErrorDecoration } from '../entrypoints/shared/lib/codemirror-error-decoration';
import { setupCodemirrorJsdom } from './helpers/codemirror-jsdom';

beforeAll(() => {
  setupCodemirrorJsdom();
});

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.innerHTML = '';
});

function makeView(doc: string, extension: unknown): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  view = new EditorView({
    state: EditorState.create({ doc, extensions: extension as never }),
    parent,
  });
  return view;
}

describe('createErrorDecoration', () => {
  it('mark 在目标位置所在行产生错误下划线 decoration', () => {
    const marker = createErrorDecoration();
    const v = makeView('{"a":1}\n{"b":}', marker.extension);
    // 第二行第一个字符
    const pos = 8;
    marker.mark(v, pos, '第 2 行，第 1 列：Unexpected token');
    const deco = v.state.field(marker.field);
    expect(deco).not.toBe(Decoration.none);
    // hover title 透传
    const iter = deco.iter();
    expect(iter.value).toBeTruthy();
    expect(iter.value?.spec.attributes.title).toContain('Unexpected token');
  });

  it('mark 范围覆盖行首到 pos+10（不越过行尾）', () => {
    const marker = createErrorDecoration();
    // '{"a":1}' 7 字符 + '\n' → 第二行行首为 8，行尾为 15
    const v = makeView('{"a":1}\n{"b":2}', marker.extension);
    marker.mark(v, 8, 'err');
    const iter = v.state.field(marker.field).iter();
    expect(iter.from).toBe(8); // 第二行行首
    expect(iter.to).toBeLessThanOrEqual(15); // 行尾
  });

  it('clear 清除所有 decoration', () => {
    const marker = createErrorDecoration();
    const v = makeView('{"a":}', marker.extension);
    marker.mark(v, 4, 'err');
    marker.clear(v);
    expect(v.state.field(marker.field)).toBe(Decoration.none);
  });

  it('文档变更后 decoration 随 changes 映射（不残留错位）', () => {
    const marker = createErrorDecoration();
    const v = makeView('{"a":1}\n{"b":}', marker.extension);
    marker.mark(v, 8, 'err');
    v.dispatch({ changes: { from: 0, insert: '  ' } });
    const iter = v.state.field(marker.field).iter();
    expect(iter.from).toBe(10); // 原行首 8 + 插入 2
  });

  it('自定义 className', () => {
    const marker = createErrorDecoration({ className: 'my-error' });
    const v = makeView('{"a":}', marker.extension);
    marker.mark(v, 2, 'err');
    const iter = v.state.field(marker.field).iter();
    expect(iter.value?.spec.class).toBe('my-error');
  });
});
