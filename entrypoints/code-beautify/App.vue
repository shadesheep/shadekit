<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  CODE_TYPE_FILE_META,
  CODE_TYPES,
  type CodeType,
  detectTypeFromFileName,
  formatCode,
  formatWithHighlight,
  getTypeDisplayName,
} from '../shared/lib/code-beautifier';
import {
  attachFileDrop,
  type CodeEditor,
  createCodeEditor,
} from '../shared/lib/codemirror-editor';
import DtButton from '../shared/components/DtButton.vue';
import DtEmptyState from '../shared/components/DtEmptyState.vue';
import DtPanel from '../shared/components/DtPanel.vue';
import DtSelect from '../shared/components/DtSelect.vue';
import { copyToClipboard } from '../shared/clipboard';
import { buildDownloadName, downloadTextAsFile } from '../shared/download';
import { getModEnterHint } from '../shared/format-shortcut';
import ToastContainer from '../shared/ToastContainer.vue';
import { getConfig } from '../shared/tool-config';
import { showToast } from '../shared/use-toast';

const inputEditorRef = ref<HTMLDivElement>();
const inputPanelRef = ref<InstanceType<typeof DtPanel>>();
const outputRef = ref<HTMLDivElement>();

let editor: CodeEditor | null = null;
let detachFileDrop: (() => void) | null = null;

const selectedType = ref<CodeType | 'auto'>('auto');
const detectedType = ref<CodeType | null>(null);
const detectedTypeLabel = computed(() =>
  detectedType.value ? getTypeDisplayName(detectedType.value) : '',
);
const outputHtml = ref('');
const rawOutput = ref('');
const isDragging = ref(false);
const modEnterHint = getModEnterHint();

// 配置项
const indentSize = ref(4);
const showLineNumbers = ref(true);

const EXAMPLES: Record<string, string> = {
  js: `function foo(){var x=10;if(x>5){return x*2;}else{return x/2;}}`,
  css: `.header{position:fixed;top:0;left:0;width:100%;background:#fff;z-index:100;}.header .logo{float:left;margin:10px;}`,
  html: `<div class="container"><div class="header"><h1>标题</h1><nav><ul><li><a href="#">首页</a></li></ul></nav></div></div>`,
  xml: `<?xml version="1.0"?><root><person><name>张三</name><age>25</age></person></root>`,
  sql: `SELECT u.name,o.order_id FROM users u LEFT JOIN orders o ON u.id=o.user_id WHERE u.status='active' ORDER BY o.create_time DESC;`,
};

const typeOptions: Array<{ value: CodeType | 'auto'; label: string }> = [
  { value: 'auto', label: '自动检测' },
  ...CODE_TYPES.map((t: CodeType) => ({
    value: t,
    label: getTypeDisplayName(t),
  })),
];

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

onMounted(async () => {
  // 读取保存的配置
  const saved = await getConfig<{
    indentSize?: number;
    showLineNumbers?: boolean;
  }>('code-beautify');
  if (saved) {
    if (saved.indentSize) indentSize.value = saved.indentSize;
    if (saved.showLineNumbers !== undefined)
      showLineNumbers.value = saved.showLineNumbers;
  }

  if (inputEditorRef.value) {
    editor = createCodeEditor({
      parent: inputEditorRef.value,
      onModEnter: () => doFormat(),
      onChange: () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          const raw = getRawText();
          if (raw.trim()) {
            doFormat();
          } else {
            clearOutput();
          }
        }, 300);
      },
    });
  }

  // 拖拽文件载入（目标为整个输入面板）
  const panelEl = inputPanelRef.value?.$el as HTMLElement | undefined;
  if (panelEl) {
    detachFileDrop = attachFileDrop(panelEl, {
      filesOnlyHint: true,
      accept: (file) =>
        detectTypeFromFileName(file.name)
          ? null
          : `不支持的文件类型：${file.name}（支持 .js / .css / .html / .xml / .sql / .json 等代码文件）`,
      onText: (text, file) => {
        if (!text.trim()) {
          showToast('文件内容为空', 'error');
          return;
        }
        if (!editor) {
          showToast('编辑器尚未就绪，请稍后重试', 'error');
          return;
        }
        // 按后缀匹配语言
        const type = detectTypeFromFileName(file.name);
        if (!type) return;
        selectedType.value = type;
        // setText 触发 onChange 防抖自动格式化，无需在此显式调用
        editor.setText(text);
        showToast(`已加载 ${file.name}（${getTypeDisplayName(type)}）`, 'info');
      },
      onError: (message) => showToast(message, 'error'),
      onDraggingChange: (dragging) => {
        isDragging.value = dragging;
      },
    });
  }
});

