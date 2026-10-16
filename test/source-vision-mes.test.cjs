'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSource } = require('../lib/source.cjs');
const { createAutoSource } = require('../lib/auto-source.cjs');

const CONFIG = { apiBase: 'https://example.invalid', loginToken: '', materialGroups: { front: [], rear: [] } };
const BARCODE = 'SYNTHETIC-MES-001';
const PROCESS = 'synthetic-process';
const PROCESSES_PATH = '/api/parameter_unqualified/getgxcode';
const DETAIL_PATH = '/api/parameter_unqualified';
const QUERY = { action: 'lookup', barcode: BARCODE, processId: PROCESS };
const CREDENTIALS = { username: 'synthetic-account-A', password: 'synthetic-password-A' };
const response = data => ({ ok: true, status: 200, json: async () => structuredClone(data) });
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(t, options = {}) {
  let credentials = { ...CREDENTIALS }, clock = 1000000, logins = 0;
  const calls = [], saved = [];
  const source = createSource(CONFIG, async (url, init) => {
    assert.equal(url.origin, CONFIG.apiBase, 'the test must never contact a real system');
    const call = { url: new URL(url), method: init.method, headers: { ...init.headers }, body: init.body };
    calls.push(call);
    if (url.pathname === '/api/User_Login') {
      assert.equal(init.method, 'POST');
      const body = JSON.parse(init.body);
      logins++;
      return response({ code: 0, data: { token: `synthetic-token-${body.account}-${logins}` } });
    }
    assert.equal(init.method, 'GET', 'MES operations must never write business records');
    assert.equal(init.body, undefined);
    if (options.handle) {
      const intercepted = await options.handle(call, calls);
      if (intercepted !== undefined) return intercepted;
    }
    if (url.pathname === PROCESSES_PATH) return response({ code: 0, data: [{ value: PROCESS, label: '合成尺寸工序' }] });
    if (url.pathname === DETAIL_PATH) return response({ code: 0, data: {
      barcode: url.searchParams.get('barcode'), create_time: '0001-01-01T00:00:00',
      cx_name: init.headers.Authorization.includes('account-B') ? '合成线体 B' : '合成线体 A',
      list: [{ param_key: 'synthetic-point', param_name: '合成点位', param_down: '-1', param_up: '1', value: '0.2', result: 'OK' }],
    } });
    if (url.pathname === '/api/Mold_SparepartsDetailed') return response({ code: 0, total: 1, data: [{ bjbh: 'synthetic-part', bjmc: '合成定位销', nowStock: 5, minStock: 1 }] });
    assert.fail(`Unexpected endpoint in a synthetic test: ${url.pathname}`);
  });
  const auto = createAutoSource({ source, now: () => clock, credentialStore: {
    async load() { return credentials ? { ...credentials } : null; },
    async save(value) { credentials = { ...value }; saved.push({ ...value }); },
    async remove() { credentials = null; },
  }, setTimer: () => ({ unref() {} }), clearTimer() {} });
  t.after(() => auto.stop());
  return { source, auto, calls, saved, advance(ms) { clock += ms; }, loginCount: () => logins };
}

test('createSource connects both MES actions and forwards only read parameters without an employee dependency', async t => {
  const { source, calls } = fixture(t);
  const session = { token: 'synthetic-direct-session' };
  const choices = await source.read('visionMes', { action: 'processes', barcode: BARCODE }, session);
  assert.deepEqual(choices.processes, [{ id: PROCESS, name: '合成尺寸工序' }]);
  const result = await source.read('visionMes', { ...QUERY, employee: 'synthetic-employee', employeeCode: 'synthetic-code',
    method: 'PUT', path: '/api/not-allowed', body: { employee: 'not-allowed' } }, session);
  assert.equal(result.barcode, BARCODE);
  assert.equal(result.measurements[0].actualRaw, '0.2');
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.eligibleForLineRate, false);
  assert.deepEqual(calls.map(c => c.url.pathname), [PROCESSES_PATH, PROCESSES_PATH, DETAIL_PATH]);
  for (const call of calls) {
    assert.equal(call.method, 'GET');
    assert.deepEqual([...call.url.searchParams.keys()].sort(), call.url.pathname === DETAIL_PATH ? ['barcode', 'id'] : ['barcode']);
    assert.equal(call.headers.Authorization, 'Bearer synthetic-direct-session');
    assert.equal(call.body, undefined);
  }
  assert.equal(JSON.stringify(result).includes('synthetic-employee'), false);
});

