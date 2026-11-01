<script setup lang="ts">
import { computed, ref } from "vue";
import { showToast } from "../../shared/use-toast";
import {
  CATEGORIES,
  FIELD_TYPES,
  createField,
} from "../../tools/mock-data/lib/generators";
import type {
  MockTemplate,
} from "../../tools/mock-data/lib/templates";
import type { MockField } from "../../tools/mock-data/lib/types";
import {
  countEnabled,
  fieldDisplayName,
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
  "import-json": [];
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

/** 展开「添加其他字段」时，把它滚进可视区（它位于字段清单底部）。 */
function scrollAddIntoView() {
  requestAnimationFrame(() => {
    addPanelRef.value?.scrollIntoView?.({ block: "nearest" });
  });
}

const searchModel = computed({
  get: () => props.search,
  set: (value: string) => emit("update:search", value),
});

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
}
</script>

<template>
  <div class="field-shelf">
    <div class="shelf-toolbar">
      <div class="shelf-search-wrap">
        <div class="i-lucide-search w-3.5 h-3.5" />
        <input
          v-model="searchModel"
          type="search"
          class="shelf-search"
          placeholder="搜索字段，如身份证"
        />
      </div>
      <button
        type="button"
        class="json-import-link"
        @click="emit('import-json')"
      >
        <div class="i-lucide-file-json-2 w-3.5 h-3.5" />
        从 JSON 导入
      </button>
      <button
        type="button"
        class="json-import-link add-shortcut"
        :aria-expanded="addOpen"
        @click="addOpen = !addOpen; if (addOpen) scrollAddIntoView()"
      >
        <div
          :class="addOpen ? 'i-lucide-chevron-up' : 'i-lucide-plus'"
          class="w-3.5 h-3.5"
        />
        添加其他字段
      </button>
    </div>

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

      <!-- 勾选清单：每行一个勾选框 + 行内编辑 -->
      <div v-if="fields.length" class="checklist">
        <div v-for="(field, index) in fields" :key="field.id" class="check-item">
          <label class="check-head">
            <input
              type="checkbox"
              class="field-checkbox"
              :checked="field.enabled !== false"
              @change="toggleEnabled(field)"
            />
            <span class="check-display">{{ fieldDisplayName(field) }}</span>
            <span class="check-key">{{ field.key }}</span>
          </label>
          <MockFieldRow
            :field="field"
            :index="index"
            :total="fields.length"
            :errors="errors"
            @remove="removeFieldById(field.id)"
            @move="moveField(field.id, $event)"
          />
        </div>
      </div>

      <!-- ＋ 添加其他字段折叠面板 -->
      <div ref="addPanelRef" class="add-panel">
        <button
          type="button"
          class="add-toggle"
          :aria-expanded="addOpen"
          @click="addOpen = !addOpen"
        >
          <div
            :class="addOpen ? 'i-lucide-chevron-up' : 'i-lucide-plus'"
            class="w-3.5 h-3.5"
          />
          添加其他字段
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
}

.shelf-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 2px 0 10px;
}

.shelf-search-wrap {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
  color: #94a3b8;
  transition: border-color 0.15s ease-out, box-shadow 0.15s ease-out;
}

.shelf-search-wrap:focus-within {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.1);
}

.shelf-search {
  flex: 1;
  min-width: 0;
  padding: 7px 0;
  border: 0;
  outline: none;
  background: transparent;
  color: #0f172a;
  font-size: 13px;
}

.shelf-search::placeholder {
  color: #94a3b8;
}

.json-import-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 2px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #6366f1;
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s ease-out;
}

.json-import-link:hover {
  color: #4f46e5;
}

.add-shortcut {
  color: #4f46e5;
}

.add-shortcut:hover {
  color: #4f46e5;
  text-decoration: underline;
}

.scenario-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-bottom: 10px;
}

.scenario-tab,
.manage-scenarios {
  padding: 4px 10px;
  border: 1px solid #e2e8f0;
  border-radius: 9999px;
  background: #fff;
  color: #64748b;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease-out;
}

.scenario-tab:hover,
.manage-scenarios:hover {
  border-color: #c7d2fe;
  color: #4f46e5;
  transform: translateY(-1px);
}

