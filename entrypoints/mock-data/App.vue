<script setup lang="ts">
import { json } from "@codemirror/lang-json";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import DtButton from "../shared/components/DtButton.vue";
import DtEmptyState from "../shared/components/DtEmptyState.vue";
import DtPanel from "../shared/components/DtPanel.vue";
import DtSelect from "../shared/components/DtSelect.vue";
import DtSegmented from "../shared/config/DtSegmented.vue";
import ToastContainer from "../shared/ToastContainer.vue";
import { copyToClipboard } from "../shared/clipboard";
import { buildDownloadName, downloadBlobAsFile } from "../shared/download";
import { getModEnterHint } from "../shared/format-shortcut";
import {
  type CodeEditor,
  createCodeEditor,
} from "../shared/lib/codemirror-editor";
import { getConfig, updateConfig } from "../shared/tool-config";
import { showToast } from "../shared/use-toast";
import {
  FORMAT_META,
  exportData,
  exportDataChunks,
  formatSize,
} from "../tools/mock-data/lib/exporters";
import {
  CATEGORIES,
  FIELD_TYPES,
  MAX_ROWS,
  createField,
  fieldDependencyErrors,
  generateRowBatches,
  generateRows,
  getFieldType,
  sanitizeFields,
} from "../tools/mock-data/lib/generators";
import { TEMPLATES, type MockTemplate } from "../tools/mock-data/lib/templates";
import type {
  CategoryId,
  ExportOptions,
  FieldTypeDef,
  LeftMode,
  LocaleId,
  MockDataConfig,
  MockField,
  MockScenario,
  OutputFormat,
} from "../tools/mock-data/lib/types";
import ConfirmDialog from "./components/ConfirmDialog.vue";
import FieldShelf from "./components/FieldShelf.vue";
import JsonImportDrawer from "./components/JsonImportDrawer.vue";
import ScenarioManagerDrawer from "./components/ScenarioManagerDrawer.vue";
import {
  DEFAULT_SCENARIO_ID,
  enabledFields,
  fieldDisplayName,
  resolveFallbackScenarioId,
} from "./lib/field-shelf";
import { templateToFields } from "../tools/mock-data/lib/template-files";

const DEFAULT_EXPORT_OPTIONS: Required<ExportOptions> = {
  sqlDialect: "mysql",
  csvDelimiter: ",",
  csvBom: false,
  xmlRoot: "list",
  xmlItem: "item",
};
const PREVIEW_HARD_LIMIT = 1000;
const TABLE_PREVIEW_LIMIT_DEFAULT = 200;
const QUICK_COUNT_DEFAULT = 6;
const COUNT_PRESETS = [1, 10, 50, 100, 1000];
const QUICK_FIELD_TYPES = FIELD_TYPES.filter(
  (type) => !["evalMethod", "openBidTime", "score"].includes(type.id),
);

function makeSeed(): string {
  const values = new Uint32Array(4);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(36)).join("-");
}

function clampInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), min), max);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ─── 状态 ──────────────────────────────────────────────────

const fields = ref<MockField[]>([]);
const count = ref(10);
const format = ref<OutputFormat>("json");
const tableName = ref("mock_data");
const autoGenerate = ref(true);
const activeCategory = ref<CategoryId>("basic");
const leftMode = ref<LeftMode>("batch");
const typeSearch = ref("");
const seed = ref(makeSeed());
const locale = ref<LocaleId>("zh-CN");
const scenario = ref<MockScenario>("normal");
const exportOptions = ref<Required<ExportOptions>>({
  ...DEFAULT_EXPORT_OPTIONS,
});
const batchSize = ref(250);
const customTemplates = ref<MockTemplate[]>([]);
const activeScenarioId = ref(DEFAULT_SCENARIO_ID);
const allTemplates = computed(() => [
  ...TEMPLATES,
  ...customTemplates.value,
]);
const shelfSearch = ref("");
const settingsOpen = ref(false);
const scenarioDrawerOpen = ref(false);
const jsonDrawerOpen = ref(false);

/** 场景替换/删除前的确认弹窗。 */
const confirmState = ref<{
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm?: () => void;
  onCancel?: () => void;
} | null>(null);

const rawOutput = ref("");
const rowCount = ref(0);
const outputSize = ref("");
const configLoaded = ref(false);
const downloading = ref(false);
const downloadedRows = ref(0);
const downloadTotal = ref(0);

const outputEditorRef = ref<HTMLDivElement>();

let editor: CodeEditor | null = null;
let generateTimer: ReturnType<typeof setTimeout> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let customTemplateSeq = 0;

const modEnterHint = getModEnterHint();

const FORMATS = Object.entries(FORMAT_META).map(([value, meta]) => ({
  value: value as OutputFormat,
  label: meta.label,
}));

const LOCALE_OPTIONS: Array<{ value: LocaleId; label: string }> = [
  { value: "zh-CN", label: "中文" },
  { value: "en-US", label: "English" },
];
const SCENARIO_OPTIONS: Array<{ value: MockScenario; label: string }> = [
  { value: "normal", label: "日常联调" },
  { value: "boundary", label: "测试边界" },
  { value: "invalid", label: "测试异常" },
  { value: "timeSeries", label: "时间递增" },
];
const SQL_DIALECT_OPTIONS: Array<{
  value: "mysql" | "postgres" | "sqlite";
  label: string;
}> = [
  { value: "mysql", label: "MySQL" },
  { value: "postgres", label: "PostgreSQL" },
  { value: "sqlite", label: "SQLite" },
];

const paletteTypes = computed(() => {
  const query = typeSearch.value.trim().toLowerCase();
  if (query) {
    return QUICK_FIELD_TYPES.filter(
      (type) =>
        type.label.toLowerCase().includes(query) ||
        type.id.toLowerCase().includes(query),
    );
  }
  return QUICK_FIELD_TYPES.filter(
    (type) => type.category === activeCategory.value,
  );
});

const normalizedCount = computed(() =>
  clampInteger(count.value, 10, 1, MAX_ROWS),
);
const normalizedBatchSize = computed(() =>
  clampInteger(batchSize.value, 250, 1, 10000),
);
const previewLimit = computed(() =>
  Math.min(
    normalizedCount.value,
    clampInteger(tablePreviewLimit.value, TABLE_PREVIEW_LIMIT_DEFAULT, 1, 1000),
    PREVIEW_HARD_LIMIT,
  ),
);

