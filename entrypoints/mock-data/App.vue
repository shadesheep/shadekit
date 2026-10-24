<script setup lang="ts">
import { json } from '@codemirror/lang-json';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import DtButton from '../shared/components/DtButton.vue';
import DtEmptyState from '../shared/components/DtEmptyState.vue';
import DtPanel from '../shared/components/DtPanel.vue';
import DtSelect from '../shared/components/DtSelect.vue';
import DtSegmented from '../shared/config/DtSegmented.vue';
import ToastContainer from '../shared/ToastContainer.vue';
import { copyToClipboard } from '../shared/clipboard';
import { buildDownloadName, downloadTextAsFile } from '../shared/download';
import { getModEnterHint } from '../shared/format-shortcut';
import {
  type CodeEditor,
  createCodeEditor,
} from '../shared/lib/codemirror-editor';
import { getConfig, updateConfig } from '../shared/tool-config';
import { showToast } from '../shared/use-toast';
import {
  FORMAT_META,
  exportData,
  formatSize,
} from '../tools/mock-data/lib/exporters';
import {
  CATEGORIES,
  FIELD_TYPES,
  createField,
  defaultParams,
  generateRows,
  getFieldType,
  sanitizeFields,
} from '../tools/mock-data/lib/generators';
import { TEMPLATES } from '../tools/mock-data/lib/templates';
import type {
  CategoryId,
  FieldTypeDef,
  LeftMode,
  MockDataConfig,
  MockField,
  OutputFormat,
} from '../tools/mock-data/lib/types';

// ─── 状态 ──────────────────────────────────────────────────

const fields = ref<MockField[]>([]);
const count = ref(10);
const format = ref<OutputFormat>('json');
const tableName = ref('mock_data');
const autoGenerate = ref(true);
/** 字段类型面板当前分类（默认展示招投标分类） */
const activeCategory = ref<CategoryId>('tender');
/** 左侧面板模式：batch 批量字段配置 / quick 单值快速取数（ADR-0008：顶栏归属当前模式作用域） */
const leftMode = ref<LeftMode>('batch');
/** 类型搜索关键字（命中时跨全部类别过滤） */
const typeSearch = ref('');

const rawOutput = ref('');
const rowCount = ref(0);
const outputSize = ref('');
const templateId = ref('');
const configLoaded = ref(false);

const outputEditorRef = ref<HTMLDivElement>();
const fieldListRef = ref<HTMLDivElement>();

let editor: CodeEditor | null = null;
let generateTimer: ReturnType<typeof setTimeout> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

const modEnterHint = getModEnterHint();

const FORMATS = Object.entries(FORMAT_META).map(([value, meta]) => ({
  value: value as OutputFormat,
  label: meta.label,
}));

/** 类型按分类分组（字段行的类型下拉 optgroup 用） */
const TYPE_GROUPS = CATEGORIES.map((c) => ({
  ...c,
  types: FIELD_TYPES.filter((t) => t.category === c.id),
}));

/** 类型面板 chips：搜索时跨类别匹配（标签或类型 id），否则按当前分类 */
const paletteTypes = computed(() => {
  const q = typeSearch.value.trim().toLowerCase();
  if (q) {
    return FIELD_TYPES.filter(
      (t) =>
        t.label.toLowerCase().includes(q) || t.id.toLowerCase().includes(q),
    );
  }
  return FIELD_TYPES.filter((t) => t.category === activeCategory.value);
});

