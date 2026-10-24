import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoServer } from './server.mjs';

const USERS = [
  ['admin@shadesheep.test', 'Delivery admin', 'admin'],
  ['tester@shadesheep.test', 'Acceptance tester', 'tester'],
];

async function start(t) {
  const server = createDemoServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function login(base, username, password) {
  return fetch(`${base}/api/session/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

test('serves the fictional login page at the entry point', async (t) => {
  const base = await start(t);
  const response = await fetch(`${base}/login`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  const html = await response.text();
  assert.match(html, /ShadeSheep 交付台/);
  assert.doesNotMatch(html, /Northstar|北星/);
});

test('accepts only the two fictional accounts and returns their server-owned identity', async (t) => {
  const base = await start(t);
  for (const [username, displayName, role] of USERS) {
    const response = await login(base, username, 'shadesheep-demo');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.displayName, displayName);
    assert.equal(body.role, role);
    assert.match(response.headers.get('set-cookie'), /HttpOnly/);
    assert.match(response.headers.get('set-cookie'), /SameSite=Lax/);
  }
});

test('rejects invalid credentials without issuing a session', async (t) => {
  const base = await start(t);
  const response = await login(base, 'admin@shadesheep.test', 'wrong');
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(await response.json(), { error: '用户名或密码不正确' });
});

test('redirects anonymous visitors to login and does not accept a forged cookie', async (t) => {
  const base = await start(t);
  for (const cookie of ['', 'shadesheep_session=forged']) {
    const response = await fetch(`${base}/console`, {
      headers: { cookie }, redirect: 'manual',
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/login');
  }
});

test('serves distinct roles from the real session and revokes it on logout', async (t) => {
  const base = await start(t);
  for (const [username, displayName, role] of USERS) {
    const response = await login(base, username, 'shadesheep-demo');
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const consoleResponse = await fetch(`${base}/console`, { headers: { cookie } });
    const html = await consoleResponse.text();
    assert.equal(consoleResponse.status, 200);
    assert.match(html, new RegExp(`data-current-role="${role}"`));
    assert.match(html, new RegExp(displayName));
    const logout = await fetch(`${base}/api/session/logout`, {
      method: 'POST', headers: { cookie },
    });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    const revoked = await fetch(`${base}/console`, {
      headers: { cookie }, redirect: 'manual',
    });
    assert.equal(revoked.status, 302);
  }
});

test('does not expose paths outside the public directory or unknown API routes', async (t) => {
  const base = await start(t);
  assert.equal((await fetch(`${base}/api/not-found`)).status, 404);
  assert.equal((await fetch(`${base}/..%2f..%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/server.mjs`)).status, 404);
});

test('rejects invalid JSON and non-POST login requests without leaking details', async (t) => {
  const base = await start(t);
  assert.equal((await fetch(`${base}/api/session/login`)).status, 405);
  const response = await fetch(`${base}/api/session/login`, {
    method: 'POST', body: '{broken',
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: '请求格式不正确' });
});