onUnmounted(() => {
  editor?.destroy();
  detachFileDrop?.();
  detachFileDrop = null;
  if (debounceTimer) clearTimeout(debounceTimer);
});

function getRawText(): string {
  return editor?.getText() || '';
}

function clearOutput() {
  outputHtml.value = '';
  rawOutput.value = '';
  detectedType.value = null;
}

function doFormat() {
  const input = getRawText();
  if (!input.trim()) {
    showToast('请输入需要美化的代码', 'error');
    return;
  }

  try {
    const result = formatCode(input, selectedType.value, {
      indentSize: indentSize.value,
    });
    rawOutput.value = result.result;
    outputHtml.value = formatWithHighlight(
      result.result,
      result.detectedType,
      showLineNumbers.value,
    );
    detectedType.value = result.detectedType;
    showToast(`格式化完成（${getTypeDisplayName(result.detectedType)}）`, 'success');
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    showToast(msg, 'error');
    clearOutput();
  }
}

function loadExample(key: string) {
  const code = EXAMPLES[key];
  if (!code) return;
  // setText 触发 onChange 防抖自动格式化，避免与显式 doFormat 重复弹 toast
  editor?.setText(code);
  showToast(`已加载${getTypeDisplayName(key as CodeType)}示例`, 'info');
}

function clearAll() {
  editor?.setText('');
  clearOutput();
  showToast('已清空', 'info');
}

async function copyResult() {
  if (rawOutput.value) {
    const ok = await copyToClipboard(rawOutput.value);
    showToast(ok ? '已复制到剪贴板' : '复制失败', ok ? 'success' : 'error');
  }
}

function downloadResult() {
  if (!rawOutput.value || !detectedType.value) {
    showToast('暂无可下载的格式化结果', 'error');
    return;
  }
  const meta = CODE_TYPE_FILE_META[detectedType.value];
  downloadTextAsFile(
    rawOutput.value,
    buildDownloadName('beautified', meta.ext, new Date()),
    meta.mime,
  );
  showToast(`已下载 .${meta.ext} 文件`, 'success');
}

// ─── Drag & Drop：由 attachFileDrop 挂载到输入面板（见 onMounted） ──

function onTypeChange() {
  if (getRawText().trim()) {
    doFormat();
  }
}
</script>

