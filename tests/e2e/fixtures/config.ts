import type { BrowserContext } from '@playwright/test';
import type {
  Account,
  AccountSwitchConfig,
  DomainConfig,
  EnvBadgeConfig,
} from '../../../entrypoints/tools/account-switch/types';
import {
  LOGIN_SPEC_VERSION,
  type LoginFormTarget,
  type LoginSpec,
  type SpecOp,
} from '../../../entrypoints/tools/account-switch/spec/types';
import { validateLoginSpec } from '../../../entrypoints/tools/account-switch/spec/validate';
import { findExtensionWorker } from './extension';

export const FIXTURE_PASSWORD = 'fixture-pass';
export const FIXTURE_ADMIN_NAME = '林屿 · 交付管理员';
export const FIXTURE_TESTER_NAME = '周然 · 验收测试';

export type LoginSelectors = {
  username: LoginFormTarget;
  password: LoginFormTarget;
  submit: LoginFormTarget;
};

export type PageLoginSpecOptions = {
  loginPath?: string;
  selectors?: Partial<LoginSelectors>;
  /** true 时填充前清空输入框（运行期默认也是 true，显式声明便于用例自证） */
  clearFirst?: boolean;
  /** 在密码填充之后、提交点击之前插入的算子（select / checkbox 等）。 */
  preSubmitOps?: SpecOp[];
};

export type MakeAccountSwitchConfigOptions = {
  originPattern: string;
  accounts: Account[];
  spec: LoginSpec;
  name?: string;
  tags?: string[];
  matchPath?: string;
  entryUrl?: string;
  tabOrder?: ('users' | 'quicklogin')[];
  envBadge?: Partial<EnvBadgeConfig>;
};

export type FixtureEnvironment = {
  /** 环境 key：具体 origin，或带路径作用域/通配符的完整 key。 */
  key: string;
  name: string;
  tags?: string[];
  matchPath?: string;
  entryUrl?: string;
  spec: LoginSpec;
};

export type MakeMultiEnvironmentConfigOptions = {
  /** 按数组顺序写入 domains；匹配优先级由产品规则决定，不由插入顺序决定。 */
  environments: FixtureEnvironment[];
  accounts: Account[];
  tabOrder?: ('users' | 'quicklogin')[];
  envBadge?: Partial<EnvBadgeConfig>;
};

const DEFAULT_SELECTORS: LoginSelectors = {
  username: '#username',
  password: '#password',
  submit: '#submit-btn',
};

function normalizePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

