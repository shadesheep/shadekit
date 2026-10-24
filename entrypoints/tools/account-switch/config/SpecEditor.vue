<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type {
  LoginSpec,
  SpecOp,
  SpecOpName,
  Target,
} from '../spec';
import {
  bucketSpecErrors,
  changeSpecOp,
  cloneSpecOps,
  createSpecOp,
  duplicateSpecOp,
  hasSpecErrors,
  insertSpecOp,
  moveSpecOp,
  removeSpecOp,
  reorderOpsAroundForm,
  simpleSpecShape,
  specAuxToEdit,
  specInputHints,
  specsAux,
  specsVariables,
  specVarsToEdit,
  SPEC_OP_OPTIONS,
  updateSpecOp,
  type SpecAuxEdit,
  type SpecVarEdit,
} from '../spec';
import { validateLoginSpec } from '../spec/validate';
import { sendBgMessage } from '../../../shared/messages';
import { SCAN_ERROR_TEXT, type FormScanFrame } from './login-form-scan';
import { rankPickerTabs } from './target-picker';
import DtButton from '../../../shared/components/DtButton.vue';
import TargetField from './TargetField.vue';
import type { TargetCandidate } from './target-picker';

/** waitFor.when.type 的可选值（界面里的切换项） */
type SettleKindValue =
  | 'formGone'
  | 'urlChanged'
  | 'url'
  | 'selector'
  | 'cookie'
  | 'storage'
  | 'fixed';

/**
 * 登录声明编辑器— 三层视图：简易 / 高级 / 原始 JSON。
 *
 * - 简易视图：`ops[]` 的投影，只读写 goto/fill/click 四个算子，其余算子
 *   原样保留（往返无损）；不满足简易形态时引导进高级视图。
 * - 高级视图：按算子注册表（SPEC_OP_OPTIONS + SPEC_OP_LABELS）渲染参数表单，
 *   可增删 / 上下移 / 复制 / 切换算子类型（保留定位与 frame）。
 * - JSON 视图：直接编辑，就地校验并把错误定位到算子下标。
 *
 * 保存由父组件（DomainsPanel）负责：这里只向外 emit `change`，并通过
 * `defineExpose` 暴露 `errors` / `invalid` 供父组件在保存前拦截（R1–R7）。
 */

const props = defineProps<{
  spec: LoginSpec;
  /** 目标环境的 origin（拾取 / 识别用于挑选标签页） */
  origin?: string;
  /** 旧配方被自动迁移时为 true，顶部展示提示 */
  migrated?: boolean;
}>();

const emit = defineEmits<{ change: [spec: LoginSpec] }>();

// ============================================================
// 内部可变状态
// ============================================================

const ops = ref<SpecOp[]>(cloneSpecOps(props.spec.ops));
const vars = ref<SpecVarEdit[]>(specVarsToEdit(props.spec));
const aux = ref<SpecAuxEdit>(specAuxToEdit(props.spec));
const showVars = ref(false);
const jsonText = ref('');
const jsonError = ref('');

/** 简易 / 高级 / JSON 视图切换；只显式由用户触发，绝不自动回落 */
const mode = ref<'simple' | 'advanced' | 'json'>(
  simpleSpecShape(props.spec) ? 'simple' : 'advanced',
);

/** 简易形态的算子下标（指向原始 ops 数组）；漂移时为 null */
const simpleShape = computed(() => simpleSpecShape(currentSpec.value));

const selectedOp = ref<number | null>(null);
const pickerCandidates = ref<Record<number, TargetCandidate[]>>({});
function candidatesOf(index: number): TargetCandidate[] {
  return pickerCandidates.value[index] ?? [];
}

// ============================================================
// 组合当前 spec（单一事实源 = ops + vars + aux）
// ============================================================

const currentSpec = computed<LoginSpec>(() => {
  const variableList = specsVariables(vars.value);
  return {
    ...props.spec,
    ops: ops.value,
    ...(variableList.length > 0 ? { vars: variableList } : {}),
    ...(aux.value.nonce || aux.value.timestamp
      ? { aux: specsAux(aux.value) }
      : {}),
  };
});

/** 最近一次向外发出的值（序列化比较，防回写死循环） */
let lastEmitted = '';
watch(
  currentSpec,
  (value) => {
    const serialized = JSON.stringify(value);
    if (serialized === lastEmitted) return;
    lastEmitted = serialized;
    emit('change', value);
  },
  { deep: true },
);

watch(
  () => props.spec,
  (next) => {
    if (JSON.stringify(next) === lastEmitted) return;
    ops.value = cloneSpecOps(next.ops);
    vars.value = specVarsToEdit(next);
    aux.value = specAuxToEdit(next);
    selectedOp.value = null;
    mode.value = simpleSpecShape(next) ? 'simple' : 'advanced';
  },
  { deep: true },
);

// ============================================================
// 校验错误（R1–R7，定位到算子）
// ============================================================

const specIssues = computed(() => validateLoginSpec(currentSpec.value));
const errors = computed(() => bucketSpecErrors(specIssues.value));
const invalid = computed(() => hasSpecErrors(errors.value));

// ============================================================
// JSON 视图
// ============================================================

function syncJson(): void {
  jsonText.value = JSON.stringify(currentSpec.value, null, 2);
}
watch(
  mode,
  (m) => {
    if (m === 'json') syncJson();
  },
  { immediate: true },
);

