<script setup lang="ts">
/**
 * Setting Item 行容器(ADR-0007):单行左右布局——左侧 label + hint,右侧控件。
 * 放入 DtConfigSection 分组；窄容器内控件移至文字下方。
 *
 * 用法:
 *   <DtConfigItem label="默认输出格式" hint="「源码」视图的输出格式">
 *     <DtSegmented v-model="config.format" :options="..." />
 *   </DtConfigItem>
 *
 * 开关行(文字在 label,右侧只有开关):
 *   <DtConfigItem label="字段变化后自动生成" hint="关闭后需手动生成">
 *     <DtToggle v-model="config.autoGenerate" />
 *   </DtConfigItem>
 *
 * 整块内容(颜色图例等)用 stack 变体,控件区占满整行:
 *   <DtConfigItem label="差异颜色说明" layout="stack">…</DtConfigItem>
 */
import { computed, provide } from 'vue';

const props = withDefaults(
  defineProps<{
    /** 设置项标题 */
    label?: string;
    /** 辅助说明,位于 label 下方 */
    hint?: string;
    /** row(默认)左右布局 / stack 上下布局 */
    layout?: 'row' | 'stack';
  }>(),
  { label: undefined, hint: undefined, layout: 'row' },
);

provide(
  'dt-config-item-label',
  computed(() => props.label),
);
</script>

<template>
  <div class="dt-config-item" :class="{ stack: layout === 'stack' }">
    <div class="dt-config-text">
      <span v-if="label" class="dt-config-label">{{ label }}</span>
      <p v-if="hint" class="dt-config-hint">{{ hint }}</p>
    </div>
    <div class="dt-config-control">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.dt-config-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 16px 0;
  min-width: 0;
}

/* 项间发丝分割线(首项无上线,末项无下线由容器边界收尾) */
.dt-config-item:not(:last-child) {
  border-bottom: 1px solid var(--config-line, #e2e8f0);
}

[data-dt-dark] .dt-config-item:not(:last-child) {
  border-bottom-color: var(--config-line, #303b4c);
}

.dt-config-item.stack {
  display: block;
}

.dt-config-text {
  flex: 1;
  min-width: 0;
}

.dt-config-label {
  display: block;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--config-ink, #0f172a);
}

[data-dt-dark] .dt-config-label {
  color: var(--config-ink, #f1f5f9);
}

.dt-config-hint {
  font-size: 13px;
  color: var(--config-secondary, #52637a);
  margin: 5px 0 0;
  line-height: 1.65;
  overflow-wrap: anywhere;
}

[data-dt-dark] .dt-config-hint {
  color: var(--config-secondary, #a5b2c4);
}

.dt-config-control {
  max-width: 100%;
  min-width: 0;
  flex: 0 1 auto;
  display: flex;
  align-items: center;
}

.stack .dt-config-control {
  margin-top: 12px;
  display: block;
}

@container dt-config (max-width: 560px) {
  .dt-config-item { flex-wrap: wrap; gap: 12px; }
  .dt-config-text { flex-basis: 100%; }
  .dt-config-control { flex-shrink: 1; }
}
</style>
