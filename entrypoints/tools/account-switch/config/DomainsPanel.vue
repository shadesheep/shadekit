<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { validateDomainUrl, isDuplicateDomain } from '../utils/validate-domain';
import SpecEditor from './SpecEditor.vue';
import LoginFormLocator from './LoginFormLocator.vue';
import { projectLegacyDefaultSpec } from '../spec/auto-login';
import { prepareLoginFormLock, type PreparedLoginFormLock } from '../login-form-lock';
import { defaultLoginSpec, type LoginSpec } from '../spec';
import { readSpecFromConfig } from '../spec/migrate';
import {
  BUILTIN_GENERIC,
  listStrategyPresets,
  matchPresetKey,
  presetTitleOf,
  slugifyKey,
  type StrategyPreset,
} from '../spec/strategy-presets';
import { validateLoginSpec } from '../spec/validate';
import { normalizeAuthWriteTemplates } from '../spec/template';
import {
  buildConfigPackage,
  validateConfigPackage,
  type ConfigPackage,
} from '../spec/package';
import { strategyTitle, upsertStrategy } from '../spec/strategy-library';
import type {
  Account,
  AccountSwitchConfig,
  DomainConfig,
  StrategyEntry,
} from '../types';
import { sendBgMessage } from '../../../shared/messages';
import type { TrialSignalState } from '../spec/run';
import { deriveEnvName, deriveEnvTag, normalizeEnvTag, type EnvTag } from '../account-env-view';
import DtDrawer from '../../../shared/components/DtDrawer.vue';
import DtButton from '../../../shared/components/DtButton.vue';
import { useOverlayClose } from '../../../shared/use-overlay-close';
import { showToast } from '../../../shared/use-toast';

/**
 * 环境（域名）表单与配置包导入向导 — 从 Config.vue 拆出的子组件
 *
 * 环境列表由 Config.vue 主视图的环境卡片承载，本组件只保留
 * 「新建/编辑/克隆环境」表单与配置包导入向导；表单不自带开关按钮，
 * 由父组件通过 expose 的 openCreate / openEdit / openClone / exportPackage /
 * openImport 驱动。
 *
 * 只持有环境表单/选择等 UI 状态，不直接写存储：
 * 增删改通过 save 事件把「新的完整 domains 记录 + 成功提示文案」交给父组件，
 * 由父组件走 updateConfig 增量合并持久化（只覆盖 domains 字段）。
 */

const props = defineProps<{
  domains: Record<string, DomainConfig>;
  /** 登录策略库（ADR-0019）：导入默认落在这里 */
  strategies?: Record<string, StrategyEntry>;
  /** 已有账号列表（「关联账号」区块复选数据源） */
  accounts?: Account[];
}>();

/** 「保存环境」事件的载荷：环境 + 关联账号变更一并交给父组件落盘 */
export interface EnvSavePayload {
  /** 新的完整 domains 记录（与 save 事件同形） */
  domains: Record<string, DomainConfig>;
  /** 本次需要新建并绑定到当前环境的账号（完整 Account 结构，id 已生成） */
  addedAccounts: Account[];
  /** 勾选的已有账号 id：父组件负责往这些账号的 domains 追加 envKey */
  boundAccountIds: string[];
  /** 编辑态下被取消勾选的已有账号 id：父组件从这些账号的 domains 移除 envKey/previousEnvKey */
  unboundAccountIds: string[];
  /** 当前环境 key（add 模式 = trimmedUrl；edit 模式可能是改后的 trimmedUrl） */
  envKey: string;
  /** 编辑模式下的原 key（新建模式为 null；key 变了时父组件按 previousEnvKey 清老绑定） */
  previousEnvKey: string | null;
  /** 成功 toast 文案（含「新增 N 个账号 / 绑定 M 个」等后缀） */
  message: string;
  /** 仅新建自动标准表单携带；基础 domains 始终保持自动 spec。 */
  lockCandidate?: PreparedLoginFormLock;
}

const emit = defineEmits<{
  save: [domains: Record<string, DomainConfig>, message: string];
  /**
   * 一次落盘多个字段（导入策略库 + 环境）：由父组件走一次 `updateConfig`，
   * 避免两次写之间的半成品状态。
   */
  savePatch: [patch: Partial<AccountSwitchConfig>, message: string];
  /** 环境保存 + 关联账号变更一并落盘（addDomain / saveEditDomain 走这里） */
  saveWithAccounts: [payload: EnvSavePayload];
}>();

/** 默认登录方式：通用登录（配方） */
const DEFAULT_LOGIN_METHOD = BUILTIN_GENERIC;

const domainFormHighlight = ref(false);

// 表单默认收起，由主视图「＋ 环境」/ 环境卡「⋯」（openCreate / openEdit / openClone）打开（右侧抽屉）
const showDomainForm = ref(false);

// 环境表单
const newDomain = ref({
  url: '',
  name: '',
  tags: [] as string[],
  loginMethod: DEFAULT_LOGIN_METHOD,
  debugRedirect: '',
  debugRedirectEnabled: false,
  defaultPassword: '',
  cookieClearIncludeParent: false,
  strategyParams: {} as Record<string, string | number | boolean | undefined>,
  spec: defaultLoginSpec() as LoginSpec,
  specMigrated: false,
  /** 读取链给出的不可用原因（旧内置登录 / 结构损坏），空串表示无 */
  specInvalid: '',
  /** 绑定的策略库条目 id（空 = 环境私有声明） */
  strategyId: '' as string,
  /** 环境级变量覆盖（ADR-0019） */
  vars: {} as Record<string, string>,
});
const editingDomain = ref<string | null>(null);
const cloningDomain = ref(false);
const savingDomain = ref(false);

// ============================================================
// 关联账号（环境抽屉底部「关联账号」区块）
// ============================================================
// 已有账号的勾选集合（Account.id）；编辑态打开时按「domains 含当前 url」初始化，
// 新建/克隆态为空集。保存时与初始集合做 diff 得出 bound/unbound。
const boundAccountIds = ref<Set<string>>(new Set());
/** 编辑态打开时 domains 含原 url 的账号 id 快照（用于 diff 出 unbound） */
const initialBoundAccountIds = ref<Set<string>>(new Set());
/** 就地新增账号的草稿行（用户名 + 密码；username 空的行保存时过滤掉） */
const newAccountDrafts = ref<Array<{ username: string; password: string }>>([]);

