/**
 * Task 8 — end-to-end secret and recovery boundary regression.
 *
 * Canaries:
 * - SAVED-PASSWORD-91: saved account password
 * - SAVED-TOKEN-72: saved secret login variable
 * - ONE-TIME-38: one-shot password typed by the user for a single run
 *
 * The only sanctioned plaintext surface is exportPlaintextBackup(). Every
 * ordinary config, public DTO, content-facing message response, log,
 * diagnostic projection, migration journal/recovery copy and vault key must
 * stay free of the saved canaries; the one-shot password must never be
 * persisted at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const keyStore = vi.hoisted(() => ({ kek: undefined as CryptoKey | undefined }));
vi.mock("../entrypoints/shared/security/crypto-key-store", () => ({
  loadVaultKek: vi.fn(async () => keyStore.kek),
  saveVaultKek: vi.fn(async (kek: CryptoKey) => {
    keyStore.kek = kek;
  }),
  deleteVaultKek: vi.fn(async () => {
    keyStore.kek = undefined;
  }),
}));

const loginRun = vi.hoisted(() => ({
  credentials: [] as Array<{ username: string; password: string }>,
  logWhileRunning: false,
}));
vi.mock("../entrypoints/tools/account-switch/spec/login-run", () => ({
  runLoginSpec: async (
    _spec: unknown,
    ctx: { credentials: { username: string; password: string } },
  ) => {
    loginRun.credentials.push({ ...ctx.credentials });
    if (loginRun.logWhileRunning) {
      // Simulate a controlled run that puts the live credential into a log
      // field while the run still holds the redaction registration.
      const { logger } = await import("../entrypoints/shared/logger");
      await logger.info("受控运行调试", {
        category: "auth",
        extra: { opaque: ctx.credentials.password },
        request: { password: ctx.credentials.password },
      });
    }
    return { success: true };
  },
}));
vi.mock("../entrypoints/tools/account-switch/login-tab-flow", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../entrypoints/tools/account-switch/login-tab-flow")
  >();
  return {
    ...actual,
    injectAndNavigate: vi.fn(async () => ({ success: true })),
    refreshAfterSwitch: vi.fn(async () => undefined),
    setupAuthTab: vi.fn(async () => undefined),
  };
});

import { clearLogs, exportLogs, getLogs, logger, registerLogSecrets } from "../entrypoints/shared/logger";
import { createBackgroundMessageListener } from "../entrypoints/shared/message-router";
import {
  buildMessageRouteTable,
} from "../entrypoints/shared/message-router";
import { exportPlaintextBackup } from "../entrypoints/shared/security/backup-service";
import { loadVaultKek } from "../entrypoints/shared/security/crypto-key-store";
import {
  clearCachedDek,
  putSecret,
  removeSecret,
  resolveSecret,
  VAULT_META_KEY,
  VAULT_STORAGE_KEY,
} from "../entrypoints/shared/security/vault-service";
import { allTools } from "../entrypoints/shared/tool-definitions";
import { handleGetAccountPanel, handleQuickLogin } from "../entrypoints/tools/account-switch/background-handler";
import { releaseLoginLock } from "../entrypoints/tools/account-switch/login-session";
import {
  accountCredentialId,
  migratePlaintextSecrets,
} from "../entrypoints/tools/account-switch/secret-migration";
import { buildErrorDetail } from "../entrypoints/tools/account-switch/utils/error-codes";
import { toPublicRunResult } from "../entrypoints/tools/account-switch/runtime";
import { runSpec } from "../entrypoints/tools/account-switch/runtime";
import type { HostBridge } from "../entrypoints/tools/account-switch/runtime";
import type { LoginSpec, SpecOpName } from "../entrypoints/tools/account-switch/spec/types";
import type { AccountSwitchConfig } from "../entrypoints/tools/account-switch/types";

const SAVED_PASSWORD = "SAVED-PASSWORD-91";
const SAVED_TOKEN = "SAVED-TOKEN-72";
const ONE_TIME = "ONE-TIME-38";
const ORIGIN = "https://boundary.example.com";
const PAGE_URL = `${ORIGIN}/dashboard`;
const ACCOUNT_CONFIG_KEY = "devtools-account-switch";
const EXTENSION_ID = "shadekit-boundary-extension";

const contentSender = {
  id: EXTENSION_ID,
  url: PAGE_URL,
  origin: ORIGIN,
  frameId: 0,
  tab: { id: 42, url: PAGE_URL },
} as chrome.runtime.MessageSender;
const optionsSender = {
  id: EXTENSION_ID,
  url: `chrome-extension://${EXTENSION_ID}/options.html`,
  origin: `chrome-extension://${EXTENSION_ID}`,
  frameId: 0,
} as chrome.runtime.MessageSender;

// ---------------------------------------------------------------------------
// chrome / navigator harness
// ---------------------------------------------------------------------------

const storage = new Map<string, unknown>();
let tamperNextVaultWrite = false;

const storageGet = vi.fn(async (keys: string[] | string | null) => {
  if (keys === null) return Object.fromEntries(storage);
  const wanted = typeof keys === "string" ? [keys] : keys;
  return Object.fromEntries(
    wanted
      .filter((key) => storage.has(key))
      .map((key) => [key, structuredClone(storage.get(key))]),
  );
});
const storageSet = vi.fn(async (values: Record<string, unknown>) => {
  if (tamperNextVaultWrite && Object.hasOwn(values, VAULT_STORAGE_KEY)) {
    tamperNextVaultWrite = false;
    for (const [key, value] of Object.entries(values)) {
      const records = structuredClone(value) as Record<string, { ciphertext: string }>;
      const first = Object.values(records)[0];
      if (first) first.ciphertext = "AAAA";
      storage.set(key, records);
    }
    return;
  }
  for (const [key, value] of Object.entries(values)) {
    storage.set(key, structuredClone(value));
  }
});
const storageRemove = vi.fn(async (keys: string | string[]) => {
  for (const key of Array.isArray(keys) ? keys : [keys]) storage.delete(key);
});
const tabsGet = vi.fn(async (tabId: number) => ({
  id: tabId,
  url: PAGE_URL,
  status: "complete",
}));
const tabsCreate = vi.fn(async () => ({ id: 43, url: PAGE_URL, status: "complete" }));

vi.stubGlobal("chrome", {
  permissions: { contains: async () => true, request: async () => true },
  runtime: { id: EXTENSION_ID },
  storage: { local: { get: storageGet, set: storageSet, remove: storageRemove } },
  tabs: {
    get: tabsGet,
    create: tabsCreate,
    query: vi.fn(async () => []),
    reload: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => ({ success: true })),
  },
  scripting: { executeScript: vi.fn() },
  cookies: { set: vi.fn(), getAll: vi.fn(async () => []), remove: vi.fn() },
  windows: { update: vi.fn(async () => undefined) },
});

const lockQueues = new Map<string, Promise<unknown>>();
vi.stubGlobal("navigator", {
  locks: {
    request<T>(name: string, operation: () => Promise<T>): Promise<T> {
      const previous = lockQueues.get(name) ?? Promise.resolve();
      const next = previous.then(operation, operation);
      lockQueues.set(name, next.catch(() => undefined));
      return next;
    },
  },
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function boundarySpec(token: string, withSecretDefault = true): LoginSpec {
  return {
    version: 2,
    vars: [
      {
        name: "token",
        title: "Token",
        secret: true,
        ...(withSecretDefault ? { default: token } : {}),
      },
      { name: "locale", default: "zh" },
    ],
    ops: [
      {
        op: "http.execute",
        url: "{origin}/login",
        method: "POST",
        body: {
          json: {
            username: "{username}",
            password: "{password}",
            token: "{token}",
          },
        },
        parse: "json",
        as: "resp",
      },
    ],
    success: [{ response: { from: "resp", path: "ok" } }],
    auth: { mode: "engine" },
  };
}

function legacyConfig(password: string, token: string): AccountSwitchConfig {
  return {
    accounts: [
      {
        id: "acc-boundary",
        name: "Boundary",
        username: "alice",
        password,
        roles: [],
        domains: [ORIGIN],
      },
    ],
    domains: {
      [ORIGIN]: {
        name: "Boundary",
        tags: [],
        vars: { locale: "en" },
        strategyConfig: { spec: boundarySpec(token) },
      },
    },
    strategies: {},
    globalDefaultPassword: password,
  };
}

// ---------------------------------------------------------------------------
// Named boundary surfaces (the brief's helper vocabulary)
// ---------------------------------------------------------------------------

async function seedSavedSecrets(password: string, token: string): Promise<void> {
  storage.set(ACCOUNT_CONFIG_KEY, structuredClone(legacyConfig(password, token)));
  await seedBoundaryLogs(password, token);
  await migratePlaintextSecrets();
}

async function seedBoundaryLogs(password: string, token: string): Promise<void> {
  const restore = registerLogSecrets([password, token]);
  try {
    await logger.info("受控运行调试", {
      category: "auth",
      extra: { opaque: password, opaqueToken: token },
    });
  } finally {
    restore();
  }
  await logger.warn("结构化登录请求", {
    category: "auth",
    request: { password, token },
    extra: { token },
  });
}

async function readOrdinaryConfig(): Promise<AccountSwitchConfig> {
  const stored = await chrome.storage.local.get([ACCOUNT_CONFIG_KEY]);
  return stored[ACCOUNT_CONFIG_KEY] as AccountSwitchConfig;
}

async function buildCurrentPanelDto(): Promise<unknown> {
  return handleGetAccountPanel(contentSender);
}

type Dispatched = { routed: boolean; response?: unknown };

function dispatch(
  listener: ReturnType<typeof createBackgroundMessageListener>,
  message: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<Dispatched> {
  return new Promise((resolve) => {
    const routed = listener(message, sender, (response) => {
      resolve({ routed: true, response });
    });
    if (!routed) resolve({ routed: false });
  });
}

async function readCapturedContentMessages(): Promise<Dispatched[]> {
  const listener = createBackgroundMessageListener(
    buildMessageRouteTable(allTools),
    { openToolTab: async () => undefined },
  );
  return [
    await dispatch(listener, { type: "GET_ACCOUNT_PANEL" }, contentSender),
    // Vault messages are extension-page-only; a page cannot receive config.
    await dispatch(listener, { type: "VAULT_GET_CONFIG" }, contentSender),
  ];
}

async function readLogs(): Promise<unknown> {
  return { entries: await getLogs(), exported: await exportLogs() };
}

const DIAGNOSTIC_OPS: SpecOpName[] = ["digest", "http.execute"];

function diagnosticHost(): HostBridge {
  return {
    capabilities: () => ({
      specVersions: [2],
      ops: DIAGNOSTIC_OPS,
      page: false,
      session: false,
      script: false,
    }),
    http: {
      execute: async (request) => ({
        status: 200,
        finalUrl: request.url,
        redirected: false,
        headers: {},
        text: "ok",
      }),
    },
  };
}

async function runRevealSpec(): Promise<Awaited<ReturnType<typeof runSpec>>> {
  const spec: LoginSpec = {
    version: 2,
    ops: [
      { op: "digest", algorithm: "sha256", input: "{password}", as: "sessionToken" },
      {
        op: "http.execute",
        url: "{origin}/login",
        method: "POST",
        body: { raw: "$sessionToken" },
        parse: "text",
        as: "response",
      },
    ],
    success: [],
    auth: { mode: "page" },
    log: { reveal: ["sessionToken"] },
  };
  return runSpec(
    {
      spec,
      inputs: {
        username: "alice",
        password: SAVED_PASSWORD,
        origin: ORIGIN,
      },
    },
    diagnosticHost(),
  );
}

async function readDiagnostics(): Promise<unknown> {
  const result = await runRevealSpec();
  return {
    errorDetail: buildErrorDetail("LOGIN_REJECTED", "登录被拒绝", {
      action: "SWITCH_ACCOUNT",
      origin: ORIGIN,
      username: "alice",
    }),
    publicResult: toPublicRunResult(result),
    logView: result.log,
    trace: result.trace,
    requestLog: await getLogs(),
  };
}

async function readAllStorage(): Promise<Record<string, unknown>> {
  return structuredClone(Object.fromEntries(storage));
}

/**
 * Decrypting vault surface: ciphertext alone cannot reveal a regression that
 * persisted a one-shot credential as a `credentialRef`, so resolve every
 * stored record back to plaintext for the boundary assertions.
 */
