import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

/**
 * GitHub Dark 风格的 CodeMirror 主题，与项目暗色模式保持一致
 */
export const darkEditorTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: '#0d1117',
      color: '#c9d1d9',
    },
    '&.cm-focused': {
      outline: 'none',
    },
    '.cm-content': {
      caretColor: '#58a6ff',
    },
    '.cm-cursor': {
      borderLeftColor: '#58a6ff',
    },
    '.cm-activeLine': {
      backgroundColor: '#161b22',
    },
    '.cm-activeLineGutter': {
      backgroundColor: '#161b22',
    },
    '.cm-selectionBackground': {
      backgroundColor: 'rgba(136,148,168,0.25)',
    },
    '&.cm-focused .cm-selectionBackground': {
      backgroundColor: 'rgba(136,148,168,0.35)',
    },
    '.cm-gutters': {
      backgroundColor: '#0d1117',
      color: '#484f58',
      borderRight: '1px solid #21262d',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      color: '#484f58',
    },
    '.cm-scroller': {
      // 与 design-tokens.css --font-mono 保持一致
      fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
      lineHeight: '1.5',
    },
    '.cm-panels': {
      backgroundColor: '#0d1117',
      color: '#c9d1d9',
    },
    '.cm-panels.cm-panels-top': {
      borderBottom: '1px solid #21262d',
    },
    '.cm-panels.cm-panels-bottom': {
      borderTop: '1px solid #21262d',
    },
    '.cm-search': {
      backgroundColor: '#161b22',
      borderColor: '#30363d',
    },
    '.cm-search label': {
      color: '#8b949e',
    },
    '.cm-search input': {
      backgroundColor: '#0d1117',
      borderColor: '#30363d',
      color: '#c9d1d9',
    },
    '.cm-search button': {
      backgroundColor: '#21262d',
      borderColor: '#30363d',
      color: '#c9d1d9',
    },
    '.cm-search button:hover': {
      backgroundColor: '#30363d',
    },
    '.cm-search .cm-button': {
      backgroundColor: '#21262d',
      borderColor: '#30363d',
      color: '#c9d1d9',
    },
    '.cm-tooltip': {
      backgroundColor: '#161b22',
      borderColor: '#30363d',
      color: '#c9d1d9',
    },
    '.cm-diagnostic': {
      borderColor: '#30363d',
    },
    '.cm-diagnostic-error': {
      borderColor: '#f85149',
    },
    '.cm-diagnostic-warning': {
      borderColor: '#d29922',
    },
    '.cm-foldPlaceholder': {
      backgroundColor: '#21262d',
      borderColor: '#30363d',
      color: '#8b949e',
    },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: '#264f78',
    },
    '.cm-completionDetail': {
      color: '#8b949e',
    },
    '.cm-matchingBracket': {
      backgroundColor: '#264f78',
      fontWeight: 'bold',
    },
    '.cm-nonmatchingBracket': {
      borderColor: '#f85149',
    },
  },
  { dark: true },
);

/**
 * JSON 语法高亮（暗色）— 已包装为 Extension
 */
const darkHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword], color: '#ff7b72' },
  { tag: [tags.name, tags.propertyName, tags.variableName], color: '#7ee787' },
  { tag: [tags.string, tags.character], color: '#a5d6ff' },
  { tag: [tags.number], color: '#79c0ff' },
  { tag: [tags.bool, tags.null], color: '#ff7b72' },
  {
    tag: [tags.punctuation, tags.bracket, tags.brace, tags.operator],
    color: '#8b949e',
  },
  { tag: [tags.comment], color: '#484f58', fontStyle: 'italic' },
  { tag: [tags.tagName], color: '#7ee787' },
  { tag: [tags.attributeName], color: '#79c0ff' },
]);

/**
 * 导出的语法高亮扩展（可直接放入 extensions 数组）
 */
export const darkSyntaxHighlighting = syntaxHighlighting(darkHighlightStyle);