function toggleBoundAccount(id: string) {
  const next = new Set(boundAccountIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  boundAccountIds.value = next;
}

function addAccountDraft() {
  newAccountDrafts.value = [...newAccountDrafts.value, { username: '', password: '' }];
}

function removeAccountDraft(index: number) {
  const next = [...newAccountDrafts.value];
  next.splice(index, 1);
  newAccountDrafts.value = next;
}


// 环境标签：UI 只提供三个预设 chip（ADR-0017）；存储仍写 string[]。
// 存量数据里的自定义 tag 原样保留、原样展示（只读），不再提供手输入口。
const ENV_TAG_PRESETS: { value: EnvTag; label: string }[] = [
  { value: 'local', label: '本地' },
  { value: 'test', label: '测试' },
  { value: 'uat', label: '预发' },
  { value: 'prod', label: '生产' },
];

/** 预设是否激活：tags 里任一值归一化后命中该预设（兼容手输的中文别名） */
function isEnvTagActive(preset: EnvTag): boolean {
  return newDomain.value.tags.some((t) => normalizeEnvTag(t) === preset);
}

/** 切换预设 chip：清掉归一化到该预设的所有旧值（含别名），再写入/移除规范值 */
function toggleEnvTag(preset: EnvTag) {
  tagsTouched.value = true;
  const rest = newDomain.value.tags.filter((t) => normalizeEnvTag(t) !== preset);
  if (rest.length !== newDomain.value.tags.length) {
    newDomain.value.tags = rest;
  } else {
    newDomain.value.tags = [...rest, preset];
  }
}

/** 归一化不进的存量自定义 tag：只读展示，随表单原样落盘 */
const customTags = computed(() =>
  newDomain.value.tags.filter((t) => normalizeEnvTag(t) === undefined),
);

// URL 行内校验：失焦或提交后才展示错误，避免输入中途频繁打扰
const urlTouched = ref(false);

const trimmedUrl = computed(() => newDomain.value.url.trim());

/** 格式 + 重复校验的错误文案；null 表示合法（或未到提示时机） */
const urlError = computed(() => {
  const url = trimmedUrl.value;
  if (!url) return urlTouched.value ? '请输入域名 URL' : null;
  const formatError = validateDomainUrl(url);
  if (formatError) return formatError;
  if (isDuplicateDomain(props.domains, url, editingDomain.value)) {
    return '该域名已存在，请勿重复添加';
  }
  return null;
});

const showUrlError = computed(() => urlTouched.value && !!urlError.value);

// 名称 / 标签自动派生：新建态下只填 URL，名称取 host、tag 由 host 推断；
// 用户一旦手改（nameTouched / tagsTouched）即停止跟随。编辑/克隆不覆盖存量值。
const nameTouched = ref(false);
const tagsTouched = ref(false);

watch(trimmedUrl, (url) => {
  if (!nameTouched.value) {
    newDomain.value.name = deriveEnvName(url) ?? '';
  }
  if (!tagsTouched.value) {
    const tag = deriveEnvTag(url);
    newDomain.value.tags = tag ? [tag] : [];
  }
});

/**
 * 可选登录方式 = 内置通用登录 + 策略库 + 未入库的存量环境声明（ADR-0019）。
 *
 * 策略库是首选来源；在此之前导入的、只存在环境里的声明仍然能被归纳出来，
 * 不做强制迁移。选中库里条目时，环境只记 `strategyId` 镜像库条目（修订：
 * 不再拷贝快照，库更新即时生效；用户在本环境改过声明才落私有 spec）。
 */
const strategyOptions = computed<StrategyPreset[]>(() =>
  listStrategyPresets(props.domains, props.strategies),
);

/** 当前表单选中的策略库条目 id（generic / 未入库预设为空） */
const selectedStrategyId = computed(() => {
  const key = newDomain.value.loginMethod;
  return key !== BUILTIN_GENERIC && props.strategies?.[key] ? key : '';
});

// 认证方式选项 key 列表（仅用于判断是否渲染下拉）
const authMethodOptions = computed(() =>
  strategyOptions.value.map((o) => o.key),
);

/**
 * 下拉实际渲染的选项。
 *
 * 「环境私有声明」不是一个策略库条目，但它仍需要在下拉里有个位置——否则
 * 解绑后的环境会退回显示某条内容相同的库策略，让「是否关联」看起来没生效。
 * 当前 loginMethod 不在预设里时补一条「（环境私有）」虚拟选项。
 */
const loginMethodChoice = computed(() => {
  const key = newDomain.value.loginMethod;
  if (!key || authMethodOptions.value.includes(key)) {
    return strategyOptions.value;
  }
  return [
    ...strategyOptions.value,
    { key, title: `${presetTitleOf(newDomain.value.spec, newDomain.value.name)}（环境私有）`, spec: newDomain.value.spec, builtin: false },
  ];
});

/** 声明是否包含 cookie 清理算子（决定是否展示「含父域」开关） */
const hasClearCookies = computed(() =>
  newDomain.value.spec.ops.some((op) => op.op === 'clear.cookies'),
);

/** 可做环境级覆盖的变量：非 secret（敏感值不适合明文落进环境配置） */
const overridableVars = computed(() =>
  (newDomain.value.spec.vars ?? []).filter((v) => v.secret !== true),
);

/**
 * 当前声明是否已偏离所绑定的库条目。
 *
 * 镜像环境（未改过声明）下，此值恒为 false；用户在表单里改过声明后变为 true，
 * 保存时这份声明会作为环境私有声明落盘（脱镜）。此时库条目的进一步编辑不再
 * 影响本环境，需要去策略库卡片点「重置镜像」拉回。
 */
const specDiverged = computed(() => {
  const id = selectedStrategyId.value;
  if (!id) return false;
  const entry = props.strategies?.[id];
  if (!entry) return false;
  return JSON.stringify(entry.spec) !== JSON.stringify(newDomain.value.spec);
});

/**
 * 能否「存入策略库」：声明必须与通用登录默认模板不同（与默认模板一致的
 * 声明会被预设归纳当作通用登录跳过，入库没有意义）。已绑定且未偏离时
 * 无需再存；已偏离时允许另存为新条目。
 */
const canSaveToLibrary = computed(() => {
  if (selectedStrategyId.value && !specDiverged.value) return false;
  return (
    JSON.stringify(newDomain.value.spec) !== JSON.stringify(defaultLoginSpec())
  );
});

function setEnvVar(name: string, value: string): void {
  newDomain.value.vars = { ...newDomain.value.vars, [name]: value };
}

/** 声明被编辑：读取链的旧错误已不再描述当前表单，清掉提示 */
function onSpecChange(spec: LoginSpec): void {
  newDomain.value.spec = spec;
  specValidationError.value = '';
}
const specValidationError = ref('');

/**
 * 用户切换登录方式：套用所选预设的声明。
 * 选中策略库条目 = 建立绑定（保存时写 `strategyId` + 快照）；
 * 选中其它预设 = 只套用声明，不建立绑定（环境保持私有声明）。
 */
function onLoginMethodChange(): void {
  const key = newDomain.value.loginMethod;
  const preset = strategyOptions.value.find((p) => p.key === key);
  if (!preset) return;
  newDomain.value.strategyId = props.strategies?.[key] ? key : '';
  newDomain.value.spec = JSON.parse(JSON.stringify(preset.spec)) as LoginSpec;
  newDomain.value.specMigrated = false;
  newDomain.value.specInvalid = '';
}

/**
 * 解除与策略库的关联（ADR-0019）：只清绑定，当前声明原样保留为环境私有。
 * 不产生、不删除任何环境记录；之后编辑本环境不会影响其它环境。
 *
 * 显示名切到 `private:` 前缀的虚拟 key，让下拉明确显示「（环境私有）」，
 * 而不是继续停在一条内容相同的库策略上。
 */
function unbindStrategy(): void {
  newDomain.value.strategyId = '';
  if (newDomain.value.loginMethod !== BUILTIN_GENERIC) {
    newDomain.value.loginMethod = `private:${slugifyKey(
      presetTitleOf(newDomain.value.spec, newDomain.value.name),
    )}`;
  }
}

/**
 * 把表单当前的登录声明存入策略库（ADR-0019 的「策略独立」入口）。
 *
 * 不依赖先保存环境：即使只填了声明（甚至还没填 URL），也能先入库再复用。
 * 入库后表单切换为绑定该条目；同内容重复存入会复用已有条目（幂等）。
 */
function saveToLibrary(): void {
  const issues = validateLoginSpec(newDomain.value.spec);
  if (issues.length > 0) {
    toast(`登录声明存在校验错误，无法存入策略库：${issues[0].message}`, 'error');
    return;
  }
  const title = strategyTitle(newDomain.value.spec, newDomain.value.name);
  const upsert = upsertStrategy(props.strategies, newDomain.value.spec, title);
  // 先切到绑定态，再让父组件落盘；spec 保持不变（就是刚入库的那份）
  newDomain.value.strategyId = upsert.id;
  newDomain.value.loginMethod = upsert.id;
  emit(
    'savePatch',
    { strategies: upsert.strategies },
    upsert.created ? `已存入策略库「${title}」` : `策略已在库中「${title}」`,
  );
}

// 高级配置展开状态
const domainDrawerTitle = computed(() =>
  cloningDomain.value ? '克隆环境' : editingDomain.value ? '编辑环境' : '新建环境',
);
const showAdvanced = ref(false);
const loginFormLocatorRef = ref<{ focus: () => void } | null>(null);

function focusLoginForm(): void {
  loginFormLocatorRef.value?.focus();
}

function resetDomainForm() {
  urlTouched.value = false;
  nameTouched.value = false;
  tagsTouched.value = false;
  boundAccountIds.value = new Set();
  initialBoundAccountIds.value = new Set();
  newAccountDrafts.value = [];
  specValidationError.value = '';
  newDomain.value = {
    url: '',
    name: '',
    tags: [],
    loginMethod: DEFAULT_LOGIN_METHOD,
    debugRedirect: '',
    debugRedirectEnabled: false,
    defaultPassword: '',
    cookieClearIncludeParent: false,
    strategyParams: {},
    spec: defaultLoginSpec(),
    specMigrated: false,
    specInvalid: '',
    /** 绑定的策略库条目 id（空 = 环境私有声明） */
    strategyId: '',
    /** 环境级变量覆盖（ADR-0019）：只展示声明里非 secret 的 vars */
    vars: {} as Record<string, string>,
  };
}

/** 用表单当前值填充（编辑/克隆共用） */
function fillFormFromDomain(url: string, d: DomainConfig) {
  // 编辑/克隆：存量名称与标签原样保留，不跟随 URL 自动派生
  nameTouched.value = true;
  tagsTouched.value = true;
  newDomain.value.url = url;
  newDomain.value.name = d.name;
  newDomain.value.tags = [...d.tags];
  newDomain.value.loginMethod = d.loginMethod || DEFAULT_LOGIN_METHOD;
  newDomain.value.debugRedirect = d.debugRedirect || '';
  newDomain.value.debugRedirectEnabled = d.debugRedirectEnabled ?? false;
  newDomain.value.defaultPassword = d.defaultPassword || '';
  newDomain.value.cookieClearIncludeParent = d.cookieClearIncludeParent === true;
  // 编辑与克隆都继承原账号关联；克隆通过独立新建提交，不会改动原绑定。
  const initialBound = new Set<string>();
  for (const a of props.accounts ?? []) {
    if (a.domains.includes(url)) initialBound.add(a.id);
  }
  boundAccountIds.value = new Set(initialBound);
  initialBoundAccountIds.value = initialBound;
  newAccountDrafts.value = [];
  newDomain.value.strategyParams = {
    ...(d.strategyParams || {}),
  } as Record<string, string | number | boolean | undefined>;
  newDomain.value.vars = { ...(d.vars ?? {}) };

  // 登录声明：优先环境自己保存的 spec（导入的动态策略就靠它），否则由
  // 旧配方 / 扁平参数经迁移链升到当前版本，再退化为默认模板。
  const loginMethod = d.loginMethod || DEFAULT_LOGIN_METHOD;
  const storedSpec = d.strategyConfig?.spec;
  const presets = listStrategyPresets(props.domains, props.strategies);
  // 策略库绑定优先（ADR-0019）：绑定存在且条目还在 → 下拉直接选中该条目
  const bound = d.strategyId && props.strategies?.[d.strategyId] ? d.strategyId : '';
  newDomain.value.strategyId = bound;
  if (storedSpec) {
    newDomain.value.spec = storedSpec;
    // 归属哪条登录方式：有绑定用绑定；否则显式自定义 key 原样保留；generic
    // 但声明不是默认模板时，按内容归到对应动态预设（否则下拉会显示
    // 「通用登录」而实际跑的是导入策略）
    newDomain.value.loginMethod = bound
      ? bound
      : loginMethod !== BUILTIN_GENERIC
        ? loginMethod
        : matchPresetKey(storedSpec, d.name, presets);
    newDomain.value.specMigrated = false;
    newDomain.value.specInvalid = '';
  } else if (bound) {
    // 镜像态（ADR-0019 修订）：环境未持私有声明，把库条目读出来供表单显示；
    // 用户不动它，保存时依然不落盘（继续镜像）。
    const mirrorSpec = props.strategies?.[bound]?.spec;
    newDomain.value.spec = mirrorSpec
      ? (JSON.parse(JSON.stringify(mirrorSpec)) as LoginSpec)
      : defaultLoginSpec();
    newDomain.value.loginMethod = bound;
    newDomain.value.specMigrated = false;
    newDomain.value.specInvalid = mirrorSpec ? '' : '策略库条目缺失，请重新选择登录方式';
  } else {
    // 无内联声明（旧配方 / 扁平参数 / 已移除的内置登录 / 未配置）：
    // 统一经读取链拿 spec，拿不到就落到默认模板并回到通用登录
    const read = readSpecFromConfig(d, props.strategies);
    newDomain.value.spec = read.spec ?? defaultLoginSpec();
    newDomain.value.specMigrated = read.invalid ? false : read.migrated;
    // 「尚未配置」是新建环境的正常状态，不必告警；只有存量声明读不出来
    // （旧内置登录 / 版本过高 / 结构损坏）才把原因摆到表单上。
    const hadStrategy =
      !!d.strategyConfig ||
      loginMethod !== BUILTIN_GENERIC ||
      Object.keys(d.strategyParams ?? {}).length > 0;
    newDomain.value.specInvalid = read.invalid && hadStrategy ? read.invalid : '';
    if (read.invalid) newDomain.value.loginMethod = BUILTIN_GENERIC;
  }
  // 历史原版默认模板只在编辑器投影；原始 storage 不发生批量改写。
  newDomain.value.spec = projectLegacyDefaultSpec(newDomain.value.spec);
  // 父域清理开关以声明为准（execution 只认 clear.cookies.includeParent）
  newDomain.value.cookieClearIncludeParent = hasCookieIncludeParent(d);
}

/** 声明里任一 `clear.cookies` 勾了含父域 → 表单开关为开 */
function hasCookieIncludeParent(d: DomainConfig): boolean {
  const ops = d.strategyConfig?.spec?.ops;
  if (!ops) return false;
  return ops.some((op) => op.op === 'clear.cookies' && op.includeParent === true);
}

/**
 * 从表单构建环境条目（tags 已是数组 + 空值降级为 undefined）。
 *
 * 镜像策略（ADR-0019 修订）：绑定的环境**默认不存声明**——执行时
 * `readSpecFromConfig` 实时读库条目，库更新立即生效。只有当表单里的声明
 * 与库条目**不一致**（用户在本环境里改过）时才落 `strategyConfig.spec`，
 * 作为环境私有声明覆盖库条目（脱镜）。旧的扁平 strategyParams 不再写入。
 */
function buildDomainEntry(): DomainConfig {
  const tags = [...newDomain.value.tags];
  const spec = withCookieIncludeParent(
    newDomain.value.spec,
    newDomain.value.cookieClearIncludeParent,
  );
  const vars = Object.fromEntries(
    Object.entries(newDomain.value.vars).filter(([, value]) => value !== ''),
  );
  // 绑定时 loginMethod 记可读的策略名（不参与执行，只用于日志/下拉显示）
  const boundEntry = newDomain.value.strategyId
    ? props.strategies?.[newDomain.value.strategyId]
    : undefined;
  // 声明与库一致 → 镜像，不落 strategyConfig.spec；不一致 → 脱镜，落私有声明
  const diverged = boundEntry
    ? JSON.stringify(spec) !== JSON.stringify(boundEntry.spec)
    : false;
  return {
    name: newDomain.value.name,
    tags,
    loginMethod: boundEntry
      ? strategyTitle(boundEntry.spec, boundEntry.name)
      : newDomain.value.loginMethod || DEFAULT_LOGIN_METHOD,
    debugRedirect: newDomain.value.debugRedirect || undefined,
    debugRedirectEnabled: newDomain.value.debugRedirectEnabled || undefined,
    defaultPassword: newDomain.value.defaultPassword || undefined,
    cookieClearIncludeParent: newDomain.value.cookieClearIncludeParent || undefined,
    strategyParams: {},
    // 镜像态不写 strategyConfig；脱镜 / 未绑定时才落盘
    ...(boundEntry && !diverged ? {} : { strategyConfig: { spec } }),
    // 绑定只在策略库条目仍存在时落盘：库里已被别处删掉时不留下悬空 id
    ...(boundEntry ? { strategyId: newDomain.value.strategyId } : {}),
    ...(Object.keys(vars).length > 0 ? { vars } : {}),
  };
}

/**
 * 把「含父域」开关落到声明的 `clear.cookies` 算子上。
 * 执行器只认算子字段，环境级 flag 仅作读取兼容。
 */
function withCookieIncludeParent(spec: LoginSpec, includeParent: boolean): LoginSpec {
  return {
    ...spec,
    ops: spec.ops.map((op) =>
      op.op === 'clear.cookies'
        ? includeParent
          ? { ...op, includeParent: true }
          : { ...op, includeParent: undefined }
        : op,
    ),
  };
}

/** 表单域名对应的 origin（拾取 / 试跑挑选标签页用） */
const formOrigin = computed(() => {
  try {
    return new URL(trimmedUrl.value).origin;
  } catch {
    return undefined;
  }
});

/**
 * 保存前的结构校验：错误已在编辑器内逐行展示，这里只负责拦截。
 * 执行只认 `strategyConfig.spec`，导入的具名策略同样要过校验。
 */
function validateRecipeForSave(): boolean {
  const issues = validateLoginSpec(newDomain.value.spec);
  specValidationError.value = issues[0]
    ? `登录声明校验失败：${issues[0].message}`
    : '';
  if (issues.length === 0) return true;
  showAdvanced.value = true;
  showToast(specValidationError.value, 'error');
  return false;
}

// 环境增删改查
function cloneDomain(url: string) {
  const d = props.domains[url];
  if (!d) return;
  editingDomain.value = null;
  cloningDomain.value = true;
  urlTouched.value = false;
  showDomainForm.value = true;
  showAdvanced.value = false;
  resetDomainForm();
  fillFormFromDomain(url, d);
  newDomain.value.url = url + '-clone';
  newDomain.value.name = d.name + ' (副本)';
  domainFormHighlight.value = true;
  setTimeout(() => {
    domainFormHighlight.value = false;
  }, 2000);
}

async function addDomain() {
  urlTouched.value = true;
  if (savingDomain.value || !trimmedUrl.value || !newDomain.value.name || urlError.value) return;
  if (!validateRecipeForSave()) return;
  savingDomain.value = true;
  try {
    const entry = buildDomainEntry();
    const envKey = trimmedUrl.value;
    const addedName = newDomain.value.name || envKey;
    const next = { ...props.domains, [envKey]: entry };
    let lockCandidate: PreparedLoginFormLock | undefined;
    try {
      lockCandidate = (await prepareLoginFormLock({
        envKey,
        spec: entry.strategyConfig?.spec ?? newDomain.value.spec,
      })) ?? undefined;
    } catch {
      // 识别只是保存后的优化；任何准备异常都不阻断基础环境与账号保存。
      lockCandidate = undefined;
    }
    const payload = buildSavePayload({
      domains: next,
      envKey,
      previousEnvKey: null,
      baseMessage: `环境「${addedName}」已添加`,
    });
    if (lockCandidate) payload.lockCandidate = lockCandidate;
    resetDomainForm();
    showDomainForm.value = false;
    emit('saveWithAccounts', payload);
  } finally {
    savingDomain.value = false;
  }
}

function editDomain(url: string) {
  const d = props.domains[url];
  if (!d) return;
  editingDomain.value = url;
  cloningDomain.value = false;
  urlTouched.value = false;
  showDomainForm.value = true;
  showAdvanced.value = false;
  fillFormFromDomain(url, d);
}

function saveEditDomain() {
  urlTouched.value = true;
  if (!editingDomain.value || !trimmedUrl.value || !newDomain.value.name || urlError.value) return;
  if (!validateRecipeForSave()) return;
  const entry = buildDomainEntry();
  const previousKey = editingDomain.value;
  const next = { ...props.domains };
  if (previousKey !== trimmedUrl.value) {
    delete next[previousKey];
  }
  next[trimmedUrl.value] = entry;
  editingDomain.value = null;
  const savedName = newDomain.value.name || trimmedUrl.value;
  const payload = buildSavePayload({
    domains: next,
    envKey: trimmedUrl.value,
    previousEnvKey: previousKey,
    baseMessage: `环境「${savedName}」已保存`,
  });
  resetDomainForm();
  showDomainForm.value = false;
  emit('saveWithAccounts', payload);
}

/**
 * 组装 saveWithAccounts 载荷：
 * - addedAccounts：就地新增草稿（username 非空的行；密码允许为空走默认回退）
 * - bound / unbound：编辑态按「initialBoundAccountIds vs 当前 boundAccountIds」做 diff；
 *   新建态全部勾选都算 bound，unbound 为空。
 * - 若 url 被改（previousEnvKey && previousEnvKey !== envKey），所有 initialBound 都视为
 *   unbound（父组件按 previousEnvKey 清老绑定），bound 按当前勾选举国到新 key。
 */
function buildSavePayload(args: {
  domains: Record<string, DomainConfig>;
  envKey: string;
  previousEnvKey: string | null;
  baseMessage: string;
}): EnvSavePayload {
  const { domains, envKey, previousEnvKey, baseMessage } = args;

  const addedAccounts: Account[] = newAccountDrafts.value
    .filter((d) => d.username.trim())
    .map((d, i) => ({
      id: 'acc_' + Date.now() + '_' + i,
      name: d.username.trim(),
      username: d.username.trim(),
      password: d.password,
      roles: [],
      domains: [envKey],
    }));

  const currentBound = new Set(boundAccountIds.value);
  let boundAccountIdsList: string[] = [];
  let unboundAccountIdsList: string[] = [];
  if (previousEnvKey === null) {
    // 新建：所有勾选项都是新增绑定
    boundAccountIdsList = [...currentBound];
  } else if (previousEnvKey !== envKey) {
    // 编辑改名：老 key 的初始绑定全部解除（父组件按 previousEnvKey 清），
    // 当前勾选举国到新 key
    unboundAccountIdsList = [...initialBoundAccountIds.value];
    boundAccountIdsList = [...currentBound];
  } else {
    // 编辑同名：diff 初始 vs 当前
    for (const id of currentBound) {
      if (!initialBoundAccountIds.value.has(id)) boundAccountIdsList.push(id);
    }
    for (const id of initialBoundAccountIds.value) {
      if (!currentBound.has(id)) unboundAccountIdsList.push(id);
    }
  }

  const parts = [baseMessage];
  if (addedAccounts.length > 0) parts.push(`新增 ${addedAccounts.length} 个账号`);
  if (boundAccountIdsList.length > 0) parts.push(`绑定 ${boundAccountIdsList.length} 个账号`);
  if (unboundAccountIdsList.length > 0) parts.push(`解绑 ${unboundAccountIdsList.length} 个账号`);

  return {
    domains,
    addedAccounts,
    boundAccountIds: boundAccountIdsList,
    unboundAccountIds: unboundAccountIdsList,
    envKey,
    previousEnvKey,
    message: parts.join('，'),
  };
}

function cancelEditDomain() {
  editingDomain.value = null;
  cloningDomain.value = false;
  resetDomainForm();
  showDomainForm.value = false;
}

/** 打开「新建环境」空表单（主视图「＋ 环境」入口） */
function openCreate() {
  editingDomain.value = null;
  cloningDomain.value = false;
  resetDomainForm();
  showAdvanced.value = false;
  showDomainForm.value = true;
}

// 由父组件（主视图环境卡）驱动的入口
defineExpose({
  openCreate,
  openEdit: editDomain,
  openClone: cloneDomain,
  focusLoginForm,
  exportPackage: exportConfigPackage,
  openImport: importConfigPackage,
});

// ============================================================
// 配置包导入导出
// 与「备份整份配置（含账号密码）」是两条不同入口：这里只导出登录声明
// + 非敏感变量，不含账号绑定、不含明文密码、不含可执行代码（script）。
// ============================================================

/** 一次性弹出文件选择；返回文本或 null（用户取消） */
function pickJsonFile(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) resolve(null);
      else {
        file
          .text()
          .then((t) => resolve(t))
          .catch(() => resolve(null));
      }
    };
    input.click();
  });
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 配置包操作统一使用全局可见 Toast。 */
function toast(message: string, type: 'success' | 'error' = 'success') {
  showToast(message, type);
}

