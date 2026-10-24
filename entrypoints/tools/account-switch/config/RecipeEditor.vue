<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type {
  Recipe,
  RecipeStep,
  SettleCondition,
  Target,
} from '../strategies/generic-recipe';
import {
  authToForm,
  changeStepOp,
  cloneSteps,
  collectRecipeErrors,
  createStep,
  describeSettle,
  describeTargetForUi,
  duplicateStep,
  formToAuth,
  formToSettle,
  fromSimpleForm,
  hasRecipeErrors,
  insertAtCursor,
  insertStep,
  moveStep,
  passwordPlaintextWarning,
  removeStep,
  settleToForm,
  simpleShapeOf,
  SETTLE_KIND_OPTIONS,
  STEP_OP_OPTIONS,
  suggestFillValue,
  toSimpleForm,
  VARIABLE_HINTS,
  type AuthForm,
  type RecipeEditorErrors,
  type SettleForm,
  type SettleKind,
  type SimpleForm,
} from './recipe-editor-model';
import TargetField from './TargetField.vue';
import DtButton from '../../../shared/components/DtButton.vue';
import { SCAN_ERROR_TEXT, type FormScanFrame } from './login-form-scan';
import { rankPickerTabs, type TargetCandidate } from './target-picker';
import { sendBgMessage } from '../../../shared/messages';
import type { DryRunStepResult } from '../strategies/generic-dry-run';

/**
 * 配方编辑器（ADR-0012 D1 / D2 / D4 / D6）
 *
 * 只负责编辑 `Recipe`；保存由父组件（DomainsPanel）负责。
 * - 步骤可增删、上下移动，每种 op 有独立表单
 * - 元素定位统一走 `TargetField`（ADR-0013 D5）：kind + value + 拾取 +
 *   候选胶囊 + 命中提示，覆盖 fill / click / waitFor / 成功失败判定 / extract
 * - 拾取后按元素类型建议填充值与类型警告（ADR-0013 D6）
 * - 成功判定 / 失败判定 / 认证规格收在折叠区
 * - 「试跑当前 tab」走 TEST_RECIPE（D13），逐行回填命中状态；
 *   每行可单独试跑（ADR-0013 D11），失败行就地「重新拾取」
 * - 切换 op 保留定位与 frame；新步骤插到选中行下方；可复制步骤（D12）
 * - 「识别环境页面上的登录表单」走 SCAN_LOGIN_FORM（ADR-0013 D8），确认后回填
 * - 简易 / 高级模式是 `steps` 的视图投影（ADR-0013 D9），值是变量胶囊插入的
 *   占位符（D10），不引入第二套数据
 */

const props = defineProps<{
  recipe: Recipe;
  /** 目标环境的 origin（拾取 / 试跑用于挑选标签页） */
  origin?: string;
  /** 旧扁平参数被自动转换时为 true，顶部展示提示 */
  migrated?: boolean;
}>();

const emit = defineEmits<{ change: [recipe: Recipe] }>();

const steps = ref<RecipeStep[]>(cloneSteps(props.recipe.steps));
const settleForm = ref<SettleForm>(settleToForm(props.recipe.settle));
const failForm = ref<SettleForm>(settleToForm(props.recipe.failWhen));
const authForm = ref<AuthForm>(authToForm(props.recipe.auth));

const showSettle = ref(false);
const showFail = ref(!!props.recipe.failWhen);
const showAuth = ref(props.recipe.auth.mode === 'snapshot');

/**
 * 最近一次拾取的候选（ADR-0013 D4），按 key 存放（步骤下标 / 判定字段名）。
 * 候选只有「刚拾取的那个元素」才有，步骤增删换序或重新载入配方后即失效。
 */
const pickerCandidates = ref<Record<string, TargetCandidate[]>>({});

function candidatesOf(key: string): TargetCandidate[] {
  return pickerCandidates.value[key] ?? [];
}

function rememberCandidates(key: string, candidates: TargetCandidate[]): void {
  pickerCandidates.value = { ...pickerCandidates.value, [key]: candidates };
}

const dryRunning = ref(false);
const dryRunSteps = ref<DryRunStepResult[]>([]);
const dryRunError = ref<string | null>(null);
/** 当前正在试跑的范围：整条 or 单步下标（ADR-0013 D11） */
const dryRunScope = ref<'all' | number>('all');
/** 一次性提示（如单步试跑 goto 会真实导航） */
const dryRunNotice = ref<string | null>(null);

/** 试跑结果计数：命中 / 跳过 / 未命中，用于结果汇总（D11） */
const dryRunSummary = computed(() => {
  const summary = { success: 0, skipped: 0, error: 0 };
  for (const step of dryRunSteps.value) summary[step.status] += 1;
  return summary;
});

/**
 * 被选中的步骤行（ADR-0013 D12）：新步骤插到它下方；未选中则追加到末尾。
 * 选中只是编辑器内的临时状态，不写入配方。
 */
const selectedStep = ref<number | null>(null);

function selectStep(index: number): void {
  selectedStep.value = selectedStep.value === index ? null : index;
}

/**
 * 简易 / 高级模式（ADR-0013 D9）：只切换**视图**，数据仍是 `recipe.steps`。
 * - 初始按配方形态决定：标准三步登录 → 简易，其余 → 高级
 * - 切换只由用户显式触发，绝不自动回落（避免误改把多步配方压平）
 */
const mode = ref<'simple' | 'advanced'>(
  toSimpleForm(props.recipe) ? 'simple' : 'advanced',
);

/** 简易模式的三行下标；配方形态漂移时为 null（模板据此判断能否回到简易模式） */
const simpleShape = computed(() => simpleShapeOf(recipe.value));

// ============================================================
// 识别登录表单（ADR-0013 D8）
// ============================================================

const scanning = ref(false);
/** 扫描命中的 frame；空数组表示「未识别到」或尚未扫描 */
const scanFrames = ref<FormScanFrame[]>([]);
const scanChoice = ref(0);
const scanNotice = ref<{ kind: 'error' | 'warn' | 'info'; message: string } | null>(
  null,
);
// 识别发生在**环境 URL 对应的标签页**（不是选项页本身），文案必须写清楚是哪一页，
// 否则用户会以为在扫描当前这个配置页。

/** 识别目标的简短地址（环境 URL，去掉 query / hash） */
const scanTargetLabel = computed(() => {
  if (!props.origin) return null;
  try {
    const url = new URL(props.origin);
    const path = url.pathname === '/' ? '' : url.pathname;
    return `${url.origin}${path}`;
  } catch {
    return props.origin;
  }
});

/** 标签页 URL 是否属于目标 origin（避免「识别」跑到同窗口的其他站点） */
function sameOrigin(url: string | undefined, origin: string): boolean {
  if (!url) return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** 本次实际扫描的标签页地址（结果卡片上标明来源，避免与配置页混淆） */
const scanTabUrl = ref<string | null>(null);

const scanSourceLabel = computed(() => {
  const raw = scanTabUrl.value;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return raw;
  }
});

/** 识别按钮文案：始终点明扫描的是环境 URL 的页面，而不是当前选项页 */
const scanButtonLabel = computed(() => {
  if (scanning.value) return '识别中…';
  return scanTargetLabel.value
    ? `识别 ${scanTargetLabel.value} 页面上的登录表单`
    : '识别环境 URL 页面上的登录表单';
});

const scanFrame = computed<FormScanFrame | null>(
  () => scanFrames.value[scanChoice.value] ?? null,
);

/** 当前 frame 的候选能力（缺项由 UI 明确指出） */
function scanMissing(frame: FormScanFrame): string[] {
  const missing: string[] = [];
  if (!frame.username) missing.push('用户名');
  if (!frame.submit) missing.push('提交按钮');
  return missing;
}

function closeScan(): void {
  scanFrames.value = [];
  scanChoice.value = 0;
  scanNotice.value = null;
  scanTabUrl.value = null;
}

