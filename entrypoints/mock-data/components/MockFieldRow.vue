<script setup lang="ts">
import { computed, ref } from "vue";
import DtSelect from "../../shared/components/DtSelect.vue";
import { isDateComparable } from "../../tools/mock-data/lib/date-cases";
import {
  CATEGORIES,
  defaultParams,
  FIELD_TYPES,
  getFieldType,
  isNumericFieldType,
} from "../../tools/mock-data/lib/generators";
import type {
  FieldConstraints,
  MockField,
} from "../../tools/mock-data/lib/types";
import { fieldDisplayName } from "../lib/field-shelf";
import MockFieldEditor from "./MockFieldEditor.vue";

const props = defineProps<{
  field: MockField;
  siblings: MockField[];
  index: number;
  total: number;
  errors: Record<string, string>;
}>();

const emit = defineEmits<{
  remove: [];
  move: [direction: -1 | 1];
}>();

const typeGroups = CATEGORIES.map((category) => ({
  ...category,
  types: FIELD_TYPES.filter((type) => type.category === category.id),
}));

const scalarTypeOptions = FIELD_TYPES.filter(
  (type) => type.id !== "object" && type.id !== "array",
).map((type) => ({ value: type.id, label: type.label }));

const paramsOf = computed(() =>
  (getFieldType(props.field.type)?.params ?? []).filter((param) => {
    if (param.name === "sourceKey") return false;
    if (props.field.type === "array" && param.name === "itemType") return false;
    if (param.name === "mean" || param.name === "stdDev") {
      return props.field.params.distribution === "normal";
    }
    if (param.name === "lambda") {
      return props.field.params.distribution === "exponential";
    }
    if (
      props.field.type === "derived" &&
      ["amount", "unit", "format", "timezone"].includes(param.name)
    ) {
      return props.field.params.transform === "dateAfter";
    }
    return true;
  }),
);
const sourceSelections = computed(() =>
  (getFieldType(props.field.type)?.sources ?? []).map((source) => {
    const options = props.siblings
      .filter(
        (field) =>
          field.id !== props.field.id &&
          field.enabled !== false &&
          field.key.trim() &&
          (!source.types || source.types.includes(field.type)),
      )
      .map((field) => ({
        value: field.id,
        label: `${fieldDisplayName(field)} (${field.key})`,
      }));
    if (!source.required) {
      options.unshift({ value: "", label: "不关联（随机生成）" });
    }
    const selected = props.field.sourceFieldIds?.[source.name] ?? "";
    return {
      source,
      options,
      selected: options.some((option) => option.value === selected)
        ? selected
        : "",
    };
  }),
);

function selectSource(role: string, id: string) {
  const ids = { ...(props.field.sourceFieldIds ?? {}) };
  if (id) ids[role] = id;
  else delete ids[role];
  if (Object.keys(ids).length) props.field.sourceFieldIds = ids;
  else delete props.field.sourceFieldIds;
}

const isObject = computed(() => props.field.type === "object");
const isArray = computed(() => props.field.type === "array");
const arrayItemType = computed(() => {
  if (
    props.field.params.itemType === "object" ||
    props.field.children !== undefined
  ) {
    return "object";
  }
  return String(props.field.params.itemType ?? "string");
});
const hasObjectItems = computed(
  () => isObject.value || (isArray.value && arrayItemType.value === "object"),
);
const errorText = computed(() => props.errors[props.field.id] ?? "");
const errorId = computed(() => `${props.field.id}-error`);
const showConstraints = ref(false);
const hasCustomConstraints = computed(
  () => props.field.constraints?.unique === true,
);

function onTypeChange() {
  if (props.field.type !== "string" && props.field.type !== "array") {
    delete props.field.lengthRule;
  }
  if (!isNumericFieldType(props.field.type)) delete props.field.numericRule;
  if (!isDateComparable(props.field)) delete props.field.dateRule;
  delete props.field.sourceFieldIds;
  const definition = getFieldType(props.field.type);
  if (definition) props.field.params = defaultParams(definition);
  if (props.field.type === "object") {
    props.field.children ??= [];
  } else if (props.field.type === "array") {
    props.field.params.itemType ??= "string";
    if (props.field.params.itemType === "object") props.field.children ??= [];
    else delete props.field.children;
  } else {
    delete props.field.children;
  }
}

