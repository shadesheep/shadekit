<script setup lang="ts">
/**
 * 账号切换工具的内容脚本面板（快捷键唤出的浮动面板）
 * 功能与 Popup.vue 保持一致：搜索、角色筛选、最近使用、键盘导航
 * 暗色模式使用 [data-dt-dark] 属性选择器（content script 容器）
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { sendBgMessage } from '../../shared/messages';
import { getConfig } from '../../shared/tool-config';
import { showToast } from '../../shared/use-toast';
import type { Account, AccountSwitchConfig, DomainConfig } from './types';
import { ACCOUNT_SWITCH_CONFIG_DEFAULTS } from './types';
import {
  collectRoles,
  filterAccounts,
  normalizeAccount,
  resolveEnvironment,
  resolvePassword,
  roleColor,
  roleColorStyle,
} from './account-view';
import { accountInitial } from './account-palette';
import { closePanel, getCurrentOrigin } from './utils/env';
import { buildErrorDetail, copyToClipboard, ErrorCodes, type ErrorDetailContext } from './utils/error-codes';
import { LOGIN_BUSY_ERROR } from './utils/error-codes';
import { parseLoginText, type ParsedLogin } from './utils/parse-text';

const accounts = ref<Account[]>([]);
const origin = ref('');
const matchedEnv = ref<DomainConfig | null>(null);

// 搜索 & 筛选
const searchQuery = ref('');
const activeRole = ref<string | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);

// Tab 管理
const activeTab = ref<'users' | 'quicklogin'>('users');
const tabOrder = ref<('users' | 'quicklogin')[]>(['users', 'quicklogin']);

// 键盘导航
const highlightedIndex = ref(-1);

// 账号数 > 6 时启用紧凑模式
const isCompact = computed(() => filteredAccounts.value.length > 6);

// 三段过滤（域 → 角色 → 搜索）收口于 account-view（ADR-0004 D6）
const filteredAccounts = computed(() =>
  filterAccounts(accounts.value, {
    origin: origin.value,
    role: activeRole.value,
    query: searchQuery.value,
  }),
);

// 角色列表：从当前域下的账号中提取（origin 未解析时保持旧行为：空列表）
const availableRoles = computed(() => {
  if (!origin.value) return [];
  return collectRoles(filterAccounts(accounts.value, { origin: origin.value }));
});

onMounted(async () => {
  // 获取当前域名（popup 环境需通过 chrome.tabs.query 获取）
  origin.value = await getCurrentOrigin();

  try {
    // getConfig + defaults：享受旧 key 迁移与缺失字段补齐（ADR-0003 D5）
    const cfg = await getConfig<AccountSwitchConfig>('account-switch', ACCOUNT_SWITCH_CONFIG_DEFAULTS);

    // 环境匹配链收口于 account-view(resolveEnvironment)
    matchedEnv.value = resolveEnvironment(origin.value, cfg?.domains ?? {})?.env ?? null;
    // role? 兼容归一化下沉至 account-view(ADR-0004 D6)
    accounts.value = (cfg?.accounts ?? []).map(normalizeAccount);
    // 读取 tab 顺序配置
    if (Array.isArray(cfg?.tabOrder) && cfg.tabOrder.length === 2) {
      tabOrder.value = cfg.tabOrder;
    }
    // 默认选中第一个 tab
    activeTab.value = tabOrder.value[0];
    // 读取快捷登录默认域名
    quickLoginDefaultDomain.value = cfg?.quickLoginDefaultDomain || '';
    globalDefaultPassword.value = cfg?.globalDefaultPassword || '';
  } catch (e) {
    // 静默降级：配置读取失败时不影响面板展示
    console.warn('[account-switch] Failed to load config:', e);
  }

  // 自动聚焦搜索框（仅在搜索框可见时）
  await nextTick();
  if (
    matchedEnv.value &&
    (searchQuery.value || filteredAccounts.value.length >= 4)
  ) {
    searchInput.value?.focus();
  }
});

// 登录防重：登录进行中的账号 id，非 null 时所有卡片置灰禁用
const switchingAccountId = ref<string | null>(null);

/**
 * 登录失败 Toast：附「复制详情」按钮，
 * 复制内容为错误码 + 环境/策略/账号/时间等关键上下文（不含密码）。
 * 失败 Toast 停留 8s，给用户留足点击复制的时间。
 */
const showLoginErrorToast = (
  prefix: string,
  err: string,
  errorCode: string | undefined,
  ctx: ErrorDetailContext,
) => {
  const code = errorCode ?? ErrorCodes.UNKNOWN;
  showToast(`${prefix}：${err} [${code}]`, 'error', 8000, {
    label: '复制详情',
    onClick: () => {
      const detail = buildErrorDetail(code, err, {
        envName: matchedEnv.value?.name,
        origin: origin.value,
        strategy: matchedEnv.value?.loginMethod,
        ...ctx,
      });
      void copyToClipboard(detail).then((ok) => {
        showToast(ok ? '错误详情已复制' : '复制失败，请查看控制台日志', ok ? 'success' : 'info');
      });
    },
  });
};

