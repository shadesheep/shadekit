import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EXTENSION = resolve(ROOT, ".output/chrome-mv3");
const OUT = process.env.SHADEKIT_DEMO_RAW || resolve(ROOT, "docs/images/raw");
const PROFILE =
  process.env.SHADEKIT_DEMO_PROFILE || "/tmp/shadekit-readme-profile";
const MODE = process.argv[2] || "all";
const VIDEO_DIR = process.env.SHADEKIT_DEMO_VIDEO || resolve(OUT, "video");
const MANIFEST = resolve(OUT, "verified-switch-video.json");
const playwrightPath =
  process.env.PLAYWRIGHT_MODULE ||
  "/tmp/shadekit-readme-tools/node_modules/playwright/index.mjs";
const { chromium } = await import(
  existsSync(playwrightPath) ? playwrightPath : "playwright"
);
const config = JSON.parse(
  await readFile(resolve(ROOT, "docs/readme-demo/demo-config.json"), "utf8"),
);
await mkdir(OUT, { recursive: true });

const bundled = chromium.executablePath();
const executablePath =
  process.env.CHROME_PATH || (existsSync(bundled) ? bundled : undefined);
if (!executablePath)
  throw new Error(
    "未找到 Playwright Chromium；请先按 docs/readme-demo/README.md 安装，或用 CHROME_PATH 指定浏览器",
  );
const video = MODE === "record" || MODE === "all";
if (video) await rm(MANIFEST, { force: true });
let switchVideoManifest = null;
if (MODE === "setup" || MODE === "all") {
  await rm(PROFILE, { recursive: true, force: true });
}
const context = await chromium.launchPersistentContext(PROFILE, {
  executablePath,
  headless: true,
  viewport: { width: 1440, height: 900 },
  colorScheme: "dark",
  ...(video
    ? { recordVideo: { dir: VIDEO_DIR, size: { width: 1440, height: 900 } } }
    : {}),
  args: [
    `--disable-extensions-except=${EXTENSION}`,
    `--load-extension=${EXTENSION}`,
    "--host-resolver-rules=MAP studio.shadesheep.test 127.0.0.1",
    "--no-proxy-server",
    "--disable-component-update",
    "--no-first-run",
  ],
});
// Extension pages read localStorage; content-script controls read chrome.storage.local.
await context.addInitScript(() => {
  if (location.protocol === "chrome-extension:")
    localStorage.setItem("devtools-theme", "dark");
});

