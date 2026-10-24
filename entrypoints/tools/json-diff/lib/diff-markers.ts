/**
 * Diff 标记 module(json-diff 专属差异扩展,第 5 轮评审收口)。
 *
 * 原先 markEffect / markField / diffTheme 与 dispatch 逻辑散在 json-diff/App.vue,
 * 调用方需懂 CodeMirror 的 StateField / Decoration / dispatch。收口后:
 * - `extension` 传进 createCodeEditor 的 extraExtensions(StateField + 主题一次装配);
 * - `set` 内部按 side 过滤、行号 → Decoration 映射(越界静默跳过)、排序后派发;
 * - `clear` 显式清空。契约:set 遇到该侧 0 条标记时不动(no-op),
 *   清空必须显式调 clear(doCompare 流程依赖此行为)。
 */
import { type Extension, type Range, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';
import type { CodeEditor } from '../../../shared/lib/codemirror-editor';
import type { DiffMarker } from './json-differ';

export interface DiffMarkers {
  /** 传进 createCodeEditor 的 extraExtensions */
  extension: Extension;
  /** 应用某侧差异标记;该侧 0 条时为 no-op(清空请用 clear) */
  set(editor: CodeEditor, markers: DiffMarker[], side: 'left' | 'right'): void;
  /** 清空全部差异标记 */
  clear(editor: CodeEditor): void;
}

export function createDiffMarkers(): DiffMarkers {
  const markEffect = StateEffect.define<DecorationSet>({
    map: (val, change) => val.map(change),
  });

  const markField = StateField.define<DecorationSet>({
    create() {
      return Decoration.none;
    },
    update(value, tr) {
      value = value.map(tr.changes);
      for (const e of tr.effects) {
        if (e.is(markEffect)) {
          value = e.value;
        }
      }
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  const diffTheme = EditorView.theme({
    '.diff-mark-left': { backgroundColor: '#DD444444 !important' },
    '.diff-mark-right': { backgroundColor: '#4ba2ff44 !important' },
    '.diff-mark-replace': { backgroundColor: '#E5E83344 !important' },
    '.diff-mark-left span, .diff-mark-right span, .diff-mark-replace span': {
      backgroundColor: 'inherit !important',
    },
  });

  return {
    extension: [diffTheme, markField],
    set(editor, markers, side) {
      const view = editor.view;
      const relevant = markers.filter((m) => m.editor === side);
      if (relevant.length === 0) return;

      const decorations = relevant
        .map((marker) => {
          try {
            const startLine = view.state.doc.line(marker.startLine + 1);
            const endLine = view.state.doc.line(marker.endLine + 1);
            const from = startLine.from + marker.startCh;
            const to = endLine.from + marker.endCh;
            return Decoration.mark({
              class: marker.className,
            }).range(from, to);
          } catch {
            return null;
          }
        })
        .filter(Boolean) as Range<Decoration>[];

      decorations.sort((a, b) => a.from - b.from);

      if (decorations.length > 0) {
        view.dispatch({
          effects: markEffect.of(Decoration.set(decorations, true)),
        });
      }
    },
    clear(editor) {
      editor.view.dispatch({ effects: markEffect.of(Decoration.none) });
    },
  };
}
