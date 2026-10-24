import { Prec, type Extension } from '@codemirror/state';
import {
  codeFolding,
  HighlightStyle,
  syntaxHighlighting,
} from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

/**
 * 检测当前是否为暗色模式
 */
function isDarkMode(): boolean {
  return typeof document !== 'undefined' && document.documentElement.hasAttribute('data-dt-dark');
}

/**
 * 统一的 CodeMirror 主题（亮色/暗色自适应）
 * 用于 standalone 标签页和 Popup 页面。
 *
 * 用法：
 *   extensions: [ getCodemirrorTheme() ]
 *
 * 暗色模式通过检测 [data-dt-dark] 属性自动切换。
 */
export function getCodemirrorTheme(): Extension[] {
  const dark = isDarkMode();

  const baseTheme = EditorView.theme(
    {
      '&': {
        fontSize: '13px'
        // Note: CodeMirror 6 implements virtual scrolling by default
      },
      '.cm-scroller': {
        overflow: 'auto',
        // 与 design-tokens.css --font-mono 保持一致
        fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
      },
      '.cm-editor': {
        height: '100%',
        backgroundColor: dark ? '#0d1117' : '#fff',
      },
      '.cm-content': { color: dark ? '#c9d1d9' : '#24292e' },
      '.cm-gutters': {
        backgroundColor: dark ? '#161b22' : '#f6f8fa',
        color: dark ? '#484f58' : '#6e7781',
        borderRight: dark ? '1px solid #30363d' : '1px solid #d0d7de',
      },
      '.cm-activeLineGutter': {
        backgroundColor: dark ? '#21262d' : '#e1e4e8',
        color: dark ? '#c9d1d9' : '#24292e',
      },
      '.cm-line': { padding: '0 2px' },
      '.cm-activeLine': {
        backgroundColor: dark ? 'rgba(255,255,255,0.03)' : '#f0f3f6',
      },
      '.cm-cursor': { borderLeftColor: dark ? '#c9d1d9' : '#24292e' },
      '.cm-selectionBackground': {
        backgroundColor: dark ? 'rgba(56,139,253,0.55)' : 'rgba(9,105,218,0.45)',
      },
      '&.cm-focused .cm-selectionBackground': {
        backgroundColor: dark ? 'rgba(56,139,253,0.7)' : 'rgba(9,105,218,0.6)',
      },
      '.cm-selectionMatch': {
        backgroundColor: dark
          ? 'rgba(134,112,204,0.15)'
          : 'rgba(234,179,8,0.2)',
      },
      '.cm-matchingBracket': {
        backgroundColor: dark
          ? 'rgba(56,139,253,0.2)'
          : 'rgba(106,166,255,0.2)',
      },
      '.cm-panels': {
        backgroundColor: dark ? '#161b22' : '#f6f8fa',
        color: dark ? '#c9d1d9' : '#24292e',
        borderTop: dark ? '1px solid #30363d' : '1px solid #d0d7de',
      },
      // 折叠占位符：纯文本加粗 "..."，与 JSON 树形视图的 .ellipsis 保持一致
      // （默认是 "…" 字符 + #eee 灰底胶囊，观感不协调）
      '.cm-foldPlaceholder': {
        backgroundColor: 'transparent',
        border: 'none',
        color: dark ? '#484f58' : '#888',
        fontSize: '12px',
        fontWeight: 'bold',
        margin: '0 4px',
        padding: '0',
        cursor: 'pointer',
      },
    },
    { dark },
  );

  // 暗色模式语法高亮（GitHub Dark 风格）
  const darkSyntaxHighlight = dark
    ? syntaxHighlighting(
        HighlightStyle.define([
          { tag: tags.bool, color: '#f0883e' },
          { tag: tags.null, color: '#f0883e' },
          { tag: tags.string, color: '#a5d6ff' },
          { tag: tags.number, color: '#79c0ff' },
          { tag: tags.propertyName, color: '#7ee787' },
          {
            tag: [tags.punctuation, tags.bracket, tags.operator],
            color: '#8b949e',
          },
        ]),
      )
    : [];

  // 折叠占位符文本：与树形视图一致使用 "..."（basicSetup 的默认 "…" 优先级更高，需覆盖）
  const foldPlaceholderText = Prec.highest(
    codeFolding({ placeholderText: '...' }),
  );

  // 返回数组，包含基础主题、折叠占位符文本和语法高亮
  return [baseTheme, foldPlaceholderText, darkSyntaxHighlight];
}
