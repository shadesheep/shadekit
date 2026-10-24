<script setup lang="ts">
/**
 * 预览式导入抽屉（ADR-0017 D2 三轴）
 *
 * 拖入/选择文件即识别（detectImportKind，不靠文件名）→ 预览（planImport：
 * 识别结论 + 内容清单 + 冲突 + 校验问题）→ 勾选落地轴（登录策略 /
 * 账号与绑定）→ 选落地方式（新建/覆盖）→ 确认。
 *
 * 校验失败：问题定位到「R3 · 第 5 步 · …」（rule + opIndex），确认按钮禁用。
 * 冲突环境默认不勾选（可手动勾）。落地产出单个 patch 交给父组件一次
 * updateConfig 落盘——失败即整体不写，不产生半成品环境（零半成品不变量）。
 */
import { computed, ref } from 'vue';
import DtButton from '../../../shared/components/DtButton.vue';
import { useOverlayClose } from '../../../shared/use-overlay-close';
import {
  planImport,
  type ImportIssue,
  type ImportLandMode,
  type ImportPlan,
} from '../account-env-view';
import type {
  Account,
  AccountSwitchConfig,
  DomainConfig,
} from '../types';

const props = defineProps<{
  accounts: Account[];
  domains: Record<string, DomainConfig>;
}>();

const emit = defineEmits<{
  save: [patch: Partial<AccountSwitchConfig>, message: string];
  close: [];
}>();

// 遮罩空白处点击关闭：mousedown+click 同源才触发，见 useOverlayClose 说明
const overlayClose = useOverlayClose(() => emit('close'));

const dragOver = ref(false);
const fileName = ref('');
/** 非 JSON 的加载错误（与 plan.issues 同一展示位，确认禁用） */
const loadError = ref('');
const plan = ref<ImportPlan | null>(null);
/** 识别结论（「识别到：登录策略包（dt-login-config/v1）」） */
const detectedLabel = ref('');
/** full 包的工具数（内容清单用） */
const fullToolCount = ref(0);
const axisChecked = ref({ strategy: false, accounts: false });
const landMode = ref<ImportLandMode>('create');

function reset() {
  plan.value = null;
  loadError.value = '';
  fileName.value = '';
  detectedLabel.value = '';
  dragOver.value = false;
}

async function loadFile(file: File) {
  reset();
  fileName.value = file.name;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    loadError.value = '文件不是合法 JSON';
    return;
  }
  const p = planImport(parsed, {
    accounts: props.accounts,
    domains: props.domains,
  });
  plan.value = p;
  if (p.kind === 'strategy') {
    const format = (parsed as { format?: unknown }).format;
    detectedLabel.value = `登录策略包（${typeof format === 'string' ? format : '未知版本'}）`;
  } else if (p.kind === 'accounts') {
    detectedLabel.value = '账号备份（含明文密码，勿分享）';
  } else if (p.kind === 'full') {
    fullToolCount.value = Object.keys(parsed as Record<string, unknown>).filter(
      (k) => k !== '__version',
    ).length;
    detectedLabel.value = `全部工具设置（${fullToolCount.value} 个工具）`;
  } else {
    detectedLabel.value = '无法识别的文件';
  }
  axisChecked.value = {
    strategy: p.axes.strategy.defaultChecked,
    accounts: p.axes.accounts.defaultChecked,
  };
  landMode.value = p.landOptions.defaultMode;
}

function onPick(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) void loadFile(file);
}

function onDrop(event: DragEvent) {
  dragOver.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (file) void loadFile(file);
}

/**
 * 「R3 · 第 5 步 · auth.write 位于成功信号之前」式定位（rule + opIndex）。
 * validateConfigPackage / validateLoginSpec 的 message 本身已含「第 N 步（op）…」，
 * 此时不再前置一次（避免「R3 · 第 5 步 · 第 5 步（goto）…」式重复）。
 */
function formatIssue(issue: ImportIssue): string {
  const parts: string[] = [];
  if (issue.rule) parts.push(issue.rule);
  if (
    issue.opIndex !== undefined &&
    !issue.message.includes(`第 ${issue.opIndex + 1} 步`)
  ) {
    parts.push(`第 ${issue.opIndex + 1} 步`);
  }
  parts.push(issue.message);
  return parts.join(' · ');
}

const shownIssues = computed<ImportIssue[]>(() => {
  if (loadError.value) return [{ message: loadError.value }];
  return plan.value?.issues ?? [];
});

/** 落地方式 = 新建时冲突跳过；覆盖时落地勾选的冲突项 */
const landableEnvs = computed(() => {
  const p = plan.value;
  if (!p || !axisChecked.value.strategy) return [];
  return p.envs.filter(
    (e) => !e.conflict || (landMode.value === 'overwrite' && e.checked),
  );
});

