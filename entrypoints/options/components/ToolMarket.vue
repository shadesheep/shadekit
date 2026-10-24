<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { allTools } from '../../shared/tool-definitions';
import { toolIconGradient } from '../../shared/tool-icon-colors';
import { isToolEnabled, setToolEnabled } from '../../shared/tool-state';

interface ToolCard {
  id: string;
  name: string;
  description: string;
  icon: string;
  enabled: boolean;
  hasConfig: boolean;
}

const tools = ref<ToolCard[]>([]);

onMounted(async () => {
  const states: Record<string, boolean> = {};
  for (const tool of allTools) {
    states[tool.id] = await isToolEnabled(tool.id, tool.enabledByDefault);
  }
  tools.value = allTools.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    icon: t.icon,
    enabled: states[t.id],
    hasConfig: !!t.configSection,
  }));
});

async function toggleTool(tool: ToolCard) {
  tool.enabled = !tool.enabled;
  const ok = await setToolEnabled(tool.id, tool.enabled);
  if (!ok) {
    // 写入失败（setToolEnabled 已提示用户）：回滚开关状态，避免 UI 与实际状态不符
    tool.enabled = !tool.enabled;
  }
}
</script>

<template>
  <div class="tool-market">
    <h2 class="section-title">
      <div class="i-lucide-puzzle w-4 h-4 inline mr-1" />
      工具总览
    </h2>
    <p class="section-desc">所有工具已内置，通过开关控制启用/禁用</p>

    <div class="tool-grid">
      <div
        v-for="tool in tools"
        :key="tool.id"
        class="tool-card"
        :class="{ disabled: !tool.enabled }"
      >
        <div class="card-header">
          <div class="card-icon-wrapper" :style="{ background: toolIconGradient(tool.id) }">
            <div :class="[tool.icon, 'card-icon']" />
          </div>
          <label class="toggle-switch">
            <input type="checkbox" :checked="tool.enabled" @change="toggleTool(tool)" />
            <span class="toggle-slider" />
          </label>
        </div>
        <div class="card-name">{{ tool.name }}</div>
        <div class="card-desc">{{ tool.description }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-market {
  padding: 4px 0;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  margin: 0 0 4px;
  color: #0f172a;
  display: flex;
  align-items: center;
}

[data-dt-dark] .section-title {
  color: #f1f5f9;
}

.section-desc {
  font-size: 12px;
  color: #94a3b8;
  margin: 0 0 16px;
}

[data-dt-dark] .section-desc {
  color: var(--dt-dark-text-muted);
}

.tool-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 16px;
}

.tool-card {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 16px;
  transition: all 0.2s ease-out;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

[data-dt-dark] .tool-card {
  background: var(--dt-dark-surface-1);
  border-color: var(--dt-dark-border);
  box-shadow: var(--dt-dark-shadow-sm),
              var(--dt-dark-shadow-inset);
}

.tool-card.disabled {
  opacity: 0.5;
  background: #f8fafc;
}

[data-dt-dark] .tool-card.disabled {
  background: var(--dt-dark-base);
  opacity: 0.4;
}

.tool-card:hover {
  border-color: #93c5fd;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  transform: translateY(-1px);
}

[data-dt-dark] .tool-card:hover {
  border-color: var(--dt-dark-border-accent);
  box-shadow: var(--dt-dark-shadow-md),
              var(--dt-dark-shadow-inset-strong),
              0 0 0 1px rgba(99, 102, 241, 0.08);
  transform: translateY(-2px);
}

.tool-card:active {
  transform: translateY(0) scale(0.99);
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.card-icon-wrapper {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  /* 背景渐变由 :style 按 tool.id 动态注入（tool-icon-colors.ts） */
}

.card-icon {
  font-size: 20px;
  color: #fff;
}

.card-name {
  font-size: 14px;
  font-weight: 600;
  color: #0f172a;
  margin-bottom: 4px;
}

[data-dt-dark] .card-name {
  color: #f1f5f9;
}

.card-desc {
  font-size: 12px;
  color: #64748b;
  line-height: 1.4;
  /* 两行占位：描述长短不一时卡片仍等高 */
  min-height: calc(1.4em * 2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

[data-dt-dark] .card-desc {
  color: var(--dt-dark-text-secondary);
}
</style>
