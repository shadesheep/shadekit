<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { showToast } from "../../shared/use-toast";
import {
  collectRoleFilterOptions,
  collectRoles,
  environmentLoginSupport,
  ROLE_NAMES,
  roleColorStyle,
  supportReason,
} from "./account-view";
import { accountInitial } from "./account-palette";
import { accountPasswordSummary } from "./account-password-state";
import { buildEnvGroups, normalizeEnvTag, removeEnvironment } from "./account-env-view";
import { sendBgMessage } from "../../shared/messages";
import { validateLoginSpec } from "./spec/validate";
import { readSpecFromConfig } from "./spec/migrate";
import type { SpecSupportReport } from "./spec/capabilities";
import {
  finalizeNewEnvironmentSave,
  newEnvironmentSaveMessage,
} from "./login-form-lock";
import { showLoginRecoveryToast } from "./login-recovery-toast";
import { guardConfigSavePatch } from "./config-save-guard";
import { resolveRequestedEnv } from "../../options/options-route";
import { LOGIN_BUSY_ERROR } from "./utils/error-codes";
import type {
  Account,
  AccountSwitchConfig,
  DomainConfig,
  EnvBadgeConfig,
  EnvBadgePosition,
  StrategyEntry,
} from "./types";
import DtConfigItem from "../../shared/config/DtConfigItem.vue";
import DtToggle from "../../shared/config/DtToggle.vue";
import DtSegmented from "../../shared/config/DtSegmented.vue";
import {
  formatShortcut,
  getShortcutSettingsPageUrl,
  SHORTCUT_SUGGESTED,
} from "../../shared/command-shortcut";
import { useCommandShortcut } from "../../shared/use-command-shortcut";
import DomainsPanel, { type EnvSavePayload } from "./config/DomainsPanel.vue";
import StrategyLibrary from "./config/StrategyLibrary.vue";
import EnvironmentIdentity from "./config/EnvironmentIdentity.vue";
import DtButton from "../../shared/components/DtButton.vue";
import DtDrawer from "../../shared/components/DtDrawer.vue";
import DtPanel from "../../shared/components/DtPanel.vue";
import DtEmptyState from "../../shared/components/DtEmptyState.vue";

const props = defineProps<{ editEnv?: string }>();
const emit = defineEmits<{
  editEnvConsumed: [];
  importBackup: [text: string];
}>();


// 主视图（环境卡片）为默认视图；设置页承载环境指示器等次级配置
const activeTab = ref<"main" | "strategies" | "settings">("main");
const config = ref<AccountSwitchConfig>({
  accounts: [],
  domains: {},
  strategies: {},
});
const showBadgeEnvironments = ref(false);
const quickLoginDefaultDomain = ref("");
const globalDefaultPassword = ref("");
// 加载失败时表单停在空集合：必须阻断所有保存/编辑/导入入口，避免覆盖真实数据。
const loadError = ref("");

const formHighlight = ref(false);

// 快捷键状态（ADR-0001 D4 可见性底线：安装时被占用会静默注册失败，此处检测并引导）
const { shortcut, restoring, canRestore, refresh, restoreSuggested } =
  useCommandShortcut();
// macOS 显示 ⌥⇧A，其他平台显示 Alt+Shift+A
const suggestedShortcut = formatShortcut(SHORTCUT_SUGGESTED);
// chrome:// / edge:// 不允许编程式打开，只能提示用户粘贴
const shortcutSettingsUrl = getShortcutSettingsPageUrl();
const shortcutUpdateError = ref("");

async function handleRestoreShortcut() {
  shortcutUpdateError.value = "";
  try {
    await restoreSuggested();
  } catch (e) {
    shortcutUpdateError.value = e instanceof Error ? e.message : "恢复失败";
  }
}

// 表单默认收起，由「＋ 账号」/「编辑」/「克隆」/「换环境」按需展开（右侧抽屉）
const showAccountForm = ref(false);

// 账号表单
const newAccount = ref({
  name: "",
  username: "",
  password: "",
  roles: [] as string[],
  domains: [] as string[],
});
const editingAccount = ref<string | null>(null);
const customRoleInput = ref("");
// 角色自由文本收进「更多」：默认只展示 3 个预设 chip
const showCustomRole = ref(false);
// 「显示密码」开关（环境与账号页顶部）：默认开启，持久化到配置；
// 控制密码输入框显示明文还是掩码。
const showPasswords = ref(true);
const accountFormError = ref("");

watch(() => newAccount.value.username, () => {
  accountFormError.value = "";
});

const hasGlobalDefaultPassword = computed(() =>
  Boolean(config.value.globalDefaultPassword),
);

// 预定义角色与角色色同源（account-view，ADR-0004 D6）
// 新增账号表单的 chip 列表直接用 roleChipOptions（预设 + 已用自定义，
// 定义在下方 computed 区，随账号数据动态更新）。

function cloneAccount(id: string) {
  const acc = config.value.accounts.find((a) => a.id === id);
  if (!acc) return;
  editingAccount.value = null;
  accountFormError.value = "";
  showAccountForm.value = true;
  newAccount.value = {
    name: acc.name + " (副本)",
    username: acc.username,
    password: acc.password ?? "",
    roles: [...acc.roles],
    domains: [...acc.domains],
  };
  formHighlight.value = true;
  setTimeout(() => {
    formHighlight.value = false;
  }, 2000);
}

function toggleDomain(domainUrl: string) {
  const idx = newAccount.value.domains.indexOf(domainUrl);
  if (idx === -1) newAccount.value.domains.push(domainUrl);
  else newAccount.value.domains.splice(idx, 1);
}

const domainOptions = computed(() => {
  const domains =
    config.value.domains && typeof config.value.domains === "object"
      ? config.value.domains
      : {};
  return Object.entries(domains).map(([url, d]) => ({
    url,
    name: (d as any).name || url,
  }));
});

async function loadConfig(): Promise<boolean> {
  try {
    const response = await sendBgMessage("ACCOUNT_CONFIG_GET");
    if (!response.success || !response.config) {
      loadError.value = response.error || "配置读取失败";
      return false;
    }
    const data = response.config;
    config.value = {
      ...(data ?? {}),
      accounts: Array.isArray(data?.accounts) ? data.accounts : [],
      domains:
        data?.domains && typeof data.domains === "object" ? data.domains : {},
      // 策略库（ADR-0019）：与账户/环境同住一个 key，备份与同步天然覆盖
      strategies:
        data?.strategies && typeof data.strategies === "object"
          ? data.strategies
          : {},
      // 指示器配置入响应式，由设置页管理角标显示。
      envBadge: data?.envBadge,
    };

    // tabOrder 存储字段保留（SwitcherPanel 仍读取），本页不再提供配置 UI
    quickLoginDefaultDomain.value = data?.quickLoginDefaultDomain || "";
    globalDefaultPassword.value = data?.globalDefaultPassword || "";
    showPasswords.value = data?.showPasswords !== false;
    loadError.value = "";
    return true;
  } catch (error: unknown) {
    loadError.value = error instanceof Error ? error.message : "配置读取失败";
    return false;
  }
}

async function retryLoad(): Promise<void> {
  if (await loadConfig()) {
    configReady.value = true;
    void refresh();
  }
}

/** 深拷贝当前账号列表（避免把响应式对象交给 storage / 后续内存修改污染已写数据） */
function accountsPatch(): Pick<AccountSwitchConfig, "accounts"> {
  return { accounts: JSON.parse(JSON.stringify(config.value.accounts)) };
}

/**
 * 字段级增量保存：读最新 → 只覆盖 patch 中的字段 → 写回。
 *
 * 多开 options 页同时修改不同字段（如 A 页改账号、B 页改环境）时，
 * 整体写回会用本页的过期内存状态覆盖另一页的修改；增量合并只动本次
 * 修改的字段，双方修改都能保留。
 *
 * @returns 是否写入成功；失败时 updateConfig 已通过 toast 提示用户，
 *          调用方不应再展示「已保存」类假反馈
 */
async function saveFields(
  patch: Partial<AccountSwitchConfig>,
): Promise<boolean> {
  const guardedPatch = guardConfigSavePatch(loadError.value, patch);
  if (!guardedPatch) {
    showToast("配置未成功加载，已阻止保存以免覆盖现有数据", "error");
    return false;
  }
  try {
    const sanitizedPatch = JSON.parse(JSON.stringify(guardedPatch)) as Partial<AccountSwitchConfig>;
    const response = await sendBgMessage("ACCOUNT_CONFIG_SAVE", {
      patch: sanitizedPatch,
    });
    if (!response.success || !response.config) {
      showToast(response.error || "保存配置失败", "error");
      return false;
    }
    config.value = {
      ...config.value,
      ...response.config,
    };
    globalDefaultPassword.value = response.config.globalDefaultPassword ?? "";
    return true;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "未知错误";
    console.error("[account-switch] 保存配置失败:", msg);
    return false;
  }
}

/**
 * 保存配置，且仅在写入成功时展示成功提示
 * （失败提示由 updateConfig 统一弹出，此处不重复、不出现假成功）
 */
async function saveWithFeedback(
  patch: Partial<AccountSwitchConfig>,
  successMessage: string,
): Promise<void> {
  if (await saveFields(patch)) {
    showToast(successMessage, "success");
  }
}

/** 切换「显示密码」：先更新 UI（输入框立即响应），再持久化到配置。 */
async function setShowPasswords(next: boolean) {
  if (showPasswords.value === next) return;
  showPasswords.value = next;
  await saveWithFeedback(
    { showPasswords: next },
    next ? "密码已显示" : "密码已隐藏",
  );
}

// 环境增删改查由 DomainsPanel 承载，这里只负责落盘（只覆盖 domains 字段）
async function onDomainsSave(
  domains: Record<string, DomainConfig>,
  message: string,
): Promise<void> {
  config.value.domains = domains;
  await saveWithFeedback({ domains }, message);
}

/**
 * 环境保存 + 关联账号变更一并落盘（DomainsPanel 的 addDomain / saveEditDomain）：
 * - domains 整体替换；
 * - accounts 追加 addedAccounts，并按 boundAccountIds/unboundAccountIds
 *   往已有账号的 domains 里追加/移除 envKey（编辑改名时同时按 previousEnvKey 清老 key）。
 */
async function requestEnvironmentPermission(environmentId: string): Promise<void> {
  const response = await sendBgMessage("REQUEST_ENVIRONMENT_PERMISSIONS", { environmentId });
  if (!response?.success) {
    showToast(response?.error || "环境权限未授予，登录前请重新授权", "error");
  }
}

