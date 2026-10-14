'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createInventoryService } = require('../lib/inventory.cjs');

const member = { account: 'worker-1', name: '张工', role: 'member' };
const reviewer = { account: 'reviewer-1', name: '李工', role: 'reviewer' };
const admin = { account: 'admin-1', name: '管理员', role: 'admin' };
const row = (id = 'item-1', extra = {}) => ({ id, bjbh: 'SYNTHETIC-PART-001', bjmc: '定位销', specifications: '后副OP55-01-02', location: 'L-8-2', unit: '件', nowStock: 10, BarCode: 'SYNTHETIC-PART-001', ...extra });
const input = (extra = {}) => ({ kind: 'outbound', itemId: 'item-1', quantity: 2, expectedStock: 10, requestId: 'request-0001', remark: '维修领用', ...extra });
const countInput = (extra = {}) => ({ itemId: 'item-1', actualQuantity: 8, expectedStock: 10, requestId: 'count-000001', remark: '现场实盘', ...extra });
const errorCode = (code, status) => error => { assert.equal(error.code, code); if (status) assert.equal(error.status, status); return true; };

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-service-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = { rows: options.rows || [row()], complete: true, calls: [], reads: 0,
    capabilities: { inbound: { enabled: true }, outbound: { enabled: true }, adjust: { enabled: true } }, ...options };
  const source = {
    async inventoryCatalog(query) { assert.equal(query.fresh, true); data.reads++; if (data.readError) throw data.readError; return { rows: data.rows, complete: data.complete, fetchedAt: '2026-10-13T01:00:00.000Z', ...(data.metadata || {}) }; },
    inventoryCapabilities() { return data.capabilities; },
    async inventoryWrite(kind, args) {
      data.calls.push({ kind, args });
      if (data.write) return data.write(kind, args);
      const item = data.rows.find(entry => String(entry.id) === String(args.item.id));
      item.nowStock = kind === 'adjust' ? args.actualQuantity : kind === 'inbound' ? args.beforeStock + args.quantity : args.beforeStock - args.quantity;
      return { receiptId: 'source-receipt-' + data.calls.length, afterStock: item.nowStock };
    }
  };
  let clock = Date.UTC(2026, 9, 13);
  const service = createInventoryService({ root, source, now: () => clock++, authorizeActor: options.authorizeActor });
  return { root, source, data, service, filename: path.join(root, 'runtime', 'inventory.json') };
}

test('catalog preserves repeated material codes and disables missing/duplicate source IDs', async t => {
  const f = await fixture(t, { rows: [row(), row('item-2', { location: 'L-8-5', specifications: '后副OP55-05-12' }), row('', { bjbh: 'EMPTY', BarCode: 'EMPTY' }), row('dup'), row('dup'), row('bad-stock', { nowStock: '' })],
    metadata: { unmatched: [{ code: 'unknown', reason: '未找到' }], scopeConfigured: true, scopeCount: 9 } });
  const result = await f.service.catalog({ code: 'SYNTHETIC-PART-001' });
  assert.equal(result.items.length, 5);
  assert.deepEqual(result.items.map(item => item.selectable), [true, true, false, false, false]);
  assert.equal(result.items[0].code, result.items[1].code);
  assert.notEqual(result.items[0].id, result.items[1].id);
  assert.equal(result.scopeConfigured, true); assert.equal(result.scopeCount, 9); assert.equal(result.unmatched[0].code, 'unknown');
  assert.equal((await f.service.catalog({ search: 'L-8-5' })).items.length, 1);
  assert.equal((await f.service.catalog({ code: 'EMPTY' })).items[0].selectable, false);
  await assert.rejects(f.service.transact(input({ itemId: 'dup' }), member), errorCode('ambiguous_item', 409));
  assert.equal(f.data.calls.length, 0);
});

test('inbound/outbound write raw source identity and retain trusted actor and receipt', async t => {
  const f = await fixture(t, { rows: [row(123)] });
  const record = await f.service.transact(input({ kind: 'inbound', itemId: '123', quantity: 1.125, actor: admin }), member);
  assert.equal(record.status, 'applied'); assert.equal(record.type, 'inbound'); assert.equal(record.afterStock, 11.125);
  assert.equal(record.actor.account, member.account); assert.equal(record.actor.role, 'member');
  assert.equal(f.data.calls[0].args.item.id, 123); assert.equal(f.data.calls[0].args.item.bjbh, 'SYNTHETIC-PART-001');
  assert.equal(f.data.calls[0].args.actor.account, member.account);
  assert.equal(record.receiptId, 'source-receipt-1');
  assert.equal(record.confirmationMethod, 'receipt');
  const saved = JSON.parse(await fs.readFile(f.filename, 'utf8'));
  assert.equal(saved.records[0].status, 'applied');
  assert.equal(Object.values(saved.requests)[0].status, 'completed');
});