async function runScan(): Promise<void> {
  if (scanning.value) return;
  scanning.value = true;
  scanNotice.value = null;
  scanFrames.value = [];
  scanChoice.value = 0;
  scanTabUrl.value = null;
  try {
    const own = await chrome.tabs.getCurrent().catch(() => undefined);
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const origin = props.origin;
    const ranked = rankPickerTabs(tabs, origin, own?.id);
    // 识别的是环境 URL 所在页面，不是选项页本身：有 URL 时只认同 origin 的标签页
    const candidate = origin
      ? ranked.find((t) => sameOrigin(t.url, origin))
      : ranked[0];
    if (!candidate || candidate.id === undefined) {
      scanNotice.value = {
        kind: 'warn',
        message: origin
          ? `没有打开 ${origin} 的标签页：请先打开该环境的页面，再识别登录表单`
          : '没有可用于识别的网页标签页，请先打开目标登录页',
      };
      return;
    }
    scanTabUrl.value = candidate.url ?? null;
    const res = await sendBgMessage('SCAN_LOGIN_FORM', {
      tabId: candidate.id,
      origin: props.origin ?? '',
    });
    if (!res.success) {
      scanNotice.value = {
        kind: 'error',
        message: res.error ?? SCAN_ERROR_TEXT.INJECT_FAILED,
      };
      return;
    }
    scanFrames.value = res.frames;
    if (res.frames.length === 0) {
      scanNotice.value = {
        kind: 'warn',
        message: `在 ${scanSourceLabel.value ?? '环境页面'} 上未找到标准登录表单，请手动拾取或直接填写`,
      };
    }
  } catch (e: unknown) {
    scanNotice.value = {
      kind: 'error',
      message: e instanceof Error ? e.message : String(e),
    };
  } finally {
    scanning.value = false;
  }
}

/**
 * 把识别结果落成步骤：保留首个 goto（登录页 URL），fill / click 绑定到
 * 命中 frame（子 frame 才记录 frameUrl）。未识别到的项留空，由用户补拾取。
 */
function scannedStepsOf(frame: FormScanFrame): RecipeStep[] {
  const scope =
    frame.frameId !== undefined && frame.frameId !== 0
      ? {
          frameId: frame.frameId,
          ...(frame.frameUrl ? { frameUrl: frame.frameUrl } : {}),
        }
      : {};
  const next: RecipeStep[] = [];
  const goto = steps.value.find((s) => s.op === 'goto');
  if (goto) next.push({ ...goto });
  next.push({
    op: 'fill',
    target: frame.username?.target ?? '',
    value: '{username}',
    ...scope,
  });
  next.push({
    op: 'fill',
    target: frame.password?.target ?? '',
    value: '{password}',
    ...scope,
  });
  next.push({
    op: 'click',
    target: frame.submit?.target ?? '',
    onNotFound: 'fail',
    ...scope,
  });
  return next;
}

/** 确认后才回填（启发式识别必须留一次人工确认） */
function applyScan(): void {
  const frame = scanFrame.value;
  if (!frame) return;
  steps.value = scannedStepsOf(frame);
  selectedStep.value = null;
  clearAllPickerNotices();
  clearDryRun();
  // 识别结果通常就是标准三步：能投影就落到简易模式，减少一次手点
  if (simpleShapeOf(recipe.value)) mode.value = 'simple';
  closeScan();
}

// ============================================================
// 填充值：变量胶囊与明文密码提示（ADR-0013 D10）
// ============================================================

/** 每个 fill 行的值输入框，变量插入到光标处 */
const valueInputs = new Map<number, HTMLInputElement>();

function bindValueInput(index: number, el: unknown): void {
  if (el instanceof HTMLInputElement) valueInputs.set(index, el);
  else valueInputs.delete(index);
}

function insertVariable(index: number, token: string): void {
  const step = steps.value[index];
  if (step?.op !== 'fill') return;
  const input = valueInputs.get(index);
  const next = insertAtCursor(
    step.value,
    token,
    input?.selectionStart ?? null,
    input?.selectionEnd ?? null,
  );
  updateStep(index, { value: next.value });
  // 插入后把光标放回变量之后，连续点胶囊能依次插入
  requestAnimationFrame(() => {
    const current = valueInputs.get(index);
    if (!current) return;
    current.focus();
    current.setSelectionRange(next.cursor, next.cursor);
  });
}

/** 密码框里写了明文时的提示（不拦截） */
function plaintextNote(index: number): string | null {
  const step = steps.value[index];
  if (step?.op !== 'fill') return null;
  return passwordPlaintextWarning(step.target, step.value);
}

// ============================================================
// 简易模式：三行表单读写（D9）
// ============================================================

/** 当前配方投影成简易表单；形态漂移时返回 null */
const simpleForm = computed<SimpleForm | null>(() => toSimpleForm(recipe.value));

/** 三行表单的定位写入对应步骤（值固定为变量，不可编辑） */
function setSimpleTarget(
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
  updateStep(index, { target });
}

/** 登录页 URL：写了就补一个 goto，清空就删掉 goto */
function setLoginUrl(url: string): void {
  const form = simpleForm.value;
  if (!form) return;
  const gotoIndex = steps.value.findIndex((s) => s.op === 'goto');
  if (!url.trim()) {
    if (gotoIndex >= 0) {
      steps.value = removeStep(steps.value, gotoIndex);
      clearAllPickerNotices();
    }
    return;
  }
  if (gotoIndex >= 0) {
    updateStep(gotoIndex, { url });
    return;
  }
  steps.value = insertStep(steps.value, -1, {
    op: 'goto',
    url,
    ...(form.waitForLoad ? {} : { waitForLoad: false }),
  });
  clearAllPickerNotices();
}

function setWaitForLoad(checked: boolean): void {
  const gotoIndex = steps.value.findIndex((s) => s.op === 'goto');
  if (gotoIndex < 0) return;
  updateStep(gotoIndex, { waitForLoad: checked });
}

/** 简易 / 高级之间切换时清掉按下标绑定的候选与试跑结果 */
function switchMode(next: 'simple' | 'advanced'): void {
  if (next === 'simple' && !simpleShape.value) return;
  mode.value = next;
  clearAllPickerNotices();
  clearDryRun();
  selectedStep.value = null;
}

/**
 * 最近一次向父组件发出的值（序列化）。
 * 两个方向都用它做值比较：emit 前防止同值重复发出，回传时防止编辑被重置。
 */
let lastEmitted = '';

const recipe = computed<Recipe>(() => {
  const settle = formToSettle(settleForm.value) ?? props.recipe.settle;
  const failWhen = formToSettle(failForm.value);
  return {
    version: 1,
    steps: steps.value,
    settle,
    auth: formToAuth(authForm.value),
    ...(failWhen && failForm.value.kind !== 'default' ? { failWhen } : {}),
    ...(props.recipe.limits ? { limits: props.recipe.limits } : {}),
  };
});

watch(
  recipe,
  (value) => {
    // 必须按值比较：`recipe` 每次求值都是新对象，父组件把 emit 的值原样写回
    // props 后 computed 会重算并再次触发 deep watch，不设防会无限循环（卡死）。
    const serialized = JSON.stringify(value);
    if (serialized === lastEmitted) return;
    lastEmitted = serialized;
    emit('change', value);
  },
  { deep: true },
);

watch(
  () => props.recipe,
  (next) => {
    if (JSON.stringify(next) === lastEmitted) return;
    steps.value = cloneSteps(next.steps);
    settleForm.value = settleToForm(next.settle);
    failForm.value = settleToForm(next.failWhen);
    authForm.value = authToForm(next.auth);
    clearDryRun();
    selectedStep.value = null;
    clearAllPickerNotices();
    // 外部换配方（切换环境）：重新按形态决定初始视图
    mode.value = toSimpleForm(next) ? 'simple' : 'advanced';
    closeScan();
  },
  { deep: true },
);

