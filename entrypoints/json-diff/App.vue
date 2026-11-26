<script setup lang="ts">
import { json } from "@codemirror/lang-json";
import { onMounted, onUnmounted, ref } from "vue";
import { stringify } from "lossless-json";
import DtSegmented from "../shared/config/DtSegmented.vue";
import { compareText } from "../tools/json-diff/lib/text-differ";
import {
  attachFileDrop,
  type CodeEditor,
  createCodeEditor,
} from "../shared/lib/codemirror-editor";
import {
  syncScroll,
  type ScrollSync,
} from "../shared/lib/codemirror-scroll-sync";
import { copyToClipboard } from "../shared/clipboard";
import DtButton from "../shared/components/DtButton.vue";
import DtPanel from "../shared/components/DtPanel.vue";
import { getConfig } from "../shared/tool-config";
import ToastContainer from "../shared/ToastContainer.vue";
import { showToast } from "../shared/use-toast";
import { createDiffMarkers } from "../tools/json-diff/lib/diff-markers";
import {
  buildDiffPositions,
  type DiffPosition,
} from "../tools/json-diff/lib/diff-nav";
import {
  compareJson,
  type DiffEntry,
  formatJson,
  getDiffMarkers,
} from "../tools/json-diff/lib/json-differ";

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

// ─── Diff State ──────────────────────────────────────────
const mode = ref<"json" | "text">("json");
const status = ref("粘贴内容或拖入文件开始对比");
const errorMessage = ref("");
const diffEntries = ref<DiffEntry[]>([]);
const differenceCount = ref(0);
const diffStats = ref({ add: 0, remove: 0, replace: 0 });
const currentDiffIndex = ref(-1);
const diffPositions = ref<DiffPosition[]>([]);

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let isFormatting = false; // 格式化期间抑制 onChangeHandler

// 工具配置（devtools-json-diff）：onChange 闭包在触发时读取 ref，
// 因此 onMounted 中异步加载即可，无需等待再建编辑器
const toolConfig = ref({ autoCompare: true, debounceMs: 300 });

const EXAMPLES = {
  userInfo: {
    left: {
      id: 1001,
      name: "张三",
      age: 28,
      email: "zhangsan@example.com",
      address: { city: "北京", district: "朝阳区" },
      tags: ["前端", "JavaScript", "Vue"],
      isActive: true,
    },
    right: {
      id: 1001,
      name: "张三",
      age: 30,
      email: "zhangsan@example.com",
      address: { city: "上海", district: "浦东新区" },
      tags: ["前端", "JavaScript", "React"],
      isActive: true,
    },
  },
  configOptions: {
    left: {
      appConfig: {
        theme: "light",
        language: "zh-CN",
        notifications: { email: true, push: true, sms: false },
        security: { twoFactorAuth: true, passwordExpiry: 90 },
      },
    },
    right: {
      appConfig: {
        theme: "dark",
        language: "zh-CN",
        notifications: { email: true, push: false, sms: true },
        security: { twoFactorAuth: true, passwordExpiry: 60 },
      },
    },
  },
  apiResponse: {
    left: {
      status: "success",
      code: 200,
      data: {
        users: [
          { id: 1, name: "李明", role: "admin" },
          { id: 2, name: "王芳", role: "user" },
        ],
        pagination: { total: 25, page: 1, limit: 10 },
      },
    },
    right: {
      status: "success",
      code: 200,
      data: {
        users: [
          { id: 1, name: "李明", role: "admin" },
          { id: 2, name: "王芳", role: "moderator" },
        ],
        pagination: { total: 28, page: 1, limit: 10 },
      },
    },
  },
};

function createSideEditor(
  parent: HTMLElement,
  initialText: string,
): CodeEditor {
  return createCodeEditor({
    parent,
    doc: initialText,
    language: json(),
    extraExtensions: diffMarkers.extension,
    onModEnter: () => doCompare(),
    onChange: () => {
      if (isFormatting) return;
      errorMessage.value = "";
      diffEntries.value = [];
      differenceCount.value = 0;
      diffPositions.value = [];
      currentDiffIndex.value = -1;
      status.value = "内容已修改，等待对比";
      if (leftEditor) diffMarkers.clear(leftEditor);
      if (rightEditor) diffMarkers.clear(rightEditor);
      if (toolConfig.value.autoCompare) {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(doCompare, toolConfig.value.debounceMs);
      }
    },
  });
}

