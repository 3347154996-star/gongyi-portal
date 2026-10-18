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


test('retired file catalog cannot be read or modified by any portal role',async t=>{
  const app=await fixture(t);
  const before=await app.visionService.catalog();
  for(const [method,body] of [['GET',undefined],['POST',draft]]){
    assert.equal((await app.request(method,'/local/vision/catalog',body)).status,401);
    for(const cookie of [app.admin,app.member,app.reviewer]){
      const response=await app.request(method,'/local/vision/catalog',body,cookie);
      assert.equal(response.status,410);assert.match(response.body.message,/公司系统/);
    }
  }
  assert.deepEqual(await app.visionService.catalog(),before);
  assert.equal(app.calls.catalog,2);assert.deepEqual(app.calls.save,[]);
});
test('retired file catalog rejects cross-site access before any service call',async t=>{
  const app=await fixture(t);
  for(const headers of [{Origin:'https://foreign.invalid'},{'Sec-Fetch-Site':'cross-site'}]){
    for(const [method,body] of [['GET',undefined],['POST',draft]])assert.equal((await app.request(method,'/local/vision/catalog',body,app.admin,headers)).status,403);
  }
  assert.deepEqual(app.calls,{catalog:0,save:[],source:0,credentials:0});
});