test('strict quantities reject coercion, excessive precision, unsafe magnitude and missing expected stock', async t => {
  const f = await fixture(t);
  for (const quantity of ['', ' 2 ', '1e3', true, null, Infinity, NaN, -1, 0, 0.0000001, '1.1234567', 9007199254740991]) {
    await assert.rejects(f.service.transact(input({ quantity }), member), errorCode('invalid_quantity', 400));
  }
  await assert.rejects(f.service.transact(input({ expectedStock: undefined }), member), errorCode('invalid_quantity', 400));
  for (const actualQuantity of ['', true, -1, '1.1234567']) await assert.rejects(f.service.count(countInput({ actualQuantity }), member), errorCode('invalid_quantity'));
  assert.equal(f.data.calls.length, 0);
  const result = await f.service.transact(input({ quantity: '0.000001' }), member);
  assert.equal(result.quantity, 0.000001);
});

test('fresh stock mismatch and insufficient outbound quantity reject without external effects', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.transact(input({ expectedStock: 9 }), member), errorCode('stale_stock', 409));
  await assert.rejects(f.service.transact(input({ quantity: 11 }), member), errorCode('insufficient_stock', 409));
  await assert.rejects(f.service.count(countInput({ expectedStock: 9 }), member), errorCode('stale_stock', 409));
  assert.equal(f.data.reads, 3); assert.equal(f.data.calls.length, 0);
});

test('incomplete/unavailable source blocks actions and incomplete catalog disables selection', async t => {
  const f = await fixture(t, { complete: false });
  assert.equal((await f.service.catalog()).items[0].selectable, false);
  await assert.rejects(f.service.transact(input(), member), errorCode('incomplete_catalog', 503));
  await assert.rejects(f.service.count(countInput(), member), errorCode('incomplete_catalog'));
  f.data.complete = true; f.data.readError = new Error('private source details');
  await assert.rejects(f.service.catalog(), error => { assert.equal(error.code, 'source_unavailable'); assert.doesNotMatch(error.message, /private/); return true; });
  assert.equal(f.data.calls.length, 0);
});

test('disabled capabilities perform no source write; count may remain pending or unchanged', async t => {
  const f = await fixture(t, { capabilities: { inbound: { enabled: false, reason: '未验证入库接口' }, outbound: { enabled: false }, adjust: { enabled: false } } });
  await assert.rejects(f.service.transact(input(), member), errorCode('capability_disabled', 503));
  const record = await f.service.count(countInput(), member);
  assert.equal(record.type, 'count'); assert.equal(record.status, 'pending'); assert.equal(record.difference, -2);
  await assert.rejects(f.service.review({ id: record.id, action: 'approve', requestId: 'review-00001' }, reviewer), errorCode('capability_disabled'));
  assert.equal((await f.service.list({}, member)).records[0].status, 'pending');
  const unchanged = await f.service.count(countInput({ actualQuantity: 10, requestId: 'count-000002' }), member);
  assert.equal(unchanged.status, 'unchanged');
  assert.equal(f.data.calls.length, 0);
});

test('same-account same-payload concurrent retries write once and survive service restart', async t => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([f.service.transact(input(), member), f.service.transact(input(), member)]);
  assert.deepEqual(first, second); assert.equal(f.data.calls.length, 1);
  const restarted = createInventoryService({ root: f.root, source: f.source });
  const repeated = await restarted.transact(input(), member);
  assert.deepEqual(first, repeated); assert.equal(f.data.calls.length, 1);
  await assert.rejects(restarted.transact(input({ quantity: 3 }), member), errorCode('idempotency_conflict', 409));
  await assert.rejects(restarted.count(countInput({ requestId: input().requestId }), member), errorCode('idempotency_conflict'));
});

test('idempotency is scoped to trusted account and parallel distinct requests recheck stock', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([
    f.service.transact(input(), member),
    f.service.transact(input({ requestId: 'request-0002' }), member)
  ]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].reason.code, 'stale_stock');
  const secondActor = { ...member, account: 'worker-2' };
  const second = await f.service.transact(input({ expectedStock: 8 }), secondActor);
  assert.equal(second.status, 'applied'); assert.equal(f.data.calls.length, 2);
});

test('authentication, roles and request IDs are enforced by the service', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.transact(input(), null), errorCode('authentication_required', 401));
  await assert.rejects(f.service.transact(input(), { ...member, role: 'viewer' }), errorCode('forbidden', 403));
  await assert.rejects(f.service.list({}, null), errorCode('authentication_required'));
  for (const requestId of ['short', '../path-00000', '<script>000', 'x'.repeat(101), null]) await assert.rejects(f.service.transact(input({ requestId }), member), errorCode('invalid_request_id'));
  const record = await f.service.count(countInput(), member);
  await assert.rejects(f.service.review({ id: record.id, action: 'approve', requestId: 'review-00001', actor: admin }, member), errorCode('review_forbidden', 403));
  assert.equal(f.data.calls.length, 0);
});

test('authorized review applies only confirmed adjustment and permits reviewer own count', async t => {
  const f = await fixture(t);
  const record = await f.service.count(countInput(), reviewer);
  assert.equal(f.data.calls.length, 0);
  const result = await f.service.review({ id: record.id, action: 'approve', requestId: 'review-00001', reason: '复点一致' }, reviewer);
  assert.equal(result.status, 'applied'); assert.equal(result.reviewer.account, reviewer.account);
  assert.equal(result.actualQuantity, 8); assert.equal(result.difference, -2);
  assert.equal(f.data.calls[0].kind, 'adjust'); assert.equal(f.data.calls[0].args.actualQuantity, 8);
  assert.equal(f.data.calls[0].args.beforeStock, 10); assert.equal(f.data.calls[0].args.reason, '复点一致');
  const repeat = await f.service.review({ id: record.id, action: 'approve', requestId: 'review-00001', reason: '复点一致' }, reviewer);
  assert.deepEqual(result, repeat); assert.equal(f.data.calls.length, 1);
  await assert.rejects(f.service.review({ id: record.id, action: 'reject', requestId: 'review-00002' }, admin), errorCode('already_reviewed', 409));
});

