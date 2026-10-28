<script setup lang="ts">
import {computed, defineAsyncComponent, markRaw, onMounted, onUnmounted, ref} from 'vue';
import {
  getAllConfig,
  isExportableConfigId,
  setAllConfig,
} from '../shared/config-transfer';
import { migrateConfig } from '../shared/tool-config';
import type {ThemeMode} from '../shared/use-theme';
import {
  applyTheme,
  getStoredTheme,
  setStoredTheme,
} from '../shared/use-theme';
import {showToast} from '../shared/use-toast';
import ToastContainer from '../shared/ToastContainer.vue';
import {DevModeClickCounter, isDevModeEnabled, onDevModeChange, setDevModeEnabled} from '../shared/dev-mode';
import ToolMarket from './components/ToolMarket.vue';
import {getConfigSections} from './tool-registry';
import {subscribeOptionsRoute} from './options-route';

type View = 'market' | string;

const logoUrl = ref('');
const allConfigFileInput = ref<HTMLInputElement | null>(null);
const themeMode = ref<ThemeMode>(getStoredTheme());
// 仓库地址统一取扩展元数据（wxt.config.ts manifest.homepage_url），避免多处硬编码
const repoUrl = chrome.runtime.getManifest().homepage_url ?? '';

interface ConfigSectionItem {
  id: string;
  label: string;
  icon?: string;
  component: any;
}

const sections = ref<ConfigSectionItem[]>([]);
const activeView = ref<View>('market');
const editEnv = ref<string | undefined>(undefined);
let unsubscribeOptionsRoute: (() => void) | undefined;

const activeComponent = computed(() => {
  if (activeView.value === 'market') return null;
  if (activeView.value === 'dev-logs') return DevLogsViewer;
  const section = sections.value.find((s) => s.id === activeView.value);
  return section?.component ?? null;
});

const activeComponentProps = computed(() =>
  activeView.value === 'account-switch'
    ? { editEnv: editEnv.value, onEditEnvConsumed: clearEditEnv }
    : {},
);

function clearEditEnv(): void {
  editEnv.value = undefined;
  const url = new URL(window.location.href);
  url.searchParams.delete('editEnv');
  window.history.replaceState({}, '', url);
}

// 开发者模式
const devMode = ref(false);
const logoClickCounter = new DevModeClickCounter();
let unsubscribeDevMode: (() => void) | null = null;
const DevLogsViewer = markRaw(defineAsyncComponent(() => import('./components/DevLogsViewer.vue')));

async function handleLogoClick() {
  const wasEnabled = await isDevModeEnabled();
  const activated = await logoClickCounter.recordClick();

  if (activated) {
    // 从关闭 → 开启（recordClick 内部已调用 setDevModeEnabled(true) 并 emit 事件）
    showToast('🔧 开发者模式已开启', 'success');
    return;
  }

  // 检查是否刚刚从开启 → 关闭（recordClick 达到阈值且原本已开启）
  const nowEnabled = await isDevModeEnabled();
  if (wasEnabled && !nowEnabled) {
    showToast('🔧 开发者模式已关闭', 'info');
    return;
  }

  // 尚未达到阈值，显示进度提示
  const remaining = logoClickCounter.getRemainingClicks();
  if (remaining > 0 && remaining < 5) {
    showToast(`再点击 ${remaining} 次开启开发者模式`, 'info');
  }
}

async function handleExitDevMode() {
  await setDevModeEnabled(false);
  showToast('🔧 开发者模式已关闭', 'info');
  // 切回工具总览，避免停留在已隐藏的调试日志视图
  activeView.value = 'market';
}

