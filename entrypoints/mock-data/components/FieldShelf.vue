<script setup lang="ts">
import { computed, ref } from "vue";
import { showToast } from "../../shared/use-toast";
import {
  CATEGORIES,
  FIELD_TYPES,
  createField,
  getFieldType,
} from "../../tools/mock-data/lib/generators";
import type {
  MockTemplate,
} from "../../tools/mock-data/lib/templates";
import type { MockField } from "../../tools/mock-data/lib/types";
import {
  countEnabled,
  fieldDisplayName,
  fieldRangeSummary,
  genericEntries,
  removeShelfEntry,
  resolveFallbackScenarioId,
  toggleFieldEnabled,
} from "../lib/field-shelf";
import MockFieldRow from "./MockFieldRow.vue";

const props = withDefaults(
  defineProps<{
    fields: MockField[];
    templates: MockTemplate[];
    customTemplates: MockTemplate[];
    activeScenarioId: string;
    search: string;
    errors?: Record<string, string>;
  }>(),
  { errors: () => ({}) },
);

const emit = defineEmits<{
  "update:fields": [fields: MockField[]];
  "update:activeScenarioId": [id: string];
  "update:search": [value: string];
  "request-scenario-load": [id: string];
  manage: [];
}>();

const allTemplates = computed(() => [
  ...props.templates,
  ...props.customTemplates,
]);

const currentScenarioId = computed(() =>
  resolveFallbackScenarioId(props.activeScenarioId, allTemplates.value),
);

const addOpen = ref(false);
const addQuery = ref("");
const addPanelRef = ref<HTMLElement | null>(null);

/** 收缩/展开状态：键为字段 id，尽量保持已存在字段的展开状态，避免点击时跳动。 */
const expandedIds = ref<Record<string, boolean>>({});

function isExpanded(field: MockField): boolean {
  return expandedIds.value[field.id] ?? false;
}

function toggleExpanded(id: string) {
  expandedIds.value = { ...expandedIds.value, [id]: !isByIdExpanded(id) };
}

function isByIdExpanded(id: string): boolean {
  return expandedIds.value[id] ?? false;
}

function rowClicked(field: MockField, event: MouseEvent) {
  // 点击内部可交互元素（输入框/按钮/选择器）时不折叠，仅整行空白区点击切换。
  const target = event.target as HTMLElement;
  if (target.closest("input, button, select")) return;
  toggleExpanded(field.id);
}

/** 展开「添加其他字段」时，把它滚进可视区（它位于字段清单底部）。 */
function scrollAddIntoView() {
  requestAnimationFrame(() => {
    addPanelRef.value?.scrollIntoView?.({ block: "nearest" });
  });
}

/** 顶部搜索：按字段名 / 输出 key 过滤当前勾选清单（含子字段）。 */
const searchableFields = computed(() => {
  const query = props.search.trim().toLowerCase();
  if (!query) return props.fields;
  const matches = (field: MockField): boolean =>
    Boolean(
      field.label?.toLowerCase().includes(query) ||
      field.key.trim().toLowerCase().includes(query) ||
      getFieldType(field.type)?.label.toLowerCase().includes(query) ||
      field.children?.some(matches),
    );
  return props.fields.filter(matches);
});

function findFieldError(field: MockField): string | undefined {
  const own = props.errors[field.id];
  if (own) return own;
  for (const child of field.children ?? []) {
    const message = findFieldError(child);
    if (message) return `${child.key}：${message}`;
  }
}

const rowErrors = computed(() =>
  new Map(searchableFields.value.map((field) => [field.id, findFieldError(field)])),
);

/** 「＋ 添加其他字段」面板：按分类分组 + 搜索过滤。 */
const addGroups = computed(() => {
  const query = addQuery.value.trim().toLowerCase();
  return CATEGORIES.map((category) => ({
    id: category.id,
    label: category.label,
    types: FIELD_TYPES.filter(
      (type) =>
        type.category === category.id &&
        (!query ||
          type.label.toLowerCase().includes(query) ||
          type.id.toLowerCase().includes(query)),
    ).map((type) => type),
  })).filter((group) => group.types.length);
});

function selectTab(id: string) {
  if (props.search) emit("update:search", "");
  emit("request-scenario-load", id);
}

function toggleEnabled(field: MockField) {
  const next = toggleFieldEnabled(props.fields, field.id);
  emit("update:fields", next);
}

function setAll(value: boolean) {
  const next = props.fields.map((field) =>
    value ? { ...field, enabled: true } : { ...field, enabled: false },
  );
  emit("update:fields", next);
}