.scenario-tab.active {
  border-color: transparent;
  background: linear-gradient(135deg, #6366f1, #3b82f6);
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
  padding: 0 0 8px;
  font-size: 12px;
  color: #64748b;
}

.selected-count {
  font-weight: 600;
  color: #0f172a;
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
  color: #6366f1;
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s ease-out;
}

.link-btn:hover {
  color: #4f46e5;
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
  padding-bottom: 8px;
}

.selected-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 4px 3px 10px;
  border: 1px solid #c7d2fe;
  border-radius: 9999px;
  background: #eef2ff;
  color: #4f46e5;
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
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
}

.check-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  cursor: pointer;
}

.field-checkbox {
  accent-color: #6366f1;
  cursor: pointer;
}

.check-display {
  font-size: 13px;
  font-weight: 600;
  color: #0f172a;
}

.check-key {
  color: #94a3b8;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}

.add-panel {
  padding-bottom: 8px;
}

.add-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px dashed #c7d2fe;
  border-radius: 9999px;
  background: transparent;
  color: #6366f1;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease-out;
}

.add-toggle:hover {
  border-color: #6366f1;
  color: #4f46e5;
  transform: translateY(-1px);
}

.add-body {
  margin-top: 8px;
  padding: 8px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #f8fafc;
}

.add-search {
  margin-bottom: 8px;
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
  border: 1px solid #e2e8f0;
  border-radius: 9999px;
  background: #fff;
  color: #334155;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease-out;
}

.add-chip:hover {
  border-color: #c7d2fe;
  color: #4f46e5;
  transform: translateY(-1px);
}

.shelf-group-title {
  margin-bottom: 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: #94a3b8;
}

.shelf-no-result {
  padding: 8px 10px;
  text-align: center;
  font-size: 12px;
  color: #94a3b8;
}

.scenario-tab:focus-visible,
.manage-scenarios:focus-visible,
.link-btn:focus-visible,
.json-import-link:focus-visible,
.chip-remove:focus-visible,
.add-toggle:focus-visible,
.add-chip:focus-visible {
  outline: 2px solid #818cf8;
  outline-offset: 1px;
}

[data-dt-dark] .shelf-search-wrap {
  border-color: #30363d;
  background: #0f172a;
  color: #6e7681;
}

[data-dt-dark] .shelf-search {
  color: #c9d1d9;
}

[data-dt-dark] .shelf-search::placeholder {
  color: #6e7681;
}

[data-dt-dark] .json-import-link {
  color: #a5b4fc;
}

[data-dt-dark] .scenario-tab,
[data-dt-dark] .manage-scenarios {
  border-color: #30363d;
  background: #161b22;
  color: #8b949e;
}

[data-dt-dark] .scenario-tab:hover,
[data-dt-dark] .manage-scenarios:hover {
  border-color: #4f46e5;
  color: #a5b4fc;
}

[data-dt-dark] .scenario-tab.active {
  border-color: transparent;
  background: linear-gradient(135deg, #6366f1, #3b82f6);
  color: #fff;
}

[data-dt-dark] .selected-bar {
  color: #8b949e;
}

[data-dt-dark] .selected-count {
  color: #c9d1d9;
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
  background: #30363d;
}

[data-dt-dark] .shelf-empty,
[data-dt-dark] .shelf-no-result,
[data-dt-dark] .shelf-group-title {
  color: #6e7681;
}

[data-dt-dark] .check-item {
  border-color: #30363d;
  background: #161b22;
}

[data-dt-dark] .check-display {
  color: #c9d1d9;
}

[data-dt-dark] .check-key {
  color: #6e7681;
}

[data-dt-dark] .add-toggle {
  border-color: #4f46e5;
  color: #a5b4fc;
}

[data-dt-dark] .add-body {
  border-color: #30363d;
  background: #161b22;
}

[data-dt-dark] .add-chip {
  border-color: #30363d;
  background: #161b22;
  color: #c9d1d9;
}

[data-dt-dark] .add-chip:hover {
  border-color: #4f46e5;
  color: #a5b4fc;
}
</style>