test('invalid MES fields fail through createSource before upstream fetch, and unknown process never reaches detail', async t => {
  const { source, calls } = fixture(t);
  for (const query of [{ ...QUERY, action: 'submit' }, { ...QUERY, barcode: 'bad\ncode' },
    { ...QUERY, barcode: 'X'.repeat(201) }, { ...QUERY, processId: '../write' }]) {
    await assert.rejects(source.read('visionMes', query, { token: 'synthetic' }), error => error.status === 400);
  }
  assert.equal(calls.length, 0);
  await assert.rejects(source.read('visionMes', { ...QUERY, processId: 'unrelated-process' }, { token: 'synthetic' }), error => error.status === 400);
  assert.deepEqual(calls.map(c => c.url.pathname), [PROCESSES_PATH]);
});

test('business 401 at either read stage automatically logs in once more and revalidates membership', async t => {
  for (const failedPath of [PROCESSES_PATH, DETAIL_PATH]) {
    const app = fixture(t, { handle(call) {
      if (call.url.pathname === failedPath && call.headers.Authorization.endsWith('-1')) return response({ code: 401, msg: 'synthetic-expired-session' });
    } });
    const result = await app.auto.read('visionMes', QUERY);
    assert.equal(result.measurements.length, 1);
    assert.equal(app.loginCount(), 2);
    assert.equal(app.auto.status().state, 'ready');
    const business = app.calls.filter(c => c.url.pathname !== '/api/User_Login');
    assert.equal(business.filter(c => c.url.pathname === PROCESSES_PATH).length, 2);
    assert.equal(business.filter(c => c.url.pathname === DETAIL_PATH).length, failedPath === DETAIL_PATH ? 2 : 1);
    assert.ok(business.every(c => c.method === 'GET'));
    assert.equal(business.at(-1).headers.Authorization.endsWith('-2'), true);
    assert.equal(JSON.stringify(result).includes('synthetic-expired-session'), false);
  }
});

test('two consecutive source 401 responses become 428 and stop retrying rather than expiring the portal session', async t => {
  const app = fixture(t, { handle: () => response({ code: '401', message: 'synthetic-private-auth-message' }) });
  await assert.rejects(app.auto.read('visionMes', QUERY), error => error.status === 428 && !error.message.includes('synthetic-private-auth-message'));
  app.advance(3600000);
  await assert.rejects(app.auto.read('visionMes', QUERY), error => error.status === 428);
  assert.equal(app.loginCount(), 2);
  assert.equal(app.calls.filter(c => c.url.pathname === PROCESSES_PATH).length, 2);
  assert.equal(app.calls.some(c => c.url.pathname === DETAIL_PATH), false);
  assert.equal(app.auto.status().retryAt, null);
});

