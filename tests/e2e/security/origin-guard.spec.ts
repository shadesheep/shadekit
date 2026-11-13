import { test, expect } from '../fixtures/extension';
import {
  FIXTURE_ADMIN_NAME,
  apiCookieLoginSpec,
  fixtureAccounts,
  makeAccountSwitchConfig,
  seedAccountSwitch,
} from '../fixtures/config';
import { expectNoAuthentication, runAccount } from '../fixtures/pages';

type AuthLogEntry = {
  category?: string;
  level?: string;
  message?: string;
  extra?: { action?: string; errorCode?: string };
};

test('[GUARD-01] rejects session writes after the executing page navigates away', async ({
  context,
  fixtureServer,
  worker,
  readStorage,
}) => {
  const origin = fixtureServer.urlFor('exact.test');
  const otherOrigin = fixtureServer.urlFor('other.test');
  await seedAccountSwitch(
    context,
    makeAccountSwitchConfig({
      originPattern: origin,
      accounts: fixtureAccounts([origin]),
      spec: apiCookieLoginSpec(),
    }),
  );
  const page = await context.newPage();
  await page.goto(fixtureServer.urlFor('exact.test', '/login'));

  let navigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations += 1;
  });

  const barrier = fixtureServer.holdResponse('/api/token');
  try {
    await runAccount(page, worker, FIXTURE_ADMIN_NAME);
    await barrier.entered;

    // 登录请求仍在途：把执行页换到另一个 origin，再放行响应。
    await page.goto(fixtureServer.urlFor('other.test', '/login'));
    const navigationsAfterMove = navigations;
    const timeOriginAfterMove = await page.evaluate(() => performance.timeOrigin);

    barrier.release();

    await expect
      .poll(
        async () => {
          const logs = (await readStorage<AuthLogEntry[]>('devtools-logs')) ?? [];
          return logs.some(
            (entry) =>
              entry.category === 'auth' &&
              entry.level === 'error' &&
              entry.extra?.action === 'SWITCH_ACCOUNT' &&
              entry.extra?.errorCode === 'INJECT_AUTH_FAILED',
          );
        },
        { timeout: 20_000 },
      )
      .toBe(true);

    // 错误目标没有认证 Cookie/Storage，也没有尾部刷新或导航回写。
    await expectNoAuthentication(page, otherOrigin);
    await expectNoAuthentication(page, origin);
    await page.waitForTimeout(300);
    expect(navigations).toBe(navigationsAfterMove);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(
      timeOriginAfterMove,
    );
  } finally {
    barrier.release();
  }
});