const pageErrors = [];
const recordedPages = [];
const shot = async (page, name) => {
  if (
    !(await page.evaluate(() =>
      document.documentElement.hasAttribute("data-dt-dark"),
    ))
  )
    throw new Error(`Dark mode was not active before capturing ${name}`);
  await page.screenshot({
    path: resolve(OUT, `${name}.png`),
    animations: "disabled",
  });
  console.log(`captured ${name}.png`);
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker", { timeout: 20000 }));
  const extensionId = worker.url().split("/")[2];
  console.log(`ShadeKit loaded: ${extensionId}`);
  const optionsUrl = `chrome-extension://${extensionId}/options.html?section=account-switch`;

  async function seedDemoConfig() {
    await worker.evaluate(async (cfg) => {
      await chrome.storage.local.set({
        "devtools-account-switch": {
          accounts: cfg.accounts,
          domains: { [cfg.origin]: cfg.environment },
          envBadge: cfg.envBadge,
          tabOrder: ["users", "quicklogin"],
        },
        "devtools-theme": "dark",
      });
    }, config);
  }

  async function openPanel(page) {
    await page.mouse.move(930, 225);
    await page.keyboard.press("Alt+Shift+A");
    try {
      await page.locator("#devtools-panel").waitFor({ timeout: 4000 });
    } catch {
      // Chrome for Testing does not consistently dispatch command shortcuts in headless mode.
      // Invoke the same real background-to-content message used by the command, never render a panel ourselves.
      await worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        await chrome.tabs.sendMessage(tab.id, {
          type: "OPEN_ACCOUNT_SWITCHER",
        });
      });
      await page.locator("#devtools-panel").waitFor({ timeout: 6000 });
      console.log(
        "panel opened through the real extension message route (headless shortcut fallback)",
      );
    }
    await page.locator("#devtools-panel").evaluate((host) => {
      if (!host.shadowRoot?.querySelector(".as-account-card"))
        throw new Error("ShadeKit account cards did not render");
    });
    const panelIsDark = await page
      .locator("#devtools-panel")
      .evaluate(
        (host) =>
          host.hasAttribute("data-dt-dark") &&
          Boolean(
            host.shadowRoot?.querySelector(".dt-shadow-ui[data-dt-dark]"),
          ),
      );
    if (!panelIsDark)
      throw new Error("ShadeKit account panel is not in dark mode");
  }

  async function waitForVisibleAccount(page, expected) {
    await page.waitForFunction(
      ({ name, email, title, scope }) => {
        const text =
          document.querySelector("#current-account")?.textContent || "";
        return [name, email, title, scope].every((value) =>
          text.includes(value),
        );
      },
      expected,
      { timeout: 30000 },
    );
  }

  async function setupRecipe() {
    for (const page of context.pages()) await page.close();
    await worker.evaluate(async () => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({ "devtools-theme": "dark" });
    });
    const demo = await context.newPage();
    await demo.goto(`${config.origin}/login`);
    await demo.evaluate(() => {
      localStorage.setItem("themePreference", "keep-me");
    });
    const options = await context.newPage();
    options.on("pageerror", (error) => pageErrors.push(error.message));
    await options.goto(optionsUrl);
    await options.bringToFront();
    await options
      .getByRole("button", { name: "新建环境", exact: true })
      .first()
      .click();
    const drawer = options.locator(".dt-drawer");
    await drawer.locator("input").first().fill(config.origin);
    await drawer.locator("input").nth(1).fill(config.environment.name);
    await drawer.getByRole("button", { name: /高级配置/ }).click();
    await drawer.locator(".simple-row").first().locator("input").fill("");
    await drawer.locator(".locator-warning").waitFor();
    await drawer.locator(".login-page-warning").waitFor();
    await drawer
      .getByRole("button", { name: "识别登录表单", exact: true })
      .click();
    await drawer.locator(".scan-card").waitFor();
    await drawer.locator(".auth-storage-selector").waitFor();
    if (await drawer.getByText("themePreference", { exact: true }).count()) {
      throw new Error("Non-auth storage key was offered for cleanup");
    }
    await drawer
      .getByRole("button", { name: "使用识别结果", exact: true })
      .click();
    await drawer.locator(".locator-state-locked").waitFor();
    const autoLoginUrl = await drawer
      .locator(".simple-row")
      .first()
      .locator("input")
      .inputValue();
    if (autoLoginUrl !== "{origin}/login") {
      throw new Error(
        `Automatic form lock did not record login page: ${autoLoginUrl}`,
      );
    }
    await drawer.locator(".locator-warning").waitFor({ state: "detached" });
    await drawer.locator(".login-page-warning").waitFor({ state: "detached" });
    console.log("Verified automatic form lock login page:", autoLoginUrl);
    await drawer.getByRole("button", { name: /高级配置/ }).click();
    await drawer.locator(".advanced-content").waitFor({ state: "hidden" });
    await pause(250);
    await drawer.locator(".dt-drawer-body").evaluate((el) => {
      el.scrollTop = 0;
    });
    await drawer.screenshot({
      path: resolve(OUT, "recipe-01-environment.png"),
      animations: "disabled",
    });
    console.log("captured recipe-01-environment.png");
    await drawer.getByRole("button", { name: /高级配置/ }).click();
    await drawer.locator(".advanced-content").waitFor({ state: "visible" });

    await drawer
      .getByRole("button", { name: "识别环境页面上的登录表单" })
      .click();
    await drawer.locator(".scan-card").waitFor({ timeout: 10000 });
    await pause(250);
    await drawer.locator(".scan-card").scrollIntoViewIfNeeded();
    await drawer.screenshot({
      path: resolve(OUT, "recipe-02-scan.png"),
      animations: "disabled",
    });
    console.log("captured recipe-02-scan.png");
    await drawer
      .getByRole("button", { name: "使用识别结果", exact: true })
      .click();
    await drawer.locator(".scan-card").waitFor({ state: "detached" });
    const fieldValues = await drawer
      .locator(".target-value")
      .evaluateAll((inputs) => inputs.map((input) => input.value));
    if (
      !fieldValues.includes("#username") ||
      !fieldValues.includes("#password") ||
      !fieldValues.includes("#submit-btn")
    ) {
      throw new Error(
        `Form scan did not fill all selectors: ${fieldValues.join(", ")}`,
      );
    }
    console.log("Verified scan backfill:", fieldValues.join(", "));

    // Real target picker: hover the login field, capture its native overlay, then click to select it.
    await drawer
      .locator(".target-field")
      .first()
      .getByRole("button", { name: "拾取", exact: true })
      .click();
    await demo.bringToFront();
    await demo.locator("#username").hover();
    await demo.locator("[data-dt-picker-overlay]").waitFor({ timeout: 6000 });
    await pause(250);
    await demo.screenshot({
      path: resolve(OUT, "recipe-02-picker.png"),
      animations: "disabled",
    });
    console.log("captured recipe-02-picker.png");
    await demo.locator("#username").click();
    await options.bringToFront();
    await drawer
      .locator(".target-field")
      .first()
      .locator(".target-value")
      .waitFor();
    const picked = await drawer
      .locator(".target-field")
      .first()
      .locator(".target-value")
      .inputValue();
    if (picked !== "#username")
      throw new Error(`Target picker did not return #username: ${picked}`);
    console.log("Verified real target picker:", picked);
    if (await drawer.locator(".trial-login-row").count())
      throw new Error("Trial login should be hidden");
    await drawer.screenshot({
      path: resolve(OUT, "recipe-03-save.png"),
      animations: "disabled",
    });
    await shot(options, "store-login-config");
    console.log("captured recipe-03-save.png");
    await drawer.getByRole("button", { name: "添加环境", exact: true }).click();
    await drawer.waitFor({ state: "detached" });
    let generatedGoto;
    for (let attempt = 0; attempt < 20 && !generatedGoto; attempt += 1) {
      generatedGoto = await worker.evaluate(async (origin) => {
        const data = await chrome.storage.local.get("devtools-account-switch");
        const env = data["devtools-account-switch"]?.domains?.[origin];
        return env?.strategyConfig?.spec?.ops?.find((op) => op.op === "goto");
      }, config.origin);
      if (!generatedGoto) await pause(100);
    }
    if (
      generatedGoto?.url !== "{origin}/login" ||
      generatedGoto.waitForLoad !== true ||
      generatedGoto.waitForTarget?.css !== "#username"
    ) {
      throw new Error(
        `Scan did not generate login navigation: ${JSON.stringify(generatedGoto)}`,
      );
    }
    console.log("Verified scanned login page:", generatedGoto.url);
    const generatedStorage = await worker.evaluate(async (origin) => {
      const data = await chrome.storage.local.get("devtools-account-switch");
      const env = data["devtools-account-switch"].domains[origin];
      return env.strategyConfig.spec.ops.filter(
        (op) => op.op === "clear.storage",
      );
    }, config.origin);
    const expectedStorage = [
      {
        op: "clear.storage",
        area: "local",
        range: [
          "token",
          "accessToken",
          "access_token",
          "refreshToken",
          "refresh_token",
          "idToken",
          "id_token",
          "authToken",
          "auth_token",
          "sessionToken",
          "jwt",
          "Authorization",
          "expireAt",
          "expiresAt",
          "expireTime",
          "expiration",
          "expiresIn",
          "userInfo",
          "user_info",
          "tokenType",
        ],
      },
      {
        op: "clear.storage",
        area: "session",
        range: [
          "token",
          "accessToken",
          "access_token",
          "refreshToken",
          "refresh_token",
          "idToken",
          "id_token",
          "authToken",
          "auth_token",
          "sessionToken",
          "jwt",
          "Authorization",
        ],
      },
    ];
    const normalizedStorage = generatedStorage.map((op) => ({
      op: op.op,
      area: op.area,
      range: op.range,
    }));
    if (JSON.stringify(normalizedStorage) !== JSON.stringify(expectedStorage)) {
      throw new Error(
        `Unexpected auth cleanup: ${JSON.stringify(generatedStorage)}`,
      );
    }
    console.log("Verified precise auth storage cleanup");

    for (const account of config.accounts) {
      await options
        .locator(".main-topbar")
        .getByRole("button", { name: "新建账号", exact: true })
        .click();
      const form = options.locator(".dt-drawer");
      await form.locator("input").nth(0).fill(account.name);
      await form.locator("input").nth(1).fill(account.username);
      await form.locator("input").nth(2).fill(account.password);
      await form
        .locator(".role-presets .role-chip", { hasText: account.roles[0] })
        .click();
      await form
        .locator(".domain-chip", { hasText: config.environment.name })
        .click();
      await form.getByRole("button", { name: "添加账号", exact: true }).click();
      await form.waitFor({ state: "detached" });
    }
    await worker.evaluate(async (badge) => {
      const data = await chrome.storage.local.get("devtools-account-switch");
      await chrome.storage.local.set({
        "devtools-account-switch": {
          ...data["devtools-account-switch"],
          envBadge: badge,
        },
      });
    }, config.envBadge);
    await options.locator(".col-actions .more-btn").first().click();
    const accountMenu = options.locator(".more-menu:visible");
    await accountMenu.waitFor();
    if (
      await accountMenu
        .getByRole("button", { name: "登录", exact: true })
        .count()
    ) {
      throw new Error("Account login action should be hidden");
    }
    await options.locator(".col-actions .more-btn").first().click();
    await pause(2600);
    await shot(options, "account-config");
    console.log(
      "Real options UI setup complete: environment, scanned recipe, two accounts",
    );
  }

  async function captureHero() {
    for (const page of context.pages()) await page.close();
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`${config.origin}/login`);
    await page.fill("#username", config.accounts[1].username);
    await page.fill("#password", config.accounts[1].password);
    await page.click("#submit-btn");
    await page.waitForURL("**/console");
    await page.locator("#shadekit-env-badge-host").waitFor();
    await pause(500);
    await openPanel(page);
    await pause(500);
    await shot(page, "hero-source");
    await page
      .locator("#devtools-panel")
      .evaluate((host) =>
        host.shadowRoot.querySelector(".devtools-panel-close").click(),
      );
    await shot(page, "console-tester");
  }

  async function recordSwitch() {
    for (const page of context.pages()) await page.close();
    // Establish the demo's HttpOnly session before creating the recorded tab.
    // Playwright records from newPage(), so preparation must not be part of the GIF.
    await context.request.post("http://127.0.0.1:4173/api/session/logout");
    const response = await context.request.post(
      "http://127.0.0.1:4173/api/session/login",
      {
        data: {
          username: config.accounts[1].username,
          password: config.accounts[1].password,
        },
      },
    );
    if (!response.ok())
      throw new Error(`Demo session preparation failed: ${response.status()}`);
    const identity = await response.json();
    if (identity.role !== "tester")
      throw new Error(`Expected tester preparation, got ${identity.role}`);
    const cookie = (await context.cookies("http://127.0.0.1:4173")).find(
      (item) => item.name === "shadesheep_session",
    );
    if (!cookie) throw new Error("Demo session cookie was not issued");
    await context.addCookies([
      { name: "shadesheep_session", value: cookie.value, url: config.origin },
    ]);
    const page = await context.newPage();
    recordedPages.push(page);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().includes("favicon.ico"))
        console.log("Demo browser console:", message.text());
    });
    page.on("response", (response) => {
      if (response.url().includes("/api/session/"))
        console.log(
          "Demo session response:",
          response.status(),
          response.url(),
        );
    });
    await page.bringToFront();
    await page.goto(`${config.origin}/console`);
    await page.evaluate(() => {
      localStorage.setItem("token", "shadekit-demo-token");
      localStorage.setItem("refreshToken", "shadekit-demo-refresh");
      localStorage.setItem("expireAt", "shadekit-demo-expiry");
      localStorage.setItem("userInfo", "shadekit-demo-user");
      sessionStorage.setItem("access_token", "shadekit-demo-session");
    });
    await page.waitForURL("**/console");
    await page.waitForFunction(
      () => document.body.dataset.currentRole === "tester",
    );
    await waitForVisibleAccount(page, {
      name: "周然",
      email: "tester@shadesheep.test",
      title: "验收测试",
      scope: "验收任务 · 回归与结果提交",
    });
    await page.locator("#shadekit-env-badge-host").waitFor();
    await pause(1800);
    await shot(page, "switch-01-before");
    await openPanel(page);
    await pause(1200);
    const adminCardHandle = await page
      .locator("#devtools-panel")
      .evaluateHandle((host) => {
        const card = [
          ...host.shadowRoot.querySelectorAll(".as-account-card"),
        ].find((el) => el.textContent.includes("林屿"));
        if (!card) throw new Error("Admin account not found in the real panel");
        return card;
      });
    const adminCard = adminCardHandle.asElement();
    if (!adminCard) throw new Error("Admin account handle was not an element");
    await adminCard.hover();
    await pause(1000);
    await shot(page, "switch-02-panel");
    const clicked = await adminCard.evaluate((card) => {
      card.dispatchEvent(
        new MouseEvent("click", { bubbles: true, composed: true }),
      );
      return card.textContent;
    });
    await adminCard.dispose();
    console.log("clicked real account card:", clicked);
    try {
      await page.waitForFunction(
        () => document.body.dataset.currentRole === "admin",
        null,
        { timeout: 30000 },
      );
      await waitForVisibleAccount(page, {
        name: "林屿",
        email: "admin@shadesheep.test",
        title: "交付管理员",
        scope: "全部项目 · 发布与权限管理",
      });
    } catch (error) {
      await shot(page, "switch-failure");
      const state = await page.evaluate(() => ({
        url: location.href,
        role: document.body.dataset.currentRole,
        cookies: document.cookie,
      }));
      const panel = await page
        .locator("#devtools-panel")
        .evaluate((host) => host.shadowRoot.textContent)
        .catch(() => "(panel closed during navigation)");
      const toast = await page
        .locator("#devtools-toast-root")
        .evaluate((host) => host.shadowRoot.textContent)
        .catch(() => "");
      const logs = await worker.evaluate(
        async () =>
          (await chrome.storage.local.get("devtools-logs"))["devtools-logs"] ||
          [],
      );
      const savedSpec = await worker.evaluate(
        async (origin) =>
          (await chrome.storage.local.get("devtools-account-switch"))[
            "devtools-account-switch"
          ]?.domains?.[origin]?.strategyConfig?.spec,
        config.origin,
      );
      console.log(
        "Switch diagnostic:",
        JSON.stringify({ state, savedSpec, logs }, null, 2),
      );
      console.log(
        "Switch diagnostic:",
        JSON.stringify({ state, panel, toast, logs }, null, 2),
      );
      await writeFile(
        resolve(OUT, "switch-diagnostic.json"),
        JSON.stringify({ state, panel, toast, logs }, null, 2),
      );
      throw error;
    }
    await page.waitForURL("**/console");
    await page.locator("#shadekit-env-badge-host").waitFor();
    await pause(3200);
    await page.mouse.move(240, 150);
    await pause(250);
    await shot(page, "switch-03-after");
    switchVideoManifest = {
      roleSwitchVerified: true,
      startRole: "tester",
      finalRole: "admin",
      visibleAccountSwitchVerified: true,
      startAccount: "tester@shadesheep.test",
      finalAccount: "admin@shadesheep.test",
      videoPath: await page.video()?.path(),
    };
    console.log("Verified visible account switch: tester → admin");
    const storageAfterSwitch = await page.evaluate(() => ({
      token: localStorage.getItem("token"),
      theme: localStorage.getItem("themePreference"),
      sessionToken: sessionStorage.getItem("access_token"),
    }));
    if (
      storageAfterSwitch.token !== null ||
      storageAfterSwitch.sessionToken !== null ||
      storageAfterSwitch.theme !== "keep-me"
    ) {
      throw new Error(
        `Auth cleanup was not precise: ${JSON.stringify(storageAfterSwitch)}`,
      );
    }
    console.log("Verified auth keys cleared and unrelated storage preserved");
  }

  async function setCodeMirror(page, index, text) {
    const overlay = page
      .locator(".editor-panel")
      .nth(index)
      .locator(".dt-empty-state--overlay");
    if (await overlay.count()) await overlay.click();
    await page.locator(".cm-content").nth(index).click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText(text);
    await pause(900);
  }

  async function captureTools() {
    for (const page of context.pages()) await page.close();
    const sample = JSON.stringify(
      {
        project: "ShadeSheep",
        environment: "test",
        release: {
          version: "2.3.8",
          owner: "林屿",
          checks: ["登录切换", "权限隔离", "回归验收"],
        },
        metrics: { delivery: 12, passRate: 96.8 },
      },
      null,
      2,
    );
    const format = await context.newPage();
    await format.goto(`chrome-extension://${extensionId}/json-format.html`);
    await format.locator(".cm-content").first().waitFor();
    await setCodeMirror(format, 0, sample);
    await pause(2600);
    await shot(format, "tool-json-format");
    await format.close();

    const diff = await context.newPage();
    await diff.goto(`chrome-extension://${extensionId}/json-diff.html`);
    await diff.locator(".cm-content").first().waitFor();
    await setCodeMirror(
      diff,
      0,
      JSON.stringify(
        {
          release: "v2.3.7",
          environment: "test",
          retries: 2,
          owner: "周然",
          features: { accountSwitch: true, sso: false },
        },
        null,
        2,
      ),
    );
    await setCodeMirror(
      diff,
      1,
      JSON.stringify(
        {
          release: "v2.3.8",
          environment: "staging",
          retries: 3,
          owner: "林屿",
          features: { accountSwitch: true, sso: true },
        },
        null,
        2,
      ),
    );
    const compare = diff.getByRole("button", { name: /对比/ }).first();
    if (await compare.count()) await compare.click();
    await diff.locator(".diff-stats").waitFor();
    await pause(2600);
    await shot(diff, "tool-json-diff");
    await diff.close();

    const mock = await context.newPage();
    await mock.goto(`chrome-extension://${extensionId}/mock-data.html`);
    await mock.locator(".count-badge").first().waitFor();
    await mock.getByTitle("载入预设模板（覆盖当前字段）").selectOption("user");
    await mock
      .locator(".view-switch")
      .getByRole("radio", { name: "表格", exact: true })
      .click();
    await mock.locator(".data-table tbody tr").first().waitFor();
    await pause(2600);
    await shot(mock, "tool-mock-data");
    await mock.close();
  }

  if (MODE === "setup" || MODE === "all") await setupRecipe();
  else await seedDemoConfig();
  if (MODE === "hero" || MODE === "all") await captureHero();
  if (MODE === "record" || MODE === "all") await recordSwitch();
  if (MODE === "tools" || MODE === "all") await captureTools();
  await writeFile(
    resolve(OUT, `${MODE}-browser-errors.json`),
    JSON.stringify(pageErrors, null, 2),
  );
  if (pageErrors.length)
    throw new Error(`Browser page errors: ${pageErrors.join("; ")}`);
} finally {
  if (video) {
    for (const page of recordedPages) {
      const path = await page.video()?.path();
      if (path) console.log("Recorded demo tab:", path);
    }
  }
  await context.close();
}
if (switchVideoManifest) {
  if (
    !switchVideoManifest.videoPath ||
    !existsSync(switchVideoManifest.videoPath)
  ) {
    throw new Error("Role switch passed, but the recorded WebM is missing");
  }
  await writeFile(MANIFEST, JSON.stringify(switchVideoManifest, null, 2));
  console.log(`Verified switch video manifest: ${MANIFEST}`);
}
if (MODE === "record") console.log(`Video and source frames: ${OUT}`);