/** 非法字段（空键名 / 键名重复）的行 id 集合，用于行内红色高亮 */
const invalidKeys = computed(() => {
  const counts = new Map<string, number>();
  for (const f of fields.value) {
    const k = f.key.trim();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const bad = new Set<string>();
  for (const f of fields.value) {
    const k = f.key.trim();
    if (!k || (counts.get(k) ?? 0) > 1) bad.add(f.id);
  }
  return bad;
});

const hasOutput = computed(() => rawOutput.value.length > 0);

// ─── 结果视图（卡片 / 表格 / 源码） ──────────────────────────
// 面向测试人员：默认卡片视图按「中文字段名 + 值」逐行展示单条记录，
// 点击即复制；表格视图总览多条；源码视图保留 JSON/CSV/SQL/XML 原文。

type ViewMode = 'card' | 'table' | 'code';

const VIEW_MODES: Array<{ value: ViewMode; label: string }> = [
  { value: 'card', label: '卡片' },
  { value: 'table', label: '表格' },
  { value: 'code', label: '源码' },
];

const viewMode = ref<ViewMode>('card');
/** 最近一次生成的记录行（卡片/表格视图的数据源） */
const records = ref<Record<string, unknown>[]>([]);
/** 卡片视图当前记录下标 */
const cardIndex = ref(0);
/** 表格视图预览上限默认值（选项页可配，完整数据走源码视图/下载） */
const TABLE_PREVIEW_LIMIT_DEFAULT = 200;
/** 表格视图预览上限（选项页可配） */
const tablePreviewLimit = ref(TABLE_PREVIEW_LIMIT_DEFAULT);
/** 条数快捷预设（覆盖「只生成一条」的高频场景） */
const COUNT_PRESETS = [1, 10, 50, 100];

/** 输出列：按字段配置顺序的有效键名 */
const columns = computed(() =>
  fields.value.map((f) => f.key.trim()).filter(Boolean),
);

const fieldByKey = computed(
  () => new Map(fields.value.map((f) => [f.key, f])),
);

/** 列的中文标签（取字段类型的显示名，如「姓名」「项目编号」） */
function columnLabel(key: string): string {
  const field = fieldByKey.value.get(key);
  const def = field ? getFieldType(field.type) : undefined;
  return def?.label ?? key;
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

const tableRows = computed(() =>
  records.value.slice(0, tablePreviewLimit.value),
);

function recordValue(col: string): string {
  const rec = records.value[cardIndex.value];
  return rec ? cellText(rec[col]) : '';
}

async function copyCell(key: string, v: unknown) {
  const text = cellText(v);
  const ok = await copyToClipboard(text);
  if (ok) {
    const preview = text.length > 40 ? `${text.slice(0, 40)}…` : text;
    showToast(`已复制 ${columnLabel(key)}：${preview}`, 'success');
  } else {
    showToast('复制失败', 'error');
  }
}

function copyCurrentField(col: string) {
  const rec = records.value[cardIndex.value];
  if (!rec) return;
  void copyCell(col, rec[col]);
}

/** 复制当前卡片整条记录（格式化 JSON 对象） */
async function copyRecord() {
  const rec = records.value[cardIndex.value];
  if (!rec) return;
  const ok = await copyToClipboard(JSON.stringify(rec, null, 2));
  showToast(
    ok ? `已复制第 ${cardIndex.value + 1} 条记录` : '复制失败',
    ok ? 'success' : 'error',
  );
}

// ─── 字段行操作（批量模式） ──────────────────────────────────

function paramsOf(field: MockField) {
  return getFieldType(field.type)?.params ?? [];
}

function addField(typeId: string) {
  const field = createField(
    typeId,
    new Set(fields.value.map((f) => f.key)),
  );
  if (!field) return;
  fields.value.push(field);
  nextTick(() => {
    const el = fieldListRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

function removeField(index: number) {
  fields.value.splice(index, 1);
}

function moveField(index: number, dir: -1 | 1) {
  const target = index + dir;
  if (target < 0 || target >= fields.value.length) return;
  const arr = fields.value;
  [arr[index], arr[target]] = [arr[target], arr[index]];
}

/** 切换字段类型：参数重置为新类型默认值（键名保留，避免打断用户命名） */
function onTypeChange(field: MockField) {
  const def = getFieldType(field.type);
  if (def) field.params = defaultParams(def);
}

// ─── 快速取数（单值场景：只要一个身份证/项目名……） ────────────

const QUICK_COUNT_DEFAULT = 6;
/** 快速取数候选条数（选项页可配） */
const quickCount = ref(QUICK_COUNT_DEFAULT);
const quickType = ref<FieldTypeDef | null>(null);
const quickValues = ref<unknown[]>([]);
/** 候选值批次号：驱动右侧结果区重新挂载，形成「左侧点击 → 右侧刷新」动效反馈 */
const quickBatch = ref(0);

function quickText(v: unknown): string {
  return typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
}

/** 生成一批候选值：去重（低基数类型如性别不会铺满多条重复值） */
function quickGenerate(typeId?: string) {
  const def = typeId ? getFieldType(typeId) : quickType.value;
  if (!def) return;
  quickType.value = def;
  const target = Math.min(Math.max(Math.trunc(quickCount.value) || QUICK_COUNT_DEFAULT, 1), 20);
  const params = defaultParams(def);
  const seen = new Set<string>();
  const values: unknown[] = [];
  let attempts = 0;
  while (values.length < target && attempts < target * 5) {
    attempts += 1;
    const v = def.generate(params, { index: values.length });
    const text = quickText(v);
    if (seen.has(text)) continue;
    seen.add(text);
    values.push(v);
  }
  quickValues.value = values;
  quickBatch.value += 1;
}

async function copyQuickValue(v: unknown) {
  const text = quickText(v);
  const ok = await copyToClipboard(text);
  if (ok) {
    const preview = text.length > 40 ? `${text.slice(0, 40)}…` : text;
    showToast(`已复制：${preview}`, 'success');
  } else {
    showToast('复制失败', 'error');
  }
}

/** 把当前快速取数的类型加入批量字段列表并切回批量模式 */
function promoteQuickToFields() {
  if (!quickType.value) return;
  const label = quickType.value.label;
  addField(quickType.value.id);
  leftMode.value = 'batch';
  showToast(`已添加「${label}」到字段列表`, 'info');
}

/** 类型 chip 点击：批量模式加字段行，快速模式生成候选值 */
function onChipClick(typeId: string) {
  if (leftMode.value === 'quick') quickGenerate(typeId);
  else addField(typeId);
}

/** 结果面板标题：随模式与当前候选类型变化 */
const resultTitle = computed(() => {
  if (leftMode.value === 'batch') return '生成结果';
  return quickType.value ? `候选值 · ${quickType.value.label}` : '候选值';
});

// ─── 生成 / 输出 ────────────────────────────────────────────

function syncEditorLanguage() {
  // 语言切换收口于 Editor Factory 的内部 Compartment
  editor?.setLanguage(format.value === 'json' ? json() : []);
}

function clearOutput() {
  rawOutput.value = '';
  rowCount.value = 0;
  outputSize.value = '';
  records.value = [];
  cardIndex.value = 0;
  editor?.setText('');
}

function doGenerate(opts: { silent?: boolean } = {}) {
  if (!fields.value.length) {
    clearOutput();
    if (!opts.silent) showToast('请先添加字段', 'error');
    return;
  }
  if (invalidKeys.value.size) {
    if (!opts.silent) showToast('存在空字段名或重复字段名，请先修正', 'error');
    return;
  }
  const rows = generateRows(fields.value, count.value);
  const text = exportData(rows, format.value, tableName.value.trim());
  rawOutput.value = text;
  rowCount.value = rows.length;
  outputSize.value = formatSize(new Blob([text]).size);
  records.value = rows;
  cardIndex.value = 0;
  editor?.setText(text);
  syncEditorLanguage();
  if (!opts.silent) showToast(`已生成 ${rows.length} 条数据`, 'success');
}

async function copyResult() {
  if (!rawOutput.value) return;
  const ok = await copyToClipboard(rawOutput.value);
  showToast(ok ? '已复制到剪贴板' : '复制失败', ok ? 'success' : 'error');
}

function downloadResult() {
  if (!rawOutput.value) return;
  const meta = FORMAT_META[format.value];
  downloadTextAsFile(
    rawOutput.value,
    buildDownloadName('mock-data', meta.ext, new Date()),
    meta.mime,
  );
  showToast(`已下载 .${meta.ext} 文件`, 'success');
}

/** 清空（模式感知）：批量 = 清字段与结果；快速 = 清候选值并回到类型选择空态 */
function clearAll() {
  if (leftMode.value === 'quick') {
    quickType.value = null;
    quickValues.value = [];
    showToast('已清空候选值', 'info');
    return;
  }
  fields.value = [];
  clearOutput();
  showToast('已清空字段与结果', 'info');
}

// ─── 模板 ───────────────────────────────────────────────────

function applyTemplate(id: string, opts: { silent?: boolean } = {}) {
  const tpl = TEMPLATES.find((t) => t.id === id);
  if (!tpl) return;
  const keys = new Set<string>();
  const rows: MockField[] = [];
  for (const r of tpl.rows) {
    const f = createField(r.type, keys);
    if (!f) continue;
    f.key = r.key;
    keys.add(r.key);
    if (r.params) f.params = { ...f.params, ...r.params };
    rows.push(f);
  }
  fields.value = rows;
  leftMode.value = 'batch';
  // 下拉保留当前模板名，让用户知道字段列表来自哪个模板
  templateId.value = id;
  doGenerate({ silent: true });
  if (!opts.silent) showToast(`已加载「${tpl.name}」模板`, 'success');
}

function onTemplateSelect() {
  if (templateId.value) applyTemplate(templateId.value);
}

/** 重新应用当前显示的模板（同名模板下拉不会再触发 change，需独立入口） */
function reapplyTemplate() {
  if (templateId.value) applyTemplate(templateId.value);
}

// ─── 持久化 / 自动生成（防抖） ───────────────────────────────

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void updateConfig<MockDataConfig>('mock-data', {
      fields: JSON.parse(JSON.stringify(fields.value)) as MockField[],
      count: count.value,
      format: format.value,
      tableName: tableName.value,
      viewMode: viewMode.value,
      autoGenerate: autoGenerate.value,
      leftMode: leftMode.value,
      quickCount: quickCount.value,
    });
  }, 500);
}

function scheduleGenerate() {
  if (generateTimer) clearTimeout(generateTimer);
  generateTimer = setTimeout(() => doGenerate({ silent: true }), 400);
}

watch(
  [fields, count, format, tableName, autoGenerate],
  () => {
    if (!configLoaded.value) return;
    scheduleSave();
    // 保险：快速模式下顶栏批量控件虽已隐藏，仍防止任何残留路径触发不可见的批量重新生成
    if (autoGenerate.value && leftMode.value === 'batch') scheduleGenerate();
  },
  { deep: true },
);

// 视图切换只持久化、不重新生成（避免切视图导致数据被重新随机）
watch(viewMode, () => {
  if (configLoaded.value) scheduleSave();
});

// 模式切换与候选条数只持久化（候选值在点击类型/换一批时生成，不随配置自动刷新）
watch([leftMode, quickCount], () => {
  if (configLoaded.value) scheduleSave();
});

// ─── 快捷键：Ctrl/Cmd + Enter ────────────────────────────────
// 批量模式 = 生成数据；快速取数模式 = 换一批候选值（动作跟随当前模式）

function onGlobalKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    if (leftMode.value === 'quick') {
      if (quickType.value) quickGenerate();
    } else {
      doGenerate();
    }
  }
}

