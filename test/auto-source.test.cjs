'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAutoSource } = require('../lib/auto-source.cjs');
const { PortalError } = require('../lib/source.cjs');
const CREDENTIALS = { username: 'synthetic-source-user', password: 'synthetic-source-password' };
const QUERY = { start: '2026-10-01', end: '2026-10-12', view: 'weekly', page: 1, size: 20 };
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t, options = {}) {
  let stored = options.empty ? null : { ...CREDENTIALS }, clock = 1000000;
  const calls = { login: [], read: [], save: [], timers: [] };
  const store = {
    async load() { return stored ? { ...stored } : null; },
    async save(value) { if (options.save) await options.save(value); calls.save.push({ ...value }); stored = { ...value }; },
    async remove() { stored = null; }
  };
  const source = {
    async login(username, password) { calls.login.push({ username, password }); return options.login ? options.login(username, password, calls.login.length) : { token: `mock-token-${calls.login.length}` }; },
    async read(module, query, context) { calls.read.push({ module, token: context.token }); return options.read ? options.read(module, query, context, calls.read.length) : { rows: [{ id: context.token }], total: 1 }; }
  };
  const service = createAutoSource({ source, credentialStore: store, now: () => clock,
    setTimer: (fn, delay) => { const timer = { fn, delay, cancelled: false }; calls.timers.push(timer); return timer; }, clearTimer: timer => { timer.cancelled = true; } });
  t.after(() => service.stop());
  return { service, calls, advance: amount => { clock += amount; }, stored: () => stored };
}

test('startup and concurrent reads use a single upstream login and one shared request', async t => {
  const loginGate = gate(), readGate = gate();
  const app = fixture(t, { login: async () => { await loginGate.promise; return { token: 'mock-token' }; }, read: async () => { await readGate.promise; return { rows: [{ id: 1 }], total: 1 }; } });
  app.service.start();
  const first = app.service.read('weld', QUERY), second = app.service.read('weld', QUERY);
  await new Promise(setImmediate); assert.equal(app.calls.login.length, 1); assert.equal(app.service.status().state, 'connecting');
  loginGate.resolve(); await new Promise(setImmediate); assert.equal(app.calls.read.length, 1);
  readGate.resolve(); assert.deepEqual(await first, await second); assert.equal(app.service.status().state, 'ready');
});

test('401 from an expired token is retried once after a single shared reauthentication', async t => {
  const app = fixture(t, { read: async (module, query, context) => {
    if (context.token === 'mock-token-1') throw new PortalError('synthetic expiry', 401);
    return { rows: [{ id: module }], total: 1 };
  } });
  const values = await Promise.all([app.service.read('weld', QUERY), app.service.read('alarm', QUERY)]);
  assert.equal(values.length, 2); assert.equal(app.calls.login.length, 2); assert.equal(app.calls.read.length, 4);
});

test('a second 401 blocks future automatic logins rather than looping on an account', async t => {
  const app = fixture(t, { read: async () => { throw new PortalError('synthetic expiry', 401); } });
  await assert.rejects(app.service.read('weld', QUERY), error => error.status === 428);
  app.advance(3600000);
  await assert.rejects(app.service.read('alarm', QUERY), error => error.status === 428);
  assert.equal(app.calls.login.length, 2); assert.equal(app.calls.read.length, 2);
  assert.equal(app.service.status().state, 'error'); assert.equal(app.service.status().retryAt, null);
});

test('an old-token success during refresh may return for the same account but never refills the new cache', async t => {
  const started = gate(), release = gate();
  const app = fixture(t, { read: async (module, query, context) => {
    if (module === 'weld' && context.token === 'mock-token-1') { started.resolve(); await release.promise; }
    if (module === 'alarm' && context.token === 'mock-token-1') throw new PortalError('synthetic expiry', 401);
    return { rows: [{ id: context.token }], total: 1 };
  } });
  const old = app.service.read('weld', QUERY); await started.promise;
  await app.service.read('alarm', QUERY); release.resolve();
  assert.equal((await old).rows[0].id, 'mock-token-1');
  assert.equal((await app.service.read('weld', QUERY)).rows[0].id, 'mock-token-2');
  assert.equal(app.calls.login.length, 2); assert.equal(app.calls.read.length, 4);
});