function getEditorText(editor: CodeEditor | null): string {
  return editor?.getText() || "";
}

function formatEditor(editor: CodeEditor | null) {
  if (!editor) return;
  const text = editor.getText();
  if (!text.trim()) return;
  try {
    const formatted = formatJson(text);
    if (formatted !== text) {
      isFormatting = true; // 格式化期间抑制 onChangeHandler
      try {
        editor.setText(formatted);
      } finally {
        isFormatting = false;
      }
    }
  } catch (error) {
    errorMessage.value = `格式化失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function setMode(value: "json" | "text") {
  mode.value = value;
  leftEditor?.setLanguage(value === "json" ? json() : []);
  rightEditor?.setLanguage(value === "json" ? json() : []);
  doCompare();
}

function formatBoth() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  errorMessage.value = "";
  formatEditor(leftEditor);
  formatEditor(rightEditor);
  if (!errorMessage.value) doCompare();
}

function loadTextExample() {
  leftEditor?.setText("# 发布说明\n\n- JSON 对比\n- 自动格式化\n");
  rightEditor?.setText(
    "# 发布说明\n\n- JSON 与文本对比\n- 手动格式化\n- 差异导航\n",
  );
  doCompare();
}

function downloadPatch() {
  const patch = diffEntries.value.map(({ op, path, value }) =>
    op === "remove" ? { op, path } : { op, path, value },
  );
  const blob = new Blob([stringify(patch, undefined, 2) ?? "[]"], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "comparison.patch.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function preview(value: unknown): string {
  const text = stringify(value) ?? "";
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

function jumpToDiff(diffIndex: number) {
  const index = diffPositions.value.findIndex((p) => p.diffIndex === diffIndex);
  if (index < 0) return;
  currentDiffIndex.value = index - 1;
  navigateDiff("next");
}

function navigateDiff(direction: "prev" | "next") {
  if (diffPositions.value.length === 0) return;

  if (direction === "next") {
    currentDiffIndex.value =
      (currentDiffIndex.value + 1) % diffPositions.value.length;
  } else {
    currentDiffIndex.value =
      currentDiffIndex.value <= 0
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

  const leftText = getEditorText(leftEditor);
  const rightText = getEditorText(rightEditor);
  if (leftEditor) diffMarkers.clear(leftEditor);
  if (rightEditor) diffMarkers.clear(rightEditor);
  const textResult =
    mode.value === "text" ? compareText(leftText, rightText) : null;
  const result = textResult ?? compareJson(leftText, rightText);
  errorMessage.value = result.error ?? "";
  diffEntries.value = result.diffs;
  differenceCount.value = result.differenceCount;
  diffStats.value = {
    add: result.diffs.filter((d) => d.op === "add").length,
    remove: result.diffs.filter((d) => d.op === "remove").length,
    replace: result.diffs.filter((d) => d.op === "replace").length,
  };
  status.value = result.error
    ? "请检查输入内容"
    : result.isDifferent
      ? `共有 ${result.differenceCount} ${mode.value === "text" ? "个差异块" : "处字段差异"}`
      : "两侧内容一致";
  if (textResult && !textResult.precise) status.value += "，大段差异已合并显示";
  const markers =
    textResult?.markers ?? getDiffMarkers(result.diffs, leftText, rightText);
  if (leftEditor) diffMarkers.set(leftEditor, markers, "left");
  if (rightEditor) diffMarkers.set(rightEditor, markers, "right");
  diffPositions.value = buildDiffPositions(markers);
  currentDiffIndex.value = -1;
}

function swapLeftRight() {
  const leftText = getEditorText(leftEditor);
  const rightText = getEditorText(rightEditor);

  leftEditor?.setText(rightText);
  rightEditor?.setText(leftText);

  showToast("已互换左右内容", "info");
  doCompare();
}

function loadExample(key: keyof typeof EXAMPLES) {
  const example = EXAMPLES[key];
  const leftJson = JSON.stringify(example.left, null, 2);
  const rightJson = JSON.stringify(example.right, null, 2);

  leftEditor?.setText(leftJson);
  rightEditor?.setText(rightJson);
  // 不再单独提示「已加载示例数据」：随后的 doCompare 会给出结果提示，
  // 避免一次点击弹出多条 Toast
  doCompare();
}

function clearAll() {
  leftEditor?.setText("");
  rightEditor?.setText("");
  if (leftEditor) diffMarkers.clear(leftEditor);
  if (rightEditor) diffMarkers.clear(rightEditor);
  differenceCount.value = 0;
  diffStats.value = { add: 0, remove: 0, replace: 0 };
  diffPositions.value = [];
  currentDiffIndex.value = -1;
  doCompare();
  status.value = "已清空";
}

async function copyLeft() {
  const text = getEditorText(leftEditor);
  if (text) {
    const ok = await copyToClipboard(text);
    showToast(ok ? "已复制左侧内容" : "复制失败", ok ? "success" : "error");
  }
}

async function copyRight() {
  const text = getEditorText(rightEditor);
  if (text) {
    const ok = await copyToClipboard(text);
    showToast(ok ? "已复制右侧内容" : "复制失败", ok ? "success" : "error");
  }
}

// ─── Drag & Drop：由 attachFileDrop 挂载到两侧面板（见 onMounted） ──

// 从 URL 参数预填内容
function getInitialText(side: "left" | "right"): string {
  const params = new URLSearchParams(window.location.search);
  const text = params.get(side);
  return text ?? "";
}

onMounted(() => {
  // 加载配置（autoCompare / debounceMs）；闭包读取 toolConfig ref，无需 await
  void getConfig<{ autoCompare?: boolean; debounceMs?: number }>(
    "json-diff",
  ).then((saved) => {
    if (typeof saved?.autoCompare === "boolean")
      toolConfig.value.autoCompare = saved.autoCompare;
    if (typeof saved?.debounceMs === "number" && saved.debounceMs >= 0)
      toolConfig.value.debounceMs = saved.debounceMs;
  });

  const leftInitial = getInitialText("left");
  const rightInitial = getInitialText("right");

  if (leftEditorRef.value) {
    leftEditor = createSideEditor(leftEditorRef.value, leftInitial);
  }
  if (rightEditorRef.value) {
    rightEditor = createSideEditor(rightEditorRef.value, rightInitial);
  }

  // 拖拽文件载入（目标为两侧面板整体）
  const sideDropOptions = (side: "left" | "right") => ({
    accept: (file: File) =>
      mode.value === "text" || /\.json$/i.test(file.name)
        ? null
        : "请拖入 .json 文件，或切换文本模式",
    // 非文件拖入（文本/链接）也提示同一句
    noFileError: "请拖入文本文件",
    onText: (text: string, file: File) => {
      const editor = side === "left" ? leftEditor : rightEditor;
      editor?.setText(text);
      showToast(`已加载 ${file.name}`, "success");
    },
    onError: (message: string) => showToast(message, "error"),
    onDraggingChange: (dragging: boolean) => {
      if (side === "left") {
        isDraggingLeft.value = dragging;
      } else {
        isDraggingRight.value = dragging;
      }
    },
  });
  const leftPanelEl = leftPanelRef.value?.$el as HTMLElement | undefined;
  const rightPanelEl = rightPanelRef.value?.$el as HTMLElement | undefined;
  if (leftPanelEl)
    detachDrops.push(attachFileDrop(leftPanelEl, sideDropOptions("left")));
  if (rightPanelEl)
    detachDrops.push(attachFileDrop(rightPanelEl, sideDropOptions("right")));

  if (leftEditor && rightEditor) {
    scrollSync = syncScroll(leftEditor, rightEditor);
  }

  if (leftInitial || rightInitial) doCompare();
});

onUnmounted(() => {
  leftEditor?.destroy();
  rightEditor?.destroy();
  scrollSync?.detach();
  scrollSync = null;
  for (const detach of detachDrops) detach();
  detachDrops = [];
  if (debounceTimer) clearTimeout(debounceTimer);
});
</script>

<template>
  <div class="page-wrapper" data-dt-root>
    <!-- 顶部工具栏 -->
    <div class="top-bar">
      <div class="brand">
        <div class="i-lucide-git-compare w-5 h-5" />
        <span>内容对比</span>
      </div>
      <div class="toolbar-actions">
        <DtSegmented :model-value="mode" :options="[{value: 'json', label: 'JSON'}, {value: 'text', label: '文本'}]" aria-label="对比模式" @update:model-value="setMode" />
        <DtButton variant="primary" @click="doCompare">对比</DtButton>
        <DtButton v-if="mode === 'json'" @click="formatBoth">格式化</DtButton>
        <DtButton icon title="左右互换" @click="swapLeftRight">
          <div class="i-lucide-arrow-left-right w-4 h-4" />
        </DtButton>
        <span class="divider" />
        <span class="toolbar-label">示例</span>
        <DtButton v-if="mode === 'text'" variant="ghost" @click="loadTextExample">发布说明</DtButton>
        <DtButton v-if="mode === 'json'" variant="ghost" icon @click="loadExample('userInfo')">用户信息</DtButton>
        <DtButton v-if="mode === 'json'" variant="ghost" icon @click="loadExample('configOptions')">配置选项</DtButton>
        <DtButton v-if="mode === 'json'" variant="ghost" icon @click="loadExample('apiResponse')">API 响应</DtButton>
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

    <div class="comparison-status" role="status" aria-live="polite">{{ status }}</div>
    <div v-if="errorMessage" class="comparison-error" role="alert">
      {{ errorMessage }}
      <DtButton v-if="mode === 'json'" size="sm" @click="setMode('text')">切换文本对比</DtButton>
    </div>
    <details v-if="diffEntries.length" class="diff-details">
      <summary>差异明细（{{ diffEntries.length }}）</summary>
      <div class="diff-list">
        <button v-for="(entry, index) in diffEntries.slice(0, 100)" :key="index" type="button" @click="jumpToDiff(index)">
          <strong>{{ { add: '新增', remove: '删除', replace: '修改' }[entry.op] }} {{ entry.path || '根节点' }}</strong>
          <span v-if="entry.op !== 'add'">原值 {{ preview(entry.oldValue) }}</span>
          <span v-if="entry.op !== 'remove'">新值 {{ preview(entry.value) }}</span>
        </button>
        <span v-if="diffEntries.length > 100">显示前 100 项，可使用差异导航查看其余项</span>
      </div>
      <DtButton v-if="mode === 'json'" size="sm" @click="downloadPatch">导出 JSON Patch</DtButton>
    </details>
    <!-- 编辑器区域 -->
    <div class="content-area">
      <DtPanel ref="leftPanelRef" class="editor-panel"
        :title="mode === 'json' ? '左侧 JSON' : '左侧文本'"
      >
        <div v-if="isDraggingLeft" class="drop-overlay">
          <div class="i-lucide-upload w-5 h-5 mb-1" />
          释放以加载到左侧
        </div>
        <div class="editor-body">
          <div ref="leftEditorRef" class="code-editor"></div>
        </div>
      </DtPanel>
      <DtPanel ref="rightPanelRef" class="editor-panel"
        :title="mode === 'json' ? '右侧 JSON' : '右侧文本'"
      >
        <div v-if="isDraggingRight" class="drop-overlay">
          <div class="i-lucide-upload w-5 h-5 mb-1" />
          释放以加载到右侧
        </div>
        <div class="editor-body">
          <div ref="rightEditorRef" class="code-editor"></div>
        </div>
      </DtPanel>
    </div>

    <ToastContainer />
  </div>
</template>

<style scoped>
.top-bar { flex-wrap: wrap; }
.comparison-status, .comparison-error, .diff-details { padding: 8px 16px; font-size: 12px; }
.comparison-status { color: #64748b; }
.comparison-error { color: #dc2626; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 120px; overflow: auto; }
.diff-details { border-bottom: 1px solid #e2e8f0; }
.diff-details summary { cursor: pointer; }
.diff-list { max-height: 180px; overflow: auto; margin: 8px 0; }
.diff-list button { display: flex; flex-direction: column; gap: 4px; width: 100%; text-align: left; background: transparent; color: inherit; border: 0; border-bottom: 1px solid #e2e8f0; padding: 8px; cursor: pointer; overflow-wrap: anywhere; }
.diff-list button:hover { background: #eef2ff; }
.diff-list button:focus-visible { outline: 2px solid #6366f1; outline-offset: -2px; }
[data-dt-dark] .comparison-status { color: #8b949e; }
[data-dt-dark] .comparison-error { color: #f87171; }
[data-dt-dark] .diff-details, [data-dt-dark] .diff-list button { border-color: #30363d; }
[data-dt-dark] .diff-list button:hover { background: #21262d; }
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
