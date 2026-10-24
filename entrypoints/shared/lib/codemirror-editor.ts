/**
 * 共享 CodeMirror 装配工厂（ADR-0003 D3,第 5 轮评审加深）。
 *
 * json-format / json-diff / code-beautify 三个标签页工具的编辑器装配收口：
 * - `createCodeEditor` 负责基础扩展（basicSetup + 折行）、主题同步
 *   （theme-changed / storage 监听 + Compartment reconfigure + destroy 清理）、
 *   Mod-Enter 绑定与文本读写。
 * - 语言恒走内部 Compartment:`language` 为初始槽位,`setLanguage` 运行时切换。
 * - `scrollToLine` 收口「光标置行首 + scrollIntoView」;`readonly` 收口只读装配。
 * - 工具差异扩展(如 json-diff 的 diff-markers)经 `extraExtensions` 参数传入。
 * - `view` 为逃生舱:仅在接口未覆盖的罕见场景派发自定义 StateEffect。
 *
 * 主题用 Compartment 局部 reconfigure（而不是 `StateEffect.reconfigure`
 * 整个替换），避免重建 EditorState / 冲掉 language、basicSetup 等扩展。
 *
 * 拖拽载入为独立 helper `attachFileDrop`，与编辑器解耦（拖拽目标常非编辑器
 * 本身，通常是整个面板）；文本由调用方在 onText 中经 setText 进编辑器。
 * 双编辑器滚动同步为独立 helper `syncScroll`(见 codemirror-scroll-sync.ts)。
 */
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { getCodemirrorTheme } from '../codemirror-theme';
import { modEnterKeymap } from '../format-shortcut';

export interface CodeEditorOptions {
  /** 编辑器挂载的父元素 */
  parent: HTMLElement;
  /** 初始文档内容 */
  doc?: string;
  /** 初始语言扩展（如 json()）；运行时可经 setLanguage 切换 */
  language?: Extension;
  /** 只读装配：EditorState.readOnly + EditorView.editable(false) */
  readonly?: boolean;
  /** 工具差异扩展：StateField、自定义 theme、额外 keymap 等 */
  extraExtensions?: Extension;
  /** 文档变更回调（防抖等由调用方负责） */
  onChange?: (text: string) => void;
  /** Mod-Enter 快捷键回调（仅编辑器聚焦时生效） */
  onModEnter?: () => void;
}

export interface CodeEditor {
  /** 逃生舱：接口未覆盖的罕见场景(派发自定义 StateEffect / 读 scrollDOM)才用 */
  view: EditorView;
  getText(): string;
  setText(text: string): void;
  /** 运行时切换语言扩展(Compartment reconfigure,不影响其他扩展) */
  setLanguage(language: Extension): void;
  /** 滚动到指定行(0-based):光标置行首 + scrollIntoView;越界静默忽略 */
  scrollToLine(line: number): void;
  focus(): void;
  /** 销毁视图并摘除主题监听 */
  destroy(): void;
}

export function createCodeEditor(options: CodeEditorOptions): CodeEditor {
  const themeCompartment = new Compartment();
  const languageCompartment = new Compartment();

  const extensions: Extension[] = [
    basicSetup,
    EditorView.lineWrapping,
    themeCompartment.of(getCodemirrorTheme()),
    languageCompartment.of(options.language ?? []),
  ];
  if (options.readonly) {
    extensions.push(EditorState.readOnly.of(true), EditorView.editable.of(false));
  }
  if (options.onModEnter) extensions.push(modEnterKeymap(options.onModEnter));
  if (options.onChange) {
    extensions.push(
      EditorView.updateListener.of((update) => {
        if (update.docChanged) options.onChange?.(update.state.doc.toString());
      }),
    );
  }
  if (options.extraExtensions) extensions.push(options.extraExtensions);

  const view = new EditorView({
    doc: options.doc ?? '',
    extensions,
    parent: options.parent,
  });

  const onThemeChanged = () => {
    view.dispatch({
      effects: themeCompartment.reconfigure(getCodemirrorTheme()),
    });
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key === 'devtools-theme') onThemeChanged();
  };
  window.addEventListener('theme-changed', onThemeChanged);
  window.addEventListener('storage', onStorage);

  return {
    view,
    getText: () => view.state.doc.toString(),
    setText(text: string) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      });
    },
    setLanguage(language: Extension) {
      view.dispatch({ effects: languageCompartment.reconfigure(language) });
    },
    scrollToLine(line: number) {
      try {
        const docLine = view.state.doc.line(line + 1);
        view.dispatch({
          selection: { anchor: docLine.from },
          scrollIntoView: true,
        });
      } catch {
        // 行号越界时忽略
      }
    },
    focus: () => view.focus(),
    destroy() {
      window.removeEventListener('theme-changed', onThemeChanged);
      window.removeEventListener('storage', onStorage);
      view.destroy();
    },
  };
}

