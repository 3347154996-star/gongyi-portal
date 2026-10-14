'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createInventoryConnector } = require('../lib/inventory-source.cjs');
const { createSource } = require('../lib/source.cjs');
const { createAutoSource } = require('../lib/auto-source.cjs');

const ACTOR = { account: '000123', name: '合成测试成员', role: 'member' };
const OPERATION = {
  item: { id: 'item-001', bjbh: '000456', bjmc: '合成测试备件', specifications: 'MODEL-A', unit: '个', location: 'A-01' },
  actor: ACTOR, quantity: 2, beforeStock: 8, requestId: 'synthetic-request-001', reason: '合成测试'
};
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function verifiedContract(overrides = {}) {
  return { verified: true, atomicStockCheck: true, verificationNote: 'synthetic test contract only', path: '/api/Mold_SparepartsOutStock', method: 'POST',
    fields: { itemId: 'pid', quantity: 'outNumber', beforeStock: 'expectedStock', operatorAccount: 'operatorCode', operatorName: 'outPeople', requestId: 'businessRequestId', code: 'bjbh', reason: 'remark' },
    staticFields: { outType: 1 }, receiptField: 'data.documentId', ...overrides };
}
function fixture(t, { scope, allRows, fetchImpl, config = {} } = {}) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'portal-inventory-source-test-'));
  t.after(() => {
    if (path.dirname(root) !== temporaryRoot || !path.basename(root).startsWith('portal-inventory-source-test-')) throw new Error('Unexpected temporary cleanup path');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const scopeFile = path.join(root, 'scope.json');
  if (scope !== undefined) fs.writeFileSync(scopeFile, typeof scope === 'string' ? scope : JSON.stringify(scope));
  const calls = { rows: [], fetch: [] };
  const resolvedConfig = { apiBase: 'https://inventory.example.invalid/', inventoryScopePath: scopeFile, ...config };
  const connector = createInventoryConnector(resolvedConfig, {
    allRows: async (...args) => { calls.rows.push(args); return allRows ? allRows(...args) : { rows: [], total: 0, complete: true }; },
    fetchImpl: async (...args) => { calls.fetch.push(args); return fetchImpl ? fetchImpl(...args) : response({ code: 0, data: { documentId: 'SYNTHETIC-DOC-001' } }); }
  });
  return { connector, calls, config: resolvedConfig, scopeFile };
}

test('missing scope yields an explicitly unconfigured empty catalog without fetching all company materials', async t => {
  const { connector, calls } = fixture(t);
  const result = await connector.inventoryCatalog({}, { token: 'synthetic-token' });
  assert.deepEqual(result.rows, []);
  assert.equal(result.scopeConfigured, false);
  assert.equal(result.complete, false);
  assert.equal(calls.rows.length, 0);
});

test('damaged, empty, or unidentified scope cannot silently broaden to all Mold materials', async t => {
  for (const scope of ['{broken', {}, { records: [] }, { records: [null] }, { records: [{}] }]) {
    const { connector, calls } = fixture(t, { scope });
    await assert.rejects(connector.inventoryCatalog({}, { token: 'synthetic-token' }), error => error.status === 503 && !error.message.includes('synthetic-token'));
    assert.equal(calls.rows.length, 0);
  }
});

test('name-only scope entries remain unmatched and never authorize same-name company materials', async t => {
  const { connector } = fixture(t, { scope: { records: [{ name: 'only name' }] }, allRows: async () => ({ rows: [{ id: 'A', bjbh: 'OTHER', bjmc: 'only name', specifications: 'MODEL' }], complete: true }) });
  const result = await connector.inventoryCatalog({}, { token: 'synthetic-token' });
  assert.deepEqual(result.rows, []);
  assert.equal(result.unmatched.length, 1);
  assert.equal(result.unmatched[0].name, 'only name');
});

test('scope keeps textual leading zeroes and duplicate company records remain separate', async t => {
  const rows = [
    { id: 'A', bjbh: '000456', specifications: 'MODEL-A', nowStock: 3 },
    { id: 'B', bjbh: '000456', specifications: 'MODEL-A', nowStock: 5 },
    { id: 'C', bjbh: '456', specifications: 'MODEL-A', nowStock: 9 },
    { id: 'D', bjbh: 'OTHER', specifications: 'MODEL-X', nowStock: 7 }
  ];
  const { connector, calls } = fixture(t, { scope: { records: [{ code: '000456', name: 'test', specification: 'MODEL-A' }] }, allRows: async () => ({ rows, complete: true, total: rows.length }) });
  const result = await connector.inventoryCatalog({ fresh: true }, { token: 'synthetic-token' });
  assert.deepEqual(result.rows.map(row => row.id), ['A', 'B']);
  assert.equal(result.rows[0].bjbh, '000456');
  assert.equal(result.rows[0].nowStock, 3);
  assert.equal(result.rows[1].nowStock, 5);
  assert.equal(calls.rows[0][0], 'spares');
  assert.deepEqual(calls.rows[0][1], {});
});

test('only scope entries without codes fall back to exact model matching; no name or substring match', async t => {
  const rows = [
    { id: 'A', bjbh: 'other1', specifications: 'MODEL-A', bjmc: 'test' },
    { id: 'B', bjbh: 'other2', specifications: 'MODEL-A-LONG', bjmc: 'test' },
    { id: 'C', bjbh: 'other3', specifications: 'MODEL-B', bjmc: 'test' },
    { id: 'D', bjbh: 'other4', specifications: 'model-a', bjmc: 'test' }
  ];
  const { connector } = fixture(t, { scope: { records: [
    { code: '', name: 'test', specification: 'MODEL-A' },
    { code: 'MISSING-CODE', name: 'test', specification: 'MODEL-B' }
  ] }, allRows: async () => ({ rows, complete: true, total: rows.length }) });
  const result = await connector.inventoryCatalog({}, { token: 'synthetic-token' });
  assert.deepEqual(result.rows.map(row => row.id), ['A']);
  assert.equal(result.unmatched.length, 1);
  assert.equal(result.unmatched[0].code, 'MISSING-CODE');
});

test('catalog fetches fresh upstream data instead of the ordinary source read cache', async t => {
  const { config } = fixture(t, { scope: { records: [{ code: '000456', name: 'test', specification: '' }] } });
  let stock = 8, requests = 0;
  const source = createSource(config, async url => {
    assert.equal(url.pathname, '/api/Mold_SparepartsDetailed');
    requests++;
    return response({ code: 0, total: 1, data: [{ id: 'A', bjbh: '000456', bjmc: '测试定位销', specifications: 'MODEL-A', nowStock: stock }] });
  });
  const session = { token: 'synthetic-token' };
  const query = { start: '2026-10-01', end: '2026-10-01', page: 1, size: 50, category: 'all', stock: 'all', keyword: '' };
  assert.equal((await source.read('spares', query, session)).rows[0].nowStock, 8);
  stock = 6;
  assert.equal((await source.read('spares', query, session)).rows[0].nowStock, 8);
  assert.equal((await source.inventoryCatalog({ fresh: true }, session)).rows[0].nowStock, 6);
  stock = 4;
  assert.equal((await source.inventoryCatalog({ fresh: true }, session)).rows[0].nowStock, 4);
  assert.equal(requests, 3);
});

test('real source rejects a read crossed by an inventory write and the next read fetches fresh stock', async t => {
  const { config } = fixture(t, { scope: { records: [{ code: '000456', name: 'test', specification: '' }] }, config: { loginToken: '', inventoryWrites: { outbound: verifiedContract() } } });
  let reads = 0, writes = 0, entered, release;
  const enteredGate = new Promise(resolve => { entered = resolve; });
  const releaseGate = new Promise(resolve => { release = resolve; });
  const source = createSource(config, async (url, options) => {
    if (url.pathname === '/api/User_Login') return response({ code: 0, data: { token: 'synthetic-business-token' } });
    if (url.pathname === '/api/Mold_SparepartsOutStock') {
      writes++;
      assert.equal(JSON.parse(options.body).expectedStock, 8);
      return response({ code: 0, data: { documentId: 'SYNTHETIC-DOC' } });
    }
    assert.equal(url.pathname, '/api/Mold_SparepartsDetailed');
    const count = ++reads;
    if (count === 1) { entered(); await releaseGate; }
    return response({ code: 0, total: 1, data: [{ id: 'item-001', bjbh: '000456', bjmc: '测试定位销', specifications: 'MODEL-A', nowStock: count === 1 ? 8 : 6 }] });
  });
  const service = createAutoSource({ source, credentialStore: { load: async () => ({ username: 'synthetic-user', password: 'synthetic-password' }) } });
  t.after(() => service.stop());
  const query = { start: '2026-10-01', end: '2026-10-01', page: 1, size: 50, category: 'all', stock: 'all', keyword: '' };
  const oldRead = service.read('spares', query);
  oldRead.catch(() => {});
  await enteredGate;
  try { assert.deepEqual(await service.inventoryWrite('outbound', OPERATION), { receiptId: 'SYNTHETIC-DOC' }); }
  finally { release(); }
  await assert.rejects(oldRead, error => error.status === 409);
  assert.equal((await service.read('spares', query)).rows[0].nowStock, 6);
  assert.equal(reads, 2);
  assert.equal(writes, 1);
});

test('writes are disabled by default and incomplete verified contracts remain disabled', async t => {
  const variants = [undefined, {}, verifiedContract({ verified: false }), verifiedContract({ verificationNote: '' }),
    verifiedContract({ fields: { itemId: 'pid', quantity: 'outNumber' } }),
    verifiedContract({ fields: { ...verifiedContract().fields, requestId: 'operatorCode' } }),
    verifiedContract({ staticFields: { outPeople: 'forged operator' } }),
    verifiedContract({ method: 'GET' }), verifiedContract({ receiptField: '' })];
  for (const contract of variants) {
    const { connector, calls } = fixture(t, { config: { inventoryWrites: { outbound: contract } } });
    assert.equal(connector.inventoryCapabilities().outbound.enabled, false);
    await assert.rejects(connector.inventoryWrite('outbound', OPERATION, { token: 'synthetic-token' }), error => error.status === 503);
    assert.equal(calls.fetch.length, 0);
  }
});

test('verified paths cannot switch to UDP, another domain, relative traversal, or an unrecognized API', async t => {
  for (const unsafePath of ['/api/UDP_SparepartsOutStock', 'https://other.example.invalid/api/Mold_X', '//other.example.invalid/api/Mold_X', '/api/Mold_X/../UDP_X', '/api/Mold_X?target=UDP', '/admin/users']) {
    const { connector, calls } = fixture(t, { config: { inventoryWrites: { outbound: verifiedContract({ path: unsafePath }) } } });
    assert.equal(connector.inventoryCapabilities().outbound.enabled, false);
    await assert.rejects(connector.inventoryWrite('outbound', OPERATION, { token: 'synthetic-token' }));
    assert.equal(calls.fetch.length, 0);
  }
});

test('adjustment contracts require actual quantity plus the checked pre-adjustment stock', t => {
  const fields = { itemId: 'pid', operatorAccount: 'operatorCode', operatorName: 'operatorName', requestId: 'requestId', actualQuantity: 'actual' };
  const { connector } = fixture(t, { config: { inventoryWrites: { adjust: verifiedContract({ fields }) } } });
  assert.equal(connector.inventoryCapabilities().adjust.enabled, false);
  const configured = fixture(t, { config: { inventoryWrites: { adjust: verifiedContract({ fields: { ...fields, beforeStock: 'expectedStock' } }) } } });
  assert.equal(configured.connector.inventoryCapabilities().adjust.enabled, true);
});

test('outbound and adjustment remain disabled without an explicit atomic stock check and expected-stock field', async t => {
  for (const kind of ['outbound', 'adjust']) {
    const fields = { ...verifiedContract().fields };
    if (kind === 'adjust') { delete fields.quantity; fields.actualQuantity = 'actualQuantity'; }
    const noExpectedStock = { ...fields }; delete noExpectedStock.beforeStock;
    for (const overrides of [{ atomicStockCheck: undefined }, { atomicStockCheck: false }, { atomicStockCheck: 'true' }, { fields: noExpectedStock }]) {
      const { connector, calls } = fixture(t, { config: { inventoryWrites: { [kind]: verifiedContract({ fields, ...overrides }) } } });
      assert.equal(connector.inventoryCapabilities()[kind].enabled, false);
      await assert.rejects(connector.inventoryWrite(kind, { ...OPERATION, actualQuantity: 6 }, { token: 'synthetic-token' }), error => error.status === 503);
      assert.equal(calls.fetch.length, 0);
    }
  }
});

test('a verified inbound increment contract does not require expected-stock comparison', t => {
  const fields = { ...verifiedContract().fields }; delete fields.beforeStock;
  const { connector } = fixture(t, { config: { inventoryWrites: { inbound: verifiedContract({ path: '/api/Mold_SparepartsInStock', fields, atomicStockCheck: undefined }) } } });
  assert.equal(connector.inventoryCapabilities().inbound.enabled, true);
});

test('verified write maps server actor and request id once, ignores extraneous forged identity, and requires receipt', async t => {
  const { connector, calls } = fixture(t, { config: { tenantId: 'synthetic-tenant', inventoryWrites: { outbound: verifiedContract() } } });
  const session = { token: 'synthetic-token', sourceCache: new Map([['old', 1]]), sourcePending: new Map([['old', 1]]) };
  const result = await connector.inventoryWrite('outbound', { ...OPERATION, operatorAccount: 'forged', outPeople: 'forged', payload: { operatorCode: 'forged' } }, session);
  assert.deepEqual(result, { receiptId: 'SYNTHETIC-DOC-001' });
  assert.equal(calls.fetch.length, 1);
  const [url, options] = calls.fetch[0];
  assert.equal(url.origin, 'https://inventory.example.invalid');
  assert.equal(url.pathname, '/api/Mold_SparepartsOutStock');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
  assert.equal(options.headers['TENANT-ID'], 'synthetic-tenant');
  assert.deepEqual(JSON.parse(options.body), { outType: 1, pid: 'item-001', outNumber: 2, expectedStock: 8, operatorCode: '000123', outPeople: '合成测试成员', businessRequestId: 'synthetic-request-001', bjbh: '000456', remark: '合成测试' });
  assert.equal(session.sourceCache.size, 0);
  assert.equal(session.sourcePending.size, 0);
});

test('explicit rejection and HTTP 401/403 are distinct from uncertain upstream outcomes', async t => {
  for (const [upstream, expected] of [[response({ code: 12, message: 'synthetic-token' }), 422], [response({ message: 'synthetic-token' }, 401), 401], [response({ message: 'synthetic-token' }, 403), 403]]) {
    const { connector, calls } = fixture(t, { config: { inventoryWrites: { outbound: verifiedContract() } }, fetchImpl: async () => upstream });
    await assert.rejects(connector.inventoryWrite('outbound', OPERATION, { token: 'synthetic-token' }), error => {
      assert.equal(error.status, expected);
      assert.notEqual(error.outcome, 'unknown');
      assert.equal(error.message.includes('synthetic-token'), false);
      return true;
    });
    assert.equal(calls.fetch.length, 1);
  }
});

test('timeout, 5xx, invalid JSON, absent success marker or receipt, and null reply never report success', async t => {
  const variants = [
    async () => { throw new Error('network error with synthetic-token'); },
    async () => response({ code: 0, data: { documentId: 'not-trusted' } }, 500),
    async () => ({ ok: true, status: 200, json: async () => { throw new Error('synthetic-token'); } }),
    async () => response({ data: { documentId: 'not-trusted' } }),
    async () => response({ code: 0, data: {} }),
    async () => response({ code: 0, data: { documentId: ' ' } }),
    async () => response(null)
  ];
  for (const fetchImpl of variants) {
    const { connector, calls } = fixture(t, { config: { inventoryWrites: { outbound: verifiedContract() } }, fetchImpl });
    await assert.rejects(connector.inventoryWrite('outbound', OPERATION, { token: 'synthetic-token' }), error => {
      assert.equal(error.status, 503);
      assert.equal(error.outcome, 'unknown');
      assert.equal(error.message.includes('synthetic-token'), false);
      return true;
    });
    assert.equal(calls.fetch.length, 1);
  }
});

test('scope file errors and missing company sessions expose no internal paths or secret values', async t => {
  const { connector, calls, scopeFile } = fixture(t, { scope: '{broken-secret-value', config: { inventoryWrites: { outbound: verifiedContract() } } });
  await assert.rejects(connector.inventoryCatalog({}, { token: 'synthetic-token' }), error => !error.message.includes(scopeFile) && !error.message.includes('broken-secret-value'));
  await assert.rejects(connector.inventoryWrite('outbound', OPERATION, {}), error => error.status === 428);
  assert.equal(calls.fetch.length, 0);
});