// ─── 生命周期 ───────────────────────────────────────────────

onMounted(async () => {
  const saved = await getConfig<MockDataConfig>('mock-data');
  if (saved) {
    fields.value = sanitizeFields(saved.fields);
    if (typeof saved.count === 'number' && saved.count >= 1) {
      count.value = Math.min(Math.trunc(saved.count), 1000);
    }
    if (saved.format && saved.format in FORMAT_META) {
      format.value = saved.format;
    }
    if (typeof saved.tableName === 'string' && saved.tableName.trim()) {
      tableName.value = saved.tableName;
    }
    if (typeof saved.autoGenerate === 'boolean') {
      autoGenerate.value = saved.autoGenerate;
    }
    if (saved.leftMode === 'batch' || saved.leftMode === 'quick') {
      leftMode.value = saved.leftMode;
    }
    if (
      saved.viewMode === 'card' ||
      saved.viewMode === 'table' ||
      saved.viewMode === 'code'
    ) {
      viewMode.value = saved.viewMode;
    }
    if (typeof saved.quickCount === 'number' && saved.quickCount >= 1) {
      quickCount.value = Math.min(Math.trunc(saved.quickCount), 20);
    }
    if (
      typeof saved.tablePreviewLimit === 'number' &&
      saved.tablePreviewLimit >= 10
    ) {
      tablePreviewLimit.value = Math.min(
        Math.trunc(saved.tablePreviewLimit),
        1000,
      );
    }
  }

  if (outputEditorRef.value) {
    editor = createCodeEditor({
      parent: outputEditorRef.value,
      readonly: true,
      language: format.value === 'json' ? json() : [],
    });
  }

  // 首次使用：静默载入用户信息模板，让首屏即有可玩内容
  if (!fields.value.length) applyTemplate('user', { silent: true });

  configLoaded.value = true;
  // 快速模式下不做首屏批量生成：结果区展示候选值，批量结果不可见（白跑且误导）
  if (leftMode.value === 'batch' && fields.value.length) {
    doGenerate({ silent: true });
  }
  window.addEventListener('keydown', onGlobalKeydown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', onGlobalKeydown);
  editor?.destroy();
  if (generateTimer) clearTimeout(generateTimer);
  if (saveTimer) clearTimeout(saveTimer);
});
</script>

<template>
  <div class="page-wrapper" data-dt-root>
    <!-- 顶部工具栏：主操作与其他工具页一致，收口在顶栏 -->
    <div class="top-bar">
      <div class="brand">
        <div class="i-lucide-dices w-5 h-5" />
        <span>模拟数据</span>
      </div>
      <div class="toolbar-actions">
        <!-- 主按钮模式感知（ADR-0008）：批量 = 生成；快速 = 换一批，与 ⌘⏎ 快捷键语义一致 -->
        <DtButton
          v-if="leftMode === 'batch'"
          variant="primary"
          :title="`生成 (${modEnterHint})`"
          @click="doGenerate()"
        >
          生成
          <kbd class="ml-1.5 px-1 py-0.5 text-[11px] rounded bg-white/20 border border-solid border-white/35 text-white [font-family:inherit] [vertical-align:1px]">{{ modEnterHint }}</kbd>
        </DtButton>
        <DtButton
          v-else
          variant="primary"
          :disabled="!quickType"
          :title="`换一批候选值 (${modEnterHint})`"
          @click="quickGenerate()"
        >
          换一批
          <kbd class="ml-1.5 px-1 py-0.5 text-[11px] rounded bg-white/20 border border-solid border-white/35 text-white [font-family:inherit] [vertical-align:1px]">{{ modEnterHint }}</kbd>
        </DtButton>
        <!-- 模板是批量配置的入口（applyTemplate 强制切回批量），快速模式下隐藏，避免无提示切模式 + 覆盖不可见字段 -->
        <DtSelect
          v-if="leftMode === 'batch'"
          v-model="templateId"
          :options="TEMPLATES.map((t) => ({ value: t.id, label: `${t.name} · ${t.hint}` }))"
          placeholder="载入模板…"
          title="载入预设模板（覆盖当前字段）"
          @change="onTemplateSelect"
        />
        <button
          v-if="leftMode === 'batch' && templateId"
          type="button"
          class="mini-btn"
          title="重新应用当前模板（覆盖字段修改）"
          @click="reapplyTemplate"
        >
          <div class="i-lucide-rotate-ccw w-3 h-3" />
        </button>
        <span class="divider" />
        <!-- 条数变形：批量 = 生成条数（1-1000）；快速 = 候选条数（1-20，与选项页同 key）。预设档仅批量有意义 -->
        <span class="toolbar-label">{{ leftMode === 'batch' ? '条数' : '候选' }}</span>
        <input
          v-if="leftMode === 'batch'"
          v-model.number="count"
          class="num-input"
          type="number"
          min="1"
          max="1000"
          title="生成条数（1-1000）"
        />
        <input
          v-else
          v-model.number="quickCount"
          class="num-input"
          type="number"
          min="1"
          max="20"
          title="候选条数（1-20）"
        />
        <span v-if="leftMode === 'batch'" class="count-presets" title="快速设置条数">
          <button
            v-for="n in COUNT_PRESETS"
            :key="n"
            type="button"
            class="preset-btn"
            :class="{ active: count === n }"
            @click="count = n"
          >
            {{ n }}
          </button>
        </span>
        <DtSegmented
          v-if="leftMode === 'batch'"
          v-model="format"
          :options="FORMATS"
          title="输出格式"
        />
        <input
          v-if="leftMode === 'batch' && format === 'sql'"
          v-model="tableName"
          class="table-input"
          type="text"
          placeholder="表名"
          title="SQL 表名"
        />
        <span class="divider" />
        <DtButton
          variant="ghost"
          icon
          :title="leftMode === 'batch' ? '清空字段与结果' : '清空候选值'"
          @click="clearAll"
        >清空</DtButton>
      </div>
    </div>

    <!-- 主区域 -->
    <div class="content-area layout-left-right">
      <!-- 左：配置（字段 / 快速取数类型选择 + 生成操作栏） -->
      <DtPanel
        class="fields-panel"
        :title="leftMode === 'batch' ? '字段配置' : '快速取数'"
      >
        <template #header-extra>
          <span v-if="leftMode === 'batch'" class="count-badge">
            {{ fields.length }} 个字段
          </span>
          <span v-else class="count-badge">结果在右侧，点击即复制</span>
        </template>

        <div class="fields-body">
          <!-- 模式切换 + 类型搜索 -->
          <div class="mode-bar">
            <DtSegmented
              v-model="leftMode"
              :options="[
                { value: 'batch', label: '批量生成' },
                { value: 'quick', label: '快速取数' },
              ]"
              class="mode-switch"
            />
            <input
              v-model="typeSearch"
              class="type-search"
              type="text"
              placeholder="搜索类型，如：身份证"
            />
          </div>

          <!-- 类型面板：分类页签 + 类型 chips -->
          <div class="palette">
            <div v-if="!typeSearch.trim()" class="palette-cats">
              <button
                v-for="c in CATEGORIES"
                :key="c.id"
                type="button"
                class="cat-btn"
                :class="{ active: activeCategory === c.id }"
                @click="activeCategory = c.id"
              >
                <div :class="[c.icon, 'w-3.5', 'h-3.5']" />
                {{ c.label }}
              </button>
            </div>
            <div class="palette-types">
              <button
                v-for="t in paletteTypes"
                :key="t.id"
                type="button"
                class="type-chip"
                :class="{ 'chip-active': leftMode === 'quick' && quickType?.id === t.id }"
                :title="
                  leftMode === 'quick'
                    ? `生成「${t.label}」候选值`
                    : `添加「${t.label}」字段`
                "
                @click="onChipClick(t.id)"
              >
                <div
                  :class="[
                    leftMode === 'quick'
                      ? 'i-lucide-zap'
                      : 'i-lucide-plus',
                    'w-3',
                    'h-3',
                  ]"
                />
                {{ t.label }}
              </button>
              <div v-if="!paletteTypes.length" class="chips-empty">
                没有匹配「{{ typeSearch.trim() }}」的类型
              </div>
            </div>
          </div>

          <!-- 批量模式：字段行列表 -->
          <div v-if="leftMode === 'batch'" ref="fieldListRef" class="field-list">
            <div
              v-for="(field, i) in fields"
              :key="field.id"
              class="field-row"
            >
              <div class="row-main">
                <span class="row-order">
                  <button
                    type="button"
                    class="icon-btn"
                    title="上移"
                    :disabled="i === 0"
                    @click="moveField(i, -1)"
                  >
                    <div class="i-lucide-chevron-up w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    class="icon-btn"
                    title="下移"
                    :disabled="i === fields.length - 1"
                    @click="moveField(i, 1)"
                  >
                    <div class="i-lucide-chevron-down w-3 h-3" />
                  </button>
                </span>
                <input
                  v-model="field.key"
                  class="key-input"
                  :class="{ invalid: invalidKeys.has(field.id) }"
                  type="text"
                  placeholder="字段名"
                  title="输出属性名"
                />
                <DtSelect
                  v-model="field.type"
                  class="row-type"
                  size="sm"
                  title="字段类型"
                  @change="onTypeChange(field)"
                >
                  <optgroup
                    v-for="g in TYPE_GROUPS"
                    :key="g.id"
                    :label="g.label"
                  >
                    <option
                      v-for="t in g.types"
                      :key="t.id"
                      :value="t.id"
                    >
                      {{ t.label }}
                    </option>
                  </optgroup>
                </DtSelect>
                <button
                  type="button"
                  class="icon-btn danger"
                  title="删除字段"
                  @click="removeField(i)"
                >
                  <div class="i-lucide-x w-3.5 h-3.5" />
                </button>
              </div>
              <div v-if="paramsOf(field).length" class="row-params">
                <label
                  v-for="p in paramsOf(field)"
                  :key="p.name"
                  class="param-item"
                >
                  <span class="param-label">{{ p.label }}</span>
                  <input
                    v-if="p.kind === 'number'"
                    v-model="field.params[p.name]"
                    class="param-input param-num"
                    type="number"
                    :min="p.min"
                    :max="p.max"
                  />
                  <DtSelect
                    v-else-if="p.kind === 'select'"
                    :model-value="String(field.params[p.name] ?? '')"
                    :options="p.options"
                    size="sm"
                    class="param-input param-select"
                    @update:model-value="field.params[p.name] = $event"
                  />
                  <input
                    v-else
                    v-model="field.params[p.name]"
                    class="param-input"
                    type="text"
                    :placeholder="p.placeholder"
                  />
                </label>
              </div>
            </div>
            <div v-if="!fields.length" class="fields-empty">
              从上方类型面板点击添加字段，或从顶部「载入模板」快速开始
            </div>
          </div>

          <!-- 快速取数模式：左侧仅做类型选择，结果统一在右侧 -->
          <div v-else class="quick-side-hint">
            <div class="i-lucide-mouse-pointer-click w-5 h-5" />
            <p>点击上方类型生成候选值<br />结果将显示在右侧面板，点击即可复制</p>
            <p v-if="quickType" class="quick-current">
              当前：<b>{{ quickType.label }}</b>
            </p>
          </div>

          <!-- 底部：自动生成开关（批量模式） -->
          <div v-if="leftMode === 'batch'" class="fields-footer">
            <label class="auto-toggle" title="字段或参数变化后自动重新生成">
              <input v-model="autoGenerate" type="checkbox" />
              <span>字段变化后自动生成</span>
            </label>
          </div>
        </div>
      </DtPanel>

      <!-- 右：结果（两种模式共用同一结果区，避免结果位置割裂） -->
      <DtPanel class="result-panel" :title="resultTitle">
        <template #header-extra>
          <template v-if="leftMode === 'batch'">
            <DtSegmented
              v-model="viewMode"
              :options="VIEW_MODES"
              size="sm"
              class="view-switch"
              title="结果展示方式"
            />
            <span v-if="hasOutput" class="count-badge">
              {{ rowCount }} 条 · {{ outputSize }}
            </span>
          </template>
          <span v-else-if="quickType" class="count-badge">
            {{ quickValues.length }} 条候选
          </span>
        </template>
        <template #actions>
          <template v-if="leftMode === 'batch'">
            <DtButton
              size="sm"
              title="复制结果"
              :disabled="!hasOutput"
              @click="copyResult"
            >
              <div class="i-lucide-copy w-3 h-3" />
            </DtButton>
            <DtButton
              size="sm"
              title="下载结果文件"
              :disabled="!hasOutput"
              @click="downloadResult"
            >
              <div class="i-lucide-download w-3 h-3" />
            </DtButton>
          </template>
          <template v-else>
            <DtButton
              size="sm"
              title="换一批候选值"
              :disabled="!quickType"
              @click="quickGenerate()"
            >
              <div class="i-lucide-refresh-cw w-3 h-3" />
              换一批
            </DtButton>
            <DtButton
              size="sm"
              title="把该类型加入批量字段列表"
              :disabled="!quickType"
              @click="promoteQuickToFields"
            >
              <div class="i-lucide-list-plus w-3 h-3" />
              加入字段
            </DtButton>
          </template>
        </template>

        <!--
          批量模式结果：卡片 / 表格 / 源码。
          注意：必须用 v-show 而非 v-if —— CodeMirror 是命令式 DOM,
          只在 onMounted 挂载进 .code-editor 一次;v-if 卸载（如切到快速取数）
          会把编辑器 DOM 一并销毁,切回后容器是空壳,源码视图空白（导出不受影响,
          因为导出走 rawOutput)。
        -->
        <div v-show="leftMode === 'batch'" class="output-body">
          <div
            v-show="viewMode === 'code'"
            ref="outputEditorRef"
            class="code-editor"
          />

          <!-- 卡片视图：单条记录的「中文字段名 + 值」列表，点击复制 -->
          <div v-if="viewMode === 'card' && hasOutput" class="data-view">
            <div v-if="records.length > 1" class="record-nav">
              <button
                type="button"
                class="nav-btn"
                title="上一条"
                :disabled="cardIndex === 0"
                @click="cardIndex--"
              >
                <div class="i-lucide-chevron-left w-3.5 h-3.5" />
              </button>
              <span class="nav-text">
                第 {{ cardIndex + 1 }} / {{ records.length }} 条
              </span>
              <button
                type="button"
                class="nav-btn"
                title="下一条"
                :disabled="cardIndex >= records.length - 1"
                @click="cardIndex++"
              >
                <div class="i-lucide-chevron-right w-3.5 h-3.5" />
              </button>
            </div>
            <div class="record-fields">
              <button
                v-for="col in columns"
                :key="col"
                type="button"
                class="rf-row"
                title="点击复制该值"
                @click="copyCurrentField(col)"
              >
                <span class="rf-label">
                  {{ columnLabel(col) }}
                  <span class="rf-key">{{ col }}</span>
                </span>
                <span class="rf-value">{{ recordValue(col) }}</span>
                <div class="i-lucide-copy w-3 h-3 rf-icon" />
              </button>
            </div>
            <div class="record-actions">
              <button
                type="button"
                class="quick-action-btn"
                @click="copyRecord"
              >
                <div class="i-lucide-braces w-3 h-3" />
                复制本条 JSON
              </button>
            </div>
          </div>

          <!-- 表格视图：多条记录总览，点单元格复制 -->
          <div
            v-else-if="viewMode === 'table' && hasOutput"
            class="data-view table-wrap"
          >
            <table class="data-table">
              <thead>
                <tr>
                  <th class="idx-col">#</th>
                  <th v-for="col in columns" :key="col">
                    <div class="th-label">{{ columnLabel(col) }}</div>
                    <div class="th-key">{{ col }}</div>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, ri) in tableRows" :key="ri">
                  <td class="idx-col">{{ ri + 1 }}</td>
                  <td
                    v-for="col in columns"
                    :key="col"
                    class="data-cell"
                    title="点击复制该值"
                    @click="copyCell(col, row[col])"
                  >
                    {{ cellText(row[col]) }}
                  </td>
                </tr>
              </tbody>
            </table>
            <div
              v-if="records.length > tablePreviewLimit"
              class="table-limit-hint"
            >
              仅预览前 {{ tablePreviewLimit }} 条，完整数据请切换到「源码」视图或下载文件
            </div>
          </div>

          <DtEmptyState v-if="!hasOutput" overlay>
            <template #icon>
              <div class="i-lucide-dices w-8 h-8" />
            </template>
            添加字段后自动生成，或按 {{ modEnterHint }} 手动生成
            <template #actions>
              <DtButton
                variant="primary"
                size="sm"
                @click="applyTemplate('user')"
              >
                载入用户信息模板
              </DtButton>
            </template>
          </DtEmptyState>
        </div>

        <!-- 快速取数结果：候选值大列表，点击复制（v-show 原因见上方批量结果区注释） -->
        <div v-show="leftMode === 'quick'" class="output-body">
          <div v-if="quickType" :key="quickBatch" class="data-view quick-view">
            <button
              v-for="(v, i) in quickValues"
              :key="i"
              type="button"
              class="quick-value"
              title="点击复制"
              @click="copyQuickValue(v)"
            >
              <span class="qv-text">{{ quickText(v) }}</span>
              <div class="i-lucide-copy w-3.5 h-3.5 qv-icon" />
            </button>
          </div>
          <DtEmptyState v-else overlay>
            <template #icon>
              <div class="i-lucide-zap w-8 h-8" />
            </template>
            从左侧点击一个类型，立即生成候选值
          </DtEmptyState>
        </div>
      </DtPanel>
    </div>

    <ToastContainer />
  </div>
