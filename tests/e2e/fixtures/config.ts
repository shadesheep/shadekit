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
    { op: 'click', target: selectors.submit, onNotFound: 'fail' },
    { op: 'auth.write' },
  ];

  return assertValidLoginSpec({
    version: LOGIN_SPEC_VERSION,
    template: 'generic',
    ops,
    success: [
      {
        page: {
          type: 'any',
          of: [{ type: 'formGone' }, { type: 'urlChanged' }],
        },
      },
    ],
    auth: { mode: 'page' },
  });
}

export function fixtureAccounts(domains: string[]): Account[] {
  return [
    {
      id: 'fixture-admin',
      name: '林屿 · 交付管理员',
      username: 'admin@fixture.test',
      password: FIXTURE_PASSWORD,
      roles: ['管理员'],
      domains: [...domains],
    },
    {
      id: 'fixture-tester',
      name: '周然 · 验收测试',
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
  // 调用方可能传入手写声明；种子工厂统一在落盘前走校验器。
  assertValidLoginSpec(options.spec);
  const environment: DomainConfig = {
    name: options.name ?? '测试环境',
    tags: [...(options.tags ?? [])],
    loginMethod: 'generic',
    ...(options.matchPath ? { matchPath: options.matchPath } : {}),
    ...(options.entryUrl ? { entryUrl: options.entryUrl } : {}),
    strategyConfig: { spec: structuredClone(options.spec) },
  };

  return {
    accounts: options.accounts.map((account) => ({
      ...account,
      roles: [...account.roles],
      domains: [...account.domains],
    })),
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
