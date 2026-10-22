'use strict';

// Only the portal loopback listener uses HTTP. All upstream calls are synthetic.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPortal } = require('../server.cjs');
const { createSource } = require('../lib/source.cjs');
const { makeAdminConfig } = require('../lib/admin.cjs');

const password = 'synthetic-migration-password';
const reportRoute = '/local/vision/mes/report?' + new URLSearchParams({
  queryMode: 'time', lineId: '11', start: '2026-02-03T00:00', end: '2026-02-03T23:59',
});

async function fixture(t, { override = false, failure, total = 2 } = {}) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'gongyi-mes-migration-'));
  const privateFiles = [
    'runtime/vision-input.json', 'runtime/legacy-config.json', 'runtime/legacy-override.json',
    'runtime/vision/records.json', 'runtime/vision/catalog.json',
  ].map(file => path.join(root, file));
  const originals = new Map();
  // Opaque historical bytes deliberately need no conversion for an MES migration.
  for (const file of privateFiles) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = Buffer.from('synthetic historical archive: ' + path.basename(file));
    fs.writeFileSync(file, bytes);
    originals.set(file, bytes);
  }
  const originalOverride = process.env.PORTAL_VISION_DATA_FILE;
  if (override) process.env.PORTAL_VISION_DATA_FILE = privateFiles[2];
  else delete process.env.PORTAL_VISION_DATA_FILE;
  let server;
  t.after(async () => {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    if (originalOverride === undefined) delete process.env.PORTAL_VISION_DATA_FILE;
    else process.env.PORTAL_VISION_DATA_FILE = originalOverride;
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('gongyi-mes-migration-'));
    await fs.promises.rm(resolved, { recursive: true, force: true });
  });
  const legacyReads = [];
  const originalRead = fs.readFileSync.bind(fs);
  for (const [target, methods] of [[fs, ['readFileSync', 'statSync']], [fs.promises, ['readFile', 'stat']]]) {
    for (const method of methods) {
      const original = target[method].bind(target);
      t.mock.method(target, method, function (file, ...args) {
        if (typeof file === 'string' && originals.has(path.resolve(file))) legacyReads.push({ method, file });
        return original(file, ...args);
      });
    }
  }
  const calls = [], unexpected = [];
  const config = {
    apiBase: 'https://synthetic-migration.invalid', loginToken: '',
    admin: makeAdminConfig('00001', password), privacy: { productNames: 'original' },
    vision: { dataFile: privateFiles[1], pollIntervalSeconds: 5, mes: { defaultLineId: '11' } },
  };
  const rows = [
    { id: 2, barCode: 'SYNTHETIC-RETEST', endTime: '2026-02-03T10:01:00+08:00', type: 'OK' },
    { id: 1, barCode: 'SYNTHETIC-RETEST', endTime: '2026-02-03T10:00:00+08:00', type: 'NG' },
  ].map(row => ({ ...row, productLineCode: 'CX_TEST', productLineName: '合成尺寸线',
    gxCode: 'PROCESS_TEST', gxName: '合成尺寸检测', equipmentCode: 'DEVICE_TEST',
    equipmentName: '合成检具', itemCode: 'PART_TEST', itemName: '合成零件' }));
  const source = createSource(config, async (url, options) => {
    const call = `${options.method} ${url.pathname}`;
    calls.push(call);
    const allowed = ['POST /api/User_Login', 'GET /api/Cx/select', 'GET /api/ProcessReport',
      'GET /api/ProcessReport/detail/1', 'GET /api/ProcessReport/detail/2'];
    if (url.origin !== config.apiBase || !allowed.includes(call)) {
      unexpected.push(call);
      throw new Error('Unexpected upstream call');
    }
    if (failure?.path === url.pathname) {
      if (failure.timeout) throw new Error('synthetic timeout');
      return { ok: false, status: failure.status };
    }
    const json = url.pathname === '/api/User_Login' ? { code: 0, data: { token: 'synthetic-migration-token' } }
      : url.pathname === '/api/Cx/select' ? { code: 0, data: [{ value: 11, label: 'CX_TEST-合成尺寸线' }] }
      : url.pathname === '/api/ProcessReport' ? { code: 0, total, data: rows }
      : { code: 0, data: [{ param_Name: '合成测点', key: 'point-test', param_UP: '1', param_DOWN: '-1', value: '0.2', result: 'OK' }] };
    return { ok: true, status: 200, json: async () => structuredClone(json) };
  });
  server = createPortal({ root, config, source,
    credentialStore: { async load() { return { username: 'synthetic-source-user', password: 'synthetic-source-password' }; } },
    inventoryService: { async capabilities() { return {}; } },
    penetrationService: { start() {}, stop() {} },
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  async function request(route, { method = 'GET', body } = {}) {
    const response = await fetch(base + route, { method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await request('/local/login', { method: 'POST', body: { username: '00001', password } })).status, 200);
  function assertPreserved() {
    assert.deepEqual(legacyReads, [], 'current deployment must not open historical collector files');
    for (const [file, bytes] of originals) assert.deepEqual(originalRead(file), bytes, 'historical bytes must be preserved');
    assert.deepEqual(unexpected, [], 'only login and the allowlisted MES reads may be attempted');
  }
  return { request, calls, assertPreserved };
}

test('migrated file settings and environment overrides cannot enable the retired source', async t => {
  for (const override of [false, true]) await t.test(`environment override ${override}`, async t => {
    const app = await fixture(t, { override });
    assert.equal((await app.request('/local/vision/mes/catalog')).status, 200);
    const report = await app.request(reportRoute);
    assert.equal(report.status, 200);
    assert.equal(report.body.sourceType, 'ProcessReport');
    assert.equal(report.body.coverage.complete, true);
    assert.deepEqual(report.body.records.map(row => row.recordId), ['2', '1']);
    assert.equal(report.body.summary.total, 2, 'same SN retests remain separate records');
    assert.equal(report.body.summary.passRate, 50);
    const detail = await app.request('/local/vision/mes/detail?recordId=2');
    assert.equal(detail.status, 200);
    assert.equal(detail.body.measurements.length, 1);
    const before = [...app.calls];
    for (const route of ['/local/vision/report', '/local/vision/catalog', '/local/vision/import', '/local/vision/records', '/local/vision/records/synthetic']) {
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        assert.equal((await app.request(route, { method, ...(method === 'POST' ? { body: {} } : {}) })).status, 410);
      }
    }
    assert.deepEqual(app.calls, before, 'retired endpoints must never call the company source');
    app.assertPreserved();
  });
});

test('successful company login does not prove MES catalog permission or allow file fallback', async t => {
  const app = await fixture(t, { override: true, failure: { path: '/api/Cx/select', status: 403 } });
  const result = await app.request('/local/vision/mes/catalog');
  assert.equal(result.status, 403);
  assert.equal(result.body.records, undefined);
  assert.equal((await app.request('/local/status')).body.connected, true);
  app.assertPreserved();
});

test('MES read failure cannot fall back to preserved collector history', async t => {
  const app = await fixture(t, { failure: { path: '/api/ProcessReport', timeout: true } });
  const result = await app.request(reportRoute);
  assert.equal(result.status, 504);
  assert.equal(result.body.records, undefined);
  app.assertPreserved();
});

test('HTTP 200 with incomplete MES coverage cannot pass migration data acceptance', async t => {
  const app = await fixture(t, { total: 3 });
  const result = await app.request(reportRoute);
  assert.equal(result.status, 200);
  assert.equal(result.body.coverage.complete, false);
  assert.equal(result.body.coverage.eligibleForLineRate, false);
  assert.equal(result.body.summary.passRate, null);
  assert.equal(result.body.analysisSnapshot.available, false);
  assert.equal(result.body.records.length, 2);
  app.assertPreserved();
});