const errors = computed<RecipeEditorErrors>(() => collectRecipeErrors(recipe.value));
const invalid = computed(() => hasRecipeErrors(errors.value));

// ============================================================
// 步骤操作
// ============================================================

/**
 * 步骤增删 / 换序后，按下标存放的候选与试跑结果都会错位，统一清空。
 * 选中行同样按下标索引，越界时置空。
 */
function clearAllPickerNotices(): void {
  if (Object.keys(pickerCandidates.value).length > 0) pickerCandidates.value = {};
  if (selectedStep.value !== null && selectedStep.value >= steps.value.length) {
    selectedStep.value = null;
  }
}

/**
 * 新步骤插到选中行下方（未选中则追加到末尾），ADR-0013 D12。
 * 插入后选中新行，连续添加时按「往下长」的直觉延伸。
 */
function addStep(): void {
  const at = selectedStep.value ?? steps.value.length - 1;
  steps.value = insertStep(steps.value, at, createStep('fill'));
  selectedStep.value = at + 1;
  clearAllPickerNotices();
  clearDryRun();
}

/** 切换 op：保留 target 与 frame 范围（D12），其余字段按新 op 重建 */
function changeOp(index: number, op: RecipeStep['op']): void {
  steps.value = steps.value.map((step, i) =>
    i === index ? changeStepOp(step, op) : step,
  );
  clearAllPickerNotices();
  clearDryRun();
}

/** 复制步骤到本行下方（D12） */
function duplicateAt(index: number): void {
  steps.value = duplicateStep(steps.value, index);
  selectedStep.value = index + 1;
  clearAllPickerNotices();
  clearDryRun();
}

function removeAt(index: number): void {
  steps.value = removeStep(steps.value, index);
  selectedStep.value = null;
  clearAllPickerNotices();
  clearDryRun();
}

function moveAt(index: number, delta: -1 | 1): void {
  steps.value = moveStep(steps.value, index, delta);
  selectedStep.value = null;
  clearAllPickerNotices();
  clearDryRun();
}

/** 步骤结构变化后，旧的逐行试跑结果不再对应（值 / 定位都可能变了） */
function clearDryRun(): void {
  dryRunSteps.value = [];
  dryRunError.value = null;
  dryRunScope.value = 'all';
  dryRunNotice.value = null;
}

function updateStep(index: number, patch: Record<string, unknown>): void {
  steps.value = steps.value.map((step, i) =>
    i === index ? ({ ...step, ...patch } as RecipeStep) : step,
  );
}

// ============================================================
// Target 编辑（统一走 TargetField，ADR-0013 D5）
// ============================================================

/** 步骤下标 → 候选缓存的 key */
function stepKey(index: number): string {
  return `step:${index}`;
}

/** 判定条件（成功 / 失败）→ 候选缓存的 key */
function settleKey(kind: 'settle' | 'fail'): string {
  return `settle:${kind}`;
}

function setStepTarget(index: number, target: Target): void {
  updateStep(index, { target });
}

/** 拾取后更新 frame 范围：执行时只在该 frame 内查找（D14） */
function setStepFrameScope(
  index: number,
  scope: { frameId?: number; frameUrl?: string },
): void {
  updateStep(index, {
    frameId: scope.frameId,
    frameUrl: scope.frameUrl,
  });
}

/**
 * 拾取成功后的建议（ADR-0013 D6）：只在值为空时填，绝不改写用户已有值；
 * 元素类型不匹配的警告由 `TargetField` 就地展示（不拦截保存）。
 */
function onStepPicked(
  index: number,
  payload: { meta: Parameters<typeof suggestFillValue>[0]; candidates: TargetCandidate[] },
): void {
  rememberCandidates(stepKey(index), payload.candidates);
  const step = steps.value[index];
  if (!step) return;
  if (step.op === 'fill' && step.value.trim()) return;
  if (step.op !== 'fill') return;
  const others = steps.value
    .filter((s, i) => i !== index && s.op === 'fill')
    .map((s) => (s.op === 'fill' ? s.value : ''));
  const suggested = suggestFillValue(payload.meta, others);
  if (suggested) updateStep(index, { value: suggested });
}

function onSettlePicked(
  kind: 'settle' | 'fail',
  payload: { candidates: TargetCandidate[] },
): void {
  rememberCandidates(settleKey(kind), payload.candidates);
}

/** 判定条件里的 selector 定位（ADR-0013 D5） */
function settleTargetOf(kind: 'settle' | 'fail'): Target | null {
  const form = kind === 'settle' ? settleForm.value : failForm.value;
  return form.kind === 'selector' ? (form.target ?? form.value) : null;
}

function updateSettleTarget(kind: 'settle' | 'fail', target: Target): void {
  const form = kind === 'settle' ? settleForm.value : failForm.value;
  const next: SettleForm = {
    kind: 'selector',
    value: describeTargetForUi(target),
    target,
  };
  if (kind === 'settle') settleForm.value = next;
  else failForm.value = next;
}

/** waitFor 的「元素出现」条件（ADR-0013 D5） */
function waitTargetOf(index: number): Target | null {
  const step = steps.value[index];
  if (step?.op !== 'waitFor' || step.when.type !== 'selector') return null;
  return step.when.target;
}

function updateWaitTarget(index: number, target: Target): void {
  const step = steps.value[index];
  if (step?.op !== 'waitFor') return;
  updateStep(index, { when: { type: 'selector', target } });
}

/** extract 的 DOM key：值在数据层是字符串（CSS 简写），界面用 TargetField 录入 */
function extractTargetOf(index: number): Target | null {
  const step = steps.value[index];
  return step?.op === 'extract' && step.source === 'dom' ? (step.key ?? null) : null;
}

/**
 * `Target` → 数据层的字符串 key：CSS 定位写选择器，其余退化为可读文案
 * （执行器的 DOM extract 只认选择器，非 CSS 定位交给用户自行确认）。
 */
function targetToKey(target: Target): string {
  if (typeof target === 'string') return target;
  if ('css' in target) return target.css;
  return describeTargetForUi(target);
}

function updateExtractTarget(index: number, target: Target): void {
  updateStep(index, { key: targetToKey(target) });
}

// ============================================================
// waitFor
// ============================================================

function waitFormOf(index: number): SettleForm | null {
  const step = steps.value[index];
  return step?.op === 'waitFor' ? settleToForm(step.when) : null;
}

function updateWaitKind(index: number, kind: SettleKind): void {
  // `selector` 需要先有 target 才能组成合法条件，但切到该类型时必须能进入
  // 表单（由 TargetField 填空），否则用户永远选不到「元素出现」。
  const when: SettleCondition | null =
    kind === 'selector'
      ? { type: 'selector', target: '' }
      : formToSettle({ kind, value: '' });
  if (when) updateStep(index, { when });
}

function updateWaitValue(index: number, value: string): void {
  const form = waitFormOf(index);
  if (!form) return;
  const when = formToSettle({ kind: form.kind, value });
  if (when) updateStep(index, { when });
}

// ============================================================
// 试跑（D13）
// ============================================================

/**
 * 试跑（D13 / ADR-0013 D11）。
 *
 * `only` 缺省时整条跑；传下标则只跑该步（单步试跑），结果只含该行。
 * `goto` 在试跑里会真实导航——这是既有语义，单步试跑 goto 时给出一次提示。
 */
