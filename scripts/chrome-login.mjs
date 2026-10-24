#!/usr/bin/env node
/**
 * Chrome Web Store 一次性授权（OAuth 桌面客户端 + loopback）
 *
 * 用法:
 *   1. 把 OAuth 桌面客户端 JSON 放到 keys/chrome-oauth-client.json
 *   2. 运行 npm run chrome:login
 *   3. 浏览器打开打印出的 URL，同意授权
 *   4. 回调拿到 code 后自动换取 refresh token，写回 .env 的 CHROME_REFRESH_TOKEN
 *
 * 说明: Google 已停用 OOB（urn:ietf:wg:oauth:2.0:oob）授权，桌面客户端必须用
 *       http://localhost 回环地址接收回调。
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { enableProxy, proxyUp, PROXY_URL } from "./net.mjs";
import { SCOPE } from "./chrome-v2.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT_FILE = resolve(root, "keys/chrome-oauth-client.json");
const ENV_FILE = resolve(root, ".env");
const PORT = Number(process.env.OAUTH_PORT || 8976);
const REDIRECT_URI = `http://localhost:${PORT}`;

const fail = (msg) => {
  console.error(`❌ ${msg}`);
  process.exit(1);
};

if (!existsSync(CLIENT_FILE)) {
  fail(`找不到 ${CLIENT_FILE}。请在 Google Cloud 创建「桌面应用」类型的 OAuth 客户端并下载 JSON`);
}

const raw = JSON.parse(readFileSync(CLIENT_FILE, "utf-8"));
const client = raw.installed ?? raw;
if (!client.client_id || !client.client_secret) {
  fail("OAuth 客户端 JSON 缺少 client_id / client_secret（需要「桌面应用」类型）");
}

// 桌面客户端的 redirect_uris 通常写的是 http://localhost，这里用固定端口
const authUrl =
  `https://accounts.google.com/o/oauth2/auth?response_type=code` +
  `&scope=${encodeURIComponent(SCOPE)}` +
  `&client_id=${encodeURIComponent(client.client_id)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&access_type=offline&prompt=consent`;

console.log("🔐 在浏览器打开下面的链接并同意授权：\n");
console.log(authUrl);
console.log(`\n等待回调 ${REDIRECT_URI} ...\n`);

const code = await new Promise((resolveCode, rejectCode) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, REDIRECT_URI);
    const err = url.searchParams.get("error");
    const codeParam = url.searchParams.get("code");
    if (err) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`授权失败: ${err}`);
      server.close();
      rejectCode(new Error(`授权被拒绝: ${err}`));
      return;
    }
    if (!codeParam) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("等待授权回调...");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("✅ 授权成功，可以关闭此页面回到终端。");
    server.close();
    resolveCode(codeParam);
  });
  server.on("error", rejectCode);
  server.listen(PORT, "127.0.0.1");
});

if (await proxyUp(PROXY_URL)) {
  await enableProxy(PROXY_URL);
  console.log(`🌐 使用代理: ${PROXY_URL}`);
}

const res = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: client.client_id,
    client_secret: client.client_secret,
    code,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
  }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok || !body.refresh_token) {
  fail(`换取 refresh token 失败: ${res.status} ${JSON.stringify(body)}`);
}

// 写回 .env：替换 CHROME_REFRESH_TOKEN，保留其余配置
let envText = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf-8") : "";
const lines = {
  CHROME_CLIENT_ID: client.client_id,
  CHROME_CLIENT_SECRET: client.client_secret,
  CHROME_REFRESH_TOKEN: body.refresh_token,
};
for (const [key, value] of Object.entries(lines)) {
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  envText = re.test(envText) ? envText.replace(re, `${key}=${value}`) : `${envText.replace(/\n*$/, "")}\n${key}=${value}\n`;
}
writeFileSync(ENV_FILE, envText);

console.log("✅ 已写入 .env：CHROME_CLIENT_ID / CHROME_CLIENT_SECRET / CHROME_REFRESH_TOKEN");
console.log("   下一步: make publish DRY=1 SKIP_BUILD=1 ONLY=chrome");
