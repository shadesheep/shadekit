<script setup lang="ts">
import { computed, defineAsyncComponent, markRaw, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { copyToClipboard } from '../shared/clipboard';
import { listNavKeydown } from '../shared/list-nav';
import { sendBgMessage } from '../shared/messages';
import ToastContainer from '../shared/ToastContainer.vue';
import { allTools } from '../shared/tool-definitions';
import { toolIconGradient } from '../shared/tool-icon-colors';
import { isToolEnabled } from '../shared/tool-state';
import {
  formatShortcut,
  useCommandShortcut,
} from '../shared/use-command-shortcut';
import { showToast } from '../shared/use-toast';

const logoUrl = ref('');

interface PopupToolItem {
  id: string;
  name: string;
  icon: string;
  hasPopup: boolean;
  popupComponent?: () => Promise<{ default: unknown }>;
  openInTabUrl?: string;
}

// Auto-discover all Popup.vue components from the tools directory
const popupModules = (import.meta as ImportMeta & { glob: (pattern: string, options: { eager: boolean }) => Record<string, unknown> }).glob(
  '../tools/*/Popup.vue',
  { eager: false },
) as Record<string, () => Promise<{ default: unknown }>>;

const popupComponents: Record<string, () => Promise<{ default: unknown }>> = {};
for (const [path, loader] of Object.entries(popupModules)) {
  // Extract tool-id from path: '../tools/{tool-id}/Popup.vue'
  const match = path.match(/tools\/([^/]+)\/Popup\.vue$/);
  if (match) {
    popupComponents[match[1]] = loader;
  }
}

const tools = ref<PopupToolItem[]>([]);
const activeTool = ref<string | null>(null);
// 被禁用的工具数量（用于可发现性提示）
const disabledCount = ref(0);

// 账号切换快捷键状态（null = 查询中；'' = 未注册/被占用）
const { shortcut, updating, updateSupported, refresh, enableSuggested } =
  useCommandShortcut();

// 键盘导航选中索引（-1 = 无选中，鼠标 hover 会同步该值）
const selectedIndex = ref(-1);
const toolListEl = ref<HTMLElement | null>(null);

// 各工具的辅助提示文案
const toolHints: Record<string, string> = {
  'json-formatter': '可选中文字右键调用',
  'json-diff': '可选中文字右键调用',
};

const activeComponent = computed(() => {
  if (!activeTool.value) return null;
  const tool = tools.value.find((t) => t.id === activeTool.value);
  return tool?.popupComponent
    ? markRaw(defineAsyncComponent(tool.popupComponent))
    : null;
});

// 账号切换工具是否在列表中（禁用时不必提示快捷键问题）
const hasAccountSwitch = computed(() =>
  tools.value.some((t) => t.id === 'account-switch'),
);

onMounted(async () => {
  logoUrl.value = chrome.runtime.getURL('logo_48.png');

  for (const tool of allTools) {
    if (!tool.popupAction && !tool.openInTab) continue;
    const enabled = await isToolEnabled(tool.id, tool.enabledByDefault);
    if (!enabled) {
      disabledCount.value++;
      continue;
    }

    tools.value.push({
      id: tool.id,
      name: tool.name,
      icon: tool.icon,
      hasPopup: !!tool.popupAction,
      popupComponent: popupComponents[tool.id],
      openInTabUrl: tool.openInTab?.url,
    });
  }

  // 读取账号切换快捷键状态（用户可能在 chrome://extensions/shortcuts 改绑/清除过）
  refresh();

  // 单工具：跳过列表页，直接展示工具内容
  if (tools.value.length === 1) {
    const tool = tools.value[0];
    if (tool.openInTabUrl) {
      chrome.tabs.create({ url: chrome.runtime.getURL(tool.openInTabUrl) });
      window.close();
      return;
    }
    if (tool.hasPopup && tool.popupComponent) {
      activeTool.value = tool.id;
    }
  }

  window.addEventListener('keydown', handleListKeydown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleListKeydown);
});

// ↑↓ 移动选中、Enter 打开；仅在工具列表视图（无子面板）时响应
const handleListKeydown = (e: KeyboardEvent) => {
  if (activeTool.value) return;
  // 焦点在按钮等交互元素上时不劫持按键（如引导条的「去设置」按钮）
  if (e.target instanceof HTMLElement && e.target.closest('button, a, input, textarea')) {
    return;
  }
  const action = listNavKeydown(e.key, selectedIndex.value, tools.value.length);
  if (!action) return;
  e.preventDefault();
  if (action.type === 'move') {
    selectedIndex.value = action.index;
    nextTick(() => {
      toolListEl.value
        ?.querySelector('.tool-item.focused')
        ?.scrollIntoView({ block: 'nearest' });
    });
  } else {
    const tool = tools.value[action.index];
    if (tool) openTool(tool);
  }
};

// 快捷键设置页地址（chrome:// 不允许编程式打开，只能复制给用户粘贴）
const shortcutsPageUrl = navigator.userAgent.includes('Edg')
  ? 'edge://extensions/shortcuts'
  : 'chrome://extensions/shortcuts';

const handleEnableShortcut = async () => {
  try {
    await enableSuggested();
    if (shortcut.value) {
      showToast(`快捷键已设置为 ${formatShortcut(shortcut.value)}`, 'success');
    } else {
      // update 成功但仍未注册（被占用），明确告知而非静默
      showToast('设置未生效，快捷键可能被占用，请手动设置', 'error', 4000);
    }
  } catch (e) {
    showToast(e instanceof Error ? e.message : '设置失败', 'error');
  }
};

const copyShortcutsPageUrl = async () => {
  const ok = await copyToClipboard(shortcutsPageUrl);
  if (ok) {
    showToast('设置页地址已复制，请在地址栏粘贴打开', 'info', 3000);
  } else {
    showToast(`请手动打开 ${shortcutsPageUrl}`, 'info', 4000);
  }
};

const openOptions = () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
};

