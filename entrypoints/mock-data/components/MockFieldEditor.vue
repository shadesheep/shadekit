<script setup lang="ts">
import { ref } from "vue";
import DtButton from "../../shared/components/DtButton.vue";
import DtSelect from "../../shared/components/DtSelect.vue";
import { FIELD_TYPES, createField } from "../../tools/mock-data/lib/generators";
import type { MockField } from "../../tools/mock-data/lib/types";
import MockFieldRow from "./MockFieldRow.vue";

const props = withDefaults(
  defineProps<{
    modelValue: MockField[];
    errors?: Record<string, string>;
    showAdd?: boolean;
  }>(),
  { errors: () => ({}), showAdd: false },
);

const emit = defineEmits<{
  "update:modelValue": [fields: MockField[]];
}>();

const childType = ref("string");

function removeField(index: number) {
  emit(
    "update:modelValue",
    props.modelValue.filter((_, i) => i !== index),
  );
}

function moveField(index: number, direction: -1 | 1) {
  const target = index + direction;
  if (target < 0 || target >= props.modelValue.length) return;
  const next = [...props.modelValue];
  [next[index], next[target]] = [next[target], next[index]];
  emit("update:modelValue", next);
}

function addChildField() {
  const field = createField(
    childType.value,
    new Set(props.modelValue.map((item) => item.key)),
  );
  if (!field) return;
  emit("update:modelValue", [...props.modelValue, field]);
}
</script>

<template>
  <div class="field-editor" :class="{ nested: showAdd }">
    <MockFieldRow
      v-for="(field, index) in modelValue"
      :key="field.id"
      :field="field"
      :siblings="modelValue"
      :index="index"
      :total="modelValue.length"
      :errors="errors"
      @remove="removeField(index)"
      @move="moveField(index, $event)"
    />

    <div v-if="!modelValue.length" class="fields-empty">
      {{
        showAdd
          ? '暂无子字段，请从下方添加'
          : '从上方字段货架点选字段'
      }}
    </div>

    <div v-if="showAdd" class="child-add">
      <DtSelect
        v-model="childType"
        :options="FIELD_TYPES.map((type) => ({ value: type.id, label: type.label }))"
        size="sm"
        aria-label="子字段类型"
      />
      <DtButton size="sm" @click="addChildField">
        <div class="i-lucide-plus w-3 h-3" />
        添加子字段
      </DtButton>
    </div>
  </div>
</template>

<style scoped>
.field-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.field-editor.nested {
  gap: 6px;
}

.fields-empty {
  padding: 18px 10px;
  text-align: center;
  font-size: 12px;
  color: #94a3b8;
}

.child-add {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  padding-top: 2px;
}

[data-dt-dark] .fields-empty {
  color: #6e7681;
}

@media (max-width: 560px) {
  .child-add {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
