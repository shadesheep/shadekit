<script setup lang="ts">
/**
 * 配置页标题栏(ADR-0007):页面标题 + 自动保存状态反馈。
 * 常态显示「更改自动保存」灰字;保存成功短暂变「✓ 已保存」后淡回(不弹 toast)。
 *
 * 用法:<DtConfigHeader title="模拟数据设置" :save-state="saveState" />
 */
import type { SaveState } from './use-tool-config';

defineProps<{
  title: string;
  saveState: SaveState;
}>();
</script>

<template>
  <div class="dt-config-header">
    <h3 class="dt-config-title">{{ title }}</h3>
    <span
      class="dt-save-status"
      :class="{ saved: saveState === 'saved' }"
      aria-live="polite"
    >
      <template v-if="saveState === 'saved'">
        <span class="i-lucide-check w-3 h-3" />
        已保存
      </template>
      <template v-else>更改自动保存</template>
    </span>
  </div>
</template>

<style scoped>
.dt-config-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}

.dt-config-title {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
  color: #0f172a;
}

[data-dt-dark] .dt-config-title {
  color: #f1f5f9;
}

.dt-save-status {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  color: #94a3b8;
  transition: color 0.2s ease;
  flex-shrink: 0;
}

[data-dt-dark] .dt-save-status {
  color: #6e7681;
}

.dt-save-status.saved {
  color: #16a34a;
}

[data-dt-dark] .dt-save-status.saved {
  color: #4ade80;
}
</style>
