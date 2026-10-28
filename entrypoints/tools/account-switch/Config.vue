<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { getConfig, updateConfig } from "../../shared/tool-config";
import { showToast } from "../../shared/use-toast";
import {
  collectRoleFilterOptions,
  collectRoles,
  ROLE_NAMES,
  roleColorStyle,
} from "./account-view";
import { accountInitial } from "./account-palette";
import { buildEnvGroups, normalizeEnvTag, removeEnvironment, tagColor } from "./account-env-view";
import { sendBgMessage } from "../../shared/messages";
import { validateLoginSpec } from "./spec/validate";
import { readSpecFromConfig } from "./spec/migrate";
import {
  finalizeNewEnvironmentSave,
  newEnvironmentSaveMessage,
} from "./login-form-lock";
import { showLoginRecoveryToast } from "./login-recovery-toast";
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
  SHORTCUT_SUGGESTED,
  useCommandShortcut,
} from "../../shared/use-command-shortcut";
import DomainsPanel, { type EnvSavePayload } from "./config/DomainsPanel.vue";
import StrategyLibrary from "./config/StrategyLibrary.vue";
import DtButton from "../../shared/components/DtButton.vue";
import DtDrawer from "../../shared/components/DtDrawer.vue";
import DtPanel from "../../shared/components/DtPanel.vue";
import DtEmptyState from "../../shared/components/DtEmptyState.vue";

const props = defineProps<{ editEnv?: string }>();
const emit = defineEmits<{ editEnvConsumed: [] }>();

const TOOL_ID = "account-switch";

// 主视图（环境卡片）为默认视图；设置页承载环境指示器等次级配置
const activeTab = ref<"main" | "settings">("main");
const config = ref<AccountSwitchConfig>({
  accounts: [],
  domains: {},
  strategies: {},
});
const quickLoginDefaultDomain = ref("");
const globalDefaultPassword = ref("");

const formHighlight = ref(false);

// 快捷键状态（ADR-0001 D4 可见性底线：安装时被占用会静默注册失败，此处检测并引导）
const { shortcut, updating, updateSupported, refresh, enableSuggested } =
  useCommandShortcut();
const shortcutUpdateError = ref("");