const switchAccount = async (account: Account) => {
  // 登录期间拒绝重复触发（点击其他卡片 / 回车键）
  if (switchingAccountId.value) return;
  switchingAccountId.value = account.id;
  showToast('正在切换至 ' + account.name + '...', 'info');
  try {
    const response = await sendBgMessage('SWITCH_ACCOUNT', {
      account,
      domain: origin.value,
    });
    if (response?.success) {
      showToast('已切换至 ' + account.name, 'success');
      closePanel();
    } else {
      const err = response?.error || '未知错误';
      // 并发互斥拒绝是「忙碌」而非失败，不加「切换失败」前缀
      if (err === LOGIN_BUSY_ERROR) {
        showToast(err, 'info');
      } else {
        showLoginErrorToast('切换失败', err, response?.errorCode, {
          action: 'SWITCH_ACCOUNT',
          accountName: account.name,
          username: account.username,
          recipeSteps: response?.recipeSteps,
        });
      }
    }
  } finally {
    // 登录结束（成功/失败/超时）后恢复卡片可点击
    switchingAccountId.value = null;
  }
};

const clearSearch = () => {
  searchQuery.value = '';
  activeRole.value = null;
  highlightedIndex.value = -1;
  searchInput.value?.focus();
};

// 键盘导航高亮索引
const totalItemCount = computed(() => filteredAccounts.value.length);

// 根据索引找到对应账号
function getAccountByGlobalIndex(globalIdx: number): Account | null {
  return filteredAccounts.value[globalIdx] ?? null;
}

// 判断某项是否高亮
const isHighlighted = (localIndex: number): boolean => {
  return highlightedIndex.value === localIndex;
};

// 键盘导航
const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === '/') {
    e.preventDefault();
    searchInput.value?.focus();
    return;
  }

  if (e.key === 'Escape') {
    if (searchQuery.value || activeRole.value) {
      clearSearch();
    } else {
      closePanel();
    }
    return;
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    highlightedIndex.value = Math.min(
      highlightedIndex.value + 1,
      totalItemCount.value - 1,
    );
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    highlightedIndex.value = Math.max(highlightedIndex.value - 1, 0);
  } else if (e.key === 'Enter' && highlightedIndex.value >= 0) {
    e.preventDefault();
    const account = getAccountByGlobalIndex(highlightedIndex.value);
    if (account) switchAccount(account);
  }
};

const selectRole = (role: string | null) => {
  activeRole.value = role;
  highlightedIndex.value = -1;
};

// ============================================================
// 快速登录：粘贴测试信息，自动解析并执行登录+跳转
// ============================================================

const quickLoginText = ref('');
const quickLoginLoading = ref(false);
const quickLoginDefaultDomain = ref('');
const globalDefaultPassword = ref('');
const redirectEnabled = ref(false);
const quickLoginMatchedEnv = ref<DomainConfig | null>(null);

/** 从粘贴的快速登录文本中提取域名（仅 URL） */
function extractOriginFromText(text: string): string | null {
  const parsed = parseLoginText(text, '');
  if (!parsed?.url) return null;
  try {
    const u = new URL(parsed.url.startsWith('http') ? parsed.url : `http://${parsed.url}`);
    return u.origin;
  } catch {
    return null;
  }
}

const handleQuickLogin = async () => {
  // 登录期间拒绝重复触发（Ctrl+Enter 不受按钮 disabled 约束）
  if (quickLoginLoading.value) return;
  const parsed = parseLoginText(quickLoginText.value, quickLoginDefaultDomain.value || origin.value);
  if (!parsed) {
    showToast('格式无法解析：请确保包含账号信息', 'error');
    return;
  }

  // 纯账号模式：优先使用当前页面匹配的环境（URL + 默认密码）
  const isPureAccount = !parsed.hasUrl;
  const targetUrl = isPureAccount && matchedEnv.value
    ? origin.value
    : parsed.url;

  // 密码优先级：用户输入 > 当前页面环境默认密码(纯账号) > 文本URL环境默认密码 > 全局默认密码
  const currentEnvPassword = isPureAccount ? matchedEnv.value?.defaultPassword : undefined;
  const textEnvPassword = isPureAccount ? undefined : quickLoginMatchedEnv.value?.defaultPassword;
  const password = resolvePassword({
    input: parsed.password,
    envDefault: currentEnvPassword ?? textEnvPassword,
    globalDefault: globalDefaultPassword.value,
  });
  if (!password) {
    showToast('未找到可用密码：请输入完整的账号/密码信息', 'error');
    return;
  }

  const debugRedirect = redirectEnabled.value && parsed.hasUrl && quickLoginMatchedEnv.value?.debugRedirect
    ? quickLoginMatchedEnv.value.debugRedirect
    : undefined;

  quickLoginLoading.value = true;
  try {
    const response = await sendBgMessage('QUICK_LOGIN', {
      url: targetUrl,
      username: parsed.username,
      password,
      hasUrl: !isPureAccount,
      debugRedirect,
    });
    if (response?.success) {
      showToast('登录成功，正在跳转...', 'success');
      await new Promise((r) => setTimeout(r, 500));
      closePanel();
    } else {
      const err = response?.error || '未知错误';
      // 并发互斥拒绝是「忙碌」而非失败
      if (err === LOGIN_BUSY_ERROR) {
        showToast(err, 'info');
      } else {
        showLoginErrorToast('登录失败', err, response?.errorCode, {
          action: 'QUICK_LOGIN',
          accountName: parsed.username,
          username: parsed.username,
          strategy:
            quickLoginMatchedEnv.value?.loginMethod ??
            matchedEnv.value?.loginMethod,
          recipeSteps: response?.recipeSteps,
        });
      }
    }
  } catch {
    // sendMessage 本身失败（background 重启/上下文失效等），原因不可知，归为 UNKNOWN
    showLoginErrorToast('登录失败', '请求发送失败', ErrorCodes.UNKNOWN, {
      action: 'QUICK_LOGIN',
      username: parsed.username,
    });
  } finally {
    quickLoginLoading.value = false;
  }
};

const handleQuickLoginKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    handleQuickLogin();
  }
};

// 根据粘贴文本中的 URL 匹配环境
watch(quickLoginText, async () => {
  const textOrigin = extractOriginFromText(quickLoginText.value);
  if (!textOrigin || !accounts.value.length) {
    quickLoginMatchedEnv.value = null;
    redirectEnabled.value = false;
    return;
  }
  try {
    // 同上:getConfig + defaults(ADR-0003 D5);匹配链收口于 account-view
    const cfg = await getConfig<AccountSwitchConfig>('account-switch', ACCOUNT_SWITCH_CONFIG_DEFAULTS);
    const resolved = resolveEnvironment(textOrigin, cfg?.domains ?? {});
    if (resolved) {
      quickLoginMatchedEnv.value = resolved.env;
      redirectEnabled.value = resolved.env.debugRedirectEnabled ?? false;
      return;
    }
  } catch (e) {
    console.warn('[account-switch] Failed to match environment:', e);
  }
  quickLoginMatchedEnv.value = null;
  redirectEnabled.value = false;
});

/** 实时解析预览：粘贴文本后立即显示解析结果 */
const quickLoginPreview = computed(() => {
  const text = quickLoginText.value.trim();
  if (!text) return null;

  const parsed = parseLoginText(text, quickLoginDefaultDomain.value || origin.value);
  if (!parsed) {
    return { ok: false, hint: '格式无法解析' };
  }

  // 密码来源分析
  const isPureAccount = !parsed.hasUrl;
  const currentEnvPassword = isPureAccount ? matchedEnv.value?.defaultPassword : undefined;
  const textEnvPassword = isPureAccount ? undefined : quickLoginMatchedEnv.value?.defaultPassword;
  const password = resolvePassword({
    input: parsed.password,
    envDefault: currentEnvPassword ?? textEnvPassword,
    globalDefault: globalDefaultPassword.value,
  });

  const parts: string[] = [];
  if (parsed.hasUrl) {
    try {
      const u = new URL(parsed.url);
      parts.push(`🌐 ${u.host}`);
    } catch {
      parts.push(`🌐 ${parsed.url}`);
    }
  } else if (matchedEnv.value) {
    parts.push(`🌐 ${matchedEnv.value.name}`);
  }
  parts.push(`👤 ${parsed.username}`);
  if (password) {
    if (parsed.password) {
      parts.push('🔑 已输入密码');
    } else if (currentEnvPassword) {
      parts.push(`🔑 使用${matchedEnv.value?.name || '当前环境'}默认密码`);
    } else if (textEnvPassword) {
      parts.push(`🔑 使用目标环境默认密码`);
    } else {
      parts.push('🔑 使用全局默认密码');
    }
  } else {
    parts.push('⚠️ 未找到密码');
  }

  return { ok: true, parts };
});
</script>

