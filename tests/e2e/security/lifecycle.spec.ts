import type { BrowserContext, CDPSession, Page, Worker } from '@playwright/test';
import {
  test,
  expect,
  findExtensionWorker,
  isTransientWorkerError,
} from '../fixtures/extension';
import {
  FIXTURE_ADMIN_NAME,
  FIXTURE_PASSWORD,
  FIXTURE_TESTER_NAME,
  fixtureAccounts,
  makeMultiEnvironmentConfig,
  pageLoginSpec,
  seedAccountSwitch,
  specWithFailure,
} from '../fixtures/config';
import {
  ConsolePage,
  expectAccountFailure,
  loginViaPanel,
  submitQuickLogin,
  switchTo,
} from '../fixtures/pages';

const TESTER_IDENTITY = {
  role: 'tester',
  name: '周然',
  email: 'tester@fixture.test',
  title: '验收测试',
  scope: '验收任务 · 回归与结果提交',
} as const;

const ADMIN_IDENTITY = {
  role: 'admin',
  name: '林屿',
  email: 'admin@fixture.test',
  title: '交付管理员',
  scope: '全部项目 · 发布与权限管理',
} as const;

type AuthLogEntry = { message?: string; extra?: { action?: string } };

async function extensionWorkerVersion(
  context: BrowserContext,
  page: Page,
  extensionId: string,
): Promise<{ cdp: CDPSession; versionId: string }> {
  // ServiceWorker 域挂在页面 target 上；browser target 不暴露该域。
  const cdp = await context.newCDPSession(page);
  // Node 20 没有 Promise.withResolvers；Promise 构造器是这里的边界 API。
  let resolveVersion!: (value: { versionId: string }) => void;
  let rejectVersion!: (reason?: unknown) => void;
  const version = new Promise<{ versionId: string }>((resolve, reject) => {
    resolveVersion = resolve;
    rejectVersion = reject;
  });
  const timer = setTimeout(
    () => rejectVersion(new Error('extension service worker version not reported')),
    15_000,
  );
  cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
    const match = versions.find(
      (candidate) =>
        candidate.scriptURL.startsWith(`chrome-extension://${extensionId}/`) &&
        candidate.runningStatus === 'running',
    );
    if (!match) return;
    clearTimeout(timer);
    resolveVersion({ versionId: match.versionId });
  });
  await cdp.send('ServiceWorker.enable');
  return { cdp, versionId: (await version).versionId };
}

async function waitForLog(
  worker: Worker,
  predicate: (entry: AuthLogEntry) => boolean,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const logs =
          (await worker.evaluate(
            async () =>
              (await chrome.storage.local.get('devtools-logs'))['devtools-logs'],
          )) as AuthLogEntry[] | undefined;
        return (logs ?? []).some(predicate);
      },
      { timeout: 20_000 },
    )
    .toBe(true);
}

test('[LIFE-01] recovers after the extension worker is stopped and woken by a message', async ({
  context,
  fixtureServer,
  worker,
  extensionId,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seedAccountSwitch(
    context,
    makeMultiEnvironmentConfig({
      environments: [
        { key: origin, name: '测试环境', spec: pageLoginSpec({}) },
      ],
      accounts: fixtureAccounts([origin]),
    }),
  );
  const page = await context.newPage();
  await page.goto(fixtureServer.urlFor('exact.test', '/login'));
  await loginViaPanel(page, worker, FIXTURE_TESTER_NAME);
  await new ConsolePage(page).expectIdentity(TESTER_IDENTITY);

  const { cdp, versionId } = await extensionWorkerVersion(
    context,
    page,
    extensionId,
  );
  // ServiceWorker 域给出真实的 stopping → stopped → running 版本事件；
  // Playwright 的 worker handle 不一定随 stopWorker 关闭，不能以它判断停止。
  const statuses: string[] = [];
  cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
    statuses.push(...versions.map((version) => version.runningStatus));
  });
  await cdp.send('ServiceWorker.stopWorker', { versionId });
  await expect
    .poll(() => statuses.includes('stopped'), { timeout: 20_000 })
    .toBe(true);

  // 扩展页消息唤醒 worker；重新发现当前可用 handle 再登录。
  const extensionPage = await context.newPage();
  await extensionPage.goto(`chrome-extension://${extensionId}/options.html`);
  await extensionPage.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_PANEL' }),
  );
  await expect
    .poll(
      () => {
        const stopped = statuses.indexOf('stopped');
        return stopped >= 0 && statuses.indexOf('running', stopped) > stopped;
      },
      { timeout: 20_000 },
    )
    .toBe(true);

  const newWorker = await findExtensionWorker(context);
  expect(newWorker.url()).toContain(extensionId);
  await extensionPage.close();

  await switchTo(page, newWorker, FIXTURE_ADMIN_NAME);
  await new ConsolePage(page).expectIdentity(ADMIN_IDENTITY);
});

