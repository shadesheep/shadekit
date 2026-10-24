// @vitest-environment jsdom
/**
 * 共享 CodeMirror 装配工厂（shared/lib/codemirror-editor.ts）测试。
 *
 * 覆盖：创建/读写/onChange/onModEnter/主题 reconfigure（Compartment，
 * 不丢其他扩展）/destroy 清理监听，以及 attachFileDrop 的 accept 校验
 * 与拖拽悬停态回调。
 */
import { json } from '@codemirror/lang-json';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  attachFileDrop,
  createCodeEditor,
} from '../entrypoints/shared/lib/codemirror-editor';
import { setupCodemirrorJsdom } from './helpers/codemirror-jsdom';

beforeAll(() => {
  setupCodemirrorJsdom();
});

afterEach(() => {
  document.documentElement.removeAttribute('data-dt-dark');
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function makeParent(): HTMLElement {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return parent;
}

function pressModEnter(editor: ReturnType<typeof createCodeEditor>) {
  // jsdom 的 navigator.platform 非 Mac，Mod 解析为 Ctrl
  editor.view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
}

describe('createCodeEditor', () => {
  it('以初始文档创建并挂载到 parent', () => {
    const editor = createCodeEditor({ parent: makeParent(), doc: '{"a":1}' });
    expect(editor.getText()).toBe('{"a":1}');
    expect(editor.view.dom.parentElement).not.toBeNull();
    editor.destroy();
  });

  it('setText / getText 往返，且 setText 触发 onChange', () => {
    const seen: string[] = [];
    const editor = createCodeEditor({
      parent: makeParent(),
      doc: 'old',
      onChange: (text) => seen.push(text),
    });
    editor.setText('new text');
    expect(editor.getText()).toBe('new text');
    expect(seen).toEqual(['new text']);
    editor.destroy();
  });

  it('文档未变化时不触发 onChange', () => {
    const onChange = vi.fn();
    const editor = createCodeEditor({ parent: makeParent(), onChange });
    editor.view.dispatch({ selection: { anchor: 0 } });
    expect(onChange).not.toHaveBeenCalled();
    editor.destroy();
  });

  it('Mod-Enter 触发 onModEnter 回调', () => {
    const onModEnter = vi.fn();
    const editor = createCodeEditor({ parent: makeParent(), onModEnter });
    pressModEnter(editor);
    expect(onModEnter).toHaveBeenCalledTimes(1);
    editor.destroy();
  });

  it('主题切换后 reconfigure 生效，且 language/basicSetup 等扩展保留', async () => {
    const editor = createCodeEditor({
      parent: makeParent(),
      doc: '{"a":1}',
      language: json(),
    });
    // 亮色 gutter 背景（主题规则以子元素为目标，.cm-editor 根规则在 CM 主题
    // 作用域下不命中根元素，故用 gutters 断言）
    const gutters = () => editor.view.dom.querySelector('.cm-gutters');
    expect(window.getComputedStyle(gutters()!).backgroundColor).toBe(
      'rgb(246, 248, 250)', // #f6f8fa
    );

    document.documentElement.setAttribute('data-dt-dark', '');
    window.dispatchEvent(new Event('theme-changed'));
    editor.view.requestMeasure();
    await new Promise((r) => setTimeout(r, 50));

    expect(window.getComputedStyle(gutters()!).backgroundColor).toBe(
      'rgb(22, 27, 34)', // #161b22
    );
    // Compartment 只换主题：basicSetup 的行号 gutter 与文档内容必须还在
    expect(gutters()).not.toBeNull();
    expect(editor.getText()).toBe('{"a":1}');
    editor.destroy();
  });

  it('storage 事件（devtools-theme）同样触发主题刷新', async () => {
    const editor = createCodeEditor({ parent: makeParent() });
    document.documentElement.setAttribute('data-dt-dark', '');
    window.dispatchEvent(new StorageEvent('storage', { key: 'devtools-theme' }));
    editor.view.requestMeasure();
    await new Promise((r) => setTimeout(r, 50));
    const gutters = editor.view.dom.querySelector('.cm-gutters');
    expect(window.getComputedStyle(gutters!).backgroundColor).toBe(
      'rgb(22, 27, 34)',
    );
    editor.destroy();
  });

  it('destroy 摘除 theme-changed / storage 监听并销毁视图', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const editor = createCodeEditor({ parent: makeParent() });
    editor.destroy();
    const removedTypes = removeSpy.mock.calls.map((c) => c[0]);
    expect(removedTypes).toContain('theme-changed');
    expect(removedTypes).toContain('storage');
    // destroy 后再派发主题事件不应抛错
    expect(() => window.dispatchEvent(new Event('theme-changed'))).not.toThrow();
  });
});

describe('attachFileDrop', () => {
  function dropFile(el: HTMLElement, file: File) {
    const e = new Event('drop', { cancelable: true, bubbles: true });
    Object.defineProperty(e, 'dataTransfer', { value: { files: [file] } });
    el.dispatchEvent(e);
  }

  it('accept 通过时读取文件文本并回调 onText', async () => {
    const el = makeParent();
    const onText = vi.fn();
    const detach = attachFileDrop(el, {
      accept: (f) => (f.name.endsWith('.json') ? null : '请拖入 .json 文件'),
      onText,
    });
    dropFile(el, new File(['{"a":1}'], 'a.json', { type: 'application/json' }));
    await vi.waitFor(() => expect(onText).toHaveBeenCalledTimes(1));
    expect(onText.mock.calls[0][0]).toBe('{"a":1}');
    expect(onText.mock.calls[0][1].name).toBe('a.json');
    detach();
  });

  it('accept 拒绝时回调 onError，不读文件', async () => {
    const el = makeParent();
    const onText = vi.fn();
    const onError = vi.fn();
    const detach = attachFileDrop(el, {
      accept: (f) => (f.name.endsWith('.json') ? null : '请拖入 .json 文件'),
      onText,
      onError,
    });
    dropFile(el, new File(['hello'], 'a.txt', { type: 'text/plain' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(onError).toHaveBeenCalledWith('请拖入 .json 文件');
    expect(onText).not.toHaveBeenCalled();
    detach();
  });

  it('dragenter/dragleave/drop 驱动 onDraggingChange', () => {
    const el = makeParent();
    const states: boolean[] = [];
    const detach = attachFileDrop(el, {
      onText: () => {},
      onDraggingChange: (d) => states.push(d),
    });
    el.dispatchEvent(new Event('dragenter', { cancelable: true }));
    el.dispatchEvent(new Event('dragleave', { cancelable: true }));
    expect(states).toEqual([true, false]);
    detach();
  });

  it('嵌套子元素 enter/leave 抖动期间保持悬停态（深度计数）', () => {
    const el = makeParent();
    const states: boolean[] = [];
    const detach = attachFileDrop(el, {
      onText: () => {},
      onDraggingChange: (d) => states.push(d),
    });
    // 进入面板(+1) → 进入子元素(+1) → 离开子元素(-1)：仍应高亮，且不重复回调 true
    el.dispatchEvent(new Event('dragenter', { cancelable: true }));
    el.dispatchEvent(new Event('dragenter', { cancelable: true }));
    el.dispatchEvent(new Event('dragleave', { cancelable: true }));
    expect(states).toEqual([true]);
    // 真正离开面板(-1 → 0)：取消高亮
    el.dispatchEvent(new Event('dragleave', { cancelable: true }));
    expect(states).toEqual([true, false]);
    detach();
  });

  it('filesOnlyHint：非文件拖拽不进入悬停态', () => {
    const el = makeParent();
    const states: boolean[] = [];
    const detach = attachFileDrop(el, {
      onText: () => {},
      onDraggingChange: (d) => states.push(d),
      filesOnlyHint: true,
    });
    // 无 dataTransfer（文本/链接拖拽）
    el.dispatchEvent(new Event('dragenter', { cancelable: true }));
    expect(states).toEqual([]);
    // 文件拖拽
    const e = new Event('dragenter', { cancelable: true });
    Object.defineProperty(e, 'dataTransfer', { value: { types: ['Files'] } });
    el.dispatchEvent(e);
    expect(states).toEqual([true]);
    detach();
  });

  it('drop 无文件时：默认静默，配置 noFileError 则经 onError 提示', () => {
    const el = makeParent();
    const onError = vi.fn();
    // 默认：静默
    const detach1 = attachFileDrop(el, { onText: () => {}, onError });
    const silent = new Event('drop', { cancelable: true });
    Object.defineProperty(silent, 'dataTransfer', { value: { files: [] } });
    el.dispatchEvent(silent);
    expect(onError).not.toHaveBeenCalled();
    detach1();
    // noFileError：提示（json-diff 历史行为）
    const detach2 = attachFileDrop(el, {
      onText: () => {},
      onError,
      noFileError: '请拖入 .json 文件',
    });
    const e = new Event('drop', { cancelable: true });
    Object.defineProperty(e, 'dataTransfer', { value: { files: [] } });
    el.dispatchEvent(e);
    expect(onError).toHaveBeenCalledWith('请拖入 .json 文件');
    detach2();
  });

  it('detach 后不再响应拖拽', () => {
    const el = makeParent();
    const onDraggingChange = vi.fn();
    const detach = attachFileDrop(el, { onText: () => {}, onDraggingChange });
    detach();
    el.dispatchEvent(new Event('dragenter', { cancelable: true }));
    expect(onDraggingChange).not.toHaveBeenCalled();
  });
});

// ─── 第 5 轮评审加深:setLanguage / scrollToLine / readonly ───

describe('createCodeEditor · setLanguage', () => {
  it('初始语言经 language 选项生效,setLanguage 运行时切换且不丢文档', () => {
    const editor = createCodeEditor({
      parent: makeParent(),
      doc: '{"a":1}',
      language: json(),
    });
    editor.setLanguage([]);
    expect(editor.getText()).toBe('{"a":1}');

    editor.setLanguage(json());
    expect(editor.getText()).toBe('{"a":1}');
    editor.destroy();
  });

  it('setLanguage 不影响 basicSetup(行号 gutter 保留)', () => {
    const editor = createCodeEditor({ parent: makeParent(), doc: 'x' });
    editor.setLanguage(json());
    expect(editor.view.dom.querySelector('.cm-gutters')).not.toBeNull();
    editor.destroy();
  });
});

describe('createCodeEditor · scrollToLine', () => {
  it('0-based 行号:光标置目标行行首', () => {
    const editor = createCodeEditor({
      parent: makeParent(),
      doc: 'line0\nline1\nline2',
    });
    editor.scrollToLine(1);
    const pos = editor.view.state.selection.main.anchor;
    // 第 2 行(0-based 1)行首偏移 = 'line0\n'.length
    expect(pos).toBe(6);
    editor.destroy();
  });

  it('行号越界静默忽略', () => {
    const editor = createCodeEditor({ parent: makeParent(), doc: 'only' });
    expect(() => editor.scrollToLine(99)).not.toThrow();
    expect(editor.view.state.selection.main.anchor).toBe(0);
    editor.destroy();
  });
});

describe('createCodeEditor · readonly', () => {
  it('readonly: true 时文档不可编辑', () => {
    const editor = createCodeEditor({ parent: makeParent(), doc: 'fixed', readonly: true });
    expect(editor.view.state.readOnly).toBe(true);
    // 只读编辑器仍可程序化 setText(输出装配场景,如 mock-data)
    editor.setText('updated');
    expect(editor.getText()).toBe('updated');
    editor.destroy();
  });

  it('默认非只读', () => {
    const editor = createCodeEditor({ parent: makeParent(), doc: 'x' });
    expect(editor.view.state.readOnly).toBe(false);
    editor.destroy();
  });
});