function onJsonInput(text: string): void {
  jsonText.value = text;
  jsonError.value = '';
  try {
    const parsed = JSON.parse(text);
    const merged: LoginSpec = {
      ...currentSpec.value,
      ...parsed,
      ops: Array.isArray(parsed?.ops) ? parsed.ops : currentSpec.value.ops,
    };
    emit('change', merged);
  } catch (e) {
    jsonError.value = e instanceof Error ? e.message : String(e);
  }
}

// ============================================================
// 识别登录表单（ADR-0013 D8，算子回填）
// ============================================================

const scanning = ref(false);
const scanFrames = ref<FormScanFrame[]>([]);
const scanChoice = ref(0);
const scanNotice = ref<string | null>(null);

const scanFrame = computed<FormScanFrame | null>(
  () => scanFrames.value[scanChoice.value] ?? null,
);

function sameOriginForScan(url: string | undefined, origin: string): boolean {
  if (!url) return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

async function runScan(): Promise<void> {
  if (scanning.value) return;
  scanning.value = true;
  scanNotice.value = null;
  scanFrames.value = [];
  scanChoice.value = 0;
  try {
    const own = await chrome.tabs.getCurrent().catch(() => undefined);
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const origin = props.origin;
    const ranked = rankPickerTabs(tabs, origin, own?.id);
    const candidate = origin
      ? ranked.find((t) => sameOriginForScan(t.url, origin))
      : ranked[0];
    if (!candidate || candidate.id === undefined) {
      scanNotice.value = origin
        ? `没有打开 ${origin} 的标签页：请先打开该环境的页面，再识别登录表单`
        : '没有可用于识别的网页标签页，请先打开目标登录页';
      return;
    }
    const res = await sendBgMessage('SCAN_LOGIN_FORM', {
      tabId: candidate.id,
      origin: props.origin ?? '',
    });
    if (!res.success) {
      scanNotice.value = res.error ?? SCAN_ERROR_TEXT.INJECT_FAILED;
      return;
    }
    scanFrames.value = res.frames;
    if (res.frames.length === 0) {
      scanNotice.value = '在环境页面上未找到标准登录表单，请手动拾取或直接填写';
    }
  } catch (e: unknown) {
    scanNotice.value = e instanceof Error ? e.message : String(e);
  } finally {
    scanning.value = false;
  }
}

function closeScan(): void {
  scanFrames.value = [];
  scanChoice.value = 0;
  scanNotice.value = null;
}

/**
 * 把识别结果回填成算子：保留首个 goto，表单算子（fill/fill/click）落到
 * 命中的 frame（子 frame 才记录 frameId / frameUrl）。其余算子按语义重排：
 * 清理类（clear.*）放最前、写入类（auth.*）放最后——否则旧会话会让
 * goto /login 被重定向回主页，fill 找不到输入框。未识别到的项留空，
 * 由用户补拾取。
 */
function applyScan(): void {
  const frame = scanFrame.value;
  if (!frame) return;
  const scope =
    frame.frameId !== undefined && frame.frameId !== 0
      ? {
          frameId: frame.frameId,
          ...(frame.frameUrl ? { frameUrl: frame.frameUrl } : {}),
        }
      : {};
  const formOps: SpecOp[] = [
    { op: 'fill', target: frame.username?.target ?? '', value: '{username}', ...scope },
    { op: 'fill', target: frame.password?.target ?? '', value: '{password}', ...scope },
    { op: 'click', target: frame.submit?.target ?? '', onNotFound: 'fail', ...scope },
  ];
  ops.value = reorderOpsAroundForm(ops.value, formOps);
  selectedOp.value = null;
  if (simpleSpecShape(currentSpec.value)) mode.value = 'simple';
  closeScan();
}

// ============================================================
// 简易视图读写（只碰 goto/fill/click）
// ============================================================

function update(index: number, patch: Record<string, unknown>): void {
  ops.value = updateSpecOp(ops.value, index, patch);
}

function setSimpleField(
  key: 'username' | 'password' | 'submit',
  target: Target,
): void {
  const shape = simpleShape.value;
  if (!shape) return;
  const index =
    key === 'username'
      ? shape.usernameIndex
      : key === 'password'
        ? shape.passwordIndex
        : shape.submitIndex;
  update(index, { target });
}

function simpleTarget(key: 'username' | 'password' | 'submit'): Target {
  const shape = simpleShape.value;
  if (!shape) return '';
  const index =
    key === 'username'
      ? shape.usernameIndex
      : key === 'password'
        ? shape.passwordIndex
        : shape.submitIndex;
  const op = ops.value[index];
  return op && (op.op === 'fill' || op.op === 'click') ? op.target : '';
}

function simpleLoginUrl(): string {
  const shape = simpleShape.value;
  const gi = shape?.gotoIndex;
  const goto = gi === undefined ? null : ops.value[gi];
  return goto?.op === 'goto' ? goto.url : '';
}

function simpleWaitForLoad(): boolean {
  const shape = simpleShape.value;
  const gi = shape?.gotoIndex;
  const goto = gi === undefined ? null : ops.value[gi];
  return goto?.op === 'goto' ? goto.waitForLoad !== false : false;
}

function setSimpleLoginUrl(url: string): void {
  const shape = simpleShape.value;
  if (!shape) return;
  const gotoIndex = ops.value.findIndex((o) => o.op === 'goto');
  if (!url.trim()) {
    if (gotoIndex >= 0) ops.value = removeSpecOp(ops.value, gotoIndex);
    return;
  }
  if (gotoIndex >= 0) {
    update(gotoIndex, { url });
    return;
  }
  ops.value = insertSpecOp(ops.value, gotoIndex, {
    op: 'goto',
    url,
    waitForLoad: false,
  });
}

function setSimpleWaitForLoad(checked: boolean): void {
  const shape = simpleShape.value;
  const gi = shape?.gotoIndex;
  if (gi === undefined) return;
  const current = ops.value[gi];
  if (current?.op !== 'goto') return;
  update(gi, { ...current, waitForLoad: checked });
}

// ============================================================
// 高级视图：算子增删 / 换序 / 复制 / 改类型
// ============================================================

function addOp(): void {
  const at = selectedOp.value ?? ops.value.length - 1;
  ops.value = insertSpecOp(ops.value, at, createSpecOp('fill'));
  selectedOp.value = at + 1;
}

function changeOp(index: number, op: SpecOpName): void {
  ops.value = ops.value.map((o, i) => (i === index ? changeSpecOp(o, op) : o));
}

function duplicateAt(index: number): void {
  ops.value = duplicateSpecOp(ops.value, index);
  selectedOp.value = index + 1;
}

function removeAt(index: number): void {
  ops.value = removeSpecOp(ops.value, index);
  selectedOp.value = null;
}

function moveAt(index: number, delta: -1 | 1): void {
  ops.value = moveSpecOp(ops.value, index, delta);
  selectedOp.value = null;
}

function selectOp(index: number): void {
  selectedOp.value = selectedOp.value === index ? null : index;
}

// ============================================================
// 参数表单：按算子类型分发
// ============================================================

function targetOf(op: SpecOp): Target {
  if ((op.op === 'fill' || op.op === 'click') && op.target !== undefined) {
    return op.target;
  }
  if (op.op === 'waitFor' && op.when.type === 'selector') return op.when.target;
  if (op.op === 'extract' && op.source === 'dom') {
    return (op.key ?? '') as unknown as Target;
  }
  return '';
}

function setTarget(index: number, target: Target): void {
  const op = ops.value[index];
  if (!op) return;
  if (op.op === 'fill' || op.op === 'click') {
    update(index, { target });
  } else if (op.op === 'waitFor' && op.when.type === 'selector') {
    update(index, { when: { ...op.when, target } });
  } else if (op.op === 'extract' && op.source === 'dom') {
    const key = typeof target === 'string' ? target : 'css' in target ? target.css : String(target);
    update(index, { key });
  }
}

// ============================================================
// 变量胶囊（fill 的 value 输入）
// ============================================================

/** waitFor 的 kind 切换：selector 需先有 target 才能进入 TargetField */
function setWaitKind(index: number, kind: SettleKindValue): void {
  const op = ops.value[index];
  if (op?.op !== 'waitFor') return;
  const schemes: Record<string, SpecOp> = {
    formGone: { op: 'waitFor', when: { type: 'formGone' } },
    urlChanged: { op: 'waitFor', when: { type: 'urlChanged' } },
    url: { op: 'waitFor', when: { type: 'url', glob: '' } },
    selector: { op: 'waitFor', when: { type: 'selector', target: '' } },
    cookie: { op: 'waitFor', when: { type: 'cookie', name: '' } },
    storage: { op: 'waitFor', when: { type: 'storage', area: 'local', key: '' } },
    fixed: { op: 'waitFor', when: { type: 'fixed', ms: 1000 } },
  };
  ops.value = ops.value.map((o, i) => (i === index ? schemes[kind] : o));
}

function insertVar(index: number, token: string): void {
  const op = ops.value[index];
  if (op?.op === 'fill') update(index, { value: (op.value || '') + token });
}

/** 拾取成功：缓存候选（供候选胶囊渲染），并在 fill 值为空时建议变量 */
function onPicked(
  index: number,
  payload: { meta?: { tag: string; type?: string }; candidates: TargetCandidate[] },
): void {
  pickerCandidates.value = { ...pickerCandidates.value, [index]: payload.candidates };
  const op = ops.value[index];
  if (op?.op === 'fill' && !(op.value ?? '').trim()) {
    const others = ops.value
      .filter((o, i) => i !== index && o.op === 'fill')
      .map((o) => (o.op === 'fill' ? o.value : ''));
    const used = { username: false, password: false };
    for (const v of others) {
      if (v.includes('{username}')) used.username = true;
      if (v.includes('{password}')) used.password = true;
    }
    let suggested: string | null = null;
    const meta = payload.meta;
    if (meta?.type === 'password') suggested = '{password}';
    else if (meta && (meta.tag === 'input' || meta.tag === 'textarea') && !used.username) {
      suggested = '{username}';
    }
    if (suggested) update(index, { value: suggested });
  }
}

// 简易视图三行定位的错误
function simpleError(key: 'username' | 'password' | 'submit'): string[] {
  const shape = simpleShape.value;
  if (!shape) return [];
  const index =
    key === 'username'
      ? shape.usernameIndex
      : key === 'password'
        ? shape.passwordIndex
        : shape.submitIndex;
  return errors.value.ops[index] ?? [];
}

defineExpose({ errors, invalid, spec: currentSpec });
</script>

<template>
  <div class="spec-editor">
    <p v-if="migrated" class="spec-notice">
      <span class="i-lucide-wand-2 w-4 h-4" />已自动转换：旧的配方 / 扁平参数已迁移为登录声明。
    </p>

    <div v-if="errors.general.length > 0" class="spec-general-errors">
      <p v-for="(message, i) in errors.general" :key="i" class="field-error">
        <span class="i-lucide-alert-circle w-3.5 h-3.5" />{{ message }}
      </p>
    </div>

    <div class="scan-bar">
      <DtButton size="sm" :disabled="scanning" @click="runScan">
        <div class="i-lucide-scan-search w-3.5 h-3.5 mr-1" />
        {{ scanning ? '识别中…' : '识别环境页面上的登录表单' }}
      </DtButton>
      <span class="scan-hint">扫描环境 URL 所在标签页（只读，不点击、不提交）</span>
    </div>

    <p v-if="scanNotice" class="scan-warn">
      <span class="i-lucide-alert-triangle w-3.5 h-3.5" />{{ scanNotice }}
      <button type="button" class="scan-dismiss" @click="closeScan">关闭</button>
    </p>

    <div v-if="scanFrame" class="scan-card">
      <div class="scan-head">
        <span class="i-lucide-clipboard-check w-4 h-4" />识别结果
        <span v-if="scanFrames.length > 1" class="optional">（命中 {{ scanFrames.length }} 个 frame）</span>
      </div>
      <label v-for="(f, i) in scanFrames" :key="`${f.frameId}-${i}`" class="scan-frame-option">
        <input v-model="scanChoice" type="radio" :value="i" />
        <span>{{ f.frameId === 0 ? '主页面' : `frame #${f.frameId}` }} · {{ f.frameUrl || '未知地址' }}</span>
      </label>
      <div class="scan-actions">
        <DtButton variant="primary" @click="applyScan">
          <div class="i-lucide-check w-3.5 h-3.5 mr-1" />回填算子
        </DtButton>
        <DtButton size="sm" @click="closeScan">取消</DtButton>
      </div>
    </div>

    <!-- 视图切换 -->
    <div class="editor-view-tabs">
      <button
        v-for="v in (['simple', 'advanced', 'json'] as const)"
        :key="v"
        type="button"
        class="view-tab"
        :class="{ active: mode === v }"
        :disabled="v === 'simple' && !simpleShape"
        @click="mode = v"
      >
        {{ v === 'simple' ? '简易' : v === 'advanced' ? '高级' : 'JSON' }}
      </button>
    </div>

    <!-- ================= 简易视图 ================= -->
    <div v-if="mode === 'simple'">
      <div v-if="!simpleShape" class="scan-warn">
        当前声明不再是标准三步登录，已无法用简易模式表达，请编辑高级视图。
      </div>
      <div v-else class="simple-form">
        <div class="simple-row">
          <span class="simple-label">登录页</span>
          <input
            class="dt-input"
            :value="simpleLoginUrl()"
            placeholder="留空表示不导航, 例: {origin}/login"
            @input="setSimpleLoginUrl(($event.target as HTMLInputElement).value)"
          />
        </div>
        <label v-if="simpleLoginUrl()" class="inline-check">
          <input type="checkbox" :checked="simpleWaitForLoad()" @change="setSimpleWaitForLoad(($event.target as HTMLInputElement).checked)" />
          等待页面加载完成
        </label>
        <div class="simple-row">
          <span class="simple-label">用户名</span>
          <TargetField
            :model-value="simpleTarget('username')"
            context="fill"
            :origin="origin"
            placeholder="用户名输入框, 如 #username"
            @update:model-value="setSimpleField('username', $event)"
          />
          <span class="simple-token">{username}</span>
        </div>
        <p v-for="(message, mi) in simpleError('username')" :key="mi" class="field-error">
          <span class="i-lucide-alert-circle w-3.5 h-3.5" />{{ message }}
        </p>
        <div class="simple-row">
          <span class="simple-label">密码</span>
          <TargetField
            :model-value="simpleTarget('password')"
            context="fill"
            :origin="origin"
            placeholder="密码输入框, 如 #password"
            @update:model-value="setSimpleField('password', $event)"
          />
          <span class="simple-token">{password}</span>
        </div>
        <p v-for="(message, mi) in simpleError('password')" :key="mi" class="field-error">
          <span class="i-lucide-alert-circle w-3.5 h-3.5" />{{ message }}
        </p>
        <div class="simple-row">
          <span class="simple-label">登录</span>
          <TargetField
            :model-value="simpleTarget('submit')"
            context="click"
            :origin="origin"
            placeholder="登录按钮, 如 button[type=submit]"
            @update:model-value="setSimpleField('submit', $event)"
          />
        </div>
        <p v-for="(message, mi) in simpleError('submit')" :key="mi" class="field-error">
          <span class="i-lucide-alert-circle w-3.5 h-3.5" />{{ message }}
        </p>
      </div>
    </div>

    <!-- ================= 高级视图 ================= -->
    <template v-else-if="mode === 'advanced'">
      <div class="op-list">
        <div
          v-for="(op, index) in ops"
          :key="index"
          class="op-item"
          :class="{ 'op-invalid': errors.ops[index], 'op-selected': selectedOp === index }"
          @click.self="selectOp(index)"
        >
          <div class="op-head" @click.self="selectOp(index)">
            <button type="button" class="op-index" @click.stop="selectOp(index)">
              {{ index + 1 }}
            </button>
            <select
              class="dt-input op-sel"
              :value="op.op"
              @change="changeOp(index, ($event.target as HTMLSelectElement).value as SpecOpName)"
            >
              <option v-for="opt in SPEC_OP_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
            <div class="op-actions">
              <button type="button" class="icon-btn" title="复制" @click="duplicateAt(index)">
                <div class="i-lucide-copy w-3.5 h-3.5" />
              </button>
              <button type="button" class="icon-btn" title="上移" :disabled="index === 0" @click="moveAt(index, -1)">
                <div class="i-lucide-arrow-up w-3.5 h-3.5" />
              </button>
              <button type="button" class="icon-btn" title="下移" :disabled="index === ops.length - 1" @click="moveAt(index, 1)">
                <div class="i-lucide-arrow-down w-3.5 h-3.5" />
              </button>
              <button type="button" class="icon-btn icon-btn-danger" title="删除" @click="removeAt(index)">
                <div class="i-lucide-trash-2 w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div class="op-body">
            <div v-if="op.op === 'clear.cookies'" class="op-grid">
              <label class="op-field">
                <span>范围</span>
                <select class="dt-input" :value="op.range" @change="update(index, { range: ($event.target as HTMLSelectElement).value })">
                  <option value="all">全部</option>
                  <option value="none">不清</option>
                </select>
              </label>
            </div>

            <div v-else-if="op.op === 'clear.storage'" class="op-grid">
              <label class="op-field">
                <span>区域</span>
                <select class="dt-input" :value="op.area" @change="update(index, { area: ($event.target as HTMLSelectElement).value })">
                  <option value="local">localStorage</option>
                  <option value="session">sessionStorage</option>
                </select>
              </label>
              <label class="op-field">
                <span>范围</span>
                <select class="dt-input" :value="op.range" @change="update(index, { range: ($event.target as HTMLSelectElement).value })">
                  <option value="all">全部</option>
                  <option value="none">不清</option>
                </select>
              </label>
            </div>

            <div v-else-if="op.op === 'goto'" class="op-column">
              <input class="dt-input" :value="op.url" placeholder="例: {origin}/login" @input="update(index, { url: ($event.target as HTMLInputElement).value })" />
            </div>

            <div v-else-if="op.op === 'fill'" class="op-column">
              <TargetField
                :model-value="targetOf(op)"
                context="fill"
                :origin="origin"
                placeholder="例: #username 或 用户名"
                :candidates="candidatesOf(index)"
                @update:model-value="setTarget(index, $event)"
                @update:frame-scope="update(index, $event)"
                @picked="onPicked(index, $event)"
              />
              <input class="dt-input" :value="op.value" placeholder="填充值，支持变量（见下方胶囊）" @input="update(index, { value: ($event.target as HTMLInputElement).value })" />
              <div class="variable-row">
                <span class="variable-label">插入变量</span>
                <button v-for="hint in specInputHints(currentSpec)" :key="hint.token" type="button" class="variable-pill" :title="hint.label" @click="insertVar(index, hint.token)">
                  {{ hint.token }}
                </button>
              </div>
            </div>

            <div v-else-if="op.op === 'click'" class="op-column">
              <TargetField
                :model-value="targetOf(op)"
                context="click"
                :origin="origin"
                placeholder="例: button[type=submit] 或 登录"
                :candidates="candidatesOf(index)"
                @update:model-value="setTarget(index, $event)"
                @update:frame-scope="update(index, $event)"
                @picked="onPicked(index, $event)"
              />
              <label class="inline-check">
                <input type="checkbox" :checked="op.onNotFound === 'skip'" @change="update(index, { onNotFound: ($event.target as HTMLInputElement).checked ? 'skip' : 'fail' })" />
                未找到时跳过
              </label>
            </div>

            <div v-else-if="op.op === 'waitFor'" class="op-column">
              <div class="op-grid">
                <select
                  class="dt-input op-field"
                  :value="op.when.type"
                  @change="setWaitKind(index, ($event.target as HTMLSelectElement).value as SettleKindValue)"
                >
                  <option value="formGone">登录表单消失</option>
                  <option value="urlChanged">URL 变化</option>
                  <option value="url">URL 通配符</option>
                  <option value="selector">元素出现</option>
                  <option value="cookie">Cookie 存在</option>
                  <option value="storage">存储键存在</option>
                  <option value="fixed">固定等待（毫秒）</option>
                </select>
              </div>
              <TargetField
                v-if="op.when.type === 'selector'"
                :model-value="targetOf(op)"
                context="locate"
                :origin="origin"
                placeholder="例: .welcome 或 已登录"
                @update:model-value="setTarget(index, $event)"
              />
              <input
                v-else-if="op.when.type === 'url'"
                class="dt-input"
                :value="op.when.glob"
                placeholder="URL 通配符，如 /welcome*"
                @input="update(index, { when: { type: 'url', glob: ($event.target as HTMLInputElement).value } })"
              />
              <input
                v-else-if="op.when.type === 'cookie'"
                class="dt-input"
                :value="op.when.name"
                placeholder="Cookie 名"
                @input="update(index, { when: { type: 'cookie', name: ($event.target as HTMLInputElement).value } })"
              />
              <div v-else-if="op.when.type === 'storage'" class="op-grid">
                <select class="dt-input op-field" :value="op.when.area" @change="update(index, { when: { type: 'storage', area: ($event.target as HTMLSelectElement).value, key: op.when.key } })">
                  <option value="local">localStorage</option>
                  <option value="session">sessionStorage</option>
                </select>
                <input class="dt-input" :value="op.when.key" placeholder="存储键" @input="update(index, { when: { type: 'storage', area: op.when.area, key: ($event.target as HTMLInputElement).value } })" />
              </div>
              <input
                v-else-if="op.when.type === 'fixed'"
                class="dt-input"
                :value="String(op.when.ms)"
                placeholder="毫秒数"
                @input="update(index, { when: { type: 'fixed', ms: Number(($event.target as HTMLInputElement).value) } })"
              />
            </div>

            <div v-else-if="op.op === 'http.execute'" class="op-column">
              <input class="dt-input" :value="op.url" placeholder="请求 URL, 例: {origin}/login" @input="update(index, { url: ($event.target as HTMLInputElement).value })" />
              <div class="op-grid">
                <label class="op-field">
                  <span>方法</span>
                  <select class="dt-input" :value="op.method ?? 'GET'" @change="update(index, { method: ($event.target as HTMLSelectElement).value })">
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                    <option value="PUT">PUT</option>
                    <option value="DELETE">DELETE</option>
                    <option value="PATCH">PATCH</option>
                  </select>
                </label>
                <label class="op-field">
                  <span>输出变量</span>
                  <input class="dt-input" :value="op.as" placeholder="如 resp" @input="update(index, { as: ($event.target as HTMLInputElement).value })" />
                </label>
              </div>
            </div>

            <div v-else-if="op.op === 'digest'" class="op-grid">
              <label class="op-field"><span>输入</span><input class="dt-input" :value="op.input" @input="update(index, { input: ($event.target as HTMLInputElement).value })" /></label>
              <label class="op-field"><span>输出变量</span><input class="dt-input" :value="op.as" @input="update(index, { as: ($event.target as HTMLInputElement).value })" /></label>
            </div>

            <div v-else-if="op.op === 'crypto.encrypt'" class="op-grid">
              <label class="op-field"><span>公钥</span><input class="dt-input" :value="op.publicKey" @input="update(index, { publicKey: ($event.target as HTMLInputElement).value })" /></label>
              <label class="op-field"><span>输入</span><input class="dt-input" :value="op.input" @input="update(index, { input: ($event.target as HTMLInputElement).value })" /></label>
              <label class="op-field"><span>输出变量</span><input class="dt-input" :value="op.as" @input="update(index, { as: ($event.target as HTMLInputElement).value })" /></label>
            </div>

            <div v-else-if="op.op === 'payload.build'" class="op-column">
              <label class="op-field"><span>输出变量</span><input class="dt-input" :value="op.as" @input="update(index, { as: ($event.target as HTMLInputElement).value })" /></label>
              <div v-for="(part, pi) in op.parts" :key="pi" class="op-field">
                <span>{{ (part.key ? part.key + ' = ' : '') + part.value }}</span>
              </div>
            </div>

            <div v-else-if="op.op === 'map'" class="op-grid">
              <label class="op-field"><span>输入</span><input class="dt-input" :value="op.input" @input="update(index, { input: ($event.target as HTMLInputElement).value })" /></label>
              <label class="op-field"><span>输出变量</span><input class="dt-input" :value="op.as" @input="update(index, { as: ($event.target as HTMLInputElement).value })" /></label>
            </div>

            <div v-else-if="op.op === 'apply.set'" class="op-grid">
              <label class="op-field">
                <span>位置</span>
                <select class="dt-input" :value="op.target" @change="update(index, { target: ($event.target as HTMLSelectElement).value })">
                  <option value="header">请求头</option>
                  <option value="body">请求体</option>
                  <option value="query">查询串</option>
                </select>
              </label>
              <label class="op-field"><span>键/名</span><input class="dt-input" :value="op.key" @input="update(index, { key: ($event.target as HTMLInputElement).value })" /></label>
              <label class="op-field"><span>值</span><input class="dt-input" :value="op.value" @input="update(index, { value: ($event.target as HTMLInputElement).value })" /></label>
            </div>

            <div v-else-if="op.op === 'extract'" class="op-grid">
              <label class="op-field">
                <span>来源</span>
                <select class="dt-input" :value="op.source" @change="update(index, { source: ($event.target as HTMLSelectElement).value, ...(op.source === 'url' && op.as === 'extract' ? {} : {}) })">
                  <option value="local">localStorage</option>
                  <option value="session">sessionStorage</option>
                  <option value="dom">DOM</option>
                  <option value="url">URL</option>
                  <option value="cookie">Cookie</option>
                </select>
              </label>
              <TargetField
                v-if="op.source === 'dom'"
                :model-value="targetOf(op)"
                context="locate"
                :origin="origin"
                placeholder="选择器, 如 .token"
                @update:model-value="setTarget(index, $event)"
              />
              <label v-else class="op-field"><span>键</span><input class="dt-input" :value="op.key ?? ''" @input="update(index, { key: ($event.target as HTMLInputElement).value })" /></label>
              <label class="op-field"><span>变量名</span><input class="dt-input" :value="op.as" @input="update(index, { as: ($event.target as HTMLInputElement).value })" /></label>
            </div>

            <div v-else-if="op.op === 'auth.write'" class="op-note">
              <span class="i-lucide-info w-3.5 h-3.5" />按认证声明写会话（cookie / storage）。
            </div>
            <div v-else-if="op.op === 'auth.capture'" class="op-grid">
              <label class="op-field"><span>输出变量</span><input class="dt-input" :value="op.as" @input="update(index, { as: ($event.target as HTMLInputElement).value })" /></label>
            </div>
            <div v-else-if="op.op === 'auth.restore'" class="op-grid">
              <label class="op-field"><span>快照</span><input class="dt-input" :value="op.snapshot" @input="update(index, { snapshot: ($event.target as HTMLInputElement).value })" /></label>
            </div>

            <div v-else-if="op.op === 'script'" class="op-column">
              <textarea class="dt-input strategy-textarea" rows="3" spellcheck="false" :value="op.code" placeholder="(bindings) => { … } 页面内执行的 JS" @input="update(index, { code: ($event.target as HTMLTextAreaElement).value })" />
              <label class="op-field"><span>输出变量</span><input class="dt-input" :value="op.as" @input="update(index, { as: ($event.target as HTMLInputElement).value })" /></label>
            </div>

            <div v-else class="op-note">
              <span class="i-lucide-info w-3.5 h-3.5" />该算子的完整参数请在 JSON 视图中编辑。
            </div>
          </div>

          <p v-for="(message, mi) in errors.ops[index] ?? []" :key="mi" class="field-error">
            <span class="i-lucide-alert-circle w-3.5 h-3.5" />{{ message }}
          </p>
        </div>
      </div>

      <div class="op-toolbar">
        <DtButton size="sm" @click="addOp">
          <div class="i-lucide-plus w-3.5 h-3.5 mr-1" />添加算子
        </DtButton>
        <span v-if="selectedOp !== null" class="selection-hint">新算子将插入到第 {{ selectedOp + 1 }} 行下方</span>
      </div>

      <!-- vars / aux 声明 -->
      <div class="vars-section">
        <button type="button" class="advanced-toggle-btn" @click="showVars = !showVars">
          <div :class="showVars ? 'i-lucide-chevron-down w-4 h-4' : 'i-lucide-chevron-right w-4 h-4'" />
          <span>自定义变量</span>
          <span class="optional">（声明后即可在任意引用处被保存期检查）</span>
        </button>
        <div v-show="showVars" class="advanced-content">
          <div v-for="(v, vi) in vars" :key="vi" class="var-row">
            <input class="dt-input" :value="v.name" placeholder="变量名，如 publicKey" @input="vars[vi].name = ($event.target as HTMLInputElement).value" />
            <input class="dt-input" :value="v.title" placeholder="说明" @input="vars[vi].title = ($event.target as HTMLInputElement).value" />
            <input class="dt-input" :value="v.default" placeholder="非敏感默认值" @input="vars[vi].default = ($event.target as HTMLInputElement).value" />
            <button type="button" class="icon-btn icon-btn-danger" title="删除变量" @click="vars.splice(vi, 1)">
              <div class="i-lucide-trash-2 w-3.5 h-3.5" />
            </button>
          </div>
          <DtButton size="sm" @click="vars = [...vars, { name: '', title: '', default: '' }]">
            <div class="i-lucide-plus w-3.5 h-3.5 mr-1" />添加变量
          </DtButton>
          <div class="aux-row">
            <label class="inline-check"><input type="checkbox" v-model="aux.nonce" /> 自动生成 nonce</label>
            <label class="inline-check"><input type="checkbox" v-model="aux.timestamp" /> 自动生成 timestamp</label>
          </div>
        </div>
      </div>
    </template>

    <!-- ================= JSON 视图 ================= -->
    <div v-else-if="mode === 'json'" class="json-mode">
      <p class="json-hint">原始 JSON 登录声明。保存时执行 R1–R7 校验，错误就地展示。</p>
      <textarea class="json-textarea" :value="jsonText" rows="14" spellcheck="false" @input="onJsonInput(($event.target as HTMLTextAreaElement).value)" />
      <p v-if="jsonError" class="field-error">
        <span class="i-lucide-alert-circle w-3.5 h-3.5" />{{ jsonError }}
      </p>
      <div v-if="Object.keys(errors.ops).length > 0" class="json-issues">
        <p v-for="(msgs, idx) in errors.ops" :key="idx" class="field-error">
          <span class="i-lucide-alert-circle w-3.5 h-3.5" />第 {{ Number(idx) + 1 }} 步：{{ msgs.join('；') }}
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
@import '../../../shared/component-styles.scss';
@import './config-panel-shared.scss';

.spec-editor { display: flex; flex-direction: column; gap: 10px; }
.spec-notice { display: flex; align-items: center; gap: 6px; padding: 8px 12px; border-radius: 8px; background: rgba(99,102,241,.06); border: 1px solid rgba(99,102,241,.16); font-size: 12px; color: #4f46e5; }
[data-dt-dark] .spec-notice { background: rgba(99,102,241,.12); border-color: rgba(99,102,241,.3); color: #93c5fd; }

.spec-general-errors { display: flex; flex-direction: column; gap: 2px; }

.editor-view-tabs { display: flex; gap: 6px; }
.view-tab { padding: 4px 14px; border: 1px solid #e2e8f0; border-radius: 9999px; background: #fff; font-size: 12px; color: #64748b; cursor: pointer; transition: all .15s ease-out; }
.view-tab:hover { border-color: #93c5fd; color: #3b82f6; }
.view-tab.active { background: linear-gradient(135deg,#6366f1,#3b82f6); border-color: transparent; color: #fff; }
.view-tab:disabled { opacity: .45; cursor: not-allowed; }
[data-dt-dark] .view-tab { background: var(--dt-dark-surface-1); border-color: var(--dt-dark-border); color: #8b949e; }

.simple-form { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 1px solid #e2e8f0; border-radius: 10px; background: #fff; }
[data-dt-dark] .simple-form { background: var(--dt-dark-surface-1); border-color: var(--dt-dark-border); }
.simple-row { display: flex; align-items: center; gap: 8px; }
.simple-label { width: 52px; flex-shrink: 0; font-size: 12px; color: #64748b; }
[data-dt-dark] .simple-label { color: #8b949e; }
.simple-token { flex-shrink: 0; padding: 2px 8px; border-radius: 9999px; background: rgba(99,102,241,.08); font-family: var(--font-mono); font-size: 12px; color: #4f46e5; }
[data-dt-dark] .simple-token { background: rgba(99,102,241,.16); color: #93c5fd; }
.inline-check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #64748b; cursor: pointer; }
[data-dt-dark] .inline-check { color: #8b949e; }

.op-list { display: flex; flex-direction: column; gap: 8px; }
.op-item { padding: 10px 12px; border: 1px solid #e2e8f0; border-radius: 10px; background: #fff; }
[data-dt-dark] .op-item { background: var(--dt-dark-surface-1); border-color: var(--dt-dark-border); }
.op-item.op-invalid { border-color: #fecaca; }
[data-dt-dark] .op-item.op-invalid { border-color: #7f1d1d; }
.op-item.op-selected { border-color: #818cf8; }
.op-head { display: flex; align-items: center; gap: 8px; }
.op-index { width: 20px; height: 20px; border: none; border-radius: 9999px; background: linear-gradient(135deg,#6366f1,#3b82f6); color: #fff; font-size: 12px; font-weight: 600; cursor: pointer; }
.op-sel { flex: 1; max-width: 220px; }
.op-actions { display: flex; gap: 4px; margin-left: auto; }
.icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border: 1px solid #e2e8f0; border-radius: 6px; background: #fff; color: #64748b; cursor: pointer; transition: all .15s ease-out; }
.icon-btn:hover:not(:disabled) { border-color: #93c5fd; color: #3b82f6; }
.icon-btn:disabled { opacity: .4; cursor: not-allowed; }
.icon-btn-danger:hover:not(:disabled) { color: #dc2626; border-color: #fecaca; }
[data-dt-dark] .icon-btn { background: var(--dt-dark-surface-hover); border-color: var(--dt-dark-border); color: #8b949e; }
.op-body { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.op-grid { display: flex; gap: 8px; flex-wrap: wrap; }
.op-column { display: flex; flex-direction: column; gap: 6px; }
.op-field { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: #94a3b8; flex: 1; min-width: 140px; }
.op-field input, .op-field select { width: 100%; box-sizing: border-box; }
.op-note { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #64748b; }
.op-toolbar { display: flex; gap: 8px; }
.selection-hint { align-self: center; font-size: 12px; color: #4f46e5; }
.variable-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.variable-label { font-size: 12px; color: #94a3b8; }
.variable-pill { padding: 1px 8px; border: 1px solid #e2e8f0; border-radius: 9999px; background: #fff; font-family: var(--font-mono); font-size: 12px; color: #475569; cursor: pointer; transition: all .15s ease-out; }
.variable-pill:hover { border-color: #93c5fd; color: #3b82f6; }
[data-dt-dark] .variable-pill { background: var(--dt-dark-surface-hover); border-color: var(--dt-dark-border); color: #cbd5e1; }
.field-error { display: flex; align-items: center; gap: 4px; margin-top: 4px; font-size: 12px; color: #dc2626; }
[data-dt-dark] .field-error { color: #f87171; }
.scan-warn { margin: 0; font-size: 12px; color: #b45309; }

.vars-section { border-top: 1px solid #e2e8f0; padding-top: 10px; }
[data-dt-dark] .vars-section { border-top-color: var(--dt-dark-border); }
.advanced-toggle-btn { display: flex; align-items: center; gap: 6px; width: 100%; padding: 8px 12px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; color: #64748b; }
[data-dt-dark] .advanced-toggle-btn { background: var(--dt-dark-surface-hover); border-color: var(--dt-dark-border); color: #8b949e; }
.advanced-content { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
.var-row { display: flex; gap: 6px; align-items: center; }
.aux-row { display: flex; gap: 12px; flex-wrap: wrap; }
.optional { font-size: 12px; color: #94a3b8; font-weight: normal; }

.json-mode { display: flex; flex-direction: column; gap: 8px; }
.json-hint { font-size: 12px; color: #94a3b8; margin: 0; }
.json-textarea { width: 100%; box-sizing: border-box; font-family: var(--font-mono); font-size: 12px; padding: 14px; border: 1px solid #e2e8f0; border-radius: 8px; background: #fff; color: #0f172a; resize: vertical; line-height: 1.6; }
[data-dt-dark] .json-textarea { background: var(--dt-dark-base); color: #f0f6fc; border-color: var(--dt-dark-border); }
.json-issues { display: flex; flex-direction: column; gap: 2px; }

.scan-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.scan-hint { font-size: 12px; color: #94a3b8; }
[data-dt-dark] .scan-hint { color: #64748b; }
.scan-dismiss { margin-left: auto; border: none; background: transparent; padding: 0; font-size: 12px; color: inherit; opacity: .75; cursor: pointer; }
.scan-dismiss:hover { opacity: 1; text-decoration: underline; }
.scan-card { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 1px solid rgba(99,102,241,.28); border-radius: 10px; background: rgba(99,102,241,.05); }
[data-dt-dark] .scan-card { background: rgba(99,102,241,.1); border-color: rgba(99,102,241,.35); }
.scan-head { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; color: #4f46e5; }
[data-dt-dark] .scan-head { color: #93c5fd; }
.scan-frame-option { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #475569; cursor: pointer; }
[data-dt-dark] .scan-frame-option { color: #cbd5e1; }
.scan-actions { display: flex; gap: 8px; }
</style>