/** 需要随包分发的变量 = spec.vars 里非 secret 的全部名字（接收方都可填写） */
function availableRequiredVars(spec: LoginSpec): string[] {
  return (spec.vars ?? [])
    .filter((v) => v.secret !== true)
    .map((v) => v.name);
}

function exportConfigPackage(url: string) {
  const d = props.domains[url];
  if (!d) return;
  // 镜像环境不持 spec 拷贝，从库条目回落读取
  const spec =
    d.strategyConfig?.spec ??
    (d.strategyId ? props.strategies?.[d.strategyId]?.spec : undefined);
  if (!spec) {
    toast(`环境「${d.name}」没有可导出的登录声明`, 'error');
    return;
  }
  // 导出前结构校验（R1–R7），失败的声明不让分发
  const specIssues = validateLoginSpec(spec);
  if (specIssues.length > 0) {
    toast(`环境「${d.name}」的登录声明存在校验错误，无法导出登录策略包`, 'error');
    return;
  }
  const result = buildConfigPackage(d, url, availableRequiredVars(spec), props.strategies);
  if (result.issues.length > 0 || !result.package) {
    const first = result.issues[0]?.message ?? '未知错误';
    toast(`无法导出登录策略包：${first}`, 'error');
    return;
  }
  downloadText(
    `dt-login-config-${(d.name || url).replace(/[^a-zA-Z0-9_-]/g, '-')}.json`,
    JSON.stringify(result.package, null, 2),
  );
  toast(`已导出环境「${d.name}」的登录策略包`);
}

