<script setup lang="ts">
/**
 * 共享按钮组件 — 独立工具标签页统一按钮样式。
 *
 * 变体：default（边框）/ primary（主色渐变）/ secondary（灰底）/ danger（红色）
 * 尺寸：md（默认）/ sm / xs（紧凑小按钮，DevLogsViewer 等用）；icon 为紧凑内边距（图标或短文本按钮）
 *
 * 用法：<DtButton variant="primary" size="sm" icon :disabled="..." @click="...">…</DtButton>
 * class / title / @click 等属性与事件自动落到根 <button> 上。
 */
withDefaults(
  defineProps<{
    variant?: 'default' | 'primary' | 'secondary' | 'danger' | 'ghost';
    size?: 'md' | 'sm' | 'xs';
    icon?: boolean;
    disabled?: boolean;
  }>(),
  { variant: 'default', size: 'md', icon: false, disabled: false },
);
</script>

<template>
  <button
    type="button"
    :class="[
      'dt-button',
      `dt-button--${variant}`,
      {
        'dt-button--sm': size === 'sm',
        'dt-button--xs': size === 'xs',
        'dt-button--icon': icon,
      },
    ]"
    :disabled="disabled"
  >
    <slot />
  </button>
</template>

<style scoped>
.dt-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 5px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  background: #fff;
  color: #374151;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.2s ease;
}

.dt-button:hover {
  background: #f1f5f9;
  border-color: #cbd5e1;
}

[data-dt-dark] .dt-button {
  background: var(--dt-dark-surface-hover);
  border-color: var(--dt-dark-border);
  color: #c9d1d9;
}

[data-dt-dark] .dt-button:hover {
  background: var(--dt-dark-border);
}

.dt-button:active {
  transform: scale(0.98);
}

.dt-button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
}

/* 主色渐变 */
.dt-button--primary {
  background: linear-gradient(135deg, #6366f1, #3b82f6);
  border-color: transparent;
  color: #fff;
  box-shadow: 0 1px 3px rgba(99, 102, 241, 0.3);
}

.dt-button--primary:hover {
  background: linear-gradient(135deg, #4f46e5, #2563eb);
  border-color: transparent;
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);
  transform: translateY(-1px);
}

.dt-button--primary:active {
  transform: scale(0.98);
}

/* 次要（灰底） */
.dt-button--secondary {
  background: #f1f5f9;
}

[data-dt-dark] .dt-button--secondary {
  background: var(--dt-dark-surface-hover);
}

/* 危险（红色实心） */
.dt-button--danger {
  background: #dc2626;
  border-color: transparent;
  color: #fff;
}

.dt-button--danger:hover {
  background: #b91c1c;
  border-color: transparent;
  box-shadow: 0 4px 12px rgba(220, 38, 38, 0.3);
}

/* 低频操作（ghost）：无边框无底，降权，hover 才出现底 */
.dt-button--ghost {
  background: transparent;
  border-color: transparent;
  color: #64748b;
}

.dt-button--ghost:hover {
  background: #f1f5f9;
  border-color: transparent;
  color: #374151;
}

[data-dt-dark] .dt-button--ghost {
  background: transparent;
  border-color: transparent;
  color: #8b949e;
}

[data-dt-dark] .dt-button--ghost:hover {
  background: var(--dt-dark-surface-hover);
  color: #c9d1d9;
}

/* 尺寸变体 */
.dt-button--sm {
  padding: 3px 8px;
  font-size: 12px;
}

.dt-button--xs {
  padding: 2px 8px;
  font-size: 12px;
}

.dt-button--icon {
  padding: 5px 8px;
}

.dt-button--sm.dt-button--icon {
  padding: 2px 6px;
}
</style>
