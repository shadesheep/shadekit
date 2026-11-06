import { test as base, chromium, expect } from '@playwright/test';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostResolverRules } from './hosts';
import { createFixtureServer, type FixtureServer } from './server';
import { createEgressProxy, type EgressProxy } from './egress';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const EXTENSION_DIR = resolve(ROOT, '.output/chrome-mv3');

export type ExtensionSessionOptions = {
  userDataDir: string;
  egressProxyUrl: string;
  headless: boolean;
  videoDir?: string;
};

export type ExtensionSession = {
  context: BrowserContext;
  tracingStarted: boolean;
  userDataDir: string;
};

export type ExtensionSessionState = {
  context?: BrowserContext;
  tracingStarted: boolean;
  userDataDir: string;
};

export type CloseExtensionSessionOptions = {
  tracePath?: string;
};

export async function openExtensionSession(
  options: ExtensionSessionOptions,
): Promise<ExtensionSession> {
  const context = await chromium.launchPersistentContext(
    options.userDataDir,
    {
      executablePath: chromium.executablePath(),
      headless: options.headless,
      viewport: { width: 1440, height: 900 },
      ...(options.videoDir
        ? { recordVideo: { dir: options.videoDir } }
        : {}),
      proxy: { server: options.egressProxyUrl, bypass: '<-loopback>' },
      args: [
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
        `--host-resolver-rules=${hostResolverRules()}`,
        '--disable-quic',
        '--disable-background-networking',
        '--disable-component-update',
        '--no-first-run',
      ],
    },
  );

  try {
    await context.tracing.start({ screenshots: true, snapshots: true });
  } catch (error) {
    let closeError: unknown;
    try {
      await context.close();
    } catch (cleanupError) {
      closeError = cleanupError;
    }
    if (closeError !== undefined) {
      throw new AggregateError(
        [error, closeError],
        'extension session startup failed and the launched browser could not be closed',
      );
    }
    throw error;
  }

  return { context, tracingStarted: true, userDataDir: options.userDataDir };
}

