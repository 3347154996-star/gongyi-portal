'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { createPortal } = require('../server.cjs');
const { makeAdminConfig } = require('../lib/admin.cjs');
const { createVisionService } = require('../lib/vision.cjs');
const password = 'synthetic-catalog-password-2026';
const draft = { deviceId: 'rear-synthetic-02', name: '合成后副检具', lineName: '合成后副线', transport: 'share', sourcePath: 'D:\\SyntheticOnly\\rear.json', partNames: ['Synthetic_RearA'], measurementCount: 42, notes: '仅登记合成测试，未接入采集\n第二行：等待格式适配\n\n第四行：待验收' };

async function fixture(t) {
  const tempBase = path.resolve(os.tmpdir()), root = await fs.mkdtemp(path.join(tempBase, 'gongyi-server-vision-catalog-'));
  const calls = { catalog: 0, save: [], source: 0, credentials: 0 };
  const vision = createVisionService({ root });
  const visionService = { ...vision, async catalog() { calls.catalog++; return vision.catalog(); }, async saveDraft(input) { calls.save.push(structuredClone(input)); return vision.saveDraft(input); } };
  const autoSource = { start() {}, stop() {}, status() { return { state: 'unconfigured' }; }, async read() { calls.source++; throw Error('Catalog must not read company data'); } };
  const credentialStore = { async load() { calls.credentials++; throw Error('Catalog must not load company credentials'); } };
  let server;
  t.after(async () => {
    if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    const resolved = path.resolve(root); assert.equal(path.dirname(resolved), tempBase); assert.ok(path.basename(resolved).startsWith('gongyi-server-vision-catalog-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  server = createPortal({ root, config: { admin: makeAdminConfig('00001', password) }, source: {}, autoSource, credentialStore, inventoryService: { async capabilities() { return {}; } }, visionService });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(method, route, data, cookie, headers = {}) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function login(account) { const result = await request('POST', '/local/login', { username: account, password }); assert.equal(result.status, 200); return result.cookie; }
  const admin = await login('00001');
  for (const [account, role] of [['00002', 'member'], ['00003', 'reviewer']]) assert.equal((await request('POST', '/local/members', { account, name: `合成${role}`, role, active: true, password, createOnly: true }, admin)).status, 200);
  return { request, login, admin, member: await login('00002'), reviewer: await login('00003'), calls, visionService, root };
}

test('catalog requires authentication and only administrators may save drafts', async t => {
  const app = await fixture(t);
  for (const [method, body] of [['GET', undefined], ['POST', draft]]) assert.equal((await app.request(method, '/local/vision/catalog', body)).status, 401);
  assert.equal(app.calls.catalog, 0); assert.equal(app.calls.save.length, 0);
  for (const cookie of [app.member, app.reviewer]) {
    const read = await app.request('GET', '/local/vision/catalog', undefined, cookie);
    assert.equal(read.status, 200); assert.equal(read.body.devices.find(row => row.id === 'vision-01').status, 'configured');
    assert.equal((await app.request('POST', '/local/vision/catalog', draft, cookie)).status, 403);
  }
  assert.equal(app.calls.catalog, 2); assert.equal(app.calls.save.length, 0);
  assert.equal(app.calls.source, 0); assert.equal(app.calls.credentials, 0);
});

test('administrator draft persists as pending and can be edited without activating collection', async t => {
  const app = await fixture(t);
  const saved = await app.request('POST', '/local/vision/catalog', draft, app.admin);
  assert.equal(saved.status, 200); assert.deepEqual(app.calls.save, [draft]);
  let catalog = (await app.request('GET', '/local/vision/catalog', undefined, app.admin)).body;
  const pending = catalog.devices.find(row => row.id === draft.deviceId);
  assert.ok(pending); assert.equal(pending.status, 'pending'); assert.equal(pending.lineName, draft.lineName); assert.equal(pending.measurementCount, 42);
  assert.equal(saved.body.device.notes, draft.notes); assert.equal(pending.notes, draft.notes);
  assert.ok(catalog.lines.some(line => line.id === pending.lineId && line.name === draft.lineName));
  assert.equal(Object.hasOwn(catalog.devices.find(row => row.id === 'vision-01'), 'sourcePath'), false, 'Configured source path is not exposed.');
  const edit = { ...draft, lineId: pending.lineId, name: '合成后副检具（修订）', notes: '修订登记，仍未接入\n第二行：共享地址待确认' }; delete edit.lineName;
  assert.equal((await app.request('POST', '/local/vision/catalog', edit, app.admin)).status, 200);
  catalog = await createVisionService({ root: app.root }).catalog();
  assert.equal(catalog.devices.filter(row => row.id === draft.deviceId).length, 1);
  assert.equal(catalog.devices.find(row => row.id === draft.deviceId).name, edit.name);
  assert.equal(catalog.devices.find(row => row.id === draft.deviceId).status, 'pending');
  assert.equal(catalog.devices.find(row => row.id === draft.deviceId).notes, edit.notes);
  const report = await app.request('GET', '/local/vision/report?' + new URLSearchParams({ lineId: pending.lineId, deviceId: pending.id }), undefined, app.member);
  assert.equal(report.status, 200); assert.equal(report.body.source.state, 'pending'); assert.equal(report.body.total, 0); assert.deepEqual(report.body.trend.points, []);
  assert.equal(app.calls.source, 0); assert.equal(app.calls.credentials, 0);
});

test('configured vision-01 cannot be overwritten by a pending draft', async t => {
  const app = await fixture(t), before = (await app.request('GET', '/local/vision/catalog', undefined, app.admin)).body;
  const result = await app.request('POST', '/local/vision/catalog', { ...draft, deviceId: 'vision-01' }, app.admin);
  assert.equal(result.status, 409);
  const after = (await app.request('GET', '/local/vision/catalog', undefined, app.admin)).body;
  assert.deepEqual(after.devices.find(row => row.id === 'vision-01'), before.devices.find(row => row.id === 'vision-01'));
  assert.equal(after.devices.length, before.devices.length);
  assert.deepEqual(after.lines, before.lines, 'A rejected override must not create an orphan line.');
});

test('foreign-origin and cross-site catalog requests are rejected before calling the service', async t => {
  const app = await fixture(t);
  for (const headers of [{ Origin: 'https://foreign-origin.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    for (const [method, body] of [['GET', undefined], ['POST', draft]]) assert.equal((await app.request(method, '/local/vision/catalog', body, app.admin, headers)).status, 403);
  }
  assert.equal(app.calls.catalog, 0); assert.equal(app.calls.save.length, 0); assert.equal(app.calls.source, 0); assert.equal(app.calls.credentials, 0);
});

test('a catalog read completing after logout cannot return the private catalog', async t => {
  const app = await fixture(t);
  let began, finish;
  const started = new Promise(resolve => { began = resolve; }), gate = new Promise(resolve => { finish = resolve; });
  app.visionService.catalog = async () => { began(); await gate; return { lines: [{ id: 'private-line' }], devices: [] }; };
  const pending = app.request('GET', '/local/vision/catalog', undefined, app.member);
  await started;
  try { assert.equal((await app.request('POST', '/local/logout', {}, app.member)).status, 200); } finally { finish(); }
  const response = await pending;
  assert.equal(response.status, 401); assert.equal(response.body.lines, undefined);
});
