<script setup lang="ts">
/**
 * 登录策略库卡片（ADR-0019，引用 + 镜像）。
 *
 * 策略是独立于环境的可分享对象；本卡片提供它的增删改查与和环境的解耦：
 *
 * - 列表：名称 / 变量数 / 已关联环境数 / 最近更新时间；
 * - 编辑：保存后**镜像环境立即生效**（它们不持声明拷贝）；脱镜环境（在环境
 *   里改过声明）不受影响；
 * - 重置镜像：把脱镜环境**重置回镜像**（丢弃其私有声明），恢复「库一改即生效」；
 * - 删除：直接摘绑定——脱镜环境的私有声明原样保留，镜像环境回到「未配置」。
 *
 * 只 emit 变更，落盘由 Config.vue 统一走 updateConfig。
 */
import { computed, ref } from 'vue';
import SpecEditor from './SpecEditor.vue';
import DtButton from '../../../shared/components/DtButton.vue';
import DtDrawer from '../../../shared/components/DtDrawer.vue';
import {
  boundEnvironments,
  listStrategies,
  removeStrategy,
  syncBoundEnvironments,
  updateStrategy,
  type StrategyListItem,
} from '../spec/strategy-library';
import type { LoginSpec } from '../spec';
import { inspectLoginSpecSupport } from '../spec/capabilities';
import { requireSupportedLoginSpec } from '../spec/document';
import type { DomainConfig, StrategyEntry } from '../types';

const props = defineProps<{
  strategies?: Record<string, StrategyEntry>;
  domains: Record<string, DomainConfig>;
}>();

const emit = defineEmits<{
  save: [strategies: Record<string, StrategyEntry>, message: string];
  saveDomains: [domains: Record<string, DomainConfig>, message: string];
}>();

const items = computed(() =>
  listStrategies(props.strategies, props.domains).map((item) => ({
    ...item,
    support: inspectLoginSpecSupport(item.spec, item.declaredSpecVersion),
  })),
);

/** 编辑抽屉 */
const editingId = ref('');
const editingName = ref('');
const editingSpec = ref<LoginSpec | null>(null);

function openEdit(item: StrategyListItem): void {
  let spec: LoginSpec;
  try {
    spec = requireSupportedLoginSpec(item.spec, item.declaredSpecVersion);
  } catch {
    return;
  }
  editingId.value = item.id;
  editingName.value = item.name;
  editingSpec.value = JSON.parse(JSON.stringify(spec)) as LoginSpec;
}

function closeEdit(): void {
  editingId.value = '';
  editingSpec.value = null;
}

function saveEdit(): void {
  const spec = editingSpec.value;
  if (!editingId.value || !spec) return;
  const next = updateStrategy(props.strategies, editingId.value, spec);
  const entry = next[editingId.value];
  closeEdit();
  emit('save', next, `登录策略「${entry?.name ?? ''}」已更新`);
}

function closeActionMenu(event: Event): void {
  (event.target as HTMLElement).closest('details')?.removeAttribute('open');
}

function closeMenuOnBlur(event: FocusEvent): void {
  const menu = event.currentTarget as HTMLDetailsElement;
  if (!menu.contains(event.relatedTarget as Node | null)) menu.open = false;
}

function environmentNames(urls: string[]): string {
  return urls.map((url) => props.domains[url]?.name || url).join('、');
}

function syncToEnvironments(item: StrategyListItem): void {
  const bound = boundEnvironments(props.domains, item.id);
  if (bound.length === 0) return;
  const privateEnvironments = bound.filter(
    (url) => props.domains[url]?.strategyConfig?.spec !== undefined,
  );
  const privateCount = privateEnvironments.length;
  if (
    privateCount > 0 &&
    !confirm(
      `确定重置登录策略「${item.name}」的镜像？\n` +
        `这将覆盖 ${privateCount} 个环境的私有修改，且无法恢复。\n` +
        `受影响环境：${environmentNames(privateEnvironments)}`,
    )
  )
    return;
  const result = syncBoundEnvironments(props.domains, item.id, item);
  if (result.updated === 0) {
    emit('saveDomains', props.domains, '所有已关联环境都已跟随库版本，无需重置');
    return;
  }
  emit(
    'saveDomains',
    result.domains,
    `已重置 ${result.updated} 个环境的镜像，后续将跟随库版本`,
  );
}

