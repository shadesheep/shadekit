<script setup lang="ts" generic="T extends string | number">
/**
 * 分段单选(ADR-0007):替代原生 radio 组。
 * 灰底槽 + 清晰选中态；配置页使用表面色选中块，其余位置保留渐变。
 * 泛型 T 由 v-model 绑定值推断,字面量联合类型(如 OutputFormat)不丢类型。
 *
 * 用法:<DtSegmented v-model="config.format" :options="[{value:'json',label:'JSON'},…]" />
 *
 * 注意:选项 >5 个时会拥挤,超量场景回退 select(届时补 DtSelect)。
 */
import { computed, inject } from 'vue';
import type { ComputedRef } from 'vue';

defineProps<{
  modelValue: T;
  options: Array<{ value: T; label: string }>;
  /** 尺寸：md（默认，选项页/工具栏）/ sm（紧凑场景，padding 2px 8px、font-size 12px） */
  size?: 'md' | 'sm';
}>();

const configItemLabel = inject<ComputedRef<string | undefined>>(
  'dt-config-item-label',
  computed(() => undefined),
);

const emit = defineEmits<{
  'update:modelValue': [value: T];
}>();
</script>

<template>
  <div class="dt-segmented" :class="{ 'dt-segmented--sm': size === 'sm' }" role="group" :aria-label="configItemLabel">
    <button
      v-for="opt in options"
      :key="opt.value"
      type="button"
      :aria-pressed="modelValue === opt.value"
      class="dt-segmented-btn"
      :class="{ active: modelValue === opt.value }"
      @click="emit('update:modelValue', opt.value)"
    >
      {{ opt.label }}
    </button>
  </div>
</template>

<style scoped>
.dt-segmented {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 2px;
  padding: 2px;
  background: var(--config-soft, #f1f5f9);
  border-radius: 8px;
}

[data-dt-dark] .dt-segmented {
  background: var(--config-soft, #0f172a);
}

.dt-segmented-btn {
  border: none;
  background: transparent;
  padding: var(--config-segment-padding, 4px 12px);
  font-size: var(--config-segment-font-size, 12px);
  font-weight: 500;
  border-radius: 6px;
  color: var(--config-secondary, #64748b);
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
}

.dt-segmented-btn:hover {
  color: var(--config-ink, #334155);
}

.dt-segmented-btn.active {
  background: var(--config-surface, linear-gradient(135deg, #6366f1, #3b82f6));
  color: var(--config-accent, #fff);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
  font-weight: 600;
}

.dt-segmented-btn:active {
  transform: scale(0.96);
}

[data-dt-dark] .dt-segmented-btn {
  color: var(--config-secondary, #8b949e);
}

[data-dt-dark] .dt-segmented-btn:hover {
  color: var(--config-ink, #c9d1d9);
}

[data-dt-dark] .dt-segmented-btn.active {
  color: var(--config-accent, #fff);
}

/* 尺寸变体：sm 用于紧凑场景 */
.dt-segmented--sm .dt-segmented-btn {
  padding: 2px 8px;
  font-size: 12px;
}
</style>
