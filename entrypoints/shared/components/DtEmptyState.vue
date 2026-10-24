<script setup lang="ts">
/**
 * 共享空态组件 — 独立工具标签页统一的空状态引导。
 *
 * 两种形态：
 * - 默认：填充父容器的居中占位（面板结果区未生成内容时）
 * - overlay：绝对定位覆盖整个相对定位父级（空编辑器遮罩，点击聚焦输入）
 *
 * 用法：
 *   <DtEmptyState>
 *     <template #icon><div class="i-lucide-braces w-8 h-8" /></template>
 *     点击"格式化"查看结果
 *   </DtEmptyState>
 *
 *   <DtEmptyState overlay @click="focus">
 *     <template #icon><div class="i-lucide-file-json w-8 h-8" /></template>
 *     粘贴 JSON，或拖入 .json 文件
 *     <template #actions><DtButton variant="primary">填入示例</DtButton></template>
 *   </DtEmptyState>
 */
withDefaults(defineProps<{ overlay?: boolean }>(), { overlay: false });
</script>

<template>
  <div :class="['dt-empty-state', { 'dt-empty-state--overlay': overlay }]">
    <div v-if="$slots.icon" class="dt-empty-state-icon">
      <slot name="icon" />
    </div>
    <p class="dt-empty-state-text"><slot /></p>
    <p v-if="$slots.hint" class="dt-empty-state-hint"><slot name="hint" /></p>
    <div v-if="$slots.actions" class="dt-empty-state-actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.dt-empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #94a3b8;
  font-size: 13px;
  text-align: center;
}

[data-dt-dark] .dt-empty-state {
  color: var(--dt-dark-text-muted);
}

.dt-empty-state-icon {
  display: flex;
  opacity: 0.35;
  margin-bottom: 8px;
  color: #94a3b8;
}

[data-dt-dark] .dt-empty-state-icon {
  color: #8b949e;
}

.dt-empty-state-text {
  margin: 0;
}

/* 次级引导：告诉用户下一步能做什么（粘贴/拖入/快捷键） */
.dt-empty-state-hint {
  margin: 6px 0 0;
  font-size: 12px;
  opacity: 0.75;
}

.dt-empty-state-actions {
  margin-top: 8px;
}

/* 覆盖式空态：盖满相对定位的父容器（如空编辑器），点击可聚焦输入 */
.dt-empty-state--overlay {
  position: absolute;
  inset: 0;
  z-index: 10;
  background: #fff;
  color: #64748b;
  cursor: text;
  user-select: none;
}

[data-dt-dark] .dt-empty-state--overlay {
  background: #161b22;
  color: #8b949e;
}

.dt-empty-state--overlay .dt-empty-state-text {
  font-weight: 500;
}
</style>