function remove(item: StrategyListItem): void {
  const bound = boundEnvironments(props.domains, item.id);
  // 镜像（无私有声明）的环境在库条目删除后会失去登录声明
  const mirroringCount = bound.filter(
    (url) => props.domains[url]?.strategyConfig?.spec === undefined,
  ).length;
  const detail =
    bound.length === 0
      ? '该策略尚未被任何环境使用。'
      : mirroringCount === 0
        ? `已关联的 ${bound.length} 个环境都持有自己的登录声明，删除后行为不变。`
        : `已关联的 ${bound.length} 个环境中有 ${mirroringCount} 个一直在镜像库条目，删除后它们将回到「未配置登录」状态。`;
  if (
    !confirm(
      `确定删除登录策略「${item.name}」？\n${detail}\n\n` +
        '策略库条目删除后不可恢复，环境记录不会被删除。' +
        (bound.length ? `\n关联环境：${environmentNames(bound)}` : ''),
    )
  )
    return;
  const result = removeStrategy(props.strategies, props.domains, item.id);
  if (result.detached.length > 0) {
    emit('saveDomains', result.domains, '已解除策略关联');
  }
  emit(
    'save',
    result.strategies,
    `登录策略「${item.name}」已删除` +
      (result.detached.length > 0
        ? `（已解除 ${result.detached.length} 个环境的关联）`
        : ''),
  );
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function formatTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  return new Date(ts).toLocaleString();
}
</script>

<template>
  <div class="form-card">
    <div class="strategy-heading">
      <div>
        <h3><div class="i-lucide-library w-4 h-4" aria-hidden="true" />登录策略库</h3>
        <p class="settings-hint">集中维护可被多个环境复用的登录流程</p>
      </div>
      <span class="strategy-count">{{ items.length }} 个策略</span>
    </div>

    <div v-if="items.length === 0" class="strategy-empty">
      还没有登录策略。在「环境与账号」页用「导入登录策略包…」导入，或在环境编辑页把当前声明存入策略库。
    </div>

    <ul v-else class="strategy-list">
      <li v-for="item in items" :key="item.id" class="strategy-item">
        <div class="strategy-main">
          <div class="strategy-title-row">
            <span class="strategy-name">{{ item.name }}</span>
            <span v-if="item.boundCount > 0" class="strategy-badge">
              已关联 {{ item.boundCount }} 个环境
            </span>
            <span v-else class="strategy-badge muted">未关联</span>
          </div>
          <div class="strategy-meta">
            {{ arrayLength(item.spec.vars) }} 个变量 · {{ arrayLength(item.spec.ops) }} 个算子
            <span v-if="!item.support.supported">
              · 当前客户端不支持：{{ item.support.issues.map((issue) => issue.message).join('；') }}
            </span>
            <span v-if="formatTime(item.updatedAt)"> · 更新于 {{ formatTime(item.updatedAt) }}</span>
          </div>
        </div>
        <div class="strategy-actions">
          <DtButton
            size="sm"
            :disabled="!item.support.supported"
            :title="item.support.supported ? '' : '当前客户端不支持编辑该声明'"
            @click="openEdit(item)"
          >
            <div class="i-lucide-pencil w-3.5 h-3.5 mr-1" />编辑
          </DtButton>
          <details class="strategy-more" name="strategy-actions" @keydown.esc.prevent="closeActionMenu" @focusout="closeMenuOnBlur">
            <summary :aria-label="`更多策略操作：${item.name}`">更多<div class="i-lucide-chevron-down w-3.5 h-3.5" aria-hidden="true" /></summary>
            <div class="strategy-menu">
              <button type="button" :disabled="item.boundCount === 0" @click="closeActionMenu($event); syncToEnvironments(item)">
                <div class="i-lucide-refresh-cw w-3.5 h-3.5" aria-hidden="true" />重置镜像
              </button>
              <button type="button" class="strategy-delete" @click="closeActionMenu($event); remove(item)">
                <div class="i-lucide-trash-2 w-3.5 h-3.5" aria-hidden="true" />删除策略
              </button>
            </div>
          </details>
        </div>
      </li>
    </ul>

    <details class="strategy-help">
      <summary>关联环境如何跟随策略？</summary>
      <p>未单独修改登录流程的环境会跟随策略库更新；已自定义的环境保留自己的流程。重置镜像会覆盖这些自定义修改；删除策略会让跟随库版本的环境回到未配置状态。</p>
    </details>

    <DtDrawer :show="!!editingSpec" :title="`编辑策略「${editingName}」`" @close="closeEdit">
      <div v-if="editingSpec" class="strategy-editor">
        <p class="field-hint">
          镜像环境（未改过声明）会立即跟随这次编辑生效；只有在本环境里改过声明的
          「脱镜」环境不跟随——需要时回到列表点「重置镜像」把它们拉回来。
        </p>
        <SpecEditor :spec="editingSpec" @change="editingSpec = $event" />
      </div>
      <div class="form-actions">
        <DtButton variant="primary" @click="saveEdit">保存</DtButton>
        <DtButton variant="secondary" @click="closeEdit">取消</DtButton>
      </div>
    </DtDrawer>
  </div>