/**
 * 导入配置包：校验 → 打开「导入向导」→ 确认后才落地。
 *
 * 导入目标（ADR-0019）：
 * - **仅存入策略库**（默认）：只新增策略条目，不产生任何环境记录；
 * - **存入策略库并创建环境**：把勾选的包内环境也落地，并绑定到刚入库的策略。
 *
 * 未确认前不产生任何环境；冲突环境在向导里标出，默认不勾选（避免误覆盖），
 * 可手动勾选覆盖。
 */
async function importConfigPackage() {
  const text = await pickJsonFile();
  if (!text) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    toast('登录策略包不是合法 JSON', 'error');
    return;
  }
  const issues = validateConfigPackage(parsed);
  if (issues.length > 0) {
    const first = issues[0];
    toast(
      `导入被拒绝：${first.message}` +
        (first.opIndex !== undefined ? `（第 ${first.opIndex + 1} 步）` : ''),
      'error',
    );
    return;
  }
  const pkg = parsed as ConfigPackage;
  // 初始化导入向导：每个环境一条计划，非冲突默认勾选，冲突默认不勾选
  importPlan.value = pkg.environments.map((env) => {
    const rawUrl = env.url.trim();
    // 字面 `{origin}` 占位：skill 产出的策略把真实服务地址留空（无法提前知道
    // 用户环境），提升为「环境地址」必填，落地时用它作环境 key——
    // 否则环境 key 是 `{origin}` 永远匹配不上真实页面。
    const needsEnvUrl = rawUrl === '{origin}';
    const url = needsEnvUrl ? '' : rawUrl;
    const taken = url !== '' && !!props.domains[url];
    const vars: Record<string, string> = {};
    for (const rv of env.requiredVars) vars[rv.name] = '';
    return {
      url,
      name: env.name,
      spec: env.spec,
      conflict: taken,
      checked: !taken,
      requiredVars: env.requiredVars,
      values: vars,
      needsEnvUrl,
      envUrlValue: '',
    };
  });
  // 默认只入库、不建环境：导入一份策略不应在环境列表里留下痕迹（ADR-0019）
  importCreatesEnv.value = false;
  showImportDialog.value = true;
}