</template>

<style scoped>
/* ===== 工具栏控件 ===== */
/* 下拉/分段控件已收口至 DtSelect / DtSegmented（共享组件） */

.table-input {
  width: 110px;
  padding: 5px 10px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  background: #fff;
  color: #374151;
  outline: none;
  transition: all 0.2s ease;
}

.table-input:hover {
  border-color: #cbd5e1;
}

.table-input:focus {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
}

[data-dt-dark] .table-input {
  background: var(--dt-dark-surface-hover);
  border-color: var(--dt-dark-border);
  color: #c9d1d9;
}

.num-input {
  width: 64px;
  padding: 5px 8px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  font-size: 12px;
  color: #374151;
  background: #fff;
  outline: none;
  transition: all 0.2s ease;
}

.num-input:focus {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
}

[data-dt-dark] .num-input {
  background: var(--dt-dark-surface-hover);
  border-color: var(--dt-dark-border);
  color: #c9d1d9;
}

/* ===== 布局 ===== */
.fields-panel {
  flex: 0 0 46%;
  min-width: 380px;
}

.result-panel {
  flex: 1;
  min-width: 0;
}

.fields-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.count-badge {
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 9999px;
  background: #eef2ff;
  color: #6366f1;
  font-weight: 600;
}

[data-dt-dark] .count-badge {
  background: #1e1b4b;
  color: #a5b4fc;
}

