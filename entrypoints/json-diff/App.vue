<script setup lang="ts">
import { json } from '@codemirror/lang-json';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  attachFileDrop,
  type CodeEditor,
  createCodeEditor,
} from '../shared/lib/codemirror-editor';
import { syncScroll, type ScrollSync } from '../shared/lib/codemirror-scroll-sync';
import { copyToClipboard } from '../shared/clipboard';
import DtButton from '../shared/components/DtButton.vue';
import DtEmptyState from '../shared/components/DtEmptyState.vue';
import DtPanel from '../shared/components/DtPanel.vue';
import { getConfig } from '../shared/tool-config';
import ToastContainer from '../shared/ToastContainer.vue';
import { showToast } from '../shared/use-toast';
import {
  exampleSideFill,
  isEmptyDoc,
  shouldShowEmptyState,
} from '../tools/json-diff/lib/empty-state';
import { createDiffMarkers } from '../tools/json-diff/lib/diff-markers';
import {
  buildDiffPositions,
  type DiffPosition,
} from '../tools/json-diff/lib/diff-nav';
import {
  compareJson,
  type DiffResult,
  getDiffMarkers,
} from '../tools/json-diff/lib/json-differ';
import {
  parseWithBigInt,
  safeStringify,
} from '../tools/json-formatter/lib/json-utils';

const leftEditorRef = ref<HTMLDivElement>();
const rightEditorRef = ref<HTMLDivElement>();
const leftPanelRef = ref<InstanceType<typeof DtPanel>>();
const rightPanelRef = ref<InstanceType<typeof DtPanel>>();

let leftEditor: CodeEditor | null = null;
let rightEditor: CodeEditor | null = null;
let detachDrops: Array<() => void> = [];
let scrollSync: ScrollSync | null = null;

// diff 标记 module(StateField + 主题 + dispatch 收口,见 lib/diff-markers.ts)
const diffMarkers = createDiffMarkers();

// ─── Drag & Drop State ──────────────────────────────────
const isDraggingLeft = ref(false);
const isDraggingRight = ref(false);

// ─── Empty State ─────────────────────────────────────────
// 编辑器为 CodeMirror 实例（在 Vue 响应式之外），通过 updateListener 同步空态标记。
// dismissed：点击空态聚焦后暂时隐藏遮罩，让光标可见；文档变更时复位。
const leftEmpty = ref(true);
const rightEmpty = ref(true);
const leftDismissed = ref(false);
const rightDismissed = ref(false);
const showLeftEmptyState = computed(() =>
  shouldShowEmptyState(leftEmpty.value && !leftDismissed.value, isDraggingLeft.value));
const showRightEmptyState = computed(() =>
  shouldShowEmptyState(rightEmpty.value && !rightDismissed.value, isDraggingRight.value));

const differenceCount = ref(0);
const diffStats = ref({ add: 0, remove: 0, replace: 0 });
const currentDiffIndex = ref(-1);
const diffPositions = ref<DiffPosition[]>([]);

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let isFormatting = false; // 格式化期间抑制 onChangeHandler

// 工具配置（devtools-json-diff）：onChange 闭包在触发时读取 ref，
// 因此 onMounted 中异步加载即可，无需等待再建编辑器
const toolConfig = ref({ autoCompare: true, debounceMs: 300 });