/** 每一级字段分别检查空键、重复键与约束范围，嵌套字段也参与生成前校验。 */
const fieldErrors = computed(() => {
  const dependencyErrors = fieldDependencyErrors(fields.value);
  const errors: Record<string, string> = Object.create(null);
  const visit = (list: MockField[]) => {
    const keyCounts = new Map<string, number>();
    for (const field of list) {
      if (field.enabled === false) continue;
      const key = field.key.trim();
      keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    }
    for (const field of list) {
      if (field.enabled === false) continue;
      const messages: string[] = [];
      const dependencyError = dependencyErrors.get(field.id);
      if (dependencyError) messages.push(dependencyError.message);
      const key = field.key.trim();
      if (!key) messages.push("字段名不能为空");
      else if ((keyCounts.get(key) ?? 0) > 1)
        messages.push("同级字段名不能重复");
      for (const name of ["nullRate", "invalidRate"] as const) {
        const value = field.constraints?.[name];
        if (
          value !== undefined &&
          (!Number.isFinite(value) || value < 0 || value > 1)
        ) {
          messages.push(`${name} 必须在 0 到 1 之间`);
        }
      }
      if (messages.length) errors[field.id] = messages.join("；");
      if (field.children?.length) visit(field.children);
    }
  };
  visit(fields.value);
  return errors;
});
const hasFieldErrors = computed(
  () => Object.keys(fieldErrors.value).length > 0,
);
const hasOutput = computed(() => records.value.length > 0);

// ─── 结果视图（卡片 / 表格 / 源码） ──────────────────────────

type ViewMode = "card" | "table" | "code";
const VIEW_MODES: Array<{ value: ViewMode; label: string }> = [
  { value: "card", label: "卡片" },
  { value: "table", label: "表格" },
  { value: "code", label: "源码" },
];
const viewMode = ref<ViewMode>("card");
const records = ref<Record<string, unknown>[]>([]);
const cardIndex = ref(0);
const tablePreviewLimit = ref(TABLE_PREVIEW_LIMIT_DEFAULT);

const columns = computed(() =>
  enabledFields(fields.value)
    .map((field) => field.key.trim())
    .filter(Boolean),
);
const fieldByKey = computed(
  () => new Map(enabledFields(fields.value).map((field) => [field.key, field])),
);