async function readDecryptedVaultSecrets(): Promise<string[]> {
  const records = (storage.get(VAULT_STORAGE_KEY) ?? {}) as Record<string, unknown>;
  const values: string[] = [];
  for (const credentialId of Object.keys(records)) {
    const secret = await resolveSecret(credentialId);
    if (secret !== undefined) values.push(secret);
  }
  return values;
}

async function readVaultKeys(): Promise<{
  kekPresent: boolean;
  kekExtractable: boolean | null;
  meta: unknown;
  wrappedMaterial: string;
}> {
  const kek = await loadVaultKek();
  const kekExtractable = kek
    ? await crypto.subtle.exportKey("raw", kek).then(
        () => true,
        () => false,
      )
    : null;
  const meta = storage.get(VAULT_META_KEY);
  return {
    kekPresent: Boolean(kek),
    kekExtractable,
    meta,
    wrappedMaterial: JSON.stringify(meta ?? {}),
  };
}

function failSecretReadbackOnce(): void {
  tamperNextVaultWrite = true;
}

async function completeQuickLoginWithTemporaryPassword(password: string): Promise<void> {
  loginRun.logWhileRunning = true;
  try {
    const result = await handleQuickLogin(
      `${ORIGIN}/login`,
      "alice",
      password,
      true,
      contentSender,
    );
    expect(result).toMatchObject({ success: true });
  } finally {
    loginRun.logWhileRunning = false;
  }
  expect(loginRun.credentials.at(-1)).toEqual({ username: "alice", password });
}