</template>

<style scoped>
@import '../../../shared/component-styles.scss';
@import './config-panel-shared.scss';

.settings-hint {
  font-size: 12px;
  color: #64748b;
  margin-bottom: 16px;
}

.strategy-empty {
  font-size: 13px;
  color: #64748b;
  padding: 14px 0;
}

.strategy-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.strategy-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 20px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  transition: all 0.15s ease-out;
}

.strategy-item:hover {
  border-color: #93c5fd;
}

[data-dt-dark] .strategy-item {
  border-color: var(--dt-dark-border);
}

[data-dt-dark] .strategy-item:hover {
  border-color: #58a6ff;
}

.strategy-main {
  min-width: 0;
}

.strategy-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.strategy-name {
  font-size: 13px;
  font-weight: 600;
  color: #0f172a;
}

[data-dt-dark] .strategy-name {
  color: #f1f5f9;
}

.strategy-badge {
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 9999px;
  background: #eff6ff;
  color: #2563eb;
}

.strategy-badge.muted {
  background: #f1f5f9;
  color: #64748b;
}

[data-dt-dark] .strategy-badge {
  background: #1e3a5f;
  color: #93c5fd;
}

[data-dt-dark] .strategy-badge.muted {
  background: var(--dt-dark-surface-hover);
  color: #8b949e;
}

.strategy-meta {
  margin-top: 3px;
  font-size: 12px;
  color: #64748b;
}

.strategy-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
  align-items: center;
}

.strategy-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.strategy-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
.strategy-heading h3 { margin-bottom: 6px; font-size: 15px; }
.strategy-heading .settings-hint { margin: 0; }
.strategy-count { color: #64748b; font-size: 12px; white-space: nowrap; }
.strategy-more { position: relative; }
.strategy-more summary { display: flex; align-items: center; gap: 6px; list-style: none; cursor: pointer; border: 1px solid #e2e8f0; border-radius: 6px; padding: 3px 8px; font-size: 12px; color: #374151; background: #fff; }
.strategy-more summary::-webkit-details-marker { display: none; }
.strategy-menu { position: absolute; right: 0; top: calc(100% + 6px); width: 160px; z-index: 10; padding: 5px; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; box-shadow: 0 6px 20px #0f172a15; }
.strategy-menu button { display: flex; align-items: center; gap: 8px; width: 100%; border: 0; border-radius: 5px; background: transparent; padding: 9px; text-align: left; color: #334155; cursor: pointer; font-size: 12px; }
.strategy-menu button:hover { background: #f1f5f9; }
.strategy-menu button:disabled { opacity: .5; cursor: not-allowed; }
.strategy-menu .strategy-delete { color: #b91c1c; }
.strategy-help { margin-top: 20px; font-size: 12px; color: #64748b; }
.strategy-help summary { cursor: pointer; }
.strategy-help p { max-width: 70ch; line-height: 1.7; margin: 10px 0 0; }
[data-dt-dark] .strategy-menu, [data-dt-dark] .strategy-more summary { background: #161b22; border-color: #30363d; color: #f1f5f9; }
[data-dt-dark] .strategy-menu button { color: #cbd5e1; }
[data-dt-dark] .strategy-menu button:hover { background: #21262d; }
[data-dt-dark] .strategy-menu .strategy-delete { color: #f87171; }
[data-dt-dark] .settings-hint, [data-dt-dark] .strategy-count, [data-dt-dark] .strategy-meta, [data-dt-dark] .strategy-empty, [data-dt-dark] .strategy-help { color: #a1adbd; }
@media (max-width: 600px) {
  .strategy-item { flex-wrap: wrap; padding: 16px; }
  .strategy-actions { margin-left: auto; }
  .strategy-meta { overflow-wrap: anywhere; }
}
</style>