function columnLabel(key: string): string {
  const field = fieldByKey.value.get(key);
  return field ? fieldDisplayName(field) : key;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function recordValue(column: string): string {
  const record = records.value[cardIndex.value];
  return record ? cellText(record[column]) : "";
}

async function copyCell(key: string, value: unknown) {
  const text = cellText(value);
  const ok = await copyToClipboard(text);
  if (ok) {
    const preview = text.length > 40 ? `${text.slice(0, 40)}…` : text;
    showToast(`已复制 ${columnLabel(key)}：${preview}`, "success");
  } else {
    showToast("复制失败", "error");
  }
}

function copyCurrentField(column: string) {
  const record = records.value[cardIndex.value];
  if (record) void copyCell(column, record[column]);
}

async function copyRecord() {
  const record = records.value[cardIndex.value];
  if (!record) return;
  const ok = await copyToClipboard(JSON.stringify(record, null, 2));
  showToast(
    ok ? `已复制第 ${cardIndex.value + 1} 条预览记录` : "复制失败",
    ok ? "success" : "error",
  );
}

// ─── 字段与快速取数 ─────────────────────────────────────────

function addField(typeId: string) {
  const field = createField(
    typeId,
    new Set(fields.value.map((item) => item.key)),
  );
  if (!field) return;
  fields.value.push(field);
}

const quickCount = ref(QUICK_COUNT_DEFAULT);
const quickType = ref<FieldTypeDef | null>(null);
const quickValues = ref<unknown[]>([]);
const quickBatch = ref(0);

function quickText(value: unknown): string {
  return typeof value === "object" && value !== null
    ? JSON.stringify(value)
    : String(value);
}

/** 快速取数与批量生成共享 RNG、场景、地区和完整行上下文。 */
function quickGenerate(typeId?: string) {
  const definition = typeId ? getFieldType(typeId) : quickType.value;
  if (!definition) return;
  if (definition.id === "derived") {
    showToast("派生字段依赖同记录来源字段，请在批量模式中使用", "info");
    return;
  }
  quickType.value = definition;
  const target = clampInteger(quickCount.value, QUICK_COUNT_DEFAULT, 1, 20);
  const params = definition.params.reduce<Record<string, unknown>>(
    (result, param) => {
      result[param.name] = param.default;
      return result;
    },
    {},
  );
  const quickField: MockField = {
    id: `quick_${definition.id}`,
    key: definition.defaultKey,
    type: definition.id,
    params,
  };
  const baseSeed = seed.value.trim();
  const rows = generateRows([quickField], target * 5, {
    seed: baseSeed
      ? `${baseSeed}|quick|${definition.id}|${quickBatch.value}`
      : undefined,
    locale: locale.value,
    scenario: scenario.value,
  });
  const seen = new Set<string>();
  const values: unknown[] = [];
  for (const row of rows) {
    const value = row[definition.defaultKey];
    const text = quickText(value);
    if (seen.has(text)) continue;
    seen.add(text);
    values.push(value);
    if (values.length >= target) break;
  }
  quickValues.value = values;
  quickBatch.value += 1;
}

async function copyQuickValue(value: unknown) {
  const text = quickText(value);
  const ok = await copyToClipboard(text);
  if (ok) {
    const preview = text.length > 40 ? `${text.slice(0, 40)}…` : text;
    showToast(`已复制：${preview}`, "success");
  } else {
    showToast("复制失败", "error");
  }
}

function promoteQuickToFields() {
  if (!quickType.value) return;
  const label = quickType.value.label;
  addField(quickType.value.id);
  leftMode.value = "batch";
  showToast(`已添加「${label}」到字段列表`, "info");
}

const resultTitle = computed(() => {
  if (leftMode.value === "batch") return "生成结果";
  return quickType.value ? `候选值 · ${quickType.value.label}` : "候选值";
});

// ─── 预览、复制与分批下载 ───────────────────────────────────

function generationOptions() {
  return {
    seed: seed.value.trim() || undefined,
    locale: locale.value,
    scenario: scenario.value,
  };
}

function syncEditorLanguage() {
  editor?.setLanguage(format.value === "json" ? json() : []);
}

function clearOutput() {
  rawOutput.value = "";
  rowCount.value = 0;
  outputSize.value = "";
  records.value = [];
  cardIndex.value = 0;
  editor?.setText("");
}

/** 源码是唯一自动序列化预览的视图；其他视图只保留记录对象。 */
function ensureCodeOutput() {
  if (
    viewMode.value !== "code" ||
    leftMode.value !== "batch" ||
    !records.value.length
  ) {
    return;
  }
  const text = exportData(
    records.value,
    format.value,
    tableName.value.trim() || "mock_data",
    exportOptions.value,
  );
  rawOutput.value = text;
  outputSize.value = formatSize(new Blob([text]).size);
  if (editor?.getText() !== text) editor?.setText(text);
  syncEditorLanguage();
}

function doGenerate(options: { silent?: boolean } = {}) {
  if (generateTimer) {
    clearTimeout(generateTimer);
    generateTimer = null;
  }
  if (!fields.value.length) {
    clearOutput();
    if (!options.silent) showToast("请先添加字段", "error");
    return;
  }
  const activeFields = enabledFields(fields.value);
  if (!activeFields.length) {
    clearOutput();
    if (!options.silent) showToast("请先勾选至少一个字段", "error");
    return;
  }
  if (hasFieldErrors.value) {
    clearOutput();
    if (!options.silent) showToast("请先修正字段中的错误", "error");
    return;
  }
  let rows: Record<string, unknown>[];
  try {
    rows = generateRows(fields.value, previewLimit.value, generationOptions());
  } catch (error) {
    clearOutput();
    showToast(`生成失败：${errorMessage(error)}`, "error");
    return;
  }
  records.value = rows;
  rowCount.value = normalizedCount.value;
  cardIndex.value = 0;
  rawOutput.value = "";
  outputSize.value = "";
  editor?.setText("");
  ensureCodeOutput();
  if (!options.silent) {
    showToast(
      `已生成预览 ${rows.length} 条（总计 ${rowCount.value} 条）`,
      "success",
    );
  }
}

async function copyResult() {
  if (!records.value.length) return;
  const text =
    viewMode.value === "code" && rawOutput.value
      ? rawOutput.value
      : exportData(
          records.value,
          format.value,
          tableName.value.trim() || "mock_data",
          exportOptions.value,
        );
  const ok = await copyToClipboard(text);
  showToast(
    ok
      ? `已复制当前预览 ${records.value.length} 条（${records.value.length < rowCount.value ? `非完整 ${rowCount.value} 条` : "当前全部数据"}）`
      : "复制失败",
    ok ? "success" : "error",
  );
}

async function downloadResult() {
  if (!records.value.length || downloading.value) return;
  if (hasFieldErrors.value) {
    showToast("请先修正字段中的错误", "error");
    return;
  }
  downloading.value = true;
  downloadedRows.value = 0;
  const total = normalizedCount.value;
  downloadTotal.value = total;
  const fieldsSnapshot = clone(fields.value);
  const optionsSnapshot = generationOptions();
  const exportOptionsSnapshot = { ...exportOptions.value };
  const formatSnapshot = format.value;
  const tableNameSnapshot = tableName.value.trim() || "mock_data";
  const currentBatchSize = normalizedBatchSize.value;

  async function* trackedBatches() {
    for await (const batch of generateRowBatches(
      fieldsSnapshot,
      total,
      optionsSnapshot,
      currentBatchSize,
    )) {
      downloadedRows.value += batch.length;
      yield batch;
      await yieldToMainThread();
    }
  }

  try {
    const chunks: string[] = [];
    for await (const chunk of exportDataChunks(
      trackedBatches(),
      formatSnapshot,
      tableNameSnapshot,
      exportOptionsSnapshot,
    )) {
      chunks.push(chunk);
      await yieldToMainThread();
    }
    const meta = FORMAT_META[formatSnapshot];
    downloadBlobAsFile(
      chunks,
      buildDownloadName("mock-data", meta.ext, new Date()),
      meta.mime,
    );
    showToast(`已下载完整 ${total} 条数据`, "success");
  } catch (error) {
    showToast(`下载失败：${errorMessage(error)}`, "error");
  } finally {
    downloading.value = false;
  }
}

function clearAll() {
  if (leftMode.value === "quick") {
    quickType.value = null;
    quickValues.value = [];
    showToast("已清空候选值", "info");
    return;
  }
  fields.value = [];
  clearOutput();
  showToast("已清空字段与结果", "info");
}

// ─── 字段货架、场景管理与 JSON 导入 ─────────────────────────

function nextCustomTemplateId(): string {
  customTemplateSeq += 1;
  return `custom-${Date.now().toString(36)}-${customTemplateSeq}`;
}

function onFieldsUpdate(next: MockField[]) {
  fields.value = next;
}

function shuffleBatch() {
  seed.value = makeSeed();
  doGenerate();
}

/** 把场景替换为整组字段（覆盖式）。 */
function loadScenarioNow(template: MockTemplate, options: { silent?: boolean } = {}) {
  fields.value = templateToFields(template);
  activeScenarioId.value = template.id;
  shelfSearch.value = "";
  doGenerate(options);
}

function applyScenario(id: string, options: { silent?: boolean } = {}) {
  const template = allTemplates.value.find((t) => t.id === id);
  if (!template) return;
  // 切换场景即整组替换字段，无需二次确认。
  loadScenarioNow(template, options);
}

function onSaveScenario(template: MockTemplate) {
  customTemplates.value.push(template);
  scenarioDrawerOpen.value = false;
  // 刚保存属已知切换，跳过确认，直接载入。
  loadScenarioNow(template, { silent: true });
  showToast(`已保存并切换到「${template.name}」`, "success");
}

function onImportScenario(template: MockTemplate) {
  template.id = nextCustomTemplateId();
  customTemplates.value.push(template);
  scenarioDrawerOpen.value = false;
  loadScenarioNow(template, { silent: true });
  showToast(
    `已导入并切换到「${template.name}」，${fields.value.length} 个可用字段`,
    "success",
  );
}

function onDeleteScenario(id: string) {
  const index = customTemplates.value.findIndex(
    (template) => template.id === id,
  );
  if (index < 0) return;
  const [removed] = customTemplates.value.splice(index, 1);
  if (activeScenarioId.value === id) {
    confirmState.value = {
      title: "删除场景",
      message: `已删除场景「${removed.name}」，是否回到「用户信息」？`,
      confirmLabel: "回到用户信息",
      danger: false,
      onConfirm: () => {
        // 用户已在删除确认里选择了「回到用户信息」，直接载入，避免二次确认。
        const fallback = allTemplates.value.find(
          (t) => t.id === DEFAULT_SCENARIO_ID,
        );
        if (fallback) loadScenarioNow(fallback, { silent: true });
      },
      onCancel: () => {
        activeScenarioId.value = DEFAULT_SCENARIO_ID;
      },
    };
  }
  showToast(`已删除场景「${removed.name}」`, "info");
}

function onJsonImport(imported: MockField[]) {
  fields.value = imported.map((f) => ({ ...f, enabled: true }));
  activeScenarioId.value = DEFAULT_SCENARIO_ID;
  shelfSearch.value = "";
  leftMode.value = "batch";
  jsonDrawerOpen.value = false;
  doGenerate({ silent: true });
  showToast(
    `Schema 导入成功，已替换为 ${imported.length} 个顶层字段`,
    "success",
  );
}

// ─── 持久化与自动生成 ───────────────────────────────────────

function persistConfig() {
  if (!configLoaded.value) return;
  void updateConfig<MockDataConfig>("mock-data", {
    schemaVersion: 2,
    fields: clone(fields.value),
    count: normalizedCount.value,
    format: format.value,
    tableName: tableName.value,
    viewMode: viewMode.value,
    autoGenerate: autoGenerate.value,
    leftMode: leftMode.value,
    activeScenarioId: activeScenarioId.value,
    quickCount: quickCount.value,
    seed: seed.value,
    locale: locale.value,
    scenario: scenario.value,
    customTemplates: clone(customTemplates.value),
    exportOptions: { ...exportOptions.value },
    batchSize: normalizedBatchSize.value,
  });
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistConfig();
  }, 500);
}

