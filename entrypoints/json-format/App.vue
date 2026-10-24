<script setup lang="ts">
import { selectAll } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { keymap } from '@codemirror/view';
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import ToastContainer from '../shared/ToastContainer.vue';
import { copyToClipboard } from '../shared/clipboard';
import DtButton from '../shared/components/DtButton.vue';
import DtEmptyState from '../shared/components/DtEmptyState.vue';
import DtPanel from '../shared/components/DtPanel.vue';
import DtSelect from '../shared/components/DtSelect.vue';
import DtSegmented from '../shared/config/DtSegmented.vue';
import { getConfig } from '../shared/tool-config';
import {
  attachFileDrop,
  type CodeEditor,
  createCodeEditor,
} from '../shared/lib/codemirror-editor';
import { createErrorDecoration } from '../shared/lib/codemirror-error-decoration';
import { showToast } from '../shared/use-toast';
import { getModEnterHint } from '../shared/format-shortcut';
import { buildDownloadName, downloadTextAsFile } from '../shared/download';
import { getPositionFromLineCol, parseJsonError } from '../shared/json-error-parser';
import { attachImagePreview } from '../tools/json-formatter/lib/image-preview';
import {
  formatJsonToHtml,
  type JsonPathResult,
  jsonPathQuery,
} from '../tools/json-formatter/lib/json-formatter';
import {
  activateMatch,
  clearHighlights,
  findMatches,
  stepIndex,
} from '../tools/json-formatter/lib/json-search';
import {
  deleteValueAtPath,
  getValueAtPath,
} from '../tools/json-formatter/lib/json-tree';
import {
  PATH_LANGUAGES,
  pathToLanguage,
} from '../tools/json-formatter/lib/json-path';
import { runFormatPipeline } from '../tools/json-formatter/lib/format-pipeline';
import {
  parseWithBigInt,
  safeStringify,
  uniDecode,
  uniEncode,
  urlDecode,
} from '../tools/json-formatter/lib/json-utils';

interface FormatConfig {
  indent: number;
  nestedEscapeParse: boolean;
  autoDecode: boolean;
  jsonLint: boolean;
}

const editorRef = ref<HTMLDivElement>();
const editorPanelRef = ref<InstanceType<typeof DtPanel>>();
const outputRef = ref<HTMLDivElement>();
let editor: CodeEditor | null = null;
let detachFileDrop: (() => void) | null = null;

// ─── Drag & Drop State ──────────────────────────────────
const isDragging = ref(false);

const outputHtml = ref('');
const rawOutput = ref('');
const isFormatted = ref(false);
const layoutMode = ref<'left-right' | 'up-down'>('left-right');
const showRaw = ref(false);
const modEnterHint = getModEnterHint();

// ─── Search State ──────────────────────────────────
const showSearch = ref(false);
const searchTerm = ref('');
const searchMatches = ref<HTMLElement[]>([]);
const currentMatchIndex = ref(0);
const searchInputRef = ref<HTMLInputElement>();

const sortMode = ref<number>(0);
const showJsonPathModal = ref(false);
const jsonPathQueryStr = ref('');
const jsonPathResults = ref<JsonPathResult[]>([]);
const jsonPathError = ref('');

const selectedPath = ref('');
const selectedLang = ref('javascript');
const selectedNodeValue = ref<unknown>(null);

// 路径复制的语言选项与翻译函数同源（json-path，ADR-0004 D3）
const languages = PATH_LANGUAGES;

const config = ref<FormatConfig>({
  indent: 2,
  nestedEscapeParse: true,
  autoDecode: false,
  jsonLint: true,
});

// Store parsed data for node operations (delete, edit)
let currentParsedData: unknown = null;
let formatTimer: ReturnType<typeof setTimeout> | null = null;
// 图片 URL 悬停预览的清理函数（bindOutputEvents 每次重挂前先解绑）
let detachImagePreview: (() => void) | null = null;

// 错误下划线 Decoration（shared/lib 扩展工厂，ADR-0004 D3）
const errorMarker = createErrorDecoration();

function validateJson(text: string): string | null {
  try {
    JSON.parse(text);
    if (editor) errorMarker.clear(editor.view);
    return null;
  } catch (e) {
    const jsonError = parseJsonError(e, text);
    if (jsonError && editor) {
      const pos = getPositionFromLineCol(text, jsonError.line, jsonError.column);
      errorMarker.mark(
        editor.view,
        pos,
        `第 ${jsonError.line} 行，第 ${jsonError.column} 列：${jsonError.message}`,
      );
    }
    return jsonError?.message || String(e);
  }
}

function getInitialText(): string {
  const params = new URLSearchParams(window.location.search);
  const text = params.get('text');
  return text ? decodeURIComponent(text) : '';
}