<template>
  <div class="page-wrapper" data-dt-root>
    <!-- 顶部工具栏 -->
    <div class="top-bar">
      <div class="brand">
        <div class="i-lucide-code-2 w-5 h-5" />
        <span>代码美化</span>
      </div>
      <div class="toolbar-actions">
        <DtButton variant="primary" :title="`格式化 (${modEnterHint})`" @click="doFormat">
          格式化 <kbd class="ml-1.5 px-1 py-0.5 text-[11px] rounded bg-white/20 border border-solid border-white/35 text-white [font-family:inherit] [vertical-align:1px]">{{ modEnterHint }}</kbd>
        </DtButton>
        <DtSelect v-model="selectedType" :options="typeOptions" @change="onTypeChange" />
        <span class="divider" />
        <span class="toolbar-label">示例：</span>
        <DtButton variant="ghost" icon @click="loadExample('js')">JS</DtButton>
        <DtButton variant="ghost" icon @click="loadExample('css')">CSS</DtButton>
        <DtButton variant="ghost" icon @click="loadExample('html')">HTML</DtButton>
        <DtButton variant="ghost" icon @click="loadExample('xml')">XML</DtButton>
        <DtButton variant="ghost" icon @click="loadExample('sql')">SQL</DtButton>
        <span class="divider" />
        <DtButton icon @click="copyResult">复制结果</DtButton>
        <DtButton variant="ghost" icon :disabled="!rawOutput" @click="downloadResult">下载</DtButton>
        <DtButton icon @click="clearAll">清空</DtButton>
      </div>
    </div>

    <!-- 编辑器区域 -->
    <div class="content-area">
      <DtPanel
        ref="inputPanelRef"
        class="editor-panel"
        title="输入"
      >
        <div v-if="isDragging" class="drop-overlay">
          <div class="i-lucide-upload w-5 h-5 mb-1" />
          释放以加载文件
        </div>
        <div ref="inputEditorRef" class="code-editor"></div>
      </DtPanel>
      <DtPanel class="output-panel" title="输出">
        <template #header-extra>
          <span v-if="detectedTypeLabel" class="detected-type-badge">{{ detectedTypeLabel }}</span>
        </template>
        <template #actions>
          <DtButton
            v-if="rawOutput"
            size="sm"
            title="下载格式化结果"
            @click="downloadResult"
          >
            <div class="i-lucide-download w-3 h-3" />
          </DtButton>
        </template>
        <div
          ref="outputRef"
          class="output-content"
          v-if="outputHtml"
          v-html="outputHtml"
        ></div>
        <DtEmptyState v-else>
          <template #icon><div class="i-lucide-code-2 w-8 h-8" /></template>
          粘贴代码后自动格式化
          <template #hint>支持 JS / CSS / HTML / XML / SQL，可拖入文件</template>
        </DtEmptyState>
      </DtPanel>
    </div>

    <ToastContainer />
  </div>
</template>

<style scoped>
/* 类型选择下拉样式已由 DtSelect 统一承担 */

/* 布局比例：输入区窄，输出区宽 */
.editor-panel {
  flex: 0 0 35%;
  min-width: 300px;
}

.output-panel {
  flex: 1;
  min-width: 0;
}

/* 输出内容 — 类 IDE 代码块风格 */
.output-content {
  flex: 1;
  overflow: auto;
  padding: 0;
  margin: 0;
}

/* 代码输出容器 — 字体度量单一来源，gutter 与代码行继承同一 font-size/line-height，
   保证行号在任何缩放/字号下逐行对齐（行号按逻辑行对应，代码区 white-space: pre 不换行） */
.output-content :deep(.code-output) {
  display: flex;
  position: relative;
  min-height: 100%;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
}

/* 行号 gutter — 独立左侧栏 */
.output-content :deep(.line-numbers-gutter) {
  position: sticky;
  left: 0;
  z-index: 1;
  width: 3.5em;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: 12px 0;
  background: #f8f9fb;
  border-right: 1px solid #e2e8f0;
  user-select: none;
}

[data-dt-dark] .output-content :deep(.line-numbers-gutter) {
  background: var(--dt-dark-base);
  border-color: var(--dt-dark-border);
}

/* 行号 span 高度由继承的 line-height 决定，与代码行盒等高，不写死 px */
.output-content :deep(.line-numbers-gutter span) {
  display: block;
  text-align: right;
  padding-right: 0.8em;
  color: #9ca3af;
}

[data-dt-dark] .output-content :deep(.line-numbers-gutter span) {
  color: #484f58;
}

