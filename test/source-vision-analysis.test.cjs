'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAutoSource } = require('../lib/auto-source.cjs');
const { createMesVisionReportConnector } = require('../lib/vision-mes-report.cjs');

const NOW = Date.parse('2026-02-03T04:00:00.000Z');
const VIEWER = 'synthetic_portal_session_A';
const CREDENTIALS = { username: 'synthetic-source-user', password: 'synthetic-source-password' };
const REPORT = '/api/ProcessReport', DETAIL = '/api/ProcessReport/detail/';
const reportQuery = overrides => ({ action: 'report', lineId: '11', queryMode: 'time',
  start: '2026-02-03T00:00', end: '2026-02-03T23:59', _viewerScope: VIEWER, ...overrides });
const batchQuery = snapshotId => ({ action: 'analysis', snapshotId, offset: 0, _viewerScope: VIEWER });
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(t, { config = {}, onCall, onRead } = {}) {
  let clock = NOW, credentials = { ...CREDENTIALS }, logins = 0;
  const requests = [], reads = [];
  const connector = createMesVisionReportConnector({ now: () => clock, config, request: async (path, options) => {
    requests.push({ path, ...options });
    assert.equal(options.method, 'GET');
    assert.ok(path === '/api/Cx/select' || path === REPORT || /^\/api\/ProcessReport\/detail\/[12]$/.test(path));
    if (onCall) await onCall(path, options);
    if (path === '/api/Cx/select') return { code: 0, data: [{ value: 11, label: 'CX_TEST1-合成视觉尺寸线' }] };
    if (path === REPORT) return { code: 0, total: 2, data: [1, 2].map(index => ({ id: index,
      barCode: `SYNTHETIC-${index}`, endTime: new Date(NOW - index * 60000).toISOString(), type: index === 1 ? 'OK' : 'NG',
      productLineCode: 'CX_TEST1', productLineName: '合成视觉尺寸线', gxCode: 'SYN_PROCESS', gxName: '合成尺寸检测工序',
      equipmentCode: 'SYN_DEVICE', equipmentName: '合成设备', itemCode: 'SYN_PART', itemName: '合成物料' })) };
    return { code: 0, data: [{ param_Name: '合成测点', key: 'point-1', param_UP: '1', param_DOWN: '-1', value: '0.2', result: 'OK' }] };
  } });
  const source = {
    async login() { return { token: `synthetic-company-token-${++logins}` }; },
    async read(module, query, session) {
      assert.equal(module, 'visionMesReport'); reads.push({ action: query.action, scope: query._viewerScope });
      if (onRead) await onRead(query, session);
      return connector.read(query, session);
    },
  };
  const service = createAutoSource({ source, now: () => clock, credentialStore: {
    async load() { return credentials && { ...credentials }; },
    async save(value) { credentials = { ...value }; },
    async remove() { credentials = null; },
  } });
  t.after(() => service.stop());
  const read = query => service.read('visionMesReport', query);
  return { service, read, requests, reads, advance: milliseconds => { clock += milliseconds; } };
}

test('auto source immediately retries failed analysis items instead of caching a partial batch for fourteen seconds', async t => {
  let broken = true;
  const app = fixture(t, { onCall: path => {
    if (broken && path === DETAIL + '2') throw Object.assign(new Error('synthetic failure'), { status: 502 });
  } });
  const report = await app.read(reportQuery()), query = batchQuery(report.analysisSnapshot.snapshotId);
  const partial = await app.read(query);
  assert.equal(partial.complete, false); assert.deepEqual(partial.errors.map(item => item.recordId), ['2']);
  broken = false;
  const retried = await app.read(query);
  assert.equal(retried.complete, true); assert.equal(retried.items.length, 2); assert.deepEqual(retried.errors, []);
  assert.equal(app.reads.filter(read => read.action === 'analysis').length, 2);
  assert.deepEqual(app.requests.filter(call => call.path.startsWith(DETAIL)).map(call => call.path), [DETAIL + '1', DETAIL + '2', DETAIL + '2'],
    'successful details retain the connector cache while the failed item is fetched again');
});