onMounted(async () => {
  const savedConfig = await getConfig<FormatConfig>('json-formatter');
  if (savedConfig) {
    config.value = { ...config.value, ...savedConfig };
  }

  if (editorRef.value) {
    editor = createCodeEditor({
      parent: editorRef.value,
      doc: getInitialText(),
      language: json(),
      extraExtensions: [
        keymap.of([
          {
            key: 'Mod-a',
            preventDefault: true,
            run: selectAll,
          },
        ]),
        errorMarker.extension,
      ],
      onModEnter: () => doFormat(),
      onChange: () => {
        validateJson(getRawText());
        if (formatTimer) clearTimeout(formatTimer);
        formatTimer = setTimeout(() => {
          const raw = getRawText();
          if (raw.trim()) {
            doFormat();
          }
        }, 300);
      },
    });
  }

  // 拖拽文件载入（目标为整个编辑器面板）
  const panelEl = editorPanelRef.value?.$el as HTMLElement | undefined;
  if (panelEl) {
    detachFileDrop = attachFileDrop(panelEl, {
      accept: (file) => {
        // 检查 MIME 类型：application/json 或 text/plain
        const isValidMime =
          file.type === 'application/json' ||
          file.type === 'text/plain' ||
          file.type === '';
        // 检查文件扩展名
        const hasJsonExtension = file.name.endsWith('.json');
        return isValidMime || hasJsonExtension
          ? null
          : '请拖入 JSON 文件或文本文件';
      },
      onText: (text, file) => {
        // 尝试解析为 JSON，验证内容是否有效
        try {
          JSON.parse(text);
        } catch {
          showToast('文件内容不是有效的 JSON', 'error');
          return;
        }
        editor?.setText(text);
        setTimeout(doFormat, 100);
        showToast(`已加载 ${file.name}`, 'success');
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
  if (formatTimer) clearTimeout(formatTimer);
  detachImagePreview?.();
  detachImagePreview = null;
});

function getRawText(): string {
  return editor?.getText() || '';
}

function setRawText(text: string) {
  editor?.setText(text);
}

async function doFormat() {
  const raw = getRawText();
  if (!raw.trim()) {
    showToast('请输入 JSON 内容', 'error');
    return;
  }

  // 数据编排收口于 format-pipeline（ADR-0004 D3）
  const result = await runFormatPipeline(
    raw,
    {
      indent: config.value.indent,
      autoDecode: config.value.autoDecode,
      nestedEscapeParse: config.value.nestedEscapeParse,
      sortMode: sortMode.value,
      jsonLint: config.value.jsonLint,
    },
    (progress) => {
      if (progress.percent === 100) {
        showToast('格式化完成', 'success');
      }
    },
  );

  if (!result.ok) {
    if (result.stage === 'lint') {
      showToast(`JSON 校验失败: ${result.message}`, 'error');
    } else if (result.stage === 'parse') {
      showToast(`JSON 解析错误: ${result.message}`, 'error');
    } else {
      const jsonError = parseJsonError(result.cause, raw);
      const errorMsg = jsonError
        ? `格式化失败 (第 ${jsonError.line} 行，第 ${jsonError.column} 列): ${jsonError.message}\n上下文: ${jsonError.context}`
        : `格式化失败: ${result.message}`;
      showToast(errorMsg, 'error');
      outputHtml.value = '';
      isFormatted.value = false;
    }
    return;
  }

  currentParsedData = result.parsed;
  rawOutput.value = result.formatted;
  outputHtml.value = result.html;
  isFormatted.value = true;
  showRaw.value = false;
  jsonPathResults.value = [];
  jsonPathError.value = '';
  selectedPath.value = '';
  selectedNodeValue.value = null;
  clearSearchHighlights();
  searchMatches.value = [];
  currentMatchIndex.value = 0;

  nextTick(() => bindOutputEvents());
}

function doCompress() {
  const raw = getRawText();
  if (!raw.trim()) return;

  try {
    const parsed = parseWithBigInt(raw);
    const compressed = safeStringify(parsed);
    setRawText(compressed);
    showToast('已压缩', 'success');
    isFormatted.value = false;
  } catch (e) {
    const jsonError = parseJsonError(e, raw);
    const errorMsg = jsonError
      ? `压缩失败 (第 ${jsonError.line} 行，第 ${jsonError.column} 列): ${jsonError.message}\n上下文: ${jsonError.context}`
      : `压缩失败: ${e instanceof Error ? e.message : String(e)}`;
    showToast(errorMsg, 'error');
  }
}

function doSort(mode: number) {
  sortMode.value = mode;

  // 添加排序模式反馈提示
  const sortModeNames: Record<number, string> = {
    0: '默认顺序',
    1: '升序排列',
    '-1': '降序排列',
  };
  showToast(`已切换为${sortModeNames[mode]}`, 'info');

  if (isFormatted.value) {
    doFormat();
  }
}

function doUniEncode() {
  const raw = getRawText();
  if (!raw.trim()) return;
  setRawText(uniEncode(raw));
}

function doUniDecode() {
  const raw = getRawText();
  if (!raw.trim()) return;
  setRawText(uniDecode(raw));
}

function doUrlDecode() {
  const raw = getRawText();
  if (!raw.trim()) return;
  setRawText(urlDecode(raw));
}

function toggleRawView() {
  showRaw.value = !showRaw.value;
}

// ─── Search in Output ──────────────────────────────────

function toggleSearch() {
  showSearch.value = !showSearch.value;
  if (showSearch.value) {
    nextTick(() => searchInputRef.value?.focus());
  } else {
    closeSearch();
  }
}

// DOM 操作收口于 json-search（ADR-0004 D3），此处仅维护 Vue 状态
function doSearch() {
  if (!searchTerm.value.trim()) {
    clearSearchHighlights();
    searchMatches.value = [];
    currentMatchIndex.value = 0;
    return;
  }

  const container = outputRef.value;
  if (!container) return;

  searchMatches.value = findMatches(container, searchTerm.value);
  currentMatchIndex.value = 0;

  if (searchMatches.value.length > 0) {
    scrollToMatch(0);
  }
}

function scrollToMatch(index: number) {
  if (searchMatches.value.length === 0) return;
  if (!searchMatches.value[index]) return;
  activateMatch(searchMatches.value, index);
  currentMatchIndex.value = index;
}

function goToPrevMatch() {
  if (searchMatches.value.length === 0) return;
  scrollToMatch(stepIndex(currentMatchIndex.value, -1, searchMatches.value.length));
}

function goToNextMatch() {
  if (searchMatches.value.length === 0) return;
  scrollToMatch(stepIndex(currentMatchIndex.value, 1, searchMatches.value.length));
}

function closeSearch() {
  clearSearchHighlights();
  searchTerm.value = '';
  searchMatches.value = [];
  currentMatchIndex.value = 0;
  showSearch.value = false;
}

function clearSearchHighlights() {
  const container = outputRef.value;
  if (!container) return;
  clearHighlights(container);
}

// ─── JSON Tree Interaction ──────────────────────────────────

function bindOutputEvents() {
  const container = outputRef.value;
  if (!container) return;

  // 图片 URL 悬停预览（重挂前先解绑，避免重复监听）
  detachImagePreview?.();
  detachImagePreview = attachImagePreview(container);

  container.onclick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;

    // 折叠/展开
    if (
      target.classList.contains('expand') ||
      target.classList.contains('ellipsis')
    ) {
      e.stopPropagation();
      let toggleTarget = target.parentElement;
      if (!toggleTarget) return;

      // 如果点击的是 .nested-value 内的元素，切换到父级容器
      if (toggleTarget.classList.contains('nested-value')) {
        toggleTarget = toggleTarget.parentElement;
        if (!toggleTarget) return;
      }

      toggleTarget.classList.toggle('collapsed');
      return;
    }

    // 忽略操作按钮点击
    if (target.closest('.boxOpt')) return;
    // 忽略链接点击
    if (target.tagName === 'A' && (target as HTMLAnchorElement).href) return;

    // 查找最近的 .item 元素
    const item = target.closest('#formattedJson .item') as HTMLElement | null;
    if (!item) return;

    const path = item.dataset.path || '$';
    e.stopPropagation();

    // 选中节点
    selectNode(item, path);
  };
}

function selectNode(item: HTMLElement, path: string) {
  // 清除之前选中
  const prev = outputRef.value?.querySelector('.x-selected');
  prev?.classList.remove('x-selected');
  const prevOpt = outputRef.value?.querySelector('.boxOpt');
  prevOpt?.remove();

  item.classList.add('x-selected');
  item.classList.add('fh-hover');
  selectedPath.value = path;
  selectedNodeValue.value = getValueAtPath(currentParsedData, path);

  // 创建操作按钮
  const optDiv = document.createElement('div');
  optDiv.className = 'boxOpt';
  optDiv.innerHTML = [
    `<a class="opt-copy" title="复制">复制</a> | `,
    `<a class="opt-download" title="下载">下载</a>`,
    path !== '$' ? ` | <a class="opt-delete" title="删除">删除</a>` : '',
  ].join('');

  optDiv.onclick = (e: MouseEvent) => {
    e.stopPropagation();
    const a = e.target as HTMLAnchorElement;
    if (a.classList.contains('opt-copy')) copyNodeValue(path);
    else if (a.classList.contains('opt-download')) downloadNodeValue(path);
    else if (a.classList.contains('opt-delete')) deleteNodeValue(path);
  };

  item.appendChild(optDiv);
}

async function copyNodeValue(path: string) {
  if (currentParsedData === null || currentParsedData === undefined) return;
  const value = getValueAtPath(currentParsedData, path);
  if (value === undefined) {
    showToast('未找到该节点的值', 'error');
    return;
  }
  const text =
    typeof value === 'object' && value !== null
      ? safeStringify(value, config.value.indent)
      : String(value);
  const ok = await copyToClipboard(text);
  showToast(ok ? '已复制节点内容' : '复制失败', ok ? 'success' : 'error');
}

function downloadNodeValue(path: string) {
  if (currentParsedData === null || currentParsedData === undefined) return;
  const value = getValueAtPath(currentParsedData, path);
  if (value === undefined) {
    showToast('未找到该节点的值', 'error');
    return;
  }
  const text =
    typeof value === 'object' && value !== null
      ? safeStringify(value, config.value.indent)
      : String(value);
  const keyName = path.split('.').pop()?.split('[')[0] || 'node';
  downloadTextAsFile(text, `${keyName}.json`);
  showToast('已下载节点文件', 'success');
}

// ─── 下载完整格式化结果 ──────────────────────────────────

function downloadOutput() {
  if (!isFormatted.value || !rawOutput.value) {
    showToast('暂无可下载的格式化结果', 'error');
    return;
  }
  downloadTextAsFile(
    rawOutput.value,
    buildDownloadName('formatted', 'json', new Date()),
  );
  showToast('已下载完整结果', 'success');
}

function deleteNodeValue(path: string) {
  if (path === '$') return;
  currentParsedData = deleteValueAtPath(currentParsedData, path);
  const html = formatJsonToHtml(
    currentParsedData,
    config.value.nestedEscapeParse,
  );
  rawOutput.value = safeStringify(currentParsedData, config.value.indent);
  outputHtml.value = html;
  selectedPath.value = '';
  selectedNodeValue.value = null;
  clearSearchHighlights();
  searchMatches.value = [];
  currentMatchIndex.value = 0;
  showToast('节点已删除', 'info');
  nextTick(() => bindOutputEvents());
}

// ─── JSON Path Navigation（翻译函数收口于 json-path，ADR-0004 D3） ──

const displayPath = computed(() => {
  if (!selectedPath.value) return '';
  return pathToLanguage(selectedPath.value, selectedLang.value);
});

async function copyDisplayPath() {
  if (displayPath.value) {
    const ok = await copyToClipboard(displayPath.value);
    showToast(ok ? '路径已复制' : '复制失败', ok ? 'success' : 'error');
  }
}

// ─── JSONPath Modal ─────────────────────────────────────────

function openJsonPathModal() {
  if (!isFormatted.value) {
    doFormat();
    if (!isFormatted.value) return;
  }
  showJsonPathModal.value = true;
  jsonPathQueryStr.value = '';
  jsonPathResults.value = [];
  jsonPathError.value = '';
}

function executeJsonPathQuery() {
  if (!jsonPathQueryStr.value.trim()) return;

  const raw = getRawText();
  try {
    const parsed = parseWithBigInt(raw);
    const results = jsonPathQuery(parsed, jsonPathQueryStr.value);
    if (results.length === 0) {
      jsonPathResults.value = [];
      jsonPathError.value = '未找到匹配的结果';
    } else {
      jsonPathResults.value = results;
      jsonPathError.value = '';
    }
  } catch (e) {
    jsonPathError.value = `查询失败: ${e instanceof Error ? e.message : String(e)}`;
    jsonPathResults.value = [];
  }
}

async function copyOutput() {
  const raw = getRawText();
  let text = raw;
  try {
    const parsed = parseWithBigInt(raw);
    text = safeStringify(parsed, config.value.indent);
  } catch {
    // 无法解析时复制原文
  }
  const ok = await copyToClipboard(text);
  showToast(ok ? '已复制到剪贴板' : '复制失败', ok ? 'success' : 'error');
}

function toggleLayout() {
  layoutMode.value =
    layoutMode.value === 'left-right' ? 'up-down' : 'left-right';
}

function expandAll() {
  const container = outputRef.value;
  if (!container) return;
  container.querySelectorAll('.collapsed').forEach((el) => {
    el.classList.remove('collapsed');
  });
  showToast('已全部展开', 'info');
}

function collapseAll() {
  const container = outputRef.value;
  if (!container) return;
  container.querySelectorAll('.item-object, .item-array').forEach((el) => {
    el.classList.add('collapsed');
  });
  showToast('已全部折叠', 'info');
}

// ─── Drag & Drop：由 attachFileDrop 挂载到编辑器面板（见 onMounted） ──

function loadExample() {
  const example = {
    BigIntSupported: '995815895020119788889',
    date: '20180322',
    url: 'https://example.com/?q=shadekit',
    img: 'https://example.com/demo-image.jpg',
    message: 'Success !',
    status: 200,
    city: '北京',
    count: 632,
    data: {
      shidu: '34%',
      pm25: 73,
      pm10: 91,
      quality: '良',
      wendu: '5',
      ganmao: '极少数敏感人群应减少户外活动',
      yesterday: {
        date: '21日星期三',
        sunrise: '06:19',
        high: '高温 11.0℃',
        low: '低温 1.0℃',
        sunset: '18:26',
        aqi: 85,
        fx: '南风',
        fl: '<3级',
        type: '多云',
        notice: '阴晴之间，谨防紫外线侵扰',
      },
      forecast: [
        {
          date: '22日星期四',
          sunrise: '06:17',
          high: '高温 17.0℃',
          low: '低温 1.0℃',
          sunset: '18:27',
          aqi: 98,
          fx: '西南风',
          fl: '<3级',
          type: '晴',
          notice: '愿你拥有比阳光明媚的心情',
        },
        {
          date: '23日星期五',
          sunrise: '06:16',
          high: '高温 18.0℃',
          low: '低温 5.0℃',
          sunset: '18:28',
          aqi: 118,
          fx: '无持续风向',
          fl: '<3级',
          type: '多云',
          notice: '阴晴之间，谨防紫外线侵扰',
        },
        {
          date: '24日星期六',
          sunrise: '06:14',
          high: '高温 21.0℃',
          low: '低温 7.0℃',
          sunset: '18:29',
          aqi: 52,
          fx: '西南风',
          fl: '<3级',
          type: '晴',
          notice: '愿你拥有比阳光明媚的心情',
        },
      ],
    },
  };
  setRawText(JSON.stringify(example, null, config.value.indent));
  // 不再单独提示「已加载示例数据」：updateListener 会防抖触发 doFormat，
  // 由「格式化完成」作为唯一结果提示，避免一次点击弹出多条 Toast
}
</script>

<template>
  <div class="page-wrapper" data-dt-root>
    <!-- 顶部工具栏 -->
    <div class="top-bar">
      <div class="brand">
        <div class="i-lucide-braces w-5 h-5" />
        <span>JSON 格式化</span>
      </div>
      <div class="toolbar-actions">
        <DtButton variant="primary" :title="`格式化 (${modEnterHint})`" @click="doFormat">
          格式化 <kbd class="ml-1.5 px-1 py-0.5 text-[11px] rounded bg-white/20 border border-solid border-white/35 text-white [font-family:inherit] [vertical-align:1px]">{{ modEnterHint }}</kbd>
        </DtButton>
        <DtButton variant="secondary" @click="doCompress">压缩</DtButton>
        <DtButton variant="secondary" @click="loadExample">示例</DtButton>
        <span class="divider" />
        <span class="toolbar-label">排序：</span>
        <DtSegmented
          :model-value="sortMode"
          :options="[
            { value: 0, label: '默认' },
            { value: 1, label: '升序' },
            { value: -1, label: '降序' },
          ]"
          @update:model-value="doSort"
        />
        <span class="divider" />
        <DtButton variant="ghost" icon title="Uni编码" @click="doUniEncode">Uni编码</DtButton>
        <DtButton variant="ghost" icon title="Uni解码" @click="doUniDecode">Uni解码</DtButton>
        <DtButton variant="ghost" icon title="URL解码" @click="doUrlDecode">URL解码</DtButton>
        <span class="divider" />
        <DtButton variant="ghost" icon @click="openJsonPathModal">JSONPath</DtButton>
        <DtButton icon @click="copyOutput">复制</DtButton>
        <DtButton v-if="isFormatted" variant="ghost" icon @click="toggleRawView">{{ showRaw ? '格式化' : '元数据' }}</DtButton>
        <DtButton variant="ghost" icon @click="toggleLayout">{{ layoutMode === 'left-right' ? '上下' : '左右' }}</DtButton>
      </div>
    </div>

    <!-- 编辑区与输出区 -->
    <div :class="['content-area', layoutMode === 'up-down' ? 'layout-up-down' : 'layout-left-right']">
      <DtPanel ref="editorPanelRef" class="editor-panel"
        title="编辑器"
      >
        <div v-if="isDragging" class="drop-overlay">
          <div class="i-lucide-upload w-5 h-5 mb-1" />
          释放以加载文件
        </div>
        <div ref="editorRef" class="code-editor"></div>
      </DtPanel>
      <DtPanel class="output-panel" title="输出">
        <template #actions>
          <template v-if="isFormatted">
            <DtButton size="sm" title="搜索" @click="toggleSearch">
              <div class="i-lucide-search w-3 h-3" />
            </DtButton>
            <DtButton size="sm" title="下载完整格式化结果" @click="downloadOutput">
              <div class="i-lucide-download w-3 h-3" />
            </DtButton>
            <DtButton size="sm" @click="expandAll">全部展开</DtButton>
            <DtButton size="sm" @click="collapseAll">全部折叠</DtButton>
          </template>
        </template>
        <!-- 搜索栏 -->
        <div v-if="showSearch" class="search-bar">
          <input
            ref="searchInputRef"
            v-model="searchTerm"
            @input="doSearch"
            @keyup.escape="closeSearch"
            placeholder="搜索..."
            class="search-input"
          />
          <span v-if="searchMatches.length > 0" class="search-count">
            {{ currentMatchIndex + 1 }}/{{ searchMatches.length }}
          </span>
          <DtButton size="sm" :disabled="searchMatches.length === 0" @click="goToPrevMatch">↑</DtButton>
          <DtButton size="sm" :disabled="searchMatches.length === 0" @click="goToNextMatch">↓</DtButton>
          <DtButton size="sm" title="关闭搜索" @click="closeSearch">
            <div class="i-lucide-x w-3 h-3" />
          </DtButton>
        </div>
        <!-- 原始 JSON -->
        <pre v-if="showRaw && rawOutput" class="raw-json">{{ rawOutput }}</pre>
        <!-- 树状可视化 -->
        <div
          ref="outputRef"
          class="output-content"
          v-else-if="outputHtml"
          v-html="outputHtml"
        ></div>
        <DtEmptyState v-else>
          <template #icon><div class="i-lucide-braces w-8 h-8" /></template>
          点击"格式化"查看结果
          <template #hint>粘贴 JSON 或拖入 .json 文件，{{ modEnterHint }} 格式化</template>
        </DtEmptyState>
      </DtPanel>
    </div>

    <!-- JSON 路径导航栏 -->
    <div v-if="selectedPath" class="path-bar">
      <span class="path-label">路径:</span>
      <DtSelect v-model="selectedLang" :options="languages" size="sm" />
      <code class="path-code">{{ displayPath }}</code>
      <DtButton icon size="sm" title="复制路径" @click="copyDisplayPath">复制</DtButton>
    </div>

    <!-- JSONPath 弹窗 -->
    <div v-if="showJsonPathModal" class="modal-overlay" @click="showJsonPathModal = false">
      <div class="modal-content" @click.stop>
        <div class="modal-header">
          <h4>JSONPath 查询</h4>
          <button class="modal-close" @click="showJsonPathModal = false">&times;</button>
        </div>
        <div class="modal-body">
          <div class="query-bar">
            <input
              type="text"
              v-model="jsonPathQueryStr"
              placeholder="JSONPath 表达式，如 $.data[*].name"
              class="query-input"
              @keyup.enter="executeJsonPathQuery"
            />
            <DtButton variant="primary" @click="executeJsonPathQuery">查询</DtButton>
          </div>
          <div v-if="jsonPathResults.length > 0" class="results">
            <p class="result-count">找到 {{ jsonPathResults.length }} 个结果</p>
            <div v-for="(result, index) in jsonPathResults" :key="index" class="result-item">
              <code class="result-path">{{ result.path }}</code>
              <pre class="result-value">{{ safeStringify(result.value, 2) }}</pre>
            </div>
          </div>
          <div v-else-if="jsonPathError" class="result-error">
            {{ jsonPathError }}
          </div>
        </div>
      </div>
    </div>

    <ToastContainer />
  </div>
</template>

<style scoped>
/* 排序切换已由 DtSegmented 统一承担 */

/* 内容区域 */
.output-content {
  flex: 1;
  overflow: auto;
  padding: 12px;
}

.raw-json {
  flex: 1;
  overflow: auto;
  padding: 12px;
  margin: 0;
  font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.5;
  background: transparent;
  white-space: pre-wrap;
  word-break: break-all;
}

/* 搜索栏 */
.search-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-bottom: 1px solid #e2e8f0;
  flex-shrink: 0;
}

[data-dt-dark] .search-bar {
  border-bottom-color: var(--dt-dark-border);
}

.search-input {
  flex: 1;
  padding: 4px 8px;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  font-size: 12px;
  outline: none;
  background: #fff;
  color: #0f172a;
  transition: border-color 0.2s ease;
}

.search-input:focus {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.1);
}