<template>
  <div @keydown="handleKeydown" tabindex="0" class="as-panel" data-dt-root>
    <!-- Tab bar: env indicator + tab buttons -->
    <div class="as-tab-bar">
      <div v-if="origin" class="as-tab-env" :title="matchedEnv ? matchedEnv.name : '未配置环境'">
        <div class="i-lucide-globe w-3.5 h-3.5 as-tab-env-icon" />
        <span class="as-tab-env-label">{{ matchedEnv ? matchedEnv.name : '未配置环境' }}</span>
      </div>
      <template v-if="matchedEnv">
        <button
          v-for="tabKey in tabOrder"
          :key="tabKey"
          :class="['as-tab-btn', { active: activeTab === tabKey }]"
          @click="activeTab = tabKey"
        >
          <div :class="tabKey === 'users' ? 'i-lucide-users w-3.5 h-3.5 mr-1' : 'i-lucide-zap w-3.5 h-3.5 mr-1'" />
          {{ tabKey === 'users' ? '选择账号' : '快速登录' }}
        </button>
      </template>
      <button v-else class="as-tab-btn active" disabled>
        <div class="i-lucide-zap w-3.5 h-3.5 mr-1" />
        快速登录
      </button>
    </div>

    <!-- 选择账号 Tab 内容 -->
    <div v-show="activeTab === 'users' && matchedEnv">
      <!-- Search bar -->
      <div v-if="searchQuery || filteredAccounts.length >= 4" class="as-search-bar">
        <div class="i-lucide-search w-3.5 h-3.5 as-search-icon" />
        <input
          ref="searchInput"
          v-model="searchQuery"
          placeholder="搜索账号（名称/用户名）"
          class="as-search-input"
        />
        <button v-if="searchQuery || activeRole" class="as-search-clear" @click="clearSearch" title="清除">
          <div class="i-lucide-x w-3 h-3" />
        </button>
      </div>

      <!-- Role filter chips -->
      <div v-if="availableRoles.length > 1" class="as-role-filter">
        <button
          :class="['as-role-chip', { active: activeRole === null }]"
          @click="selectRole(null)"
        >
          全部
        </button>
        <button
          v-for="role in availableRoles"
          :key="role"
          :class="['as-role-chip', { active: activeRole === role }]"
          :style="activeRole === role ? { borderColor: roleColor(role), backgroundColor: roleColor(role) + '18' } : {}"
          @click="selectRole(role)"
        >
          {{ role }}
        </button>
      </div>

      <div v-if="filteredAccounts.length === 0" class="as-empty">
        <div v-if="searchQuery || activeRole" class="i-lucide-search-x w-10 h-10 as-empty-icon" />
        <div v-else class="i-lucide-user-x w-10 h-10 as-empty-icon animate-pulse" />
        <p v-if="searchQuery || activeRole" class="as-empty-text">
          没有找到匹配的账号
        </p>
        <p v-else class="as-empty-text">该环境下没有配置账号</p>
      </div>

      <div v-else :class="['as-account-list', { compact: isCompact }]">
        <div
          v-for="(acc, idx) in filteredAccounts"
          :key="acc.id"
          :class="['as-account-card', {
            highlighted: isHighlighted(idx),
            disabled: switchingAccountId !== null,
            loading: switchingAccountId === acc.id,
          }]"
          @click="switchAccount(acc)"
        >
          <div class="as-accent" :style="{ backgroundColor: roleColor(acc.roles[0] || '') }" />
          <div class="as-avatar">{{ accountInitial(acc) }}</div>
          <div class="as-body">
            <div class="as-name">{{ acc.name }}</div>
            <div class="as-meta">
              <span class="as-account-username">
                <div class="i-lucide-at-sign w-3 h-3" />
                {{ acc.username }}
              </span>
              <span class="as-roles">
                <span v-for="r in acc.roles" :key="r" class="as-role-tag" :style="roleColorStyle(r)">{{ r }}</span>
                <span v-if="acc.roles.length === 0" class="as-no-role">—</span>
              </span>
            </div>
          </div>
          <div v-if="switchingAccountId === acc.id" class="as-card-spinner" />
        </div>
      </div>
    </div>

    <!-- 快速登录 Tab 内容 -->
    <div v-show="activeTab === 'quicklogin' || !matchedEnv" class="as-quicklogin-tab">
      <div class="as-quicklogin-inner">
        <!-- 标题区 -->
        <div class="as-ql-header">
          <div class="i-lucide-zap w-4 h-4 as-ql-header-icon" />
          <div>
            <div class="as-ql-title">快速登录</div>
            <div class="as-ql-desc">粘贴测试信息，自动解析并跳转</div>
          </div>
        </div>

        <!-- 输入区 -->
        <textarea
          v-model="quickLoginText"
          @keydown="handleQuickLoginKeydown"
          class="as-ql-input"
          placeholder="在此粘贴测试信息&#10;Ctrl+Enter 快速登录"
          rows="5"
          spellcheck="false"
        />

        <!-- 实时解析预览 -->
        <div v-if="quickLoginPreview" class="as-ql-preview" :class="{ error: !quickLoginPreview.ok }">
          <template v-if="quickLoginPreview.ok && quickLoginPreview.parts">
            <div class="i-lucide-check-circle w-3 h-3 as-ql-preview-icon" />
            <span v-for="(part, i) in quickLoginPreview.parts" :key="i" class="as-ql-preview-part">
              {{ part }}<span v-if="i < quickLoginPreview.parts.length - 1" class="as-ql-preview-sep">·</span>
            </span>
          </template>
          <template v-else-if="!quickLoginPreview.ok">
            <div class="i-lucide-alert-circle w-3 h-3 as-ql-preview-icon" />
            <span>{{ quickLoginPreview.hint }}</span>
          </template>
        </div>

        <!-- 默认密码提示 -->
        <div v-if="quickLoginMatchedEnv?.defaultPassword" class="as-ql-password-hint">
          <div class="i-lucide-lock w-3 h-3" />
          <span>{{ quickLoginMatchedEnv.name }} 已启用默认密码，可仅输入 URL + 账号</span>
        </div>

        <!-- Bug 复现开关：登录成功后自动进入该环境配置的反馈页面 -->
        <div
          v-if="quickLoginMatchedEnv?.debugRedirect"
          class="as-ql-redirect-toggle"
          @click="redirectEnabled = !redirectEnabled"
        >
          <div :class="['as-ql-toggle-track', { active: redirectEnabled }]">
            <div :class="['as-ql-toggle-knob', { active: redirectEnabled }]" />
          </div>
          <span class="as-ql-toggle-label">
            登录后进入 Bug 页
            <span class="as-ql-toggle-target">{{ quickLoginMatchedEnv.debugRedirect }}</span>
          </span>
        </div>

        <!-- 操作按钮 -->
        <button
          class="as-ql-btn"
          :disabled="quickLoginLoading || !quickLoginText.trim()"
          @click="handleQuickLogin"
        >
          <div v-if="quickLoginLoading" class="as-ql-spinner" />
          <div v-else class="i-lucide-log-in w-3.5 h-3.5" />
          {{ quickLoginLoading ? '登录中...' : '登录并跳转' }}
        </button>

        <!-- 格式提示 -->
        <div class="as-ql-hint">
          <div class="i-lucide-info w-3 h-3" />
          <span>支持格式：<code>URL</code> + 回车 + <code>账号</code>（使用默认密码）或 <code>URL</code> + 回车 + <code>账号/密码</code></span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.as-panel {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #fff;
  outline: none;
}