/* ===== 模式切换 + 搜索 ===== */
.mode-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px 0;
  flex-shrink: 0;
}

.mode-switch {
  flex-shrink: 0;
}

.type-search {
  flex: 1;
  min-width: 0;
  padding: 4px 10px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  font-size: 12px;
  color: #374151;
  background: #fff;
  outline: none;
  transition: all 0.15s ease;
}

.type-search:focus {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.12);
}

[data-dt-dark] .type-search {
  background: var(--dt-dark-surface-hover);
  border-color: var(--dt-dark-border);
  color: #c9d1d9;
}

/* ===== 类型面板 ===== */
.palette {
  padding: 12px 16px 8px;
  border-bottom: 1px solid #e2e8f0;
  flex-shrink: 0;
}

[data-dt-dark] .palette {
  border-color: var(--dt-dark-border);
}

.palette-cats {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

/* 分类筛选 chip：描边 + 淡色激活（不用渐变填充，避免与切换器混淆） */
.cat-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 9px;
  font-size: 12px;
  font-weight: 500;
  border: 1px solid #e2e8f0;
  border-radius: 9999px;
  background: #fff;
  color: #64748b;
  cursor: pointer;
  transition: all 0.15s ease;
}

.cat-btn:hover {
  border-color: #a5b4fc;
  color: #6366f1;
}