const accountsWillLand = computed(
  () =>
    !!plan.value &&
    axisChecked.value.accounts &&
    plan.value.axes.accounts.available,
);

const canConfirm = computed(() => {
  const p = plan.value;
  if (!p || p.issues.length > 0) return false;
  return accountsWillLand.value || landableEnvs.value.length > 0;
});

/** 账号列表将被空列表清空的警示（沿用旧「从文件导入」的保护语义） */
const emptyAccountsWarning = computed(
  () =>
    accountsWillLand.value &&
    plan.value!.accountsToLand.length === 0 &&
    props.accounts.length > 0,
);

function confirm() {
  const p = plan.value;
  if (!p || !canConfirm.value) return;
  // 单个 patch 一次落盘：任一轴的内容都先算好，失败即整体不写（零半成品）
  const patch: Partial<AccountSwitchConfig> = {};
  const parts: string[] = [];
  if (accountsWillLand.value) {
    patch.accounts = JSON.parse(JSON.stringify(p.accountsToLand));
    parts.push(`${p.accountsToLand.length} 个账号`);
  }
  if (axisChecked.value.strategy) {
    const next: Record<string, DomainConfig> = JSON.parse(
      JSON.stringify(props.domains),
    );
    for (const item of landableEnvs.value) {
      next[item.url] = item.domain;
    }
    patch.domains = next;
    parts.push(`${landableEnvs.value.length} 个环境`);
  }
  emit('save', patch, `已导入 ${parts.join('，')}`);
}
</script>