[data-dt-dark] .search-input {
  background: var(--dt-dark-base);
  border-color: var(--dt-dark-border);
  color: #f0f6fc;
}

[data-dt-dark] .search-input:focus {
  border-color: #818cf8;
  box-shadow: 0 0 0 2px rgba(129, 140, 248, 0.15);
}

.search-input::placeholder {
  color: #94a3b8;
}

[data-dt-dark] .search-input::placeholder {
  color: var(--dt-dark-text-muted);
}

.search-count {
  font-size: 13px;
  font-weight: 600;
  color: #6366f1;
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.1), rgba(59, 130, 246, 0.1));
  padding: 2px 10px;
  border-radius: 12px;
  border: 1px solid rgba(99, 102, 241, 0.2);
  white-space: nowrap;
  min-width: 50px;
  text-align: center;
}

[data-dt-dark] .search-count {
  color: #a5b4fc;
  background: linear-gradient(135deg, rgba(129, 140, 248, 0.15), rgba(96, 165, 250, 0.15));
  border-color: rgba(129, 140, 248, 0.3);
}

/* 路径导航栏 */
.path-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  background: #f1f5f9;
  border-top: 1px solid #e2e8f0;
  font-size: 12px;
  flex-shrink: 0;
}

[data-dt-dark] .path-bar {
  background: #161b22;
  border-color: var(--dt-dark-border);
}