async function onEnvSaveWithAccounts(payload: EnvSavePayload): Promise<void> {
  const { envKey, previousEnvKey } = payload;
  const keysToUnbind = new Set<string>(
    previousEnvKey && previousEnvKey !== envKey
      ? [previousEnvKey, envKey]
      : [envKey],
  );
  const boundSet = new Set(payload.boundAccountIds);
  const unboundSet = new Set(payload.unboundAccountIds);

  const nextAccounts: Account[] = config.value.accounts.map((a) => {
    let domains = a.domains;
    if (unboundSet.has(a.id)) {
      domains = domains.filter((d) => !keysToUnbind.has(d));
    }
    if (boundSet.has(a.id) && !domains.includes(envKey)) {
      domains = [...domains, envKey];
    }
    if (domains === a.domains) return a;
    return { ...a, domains };
  });
  nextAccounts.push(...payload.addedAccounts);

  const saveBase = () =>
    saveFields({ domains: payload.domains, accounts: nextAccounts });
  if (previousEnvKey === null) {
    const result = await finalizeNewEnvironmentSave({
      candidate: payload.lockCandidate,
      saveBase,
      reload: async () => {
        await loadConfig();
      },
    });
    if (result.saved) {
      showToast(newEnvironmentSaveMessage(result.lockStatus), "success");
      await requestEnvironmentPermission(envKey);
    }
      return;
  }

  if (await saveBase()) {
    await loadConfig();
    showToast(payload.message, "success");
    await requestEnvironmentPermission(envKey);
  }
}

/** DomainsPanel 的多字段落盘（导入策略库 + 环境一次写入，ADR-0019） */
async function onDomainsPatch(
  patch: Partial<AccountSwitchConfig>,
  message: string,
): Promise<void> {
  if (patch.domains) config.value.domains = patch.domains;
  if (patch.strategies) config.value.strategies = patch.strategies;
  await saveWithFeedback(patch, message);
}

/** 策略库变更（设置页策略卡：编辑 / 删除 / 同步） */
async function onStrategiesSave(
  strategies: Record<string, StrategyEntry>,
  message: string,
): Promise<void> {
  config.value.strategies = strategies;
  await saveWithFeedback({ strategies }, message);
}

// 账号增删改查
function toggleRole(role: string) {
  const idx = newAccount.value.roles.indexOf(role);
  if (idx === -1) newAccount.value.roles.push(role);
  else newAccount.value.roles.splice(idx, 1);
}

function addCustomRole() {
  const role = customRoleInput.value.trim();
  if (role && !newAccount.value.roles.includes(role)) {
    newAccount.value.roles.push(role);
    customRoleInput.value = "";
  }
}

function removeRole(role: string) {
  newAccount.value.roles = newAccount.value.roles.filter((r) => r !== role);
}

/**
 * 新增/编辑统一校验：只需用户名；
 * 名称为空时默认 = 用户名；密码不强制（走 用户输入 > 环境默认 > 全局默认 回退）。
 */
function accountFormValues(): { name: string; username: string } | null {
  const username = newAccount.value.username.trim();
  if (!username) {
    accountFormError.value = "请输入登录用户名";
    void nextTick(() => document.getElementById("account-username")?.focus());
    return null;
  }
  accountFormError.value = "";
  return { name: newAccount.value.name.trim() || username, username };
}

async function addAccount() {
  const values = accountFormValues();
  if (!values) return;
  config.value.accounts.push({
    id: "acc_" + Date.now(),
    name: values.name,
    username: values.username,
    ...(newAccount.value.password ? { password: newAccount.value.password } : {}),
    roles: [...newAccount.value.roles],
    domains: [...newAccount.value.domains],
  });
  const addedName = values.name;
  newAccount.value = {
    name: "",
    username: "",
    password: "",
    roles: [],
    domains: [],
  };
  customRoleInput.value = "";
  showAccountForm.value = false;
  await saveWithFeedback(accountsPatch(), `账号「${addedName}」已添加`);
}

function editAccount(id: string) {
  const acc = config.value.accounts.find((a) => a.id === id);
  if (!acc) return;
  editingAccount.value = id;
  accountFormError.value = "";
  showAccountForm.value = true;
  newAccount.value = {
    name: acc.name,
    username: acc.username,
    password: acc.password ?? "",
    roles: [...acc.roles],
    domains: [...acc.domains],
  };
}

async function saveEditAccount() {
  const values = accountFormValues();
  if (!editingAccount.value || !values) return;
  const acc = config.value.accounts.find((a) => a.id === editingAccount.value);
  if (acc) {
    acc.name = values.name;
    acc.username = values.username;
    if (newAccount.value.password) {
      acc.password = newAccount.value.password;
    } else {
      delete acc.password;
    }
    acc.roles = [...newAccount.value.roles];
    acc.domains = [...newAccount.value.domains];
  }
  editingAccount.value = null;
  const savedAccountName = values.name;
  newAccount.value = {
    name: "",
    username: "",
    password: "",
    roles: [],
    domains: [],
  };
  customRoleInput.value = "";
  showAccountForm.value = false;
  await saveWithFeedback(
    accountsPatch(),
    `账号「${savedAccountName}」已保存`,
  );
}

function cancelEditAccount() {
  editingAccount.value = null;
  newAccount.value = {
    name: "",
    username: "",
    password: "",
    roles: [],
    domains: [],
  };
  customRoleInput.value = "";
  accountFormError.value = "";
}

async function deleteAccount(id: string) {
  const acc = config.value.accounts.find((a) => a.id === id);
  if (!acc) return;
  if (
    !confirm(
      `确定删除账号「${acc.name}」（用户名 ${acc.username}）？该账号在所有环境下的绑定会一并移除。`,
    )
  )
    return;
  config.value.accounts = config.value.accounts.filter((a) => a.id !== id);
  await saveWithFeedback(accountsPatch(), `账号「${acc.name}」已删除`);
}

// ============================================================
// 主视图：环境筛选与账号表格
// 渲染数据来源只有 buildEnvGroups 投影；UI 不自行遍历 config.domains。
// ============================================================
const envGroups = computed(() => buildEnvGroups(config.value));
// 每次配置/策略变化都重新从原始声明派生；不落盘 support 标志。
const envSupports = computed(() =>
  Object.fromEntries(
    Object.entries(config.value.domains ?? {}).map(([key, env]) => [
      key,
      environmentLoginSupport(env, config.value.strategies),
    ]),
  ) as Record<string, SpecSupportReport>,
);
function envSupportOf(key: string): SpecSupportReport {
  return envSupports.value[key] ?? { supported: true, issues: [] };
}
const envCount = computed(() => envGroups.value.groups.length);
const accountCount = computed(() => config.value.accounts.length);
// 初次进入（0 环境 0 账号）：只显示空态引导卡，不渲染空的轨道+表格骨架
const isEmptyState = computed(
  () => envCount.value === 0 && accountCount.value === 0,
);

// ----- 主视图：左侧环境筛选、搜索与角色组合过滤 -----
// 状态：环境过滤（'all' | envKey | 'unbound'）、搜索、角色
type EnvFilter = "all" | "unbound" | string;
const envFilter = ref<EnvFilter>("all");
const query = ref("");
const roleFilter = ref("");

function environmentLabel(env: DomainConfig): string {
  const tag = env.tags?.map(normalizeEnvTag).find(Boolean);
  const type = tag ? { local: "本地", test: "测试", uat: "预发", prod: "生产" }[tag] : "";
  return type ? `${env.name} · ${type}` : env.name;
}

// 删除或导入环境后，不保留已失效的筛选 key。
watch(() => config.value.domains, domains => {
  if (envFilter.value !== "all" && envFilter.value !== "unbound" && !domains[envFilter.value]) {
    envFilter.value = "all";
  }
}, { deep: true });

const bindingAccountId = ref<string | null>(null);
const bindingAccount = computed(() => config.value.accounts.find(account => account.id === bindingAccountId.value));

function accountEnvironmentSummary(account: Account): string {
  const envs = accEnvList(account);
  const first = envs.find(item => item.key === envFilter.value) ?? envs[0];
  if (!first) return "未关联环境";
  return `${environmentLabel(first.env)}${envs.length > 1 ? ` +${envs.length - 1}` : ""}`;
}

function showEnvironmentAccounts(key: string) {
  envFilter.value = key;
  bindingAccountId.value = null;
  closeMenu();
}

const hasAnyAccountFilters = computed(() => envFilter.value !== "all" || hasAccountFilters.value);
function clearAllAccountFilters() {
  envFilter.value = "all";
  clearAccountFilters();
}

/** 账号当前生效的环境 key：编辑表单的预填用「首个绑定」，验证/登录取对应环境 */
function accFallbackEnv(
  acc: Account,
): { key: string; env: DomainConfig } | null {
  // 若处于具体环境过滤中，优先用该环境；
  // 否则用账号首个绑定（多对多取第一个做 fallback；未绑定返回 null）
  if (
    envFilter.value &&
    envFilter.value !== "all" &&
    envFilter.value !== "unbound"
  ) {
    const f = config.value.domains[envFilter.value];
    if (f && acc.domains.includes(envFilter.value)) {
      return { key: envFilter.value, env: f };
    }
  }
  const first = acc.domains.find((d) => config.value.domains[d]);
  return first ? { key: first, env: config.value.domains[first] } : null;
}

/** 账号在任意绑定保留的多对多过滤：envFilter + roleFilter + query 三条件组合 */
const filteredAccounts = computed(() => {
  const q = query.value.trim().toLowerCase();
  return config.value.accounts.filter((acc) => {
    if (envFilter.value === "unbound") {
      if (acc.domains.some((d) => config.value.domains[d])) return false;
    } else if (envFilter.value !== "all") {
      if (!acc.domains.includes(envFilter.value as string)) return false;
    }
    if (roleFilter.value && !acc.roles.includes(roleFilter.value)) return false;
    if (q) {
      if (
        !acc.name.toLowerCase().includes(q) &&
        !acc.username.toLowerCase().includes(q)
      ) {
        return false;
      }
    }
    return true;
  });
});

const hasAccountFilters = computed(() => Boolean(query.value.trim() || roleFilter.value));
const emptyAccountMessage = computed(() => {
  if (hasAccountFilters.value) return "没有符合搜索或角色筛选的账号";
  if (envFilter.value === "unbound") return "所有账号都已关联环境";
  if (envFilter.value !== "all") return "该环境还没有关联账号";
  return "还没有账号";
});

function clearAccountFilters() {
  query.value = "";
  roleFilter.value = "";
}

function handleEmptyAccountAction() {
  if (hasAccountFilters.value) clearAccountFilters();
  else addAccountToView();
}

/** 账号绑定的环境列表（多对多反查 config.domains，按绑定顺序） */
function accEnvList(acc: Account): Array<{ key: string; env: DomainConfig }> {
  return acc.domains
    .map((d) => ({ key: d, env: config.value.domains[d] }))
    .filter((e) => e.env);
}

/** 角色筛选选项：按现有账号数据中实际出现的角色展示（预设角色在前，自定义角色在后） */
const roleFilterOptions = computed(() =>
  collectRoleFilterOptions(config.value.accounts),
);

/**
 * 新增账号表单的角色 chip 候选：预设 3 个 + 已用自定义角色（去重，预设在前）。
 * 与 collectRoleFilterOptions 不同：未被任何账号使用的预设角色也展示，
 * 因为这是「新增账号可勾选」而非「过滤现有账号」。
 */
const roleChipOptions = computed(() => {
  const used = collectRoles(config.value.accounts);
  const custom = used.filter((r) => !ROLE_NAMES.includes(r));
  return [...ROLE_NAMES, ...custom];
});

// 角色数据变化后（编辑/删除账号）当前筛选角色可能已不存在，自动清除避免表格永久为空
watch(roleFilterOptions, (roles) => {
  if (roleFilter.value && !roles.includes(roleFilter.value))
    roleFilter.value = "";
});

