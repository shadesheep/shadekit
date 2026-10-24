import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  normalizePrivateKey,
  parseEnvFile,
  resolveChromeOAuth,
  resolveChromeServiceAccount,
} from '../scripts/release-credentials.mjs';

const PEM = '-----BEGIN PRIVATE KEY-----\\nMIIE\\n-----END PRIVATE KEY-----\\n';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'shadekit-release-'));
}

test('parseEnvFile ignores comments and blank lines', () => {
  const env = parseEnvFile('# comment\n\nA=1\nB=two words\n');
  assert.deepEqual(env, { A: '1', B: 'two words' });
});

test('normalizePrivateKey restores literal \\n escapes from .env', () => {
  assert.equal(normalizePrivateKey(PEM).split('\n').length, 4);
});

test('service account JSON file is parsed into email and normalized key', () => {
  const root = tempRoot();
  writeFileSync(
    join(root, 'sa.json'),
    JSON.stringify({ type: 'service_account', client_email: 'svc@example.com', private_key: PEM }),
  );
  const out = resolveChromeServiceAccount({ CHROME_SERVICE_ACCOUNT_JSON: 'sa.json' }, root);
  assert.equal(out.clientEmail, 'svc@example.com');
  assert.ok(out.privateKey.startsWith('-----BEGIN PRIVATE KEY-----\n'));
});

test('OAuth client JSON is rejected with an actionable message', () => {
  const root = tempRoot();
  writeFileSync(join(root, 'oauth.json'), JSON.stringify({ installed: { client_id: 'x' } }));
  assert.throws(
    () => resolveChromeServiceAccount({ CHROME_SERVICE_ACCOUNT_JSON: 'oauth.json' }, root),
    /type=unknown.*service_account/,
  );
});

test('inline email + private key works without a JSON file', () => {
  const out = resolveChromeServiceAccount(
    {
      CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL: 'svc@example.com',
      CHROME_SERVICE_ACCOUNT_PRIVATE_KEY: PEM,
    },
    tempRoot(),
  );
  assert.equal(out.clientEmail, 'svc@example.com');
  assert.ok(out.privateKey.includes('BEGIN PRIVATE KEY'));
});

test('missing credentials and malformed keys fail fast', () => {
  assert.throws(() => resolveChromeServiceAccount({}, tempRoot()), /缺少 Chrome 服务账号凭据/);
  assert.throws(
    () =>
      resolveChromeServiceAccount(
        {
          CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL: 'svc@example.com',
          CHROME_SERVICE_ACCOUNT_PRIVATE_KEY: 'not-a-key',
        },
        tempRoot(),
      ),
    /私钥格式不正确/,
  );
});

test('missing JSON path reports the resolved path', () => {
  assert.throws(
    () => resolveChromeServiceAccount({ CHROME_SERVICE_ACCOUNT_JSON: 'nope.json' }, tempRoot()),
    /找不到服务账号密钥文件/,
  );
});

test('OAuth credentials are detected only when all three fields exist', () => {
  assert.equal(resolveChromeOAuth({}), null);
  assert.equal(resolveChromeOAuth({ CHROME_CLIENT_ID: 'id', CHROME_CLIENT_SECRET: 'secret' }), null);
  assert.deepEqual(
    resolveChromeOAuth({
      CHROME_CLIENT_ID: 'id',
      CHROME_CLIENT_SECRET: 'secret',
      CHROME_REFRESH_TOKEN: 'token',
    }),
    { clientId: 'id', clientSecret: 'secret', refreshToken: 'token' },
  );
});
