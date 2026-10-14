'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createVisionCatalog } = require('../lib/vision-catalog.cjs');

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-vision-catalog-'));
  t.after(async () => {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('portal-vision-catalog-')) throw new Error('Unexpected test cleanup directory');
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { root, file: path.join(root, 'runtime/vision/catalog.json'), catalog: createVisionCatalog({ root, config: { vision: { dataFile: 'synthetic-private-configured-path.json' } } }) };
}
const draft = (overrides = {}) => ({ deviceId: 'synthetic-rear-02', name: '合成后副检具', lineName: '合成后副线', transport: 'share', sourcePath: 'Z:\\SyntheticOnly\\rear.json', partNames: ['Synthetic_RearA'], measurementCount: 42, notes: '仅登记合成测试', ...overrides });

test('default catalog shows current configured device without private connection settings or writes', async t => {
  const { catalog, file } = await setup(t);
  const result = await catalog.list();
  assert.deepEqual(result.lines, [{ id: 'front-subframe', name: '前副车架' }]);
  assert.deepEqual(result.devices, [{ id: 'vision-01', name: '前副车架检具', lineId: 'front-subframe', lineName: '前副车架', status: 'configured', transport: 'share', partNames: ['Tesla_Front11', 'Tesla_Front12'], measurementCount: 61 }]);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private-configured-path/);
  assert.equal(result.limits.maxDevices, 100);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  result.devices[0].partNames.push('ClientMutation');
  assert.equal((await catalog.list()).devices[0].partNames.length, 2);
});

test('draft saves only pending metadata, persists after restart and never accesses its proposed source', async t => {
  const { catalog, root, file } = await setup(t);
  const input = draft({ password: 'SYNTHETIC-SECRET-NOT-STORED', token: 'SYNTHETIC-TOKEN-NOT-STORED', status: 'configured' });
  const stat = fs.stat.bind(fs), readFile = fs.readFile.bind(fs);
  const guardStat = t.mock.method(fs, 'stat', async (target, ...args) => { assert.notEqual(String(target), input.sourcePath); return stat(target, ...args); });
  const guardRead = t.mock.method(fs, 'readFile', async (target, ...args) => { assert.notEqual(String(target), input.sourcePath); return readFile(target, ...args); });
  const saved = await catalog.saveDraft(input);
  assert.equal(saved.device.status, 'pending');
  assert.equal(saved.device.id, input.deviceId);
  assert.equal(saved.device.lineName, input.lineName);
  assert.equal(saved.device.sourcePath, input.sourcePath);
  assert.match(saved.message, /尚未读取来源/);
  const restarted = await createVisionCatalog({ root }).list();
  assert.deepEqual(restarted.devices[1], saved.device);
  guardStat.mock.restore(); guardRead.mock.restore();
  assert.doesNotMatch(await fs.readFile(file, 'utf8'), /SYNTHETIC-SECRET|SYNTHETIC-TOKEN|"password"|"token"/);
});

test('same line name reuses its identity and an existing line id takes its stored name', async t => {
  const { catalog } = await setup(t);
  const first = await catalog.saveDraft(draft());
  const second = await catalog.saveDraft(draft({ deviceId: 'synthetic-rear-03', lineName: ' 合成后副线 ' }));
  assert.equal(second.device.lineId, first.device.lineId);
  const third = await catalog.saveDraft(draft({ deviceId: 'synthetic-front-04', lineId: 'front-subframe', lineName: 'THIS-MUST-NOT-RENAME-THE-LINE' }));
  assert.equal(third.device.lineName, '前副车架');
  assert.equal((await catalog.list()).lines.length, 2);
});

test('pending draft can be updated while omitted optional metadata is preserved', async t => {
  const { catalog } = await setup(t);
  const saved = await catalog.saveDraft(draft());
  const updated = await catalog.saveDraft({ deviceId: saved.device.id, name: '修改后的合成检具', lineId: saved.device.lineId, transport: 'upload' });
  assert.equal(updated.device.name, '修改后的合成检具');
  assert.equal(updated.device.transport, 'upload');
  assert.equal(updated.device.sourcePath, saved.device.sourcePath);
  assert.equal(updated.device.measurementCount, 42);
  assert.equal(updated.device.status, 'pending');
  assert.equal((await catalog.list()).devices.length, 2);
  const cleared = await catalog.saveDraft(draft({ sourcePath: '', partNames: [], measurementCount: null, notes: '' }));
  assert.equal(cleared.device.measurementCount, null);
  assert.equal(cleared.device.sourcePath, '');
});