.cat-btn.active {
  background: #eef2ff;
  border-color: #6366f1;
  color: #6366f1;
}

[data-dt-dark] .cat-btn {
  background: transparent;
  border-color: var(--dt-dark-border);
  color: #8b949e;
}

[data-dt-dark] .cat-btn:hover {
  border-color: #818cf8;
  color: #a5b4fc;
}

[data-dt-dark] .cat-btn.active {
  background: rgba(99, 102, 241, 0.16);
  border-color: #818cf8;
  color: #a5b4fc;
}

.palette-types {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  /* 顶部留 2px 缓冲：chip hover 上浮 -1px 时不被 overflow 裁掉上边框 */
  padding-top: 2px;
  max-height: 110px;
  overflow-y: auto;
}

.chips-empty {
  font-size: 12px;
  color: #94a3b8;
  padding: 4px 2px;
}

[data-dt-dark] .chips-empty {
  color: #6e7681;
}

.type-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 3px 9px;
  font-size: 12px;
  border: 1px solid #e2e8f0;
  border-radius: 9999px;
  background: #fff;
  color: #374151;
  cursor: pointer;
  transition: all 0.15s ease;
}

.type-chip:hover {
  border-color: #6366f1;
  color: #6366f1;
  background: rgba(99, 102, 241, 0.06);
  transform: translateY(-1px);
}

.type-chip:active {
  transform: scale(0.96);
}

/* 快速取数模式下当前选中类型的 chip 高亮 */
.type-chip.chip-active {
  border-color: #6366f1;
  color: #6366f1;
  background: rgba(99, 102, 241, 0.1);
  font-weight: 600;
}

[data-dt-dark] .type-chip {
  background: var(--dt-dark-surface-hover);
  border-color: var(--dt-dark-border);
  color: #c9d1d9;
}