const openTool = (tool: PopupToolItem, forceNew = false) => {
  // 有 openInTab 声明的工具 → 新标签页打开（走 background 统一复用逻辑）
  if (tool.openInTabUrl) {
    void sendBgMessage('OPEN_TOOL_TAB', { tool: tool.id, forceNew });
    return;
  }
  // 有 popup 的工具 → popup 内显示
  if (tool.hasPopup) {
    activeTool.value = tool.id;
  }
};

const goBack = () => {
  activeTool.value = null;
  selectedIndex.value = -1;
};
</script>

<template>
  <div class="popup-container" data-dt-root>
    <!-- Header -->
    <div class="header">
      <button v-if="activeTool" class="btn-back" @click="goBack" title="返回">
        <div class="i-lucide-chevron-left w-4 h-4" />
      </button>
      <span class="title">
        <img :src="logoUrl" class="logo-img" alt="ShadeKit" />
        ShadeKit
      </span>
      <button class="btn-settings" @click="openOptions" title="设置">
        <div class="i-lucide-settings w-4 h-4" />
      </button>
    </div>

    <!-- Tool list -->
    <div v-if="!activeTool" ref="toolListEl" class="tool-list">
      <div
        v-for="(tool, index) in tools"
        :key="tool.id"
        class="tool-item"
        :class="{ focused: index === selectedIndex }"
        :title="tool.openInTabUrl ? '中键点击可在新标签页打开' : undefined"
        @click="openTool(tool)"
        @auxclick.middle.prevent="openTool(tool, true)"
        @mouseenter="selectedIndex = index"
        @mouseleave="selectedIndex = -1"
      >
        <div class="tool-icon-wrapper" :style="{ background: toolIconGradient(tool.id) }">
          <div :class="[tool.icon, 'tool-icon']" />
        </div>
        <div class="tool-text">
          <span class="tool-name">{{ tool.name }}</span>
          <span v-if="toolHints[tool.id]" class="tool-hint">{{ toolHints[tool.id] }}</span>
        </div>
        <kbd v-if="tool.id === 'account-switch' && shortcut" class="shortcut-badge">
          {{ formatShortcut(shortcut) }}
        </kbd>
        <div v-if="tool.openInTabUrl" class="i-lucide-external-link w-3.5 h-3.5 text-slate-300 dark:text-slate-600" />
        <div v-else class="i-lucide-chevron-right w-4 h-4 text-slate-300 dark:text-slate-600" />
      </div>

      <div v-if="tools.length === 0" class="empty-state">
        <div class="i-lucide-inbox w-12 h-12 text-slate-300 dark:text-slate-600 mb-3 animate-pulse" />
        <p class="text-sm text-slate-400 dark:text-slate-500 mb-1">没有已启用的工具</p>
        <p v-if="disabledCount > 0" class="text-xs text-slate-400 dark:text-slate-500 mb-3">
          有 {{ disabledCount }} 个工具被禁用
        </p>
        <button class="dt-btn-primary" @click="openOptions">前往设置</button>
      </div>

      <div
        v-else-if="disabledCount > 0"
        class="disabled-hint"
        @click="openOptions"
      >
        <div class="i-lucide-eye-off w-3.5 h-3.5" />
        <span>{{ disabledCount }} 个工具已禁用</span>
      </div>

      <!-- 账号切换快捷键未注册/被占用时的引导（空串 = 已查询但未生效） -->
      <div v-if="shortcut === '' && hasAccountSwitch" class="shortcut-missing-hint">
        <div class="i-lucide-alert-triangle w-3.5 h-3.5" />
        <span class="shortcut-missing-text">账号切换快捷键未生效</span>
        <button
          v-if="updateSupported"
          class="shortcut-fix-btn"
          :disabled="updating"
          @click="handleEnableShortcut"
        >
          {{ updating ? '设置中…' : '一键设置' }}
        </button>
        <button v-else class="shortcut-fix-btn" @click="copyShortcutsPageUrl">
          去设置
        </button>
      </div>
    </div>

    <!-- Tool sub-views -->
    <component v-else-if="activeComponent" :is="activeComponent" />

    <!-- Default behavior -->
    <div v-else class="tool-default-view">
      <p class="text-sm text-slate-400 dark:text-slate-500">此工具没有弹出页</p>
    </div>

    <ToastContainer />
  </div>