test('weekly data refreshes after fourteen seconds and spares after twenty-nine seconds', async t => {
  const app = fixture(t);
  await app.service.read('weld', QUERY); await app.service.read('spares', QUERY);
  app.advance(14001); await app.service.read('weld', QUERY); await app.service.read('spares', QUERY);
  assert.equal(app.calls.read.length, 3);
  app.advance(15000); await app.service.read('spares', QUERY); assert.equal(app.calls.read.length, 4);
});

test('module denial does not reauthenticate or poison another module', async t => {
  const app = fixture(t, { read: async module => { if (module === 'alarm') throw new PortalError('synthetic permission denial', 403); return { rows: [], total: 0 }; } });
  await assert.rejects(app.service.read('alarm', QUERY), error => error.status === 403);
  assert.equal((await app.service.read('spares', QUERY)).total, 0);
  assert.equal(app.calls.login.length, 1); assert.equal(app.service.status().state, 'ready');
});

test('authentication rejection stops automatic retries immediately and never leaks upstream messages', async t => {
  const app = fixture(t, { login: async () => { throw new PortalError(CREDENTIALS.password, 401); } });
  await assert.rejects(app.service.ensureReady()); app.advance(3600000); await assert.rejects(app.service.ensureReady());
  assert.equal(app.calls.login.length, 1); assert.equal(app.service.status().retryAt, null);
  assert.equal(JSON.stringify(app.service.status()).includes(CREDENTIALS.password), false);
});

test('transient login failures back off and stop after three attempts', async t => {
  const app = fixture(t, { login: async () => { throw new PortalError('synthetic unavailable', 504); } });
  await assert.rejects(app.service.ensureReady());
  assert.equal(app.calls.timers[0].delay, 60000); await assert.rejects(app.service.ensureReady()); assert.equal(app.calls.login.length, 1);
  app.advance(60000); await assert.rejects(app.service.ensureReady()); assert.equal(app.calls.timers[1].delay, 300000);
  app.advance(300000); await assert.rejects(app.service.ensureReady());
  app.advance(3600000); await assert.rejects(app.service.ensureReady());
  assert.equal(app.calls.login.length, 3); assert.equal(app.service.status().retryAt, null);
});

test('successful settings take effect immediately and stale old-account reads cannot escape', async t => {
  const started = gate(), release = gate();
  const app = fixture(t, { login: async username => ({ token: username }), read: async (module, query, context) => {
    if (context.token === CREDENTIALS.username) { started.resolve(); await release.promise; }
    return { rows: [{ id: context.token }], total: 1 };
  } });
  const old = app.service.read('weld', QUERY); old.catch(() => {}); await started.promise;
  await app.service.configure({ username: 'synthetic-replacement', password: 'synthetic-replacement-password' });
  release.resolve(); await assert.rejects(old, error => error.status === 428);
  const fresh = await app.service.read('weld', QUERY);
  assert.equal(fresh.rows[0].id, 'synthetic-replacement'); assert.equal(app.calls.save.length, 1);
});

test('failed candidates are not persisted and do not replace a working account', async t => {
  const app = fixture(t, { login: async username => {
    if (username !== CREDENTIALS.username) throw new PortalError('synthetic refused', 401);
    return { token: 'working-token' };
  } });
  await app.service.ensureReady();
  await assert.rejects(app.service.configure({ username: 'synthetic-refused', password: 'synthetic-refused-password' }), error => error.status === 400);
  assert.equal(app.calls.save.length, 0); assert.equal(app.stored().username, CREDENTIALS.username);
  assert.equal(app.service.status().state, 'ready');
  await assert.rejects(app.service.configure(CREDENTIALS), error => error.status === 429);
  assert.equal((await app.service.read('weld', QUERY)).rows[0].id, 'working-token');
});

test('failed data requests are not cached', async t => {
  const app = fixture(t, { read: async (module, query, context, count) => { if (count === 1) throw new PortalError('synthetic temporary query error', 502); return { rows: [], total: 0 }; } });
  await assert.rejects(app.service.read('weld', QUERY));
  assert.equal((await app.service.read('weld', QUERY)).total, 0); assert.equal(app.calls.read.length, 2);
});

test('absence of configured credentials never attempts a company login', async t => {
  const app = fixture(t, { empty: true });
  await assert.rejects(app.service.ensureReady(), error => error.status === 428);
  assert.deepEqual(app.service.status(), { state: 'unconfigured', configured: false, retryAt: null, error: null });
  assert.equal(app.calls.login.length, 0);
});