[data-dt-dark] .type-chip:hover {
  border-color: #818cf8;
  color: #a5b4fc;
  background: rgba(99, 102, 241, 0.12);
}

[data-dt-dark] .type-chip.chip-active {
  border-color: #818cf8;
  color: #a5b4fc;
  background: rgba(99, 102, 241, 0.16);
}

/* ===== 快速取数左侧提示 ===== */
.quick-side-hint {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px 16px;
  text-align: center;
  font-size: 12px;
  color: #94a3b8;
}

.quick-side-hint p {
  margin: 0;
  line-height: 1.7;
}

.quick-current {
  color: #6366f1;
}

[data-dt-dark] .quick-side-hint {
  color: #6e7681;
}

[data-dt-dark] .quick-current {
  color: #a5b4fc;
}

/* ===== 模板重新应用小按钮 ===== */
.mini-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 5px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  background: #fff;
  color: #64748b;
  cursor: pointer;
  transition: all 0.15s ease;
}

.mini-btn:hover {
  border-color: #6366f1;
  color: #6366f1;
}

.mini-btn:active {
  transform: rotate(-90deg);
}

[data-dt-dark] .mini-btn {
  background: var(--dt-dark-surface-hover);
  border-color: var(--dt-dark-border);
  color: #8b949e;
}

[data-dt-dark] .mini-btn:hover {
  border-color: #818cf8;
  color: #a5b4fc;
}

/* ===== 条数预设 ===== */
.count-presets {
  display: inline-flex;
  gap: 2px;
}

.preset-btn {
  border: 1px solid var(--border);
  background: #fff;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  padding: 3px 7px;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.preset-btn:first-child {
  border-radius: var(--radius-md) 0 0 var(--radius-md);
}

.preset-btn:last-child {
  border-radius: 0 var(--radius-md) var(--radius-md) 0;
}

.preset-btn + .preset-btn {
  margin-left: -1px;
}

.preset-btn:hover {
  color: var(--primary-start);
  border-color: var(--primary-start);
  position: relative;
  z-index: 1;
}

.preset-btn.active {
  background: linear-gradient(135deg, var(--primary-start), var(--primary-end));
  border-color: transparent;
  color: #fff;
  position: relative;
  z-index: 1;
}

[data-dt-dark] .preset-btn {
  background: var(--dt-dark-surface-hover);
  border-color: var(--dt-dark-border);
  color: #8b949e;
}

[data-dt-dark] .preset-btn.active {
  color: #fff;
}

/* ===== 结果视图切换 ===== */
.view-switch {
  margin-left: 4px;
}

/* ===== 数据视图（卡片/表格/快速候选共用容器） ===== */
.data-view {
  flex: 1;
  overflow: auto;
  min-height: 0;
  padding: 12px 14px;
}

/* ---- 卡片视图 ---- */
.record-nav {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-bottom: 10px;
}

.nav-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  background: #fff;
  color: #64748b;
  cursor: pointer;
  transition: all 0.15s ease;
}

.nav-btn:hover:not(:disabled) {
  border-color: #6366f1;
  color: #6366f1;
}

.nav-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

[data-dt-dark] .nav-btn {
  background: var(--dt-dark-surface-hover);
  border-color: var(--dt-dark-border);
  color: #8b949e;
}

.nav-text {
  font-size: 12px;
  color: #64748b;
  min-width: 88px;
  text-align: center;
}

[data-dt-dark] .nav-text {
  color: #8b949e;
}

.record-fields {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.rf-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
  text-align: left;
  transition: all 0.15s ease;
}

.rf-row:hover {
  border-color: #6366f1;
  background: rgba(99, 102, 241, 0.04);
}

.rf-row:active {
  transform: scale(0.995);
}

[data-dt-dark] .rf-row {
  background: var(--dt-dark-base);
  border-color: var(--dt-dark-border);
}

[data-dt-dark] .rf-row:hover {
  border-color: #818cf8;
  background: rgba(99, 102, 241, 0.08);
}

.rf-label {
  flex: 0 0 132px;
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: #334155;
  white-space: nowrap;
  overflow: hidden;
}

[data-dt-dark] .rf-label {
  color: #c9d1d9;
}

.rf-key {
  font-size: 12px;
  font-weight: 400;
  font-family: var(--font-mono);
  color: #94a3b8;
  overflow: hidden;
  text-overflow: ellipsis;
}

[data-dt-dark] .rf-key {
  color: #6e7681;
}

.rf-value {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  font-family: var(--font-mono);
  color: #0f172a;
  word-break: break-all;
  user-select: none;
}

[data-dt-dark] .rf-value {
  color: #e6edf3;
}

.rf-icon {
  flex-shrink: 0;
  color: #94a3b8;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.rf-row:hover .rf-icon {
  opacity: 1;
}

.record-actions {
  display: flex;
  justify-content: center;
  margin-top: 12px;
}

.quick-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  font-size: 12px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  background: #fff;
  color: #64748b;
  cursor: pointer;
  transition: all 0.15s ease;
}

.quick-action-btn:hover {
  border-color: #6366f1;
  color: #6366f1;
}

[data-dt-dark] .quick-action-btn {
  background: var(--dt-dark-surface-hover);
  border-color: var(--dt-dark-border);
  color: #8b949e;
}

[data-dt-dark] .quick-action-btn:hover {
  border-color: #818cf8;
  color: #a5b4fc;
}

/* ---- 表格视图 ---- */
.table-wrap {
  padding: 0;
}

.data-table {
  border-collapse: separate;
  border-spacing: 0;
  width: 100%;
  font-size: 12px;
}

.data-table thead th {
  position: sticky;
  top: 0;
  z-index: 2;
  background: #f8fafc;
  border-bottom: 1px solid #e2e8f0;
  padding: 7px 10px;
  text-align: left;
  font-weight: 600;
  color: #334155;
  white-space: nowrap;
}

[data-dt-dark] .data-table thead th {
  background: var(--dt-dark-surface-hover);
  border-color: var(--dt-dark-border);
  color: #c9d1d9;
}

.th-label {
  font-size: 12px;
}

.th-key {
  font-size: 12px;
  font-weight: 400;
  font-family: var(--font-mono);
  color: #94a3b8;
}