function onArrayItemTypeChange(value: string) {
  props.field.params.itemType = value;
  if (value === "object") props.field.children ??= [];
  else delete props.field.children;
}

function updateUnique(event: Event) {
  const constraints: FieldConstraints = props.field.constraints ?? {};
  constraints.unique = (event.target as HTMLInputElement).checked;
  props.field.constraints = constraints;
}
</script>

<template>
  <section class="field-row" :aria-label="`字段 ${index + 1}`">
    <div class="row-main">
      <span class="row-order">
        <button
          type="button"
          class="icon-btn"
          title="上移字段"
          aria-label="上移字段"
          :disabled="index === 0"
          @click="emit('move', -1)"
        >
          <div class="i-lucide-chevron-up w-3 h-3" />
        </button>
        <button
          type="button"
          class="icon-btn"
          title="下移字段"
          aria-label="下移字段"
          :disabled="index === total - 1"
          @click="emit('move', 1)"
        >
          <div class="i-lucide-chevron-down w-3 h-3" />
        </button>
      </span>
      <input
        v-model.trim="field.key"
        class="key-input"
        :class="{ invalid: errorText }"
        type="text"
        placeholder="输出字段名（英文）"
        title="输出属性名"
        aria-label="字段名"
        :aria-invalid="Boolean(errorText)"
        :aria-describedby="errorText ? errorId : undefined"
      />
      <DtSelect
        v-model="field.type"
        class="row-type"
        size="sm"
        title="字段类型"
        aria-label="字段类型"
        @change="onTypeChange"
      >
        <optgroup v-for="group in typeGroups" :key="group.id" :label="group.label">
          <option v-for="type in group.types" :key="type.id" :value="type.id">
            {{ type.label }}
          </option>
        </optgroup>
      </DtSelect>
      <button
        type="button"
        class="icon-btn settings-btn"
        :class="{ 'constraint-active': hasCustomConstraints || showConstraints }"
        title="唯一性设置"
        aria-label="字段高级设置"
        :aria-expanded="showConstraints"
        @click="showConstraints = !showConstraints"
      >
        <div class="i-lucide-settings-2 w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        class="icon-btn danger"
        title="删除字段"
        aria-label="删除字段"
        @click="emit('remove')"
      >
        <div class="i-lucide-x w-3.5 h-3.5" />
      </button>
    </div>

    <p v-if="errorText" :id="errorId" class="inline-error" role="alert">
      {{ errorText }}
    </p>

    <div v-if="paramsOf.length || sourceSelections.length" class="row-params">
      <label
        v-for="selection in sourceSelections"
        :key="selection.source.name"
        class="param-item"
      >
        <span class="param-label source-label">
          {{ selection.source.label }}
        </span>
        <DtSelect
          :model-value="selection.selected"
          :options="selection.options"
          :placeholder="
            selection.source.required
              ? `请选择${selection.source.label}`
              : '不关联（随机生成）'
          "
          :aria-label="selection.source.label"
          :aria-invalid="Boolean(errorText)"
          :aria-describedby="errorText ? errorId : undefined"
          size="sm"
          class="param-select"
          @update:model-value="
            (value) => selectSource(selection.source.name, value)
          "
        />
      </label>
      <label v-for="param in paramsOf" :key="param.name" class="param-item">
        <span class="param-label">{{ param.label }}</span>
        <input
          v-if="param.kind === 'number'"
          v-model="field.params[param.name]"
          class="param-input param-num"
          type="number"
          :min="param.min"
          :max="param.max"
        />
        <DtSelect
          v-else-if="param.kind === 'select'"
          :model-value="String(field.params[param.name] ?? '')"
          :options="param.options"
          size="sm"
          class="param-input param-select"
          @update:model-value="field.params[param.name] = $event"
        />
        <input
          v-else
          v-model="field.params[param.name]"
          class="param-input"
          type="text"
          :placeholder="param.placeholder"
        />
      </label>
    </div>


    <div v-if="isArray" class="array-items">
      <label class="param-item">
        <span class="param-label">数组元素</span>
        <DtSelect
          :model-value="arrayItemType"
          :options="[...scalarTypeOptions, { value: 'object', label: '对象（子字段）' }]"
          size="sm"
          @update:model-value="onArrayItemTypeChange"
        />
      </label>
    </div>

    <div v-if="showConstraints" class="advanced-settings">
      <div class="constraint-grid">
        <label class="unique-item">
          <input
            :checked="field.constraints?.unique ?? false"
            type="checkbox"
            @change="updateUnique"
          />
          <span>所有记录保持唯一</span>
        </label>
      </div>
    </div>

    <div v-if="hasObjectItems" class="children-editor">
      <div class="children-title">
        {{ isObject ? '对象子字段' : '数组对象子字段' }}
      </div>
      <MockFieldEditor
        :model-value="field.children ?? []"
        :errors="errors"
        show-add
        @update:model-value="field.children = $event"
      />
    </div>
  </section>