function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  persistConfig();
}

function scheduleGenerate() {
  if (generateTimer) clearTimeout(generateTimer);
  generateTimer = setTimeout(() => {
    generateTimer = null;
    doGenerate({ silent: true });
  }, 400);
}

watch(
  [fields, count, seed, locale, scenario],
  () => {
    if (!configLoaded.value) return;
    scheduleSave();
    if (autoGenerate.value && leftMode.value === "batch") scheduleGenerate();
  },
  { deep: true },
);

watch(
  [format, tableName, exportOptions],
  () => {
    if (!configLoaded.value) return;
    scheduleSave();
    ensureCodeOutput();
  },
  { deep: true },
);

watch(viewMode, () => {
  if (!configLoaded.value) return;
  scheduleSave();
  ensureCodeOutput();
});

watch(
  [
    leftMode,
    quickCount,
    autoGenerate,
    batchSize,
    customTemplates,
    activeScenarioId,
  ],
  () => {
    if (configLoaded.value) scheduleSave();
  },
  { deep: true },
);

function onGlobalKeydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    if (leftMode.value === "quick") {
      if (quickType.value) quickGenerate();
    } else {
      shuffleBatch();
    }
  }
}

onMounted(async () => {
  const saved = await getConfig<MockDataConfig>("mock-data");
  const savedFields =
    saved && Array.isArray(saved.fields) ? sanitizeFields(saved.fields) : null;

  if (saved) {
    count.value = clampInteger(saved.count, 10, 1, MAX_ROWS);
    if (saved.format && saved.format in FORMAT_META)
      format.value = saved.format;
    if (typeof saved.tableName === "string" && saved.tableName.trim()) {
      tableName.value = saved.tableName;
    }
    if (typeof saved.autoGenerate === "boolean")
      autoGenerate.value = saved.autoGenerate;
    if (saved.leftMode === "batch" || saved.leftMode === "quick") {
      leftMode.value = saved.leftMode;
    }
    if (
      saved.viewMode === "card" ||
      saved.viewMode === "table" ||
      saved.viewMode === "code"
    ) {
      viewMode.value = saved.viewMode;
    }
    quickCount.value = clampInteger(
      saved.quickCount,
      QUICK_COUNT_DEFAULT,
      1,
      20,
    );
    tablePreviewLimit.value = clampInteger(
      saved.tablePreviewLimit,
      TABLE_PREVIEW_LIMIT_DEFAULT,
      1,
      1000,
    );
    if (typeof saved.seed === "string") seed.value = saved.seed;
    if (saved.locale === "zh-CN" || saved.locale === "en-US")
      locale.value = saved.locale;
    if (
      saved.scenario === "normal" ||
      saved.scenario === "boundary" ||
      saved.scenario === "invalid" ||
      saved.scenario === "timeSeries"
    ) {
      scenario.value = saved.scenario;
    }
    if (Array.isArray(saved.customTemplates)) {
      customTemplates.value = clone(saved.customTemplates);
    }
    exportOptions.value = {
      ...DEFAULT_EXPORT_OPTIONS,
      ...(saved.exportOptions ?? {}),
    };
    batchSize.value = clampInteger(saved.batchSize, 250, 1, 10000);
  }

  const storedId = saved?.activeScenarioId;
  const resolvedId = resolveFallbackScenarioId(storedId, [
    ...TEMPLATES,
    ...customTemplates.value,
  ]);
  // 有保存字段：恢复（透传 enabled）；首次/选项页清空：默认用户场景整组勾选。
  if (savedFields) {
    // 若存储的 activeScenarioId 指向已删除场景，回退到 user 并整组加载其字段（不留残留）。
    if (resolvedId === DEFAULT_SCENARIO_ID && storedId && storedId !== resolvedId) {
      const userTemplate = TEMPLATES.find((t) => t.id === DEFAULT_SCENARIO_ID);
      fields.value = userTemplate
        ? templateToFields(userTemplate)
        : [];
    } else {
      fields.value = savedFields;
    }
  } else {
    const userTemplate = TEMPLATES.find((t) => t.id === DEFAULT_SCENARIO_ID);
    fields.value = userTemplate
      ? templateToFields(userTemplate)
      : [];
  }
  activeScenarioId.value = resolvedId;

  if (outputEditorRef.value) {
    editor = createCodeEditor({
      parent: outputEditorRef.value,
      readonly: true,
      language: format.value === "json" ? json() : [],
    });
  }

  configLoaded.value = true;
  if (leftMode.value === "batch" && fields.value.length)
    doGenerate({ silent: true });
  window.addEventListener("keydown", onGlobalKeydown);
  window.addEventListener("pagehide", flushSave);
});

