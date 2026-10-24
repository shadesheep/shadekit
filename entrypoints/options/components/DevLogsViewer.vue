<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { copyToClipboard } from '../../shared/clipboard';
import DtButton from '../../shared/components/DtButton.vue';
import type { LogCategory, LogEntry, LogLevel } from '../../shared/logger';
import { clearLogs, exportLogs, getLogs, getLogStats } from '../../shared/logger';
import { showToast } from '../../shared/use-toast';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface FilterState {
  categories: Set<LogCategory>;
  levels: Set<LogLevel>;
  keyword: string;
  timeRange: 'all' | '1h' | '24h' | '7d';
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

const logs = ref<LogEntry[]>([]);
const stats = ref<Record<LogCategory, number>>({
  auth: 0,
  script: 0,
  ext: 0,
  system: 0,
});
const loading = ref(false);
const expandedIds = ref<Set<string>>(new Set());

/** 大量日志时先渲染首批，避免一次性渲染全部导致页面卡顿 */
const PAGE_SIZE = 100;
const displayLimit = ref(PAGE_SIZE);

const filter = ref<FilterState>({
  categories: new Set(),
  levels: new Set(),
  keyword: '',
  timeRange: 'all',
});

// ---------------------------------------------------------------------------
// 计算属性
// ---------------------------------------------------------------------------

const filteredLogs = computed(() => {
  let result = logs.value;

  // 按类别筛选
  if (filter.value.categories.size > 0) {
    result = result.filter((l) => filter.value.categories.has(l.category));
  }

  // 按级别筛选
  if (filter.value.levels.size > 0) {
    result = result.filter((l) => filter.value.levels.has(l.level));
  }

  // 按时间范围筛选
  if (filter.value.timeRange !== 'all') {
    const now = Date.now();
    const ranges = {
      '1h': 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
    };
    const startTime = now - ranges[filter.value.timeRange];
    result = result.filter((l) => l.timestamp >= startTime);
  }

  // 按关键词搜索
  if (filter.value.keyword.trim()) {
    const kw = filter.value.keyword.toLowerCase();
    result = result.filter(
      (l) =>
        l.message.toLowerCase().includes(kw) ||
        l.error?.toLowerCase().includes(kw) ||
        l.extId?.toLowerCase().includes(kw) ||
        l.account?.username.toLowerCase().includes(kw),
    );
  }

  return result;
});

/** 当前实际渲染的日志（分页展示，避免大量日志一次性渲染卡顿） */
const visibleLogs = computed(() => filteredLogs.value.slice(0, displayLimit.value));
const hasMore = computed(() => filteredLogs.value.length > displayLimit.value);

const totalCount = computed(() => logs.value.length);
const filteredCount = computed(() => filteredLogs.value.length);

// ---------------------------------------------------------------------------
// 方法
// ---------------------------------------------------------------------------

async function loadLogs() {
  loading.value = true;
  try {
    logs.value = await getLogs();
    stats.value = await getLogStats();
  } catch (e) {
    showToast('加载日志失败', 'error');
    console.error(e);
  } finally {
    loading.value = false;
  }
}

function toggleCategory(cat: LogCategory) {
  const newSet = new Set(filter.value.categories);
  if (newSet.has(cat)) {
    newSet.delete(cat);
  } else {
    newSet.add(cat);
  }
  filter.value = { ...filter.value, categories: newSet };
}

function toggleLevel(level: LogLevel) {
  const newSet = new Set(filter.value.levels);
  if (newSet.has(level)) {
    newSet.delete(level);
  } else {
    newSet.add(level);
  }
  filter.value = { ...filter.value, levels: newSet };
}

function setTimeRange(range: 'all' | '1h' | '24h' | '7d') {
  filter.value = { ...filter.value, timeRange: range };
}

function clearFilter() {
  filter.value = {
    categories: new Set(),
    levels: new Set(),
    keyword: '',
    timeRange: 'all',
  };
}

async function handleClearLogs(category?: LogCategory) {
  const msg = category ? `确定清空「${getCategoryLabel(category)}」类别的日志？` : '确定清空所有日志？';
  if (!confirm(msg)) return;

  try {
    const ok = await clearLogs(category);
    if (!ok) {
      showToast('清空失败：存储写入异常，请重试', 'error');
      return;
    }
    await loadLogs();
    showToast('日志已清空', 'success');
  } catch {
    showToast('清空失败', 'error');
  }
}

async function handleExport() {
  try {
    const json = await exportLogs({
      categories: filter.value.categories.size > 0 ? [...filter.value.categories] : undefined,
      levels: filter.value.levels.size > 0 ? [...filter.value.levels] : undefined,
      keyword: filter.value.keyword || undefined,
    });
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `devtools-logs-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('日志已导出', 'success');
  } catch {
    showToast('导出失败', 'error');
  }
}

function toggleExpand(id: string) {
  const newSet = new Set(expandedIds.value);
  if (newSet.has(id)) {
    newSet.delete(id);
  } else {
    newSet.add(id);
  }
  expandedIds.value = newSet;
}

function showMore() {
  displayLimit.value += PAGE_SIZE;
}

async function copyLogJson(log: LogEntry) {
  const ok = await copyToClipboard(JSON.stringify(log, null, 2));
  showToast(ok ? '已复制' : '复制失败', ok ? 'success' : 'error');
}

// ---------------------------------------------------------------------------
// 格式化工具
// ---------------------------------------------------------------------------

const CATEGORY_CONFIG: Record<LogCategory, { label: string; color: string; icon: string }> = {
  auth: { label: '认证', color: '#3b82f6', icon: 'i-lucide-key' },
  script: { label: '脚本', color: '#8b5cf6', icon: 'i-lucide-code' },
  ext: { label: '扩展', color: '#10b981', icon: 'i-lucide-puzzle' },
  system: { label: '系统', color: '#64748b', icon: 'i-lucide-settings' },
};

const LEVEL_CONFIG: Record<LogLevel, { label: string; color: string; icon: string }> = {
  debug: { label: '调试', color: '#64748b', icon: 'i-lucide-bug' },
  info: { label: '信息', color: '#3b82f6', icon: 'i-lucide-info' },
  warn: { label: '警告', color: '#f59e0b', icon: 'i-lucide-alert-triangle' },
  error: { label: '错误', color: '#ef4444', icon: 'i-lucide-x-circle' },
};

function getCategoryLabel(cat: LogCategory): string {
  return CATEGORY_CONFIG[cat]?.label ?? cat;
}

function getCategoryIcon(cat: LogCategory): string {
  return CATEGORY_CONFIG[cat]?.icon ?? 'i-lucide-file';
}

function getCategoryColor(cat: LogCategory): string {
  return CATEGORY_CONFIG[cat]?.color ?? '#64748b';
}

function getLevelLabel(level: LogLevel): string {
  return LEVEL_CONFIG[level]?.label ?? level;
}

function getLevelIcon(level: LogLevel): string {
  return LEVEL_CONFIG[level]?.icon ?? 'i-lucide-circle';
}

function getLevelColor(level: LogLevel): string {
  return LEVEL_CONFIG[level]?.color ?? '#64748b';
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// Auth 日志专用辅助函数
// ---------------------------------------------------------------------------

interface AuthExtraData {
  action?: string;
  domain?: {
    name: string;
    origin: string;
    loginMethod: string;
  };
  result?: {
    success: boolean;
    error?: string;
    duration: number;
  };
  steps?: {
    name: string;
    status: 'pending' | 'success' | 'error';
    error?: string;
    duration?: number;
  }[];
  /** 逐算子轨迹（ADR-0015 D8，原 recipeSteps 升格）：op / 序号 / 目标 / 状态 / 错误码 */
  ops?: {
    index: number;
    op: string;
    target?: string;
    status: 'success' | 'error' | 'skipped';
    duration?: number;
    errorCode?: string;
    error?: string;
  }[];
  /** `spec.log.reveal` 白名单命中值（ADR-0015 D8，黑名单优先，绝对不含敏感字段） */
  revealed?: Record<string, string>;
  targetUrl?: string;
  debugRedirect?: string;
  request?: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
    encryptedPassword?: string;
    revealed?: Record<string, string>;
  } | null;
  response?: {
    status?: number;
    statusText?: string;
    body?: string;
    parsed?: string;
  } | null;
}

/** 从 extra 中提取 auth 专用数据 */
function getAuthExtra(log: LogEntry): AuthExtraData | null {
  if (log.category !== 'auth' || !log.extra) return null;
  return log.extra as AuthExtraData;
}

/** 格式化请求头为 key: value 多行文本 */
function formatHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

/** 格式化白名单可见字段为 key: value 多行文本 */
function formatRevealed(revealed: Record<string, string>): string {
  return Object.entries(revealed)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

/** 获取操作类型标签 */
function getActionLabel(action?: string): string {
  const map: Record<string, string> = {
    SWITCH_ACCOUNT: '切换账号',
    QUICK_LOGIN: '快捷登录',
    QUICK_LOGIN_NEW_TAB: '新标签登录',
    AUTO: '自动登录',
    RECIPE_STEP_START: '配方步骤',
    RECIPE_STEP_END: '配方步骤',
  };
  return map[action ?? ''] ?? action ?? '未知';
}

/** 配方步骤的实时事件：列表行直接显示「第几步、什么操作」 */
function isRecipeStepLog(log: LogEntry): boolean {
  const action = getAuthExtra(log)?.action;
  return action === 'RECIPE_STEP_START' || action === 'RECIPE_STEP_END';
}

/** 获取步骤状态标签 */
function getStepStatusLabel(status: string): string {
  switch (status) {
    case 'success': return '成功';
    case 'error': return '失败';
    case 'skipped': return '跳过';
    default: return '待执行';
  }
}

/** 配方步骤的操作名（用户可读） */
function getRecipeOpLabel(op: string): string {
  const map: Record<string, string> = {
    goto: '导航',
    fill: '填充',
    click: '点击',
    waitFor: '等待',
    extract: '提取',
    script: '脚本',
  };
  return map[op] ?? op;
}

/** 判断 auth 日志是否成功 */
function isAuthSuccess(log: LogEntry): boolean {
  const extra = getAuthExtra(log);
  return extra?.result?.success ?? (log.level !== 'error');
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

onMounted(loadLogs);

// 筛选条件变化时重置分页（前端筛选，无需重新加载）
watch(filter, () => {
  displayLimit.value = PAGE_SIZE;
}, { deep: true });
</script>

<template>
  <div class="dev-logs">
    <!-- 标题栏 -->
    <div class="logs-header">
      <div>
        <h2 class="section-title">
          <div class="i-lucide-bug w-4 h-4 inline mr-1" />
          调试日志
        </h2>
        <p class="section-desc">
          共 {{ totalCount }} 条日志，当前筛选 {{ filteredCount }} 条
        </p>
      </div>
      <div class="header-actions">
        <DtButton size="xs" :disabled="loading" @click="loadLogs">
          <div class="i-lucide-refresh-cw w-3.5 h-3.5" />
          刷新
        </DtButton>
        <DtButton size="xs" @click="handleExport">
          <div class="i-lucide-download w-3.5 h-3.5" />
          导出
        </DtButton>
        <DtButton size="xs" variant="danger" @click="handleClearLogs()">
          <div class="i-lucide-trash-2 w-3.5 h-3.5" />
          清空全部
        </DtButton>
      </div>
    </div>

    <!-- 筛选栏 -->
    <div class="filter-bar">
      <!-- 类别筛选 -->
      <div class="filter-group">
        <span class="filter-label">类别</span>
        <div class="filter-chips">
          <button
            v-for="cat in (['auth', 'script', 'ext', 'system'] as LogCategory[])"
            :key="cat"
            :class="['chip', { active: filter.categories.has(cat) }]"
            :style="{ '--chip-color': getCategoryColor(cat) }"
            @click="toggleCategory(cat)"
          >
            <div :class="[getCategoryIcon(cat), 'chip-icon']" />
            {{ getCategoryLabel(cat) }}
            <span class="chip-count">{{ stats[cat] }}</span>
          </button>
        </div>
      </div>

      <!-- 级别筛选 -->
      <div class="filter-group">
        <span class="filter-label">级别</span>
        <div class="filter-chips">
          <button
            v-for="level in (['debug', 'info', 'warn', 'error'] as LogLevel[])"
            :key="level"
            :class="['chip level', { active: filter.levels.has(level) }]"
            :style="{ '--chip-color': getLevelColor(level) }"
            @click="toggleLevel(level)"
          >
            <div :class="[getLevelIcon(level), 'chip-icon']" />
            {{ getLevelLabel(level) }}
          </button>
        </div>
      </div>

      <!-- 时间范围 -->
      <div class="filter-group">
        <span class="filter-label">时间</span>
        <div class="filter-chips">
          <button
            v-for="range in ([
              { value: 'all', label: '全部' },
              { value: '1h', label: '1小时' },
              { value: '24h', label: '24小时' },
              { value: '7d', label: '7天' },
            ] as const)"
            :key="range.value"
            :class="['chip', { active: filter.timeRange === range.value }]"
            @click="setTimeRange(range.value)"
          >
            {{ range.label }}
          </button>
        </div>
      </div>

      <!-- 搜索 -->
      <div class="filter-group search-group">
        <span class="filter-label">搜索</span>
        <div class="search-input-wrapper">
          <div class="i-lucide-search search-icon" />
          <input
            v-model="filter.keyword"
            type="text"
            class="search-input"
            placeholder="搜索日志内容..."
          />
        </div>
      </div>

      <!-- 清除筛选 -->
      <button
        v-if="filter.categories.size > 0 || filter.levels.size > 0 || filter.keyword || filter.timeRange !== 'all'"
        class="btn-clear-filter"
        @click="clearFilter"
      >
        <div class="i-lucide-x w-3.5 h-3.5" />
        清除筛选
      </button>
    </div>

    <!-- 日志列表 -->
    <div class="logs-list" v-if="filteredLogs.length > 0">
      <div
        v-for="log in visibleLogs"
        :key="log.id"
        :class="['log-item', `level-${log.level}`, `category-${log.category}`, { expanded: expandedIds.has(log.id) }]"
        @click="toggleExpand(log.id)"
      >
        <div class="log-main">
          <div class="log-indicators">
            <!-- Auth 类别：使用成功/失败图标 -->
            <template v-if="log.category === 'auth'">
              <div
                :class="['log-status-icon', isAuthSuccess(log) ? 'success' : 'error']"
              >
                <div :class="isAuthSuccess(log) ? 'i-lucide-check-circle' : 'i-lucide-alert-circle'" />
              </div>
            </template>
            <!-- 其他类别：使用级别徽章 -->
            <template v-else>
              <div
                :class="['log-level-badge', log.level]"
                :style="{ backgroundColor: getLevelColor(log.level) + '20', color: getLevelColor(log.level) }"
              >
                <div :class="[getLevelIcon(log.level), 'w-3 h-3']" />
                {{ getLevelLabel(log.level) }}
              </div>
            </template>
            <div
              :class="['log-category-badge']"
              :style="{ backgroundColor: getCategoryColor(log.category) + '15', color: getCategoryColor(log.category) }"
            >
              <div :class="[getCategoryIcon(log.category), 'w-3 h-3']" />
              {{ getCategoryLabel(log.category) }}
            </div>
            <!-- Auth 类别：显示操作类型徽章 -->
            <div v-if="log.category === 'auth' && getAuthExtra(log)?.action" class="log-action-badge">
              {{ getActionLabel(getAuthExtra(log)?.action) }}
            </div>
          </div>
          <div class="log-content">
            <div class="log-message">
              <!-- Auth 类别：显示账号和环境信息 -->
              <template v-if="log.category === 'auth'">
                <span class="log-account-name">{{ log.account?.name }}</span>
                <span class="log-separator">·</span>
                <span class="log-domain-name">{{ getAuthExtra(log)?.domain?.name }}</span>
                <span v-if="isRecipeStepLog(log)" class="log-recipe-message">
                  {{ log.message }}
                </span>
                <span v-if="getAuthExtra(log)?.result?.error" class="log-error-text">
                  {{ getAuthExtra(log)?.result?.error }}
                </span>
              </template>
              <template v-else>
                {{ log.message }}
              </template>
            </div>
            <div class="log-meta">
              <span class="log-time" :title="new Date(log.timestamp).toLocaleString()">
                {{ formatTime(log.timestamp) }}
              </span>
              <span class="log-time-relative">· {{ formatRelative(log.timestamp) }}</span>
              <!-- Auth 类别：显示耗时 -->
              <span v-if="log.category === 'auth' && getAuthExtra(log)?.result?.duration" class="log-duration">
                {{ formatDuration(getAuthExtra(log)!.result!.duration) }}
              </span>
              <span v-if="log.extId" class="log-ext-id">{{ log.extId }}</span>
              <span v-if="log.account && log.category !== 'auth'" class="log-account">{{ log.account.name }}</span>
            </div>
          </div>
          <div class="log-expand-icon">
            <div :class="['i-lucide-chevron-down', 'w-4 h-4', { 'rotate-180': expandedIds.has(log.id) }]" />
          </div>
        </div>

        <!-- 展开的详情 -->
        <div v-if="expandedIds.has(log.id)" class="log-details">
          <!-- Auth 类别：逐算子轨迹（ADR-0015 D8，可折叠） -->
          <div v-if="log.category === 'auth' && getAuthExtra(log)?.ops?.length" class="auth-steps-section">
            <div
              class="detail-section-title recipe-trace-toggle"
              @click.stop="toggleExpand('recipe:' + log.id)"
            >
              <div
                :class="[
                  'i-lucide-chevron-right',
                  'w-3.5',
                  'h-3.5',
                  'recipe-trace-arrow',
                  { 'rotate-90': expandedIds.has('recipe:' + log.id) },
                ]"
              />
              算子轨迹（{{ getAuthExtra(log)!.ops!.length }}）
            </div>
            <div v-if="expandedIds.has('recipe:' + log.id)" class="auth-steps-list">
              <div
                v-for="step in getAuthExtra(log)!.ops"
                :key="step.index"
                :class="['auth-step-item', `step-${step.status}`]"
              >
                <div :class="['auth-step-dot', `dot-${step.status}`]" />
                <span class="auth-step-name">
                  {{ step.index + 1 }}. {{ getRecipeOpLabel(step.op) }}
                  <span v-if="step.target" class="recipe-step-target">{{ step.target }}</span>
                </span>
                <span class="auth-step-status">{{ getStepStatusLabel(step.status) }}</span>
                <span v-if="step.duration !== undefined" class="auth-step-duration">{{ formatDuration(step.duration) }}</span>
                <span v-if="step.errorCode" class="recipe-step-code">{{ step.errorCode }}</span>
                <span v-if="step.error" class="auth-step-error">{{ step.error }}</span>
              </div>
            </div>
          </div>

          <!-- Auth 类别：显示请求详情 -->
          <template v-if="log.category === 'auth' && getAuthExtra(log)?.request">
            <div class="detail-row">
              <span class="detail-label">请求 URL</span>
              <code class="detail-value code">{{ getAuthExtra(log)!.request!.url }}</code>
            </div>
            <div v-if="getAuthExtra(log)!.request!.headers" class="detail-row">
              <span class="detail-label">请求头</span>
              <pre class="detail-value code-block">{{ formatHeaders(getAuthExtra(log)!.request!.headers) }}</pre>
            </div>
            <div v-if="getAuthExtra(log)!.request!.body" class="detail-row">
              <span class="detail-label">请求 Body</span>
              <pre class="detail-value code-block">{{ getAuthExtra(log)!.request!.body }}</pre>
            </div>
            <div v-if="getAuthExtra(log)!.request!.revealed" class="detail-row">
              <span class="detail-label">白名单可见字段（log.reveal）</span>
              <pre class="detail-value code-block">{{ formatRevealed(getAuthExtra(log)!.request!.revealed!) }}</pre>
            </div>
          </template>

          <!-- Auth 类别：显示响应详情 -->
          <template v-if="log.category === 'auth' && getAuthExtra(log)?.response">
            <div v-if="getAuthExtra(log)!.response!.status" class="detail-row">
              <span class="detail-label">状态码</span>
              <code class="detail-value code">
                {{ getAuthExtra(log)!.response!.status }} {{ getAuthExtra(log)!.response!.statusText || '' }}
              </code>
            </div>
            <div v-if="getAuthExtra(log)!.response!.body" class="detail-row">
              <span class="detail-label">响应 Body</span>
              <pre class="detail-value code-block">{{ getAuthExtra(log)!.response!.body }}</pre>
            </div>
            <div v-if="getAuthExtra(log)!.response!.parsed" class="detail-row">
              <span class="detail-label">解析结果</span>
              <pre class="detail-value code-block parsed">{{ getAuthExtra(log)!.response!.parsed }}</pre>
            </div>
          </template>

          <!-- 其他类别：通用详情显示 -->
          <template v-if="log.category !== 'auth'">
            <div v-if="log.error" class="detail-row">
              <span class="detail-label">错误</span>
              <pre class="detail-value error">{{ log.error }}</pre>
            </div>
            <div v-if="log.account" class="detail-row">
              <span class="detail-label">账号</span>
              <span class="detail-value">{{ log.account.name }} ({{ log.account.username }})</span>
            </div>
            <div v-if="log.extId" class="detail-row">
              <span class="detail-label">扩展 ID</span>
              <span class="detail-value mono">{{ log.extId }}</span>
            </div>
            <div v-if="log.request" class="detail-row">
              <span class="detail-label">请求</span>
              <pre class="detail-value json">{{ JSON.stringify(log.request, null, 2) }}</pre>
            </div>
            <div v-if="log.response" class="detail-row">
              <span class="detail-label">响应</span>
              <pre class="detail-value json">{{ JSON.stringify(log.response, null, 2) }}</pre>
            </div>
            <div v-if="log.extra" class="detail-row">
              <span class="detail-label">附加数据</span>
              <pre class="detail-value json">{{ JSON.stringify(log.extra, null, 2) }}</pre>
            </div>
          </template>

          <div class="detail-actions">
            <DtButton size="xs" @click.stop="handleClearLogs(log.category)">
              清空此类日志
            </DtButton>
            <DtButton size="xs" @click.stop="copyLogJson(log)">
              复制 JSON
            </DtButton>
          </div>
        </div>
      </div>
    </div>

    <!-- 加载更多（大量日志时分页渲染） -->
    <div v-if="hasMore" class="load-more">
      <DtButton size="xs" @click="showMore">
        <div class="i-lucide-chevron-down w-3.5 h-3.5" />
        显示更多（还有 {{ filteredCount - visibleLogs.length }} 条）
      </DtButton>
    </div>

    <!-- 空状态 -->
    <div v-if="filteredLogs.length === 0" class="empty-state">
      <div class="empty-icon">
        <div class="i-lucide-inbox w-12 h-12" />
      </div>
      <div class="empty-text">
        {{ totalCount === 0 ? '暂无日志记录' : '没有匹配的日志' }}
      </div>
      <div class="empty-hint">
        {{ totalCount === 0 ? '日志将在操作时自动记录' : '尝试调整筛选条件' }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.dev-logs {
  padding: 4px 0;
}

/* 标题栏 */
.logs-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 16px;
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
  margin: 0;
}

.header-actions {
  display: flex;
  gap: 8px;
}

/* 筛选栏 */
.filter-bar {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 12px 16px;
  margin-bottom: 16px;
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: center;
}

[data-dt-dark] .filter-bar {
  background: var(--dark-card-gradient, linear-gradient(135deg, var(--dt-dark-surface-1, #161b22), var(--dt-dark-base, #0d1117)));
  border-color: var(--dt-dark-border);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
}

.filter-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.filter-label {
  font-size: 12px;
  font-weight: 600;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

[data-dt-dark] .filter-label {
  color: #6e7681;
}

.filter-chips {
  display: flex;
  gap: 4px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 9999px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease-out;
  border: 1px solid #e2e8f0;
  background: #fff;
  color: #64748b;
}

[data-dt-dark] .chip {
  background: var(--dt-dark-base);
  border-color: var(--dt-dark-border);
  color: #8b949e;
}

.chip:hover {
  border-color: var(--chip-color, #94a3b8);
  background: color-mix(in srgb, var(--chip-color, #94a3b8) 10%, transparent);
}

.chip.active {
  background: color-mix(in srgb, var(--chip-color, #94a3b8) 15%, transparent);
  border-color: var(--chip-color, #94a3b8);
  color: var(--chip-color, #94a3b8);
}

.chip-icon {
  width: 12px;
  height: 12px;
}

.chip-count {
  font-size: 12px;
  opacity: 0.7;
}

.search-group {
  flex: 1;
  min-width: 180px;
}

.search-input-wrapper {
  position: relative;
  flex: 1;
}

.search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  width: 14px;
  height: 14px;
  color: #94a3b8;
}

.search-input {
  width: 100%;
  padding: 6px 12px 6px 30px;
  border-radius: 6px;
  border: 1px solid #e2e8f0;
  background: #fff;
  font-size: 12px;
  color: #0f172a;
  transition: all 0.15s ease-out;
}

[data-dt-dark] .search-input {
  background: var(--dt-dark-base);
  border-color: var(--dt-dark-border);
  color: #f1f5f9;
}

.search-input:focus {
  outline: none;
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.1);
}

.btn-clear-filter {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  border: 1px solid #e2e8f0;
  background: #fff;
  color: #64748b;
  transition: all 0.15s ease-out;
}

[data-dt-dark] .btn-clear-filter {
  background: var(--dt-dark-base);
  border-color: var(--dt-dark-border);
  color: #8b949e;
}

.btn-clear-filter:hover {
  border-color: #f87171;
  color: #dc2626;
}

/* 日志列表 */
.logs-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.log-item {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  transition: all 0.15s ease-out;
}

[data-dt-dark] .log-item {
  background: var(--dark-card-gradient, linear-gradient(135deg, var(--dt-dark-surface-1, #161b22), var(--dt-dark-base, #0d1117)));
  border-color: var(--dt-dark-border);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.03);
}

.log-item:hover {
  border-color: #93c5fd;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
}

[data-dt-dark] .log-item:hover {
  border-color: var(--dark-card-border-hover, rgba(99, 102, 241, 0.3));
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.05);
}

.log-item.level-error {
  border-left: 3px solid #ef4444;
}

.log-item.level-warn {
  border-left: 3px solid #f59e0b;
}

.log-main {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
}

.log-indicators {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.log-level-badge, .log-category-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.log-content {
  flex: 1;
  min-width: 0;
}

.log-message {
  font-size: 13px;
  color: #0f172a;
  margin-bottom: 4px;
  word-break: break-word;
}

[data-dt-dark] .log-message {
  color: #f1f5f9;
}

.log-meta {
  display: flex;
  gap: 8px;
  font-size: 12px;
  color: #94a3b8;
}

.log-time-relative {
  opacity: 0.7;
}

.log-ext-id, .log-account {
  padding: 1px 6px;
  background: #f1f5f9;
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 12px;
}

[data-dt-dark] .log-ext-id, [data-dt-dark] .log-account {
  background: var(--dt-dark-surface-hover);
}

.log-expand-icon {
  flex-shrink: 0;
  color: #94a3b8;
  transition: transform 0.2s ease-out;
}

.log-expand-icon .rotate-180 {
  transform: rotate(180deg);
}

/* 展开的详情 */
.log-details {
  padding: 0 16px 16px;
  border-top: 1px solid #e2e8f0;
  margin-top: -4px;
  padding-top: 12px;
}

[data-dt-dark] .log-details {
  border-color: var(--dt-dark-border);
}

.detail-row {
  display: flex;
  gap: 12px;
  margin-bottom: 8px;
}

.detail-label {
  font-size: 12px;
  font-weight: 600;
  color: #64748b;
  min-width: 60px;
  flex-shrink: 0;
}

[data-dt-dark] .detail-label {
  color: #8b949e;
}

.detail-value {
  font-size: 12px;
  color: #0f172a;
  flex: 1;
  margin: 0;
}

[data-dt-dark] .detail-value {
  color: #f1f5f9;
}

.detail-value.error {
  color: #dc2626;
  font-family: var(--font-mono);
  white-space: pre-wrap;
}

.detail-value.json {
  font-family: var(--font-mono);
  font-size: 12px;
  background: #f8fafc;
  padding: 8px 12px;
  border-radius: 6px;
  overflow-x: auto;
  max-height: 200px;
  white-space: pre-wrap;
}

[data-dt-dark] .detail-value.json {
  background: var(--dt-dark-base);
}

.detail-value.mono {
  font-family: var(--font-mono);
}

.detail-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed #e2e8f0;
}

[data-dt-dark] .detail-actions {
  border-color: var(--dt-dark-border);
}

/* ===== Auth 日志专用样式 ===== */

/* Auth 日志项的成功/失败边框 */
.log-item.category-auth {
  border-left: 3px solid;
}

.log-item.category-auth:has(.log-status-icon.success) {
  border-left-color: #16a34a;
}

.log-item.category-auth:has(.log-status-icon.error) {
  border-left-color: #dc2626;
}

/* 状态图标 */
.log-status-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  flex-shrink: 0;
}

.log-status-icon > div {
  width: 16px;
  height: 16px;
}

.log-status-icon.success {
  color: #16a34a;
  background: rgba(22, 163, 74, 0.1);
}

[data-dt-dark] .log-status-icon.success {
  color: #4ade80;
  background: rgba(74, 222, 128, 0.1);
}

.log-status-icon.error {
  color: #dc2626;
  background: rgba(220, 38, 38, 0.1);
}

[data-dt-dark] .log-status-icon.error {
  color: #f87171;
  background: rgba(248, 113, 113, 0.1);
}

/* 操作类型徽章 */
.log-action-badge {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 9999px;
  background: rgba(99, 102, 241, 0.08);
  color: #6366f1;
  font-weight: 500;
  white-space: nowrap;
}

[data-dt-dark] .log-action-badge {
  background: rgba(129, 140, 248, 0.12);
  color: #818cf8;
}

/* Auth 日志的账号和域名显示 */
.log-account-name {
  font-weight: 600;
  color: #0f172a;
}

[data-dt-dark] .log-account-name {
  color: #f1f5f9;
}

.log-separator {
  color: #cbd5e1;
  margin: 0 4px;
}

[data-dt-dark] .log-separator {
  color: #475569;
}

.log-domain-name {
  color: #64748b;
  font-size: 12px;
}

[data-dt-dark] .log-domain-name {
  color: #8b949e;
}

/* 配方步骤实时事件 */
.log-recipe-message {
  margin-left: 8px;
  font-size: 12px;
  color: #334155;
}

[data-dt-dark] .log-recipe-message {
  color: #cbd5e1;
}

.log-error-text {
  color: #dc2626;
  font-size: 12px;
  margin-left: 8px;
}

[data-dt-dark] .log-error-text {
  color: #f87171;
}

/* 耗时显示 */
.log-duration {
  font-size: 12px;
  font-family: var(--font-mono);
  color: #94a3b8;
  padding: 1px 6px;
  background: #f1f5f9;
  border-radius: 4px;
}

[data-dt-dark] .log-duration {
  background: var(--dt-dark-surface-hover);
  color: #8b949e;
}

/* 步骤时间线 */
.auth-steps-section {
  margin-bottom: 12px;
  padding-bottom: 12px;
  border-bottom: 1px dashed #e2e8f0;
}

[data-dt-dark] .auth-steps-section {
  border-bottom-color: var(--dt-dark-border);
}

.detail-section-title {
  font-size: 12px;
  font-weight: 600;
  color: #64748b;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 8px;
}

[data-dt-dark] .detail-section-title {
  color: #8b949e;
}

.auth-steps-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.auth-step-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 12px;
  background: #f8fafc;
}

[data-dt-dark] .auth-step-item {
  background: var(--dt-dark-base);
}

.auth-step-item.step-error {
  background: #fef2f2;
}

[data-dt-dark] .auth-step-item.step-error {
  background: rgba(127, 29, 29, 0.2);
}

.auth-step-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.auth-step-dot.dot-success {
  background: #16a34a;
}

[data-dt-dark] .auth-step-dot.dot-success {
  background: #4ade80;
}

.auth-step-dot.dot-error {
  background: #dc2626;
}

[data-dt-dark] .auth-step-dot.dot-error {
  background: #f87171;
}

.auth-step-dot.dot-pending {
  background: #cbd5e1;
}

[data-dt-dark] .auth-step-dot.dot-pending {
  background: #475569;
}

.auth-step-item.step-skipped {
  opacity: 0.7;
}

.auth-step-dot.dot-skipped {
  background: #94a3b8;
}

[data-dt-dark] .auth-step-dot.dot-skipped {
  background: #64748b;
}

/* 配方步骤轨迹（ADR-0012 D13） */
.recipe-trace-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  user-select: none;
}

.recipe-trace-toggle:hover {
  color: #3b82f6;
}

[data-dt-dark] .recipe-trace-toggle:hover {
  color: #60a5fa;
}

.recipe-trace-arrow {
  transition: transform 0.15s ease-out;
}

.recipe-step-target {
  margin-left: 6px;
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: normal;
  color: #64748b;
  word-break: break-all;
}

[data-dt-dark] .recipe-step-target {
  color: #8b949e;
}

.recipe-step-code {
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 1px 6px;
  border-radius: 9999px;
  background: #fee2e2;
  color: #b91c1c;
}

[data-dt-dark] .recipe-step-code {
  background: rgba(127, 29, 29, 0.35);
  color: #fca5a5;
}

.auth-step-name {
  font-weight: 500;
  color: #334155;
  text-transform: capitalize;
  flex: 1;
}

[data-dt-dark] .auth-step-name {
  color: #cbd5e1;
}

.auth-step-status {
  font-size: 12px;
  color: #94a3b8;
}

.auth-step-item.step-error .auth-step-status {
  color: #dc2626;
}

[data-dt-dark] .auth-step-item.step-error .auth-step-status {
  color: #f87171;
}

.auth-step-duration {
  font-size: 12px;
  font-family: var(--font-mono);
  color: #94a3b8;
}

.auth-step-error {
  font-size: 12px;
  color: #dc2626;
  margin-left: 8px;
}

[data-dt-dark] .auth-step-error {
  color: #f87171;
}

/* Auth 请求/响应代码块 */
.detail-value.code {
  font-family: var(--font-mono);
  font-size: 12px;
  word-break: break-all;
  padding: 6px 10px;
  background: #f8fafc;
  border-radius: 4px;
}

[data-dt-dark] .detail-value.code {
  background: var(--dt-dark-base);
  color: #cbd5e1;
}

.detail-value.code-block {
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 10px 12px;
  background: #f8fafc;
  border-radius: 6px;
  overflow-x: auto;
  max-height: 200px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.5;
  margin: 0;
}

[data-dt-dark] .detail-value.code-block {
  background: var(--dt-dark-base);
  color: #cbd5e1;
}

.detail-value.code-block.parsed {
  border-left: 2px solid #16a34a;
}

[data-dt-dark] .detail-value.code-block.parsed {
  border-left-color: #4ade80;
}

.detail-value.encrypted {
  color: #7c3aed;
}

[data-dt-dark] .detail-value.encrypted {
  color: #c4b5fd;
}

/* 加载更多 */
.load-more {
  display: flex;
  justify-content: center;
  margin-top: 12px;
}

/* 空状态 */
.empty-state {
  text-align: center;
  padding: 60px 20px;
}

.empty-icon {
  color: #cbd5e1;
  margin-bottom: 16px;
}

[data-dt-dark] .empty-icon {
  color: var(--dt-dark-border);
}

.empty-text {
  font-size: 14px;
  font-weight: 500;
  color: #64748b;
  margin-bottom: 4px;
}

[data-dt-dark] .empty-text {
  color: #8b949e;
}

.empty-hint {
  font-size: 12px;
  color: #94a3b8;
}
</style>