// ─── Paste Detection ──────────────────────────────────────
function handlePaste(e: ClipboardEvent) {
  const text = e.clipboardData?.getData('text');
  if (!text) return;

  const isCompressed = text.trim().split('\n').length === 1 &&
                       /[{[]/.test(text) &&
                       text.length > 50;

  if (isCompressed) {
    showToast('检测到压缩 JSON，点击"对比"将自动格式化', 'info');
  }
}

// 滚动同步:按滚动比例而非像素,收口至 shared/lib/codemirror-scroll-sync
// (onMounted 中两侧编辑器就绪后挂载,navigateDiff 经 scrollSync.suppress 压制)

const EXAMPLES = {
  userInfo: {
    left: {
      id: 1001,
      name: '张三',
      age: 28,
      email: 'zhangsan@example.com',
      address: { city: '北京', district: '朝阳区' },
      tags: ['前端', 'JavaScript', 'Vue'],
      isActive: true,
    },
    right: {
      id: 1001,
      name: '张三',
      age: 30,
      email: 'zhangsan@example.com',
      address: { city: '上海', district: '浦东新区' },
      tags: ['前端', 'JavaScript', 'React'],
      isActive: true,
    },
  },
  configOptions: {
    left: {
      appConfig: {
        theme: 'light',
        language: 'zh-CN',
        notifications: { email: true, push: true, sms: false },
        security: { twoFactorAuth: true, passwordExpiry: 90 },
      },
    },
    right: {
      appConfig: {
        theme: 'dark',
        language: 'zh-CN',
        notifications: { email: true, push: false, sms: true },
        security: { twoFactorAuth: true, passwordExpiry: 60 },
      },
    },
  },
  apiResponse: {
    left: {
      status: 'success',
      code: 200,
      data: {
        users: [
          { id: 1, name: '李明', role: 'admin' },
          { id: 2, name: '王芳', role: 'user' },
        ],
        pagination: { total: 25, page: 1, limit: 10 },
      },
    },
    right: {
      status: 'success',
      code: 200,
      data: {
        users: [
          { id: 1, name: '李明', role: 'admin' },
          { id: 2, name: '王芳', role: 'moderator' },
        ],
        pagination: { total: 28, page: 1, limit: 10 },
      },
    },
  },
};

function createSideEditor(
  parent: HTMLElement,
  initialText: string,
  side: 'left' | 'right',
): CodeEditor {
  return createCodeEditor({
    parent,
    doc: initialText,
    language: json(),
    extraExtensions: diffMarkers.extension,
    onModEnter: () => doCompare(),
    onChange: (text) => {
      if (side === 'left') {
        leftEmpty.value = isEmptyDoc(text);
        leftDismissed.value = false;
      } else {
        rightEmpty.value = isEmptyDoc(text);
        rightDismissed.value = false;
      }
      if (!isFormatting && toolConfig.value.autoCompare) {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(doCompare, toolConfig.value.debounceMs);
      }
    },
  });
}

function getEditorText(editor: CodeEditor | null): string {
  return editor?.getText() || '';
}

function formatEditor(editor: CodeEditor | null) {
  if (!editor) return;
  const text = editor.getText();
  if (!text.trim()) return;
  try {
    const parsed = parseWithBigInt(text);
    const formatted = safeStringify(parsed, 2);
    if (formatted !== text) {
      isFormatting = true; // 格式化期间抑制 onChangeHandler
      try {
        editor.setText(formatted);
      } finally {
        isFormatting = false;
      }
    }
  } catch {
    // 解析失败不阻断对比，让 compareJson 处理错误提示
  }
}

function collectDiffPositions(result: DiffResult, leftText: string, rightText: string) {
  const markers = getDiffMarkers(result.diffs, leftText, rightText);
  // 按 diffIndex 聚合左右两侧行号：replace 差异在左右各有一个 marker，
  // 导航时两侧都要滚动/高亮，右侧高亮才能跟随（旧逻辑只保留左侧 marker）
  diffPositions.value = buildDiffPositions(markers);
  currentDiffIndex.value = -1;
}

function navigateDiff(direction: 'prev' | 'next') {
  if (diffPositions.value.length === 0) return;

  if (direction === 'next') {
    currentDiffIndex.value = (currentDiffIndex.value + 1) % diffPositions.value.length;
  } else {
    currentDiffIndex.value = currentDiffIndex.value <= 0
      ? diffPositions.value.length - 1
      : currentDiffIndex.value - 1;
  }

  const pos = diffPositions.value[currentDiffIndex.value];
  // 两侧各自滚动到自己的差异行：add 只有右侧、remove 只有左侧、replace 两侧都有。
  // 滚动期间压制滚动同步,避免两侧的按比例同步互相把对方拽离目标行
  // (CM 的 scrollIntoView 在下一帧才落实为 DOM 滚动,故压制一个时间窗)
  scrollSync?.suppress(150);
  if (pos.left !== undefined) leftEditor?.scrollToLine(pos.left);
  if (pos.right !== undefined) rightEditor?.scrollToLine(pos.right);
}

function doCompare() {
  // 手动/示例/互换触发的 doCompare 需要取消 onChange 已排期的防抖，
  // 否则同一批变更会让 doCompare 跑两次（Bug: "共有 N 处差异" 提示两次）
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  // 对比前先格式化两边内容
  formatEditor(leftEditor);
  formatEditor(rightEditor);

  const leftText = getEditorText(leftEditor);
  const rightText = getEditorText(rightEditor);

  if (leftEditor) diffMarkers.clear(leftEditor);
  if (rightEditor) diffMarkers.clear(rightEditor);

  if (!leftText.trim() && !rightText.trim()) {
    differenceCount.value = 0;
    diffStats.value = { add: 0, remove: 0, replace: 0 };
    diffPositions.value = [];
    currentDiffIndex.value = -1;
    return;
  }

  if (!leftText.trim()) {
    showToast('请在左侧填入待比对的 JSON 内容', 'error');
    differenceCount.value = 0;
    diffStats.value = { add: 0, remove: 0, replace: 0 };
    diffPositions.value = [];
    currentDiffIndex.value = -1;
    return;
  }

  if (!rightText.trim()) {
    showToast('请在右侧填入待比对的 JSON 内容', 'error');
    differenceCount.value = 0;
    diffStats.value = { add: 0, remove: 0, replace: 0 };
    diffPositions.value = [];
    currentDiffIndex.value = -1;
    return;
  }

  // compareJson 为同步执行且很快，无需「正在对比...」进度提示，
  // 只保留结果提示，避免与 loadExample 等入口的提示堆叠
  const result = compareJson(leftText, rightText);

  diffStats.value = {
    add: result.diffs.filter((d) => d.op === 'add').length,
    remove: result.diffs.filter((d) => d.op === 'remove').length,
    replace: result.diffs.filter((d) => d.op === 'replace').length,
  };

  if (result.error) {
    showToast(result.error, 'error');
    differenceCount.value = 0;
    diffStats.value = { add: 0, remove: 0, replace: 0 };
    diffPositions.value = [];
    currentDiffIndex.value = -1;
    return;
  }

  differenceCount.value = result.differenceCount;

  if (result.differenceCount === 0) {
    showToast('两侧 JSON 完全一致', 'success');
  } else {
    showToast(`共有 ${result.differenceCount} 处差异`, 'info');
  }

  const markers = getDiffMarkers(result.diffs, leftText, rightText);
  if (leftEditor) diffMarkers.set(leftEditor, markers, 'left');
  if (rightEditor) diffMarkers.set(rightEditor, markers, 'right');
  collectDiffPositions(result, leftText, rightText);
}

function swapLeftRight() {
  const leftText = getEditorText(leftEditor);
  const rightText = getEditorText(rightEditor);

  leftEditor?.setText(rightText);
  rightEditor?.setText(leftText);

  showToast('已互换左右内容', 'info');
  setTimeout(doCompare, 100);
}

function loadExample(key: keyof typeof EXAMPLES) {
  const example = EXAMPLES[key];
  const leftJson = JSON.stringify(example.left, null, 2);
  const rightJson = JSON.stringify(example.right, null, 2);

  leftEditor?.setText(leftJson);
  rightEditor?.setText(rightJson);
  // 不再单独提示「已加载示例数据」：随后的 doCompare 会给出结果提示，
  // 避免一次点击弹出多条 Toast
  setTimeout(doCompare, 100);
}

function focusEditor(side: 'left' | 'right') {
  // 隐藏遮罩让聚焦后的光标可见；文档变更时 dismissed 复位，空态恢复
  if (side === 'left') {
    leftDismissed.value = true;
    leftEditor?.focus();
  } else {
    rightDismissed.value = true;
    rightEditor?.focus();
  }
}

// 空态「填入示例」：填入本侧示例，另一侧保持原样
function fillExample(side: 'left' | 'right') {
  const editor = side === 'left' ? leftEditor : rightEditor;
  if (!editor) return;

  const text = exampleSideFill(EXAMPLES.userInfo, side);
  editor.setText(text);
  showToast('已填入示例数据', 'info');
}

function clearAll() {
  leftEditor?.setText('');
  rightEditor?.setText('');
  if (leftEditor) diffMarkers.clear(leftEditor);
  if (rightEditor) diffMarkers.clear(rightEditor);
  differenceCount.value = 0;
  diffStats.value = { add: 0, remove: 0, replace: 0 };
  diffPositions.value = [];
  currentDiffIndex.value = -1;
  showToast('已清空', 'info');
}

async function copyLeft() {
  const text = getEditorText(leftEditor);
  if (text) {
    const ok = await copyToClipboard(text);
    showToast(ok ? '已复制左侧内容' : '复制失败', ok ? 'success' : 'error');
  }
}

async function copyRight() {
  const text = getEditorText(rightEditor);
  if (text) {
    const ok = await copyToClipboard(text);
    showToast(ok ? '已复制右侧内容' : '复制失败', ok ? 'success' : 'error');
  }
}

// ─── Drag & Drop：由 attachFileDrop 挂载到两侧面板（见 onMounted） ──

// 从 URL 参数预填内容
function getInitialText(side: 'left' | 'right'): string {
  const params = new URLSearchParams(window.location.search);
  const text = params.get(side);
  return text ? decodeURIComponent(text) : '';
}

onMounted(() => {
  // 加载配置（autoCompare / debounceMs）；闭包读取 toolConfig ref，无需 await
  void getConfig<{ autoCompare?: boolean; debounceMs?: number }>('json-diff').then(
    (saved) => {
      if (typeof saved?.autoCompare === 'boolean')
        toolConfig.value.autoCompare = saved.autoCompare;
      if (typeof saved?.debounceMs === 'number' && saved.debounceMs >= 0)
        toolConfig.value.debounceMs = saved.debounceMs;
    },
  );

  const leftInitial = getInitialText('left');
  const rightInitial = getInitialText('right');

  if (leftEditorRef.value) {
    leftEditor = createSideEditor(leftEditorRef.value, leftInitial, 'left');
  }
  if (rightEditorRef.value) {
    rightEditor = createSideEditor(rightEditorRef.value, rightInitial, 'right');
  }

  // URL 参数可能预填内容，初始化空态标记
  leftEmpty.value = isEmptyDoc(getEditorText(leftEditor));
  rightEmpty.value = isEmptyDoc(getEditorText(rightEditor));

  // 拖拽文件载入（目标为两侧面板整体）
  const sideDropOptions = (side: 'left' | 'right') => ({
    accept: (file: File) =>
      file.name.endsWith('.json') ? null : '请拖入 .json 文件',
    // 非文件拖入（文本/链接）也提示同一句
    noFileError: '请拖入 .json 文件',
    onText: (text: string, file: File) => {
      const editor = side === 'left' ? leftEditor : rightEditor;
      editor?.setText(text);
      showToast(`已加载 ${file.name}`, 'success');
    },
    onError: (message: string) => showToast(message, 'error'),
    onDraggingChange: (dragging: boolean) => {
      if (side === 'left') {
        isDraggingLeft.value = dragging;
      } else {
        isDraggingRight.value = dragging;
      }
    },
  });
  const leftPanelEl = leftPanelRef.value?.$el as HTMLElement | undefined;
  const rightPanelEl = rightPanelRef.value?.$el as HTMLElement | undefined;
  if (leftPanelEl) detachDrops.push(attachFileDrop(leftPanelEl, sideDropOptions('left')));
  if (rightPanelEl) detachDrops.push(attachFileDrop(rightPanelEl, sideDropOptions('right')));

  if (leftEditor && rightEditor) {
    scrollSync = syncScroll(leftEditor, rightEditor);
  }

  // 监听粘贴事件，检测压缩 JSON
  document.addEventListener('paste', handlePaste);
});

onUnmounted(() => {
  leftEditor?.destroy();
  rightEditor?.destroy();
  scrollSync?.detach();
  scrollSync = null;
  for (const detach of detachDrops) detach();
  detachDrops = [];
  if (debounceTimer) clearTimeout(debounceTimer);
  document.removeEventListener('paste', handlePaste);
});
</script>

<template>
  <div class="page-wrapper" data-dt-root>
    <!-- 顶部工具栏 -->
    <div class="top-bar">
      <div class="brand">
        <div class="i-lucide-git-compare w-5 h-5" />
        <span>JSON 对比</span>
      </div>
      <div class="toolbar-actions">
        <DtButton variant="primary" @click="doCompare">对比</DtButton>
        <DtButton icon title="左右互换" @click="swapLeftRight">
          <div class="i-lucide-arrow-left-right w-4 h-4" />
        </DtButton>
        <span class="divider" />
        <span class="toolbar-label">示例：</span>
        <DtButton variant="ghost" icon @click="loadExample('userInfo')">用户信息</DtButton>
        <DtButton variant="ghost" icon @click="loadExample('configOptions')">配置选项</DtButton>
        <DtButton variant="ghost" icon @click="loadExample('apiResponse')">API 响应</DtButton>
        <span class="divider" />
        <DtButton icon @click="clearAll">清空</DtButton>
        <DtButton variant="ghost" icon @click="copyLeft">复制左侧</DtButton>
        <DtButton variant="ghost" icon @click="copyRight">复制右侧</DtButton>
      </div>
      <div v-if="differenceCount > 0" class="diff-nav">
        <DtButton icon title="上一个差异" @click="navigateDiff('prev')">
          <div class="i-lucide-chevron-up w-4 h-4" />
        </DtButton>
        <span class="diff-counter">{{ currentDiffIndex >= 0 ? currentDiffIndex + 1 : 0 }}/{{ diffPositions.length }}</span>
        <DtButton icon title="下一个差异" @click="navigateDiff('next')">
          <div class="i-lucide-chevron-down w-4 h-4" />
        </DtButton>
      </div>
      <div v-if="differenceCount > 0" class="diff-stats">
        <span class="stat-add">+{{ diffStats.add }}</span>
        <span class="stat-remove">-{{ diffStats.remove }}</span>
        <span class="stat-replace">~{{ diffStats.replace }}</span>
      </div>
    </div>

    <!-- 编辑器区域 -->
    <div class="content-area">
      <DtPanel ref="leftPanelRef" class="editor-panel"
        title="左侧 JSON"
      >
        <div v-if="isDraggingLeft" class="drop-overlay">
          <div class="i-lucide-upload w-5 h-5 mb-1" />
          释放以加载到左侧
        </div>
        <div class="editor-body">
          <DtEmptyState v-if="showLeftEmptyState" overlay @click="focusEditor('left')">
            <template #icon><div class="i-lucide-file-json w-8 h-8" /></template>
            粘贴 JSON，或拖入 .json 文件
            <template #actions>
              <DtButton variant="primary" @click.stop="fillExample('left')">填入示例</DtButton>
            </template>
          </DtEmptyState>
          <div ref="leftEditorRef" class="code-editor"></div>
        </div>
      </DtPanel>
      <DtPanel ref="rightPanelRef" class="editor-panel"
        title="右侧 JSON"
      >
        <div v-if="isDraggingRight" class="drop-overlay">
          <div class="i-lucide-upload w-5 h-5 mb-1" />
          释放以加载到右侧
        </div>
        <div class="editor-body">
          <DtEmptyState v-if="showRightEmptyState" overlay @click="focusEditor('right')">
            <template #icon><div class="i-lucide-file-json w-8 h-8" /></template>
            粘贴 JSON，或拖入 .json 文件
            <template #actions>
              <DtButton variant="primary" @click.stop="fillExample('right')">填入示例</DtButton>
            </template>
          </DtEmptyState>
          <div ref="rightEditorRef" class="code-editor"></div>
        </div>
      </DtPanel>
    </div>

    <ToastContainer />
  </div>
</template>

<style scoped>
/* 两个编辑器面板等宽 */
.editor-panel {
  flex: 1;
  min-width: 0;
}

.editor-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 差异导航 */
.diff-nav {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 2px 6px;
  border-radius: 6px;
  background: #f1f5f9;
  border: 1px solid #e2e8f0;
}

[data-dt-dark] .diff-nav {
  background: #21262d;
  border-color: var(--dt-dark-border);
}

.diff-counter {
  font-size: 12px;
  font-weight: 600;
  color: #374151;
  min-width: 40px;
  text-align: center;
  user-select: none;
}

[data-dt-dark] .diff-counter {
  color: #c9d1d9;
}

/* 差异统计 */
.diff-stats {
  display: flex;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
  padding: 4px 10px;
  border-radius: 6px;
  background: #f1f5f9;
  border: 1px solid #e2e8f0;
}

[data-dt-dark] .diff-stats {
  background: #21262d;
  border-color: var(--dt-dark-border);
}

.stat-add {
  color: #16a34a;
}
[data-dt-dark] .stat-add {
  color: #4ade80;
}

.stat-remove {
  color: #dc2626;
}
[data-dt-dark] .stat-remove {
  color: #f87171;
}

.stat-replace {
  color: #d97706;
}
[data-dt-dark] .stat-replace {
  color: #fbbf24;
}
</style>