.path-label {
  color: #64748b;
  font-weight: 500;
}

/* 路径语言下拉已由 DtSelect 统一承担 */

.path-code {
  flex: 1;
  padding: 3px 8px;
  background: #fff;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
  font-size: 12px;
  color: #3b82f6;
  overflow-x: auto;
  white-space: nowrap;
}

[data-dt-dark] .path-code {
  background: var(--dt-dark-surface-hover);
  border-color: var(--dt-dark-border);
}

/* Modal */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-content {
  background: white;
  border-radius: 12px;
  width: 90%;
  max-width: 600px;
  max-height: 80vh;
  overflow: auto;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.2);
}

[data-dt-dark] .modal-content {
  background: #161b22;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 20px;
  border-bottom: 1px solid #e2e8f0;
}

[data-dt-dark] .modal-header {
  border-color: var(--dt-dark-border);
}

.modal-header h4 {
  margin: 0;
  font-size: 15px;
}

.modal-close {
  border: none;
  background: none;
  font-size: 22px;
  cursor: pointer;
  color: #6b7280;
  padding: 0;
  line-height: 1;
}

.modal-body {
  padding: 16px 20px;
}

.query-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.query-input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 13px;
  font-family: var(--font-mono);
  background: #fff;
  color: #0f172a;
}

