/**
 * 发布凭据解析（纯函数，供 scripts/release.mjs 与单测共用）
 *
 * Chrome Web Store API v2 只接受服务账号：
 * - OAuth 客户端 JSON（type=installed / web）没有 client_email / private_key，不能用于 v2
 * - 服务账号 JSON 的 private_key 是 PEM；写进 .env 时常被压成一行字面量 \n，
 *   publish-browser-extension 不会还原转义，必须在传给子进程前归一化
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// 解析 .env（KEY=VALUE，忽略注释与空行）
export function parseEnvFile(text) {
  const env = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#")) env[m[1]] = m[2];
  }
  return env;
}

export function loadEnvFile(envPath) {
  if (!existsSync(envPath)) throw new Error("找不到 .env 文件");
  return parseEnvFile(readFileSync(envPath, "utf-8"));
}

export const normalizePrivateKey = (key) => key.replace(/\\n/g, "\n");

/**
 * OAuth refresh token 模式（桌面客户端授权，见 scripts/chrome-login.mjs）。
 * 三个字段齐全时返回 { clientId, clientSecret, refreshToken }，否则返回 null。
 */
export function resolveChromeOAuth(env) {
  const clientId = env.CHROME_CLIENT_ID;
  const clientSecret = env.CHROME_CLIENT_SECRET;
  const refreshToken = env.CHROME_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken };
}

/**
 * 返回 { clientEmail, privateKey }，失败时抛出带修复指引的 Error。
 * 优先 CHROME_SERVICE_ACCOUNT_JSON（文件路径），否则读平铺字段。
 */
export function resolveChromeServiceAccount(env, root) {
  let clientEmail;
  let privateKey;

  if (env.CHROME_SERVICE_ACCOUNT_JSON) {
    const keyPath = resolve(root, env.CHROME_SERVICE_ACCOUNT_JSON);
    if (!existsSync(keyPath)) throw new Error(`找不到服务账号密钥文件: ${keyPath}`);
    let key;
    try {
      key = JSON.parse(readFileSync(keyPath, "utf-8"));
    } catch (err) {
      throw new Error(`服务账号密钥文件不是合法 JSON: ${err.message}`);
    }
    if (key.type !== "service_account") {
      throw new Error(
        `密钥文件 type=${key.type ?? "unknown"}，v2 需要 type=service_account 的服务账号密钥（OAuth 客户端 JSON 不可用）`,
      );
    }
    clientEmail = key.client_email;
    privateKey = key.private_key;
  } else {
    clientEmail = env.CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL;
    privateKey = env.CHROME_SERVICE_ACCOUNT_PRIVATE_KEY;
  }

  if (!clientEmail || !privateKey) {
    throw new Error(
      "缺少 Chrome 服务账号凭据，请配置 CHROME_SERVICE_ACCOUNT_JSON，或 CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL + CHROME_SERVICE_ACCOUNT_PRIVATE_KEY",
    );
  }
  const normalized = normalizePrivateKey(privateKey);
  if (!normalized.includes("BEGIN PRIVATE KEY")) {
    throw new Error("服务账号私钥格式不正确，需包含完整的 PEM 私钥");
  }
  return { clientEmail, privateKey: normalized };
}