test('count retries preserve the submitted result even after later review', async t => {
  const f = await fixture(t);
  const record = await f.service.count(countInput(), member);
  await f.service.review({ id: record.id, action: 'approve', requestId: 'review-00001' }, reviewer);
  assert.deepEqual(await f.service.count(countInput(), member), record);
  const list = await f.service.list({ type: 'count', status: 'applied' }, member);
  assert.equal(list.records.length, 1); assert.equal(list.counts.applied, 1); assert.equal(list.counts.pending, 0);
});

test('review approval detects stock changes; rejection refreshes source and never adjusts', async t => {
  const f = await fixture(t);
  const record = await f.service.count(countInput(), member);
  f.data.rows[0].nowStock = 7;
  await assert.rejects(f.service.review({ id: record.id, action: 'approve', requestId: 'review-00001' }, reviewer), errorCode('stale_stock', 409));
  const rejected = await f.service.review({ id: record.id, action: 'reject', requestId: 'review-00002', reason: '期间已领用，重新盘点' }, reviewer);
  assert.equal(rejected.status, 'rejected'); assert.equal(f.data.reads, 3); assert.equal(f.data.calls.length, 0);
});

test('review requires a complete fresh source even when rejecting', async t => {
  const f = await fixture(t);
  const record = await f.service.count(countInput(), member); f.data.complete = false;
  await assert.rejects(f.service.review({ id: record.id, action: 'reject', requestId: 'review-00001' }, admin), errorCode('incomplete_catalog'));
  assert.equal((await f.service.list({}, member)).records[0].status, 'pending');
});

test('unknown source result is durable, replays its error and blocks later writes and reviews for the item', async t => {
  const f = await fixture(t);
  const count = await f.service.count(countInput(), member);
  f.data.write = async () => { const error = new Error('timeout with private token'); error.outcome = 'unknown'; throw error; };
  await assert.rejects(f.service.transact(input(), member), errorCode('outcome_unknown', 503));
  await assert.rejects(f.service.transact(input(), member), errorCode('outcome_unknown'));
  await assert.rejects(f.service.transact(input({ requestId: 'request-0002' }), member), errorCode('item_outcome_unknown', 409));
  await assert.rejects(f.service.review({ id: count.id, action: 'approve', requestId: 'review-00001' }, reviewer), errorCode('item_outcome_unknown'));
  assert.equal(f.data.calls.length, 1);
  const saved = await fs.readFile(f.filename, 'utf8'); assert.doesNotMatch(saved, /private token/);
  const restarted = createInventoryService({ root: f.root, source: f.source });
  await assert.rejects(restarted.transact(input({ requestId: 'request-0003' }), member), errorCode('item_outcome_unknown'));
  assert.equal((await restarted.list({ status: 'unknown' }, admin)).records.length, 1);
});

test('undefined or unconfirmed source responses never become applied', async t => {
  for (const response of [undefined, null, { ok: false }, { confirmed: false }, { outcome: 'unknown' }]) {
    const f = await fixture(t, { write: async () => response });
    await assert.rejects(f.service.transact(input(), member), errorCode('outcome_unknown'));
    assert.equal((await f.service.list({}, member)).records[0].status, 'unknown');
  }
});

test('definite source rejection is not retried with the same key and keeps failed adjustment pending', async t => {
  const f = await fixture(t, { write: async () => { throw new Error('business rejection'); } });
  await assert.rejects(f.service.transact(input(), member), errorCode('source_write_failed'));
  await assert.rejects(f.service.transact(input(), member), errorCode('source_write_failed'));
  assert.equal(f.data.calls.length, 1);
  const record = await f.service.count(countInput(), member);
  await assert.rejects(f.service.review({ id: record.id, action: 'approve', requestId: 'review-00001' }, reviewer), errorCode('source_write_failed'));
  assert.equal((await f.service.list({ type: 'count' }, member)).records[0].status, 'pending');
});

test('intent is persisted before external call; interrupted intent recovers unknown after restart', async t => {
  const f = await fixture(t);
  let durableIntent;
  f.data.write = async () => { durableIntent = await fs.readFile(f.filename, 'utf8'); assert.equal(Object.values(JSON.parse(durableIntent).requests)[0].status, 'intent'); return { receiptId: 'confirmed' }; };
  await f.service.transact(input(), member);
  await fs.writeFile(f.filename, durableIntent, 'utf8'); // Represents a process stopping before final local save.
  const restarted = createInventoryService({ root: f.root, source: f.source });
  await assert.rejects(restarted.transact(input(), member), errorCode('outcome_unknown'));
  await assert.rejects(restarted.transact(input({ requestId: 'request-0002' }), member), errorCode('item_outcome_unknown'));
  const saved = JSON.parse(await fs.readFile(f.filename, 'utf8'));
  assert.equal(saved.records[0].status, 'unknown'); assert.equal(Object.values(saved.requests)[0].status, 'unknown');
  assert.equal(f.data.calls.length, 1);
});