interface ImportPlanItem {
  url: string;
  name: string;
  spec: LoginSpec;
  conflict: boolean;
  checked: boolean;
  requiredVars: ConfigPackage['environments'][number]['requiredVars'];
  /** 用户为本环境的每个 requiredVar 填写的值 */
  values: Record<string, string>;
  /** url 是字面 `{origin}` 占位，需用户填真实环境地址 */
  needsEnvUrl: boolean;
  /** needsEnvUrl 时用户填的地址（作环境 key） */
  envUrlValue: string;
}

const showImportDialog = ref(false);
// 遮罩空白处点击关闭：mousedown+click 同源才触发，见 useOverlayClose 说明
const importOverlay = useOverlayClose(() => { showImportDialog.value = false; });
const importPlan = ref<ImportPlanItem[]>([]);
/**
 * 导入时是否同时创建包内环境（ADR-0019）。
 * 默认 false：策略先入库、不碰环境列表；勾选后每个环境绑定到入库的策略。
 * 同时创建环境时，包里的 `requiredVars` 填值归属**环境**（写 `DomainConfig.vars`），
 * 不烘进共享声明——否则同一策略绑多个环境会互相污染。
 */
const importCreatesEnv = ref(false);

/**
 * 确认导入：策略一律入库；环境仅在勾选「同时创建环境」时落地。
 * 未勾选的包内环境一律不产生（零半成品）。
 */
function confirmImport() {
  const nextStrategies: Record<string, StrategyEntry> = {
    ...(props.strategies ?? {}),
  };
  const nextDomains: Record<string, DomainConfig> = { ...props.domains };
  let added = 0;
  let addedStrategies = 0;
  for (const item of importPlan.value) {
    // 导入容错：把「cookie value 为字面 JSON 对象」这类手写包的结构花括号自动
    // 转义（{{/}}），再落地，保证存盘的是合法模板（escapeLiteralBraces）
    const normalizedSpec = normalizeAuthWriteTemplates(item.spec) as LoginSpec;
    const title = strategyTitle(
      normalizedSpec,
      item.name || DEFAULT_LOGIN_METHOD,
    );
    // 策略入库：同内容幂等复用（重复导入同一份包不会堆条目）
    const upsert = upsertStrategy(nextStrategies, normalizedSpec, title);
    if (upsert.created) addedStrategies += 1;
    Object.assign(nextStrategies, upsert.strategies);
    // 冲突环境默认不勾选；勾选即覆盖（向导里已标注）
    if (!importCreatesEnv.value || !item.checked) continue;
    // 字面 `{origin}` 占位：用用户填的真实地址作环境 key，
    // 否则 key 是 `{origin}` 永远匹配不上真实页面
    const url = item.needsEnvUrl ? item.envUrlValue.trim() : item.url;
    if (url === '') {
      toast(`环境「${item.name}」缺少地址，未创建（策略已入库）`, 'error');
      continue;
    }
    const vars: Record<string, string> = {};
    for (const rv of item.requiredVars) {
      const value = item.values[rv.name];
      if (value !== undefined && value !== '') vars[rv.name] = value;
    }
    nextDomains[url] = {
      name: item.name,
      tags: [],
      // 绑定入库的策略：只写 strategyId，不存声明（ADR-0019 修订：镜像）
      loginMethod: title,
      strategyId: upsert.id,
      ...(Object.keys(vars).length > 0 ? { vars } : {}),
    };
    added += 1;
  }
  showImportDialog.value = false;
  if (addedStrategies === 0 && added === 0) {
    // 全部条目都幂等命中且未创建环境：不算失败，明确告知即可
    toast('策略已在库中，未新增环境');
    return;
  }
  const parts: string[] = [];
  if (addedStrategies > 0) parts.push(`${addedStrategies} 条登录策略`);
  if (added > 0) parts.push(`${added} 个环境`);
  emit(
    'savePatch',
    {
      strategies: nextStrategies,
      ...(added > 0 ? { domains: nextDomains } : {}),
    },
    `已导入 ${parts.join('，')}`,
  );
}

// ============================================================
// 试登录：在后台试跑一次登录请求，默认零副作用。
// 不提交保存、不写会话（除非勾选）、不触达当前标签页。
// ============================================================

/** 试登录表单：只用于试跑，不落盘 */
const trialCred = ref({ username: '', password: '' });
/** 试登录运行时是否写入会话（「能换到凭据」→「已登录」） */
const trialWriteSession = ref(false);
const trialRunning = ref(false);
const trialResult = ref<{
  ok: boolean;
  error?: string;
  errorCode?: string;
  signals: TrialSignalState[];
  requestSent: boolean;
  sessionWritten: boolean;
} | null>(null);

function trialError(code?: string, message?: string): string {
  const prefix = code ? `错误码 ${code}：` : '';
  return prefix + (message ?? '试登录失败');
}

/** 试登录是否可用于当前表单：地址合法即可（执行只认 spec，与登录方式标签无关） */
const trialAvailable = computed(() => {
  if (!trimmedUrl.value || urlError.value) return false;
  return true;
});

/** 发起试登录；由编辑器当前声明的 spec 执行（未保存也会用当前编辑态试跑） */
async function runTrialLogin(): Promise<void> {
  if (trialRunning.value) return;
  if (!trialAvailable.value) return;
  if (!trimmedUrl.value) return;
  // 试登录前先校验（R1–R7），配置错误不发请求
  const issues = validateLoginSpec(newDomain.value.spec);
  if (issues.length > 0) {
    trialResult.value = {
      ok: false,
      error: '登录声明存在校验错误，请先修复（' + issues[0].message + '）',
      errorCode: 'CONFIG_INVALID',
      signals: [],
      requestSent: false,
      sessionWritten: false,
    };
    return;
  }
  trialRunning.value = true;
  trialResult.value = null;
  try {
    const res = await sendBgMessage('TRIAL_LOGIN', {
      spec: newDomain.value.spec,
      origin: trimmedUrl.value,
      username: trialCred.value.username,
      password: trialCred.value.password,
      writeSession: trialWriteSession.value,
    });
    trialResult.value = {
      ok: res.ok,
      ...(res.error ? { error: res.error } : {}),
      ...(res.errorCode ? { errorCode: res.errorCode } : {}),
      signals: res.signals ?? [],
      requestSent: res.requestSent,
      sessionWritten: res.sessionWritten,
    };
  } catch (e) {
    trialResult.value = {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      signals: [],
      requestSent: false,
      sessionWritten: false,
    };
  } finally {
    trialRunning.value = false;
  }
}
</script>