/* 代码内容区 — font/line-height 继承自 .code-output；斑马纹用 em 与行高同步 */
.output-content :deep(.code-content) {
  flex: 1;
  margin: 0;
  padding: 12px 16px 12px 16px;
  overflow-x: auto;
  border-left: 4px solid #6366f1;
  font: inherit;
  white-space: pre;
  tab-size: 4;
  background:
    repeating-linear-gradient(
      to bottom,
      transparent,
      transparent 3.2em,
      rgba(0, 0, 0, 0.015) 3.2em,
      rgba(0, 0, 0, 0.015) calc(3.2em + 1px)
    );
}

[data-dt-dark] .output-content :deep(.code-content) {
  border-left-color: #818cf8;
  background:
    repeating-linear-gradient(
      to bottom,
      transparent,
      transparent 3.2em,
      rgba(255, 255, 255, 0.02) 3.2em,
      rgba(255, 255, 255, 0.02) calc(3.2em + 1px)
    );
}

.output-content :deep(.code-content code) {
  font: inherit;
  color: #334155;
  white-space: inherit;
}

[data-dt-dark] .output-content :deep(.code-content code) {
  color: #c9d1d9;
}

/* 无行号模式 */
.output-content :deep(.code-content.no-line-numbers) {
  border-left: none;
  padding-left: 16px;
}

/* 语法高亮配色（亮色模式） */
.output-content :deep(.hl-keyword) { color: #d73a49; font-weight: bold; }
.output-content :deep(.hl-literal) { color: #005cc5; }
.output-content :deep(.hl-string) { color: #032f62; }
.output-content :deep(.hl-number) { color: #005cc5; }
.output-content :deep(.hl-comment) { color: #6a737d; font-style: italic; }
.output-content :deep(.hl-regex) { color: #032f62; }
.output-content :deep(.hl-attribute) { color: #005cc5; }
.output-content :deep(.hl-selector-tag) { color: #22863a; font-weight: bold; }
.output-content :deep(.hl-selector-id) { color: #6f42c1; font-weight: bold; }
.output-content :deep(.hl-selector-class) { color: #6f42c1; }
.output-content :deep(.hl-selector-pseudo) { color: #e36209; }
.output-content :deep(.hl-tag) { color: #22863a; font-weight: bold; }
.output-content :deep(.hl-punctuation) { color: #6e7781; }

/* 语法高亮配色（暗色模式） */
[data-dt-dark] .output-content :deep(.hl-keyword) { color: #ff7b72; font-weight: bold; }
[data-dt-dark] .output-content :deep(.hl-literal) { color: #79c0ff; }
[data-dt-dark] .output-content :deep(.hl-string) { color: #a5d6ff; }
[data-dt-dark] .output-content :deep(.hl-number) { color: #79c0ff; }
[data-dt-dark] .output-content :deep(.hl-comment) { color: #8b949e; font-style: italic; }
[data-dt-dark] .output-content :deep(.hl-regex) { color: #a5d6ff; }
[data-dt-dark] .output-content :deep(.hl-attribute) { color: #79c0ff; }
[data-dt-dark] .output-content :deep(.hl-selector-tag) { color: #7ee787; font-weight: bold; }
[data-dt-dark] .output-content :deep(.hl-selector-id) { color: #d2a8ff; font-weight: bold; }
[data-dt-dark] .output-content :deep(.hl-selector-class) { color: #d2a8ff; }
[data-dt-dark] .output-content :deep(.hl-selector-pseudo) { color: #ffa657; }
[data-dt-dark] .output-content :deep(.hl-tag) { color: #7ee787; font-weight: bold; }
[data-dt-dark] .output-content :deep(.hl-punctuation) { color: #8b949e; }

.detected-type-badge {
  font-size: 11px;
  padding: 1px 6px;
  background: #ecfdf5;
  color: #059669;
  border-radius: 6px;
}

[data-dt-dark] .detected-type-badge {
  background: #064e3b;
  color: #6ee7b7;
}
</style>