</template>

<style scoped>
.field-row {
  min-width: 0;
  padding: 7px 8px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.field-row:hover {
  border-color: #c7d2fe;
  box-shadow: 0 1px 3px rgba(99, 102, 241, 0.08);
}

.row-main {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.row-order {
  display: inline-flex;
  flex-direction: column;
  flex-shrink: 0;
  gap: 1px;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 3px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #94a3b8;
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease;
}

.icon-btn:hover:not(:disabled) {
  background: #f1f5f9;
  color: #475569;
}

.icon-btn:focus-visible,
.key-input:focus-visible,
.param-input:focus-visible,
.constraint-item input:focus-visible,
.rule-toggle:focus-visible,
.rule-clear:focus-visible,
summary:focus-visible {
  outline: 2px solid #818cf8;
  outline-offset: 2px;
}

.icon-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.icon-btn.danger:hover {
  background: #fef2f2;
  color: #dc2626;
}

.key-input {
  flex: 0 1 128px;
  min-width: 76px;
  padding: 4px 8px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  outline: none;
  background: #fff;
  color: #0f172a;
  font: 12px var(--font-mono);
}

.key-input.invalid {
  border-color: #dc2626;
  background: #fef2f2;
}

.row-type {
  flex: 1 1 180px;
  min-width: 100px;
  max-width: 320px;
}

.settings-btn {
  margin-left: auto;
}

.inline-error {
  margin: 5px 0 0 27px;
  color: #dc2626;
  font-size: 12px;
  line-height: 1.5;
}

.row-params,
.array-items {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  margin-top: 6px;
  padding: 6px 2px 2px 27px;
  border-top: 1px dashed #e2e8f0;
}

.param-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

.param-label {
  color: #94a3b8;
  font-size: 12px;
  white-space: nowrap;
}

.source-label {
  color: var(--text-secondary, #64748b);
}

.param-input {
  width: 130px;
  padding: 3px 7px;
  border: 1px solid #e2e8f0;
  border-radius: 5px;
  outline: none;
  background: #fff;
  color: #374151;
  font-size: 12px;
}

.param-num {
  width: 72px;
}

.param-select {
  width: 130px;
  max-width: 130px;
}

.numeric-rule,
.input-rule {
  margin: 6px 0 0 27px;
  padding-top: 6px;
  border-top: 1px dashed #e2e8f0;
  color: #64748b;
  font-size: 12px;
}

.numeric-rule-title {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-weight: 500;
}

.numeric-rule-title span {
  color: #94a3b8;
  font-weight: 400;
}

.numeric-rule-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 7px 12px;
  padding: 7px 0 2px;
}

.rule-flags {
  display: flex;
  flex-wrap: wrap;
  gap: 7px 18px;
  padding: 7px 0 2px;
}

.rule-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 7px 12px;
  padding: 2px 0;
}

.rule-fields > * {
  min-width: 0;
}

.rule-fields :deep(.dt-select) {
  width: 100%;
  max-width: none;
}

.numeric-rule-grid > * {
  min-width: 0;
}

.numeric-rule-grid :deep(.dt-select) {
  width: 100%;
  max-width: none;
}

.input-flag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.input-flag input {
  accent-color: #6366f1;
}

.rule-clear {
  margin-left: auto;
  padding: 0;
  border: none;
  background: none;
  color: #6366f1;
  font-size: 12px;
  cursor: pointer;
}

.rule-clear:hover {
  text-decoration: underline;
}

.rule-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.rule-toggle {
  display: inline-flex;
  flex: 1;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: none;
  color: #64748b;
  font: inherit;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
}

.rule-toggle:hover {
  color: #4f46e5;
}

.rule-toggle-hint {
  overflow: hidden;
  color: #94a3b8;
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rule-toggle-chevron {
  flex-shrink: 0;
  color: #94a3b8;
}

.advanced-settings {
  margin: 6px 0 0 27px;
  color: #64748b;
  font-size: 12px;
}

.icon-btn.constraint-active {
  background: #eef2ff;
  color: #6366f1;
}


.constraint-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(150px, 1fr));
  gap: 7px 12px;
  padding: 7px 0 2px;
}

