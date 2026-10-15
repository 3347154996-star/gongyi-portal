'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createVisionService, validateVisionSnapshot } = require('../lib/vision.cjs');

const now = () => Date.parse('2026-10-13T09:00:00Z');
function record(sn = 'SYNTHETIC-SYNC-001') {
  return { deviceId: 'vision-01', partName: 'Tesla_Front12', serialNumber: sn, measuredAt: '2026-10-13T08:00:00', sourceResult: 'OK',
    measurements: Array.from({ length: 61 }, (_, i) => ({ name: `合成测点_${i + 1}`, nominal: 10, lowerLimit: -0.5, upperLimit: 0.5, isCritical: true, deviation: 0.1, deviationRaw: '0.1', sourceResult: 'OK' })) };
}
function snapshot(...rows) { return { schema_version: 1, records: rows, last_scan: { scanned_at_utc: '2026-10-13T09:00:00Z', errors: [], deferred: 0 } }; }
function gate() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function within(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Snapshot query waited for the source read')), 1000); })]); }
  finally { clearTimeout(timer); }
}
async function setup(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-vision-sync-'));
  const service = createVisionService({ root, now, ...options });
  t.after(async () => {
    service.stop();
    const resolved = path.resolve(root), temporary = path.resolve(os.tmpdir());
    assert.ok(resolved.startsWith(temporary + path.sep) && path.basename(resolved).startsWith('portal-vision-sync-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { root, service, store: path.join(root, 'runtime/vision/records.json') };
}
function csv(sn) {
  const rows = [['PartName', 'Tesla_Front12', '', '', '', '', ''], ['SN', sn, '', '', '', '', ''], ['TimeStamp', '2026/10/13 08:00:00', '', '', '', '', ''], ['Result', 'OK', '', '', '', '', ''], ['Name', 'Nominal', 'Lower_SL', 'Upper_SL', 'IsCritical', 'Dev', 'OK/NG'],
    ...Array.from({ length: 61 }, (_, i) => [`合成测点_${i + 1}`, 10, -0.5, 0.5, 'Yes', 0.1, 'OK'])];
  return { deviceId: 'vision-01', filename: 'Tesla_Front12_20261013-080000.csv', content: rows.map(row => row.join(',')).join('\r\n') + '\r\n' };
}

test('snapshot validation is pure, returns normalized records and validates the whole batch', () => {
  const raw = snapshot(record()), before = structuredClone(raw);
  const [normalized] = validateVisionSnapshot(raw);
  assert.equal(normalized.serialNumber, 'SYNTHETIC-SYNC-001');
  assert.match(normalized.id, /^[a-f0-9]{64}$/);
  assert.equal(normalized.measurements.length, 61);
  assert.deepEqual(raw, before);
  normalized.measurements[0].deviation = 999;
  assert.equal(raw.records[0].measurements[0].deviation, 0.1);
  assert.throws(() => validateVisionSnapshot(snapshot(record(), { ...record('INVALID'), measurements: [] })), /61/);
  assert.throws(() => validateVisionSnapshot({ schema_version: 2, records: [] }), /版本/);
});

test('start persists inspections without any page query and stop leaves the snapshot readable', async t => {
  let reads = 0;
  const { service, store } = await setup(t, { sourceReader: { async read() { reads++; return snapshot(record()); } } });
  await service.start();
  const saved = JSON.parse(await fs.readFile(store, 'utf8'));
  assert.equal(reads, 1);
  assert.equal(saved.records[0].serialNumber, 'SYNTHETIC-SYNC-001');
  assert.equal(saved.collectorCheckedAt, '2026-10-13T09:00:00.000Z');
  service.stop();
  assert.equal((await service.report()).total, 1);
  assert.equal((await service.detail(saved.records[0].id)).measurements.length, 61);
  assert.equal(reads, 1);
});

test('a hanging source does not block restored reports, details or manual imports', async t => {
  const pending = gate(), called = gate();
  const { root, store } = await setup(t, { sourceReader: { async read() { return snapshot(); } } });
  const seed = createVisionService({ root, now, sourceReader: { async read() { return snapshot(record()); } } });
  await seed.sync();
  const id = JSON.parse(await fs.readFile(store, 'utf8')).records[0].id;
  let reads = 0;
  const service = createVisionService({ root, now, sourceReader: { read() { reads++; called.resolve(); return pending.promise; } } });
  t.after(() => service.stop());
  const started = service.start();
  await called.promise;
  try {
    assert.equal((await within(service.report())).total, 1);
    assert.equal((await within(service.detail(id))).serialNumber, 'SYNTHETIC-SYNC-001');
    assert.equal((await within(service.importCsv(csv('SYNTHETIC-MANUAL')))).imported, 1);
    assert.equal((await within(service.report())).total, 2);
    assert.equal(reads, 1);
  } finally { pending.resolve(snapshot(record('SYNTHETIC-AUTOMATIC'))); await started; }
  assert.equal((await service.report()).total, 3);
  assert.equal(JSON.parse(await fs.readFile(store, 'utf8')).records.length, 3);
});

test('background sync is single-flight and schedules the next read only after completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = gate(), called = gate();
  let reads = 0;
  const { service, store } = await setup(t, { config: { vision: { pollIntervalSeconds: 5 } }, sourceReader: { read() {
    reads++;
    if (reads === 1) { called.resolve(); return pending.promise; }
    return Promise.resolve(snapshot(record('SYNTHETIC-NEXT')));
  } } });
  const first = service.start();
  await called.promise;
  assert.equal(service.sync(), first);
  assert.equal(service.start(), first);
  t.mock.timers.tick(60000);
  assert.equal(reads, 1);
  pending.resolve(snapshot(record()));
  await first;
  t.mock.timers.tick(4999);
  assert.equal(reads, 1);
  t.mock.timers.tick(1);
  await service.sync();
  assert.equal(reads, 2);
  assert.equal(JSON.parse(await fs.readFile(store, 'utf8')).records.length, 2);
  service.stop();
  t.mock.timers.tick(60000);
  assert.equal(reads, 2);
});

test('failed and invalid snapshots preserve saved inspections and the next automatic poll recovers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const { service, store } = await setup(t, { config: { vision: { pollIntervalSeconds: 5 } }, sourceReader: { async read() {
    reads++;
    if (reads === 2) throw Object.assign(new Error('synthetic unavailable source'), { code: 'EACCES' });
    if (reads === 3) return snapshot(record('SYNTHETIC-UNCOMMITTED'), { ...record('INVALID'), measurements: [] });
    return snapshot(record(reads === 1 ? 'SYNTHETIC-OLD' : 'SYNTHETIC-RECOVERED'));
  } } });
  await service.start();
  const before = await fs.readFile(store, 'utf8');
  for (let i = 0; i < 2; i++) {
    t.mock.timers.tick(5000); await service.sync();
    const report = await service.report();
    assert.equal(report.total, 1); assert.equal(report.source.state, 'error');
    assert.equal(await fs.readFile(store, 'utf8'), before);
  }
  t.mock.timers.tick(5000); await service.sync();
  const report = await service.report();
  assert.equal(report.total, 2); assert.equal(report.source.state, 'ready');
  assert.deepEqual(report.records.map(row => row.serialNumber).sort(), ['SYNTHETIC-OLD', 'SYNTHETIC-RECOVERED']);
});

