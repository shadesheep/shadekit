<script setup lang="ts">
/**
 * 共享面板组件 — 独立工具标签页统一的卡片容器。
 *
 * 提供：卡片外观（圆角/边框/阴影/暗色）与可选头部（标题 + 附加内容 + 右侧操作区）。
 * 布局尺寸（flex 占比等）通过 class 落到根元素上，由 page-styles.scss 或页面自有样式控制。
 *
 * 用法：
 *   <DtPanel class="editor-panel" title="输出" @drop="...">
 *     <template #header-extra><span class="badge">JS</span></template>
 *     <template #actions><DtButton size="sm">全部展开</DtButton></template>
 *     …面板内容…
 *   </DtPanel>
 */
defineProps<{ title?: string }>();
</script>

<template>
  <div class="dt-panel">
    <div
      v-if="title || $slots['header-extra'] || $slots.actions"
      class="dt-panel-header"
    >
      <span v-if="title" class="dt-panel-title">{{ title }}</span>
      <slot name="header-extra" />
      <div v-if="$slots.actions" class="dt-panel-actions">
        <slot name="actions" />
      </div>
    </div>
    <slot />
  </div>
</template>

<style scoped>
.dt-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 10px;
  border: 1px solid #e2e8f0;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

[data-dt-dark] .dt-panel {
  background: #161b22;
  border-color: var(--dt-dark-border);
}

.dt-panel-header {
  padding: 8px 14px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary, #64748b);
  border-bottom: 1px solid #e2e8f0;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

[data-dt-dark] .dt-panel-header {
  border-color: var(--dt-dark-border);
}

.dt-panel-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
}
</style>
