/**
 * P0a spike 测试站点：模拟登录页 / 受保护页 / iframe / CSP 页面。
 * 只用于本地验证，不参与构建。
 */
import http from "node:http";

const html = (body, extraHead = "") => `<!doctype html>
<html><head><meta charset="utf-8">${extraHead}</head><body>${body}</body></html>`;

const pageHome = html(`
  <h1>spike home</h1>
  <form id="login-form" method="post" action="/login-form">
    <label for="username">用户名</label>
    <input id="username" name="username" autocomplete="username">
    <label for="password">密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password">
    <button id="submit" type="submit">登录</button>
  </form>
`);

const pageApp = (authed) => html(`
  <h1>spike app</h1>
  <div id="state" data-auth="${authed ? "in" : "out"}">${authed ? "logged-in" : "logged-out"}</div>
  <div id="user">${authed ? "alice" : ""}</div>
`);

const pageIframeHost = html(`
  <h1>iframe host</h1>
  <button id="in-main">MAIN</button>
  <iframe id="same" src="/iframe-child"></iframe>
  <iframe id="cross" src="http://localhost:__PORT__/iframe-child"></iframe>
`);

const pageIframeChild = html(`
  <h1>iframe child</h1>
  <button id="in-iframe">IFRAME</button>
`);

const pageCsp = html(
  `
  <h1>csp page</h1>
  <div id="csp-state">pending</div>
  <script>window.__cspInlineRan = true; document.getElementById("csp-state").textContent = "inline-ran";</script>
`,
  `<meta http-equiv="Content-Security-Policy" content="script-src 'none'">`,
);

export function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const cookie = req.headers.cookie || "";
    const authed = /(?:^|;\s*)session=ok(?:;|$)/.test(cookie);

    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end(body);
    };
    const json = (status, obj, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(obj));
    };

    if (req.method === "POST" && url.pathname === "/login-form") {
      // 真实表单提交：设置会话 cookie 后 302 到受保护页
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(302, {
          "set-cookie": "session=ok; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600",
          location: "/app",
        });
        res.end();
      });
      return;
    }

    if (url.pathname === "/") return send(200, pageHome);
    if (url.pathname === "/app") return send(200, pageApp(authed));
    if (url.pathname === "/iframe-host")
      return send(200, pageIframeHost.replace("__PORT__", String(server.address().port)));
    if (url.pathname === "/iframe-child") return send(200, pageIframeChild);
    if (url.pathname === "/csp") return send(200, pageCsp);

    if (url.pathname === "/api/login" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        json(
          200,
          {
            token: "tok-123",
            user: "alice",
            receivedOrigin: req.headers.origin ?? null,
            receivedCookieHeader: req.headers.cookie ?? null,
            body,
          },
          {
            "set-cookie": [
              "session=ok; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600",
              "extra=1; Path=/; Max-Age=60",
            ],
            "access-control-allow-origin": "*",
          },
        );
      });
      return;
    }

    if (url.pathname === "/api/me") {
      // 刻意不返回 Access-Control-Allow-Origin：模拟「后端没配 CORS」的常见情况
      if (!authed) return json(401, { error: "unauthenticated" });
      return json(200, { user: "alice", cookie });
    }

    send(404, "not found");
  });

  return new Promise((resolve) => {
    server.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

// 直接运行时自测
if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = await startServer();
  console.log(`spike server on http://127.0.0.1:${port}`);
}