<template>
  <div
    class="drawer-overlay"
    @mousedown="overlayClose.onOverlayMousedown"
    @click="overlayClose.onOverlayClick"
  >
    <div class="drawer-card" data-dt-root>
      <h3 class="drawer-title">
        <div class="i-lucide-download w-4 h-4 mr-1" />导入
      </h3>

      <!-- 空态：拖入/选文件 + 从 Skill 粘贴（禁用占位） -->
      <template v-if="!plan && !loadError">
        <p class="drawer-hint">
          拖入文件即识别内容，不靠文件名：登录策略包（登录声明，可分享）/
          账号备份（含明文密码，勿分享）/ 全部工具设置。
        </p>
        <div
          class="drop-zone"
          :class="{ 'drop-zone-active': dragOver }"
          @dragover.prevent="dragOver = true"
          @dragleave.prevent="dragOver = false"
          @drop.prevent="onDrop"
        >
          <div class="i-lucide-file-json w-6 h-6" />
          <p class="drop-zone-text">把 .json 文件拖到这里</p>
          <label class="drop-zone-pick">
            <div class="i-lucide-folder-open w-3.5 h-3.5 mr-1" />选择文件
            <input
              type="file"
              accept=".json,application/json"
              class="hidden-file"
              @change="onPick"
            />
          </label>
        </div>
        <div class="skill-paste">
          <textarea
            class="dt-input skill-paste-input"
            disabled
            rows="2"
            placeholder="从 Skill 粘贴登录策略 —— 待 Skill 上线"
          />
          <p class="drawer-hint">
            Skill 以问答方式产出登录声明，上线后可直接粘贴导入，无需先存成文件。
          </p>
        </div>
        <div class="form-actions">
          <DtButton variant="secondary" @click="emit('close')">取消</DtButton>
        </div>
      </template>

      <!-- 预览：识别结论 → 内容清单 → 问题/轴/落地方式 → 确认 -->
      <template v-else>
        <p v-if="detectedLabel" class="drawer-detected">
          识别到：<strong>{{ detectedLabel }}</strong>
          <span class="drawer-file-name">{{ fileName }}</span>
        </p>

        <!-- 内容清单：文件里有什么 -->
        <ul v-if="plan" class="drawer-inventory">
          <li v-if="plan.axes.strategy.available">
            登录策略：{{ plan.axes.strategy.count }} 个环境声明
          </li>
          <li v-if="plan.axes.accounts.available">
            账号与绑定：{{ plan.axes.accounts.count }} 个（含明文密码）
          </li>
          <li v-if="plan.axes.accounts.available" class="drawer-inventory-note">
            不含指示器设置（角标开关导入后保持当前配置，如需调整到设置页修改）
          </li>
          <li v-if="plan.kind === 'full'" class="drawer-inventory-note">
            此处只落地「环境与账号」两轴；其余工具的设置请用选项页顶部「导入全部工具设置」
          </li>
        </ul>

        <!-- 校验问题：rule · 第 N 步 · message，确认禁用 + 一句话指引 -->
        <div v-if="shownIssues.length > 0" class="drawer-issues">
          <p v-for="(issue, idx) in shownIssues" :key="idx" class="drawer-issue">
            <div class="i-lucide-alert-triangle w-3.5 h-3.5 mr-1" />
            {{ formatIssue(issue) }}
          </p>
          <p class="drawer-issue-guide">
            该改哪里：问题出在文件的登录声明上——script 算子与 secret
            变量不能随包分发，版本过高需先升级扩展；请让提供方修正后重新导出，再导入。
          </p>
        </div>

        <template v-if="plan && plan.issues.length === 0 && plan.kind !== 'unknown'">
          <!-- 落地轴（按 kind 启停） -->
          <div class="drawer-section">
            <p class="drawer-section-label">落地内容</p>
            <label
              class="drawer-axis"
              :class="{ 'drawer-axis-disabled': !plan.axes.strategy.available }"
            >
              <input
                type="checkbox"
                v-model="axisChecked.strategy"
                :disabled="!plan.axes.strategy.available"
              />
              登录策略
              <span v-if="plan.axes.strategy.available" class="drawer-axis-count">
                {{ plan.axes.strategy.count }} 个环境声明
              </span>
            </label>
            <label
              class="drawer-axis"
              :class="{ 'drawer-axis-disabled': !plan.axes.accounts.available }"
            >
              <input
                type="checkbox"
                v-model="axisChecked.accounts"
                :disabled="!plan.axes.accounts.available"
              />
              账号与绑定
              <span v-if="plan.axes.accounts.available" class="drawer-axis-count">
                {{ plan.axes.accounts.count }} 个，含明文密码
              </span>
            </label>
          </div>

          <!-- 落地方式（有冲突才可选覆盖） -->
          <div v-if="axisChecked.strategy" class="drawer-section">
            <p class="drawer-section-label">落地方式</p>
            <label class="drawer-axis">
              <input type="radio" value="create" v-model="landMode" />
              新建环境<span class="drawer-axis-count">冲突地址跳过</span>
            </label>
            <label
              class="drawer-axis"
              :class="{
                'drawer-axis-disabled': !plan.landOptions.modes.includes('overwrite'),
              }"
            >
              <input
                type="radio"
                value="overwrite"
                v-model="landMode"
                :disabled="!plan.landOptions.modes.includes('overwrite')"
              />
              覆盖已有环境
              <span v-if="!plan.landOptions.modes.includes('overwrite')" class="drawer-axis-count">
                没有地址冲突，无需覆盖
              </span>
            </label>
          </div>

          <!-- 环境清单：非冲突直接落地；冲突默认不勾选，可手动勾 -->
          <div v-if="axisChecked.strategy && plan.envs.length > 0" class="drawer-env-list">
            <div
              v-for="item in plan.envs"
              :key="item.url"
              class="drawer-env-item"
              :class="{ 'drawer-env-conflict': item.conflict }"
            >
              <label class="drawer-env-check">
                <input
                  v-if="item.conflict"
                  type="checkbox"
                  v-model="item.checked"
                  :disabled="landMode !== 'overwrite'"
                />
                <span class="drawer-env-name">
                  {{ item.name }}
                  <span v-if="item.conflict" class="drawer-conflict-tag">
                    地址已占用{{ landMode === 'overwrite' ? '（勾选后覆盖）' : '（将跳过）' }}
                  </span>
                </span>
              </label>
              <span class="drawer-env-url">{{ item.url }}</span>
            </div>
          </div>

          <p v-if="emptyAccountsWarning" class="drawer-warning">
            <div class="i-lucide-alert-triangle w-3.5 h-3.5 mr-1" />
            文件中的账号列表为空：落地将清空当前 {{ accounts.length }} 个账号。
          </p>
        </template>

        <div class="form-actions">
          <DtButton
            variant="primary"
            :disabled="!canConfirm"
            :title="plan && plan.issues.length > 0 ? '先修好登录声明再导入' : ''"
            @click="confirm"
          >
            <div class="i-lucide-check w-4 h-4 mr-1" />确认导入
          </DtButton>
          <DtButton variant="secondary" @click="reset">重新选择文件</DtButton>
          <DtButton variant="secondary" @click="emit('close')">取消</DtButton>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
@import '../../../shared/component-styles.scss';
@import './config-panel-shared.scss';

.drawer-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 48px 16px;
  background: rgba(15, 23, 42, 0.5);
  backdrop-filter: blur(2px);
}

.drawer-card {
  width: 100%;
  max-width: 560px;
  max-height: 80vh;
  overflow-y: auto;
  background: #fff;
  border-radius: 12px;
  border: 1px solid #e2e8f0;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.2);
  padding: 20px;
}

[data-dt-dark] .drawer-card {
  background: var(--dt-dark-surface);
  border-color: var(--dt-dark-border);
}

.drawer-title {
  display: flex;
  align-items: center;
  font-size: 16px;
  font-weight: 600;
  color: #0f172a;
  margin: 0 0 10px;
}

