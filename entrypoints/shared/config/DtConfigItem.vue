<script setup lang="ts">
/**
 * Setting Item 行容器(ADR-0007):单行左右布局——左侧 label + hint,右侧控件。
 * 项间以发丝分割线分隔,配置项多时一屏可放 8+ 行,扫读 label 列即可定位。
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
    /** 辅助说明,12px 灰字,位于 label 下方 */
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
      <label v-if="label" class="dt-config-label">{{ label }}</label>
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
  gap: 16px;
  padding: 10px 12px;
}

/* 项间发丝分割线(首项无上线,末项无下线由容器边界收尾) */
.dt-config-item:not(:last-child) {
  border-bottom: 1px solid #f1f5f9;
}

[data-dt-dark] .dt-config-item:not(:last-child) {
  border-bottom-color: #21262d;
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
  font-size: 13px;
  font-weight: 500;
  color: #0f172a;
}

[data-dt-dark] .dt-config-label {
  color: #c9d1d9;
}

.dt-config-hint {
  font-size: 12px;
  color: #94a3b8;
  margin: 2px 0 0;
  line-height: 1.5;
}

[data-dt-dark] .dt-config-hint {
  color: #6e7681;
}

.dt-config-control {
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

.stack .dt-config-control {
  margin-top: 8px;
  display: block;
}
</style>
