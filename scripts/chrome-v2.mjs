/**
 * Chrome Web Store API v2 —— OAuth 桌面客户端通道
 *
 * publish-browser-extension 的 v2 只支持服务账号 JWT；本模块用 OAuth
 * refresh token 自己换 access token，再调用 v2 的 fetchStatus / upload / publish。
 * 接口文档：https://developer.chrome.com/docs/webstore/using-api
 */
import { readFileSync } from "node:fs";

const API = "https://chromewebstore.googleapis.com";
const SCOPE = "https://www.googleapis.com/auth/chromewebstore";

export function itemName(publisherId, extensionId) {
  return `publishers/${publisherId}/items/${extensionId}`;
}

/** refresh token → access token */
export async function getAccessToken({ clientId, clientSecret, refreshToken }) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    const reason = body.error ? `${body.error}: ${body.error_description ?? ""}`.trim() : res.statusText;
    throw new Error(
      `换取 access token 失败 (${res.status} ${reason})。` +
        "refresh token 失效、或与 client_id/secret 不匹配时需重新运行 `npm run chrome:login`",
    );
  }
  return body.access_token;
}

async function call(token, method, url, body, contentType) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "x-goog-api-version": "2",
      ...(contentType ? { "Content-Type": contentType } : {}),
    },
    body,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const detail = json.error ? JSON.stringify(json.error) : text;
    throw new Error(`Chrome Web Store API ${res.status} ${res.statusText}: ${detail}`);
  }
  return json;
}

export async function fetchStatus(token, { publisherId, extensionId }) {
  return call(token, "GET", `${API}/v2/${itemName(publisherId, extensionId)}:fetchStatus`);
}

export async function uploadZip(token, { publisherId, extensionId, zipPath }) {
  const zip = readFileSync(zipPath);
  const res = await call(
    token,
    "POST",
    `${API}/upload/v2/${itemName(publisherId, extensionId)}:upload`,
    zip,
    "application/zip",
  );
  if (res.uploadState && res.uploadState !== "SUCCEEDED") {
    throw new Error(`上传未成功，uploadState=${res.uploadState}${res.message ? `: ${res.message}` : ""}`);
  }
  return res;
}

export async function publish(token, { publisherId, extensionId, publishType = "DEFAULT_PUBLISH" }) {
  const res = await call(
    token,
    "POST",
    `${API}/v2/${itemName(publisherId, extensionId)}:publish`,
    JSON.stringify({ publishType }),
    "application/json",
  );
  for (const warning of res.warningInfo?.warnings ?? []) {
    console.warn(`⚠️  ${warning.reason}: ${warning.description}`);
  }
  return res;
}

/** 完整发布流程：验证 → 上传 → 提交审核 */
export async function publishChrome({ credentials, publisherId, extensionId, zipPath, dryRun, log = console.log }) {
  const token = await getAccessToken(credentials);
  log("🔑 已获取 access token");
  const status = await fetchStatus(token, { publisherId, extensionId });
  log(`📋 当前状态: ${JSON.stringify(status.submittedItemRevisionStatus ?? status)}`);
  if (dryRun) {
    log("🧪 干跑通过：凭证、publisher 与条目权限均有效（未上传）");
    return { dryRun: true, status };
  }
  log("⬆️  上传 zip...");
  await uploadZip(token, { publisherId, extensionId, zipPath });
  log("🚀 提交审核...");
  const published = await publish(token, { publisherId, extensionId });
  log("✅ Chrome 已提交审核");
  return { dryRun: false, status, published };
}

export { SCOPE, API };
