import { test, expect } from '../fixtures/extension';
import {
  FIXTURE_PASSWORD,
  fixtureAccounts,
  makeAccountSwitchConfig,
  pageLoginSpec,
  seedAccountSwitch,
} from '../fixtures/config';
import { OptionsPage } from '../fixtures/pages';
import type { AccountSwitchConfig } from '../../../entrypoints/tools/account-switch/types';

test('[SEED-01] seeded wildcard environment and accounts render in options', async ({
  openOptions,
  fixtureServer,
  context,
  readStorage,
}) => {
  const pattern = `http://*.wild.test:${fixtureServer.port}`;
  await seedAccountSwitch(
    context,
    makeAccountSwitchConfig({
      originPattern: pattern,
      accounts: fixtureAccounts([pattern]),
      spec: pageLoginSpec({}),
    }),
  );

  const page = await openOptions();
  const options = new OptionsPage(page);
  await options.expectEnvironment('测试环境');
  await options.expectAccount('林屿 · 交付管理员');
  await options.expectAccount('周然 · 验收测试');

  const stored = await readStorage<AccountSwitchConfig>(
    'devtools-account-switch',
  );
  expect(stored?.domains[pattern]?.name).toBe('测试环境');

  const admin = stored?.accounts.find(
    (account) => account.id === 'fixture-admin',
  );
  expect(admin?.password).toBe(FIXTURE_PASSWORD);

  // 密码以明文保存在配置里，不再有保险库密文。
  expect(JSON.stringify(stored)).toContain(FIXTURE_PASSWORD);
});
