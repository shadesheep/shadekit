// @vitest-environment jsdom
/**
 * mock-data 页「源码」视图回归测试（v1.1.1 用户反馈:某些场景下源码栏目
 * 不显示内容,但能导出)。
 *
 * 根因:批量结果区 `.output-body` 用 `v-if="leftMode === 'batch'"` 条件渲染,
 * 切到「快速取数」时整个容器(含 CodeMirror 挂载点)被 Vue 销毁,而编辑器
 * 实例只在 onMounted 创建一次 —— 切回批量模式后 Vue 生成全新的空容器,
 * 编辑器 DOM 已孤儿化(detached),`setText` 静默写入不可见的旧 DOM。
 * 导出走 `rawOutput`(响应式数据,与编辑器无关),故「能导出但不显示」。
 *
 * 断言策略:jsdom 无布局,CM 视口高度为 0,不断言渲染行;改用
 * `EditorView.findFromDOM` 读取容器内活编辑器实例的文档 —— 精确对应
 * 「用户看到的容器里有没有一个带内容的编辑器」。
 */
import { EditorView } from '@codemirror/view';
import { createApp, nextTick, type App as VueApp } from 'vue';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../entrypoints/mock-data/App.vue';
import { setupCodemirrorJsdom } from './helpers/codemirror-jsdom';

// ─── chrome.storage.local stub(与 config-save-toast.test.ts 同款) ──────

let store: Record<string, unknown>;

function stubChromeStorage() {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (keys: string[] | null) => {
          if (keys === null) return { ...store };
          const out: Record<string, unknown> = {};
          for (const k of keys) {
            if (k in store) out[k] = store[k];
          }
          return out;
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, items);
        }),
        remove: vi.fn(async (keys: string[]) => {
          for (const k of keys) delete store[k];
        }),
      },
    },
  });
}

// ─── 挂载与交互 ─────────────────────────────────────────────

let app: VueApp<Element> | null = null;
let root: HTMLDivElement;

beforeAll(() => {
  setupCodemirrorJsdom();
});

beforeEach(() => {
  store = {};
  stubChromeStorage();
});

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function flush() {
  await nextTick();
  await new Promise((r) => setTimeout(r, 0));
  await nextTick();
}

/** 挂载真实 App.vue 并等待 onMounted(异步 getConfig + 首次自动生成)完成 */
async function mountApp() {
  root = document.createElement('div');
  document.body.appendChild(root);
  app = createApp(App);
  app.mount(root);
  await flush();
  await flush();
}

async function clickButton(text: string) {
  const btn = Array.from(root.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  );
  expect(btn, `按钮「${text}」应存在`).toBeTruthy();
  btn!.click();
  await flush();
}

/** 结果区条数徽标文本(导出数据源 rawOutput 是否健在的可观测代理) */
function countBadgeText(): string {
  return root.querySelector('.result-panel .count-badge')?.textContent ?? '';
}

/**
 * 「源码」容器内活编辑器的文档内容。
 * 容器里没有 CM 实例(孤儿化/未挂载)时返回 ''。
 */
function codeEditorDoc(): string {
  const container = root.querySelector('.code-editor');
  if (!(container instanceof HTMLElement)) return '';
  const view = EditorView.findFromDOM(container);
  return view ? view.state.doc.toString() : '';
}

// ─── 用例 ───────────────────────────────────────────────────

describe('mock-data 源码视图', () => {
  it('对照:挂载后直接切到源码视图,编辑器显示生成内容', async () => {
    await mountApp();
    // 首屏自动载入 user 模板并生成(10 条)
    expect(countBadgeText()).toMatch(/\d+ 条/);

    await clickButton('源码');
    expect(codeEditorDoc()).toContain('"name"');
  });

  it('回归:切到快速取数再切回批量,源码视图仍应显示内容', async () => {
    await mountApp();
    await clickButton('快速取数');
    await clickButton('批量生成');
    await clickButton('源码');

    // 导出数据源仍在 —— 对应用户反馈的「能导出」
    expect(countBadgeText()).toMatch(/\d+ 条/);
    // 源码编辑器也必须有内容 —— 修复前此处为空(v-if 卸载导致编辑器 DOM 孤儿化)
    expect(codeEditorDoc()).toContain('"name"');
  });
});