[data-dt-dark] .query-input {
  background: var(--dt-dark-base);
  border-color: var(--dt-dark-border);
  color: #f0f6fc;
}

.query-input::placeholder {
  color: #94a3b8;
}

[data-dt-dark] .query-input::placeholder {
  color: var(--dt-dark-text-muted);
}

.result-count {
  font-size: 12px;
  color: #059669;
  margin-bottom: 8px;
}

.result-item {
  margin-bottom: 10px;
}

.result-path {
  font-size: 12px;
  color: #3b82f6;
  display: block;
  margin-bottom: 4px;
}

.result-value {
  margin: 0;
  padding: 8px 10px;
  background: #f9fafb;
  border-radius: 6px;
  font-size: 12px;
  overflow: auto;
  max-height: 150px;
}

[data-dt-dark] .result-value {
  background: #161b22;
}

.result-error {
  color: #dc2626;
  font-size: 12px;
}
</style>

<style>
/* JSON tree styles (not scoped) */
#formattedJson {
  padding: 8px;
  font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre;
  user-select: text;
}

/* ── 基础节点布局 ── */
#formattedJson .item {
  position: relative;
  padding-top: 1px;
  padding-bottom: 1px;
}

#formattedJson .item-line {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
}

#formattedJson .item-block,
#formattedJson .item-object,
#formattedJson .item-array {
  padding-left: 20px;
  margin-left: -20px;
}