test('a post-source local save failure locks writes and restart cannot repeat the external operation', async t => {
  const f = await fixture(t);
  const originalRename = fs.rename;
  f.data.write = async () => {
    fs.rename = async (...args) => { if (args[1] === f.filename) { const error = new Error('disk failure'); error.code = 'EACCES'; throw error; } return originalRename(...args); };
    return { receiptId: 'already-committed' };
  };
  try {
    await assert.rejects(f.service.transact(input(), member), errorCode('outcome_unknown'));
    await assert.rejects(f.service.transact(input(), member), errorCode('outcome_unknown'));
    await assert.rejects(f.service.transact(input({ requestId: 'request-0002' }), member), errorCode('storage_unavailable'));
    assert.equal((await f.service.list({}, admin)).records[0].status, 'unknown');
    assert.equal((await f.service.capabilities()).outbound.enabled, false);
    assert.equal(Object.values(JSON.parse(await fs.readFile(f.filename, 'utf8')).requests)[0].status, 'intent');
  } finally { fs.rename = originalRename; }
  const restarted = createInventoryService({ root: f.root, source: f.source });
  await assert.rejects(restarted.transact(input(), member), errorCode('outcome_unknown'));
  assert.equal(f.data.calls.length, 1);
});

test('a failed initial durable save prevents any source write', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'runtime'), 'not a directory');
  await assert.rejects(f.service.transact(input(), member), errorCode('storage_unavailable'));
  assert.equal(f.data.calls.length, 0);
});

test('corrupt persistence fails closed rather than replacing existing history', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.filename), { recursive: true }); await fs.writeFile(f.filename, '{bad json');
  const broken = createInventoryService({ root: f.root, source: f.source });
  await assert.rejects(broken.transact(input(), member), errorCode('storage_unavailable'));
  assert.equal(await fs.readFile(f.filename, 'utf8'), '{bad json'); assert.equal(f.data.calls.length, 0);
});



test('two instances cannot send the same request while another instance holds the file lock', async t => {
  const f = await fixture(t);
  let started, release;
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  f.data.write = async () => { started(); await gate; return { receiptId: 'one-commit' }; };
  const other = createInventoryService({ root: f.root, source: f.source });
  const first = f.service.transact(input(), member);
  await began;
  await assert.rejects(other.transact(input(), member), errorCode('inventory_busy', 409));
  release(); const completed = await first;
  assert.deepEqual(await other.transact(input(), member), completed);
  assert.equal(f.data.calls.length, 1);
  const saved = JSON.parse(await fs.readFile(f.filename, 'utf8'));
  assert.equal(saved.records.length, 1);
  assert.equal((await other.list({}, member)).records[0].status, 'applied');
  await assert.rejects(fs.access(path.join(f.root, 'runtime', 'inventory.lock')), { code: 'ENOENT' });
});

test('a second process sees the live lock and cannot recover an active intent or write the source', async t => {
  const f = await fixture(t);
  let started, release;
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  f.data.write = async () => { started(); await gate; return { receiptId: 'first-process' }; };
  const first = f.service.transact(input(), member); await began;
  const { promisify } = require('node:util');
  const execute = promisify(require('node:child_process').execFile);
  const script = `const {createInventoryService}=require(process.argv[1]);
    const source={inventoryCatalog:async()=>({rows:[{id:'item-1',nowStock:10}],complete:true}),inventoryCapabilities:()=>({outbound:{enabled:true}}),inventoryWrite:async()=>{console.log('UNEXPECTED_WRITE');return{receiptId:'bad'}}};
    createInventoryService({root:process.argv[2],source}).transact(JSON.parse(process.argv[3]),JSON.parse(process.argv[4])).then(()=>console.log('UNEXPECTED_SUCCESS'),e=>console.log(JSON.stringify({code:e.code,status:e.status})));`;
  const child = await execute(process.execPath, ['-e', script, path.resolve(__dirname, '../lib/inventory.cjs'), f.root, JSON.stringify(input()), JSON.stringify(member)], { timeout: 10000 });
  assert.deepEqual(JSON.parse(child.stdout.trim()), { code: 'inventory_busy', status: 409 });
  assert.equal(Object.values(JSON.parse(await fs.readFile(f.filename, 'utf8')).requests)[0].status, 'intent');
  release(); await first;
  assert.equal(f.data.calls.length, 1);
});

test('an exited owner lock is reclaimed but malformed or unverifiable locks fail closed', async t => {
  const f = await fixture(t);
  const { promisify } = require('node:util');
  const execute = promisify(require('node:child_process').execFile);
  const child = await execute(process.execPath, ['-p', 'process.pid'], { timeout: 10000 });
  const deadPid = Number(child.stdout.trim());
  assert.throws(() => process.kill(deadPid, 0), error => error.code === 'ESRCH');
  const directory = path.join(f.root, 'runtime'), lockfile = path.join(directory, 'inventory.lock');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(lockfile, JSON.stringify({ pid: deadPid, nonce: require('node:crypto').randomUUID() }));
  assert.equal((await f.service.count(countInput(), member)).status, 'pending');
  await fs.writeFile(lockfile, '{partial-lock');
  await assert.rejects(f.service.count(countInput({ requestId: 'count-000002' }), member), errorCode('inventory_busy'));
  assert.equal(await fs.readFile(lockfile, 'utf8'), '{partial-lock');
  await fs.writeFile(lockfile, JSON.stringify({ pid: deadPid, nonce: require('node:crypto').randomUUID() }));
  const denied = new Error('cannot determine owner'); denied.code = 'EPERM';
  const mock = t.mock.method(process, 'kill', () => { throw denied; });
  await assert.rejects(f.service.count(countInput({ requestId: 'count-000003' }), member), errorCode('inventory_busy'));
  mock.mock.restore();
  assert.equal(f.data.calls.length, 0);
});

