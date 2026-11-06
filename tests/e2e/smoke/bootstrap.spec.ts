import type { Page, Worker } from '@playwright/test';
import { test, expect } from '../fixtures/extension';

type ProbeResult = { status: number; body: string; error?: string };

async function probe(
  target: Page | Worker,
  urls: string[],
): Promise<ProbeResult[]> {
  return (target as Page).evaluate(
    async (targets: string[]) =>
      Promise.all(
        targets.map(async (url): Promise<ProbeResult> => {
          try {
            const response = await fetch(url);
            return { status: response.status, body: await response.text() };
          } catch (error) {
            return { status: 0, body: '', error: String(error) };
          }
        }),
      ),
    urls,
  );
}

test('[BOOTSTRAP-01] loads the built MV3 extension and opens options @smoke', async ({
  context,
  extensionId,
  worker,
}) => {
  expect(extensionId).toMatch(/^[a-p]{32}$/);
  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.permissions).toContain('storage');
  expect(manifest.host_permissions).toEqual(
    expect.arrayContaining(['http://*/*', 'https://*/*']),
  );

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(page.locator('#app > *').first()).toBeVisible();
  await expect(page).toHaveTitle('ShadeKit');
});

test('[BOOTSTRAP-NETWORK-01] routes page and worker traffic through the default-deny proxy @smoke', async ({
  context,
  egressProxy,
  fixtureServer,
  worker,
}) => {
  const allowedUrl = fixtureServer.urlFor('exact.test', '/health');
  const blockedUrls = ['http://blocked.invalid/', 'http://192.0.2.1/'];

  const page = await context.newPage();
  await page.goto(allowedUrl);

  const [pageAllowed] = await probe(page, [allowedUrl]);
  expect(pageAllowed.error).toBeUndefined();
  expect(pageAllowed.status).toBe(200);
  expect(JSON.parse(pageAllowed.body)).toEqual({ ok: true });

  const [workerAllowed] = await probe(worker, [allowedUrl]);
  expect(workerAllowed.error).toBeUndefined();
  expect(workerAllowed.status).toBe(200);
  expect(JSON.parse(workerAllowed.body)).toEqual({ ok: true });

  const beforeNegatives = egressProxy.diagnostics();

  for (const target of [page, worker] as const) {
    for (const result of await probe(target, blockedUrls)) {
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(403);
      expect(JSON.parse(result.body)).toMatchObject({
        error: 'egress_denied',
        reason: 'host-not-registered',
      });
    }
  }

  const afterNegatives = egressProxy.diagnostics();
  expect(afterNegatives.upstreamConnections).toBe(
    beforeNegatives.upstreamConnections,
  );
  expect(afterNegatives.deniedRequests).toBeGreaterThanOrEqual(
    beforeNegatives.deniedRequests + blockedUrls.length * 2,
  );

  const deniedTargets = afterNegatives.entries
    .filter((entry) => entry.decision === 'denied')
    .map((entry) => entry.target);
  expect(deniedTargets).toEqual(expect.arrayContaining(blockedUrls));
  expect(
    afterNegatives.entries.some(
      (entry) =>
        entry.decision === 'denied' && entry.reason === 'host-not-registered',
    ),
  ).toBe(true);
});
