#!/usr/bin/env node
/**
 * 三商店一键发布：构建 Chrome + Edge + Firefox zip → wxt submit 同时提交三个商店
 *
 * 用法:
 *   npm run release                  # 构建 + 发布（正式提交审核）
 *   npm run release -- --dry-run     # 只验证凭证，不上传不提交
 *   npm run release -- --skip-build  # 跳过构建，直接用 .output 里已有的 zip
 *   npm run release -- --chrome-only / --edge-only / --firefox-only
 *
 * 凭证来源: 项目根目录 .env
 *   CHROME_EXTENSION_ID / CHROME_PUBLISHER_ID
 *     + CHROME_SERVICE_ACCOUNT_JSON 指向服务账号密钥文件；
 *       或直接填 CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL / CHROME_SERVICE_ACCOUNT_PRIVATE_KEY
 *   PRODUCT_ID / CLIENT_ID / CLIENT_SECRET  (Edge Makefile 命名，自动映射为 wxt 需要的 EDGE_*)
 *   FIREFOX_EXTENSION_ID / FIREFOX_JWT_ISSUER / FIREFOX_JWT_SECRET
 *   FIREFOX_CHANNEL (listed 或 unlisted，默认 listed)
 *
 * 网络: Chrome API 需走本地代理（默认 127.0.0.1:7890，可用 PROXY_URL 环境变量覆盖）；
 *       通过 scripts/undici-proxy.cjs 预加载注入全局 dispatcher。
 */
import { spawnSync, execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { loadEnvFile, resolveChromeOAuth, resolveChromeServiceAccount } from "./release-credentials.mjs";
import { publishChrome } from "./chrome-v2.mjs";
import { enableProxy } from "./net.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SKIP_BUILD = args.includes("--skip-build");
const CHROME_ONLY = args.includes("--chrome-only");
const EDGE_ONLY = args.includes("--edge-only");
const FIREFOX_ONLY = args.includes("--firefox-only");
const chromeEnabled = !EDGE_ONLY && !FIREFOX_ONLY;
const edgeEnabled = !CHROME_ONLY && !FIREFOX_ONLY;
const firefoxEnabled = !CHROME_ONLY && !EDGE_ONLY;

const fail = (msg) => { console.error(`❌ ${msg}`); process.exit(1); };
const info = (msg) => console.log(msg);

// ── 1. 读取 .env ─────────────────────────────────────────
const env = (() => {
  try {
    return loadEnvFile(resolve(root, ".env"));
  } catch (err) {
    fail(err.message);
  }
})();
const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8")).version;
info(`📦 当前版本: v${version}`);

// ── 2. 校验凭证 ──────────────────────────────────────────
const submitEnv = { ...process.env };

// Chrome 认证二选一：OAuth refresh token（npm run chrome:login）或服务账号 JWT
let chromeAuth;
if (chromeEnabled) {
  for (const k of ["CHROME_EXTENSION_ID", "CHROME_PUBLISHER_ID"]) {
    if (!env[k]) fail(`缺少 ${k}，请检查 .env`);
    submitEnv[k] = env[k];
  }
  try {
    const oauth = resolveChromeOAuth(env);
    if (oauth) {
      chromeAuth = { mode: "oauth", credentials: oauth };
      info("🔐 Chrome 认证: OAuth refresh token");
    } else {
      const { clientEmail, privateKey } = resolveChromeServiceAccount(env, root);
      chromeAuth = { mode: "service-account" };
      submitEnv.CHROME_API_VERSION = "v2";
      submitEnv.CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL = clientEmail;
      submitEnv.CHROME_SERVICE_ACCOUNT_PRIVATE_KEY = privateKey;
      info("🔐 Chrome 认证: 服务账号 JWT");
    }
  } catch (err) {
    fail(err.message);
  }
}
if (edgeEnabled) {
  // Makefile 命名 → wxt submit 命名
  const map = { PRODUCT_ID: "EDGE_PRODUCT_ID", CLIENT_ID: "EDGE_CLIENT_ID", CLIENT_SECRET: "EDGE_API_KEY" };
  for (const [from, to] of Object.entries(map)) {
    if (!env[from]) fail(`缺少 ${from}（Edge），请检查 .env`);
    submitEnv[to] = env[from];
  }
}
if (firefoxEnabled) {
  for (const k of ["FIREFOX_EXTENSION_ID", "FIREFOX_JWT_ISSUER", "FIREFOX_JWT_SECRET"]) {
    if (!env[k]) fail(`缺少 ${k}（Firefox），请检查 .env`);
    submitEnv[k] = env[k];
  }
  submitEnv.FIREFOX_CHANNEL = env.FIREFOX_CHANNEL || "listed";
}

// ── 3. 构建 zip ──────────────────────────────────────────
const chromeZip = resolve(root, `.output/shadekit-${version}-chrome.zip`);
const edgeZip = resolve(root, `.output/shadekit-${version}-edge.zip`);
const firefoxZip = resolve(root, `.output/shadekit-${version}-firefox.zip`);
const firefoxSourcesZip = resolve(root, `.output/shadekit-${version}-sources.zip`);

if (!SKIP_BUILD) {
  const buildCommands = [
    ...(chromeEnabled ? ["npm run zip"] : []),
    ...(edgeEnabled ? ["npm run zip:edge"] : []),
    ...(firefoxEnabled ? ["npm run zip:firefox"] : []),
  ];
  info("🔨 构建商店 zip...");
  for (const cmd of buildCommands) {
    const r = spawnSync(cmd, { shell: true, stdio: "inherit", cwd: root });
    if (r.status !== 0) fail(`构建失败: ${cmd}`);
  }
}
if (chromeEnabled && !existsSync(chromeZip)) fail(`找不到 ${chromeZip}`);
if (edgeEnabled && !existsSync(edgeZip)) fail(`找不到 ${edgeZip}`);
if (firefoxEnabled && !existsSync(firefoxZip)) fail(`找不到 ${firefoxZip}`);
if (firefoxEnabled && !existsSync(firefoxSourcesZip)) fail(`找不到 ${firefoxSourcesZip}`);

// ── 4. 代理检测（Chrome API 必需）─────────────────────────
const PROXY_URL = process.env.PROXY_URL || "http://127.0.0.1:7890";
function proxyUp(url) {
  return new Promise((resolvePromise) => {
    const u = new URL(url);
    const sock = net.connect(Number(u.port), u.hostname);
    sock.setTimeout(1500);
    sock.on("connect", () => { sock.end(); resolvePromise(true); });
    sock.on("timeout", () => { sock.destroy(); resolvePromise(false); });
    sock.on("error", () => resolvePromise(false));
  });
}

if (chromeEnabled) {
  if (await proxyUp(PROXY_URL)) {
    // wxt submit 子进程通过预加载脚本注入代理；OAuth 通道走本进程的全局 fetch
    submitEnv.DEVTOOLS_PROXY_URL = PROXY_URL;
    submitEnv.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ""} --require ${resolve(root, "scripts/undici-proxy.cjs")}`.trim();
    if (chromeAuth.mode === "oauth") await enableProxy(PROXY_URL);
    info(`🌐 使用代理: ${PROXY_URL}`);
  } else {
    fail(`代理不可用 (${PROXY_URL})。Chrome API 需要代理，请启动代理软件，或用 PROXY_URL=http://host:port 指定`);
  }
}