/** ⋯ 菜单「验证」：落到账号第一个绑定的环境（未绑定账号不出此菜单项，见模板 v-if） */
function verifyMenuAccount(acc: Account) {
  const fb = accFallbackEnv(acc);
  if (!fb) return;
  verifyAccount(fb.key, fb.env, acc);
}

/** 表格行验证结果查询：envKey::accId（与 verifyAccount 落点一致） */
function rowVerify(acc: Account): VerifyState | undefined {
  const fb = accFallbackEnv(acc);
  if (!fb) return undefined;
  return verifyStateOf(fb.key, acc.id);
}

/** ⋯ 菜单「登录」：落到账号第一个绑定的环境 */
function loginMenuAccount(acc: Account) {
  const fb = accFallbackEnv(acc);
  if (!fb) return;
  void loginAccount(fb.key, acc);
}

/** 环境 key ⇒ DomainConfig（供环境上下文工具条） */
function envOfKey(key: string): DomainConfig {
  return config.value.domains[key];
}

/** 环境 key ⇒ 该环境账号数组（供验证环境） */
function groupsOfKey(key: string): Account[] {
  return envGroups.value.groups.find((g) => g.key === key)?.accounts ?? [];
}

const enabledEnvironmentCount = computed(() =>
  Object.values(config.value.domains).filter((env) => env.enabled !== false).length,
);

/** 轨道项到对应「＋账号」/菜单环境 key 的统一入口（用当前过滤） */
function railEnvKey(): string | null {
  if (envFilter.value === "all" || envFilter.value === "unbound") return null;
  return envFilter.value as string;
}

/** 主视图「＋ 账号」/「＋ 环境」预填：轨道选中某环境时预填该环境，否则空白 */
function addAccountToView() {
  const k = railEnvKey();
  if (k) {
    addAccountForEnv(k);
  } else {
    cancelEditAccount();
    newAccount.value.domains = [];
    showAccountForm.value = true;
  }
}

// ----- 环境编辑入口：复用 DomainsPanel 的表单与导入向导 -----
interface DomainsPanelExpose {
  openCreate: () => void;
  openEdit: (url: string) => void;
  openClone: (url: string) => void;
  exportPackage: (url: string) => void;
  openImport: () => void;
  focusLoginForm: () => void;
}
const domainsPanelRef = ref<DomainsPanelExpose | null>(null);
const configReady = ref(false);

async function openRequestedEnvironment(editEnv: string): Promise<void> {
  const envKey = resolveRequestedEnv(config.value.domains, editEnv);
  if (!envKey) {
    showToast("未找到要编辑的环境，可能已被删除或地址已修改", "error");
  } else {
    activeTab.value = "main";
    domainsPanelRef.value?.openEdit(envKey);
    await nextTick();
    domainsPanelRef.value?.focusLoginForm();
  }
  emit("editEnvConsumed");
}

watch([() => props.editEnv, configReady], ([editEnv, ready]) => {
  if (ready && editEnv) void openRequestedEnvironment(editEnv);
});

async function deleteEnv(key: string) {
  const env = config.value.domains[key];
  if (!env) return;
  const bound =
    envGroups.value.groups.find((g) => g.key === key)?.accounts.length ?? 0;
  if (
    !confirm(
      `确定删除环境「${env.name}」（${key}）？\n` +
        `该环境下的 ${bound} 个账号不会被删除，但会失去这个环境的绑定。`,
    )
  )
    return;
  const next = removeEnvironment(config.value, key);
  config.value.domains = next.domains;
  config.value.accounts = next.accounts;
  await saveWithFeedback(next, `环境「${env.name}」已删除`);
}

/** 「＋ 账号」：卡内直接给该环境加账号（环境预填为当前卡） */
function addAccountForEnv(envKey: string) {
  cancelEditAccount();
  newAccount.value.domains = [envKey];
  showAccountForm.value = true;
}

function closeAccountForm() {
  cancelEditAccount();
  showAccountForm.value = false;
}

// ----- 「⋯」菜单（账号行：编辑/克隆/删除/换环境；环境卡头：编辑/克隆/导出登录策略包/删除） -----
// 菜单采用 position: fixed + 触发按钮视口坐标定位：脱离 .env-table-scroll 的滚动上下文，
// 避免 absolute 菜单把定高滚动容器「撑长」（滚动条随菜单出现被拉高）。
const openMenu = ref<string | null>(null);
const menuPos = ref<{ top: number; right: number } | null>(null);
let menuTrigger: HTMLElement | null = null;

function toggleMenu(key: string, ev: MouseEvent) {
  if (openMenu.value === key) {
    closeMenu();
    return;
  }
  const trigger = ev.currentTarget as HTMLElement;
  const btn = trigger.getBoundingClientRect();
  menuTrigger = trigger;
  menuPos.value = {
    top: Math.round(btn.bottom + 4),
    right: Math.round(window.innerWidth - btn.right),
  };
  openMenu.value = key;
  void nextTick(() => {
    document.getElementById(`${key}:menu`)?.querySelector("button")?.focus();
  });
}

function closeMenu(restoreFocus = false) {
  openMenu.value = null;
  menuPos.value = null;
  if (restoreFocus) menuTrigger?.focus();
  if (restoreFocus) menuTrigger = null;
}

function handleMenuKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeMenu(true);
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const menu = event.currentTarget as HTMLElement;
  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
  if (items.length === 0) return;
  event.preventDefault();
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home"
    ? 0
    : event.key === "End"
      ? items.length - 1
      : event.key === "ArrowDown"
        ? (current + 1 + items.length) % items.length
        : (current - 1 + items.length) % items.length;
  items[next].focus();
}

const handleDocumentClick = () => closeMenu();

// ----- 当前环境启停：与环境角标的全局设置独立 -----
const savingEnvironment = ref(false);

async function setEnvironmentEnabled(key: string, enabled: boolean) {
  const environment = config.value.domains[key];
  if (!environment || savingEnvironment.value) return;
  savingEnvironment.value = true;
  try {
    await saveWithFeedback({
      domains: { ...config.value.domains, [key]: { ...environment, enabled } },
    }, `环境「${environment.name}」已${enabled ? "启用" : "停用"}`);
  } finally {
    savingEnvironment.value = false;
  }
}

const DEFAULT_ENV_BADGE: EnvBadgeConfig = {
  enabled: false,
  position: "bottom-right",
  whitelist: [],
};
const envBadge = computed<EnvBadgeConfig>(
  () => config.value.envBadge ?? DEFAULT_ENV_BADGE,
);

// ----- 设置页：环境指示器区块（Config Kit / ADR-0007 Auto-save 范式） -----
// whitelist 仅控制角标范围：空 = 全部已启用环境
const POSITION_OPTIONS: Array<{ value: EnvBadgePosition; label: string }> = [
  { value: "top-left", label: "左上" },
  { value: "top-right", label: "右上" },
  { value: "bottom-left", label: "左下" },
  { value: "bottom-right", label: "右下" },
];

const badgePreviewName = computed(() => {
  const environment = domainOptions.value.find((option) =>
    envBadge.value.whitelist.length === 0 || envBadge.value.whitelist.includes(option.url),
  );
  return environment?.name || "环境名称";
});
const selectedBadgeEnvironmentCount = computed(() =>
  domainOptions.value.filter((option) => envBadge.value.whitelist.includes(option.url)).length,
);
const quickLoginSummary = computed(() => {
  const environment = domainOptions.value.find((option) => option.url === quickLoginDefaultDomain.value);
  const target = quickLoginDefaultDomain.value
    ? `默认环境：${environment?.name || "未匹配到环境"}`
    : "未设置默认环境";
  return `${target} · ${hasGlobalDefaultPassword.value ? "密码已设置" : "未设置全局密码"}`;
});

/** 显示范围：白名单空 = 全部已配置环境 */
const badgeScope = computed<"all" | "selected">(() =>
  envBadge.value.whitelist.length === 0 ? "all" : "selected",
);

async function saveEnvBadge(next: EnvBadgeConfig) {
  config.value.envBadge = next;
  await saveWithFeedback({ envBadge: next }, "设置已保存");
}

function setEnvBadgeEnabled(enabled: boolean) {
  void saveEnvBadge({ ...envBadge.value, enabled });
}

function setEnvBadgePosition(position: EnvBadgePosition) {
  void saveEnvBadge({ ...envBadge.value, position });
}

function setBadgeScope(scope: "all" | "selected") {
  const current = envBadge.value;
  if (scope === "all") {
    if (current.whitelist.length === 0) return;
    void saveEnvBadge({ ...current, whitelist: [] });
  } else if (current.whitelist.length === 0) {
    // 切到「仅这些环境」时物化当前生效集合（空白名单语义=全部），
    // 避免勾选列表全空却被读作「全部」的歧义
    void saveEnvBadge({
      ...current,
      whitelist: Object.keys(config.value.domains),
    });
  }
}

function handleWhitelistChange(key: string, event: Event) {
  toggleWhitelist(key);
  // 拒绝取消最后一项时也还原原生复选框状态。
  (event.target as HTMLInputElement).checked = envBadge.value.whitelist.includes(key);
}

function toggleWhitelist(key: string) {
  const current = envBadge.value;
  const whitelist = current.whitelist.includes(key)
    ? current.whitelist.filter((k) => k !== key)
    : [...current.whitelist, key];
  if (whitelist.length === 0) {
    showToast("至少保留 1 个环境；如需全部关闭，请关闭「启用环境角标」", "info");
    return;
  }
  void saveEnvBadge({ ...current, whitelist });
}

/** 存量默认环境值不在当前环境列表里（环境已删/改名）时原样显示并标注 */
const quickLoginDomainUnmatched = computed(
  () =>
    quickLoginDefaultDomain.value !== "" &&
    !(quickLoginDefaultDomain.value in config.value.domains),
);

// ----- 行内验证（复用 TRIAL_LOGIN，默认零副作用：不写会话/不跳转/不碰当前标签页） -----
interface VerifyState {
  status: "running" | "ok" | "fail";
  /** 一句话结论：成功时为「能换到凭据」/「已登录」，失败时为原因 */
  message: string;
}
const verifyStates = ref<Record<string, VerifyState>>({});
const verifyKey = (envKey: string, accId: string) => `${envKey}::${accId}`;

function verifyStateOf(envKey: string, accId: string): VerifyState | undefined {
  return verifyStates.value[verifyKey(envKey, accId)];
}

/** 行内验证只判断密码来源是否存在；实际秘密由 Background 按 ID 解析。 */
function hasRowPassword(env: DomainConfig, acc: Account): boolean {
  return Boolean(
    acc.password || env.defaultPassword ||
    config.value.globalDefaultPassword || globalDefaultPassword.value
  );
}

function accountPasswordState(acc: Account) {
  const environments = accEnvList(acc)
    .filter(item => envFilter.value === "all" || envFilter.value === "unbound" || item.key === envFilter.value)
    .map(item => item.env);
  return accountPasswordSummary(acc, environments, Boolean(config.value.globalDefaultPassword || globalDefaultPassword.value));
}