test('sequential instances reload disk and do not overwrite another instance records', async t => {
  const f = await fixture(t);
  const other = createInventoryService({ root: f.root, source: f.source });
  const first = await f.service.count(countInput(), member);
  const second = await other.count(countInput({ actualQuantity: 9, requestId: 'count-000002' }), member);
  const list = await f.service.list({}, member);
  assert.equal(list.records.length, 2);
  assert.deepEqual(new Set(list.records.map(record => record.id)), new Set([first.id, second.id]));
  assert.equal(JSON.parse(await fs.readFile(f.filename, 'utf8')).records.length, 2);
});

test('a queued action reauthorizes the original version after membership is revoked', async t => {
  let revoked = false;
  const seen = [];
  const user = { ...member, version: 7 };
  const f = await fixture(t, { rows: [row(), row('item-2')], authorizeActor: async (trusted, options) => {
    seen.push({ account: trusted.account, version: trusted.version, review: options.review });
    if (trusted.account === user.account && revoked) { const error = new Error('成员已停用'); error.status = 401; error.code = 'membership_revoked'; throw error; }
    return trusted;
  } });
  let started, release;
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  f.data.write = async () => { started(); await gate; return { receiptId: 'first' }; };
  const first = f.service.transact(input(), admin); await began;
  const queued = f.service.transact(input({ itemId: 'item-2', requestId: 'request-0002' }), user);
  const rejected = assert.rejects(queued, errorCode('membership_revoked', 401));
  revoked = true; release(); await first; await rejected;
  assert.equal(f.data.calls.length, 1);
  assert.ok(seen.some(call => call.account === user.account && call.version === 7 && call.review === false));
});

test('revocation during fresh inventory read prevents both source write and local count save', async t => {
  for (const action of ['transact', 'count']) {
    let allowed = true;
    const user = { ...member, version: 3 };
    const f = await fixture(t, { authorizeActor: async trusted => {
      assert.equal(trusted.version, 3);
      if (!allowed) { const error = new Error('会话版本已撤销'); error.status = 401; error.code = 'membership_revoked'; throw error; }
      return trusted;
    } });
    let started, release;
    const began = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const catalog = f.source.inventoryCatalog;
    f.source.inventoryCatalog = async args => { started(); await gate; return catalog(args); };
    const operation = f.service[action](action === 'count' ? countInput() : input(), user);
    const rejected = assert.rejects(operation, errorCode('membership_revoked', 401));
    await began; allowed = false; release(); await rejected;
    assert.equal(f.data.calls.length, 0);
    await assert.rejects(fs.access(f.filename), { code: 'ENOENT' });
  }
});

test('reviewer downgrade while fresh read waits blocks approval and rejection before any change', async t => {
  for (const decision of ['approve', 'reject']) {
    let role = 'reviewer';
    const f = await fixture(t, { authorizeActor: async trusted => trusted.account === reviewer.account ? { ...trusted, role } : trusted });
    const record = await f.service.count(countInput(), member);
    let started, release;
    const began = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const catalog = f.source.inventoryCatalog;
    f.source.inventoryCatalog = async args => { started(); await gate; return catalog(args); };
    const operation = f.service.review({ id: record.id, action: decision, requestId: 'review-00001' }, { ...reviewer, version: 4 });
    const rejected = assert.rejects(operation, errorCode('review_forbidden', 403));
    await began; role = 'member'; release(); await rejected;
    assert.equal(f.data.calls.length, 0);
    assert.equal(JSON.parse(await fs.readFile(f.filename, 'utf8')).records[0].status, 'pending');
  }
});

test('final authorization after durable intent may deny a write without sending it', async t => {
  let checks = 0;
  const f = await fixture(t, { authorizeActor: async trusted => {
    if (++checks === 3) { const error = new Error('权限已撤销'); error.status = 403; error.code = 'membership_revoked'; throw error; }
    return trusted;
  } });
  await assert.rejects(f.service.transact(input(), { ...member, version: 8 }), errorCode('membership_revoked', 403));
  assert.equal(f.data.calls.length, 0);
  const saved = JSON.parse(await fs.readFile(f.filename, 'utf8'));
  assert.equal(saved.records[0].status, 'rejected');
  assert.equal(Object.values(saved.requests)[0].status, 'failed');
  assert.equal(Object.values(saved.requests)[0].error.code, 'membership_revoked');
});