async function handleEnableShortcut() {
  shortcutUpdateError.value = "";
  try {
    await enableSuggested();
  } catch (e) {
    shortcutUpdateError.value = e instanceof Error ? e.message : "设置失败";
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
const showAccountPassword = ref(false);
const showGlobalPassword = ref(false);
const accountFormError = ref("");

watch(() => newAccount.value.username, () => {
  accountFormError.value = "";
});

// 预定义角色与角色色同源（account-view，ADR-0004 D6）
// 新增账号表单的 chip 列表直接用 roleChipOptions（预设 + 已用自定义，
// 定义在下方 computed 区，随账号数据动态更新）。

function cloneAccount(id: string) {
  const acc = config.value.accounts.find((a) => a.id === id);
  if (!acc) return;
  editingAccount.value = null;
  showAccountPassword.value = false;
  accountFormError.value = "";
  showAccountForm.value = true;
  newAccount.value = {
    name: acc.name + " (副本)",
    username: acc.username,
    password: acc.password,
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

async function loadConfig() {
  const data = await getConfig<AccountSwitchConfig>(TOOL_ID);
  config.value = {
    accounts: Array.isArray(data?.accounts) ? data.accounts : [],
    domains:
      data?.domains && typeof data.domains === "object" ? data.domains : {},
    // 策略库（ADR-0019）：与账户/环境同住一个 key，备份与同步天然覆盖
    strategies:
      data?.strategies && typeof data.strategies === "object"
        ? data.strategies
        : {},
    // 指示器配置入响应式：设置页与主视图卡头开关共写 envBadge
    envBadge: data?.envBadge,
  };

  // tabOrder 存储字段保留（SwitcherPanel 仍读取），本页不再提供配置 UI
  quickLoginDefaultDomain.value = data?.quickLoginDefaultDomain || "";
  globalDefaultPassword.value = data?.globalDefaultPassword || "";
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
  try {
    // JSON 深拷贝：patch 中的值来自响应式状态，需先剥离 Proxy
    return await updateConfig<AccountSwitchConfig>(
      TOOL_ID,
      JSON.parse(JSON.stringify(patch)),
    );
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
      reload: loadConfig,
    });
    if (result.saved)
      showToast(newEnvironmentSaveMessage(result.lockStatus), "success");
    return;
  }

  if (await saveBase()) {
    await loadConfig();
    showToast(payload.message, "success");
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
    password: newAccount.value.password,
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
  showAccountPassword.value = false;
  accountFormError.value = "";
  showAccountForm.value = true;
  newAccount.value = {
    name: acc.name,
    username: acc.username,
    password: acc.password,
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
    acc.password = newAccount.value.password;
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
  await saveWithFeedback(accountsPatch(), `账号「${savedAccountName}」已保存`);
}

function cancelEditAccount() {
  editingAccount.value = null;
  showAccountPassword.value = false;
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
// 主视图：环境卡片
// 渲染数据来源只有 buildEnvGroups 投影；UI 不自行遍历 config.domains。
// ============================================================
const envGroups = computed(() => buildEnvGroups(config.value));
const envCount = computed(() => envGroups.value.groups.length);
const accountCount = computed(() => config.value.accounts.length);
// 初次进入（0 环境 0 账号）：只显示空态引导卡，不渲染空的轨道+表格骨架
const isEmptyState = computed(
  () => envCount.value === 0 && accountCount.value === 0,
);

// ----- 主视图：表格 + 环境轨道（原型 ?variant=B / ADR-0017 决策见 spec） -----
// 状态：环境过滤（'all' | envKey | 'unbound'）、搜索、角色、上手卡折叠
type EnvFilter = "all" | "unbound" | string;
const envFilter = ref<EnvFilter>("all");
const query = ref("");
const roleFilter = ref("");

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

/** 指示器统计：当前白名单启用的环境数（空 = 全部） */
const badgeEnabledCount = computed(() => {
  const wl = envBadge.value.whitelist;
  return wl.length === 0 ? envGroups.value.groups.length : wl.length;
});

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

/** 环境色点：与指示器角标同源（tagColor，取第一个可识别的 tag，与 EnvIndicator 选择规则一致） */
function envDotColor(env: DomainConfig): string {
  return tagColor(env.tags?.find((t) => normalizeEnvTag(t) !== undefined));
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

// ----- 指示器开关（per-env，落地为 envBadge.whitelist 增删） -----
const DEFAULT_ENV_BADGE: EnvBadgeConfig = {
  enabled: false,
  position: "bottom-right",
  whitelist: [],
};
const envBadge = computed<EnvBadgeConfig>(
  () => config.value.envBadge ?? DEFAULT_ENV_BADGE,
);

/** 白名单为空 = 全部环境显示角标，此时卡头开关显示为开并附「跟随全局」提示态 */
function envBadgeOn(key: string): boolean {
  const wl = envBadge.value.whitelist;
  return wl.length === 0 || wl.includes(key);
}

async function toggleEnvBadge(key: string) {
  if (!envBadge.value.enabled) return; // 总开关已关：开关禁用（模板层 disabled 兜底）
  const current = envBadge.value;
  let whitelist: string[];
  if (current.whitelist.length === 0) {
    // 空白名单下 Uncheck：物化为「除该环境外的全部环境 key」
    whitelist = Object.keys(config.value.domains).filter((k) => k !== key);
  } else if (current.whitelist.includes(key)) {
    whitelist = current.whitelist.filter((k) => k !== key);
  } else {
    whitelist = [...current.whitelist, key];
  }
  if (current.whitelist.length > 0 && whitelist.length === 0) {
    showToast("至少保留 1 个环境；如需全部关闭，请在「设置 → 环境角标」中关闭总开关", "info");
    return;
  }
  const next: EnvBadgeConfig = { ...current, whitelist };
  config.value.envBadge = next;
  await saveWithFeedback({ envBadge: next }, "环境角标显示范围已保存");
}

// ----- 设置页：环境指示器区块（Config Kit / ADR-0007 Auto-save 范式） -----
// whitelist 与主视图卡头开关共写同一字段，语义不变：空 = 全部已配置环境
const POSITION_OPTIONS: Array<{ value: EnvBadgePosition; label: string }> = [
  { value: "top-left", label: "左上" },
  { value: "top-right", label: "右上" },
  { value: "bottom-left", label: "左下" },
  { value: "bottom-right", label: "右下" },
];

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

/** 行内验证密码回退：账号密码 > 环境默认密码 > 全局默认密码（与快捷登录同源） */
function resolveRowPassword(env: DomainConfig, acc: Account): string {
  return (
    acc.password || env.defaultPassword || globalDefaultPassword.value || ""
  );
}

function accountPasswordState(acc: Account): { label: string; missing: boolean } {
  if (acc.password) return { label: "已配置", missing: false };
  if (accEnvList(acc).some(({ env }) => env.defaultPassword)) {
    return { label: "环境默认", missing: false };
  }
  if (globalDefaultPassword.value) {
    return { label: "全局默认", missing: false };
  }
  return { label: "未配置", missing: true };
}

async function verifyAccount(envKey: string, env: DomainConfig, acc: Account) {
  const k = verifyKey(envKey, acc.id);
  if (verifyStates.value[k]?.status === "running") return;
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
  const password = resolveRowPassword(env, acc);
  if (!password) {
    verifyStates.value[k] = {
      status: "fail",
      message: "未配置密码：请填写账号密码，或设置环境/全局默认密码",
    };
    return;
  }
  verifyStates.value[k] = { status: "running", message: "" };
  try {
    const res = await sendBgMessage("TRIAL_LOGIN", {
      spec,
      origin: envKey,
      username: acc.username,
      password,
      // writeSession 缺省 false：只发请求验证，不写会话
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
  // spec 校验（有登录声明时；无声明按通用登录默认三步执行，不算问题）
  // 镜像环境不持私有声明，回落读库条目（ADR-0019 修订）
  const spec =
    env.strategyConfig?.spec ??
    (env.strategyId
      ? config.value.strategies?.[env.strategyId]?.spec
      : undefined);
  if (spec) {
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
    if (!resolveRowPassword(env, acc)) {
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
      account: acc,
      domain: envKey,
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
  await loadConfig();
  configReady.value = true;
  void refresh();
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
    <!-- Pill tabs -->
    <div class="tabs">
      <button :class="['tab-btn', { active: activeTab === 'main' }]" @click="activeTab = 'main'">
        <div class="i-lucide-layout-grid w-3.5 h-3.5 mr-1" />
        环境与账号
      </button>
      <button :class="['tab-btn', { active: activeTab === 'settings' }]" @click="handleSettingsClick">
        <div class="i-lucide-settings w-3.5 h-3.5 mr-1" />
        设置
      </button>
    </div>


    <!-- 主视图：环境卡片 -->
    <div v-show="activeTab === 'main'" class="tab-content">
      <!-- 顶部栏：规模统计（US-7）+ 环境操作（「＋ 环境」降级为次要按钮） -->
      <div class="main-topbar">
        <span class="toolbar-count">{{ envCount }} 个环境 · {{ accountCount }} 个账号</span>
        <div class="main-topbar-actions">
          <DtButton size="sm" variant="primary" @click="domainsPanelRef?.openCreate()">
            <div class="i-lucide-plus w-3.5 h-3.5 mr-1" />新建环境
          </DtButton>
          <DtButton size="sm" variant="secondary" @click="addAccountToView">
            <div class="i-lucide-plus w-3.5 h-3.5 mr-1" />新建账号
          </DtButton>
          <DtButton size="sm" variant="secondary" title="从文件导入可复用的登录方式，不包含账号密码" @click="domainsPanelRef?.openImport()">
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
            <label for="account-password">密码 <span class="optional">（选填）</span></label>
            <div class="password-input-wrapper">
              <input id="account-password" class="dt-input password-input" v-model="newAccount.password" :type="showAccountPassword ? 'text' : 'password'" placeholder="留空时使用环境或全局默认密码" />
              <button class="password-toggle" type="button" @click="showAccountPassword = !showAccountPassword" :title="showAccountPassword ? '隐藏密码' : '显示密码'" :aria-label="showAccountPassword ? '隐藏账号密码' : '显示账号密码'" :aria-pressed="showAccountPassword">
                <div :class="showAccountPassword ? 'i-lucide-eye-off w-4 h-4' : 'i-lucide-eye w-4 h-4'" />
              </button>
            </div>
            <p class="field-hint">使用时依次读取：账号密码 → 环境默认密码 → 全局默认密码。</p>
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

      <!-- 主视图：表格 + 环境轨道（原型 ?variant=B；环境退化为左侧筛选轨道）。空态下隐藏骨架，避免与引导卡重复 -->
      <div v-else class="env-rail-layout">
        <!-- 左轨道：全部 / 各环境 / 未绑定 -->
        <aside class="env-rail">
          <button
            type="button"
            class="rail-item"
            :class="{ active: envFilter === 'all' }"
            @click="envFilter = 'all'; closeMenu()"
          >
            <span class="rail-dot none" />
            <span class="rail-label">全部账号</span>
            <span class="rail-count">{{ accountCount }}</span>
          </button>
          <div class="rail-sep" />

          <button
            v-for="g in envGroups.groups"
            :key="g.key"
            type="button"
            class="rail-item"
            :class="{ active: envFilter === g.key }"
            @click="envFilter = g.key; closeMenu()"
          >
            <span class="rail-dot" :style="{ backgroundColor: envDotColor(g.env) }" />
            <span class="rail-label">{{ g.env.name }}</span>
            <span class="rail-count">{{ g.accounts.length }}</span>
          </button>

          <div class="rail-sep" />

          <button
            type="button"
            class="rail-item"
            :class="{ active: envFilter === 'unbound' }"
            @click="envFilter = 'unbound'; closeMenu()"
          >
            <span class="rail-dot none" />
            <span class="rail-label">未关联环境</span>
            <span class="rail-count">{{ envGroups.unbound.length }}</span>
          </button>

          <div class="rail-note">
            {{ envBadge.enabled ? `环境角标：${badgeEnabledCount} / ${envGroups.groups.length} 个环境开启` : '环境角标：未启用' }}
          </div>
        </aside>

        <!-- 右表区：搜索 + 角色筛选 + 账号表 -->
        <div class="env-table-wrap">
          <!-- 选中某具体环境时：环境上下文工具条（验证/指示器/编辑等，承接 A 卡头能力） -->
          <div v-if="envFilter !== 'all' && envFilter !== 'unbound' && envGroups.groups.find((g) => g.key === envFilter)" class="env-context-bar">
            <span class="rail-dot" :style="{ backgroundColor: envDotColor(envOfKey(envFilter)) }" />
            <span class="item-name">{{ envOfKey(envFilter).name }}</span>
            <span class="item-sub">{{ envFilter }}</span>
            <span class="context-spacer" />
            <DtButton v-if="!envBadge.enabled" size="sm" variant="secondary" title="前往设置启用环境角标" @click="activeTab = 'settings'">启用角标</DtButton>
            <label v-else class="toggle-switch" :title="`在「${envOfKey(envFilter).name}」页面显示环境角标`">
              <input
                type="checkbox"
                :checked="envBadgeOn(envFilter)"
                :aria-label="`在「${envOfKey(envFilter).name}」页面显示环境角标`"
                @change="toggleEnvBadge(envFilter)"
              />
              <span class="toggle-slider" />
            </label>
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
          <!-- 环境校验结论横幅：随「验证环境」按钮一并隐藏，功能恢复时一并放回
          <div
            v-if="envFilter !== 'all' && envFilter !== 'unbound' && envCheckStates[envFilter]"
            class="env-check"
            :class="envCheckStates[envFilter].ok ? 'env-check-ok' : 'env-check-fail'"
          >
            {{ (envCheckStates[envFilter].ok ? '✓ ' : '✗ ') + envCheckStates[envFilter].message }}
          </div>
          -->

          <div class="env-table-filterbar">
            <input
              class="dt-input env-search"
              v-model="query"
              aria-label="搜索账号名称或用户名"
              placeholder="搜索名称或用户名…"
            />
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
          </div>

          <div class="env-table-scroll">
          <table class="env-table">
            <thead>
              <tr>
                <th>账号 / 角色</th>
                <th>环境</th>
                <th>密码</th>
                <th style="text-align:right">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="acc in filteredAccounts" :key="acc.id">
                <td class="col-account">
                  <div class="acc-main">
                    <div class="acc-avatar">{{ accountInitial(acc) }}</div>
                    <div class="acc-main-body">
                      <div class="acc-line">
                        <span class="item-name">{{ acc.name }}</span>
                        <span v-for="r in acc.roles" :key="r" class="role-pill" :style="roleColorStyle(r)">{{ r }}</span>
                      </div>
                      <div class="item-sub">
                        <div class="i-lucide-at-sign w-3 h-3 inline mr-0.5" />{{ acc.username }}
                      </div>
                    </div>
                  </div>
                  <div
                    v-if="rowVerify(acc) && rowVerify(acc)!.status !== 'running'"
                    class="verify-line"
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
                </td>
                <td class="col-envs">
                  <div v-if="accEnvList(acc).length === 0" class="env-cell">
                    <span class="rail-dot none" /><span class="cell-hint">未关联环境</span>
                  </div>
                  <div v-else class="env-multi">
                    <template
                      v-for="(e, i) in accEnvList(acc)"
                      :key="e.key"
                    >
                      <span v-if="i > 0" class="env-multi-sep">·</span>
                      <span class="env-multi-item">
                        <span class="env-multi-name">{{ e.env.name }}</span>
                      </span>
                    </template>
                  </div>
                </td>
                <td class="col-password">
                  <span class="pw-state" :class="{ 'pw-missing': accountPasswordState(acc).missing }" title="密码优先级：账号密码 → 环境默认密码 → 全局默认密码">
                    <div class="i-lucide-lock w-3 h-3 inline mr-0.5" />{{ accountPasswordState(acc).label }}
                  </span>
                </td>
                <td class="col-actions">
                  <div class="item-actions">
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
                          <button type="button" role="menuitem" class="more-item" @click="closeMenu(true); editAccount(acc.id)">编辑账号</button>
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
            <span class="toolbar-count">{{ filteredAccounts.length }} / {{ accountCount }} 个账号</span>
          </div>
        </div>
      </div>

      <!-- 环境表单与配置包导入向导（列表由上方环境卡承载） -->
      <DomainsPanel
        ref="domainsPanelRef"
        :domains="config.domains"
        :strategies="config.strategies"
        :accounts="config.accounts"
        @save="onDomainsSave"
        @save-patch="onDomainsPatch"
        @save-with-accounts="onEnvSaveWithAccounts"
      />
    </div>

    <!-- 设置：快捷键 / 环境指示器 / 登录策略库 / 快捷登录默认值 -->
    <div v-show="activeTab === 'settings'" class="tab-content">

      <!-- 快捷键（ADR-0001 D4 可见性底线：从主视图迁入设置区，B 布局下收进设置） -->
      <div v-if="shortcut !== null" class="form-card">
        <h3>
          <div class="i-lucide-keyboard w-4 h-4" />
          快捷键
        </h3>
        <template v-if="shortcut">
          <p class="settings-hint">
            快捷键 <kbd>{{ formatShortcut(shortcut) }}</kbd> 已生效。
          </p>
        </template>
        <template v-else>
          <p class="settings-hint">
            快捷键未生效（安装时 {{ SHORTCUT_SUGGESTED }} 可能被其他程序占用）。
          </p>
          <div class="shortcut-actions">
            <button
              v-if="updateSupported"
              class="shortcut-enable-btn"
              :disabled="updating"
              @click="handleEnableShortcut"
            >
              {{ updating ? '设置中…' : `一键设置为 ${SHORTCUT_SUGGESTED}` }}
            </button>
            <span class="shortcut-manual-hint">
              或手动设置：打开
              <code>edge://extensions/shortcuts</code>
              （地址栏粘贴访问），找到「ShadeKit」→「快速切换账号」，输入
              {{ SHORTCUT_SUGGESTED }}
            </span>
            <span v-if="shortcutUpdateError" class="shortcut-error">{{ shortcutUpdateError }}</span>
          </div>
        </template>
      </div>

      <!-- 环境指示器（Config Kit：DtConfigItem + DtToggle + DtSegmented） -->
      <div class="form-card">
        <h3>
          <div class="i-lucide-map-pin w-4 h-4" />
          环境角标
        </h3>
        <p class="settings-hint">在匹配环境的页面角落显示环境名称，帮助区分本地、测试和生产环境。更改后，已打开的页面需刷新才会生效。</p>

        <div class="settings-items">
          <DtConfigItem label="启用环境角标" hint="关闭后所有页面都不再显示角标">
            <DtToggle
              :model-value="envBadge.enabled"
              @update:model-value="setEnvBadgeEnabled"
            />
          </DtConfigItem>
          <DtConfigItem label="停靠位置" hint="角标显示在页面的哪个角落">
            <DtSegmented
              :model-value="envBadge.position"
              :options="POSITION_OPTIONS"
              @update:model-value="setEnvBadgePosition"
            />
          </DtConfigItem>
          <DtConfigItem label="显示范围" hint="「仅这些环境」至少保留 1 个；若要全部关闭，请关闭上方总开关" layout="stack">
            <DtSegmented
              :model-value="badgeScope"
              :options="[
                { value: 'all', label: '全部已配置环境' },
                { value: 'selected', label: '仅这些环境' },
              ]"
              @update:model-value="setBadgeScope"
            />
            <div v-if="badgeScope === 'selected'" class="env-whitelist">
              <p v-if="domainOptions.length === 0" class="field-hint">还没有已配置的环境</p>
              <label v-for="opt in domainOptions" :key="opt.url" class="env-whitelist-item">
                <input
                  type="checkbox"
                  :checked="envBadge.whitelist.includes(opt.url)"
                  @change="toggleWhitelist(opt.url)"
                />
                <span>{{ opt.name }}（{{ opt.url }}）</span>
              </label>
            </div>
          </DtConfigItem>
        </div>
      </div>

      <!-- 登录策略库（ADR-0019）：策略独立于环境，可复用 / 分享 / 解绑 -->
      <StrategyLibrary
        :strategies="config.strategies"
        :domains="config.domains"
        @save="onStrategiesSave"
        @save-domains="onDomainsSave"
      />

      <!-- 快捷登录默认值 -->
      <div class="form-card">
        <h3>
          <div class="i-lucide-zap w-4 h-4" />
          快捷登录默认值
        </h3>
        <p class="settings-hint">当快捷登录文本不含 URL 时，使用此处配置作为目标。全局默认密码在环境未配置默认密码时作为最后回退。</p>

        <div class="form-row">
          <label for="quick-login-default-domain">默认环境</label>
          <template v-if="domainOptions.length > 0">
            <select
              id="quick-login-default-domain"
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
        </div>
        <div class="form-row">
          <label for="global-default-password">全局默认密码</label>
          <div class="password-input-wrapper">
            <input
              id="global-default-password"
              class="dt-input password-input"
              v-model="globalDefaultPassword"
              :type="showGlobalPassword ? 'text' : 'password'"
              @change="saveGlobalDefaultPassword()"
              placeholder="留空表示不使用全局默认密码"
            />
            <button class="password-toggle" type="button" @click="showGlobalPassword = !showGlobalPassword" :title="showGlobalPassword ? '隐藏密码' : '显示密码'" :aria-label="showGlobalPassword ? '隐藏全局默认密码' : '显示全局默认密码'" :aria-pressed="showGlobalPassword">
              <div :class="showGlobalPassword ? 'i-lucide-eye-off w-4 h-4' : 'i-lucide-eye w-4 h-4'" />
            </button>
          </div>
        </div>
      </div>

    </div>

  </div>
</template>

<style scoped>
@import '../../shared/component-styles.scss';
@import './config/config-panel-shared.scss';

.config-panel {
  min-height: 400px;
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

/* 表格行内角色：中性 chip + 角色色小圆点。
   每行都出现的元素不能用填色——色块连成一片会盖过账号名本身；
   颜色缩成 5px 点（取自 roleColorStyle 注入的 fg token）保留跨行识别，
   填色只留给筛选栏选中态与表单已选角色这类「表达状态、单点出现」的位置。 */
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

.role-pill::before {
  content: '';
  flex-shrink: 0;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--role-light-fg);
}

[data-dt-dark] .role-pill {
  background: #21262d;
  color: #8b949e;
  border-color: var(--dt-dark-border, #30363d);
}

[data-dt-dark] .role-pill::before {
  background: var(--role-dark-fg);
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

/* 设置页：Config Kit 区块容器与字段级提示 */
.settings-items {
  border: 1px solid #f1f5f9;
  border-radius: 8px;
  overflow: hidden;
}

[data-dt-dark] .settings-items {
  border-color: #21262d;
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

/* 显示范围「仅这些环境」的勾选列表 */
.env-whitelist {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.env-whitelist-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #334155;
  cursor: pointer;
}

[data-dt-dark] .env-whitelist-item {
  color: #c9d1d9;
}

.env-whitelist-item input[type='checkbox'] {
  accent-color: #6366f1;
}

/* Utility */
.mt-4 {
  margin-top: 16px;
}

/* Password visibility toggle */
.password-input-wrapper {
  position: relative;
  display: flex;
  align-items: center;
}

.password-input {
  flex: 1;
  padding-right: 36px;
}

.password-toggle {
  position: absolute;
  right: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  border-radius: 4px;
  cursor: pointer;
  color: #94a3b8;
  transition: all 0.15s ease-out;
  flex-shrink: 0;
}

.password-toggle:hover {
  background: #f1f5f9;
  color: #64748b;
}

[data-dt-dark] .password-toggle:hover {
  background: var(--dt-dark-surface-hover);
  color: #8b949e;
}

/* ===== 快捷键状态卡片（原 GuideSection，ADR-0001 D4） ===== */
.shortcut-status {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 12px;
  line-height: 1.6;
  margin-bottom: 16px;
}

.shortcut-ok {
  color: #16a34a;
  background: rgba(22, 163, 74, 0.06);
  border: 1px solid rgba(22, 163, 74, 0.2);
  align-items: center;
}

[data-dt-dark] .shortcut-ok {
  color: #4ade80;
  background: rgba(74, 222, 128, 0.08);
  border-color: rgba(74, 222, 128, 0.25);
}

.shortcut-missing {
  color: #b45309;
  background: rgba(217, 119, 6, 0.06);
  border: 1px solid rgba(217, 119, 6, 0.25);
}

[data-dt-dark] .shortcut-missing {
  color: #fbbf24;
  background: rgba(251, 191, 36, 0.08);
  border-color: rgba(251, 191, 36, 0.25);
}

.shortcut-status .i-lucide-keyboard,
.shortcut-status .i-lucide-alert-triangle {
  flex-shrink: 0;
  margin-top: 2px;
}

.shortcut-ok kbd {
  display: inline-block;
  padding: 1px 6px;
  font-size: 12px;
  font-family: var(--font-mono);
  background: rgba(22, 163, 74, 0.1);
  border-radius: 4px;
}

.shortcut-missing-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

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

/* ===== 主视图：表格 + 环境轨道（原型 ?variant=B） ===== */
.env-rail-layout {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}

/* 左轨道（容器 1120 下表格可用约 700px） */
.env-rail {
  flex: 0 0 180px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--dt-surface, #f8fafc);
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 6px;
}

[data-dt-dark] .env-rail {
  background: var(--dt-dark-surface-1, #161b22);
  border-color: var(--dt-dark-border, #30363d);
}

.rail-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border: none;
  background: transparent;
  border-radius: 7px;
  font-size: 13px;
  color: #0f172a;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s ease-out;
}

[data-dt-dark] .rail-item {
  color: #f1f5f9;
}

.rail-item:hover {
  background: rgba(99, 102, 241, 0.07);
}

.rail-item.active {
  background: linear-gradient(135deg, #6366f1, #3b82f6);
  color: #fff;
}

.rail-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rail-count {
  font-size: 12px;
  color: #94a3b8;
}

.rail-item.active .rail-count {
  color: rgba(255, 255, 255, 0.8);
}

/* 环境轨道项左侧色条：与 SwitcherPanel 账号卡片 .as-accent 同款（3px 竖条），
   取代原先的圆形色点 —— 圆形在轨道上视觉太花，色条更收敛 */
.rail-dot {
  width: 3px;
  height: 14px;
  border-radius: 2px;
  flex-shrink: 0;
  background: #6b7280;
}

.rail-dot.none {
  background: #cbd5e1;
}

[data-dt-dark] .rail-dot.none {
  background: #475569;
}

.rail-sep {
  height: 1px;
  background: #e2e8f0;
  margin: 4px 0;
}

[data-dt-dark] .rail-sep {
  background: var(--dt-dark-border, #30363d);
}

.rail-note {
  margin-top: 6px;
  padding: 6px 9px;
  font-size: 12px;
  color: #94a3b8;
  border-radius: 6px;
  background: rgba(99, 102, 241, 0.05);
}

[data-dt-dark] .rail-note {
  color: #8b949e;
  background: rgba(99, 102, 241, 0.12);
}

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
  margin-bottom: 4px;
}

[data-dt-dark] .env-context-bar {
  background: var(--dt-dark-surface-1, #161b22);
  border-color: var(--dt-dark-border, #30363d);
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
  min-width: 160px;
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
  max-height: calc(100vh - 320px);
  min-height: 120px;
}

[data-dt-dark] .env-table-scroll {
  border-color: var(--dt-dark-border, #30363d);
}

.env-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  background: #fff;
  border-radius: 10px;
  font-size: 13px;
}

[data-dt-dark] .env-table {
  background: var(--dt-dark-surface-1, #161b22);
}

/* 列宽：auto 布局 + 「窄列 width:1% + nowrap」收缩，账号列吃剩余空间。
   表格可用宽约 500px（960 容器 - sidebar - 轨道），因此只保留 4 列。 */
.env-table .col-account {
  min-width: 190px;
}

.env-table th:nth-child(3),
.env-table td:nth-child(3),
.env-table th:nth-child(4),
.env-table td:nth-child(4) {
  width: 1%;
  white-space: nowrap;
}

.env-table .pw-state {
  margin-left: 0;
}

/* 账号识别色头像：颜色由账号名+用户名稳定哈希自 10 色池取，亮/暗主题各一套 token */
.acc-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.acc-main-body {
  min-width: 0;
}

.acc-avatar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
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
  flex-wrap: wrap;
}

.acc-line .item-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
  font-size: 13px;
}

/* 用户名过长时省略，不把名称挤成一字一行 */
.env-table .col-account .item-sub {
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
  color: #64748b;
  border-bottom: 1px solid #e2e8f0;
  background: #f8fafc;
}

[data-dt-dark] .env-table th {
  color: #8b949e;
  border-bottom-color: var(--dt-dark-border, #30363d);
  background: #21262d;
}

.env-table td {
  padding: 8px 9px;
  border-bottom: 1px solid #f1f5f9;
  vertical-align: top;
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

.env-multi {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
  /* 环境列的内容上限：超出时环境项之间换行，而不是把整张表撑宽 */
  max-width: 250px;
}

/* 每个环境名是不可拆分单元，只在环境之间允许换行 */
.env-multi-item {
  display: inline-flex;
  align-items: center;
  white-space: nowrap;
}

.env-multi-sep {
  color: #94a3b8;
}

.env-multi-name {
  color: #334155;
}

[data-dt-dark] .env-multi-name {
  color: #c9d1d9;
}

.env-cell {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: #94a3b8;
  font-size: 12px;
}

.env-table-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
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
  color: #94a3b8;
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
</style>