async function verifyAccount(envKey: string, env: DomainConfig, acc: Account) {
  const k = verifyKey(envKey, acc.id);
  if (verifyStates.value[k]?.status === "running") return;
  // 能力缺口先于结构校验给出精确原因（版本/算子/算法）。
  const support = environmentLoginSupport(env, config.value.strategies);
  if (!support.supported) {
    verifyStates.value[k] = {
      status: "fail",
      message: "当前客户端不支持该环境的登录声明：" + supportReason(support),
    };
    return;
  }
  // 与 DomainsPanel / 登录 prelude 同一条读取链：私有声明 > 库镜像 > 旧配方迁移，
  // 保证「这里能验证的」就是「实际会执行的」。
  const { spec } = readSpecFromConfig(env, config.value.strategies);
  if (!spec) {
    verifyStates.value[k] = {
      status: "fail",
      message: "该环境没有登录声明，无法行内验证",
    };
    return;
  }
  // 试跑前先校验（R1–R7），配置错误不发请求
  const issues = validateLoginSpec(spec);
  if (issues.length > 0) {
    verifyStates.value[k] = {
      status: "fail",
      message: "登录配置有误：" + issues[0].message,
    };
    return;
  }
  if (!hasRowPassword(env, acc)) {
    verifyStates.value[k] = {
      status: "fail",
      message: "未配置密码：请填写账号密码，或设置环境/全局默认密码",
    };
    return;
  }
  verifyStates.value[k] = { status: "running", message: "" };
  try {
    const res = await sendBgMessage("TRIAL_SAVED_ACCOUNT", {
      accountId: acc.id,
      environmentId: envKey,
    });
    verifyStates.value[k] = res.ok
      ? { status: "ok", message: res.sessionWritten ? "当前已是该账号" : "账号密码可用" }
      : { status: "fail", message: res.error || "检查失败" };
  } catch (e) {
    verifyStates.value[k] = {
      status: "fail",
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

// ----- 验证环境（卡头）：只做配置可用性检查，不发请求 -----
const envCheckStates = ref<Record<string, { ok: boolean; message: string }>>(
  {},
);

function verifyEnv(envKey: string, env: DomainConfig, accounts: Account[]) {
  const problems: string[] = [];
  // 能力缺口：直接给出精确原因，避免与结构校验问题混淆。
  const support = environmentLoginSupport(env, config.value.strategies);
  if (!support.supported) {
    problems.push("当前客户端不支持该环境的登录声明：" + supportReason(support));
  }
  // spec 校验（有登录声明时；无声明按通用登录默认三步执行，不算问题）
  // 镜像环境不持私有声明，回落读库条目（ADR-0019 修订）
  const spec =
    env.strategyConfig?.spec ??
    (env.strategyId
      ? config.value.strategies?.[env.strategyId]?.spec
      : undefined);
  if (spec && support.supported) {
    for (const issue of validateLoginSpec(spec)) {
      const where =
        issue.opIndex !== undefined ? ` 第 ${issue.opIndex + 1} 步` : "";
      problems.push(
        `登录声明${issue.rule ? " " + issue.rule : ""}${where}：${issue.message}`,
      );
    }
  }
  // 必填项：用户名 / 密码齐全性（密码含环境与全局默认回退）
  for (const acc of accounts) {
    if (!acc.username) problems.push(`账号「${acc.name}」缺用户名`);
    if (!hasRowPassword(env, acc)) {
      problems.push(`账号「${acc.name}」缺密码`);
    }
  }
  envCheckStates.value[envKey] =
    problems.length === 0
      ? {
          ok: true,
          message:
            accounts.length === 0
              ? "配置可用（尚无账号可验）"
              : `配置可用：${accounts.length} 个账号凭据齐全`,
        }
      : { ok: false, message: problems.join("；") };
}

// ----- 行内「登录」：与面板同一条 SWITCH_ACCOUNT 消息路径 -----
const switchingAccountId = ref<string | null>(null);

async function loginAccount(envKey: string, acc: Account) {
  if (switchingAccountId.value) return;
  switchingAccountId.value = acc.id;
  showToast("正在登录 " + acc.name + "…", "info");
  try {
    const response = await sendBgMessage("SWITCH_ACCOUNT", {
      accountId: acc.id,
      environmentId: envKey,
    });
    if (response?.success) {
      showToast("已切换至 " + acc.name, "success");
    } else {
      const err = response?.error || "未知错误";
      // 并发互斥拒绝是「忙碌」而非失败（与 SwitcherPanel 一致）
      if (err === LOGIN_BUSY_ERROR) {
        showToast(err, "info");
      } else {
        const env = config.value.domains[envKey];
        const spec = env
          ? readSpecFromConfig(env, config.value.strategies).spec
          : null;
        showLoginRecoveryToast({
          prefix: "登录失败",
          error: err,
          errorCode: response?.errorCode,
          envKey,
          spec: spec ?? undefined,
          detail: {
            action: "SWITCH_ACCOUNT",
            envName: config.value.domains[envKey]?.name,
            origin: envKey,
            strategy: config.value.domains[envKey]?.loginMethod,
            accountName: acc.name,
            username: acc.username,
            recipeSteps: response?.recipeSteps,
          },
        });
      }
    }
  } finally {
    switchingAccountId.value = null;
  }
}

onMounted(async () => {
  if (await loadConfig()) {
    configReady.value = true;
    void refresh();
  }
  // 「⋯」菜单：点页面任意处关闭（⋯ 按钮自身 @click.stop 除外）
  document.addEventListener("click", handleDocumentClick);
});

onUnmounted(() => {
  document.removeEventListener("click", handleDocumentClick);
});

/**
 * 设置按钮点击处理 — 切换到设置标签页
 */
function handleSettingsClick() {
  activeTab.value = "settings";
}

// 设置页各项独立保存对应字段，互不干扰也不覆盖其他页面改过的字段
function saveQuickLoginDefaultDomain() {
  void saveWithFeedback(
    { quickLoginDefaultDomain: quickLoginDefaultDomain.value },
    "设置已保存",
  );
}

function saveGlobalDefaultPassword() {
  void saveWithFeedback(
    { globalDefaultPassword: globalDefaultPassword.value },
    "设置已保存",
  );
}
</script>

<template>
  <div class="config-panel">
    <!-- 加载失败：表单停在空集合，任何保存都会覆盖真实数据 → 阻断全部编辑入口 -->
    <div v-if="loadError" class="config-load-error" role="alert">
      <div class="i-lucide-shield-alert w-5 h-5 config-load-error-icon" />
      <div class="config-load-error-body">
        <strong>无法读取账号配置，已禁用编辑、保存与导入</strong>
        <p class="config-load-error-detail">{{ loadError }}</p>
        <p>
          当前配置无法读取（可能来自旧版或未知格式）。ShadeKit 不会自动改写或清空它，
          请先导入备份或修复存储后，再刷新本页。
        </p>
        <DtButton size="sm" variant="primary" @click="retryLoad">
          <div class="i-lucide-refresh-cw w-3.5 h-3.5 mr-1" />重试
        </DtButton>
      </div>
    </div>

    <template v-else>
    <!-- Pill tabs -->
    <div class="tabs">
      <button :class="['tab-btn', { active: activeTab === 'main' }]" @click="activeTab = 'main'">
        <div class="i-lucide-layout-grid w-3.5 h-3.5 mr-1" />
        环境与账号
      </button>
      <button type="button" :class="['tab-btn', { active: activeTab === 'strategies' }]" :aria-pressed="activeTab === 'strategies'" @click="activeTab = 'strategies'">
        <div class="i-lucide-library w-3.5 h-3.5 mr-1" aria-hidden="true" />
        登录策略
      </button>
      <button :class="['tab-btn', { active: activeTab === 'settings' }]" @click="handleSettingsClick">
        <div class="i-lucide-settings w-3.5 h-3.5 mr-1" />
        设置
      </button>
    </div>


    <!-- 主视图：环境卡片 -->
    <div v-show="activeTab === 'main'" class="tab-content">
      <!-- 顶部栏：规模统计、主要账号操作与次级导入入口 -->
      <div class="main-topbar">
        <span class="toolbar-count">{{ envCount }} 个环境 · {{ accountCount }} 个账号</span>
        <div class="main-topbar-actions">
          <DtButton size="sm" variant="secondary" @click="domainsPanelRef?.openCreate()">
            <span class="i-lucide-plus w-3.5 h-3.5" aria-hidden="true" />新建环境
          </DtButton>
          <DtButton size="sm" variant="primary" @click="addAccountToView">
            <div class="i-lucide-plus w-3.5 h-3.5 mr-1" />新建账号
          </DtButton>
          <DtButton size="sm" variant="ghost" title="选择登录策略包或 ShadeKit 完整备份" @click="domainsPanelRef?.openImport()">
            <div class="i-lucide-download w-3.5 h-3.5 mr-1" />导入策略
          </DtButton>
        </div>
      </div>

      <!-- 账号表单（右侧抽屉：＋ 账号 / 编辑 / 克隆 / 换环境 / 绑定到环境 共用） -->
      <DtDrawer :show="showAccountForm" :title="editingAccount ? '编辑账号' : '添加账号'" @close="closeAccountForm">
        <div class="form-card" :class="{ 'form-card-highlight': formHighlight }">
          <div class="form-row">
            <label for="account-name">显示名称 <span class="optional">（选填）</span></label>
            <input id="account-name" class="dt-input" v-model="newAccount.name" placeholder="留空时使用用户名" />
          </div>
          <div class="form-row">
            <label for="account-username">用户名 <span class="required" aria-hidden="true">*</span></label>
            <input
              id="account-username"
              class="dt-input"
              v-model="newAccount.username"
              placeholder="登录时使用的用户名"
              required
              :aria-invalid="Boolean(accountFormError)"
              :aria-describedby="accountFormError ? 'account-username-error' : undefined"
            />
            <p v-if="accountFormError" id="account-username-error" class="field-error" role="alert">
              <span class="i-lucide-alert-circle w-3.5 h-3.5" />{{ accountFormError }}
            </p>
          </div>
          <div class="form-row">
            <label for="account-password">
              密码 <span class="optional">（选填）</span>
            </label>
            <input
              id="account-password"
              class="dt-input"
              v-model="newAccount.password"
              :type="showPasswords ? 'text' : 'password'"
              placeholder="留空时使用环境或全局默认密码"
            />
            <p class="field-hint">使用时依次读取：账号密码 → 环境默认密码 → 全局默认密码；清空保存即移除账号密码。</p>
          </div>
          <div class="form-row">
            <label id="account-roles-label">角色 <span class="optional">（选填，用于筛选）</span></label>
            <div class="role-selector">
              <div class="role-presets" role="group" aria-labelledby="account-roles-label">
                <button
                  v-for="r in roleChipOptions"
                  :key="r"
                  type="button"
                  :class="['role-chip', { active: newAccount.roles.includes(r) }]"
                  :aria-pressed="newAccount.roles.includes(r)"
                  @click="toggleRole(r)"
                >{{ r }}</button>
                <button type="button" class="role-chip" :aria-expanded="showCustomRole" aria-controls="account-custom-role" @click="showCustomRole = !showCustomRole">
                  {{ showCustomRole ? '收起自定义角色' : '自定义角色' }}
                </button>
              </div>
              <input
                v-if="showCustomRole"
                id="account-custom-role"
                class="dt-input role-custom-input"
                v-model="customRoleInput"
                aria-label="自定义角色名"
                @keydown.enter.prevent="addCustomRole"
                placeholder="输入角色名，按回车添加"
              />
              <div class="role-selected-list" v-if="newAccount.roles.length > 0">
                <span v-for="r in newAccount.roles" :key="r" class="role-chip selected" :style="roleColorStyle(r)">
                  {{ r }}
                  <button type="button" class="role-remove" :aria-label="`移除角色「${r}」`" :title="`移除角色「${r}」`" @click="removeRole(r)">&times;</button>
                </span>
              </div>
            </div>
          </div>
          <div class="form-row">
            <label id="account-domains-label">关联环境 <span class="optional">（至少关联 1 个才会出现在网页切换面板）</span></label>
            <div class="domain-chip-selector" role="group" aria-labelledby="account-domains-label">
              <button
                v-for="opt in domainOptions"
                :key="opt.url"
                type="button"
                :class="['domain-chip', { selected: newAccount.domains.includes(opt.url) }]"
                :aria-pressed="newAccount.domains.includes(opt.url)"
                :title="opt.url"
                @click="toggleDomain(opt.url)"
              >{{ opt.name }}</button>
            </div>
            <p v-if="domainOptions.length === 0" class="field-hint">还没有环境。可先保存账号，再新建环境并关联。</p>
          </div>
          <div class="form-actions">
            <DtButton v-if="!editingAccount" variant="primary" @click="addAccount">
              <div class="i-lucide-plus w-4 h-4 mr-1" />添加账号
            </DtButton>
            <DtButton v-else variant="primary" @click="saveEditAccount">保存修改</DtButton>
            <DtButton variant="secondary" @click="closeAccountForm">取消</DtButton>
          </div>
        </div>
      </DtDrawer>

      <!-- 空态（US-6）：无环境无账号时的引导 -->
      <DtPanel v-if="isEmptyState">
        <DtEmptyState class="environment-empty-state">
          <template #icon>
            <div class="empty-state-icon">
              <div class="i-lucide-globe w-8 h-8" />
            </div>
          </template>
          <span class="empty-title">还没有任何环境与账号</span>
          <template #hint>
            <span class="empty-hint">只需两步：先添加环境网址，再在环境中添加账号。之后即可在网页中一键切换。</span>
          </template>
          <template #actions>
            <DtButton variant="primary" @click="domainsPanelRef?.openCreate()">
              <div class="i-lucide-plus w-4 h-4 mr-1" />新建环境
            </DtButton>
          </template>
        </DtEmptyState>
      </DtPanel>

      <!-- 左侧环境直接切换，账号表保持紧凑等高。 -->
      <div v-else class="env-rail-layout">
        <aside class="env-rail" aria-label="环境筛选">
          <div class="rail-heading">
            <span>环境</span>
          </div>
          <button type="button" class="rail-item rail-summary" :class="{ active: envFilter === 'all' }" :aria-pressed="envFilter === 'all'" @click="showEnvironmentAccounts('all')">
            <span class="rail-label">全部账号</span><span class="rail-count">{{ accountCount }}</span>
          </button>
          <div class="rail-environments">
            <button
              v-for="group in envGroups.groups"
              :key="group.key"
              type="button"
              class="rail-item rail-environment"
              :class="{ active: envFilter === group.key }"
              :aria-pressed="envFilter === group.key"
              :aria-label="`${environmentLabel(group.env)}，${group.key}，${group.accounts.length} 个账号${group.env.enabled === false ? '，已停用' : ''}`"
              @click="showEnvironmentAccounts(group.key)"
            >
              <EnvironmentIdentity :env="group.env" :env-key="group.key" compact />
              <span v-if="group.env.enabled === false" class="rail-count">已停用</span>
              <span v-if="!envSupportOf(group.key).supported" class="rail-warning" :title="supportReason(envSupportOf(group.key))" aria-label="当前客户端不支持该环境的登录声明">!</span>
              <span class="rail-count">{{ group.accounts.length }}</span>
            </button>
          </div>
          <button type="button" class="rail-item rail-summary" :class="{ active: envFilter === 'unbound' }" :aria-pressed="envFilter === 'unbound'" @click="showEnvironmentAccounts('unbound')">
            <span class="rail-label">未关联环境</span><span class="rail-count">{{ envGroups.unbound.length }}</span>
          </button>
        </aside>
        <div class="env-table-wrap">
        <div class="env-table-filterbar">
          <div class="account-search">
            <span class="i-lucide-search w-3.5 h-3.5" aria-hidden="true" />
            <input class="env-search" v-model="query" aria-label="搜索账号名称或用户名" placeholder="搜索名称或用户名…" />
            <button v-if="query" type="button" class="search-clear" aria-label="清空账号搜索" @click="query = ''">
              <span class="i-lucide-x w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
        <div class="account-filter-status">
            <!-- 角色 pill 筛选：按现有数据中的角色动态生成（预设在前，自定义在后） -->
            <div v-if="roleFilterOptions.length > 0" class="role-pills-filter">
              <button
                v-for="r in roleFilterOptions"
                :key="r"
                type="button"
                class="pill"
                :class="{ active: roleFilter === r }"
                :style="roleColorStyle(r)"
                :aria-pressed="roleFilter === r"
                @click="roleFilter = roleFilter === r ? '' : r"
              >{{ r }}</button>
            </div>

          <span class="filter-result" role="status">{{ roleFilter ? roleFilter + ' · ' : '' }}显示 {{ filteredAccounts.length }} 个账号</span>
          <DtButton v-if="hasAnyAccountFilters" size="sm" variant="ghost" @click="clearAllAccountFilters">清除筛选</DtButton>
        </div>
          <!-- 选中具体环境时，提供当前环境启停与编辑入口。 -->
          <div v-if="envFilter !== 'all' && envFilter !== 'unbound' && envGroups.groups.find((g) => g.key === envFilter)" class="env-context-bar">
            <EnvironmentIdentity :env="envOfKey(envFilter)" :env-key="envFilter" />
            <span class="context-spacer" />
            <DtToggle
              :label="`启用环境「${envOfKey(envFilter).name}」`"
              :model-value="envOfKey(envFilter).enabled !== false"
              :disabled="savingEnvironment"
              :aria-busy="savingEnvironment"
              title="控制当前环境的账号登录与环境角标"
              @update:model-value="setEnvironmentEnabled(envFilter, $event)"
            >{{ savingEnvironment ? '保存中…' : envOfKey(envFilter).enabled !== false ? '已启用' : '已停用' }}</DtToggle>
            <div class="more-wrap">
              <DtButton size="sm" class="more-btn" title="环境操作" :aria-label="`环境「${envOfKey(envFilter).name}」的其他操作`" :aria-expanded="openMenu === 'env:' + envFilter" :aria-controls="openMenu === 'env:' + envFilter ? 'env:' + envFilter + ':menu' : undefined" @click.stop="toggleMenu('env:' + envFilter, $event)">⋯</DtButton>
              <Teleport to="body">
                <div
                  v-if="openMenu === 'env:' + envFilter && menuPos"
                  :id="'env:' + envFilter + ':menu'"
                  class="more-menu"
                  role="menu"
                  :aria-label="`环境「${envOfKey(envFilter).name}」操作`"
                  :style="{ top: menuPos.top + 'px', right: menuPos.right + 'px' }"
                  @keydown="handleMenuKeydown"
                >
                  <button type="button" role="menuitem" class="more-item" @click="closeMenu(true); domainsPanelRef?.openEdit(envFilter)">编辑环境</button>
                  <button type="button" role="menuitem" class="more-item" @click="closeMenu(true); domainsPanelRef?.openClone(envFilter)">创建副本</button>
                  <button type="button" role="menuitem" class="more-item" @click="closeMenu(true); domainsPanelRef?.exportPackage(envFilter)">导出登录策略包</button>
                  <button type="button" role="menuitem" class="more-item more-danger" @click="closeMenu(true); deleteEnv(envFilter)">删除环境</button>
                </div>
              </Teleport>
            </div>
          </div>
          <!-- 能力缺口：环境详情展示精确原因；导出/删除/关联账号等操作保持可用 -->
          <div
            v-if="envFilter !== 'all' && envFilter !== 'unbound' && !envSupportOf(envFilter).supported"
            class="env-support-note"
            role="alert"
          >
            <div class="i-lucide-shield-alert w-4 h-4 env-support-note-icon" />
            <div>
              <strong>当前客户端不支持该环境的登录声明</strong>
              <p>{{ supportReason(envSupportOf(envFilter)) }}</p>
              <p class="env-support-note-hint">环境与账号仍可编辑、导出或删除；升级客户端后会自动恢复执行。</p>
            </div>
          </div>
          <!-- 环境校验结论横幅：随「验证环境」按钮一并隐藏，功能恢复时一并放回
          <div
            v-if="envFilter !== 'all' && envFilter !== 'unbound' && envCheckStates[envFilter]"
            class="env-check"
            :class="envCheckStates[envFilter].ok ? 'env-check-ok' : 'env-check-fail'"
          >
            {{ (envCheckStates[envFilter].ok ? '✓ ' : '✗ ') + envCheckStates[envFilter].message }}
          </div>
          -->


          <div class="env-table-scroll">
          <table class="env-table">
            <colgroup><col class="account-column" /><col class="environment-column" /><col class="password-column" /><col class="actions-column" /></colgroup>
            <thead>
              <tr>
                <th>账号 / 角色</th>
                <th>环境</th>
                <th>密码来源</th>
                <th style="text-align:right">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="acc in filteredAccounts" :key="acc.id" class="account-row">
                <td class="col-account">
                  <div class="acc-main">
                    <div class="acc-avatar" aria-hidden="true">{{ accountInitial(acc) }}</div>
                    <div class="acc-main-body">
                      <div class="acc-line">
                        <span class="item-name" :title="acc.name">{{ acc.name }}</span>
                        <span v-if="acc.roles[0]" class="role-pill" :title="acc.roles.join('、')">{{ acc.roles[0] }}</span>
                        <span v-if="acc.roles.length > 1" class="role-overflow" :title="acc.roles.join('、')" :aria-label="`角色：${acc.roles.join('、')}`">+{{ acc.roles.length - 1 }}</span>
                      </div>
                      <div v-if="!rowVerify(acc)" class="item-sub" :title="acc.username">
                        <div class="i-lucide-at-sign w-3 h-3 inline mr-0.5" aria-hidden="true" />{{ acc.username }}
                      </div>
                      <div
                        v-else-if="rowVerify(acc) && rowVerify(acc)!.status !== 'running'"
                        class="verify-line"
                        :title="rowVerify(acc)?.message"
                        :class="rowVerify(acc)!.status === 'ok' ? 'verify-ok' : 'verify-fail'"
                      >
                        {{ (rowVerify(acc)!.status === 'ok' ? '✓ ' : '✗ ') + rowVerify(acc)!.message }}
                      </div>
                      <div
                        v-else-if="rowVerify(acc)?.status === 'running'"
                        class="verify-line verify-running"
                      >
                        检查中…
                      </div>
                    </div>
                  </div>

                </td>
                <td class="col-envs">
                  <div v-if="accEnvList(acc).length === 0" class="env-cell">
                    <span class="cell-hint">未关联环境</span>
                  </div>
                  <button
                    v-else
                    type="button"
                    class="environment-summary"
                    :title="accEnvList(acc).map(entry => `${environmentLabel(entry.env)} — ${entry.key}`).join('；')"
                    :aria-label="`查看账号「${acc.name}」关联的 ${accEnvList(acc).length} 个环境`"
                    aria-haspopup="dialog"
                    @click="bindingAccountId = acc.id"
                  >
                    <span>{{ accountEnvironmentSummary(acc) }}</span>
                    <span class="i-lucide-chevron-right w-3 h-3" aria-hidden="true" />
                  </button>
                </td>
                <td class="col-password">
                  <span class="pw-state" :class="{ 'pw-missing': accountPasswordState(acc).missing }" :title="accountPasswordState(acc).detail">
                    <div class="i-lucide-lock w-3 h-3 inline mr-0.5" />{{ accountPasswordState(acc).label }}
                  </span>
                </td>
                <td class="col-actions">
                  <div class="item-actions">
                    <DtButton size="sm" class="account-edit-btn" :aria-label="`编辑账号「${acc.name}」`" @click="closeMenu(); editAccount(acc.id)">
                      <span class="i-lucide-pencil w-3 h-3" aria-hidden="true" />编辑
                    </DtButton>
                    <div class="more-wrap">
                      <DtButton size="sm" class="more-btn" title="账号操作" :aria-label="`账号「${acc.name}」的其他操作`" :aria-expanded="openMenu === 'acc:' + acc.id" :aria-controls="openMenu === 'acc:' + acc.id ? 'acc:' + acc.id + ':menu' : undefined" @click.stop="toggleMenu('acc:' + acc.id, $event)">⋯</DtButton>
                      <Teleport to="body">
                        <div
                          v-if="openMenu === 'acc:' + acc.id && menuPos"
                          :id="'acc:' + acc.id + ':menu'"
                          class="more-menu"
                          role="menu"
                          :aria-label="`账号「${acc.name}」操作`"
                          :style="{ top: menuPos.top + 'px', right: menuPos.right + 'px' }"
                          @keydown="handleMenuKeydown"
                        >
                          <template v-if="accFallbackEnv(acc)">
                            <button type="button" role="menuitem" class="more-item" @click="closeMenu(true); verifyMenuAccount(acc)">检查配置</button>
                            <div class="more-sep" />
                          </template>
                          <button type="button" role="menuitem" class="more-item" @click="closeMenu(true); cloneAccount(acc.id)">创建副本</button>
                          <button type="button" role="menuitem" class="more-item more-danger" @click="closeMenu(true); deleteAccount(acc.id)">删除账号</button>
                        </div>
                      </Teleport>
                    </div>
                  </div>
                </td>
              </tr>
              <tr v-if="filteredAccounts.length === 0">
                <td colspan="4" class="table-empty">
                  <p>{{ emptyAccountMessage }}</p>
                  <DtButton v-if="hasAccountFilters || envFilter !== 'unbound'" size="sm" variant="secondary" @click="handleEmptyAccountAction">
                    {{ hasAccountFilters ? '清除筛选' : '新建账号' }}
                  </DtButton>
                </td>
              </tr>
            </tbody>
          </table>
          </div>

          <div class="env-table-foot">
            <span class="badge-summary">环境：{{ enabledEnvironmentCount }} / {{ envCount }} 个已启用</span>
            <span class="toolbar-count">{{ filteredAccounts.length }} / {{ accountCount }} 个账号</span>
          </div>
        </div>
      </div>

      <DtDrawer :show="Boolean(bindingAccount)" :title="`${bindingAccount?.name ?? ''} · 关联环境`" @close="bindingAccountId = null">
        <ul v-if="bindingAccount" class="account-bindings">
          <li v-for="entry in accEnvList(bindingAccount)" :key="entry.key">
            <EnvironmentIdentity :env="entry.env" :env-key="entry.key" />
            <DtButton size="sm" @click="showEnvironmentAccounts(entry.key)">查看账号</DtButton>
          </li>
        </ul>
      </DtDrawer>

      <!-- 环境表单与配置包导入向导 -->
      <DomainsPanel
        ref="domainsPanelRef"
        :domains="config.domains"
        :strategies="config.strategies"
        :accounts="config.accounts"
        :show-passwords="showPasswords"
        @save="onDomainsSave"
        @save-patch="onDomainsPatch"
        @save-with-accounts="onEnvSaveWithAccounts"
        @import-backup="emit('importBackup', $event)"
      />
    </div>

    <!-- 登录策略独立管理，保留既有编辑与保存路径 -->
    <div v-show="activeTab === 'strategies'" class="account-strategies">
      <StrategyLibrary
        :strategies="config.strategies"
        :domains="config.domains"
        @save="onStrategiesSave"
        @save-domains="onDomainsSave"
      />
    </div>

    <div v-show="activeTab === 'settings'" class="account-settings">
      <section v-if="shortcut === ''" class="settings-card shortcut-card" aria-label="快捷键">
        <div class="settings-card-heading">
          <h3><div class="i-lucide-keyboard w-4 h-4" aria-hidden="true" />快速打开面板</h3>
        </div>
        <p class="settings-hint">
          系统快捷键未生效（安装/更新时 {{ suggestedShortcut }} 可能已被其他扩展或程序占用）。
          普通网页内的按键兜底已启用，按 {{ suggestedShortcut }} 仍可唤起面板（浏览器内置页面除外）；
          如需系统级绑定，请手动设置或恢复默认。
        </p>
        <div class="shortcut-actions">
          <button
            v-if="canRestore"
            class="shortcut-enable-btn"
            :disabled="restoring"
            @click="handleRestoreShortcut"
          >
            {{ restoring ? '恢复中…' : `恢复默认 ${suggestedShortcut}` }}
          </button>
          <span class="shortcut-manual-hint">
            或手动设置：打开
            <code>{{ shortcutSettingsUrl }}</code>
            <template v-if="shortcutSettingsUrl === 'about:addons'">
              ，点击齿轮图标 →「管理扩展快捷键」
            </template>
            <template v-else>（地址栏粘贴访问）</template>
            ，找到「ShadeKit」→「快速切换账号」，输入
            <kbd>{{ suggestedShortcut }}</kbd>
          </span>
          <span v-if="shortcutUpdateError" class="shortcut-error">{{ shortcutUpdateError }}</span>
        </div>
      </section>

      <section class="settings-card" aria-label="环境角标">
        <div class="settings-card-heading">
          <div>
            <h3><div class="i-lucide-map-pin w-4 h-4" aria-hidden="true" />环境角标</h3>
            <p class="settings-description">在页面角落显示已启用环境的名称</p>
          </div>
          <DtToggle label="启用环境角标" :model-value="envBadge.enabled" @update:model-value="setEnvBadgeEnabled">
            {{ envBadge.enabled ? '已启用' : '已关闭' }}
          </DtToggle>
        </div>
        <div class="badge-settings-layout">
          <fieldset class="badge-settings-fields" :disabled="!envBadge.enabled">
            <legend class="sr-only">环境角标显示设置</legend>
            <DtConfigItem label="显示位置" layout="stack">
              <DtSegmented :model-value="envBadge.position" :options="POSITION_OPTIONS" @update:model-value="setEnvBadgePosition" />
            </DtConfigItem>
            <DtConfigItem label="显示范围" layout="stack">
              <DtSegmented
                :model-value="badgeScope"
                :options="[{ value: 'all', label: '全部已配置环境' }, { value: 'selected', label: '指定环境' }]"
                @update:model-value="setBadgeScope"
              />
              <div v-if="badgeScope === 'selected'" class="badge-scope-summary">
                <span>已选择 {{ selectedBadgeEnvironmentCount }} 个环境</span>
                <DtButton size="sm" variant="ghost" :aria-expanded="showBadgeEnvironments" aria-controls="badge-environment-manager" @click="showBadgeEnvironments = !showBadgeEnvironments">
                  管理环境<div :class="showBadgeEnvironments ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="w-3.5 h-3.5 ml-1" aria-hidden="true" />
                </DtButton>
              </div>
              <p v-else class="settings-description">在全部已配置环境中显示角标</p>
            </DtConfigItem>
          </fieldset>
          <div class="badge-preview" role="img" :aria-label="envBadge.enabled ? `环境角标显示在页面${POSITION_OPTIONS.find(option => option.value === envBadge.position)?.label}角` : '环境角标已关闭'">
            <span class="badge-preview-label"><div class="i-lucide-monitor w-3.5 h-3.5" aria-hidden="true" />位置预览</span>
            <div class="badge-preview-browser">
              <div class="badge-preview-toolbar"><span>•••</span>业务页面</div>
              <div class="badge-preview-page">
                <div class="badge-preview-line" /><div class="badge-preview-line short" /><div class="badge-preview-line" />
                <span v-if="envBadge.enabled" class="badge-preview-indicator" :class="envBadge.position">{{ badgePreviewName }}</span>
              </div>
            </div>
          </div>
        </div>
        <p class="settings-footnote"><span class="i-lucide-info w-3.5 h-3.5" aria-hidden="true" />更改后，已打开的业务页面需刷新生效</p>
        <div v-if="badgeScope === 'selected' && showBadgeEnvironments && envBadge.enabled" id="badge-environment-manager" class="badge-environment-manager">
          <div class="badge-manager-heading"><strong>选择显示角标的环境</strong><span>至少保留 1 个；全部关闭请使用总开关</span></div>
          <p v-if="domainOptions.length === 0" class="settings-description">还没有已配置的环境</p>
          <div class="badge-environment-grid">
            <label v-for="opt in domainOptions" :key="opt.url" class="badge-environment-option">
              <input type="checkbox" :checked="envBadge.whitelist.includes(opt.url)" @change="handleWhitelistChange(opt.url, $event)" />
              <span><strong>{{ opt.name }}</strong><span class="badge-environment-url">{{ opt.url }}</span></span>
            </label>
          </div>
        </div>
      </section>

      <section class="settings-card" aria-label="密码显示">
        <div class="settings-card-heading">
          <div>
            <h3><div class="i-lucide-eye w-4 h-4" aria-hidden="true" />密码显示</h3>
            <p class="settings-description">账号、环境默认密码与全局默认密码输入框显示明文</p>
          </div>
          <DtToggle label="显示密码" :model-value="showPasswords" @update:model-value="setShowPasswords">
            {{ showPasswords ? '显示明文' : '掩码显示' }}
          </DtToggle>
        </div>
      </section>

      <details class="settings-card quick-login-defaults">
        <summary>快捷登录默认值<span class="quick-login-summary">{{ quickLoginSummary }}</span></summary>
        <p class="settings-description">未提供 URL 时使用默认环境；环境未配置密码时使用全局默认密码。</p>
        <div class="quick-login-fields">
        <DtConfigItem label="默认环境" layout="stack">
          <template v-if="domainOptions.length > 0">
            <select
              id="quick-login-default-domain"
              aria-label="默认环境"
              class="dt-select"
              v-model="quickLoginDefaultDomain"
              @change="saveQuickLoginDefaultDomain()"
            >
              <option value="">不使用默认环境</option>
              <option
                v-if="quickLoginDomainUnmatched"
                :value="quickLoginDefaultDomain"
              >{{ quickLoginDefaultDomain }}（未匹配到环境）</option>
              <option v-for="opt in domainOptions" :key="opt.url" :value="opt.url">
                {{ opt.name }}（{{ opt.url }}）
              </option>
            </select>
            <p v-if="quickLoginDomainUnmatched" class="field-hint">
              当前值未匹配到任何环境（可能已被删除或改名），可重新选择或改回「不使用默认环境」
            </p>
          </template>
          <template v-else>
            <DtButton size="sm" @click="activeTab = 'main'">
              <div class="i-lucide-plus w-3.5 h-3.5 mr-1" />先添加一个环境
            </DtButton>
          </template>
        </DtConfigItem>
        <DtConfigItem label="全局默认密码" layout="stack">
          <span v-if="hasGlobalDefaultPassword" class="stored-secret-badge">已设置</span>
          <input
            id="global-default-password"
            aria-label="全局默认密码"
            class="dt-input"
            v-model="globalDefaultPassword"
            :type="showPasswords ? 'text' : 'password'"
            @change="saveGlobalDefaultPassword()"
            placeholder="输入后保存；清空保存即移除"
          />
        </DtConfigItem>
        </div>
      </details>
    </div>
    </template>
  </div>
</template>

<style scoped>
@import '../../shared/component-styles.scss';
@import './config/config-panel-shared.scss';
@import './config/account-settings.scss';

.config-panel {
  --account-secondary: #52637a;
  min-height: 400px;
}

[data-dt-dark] .config-panel {
  --account-secondary: #a5b2c4;
}

.config-panel .toolbar-count {
  color: var(--account-secondary);
  font-variant-numeric: tabular-nums;
}

/* 加载失败阻断页：表单为空集合时不允许任何写操作 */
.config-load-error {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 18px 20px;
  border: 1px solid #fca5a5;
  border-radius: 10px;
  background: #fef2f2;
  color: #991b1b;
}

[data-dt-dark] .config-load-error {
  background: #2a1215;
  border-color: #7f1d1d;
  color: #fca5a5;
}

.config-load-error-icon {
  flex-shrink: 0;
  margin-top: 1px;
}

.config-load-error-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
  line-height: 1.6;
}

.config-load-error-body strong {
  font-size: 14px;
}

.config-load-error-body p {
  margin: 0;
}

.config-load-error-detail {
  font-family: var(--font-mono);
  font-size: 12px;
  opacity: 0.9;
  word-break: break-word;
}

/* 抽屉内表单提交区：与全页操作区（顶栏/表尾/操作列）一致靠右，覆盖共享 .form-actions 默认左对齐 */
.form-actions {
  justify-content: flex-end;
  border-top: 1px solid #f1f5f9;
  padding-top: 14px;
  margin-top: 4px;
}

[data-dt-dark] .form-actions {
  border-top-color: var(--dt-dark-border, #30363d);
}

/* Pill tabs */
.tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 16px;
}

.tab-btn {
  display: flex;
  align-items: center;
  padding: 6px 14px;
  border: 1px solid #e2e8f0;
  background: #fff;
  border-radius: 9999px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  color: #64748b;
  transition: all 0.2s ease-out;
}

[data-dt-dark] .tab-btn {
  background: var(--dt-dark-surface-1);
  border-color: var(--dt-dark-border);
  color: #8b949e;
}

.tab-btn:hover {
  border-color: #93c5fd;
  color: #3b82f6;
}

.tab-btn.active {
  background: linear-gradient(135deg, #6366f1, #3b82f6);
  border-color: transparent;
  color: white;
  box-shadow: 0 2px 8px rgba(99, 102, 241, 0.3);
}

/* 主视图顶部栏 */
.main-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 12px;
}

.main-topbar-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 6px;
  margin-left: auto;
}

[data-dt-dark] .main-topbar-actions :deep(.dt-button--primary) {
  background: var(--gradient-primary);
  border-color: transparent;
  color: #fff;
}

/* 空态引导卡：使用共享 Panel / EmptyState，保持与其他工具页一致。 */
.environment-empty-state {
  box-sizing: border-box;
  min-height: 320px;
  padding: 40px 24px;
}

.environment-empty-state :deep(.dt-empty-state-icon) {
  margin-bottom: 16px;
  opacity: 1;
}

.environment-empty-state :deep(.dt-empty-state-hint) {
  margin: 8px 0 0;
  opacity: 1;
}

.environment-empty-state :deep(.dt-empty-state-actions) {
  margin-top: 20px;
}

.empty-state-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border: 1px solid rgba(99, 102, 241, 0.18);
  border-radius: 16px;
  background: rgba(99, 102, 241, 0.08);
  color: #6366f1;
}