[data-dt-dark] .drawer-title {
  color: #f1f5f9;
}

.drawer-hint {
  font-size: 12px;
  color: #64748b;
  margin: 0 0 12px;
  line-height: 1.6;
}

.drop-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 28px 16px;
  border: 1.5px dashed #cbd5e1;
  border-radius: 10px;
  color: #64748b;
  transition: all 0.15s ease-out;
}

[data-dt-dark] .drop-zone {
  border-color: var(--dt-dark-border);
  color: #8b949e;
}

.drop-zone-active {
  border-color: #3b82f6;
  background: rgba(59, 130, 246, 0.06);
  color: #3b82f6;
}

.drop-zone-text {
  margin: 0;
  font-size: 13px;
}

.drop-zone-pick {
  position: relative;
  /* 对齐 DtButton 默认形态（按钮承载不了 file input，这里用 label 伪装成按钮） */
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  background: #fff;
  color: #374151;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.2s ease;
}

.drop-zone-pick:hover {
  background: #f1f5f9;
  border-color: #cbd5e1;
}

.drop-zone-pick:active {
  transform: scale(0.98);
}

[data-dt-dark] .drop-zone-pick {
  background: var(--dt-dark-surface-hover);
  border-color: var(--dt-dark-border);
  color: #c9d1d9;
}

[data-dt-dark] .drop-zone-pick:hover {
  background: var(--dt-dark-border);
}

.hidden-file {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

.skill-paste {
  margin-top: 14px;
}

.skill-paste-input {
  width: 100%;
  resize: none;
  opacity: 0.6;
  cursor: not-allowed;
}

.skill-paste .drawer-hint {
  margin: 6px 0 0;
}

.drawer-detected {
  font-size: 14px;
  color: #0f172a;
  margin: 0 0 10px;
}

[data-dt-dark] .drawer-detected {
  color: #f1f5f9;
}

.drawer-file-name {
  margin-left: 8px;
  font-size: 12px;
  color: #94a3b8;
}

.drawer-inventory {
  margin: 0 0 12px;
  padding-left: 18px;
  font-size: 13px;
  color: #334155;
  line-height: 1.8;
}

[data-dt-dark] .drawer-inventory {
  color: #c9d1d9;
}

.drawer-inventory-note {
  color: #64748b;
  font-size: 12px;
}

.drawer-issues {
  border: 1px solid #fca5a5;
  background: rgba(239, 68, 68, 0.06);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}

[data-dt-dark] .drawer-issues {
  border-color: #7f1d1d;
  background: rgba(239, 68, 68, 0.12);
}

.drawer-issue {
  display: flex;
  align-items: flex-start;
  font-size: 13px;
  color: #b91c1c;
  margin: 0 0 6px;
  line-height: 1.5;
}

[data-dt-dark] .drawer-issue {
  color: #fca5a5;
}

.drawer-issue .i-lucide-alert-triangle {
  flex-shrink: 0;
  margin-top: 2px;
}

.drawer-issue-guide {
  font-size: 12px;
  color: #64748b;
  margin: 8px 0 0;
  line-height: 1.6;
}

.drawer-section {
  margin-bottom: 12px;
}

.drawer-section-label {
  font-size: 12px;
  font-weight: 600;
  color: #64748b;
  margin: 0 0 6px;
}

.drawer-axis {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #0f172a;
  padding: 4px 0;
  cursor: pointer;
}

[data-dt-dark] .drawer-axis {
  color: #f1f5f9;
}

.drawer-axis-disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.drawer-axis-count {
  font-size: 12px;
  color: #94a3b8;
}

.drawer-env-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}

.drawer-env-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 8px 12px;
}

[data-dt-dark] .drawer-env-item {
  border-color: var(--dt-dark-border);
}

.drawer-env-item.drawer-env-conflict {
  border-color: #f59e0b;
  background: rgba(245, 158, 11, 0.06);
}

.drawer-env-check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 500;
  color: #0f172a;
  cursor: pointer;
}

[data-dt-dark] .drawer-env-check {
  color: #f1f5f9;
}

.drawer-conflict-tag {
  margin-left: 6px;
  font-size: 12px;
  font-weight: 400;
  color: var(--warning);
  background: rgba(245, 158, 11, 0.15);
  border-radius: 4px;
  padding: 1px 6px;
}

.drawer-env-url {
  font-size: 12px;
  color: #94a3b8;
  word-break: break-all;
}

.drawer-warning {
  display: flex;
  align-items: flex-start;
  font-size: 12px;
  color: var(--warning);
  margin: 0 0 12px;
  line-height: 1.6;
}

.drawer-warning .i-lucide-alert-triangle {
  flex-shrink: 0;
  margin-top: 2px;
}

.form-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
</style>
