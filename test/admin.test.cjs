'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeAdminConfig, verifyAdmin } = require('../lib/admin.cjs');

test('administrator configuration stores random salt and hash without plaintext password', () => {
  const password = 'synthetic-unit-test-secret-42!';
  const first = makeAdminConfig('synthetic-admin', password), second = makeAdminConfig('synthetic-admin', password);
  assert.equal(first.username, 'synthetic-admin');
  assert.match(first.salt, /^[a-f0-9]{32,}$/i); assert.match(first.passwordHash, /^[a-f0-9]{64,}$/i);
  assert.notEqual(first.salt, second.salt); assert.notEqual(first.passwordHash, second.passwordHash);
  assert.equal(Object.hasOwn(first, 'password'), false); assert.equal(JSON.stringify(first).includes(password), false);
  assert.equal(verifyAdmin(first, 'synthetic-admin', password), true);
});

test('only the matching local administrator and password authenticate', () => {
  const config = makeAdminConfig('synthetic-admin', 'synthetic-correct-secret');
  assert.equal(verifyAdmin(config, 'synthetic-admin', 'synthetic-correct-secret'), true);
  assert.equal(verifyAdmin(config, 'synthetic-admin', 'synthetic-wrong-secret'), false);
  assert.equal(verifyAdmin(config, 'different-admin', 'synthetic-correct-secret'), false);
  assert.equal(verifyAdmin(config, '', ''), false);
});

test('missing or malformed configuration has no default administrator credentials', () => {
  for (const config of [undefined, null, {}, { username: 'admin' }, { username: 'admin', salt: 'not-hex', passwordHash: 'not-hex' }, { username: 'admin', salt: '11'.repeat(16), passwordHash: '00' }]) {
    assert.equal(verifyAdmin(config, 'admin', 'admin'), false);
    assert.equal(verifyAdmin(config, 'admin', '123456'), false);
  }
});
