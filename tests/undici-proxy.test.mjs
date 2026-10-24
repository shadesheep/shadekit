import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('ordinary builds do not spawn the credential-based token keepalive', () => {
  const config = readFileSync(new URL('../wxt.config.ts', import.meta.url), 'utf8');
  assert.equal(config.includes('build:done'), false);
  assert.equal(config.includes('token-keepalive'), false);
});

// A missing proxy bootstrap must fail before a release starts uploading packages.
test('release proxy bootstrap configures a global dispatcher from the environment', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { getGlobalDispatcher } from 'undici';
    await import('./scripts/undici-proxy.cjs');
    assert.ok(getGlobalDispatcher());
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, DEVTOOLS_PROXY_URL: 'http://127.0.0.1:7890' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});