/* ── 缩进引导线 ── */
#formattedJson .kv-list {
  display: block;
  border-left: 1px dashed #bbb;
  margin-left: 2px;
  padding-left: 24px;
}

/* ── 折叠/展开 ── */
#formattedJson .collapsed > .kv-list { display: none; }
#formattedJson .collapsed > .ellipsis { display: inline; }

#formattedJson .expand {
  display: inline-block;
  width: 16px;
  height: 18px;
  cursor: pointer;
  position: absolute;
  left: -18px;
  top: 1px;
  z-index: 5;
  opacity: 0.4;
  user-select: none;
  transition: opacity 0.15s;
}

#formattedJson .expand:before {
  content: '\25BC';
  font-size: 9px;
  color: #888;
}

#formattedJson .expand:hover { opacity: 0.7; }
#formattedJson .expand:active { opacity: 0.9; }

#formattedJson .collapsed > .expand:before {
  transform: rotate(-90deg);
}

/* 数组元素的展开按钮定位 */
#formattedJson .item-array .item-array-element > .expand:first-child {
  left: -18px;
}

#formattedJson .item-object > .expand:first-child,
#formattedJson .item-array > .expand:first-child {
  left: 2px;
  top: 1px;
}

#formattedJson .ellipsis {
  display: none;
  cursor: pointer;
  color: #888;
  font-size: 12px;
  margin: 0 4px;
  font-weight: bold;
}