/** 所有工厂共用：生成前必须通过真实保存期校验器，非法声明不进入种子。 */
function assertValidLoginSpec(spec: LoginSpec): LoginSpec {
  const issues = validateLoginSpec(spec);
  if (issues.length > 0) {
    throw new Error(
      `invalid fixture login spec: ${issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  return spec;
}

/**
 * 标准表单登录声明：清理 Cookie → 打开登录页 → 填用户名/密码 → 提交 → 写会话。
 * auth.mode = 'page'，认证由站点表单自身的响应建立，测试不代劳。
 */
export function pageLoginSpec(
  options: PageLoginSpecOptions = {},
): LoginSpec {
  const loginPath = normalizePath(options.loginPath ?? '/login');
  const selectors: LoginSelectors = {
    ...DEFAULT_SELECTORS,
    ...options.selectors,
  };
  const clearFirst = options.clearFirst ?? true;

  const ops: SpecOp[] = [
    { op: 'clear.cookies', range: 'all' },
    { op: 'goto', url: `{origin}${loginPath}`, waitForLoad: true },
    {
      op: 'fill',
      target: selectors.username,
      value: '{username}',
      clearFirst,
    },
    {
      op: 'fill',
      target: selectors.password,
      value: '{password}',
      clearFirst,
    },
    ...(options.preSubmitOps ?? []),
    { op: 'click', target: selectors.submit, onNotFound: 'fail' },
    { op: 'auth.write' },
  ];

  return assertValidLoginSpec({
    version: LOGIN_SPEC_VERSION,
    template: 'generic',
    ops,
    // 等目标文档真正出现（登录表单消失），而不是等 `window.location.assign`
    // 一改地址就成立的 urlChanged：后者可能在表单重定向提交前触发，使
    // `refreshAfterSwitch` 的尾部 reload 竞态地重载旧登录页。
    success: [{ page: { type: 'formGone' } }],
    auth: { mode: 'page' },
  });
}

/**
 * API 登录（HttpOnly Cookie）：请求 `/api/token`，把响应里的 sessionToken
 * 写成 Cookie，再导航到控制台。成功信号只认响应里的 sessionToken。
 */
export function apiCookieLoginSpec(): LoginSpec {
  return assertValidLoginSpec({
    version: LOGIN_SPEC_VERSION,
    template: 'api',
    ops: [
      { op: 'clear.cookies', range: 'all' },
      { op: 'goto', url: '{origin}/login', waitForLoad: true },
      {
        op: 'http.execute',
        url: '{origin}/api/token',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { json: { username: '{username}', password: '{password}' } },
        parse: 'json',
        expectStatus: '2xx',
        as: 'token',
      },
      { op: 'auth.write' },
      { op: 'goto', url: '{origin}/console', waitForLoad: true },
    ],
    success: [{ token: { from: 'token', path: 'data.sessionToken' } }],
    auth: {
      mode: 'engine',
      cookiesWrite: [
        {
          name: 'shadekit_session',
          value: '$token.data.sessionToken',
          httpOnly: true,
          sameSite: 'lax',
        },
      ],
    },
    limits: { requestMs: 15000, stepMs: 5000, settleMs: 10000 },
  });
}

/**
 * API 登录（localStorage）：accessToken 写入 `access_token`，由
 * `/api-console` 用 bearer 头向服务端换取身份。
 */
export function apiStorageLoginSpec(): LoginSpec {
  return assertValidLoginSpec({
    version: LOGIN_SPEC_VERSION,
    template: 'api',
    ops: [
      { op: 'clear.cookies', range: 'all' },
      { op: 'clear.storage', area: 'local', range: ['access_token'] },
      { op: 'goto', url: '{origin}/login', waitForLoad: true },
      {
        op: 'http.execute',
        url: '{origin}/api/token',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { json: { username: '{username}', password: '{password}' } },
        parse: 'json',
        expectStatus: '2xx',
        as: 'token',
      },
      { op: 'auth.write' },
      { op: 'goto', url: '{origin}/api-console', waitForLoad: true },
    ],
    success: [{ token: { from: 'token', path: 'data.accessToken' } }],
    auth: {
      mode: 'engine',
      cookiesWrite: [],
      localStorageWrite: [
        { key: 'access_token', value: '$token.data.accessToken' },
      ],
    },
    limits: { requestMs: 15000, stepMs: 5000, settleMs: 10000 },
  });
}

function cloneAccounts(accounts: Account[]): Account[] {
  return accounts.map((account) => ({
    ...account,
    roles: [...account.roles],
    domains: [...account.domains],
  }));
}

function toDomainConfig(environment: {
  name: string;
  tags?: string[];
  matchPath?: string;
  entryUrl?: string;
  spec: LoginSpec;
}): DomainConfig {
  // 调用方可能传入手写声明；种子工厂统一在落盘前走校验器。
  assertValidLoginSpec(environment.spec);
  return {
    name: environment.name,
    tags: [...(environment.tags ?? [])],
    loginMethod: 'generic',
    ...(environment.matchPath ? { matchPath: environment.matchPath } : {}),
    ...(environment.entryUrl ? { entryUrl: environment.entryUrl } : {}),
    strategyConfig: { spec: structuredClone(environment.spec) },
  };
}

export function fixtureAccounts(domains: string[]): Account[] {
  return [
    {
      id: 'fixture-admin',
      name: FIXTURE_ADMIN_NAME,
      username: 'admin@fixture.test',
      password: FIXTURE_PASSWORD,
      roles: ['管理员'],
      domains: [...domains],
    },
    {
      id: 'fixture-tester',
      name: FIXTURE_TESTER_NAME,
      username: 'tester@fixture.test',
      password: FIXTURE_PASSWORD,
      roles: ['普通用户'],
      domains: [...domains],
    },
  ];
}

export function makeAccountSwitchConfig(
  options: MakeAccountSwitchConfigOptions,
): AccountSwitchConfig {
  const environment = toDomainConfig({
    name: options.name ?? '测试环境',
    tags: options.tags,
    matchPath: options.matchPath,
    entryUrl: options.entryUrl,
    spec: options.spec,
  });

  return {
    accounts: cloneAccounts(options.accounts),
    domains: { [options.originPattern]: environment },
    envBadge: {
      enabled: true,
      position: 'bottom-right',
      whitelist: [options.originPattern],
      ...(options.envBadge ?? {}),
    },
    tabOrder: [...(options.tabOrder ?? ['users', 'quicklogin'])],
  };
}

/**
 * 多环境配置：用于同 origin 路径子环境、通配符 + 精确 origin 等需要多个
 * domains key 的 E2E 场景。环境名与登录声明各自独立，账号按 domains 绑定过滤。
 */
export function makeMultiEnvironmentConfig(
  options: MakeMultiEnvironmentConfigOptions,
): AccountSwitchConfig {
  const domains: Record<string, DomainConfig> = {};
  for (const environment of options.environments) {
    domains[environment.key] = toDomainConfig(environment);
  }

  return {
    accounts: cloneAccounts(options.accounts),
    domains,
    envBadge: {
      enabled: true,
      position: 'bottom-right',
      whitelist: Object.keys(domains),
      ...(options.envBadge ?? {}),
    },
    tabOrder: [...(options.tabOrder ?? ['users', 'quicklogin'])],
  };
}

/**
 * 通过扩展自己的保存链路写入种子配置：
 * - 打开扩展页以获得 `chrome.*` 上下文；
 * - 用 `VAULT_SAVE_CONFIG` 让 Background 走真实的明文 → 保险库引用迁移；
 * - 关闭临时页。
 *
 * 测试不得直接写 `devtools-account-switch`（迁移专项除外）：直接写会绕过
 * 凭据引用，面板将看到 `hasSavedPassword: false`。
 */
export async function seedAccountSwitch(
  context: BrowserContext,
  config: AccountSwitchConfig,
): Promise<void> {
  const worker = await findExtensionWorker(context);
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  try {
    await page.goto(
      `chrome-extension://${extensionId}/options.html?section=account-switch`,
    );
    const response = await page.evaluate(async (patch) => {
      return (await chrome.runtime.sendMessage({
        type: 'VAULT_SAVE_CONFIG',
        patch,
      })) as { success: boolean; error?: string } | undefined;
    }, config);
    if (!response?.success) {
      throw new Error(
        `seeding account switch config failed: ${
          response?.error ?? 'background did not respond'
        }`,
      );
    }
    await page.evaluate(async () => {
      // 面板/配置页的暗色态也纳入 E2E 观察面（不依赖系统主题）。
      await chrome.storage.local.set({ 'devtools-theme': 'dark' });
    });
  } finally {
    await page.close();
  }
}