test('source revision from each fresh catalog is passed to source writes including review', async t => {
  const f = await fixture(t, { metadata: { sourceRevision: 7 } });
  const count = await f.service.count(countInput(), member);
  f.data.metadata.sourceRevision = 9;
  await f.service.review({ id: count.id, action: 'approve', requestId: 'review-00001' }, reviewer);
  assert.equal(f.data.calls[0].args.sourceRevision, 9);
  assert.equal(Object.hasOwn((await f.service.list({}, member)).records[0], 'sourceRevision'), false);
  f.data.metadata.sourceRevision = 10;
  await f.service.transact(input({ expectedStock: 8 }), member);
  assert.equal(f.data.calls[1].args.sourceRevision, 10);
});

test('GY-SPARE labels select exact scoped source IDs; old material codes remain ambiguous', async t => {
  const f = await fixture(t, { rows: [row('item/中文-1', { bjbh: '', BarCode: '' }), row('item-2'), row('item-3'), row('other', { bjbh: 'GY-SPARE:nonexistent' })] });
  const selected = await f.service.catalog({ code: 'GY-SPARE:' + encodeURIComponent('item/中文-1') });
  assert.equal(selected.items.length, 1); assert.equal(selected.items[0].id, 'item/中文-1'); assert.equal(selected.items[0].selectable, true);
  assert.equal((await f.service.catalog({ code: 'SYNTHETIC-PART-001' })).items.length, 3);
  assert.equal((await f.service.catalog({ code: 'GY-SPARE:nonexistent' })).items.length, 0);
  for (const code of ['GY-SPARE:', 'GY-SPARE:%', 'GY-SPARE:%20', 'GY-SPARE:%00', 'GY-SPARE:%E0%A4%A']) {
    await assert.rejects(f.service.catalog({ code }), errorCode('invalid_barcode', 400));
  }
});

test('explicit company acknowledgement without a document ID is audited without inventing a receipt or after-stock', async t => {
  const f = await fixture(t, { write: async () => ({ confirmed: true, acknowledgement: 'company-success', actor: admin, reviewer: admin }) });
  const record = await f.service.transact(input(), member);
  assert.equal(record.status, 'applied');
  assert.equal(record.confirmationMethod, 'company-success');
  assert.equal(record.confirmed, true);
  assert.equal(record.acknowledgement, 'company-success');
  assert.equal(record.actor.account, member.account);
  assert.equal(Object.hasOwn(record, 'reviewer'), false);
  assert.equal(Object.hasOwn(record, 'receiptId'), false);
  assert.equal(Object.hasOwn(record, 'afterStock'), false);
  assert.equal(f.data.calls[0].args.actor.account, member.account);
  const retried = await f.service.transact(input(), member);
  assert.deepEqual(retried, record);
  assert.equal(f.data.calls.length, 1);
  const restarted = createInventoryService({ root: f.root, source: f.source });
  assert.deepEqual(await restarted.transact(input(), member), record);
  const saved = JSON.parse(await fs.readFile(f.filename, 'utf8'));
  assert.equal(saved.records[0].acknowledgement, 'company-success');
  assert.equal(Object.hasOwn(saved.records[0], 'receiptId'), false);
});

test('explicit acknowledgement supports reviewed adjustments and preserves both actual operators', async t => {
  const f = await fixture(t, { write: async () => ({ confirmed: true, acknowledgement: 'company-success' }) });
  const counted = await f.service.count(countInput(), member);
  const result = await f.service.review({ id: counted.id, action: 'approve', requestId: 'review-ack-0001', reason: '复核差异' }, reviewer);
  assert.equal(result.status, 'applied');
  assert.equal(result.confirmationMethod, 'company-success');
  assert.equal(result.actor.account, member.account);
  assert.equal(result.reviewer.account, reviewer.account);
  assert.equal(f.data.calls[0].args.actor.account, reviewer.account);
  assert.equal(Object.hasOwn(result, 'receiptId'), false);
  assert.equal(Object.hasOwn(result, 'afterStock'), false);
});

test('empty or merely truthy write responses stay unknown and preserve protection against retries', async t => {
  for (const reply of [
    {}, [], null, { acknowledgement: 'company-success' }, { confirmed: 'true' }, { ok: true }, { success: true },
    { receiptId: '' }, { receiptId: ' ' }, { receiptId: {} }, { receiptId: false }, { receiptId: NaN },
    { receiptId: 'line\nbreak' }, { receiptId: 'x'.repeat(201) },
    { receiptId: 'actual-receipt', confirmed: false }, { confirmed: true, outcome: 'unknown' },
    { confirmed: true, ok: false }, { confirmed: true, success: false }
  ]) {
    const f = await fixture(t, { write: async () => reply });
    await assert.rejects(f.service.transact(input(), member), errorCode('outcome_unknown', 503));
    await assert.rejects(f.service.transact(input(), member), errorCode('outcome_unknown', 503));
    await assert.rejects(f.service.transact(input({ requestId: 'request-0002' }), member), errorCode('item_outcome_unknown', 409));
    assert.equal(f.data.calls.length, 1);
    const listed = (await f.service.list({}, member)).records[0];
    assert.equal(listed.status, 'unknown');
    assert.equal(Object.hasOwn(listed, 'confirmationMethod'), false);
    assert.equal(Object.hasOwn(listed, 'receiptId'), false);
  }
});

