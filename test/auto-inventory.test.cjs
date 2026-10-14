'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAutoSource } = require('../lib/auto-source.cjs');
const { PortalError } = require('../lib/source.cjs');

const CREDENTIALS = { username: 'synthetic-inventory-user', password: 'synthetic-inventory-password' };
const QUERY = { category: 'all', stock: 'all', page: 1, size: 50 };
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t, options = {}) {
  let stored = { ...CREDENTIALS };
  const calls = { login: 0, catalog: 0, write: 0, read: 0, save: 0, remove: 0 };
  const source = {
    async login(account, password) { calls.login++; return options.login ? options.login(account, password, calls.login) : { token: 'synthetic-token-' + calls.login }; },
    async read(module, query, context) { calls.read++; return options.read ? options.read(module, query, context, calls.read) : { rows: [{ id: calls.read }] }; },
    inventoryCapabilities: () => ({ inbound: { enabled: false }, outbound: { enabled: true }, adjust: { enabled: false } }),
    async inventoryCatalog(input, context) { calls.catalog++; return options.catalog ? options.catalog(input, context, calls.catalog) : { rows: [{ id: calls.catalog }], complete: true }; },
    async inventoryWrite(kind, operation, context) { calls.write++; return options.write ? options.write(kind, operation, context, calls.write) : { receiptId: 'SYNTHETIC-DOC' }; }
  };
  if (options.noInventory) for (const key of ['inventoryCapabilities', 'inventoryCatalog', 'inventoryWrite']) delete source[key];
  const credentialStore = {
    async load() { return stored && { ...stored }; },
    async save(value) { calls.save++; stored = { ...value }; },
    async remove() { calls.remove++; stored = null; }
  };
  const service = createAutoSource({ source, credentialStore, setTimer: () => ({ unref() {} }), clearTimer: () => {} });
  t.after(() => service.stop());
  return { service, calls };
}

test('inventory catalog bypasses the ordinary read cache and keeps the authenticated source context', async t => {
  const { service, calls } = fixture(t, { catalog: async (options, context, count) => {
    assert.equal(context.token, 'synthetic-token-1');
    assert.equal(options.fresh, true);
    return { rows: [{ id: count }], complete: true };
  } });
  await service.read('spares', QUERY);
  assert.equal((await service.inventoryCatalog({ fresh: true })).rows[0].id, 1);
  assert.equal((await service.inventoryCatalog({ fresh: true })).rows[0].id, 2);
  assert.equal(calls.login, 1);
  assert.equal(calls.catalog, 2);
  assert.equal(calls.read, 1);
});

test('inventory catalog refreshes an expired source session once and returns the new-session result', async t => {
  const tokens = [];
  const { service, calls } = fixture(t, { catalog: async (options, context) => {
    tokens.push(context.token);
    assert.equal(options.fresh, true);
    if (context.token === 'synthetic-token-1') throw new PortalError('synthetic expired source session', 401);
    return { rows: [{ id: 'new-session-stock', stock: 6 }], complete: true };
  } });
  const result = await service.inventoryCatalog({ fresh: true });
  assert.equal(result.rows[0].id, 'new-session-stock');
  assert.equal(result.rows[0].stock, 6);
  assert.deepEqual(tokens, ['synthetic-token-1', 'synthetic-token-2']);
  assert.equal(calls.login, 2);
  assert.equal(calls.catalog, 2);
  assert.equal(service.status().state, 'ready');
  assert.equal(service.status().error, null);
  await service.inventoryCatalog({ fresh: true });
  assert.equal(calls.login, 2);
  assert.equal(calls.catalog, 3);
});

test('a second inventory catalog 401 blocks automatic reauthentication instead of looping', async t => {
  const { service, calls } = fixture(t, { catalog: async () => { throw new PortalError('synthetic denial ' + CREDENTIALS.password, 401); } });
  await assert.rejects(service.inventoryCatalog({ fresh: true }), error => error.status === 428 && !error.message.includes(CREDENTIALS.password));
  assert.equal(calls.login, 2);
  assert.equal(calls.catalog, 2);
  assert.equal(service.status().state, 'error');
  assert.equal(service.status().retryAt, null);
  assert.equal(JSON.stringify(service.status()).includes(CREDENTIALS.password), false);
  await assert.rejects(service.inventoryCatalog({ fresh: true }), error => error.status === 428);
  await assert.rejects(service.ensureReady(), error => error.status === 428);
  assert.equal(calls.login, 2);
  assert.equal(calls.catalog, 2);
});

test('writes never reauthenticate or retry after explicit denial or uncertain failures', async t => {
  for (const status of [401, 403, 422, 503]) {
    const { service, calls } = fixture(t, { write: async () => {
      const error = new PortalError('合成测试错误', status);
      if (status === 503) error.outcome = 'unknown';
      throw error;
    } });
    await assert.rejects(service.inventoryWrite('outbound', { requestId: 'synthetic-request' }), error => error.status === status);
    assert.equal(calls.write, 1);
    assert.equal(calls.login, 1);
  }
});