function clearFields() {
  emit("update:fields", []);
}

function removeField(key: string) {
  emit("update:fields", removeShelfEntry(props.fields, key));
}

function removeFieldById(id: string) {
  emit("update:fields", props.fields.filter((field) => field.id !== id));
}

function moveField(id: string, direction: -1 | 1) {
  const index = props.fields.findIndex((field) => field.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= props.fields.length) return;
  const next = [...props.fields];
  const [field] = next.splice(index, 1);
  next.splice(target, 0, field!);
  emit("update:fields", next);
}

function addGenericType(type: string) {
  const all = genericEntries();
  const entry = all.find((item) => item.typeId === type);
  if (!entry) return;
  const field = createField(
    entry.typeId,
    new Set(props.fields.map((item) => item.key)),
  );
  if (!field) return;
  emit("update:fields", [...props.fields, { ...field, enabled: true }]);
  // 新加入的字段立即展开编辑，并滚到可视区。
  expandedIds.value = { ...expandedIds.value, [field.id]: true };
  requestAnimationFrame(() => {
    document
      .querySelector(`[data-row-id="${field.id}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  });
}
</script>

<template>
  <div class="field-shelf">
    <div class="scenario-tabs">
      <button
        v-for="template in allTemplates"
        :key="template.id"
        type="button"
        class="scenario-tab"
        :class="{ active: currentScenarioId === template.id }"
        @click="selectTab(template.id)"
      >
        {{ template.name }}
      </button>
      <button
        type="button"
        class="manage-scenarios"
        @click="emit('manage')"
      >
        <div class="i-lucide-settings-2 w-3.5 h-3.5" />
        管理场景
      </button>
    </div>

    <div class="selected-bar">
      <span class="selected-count">勾选了 {{ countEnabled(fields) }} 个字段</span>
      <div class="bulk-actions">
        <button type="button" class="link-btn" @click="setAll(true)">
          全选
        </button>
        <button type="button" class="link-btn" @click="setAll(false)">
          全不选
        </button>
      </div>
      <button
        v-if="fields.length"
        type="button"
        class="link-btn"
        @click="clearFields"
      >
        清空
      </button>
    </div>

    <div class="shelf-scroll">
      <div v-if="fields.length" class="selected-chips">
        <span
          v-for="field in fields"
          :key="field.id"
          class="selected-chip"
          :title="field.key"
        >
          {{ fieldDisplayName(field) }}
          <button
            type="button"
            class="chip-remove"
            aria-label="移除字段"
            @click="removeField(field.key)"
          >
            <div class="i-lucide-x w-3 h-3" />
          </button>
        </span>
      </div>

      <div v-if="!fields.length" class="shelf-empty">
        还没有字段，点击上方场景标签可一键载入
      </div>
      <div v-else-if="!searchableFields.length" class="shelf-empty">
        没有匹配「{{ search }}」的字段
      </div>

      <!-- 勾选清单：每行一个勾选框 + 行内编辑（默认收缩，点击展开编辑） -->
      <div v-if="searchableFields.length" class="checklist">
        <div v-for="field in searchableFields" :key="field.id" class="check-item" :data-row-id="field.id">
          <div
            class="check-head"
            role="button"
            tabindex="0"
            :aria-expanded="isExpanded(field)"
            aria-label="点击展开或收起字段编辑"
            :aria-describedby="!isExpanded(field) && rowErrors.get(field.id) ? `${field.id}-collapsed-error` : undefined"
            @click="rowClicked(field, $event)"
            @keydown.enter.prevent="toggleExpanded(field.id)"
            @keydown.space.prevent="toggleExpanded(field.id)"
          >
            <input
              type="checkbox"
              class="field-checkbox"
              :checked="field.enabled !== false"
              @click.stop
              @change="toggleEnabled(field)"
            />
            <span class="check-display">{{ fieldDisplayName(field) }}</span>
            <span class="check-key">{{ field.key }}</span>
            <span class="check-range">{{ fieldRangeSummary(field) }}</span>
            <span class="check-chevron">
              <div :class="isExpanded(field) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="w-3 h-3" />
            </span>
          </div>
          <MockFieldRow
            v-if="isExpanded(field)"
            :field="field"
            :siblings="fields"
            :index="fields.indexOf(field)"
            :total="fields.length"
            :errors="errors"
            @remove="removeFieldById(field.id)"
            @move="moveField(field.id, $event)"
          />
          <p
            v-else-if="rowErrors.get(field.id)"
            :id="`${field.id}-collapsed-error`"
            class="check-error"
            role="alert"
          >
            {{ rowErrors.get(field.id) }}
          </p>
        </div>
      </div>

      <!-- ＋ 添加其他字段折叠面板（常显切换条，参考「更多设置」） -->
      <div ref="addPanelRef" class="add-panel">
        <button
          type="button"
          class="add-toggle"
          :aria-expanded="addOpen"
          @click="addOpen = !addOpen"
        >
          <div class="i-lucide-plus w-4 h-4" />
          <span>添加其他字段</span>
          <div
            :class="addOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
            class="w-3.5 h-3.5"
          />
        </button>
        <div v-if="addOpen" class="add-body">
          <div class="shelf-search-wrap add-search">
            <div class="i-lucide-search w-3.5 h-3.5" />
            <input
              v-model="addQuery"
              type="search"
              class="shelf-search"
              placeholder="搜索字段类型"
            />
          </div>
          <div v-for="group in addGroups" :key="group.id" class="add-group">
            <div class="shelf-group-title">{{ group.label }}</div>
            <div class="add-chips">
              <button
                v-for="type in group.types"
                :key="type.id"
                type="button"
                class="add-chip"
                @click="addGenericType(type.id)"
              >
                <div class="i-lucide-plus w-3 h-3" />
                <span class="chip-label">{{ type.label }}</span>
              </button>
            </div>
          </div>
          <div v-if="!addGroups.length" class="shelf-no-result">无匹配字段</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.field-shelf {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  padding: 0 16px;
}

.scenario-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 0 10px;
}

.scenario-tab,
.manage-scenarios {
  padding: 4px 10px;
  border: 1px solid var(--border, #e2e8f0);
  border-radius: 9999px;
  background: var(--dt-light-surface, #fff);
  color: var(--text-secondary, #64748b);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease-out;
}

.scenario-tab:hover,
.manage-scenarios:hover {
  border-color: #c7d2fe;
  color: var(--primary-hover-start, #4f46e5);
  transform: translateY(-1px);
}

.scenario-tab.active {
  border-color: transparent;
  background: linear-gradient(135deg, var(--primary-start), var(--primary-end));
  color: #fff;
  box-shadow: 0 2px 6px rgba(99, 102, 241, 0.3);
}

.manage-scenarios {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-style: dashed;
}

.selected-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 0 0 10px;
  font-size: 12px;
  color: var(--text-secondary, #64748b);
}

.selected-count {
  font-weight: 600;
  color: var(--text-primary, #0f172a);
}

.bulk-actions {
  display: inline-flex;
  gap: 6px;
}

.link-btn {
  padding: 2px 4px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--primary-start, #6366f1);
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s ease-out;
}

.link-btn:hover {
  color: var(--primary-hover-start, #4f46e5);
  text-decoration: underline;
}

.shelf-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
}

.selected-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-bottom: 10px;
}

.selected-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 4px 3px 10px;
  border: 1px solid #c7d2fe;
  border-radius: 9999px;
  background: #eef2ff;
  color: var(--primary-hover-start, #4f46e5);
  font-size: 12px;
}

.chip-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  border-radius: 9999px;
  background: transparent;
  color: #6366f1;
  cursor: pointer;
  transition: background 0.15s ease-out;
}

.chip-remove:hover {
  background: #c7d2fe;
}

.shelf-empty {
  padding: 14px 10px;
  text-align: center;
  font-size: 12px;
  color: #94a3b8;
}

.checklist {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-bottom: 12px;
}

.check-item {
  border: 1px solid var(--border, #e2e8f0);
  border-radius: 8px;
  background: var(--dt-light-surface, #fff);
}

.check-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 8px;
  cursor: pointer;
  user-select: none;
  transition: background 0.15s ease-out;
}

.check-head:hover {
  background: rgba(99, 102, 241, 0.05);
}

.check-head:focus-visible {
  outline: 2px solid #818cf8;
  outline-offset: -2px;
}

.check-error {
  margin: 0;
  padding: 0 8px 6px 28px;
  color: var(--error, #dc2626);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.field-checkbox {
  accent-color: var(--primary-start, #6366f1);
  cursor: pointer;
  flex-shrink: 0;
}

.check-display {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary, #0f172a);
  flex-shrink: 0;
}

.check-key {
  color: var(--text-muted, #94a3b8);
  font-family: var(--font-mono);
  font-size: 11px;
  flex-shrink: 0;
}

.check-range {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-secondary, #64748b);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.check-chevron {
  display: inline-flex;
  flex-shrink: 0;
  color: var(--text-muted, #94a3b8);
  transition: color 0.15s ease-out;
}

.check-head:hover .check-chevron {
  color: var(--primary-start, #6366f1);
}

.add-panel {
  padding: 0;
  border-top: 1px solid var(--border, #e2e8f0);
  margin-top: 12px;
}

.add-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 10px 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--text-secondary, #64748b);
  font-size: 12px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  transition: color 0.15s ease-out;
}

.add-toggle > span {
  flex: 1;
}

.add-toggle:hover {
  color: var(--primary-start, #6366f1);
}

.add-toggle:focus-visible {
  outline: 2px solid #818cf8;
  outline-offset: -2px;
}

.add-body {
  padding: 8px;
  border-top: 1px solid var(--border, #e2e8f0);
  background: var(--bg-hover, #f8fafc);
}

.add-search {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  padding: 0 10px;
  border: 1px solid var(--border, #e2e8f0);
  border-radius: 8px;
  background: var(--dt-light-surface, #fff);
  color: var(--text-muted, #94a3b8);
  transition: border-color 0.15s ease-out, box-shadow 0.15s ease-out;
}

.add-search:focus-within {
  border-color: var(--primary-start, #6366f1);
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.1);
}

.add-search input {
  flex: 1;
  min-width: 0;
  padding: 6px 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--text-primary, #0f172a);
  font-size: 12px;
}

.add-search input::placeholder {
  color: var(--text-muted, #94a3b8);
}

[data-dt-dark] .add-search {
  border-color: var(--dt-dark-border, #30363d);
  background: var(--dt-dark-surface-hover, #21262d);
  color: var(--dt-dark-text-muted, #6e7681);
}

[data-dt-dark] .add-search input {
  color: var(--dt-dark-text, #c9d1d9);
}

.add-group {
  margin-bottom: 10px;
}

.add-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.add-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--border, #e2e8f0);
  border-radius: 9999px;
  background: var(--dt-light-surface, #fff);
  color: var(--text-primary, #334155);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease-out;
}

.add-chip:hover {
  border-color: #c7d2fe;
  color: var(--primary-hover-start, #4f46e5);
  transform: translateY(-1px);
}

.shelf-group-title {
  margin-bottom: 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-muted, #94a3b8);
}

.shelf-no-result {
  padding: 8px 10px;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted, #94a3b8);
}

.scenario-tab:focus-visible,
.manage-scenarios:focus-visible,
.link-btn:focus-visible,
.chip-remove:focus-visible,
.add-toggle:focus-visible,
.add-chip:focus-visible {
  outline: 2px solid #818cf8;
  outline-offset: 1px;
}

[data-dt-dark] .scenario-tab,
[data-dt-dark] .manage-scenarios {
  background: var(--dt-dark-surface-1, #161b22);
}

[data-dt-dark] .scenario-tab:hover,
[data-dt-dark] .manage-scenarios:hover {
  border-color: #4f46e5;
}

[data-dt-dark] .scenario-tab.active {
  border-color: transparent;
  background: linear-gradient(135deg, var(--primary-start), var(--primary-end));
  color: #fff;
}

[data-dt-dark] .link-btn {
  color: #a5b4fc;
}

[data-dt-dark] .selected-chip {
  border-color: #4f46e5;
  background: #1e3a5f;
  color: #93c5fd;
}

[data-dt-dark] .chip-remove {
  color: #a5b4fc;
}

[data-dt-dark] .chip-remove:hover {
  background: var(--dt-dark-border, #30363d);
}

[data-dt-dark] .check-item {
  background: var(--dt-dark-surface-1, #161b22);
}

[data-dt-dark] .check-error {
  color: var(--error-dark, #f87171);
}

[data-dt-dark] .check-head:hover {
  background: rgba(99, 102, 241, 0.08);
}

[data-dt-dark] .check-head:hover .check-chevron {
  color: #a5b4fc;
}

[data-dt-dark] .add-toggle:hover {
  color: #a5b4fc;
}

[data-dt-dark] .add-body {
  background: var(--dt-dark-surface-1, #161b22);
}

[data-dt-dark] .add-chip {
  background: var(--dt-dark-surface-1, #161b22);
}

[data-dt-dark] .add-chip:hover {
  border-color: #4f46e5;
  color: #a5b4fc;
}
</style>
