/**
 * CodeMirror 错误 Decoration 扩展工厂（ADR-0004 D3）
 *
 * 收口「语法错误行下划线」：StateEffect + StateField + mark/clear。
 * json-format 的 JSON 错误下划线使用；json-diff 后续可复用。
 * Editor Factory（codemirror-editor.ts）的邻居，通过 extraExtensions 挂载。
 */

import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';

export interface ErrorDecorationOptions {
  /** 下划线 CSS 类名，默认 json-error-underline */
  className?: string;
  /** 从错误位置起覆盖的字符数（不越过行尾），默认 10 */
  span?: number;
}

export interface ErrorDecorationHandle {
  /** 挂到编辑器 extensions（createCodeEditor 的 extraExtensions） */
  extension: Extension;
  /** 底层 StateField（测试与高级场景用） */
  field: StateField<DecorationSet>;
  /** 在 pos 所在行标记错误下划线，title 为 hover 提示 */
  mark(view: EditorView, pos: number, title: string): void;
  /** 清除错误标记 */
  clear(view: EditorView): void;
}

export function createErrorDecoration(
  options: ErrorDecorationOptions = {},
): ErrorDecorationHandle {
  const className = options.className ?? 'json-error-underline';
  const span = options.span ?? 10;

  const setEffect = StateEffect.define<DecorationSet>();
  const field = StateField.define<DecorationSet>({
    create() {
      return Decoration.none;
    },
    update(value, tr) {
      value = value.map(tr.changes);
      for (const e of tr.effects) {
        if (e.is(setEffect)) value = e.value;
      }
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  return {
    extension: field,
    field,
    mark(view, pos, title) {
      const line = view.state.doc.lineAt(pos);
      const deco = Decoration.mark({
        class: className,
        attributes: { title },
      }).range(line.from, Math.min(line.to, pos + span));
      view.dispatch({ effects: setEffect.of(Decoration.set([deco])) });
    },
    clear(view) {
      view.dispatch({ effects: setEffect.of(Decoration.none) });
    },
  };
}