/* ===== Tab bar ===== */
.as-tab-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  margin-bottom: 8px;
  border-bottom: 1px solid #e2e8f0;
  overflow-x: auto;
  -ms-overflow-style: none;
  scrollbar-width: none;
}

.as-tab-bar::-webkit-scrollbar {
  display: none;
}

[data-dt-dark] .as-tab-bar {
  border-bottom: none;
  background: linear-gradient(180deg, var(--dt-dark-surface-2, #1a1d26), var(--dt-dark-surface-1, #12141a));
}

.as-tab-env {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 6px;
  background: linear-gradient(135deg, rgba(99,102,241,0.06), rgba(59,130,246,0.06));
  border: 1px solid rgba(99,102,241,0.1);
  flex-shrink: 1;
  min-width: 0;
  max-width: 140px;
}

[data-dt-dark] .as-tab-env {
  background: linear-gradient(135deg, rgba(99,102,241,0.12), rgba(59,130,246,0.12));
  border: none;
}

.as-tab-env-icon {
  color: #94a3b8;
  flex-shrink: 0;
}

[data-dt-dark] .as-tab-env-icon {
  color: #64748b;
}

.as-tab-env-label {
  font-size: 12px;
  color: #64748b;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

[data-dt-dark] .as-tab-env-label {
  color: #8b949e;
}

.as-tab-btn {
  display: flex;
  align-items: center;
  padding: 4px 10px;
  border: 1px solid #e2e8f0;
  background: #fff;
  border-radius: 9999px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  color: #64748b;
  transition: all 0.2s ease-out;
  flex-shrink: 0;
}

[data-dt-dark] .as-tab-btn {
  background: #1a1d26;
  border: none;
  color: #8b949e;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
}

.as-tab-btn:hover {
  border-color: #93c5fd;
  color: #3b82f6;
}

[data-dt-dark] .as-tab-btn:hover {
  background: #212530;
  border: none;
  color: #f1f5f9;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.15);
}

.as-tab-btn.active {
  background: linear-gradient(135deg, #6366f1, #3b82f6);
  border-color: transparent;
  color: #fff;
  box-shadow: 0 1px 4px rgba(99, 102, 241, 0.25);
}

[data-dt-dark] .as-tab-btn.active {
  background: linear-gradient(135deg, #6366f1, #3b82f6);
  border-color: transparent;
  color: #fff;
  box-shadow: 0 1px 4px rgba(99, 102, 241, 0.25);
}

/* Quick login tab content */
.as-quicklogin-tab {
  padding: 8px 12px;
}

.as-quicklogin-inner {
  padding: 0;
}

/* ===== Environment bar (removed, replaced by tab bar) ===== */

/* ===== Search bar ===== */
.as-search-bar {
  position: relative;
  display: flex;
  align-items: center;
  margin-bottom: 8px;
  padding: 0 10px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
  transition: all 0.2s ease-out;
}

.as-search-bar:focus-within {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.1);
}

.as-search-icon {
  flex-shrink: 0;
  color: #94a3b8;
}

.as-search-input {
  flex: 1;
  border: none;
  background: transparent;
  padding: 7px 6px;
  font-size: 12px;
  color: #0f172a;
  outline: none;
}

.as-search-input::placeholder {
  color: #94a3b8;
}

.as-search-clear {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  border-radius: 4px;
  cursor: pointer;
  color: #94a3b8;
  transition: all 0.2s ease-out;
}

.as-search-clear:hover {
  background: #f1f5f9;
  color: #64748b;
}

/* ===== Role filter chips ===== */
.as-role-filter {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
  padding: 0 2px;
  overflow-x: auto;
  flex-wrap: nowrap;
  -ms-overflow-style: none;
  scrollbar-width: none;
}

.as-role-filter::-webkit-scrollbar {
  display: none;
}

.as-role-chip {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding: 3px 10px;
  border: 1px solid #e2e8f0;
  background: #fff;
  border-radius: 9999px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  color: #64748b;
  transition: all 0.2s ease-out;
  white-space: nowrap;
}

.as-role-chip:hover {
  border-color: #93c5fd;
  color: #3b82f6;
}

.as-role-chip.active {
  color: #fff;
  border-color: transparent;
  background: linear-gradient(135deg, #6366f1, #3b82f6);
  box-shadow: 0 1px 4px rgba(99, 102, 241, 0.25);
}

/* ===== Empty state ===== */
.as-empty {
  text-align: center;
  padding: 24px;
}

.as-empty-icon {
  width: 40px;
  height: 40px;
  display: block;
  margin: 0 auto 8px;
  color: #cbd5e1;
  opacity: 0.6;
}

.as-empty-text {
  font-size: 13px;
  color: #94a3b8;
  margin: 0 0 4px;
}

.as-empty-hint {
  font-size: 12px;
  color: #cbd5e1;
  margin: 0;
}

/* ===== Account list ===== */
.as-account-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: #fff;
}

.as-account-list.compact {
  gap: 4px;
}


/* ===== Account card ===== */
.as-account-card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px 10px 16px;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  cursor: pointer;
  transition:
    transform 0.2s cubic-bezier(0.16, 1, 0.3, 1),
    box-shadow 0.2s ease,
    border-color 0.2s ease;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

.as-account-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  border-color: #93c5fd;
}

.as-account-card:active {
  transform: translateY(0) scale(0.98);
  transition-duration: 0.1s;
}

.as-account-card.highlighted {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
}

/* 登录期间：所有卡片置灰禁用，进行中的卡片显示 spinner */
.as-account-card.disabled {
  opacity: 0.55;
  cursor: not-allowed;
  pointer-events: none;
  transform: none;
}

.as-account-card.loading {
  opacity: 1;
  border-color: #6366f1;
}

.as-card-spinner {
  position: absolute;
  right: 12px;
  top: 50%;
  margin-top: -7px;
  width: 14px;
  height: 14px;
  border: 2px solid rgba(99, 102, 241, 0.25);
  border-top-color: #6366f1;
  border-radius: 50%;
  animation: as-spin 0.6s linear infinite;
}

.as-account-list.compact .as-account-card {
  padding: 8px 12px 8px 14px;
}

.as-accent {
  position: absolute;
  left: 0;
  top: 10px;
  bottom: 10px;
  width: 3px;
  border-radius: 0 2px 2px 0;
}

.as-account-list.compact .as-accent {
  top: 8px;
  bottom: 8px;
}

/* 账号头像：固定中性色，不参与 10 色池（色池只用于角色 pill，避免字面花） */
.as-avatar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  user-select: none;
  background: #f1f5f9;
  color: #475569;
}

[data-dt-dark] .as-avatar {
  background: #21262d;
  color: #c9d1d9;
}

.as-body {
  flex: 1;
  min-width: 0;
}

.as-name {
  font-size: 13px;
  font-weight: 500;
  color: #0f172a;
  margin-bottom: 4px;
  display: flex;
  align-items: center;
}

.as-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.as-account-username {
  font-size: 12px;
  color: #94a3b8;
  display: flex;
  align-items: center;
}

.as-role-tag {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 9999px;
  font-weight: 500;
  white-space: nowrap;
  background-color: var(--role-light-bg);
  color: var(--role-light-fg);
  border: 1px solid color-mix(in srgb, var(--role-light-fg) 30%, transparent);
}

[data-dt-dark] .as-role-tag {
  background-color: var(--role-dark-bg);
  color: var(--role-dark-fg);
  border-color: color-mix(in srgb, var(--role-dark-fg) 30%, transparent);
}

.as-roles {
  display: flex;
  gap: 4px;
  align-items: center;
}

.as-no-role {
  font-size: 12px;
  color: #cbd5e1;
}

/* ===== Dark mode — scoped rules with higher specificity, no !important needed ===== */
[data-dt-dark] .as-panel {
  background: rgba(22, 27, 34, 0.95);
  border-color: rgba(48, 54, 61, 0.8);
  box-shadow: rgba(0, 0, 0, 0.4) 0px 8px 24px, rgba(0, 0, 0, 0.3) 0px 2px 8px;
}

[data-dt-dark] .as-search-bar {
  background: #12141a;
  border: none;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  transition: all 0.2s ease-out;
}

[data-dt-dark] .as-search-bar:focus-within {
  background: #1a1d26;
  border: none;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.2);
}

[data-dt-dark] .as-search-icon {
  color: #64748b;
}

[data-dt-dark] .as-search-input {
  color: #f1f5f9;
}

[data-dt-dark] .as-search-clear {
  color: #484f58;
}

[data-dt-dark] .as-search-clear:hover {
  background: var(--dt-dark-surface-hover);
  color: #94a3b8;
}

[data-dt-dark] .as-role-chip {
  background: #1a1d26;
  border: none;
  color: #8b949e;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
  transition: all 0.2s ease-out;
}

[data-dt-dark] .as-role-chip:hover {
  background: #212530;
  border: none;
  color: #f1f5f9;
  transform: translateY(-1px);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.15);
}