</template>

<style scoped lang="scss">
@use '../shared/component-styles.scss' as *;

.popup-container {
  padding: 10px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  width: 100%;
  min-width: 280px;
  max-width: 320px;
  box-sizing: border-box;
  color: var(--text-primary);
}

/* Header */
.header {
  @extend .dt-flex;
  @extend .dt-items-center;
  @extend .dt-justify-between;
  margin-bottom: 8px;
  padding: 6px 8px;
  background: rgba(99, 102, 241, 0.06);
  border-radius: var(--radius-lg);
}

[data-dt-dark] .header {
  background: rgba(129, 140, 248, 0.1);
}

.title {
  font-weight: 600;
  font-size: var(--text-md);
  flex: 1;
  text-align: center;
  color: var(--text-primary);
  @extend .dt-flex;
  @extend .dt-items-center;
  @extend .dt-justify-center;
  gap: 6px;
}

.logo-img {
  width: 18px;
  height: 18px;
  object-fit: contain;
}

.btn-back,
.btn-settings {
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 4px;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  @extend .dt-flex;
  @extend .dt-items-center;
  @extend .dt-justify-center;
  transition: all var(--transition-normal);
}

.btn-back:hover,
.btn-settings:hover {
  background: rgba(0, 0, 0, 0.05);
}

[data-dt-dark] .btn-back:hover,
[data-dt-dark] .btn-settings:hover {
  background: rgba(255, 255, 255, 0.08);
}

.btn-settings:hover .i-lucide-settings {
  transform: rotate(45deg);
}