onUnmounted(() => {
  window.removeEventListener("keydown", onGlobalKeydown);
  window.removeEventListener("pagehide", flushSave);
  if (generateTimer) {
    clearTimeout(generateTimer);
    generateTimer = null;
  }
  flushSave();
  editor?.destroy();
  editor = null;
});
</script>

<template>
  <div class="page-wrapper" data-dt-root>
    <div class="top-bar">
      <div class="brand">
        <div class="i-lucide-dices w-5 h-5" />
        <span>模拟数据</span>
      </div>
      <div class="toolbar-actions">
        <DtButton
          v-if="leftMode === 'batch'"
          variant="primary"
          :title="`生成并换一批数据，字段和格式不变 (${modEnterHint})`"
          @click="shuffleBatch"
        >
          生成
          <kbd class="mod-key">{{ modEnterHint }}</kbd>
        </DtButton>
        <DtButton
          v-else
          variant="primary"
          :disabled="!quickType"
          :title="`换一批候选值 (${modEnterHint})`"
          @click="quickGenerate()"
        >
          换一批
          <kbd class="mod-key">{{ modEnterHint }}</kbd>
        </DtButton>
        <span class="divider" />
        <span class="toolbar-label">{{ leftMode === 'batch' ? '条数' : '候选' }}</span>
        <input
          v-if="leftMode === 'batch'"
          v-model.number="count"
          class="num-input"
          type="number"
          min="1"
          :max="MAX_ROWS"
          :title="`生成总条数（1-${MAX_ROWS}），预览最多 1000 条`"
          @change="count = normalizedCount"
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
            v-for="preset in COUNT_PRESETS"
            :key="preset"
            type="button"
            class="preset-btn"
            :class="{ active: count === preset }"
            @click="count = preset"
          >
            {{ preset }}
          </button>
        </span>
        <DtSegmented
          v-if="leftMode === 'batch'"
          v-model="format"
          :options="FORMATS"
          title="输出格式"
        />
        <DtSegmented
          v-if="leftMode === 'batch'"
          v-model="locale"
          :options="LOCALE_OPTIONS"
          size="sm"
          title="数据语言"
        />
        <span class="divider" />
        <DtButton
          variant="ghost"
          icon
          :title="leftMode === 'batch' ? '清空字段与结果' : '清空候选值'"
          @click="clearAll"
        >
          清空
        </DtButton>
      </div>
    </div>

    <div class="content-area layout-left-right">
      <DtPanel
        class="fields-panel"
        :title="leftMode === 'quick' ? '快速取数' : '字段货架'"
      >
        <template #header-extra>
          <span v-if="leftMode === 'batch'" class="count-badge">
            {{ fields.length }} 个字段
          </span>
          <span v-else class="count-badge">结果在右侧，点击即复制</span>
        </template>

        <div class="fields-body">
          <div class="mode-bar">
            <DtSegmented
              v-model="leftMode"
              :options="[
                { value: 'batch', label: '批量生成' },
                { value: 'quick', label: '快速取数' },
              ]"
              class="mode-switch"
            />
            <!-- 搜索框统一夹在模式按钮右侧：批量搜字段、快捷搜类型，位置一致 -->
            <input
              v-if="leftMode === 'quick'"
              v-model="typeSearch"
              class="type-search"
              type="text"
              placeholder="搜索类型，如：身份证"
            />
            <input
              v-else
              v-model="shelfSearch"
              class="type-search"
              type="search"
              placeholder="搜索字段，如身份证"
              aria-label="搜索字段"
            />
            <button
              v-if="leftMode === 'batch'"
              type="button"
              class="json-import-link"
              title="从 JSON 导入字段"
              @click="jsonDrawerOpen = true"
            >
              <div class="i-lucide-file-json-2 w-3.5 h-3.5" />
              从 JSON 导入
            </button>
          </div>

          <div v-if="leftMode === 'quick'" class="palette">
            <div v-if="!typeSearch.trim()" class="palette-cats">
              <button
                v-for="category in CATEGORIES"
                :key="category.id"
                type="button"
                class="cat-btn"
                :class="{ active: activeCategory === category.id }"
                @click="activeCategory = category.id"
              >
                <div :class="[category.icon, 'w-3.5', 'h-3.5']" />
                {{ category.label }}
              </button>
            </div>
            <div class="palette-types">
              <button
                v-for="type in paletteTypes"
                :key="type.id"
                type="button"
                class="type-chip"
                :class="{ 'chip-active': quickType?.id === type.id }"
                :title="`生成「${type.label}」候选值`"
                @click="quickGenerate(type.id)"
              >
                <div class="i-lucide-zap w-3 h-3" />
                {{ type.label }}
              </button>
              <div v-if="!paletteTypes.length" class="chips-empty">
                没有匹配「{{ typeSearch.trim() }}」的类型
              </div>
            </div>
          </div>

          <FieldShelf
            v-if="leftMode === 'batch'"
            :fields="fields"
            :templates="TEMPLATES"
            :custom-templates="customTemplates"
            v-model:active-scenario-id="activeScenarioId"
            v-model:search="shelfSearch"
            :errors="fieldErrors"
            @update:fields="onFieldsUpdate"
            @request-scenario-load="applyScenario"
            @manage="scenarioDrawerOpen = true"
          />

          <button
            v-if="leftMode === 'batch'"
            type="button"
            class="more-settings-toggle"
            :aria-expanded="settingsOpen"
            @click="settingsOpen = !settingsOpen"
          >
            <div class="i-lucide-settings-2 w-4 h-4" />
            <span>更多设置（可选）</span>
            <div
              :class="[
                settingsOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down',
                'w-3.5',
                'h-3.5',
              ]"
            />
          </button>

          <div
            v-if="leftMode === 'batch'"
            v-show="settingsOpen"
            class="settings-panel"
          >
            <section class="settings-section">
              <h4>数据内容</h4>
              <label class="setting-item">
                <span>数据用途 · 影响取值范围</span>
                <DtSelect
                  v-model="scenario"
                  :options="SCENARIO_OPTIONS"
                  size="sm"
                />
                <small class="setting-hint"
                  >决定输出偏日常、偏边界还是偏异常；不确定就选「日常联调」</small
                >
              </label>
            </section>

            <section class="settings-section">
              <h4>导出 · 当前格式</h4>
              <p
                v-if="format === 'json' || format === 'jsonl'"
                class="settings-note"
              >
                当前格式无需额外设置
              </p>
              <template v-else-if="format === 'csv'">
                <label class="checkbox-setting">
                  <input v-model="exportOptions.csvBom" type="checkbox" />
                  <span>Excel 兼容</span>
                </label>
                <small class="setting-hint">勾上后 Excel 打开中文不乱码</small>
                <label class="setting-item">
                  <span>分隔符</span>
                  <input
                    v-model="exportOptions.csvDelimiter"
                    type="text"
                    placeholder=","
                    aria-label="CSV 分隔符"
                  />
                  <small class="setting-hint"
                    >默认逗号；用 Excel 打开一般不用改</small
                  >
                </label>
              </template>
              <template v-else-if="format === 'sql'">
                <label class="setting-item">
                  <span>表名</span>
                  <input v-model="tableName" type="text" placeholder="mock_data" />
                </label>
                <label class="setting-item">
                  <span>数据库</span>
                  <DtSelect
                    v-model="exportOptions.sqlDialect"
                    :options="SQL_DIALECT_OPTIONS"
                    size="sm"
                  />
                </label>
              </template>
              <template v-else-if="format === 'xml'">
                <label class="setting-item">
                  <span>根节点</span>
                  <input
                    v-model="exportOptions.xmlRoot"
                    type="text"
                    placeholder="list"
                  />
                </label>
                <label class="setting-item">
                  <span>记录节点</span>
                  <input
                    v-model="exportOptions.xmlItem"
                    type="text"
                    placeholder="item"
                  />
                </label>
              </template>
            </section>
          </div>

          <div v-if="leftMode === 'quick'" class="quick-side-hint">
            <div class="i-lucide-mouse-pointer-click w-5 h-5" />
            <p>点击上方类型生成候选值<br />结果将显示在右侧面板，点击即可复制</p>
            <p v-if="quickType" class="quick-current">
              当前：<b>{{ quickType.label }}</b>
            </p>
          </div>
        </div>
      </DtPanel>

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
              仅预览 {{ records.length }} / {{ rowCount }} 条
              <template v-if="viewMode === 'code' && outputSize"> · {{ outputSize }}</template>
            </span>
          </template>
          <span v-else-if="quickType" class="count-badge">
            {{ quickValues.length }} 条候选
          </span>
        </template>
        <template #actions>
          <template v-if="leftMode === 'batch'">
            <span v-if="downloading" class="download-progress" role="status" aria-live="polite">
              正在导出 {{ downloadedRows }} / {{ downloadTotal }} 条
            </span>
            <DtButton
              size="sm"
              :title="`仅复制当前预览 ${records.length} 条`"
              :disabled="!hasOutput || hasFieldErrors"
              @click="copyResult"
            >
              <div class="i-lucide-copy w-3 h-3" />
            </DtButton>
            <DtButton
              size="sm"
              :title="`从 Seed 起点分批下载完整 ${rowCount} 条数据`"
              :disabled="!hasOutput || hasFieldErrors || downloading"
              :aria-busy="downloading"
              @click="downloadResult"
            >
              <div :class="[downloading ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-download', 'w-3', 'h-3']" />
            </DtButton>
          </template>
          <template v-else>
            <DtButton size="sm" title="换一批候选值" :disabled="!quickType" @click="quickGenerate()">
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

        <div v-show="leftMode === 'batch'" class="output-body">
          <div v-show="viewMode === 'code'" ref="outputEditorRef" class="code-editor" />

          <div v-if="viewMode === 'card' && hasOutput" class="data-view">
            <div v-if="records.length > 1" class="record-nav">
              <button type="button" class="nav-btn" title="上一条" :disabled="cardIndex === 0" @click="cardIndex--">
                <div class="i-lucide-chevron-left w-3.5 h-3.5" />
              </button>
              <span class="nav-text">第 {{ cardIndex + 1 }} / {{ records.length }} 条预览</span>
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
                v-for="column in columns"
                :key="column"
                type="button"
                class="rf-row"
                title="点击复制该值"
                @click="copyCurrentField(column)"
              >
                <span class="rf-label">
                  {{ columnLabel(column) }}
                  <span class="rf-key">{{ column }}</span>
                </span>
                <span class="rf-value">{{ recordValue(column) }}</span>
                <div class="i-lucide-copy w-3 h-3 rf-icon" />
              </button>
            </div>
            <div class="record-actions">
              <button type="button" class="quick-action-btn" @click="copyRecord">
                <div class="i-lucide-braces w-3 h-3" />
                复制本条 JSON
              </button>
            </div>
          </div>

          <div v-else-if="viewMode === 'table' && hasOutput" class="data-view table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th class="idx-col">#</th>
                  <th v-for="column in columns" :key="column">
                    <div class="th-label">{{ columnLabel(column) }}</div>
                    <div class="th-key">{{ column }}</div>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, rowIndex) in records" :key="rowIndex">
                  <td class="idx-col">{{ rowIndex + 1 }}</td>
                  <td
                    v-for="column in columns"
                    :key="column"
                    class="data-cell"
                    title="点击复制该值"
                    @click="copyCell(column, row[column])"
                  >
                    {{ cellText(row[column]) }}
                  </td>
                </tr>
              </tbody>
            </table>
            <div v-if="rowCount > records.length" class="table-limit-hint">
              仅预览 {{ records.length }} / {{ rowCount }} 条；下载将重新从相同 Seed 起点生成完整数据
            </div>
          </div>

          <DtEmptyState v-if="!hasOutput" overlay>
            <template #icon><div class="i-lucide-dices w-8 h-8" /></template>
            从左侧字段货架勾选字段，或按 {{ modEnterHint }} 手动生成
          </DtEmptyState>
        </div>

        <div v-show="leftMode === 'quick'" class="output-body">
          <div v-if="quickType" :key="quickBatch" class="data-view quick-view">
            <button
              v-for="(value, index) in quickValues"
              :key="index"
              type="button"
              class="quick-value"
              title="点击复制"
              @click="copyQuickValue(value)"
            >
              <span class="qv-text">{{ quickText(value) }}</span>
              <div class="i-lucide-copy w-3.5 h-3.5 qv-icon" />
            </button>
          </div>
          <DtEmptyState v-else overlay>
            <template #icon><div class="i-lucide-zap w-8 h-8" /></template>
            从左侧点击一个类型，立即生成候选值
          </DtEmptyState>
        </div>
      </DtPanel>
    </div>

    <ScenarioManagerDrawer
      :show="scenarioDrawerOpen"
      :templates="TEMPLATES"
      :custom-templates="customTemplates"
      :fields="fields"
      :has-field-errors="hasFieldErrors"
      @close="scenarioDrawerOpen = false"
      @save="onSaveScenario"
      @import="onImportScenario"
      @delete="onDeleteScenario"
    />
    <JsonImportDrawer
      :show="jsonDrawerOpen"
      @close="jsonDrawerOpen = false"
      @import="onJsonImport"
    />
    <ConfirmDialog
      v-if="confirmState"
      :show="true"
      :title="confirmState.title"
      :message="confirmState.message"
      :confirm-label="confirmState.confirmLabel"
      :cancel-label="confirmState.cancelLabel"
      :danger="confirmState.danger"
      @confirm="
        confirmState.onConfirm?.();
        confirmState = null;
      "
      @cancel="
        confirmState.onCancel?.();
        confirmState = null;
      "
    />

    <ToastContainer />
  </div>