test('missing inventory integration exposes disabled capabilities and never attempts a write', async t => {
  const { service, calls } = fixture(t, { noInventory: true });
  assert.deepEqual(Object.values(service.inventoryCapabilities()).map(value => value.enabled), [false, false, false]);
  await assert.rejects(service.inventoryWrite('outbound', {}), error => error.status === 503);
  assert.equal(calls.write, 0);
});

test('source authentication failures sanitize credentials and never reach the inventory write', async t => {
  const { service, calls } = fixture(t, { login: async () => { throw new PortalError(CREDENTIALS.username + ' ' + CREDENTIALS.password, 401); } });
  await assert.rejects(service.inventoryWrite('outbound', {}), error => !error.message.includes(CREDENTIALS.username) && !error.message.includes(CREDENTIALS.password));
  assert.equal(calls.write, 0);
  const serialized = JSON.stringify(service.status());
  assert.equal(serialized.includes(CREDENTIALS.username), false);
  assert.equal(serialized.includes(CREDENTIALS.password), false);
});

test('source switch during catalog load invalidates the old account result', async t => {
  const entered = gate(), release = gate();
  const { service, calls } = fixture(t, { catalog: async () => { entered.resolve(); await release.promise; return { rows: [{ id: 'old-account' }] }; } });
  const old = service.inventoryCatalog({ fresh: true });
  old.catch(() => {});
  await entered.promise;
  await service.configure({ username: 'synthetic-replacement', password: 'synthetic-replacement-password' });
  release.resolve();
  await assert.rejects(old, error => error.status === 428);
  assert.equal(calls.catalog, 1);
});

test('a catalog source revision cannot authorize a write after switching the company account', async t => {
  const seenWrites = [];
  const { service, calls } = fixture(t, { write: async (kind, operation, context) => {
    seenWrites.push({ kind, sourceRevision: operation.sourceRevision, token: context.token });
    return { receiptId: 'SYNTHETIC-NEW-ACCOUNT-DOC' };
  } });
  const oldCatalog = await service.inventoryCatalog({ fresh: true });
  assert.equal(typeof oldCatalog.sourceRevision, 'number');
  await service.configure({ username: 'synthetic-replacement', password: 'synthetic-replacement-password' });
  await assert.rejects(service.inventoryWrite('outbound', { requestId: 'synthetic-old-request', sourceRevision: oldCatalog.sourceRevision }), error => error.status === 409);
  assert.equal(calls.write, 0);
  const freshCatalog = await service.inventoryCatalog({ fresh: true });
  assert.notEqual(freshCatalog.sourceRevision, oldCatalog.sourceRevision);
  assert.deepEqual(await service.inventoryWrite('outbound', { requestId: 'synthetic-new-request', sourceRevision: freshCatalog.sourceRevision }), { receiptId: 'SYNTHETIC-NEW-ACCOUNT-DOC' });
  assert.deepEqual(seenWrites, [{ kind: 'outbound', sourceRevision: freshCatalog.sourceRevision, token: 'synthetic-token-2' }]);
  assert.equal(calls.write, 1);
});

test('in-flight inventory writes prevent source configuration and removal before any credential mutation', async t => {
  const entered = gate(), release = gate();
  const { service, calls } = fixture(t, { write: async () => { entered.resolve(); await release.promise; return { receiptId: 'SYNTHETIC-DOC' }; } });
  const writing = service.inventoryWrite('outbound', {});
  writing.catch(() => {});
  await entered.promise;
  try {
    await assert.rejects(service.configure({ username: 'synthetic-replacement', password: 'synthetic-replacement-password' }), error => error.status === 409);
    await assert.rejects(service.clear(), error => error.status === 409);
    assert.equal(calls.login, 1);
    assert.equal(calls.save, 0);
    assert.equal(calls.remove, 0);
  } finally { release.resolve(); }
  assert.deepEqual(await writing, { receiptId: 'SYNTHETIC-DOC' });
});

test('success and uncertain write failure both invalidate cached stock', async t => {
  for (const outcome of ['success', 'unknown']) {
    const { service, calls } = fixture(t, { write: async () => {
      if (outcome === 'unknown') { const error = new PortalError('库存待核实', 503); error.outcome = 'unknown'; throw error; }
      return { receiptId: 'SYNTHETIC-DOC' };
    } });
    await service.read('spares', QUERY);
    await service.read('spares', QUERY);
    assert.equal(calls.read, 1);
    if (outcome === 'unknown') await assert.rejects(service.inventoryWrite('outbound', {}));
    else await service.inventoryWrite('outbound', {});
    await service.read('spares', QUERY);
    assert.equal(calls.read, 2);
  }
});

test('an old read finishing after a write cannot refill the cache with the old inventory', async t => {
  const entered = gate(), release = gate();
  const { service, calls } = fixture(t, { read: async (module, query, context, count) => {
    if (count === 1) { entered.resolve(); await release.promise; return { rows: [{ stock: 8 }] }; }
    return { rows: [{ stock: 6 }] };
  } });
  const oldRead = service.read('spares', QUERY);
  oldRead.catch(() => {});
  await entered.promise;
  await service.inventoryWrite('outbound', {});
  release.resolve();
  await oldRead;
  const fresh = await service.read('spares', QUERY);
  assert.equal(fresh.rows[0].stock, 6);
  assert.equal(calls.read, 2);
});
