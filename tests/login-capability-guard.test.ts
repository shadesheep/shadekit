// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, ref, type App as VueApp } from "vue";
import DomainsPanel, {
  type EnvSavePayload,
} from "../entrypoints/tools/account-switch/config/DomainsPanel.vue";
import {
  buildAccountPanel,
  supportReason,
} from "../entrypoints/tools/account-switch/account-view";
import {
  EXTENSION_SPEC_CAPABILITIES,
  inspectLoginSpecSupport,
} from "../entrypoints/tools/account-switch/spec/capabilities";
import type {
  AccountSwitchConfig,
  StrategyEntry,
} from "../entrypoints/tools/account-switch/types";

const mocks = vi.hoisted(() => ({
  storageGet: vi.fn(),
  storageSet: vi.fn(async () => undefined),
  resolveSecret: vi.fn(async () => "resolved-secret"),
  permissionsContains: vi.fn(async () => true),
  permissionsRequest: vi.fn(async () => true),
  tabsCreate: vi.fn(async () => ({ id: 99 })),
  tabsGet: vi.fn(async () => ({
    id: 42,
    url: "https://current.example.com/login",
    status: "complete",
  })),
}));

vi.mock("../entrypoints/shared/security/vault-service", () => ({
  resolveSecret: mocks.resolveSecret,
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
vi.stubGlobal("chrome", {
  permissions: {
    contains: mocks.permissionsContains,
    request: mocks.permissionsRequest,
  },
  storage: {
    local: {
      get: mocks.storageGet,
      set: mocks.storageSet,
      remove: vi.fn(async () => undefined),
    },
  },
  tabs: {
    get: mocks.tabsGet,
    create: mocks.tabsCreate,
    query: vi.fn(async () => []),
    remove: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  scripting: { executeScript: vi.fn() },
  cookies: { set: vi.fn(), getAll: vi.fn(async () => []), remove: vi.fn() },
  runtime: { getURL: (path: string) => path },
});

import {
  handleSwitchAccount,
  handleTrialLogin,
} from "../entrypoints/tools/account-switch/background-handler";
import { releaseLoginLock } from "../entrypoints/tools/account-switch/login-session";
import { runSpec } from "../entrypoints/tools/account-switch/spec/run";
import { runTrialLogin } from "../entrypoints/tools/account-switch/spec/trial";
import type { LoginSpec } from "../entrypoints/tools/account-switch/spec/types";
import type { AuthContext } from "../entrypoints/tools/account-switch/types";
import {
  ErrorCodes,
  formatLoginError,
} from "../entrypoints/tools/account-switch/utils/error-codes";

/**
 * v2 declaration containing an operator this client cannot execute. The
 * `http.execute` step after the unknown operator makes a missing preflight
 * observable as a real network side effect.
 */
const futureSpec = {
  version: 2,
  template: "future-login",
  ops: [
    { op: "future.op", futureField: { keep: true } },
    { op: "http.execute", url: "{origin}/login", method: "POST", as: "resp" },
  ],
  success: [{ response: { from: "resp", path: "ok", equals: true } }],
  auth: { mode: "page" },
  futureTop: { keep: [1, 2] },
} as const;
const originalFutureSpec = structuredClone(futureSpec);

/** Known operator with an algorithm the client does not support. */
const md5DigestSpec = {
  version: 2,
  ops: [{ op: "digest", algorithm: "md5", input: "{password}", as: "sig" }],
  success: [{ page: { type: "formGone" } }],
  auth: { mode: "page" },
} as const;

function mirroredFutureConfig(
  environmentIds: string[],
  options: { declaredSpecVersion?: number } = {},
): AccountSwitchConfig {
  return {
    accounts: [
      {
        id: "account-1",
        name: "未来账号",
        username: "alice",
        credentialRef: "cred-account-1",
        roles: [],
        domains: [...environmentIds],
      },
    ],
    domains: Object.fromEntries(
      environmentIds.map((id) => [
        id,
        { name: id, tags: [], strategyId: "future" },
      ]),
    ),
    strategies: {
      future: {
        name: "未来策略",
        spec: structuredClone(futureSpec),
        ...(options.declaredSpecVersion === undefined
          ? {}
          : { declaredSpecVersion: options.declaredSpecVersion }),
        createdAt: 1,
        updatedAt: 1,
      },
    },
  };
}

function supportFor(config: AccountSwitchConfig, environmentId: string) {
  const panel = buildAccountPanel(config, "");
  return (
    panel.domains[environmentId].support ?? {
      supported: true,
      issues: [],
    }
  );
}

function storageWith(config: AccountSwitchConfig | undefined) {
  mocks.storageGet.mockImplementation(async (keys: string[]) =>
    keys.includes("devtools-account-switch") && config
      ? { "devtools-account-switch": config }
      : {},
  );
}

function buildCtx(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    tabId: 5,
    origin: "https://trial.example.com",
    domainConfig: { name: "trial", tags: [] },
    credentials: { username: "alice", password: "ONE-TIME-91" },
    tokenData: null,
    targetUrl: "",
    debugRedirect: "",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  releaseLoginLock(42);
  mocks.tabsGet.mockResolvedValue({
    id: 42,
    url: "https://current.example.com/login",
    status: "complete",
  });
});

describe("登录能力门 — 副作用之前拒绝", () => {
  it("rejects before permission requests, tab creation, HTTP, and saved-secret resolution", async () => {
    storageWith(mirroredFutureConfig(["future-env"]));
    const sender = {
      id: "shadekit-test-extension",
      url: "",
      origin: "",
      frameId: 0,
    } as unknown as chrome.runtime.MessageSender;

    await expect(
      handleSwitchAccount("account-1", "future-env", sender),
    ).resolves.toMatchObject({
      success: false,
      errorCode: "OP_UNSUPPORTED",
    });

    expect(mocks.permissionsRequest).not.toHaveBeenCalled();
    expect(mocks.permissionsContains).not.toHaveBeenCalled();
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.resolveSecret).not.toHaveBeenCalled();
    expect(mocks.storageSet).not.toHaveBeenCalled();
  });

  it("surfaces the registered algorithm message for saved and trial rejections", async () => {
    const environmentId = "https://md5.example.com";
    storageWith({
      accounts: [
        {
          id: "account-md5",
          name: "MD5账号",
          username: "alice",
          credentialRef: "cred-md5",
          roles: [],
          domains: [environmentId],
        },
      ],
      domains: {
        [environmentId]: {
          name: "MD5环境",
          tags: [],
          strategyConfig: { spec: structuredClone(md5DigestSpec) },
        },
      },
    });
    const sender = {
      id: "shadekit-test-extension",
      url: "",
      origin: "",
      frameId: 0,
    } as unknown as chrome.runtime.MessageSender;
    const algorithmMessage =
      "当前客户端不支持该登录算法，请升级客户端或修改策略";

    const saved = await handleSwitchAccount(
      "account-md5",
      environmentId,
      sender,
    );
    expect(saved).toMatchObject({
      success: false,
      errorCode: ErrorCodes.ALGORITHM_UNSUPPORTED,
    });
    expect(formatLoginError(saved.errorCode, saved.error)).toBe(
      algorithmMessage,
    );
    expect(mocks.permissionsContains).not.toHaveBeenCalled();
    expect(mocks.permissionsRequest).not.toHaveBeenCalled();
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
    expect(mocks.resolveSecret).not.toHaveBeenCalled();
    expect(mocks.storageSet).not.toHaveBeenCalled();

    const trial = await handleTrialLogin({
      spec: md5DigestSpec as unknown as LoginSpec,
      origin: environmentId,
      username: "alice",
      password: "ONE-TIME-91",
    });
    expect(trial).toMatchObject({
      ok: false,
      errorCode: ErrorCodes.ALGORITHM_UNSUPPORTED,
      requestSent: false,
      sessionWritten: false,
    });
    expect(formatLoginError(trial.errorCode, trial.error)).toBe(
      algorithmMessage,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks trial login before sending credentials", async () => {
    const result = await handleTrialLogin({
      spec: futureSpec as unknown as LoginSpec,
      origin: "https://trial.example.com",
      username: "alice",
      password: "ONE-TIME-91",
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: "OP_UNSUPPORTED",
      requestSent: false,
      sessionWritten: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.resolveSecret).not.toHaveBeenCalled();
    expect(mocks.permissionsRequest).not.toHaveBeenCalled();
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
  });

  it("keeps the trial and runtime entry points guarded for direct callers", async () => {
    const trial = await runTrialLogin(
      futureSpec as unknown as LoginSpec,
      buildCtx(),
    );
    expect(trial).toMatchObject({
      ok: false,
      errorCode: "OP_UNSUPPORTED",
      requestSent: false,
      sessionWritten: false,
    });
    expect(trial.bindings).toEqual({});

    await expect(
      runSpec(futureSpec as unknown as LoginSpec, buildCtx()),
    ).rejects.toMatchObject({ code: "OP_UNSUPPORTED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("登录能力门 — 支持度每次读取时派生", () => {
  it("disables every mirror and recovers from the same stored raw spec after an upgrade", () => {
    const config = mirroredFutureConfig(["env-a", "env-b"], {
      declaredSpecVersion: 3,
    });

    expect(
      ["env-a", "env-b"].map((id) => supportFor(config, id).supported),
    ).toEqual([false, false]);
    expect(config.strategies?.future.declaredSpecVersion).toBe(3);
    expect(config.strategies?.future.spec).toEqual(originalFutureSpec);
    expect(
      inspectLoginSpecSupport(originalFutureSpec, 3, {
        ...EXTENSION_SPEC_CAPABILITIES,
        specVersions: [2, 3],
        ops: [...EXTENSION_SPEC_CAPABILITIES.ops, "future.op"],
      }).supported,
    ).toBe(true);
    expect(originalFutureSpec).toEqual(futureSpec);

    // Support state is derived metadata: it never gets written to the holders.
    expect(config.domains["env-a"]).not.toHaveProperty("support");
    expect(config.strategies?.future).not.toHaveProperty("support");
  });

  it("shows the exact version, operator, and algorithm reason to the panel", () => {
    const rsaSpec = {
      version: 2,
      ops: [
        {
          op: "crypto.encrypt",
          algorithm: "rsa-extra",
          publicKey: "{origin}",
          input: "{password}",
          as: "secret",
        },
      ],
      success: [{ page: { type: "formGone" } }],
      auth: { mode: "page" },
    };
    const config: AccountSwitchConfig = {
      accounts: [],
      domains: {
        versioned: {
          name: "版本过高",
          tags: [],
          strategyConfig: {
            spec: structuredClone(futureSpec),
            declaredSpecVersion: 3,
          },
        },
        "unknown-op": {
          name: "未知算子",
          tags: [],
          strategyConfig: { spec: structuredClone(futureSpec) },
        },
        "md5-digest": {
          name: "弱摘要",
          tags: [],
          strategyConfig: { spec: structuredClone(md5DigestSpec) },
        },
        "rsa-algorithm": {
          name: "未知加密",
          tags: [],
          strategyConfig: { spec: rsaSpec },
        },
      },
    };
    const panel = buildAccountPanel(config, "");

    expect(panel.domains.versioned.support).toMatchObject({
      supported: false,
    });
    expect(panel.domains.versioned.support?.issues[0]).toMatchObject({
      code: "SPEC_VERSION_UNSUPPORTED",
      message: "当前客户端不支持 LoginSpec 版本 3",
    });
    expect(panel.domains["unknown-op"].support?.issues[0]).toMatchObject({
      code: "OP_UNSUPPORTED",
      message: "当前客户端不支持算子 future.op",
      opIndex: 0,
    });
    expect(panel.domains["md5-digest"].support?.issues[0]).toMatchObject({
      code: "ALGORITHM_UNSUPPORTED",
      message: "当前客户端不支持 digest 算法 md5",
      opIndex: 0,
    });
    expect(panel.domains["rsa-algorithm"].support?.issues[0]).toMatchObject({
      code: "ALGORITHM_UNSUPPORTED",
      message: "当前客户端不支持 crypto.encrypt 算法 rsa-extra",
      opIndex: 0,
    });
    expect(supportReason(panel.domains.versioned.support!)).toContain(
      "当前客户端不支持 LoginSpec 版本 3",
    );
    // Public issues never carry the raw declaration or bindings.
    expect(JSON.stringify(panel)).not.toContain("futureTop");
    expect(JSON.stringify(panel.domains.versioned.support)).not.toContain("ops");
  });

  it("resolves the private document before the mirrored strategy", () => {
    const supportedSpec = {
      version: 2,
      ops: [
        {
          op: "http.execute",
          url: "{origin}/login",
          method: "POST",
          as: "resp",
        },
      ],
      success: [{ response: { from: "resp", path: "ok" } }],
      auth: { mode: "page" },
    };
    const config = mirroredFutureConfig(["mirror-future"], {
      declaredSpecVersion: 3,
    });
    config.domains["private-supported"] = {
      name: "私有可用",
      tags: [],
      strategyId: "future",
      strategyConfig: { spec: supportedSpec },
    };
    config.strategies!.supported = {
      name: "可用策略",
      spec: supportedSpec,
      createdAt: 1,
      updatedAt: 1,
    } as StrategyEntry;
    config.domains["mirror-supported"] = {
      name: "镜像可用",
      tags: [],
      strategyId: "supported",
    };

    expect(supportFor(config, "private-supported").supported).toBe(true);
    expect(supportFor(config, "mirror-supported").supported).toBe(true);
    expect(supportFor(config, "mirror-future").supported).toBe(false);
  });
});

describe("登录能力门 — 环境详情仍可保留原始声明", () => {
  let app: VueApp<Element> | null = null;

  function mountEditDrawer(
    config: AccountSwitchConfig,
    environmentId: string,
  ): { root: HTMLDivElement; emitted: EnvSavePayload[] } {
    const panel = ref<{ openEdit: (key: string) => void } | null>(null);
    const emitted: EnvSavePayload[] = [];
    const root = document.createElement("div");
    document.body.appendChild(root);
    app = createApp({
      render: () =>
        h(DomainsPanel, {
          ref: panel,
          domains: config.domains,
          strategies: config.strategies,
          accounts: config.accounts,
          onSaveWithAccounts: (payload: EnvSavePayload) =>
            emitted.push(payload),
        }),
    });
    app.mount(root);
    panel.value?.openEdit(environmentId);
    return { root, emitted };
  }

  afterEach(() => {
    app?.unmount();
    app = null;
    document.body.innerHTML = "";
  });

  it("keeps a version-only unsupported document intact when saving other fields", async () => {
    const environmentId = "https://version-only.example.com";
    const raw = { version: 3 };
    const config: AccountSwitchConfig = {
      accounts: [],
      domains: {
        [environmentId]: {
          name: "未来版本环境",
          tags: [],
          strategyConfig: { spec: raw },
        },
      },
    };

    const { root, emitted } = mountEditDrawer(config, environmentId);
    await nextTick();

    expect(root.querySelector(".spec-invalid-note")?.textContent).toContain(
      "LoginSpec 版本 3",
    );
    const save = Array.from(
      root.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.includes("保存环境"));
    expect(save).toBeTruthy();
    save!.click();
    await nextTick();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].domains[environmentId].strategyConfig?.spec).toEqual(raw);
  });

  it("shows the exact support reason and preserves the raw document on save", async () => {
    const environmentId = "https://future.example.com";
    const config = mirroredFutureConfig([environmentId], {
      declaredSpecVersion: 3,
    });
    config.domains[environmentId].strategyId = undefined;
    config.domains[environmentId].strategyConfig = {
      spec: structuredClone(futureSpec),
      declaredSpecVersion: 3,
    };

    const { root, emitted } = mountEditDrawer(config, environmentId);
    await nextTick();

    const supportNote = root.querySelector(".spec-invalid-note");
    expect(supportNote?.textContent).toContain("当前客户端不支持");
    expect(supportNote?.textContent).toContain("LoginSpec 版本 3");
    expect(supportNote?.textContent).toContain("算子 future.op");

    // Account-binding controls remain available in the same detail view.
    expect(root.textContent).toContain("关联账号");
    expect(root.textContent).toContain("未来账号");

    const save = Array.from(
      root.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.includes("保存环境"));
    expect(save).toBeTruthy();
    save!.click();
    await nextTick();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].domains[environmentId].strategyConfig?.spec).toEqual(
      futureSpec,
    );
    expect(
      emitted[0].domains[environmentId].strategyConfig?.declaredSpecVersion,
    ).toBe(3);
  });
});
