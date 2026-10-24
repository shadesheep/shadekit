<script setup lang="ts" generic="T extends string | number">
/**
 * 分段单选(ADR-0007):替代原生 radio 组。
 * 灰底槽 + 激活项 indigo→blue 渐变 + 白字 + shadow,同工具页 seg-group 规格。
 * 泛型 T 由 v-model 绑定值推断,字面量联合类型(如 OutputFormat)不丢类型。
 *
 * 用法:<DtSegmented v-model="config.format" :options="[{value:'json',label:'JSON'},…]" />
 *
 * 注意:选项 >5 个时会拥挤,超量场景回退 select(届时补 DtSelect)。
 */
defineProps<{
  modelValue: T;
  options: Array<{ value: T; label: string }>;
  /** 尺寸：md（默认，选项页/工具栏）/ sm（紧凑场景，padding 2px 8px、font-size 12px） */
  size?: 'md' | 'sm';
}>();

const emit = defineEmits<{
  'update:modelValue': [value: T];
}>();
</script>

<template>
  <div class="dt-segmented" :class="{ 'dt-segmented--sm': size === 'sm' }" role="radiogroup">
    <button
      v-for="opt in options"
      :key="opt.value"
      type="button"
      role="radio"
      :aria-checked="modelValue === opt.value"
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
  gap: 2px;
  padding: 2px;
  background: #f1f5f9;
  border-radius: 8px;
}

[data-dt-dark] .dt-segmented {
  background: #0f172a;
}

.dt-segmented-btn {
  border: none;
  background: transparent;
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 500;
  border-radius: 6px;
  color: #64748b;
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
}

.dt-segmented-btn:hover {
  color: #334155;
}

.dt-segmented-btn.active {
  background: linear-gradient(135deg, #6366f1, #3b82f6);
  color: #fff;
  box-shadow: 0 1px 3px rgba(99, 102, 241, 0.3);
}

.dt-segmented-btn:active {
  transform: scale(0.96);
}

[data-dt-dark] .dt-segmented-btn {
  color: #8b949e;
}

[data-dt-dark] .dt-segmented-btn:hover {
  color: #c9d1d9;
}

[data-dt-dark] .dt-segmented-btn.active {
  color: #fff;
}

/* 尺寸变体：sm 用于紧凑场景 */
.dt-segmented--sm .dt-segmented-btn {
  padding: 2px 8px;
  font-size: 12px;
}
</style>