[data-dt-dark] .empty-state-icon {
  background: rgba(99, 102, 241, 0.14);
  border-color: rgba(129, 140, 248, 0.28);
  color: #93c5fd;
}

.empty-title {
  display: block;
  font-size: 16px;
  line-height: 24px;
  font-weight: 600;
  color: #0f172a;
}

[data-dt-dark] .empty-title {
  color: #f1f5f9;
}

.empty-hint {
  display: block;
  max-width: 460px;
  font-size: 13px;
  line-height: 1.7;
  text-wrap: balance;
  color: #64748b;
}

[data-dt-dark] .empty-hint {
  color: #8b949e;
}

@media (max-width: 640px) {
  .main-topbar-actions {
    justify-content: flex-start;
    margin-left: 0;
  }

  .environment-empty-state {
    min-height: 280px;
    padding: 32px 16px;
  }
}

/* ===== 环境卡片 ===== */
.env-card-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 10px;
  border-bottom: 1px solid #f1f5f9;
}

[data-dt-dark] .env-card-head {
  border-bottom-color: var(--dt-dark-border);
}

.env-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.env-head-info {
  min-width: 0;
}

.env-head-meta {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.env-badge-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.toggle-disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 验证环境（配置可用性检查）行内结论 */
.env-check {
  margin-top: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.6;
}

.env-check-ok {
  color: #16a34a;
  background: rgba(22, 163, 74, 0.06);
  border: 1px solid rgba(22, 163, 74, 0.15);
}

[data-dt-dark] .env-check-ok {
  color: #4ade80;
  background: rgba(74, 222, 128, 0.08);
  border-color: rgba(74, 222, 128, 0.2);
}

.env-check-fail {
  color: #b45309;
  background: rgba(217, 119, 6, 0.06);
  border: 1px solid rgba(217, 119, 6, 0.2);
}

[data-dt-dark] .env-check-fail {
  color: #fbbf24;
  background: rgba(251, 191, 36, 0.08);
  border-color: rgba(251, 191, 36, 0.2);
}

/* 账号行 */
.env-acc-rows {
  display: flex;
  flex-direction: column;
}

.env-acc-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid #f8fafc;
}