.constraint-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.constraint-item input {
  width: 100%;
  box-sizing: border-box;
  padding: 3px 7px;
  border: 1px solid #e2e8f0;
  border-radius: 5px;
  background: #fff;
  color: #374151;
  font-size: 12px;
}

.unique-item {
  display: inline-flex;
  grid-column: 1 / -1;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.unique-item input {
  accent-color: #6366f1;
}

.children-editor {
  margin: 7px 0 0 27px;
  padding: 7px;
  border-left: 2px solid #c7d2fe;
  border-radius: 0 6px 6px 0;
  background: #f8fafc;
}

.children-title {
  margin-bottom: 6px;
  color: #64748b;
  font-size: 12px;
  font-weight: 600;
}

[data-dt-dark] .field-row {
  border-color: var(--dt-dark-border);
  background: var(--dt-dark-base);
}

[data-dt-dark] .field-row:hover {
  border-color: #4338ca;
}

[data-dt-dark] .icon-btn {
  color: #6e7681;
}

[data-dt-dark] .icon-btn:hover:not(:disabled) {
  background: var(--dt-dark-surface-hover);
  color: #c9d1d9;
}

[data-dt-dark] .icon-btn.constraint-active {
  background: rgba(99, 102, 241, 0.18);
  color: #a5b4fc;
}

[data-dt-dark] .icon-btn.danger:hover {
  background: rgba(220, 38, 38, 0.15);
  color: #f87171;
}

[data-dt-dark] .key-input,
[data-dt-dark] .param-input,
[data-dt-dark] .constraint-item input {
  border-color: var(--dt-dark-border);
  background: var(--dt-dark-surface-hover);
  color: #c9d1d9;
}

[data-dt-dark] .key-input.invalid {
  border-color: #f87171;
  background: rgba(220, 38, 38, 0.12);
}

[data-dt-dark] .inline-error {
  color: #f87171;
}

[data-dt-dark] .row-params,
[data-dt-dark] .array-items,
[data-dt-dark] .numeric-rule,
[data-dt-dark] .input-rule {
  border-color: var(--dt-dark-border);
}

[data-dt-dark] .numeric-rule-title {
  color: #8b949e;
}
[data-dt-dark] .rule-toggle,
[data-dt-dark] .rule-toggle-hint,
[data-dt-dark] .rule-toggle-chevron {
  color: #8b949e;
}

[data-dt-dark] .rule-toggle:hover {
  color: #a5b4fc;
}

[data-dt-dark] .param-label,
[data-dt-dark] .advanced-settings,
[data-dt-dark] .children-title {
  color: #8b949e;
}

[data-dt-dark] .children-editor {
  border-left-color: #4338ca;
  background: var(--dt-dark-surface-hover);
}

@media (max-width: 1000px) {
  .numeric-rule-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 560px) {
  .row-main {
    flex-wrap: wrap;
  }

  .key-input,
  .row-type {
    flex: 1 1 140px;
  }

  .constraint-grid {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .field-row,
  .icon-btn {
    transition: none;
  }
}
</style>