async function readPersistentAndLogSurfaces(): Promise<unknown> {
  return {
    storage: await readAllStorage(),
    ordinaryConfig: await readOrdinaryConfig(),
    panel: await buildCurrentPanelDto(),
    contentMessages: await readCapturedContentMessages(),
    logs: await readLogs(),
    diagnostics: await readDiagnostics(),
    vaultKeys: await readVaultKeys(),
    // Decrypting surfaces: a persisted one-shot credential would be invisible
    // in ciphertext but visible here (explicit full backup and per-record
    // vault resolution are the only paths that materialize plaintext).
    backup: await exportPlaintextBackup(),
    decryptedVaultSecrets: await readDecryptedVaultSecrets(),
  };
}

function expectNoCanaries(value: unknown, ...canaries: string[]): void {
  const serialized = JSON.stringify(value);
  for (const canary of canaries) {
    expect(serialized).not.toContain(canary);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  storage.clear();
  keyStore.kek = undefined;
  tamperNextVaultWrite = false;
  loginRun.credentials.length = 0;
  loginRun.logWhileRunning = false;
  lockQueues.clear();
  releaseLoginLock(42);
  clearCachedDek();
  vi.clearAllMocks();
  await clearLogs();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("扩展秘密与恢复边界", () => {
  it("contains saved canaries only in ciphertext and explicit full backup", async () => {
    await seedSavedSecrets(SAVED_PASSWORD, SAVED_TOKEN);

    // Positive controls: the saved values really reached the vault, and the
    // log/message surfaces are populated rather than trivially empty.
    const migrated = await readOrdinaryConfig();
    expect(await resolveSecret(accountCredentialId("acc-boundary"))).toBe(SAVED_PASSWORD);
    const tokenRef = Object.values(
      migrated.domains[ORIGIN]?.strategyConfig?.secretVarRefs ?? {},
    )[0];
    expect(tokenRef).toBeDefined();
    expect(await resolveSecret(tokenRef!)).toBe(SAVED_TOKEN);
    const logs = (await readLogs()) as { entries: unknown[] };
    expect(logs.entries.length).toBeGreaterThan(0);
    const panel = (await buildCurrentPanelDto()) as { accounts: unknown[] };
    expect(panel.accounts).toHaveLength(1);
    const contentMessages = await readCapturedContentMessages();
    expect(contentMessages[0]).toMatchObject({ routed: true });
    expect(contentMessages[1]).toMatchObject({
      routed: true,
      response: { success: false, errorCode: "LOGIN_REJECTED" },
    });

    const surfaces = [migrated, panel, contentMessages, logs, await readDiagnostics()];
    for (const surface of surfaces) {
      expectNoCanaries(surface, SAVED_PASSWORD, SAVED_TOKEN);
    }

    // The entire extension persistence (including ciphertext, journals and
    // encrypted recovery copies) must stay canary-free.
    expectNoCanaries(await readAllStorage(), SAVED_PASSWORD, SAVED_TOKEN);

    // The vault really holds the secrets, but only as non-extractable keys
    // and ciphertext.
    expect(migrated.accounts[0]?.credentialRef).toBe(accountCredentialId("acc-boundary"));
    expect(migrated.accounts[0]).not.toHaveProperty("password");
    expect(JSON.stringify(storage.get(VAULT_STORAGE_KEY))).not.toContain(SAVED_PASSWORD);
    const vaultKeys = await readVaultKeys();
    expect(vaultKeys.kekPresent).toBe(true);
    expect(vaultKeys.kekExtractable).toBe(false);
    expectNoCanaries(vaultKeys, SAVED_PASSWORD, SAVED_TOKEN);
    // Positive control for the decrypting vault surface: resolving every
    // record must observe the saved canaries (they live in ciphertext).
    const decrypted = await readDecryptedVaultSecrets();
    expect(decrypted).toContain(SAVED_PASSWORD);
    expect(decrypted).toContain(SAVED_TOKEN);

    const backup = await exportPlaintextBackup();
    expect(JSON.stringify(backup)).toContain(SAVED_PASSWORD);
    expect(JSON.stringify(backup)).toContain(SAVED_TOKEN);
    // The explicit backup is portable plaintext only — no vault internals.
    expect(JSON.stringify(backup)).not.toContain("wrappedDek");
    expect(JSON.stringify(backup)).not.toContain(VAULT_STORAGE_KEY);
  });

  it("keeps old plaintext on migration failure and never persists a temporary password", async () => {
    storage.set(ACCOUNT_CONFIG_KEY, structuredClone(legacyConfig(SAVED_PASSWORD, SAVED_TOKEN)));
    failSecretReadbackOnce();
    await expect(migratePlaintextSecrets()).rejects.toThrow();
    expect((await readOrdinaryConfig()).accounts[0].password).toBe(SAVED_PASSWORD);

    await completeQuickLoginWithTemporaryPassword(ONE_TIME);
    // Positive control for the decrypting vault surface: this post-rollback
    // state starts without records, so plant a probe through the regular vault
    // write path to prove the helper below would observe a regression that
    // persisted the one-shot credential as a resolvable secret.
    const probeId = accountCredentialId("boundary-probe");
    const probeValue = "BOUNDARY-PROBE-04";
    await putSecret(probeId, probeValue);

    const surfaces = (await readPersistentAndLogSurfaces()) as {
      logs: { entries: unknown[] };
      backup: Record<string, unknown>;
      decryptedVaultSecrets: string[];
    };
    // The controlled run logged while holding the temporary credential; the
    // entry must exist but must not carry the credential.
    expect(surfaces.logs.entries.length).toBeGreaterThan(0);
    // Positive controls: the explicit backup still materializes the legacy
    // saved password, and per-record vault resolution observes the probe.
    expect(JSON.stringify(surfaces.backup)).toContain(SAVED_PASSWORD);
    expect(surfaces.decryptedVaultSecrets).toContain(probeValue);
    expect(await resolveSecret(probeId)).toBe(probeValue);
    expect(surfaces.decryptedVaultSecrets).not.toContain(ONE_TIME);
    expectNoCanaries(surfaces, ONE_TIME);
    await removeSecret(probeId);
  });

  it("never lets log.reveal override taint blacklisting", async () => {
    const result = await runRevealSpec();
    expect(result.success).toBe(true);
    expect(result.taint?.bindings.sessionToken).toBe(true);
    expect(typeof result.bindings.sessionToken).toBe("string");
    expect(result.log?.request.revealed).toBeUndefined();
    expectNoCanaries(result.log, SAVED_PASSWORD, String(result.bindings.sessionToken));

    const publicResult = toPublicRunResult(result);
    expect(publicResult).not.toHaveProperty("taint");
    expect(publicResult).not.toHaveProperty("bindings");
    expectNoCanaries(publicResult, SAVED_PASSWORD, String(result.bindings.sessionToken));
  });

  it("does not expose any bulk plaintext-password message", async () => {
    const routedTypes = new Set(
      allTools.flatMap((tool) => Object.keys(tool.backgroundHandlers ?? {})),
    );
    const forbidden = [
      "VAULT_GET_SECRET",
      "VAULT_GET_SECRETS",
      "VAULT_GET_ALL_SECRETS",
      "VAULT_EXPORT_SECRETS",
      "VAULT_REVEAL",
      "GET_SAVED_PASSWORDS",
      "GET_ALL_PASSWORDS",
      "GET_ACCOUNT_PASSWORDS",
    ];
    expect(forbidden.filter((type) => routedTypes.has(type))).toEqual([]);

    const listener = createBackgroundMessageListener(
      buildMessageRouteTable(allTools),
      { openToolTab: async () => undefined },
    );
    for (const type of forbidden) {
      await expect(dispatch(listener, { type }, optionsSender)).resolves.toEqual({
        routed: false,
      });
    }
  });
});