<template>
  <div>
    <DtDrawer :show="showDomainForm" :title="domainDrawerTitle" @close="cancelEditDomain">
      <div class="form-card domain-form" :class="{ 'form-card-highlight': domainFormHighlight }">
      <div class="form-row">
        <label for="domain-url">域名 / URL</label>
        <input
          id="domain-url"
          class="dt-input"
          :class="{ 'input-invalid': showUrlError }"
          v-model="newDomain.url"
          @blur="urlTouched = true"
          placeholder="例: http://localhost:8888"
        />
        <p v-if="showUrlError" class="field-error">
          <span class="i-lucide-alert-circle w-3.5 h-3.5" />{{ urlError }}
        </p>
      </div>
      <div class="form-row">
        <label for="domain-name">名称</label>
        <input id="domain-name" class="dt-input" v-model="newDomain.name" @input="nameTouched = true" placeholder="留空按 URL 的 host 自动填充" />
      </div>
      <div class="form-row">
        <label id="domain-tags-label">标签</label>
        <div class="domain-chip-selector" role="group" aria-labelledby="domain-tags-label">
          <button
            v-for="p in ENV_TAG_PRESETS"
            :key="p.value"
            type="button"
            :class="['domain-chip', { selected: isEnvTagActive(p.value) }]"
            :aria-pressed="isEnvTagActive(p.value)"
            :aria-label="`环境标签：${p.label}`"
            @click="toggleEnvTag(p.value)"
          >{{ p.label }}</button>
          <span v-for="t in customTags" :key="t" class="env-tag" title="存量自定义标签（只读）">{{ t }}</span>
        </div>
      </div>
      <div v-if="authMethodOptions.length > 0" class="form-row">
        <label for="domain-login-strategy">登录策略</label>
        <select id="domain-login-strategy" class="dt-input" v-model="newDomain.loginMethod" @change="onLoginMethodChange">
          <option v-for="opt in loginMethodChoice" :key="opt.key" :value="opt.key">{{ opt.title }}</option>
        </select>
        <!-- 关联策略库时的状态与解除入口（ADR-0019）：解绑只摘引用，不产生环境 -->
        <p v-if="selectedStrategyId" class="field-hint strategy-bound-hint">
          <span class="i-lucide-link w-3 h-3 mr-1" />
          <template v-if="specDiverged">
            已关联策略库条目，但本环境的登录声明已修改并保存为环境私有版本，仅本环境生效；库里的「重置镜像」会覆盖这些修改。
          </template>
          <template v-else>
            已关联策略库条目；当前登录声明未偏离库版本，会继续跟随库版本更新。
          </template>
          <button type="button" class="strategy-unbind" @click="unbindStrategy">解除关联</button>
        </p>
        <p v-else-if="strategyOptions.length > 2" class="field-hint">策略库条目会出现在这里，选中即关联并套用其登录声明（保存后可再编辑环境私有副本）。</p>
      </div>
      <LoginFormLocator
        class="form-row"
        ref="loginFormLocatorRef"
        :spec="newDomain.spec"
        :origin="formOrigin"
        :mirrored="!!newDomain.strategyId"
        @change="onSpecChange"
      />
      <!-- 读取链拒绝的存量声明（如旧内置登录）：给出可操作指引，不静默降级 -->
      <p v-if="newDomain.specInvalid" class="risk-note spec-invalid-note">
        <span class="i-lucide-alert-triangle w-3.5 h-3.5" />{{ newDomain.specInvalid }}
      </p>

      <!-- 关联账号：勾选已有账号绑定到本环境；也可就地新增账号（保存环境时一并落盘） -->
      <div class="form-row env-accounts-row">
        <label id="domain-accounts-label">关联账号 <span class="optional">（选填）</span></label>
        <!-- 已有账号复选列表 -->
        <div v-if="(accounts ?? []).length > 0" class="domain-chip-selector" role="group" aria-labelledby="domain-accounts-label">
          <button
            v-for="a in accounts"
            :key="a.id"
            type="button"
            :class="['domain-chip', { selected: boundAccountIds.has(a.id) }]"
            :title="a.username"
            :aria-pressed="boundAccountIds.has(a.id)"
            :aria-label="`关联账号：${a.name || a.username}`"
            @click="toggleBoundAccount(a.id)"
          >{{ a.name || a.username }}</button>
        </div>
        <p v-else class="field-hint">还没有账号；可以在下面就地新增，保存时一并创建并绑定到本环境。</p>

        <!-- 就地新增账号草稿 -->
        <div v-if="newAccountDrafts.length > 0" class="env-account-draft-list">
          <div v-for="(d, i) in newAccountDrafts" :key="i" class="env-account-draft-row">
            <input
              class="dt-input"
              v-model="d.username"
              placeholder="用户名"
              :aria-label="`新账号 ${i + 1} 的用户名`"
              autocomplete="off"
            />
            <input
              class="dt-input"
              v-model="d.password"
              type="password"
              placeholder="密码（留空走环境/全局默认）"
              :aria-label="`新账号 ${i + 1} 的密码`"
              autocomplete="off"
            />
            <button
              type="button"
              class="env-account-draft-remove"
              title="移除该草稿"
              :aria-label="`移除新账号草稿 ${i + 1}`"
              @click="removeAccountDraft(i)"
            >
              <div class="i-lucide-x w-4 h-4" />
            </button>
          </div>
        </div>
        <div class="env-account-actions">
          <DtButton size="sm" variant="secondary" @click="addAccountDraft">
            <div class="i-lucide-plus w-4 h-4 mr-1" />新建账号
          </DtButton>
        </div>
      </div>

      <!-- 试登录暂时隐藏，保留实现，恢复时放回完整区域
      <div class="form-row trial-login-row">
        <div class="trial-inputs">
          <label class="trial-label">试登录</label>
          <input
            class="dt-input"
            v-model="trialCred.username"
            placeholder="测试账号"
            autocomplete="off"
          />
          <input
            class="dt-input"
            v-model="trialCred.password"
            type="password"
            placeholder="测试密码"
            autocomplete="off"
          />
          <DtButton
            size="sm"
            :class="{ 'btn-trial': !trialAvailable }"
            :disabled="trialRunning || !trialAvailable"
            @click="runTrialLogin"
          >
            <div :class="trialRunning ? 'i-lucide-loader w-3.5 h-3.5 mr-1 anim-spin' : 'i-lucide-flask-conical w-3.5 h-3.5 mr-1'" />
            {{ trialRunning ? '试登录中…' : '验证配置' }}
          </DtButton>
          <label class="inline-check" title="勾选后才会向目标站点写入会话（登录态）。未勾选时只发请求验证配置，不写任何凭据">
            <input type="checkbox" v-model="trialWriteSession" />
            写入会话
          </label>
        </div>
        <p class="trial-hint">
          后台试发一次登录请求验证配置。默认不写会话、不跳转、不触达当前标签页。
        </p>
        <div v-if="trialResult" class="trial-result" :class="{ 'trial-ok': trialResult.ok, 'trial-fail': !trialResult.ok }">
          <div class="trial-result-head">
            <span :class="trialResult.ok ? 'i-lucide-check-circle w-3.5 h-3.5' : 'i-lucide-alert-circle w-3.5 h-3.5'" />
            <span>
              {{ trialResult.ok ? (trialResult.sessionWritten ? '已登录（与会话）' : '请求成功，可换到凭据') : trialError(trialResult.errorCode, trialResult.error) }}
            </span>
          </div>
          <ul v-if="trialResult.signals.length > 0" class="trial-signals">
            <li v-for="(s, si) in trialResult.signals" :key="si" :class="s.met ? 'sig-met' : 'sig-unmet'">
              <span :class="s.met ? 'i-lucide-check w-3 h-3' : 'i-lucide-x w-3 h-3'" />
              {{ s.description }} · {{ s.met ? '已命中' : '未命中' }}
            </li>
          </ul>
          <p v-else class="trial-signals-empty">
            <span class="i-lucide-info w-3 h-3" />
            {{ trialResult.ok ? '请求已成功发出' : '未发出请求' }}
            {{ trialResult.requestSent ? '' : '（未触达目标站点）' }}
          </p>
        </div>
      </div>
      -->

      <!-- 高级配置（可折叠）：默认密码、本地 Bug 复现地址、登录声明等低频设置 -->
      <div class="advanced-settings-section">
        <button type="button" class="advanced-toggle-btn" :aria-expanded="showAdvanced" aria-controls="domain-advanced-settings" @click="showAdvanced = !showAdvanced">
          <div :class="showAdvanced ? 'i-lucide-chevron-down w-4 h-4' : 'i-lucide-chevron-right w-4 h-4'" />
          <span>高级配置</span>
          <span class="optional">（默认密码 / 本地复现 / 登录声明等）</span>
        </button>
        <div id="domain-advanced-settings" v-show="showAdvanced" class="advanced-content">
          <div class="form-row">
            <label for="domain-default-password">默认密码 <span class="optional">（选填，快捷登录时可仅输入 URL + 账号）</span></label>
            <input id="domain-default-password" class="dt-input" v-model="newDomain.defaultPassword" type="password" placeholder="留空表示不使用默认密码" />
            <p class="field-hint">密码优先级：用户输入 &gt; 环境默认 &gt; 全局默认</p>
          </div>

          <!-- 本地 Bug 复现地址：替换测试链接的域名和端口，保留后续完整 URL -->
          <div class="form-row">
            <label for="domain-debug-redirect">本地 Bug 复现地址 <span class="optional">（选填，填写本地项目的完整页面 URL）</span></label>
            <input id="domain-debug-redirect" class="dt-input" v-model="newDomain.debugRedirect" placeholder="例: http://localhost:3000/web/#/home/..." />
            <p class="field-hint">将测试链接的域名和端口替换为本地项目的对应值，后续路径、Hash 路由和查询参数全部保留；使用测试账号登录后自动打开。</p>
          </div>
          <div class="form-row" v-if="newDomain.debugRedirect">
            <label for="domain-debug-redirect-enabled">登录后打开复现页面</label>
            <div class="debug-redirect-toggle">
              <label class="toggle-switch">
                <input id="domain-debug-redirect-enabled" v-model="newDomain.debugRedirectEnabled" type="checkbox" />
                <span class="toggle-slider" />
              </label>
              <span class="toggle-label">{{ newDomain.debugRedirectEnabled ? '已启用' : '已禁用' }}</span>
            </div>
          </div>

          <!-- 登录声明编辑器（三层视图）：内置与导入的策略都可编辑 -->
          <div class="form-row recipe-form-row">
            <label id="domain-spec-label">
              登录声明
              <button
                v-if="canSaveToLibrary"
                type="button"
                class="strategy-save-link"
                :title="specDiverged ? '把修改后的声明另存为一条新策略' : '把这份声明存入策略库，供其它环境复用（不产生环境记录）'"
                @click="saveToLibrary"
              >{{ specDiverged ? '另存为新策略' : '存入策略库' }}</button>
            </label>
            <p v-if="specValidationError" class="field-error" role="alert">{{ specValidationError }}</p>
            <SpecEditor
              :spec="newDomain.spec"
              :origin="formOrigin"
              :migrated="newDomain.specMigrated"
              @change="onSpecChange"
            />
          </div>
          <!-- 环境级变量覆盖（ADR-0019）：同一份策略绑多个环境时，差异放这里 -->
          <div v-if="overridableVars.length > 0" class="form-row">
            <label id="domain-vars-label">变量覆盖 <span class="optional">（选填，优先于声明里的默认值，只影响本环境）</span></label>
            <div v-for="variable in overridableVars" :key="variable.name" class="env-var-row">
              <label class="env-var-name" :for="`domain-var-${variable.name}`" :title="variable.name">{{ variable.title || variable.name }}</label>
              <input
                :id="`domain-var-${variable.name}`"
                class="dt-input"
                :value="newDomain.vars[variable.name] ?? ''"
                :placeholder="variable.default ? `默认：${variable.default}` : '未设置'"
                @input="setEnvVar(variable.name, ($event.target as HTMLInputElement).value)"
              />
            </div>
          </div>
          <!-- 本域 Cookie 清理范围（ADR-0012 D8）：声明里有 clear.cookies 才展示 -->
          <div v-if="hasClearCookies" class="form-row">
            <label for="domain-cookie-parent">清除 Cookie 时包含父域</label>
            <div class="strategy-bool-toggle">
              <label class="toggle-switch">
                <input id="domain-cookie-parent" v-model="newDomain.cookieClearIncludeParent" type="checkbox" />
                <span class="toggle-slider" />
              </label>
              <span class="toggle-label">{{ newDomain.cookieClearIncludeParent ? '含父域' : '仅当前域名' }}</span>
            </div>
            <p v-if="newDomain.cookieClearIncludeParent" class="risk-note">
              <span class="i-lucide-alert-triangle w-3.5 h-3.5" />
              含父域会同时清除如 example.com 上的 Cookie，可能影响同域其他系统的登录态。
            </p>
          </div>
        </div>
      </div>
      <div class="form-actions">
        <DtButton v-if="!editingDomain" variant="primary" :disabled="savingDomain" @click="addDomain">
          <div class="i-lucide-plus w-4 h-4 mr-1" />{{ savingDomain ? '保存中…' : cloningDomain ? '创建副本' : '添加环境' }}
        </DtButton>
        <DtButton v-else variant="primary" @click="saveEditDomain">保存环境</DtButton>
        <DtButton variant="secondary" :disabled="savingDomain" @click="cancelEditDomain">取消</DtButton>
      </div>
      </div>
    </DtDrawer>

    <!-- 配置包导入向导：逐个环境勾选 + 填写 requiredVars，确认后才落地 -->
    <div
      v-if="showImportDialog"
      class="import-dialog-overlay"
      @mousedown="importOverlay.onOverlayMousedown"
      @click="importOverlay.onOverlayClick"
    >
      <div class="import-dialog-card">
        <h3 class="import-dialog-title">
          <div class="i-lucide-download w-4 h-4 mr-1" />导入登录策略包
        </h3>
        <p class="import-dialog-hint">策略一律存入策略库；需要时再勾选「同时创建环境」把包内环境一并落地。</p>

        <!-- 导入目标（ADR-0019）：默认只入库，不产生环境记录 -->
        <div class="import-dest">
          <label class="import-dest-option">
            <input type="radio" :value="false" v-model="importCreatesEnv" />
            仅存入策略库<span class="optional">（不新增任何环境）</span>
          </label>
          <label class="import-dest-option">
            <input type="radio" :value="true" v-model="importCreatesEnv" />
            同时创建环境<span class="optional">（勾选下方条目，绑定到入库的策略）</span>
          </label>
        </div>

        <template v-if="importCreatesEnv">
          <p class="import-dialog-hint">勾选要创建/覆盖的环境；地址为 {origin} 占位的策略请填真实地址，并为需要填写的变量输入值。</p>
          <div class="import-env-list">
            <div v-for="(item, idx) in importPlan" :key="idx" class="import-env-item" :class="{ 'import-env-conflict': item.conflict }">
              <div class="import-env-head">
                <label class="import-env-check">
                  <input type="checkbox" v-model="item.checked" />
                  <span class="import-env-name">
                    {{ item.name }}
                    <span v-if="item.conflict" class="import-conflict-tag">地址已占用（将覆盖）</span>
                  </span>
                </label>
                <span v-if="!item.needsEnvUrl" class="import-env-url">{{ item.url }}</span>
              </div>
              <!-- 字面 {origin} 占位：策略把真实地址留空，需用户填写，落地才有关联上的实际 key -->
              <div v-if="item.needsEnvUrl" class="import-vars">
                <div class="import-var-row">
                  <label :for="`import-env-url-${idx}`">
                    环境地址<span class="optional">（登录/API 根地址）</span>
                  </label>
                  <input
                    :id="`import-env-url-${idx}`"
                    class="dt-input"
                    type="text"
                    placeholder="填写真实登录/API 地址，如 https://app.example.com"
                    v-model="item.envUrlValue"
                  />
                </div>
              </div>
              <div v-if="item.requiredVars.length > 0" class="import-vars">
                <div v-for="rv in item.requiredVars" :key="rv.name" class="import-var-row">
                  <label :for="`import-var-${idx}-${rv.name}`">
                    {{ rv.title || rv.name }}
                    <span class="optional">（{{ rv.name }}）</span>
                  </label>
                  <input :id="`import-var-${idx}-${rv.name}`" class="dt-input" :type="rv.name.toLowerCase().includes('key') || rv.name.toLowerCase().includes('secret') ? 'password' : 'text'"
                    :placeholder="`填写 ${rv.title || rv.name}`" v-model="item.values[rv.name]" />
                </div>
              </div>
            </div>
            <div v-if="importPlan.length === 0" class="empty-import-plan">登录策略包不含可导入的环境</div>
          </div>
        </template>
        <div class="form-actions">
          <DtButton variant="primary" @click="confirmImport">
            <div class="i-lucide-check w-4 h-4 mr-1" />{{ importCreatesEnv ? '导入策略并创建环境' : '存入策略库' }}
          </DtButton>
          <DtButton variant="secondary" @click="showImportDialog = false">取消</DtButton>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