/* ── 折叠计数 ── */
#formattedJson .item-object.collapsed::after,
#formattedJson .item-array.collapsed::after {
  content: ' // ' attr(data-items) ' items';
  color: #999;
  font-style: normal;
  cursor: pointer;
}

/* ── 语法高亮配色（亮色） ── */
#formattedJson .key         { color: #881391; font-weight: 500; }
#formattedJson .quote       { color: #bbb; }
#formattedJson .colon       { color: #999; }
#formattedJson .comma       { color: #999; }
#formattedJson .brace       { color: #333; font-weight: 600; }
#formattedJson .string      { color: #0b7500; }
#formattedJson .string a    { color: #0000cc; text-decoration: underline; }
#formattedJson .string a:hover { color: #b00; }
#formattedJson .number      { color: #1c00cf; font-weight: 600; }
#formattedJson .bool        { color: #ff6b00; font-weight: 600; }
#formattedJson .null        { color: #808080; font-style: italic; }

/* ── hover / 选中态 ── */
#formattedJson .item-line:hover,
#formattedJson .item-block:hover > span,
#formattedJson .item-object:hover > span,
#formattedJson .item-array:hover > span {
  background: rgba(0, 0, 0, 0.035);
  border-radius: 2px;
}

#formattedJson .fh-hover {
  background: rgba(0, 0, 0, 0.025);
}