test('stop invalidates a pending source response without writing or scheduling another poll', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = gate(), called = gate();
  let reads = 0;
  const { service, store } = await setup(t, { config: { vision: { pollIntervalSeconds: 5 } }, sourceReader: { read() {
    reads++; if (reads === 1) return Promise.resolve(snapshot(record()));
    called.resolve(); return pending.promise;
  } } });
  await service.start();
  const before = await fs.readFile(store, 'utf8');
  const flight = service.sync(); await called.promise;
  service.stop();
  pending.resolve(snapshot(record('SYNTHETIC-AFTER-STOP'))); await flight;
  t.mock.timers.tick(60000);
  assert.equal(reads, 2);
  assert.equal(await fs.readFile(store, 'utf8'), before);
  assert.equal((await service.report()).total, 1);
});

test('stop during a staged local write prevents replacement and removes the temporary file', async t => {
  let incoming = snapshot(record());
  const { service, store } = await setup(t, { sourceReader: { async read() { return incoming; } } });
  await service.start();
  const before = await fs.readFile(store, 'utf8'), staged = gate(), release = gate();
  const originalWrite = fs.writeFile;
  const write = t.mock.method(fs, 'writeFile', async (filename, ...args) => {
    await originalWrite(filename, ...args);
    if (String(filename).startsWith(store + '.') && String(filename).endsWith('.tmp')) { staged.resolve(); await release.promise; }
  });
  incoming = snapshot(record('SYNTHETIC-STAGED'));
  const flight = service.sync(); await staged.promise;
  service.stop(); release.resolve(); await flight; write.mock.restore();
  assert.equal(await fs.readFile(store, 'utf8'), before);
  assert.equal((await service.report()).total, 1);
  assert.deepEqual(await fs.readdir(path.dirname(store)), ['records.json']);
});