test('confirmed writes record only authoritative valid after-stock and retain real optional receipt IDs', async t => {
  const f = await fixture(t, { write: async () => ({ confirmed: true, acknowledgement: 'company-success', receiptId: 'REAL-DOC-007', afterStock: 0 }) });
  const record = await f.service.transact(input(), member);
  assert.equal(record.receiptId, 'REAL-DOC-007');
  assert.equal(record.confirmationMethod, 'receipt');
  assert.equal(record.acknowledgement, 'company-success');
  assert.equal(record.afterStock, 0);
  for (const afterStock of [undefined, null, '', true, 'not-a-number', -1]) {
    const isolated = await fixture(t, { write: async () => ({ confirmed: true, acknowledgement: 'company-success', afterStock }) });
    const result = await isolated.service.transact(input(), member);
    assert.equal(result.status, 'applied');
    assert.equal(Object.hasOwn(result, 'afterStock'), false);
  }
  const numbered = await fixture(t, { write: async () => ({ receiptId: 0 }) });
  assert.equal((await numbered.service.transact(input(), member)).receiptId, '0');
});

const SOURCE_A = 'a'.repeat(64), SOURCE_B = 'b'.repeat(64);

test('catalog exposes source profile, label and stable identity and rejects malformed origins', async t => {
  const f = await fixture(t, { metadata: { sourceIdentity: SOURCE_A, inventoryProfile: 'mold', inventoryLabel: '工艺部仓库' } });
  const catalog = await f.service.catalog();
  assert.equal(catalog.sourceIdentity, SOURCE_A);
  assert.equal(catalog.inventoryProfile, 'mold');
  assert.equal(catalog.inventoryLabel, '工艺部仓库');
  assert.equal(catalog.items[0].sourceIdentity, SOURCE_A);
  for (const sourceIdentity of [null, undefined, '', 'not-a-sha256', 'A'.repeat(64), 123]) {
    f.data.metadata.sourceIdentity = sourceIdentity;
    await assert.rejects(f.service.catalog(), errorCode('source_identity_unavailable', 503));
  }
  assert.equal(f.data.calls.length, 0);
});

test('transactions and counts require the exact fresh source identity and persist its trustworthy value', async t => {
  const f = await fixture(t, { metadata: { sourceIdentity: SOURCE_A } });
  for (const expectedSourceIdentity of [undefined, SOURCE_B]) {
    await assert.rejects(f.service.transact(input({ expectedSourceIdentity }), member), errorCode('source_identity_mismatch', 409));
    await assert.rejects(f.service.count(countInput({ expectedSourceIdentity }), member), errorCode('source_identity_mismatch', 409));
  }
  for (const expectedSourceIdentity of [null, '', true, 'fake', 'A'.repeat(64)]) {
    await assert.rejects(f.service.transact(input({ expectedSourceIdentity }), member), errorCode('invalid_source_identity', 400));
    await assert.rejects(f.service.count(countInput({ expectedSourceIdentity }), member), errorCode('invalid_source_identity', 400));
  }
  assert.equal(f.data.calls.length, 0);
  assert.equal((await f.service.list({}, member)).records.length, 0);
  const moved = await f.service.transact(input({ expectedSourceIdentity: SOURCE_A }), member);
  assert.equal(moved.sourceIdentity, SOURCE_A);
  assert.equal(moved.item.sourceIdentity, SOURCE_A);
  assert.equal(f.data.calls[0].args.sourceIdentity, SOURCE_A);
  const counted = await f.service.count(countInput({ expectedStock: 8, actualQuantity: 7, expectedSourceIdentity: SOURCE_A }), member);
  assert.equal(counted.sourceIdentity, SOURCE_A);
  const disk = JSON.parse(await fs.readFile(f.filename, 'utf8'));
  assert.equal(disk.records.every(record => record.sourceIdentity === SOURCE_A), true);
});

test('same item ID and stock in another warehouse cannot use the old client confirmation', async t => {
  const f = await fixture(t, { metadata: { sourceIdentity: SOURCE_A } });
  const selected = (await f.service.catalog()).items[0];
  f.data.metadata.sourceIdentity = SOURCE_B;
  await assert.rejects(f.service.transact(input({ expectedSourceIdentity: selected.sourceIdentity }), member), errorCode('source_identity_mismatch', 409));
  await assert.rejects(f.service.count(countInput({ expectedSourceIdentity: selected.sourceIdentity }), member), errorCode('source_identity_mismatch', 409));
  assert.equal(f.data.calls.length, 0);
  assert.equal((await f.service.list({}, member)).records.length, 0);
});

test('pending counts can only be approved or rejected in their original stable warehouse identity', async t => {
  const f = await fixture(t, { metadata: { sourceIdentity: SOURCE_A } });
  const counted = await f.service.count(countInput({ expectedSourceIdentity: SOURCE_A }), member);
  f.data.metadata.sourceIdentity = SOURCE_B;
  for (const action of ['approve', 'reject']) {
    await assert.rejects(f.service.review({ id: counted.id, action, requestId: 'review-source-' + action }, reviewer), errorCode('source_identity_mismatch', 409));
  }
  assert.equal(f.data.calls.length, 0);
  assert.equal((await f.service.list({}, member)).records[0].status, 'pending');
  f.data.metadata.sourceIdentity = SOURCE_A;
  const reviewed = await f.service.review({ id: counted.id, action: 'approve', requestId: 'review-source-approve' }, reviewer);
  assert.equal(reviewed.status, 'applied');
  assert.equal(reviewed.sourceIdentity, SOURCE_A);
  assert.equal(f.data.calls[0].args.sourceIdentity, SOURCE_A);
});

