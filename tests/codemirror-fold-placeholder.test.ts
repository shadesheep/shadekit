// @vitest-environment jsdom
/**
 * 回归测试：CodeMirror 折叠占位符应使用设计系统胶囊样式
 *
 * 背景：json-format 页左侧编辑器（CodeMirror）折叠后显示 CM 默认的
 * #eee 灰底小胶囊，与右侧树形视图的折叠样式观感不一致。
 * 修复：共享主题 codemirror-theme.ts 统一覆盖 .cm-foldPlaceholder。
 */
import { foldEffect } from '@codemirror/language';
import { json } from '@codemirror/lang-json';
import { basicSetup } from 'codemirror';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getCodemirrorTheme } from '../entrypoints/shared/codemirror-theme';
import { setupCodemirrorJsdom } from './helpers/codemirror-jsdom';

beforeAll(() => {
  setupCodemirrorJsdom();
});

afterEach(() => {
  document.documentElement.removeAttribute('data-dt-dark');
  document.body.innerHTML = '';
});

async function mountFoldedEditor(): Promise<EditorView> {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const doc = '{\n  "a": 1,\n  "b": [1, 2]\n}';
  const view = new EditorView({
    doc,
    extensions: [basicSetup, json(), getCodemirrorTheme()],
    parent,
  });
  // 折叠对象内部（模拟真实折叠行为）
  const from = doc.indexOf('{') + 1;
  const to = doc.lastIndexOf('}');
  view.dispatch({ effects: foldEffect.of({ from, to }) });
  // 让视图完成 measure/渲染
  await new Promise((r) => setTimeout(r, 50));
  view.requestMeasure();
  await new Promise((r) => setTimeout(r, 50));
  return view;
}

function placeholderStyle(view: EditorView): CSSStyleDeclaration {
  const el = view.dom.querySelector('.cm-foldPlaceholder') as HTMLElement | null;
  expect(el, '折叠后应存在 .cm-foldPlaceholder 元素').not.toBeNull();
  return window.getComputedStyle(el!);
}

describe('CodeMirror 折叠占位符样式（共享主题）', () => {
  it('占位符文本为 "..."，与树形视图 .ellipsis 一致', async () => {
    const view = await mountFoldedEditor();
    const el = view.dom.querySelector('.cm-foldPlaceholder');
    expect(el?.textContent).toBe('...');
    view.destroy();
  });

  it('亮色模式：纯文本加粗灰点，无胶囊底/边框', async () => {
    const view = await mountFoldedEditor();
    const cs = placeholderStyle(view);
    expect(cs.color).toBe('rgb(136, 136, 136)'); // #888，同 .ellipsis
    expect(cs.fontWeight).toBe('bold');
    expect(cs.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(cs.borderTopStyle).toBe('none');
    view.destroy();
  });

  it('暗色模式：暗灰文字，无胶囊底/边框', async () => {
    document.documentElement.setAttribute('data-dt-dark', '');
    const view = await mountFoldedEditor();
    const cs = placeholderStyle(view);
    expect(cs.color).toBe('rgb(72, 79, 88)'); // #484f58，同暗色 .ellipsis
    expect(cs.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    view.destroy();
  });
});
