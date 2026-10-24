// @vitest-environment jsdom
/**
 * diff 标记 module(tools/json-diff/lib/diff-markers.ts)测试。
 *
 * 契约:set 按 side 过滤 + 行号映射(越界跳过)+ 0 条时 no-op;
 * clear 显式清空。用真实 EditorView 验证 Decoration 落到 DOM。
 */
import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import { createCodeEditor, type CodeEditor } from '../entrypoints/shared/lib/codemirror-editor';
import { createDiffMarkers } from '../entrypoints/tools/json-diff/lib/diff-markers';
import type { DiffMarker } from '../entrypoints/tools/json-diff/lib/json-differ';
import { setupCodemirrorJsdom } from './helpers/codemirror-jsdom';

beforeAll(() => {
  setupCodemirrorJsdom();
});

afterEach(() => {
  document.body.innerHTML = '';
});

function _makeEditor(doc: string): CodeEditor {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return createCodeEditor({ parent, doc });
}

function marker(partial: Partial<DiffMarker>): DiffMarker {
  return {
    editor: 'left',
    startLine: 0,
    startCh: 0,
    endLine: 0,
    endCh: 1,
    color: '',
    className: 'diff-mark-left',
    diffIndex: 0,
    ...partial,
  };
}

function markCount(editor: CodeEditor, className: string): number {
  return editor.view.dom.querySelectorAll(`.${className}`).length;
}

describe('createDiffMarkers', () => {
  it('set 按 side 过滤并把标记渲染为 Decoration', () => {
    const diffMarkers = createDiffMarkers();
    const editor = createCodeEditor({
      parent: (() => { const p = document.createElement('div'); document.body.appendChild(p); return p; })(),
      doc: 'ab\ncd',
      extraExtensions: diffMarkers.extension,
    });

    diffMarkers.set(editor, [
      marker({ editor: 'left', startLine: 0, startCh: 0, endLine: 0, endCh: 2 }),
      marker({ editor: 'right', startLine: 1, startCh: 0, endLine: 1, endCh: 2, className: 'diff-mark-right' }),
    ], 'left');

    expect(markCount(editor, 'diff-mark-left')).toBe(1);
    expect(markCount(editor, 'diff-mark-right')).toBe(0);
    editor.destroy();
  });

  it('该侧 0 条标记时 no-op(不清空已有标记)', () => {
    const diffMarkers = createDiffMarkers();
    const editor = createCodeEditor({
      parent: (() => { const p = document.createElement('div'); document.body.appendChild(p); return p; })(),
      doc: 'ab',
      extraExtensions: diffMarkers.extension,
    });
    diffMarkers.set(editor, [marker({})], 'left');
    expect(markCount(editor, 'diff-mark-left')).toBe(1);

    // 只含 right 标记的 set 对 left 侧不动
    diffMarkers.set(editor, [marker({ editor: 'right', className: 'diff-mark-right' })], 'left');
    expect(markCount(editor, 'diff-mark-left')).toBe(1);
    editor.destroy();
  });

  it('clear 显式清空', () => {
    const diffMarkers = createDiffMarkers();
    const editor = createCodeEditor({
      parent: (() => { const p = document.createElement('div'); document.body.appendChild(p); return p; })(),
      doc: 'ab',
      extraExtensions: diffMarkers.extension,
    });
    diffMarkers.set(editor, [marker({})], 'left');
    expect(markCount(editor, 'diff-mark-left')).toBe(1);

    diffMarkers.clear(editor);
    expect(markCount(editor, 'diff-mark-left')).toBe(0);
    editor.destroy();
  });

  it('行号越界的标记静默跳过', () => {
    const diffMarkers = createDiffMarkers();
    const editor = createCodeEditor({
      parent: (() => { const p = document.createElement('div'); document.body.appendChild(p); return p; })(),
      doc: 'ab',
      extraExtensions: diffMarkers.extension,
    });
    diffMarkers.set(editor, [
      marker({ startLine: 99, endLine: 99 }),
      marker({}),
    ], 'left');
    expect(markCount(editor, 'diff-mark-left')).toBe(1);
    editor.destroy();
  });
});
