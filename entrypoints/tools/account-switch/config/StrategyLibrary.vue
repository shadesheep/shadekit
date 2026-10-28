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
import type { DomainConfig, StrategyEntry } from '../types';

const props = defineProps<{
  strategies?: Record<string, StrategyEntry>;
  domains: Record<string, DomainConfig>;
}>();

const emit = defineEmits<{
  save: [strategies: Record<string, StrategyEntry>, message: string];
  saveDomains: [domains: Record<string, DomainConfig>, message: string];
}>();

const items = computed(() => listStrategies(props.strategies, props.domains));

/** 编辑抽屉 */
const editingId = ref('');
const editingName = ref('');
const editingSpec = ref<LoginSpec | null>(null);

function openEdit(item: StrategyListItem): void {
  editingId.value = item.id;
  editingName.value = item.name;
  editingSpec.value = JSON.parse(JSON.stringify(item.spec)) as LoginSpec;
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

function syncToEnvironments(item: StrategyListItem): void {
  const bound = boundEnvironments(props.domains, item.id);
  if (bound.length === 0) return;
  const privateCount = bound.filter(
    (url) => props.domains[url]?.strategyConfig?.spec !== undefined,
  ).length;
  if (
    privateCount > 0 &&
    !confirm(
      `确定重置登录策略「${item.name}」的镜像？\n` +
        `这将覆盖 ${privateCount} 个环境的私有修改，且无法恢复。`,
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
        '策略库条目删除后不可恢复，环境记录不会被删除。',
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

function formatTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  return new Date(ts).toLocaleString();
}
</script>

<template>
  <div class="form-card">
    <h3>
      <div class="i-lucide-library w-4 h-4" />
      登录策略库
    </h3>
    <p class="settings-hint">
      策略是可分享的登录声明，独立于环境。环境通过「登录策略」关联策略，关联不产生额外环境；
      未偏离库版本的环境会持续跟随库版本；在本环境修改并保存声明后，仅本环境生效。删除策略会让镜像环境回到未配置状态。
    </p>

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
            {{ item.spec.vars?.length ?? 0 }} 个变量 · {{ item.spec.ops.length }} 个算子
            <span v-if="formatTime(item.updatedAt)"> · 更新于 {{ formatTime(item.updatedAt) }}</span>
          </div>
        </div>
        <div class="strategy-actions">
          <DtButton size="sm" @click="openEdit(item)">
            <div class="i-lucide-pencil w-3.5 h-3.5 mr-1" />编辑
          </DtButton>
          <DtButton
            size="sm"
            :disabled="item.boundCount === 0"
            :title="item.boundCount === 0 ? '没有已关联的环境' : `把 ${item.boundCount} 个已关联环境中改过声明的重置回镜像`"
            @click="syncToEnvironments(item)"
          >
            <div class="i-lucide-refresh-cw w-3.5 h-3.5 mr-1" />重置镜像
          </DtButton>
          <DtButton size="sm" variant="danger" @click="remove(item)">
            <div class="i-lucide-trash-2 w-3.5 h-3.5 mr-1" />删除
          </DtButton>
        </div>
      </li>
    </ul>

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
  color: #94a3b8;
  margin-bottom: 16px;
}

.strategy-empty {
  font-size: 13px;
  color: #94a3b8;
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
  padding: 10px 12px;
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
  color: #94a3b8;
}

.strategy-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.strategy-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
</style>