test('concurrent identical MES queries share one fetch, while action and barcode caches stay separate', async t => {
  const started = gate(), release = gate();
  const app = fixture(t, { async handle(call) {
    if (call.url.pathname === PROCESSES_PATH && call.url.searchParams.get('barcode') === BARCODE) { started.resolve(); await release.promise; }
  } });
  const first = app.auto.read('visionMes', QUERY), second = app.auto.read('visionMes', { ...QUERY });
  await started.promise;
  assert.equal(app.calls.filter(c => c.url.pathname === PROCESSES_PATH).length, 1);
  release.resolve();
  assert.deepEqual(await first, await second);
  assert.equal(app.calls.filter(c => c.url.pathname === DETAIL_PATH).length, 1);
  const other = await app.auto.read('visionMes', { ...QUERY, barcode: 'SYNTHETIC-MES-OTHER' });
  assert.equal(other.barcode, 'SYNTHETIC-MES-OTHER');
  const choices = await app.auto.read('visionMes', { action: 'processes', barcode: BARCODE });
  assert.ok(Array.isArray(choices.processes));
  assert.equal(Object.hasOwn(choices, 'measurements'), false);
  assert.equal(app.loginCount(), 1);
});

test('MES cache refresh observes changed measurements after TTL and does not replace another module cache', async t => {
  let value = '0.1';
  const app = fixture(t, { handle(call) {
    if (call.url.pathname === DETAIL_PATH) return response({ code: 0, data: { barcode: BARCODE,
      list: [{ param_key: 'synthetic-point', param_name: '合成点位', param_down: '-1', param_up: '1', value, result: 'OK' }] } });
  } });
  const spareQuery = { page: 1, size: 20, category: 'all', keyword: '', stock: 'all' };
  const spare = await app.auto.read('spares', spareQuery);
  assert.equal((await app.auto.read('visionMes', QUERY)).measurements[0].actual, 0.1);
  value = '0.2';
  app.advance(13999);
  assert.equal((await app.auto.read('visionMes', QUERY)).measurements[0].actual, 0.1);
  app.advance(2);
  assert.equal((await app.auto.read('visionMes', QUERY)).measurements[0].actual, 0.2);
  assert.deepEqual(await app.auto.read('spares', spareQuery), spare);
  assert.equal(app.calls.filter(c => c.url.pathname === DETAIL_PATH).length, 2);
  assert.equal(app.calls.filter(c => c.url.pathname === '/api/Mold_SparepartsDetailed').length, 1);
});

test('changing the source account invalidates cached MES results', async t => {
  const app = fixture(t);
  assert.equal((await app.auto.read('visionMes', QUERY)).lineName, '合成线体 A');
  await app.auto.configure({ username: 'synthetic-account-B', password: 'synthetic-password-B' });
  assert.equal((await app.auto.read('visionMes', QUERY)).lineName, '合成线体 B');
  assert.equal(app.calls.filter(c => c.url.pathname === DETAIL_PATH).length, 2);
  assert.equal(app.saved.length, 1);
});

test('an in-flight result from the previous account is rejected and cannot refill the replacement cache', async t => {
  const started = gate(), release = gate();
  const app = fixture(t, { async handle(call) {
    if (call.url.pathname === DETAIL_PATH && call.headers.Authorization.includes('account-A')) { started.resolve(); await release.promise; }
  } });
  const old = app.auto.read('visionMes', QUERY);
  old.catch(() => {});
  await started.promise;
  await app.auto.configure({ username: 'synthetic-account-B', password: 'synthetic-password-B' });
  release.resolve();
  await assert.rejects(old, error => error.status === 428);
  assert.equal((await app.auto.read('visionMes', QUERY)).lineName, '合成线体 B');
  assert.equal(app.calls.filter(c => c.url.pathname === DETAIL_PATH).length, 2);
});

test('a denied MES module neither forces reauthentication nor poisons an authorized module', async t => {
  const app = fixture(t, { handle(call) {
    if (call.url.pathname === PROCESSES_PATH) return { ok: false, status: 403 };
  } });
  await assert.rejects(app.auto.read('visionMes', QUERY), error => error.status === 403);
  const spare = await app.auto.read('spares', { page: 1, size: 20, category: 'all', keyword: '', stock: 'all' });
  assert.equal(spare.total, 1);
  assert.equal(app.loginCount(), 1);
  assert.equal(app.auto.status().state, 'ready');
});