</template>

<style scoped>
.mod-key {
  margin-left: 6px;
  padding: 2px 4px;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.2);
  color: #fff;
  font: 11px inherit;
  vertical-align: 1px;
}

.num-input {
  width: 76px;
  padding: 5px 8px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  outline: none;
  background: #fff;
  color: #374151;
  font-size: 12px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.num-input:focus,
.type-search:focus {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
}

.fields-panel {
  flex: 0 0 47%;
  min-width: 400px;
}

.result-panel {
  flex: 1;
  min-width: 0;
}

.result-panel :deep(.dt-panel-header) {
  flex-wrap: wrap;
}

.result-panel :deep(.dt-panel-title) {
  flex-shrink: 0;
  white-space: nowrap;
}

.fields-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.count-badge {
  padding: 1px 8px;
  border-radius: 9999px;
  background: #eef2ff;
  color: #6366f1;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.mode-bar {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  padding: 12px 16px 0;
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
  outline: none;
  background: #fff;
  color: #374151;
  font-size: 12px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.json-import-link {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--primary-start, #6366f1);
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s ease-out;
}

.json-import-link:hover {
  color: var(--primary-hover-start, #4f46e5);
}

.json-import-link:focus-visible {
  outline: 2px solid #818cf8;
  outline-offset: 2px;
}

[data-dt-dark] .json-import-link {
  color: #a5b4fc;
}

.palette {
  flex-shrink: 0;
  padding: 12px 16px 8px;
  border-bottom: 1px solid #e2e8f0;
}

.palette-cats {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 8px;
}

.cat-btn,
.type-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid #e2e8f0;
  border-radius: 9999px;
  background: #fff;
  color: #64748b;
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
}

.cat-btn {
  padding: 2px 9px;
  font-weight: 500;
}

.type-chip {
  gap: 3px;
  padding: 3px 9px;
  color: #374151;
}

.cat-btn:hover,
.type-chip:hover {
  border-color: #6366f1;
  background: rgba(99, 102, 241, 0.06);
  color: #6366f1;
}

.cat-btn.active,
.type-chip.chip-active {
  border-color: #6366f1;
  background: #eef2ff;
  color: #6366f1;
}

.palette-types {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 110px;
  padding-top: 2px;
  overflow-y: auto;
}

.chips-empty {
  padding: 4px 2px;
  color: #94a3b8;
  font-size: 12px;
}

.more-settings-toggle {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 6px;
  width: 100%;
  margin-top: 4px;
  padding: 9px 16px;
  border: 0;
  border-top: 1px solid #e2e8f0;
  background: transparent;
  color: #475569;
  font-size: 12px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}

.more-settings-toggle:hover {
  color: #6366f1;
}

.more-settings-toggle > span {
  flex: 1;
}

.more-settings-toggle:focus-visible {
  outline: 2px solid #818cf8;
  outline-offset: -2px;
}

.settings-panel {
  flex-shrink: 0;
  max-height: 46%;
  padding: 0 16px 12px;
  overflow-y: auto;
  border-top: 1px solid #e2e8f0;
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 10px;
}

.settings-section + .settings-section {
  margin-top: 10px;
  border-top: 1px solid #f1f5f9;
}

.settings-section h4 {
  margin: 0;
  color: #0f172a;
  font-size: 12px;
  font-weight: 600;
}

.settings-note,
.setting-hint {
  margin: 0;
  color: #94a3b8;
  font-size: 11px;
  line-height: 1.5;
}

.setting-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  color: #64748b;
}

.setting-item > input {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 4px 8px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  outline: none;
  background: #fff;
  color: #374151;
  font: 12px var(--font-sans);
}

.setting-item > input:focus {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
}

.checkbox-setting {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  gap: 6px;
  min-height: 24px;
  color: #64748b;
  cursor: pointer;
}

.checkbox-setting input {
  accent-color: #6366f1;
}

.count-presets {
  display: inline-flex;
  gap: 2px;
}

.preset-btn {
  padding: 3px 7px;
  border: 1px solid var(--border);
  background: #fff;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  cursor: pointer;
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

.preset-btn.active {
  border-color: transparent;
  background: linear-gradient(135deg, var(--primary-start), var(--primary-end));
  color: #fff;
}

.quick-side-hint {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px 16px;
  color: #94a3b8;
  font-size: 12px;
  text-align: center;
}

.quick-side-hint p {
  margin: 0;
  line-height: 1.7;
}

.quick-current {
  color: #6366f1;
}

.view-switch {
  margin-left: 4px;
}

.download-progress {
  color: #6366f1;
  font-size: 12px;
  white-space: nowrap;
}

.output-body {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.data-view {
  flex: 1;
  min-height: 0;
  padding: 12px 14px;
  overflow: auto;
}

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
}

.nav-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.nav-text {
  min-width: 118px;
  color: #64748b;
  font-size: 12px;
  text-align: center;
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
}

.rf-row:hover {
  border-color: #6366f1;
  background: rgba(99, 102, 241, 0.04);
}

.rf-label {
  display: inline-flex;
  flex: 0 0 132px;
  align-items: baseline;
  gap: 6px;
  overflow: hidden;
  color: #334155;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.rf-key,
.th-key {
  overflow: hidden;
  color: #94a3b8;
  font: 12px var(--font-mono);
  font-weight: 400;
  text-overflow: ellipsis;
}

.rf-value {
  flex: 1;
  min-width: 0;
  color: #0f172a;
  font: 12.5px var(--font-mono);
  overflow-wrap: anywhere;
}

.rf-icon,
.qv-icon {
  flex-shrink: 0;
  color: #94a3b8;
  opacity: 0;
}

.rf-row:hover .rf-icon,
.rf-row:focus-visible .rf-icon,
.quick-value:hover .qv-icon,
.quick-value:focus-visible .qv-icon {
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
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  background: #fff;
  color: #64748b;
  font-size: 12px;
  cursor: pointer;
}

.table-wrap {
  padding: 0;
}

.data-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 12px;
}

.data-table thead th {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 7px 10px;
  border-bottom: 1px solid #e2e8f0;
  background: #f8fafc;
  color: #334155;
  font-weight: 600;
  text-align: left;
  white-space: nowrap;
}

.th-label {
  font-size: 12px;
}

.idx-col {
  width: 42px;
  min-width: 42px;
  background: #f8fafc;
  color: #94a3b8;
  font: 12px var(--font-mono);
  text-align: right !important;
}

.data-table tbody td {
  max-width: 260px;
  padding: 6px 10px;
  border-bottom: 1px solid #f1f5f9;
}

.data-cell {
  overflow: hidden;
  color: #0f172a;
  font-family: var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.data-table tbody tr:hover .data-cell {
  background: rgba(99, 102, 241, 0.04);
}

.table-limit-hint {
  padding: 10px;
  color: #94a3b8;
  font-size: 12px;
  text-align: center;
}

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
}

.quick-value:hover {
  border-color: #6366f1;
  background: rgba(99, 102, 241, 0.04);
}

.qv-text {
  color: #0f172a;
  font: 13px var(--font-mono);
  overflow-wrap: anywhere;
}

.preset-btn:focus-visible,
.cat-btn:focus-visible,
.type-chip:focus-visible,
.nav-btn:focus-visible,
.quick-action-btn:focus-visible {
  outline: 2px solid #818cf8;
  outline-offset: 2px;
}

[data-dt-dark] .num-input,
[data-dt-dark] .type-search,
[data-dt-dark] .preset-btn,
[data-dt-dark] .nav-btn,
[data-dt-dark] .quick-action-btn,
[data-dt-dark] .setting-item > input {
  border-color: var(--dt-dark-border);
  background: var(--dt-dark-surface-hover);
  color: #c9d1d9;
}

[data-dt-dark] .count-badge {
  background: #1e1b4b;
  color: #a5b4fc;
}

[data-dt-dark] .palette,
[data-dt-dark] .more-settings-toggle,
[data-dt-dark] .settings-panel,
[data-dt-dark] .settings-section + .settings-section {
  border-color: var(--dt-dark-border);
}

[data-dt-dark] .cat-btn,
[data-dt-dark] .type-chip {
  border-color: var(--dt-dark-border);
  background: var(--dt-dark-surface-hover);
  color: #c9d1d9;
}

[data-dt-dark] .cat-btn.active,
[data-dt-dark] .type-chip.chip-active {
  border-color: #818cf8;
  background: rgba(99, 102, 241, 0.16);
  color: #a5b4fc;
}

[data-dt-dark] .more-settings-toggle {
  color: #c9d1d9;
}

[data-dt-dark] .settings-section h4 {
  color: #f1f5f9;
}

[data-dt-dark] .setting-item,
[data-dt-dark] .checkbox-setting,
[data-dt-dark] .nav-text {
  color: #8b949e;
}

[data-dt-dark] .settings-note,
[data-dt-dark] .setting-hint,
[data-dt-dark] .chips-empty,
[data-dt-dark] .quick-side-hint {
  color: #6e7681;
}

[data-dt-dark] .rf-row,
[data-dt-dark] .quick-value {
  border-color: var(--dt-dark-border);
  background: var(--dt-dark-base);
}

[data-dt-dark] .rf-label,
[data-dt-dark] .data-table thead th {
  color: #c9d1d9;
}

[data-dt-dark] .rf-value,
[data-dt-dark] .qv-text,
[data-dt-dark] .data-cell {
  color: #e6edf3;
}

[data-dt-dark] .data-table thead th,
[data-dt-dark] .idx-col {
  border-color: var(--dt-dark-border);
  background: var(--dt-dark-surface-hover);
}

[data-dt-dark] .data-table tbody td {
  border-color: var(--dt-dark-border);
}

[data-dt-dark] .download-progress,
[data-dt-dark] .quick-current {
  color: #a5b4fc;
}

@media (max-width: 900px) {
  .fields-panel {
    min-width: 340px;
  }

  .count-presets {
    display: none;
  }
}

@media (max-width: 640px) {
  .rf-label {
    flex-basis: 108px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .quick-view,
  .animate-spin {
    animation: none;
  }

  .num-input,
  .type-search,
  .cat-btn,
  .type-chip {
    transition: none;
  }
}
</style>