test('a previously successful analysis batch rechecks absolute snapshot expiry within the former result-cache window', async t => {
  const app = fixture(t, { config: { vision: { mes: { analysisSnapshotTtlMs: 1000 } } } });
  const report = await app.read(reportQuery()), query = batchQuery(report.analysisSnapshot.snapshotId);
  assert.equal((await app.read(query)).complete, true);
  app.advance(1000);
  await assert.rejects(app.read(query), error => error.status === 410);
  assert.equal(app.reads.filter(read => read.action === 'analysis').length, 2);
  assert.equal(app.requests.filter(call => call.path.startsWith(DETAIL)).length, 2, 'expiry is rejected before another detail request');
});

test('scoped reports create fresh snapshots after expiry without waiting for fourteen seconds', async t => {
  const app = fixture(t, { config: { vision: { mes: { analysisSnapshotTtlMs: 1000 } } } });
  const first = await app.read(reportQuery()); app.advance(1000);
  const refreshed = await app.read(reportQuery());
  assert.notEqual(refreshed.analysisSnapshot.snapshotId, first.analysisSnapshot.snapshotId);
  assert.equal(Date.parse(refreshed.analysisSnapshot.expiresAt), NOW + 2000);
  assert.equal((await app.read(batchQuery(refreshed.analysisSnapshot.snapshotId))).complete, true);
  assert.equal(app.reads.filter(read => read.action === 'report').length, 2);
});

test('report refresh also replaces an LRU-evicted snapshot whose advertised expiry is still in the future', async t => {
  const app = fixture(t, { config: { vision: { mes: { analysisMaxSnapshots: 1 } } } });
  const first = await app.read(reportQuery());
  await app.read(reportQuery({ end: '2026-02-03T12:00' }));
  await assert.rejects(app.read(batchQuery(first.analysisSnapshot.snapshotId)), error => error.status === 404);
  const refreshed = await app.read(reportQuery());
  assert.notEqual(refreshed.analysisSnapshot.snapshotId, first.analysisSnapshot.snapshotId);
  assert.equal((await app.read(batchQuery(refreshed.analysisSnapshot.snapshotId))).complete, true);
});

test('fresh snapshot reads retain in-flight sharing for reports and batches but never share between viewer scopes', async t => {
  let heldAction = 'report'; const started = gate(), release = gate();
  const app = fixture(t, { onRead: async query => {
    if (query.action === heldAction) { started.resolve(); await release.promise; }
  } });
  const first = app.read(reportQuery()), second = app.read(reportQuery());
  await started.promise; release.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.analysisSnapshot.snapshotId, b.analysisSnapshot.snapshotId);
  assert.equal(app.reads.filter(read => read.action === 'report').length, 1);
  heldAction = null;
  const query = batchQuery(a.analysisSnapshot.snapshotId);
  const [batchA, batchB] = await Promise.all([app.read(query), app.read(query)]);
  assert.deepEqual(batchA, batchB);
  assert.equal(app.reads.filter(read => read.action === 'analysis').length, 1);
  await assert.rejects(app.read({ ...query, _viewerScope: 'synthetic_portal_session_B' }), error => error.status === 404);
  assert.equal(app.reads.filter(read => read.action === 'analysis').length, 2);
});

test('fresh analysis results remain blocked if data-source settings change while the request is pending', async t => {
  const started = gate(), release = gate();
  const app = fixture(t, { onCall: async path => {
    if (path === DETAIL + '1') { started.resolve(); await release.promise; }
  } });
  const report = await app.read(reportQuery());
  const pending = app.read(batchQuery(report.analysisSnapshot.snapshotId)); pending.catch(() => {});
  await started.promise;
  await app.service.configure({ username: 'synthetic-replacement', password: 'synthetic-replacement-password' });
  release.resolve();
  await assert.rejects(pending, error => error.status === 428);
  await assert.rejects(app.read(batchQuery(report.analysisSnapshot.snapshotId)), error => error.status === 404);
});

test('catalog and legacy reports without snapshot capabilities retain the established short result cache', async t => {
  const app = fixture(t), catalog = { action: 'catalog' }, unscoped = reportQuery(); delete unscoped._viewerScope;
  const first = await app.read(unscoped);
  assert.equal(first.analysisSnapshot.available, false);
  await app.read(unscoped); await app.read(catalog); await app.read(catalog);
  assert.equal(app.reads.length, 2);
  app.advance(14001); await app.read(unscoped); await app.read(catalog);
  assert.equal(app.reads.length, 4);
});
