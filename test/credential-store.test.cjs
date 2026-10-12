'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createCredentialStore, dpapi } = require('../lib/credential-store.cjs');
const CREDENTIALS = { username: 'synthetic-store-user', password: 'synthetic-store-password' };
async function fixture(t, options = {}) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const root = path.resolve(await fs.mkdtemp(path.join(temporaryRoot, 'portal-credential-test-')));
  t.after(() => {
    if (path.dirname(root) !== temporaryRoot || !path.basename(root).startsWith('portal-credential-test-')) throw new Error('Unexpected temporary cleanup path');
    return fs.rm(root, { recursive: true, force: true });
  });
  const store = createCredentialStore({ root, env: {}, ...options });
  return { store, root, file: path.join(root, 'runtime', 'source-credentials.dpapi.json') };
}

test('environment credentials take priority and cannot be silently overridden by saved settings', async t => {
  const { store } = await fixture(t, { env: { PORTAL_SOURCE_USERNAME: CREDENTIALS.username, PORTAL_SOURCE_PASSWORD: CREDENTIALS.password } });
  assert.deepEqual(await store.load(), CREDENTIALS);
  await assert.rejects(store.save(CREDENTIALS), error => error.status === 409);
  await assert.rejects(store.remove(), error => error.status === 409);
});

test('partial environment configuration fails without falling back to another account', async t => {
  const { store } = await fixture(t, { env: { PORTAL_SOURCE_USERNAME: CREDENTIALS.username } });
  await assert.rejects(store.load(), error => error.status === 503 && !error.message.includes(CREDENTIALS.username));
});

test('disk format contains only encrypted ciphertext; load decrypts internally', async t => {
  let protectedPlaintext;
  const { store, file } = await fixture(t, {
    protect: async value => { protectedPlaintext = value; return 'SYNTHETIC-OPAQUE-CIPHERTEXT'; },
    unprotect: async value => { assert.equal(value, 'SYNTHETIC-OPAQUE-CIPHERTEXT'); return protectedPlaintext; }
  });
  assert.equal(await store.load(), null);
  await store.save(CREDENTIALS);
  const disk = await fs.readFile(file, 'utf8');
  assert.equal(disk.includes(CREDENTIALS.username), false); assert.equal(disk.includes(CREDENTIALS.password), false);
  assert.deepEqual(await store.load(), CREDENTIALS);
  await store.remove(); assert.equal(await store.load(), null);
});

test('encryption failure never writes plaintext and leaves existing encrypted settings intact', async t => {
  let fail = false;
  const { store, file } = await fixture(t, { protect: async () => { if (fail) throw new Error('synthetic failure'); return 'SYNTHETIC-CIPHERTEXT'; } });
  await store.save(CREDENTIALS); const before = await fs.readFile(file, 'utf8'); fail = true;
  await assert.rejects(store.save({ username: 'synthetic-other', password: 'synthetic-other-password' }));
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('unsupported platform cannot silently save unencrypted credentials', async t => {
  const { store, file } = await fixture(t, { platform: 'linux' });
  await assert.rejects(store.save(CREDENTIALS), error => error.status === 503);
  await assert.rejects(fs.stat(file), error => error.code === 'ENOENT');
});

test('Windows DPAPI round-trip uses synthetic data and persists no plaintext', { skip: process.platform !== 'win32' }, async () => {
  const plaintext = JSON.stringify(CREDENTIALS);
  const ciphertext = await dpapi('protect', plaintext);
  assert.notEqual(ciphertext, plaintext); assert.equal(ciphertext.includes(CREDENTIALS.password), false);
  assert.equal(await dpapi('unprotect', ciphertext), plaintext);
});