async function runTest(only?: number): Promise<void> {
  if (dryRunning.value) return;
  dryRunning.value = true;
  dryRunError.value = null;
  dryRunSteps.value = [];
  dryRunScope.value = only ?? 'all';
  const step = only === undefined ? undefined : steps.value[only];
  dryRunNotice.value =
    step?.op === 'goto'
      ? '本步会真实导航到目标页面（既有试跑语义），页面上的未保存输入会丢失'
      : null;
  try {
    const own = await chrome.tabs.getCurrent().catch(() => undefined);
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const [candidate] = rankPickerTabs(tabs, props.origin, own?.id);
    if (!candidate || candidate.id === undefined) {
      dryRunError.value = '没有可用于试跑的网页标签页，请先打开目标环境页面';
      return;
    }
    const res = await sendBgMessage('TEST_RECIPE', {
      tabId: candidate.id,
      origin: props.origin ?? '',
      recipe: recipe.value,
      ...(only === undefined ? {} : { only: [only] }),
    });
    dryRunSteps.value = res.steps;
    dryRunError.value = res.success ? null : (res.error ?? '试跑失败');
    // 行内失败：把错误直接挂在步骤上（模板按 index 渲染），不再只留一条汇总
    if (only !== undefined && res.steps.length === 0 && !res.error) {
      dryRunError.value = '该步骤未参与试跑（可能已被删除），请重试';
    }
  } catch (e: unknown) {
    dryRunError.value = e instanceof Error ? e.message : String(e);
  } finally {
    dryRunning.value = false;
  }
}

function dryRunOf(index: number): DryRunStepResult | undefined {
  return dryRunSteps.value.find((s) => s.index === index);
}

/** 该行是否有拾取入口（fill / click / waitFor 元素出现 / extract DOM 都走 TargetField） */
function hasPicker(step: RecipeStep): boolean {
  if (step.op === 'fill' || step.op === 'click') return true;
  if (step.op === 'waitFor') return step.when.type === 'selector';
  if (step.op === 'extract') return step.source === 'dom';
  return false;
}

/** 失败行直接给「重新拾取」入口（D11）：就地触发该行 TargetField 的拾取按钮 */
function repickAt(event: Event): void {
  const row = (event.target as HTMLElement).closest('.step-item');
  row?.querySelector<HTMLButtonElement>('.pick-btn')?.click();
}

defineExpose({ errors, invalid });
</script>