[data-dt-dark] .env-acc-row {
  border-bottom-color: var(--dt-dark-border);
}

.env-acc-row:last-child {
  border-bottom: none;
}

.env-acc-info {
  min-width: 0;
}

.env-acc-line1 {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.pw-state {
  display: inline-flex;
  align-items: center;
  white-space: nowrap;
  margin-left: 8px;
}

.pw-missing {
  color: #d97706;
}

[data-dt-dark] .pw-missing {
  color: #fbbf24;
}

/* 行内验证结果 */
.verify-line {
  margin-top: 2px;
  font-size: 12px;
}

.verify-ok {
  color: #16a34a;
}

[data-dt-dark] .verify-ok {
  color: #4ade80;
}

.verify-fail {
  color: #dc2626;
}

[data-dt-dark] .verify-fail {
  color: #f87171;
}

.verify-btn-ok {
  color: #16a34a;
}

.verify-btn-fail {
  color: #dc2626;
}

/* 空环境卡 */
.env-empty {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 0;
  font-size: 12px;
  color: #94a3b8;
}

/* 卡尾 */
.env-card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 6px;
  padding-top: 10px;
  border-top: 1px solid #f1f5f9;
}

[data-dt-dark] .env-card-foot {
  border-top-color: var(--dt-dark-border);
}