test('[LIFE-02] recovers after the extension runtime restarts and keeps config and credentials', async ({
  context,
  fixtureServer,
  worker,
  extensionId,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  await seedAccountSwitch(
    context,
    makeMultiEnvironmentConfig({
      environments: [
        {
          key: origin,
          name: '测试环境',
          spec: pageLoginSpec({}),
          defaultPassword: FIXTURE_PASSWORD,
        },
      ],
      accounts: fixtureAccounts([origin]),
    }),
  );
  const page = await context.newPage();
  await page.goto(fixtureServer.urlFor('exact.test', '/login'));
  await loginViaPanel(page, worker, FIXTURE_TESTER_NAME);
  await new ConsolePage(page).expectIdentity(TESTER_IDENTITY);

  // chrome.runtime.reload() 会让命令行加载的扩展在 Chrome for Testing 中
  // 永久进入损坏/禁用态；restart() 走同一条扩展重启生命周期且保持可用。
  await worker.evaluate(() => chrome.runtime.restart()).catch((error: unknown) => {
    if (!isTransientWorkerError(error)) throw error;
  });
  const newWorker = await findExtensionWorker(context, 30_000);
  expect(newWorker.url()).toContain(extensionId);

  const config = (await newWorker.evaluate(
    async () =>
      (await chrome.storage.local.get('devtools-account-switch'))[
        'devtools-account-switch'
      ],
  )) as {
    accounts: Array<{ id: string; credentialRef?: string }>;
    domains: Record<string, { defaultCredentialRef?: string }>;
  };
  expect(config.accounts.find((account) => account.id === 'fixture-admin')).toMatchObject(
    { credentialRef: 'account:fixture-admin' },
  );
  expect(config.domains[origin]?.defaultCredentialRef).toBeTruthy();

  const extensionPage = await context.newPage();
  await extensionPage.goto(`chrome-extension://${extensionId}/options.html`);
  const secret = await extensionPage.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'VAULT_HAS_SECRET',
      credentialId: 'account:fixture-admin',
    }),
  );
  expect(secret).toMatchObject({ success: true, hasSecret: true });
  await extensionPage.close();

  // 旧 worker handle 可能仍指向已关闭的 target；刷新站点重建 content script 后再登录。
  await page.reload();
  await switchTo(page, newWorker, FIXTURE_ADMIN_NAME);
  await new ConsolePage(page).expectIdentity(ADMIN_IDENTITY);
});

test('[LIFE-03] recovers when the executing page closes mid-login', async ({
  context,
  fixtureServer,
  worker,
}) => {
  const exactOrigin = new URL(fixtureServer.urlFor('exact.test')).origin;
  const otherOrigin = new URL(fixtureServer.urlFor('other.test')).origin;
  await seedAccountSwitch(
    context,
    makeMultiEnvironmentConfig({
      environments: [
        {
          key: exactOrigin,
          name: '测试环境',
          spec: pageLoginSpec({}),
          defaultPassword: FIXTURE_PASSWORD,
        },
        {
          key: otherOrigin,
          name: '其他环境',
          spec: specWithFailure(pageLoginSpec({}), [
            { type: 'selector', target: '#login-error' },
          ]),
        },
      ],
      accounts: fixtureAccounts([exactOrigin, otherOrigin]),
    }),
  );

  const page = await context.newPage();
  await page.goto(fixtureServer.urlFor('exact.test', '/login'));
  const barrier = fixtureServer.holdResponse('/api/session/login');
  try {
    await submitQuickLogin(page, worker, 'tester@fixture.test');
    await barrier.entered;
    await page.close();
  } finally {
    barrier.release();
  }

  await waitForLog(
    worker,
    (entry) =>
      entry.extra?.action === 'QUICK_LOGIN' &&
      typeof entry.message === 'string' &&
      entry.message.includes('失败'),
  );

  const recovered = await context.newPage();
  await recovered.goto(fixtureServer.urlFor('exact.test', '/login'));
  await loginViaPanel(recovered, worker, FIXTURE_ADMIN_NAME);
  await new ConsolePage(recovered).expectIdentity(ADMIN_IDENTITY);

  // 新标签页登录失败时按既有回滚契约关闭，不留下空标签页。
  const tabsBeforeFailure = context.pages().length;
  const targetPromise = context.waitForEvent('page');
  await submitQuickLogin(
    recovered,
    worker,
    `${otherOrigin}/console\nadmin@fixture.test/wrong-password`,
  );
  const target = await targetPromise;
  await expect
    .poll(() => target.isClosed(), { timeout: 30_000 })
    .toBe(true);
  expect(context.pages()).toHaveLength(tabsBeforeFailure);
  await expectAccountFailure(recovered, /登录失败|Invalid|失败/);
});
