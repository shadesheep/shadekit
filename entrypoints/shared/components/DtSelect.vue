<script setup lang="ts">
/**
 * 共享下拉组件 — 独立工具标签页统一下拉样式。
 *
 * 包装原生 <select>（无障碍/键盘导航天然可用），外观对齐 design tokens:
 * 1px border / radius 6px / focus ring / SVG chevron 背景图。
 *
 * 尺寸：md（默认，工具栏用）/ sm（字段行等紧凑场景，padding 4px 8px、font-size 12px）。
 *
 * 用法:
 *   <DtSelect v-model="format" :options="[{value:'json',label:'JSON'},…]" />
 *   <DtSelect v-model="type" :options="TYPE_OPTIONS" size="sm" />
 *
 * class / title / @change 等属性自动落到根 <select> 上（inheritAttrs 默认 true）。
 */
withDefaults(
  defineProps<{
    modelValue: string;
    options?: Array<{ value: string; label: string }>;
    size?: 'md' | 'sm';
    placeholder?: string;
    disabled?: boolean;
  }>(),
  { size: 'md', placeholder: undefined, disabled: false, options: () => [] },
);

const emit = defineEmits<{
  'update:modelValue': [value: string];
  change: [value: string];
}>();

function onChange(e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  emit('update:modelValue', v);
  emit('change', v);
}
</script>

<template>
  <select
    class="dt-select"
    :class="{ 'dt-select--sm': size === 'sm' }"
    :value="modelValue"
    :disabled="disabled"
    @change="onChange"
  >
    <!-- 默认 slot 用于 optgroup 分组等复杂场景（如 mock-data 字段类型）；未提供时渲染 options -->
    <slot>
      <option v-if="placeholder !== undefined" value="" disabled>
        {{ placeholder }}
      </option>
      <option v-for="opt in options" :key="opt.value" :value="opt.value">
        {{ opt.label }}
      </option>
    </slot>
  </select>
</template>

<style scoped>
.dt-select {
  padding: 5px 26px 5px 10px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  background: #fff
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")
    no-repeat right 8px center;
  color: #374151;
  cursor: pointer;
  outline: none;
  appearance: none;
  -webkit-appearance: none;
  transition: all 0.2s ease;
  max-width: 180px;
}

.dt-select:hover {
  border-color: #cbd5e1;
}

.dt-select:focus {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
}

.dt-select:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

[data-dt-dark] .dt-select {
  background-color: var(--dt-dark-surface-hover);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238b949e' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
  border-color: var(--dt-dark-border);
  color: #c9d1d9;
}

[data-dt-dark] .dt-select:hover {
  border-color: #484f58;
}

[data-dt-dark] .dt-select:focus {
  border-color: #818cf8;
  box-shadow: 0 0 0 2px rgba(129, 140, 248, 0.2);
}

/* 尺寸变体：sm 用于字段行/紧凑场景 */
.dt-select--sm {
  padding: 4px 24px 4px 8px;
  font-size: 12px;
}
</style>