[data-dt-dark] .as-role-chip.active {
  color: #fff;
  background: linear-gradient(135deg, #6366f1, #3b82f6);
  border: none;
  box-shadow: 0 2px 8px rgba(99, 102, 241, 0.3);
}

[data-dt-dark] .as-empty-icon {
  color: var(--dt-dark-surface-hover);
}

[data-dt-dark] .as-empty-text {
  color: #8b949e;
}

[data-dt-dark] .as-empty-hint {
  color: #484f58;
}

[data-dt-dark] .as-account-list {
  background: transparent;
}

[data-dt-dark] .as-account-list.compact {
  gap: 4px;
}

[data-dt-dark] .as-account-card {
  background: #1a1d26;
  border: none;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
  transition:
    transform 0.2s cubic-bezier(0.16, 1, 0.3, 1),
    box-shadow 0.2s ease,
    background-color 0.2s ease;
}

[data-dt-dark] .as-account-card:hover {
  transform: translateY(-1px);
  background: #212530;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
}

[data-dt-dark] .as-account-card:active {
  transform: translateY(0) scale(0.98);
  transition-duration: 0.1s;
}

[data-dt-dark] .as-account-card.highlighted {
  background: #212530;
  border: none;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.2);
}

[data-dt-dark] .as-name {
  color: var(--dt-dark-text-primary, #f1f5f9);
}

[data-dt-dark] .as-account-username {
  color: var(--dt-dark-text-secondary, #8b949e);
}

[data-dt-dark] .as-no-role {
  color: var(--dt-dark-text-disabled, #484f58);
}

/* Role tags dark mode - 半透明背景 + 微妙发光 */

/* ===== Quick login ===== */
.as-ql-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.as-ql-header-icon {
  color: #f59e0b;
  flex-shrink: 0;
}

[data-dt-dark] .as-ql-header-icon {
  color: #fbbf24;
}

.as-ql-title {
  font-size: 13px;
  font-weight: 600;
  color: #0f172a;
}

[data-dt-dark] .as-ql-title {
  color: #f1f5f9;
}

.as-ql-desc {
  font-size: 12px;
  color: #94a3b8;
  margin-top: 2px;
}

[data-dt-dark] .as-ql-desc {
  color: #64748b;
}

.as-ql-input {
  width: 100%;
  font-size: 11px;
  font-family: var(--font-mono);
  padding: 8px 10px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  background: #fff;
  color: #0f172a;
  resize: none;
  outline: none;
  transition: all 0.2s ease-out;
  line-height: 1.5;
  box-sizing: border-box;
}

.as-ql-input:focus {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.1);
}

.as-ql-input::placeholder {
  color: #94a3b8;
}

[data-dt-dark] .as-ql-input {
  background: #12141a;
  color: var(--dt-dark-text-primary, #f0f6fc);
  border: none;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

[data-dt-dark] .as-ql-input:focus {
  background: #1a1d26;
  border: none;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.2);
}

[data-dt-dark] .as-ql-input::placeholder {
  color: var(--dt-dark-text-disabled, #484f58);
}

/* ===== Quick login preview ===== */
.as-ql-preview {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(99, 102, 241, 0.05);
  border: 1px solid rgba(99, 102, 241, 0.1);
  font-size: 12px;
  color: #6366f1;
  animation: as-preview-in 0.2s ease-out;
}

.as-ql-preview.error {
  background: rgba(239, 68, 68, 0.05);
  border-color: rgba(239, 68, 68, 0.12);
  color: #dc2626;
}

.as-ql-preview-icon {
  flex-shrink: 0;
}

.as-ql-preview-part {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.as-ql-preview-sep {
  margin: 0 2px;
  color: #94a3b8;
}

[data-dt-dark] .as-ql-preview {
  background: rgba(129, 140, 248, 0.08);
  border-color: rgba(129, 140, 248, 0.12);
  color: #818cf8;
}

[data-dt-dark] .as-ql-preview.error {
  background: rgba(248, 113, 113, 0.08);
  border-color: rgba(248, 113, 113, 0.15);
  color: #f87171;
}

[data-dt-dark] .as-ql-preview-sep {
  color: #484f58;
}

@keyframes as-preview-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}

/* Quick login button */
.as-ql-btn {
  margin-top: 10px;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 8px 12px;
  border: none;
  border-radius: 6px;
  background: linear-gradient(135deg, #6366f1, #3b82f6);
  color: #fff;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease-out;
  box-shadow: 0 1px 4px rgba(99, 102, 241, 0.25);
}

.as-ql-btn:hover {
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.35);
  transform: translateY(-1px);
}

.as-ql-btn:active {
  transform: scale(0.98);
}

.as-ql-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none;
}

[data-dt-dark] .as-ql-btn {
  background: linear-gradient(135deg, #818cf8, #60a5fa);
  box-shadow: 0 2px 8px rgba(99, 102, 241, 0.3);
}

[data-dt-dark] .as-ql-btn:hover:not(:disabled) {
  box-shadow: 0 4px 16px rgba(99, 102, 241, 0.4);
  transform: translateY(-1px);
}

[data-dt-dark] .as-ql-btn:active:not(:disabled) {
  transform: translateY(0) scale(0.98);
  transition-duration: 0.1s;
}

[data-dt-dark] .as-ql-btn:disabled {
  opacity: 0.5;
}

.as-ql-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: as-spin 0.6s linear infinite;
}

/* Default password hint */
.as-ql-password-hint {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(22, 163, 74, 0.06);
  border: 1px solid rgba(22, 163, 74, 0.12);
  font-size: 12px;
  color: #16a34a;
}

.as-ql-password-hint .i-lucide-lock {
  flex-shrink: 0;
  color: #16a34a;
}

[data-dt-dark] .as-ql-password-hint {
  background: rgba(74, 222, 128, 0.08);
  border: none;
  color: #4ade80;
}

[data-dt-dark] .as-ql-password-hint .i-lucide-lock {
  color: #4ade80;
}

/* Redirect toggle */
.as-ql-redirect-toggle {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(99, 102, 241, 0.04);
  border: 1px solid rgba(99, 102, 241, 0.08);
  transition: all 0.2s ease-out;
}

.as-ql-redirect-toggle:hover {
  background: rgba(99, 102, 241, 0.08);
}

[data-dt-dark] .as-ql-redirect-toggle {
  background: rgba(99, 102, 241, 0.08);
  border: none;
}

.as-ql-toggle-track {
  width: 38px;
  height: 20px;
  border-radius: 10px;
  background: #cbd5e1;
  position: relative;
  transition: all 0.2s ease-out;
  flex-shrink: 0;
}

.as-ql-toggle-track.active {
  background: linear-gradient(135deg, #6366f1, #3b82f6);
}

[data-dt-dark] .as-ql-toggle-track {
  background: #475569;
}

[data-dt-dark] .as-ql-toggle-track.active {
  background: linear-gradient(135deg, #818cf8, #60a5fa);
  box-shadow: 0 0 6px rgba(129, 140, 248, 0.4);
}

.as-ql-toggle-knob {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  position: absolute;
  top: 2px;
  left: 2px;
  transition: all 0.2s ease-out;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
}

.as-ql-toggle-knob.active {
  left: 20px;
}

.as-ql-toggle-label {
  font-size: 12px;
  color: #64748b;
  display: flex;
  align-items: center;
  gap: 4px;
}

[data-dt-dark] .as-ql-toggle-label {
  color: #8b949e;
}

.as-ql-toggle-target {
  font-family: var(--font-mono);
  font-size: 11px;
  color: #94a3b8;
}

[data-dt-dark] .as-ql-toggle-target {
  color: #64748b;
}

.as-ql-hint {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-top: 10px;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(99, 102, 241, 0.04);
  border: 1px solid rgba(99, 102, 241, 0.08);
  font-size: 11px;
  color: #64748b;
  line-height: 1.5;
}

.as-ql-hint .i-lucide-info {
  flex-shrink: 0;
  color: #94a3b8;
  margin-top: 1px;
}

[data-dt-dark] .as-ql-hint {
  background: rgba(99, 102, 241, 0.08);
  border: none;
  color: #8b949e;
}

[data-dt-dark] .as-ql-hint .i-lucide-info {
  color: #64748b;
}

.as-ql-hint code {
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(99, 102, 241, 0.08);
  color: #6366f1;
  font-size: 11px;
  font-family: var(--font-mono);
}

[data-dt-dark] .as-ql-hint code {
  background: rgba(129, 140, 248, 0.12);
  color: #818cf8;
}

@keyframes as-spin {
  to { transform: rotate(360deg); }
}

</style>