// ── 5. 工作区检查（仅提醒）────────────────────────────────
try {
  const dirty = execSync("git status --porcelain", { cwd: root }).toString().trim();
  if (dirty && !DRY_RUN) info("⚠️  工作区有未提交改动（继续发布，建议先 commit）");
} catch { /* 非 git 环境忽略 */ }

// ── 6. 提交发布 ──────────────────────────────────────────
// Chrome: OAuth 通道自管 v2 接口；服务账号通道交给 wxt submit。
if (chromeEnabled && chromeAuth.mode === "oauth") {
  try {
    await publishChrome({
      credentials: chromeAuth.credentials,
      publisherId: env.CHROME_PUBLISHER_ID,
      extensionId: env.CHROME_EXTENSION_ID,
      zipPath: chromeZip,
      dryRun: DRY_RUN,
      log: info,
    });
  } catch (err) {
    fail(err.message);
  }
  if (DRY_RUN && CHROME_ONLY) {
    info("✅ 干跑通过，凭证与配置有效");
    process.exit(0);
  }
}

const submitArgs = ["wxt", "submit"];
if (DRY_RUN) submitArgs.push("--dry-run");
// OAuth 通道已自行处理 Chrome，这里只保留其他商店
if (chromeEnabled && chromeAuth.mode !== "oauth") submitArgs.push("--chrome-zip", chromeZip);
if (edgeEnabled) submitArgs.push("--edge-zip", edgeZip);
if (firefoxEnabled) submitArgs.push("--firefox-zip", firefoxZip, "--firefox-sources-zip", firefoxSourcesZip);

if (submitArgs.length > 2) {
  info(`🚀 ${DRY_RUN ? "干跑验证" : "提交发布"}: npx ${submitArgs.join(" ")}`);
  const r = spawnSync("npx", submitArgs, { stdio: "inherit", cwd: root, env: submitEnv });
  if (r.status !== 0) fail("发布失败，见上方输出");
}

info(DRY_RUN ? "✅ 干跑通过，凭证与配置有效" : "🎉 已提交商店审核，注意查收审核邮件");