/* 「⋯」菜单（布局必需的新增样式） */
.more-wrap {
  position: relative;
}

.more-menu {
  /* fixed 定位 + JS 内联 top/right：脱离 .env-table-scroll 的 overflow 上下文，
     避免 absolute 菜单把定高滚动容器的内容高度撑长（滚动条随之变长）。 */
  position: fixed;
  z-index: 30;
  min-width: 128px;
  display: flex;
  flex-direction: column;
  padding: 4px;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12);
}

[data-dt-dark] .more-menu {
  background: var(--dt-dark-surface-1);
  border-color: var(--dt-dark-border);
}

.more-item {
  display: block;
  width: 100%;
  padding: 6px 10px;
  border: none;
  background: transparent;
  border-radius: 5px;
  font-size: 12px;
  text-align: left;
  color: #374151;
  cursor: pointer;
}

[data-dt-dark] .more-item {
  color: #c9d1d9;
}

.more-item:hover {
  background: #f1f5f9;
}

[data-dt-dark] .more-item:hover {
  background: var(--dt-dark-surface-hover);
}

.more-danger {
  color: #dc2626;
}

[data-dt-dark] .more-danger {
  color: #f87171;
}

select[multiple] {
  height: auto;
  padding: 6px;
}

select[multiple] option {
  padding: 4px 6px;
  font-size: 12px;
}

/* 表格行内角色仅保留中性文字；颜色用于筛选栏选中态与表单已选角色。 */
.role-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 9999px;
  font-weight: 400;
  white-space: nowrap;
  /* 同一单元格多个角色 pill 之间留白，避免粘连 */
  margin: 0 4px 2px 0;
  background: #f8fafc;
  color: #64748b;
  border: 1px solid #e2e8f0;
}

