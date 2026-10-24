import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(ROOT, 'public');
const SESSION_COOKIE = 'shadesheep_session';
const sessions = new Map();

// Public, fictional identities for this local-only visual demonstration.
const USERS = new Map([
  ['admin@shadesheep.test', { displayName: 'Delivery admin', localName: '林屿', role: 'admin', title: '交付管理员', password: 'shadesheep-demo' }],
  ['tester@shadesheep.test', { displayName: 'Acceptance tester', localName: '周然', role: 'tester', title: '验收测试', password: 'shadesheep-demo' }],
]);

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function servePage(res, file, identity) {
  let html = await readFile(resolve(PUBLIC, file), 'utf8');
  if (identity) {
    for (const [key, value] of Object.entries(identity)) {
      html = html.replaceAll(`{{${key}}}`, String(value));
    }
  }
  res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
  res.end(html);
}

function identityFrom(req) {
  const cookie = req.headers.cookie ?? '';
  const match = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  const token = match?.slice(SESSION_COOKIE.length + 1);
  return sessions.get(token);
}

export function createDemoServer() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const identity = identityFrom(req);

      if (url.pathname === '/api/session/login') {
        if (req.method !== 'POST') return json(res, 405, { error: '仅支持 POST' });
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 4096) return json(res, 413, { error: '请求过大' });
        }
        let input;
        try { input = JSON.parse(body); } catch { return json(res, 400, { error: '请求格式不正确' }); }
        const user = USERS.get(input.username);
        if (!user || input.password !== user.password) {
          return json(res, 401, { error: '用户名或密码不正确' });
        }
        const token = randomBytes(32).toString('hex');
        const { password, ...publicIdentity } = user;
        sessions.set(token, publicIdentity);
        res.setHeader('set-cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/`);
        return json(res, 200, publicIdentity);
      }

      if (url.pathname === '/api/session/logout') {
        if (req.method !== 'POST') return json(res, 405, { error: '仅支持 POST' });
        const cookie = req.headers.cookie ?? '';
        const token = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
        if (token) sessions.delete(token);
        res.writeHead(204, { 'set-cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
        return res.end();
      }

      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: '接口不存在' });
      if (url.pathname === '/') {
        res.writeHead(302, { location: identity ? '/console' : '/login' });
        return res.end();
      }
      if (url.pathname === '/login' || url.pathname === '/login.html') {
        if (identity) {
          res.writeHead(302, { location: '/console' });
          return res.end();
        }
        return await servePage(res, 'login.html');
      }
      if (url.pathname === '/console' || url.pathname === '/console.html') {
        if (!identity) {
          res.writeHead(302, { location: '/login' });
          return res.end();
        }
        return await servePage(res, 'console.html', identity);
      }
      if (req.method !== 'GET') return json(res, 405, { error: '仅支持 GET' });
      const file = resolve(PUBLIC, `.${decodeURIComponent(url.pathname)}`);
      if (!file.startsWith(`${PUBLIC}/`) || url.pathname.includes('..')) return json(res, 404, { error: '资源不存在' });
      const extension = file.slice(file.lastIndexOf('.'));
      if (!MIME[extension] || extension === '.html') return json(res, 404, { error: '资源不存在' });
      const content = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extension], 'cache-control': 'no-cache' });
      res.end(content);
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof URIError) return json(res, 404, { error: '资源不存在' });
      console.error(error);
      json(res, 500, { error: '演示服务暂时不可用' });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  const server = createDemoServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`ShadeSheep fictional demo: http://127.0.0.1:${port}`);
    console.log('Local accounts: admin@shadesheep.test / tester@shadesheep.test');
  });
}