<template>
  <div class="recipe-editor">
    <div v-if="migrated" class="recipe-notice">
      <div class="i-lucide-wand-2 w-4 h-4" />
      <span>已自动转换：旧的扁平参数已转成配方步骤，原参数不再显示。</span>
    </div>

    <!-- 一键识别登录表单（ADR-0013 D8）：识别结果必须人工确认后才回填 -->
    <div class="scan-bar">
      <DtButton size="sm" :disabled="scanning" @click="runScan">
        <div class="i-lucide-scan-search w-3.5 h-3.5 mr-1" />
        {{ scanButtonLabel }}
      </DtButton>
      <span class="scan-hint">
        扫描环境页面所在标签页（不是本配置页），只读不点击、不提交
      </span>
    </div>

    <p
      v-if="scanNotice"
      class="picker-notice"
      :class="`picker-notice-${scanNotice.kind}`"
    >
      <span
        :class="
          scanNotice.kind === 'error'
            ? 'i-lucide-alert-circle'
            : scanNotice.kind === 'warn'
              ? 'i-lucide-alert-triangle'
              : 'i-lucide-info'
        "
        class="w-3.5 h-3.5 picker-notice-icon"
      />{{ scanNotice.message }}
      <button type="button" class="scan-dismiss" @click="closeScan">关闭</button>
    </p>

    <div v-if="scanFrame" class="scan-card">
      <div class="scan-head">
        <span class="i-lucide-clipboard-check w-4 h-4" />
        <span>识别结果</span>
        <span class="optional">
          · {{ scanSourceLabel ?? '环境页面' }}
        </span>
        <span v-if="scanFrames.length > 1" class="optional">
          （命中 {{ scanFrames.length }} 个 frame）
        </span>
      </div>

      <div v-if="scanFrames.length > 1" class="scan-frames">
        <label
          v-for="(frame, i) in scanFrames"
          :key="`${frame.frameId}-${i}`"
          class="scan-frame-option"
        >
          <input v-model="scanChoice" type="radio" :value="i" />
          <span class="scan-frame-url">
            {{ frame.frameId === 0 ? '主页面' : `frame #${frame.frameId}` }} · {{ frame.frameUrl || '未知地址' }}
          </span>
        </label>
      </div>

      <div class="scan-rows">
        <div class="scan-row">
          <span class="scan-key">用户名</span>
          <span class="scan-val" :class="{ 'scan-missing': !scanFrame.username }">
            {{ scanFrame.username ? describeTargetForUi(scanFrame.username.target) : '未识别到' }}
          </span>
          <span v-if="scanFrame.username" class="scan-count">
            {{ scanFrame.username.count === 1 ? '唯一' : `命中 ${scanFrame.username.count}` }}
          </span>
        </div>
        <div class="scan-row">
          <span class="scan-key">密码</span>
          <span class="scan-val" :class="{ 'scan-missing': !scanFrame.password }">
            {{ scanFrame.password ? describeTargetForUi(scanFrame.password.target) : '未识别到' }}
          </span>
          <span v-if="scanFrame.password" class="scan-count">
            {{ scanFrame.password.count === 1 ? '唯一' : `命中 ${scanFrame.password.count}` }}
          </span>
        </div>
        <div class="scan-row">
          <span class="scan-key">提交</span>
          <span class="scan-val" :class="{ 'scan-missing': !scanFrame.submit }">
            {{ scanFrame.submit ? describeTargetForUi(scanFrame.submit.target) : '未识别到' }}
          </span>
          <span v-if="scanFrame.submit" class="scan-count">
            {{ scanFrame.submit.count === 1 ? '唯一' : `命中 ${scanFrame.submit.count}` }}
          </span>
        </div>
      </div>

      <p v-if="scanMissing(scanFrame).length > 0" class="scan-warn">
        未识别到{{ scanMissing(scanFrame).join('、') }}，会保留为空，请手动拾取
      </p>
      <p v-else class="scan-note">
        将替换当前 {{ steps.length }} 个步骤（登录页 URL 与判定配置保留）
      </p>

      <div class="scan-actions">
        <DtButton variant="primary" @click="applyScan">
          <div class="i-lucide-check w-3.5 h-3.5 mr-1" />替换步骤
        </DtButton>
        <DtButton size="sm" @click="closeScan">取消</DtButton>
      </div>
    </div>

    <div class="recipe-section-title">
      <span>{{ mode === 'simple' ? '登录表单' : '登录步骤' }}</span>
      <span class="optional">（{{ steps.length }} 步）</span>
      <button
        v-if="mode === 'advanced' && simpleShape"
        type="button"
        class="mode-link"
        @click="switchMode('simple')"
      >
        简易模式
      </button>
      <button
        v-else-if="mode === 'simple'"
        type="button"
        class="mode-link"
        @click="switchMode('advanced')"
      >
        编辑原始步骤（{{ steps.length }} 步）
      </button>
    </div>

    <!-- 简易模式（D9）：steps 的投影视图，值固定为变量，只有定位可编辑 -->
    <div v-if="mode === 'simple' && simpleForm" class="simple-form">
      <div class="simple-row">
        <span class="simple-label">登录页</span>
        <input
          class="dt-input"
          :value="simpleForm.loginUrl"
          placeholder="留空表示不导航，例: {origin}/login"
          @input="setLoginUrl(($event.target as HTMLInputElement).value)"
        />
      </div>
      <label v-if="simpleForm.loginUrl" class="inline-check">
        <input
          type="checkbox"
          :checked="simpleForm.waitForLoad"
          @change="setWaitForLoad(($event.target as HTMLInputElement).checked)"
        />
        等待页面加载完成
      </label>
      <div class="simple-row">
        <span class="simple-label">用户名</span>
        <TargetField
          :model-value="simpleForm.username"
          context="fill"
          :origin="origin"
          placeholder="用户名输入框，如 #username"
          @update:model-value="setSimpleTarget('username', $event)"
        />
        <span class="simple-token">{username}</span>
      </div>
      <p v-for="message in errors.steps[simpleShape!.usernameIndex] ?? []" :key="message" class="field-error">
        <span class="i-lucide-alert-circle w-3.5 h-3.5" />{{ message }}
      </p>
      <div class="simple-row">
        <span class="simple-label">密码</span>
        <TargetField
          :model-value="simpleForm.password"
          context="fill"
          :origin="origin"
          placeholder="密码输入框，如 #password"
          @update:model-value="setSimpleTarget('password', $event)"
        />
        <span class="simple-token">{password}</span>
      </div>
      <p v-for="message in errors.steps[simpleShape!.passwordIndex] ?? []" :key="message" class="field-error">
        <span class="i-lucide-alert-circle w-3.5 h-3.5" />{{ message }}
      </p>
      <div class="simple-row">
        <span class="simple-label">登录</span>
        <TargetField
          :model-value="simpleForm.submit"
          context="click"
          :origin="origin"
          placeholder="登录按钮，如 button[type=submit]"
          @update:model-value="setSimpleTarget('submit', $event)"
        />
      </div>
      <p v-for="message in errors.steps[simpleShape!.submitIndex] ?? []" :key="message" class="field-error">
        <span class="i-lucide-alert-circle w-3.5 h-3.5" />{{ message }}
      </p>
      <p class="target-hint">定位可拾取或手填；值固定为账号 / 密码变量。</p>
    </div>

    <!-- 高级模式：原始步骤编辑器 -->
    <template v-else>
      <p v-if="mode === 'simple' && !simpleForm" class="scan-warn">
        当前配方不再是标准三步登录，已无法用简易模式表达，请编辑原始步骤。
      </p>
      <div class="step-list">
        <div
          v-for="(step, index) in steps"
          :key="index"
          class="step-item"
          :class="{ 'step-invalid': errors.steps[index], 'step-selected': selectedStep === index }"
          @click.self="selectStep(index)"
        >
          <div class="step-head" @click.self="selectStep(index)">
            <button
              type="button"
              class="step-index"
              :class="{ 'step-index-selected': selectedStep === index }"
              :title="selectedStep === index ? '已选中：新步骤将插入到此行下方' : '选中此行（新步骤插入到下方）'"
              @click.stop="selectStep(index)"
            >
              {{ index + 1 }}
            </button>
            <select
              class="dt-input step-op-select"
              :value="step.op"
              @change="changeOp(index, ($event.target as HTMLSelectElement).value as RecipeStep['op'])"
            >
              <option v-for="opt in STEP_OP_OPTIONS" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
            <div class="step-actions">
              <button
                type="button"
                class="icon-btn"
                :title="step.op === 'goto' ? '试跑本步（会真实导航）' : '试跑本步'"
                :disabled="dryRunning"
                @click="runTest(index)"
              >
                <div class="i-lucide-play w-3.5 h-3.5" />
              </button>
              <button type="button" class="icon-btn" title="复制步骤" @click="duplicateAt(index)">
                <div class="i-lucide-copy w-3.5 h-3.5" />
              </button>
              <button type="button" class="icon-btn" title="上移" :disabled="index === 0" @click="moveAt(index, -1)">
                <div class="i-lucide-arrow-up w-3.5 h-3.5" />
              </button>
              <button type="button" class="icon-btn" title="下移" :disabled="index === steps.length - 1" @click="moveAt(index, 1)">
                <div class="i-lucide-arrow-down w-3.5 h-3.5" />
              </button>
              <button type="button" class="icon-btn icon-btn-danger" title="删除" @click="removeAt(index)">
                <div class="i-lucide-trash-2 w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <!-- goto -->
          <div v-if="step.op === 'goto'" class="step-body">
            <input
              class="dt-input"
              :value="step.url"
              placeholder="例: {origin}/login 或 /login"
              @input="updateStep(index, { url: ($event.target as HTMLInputElement).value })"
            />
            <label class="inline-check">
              <input
                type="checkbox"
                :checked="step.waitForLoad !== false"
                @change="updateStep(index, { waitForLoad: ($event.target as HTMLInputElement).checked })"
              />
              等待页面加载完成
            </label>
          </div>

          <!-- fill -->
          <div v-else-if="step.op === 'fill'" class="step-body">
            <TargetField
              :model-value="step.target"
              context="fill"
              :origin="origin"
              placeholder="例: #username 或 用户名"
              :candidates="candidatesOf(stepKey(index))"
              @update:model-value="setStepTarget(index, $event)"
              @update:frame-scope="setStepFrameScope(index, $event)"
              @picked="onStepPicked(index, $event)"
            />
            <input
              :ref="(el) => bindValueInput(index, el)"
              class="dt-input"
              :value="step.value"
              placeholder="填充值，支持变量（见下方胶囊）"
              @input="updateStep(index, { value: ($event.target as HTMLInputElement).value })"
            />
            <!-- 变量胶囊（ADR-0013 D10）：清单来自执行器的变量表，不硬编码 -->
            <div class="variable-row">
              <span class="variable-label">插入变量</span>
              <button
                v-for="hint in VARIABLE_HINTS"
                :key="hint.token"
                type="button"
                class="variable-pill"
                :title="hint.label"
                @click="insertVariable(index, hint.token)"
              >
                {{ hint.token }}
              </button>
              <span class="variable-label">{step.*} 引用前面步骤的提取结果</span>
            </div>
            <p v-if="plaintextNote(index)" class="type-note">
              <span class="i-lucide-alert-triangle w-3.5 h-3.5" />{{ plaintextNote(index) }}
            </p>
          </div>

          <!-- click -->
          <div v-else-if="step.op === 'click'" class="step-body">
            <TargetField
              :model-value="step.target"
              context="click"
              :origin="origin"
              placeholder="例: button[type=submit] 或 登录"
              :candidates="candidatesOf(stepKey(index))"
              @update:model-value="setStepTarget(index, $event)"
              @update:frame-scope="setStepFrameScope(index, $event)"
              @picked="onStepPicked(index, $event)"
            />
            <label class="inline-check">
              <input
                type="checkbox"
                :checked="step.onNotFound === 'skip'"
                @change="updateStep(index, { onNotFound: ($event.target as HTMLInputElement).checked ? 'skip' : 'fail' })"
              />
              未找到时跳过（例如可选的「下一步」按钮）
            </label>
          </div>

          <!-- waitFor -->
          <div v-else-if="step.op === 'waitFor'" class="step-body">
            <div class="target-row">
              <select
                class="dt-input target-kind"
                :value="waitFormOf(index)?.kind ?? 'urlChanged'"
                @change="updateWaitKind(index, ($event.target as HTMLSelectElement).value as SettleKind)"
              >
                <option
                  v-for="opt in SETTLE_KIND_OPTIONS.filter((o) => o.value !== 'default' && o.value !== 'custom')"
                  :key="opt.value"
                  :value="opt.value"
                >
                  {{ opt.label }}
                </option>
              </select>
              <!-- 元素出现：复用 TargetField（ADR-0013 D5） -->
              <TargetField
                v-if="waitFormOf(index)?.kind === 'selector'"
                :model-value="waitTargetOf(index)"
                context="locate"
                :origin="origin"
                placeholder="例: .welcome 或 已登录"
                @update:model-value="updateWaitTarget(index, $event)"
              />
              <input
                v-else-if="waitFormOf(index) && !['formGone', 'urlChanged'].includes(waitFormOf(index)!.kind)"
                class="dt-input target-value"
                :value="waitFormOf(index)!.value"
                placeholder="等待条件的值"
                @input="updateWaitValue(index, ($event.target as HTMLInputElement).value)"
              />
            </div>
            <div class="target-hint">当前条件：{{ describeSettle(step.when) }}</div>
          </div>

          <!-- extract -->
          <div v-else-if="step.op === 'extract'" class="step-body">
            <div class="target-row">
              <select
                class="dt-input target-kind"
                :value="step.source"
                @change="updateStep(index, { source: ($event.target as HTMLSelectElement).value })"
              >
                <option value="storage">storage</option>
                <option value="dom">DOM</option>
                <option value="url">URL</option>
              </select>
              <!-- DOM key 本质是选择器：DOM 来源直接给拾取器（ADR-0013 D5） -->
              <TargetField
                v-if="step.source === 'dom'"
                :model-value="extractTargetOf(index)"
                context="locate"
                :origin="origin"
                placeholder="选择器，如 .token"
                @update:model-value="updateExtractTarget(index, $event)"
              />
              <input
                v-else-if="step.source === 'storage'"
                class="dt-input target-value"
                :value="step.key ?? ''"
                placeholder="存储键"
                @input="updateStep(index, { key: ($event.target as HTMLInputElement).value })"
              />
              <input
                class="dt-input target-value extract-as"
                :value="step.as ?? ''"
                placeholder="变量名（默认 extract）"
                @input="updateStep(index, { as: ($event.target as HTMLInputElement).value })"
              />
            </div>
          </div>

          <!-- script -->
          <div v-else-if="step.op === 'script'" class="step-body">
            <textarea
              class="dt-input strategy-textarea"
              rows="3"
              spellcheck="false"
              :value="step.code"
              placeholder="页面内执行的 JS（仅限可信来源；不要写入密码）"
              @input="updateStep(index, { code: ($event.target as HTMLTextAreaElement).value })"
            />
          </div>

          <p v-for="message in errors.steps[index] ?? []" :key="message" class="field-error">
            <span class="i-lucide-alert-circle w-3.5 h-3.5" />{{ message }}
          </p>

          <div v-if="dryRunOf(index)" class="dry-run-status" :class="`dry-${dryRunOf(index)!.status}`">
            <span v-if="dryRunOf(index)!.status === 'success'">命中</span>
            <span v-else-if="dryRunOf(index)!.status === 'skipped'">跳过（试跑不执行此类型）</span>
            <span v-else>
              未命中{{ dryRunOf(index)!.errorCode ? ` [${dryRunOf(index)!.errorCode}]` : '' }}<template
                v-if="dryRunOf(index)!.error"
              >：{{ dryRunOf(index)!.error }}</template>
            </span>
            <!-- 失败行就地给修复入口（D11）：FRAME_NOT_FOUND 之类不需要用户自己找拾取按钮 -->
            <button
              v-if="dryRunOf(index)!.status === 'error' && hasPicker(step)"
              type="button"
              class="dry-run-repick"
              @click.stop="repickAt($event)"
            >
              重新拾取
            </button>
          </div>
        </div>
      </div>

      <div class="recipe-toolbar">
        <DtButton size="sm" @click="addStep">
          <div class="i-lucide-plus w-3.5 h-3.5 mr-1" />添加步骤
        </DtButton>
        <DtButton size="sm" :disabled="dryRunning" @click="runTest()">
          <div class="i-lucide-play w-3.5 h-3.5 mr-1" />
          {{ dryRunning ? '试跑中…' : '试跑当前 tab' }}
        </DtButton>
        <span v-if="selectedStep !== null" class="selection-hint">
          新步骤将插入到第 {{ selectedStep + 1 }} 步下方
        </span>
      </div>

      <!-- 结果汇总：区分命中 / 跳过 / 未命中（D11） -->
      <p v-if="dryRunSteps.length > 0" class="dry-run-summary">
        {{ dryRunScope === 'all' ? '整条配方' : `第 ${dryRunScope + 1} 步` }}试跑：
        命中 {{ dryRunSummary.success }} · 跳过 {{ dryRunSummary.skipped }} · 未命中
        {{ dryRunSummary.error }}
      </p>

      <p v-if="dryRunNotice" class="type-note">
        <span class="i-lucide-info w-3.5 h-3.5" />{{ dryRunNotice }}
      </p>

      <p v-if="dryRunError" class="field-error">
        <span class="i-lucide-alert-circle w-3.5 h-3.5" />{{ dryRunError }}
      </p>
    </template>

    <!-- 成功判定 -->
    <div class="advanced-settings-section">
      <button type="button" class="advanced-toggle-btn" @click="showSettle = !showSettle">
        <div :class="showSettle ? 'i-lucide-chevron-down w-4 h-4' : 'i-lucide-chevron-right w-4 h-4'" />
        <span>成功判定</span>
        <span class="optional">（{{ describeSettle(recipe.settle) }}）</span>
      </button>
      <div v-show="showSettle" class="advanced-content">
        <div class="target-row">
          <select
            class="dt-input target-kind"
            :value="settleForm.kind"
            @change="settleForm = { kind: ($event.target as HTMLSelectElement).value as SettleKind, value: '' }"
          >
            <option v-for="opt in SETTLE_KIND_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
          <!-- 元素出现：复用 TargetField（ADR-0013 D5） -->
          <TargetField
            v-if="settleForm.kind === 'selector'"
            :model-value="settleTargetOf('settle')"
            context="locate"
            :origin="origin"
            placeholder="判定元素，如 .welcome"
            :candidates="candidatesOf(settleKey('settle'))"
            @update:model-value="updateSettleTarget('settle', $event)"
            @picked="onSettlePicked('settle', $event)"
          />
          <input
            v-else-if="!['default', 'formGone', 'urlChanged', 'custom'].includes(settleForm.kind)"
            class="dt-input target-value"
            :value="settleForm.value"
            placeholder="判定值"
            @input="settleForm = { kind: settleForm.kind, value: ($event.target as HTMLInputElement).value }"
          />
        </div>
        <p v-for="message in errors.settle" :key="message" class="field-error">
          <span class="i-lucide-alert-circle w-3.5 h-3.5" />{{ message }}
        </p>
      </div>
    </div>

    <!-- 失败判定 -->
    <div class="advanced-settings-section">
      <button type="button" class="advanced-toggle-btn" @click="showFail = !showFail">
        <div :class="showFail ? 'i-lucide-chevron-down w-4 h-4' : 'i-lucide-chevron-right w-4 h-4'" />
        <span>失败判定</span>
        <span class="optional">（{{ recipe.failWhen ? describeSettle(recipe.failWhen) : '未配置' }}）</span>
      </button>
      <div v-show="showFail" class="advanced-content">
        <div class="target-row">
          <select
            class="dt-input target-kind"
            :value="failForm.kind"
            @change="failForm = { kind: ($event.target as HTMLSelectElement).value as SettleKind, value: '' }"
          >
            <option v-for="opt in SETTLE_KIND_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
          <!-- 元素出现：复用 TargetField（ADR-0013 D5） -->
          <TargetField
            v-if="failForm.kind === 'selector'"
            :model-value="settleTargetOf('fail')"
            context="locate"
            :origin="origin"
            placeholder="失败元素，如 .error-msg"
            :candidates="candidatesOf(settleKey('fail'))"
            @update:model-value="updateSettleTarget('fail', $event)"
            @picked="onSettlePicked('fail', $event)"
          />
          <input
            v-else-if="!['default', 'formGone', 'urlChanged', 'custom'].includes(failForm.kind)"
            class="dt-input target-value"
            :value="failForm.value"
            placeholder="判定值"
            @input="failForm = { kind: failForm.kind, value: ($event.target as HTMLInputElement).value }"
          />
        </div>
        <p class="target-hint">选择「默认」表示不配置失败判定。</p>
      </div>
    </div>

    <!-- 认证规格 -->
    <div class="advanced-settings-section">
      <button type="button" class="advanced-toggle-btn" @click="showAuth = !showAuth">
        <div :class="showAuth ? 'i-lucide-chevron-down w-4 h-4' : 'i-lucide-chevron-right w-4 h-4'" />
        <span>认证规格</span>
        <span class="optional">（{{ authForm.mode === 'page' ? '页面自管' : '快照' }}）</span>
      </button>
      <div v-show="showAuth" class="advanced-content">
        <div class="target-row">
          <select
            class="dt-input"
            :value="authForm.mode"
            @change="authForm = { ...authForm, mode: ($event.target as HTMLSelectElement).value as 'page' | 'snapshot' }"
          >
            <option value="page">页面自管（默认）</option>
            <option value="snapshot">快照（跨 origin Bug 复现跳转用）</option>
          </select>
        </div>

        <template v-if="authForm.mode === 'snapshot'">
          <div class="form-row">
            <label>登录前清除 Cookie</label>
            <div class="target-row">
              <select
                class="dt-input target-kind"
                :value="authForm.clearKind"
                @change="authForm = { ...authForm, clearKind: ($event.target as HTMLSelectElement).value as AuthForm['clearKind'] }"
              >
                <option value="all">全部（仅当前域名）</option>
                <option value="none">不清</option>
                <option value="names">白名单</option>
              </select>
              <input
                v-if="authForm.clearKind === 'names'"
                class="dt-input target-value"
                :value="authForm.clearNames"
                placeholder="Cookie 名，逗号分隔"
                @input="authForm = { ...authForm, clearNames: ($event.target as HTMLInputElement).value }"
              />
            </div>
            <p v-if="authForm.clearKind === 'all'" class="risk-note">
              <span class="i-lucide-alert-triangle w-3.5 h-3.5" />
              会清除该域名下全部 Cookie（含同域其他登录态）。如需保留部分登录态，请改用白名单或「不清」。
            </p>
          </div>

          <div class="form-row">
            <label>跨 origin 携带 Cookie</label>
            <div class="target-row">
              <select
                class="dt-input target-kind"
                :value="authForm.cookiesKind"
                @change="authForm = { ...authForm, cookiesKind: ($event.target as HTMLSelectElement).value as AuthForm['cookiesKind'] }"
              >
                <option value="none">不携带</option>
                <option value="all">全部</option>
                <option value="names">白名单</option>
              </select>
              <input
                v-if="authForm.cookiesKind === 'names'"
                class="dt-input target-value"
                :value="authForm.cookiesNames"
                placeholder="Cookie 名，逗号分隔"
                @input="authForm = { ...authForm, cookiesNames: ($event.target as HTMLInputElement).value }"
              />
            </div>
          </div>

          <div class="form-row">
            <label>localStorage</label>
            <div class="target-row">
              <select
                class="dt-input target-kind"
                :value="authForm.localKind"
                @change="authForm = { ...authForm, localKind: ($event.target as HTMLSelectElement).value as AuthForm['localKind'] }"
              >
                <option value="none">不处理</option>
                <option value="all">全部</option>
                <option value="names">白名单</option>
              </select>
              <input
                v-if="authForm.localKind === 'names'"
                class="dt-input target-value"
                :value="authForm.localNames"
                placeholder="键名，逗号分隔"
                @input="authForm = { ...authForm, localNames: ($event.target as HTMLInputElement).value }"
              />
            </div>
          </div>

          <div class="form-row">
            <label>sessionStorage</label>
            <div class="target-row">
              <select
                class="dt-input target-kind"
                :value="authForm.sessionKind"
                @change="authForm = { ...authForm, sessionKind: ($event.target as HTMLSelectElement).value as AuthForm['sessionKind'] }"
              >
                <option value="none">不处理</option>
                <option value="all">全部</option>
                <option value="names">白名单</option>
              </select>
              <input
                v-if="authForm.sessionKind === 'names'"
                class="dt-input target-value"
                :value="authForm.sessionNames"
                placeholder="键名，逗号分隔"
                @input="authForm = { ...authForm, sessionNames: ($event.target as HTMLInputElement).value }"
              />
            </div>
          </div>
        </template>

        <p v-for="message in errors.auth" :key="message" class="field-error">
          <span class="i-lucide-alert-circle w-3.5 h-3.5" />{{ message }}
        </p>
      </div>
    </div>

    <p v-for="message in errors.general" :key="message" class="field-error">
      <span class="i-lucide-alert-circle w-3.5 h-3.5" />{{ message }}
    </p>
  </div>