@import '../../../shared/component-styles.scss';
@import './config-panel-shared.scss';

/* 抽屉表单：统一字段节奏与控件高度，嵌套编辑器也沿用同一尺寸。 */
.domain-form > .form-row {
  margin-bottom: 16px;
}

.domain-form > .form-row > label {
  margin-bottom: 6px;
  line-height: 18px;
}

.domain-form :deep(.dt-input) {
  box-sizing: border-box;
  min-height: 32px;
  line-height: 18px;
}

.domain-form :deep(textarea.dt-input) {
  min-height: 80px;
}

.domain-form :deep(.dt-button) {
  box-sizing: border-box;
  min-height: 32px;
}

.domain-form :deep(.domain-chip) {
  box-sizing: border-box;
  min-height: 28px;
}

/* 高级配置区域 */
.advanced-settings-section {
  margin-top: 16px;
  border-top: 1px solid #e2e8f0;
  padding-top: 12px;
}
.domain-form button.domain-chip {
  font: inherit;
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
  margin-top: 12px;
  padding-left: 8px;
}

/* 抽屉内表单提交区：与全页操作区一致靠右，覆盖共享 .form-actions 默认左对齐 */
.form-actions {
  justify-content: flex-end;
  border-top: 1px solid #f1f5f9;
  padding-top: 14px;
  margin-top: 4px;
}

