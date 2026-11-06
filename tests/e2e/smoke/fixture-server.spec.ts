import { expect, request, test } from '@playwright/test';
import { createFixtureServer } from '../fixtures/server';

test('[SERVER-01] issues an HttpOnly cookie and serves console', async () => {
  const server = await createFixtureServer();
  const api = await request.newContext({
    baseURL: `http://127.0.0.1:${server.port}`,
  });
  const attemptLogin = (password: string) =>
    api.post('/api/session/login', {
      data: { username: 'tester@fixture.test', password },
    });
  try {
    const unauthenticated = await api.get('/console', { maxRedirects: 0 });
    expect(unauthenticated.status()).toBe(302);
    expect(unauthenticated.headers().location).toBe('/login');
    expect((await api.get('/api/session/me')).status()).toBe(401);

    expect((await attemptLogin('wrong-pass')).status()).toBe(401);

    const login = await attemptLogin('fixture-pass');
    expect(login.status()).toBe(200);
    expect(await login.json()).toMatchObject({
      role: 'tester',
      email: 'tester@fixture.test',
    });

    const state = await api.storageState();
    const sessionCookie = state.cookies.find(
      (cookie) => cookie.name === 'shadekit_session',
    );
    expect(sessionCookie?.httpOnly).toBe(true);
    expect(sessionCookie?.sameSite).toBe('Lax');
    expect(sessionCookie?.path).toBe('/');

    const consoleResponse = await api.get('/console');
    expect(consoleResponse.status()).toBe(200);
    expect(consoleResponse.headers()['cache-control']).toBe('no-store');
    const html = await consoleResponse.text();
    expect(html).toContain('data-current-role="tester"');
    expect(html).toContain('id="identity-email">tester@fixture.test<');
    expect(html).toContain('id="identity-title">验收测试<');

    const me = await api.get('/api/session/me');
    expect(me.status()).toBe(200);
    expect(await me.json()).toMatchObject({
      name: '周然',
      role: 'tester',
    });

    const logout = await api.post('/api/session/logout');
    expect(logout.status()).toBe(200);
    expect((await api.get('/api/session/me')).status()).toBe(401);
  } finally {
    await api.dispose();
    await server.close();
  }
});