[data-dt-dark] .th-key {
  color: #6e7681;
}

.idx-col {
  width: 42px;
  min-width: 42px;
  text-align: right !important;
  color: #94a3b8;
  font-family: var(--font-mono);
  font-size: 12px;
  background: #f8fafc;
}

[data-dt-dark] .idx-col {
  background: var(--dt-dark-base);
  color: #6e7681;
}

.data-table tbody td {
  border-bottom: 1px solid #f1f5f9;
  padding: 6px 10px;
  max-width: 260px;
}

[data-dt-dark] .data-table tbody td {
  border-color: var(--dt-dark-border);
}

.data-table tbody tr:hover .data-cell {
  background: rgba(99, 102, 241, 0.04);
}

[data-dt-dark] .data-table tbody tr:hover .data-cell {
  background: rgba(99, 102, 241, 0.08);
}

.data-cell {
  font-family: var(--font-mono);
  color: #0f172a;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

[data-dt-dark] .data-cell {
  color: #c9d1d9;
}

.table-limit-hint {
  padding: 10px;
  text-align: center;
  font-size: 12px;
  color: #94a3b8;
}

[data-dt-dark] .table-limit-hint {
  color: #6e7681;
}

/* ---- 快速取数候选值（右侧结果区） ---- */
.quick-view {
  display: flex;
  flex-direction: column;
  gap: 8px;
  animation: quick-in 0.18s ease-out;
}

@keyframes quick-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.quick-value {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 12px 14px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
  text-align: left;
  transition: all 0.15s ease;
}

.quick-value:hover {
  border-color: #6366f1;
  background: rgba(99, 102, 241, 0.04);
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(99, 102, 241, 0.1);
}

.quick-value:active {
  transform: scale(0.99);
}

[data-dt-dark] .quick-value {
  background: var(--dt-dark-base);
  border-color: var(--dt-dark-border);
}

[data-dt-dark] .quick-value:hover {
  border-color: #818cf8;
  background: rgba(99, 102, 241, 0.08);
}

.qv-text {
  font-family: var(--font-mono);
  font-size: 13px;
  color: #0f172a;
  word-break: break-all;
  user-select: none;
}

[data-dt-dark] .qv-text {
  color: #e6edf3;
}

.qv-icon {
  flex-shrink: 0;
  color: #94a3b8;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.quick-value:hover .qv-icon {
  opacity: 1;
}

/* ===== 字段行 ===== */
.field-list {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}

.field-row {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 6px 8px;
  background: #fff;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
  flex-shrink: 0;
}

.field-row:hover {
  border-color: #c7d2fe;
  box-shadow: 0 1px 3px rgba(99, 102, 241, 0.08);
}

[data-dt-dark] .field-row {
  background: var(--dt-dark-base);
  border-color: var(--dt-dark-border);
}

[data-dt-dark] .field-row:hover {
  border-color: #4338ca;
}

.row-main {
  display: flex;
  align-items: center;
  gap: 6px;
}

.row-order {
  display: inline-flex;
  flex-direction: column;
  gap: 1px;
  flex-shrink: 0;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #94a3b8;
  cursor: pointer;
  transition: all 0.15s ease;
}

.icon-btn:hover {
  background: #f1f5f9;
  color: #475569;
}

.icon-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.icon-btn.danger:hover {
  background: #fef2f2;
  color: #dc2626;
}

[data-dt-dark] .icon-btn {
  color: #6e7681;
}

[data-dt-dark] .icon-btn:hover {
  background: var(--dt-dark-surface-hover);
  color: #c9d1d9;
}

[data-dt-dark] .icon-btn.danger:hover {
  background: rgba(220, 38, 38, 0.15);
  color: #f87171;
}

.key-input {
  flex: 0 0 118px;
  padding: 4px 8px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  font-size: 12px;
  font-family: var(--font-mono);
  color: #0f172a;
  background: #fff;
  outline: none;
  transition: all 0.15s ease;
}

.key-input:focus {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
}

.key-input.invalid {
  border-color: #dc2626;
  background: #fef2f2;
}

[data-dt-dark] .key-input {
  background: var(--dt-dark-surface-hover);
  border-color: var(--dt-dark-border);
  color: #c9d1d9;
}

[data-dt-dark] .key-input.invalid {
  border-color: #f87171;
  background: rgba(220, 38, 38, 0.12);
}

.row-type {
  flex: 1;
  min-width: 0;
  max-width: none;
}

.row-params {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  margin-top: 6px;
  padding: 6px 2px 2px 26px;
  border-top: 1px dashed #e2e8f0;
}

[data-dt-dark] .row-params {
  border-color: var(--dt-dark-border);
}

.param-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

.param-label {
  font-size: 12px;
  color: #94a3b8;
  white-space: nowrap;
}

[data-dt-dark] .param-label {
  color: #6e7681;
}

.param-input {
  width: 130px;
  padding: 3px 7px;
  border: 1px solid #e2e8f0;
  border-radius: 5px;
  font-size: 12px;
  color: #374151;
  background: #fff;
  outline: none;
  transition: all 0.15s ease;
}

.param-input:focus {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.12);
}

.param-num {
  width: 72px;
}

/* 下拉参数复用 .param-input 宽度；视觉样式由 DtSelect 统一承担 */
.param-select {
  width: 130px;
  max-width: 130px;
}

[data-dt-dark] .param-input {
  background: var(--dt-dark-surface-hover);
  border-color: var(--dt-dark-border);
  color: #c9d1d9;
}

.fields-empty {
  padding: 24px 12px;
  text-align: center;
  font-size: 12px;
  color: #94a3b8;
}

[data-dt-dark] .fields-empty {
  color: #6e7681;
}

/* ===== 底部开关 ===== */
.fields-footer {
  flex-shrink: 0;
  padding: 8px 12px;
  border-top: 1px solid #e2e8f0;
}

[data-dt-dark] .fields-footer {
  border-color: var(--dt-dark-border);
}

.auto-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #64748b;
  cursor: pointer;
  flex-shrink: 0;
}

.auto-toggle input {
  accent-color: #6366f1;
}

[data-dt-dark] .auto-toggle {
  color: #8b949e;
}

/* ===== 输出区 ===== */
.output-body {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
</style>
