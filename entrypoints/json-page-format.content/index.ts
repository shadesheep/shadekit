/**
 * JSON 页面自动格式化 Content Script
 * 当浏览器直接访问返回 JSON 的 API URL 时，自动将原始 JSON 文本格式化为可折叠的 HTML 树
 * 参考 FeHelper 的实现原理，UI 风格与现有项目保持一致
 */
import { defineContentScript } from 'wxt/utils/define-content-script';
import './style.scss';
import { formatJsonToHtml } from '../tools/json-formatter/lib/json-formatter';
import { copyToClipboard } from '../shared/clipboard';
import { watchDarkMode, writeThemeMode } from '../shared/content-theme';
import { getConfig } from '../shared/tool-config';

export default defineContentScript({
  matches: [
    'http://*/*',
    'https://*/*'
  ],
  runAt: 'document_idle',
  async main() {
    // 1. 检查是否开启自动解析
    const enabled = await isAutoParseEnabled();
    if (!enabled) return;

    // 2. 排除 HTML 页面（SPA 页面不干扰）
    if (document.contentType === 'text/html') return;

    // 3. 等待 DOM 加载完成
    await waitForDocumentReady();

    // 4. 初始化主题（跟随系统设置）
    initTheme();

    // 5. 获取页面文本
    const text = getJsonText();
    if (!text) return;

    // 6. 尝试解析 JSON
    const result = tryParseJson(text);
    if (!result) return;

    // 7. 执行格式化
    formatJsonPage(result.jsonObj, result.source);
  },
});

// ==================== Theme ====================
// 读取/监听/写入收口在 shared/content-theme.ts（ADR-0004 D7）

let currentDark = false;

async function isAutoParseEnabled(): Promise<boolean> {
  try {
    // 走 getConfig 享受缺失字段补齐（ADR-0003 D5）
    const cfg = await getConfig<{ autoParseJson?: boolean }>(
      'json-formatter',
      { autoParseJson: true },
    );
    if (cfg && typeof cfg.autoParseJson === 'boolean') return cfg.autoParseJson;
  } catch {
    // ignore
  }
  return true; // default on
}

function applyTheme(): void {
  document.documentElement.toggleAttribute('data-dt-dark', currentDark);
  document.documentElement.style.colorScheme = currentDark ? 'dark' : 'light';
  updateThemeIcon();
}

async function initTheme(): Promise<void> {
  await watchDarkMode((isDark) => {
    currentDark = isDark;
    applyTheme();
  });
}

function toggleTheme(): void {
  // content script 内无 Toast 容器，静默写入（失败仅影响主题跨页同步）
  void writeThemeMode(currentDark ? 'light' : 'dark');
}

// ==================== Helpers ====================

function waitForDocumentReady(): Promise<void> {
  if (document.readyState !== 'loading') return Promise.resolve();
  return new Promise((resolve) => {
    document.addEventListener('DOMContentLoaded', () => resolve());
  });
}

function getJsonText(): string | null {
  // 如果是 .js 文件，跳过
  const pathname = new URL(location.href).pathname;
  if (/\.js$/.test(pathname) && document.contentType === 'application/javascript') {
    return null;
  }

  // 优先从 <pre> 标签获取
  const pre = document.querySelector('body > pre');
  if (pre) {
    const text = pre.textContent?.trim();
    if (text) return text;
  }

  // 从 body 的文本内容获取
  if (document.body) {
    const text = document.body.textContent?.trim();
    if (text) return text;
  }

  return null;
}

function tryParseJson(source: string): { jsonObj: unknown; source: string } | null {
  let jsonText = source;

  // 尝试直接解析
  try {
    const obj = JSON.parse(jsonText);
    if (obj != null && typeof obj === 'object') {
      return { jsonObj: obj, source: JSON.stringify(obj) };
    }
  } catch {
    // 继续
  }

  // JSONP 格式：callback({...})
  const jsonpReg = /^([\w.]+)\(\s*([\s\S]*)\s*\)$/m;
  const jsonpMatch = jsonpReg.exec(jsonText);
  if (jsonpMatch) {
    jsonText = jsonpMatch[2];
  }

  try {
    const obj = JSON.parse(jsonText);
    if (obj != null && typeof obj === 'object') {
      return { jsonObj: obj, source: JSON.stringify(obj) };
    }
  } catch {
    // 继续
  }

  // new Function（支持无引号 key）
  try {
    const obj = new Function('return ' + jsonText)();
    if (obj != null && typeof obj === 'object') {
      JSON.stringify(obj);
      return { jsonObj: obj, source: JSON.stringify(obj) };
    }
  } catch {
    // 继续
  }

  // 被引号包裹的字符串："{...}"
  if ((jsonText.startsWith('"') && jsonText.endsWith('"')) ||
      (jsonText.startsWith("'") && jsonText.endsWith("'"))) {
    try {
      const inner = jsonText.slice(1, -1);
      const obj = new Function('return ' + inner)();
      if (obj != null && typeof obj === 'object') {
        JSON.stringify(obj);
        return { jsonObj: obj, source: JSON.stringify(obj) };
      }
    } catch {
      // 失败
    }
  }

  return null;
}

// ==================== Page Rendering ====================

let escapeEnabled = true;
let sortMode = 0;
let currentParsedData: unknown = null;
let currentSource = '';
let currentRawOutput = '';
let showRaw = false;

