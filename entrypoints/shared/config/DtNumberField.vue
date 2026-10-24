<script setup lang="ts">
/**
 * 数字输入(ADR-0007):替代各页散装 count-input / input-number。
 * change 时提交(非 input,避免输入过程触发保存);min/max 仅为输入辅助,
 * 真正的边界钳制在 useToolConfig 的 normalize 钩子里。
 *
 * 用法:<DtNumberField v-model="config.count" :min="1" :max="1000" />
 */
withDefaults(
  defineProps<{
    modelValue: number;
    min?: number;
    max?: number;
    step?: number;
    /** 输入框宽度(px),默认 96 */
    width?: number;
  }>(),
  { min: undefined, max: undefined, step: undefined, width: 96 },
);

const emit = defineEmits<{
  'update:modelValue': [value: number];
}>();

function onChange(e: Event) {
  const v = Number((e.target as HTMLInputElement).value);
  emit('update:modelValue', Number.isFinite(v) ? v : 0);
}
</script>

<template>
  <input
    class="dt-number-field"
    type="number"
    :value="modelValue"
    :min="min"
    :max="max"
    :step="step"
    :style="{ width: `${width}px` }"
    @change="onChange"
  />
</template>

<style scoped>
.dt-number-field {
  padding: 5px 8px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  font-size: 13px;
  color: #0f172a;
  background: #fff;
  outline: none;
  transition: all 0.2s ease;
}

.dt-number-field:focus {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.1);
}

[data-dt-dark] .dt-number-field {
  background: #21262d;
  border-color: #30363d;
  color: #c9d1d9;
}
</style>