export async function closeExtensionSession(
  session: ExtensionSessionState,
  options: CloseExtensionSessionOptions = {},
): Promise<unknown[]> {
  const cleanupErrors: unknown[] = [];

  if (session.context) {
    const context = session.context;
    if (session.tracingStarted) {
      try {
        await context.tracing.stop(
          options.tracePath ? { path: options.tracePath } : {},
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await context.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  try {
    await rm(session.userDataDir, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }

  return cleanupErrors;
}

const TRANSIENT_WORKER_ERROR =
  /execution context was destroyed|target closed|session closed|worker.*(?:closed|destroyed)|service worker.*(?:terminated|stopped)/i;

export function isTransientWorkerError(error: unknown): boolean {
  return TRANSIENT_WORKER_ERROR.test(String(error));
}

async function isUsableExtensionWorker(worker: Worker): Promise<boolean> {
  if (!worker.url().startsWith('chrome-extension://')) return false;
  try {
    await worker.evaluate(() => chrome.runtime.id);
    return true;
  } catch {
    return false;
  }
}

export async function findExtensionWorker(
  context: BrowserContext,
  timeoutMs = 30_000,
): Promise<Worker> {
  for (const worker of context.serviceWorkers()) {
    if (await isUsableExtensionWorker(worker)) {
      return worker;
    }
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const worker = await context
      .waitForEvent('serviceworker', {
        timeout: Math.max(deadline - Date.now(), 1),
      })
      .catch(() => undefined);
    if (!worker) break;
    if (await isUsableExtensionWorker(worker)) {
      return worker;
    }
  }

  throw new Error('ShadeKit extension service worker did not start');
}

export type ExtensionFixtures = {
  fixtureServer: FixtureServer;
  egressProxy: EgressProxy;
  context: BrowserContext;
  worker: Worker;
  extensionId: string;
  openOptions: () => Promise<Page>;
  openExtensionPage: (path: string) => Promise<Page>;
  readStorage: <T>(key: string) => Promise<T | undefined>;
  writeStorage: (entries: Record<string, unknown>) => Promise<void>;
  clearStorage: () => Promise<void>;
};

export const test = base.extend<ExtensionFixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture callbacks to destructure their dependency object
  fixtureServer: async ({}, use) => {
    const server = await createFixtureServer();
    try {
      await use(server);
    } finally {
      await server.close();
    }
  },
  egressProxy: async ({ fixtureServer }, use) => {
    const proxy = await createEgressProxy();
    const revoke = proxy.allowServer(fixtureServer);
    try {
      await use(proxy);
    } finally {
      revoke();
      await proxy.close();
    }
  },
  context: async ({ fixtureServer, egressProxy }, use, testInfo) => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'shadekit-e2e-'));
    let context: BrowserContext | undefined;
    let tracingStarted = false;
    let primaryError: unknown;
    const pageErrors: string[] = [];
    const cleanupErrors: unknown[] = [];
    const cleanup = async (operation: () => Promise<unknown>) => {
      try {
        await operation();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };

    try {
      const session = await openExtensionSession({
        userDataDir,
        egressProxyUrl: egressProxy.url,
        headless: process.env.E2E_HEADED !== '1',
        videoDir: testInfo.outputPath('video'),
      });
      context = session.context;
      tracingStarted = session.tracingStarted;

      const trackPage = (page: Page) =>
        page.on('pageerror', (error) => pageErrors.push(error.message));
      context.pages().forEach(trackPage);
      context.on('page', trackPage);

      await use(context);

      if (pageErrors.length) {
        throw new Error(`Unexpected page errors: ${pageErrors.join('; ')}`);
      }
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await cleanup(async () => {
        const path = testInfo.outputPath('fixture-network.json');
        await writeFile(
          path,
          JSON.stringify(
            {
              server: fixtureServer.diagnostics(),
              proxy: egressProxy.diagnostics(),
            },
            null,
            2,
          ),
        );
        await testInfo.attach('fixture-network', {
          path,
          contentType: 'application/json',
        });
      });

      if (context) {
        const activeContext = context;
        if (
          primaryError !== undefined ||
          testInfo.status !== testInfo.expectedStatus
        ) {
          for (const [index, page] of activeContext.pages().entries()) {
            if (page.isClosed()) continue;
            await cleanup(async () => {
              const path = testInfo.outputPath(`failure-${index}.png`);
              await page.screenshot({ path });
              await testInfo.attach(`failure-${index}`, {
                path,
                contentType: 'image/png',
              });
            });
          }
        }
      }

      cleanupErrors.push(
        ...(await closeExtensionSession(
          { context, tracingStarted, userDataDir },
          { tracePath: testInfo.outputPath('trace.zip') },
        )),
      );

      if (cleanupErrors.length) {
        await cleanup(async () => {
          await testInfo.attach('cleanup-errors', {
            body: Buffer.from(cleanupErrors.map(String).join('\n')),
            contentType: 'text/plain',
          });
        });
        if (primaryError === undefined && testInfo.errors.length === 0) {
          // biome-ignore lint/correctness/noUnsafeFinally: cleanup failures must fail the test only when no earlier failure exists, so the original error is never overwritten
          throw new AggregateError(cleanupErrors, 'Fixture cleanup failed');
        }
      }
    }
  },
  worker: async ({ context }, use) => {
    const worker = await findExtensionWorker(context);
    await use(worker);
  },
  extensionId: async ({ worker }, use) => {
    await use(new URL(worker.url()).host);
  },
  openExtensionPage: async ({ context, extensionId }, use) => {
    await use(async (path) => {
      const page = await context.newPage();
      await page.goto(
        `chrome-extension://${extensionId}/${path.replace(/^\//, '')}`,
      );
      return page;
    });
  },
  openOptions: async ({ openExtensionPage }, use) => {
    await use(() => openExtensionPage('options.html?section=account-switch'));
  },
  readStorage: async ({ context, worker }, use) => {
    await use(async <T,>(key: string) => {
      const read = (target: Worker) =>
        target.evaluate(
          async (storageKey) =>
            (await chrome.storage.local.get(storageKey))[storageKey],
          key,
        );
      let value: unknown;
      try {
        value = await read(worker);
      } catch (error) {
        if (!isTransientWorkerError(error)) throw error;
        // Reads are idempotent: rediscover the worker and retry once.
        value = await read(await findExtensionWorker(context));
      }
      return value as T | undefined;
    });
  },
  writeStorage: async ({ worker }, use) => {
    await use(async (entries) => {
      await worker.evaluate(
        async (data) => chrome.storage.local.set(data),
        entries,
      );
    });
  },
  clearStorage: async ({ worker }, use) => {
    await use(async () => {
      await worker.evaluate(async () => chrome.storage.local.clear());
    });
  },
});

export { expect };