</template>

<style scoped>
@import '../../../shared/component-styles.scss';
@import './config-panel-shared.scss';

.recipe-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.recipe-notice {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-radius: 8px;
  background: rgba(99, 102, 241, 0.06);
  border: 1px solid rgba(99, 102, 241, 0.16);
  font-size: 12px;
  color: #4f46e5;
}

[data-dt-dark] .recipe-notice {
  background: rgba(99, 102, 241, 0.12);
  border-color: rgba(99, 102, 241, 0.3);
  color: #93c5fd;
}

.recipe-section-title {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  font-weight: 600;
  color: #0f172a;
}

[data-dt-dark] .recipe-section-title {
  color: #f1f5f9;
}

.step-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.step-item {
  padding: 10px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  background: #fff;
  transition: border-color 0.15s ease-out;
}

[data-dt-dark] .step-item {
  background: var(--dt-dark-surface-1);
  border-color: var(--dt-dark-border);
}

.step-item:hover {
  border-color: #93c5fd;
}

[data-dt-dark] .step-item:hover {
  border-color: #58a6ff;
}

.step-item.step-invalid {
  border-color: #fecaca;
}

[data-dt-dark] .step-item.step-invalid {
  border-color: #7f1d1d;
}

.step-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.step-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 9999px;
  background: linear-gradient(135deg, #6366f1, #3b82f6);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
  cursor: pointer;
  transition: box-shadow 0.15s ease-out, transform 0.15s ease-out;
}