function formatJsonPage(jsonObj: unknown, source: string): void {
  currentParsedData = jsonObj;
  currentSource = source;
  currentRawOutput = JSON.stringify(jsonObj, null, 2);

  // 添加标记
  document.documentElement.classList.add('fh-jf');

  // 清理原始内容
  document.querySelectorAll('body > pre').forEach((pre) => {
    pre.remove();
  });
  Array.from(document.body.childNodes).forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) node.remove();
  });

  // 构建页面 HTML
  const html = buildPageHtml();
  document.body.insertAdjacentHTML('afterbegin', html);

  // 渲染 JSON 树
  renderJsonTree();

  // 绑定事件
  bindEvents();
}

function buildPageHtml(): string {
  return `
    <div id="jf-page">
      <!-- 顶部工具栏 -->
      <div class="top-bar">
        <div class="brand">
          <span class="i-lucide-braces"></span>
          <span>JSON 自动格式化</span>
        </div>
        <div class="toolbar-actions">
          <span class="sort-label">排序：</span>
          <div class="sort-group">
            <button class="sort-btn active" data-sort="0">默认</button>
            <button class="sort-btn" data-sort="1">升序</button>
            <button class="sort-btn" data-sort="-1">降序</button>
          </div>
          <span class="divider"></span>
          <button class="btn dt-btn-icon" id="jfToggleEscape" title="嵌套转义">转义</button>
          <button class="btn dt-btn-icon" id="jfCopyRaw" title="复制原始 JSON">复制</button>
          <button class="btn dt-btn-icon" id="jfToggleView" title="切换视图">元数据</button>
          <span class="divider"></span>
          <button class="btn dt-btn-icon" id="jfThemeToggle" title="切换亮/暗色主题">
            <span id="jfThemeIcon"></span>
          </button>
        </div>
      </div>

      <!-- 内容区域 -->
      <div class="content-area">
        <div class="panel output-panel">
          <div class="panel-header">输出</div>
          <div id="jfContent"></div>
          <pre id="jfContent_pre"></pre>
          <div id="formattingMsg"><span class="x-loading"></span>格式化中...</div>
        </div>
      </div>
    </div>
  `;
}

function renderJsonTree(): void {
  let data = currentParsedData;

  // 排序
  if (sortMode !== 0 && data != null && typeof data === 'object') {
    data = sortObject(data, sortMode);
  }

  const formattedHtml = formatJsonToHtml(data, escapeEnabled);
  const jfContent = document.getElementById('jfContent');
  if (jfContent) {
    jfContent.innerHTML = formattedHtml;
  }

  currentRawOutput = JSON.stringify(data, null, 2);
  const jfPre = document.getElementById('jfContent_pre');
  if (jfPre) {
    jfPre.textContent = currentSource;
    jfPre.style.display = 'none';
  }
}

function sortObject(obj: unknown, mode: number): unknown {
  if (obj == null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => sortObject(item, mode));
  }
  const entries = Object.entries(obj as Record<string, unknown>);
  entries.sort((a, b) => {
    return mode === 1 ? a[0].localeCompare(b[0]) : b[0].localeCompare(a[0]);
  });
  const result: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    result[k] = typeof v === 'object' ? sortObject(v, mode) : v;
  }
  return result;
}

// ==================== Events ====================

function bindEvents(): void {
  // 排序按钮
  document.querySelectorAll('.sort-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sort-btn').forEach((b) => {
        b.classList.remove('active');
      });
      (btn as HTMLElement).classList.add('active');
      sortMode = parseInt((btn as HTMLElement).dataset.sort || '0', 10);
      renderJsonTree();
    });
  });

  // 嵌套转义开关
  document.getElementById('jfToggleEscape')?.addEventListener('click', () => {
    escapeEnabled = !escapeEnabled;
    const btn = document.getElementById('jfToggleEscape') as HTMLElement;
    btn.classList.toggle('btn-active', escapeEnabled);
    renderJsonTree();
  });

  // 复制原始 JSON
  document.getElementById('jfCopyRaw')?.addEventListener('click', () => {
    void copyToClipboard(currentRawOutput).then((ok) => {
      showToast(ok ? '已复制到剪贴板' : '复制失败');
    });
  });

  // 元数据 / 格式化视图切换
  document.getElementById('jfToggleView')?.addEventListener('click', () => {
    showRaw = !showRaw;
    const btn = document.getElementById('jfToggleView') as HTMLElement;
    const jfContent = document.getElementById('jfContent');
    const jfPre = document.getElementById('jfContent_pre');
    if (showRaw) {
      if (jfContent) jfContent.style.display = 'none';
      if (jfPre) {
        jfPre.textContent = currentSource;
        jfPre.style.display = 'block';
      }
      btn.textContent = '格式化';
    } else {
      if (jfContent) jfContent.style.display = 'block';
      if (jfPre) jfPre.style.display = 'none';
      btn.textContent = '元数据';
    }
  });

  // 主题切换（写入 storage 后经 watchDarkMode 回环刷新图标与属性）
  document.getElementById('jfThemeToggle')?.addEventListener('click', () => {
    toggleTheme();
  });
  updateThemeIcon();

  // JSON 树折叠/展开
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('expand') || target.classList.contains('ellipsis')) {
      e.stopPropagation();
      const parent = target.closest('#formattedJson .item, #jfContent .item') as HTMLElement;
      if (parent) {
        parent.classList.toggle('collapsed');
      }
    }
  });
}

function updateThemeIcon(): void {
  const icon = document.getElementById('jfThemeIcon');
  if (!icon) return;
  // Use Unicode: sun/moon icons
  icon.textContent = currentDark ? '\u2600' : '\u{1F319}';
}

function showToast(msg: string): void {
  const existing = document.getElementById('jf-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'jf-toast';
  toast.textContent = msg;
  const page = document.getElementById('jf-page');
  if (page) page.appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}