async function exportAllConfig() {
  try {
    const data = await getAllConfig();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `shadekit-config-${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('全部工具设置已导出', 'success');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '未知错误';
    showToast(`导出失败: ${msg}`, 'error');
  }
}

async function importAllConfig(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  // 重置 input，允许重复选择同一文件
  input.value = '';

  try {
    const text = await file.text();
    const data = JSON.parse(text) as Record<string, unknown>;
    const migrated = migrateConfig(data);
    // 只统计会真正落地的 key：导出文件里夹带的日志/死键会被 setAllConfig
    // 过滤掉，不能算进「N 个工具」让用户误以为要导入更多东西
    const toolCount = Object.keys(migrated).filter(
        (k) => !k.startsWith('__') && isExportableConfigId(k),
    ).length;
    if (toolCount === 0) {
      showToast('文件中没有可导入的工具设置', 'error');
      return;
    }
    if (
        !confirm(`将导入 ${toolCount} 个工具的全部设置，当前设置将被覆盖。确定继续？`)
    )
      return;

    const ok = await setAllConfig(migrated);
    if (!ok) {
      // 写入失败（如配额满）：setAllConfig 已提示用户，此处不展示成功反馈
      return;
    }
    showToast('全部工具设置已导入，刷新页面生效', 'success');
    // 刷新侧边栏
    const configSections = getConfigSections();
    sections.value = configSections.map((s) => ({
      id: s.id,
      label: s.label,
      icon: s.icon,
      component: markRaw(defineAsyncComponent(s.component)),
    }));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'JSON 格式错误';
    showToast(`导入失败: ${msg}`, 'error');
  }
}

/** 切换主题。 */
function changeTheme(mode: ThemeMode) {
  themeMode.value = mode;
  setStoredTheme(mode);
}

onMounted(async () => {
  logoUrl.value = chrome.runtime.getURL('logo_128.png');
  applyTheme(themeMode.value);
  // 从 storage 读取持久化的开发者模式状态
  devMode.value = await isDevModeEnabled();
  // 订阅全局状态变化（任何地方调用 setDevModeEnabled 都会同步到这里）
  unsubscribeDevMode = onDevModeChange((enabled) => {
    devMode.value = enabled;
  });
  const configSections = getConfigSections();
  sections.value = configSections.map((s) => ({
    id: s.id,
    label: s.label,
    icon: s.icon,
    component: markRaw(defineAsyncComponent(s.component)),
  }));

  // 支持 ?section=xxx 与账号失败恢复 ?editEnv=<envKey>，初次及后续 query 均解析。
  unsubscribeOptionsRoute = subscribeOptionsRoute((route) => {
    if (route.section && sections.value.some((s) => s.id === route.section)) {
      activeView.value = route.section;
    }
    editEnv.value = activeView.value === 'account-switch' ? route.editEnv : undefined;
  });
});

onUnmounted(() => {
  unsubscribeOptionsRoute?.();
  unsubscribeOptionsRoute = undefined;
  if (unsubscribeDevMode) {
    unsubscribeDevMode();
    unsubscribeDevMode = null;
  }
});
</script>

<template>
  <div class="options-container" data-dt-root>
    <div class="header">
      <div class="header-brand">
        <img :src="logoUrl" class="header-logo" alt="ShadeKit" @click="handleLogoClick"/>
        <div class="header-text">
          <h1>ShadeKit</h1>
          <p class="header-desc">浏览器开发者工具集合</p>
        </div>
      </div>

      <!-- 全局配置操作（全部工具设置：跨工具整包） -->
      <div class="header-actions">
        <button
          type="button"
          class="btn-import"
          title="导入全部工具的设置（整包覆盖）"
          @click="allConfigFileInput?.click()"
        >
          <div class="i-lucide-download w-4 h-4" aria-hidden="true"/>
          导入全部工具设置
        </button>
        <input
          ref="allConfigFileInput"
          type="file"
          accept=".json"
          class="hidden-file"
          @change="importAllConfig"
        />
        <button
          type="button"
          class="btn-export"
          title="导出全部工具的设置"
          aria-describedby="export-backup-warning"
          @click="exportAllConfig"
        >
          <div class="i-lucide-upload w-4 h-4" aria-hidden="true"/>
          导出全部工具设置
        </button>
        <p id="export-backup-warning" class="export-warning">
          导出文件包含明文账号密码，请勿随意分享。
        </p>
      </div>
    </div>

    <div class="main-layout">
      <!-- Sidebar -->
      <div class="sidebar">
        <div class="sidebar-nav">
          <button
              type="button"
              :class="['sidebar-item', { active: activeView === 'market' }]"
              :aria-current="activeView === 'market' ? 'page' : undefined"
              @click="activeView = 'market'"
          >
            <div class="i-lucide-puzzle sidebar-icon" aria-hidden="true"/>
            <span class="sidebar-label">工具总览</span>
          </button>
          <button
              v-for="section in sections"
              :key="section.id"
              type="button"
              :class="['sidebar-item', { active: activeView === section.id }]"
              :aria-current="activeView === section.id ? 'page' : undefined"
              @click="activeView = section.id"
          >
            <div :class="[section.icon, 'sidebar-icon']" aria-hidden="true"/>
            <span class="sidebar-label">{{ section.label }}</span>
          </button>

          <!-- 开发者模式入口 -->
          <template v-if="devMode">
            <div class="sidebar-divider"/>
            <button
                type="button"
                :class="['sidebar-item dev-mode', { active: activeView === 'dev-logs' }]"
                :aria-current="activeView === 'dev-logs' ? 'page' : undefined"
                @click="activeView = 'dev-logs'"
            >
              <div class="i-lucide-bug sidebar-icon" aria-hidden="true"/>
              <span class="sidebar-label">调试日志</span>
            </button>
            <button
                type="button"
                class="sidebar-item dev-mode-exit"
                title="点击退出开发者模式"
                @click="handleExitDevMode"
            >
              <div class="i-lucide-log-out sidebar-icon" aria-hidden="true"/>
              <span class="sidebar-label">退出开发者模式</span>
            </button>
          </template>
        </div>

        <!-- 主题切换移至侧边栏底部 -->
        <div class="sidebar-footer">
          <span class="sidebar-footer-label">主题</span>
          <div class="theme-switcher">
            <button
                v-for="m in ['system', 'light', 'dark'] as ThemeMode[]"
                :key="m"
                :class="['theme-btn', { active: themeMode === m }]"
                @click="changeTheme(m)"
                :aria-label="m === 'system' ? '跟随系统' : m === 'light' ? '浅色' : '深色'"
                :aria-pressed="themeMode === m"
                :title="m === 'system' ? '跟随系统' : m === 'light' ? '浅色' : '深色'"
            >
              <div v-if="m === 'system'" class="i-lucide-monitor w-3.5 h-3.5"/>
              <div v-else-if="m === 'light'" class="i-lucide-sun w-3.5 h-3.5"/>
              <div v-else class="i-lucide-moon w-3.5 h-3.5"/>
            </button>
          </div>

          <a
              v-if="repoUrl"
              class="github-link"
              :href="repoUrl"
              target="_blank"
              rel="noopener noreferrer"
              title="在 GitHub 查看源码 / 反馈问题"
          >
            <div class="i-lucide-github w-3.5 h-3.5"/>
            <span>GitHub</span>
          </a>
        </div>
      </div>

      <!-- Content area -->
      <div class="content-area">
        <ToolMarket v-if="activeView === 'market'"/>
        <component v-else-if="activeComponent" :is="activeComponent" v-bind="activeComponentProps"/>
      </div>
    </div>

    <ToastContainer/>
  </div>
</template>

<style scoped>
.options-container {
  /* 960 只够单栏表单；账号表格 + 环境轨道需要更宽的内容区（ADR-0017 主视图 B） */
  max-width: 1120px;
  margin: 0 auto;
  padding: 24px;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  box-sizing: border-box;
}

.options-container *,
.options-container input,
.options-container textarea,
.options-container select {
  box-sizing: border-box;
}

/* Header */
.header {
  margin-bottom: 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}

.header-brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.header-text h1 {
  font-size: 22px;
  font-weight: 700;
  margin: 0;
  background: linear-gradient(135deg, #6366f1, #3b82f6);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.header-text .header-desc {
  font-size: 13px;
  color: #94a3b8;
  margin: 0;
}

[data-dt-dark] .header-text .header-desc {
  color: var(--dt-dark-text-muted);
}

.header-logo {
  width: 36px;
  height: 36px;
  object-fit: contain;
  border-radius: 8px;
  flex-shrink: 0;
  cursor: pointer;
  transition: all 0.2s ease-out;
  user-select: none;
  -webkit-user-select: none;
}

.header-logo:hover {
  transform: scale(1.05);
  box-shadow: 0 2px 8px rgba(99, 102, 241, 0.2);
}

.header-logo:active {
  transform: scale(0.95);
}

/* Header actions */
.header-actions {
  margin-left: auto;
  width: max-content;
  max-width: 100%;
  flex-wrap: wrap;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}


.export-warning {
  flex-basis: 100%;
  margin: 0;
  color: #b45309;
  font-size: 12px;
  line-height: 1.5;
  text-align: right;
}

[data-dt-dark] .export-warning {
  color: #fbbf24;
}
.btn-export, .btn-import {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 14px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease-out;
  border: 1px solid #e2e8f0;
  background: #fff;
  color: #374151;
}

[data-dt-dark] .btn-export, [data-dt-dark] .btn-import {
  background: var(--dt-dark-surface-1);
  border-color: var(--dt-dark-border);
  color: #cbd5e1;
}

.btn-export:hover, .btn-import:hover {
  border-color: #93c5fd;
  background: #f0f9ff;
}

[data-dt-dark] .btn-export:hover, [data-dt-dark] .btn-import:hover {
  background: #1e3a5f;
  border-color: #58a6ff;
}

.btn-export:active, .btn-import:active {
  transform: scale(0.98);
}

.btn-export {
  background: rgba(99, 102, 241, 0.06);
  border-color: #c7d2fe;
  color: #6366f1;
}

[data-dt-dark] .btn-export {
  background: rgba(99, 102, 241, 0.12);
  border-color: #4f46e5;
  color: #a5b4fc;
}

.btn.dt-btn-icon {
  font-size: 14px;
  line-height: 1;
}

.hidden-file {
  display: none;
}

/* Main layout */
.main-layout {
  display: flex;
  gap: 20px;
  flex: 1;
  min-height: 0;
}

/* Sidebar */
.sidebar {
  width: 180px;
  flex-shrink: 0;
  background: #fff;
  border-radius: 10px;
  padding: 8px;
  border: 1px solid #e2e8f0;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
  display: flex;
  flex-direction: column;
  height: fit-content;
  max-height: calc(100dvh - 120px);
}

[data-dt-dark] .sidebar {
  background: var(--dark-card-gradient, linear-gradient(135deg, var(--dt-dark-surface-1, #161b22), var(--dt-dark-base, #0d1117)));
  border-color: var(--dt-dark-border);
  box-shadow: var(--dark-card-shadow, 0 1px 2px rgba(0, 0, 0, 0.3), 0 1px 3px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.04));
}

.sidebar-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
}

/* Sidebar footer (theme switcher) */
.sidebar-footer {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding-top: 12px;
  margin-top: 12px;
  border-top: 1px solid #e2e8f0;
}

[data-dt-dark] .sidebar-footer {
  border-color: var(--dt-dark-border);
}

.sidebar-footer-label {
  font-size: 11px;
  font-weight: 600;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

[data-dt-dark] .sidebar-footer-label {
  color: var(--dt-dark-text-muted);
}

.github-link {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 6px;
  font-size: 12px;
  color: #64748b;
  text-decoration: none;
  transition: all 0.2s ease-out;
}

[data-dt-dark] .github-link {
  color: #8b949e;
}

.github-link:hover {
  background: rgba(99, 102, 241, 0.08);
  color: #6366f1;
}

[data-dt-dark] .github-link:hover {
  background: rgba(99, 102, 241, 0.15);
  color: #a5b4fc;
}

.github-link:active {
  transform: scale(0.98);
}

.github-link:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.35);
}

.sidebar-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  color: #374151;
  transition: all 0.2s ease-out;
  position: relative;
  width: 100%;
  border: 0;
  background: transparent;
  text-align: left;
  font-family: inherit;
}

[data-dt-dark] .sidebar-item {
  color: #cbd5e1;
}

.sidebar-item:hover {
  background: #f8fafc;
}

[data-dt-dark] .sidebar-item:hover {
  background: var(--dt-dark-surface-hover);
}

.sidebar-item.active {
  background: rgba(99, 102, 241, 0.08);
  color: #6366f1;
  font-weight: 500;
}

[data-dt-dark] .sidebar-item.active {
  background: rgba(99, 102, 241, 0.15);
  color: #818cf8;
}

.sidebar-item:active {
  transform: scale(0.99);
}

.sidebar-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 60%;
  border-radius: 0 2px 2px 0;
  background: linear-gradient(180deg, #6366f1, #3b82f6);
}

.sidebar-item.dev-mode {
  color: #8b5cf6;
}

[data-dt-dark] .sidebar-item.dev-mode {
  color: #a78bfa;
}

.sidebar-item.dev-mode.active {
  background: linear-gradient(135deg, rgba(139, 92, 246, 0.08), rgba(168, 85, 247, 0.08));
  color: #7c3aed;
}

[data-dt-dark] .sidebar-item.dev-mode.active {
  background: linear-gradient(135deg, rgba(139, 92, 246, 0.15), rgba(168, 85, 247, 0.15));
  color: #c4b5fd;
}

.sidebar-item.dev-mode.active::before {
  background: linear-gradient(180deg, #8b5cf6, #a855f7);
}

.sidebar-item.dev-mode-exit {
  color: #94a3b8;
  opacity: 0.75;
}

[data-dt-dark] .sidebar-item.dev-mode-exit {
  color: #6e7681;
}

.sidebar-item.dev-mode-exit:hover {
  background: rgba(220, 38, 38, 0.06);
  color: #dc2626;
  opacity: 1;
}

[data-dt-dark] .sidebar-item.dev-mode-exit:hover {
  background: rgba(248, 113, 113, 0.1);
  color: #f87171;
}

.sidebar-item.dev-mode-exit:active {
  transform: scale(0.98);
}

.sidebar-divider {
  height: 1px;
  background: #e2e8f0;
  margin: 8px 12px;
}

[data-dt-dark] .sidebar-divider {
  background: var(--dt-dark-border);
}

.sidebar-icon {
  font-size: 16px;
  line-height: 1;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}

.sidebar-label {
  white-space: nowrap;
}

/* Content area */
.content-area {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}

/* Theme switcher */
.theme-switcher {
  display: flex;
  gap: 2px;
  padding: 2px;
  background: #f1f5f9;
  border-radius: 8px;
}

[data-dt-dark] .theme-switcher {
  background: var(--dt-dark-surface-hover);
}

.theme-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  color: #64748b;
  transition: all 0.2s ease-out;
}

[data-dt-dark] .theme-btn {
  color: #8b949e;
}

.theme-btn:hover {
  background: rgba(255, 255, 255, 0.6);
}

[data-dt-dark] .theme-btn:hover {
  background: rgba(255, 255, 255, 0.05);
}

.theme-btn.active {
  background: #fff;
  color: #6366f1;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

[data-dt-dark] .theme-btn.active {
  background: var(--dt-dark-border);
  color: #a5b4fc;
  box-shadow: var(--dt-dark-shadow-sm);
}
</style>