.step-index:hover {
  transform: scale(1.08);
}

/* 选中行：新步骤插到它下方（ADR-0013 D12） */
.step-index-selected {
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.28);
}

.step-item.step-selected {
  border-color: #818cf8;
}

[data-dt-dark] .step-item.step-selected {
  border-color: #6366f1;
}

.selection-hint {
  align-self: center;
  font-size: 12px;
  color: #4f46e5;
}

[data-dt-dark] .selection-hint {
  color: #93c5fd;
}

.step-op-select {
  flex: 1;
  max-width: 200px;
}

.step-actions {
  display: flex;
  gap: 4px;
  margin-left: auto;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  background: #fff;
  color: #64748b;
  cursor: pointer;
  transition: all 0.15s ease-out;
}

.icon-btn:hover:not(:disabled) {
  border-color: #93c5fd;
  color: #3b82f6;
}

.icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

[data-dt-dark] .icon-btn {
  background: var(--dt-dark-surface-hover);
  border-color: var(--dt-dark-border);
  color: #8b949e;
}

[data-dt-dark] .icon-btn:hover:not(:disabled) {
  border-color: #58a6ff;
  color: #60a5fa;
}

.icon-btn-danger:hover:not(:disabled) {
  border-color: #fecaca;
  color: #dc2626;
}

[data-dt-dark] .icon-btn-danger:hover:not(:disabled) {
  border-color: #7f1d1d;
  color: #f87171;
}

.step-body {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.target-row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.target-kind {
  max-width: 130px;
  flex-shrink: 0;
}

.target-value {
  flex: 1;
  min-width: 0;
}

/* extract 的变量名输入不与选择器抢宽度 */
.extract-as {
  max-width: 180px;
}

.target-hint {
  font-size: 12px;
  font-family: var(--font-mono);
  color: #94a3b8;
}

[data-dt-dark] .target-hint {
  color: #64748b;
}

.inline-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #64748b;
  cursor: pointer;
}

[data-dt-dark] .inline-check {
  color: #8b949e;
}

.recipe-toolbar {
  display: flex;
  gap: 8px;
}