[data-dt-dark] .role-pill {
  background: #21262d;
  color: #8b949e;
  border-color: var(--dt-dark-border, #30363d);
}

/* Role selector */
.role-selector {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.role-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.role-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 9999px;
  font-size: 12px;
  cursor: pointer;
  border: 1px solid #e2e8f0;
  background: #fff;
  color: #374151;
  user-select: none;
  transition: all 0.2s ease-out;
}

[data-dt-dark] .role-chip {
  background: var(--dt-dark-surface-1);
  border-color: var(--dt-dark-border);
  color: #c9d1d9;
}

.role-chip:hover {
  border-color: #93c5fd;
  background: #eff6ff;
}

[data-dt-dark] .role-chip:hover {
  border-color: #58a6ff;
  background: #1e3a5f;
}

.role-chip.active {
  background: #dbeafe;
  border-color: #3b82f6;
  color: #1e40af;
}

[data-dt-dark] .role-chip.active {
  background: #1e3a5f;
  border-color: #58a6ff;
  color: #93c5fd;
}

.role-chip.selected {
  font-weight: 500;
  background: var(--role-light-bg);
  border-color: var(--role-light-fg);
  color: var(--role-light-fg);
}

[data-dt-dark] .role-chip.selected {
  background: var(--role-dark-bg);
  border-color: var(--role-dark-fg);
  color: var(--role-dark-fg);
}

.role-remove {
  cursor: pointer;
  padding: 0;
  border: 0;
  background: transparent;
  font-size: 14px;
  line-height: 1;
  color: #94a3b8;
  margin-left: 2px;
}

.role-remove:hover {
  color: #ef4444;
}

.role-selected-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.role-custom-input {
  margin-top: 4px;
}

.required,
.field-error {
  color: #dc2626;
}

.field-error {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 6px 0 0;
  font-size: 12px;
}

[data-dt-dark] .required,
[data-dt-dark] .field-error {
  color: #f87171;
}

/* 设置页 */
.settings-hint {
  font-size: 12px;
  color: #94a3b8;
  margin-bottom: 16px;
}

.field-hint {
  font-size: 12px;
  color: #94a3b8;
  margin: 6px 0 0;
  line-height: 1.5;
}

[data-dt-dark] .field-hint {
  color: #6e7681;
}

.stored-secret-badge {
  display: inline-flex;
  align-items: center;
  margin-left: 6px;
  padding: 1px 7px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 500;
  color: #3b82f6;
  background: rgba(59, 130, 246, 0.1);
}

[data-dt-dark] .stored-secret-badge {
  color: #93c5fd;
  background: #1e3a5f;
}

/* Utility */
.mt-4 {
  margin-top: 16px;
}

/* ===== 快捷键缺失时的修复卡片（ADR-0001 D4） ===== */
.shortcut-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.shortcut-enable-btn {
  align-self: flex-start;
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 500;
  color: #fff;
  background: linear-gradient(135deg, #6366f1, #3b82f6);
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease-out;
  box-shadow: 0 1px 3px rgba(99, 102, 241, 0.3);
}

.shortcut-enable-btn:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(99, 102, 241, 0.4);
}

.shortcut-enable-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.shortcut-manual-hint {
  color: inherit;
  opacity: 0.85;
}

.shortcut-manual-hint code {
  padding: 1px 5px;
  font-size: 12px;
  background: rgba(217, 119, 6, 0.12);
  border-radius: 4px;
  user-select: all;
}

.shortcut-error {
  color: #dc2626;
}

[data-dt-dark] .shortcut-error {
  color: #f87171;
}

/* 左侧紧凑环境列表：地址单行省略，完整地址保留在可访问名称与提示中。 */
.env-rail-layout { display: flex; align-items: flex-start; gap: 16px; }
.env-rail {
  flex: 0 0 196px;
  min-width: 0;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-base);
  box-sizing: border-box;
}
.rail-heading { display: flex; align-items: center; justify-content: space-between; padding: 2px 6px 6px; font-size: 12px; color: var(--account-secondary); }
.rail-environments { max-height: calc(100dvh - 370px); overflow-y: auto; min-height: 52px; margin: 6px 0; padding: 4px 0; border-block: 1px solid var(--border); }
.rail-item { display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; padding: 8px; border: 0; border-radius: 6px; box-sizing: border-box; background: transparent; color: var(--text-primary); text-align: left; cursor: pointer; font-size: 13px; transition: background 0.15s ease-out; }
.rail-item:hover { background: var(--surface-hover); }
.rail-item.active { --identity-secondary: #fff; --identity-production: #fff; --identity-tag-bg: rgba(255,255,255,0.18); background: var(--gradient-primary); color: #fff; }
.rail-environment { height: 52px; }
.rail-summary { height: 36px; }
.rail-label { flex: 1; min-width: 0; }
.rail-count { flex-shrink: 0; font-size: 12px; font-variant-numeric: tabular-nums; color: var(--account-secondary); }
.rail-item.active .rail-count { color: #fff; }
.rail-warning { color: var(--warning); font-size: 12px; }

/* 右表区 */
.env-table-wrap {
  flex: 1;
  min-width: 0;
}

.env-context-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  margin-bottom: 12px;
}

[data-dt-dark] .env-context-bar {
  background: var(--dt-dark-surface-1, #161b22);
  border-color: var(--dt-dark-border, #30363d);
}

.env-support-note {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  margin: 4px 0 8px;
  padding: 10px 12px;
  border: 1px solid #fcd34d;
  border-radius: 10px;
  background: #fffbeb;
  color: #92400e;
  font-size: 12px;
  line-height: 1.5;
}

.env-support-note strong {
  display: block;
  color: #78350f;
  font-size: 12.5px;
}

.env-support-note p {
  margin: 2px 0 0;
}

.env-support-note-icon {
  flex-shrink: 0;
  margin-top: 1px;
}

.env-support-note-hint {
  color: #a16207;
}

[data-dt-dark] .env-support-note {
  background: #2a1f0a;
  border-color: #854d0e;
  color: #fcd34d;
}

[data-dt-dark] .env-support-note strong {
  color: #fde68a;
}

[data-dt-dark] .env-support-note-hint {
  color: #d6b25e;
}

.context-spacer {
  flex: 1;
}

.env-table-filterbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 4px 0 8px;
}

.env-search {
  flex: 1;
  min-width: 0;
  width: 100%;
  border: 0;
  padding: 0;
  outline: none;
  background: transparent;
  font: inherit;
  color: var(--text-primary);
}

.role-pills-filter {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.role-pills-filter .pill {
  padding: 3px 10px;
  font-size: 12px;
  border-radius: 9999px;
  border: 1px solid #e2e8f0;
  background: transparent;
  cursor: pointer;
  color: #475569;
  transition: all 0.15s ease-out;
}

[data-dt-dark] .role-pills-filter .pill {
  border-color: var(--dt-dark-border, #30363d);
  color: #c9d1d9;
}

/* 选中：用当前角色的色板色（CSS 变量由 roleColorStyle 注入），不再用渐变主色 */
.role-pills-filter .pill.active {
  background: var(--role-light-bg);
  border-color: var(--role-light-fg);
  color: var(--role-light-fg);
  font-weight: 500;
}

[data-dt-dark] .role-pills-filter .pill.active {
  background: var(--role-dark-bg);
  border-color: var(--role-dark-fg);
  color: var(--role-dark-fg);
}

.env-table-scroll {
  /* 表体定高滚动：一页放满后仅表格竖滚，页面不滚动（表头随滚动区域 sticky 固定） */
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  overflow-x: auto;
  overflow-y: auto;
  max-height: calc(100dvh - 340px);
  min-height: 120px;
}

[data-dt-dark] .env-table-scroll {
  border-color: var(--dt-dark-border, #30363d);
}

.env-table {
  width: 100%;
  min-width: 620px;
  table-layout: fixed;
  border-collapse: separate;
  border-spacing: 0;
  background: #fff;
  border-radius: 10px;
  font-size: 13px;
}

[data-dt-dark] .env-table {
  background: var(--dt-dark-surface-1, #161b22);
}

/* 明确分配列宽，用户内容不会改变其他行的布局。 */
.account-column { width: 38%; }
.environment-column { width: 26%; }
.password-column { width: 16%; }
.actions-column { width: 20%; }
.account-row { height: 64px; }

.env-table .pw-state {
  margin-left: 0;
  color: var(--account-secondary);
}

.env-table .pw-state.pw-missing {
  color: #b45309;
}

[data-dt-dark] .env-table .pw-state.pw-missing {
  color: #fbbf24;
}

.account-edit-btn {
  color: var(--account-secondary);
}

[data-dt-dark] .account-edit-btn {
  color: var(--account-secondary);
}

/* 账号识别色头像：颜色由账号名+用户名稳定哈希自 10 色池取，亮/暗主题各一套 token */
.acc-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.acc-main-body {
  flex: 1;
  min-width: 0;
}

.acc-avatar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  user-select: none;
  /* 头像固定中性色，不参与 10 色池（色池只用于角色 pill 的色点，避免字面花） */
  background: #f1f5f9;
  color: #475569;
}

[data-dt-dark] .acc-avatar {
  background: #21262d;
  color: #c9d1d9;
}

/* 账号名 + 角色 pill 同一行，超长时名称省略、pill 不缩 */
.acc-line {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 20px;
  min-width: 0;
  white-space: nowrap;
}

.acc-line .item-name {
  min-width: 0;
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
  font-size: 13px;
}

/* 用户名过长时省略，不把名称挤成一字一行 */
.env-table .col-account .item-sub {
  color: var(--account-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.env-table th:nth-child(4),
.env-table td:nth-child(4) {
  text-align: right;
}

.env-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  text-align: left;
  padding: 8px 9px;
  font-size: 12px;
  font-weight: 600;
  color: var(--account-secondary);
  border-bottom: 1px solid #e2e8f0;
  background: #f8fafc;
}

[data-dt-dark] .env-table th {
  color: var(--account-secondary);
  border-bottom-color: var(--dt-dark-border, #30363d);
  background: #21262d;
}

.env-table td {
  padding: 8px 9px;
  border-bottom: 1px solid #f1f5f9;
  vertical-align: middle;
}

[data-dt-dark] .env-table td {
  border-bottom-color: var(--dt-dark-border, #30363d);
}

.env-table tr:last-child td {
  border-bottom: none;
}

.table-empty {
  text-align: center;
  color: #94a3b8;
  padding: 24px 12px;
}

.table-empty p {
  margin: 0 0 12px;
}

.env-cell {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--account-secondary);
  font-size: 12px;
}

.env-table-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 2px 0;
}

.env-table-foot .spacer {
  flex: 1;
}

.verify-running {
  color: #64748b;
  font-style: italic;
}

[data-dt-dark] .verify-running {
  color: #8b949e;
}

.cell-hint {
  color: var(--account-secondary);
  font-size: 12px;
}

/* ⋯ 菜单分隔线（操作列通常菜单里：验证/登录 | 编辑/克隆/删除） */
.more-sep {
  height: 1px;
  margin: 4px 0;
  background: #e2e8f0;
}

[data-dt-dark] .more-sep {
  background: var(--dt-dark-border, #30363d);
}

.account-search {
  display: flex;
  align-items: center;
  flex: 1 1 240px;
  min-width: 180px;
  gap: 8px;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-base);
  color: var(--account-secondary);
  box-sizing: border-box;
  font-size: 13px;
}
.account-search:focus-within { outline: 2px solid var(--focus-ring-color); outline-offset: 2px; }
.search-clear {
  display: inline-flex;
  padding: 4px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.search-clear:hover { background: var(--surface-hover); }
.account-filter-status {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  min-height: 34px;
  margin-bottom: 12px;
}
.filter-result { margin-left: auto; color: var(--account-secondary); font-size: 12px; }
.environment-summary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  height: 30px;
  padding: 3px 7px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: var(--surface-secondary);
  color: var(--text-primary);
  font: inherit;
  cursor: pointer;
}
.environment-summary > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.environment-summary > span:last-child { flex-shrink: 0; color: var(--account-secondary); }
.environment-summary:hover { border-color: var(--border); background: var(--surface-hover); }
.env-table .item-actions { justify-content: flex-end; }
.env-table .role-pill {
  max-width: 110px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;
  margin: 0;
  background: transparent;
  border-color: transparent;
  color: var(--account-secondary);
}
.env-table .role-overflow { font-size: 11px; color: var(--account-secondary); flex-shrink: 0; }
.env-table .verify-line {
  line-height: 18px;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.badge-summary { color: var(--account-secondary); font-size: 12px; }
.account-bindings { margin: 0; padding: 0; list-style: none; }
.account-bindings > li { display: flex; align-items: center; gap: 16px; padding: 16px 0; border-bottom: 1px solid var(--border); }
.account-bindings > li:last-child { border-bottom: 0; }
</style>