/* Tool list */
.tool-list {
  @extend .dt-flex-col;
  gap: 4px;
}

.tool-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-lg);
  cursor: pointer;
  transition: all var(--transition-normal);
  border: 1px solid transparent;
}

.tool-item:hover {
  background: #fff;
  border-color: #e2e8f0;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
  transform: translateY(-1px);
}

[data-dt-dark] .tool-item:hover {
  background: #1e293b;
  border-color: #334155;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
}

/* 键盘导航焦点态：主色描边 + ring，与 hover 态区分且在亮/暗下均清晰可见 */
.tool-item.focused {
  background: #fff;
  border-color: var(--primary-start);
  box-shadow:
    0 0 0 2px rgba(99, 102, 241, 0.18),
    0 1px 3px rgba(0, 0, 0, 0.06);
}

[data-dt-dark] .tool-item.focused {
  background: #1e293b;
  border-color: #818cf8;
  box-shadow:
    0 0 0 2px rgba(129, 140, 248, 0.25),
    0 1px 3px rgba(0, 0, 0, 0.3);
}

.tool-icon-wrapper {
  width: 32px;
  height: 32px;
  @extend .dt-flex;
  @extend .dt-items-center;
  @extend .dt-justify-center;
  border-radius: var(--radius-lg);
  /* 背景渐变由 :style 按 tool.id 动态注入（tool-icon-colors.ts） */
  flex-shrink: 0;
}

.tool-icon {
  font-size: 18px;
  color: #fff;
}

.tool-name {
  font-size: var(--text-base);
  font-weight: 500;
  color: var(--text-primary);
}

.tool-text {
  flex: 1;
  @extend .dt-flex-col;
  gap: 1px;
  min-width: 0;
}

.tool-hint {
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.shortcut-badge {
  font-size: var(--text-xs);
  font-family: inherit;
  color: var(--text-muted);
  background: rgba(0, 0, 0, 0.04);
  border-radius: 4px;
  padding: 1px 5px;
  white-space: nowrap;
}

[data-dt-dark] .shortcut-badge {
  background: rgba(255, 255, 255, 0.06);
}

.disabled-hint {
  @extend .dt-flex;
  @extend .dt-items-center;
  @extend .dt-justify-center;
  gap: 5px;
  margin-top: 6px;
  padding: 6px;
  font-size: var(--text-xs);
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius-md);
  transition: all var(--transition-normal);
}

.disabled-hint:hover {
  background: rgba(0, 0, 0, 0.04);
  color: var(--text-secondary);
}

[data-dt-dark] .disabled-hint:hover {
  background: rgba(255, 255, 255, 0.06);
}

/* 快捷键未生效引导条（琥珀色警示，与 Config.vue 快捷键状态块语义色一致） */
.shortcut-missing-hint {
  @extend .dt-flex;
  @extend .dt-items-center;
  gap: 6px;
  margin-top: 6px;
  padding: 7px 10px;
  font-size: var(--text-xs);
  color: var(--warning);
  background: var(--warning-bg);
  border: 1px solid var(--warning-border);
  border-radius: var(--radius-md);
}

[data-dt-dark] .shortcut-missing-hint {
  color: var(--warning-dark);
  background: var(--warning-bg-dark);
  border-color: var(--warning-border-dark);
}

.shortcut-missing-text {
  flex: 1;
}

.shortcut-fix-btn {
  @extend .dt-btn-gradient;
  flex-shrink: 0;
  padding: 2px 10px;
  font-size: var(--text-xs);
  border-radius: var(--radius-md);
}

/* Empty state */
.empty-state {
  @extend .dt-empty-state;
  padding: 28px 16px;
}

/* Primary button */
.dt-btn-primary {
  @extend .dt-btn-gradient;
  padding: 6px 16px;
  font-size: var(--text-base);
  border-radius: var(--radius-lg);
}

.tool-default-view {
  text-align: center;
  padding: 16px;
}
</style>