[data-dt-dark] .form-actions {
  border-top-color: var(--dt-dark-border, #30363d);
}

.optional {
  font-size: 12px;
  color: #94a3b8;
  font-weight: normal;
}

/* 字段级提示（密码优先级贴密码框旁） */
.field-hint {
  font-size: 12px;
  color: #94a3b8;
  margin: 6px 0 0;
  line-height: 1.5;
}

[data-dt-dark] .field-hint {
  color: #6e7681;
}

/* URL 行内校验错误 */
.dt-input.input-invalid {
  border-color: #dc2626;
}

.dt-input.input-invalid:focus {
  border-color: #dc2626;
  box-shadow: 0 0 0 2px rgba(220, 38, 38, 0.1);
}

[data-dt-dark] .dt-input.input-invalid,
[data-dt-dark] .dt-input.input-invalid:focus {
  border-color: #f87171;
}

[data-dt-dark] .dt-input.input-invalid:focus {
  box-shadow: 0 0 0 2px rgba(248, 113, 113, 0.15);
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

.recipe-form-row {
  display: block;
}

.recipe-form-row :deep(label) {
  font-weight: 600;
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

/* 存量声明不可读的提示（旧内置登录）：独立成行，与上方字段拉开距离 */
.spec-invalid-note {
  margin: 0 0 12px;
  padding: 8px 10px;
  border: 1px solid rgba(180, 83, 9, 0.2);
  border-radius: 8px;
  background: rgba(180, 83, 9, 0.06);
}

[data-dt-dark] .spec-invalid-note {
  border-color: rgba(251, 191, 36, 0.25);
  background: rgba(251, 191, 36, 0.08);
}

/* Debug redirect toggle */
.debug-redirect-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
  padding: 8px 12px;
  border-radius: 8px;
  background: rgba(99, 102, 241, 0.04);
  border: 1px solid rgba(99, 102, 241, 0.08);
  transition: all 0.2s ease;
}

.debug-redirect-toggle:hover {
  background: rgba(99, 102, 241, 0.08);
}

[data-dt-dark] .debug-redirect-toggle {
  background: rgba(99, 102, 241, 0.08);
  border-color: rgba(99, 102, 241, 0.12);
}

/* 布尔设置与开关标签保持同一行；覆盖 .form-row label 的块级样式。 */
.strategy-bool-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  cursor: pointer;
  user-select: none;
}

.debug-redirect-toggle .toggle-switch,
.strategy-bool-toggle .toggle-switch {
  flex-shrink: 0;
  margin-bottom: 0;
}

.toggle-label {
  font-size: 12px;
  color: #64748b;
  font-weight: 500;
}

[data-dt-dark] .toggle-label {
  color: #8b949e;
}

/* 配置包导入向导 */
.import-dialog-overlay {
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

.import-dialog-card {
  width: 100%;
  max-width: 520px;
  max-height: 80vh;
  overflow-y: auto;
  background: #fff;
  border-radius: 12px;
  border: 1px solid #e2e8f0;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.2);
  padding: 20px;
}

[data-dt-dark] .import-dialog-card {
  background: var(--dt-dark-surface-1, #161b22);
  border-color: var(--dt-dark-border);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
}

.import-dialog-title {
  display: flex;
  align-items: center;
  font-size: 16px;
  font-weight: 600;
  color: #0f172a;
  margin: 0 0 6px;
}

[data-dt-dark] .import-dialog-title {
  color: #f1f5f9;
}

.import-dialog-hint {
  font-size: 13px;
  color: #64748b;
  margin: 0 0 14px;
}

.import-env-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 导入目标（ADR-0019）：策略库 / 策略库 + 环境 */
.import-dest {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
  padding: 10px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #f8fafc;
}

[data-dt-dark] .import-dest {
  border-color: var(--dt-dark-border);
  background: var(--dt-dark-surface-hover);
}

.import-dest-option {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #0f172a;
  cursor: pointer;
}

[data-dt-dark] .import-dest-option {
  color: #f1f5f9;
}

/* 策略库绑定状态（ADR-0019） */
.strategy-bound-hint {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  color: #3b82f6;
}

[data-dt-dark] .strategy-bound-hint {
  color: #60a5fa;
}

.strategy-unbind,
.strategy-save-link {
  padding: 0;
  border: 0;
  background: transparent;
  font: inherit;
}

.strategy-unbind {
  margin-left: 4px;
  color: #dc2626;
  cursor: pointer;
  text-decoration: underline;
}

/* 「存入策略库」按钮：与字段标签同行，弱化为主操作之外的可选动作 */
.strategy-save-link {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 500;
  color: #3b82f6;
  cursor: pointer;
  text-decoration: underline;
}

[data-dt-dark] .strategy-save-link {
  color: #60a5fa;
}

[data-dt-dark] .strategy-unbind {
  color: #f87171;
}

/* 环境级变量覆盖（ADR-0019） */
.env-var-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.env-var-name {
  flex: 0 0 120px;
  font-size: 12px;
  color: #64748b;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

[data-dt-dark] .env-var-name {
  color: #8b949e;
}

.import-env-item {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 10px 12px;
  transition: all 0.15s ease-out;
}

[data-dt-dark] .import-env-item {
  border-color: var(--dt-dark-border);
}

.import-env-item.import-env-conflict {
  border-color: #f59e0b;
  background: rgba(245, 158, 11, 0.06);
}

.import-env-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.import-env-check {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  color: #0f172a;
}

[data-dt-dark] .import-env-check {
  color: #f1f5f9;
}

.import-conflict-tag {
  font-size: 12px;
  font-weight: 400;
  color: var(--warning);
  background: rgba(245, 158, 11, 0.15);
  border-radius: 9999px;
  padding: 1px 8px;
}

.import-env-url {
  font-size: 12px;
  color: #94a3b8;
  word-break: break-all;
}

.import-vars {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.import-var-row label {
  display: block;
  font-size: 12px;
  color: #64748b;
  margin-bottom: 4px;
}

.empty-import-plan {
  text-align: center;
  color: #94a3b8;
  font-size: 13px;
  padding: 16px 0;
}

/* ===== 关联账号（环境抽屉底部） ===== */
.env-account-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}

.env-accounts-row .domain-chip-selector {
  margin-bottom: 8px;
}

.env-account-draft-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
}

.env-account-draft-row {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  gap: 6px;
  align-items: center;
}

.env-account-draft-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  color: #64748b;
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.15s ease-out;
}

.env-account-draft-remove:hover {
  color: #dc2626;
  background: #fee2e2;
  border-color: #fecaca;
}

[data-dt-dark] .env-account-draft-remove {
  color: #8b949e;
}
[data-dt-dark] .env-account-draft-remove:hover {
  color: #f87171;
  background: rgba(248, 113, 113, 0.12);
  border-color: rgba(248, 113, 113, 0.3);
}

/* ===== 试登录 ===== */
.trial-login-row {
  border-radius: 10px;
  padding: 10px 12px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
}
[data-dt-dark] .trial-login-row {
  background: var(--dt-dark-surface-hover);
  border-color: var(--dt-dark-border);
}
.trial-inputs {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.trial-label {
  font-size: 12px;
  font-weight: 600;
  color: #475569;
  flex-shrink: 0;
}
[data-dt-dark] .trial-label {
  color: #cbd5e1;
}
.trial-inputs .dt-input {
  max-width: 160px;
}
.btn-trial {
  opacity: .5;
}
.anim-spin {
  animation: dt-spin 1s linear infinite;
}
@keyframes dt-spin {
  to { transform: rotate(360deg); }
}
.trial-hint {
  margin: 6px 0 0;
  font-size: 12px;
  color: #94a3b8;
}
[data-dt-dark] .trial-hint {
  color: #64748b;
}
.trial-result {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 12px;
}
.trial-ok {
  background: rgba(22, 163, 74, .08);
  border: 1px solid rgba(22, 163, 74, .25);
  color: #16a34a;
}
.trial-fail {
  background: rgba(220, 38, 38, .06);
  border: 1px solid rgba(220, 38, 38, .2);
  color: #dc2626;
}
[data-dt-dark] .trial-ok { color: #4ade80; }
[data-dt-dark] .trial-fail { color: #f87171; }
.trial-result-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
}
.trial-signals {
  margin: 6px 0 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.trial-signals li {
  display: flex;
  align-items: center;
  gap: 4px;
}
.trial-signals-empty {
  margin: 6px 0 0;
  display: flex;
  align-items: center;
  gap: 4px;
  opacity: .8;
}
</style>