test('legacy counts without a source identity cannot be attached to a newly identified warehouse', async t => {
  const f = await fixture(t);
  const counted = await f.service.count(countInput(), member);
  f.data.metadata = { sourceIdentity: SOURCE_A };
  for (const action of ['approve', 'reject']) {
    await assert.rejects(f.service.review({ id: counted.id, action, requestId: 'review-legacy-' + action }, reviewer), errorCode('source_identity_mismatch', 409));
  }
  assert.equal(f.data.calls.length, 0);
  assert.equal((await f.service.list({}, member)).records[0].status, 'pending');
});

test('idempotency fingerprints bind the expected source identity for transactions and counts', async t => {
  const f = await fixture(t, { metadata: { sourceIdentity: SOURCE_A } });
  const recorded = await f.service.transact(input({ expectedSourceIdentity: SOURCE_A }), member);
  f.data.metadata.sourceIdentity = SOURCE_B;
  f.data.rows[0].nowStock = 10;
  await assert.rejects(f.service.transact(input({ expectedSourceIdentity: SOURCE_B }), member), errorCode('idempotency_conflict', 409));
  assert.equal(f.data.calls.length, 1);
  const replay = await f.service.transact(input({ expectedSourceIdentity: SOURCE_A }), member);
  assert.equal(replay.id, recorded.id);
  assert.equal(replay.sourceIdentity, SOURCE_A);
  assert.equal(f.data.calls.length, 1);
  const counted = await f.service.count(countInput({ expectedSourceIdentity: SOURCE_B }), member);
  f.data.metadata.sourceIdentity = SOURCE_A;
  await assert.rejects(f.service.count(countInput({ expectedSourceIdentity: SOURCE_A }), member), errorCode('idempotency_conflict', 409));
  assert.equal((await f.service.list({}, member)).records.find(item => item.id === counted.id).sourceIdentity, SOURCE_B);
});

test('versioned labels bind exact item IDs to one warehouse and old production labels require reprinting', async t => {
  const id = 'item/中文-1';
  const f = await fixture(t, { rows: [row(id, { bjbh: '', BarCode: '' })], metadata: { sourceIdentity: SOURCE_A } });
  const label = 'GY-SPARE:v1:' + SOURCE_A + ':' + encodeURIComponent(id);
  const found = await f.service.catalog({ code: label });
  assert.equal(found.items.length, 1);
  assert.equal(found.items[0].id, id);
  assert.equal(found.items[0].sourceIdentity, SOURCE_A);
  await assert.rejects(f.service.catalog({ code: 'GY-SPARE:v1:' + SOURCE_B + ':' + encodeURIComponent(id) }), errorCode('source_identity_mismatch', 409));
  await assert.rejects(f.service.catalog({ code: 'GY-SPARE:' + encodeURIComponent(id) }), errorCode('legacy_barcode', 409));
  for (const code of ['GY-SPARE:v1:missing:item', 'GY-SPARE:v1:' + SOURCE_A + ':', 'GY-SPARE:v1:' + SOURCE_A + ':%']) {
    await assert.rejects(f.service.catalog({ code }), errorCode('invalid_barcode', 400));
  }
  delete f.data.metadata.sourceIdentity;
  await assert.rejects(f.service.catalog({ code: label }), errorCode('source_identity_mismatch', 409));
  assert.equal((await f.service.catalog({ code: 'GY-SPARE:' + encodeURIComponent(id) })).items[0].id, id);
});

test('unknown operations stay blocked in their source while identified records in another warehouse are distinct', async t => {
  const f = await fixture(t, { metadata: { sourceIdentity: SOURCE_A }, write: async () => ({}) });
  await assert.rejects(f.service.transact(input({ expectedSourceIdentity: SOURCE_A }), member), errorCode('outcome_unknown'));
  f.data.metadata.sourceIdentity = SOURCE_B;
  f.data.write = async () => ({ confirmed: true, acknowledgement: 'company-success' });
  const otherWarehouse = await f.service.transact(input({ expectedSourceIdentity: SOURCE_B, requestId: 'request-source-b' }), member);
  assert.equal(otherWarehouse.status, 'applied');
  assert.equal(otherWarehouse.sourceIdentity, SOURCE_B);
  f.data.metadata.sourceIdentity = SOURCE_A;
  await assert.rejects(f.service.transact(input({ expectedSourceIdentity: SOURCE_A, requestId: 'request-source-a' }), member), errorCode('item_outcome_unknown', 409));
  assert.equal(f.data.calls.length, 2);
  const legacy = await fixture(t, { write: async () => ({}) });
  await assert.rejects(legacy.service.transact(input(), member), errorCode('outcome_unknown'));
  legacy.data.metadata = { sourceIdentity: SOURCE_B };
  await assert.rejects(legacy.service.transact(input({ expectedSourceIdentity: SOURCE_B, requestId: 'request-legacy-b' }), member), errorCode('item_outcome_unknown', 409));
  assert.equal(legacy.data.calls.length, 1);
});
