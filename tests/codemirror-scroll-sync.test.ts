// @vitest-environment jsdom
/**
 * 双编辑器滚动同步(shared/lib/codemirror-scroll-sync.ts)测试。
 *
 * 契约:按比例同步(scrollTop/maxScroll)、防回声、suppress 时间窗内
 * 暂停同步、detach 解绑。jsdom 中 scrollHeight/clientHeight 恒为 0,
 * 测试用 Object.defineProperty 注入几何量。
 */
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createCodeEditor, type CodeEditor } from '../entrypoints/shared/lib/codemirror-editor';
import { syncScroll } from '../entrypoints/shared/lib/codemirror-scroll-sync';
import { setupCodemirrorJsdom } from './helpers/codemirror-jsdom';

beforeAll(() => {
  setupCodemirrorJsdom();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function makeEditor(): CodeEditor {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return createCodeEditor({ parent, doc: 'x'.repeat(100) });
}

/** 给 scrollDOM 注入可控的几何量(scrollHeight/clientHeight jsdom 恒 0) */
function stubGeometry(editor: CodeEditor, scrollHeight: number, clientHeight: number) {
  const dom = editor.view.scrollDOM;
  Object.defineProperty(dom, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(dom, 'clientHeight', { value: clientHeight, configurable: true });
  return dom;
}

describe('syncScroll', () => {
  it('按滚动比例同步对侧 scrollTop', async () => {
    const a = makeEditor();
    const b = makeEditor();
    const aDom = stubGeometry(a, 1000, 200); // maxA = 800
    const bDom = stubGeometry(b, 500, 100);  // maxB = 400
    syncScroll(a, b);

    aDom.scrollTop = 400; // ratio = 0.5
    aDom.dispatchEvent(new Event('scroll'));

    expect(bDom.scrollTop).toBe(200); // 0.5 * 400
    a.destroy();
    b.destroy();
  });

  it('对侧同步触发的 scroll 事件不回声(防循环)', async () => {
    const a = makeEditor();
    const b = makeEditor();
    const aDom = stubGeometry(a, 1000, 200);
    const bDom = stubGeometry(b, 1000, 200);
    syncScroll(a, b);

    aDom.scrollTop = 100;
    aDom.dispatchEvent(new Event('scroll'));
    // b 的 scrollTop 赋值在 jsdom 不触发 scroll 事件;若触发也不应回写 a
    bDom.dispatchEvent(new Event('scroll'));
    expect(aDom.scrollTop).toBe(100);
    a.destroy();
    b.destroy();
  });

  it('suppress 时间窗内暂停同步', async () => {
    vi.useFakeTimers();
    const a = makeEditor();
    const b = makeEditor();
    const aDom = stubGeometry(a, 1000, 200);
    const bDom = stubGeometry(b, 500, 100);
    const sync = syncScroll(a, b);

    sync.suppress(150);
    aDom.scrollTop = 400;
    aDom.dispatchEvent(new Event('scroll'));
    expect(bDom.scrollTop).toBe(0); // 被压制

    vi.advanceTimersByTime(200);
    aDom.dispatchEvent(new Event('scroll'));
    expect(bDom.scrollTop).toBe(200); // 恢复同步

    sync.detach();
    vi.useRealTimers();
    a.destroy();
    b.destroy();
  });

  it('detach 后不再同步', () => {
    const a = makeEditor();
    const b = makeEditor();
    const aDom = stubGeometry(a, 1000, 200);
    const bDom = stubGeometry(b, 500, 100);
    const sync = syncScroll(a, b);
    sync.detach();

    aDom.scrollTop = 400;
    aDom.dispatchEvent(new Event('scroll'));
    expect(bDom.scrollTop).toBe(0);
    a.destroy();
    b.destroy();
  });
});