test('restarting while an old read is pending discards that generation and resumes fresh sync', async t => {
  const old = gate(), called = gate(); let reads = 0;
  const { service, store } = await setup(t, { sourceReader: { read() {
    reads++; if (reads === 1) { called.resolve(); return old.promise; }
    return Promise.resolve(snapshot(record('SYNTHETIC-RESTARTED')));
  } } });
  const first = service.start(); await called.promise;
  service.stop(); const restarted = service.start();
  old.resolve(snapshot(record('SYNTHETIC-OBSOLETE')));
  await Promise.all([first, restarted]);
  assert.equal(reads, 2);
  assert.deepEqual(JSON.parse(await fs.readFile(store, 'utf8')).records.map(row => row.serialNumber), ['SYNTHETIC-RESTARTED']);
});

test('source commit failure keeps the previous disk and memory snapshot and can be retried', async t => {
  let incoming = snapshot(record());
  const { service, store } = await setup(t, { sourceReader: { async read() { return incoming; } } });
  await service.start(); const before = await fs.readFile(store, 'utf8');
  incoming = snapshot(record('SYNTHETIC-RETRY'));
  const rename = t.mock.method(fsSync, 'renameSync', () => { throw new Error('synthetic commit failure'); });
  await service.sync(); rename.mock.restore();
  assert.equal((await service.report()).total, 1);
  assert.equal((await service.report()).source.state, 'error');
  assert.equal(await fs.readFile(store, 'utf8'), before);
  await service.sync();
  assert.equal((await service.report()).total, 2);
  assert.deepEqual(await fs.readdir(path.dirname(store)), ['records.json']);
});

test('polling defaults to 30 seconds and accepts only the configured 5–3600 second range', async t => {
  for (const [configured, seconds] of [[undefined, 30], [4, 30], [3601, 30], ['5', 30], [5, 5], [3600, 3600]]) {
    await t.test(String(configured), async t => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      let reads = 0;
      const { service } = await setup(t, { config: { vision: { pollIntervalSeconds: configured } }, sourceReader: { async read() { reads++; return snapshot(); } } });
      await service.start();
      t.mock.timers.tick(seconds * 1000 - 1); assert.equal(reads, 1);
      t.mock.timers.tick(1); await service.sync(); assert.equal(reads, 2);
    });
  }
});

test('a service never started retains query-triggered awaited synchronization', async t => {
  const pending = gate(), called = gate();
  const { service } = await setup(t, { sourceReader: { read() { called.resolve(); return pending.promise; } } });
  let settled = false;
  const query = service.report().then(report => { settled = true; return report; });
  await called.promise; await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  pending.resolve(snapshot(record()));
  assert.equal((await query).total, 1);
});