test('multiline notes normalize Windows newlines and survive persistence without relaxing other text fields', async t => {
  const { catalog, root, file } = await setup(t);
  const saved = await catalog.saveDraft(draft({ notes: ' 第一行\r\n第二行\n第三行 ' }));
  assert.equal(saved.device.notes, '第一行\n第二行\n第三行');
  assert.equal((await createVisionCatalog({ root }).list()).devices[1].notes, saved.device.notes);
  const stored = JSON.parse(await fs.readFile(file, 'utf8'));
  stored.devices[0].notes = '存盘第一行\r\n存盘第二行';
  await fs.writeFile(file, JSON.stringify(stored));
  assert.equal((await catalog.list()).devices[1].notes, '存盘第一行\n存盘第二行');
  for (const value of ['bad\rnotes', 'bad\tnotes', 'bad\u0000notes']) {
    await assert.rejects(catalog.saveDraft(draft({ notes: value })), { status: 400 });
  }
  await assert.rejects(catalog.saveDraft(draft({ name: 'bad\nname' })), { status: 400 });
  await assert.rejects(catalog.saveDraft(draft({ sourcePath: 'bad\r\npath' })), { status: 400 });
});

test('configured device cannot be replaced and malformed draft values are rejected', async t => {
  const { catalog } = await setup(t);
  await assert.rejects(catalog.saveDraft(draft({ deviceId: 'vision-01' })), { status: 409 });
  const invalid = [
    { deviceId: 'all' }, { deviceId: 'ALL' }, { deviceId: '../bad' }, { deviceId: 'x'.repeat(65) },
    { name: '' }, { name: 'bad\nname' }, { name: 'x'.repeat(101) }, { lineId: 'missing-line' }, { lineName: '' },
    { transport: 'http' }, { sourcePath: 'bad\u0000path' }, { sourcePath: 'x'.repeat(1025) },
    { partNames: ['duplicate', 'duplicate'] }, { partNames: 'not-a-list' }, { partNames: Array(51).fill('x') },
    { measurementCount: 0 }, { measurementCount: 1.5 }, { measurementCount: 10001 }, { measurementCount: '61' },
    { notes: 'x'.repeat(1001) }, { notes: 'bad\u007fnotes' }
  ];
  for (const changes of invalid) await assert.rejects(catalog.saveDraft(draft(changes)), { status: 400 });
  assert.equal((await catalog.list()).devices.length, 1);
});

test('concurrent registration writes are serialized without losing devices', async t => {
  const { catalog, root, file } = await setup(t);
  await Promise.all(Array.from({ length: 10 }, (_, i) => catalog.saveDraft(draft({ deviceId: `synthetic-concurrent-${i}` }))));
  assert.equal((await catalog.list()).devices.length, 11);
  assert.equal((await createVisionCatalog({ root }).list()).devices.length, 11);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['catalog.json']);
});

test('catalog supports at most 100 devices including the configured one', async t => {
  const { catalog } = await setup(t);
  await Promise.all(Array.from({ length: 99 }, (_, i) => catalog.saveDraft(draft({ deviceId: `synthetic-capacity-${i}` }))));
  assert.equal((await catalog.list()).devices.length, 100);
  await assert.rejects(catalog.saveDraft(draft({ deviceId: 'synthetic-over-capacity' })), { status: 400 });
  await catalog.saveDraft(draft({ deviceId: 'synthetic-capacity-0', name: '容量满时仍可更新' }));
  assert.equal((await catalog.list()).devices.length, 100);
});

test('invalid or contradictory stored catalogs are reported and never overwritten', async t => {
  const { catalog, file } = await setup(t);
  await catalog.saveDraft(draft());
  const valid = JSON.parse(await fs.readFile(file, 'utf8'));
  const contradictory = structuredClone(valid); contradictory.devices[0].lineId = 'front-subframe';
  const overwrittenDefault = structuredClone(valid); overwrittenDefault.devices[0].id = 'vision-01';
  for (const content of ['{ broken', JSON.stringify({ schema_version: 2, devices: [] }), JSON.stringify(contradictory), JSON.stringify(overwrittenDefault)]) {
    await fs.writeFile(file, content);
    await assert.rejects(catalog.list(), { status: 503 });
    await assert.rejects(catalog.saveDraft(draft({ deviceId: 'synthetic-unwritten' })), { status: 503 });
    assert.equal(await fs.readFile(file, 'utf8'), content);
  }
});

test('atomic replacement failure preserves the previous catalog and removes the temporary file', async t => {
  const { catalog, file } = await setup(t);
  await catalog.saveDraft(draft());
  const before = await fs.readFile(file, 'utf8');
  const rename = t.mock.method(fs, 'rename', async () => { throw Object.assign(new Error('synthetic write failure'), { code: 'EIO' }); });
  await assert.rejects(catalog.saveDraft(draft({ deviceId: 'synthetic-not-saved' })), { status: 503 });
  rename.mock.restore();
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.equal((await catalog.list()).devices.length, 2);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['catalog.json']);
});