.advanced-settings-section {
  margin-top: 4px;
  border-top: 1px solid #e2e8f0;
  padding-top: 10px;
}

[data-dt-dark] .advanced-settings-section {
  border-top-color: var(--dt-dark-border);
}

.advanced-toggle-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 12px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  color: #64748b;
  transition: all 0.2s ease-out;
}

[data-dt-dark] .advanced-toggle-btn {
  background: var(--dt-dark-surface-hover);
  border-color: var(--dt-dark-border);
  color: #8b949e;
}

.advanced-toggle-btn:hover {
  background: #f1f5f9;
  border-color: #93c5fd;
  color: #3b82f6;
}

[data-dt-dark] .advanced-toggle-btn:hover {
  background: #1e3a5f;
  border-color: #58a6ff;
  color: #60a5fa;
}

.advanced-content {
  margin-top: 10px;
  padding-left: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.optional {
  font-size: 12px;
  color: #94a3b8;
  font-weight: normal;
}

.field-error {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  font-size: 12px;
  color: #dc2626;
}

.field-error .i-lucide-alert-circle {
  flex-shrink: 0;
}

[data-dt-dark] .field-error {
  color: #f87171;
}

.risk-note {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--warning);
}

.risk-note .i-lucide-alert-triangle {
  flex-shrink: 0;
  margin-top: 1px;
}

[data-dt-dark] .risk-note {
  color: var(--warning-dark);
}

.dry-run-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 12px;
}

/* 失败行的就地修复入口（ADR-0013 D11） */
.dry-run-repick {
  margin-left: auto;
  border: 1px solid currentColor;
  border-radius: 9999px;
  background: transparent;
  padding: 0 8px;
  font-size: 12px;
  color: inherit;
  cursor: pointer;
  opacity: 0.85;
  transition: opacity 0.15s ease-out;
}

.dry-run-repick:hover {
  opacity: 1;
}

.dry-run-summary {
  margin: 0;
  font-size: 12px;
  color: #64748b;
}

[data-dt-dark] .dry-run-summary {
  color: #8b949e;
}

.dry-success {
  background: rgba(22, 163, 74, 0.08);
  color: #16a34a;
}

[data-dt-dark] .dry-success {
  background: rgba(74, 222, 128, 0.12);
  color: #4ade80;
}

.dry-skipped {
  background: rgba(148, 163, 184, 0.12);
  color: #64748b;
}

[data-dt-dark] .dry-skipped {
  background: rgba(100, 116, 139, 0.18);
  color: #8b949e;
}

.dry-error {
  background: rgba(220, 38, 38, 0.08);
  color: #dc2626;
}

[data-dt-dark] .dry-error {
  background: rgba(248, 113, 113, 0.12);
  color: #f87171;
}

/* ============================================================
   识别登录表单（D8）/ 简易模式（D9）/ 变量胶囊（D10）
   ============================================================ */

.scan-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.scan-hint {
  font-size: 12px;
  color: #94a3b8;
}

[data-dt-dark] .scan-hint {
  color: #64748b;
}

.scan-dismiss {
  margin-left: auto;
  border: none;
  background: transparent;
  padding: 0;
  font-size: 12px;
  color: inherit;
  opacity: 0.75;
  cursor: pointer;
}

.scan-dismiss:hover {
  opacity: 1;
  text-decoration: underline;
}

.scan-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid rgba(99, 102, 241, 0.28);
  border-radius: 10px;
  background: rgba(99, 102, 241, 0.05);
}

[data-dt-dark] .scan-card {
  background: rgba(99, 102, 241, 0.1);
  border-color: rgba(99, 102, 241, 0.35);
}

.scan-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: #4f46e5;
}

[data-dt-dark] .scan-head {
  color: #93c5fd;
}

.scan-frames {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.scan-frame-option {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #475569;
  cursor: pointer;
}

[data-dt-dark] .scan-frame-option {
  color: #cbd5e1;
}

.scan-frame-url {
  font-family: var(--font-mono);
  word-break: break-all;
}

.scan-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.scan-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.scan-key {
  width: 48px;
  flex-shrink: 0;
  color: #64748b;
}

[data-dt-dark] .scan-key {
  color: #8b949e;
}

.scan-val {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  color: #0f172a;
  word-break: break-all;
}

[data-dt-dark] .scan-val {
  color: #f1f5f9;
}

.scan-val.scan-missing {
  color: var(--warning);
  font-style: italic;
}

[data-dt-dark] .scan-val.scan-missing {
  color: var(--warning-dark);
}

.scan-count {
  flex-shrink: 0;
  font-size: 12px;
  color: #16a34a;
}

[data-dt-dark] .scan-count {
  color: #4ade80;
}

.scan-warn {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  margin: 0;
  font-size: 12px;
  color: var(--warning);
}

[data-dt-dark] .scan-warn {
  color: var(--warning-dark);
}

.scan-note {
  margin: 0;
  font-size: 12px;
  color: #64748b;
}

[data-dt-dark] .scan-note {
  color: #8b949e;
}

.scan-actions {
  display: flex;
  gap: 8px;
}

.mode-link {
  margin-left: auto;
  border: none;
  background: transparent;
  padding: 0;
  font-size: 12px;
  font-weight: 500;
  color: #4f46e5;
  cursor: pointer;
}

.mode-link:hover {
  text-decoration: underline;
}

[data-dt-dark] .mode-link {
  color: #93c5fd;
}

.simple-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  background: #fff;
}

[data-dt-dark] .simple-form {
  background: var(--dt-dark-surface-1);
  border-color: var(--dt-dark-border);
}

.simple-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.simple-label {
  width: 52px;
  flex-shrink: 0;
  font-size: 12px;
  color: #64748b;
}

[data-dt-dark] .simple-label {
  color: #8b949e;
}

.simple-token {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 9999px;
  background: rgba(99, 102, 241, 0.08);
  font-family: var(--font-mono);
  font-size: 12px;
  color: #4f46e5;
}

[data-dt-dark] .simple-token {
  background: rgba(99, 102, 241, 0.16);
  color: #93c5fd;
}

.variable-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.variable-label {
  font-size: 12px;
  color: #94a3b8;
}

[data-dt-dark] .variable-label {
  color: #64748b;
}

.variable-pill {
  padding: 1px 8px;
  border: 1px solid #e2e8f0;
  border-radius: 9999px;
  background: #fff;
  font-family: var(--font-mono);
  font-size: 12px;
  color: #475569;
  cursor: pointer;
  transition: all 0.15s ease-out;
}

.variable-pill:hover {
  border-color: #93c5fd;
  color: #3b82f6;
  transform: translateY(-1px);
}

[data-dt-dark] .variable-pill {
  background: var(--dt-dark-surface-hover);
  border-color: var(--dt-dark-border);
  color: #cbd5e1;
}

[data-dt-dark] .variable-pill:hover {
  border-color: #58a6ff;
  color: #60a5fa;
}

.type-note {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  margin: 0;
  font-size: 12px;
  color: var(--warning);
}

.type-note .i-lucide-alert-triangle {
  flex-shrink: 0;
  margin-top: 1px;
}

[data-dt-dark] .type-note {
  color: var(--warning-dark);
}

/* 复用 TargetField 的行内提示样式（scoped 组件内不可继承，这里补一份） */
.picker-notice {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0;
  font-size: 12px;
}

.picker-notice-icon {
  flex-shrink: 0;
}

.picker-notice-error {
  color: #dc2626;
}

.picker-notice-warn {
  color: var(--warning);
}

.picker-notice-info {
  color: #64748b;
}

[data-dt-dark] .picker-notice-error {
  color: #f87171;
}

[data-dt-dark] .picker-notice-warn {
  color: var(--warning-dark);
}

[data-dt-dark] .picker-notice-info {
  color: #8b949e;
}
</style>
