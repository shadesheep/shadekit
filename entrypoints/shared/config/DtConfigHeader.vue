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
  description?: string;
  saveState: SaveState;
}>();
</script>

<template>
  <div class="dt-config-header">
    <div>
      <h3 class="dt-config-title">{{ title }}</h3>
      <p v-if="description" class="dt-config-description">{{ description }}</p>
    </div>
    <span
      class="dt-save-status"
      :class="{ saved: saveState === 'saved' }"
      aria-live="polite"
    >
      <template v-if="saveState === 'saved'">
        <span class="i-lucide-check w-3 h-3" aria-hidden="true" />
        已保存
      </template>
      <template v-else>
        <span class="i-lucide-cloud-check w-3.5 h-3.5" aria-hidden="true" />
        更改自动保存
      </template>
    </span>
  </div>
</template>

<style scoped>
.dt-config-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 22px;
}

.dt-config-title {
  font-size: 20px;
  font-weight: 600;
  margin: 0;
  color: var(--config-ink, #0f172a);
}

[data-dt-dark] .dt-config-title {
  color: var(--config-ink, #f1f5f9);
}

.dt-config-description {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--config-secondary, #52637a);
}

.dt-save-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding-top: 4px;
  font-size: 12px;
  color: var(--config-secondary, #52637a);
  transition: color 0.2s ease;
  flex-shrink: 0;
}

[data-dt-dark] .dt-save-status {
  color: var(--config-secondary, #a5b2c4);
}

.dt-save-status.saved {
  color: #16a34a;
}

[data-dt-dark] .dt-save-status.saved {
  color: #4ade80;
}
</style>