// ─── 拖拽文件载入 ─────────────────────────────────────────

export interface FileDropOptions {
  /**
   * 文件校验：返回 null 表示接受，否则返回错误提示文案并终止读取。
   * 缺省时接受所有文件。
   */
  accept?: (file: File) => string | null;
  /** 文件读取成功回调，文本由调用方（经 editor.setText）进编辑器 */
  onText?: (text: string, file: File) => void;
  /**
   * 非文本场景（图片等二进制）：直接接管 File，跳过 FileReader 文本读取。
   * 与 onText 二选一；同时提供时 onFile 优先。
   */
  onFile?: (file: File) => void;
  /** 校验失败 / 读取失败回调 */
  onError?: (message: string) => void;
  /**
   * 拖入内容不含文件（如文本/链接拖拽）时的错误提示；缺省则静默忽略。
   * （如 json-diff：非文件拖入也提示「请拖入 .json 文件」）
   */
  noFileError?: string;
  /** 拖拽悬停态变化（用于拖拽遮罩显隐） */
  onDraggingChange?: (dragging: boolean) => void;
  /** 仅文件拖拽才进入悬停态（忽略文本/链接拖拽） */
  filesOnlyHint?: boolean;
}

/**
 * 在元素上挂载文件拖拽载入，返回解绑函数。
 * 拖拽目标通常是整个面板而非编辑器本身，故与编辑器解耦。
 * 悬停态内部用深度计数（子元素间 dragenter/dragleave 成对抖动），调用方直接信任 onDraggingChange。
 */
export function attachFileDrop(
  el: HTMLElement,
  options: FileDropOptions,
): () => void {
  const isFileDrag = (e: DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes('Files');

  let dragDepth = 0;

  const onDragEnter = (e: DragEvent) => {
    e.preventDefault();
    // 仅文件拖拽显示视觉反馈，忽略文本/链接拖拽
    if (options.filesOnlyHint && !isFileDrag(e)) return;
    dragDepth += 1;
    if (dragDepth === 1) options.onDraggingChange?.(true);
  };
  const onDragLeave = (e: DragEvent) => {
    e.preventDefault();
    // 与 onDragEnter 对称：只给计过数的拖拽出栈，避免配对错乱
    if (options.filesOnlyHint && !isFileDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) options.onDraggingChange?.(false);
  };
  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    dragDepth = 0;
    options.onDraggingChange?.(false);

    const file = e.dataTransfer?.files[0];
    if (!file) {
      if (options.noFileError) options.onError?.(options.noFileError);
      return;
    }

    const rejectReason = options.accept?.(file) ?? null;
    if (rejectReason) {
      options.onError?.(rejectReason);
      return;
    }

    if (options.onFile) {
      options.onFile(file);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => options.onText?.((reader.result as string) ?? '', file);
    reader.onerror = () => options.onError?.('文件读取失败');
    reader.readAsText(file);
  };

  el.addEventListener('dragenter', onDragEnter);
  el.addEventListener('dragleave', onDragLeave);
  el.addEventListener('dragover', onDragOver);
  el.addEventListener('drop', onDrop);

  return () => {
    el.removeEventListener('dragenter', onDragEnter);
    el.removeEventListener('dragleave', onDragLeave);
    el.removeEventListener('dragover', onDragOver);
    el.removeEventListener('drop', onDrop);
  };
}