#formattedJson .x-selected {
  background: var(--selection-bg) !important;
  outline: 1px solid var(--selection-border);
  border-radius: 2px;
}

#formattedJson .x-selected > span {
  font-weight: 600;
}

/* ── 操作按钮 ── */
#formattedJson .boxOpt {
  position: absolute;
  right: 8px;
  top: 0;
  font-size: 12px;
  color: #999;
  z-index: 10;
  user-select: none;
  background: rgba(255, 255, 255, 0.9);
  border: 1px solid #e0e0e0;
  border-radius: 3px;
  padding: 1px 4px;
}

#formattedJson .boxOpt a {
  cursor: pointer;
  margin: 0 4px;
  color: #2196f3;
  text-decoration: none;
  font-weight: 500;
}

#formattedJson .boxOpt a:hover {
  color: #1565c0;
}

/* ── 嵌套 JSON 字符串 ── */
#formattedJson .string-json-nested { display: block; }

/* ── 搜索高亮 ── */
#formattedJson .search-match {
  background: rgba(255, 235, 59, 0.1);
  border-radius: 2px;
  transition: background 0.15s ease;
}

#formattedJson .search-match.current-match {
  background: rgba(255, 152, 0, 0.1);
  outline: 1px solid #ff9800;
}

/* ── 暗色模式 ── */
[data-dt-dark] #formattedJson .key         { color: #7ee787; }
[data-dt-dark] #formattedJson .quote       { color: #6e7681; }
[data-dt-dark] #formattedJson .colon       { color: #8b949e; }
[data-dt-dark] #formattedJson .comma       { color: #8b949e; }
[data-dt-dark] #formattedJson .brace       { color: #c9d1d9; font-weight: 600; }
[data-dt-dark] #formattedJson .string      { color: #a5d6ff; }
[data-dt-dark] #formattedJson .string a    { color: #58a6ff; }
[data-dt-dark] #formattedJson .string a:hover { color: #b00; }
[data-dt-dark] #formattedJson .number      { color: #79c0ff; }
[data-dt-dark] #formattedJson .bool        { color: #ff7b72; }
[data-dt-dark] #formattedJson .null        { color: #8b949e; }

[data-dt-dark] #formattedJson .kv-list     { border-left-color: var(--dt-dark-border); border-left-style: dashed; }
[data-dt-dark] #formattedJson .expand:before { color: #8b949e; }
[data-dt-dark] #formattedJson .ellipsis    { color: #484f58; font-weight: bold; font-size: 12px; }

[data-dt-dark] #formattedJson .item-line:hover,
[data-dt-dark] #formattedJson .item-block:hover > span,
[data-dt-dark] #formattedJson .item-object:hover > span,
[data-dt-dark] #formattedJson .item-array:hover > span {
  background: rgba(255, 255, 255, 0.03);
}

[data-dt-dark] #formattedJson .fh-hover { background: rgba(255, 255, 255, 0.02); }
[data-dt-dark] #formattedJson .x-selected {
  background: var(--selection-bg-dark) !important;
  outline-color: var(--selection-border-dark);
}

[data-dt-dark] #formattedJson .boxOpt {
  background: rgba(22, 27, 34, 0.9);
  border-color: var(--dt-dark-border);
  color: #8b949e;
}
[data-dt-dark] #formattedJson .boxOpt a { color: #58a6ff; }
[data-dt-dark] #formattedJson .boxOpt a:hover { color: #79c0ff; }

[data-dt-dark] #formattedJson .item-object.collapsed::after,
[data-dt-dark] #formattedJson .item-array.collapsed::after { color: #484f58; }

/* ── 搜索高亮（暗色） ── */
[data-dt-dark] #formattedJson .search-match {
  box-shadow: inset 0 0 0 1px rgba(250, 204, 21, 0.2);
  border-radius: 2px;
}

[data-dt-dark] #formattedJson .search-match.current-match {
  box-shadow: inset 0 0 0 1px rgba(251, 146, 60, 0.8), 0 0 8px rgba(251, 146, 60, 0.3);
  border-radius: 2px;
}

/* ── JSON 实时校验错误下划线 ── */
.cm-editor .json-error-underline {
  text-decoration: wavy underline red;
  text-decoration-skip-ink: none;
}

/* ── 图片 URL 悬停预览 ── */
.dt-img-preview {
  position: fixed;
  z-index: 2000;
  padding: 6px;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.15);
  pointer-events: none;
}

.dt-img-preview img {
  display: block;
  max-width: 320px;
  max-height: 240px;
  border-radius: 4px;
}

[data-dt-dark] .dt-img-preview {
  background: #161b22;
  border-color: var(--dt-dark-border);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}
</style>
