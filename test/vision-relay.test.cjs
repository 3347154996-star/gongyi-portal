'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { relayOnce, runWorker, requestStop, consumeStopRequest } = require('../lib/vision-relay.cjs');

async function workspace(t) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'portal-vision-relay-test-'));
  t.after(async () => {
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('portal-vision-relay-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { root, sourceFile: path.join(root, 'private-synthetic-source.json'), destinationFile: path.join(root, 'destination.json') };
}
function record() {
  return { device_id: 'synthetic-relay-device', part_name: 'Tesla_Front12', serial_number: 'SYNTHETIC-RELAY-001', measured_at_local: '2026-10-15T08:00:00', source_result: 'OK',
    measurements: Array.from({ length: 61 }, (_, index) => ({ name: `合成测点 ${index + 1}`, nominal: 10, lower_limit: -0.5, upper_limit: 0.5, is_critical: index < 59, deviation: 0.1, deviation_raw: '0.1', source_result: 'OK' })) };
}
function snapshot({ scannedAt = new Date().toISOString(), records = [], errors = [], deferred = 0 } = {}) {
  return { schema_version: 1, records, last_scan: { scanned_at_utc: scannedAt, errors, deferred } };
}
const bytesOf = value => Buffer.from('\uFEFF' + JSON.stringify(value, null, 2).replaceAll('\n', '\r\n') + '\r\n');
function safeError(files, code) {
  return error => {
    assert.ok(error instanceof Error);
    assert.equal(typeof error.code, 'string');
    assert.ok(error.code.length > 0);
    if (code) assert.equal(error.code, code);
    for (const filename of files) assert.ok(!error.message.includes(filename), 'error must not expose source or destination paths');
    assert.ok(!error.message.includes('PRIVATE-SYNTHETIC-PAYLOAD'));
    return true;
  };
}

async function instrumentedRelay({ corruptTemporary = false } = {}) {
  const filename = path.resolve(__dirname, '../lib/vision-relay.cjs');
  const localRequire = require('node:module').createRequire(filename);
  const originalValidator = localRequire('./vision.cjs').validateVisionSnapshot;
  const metrics = { validatedBatches: [], wholeFileReads: [], chunkReadSizes: [], writes: 0 };
  const io = { ...fs, open: async (name, ...args) => {
    const handle = await fs.open(name, ...args);
    return new Proxy(handle, { get(target, key) {
      if (key === 'readFile') return async (...values) => { metrics.wholeFileReads.push(String(name)); return target.readFile(...values); };
      if (key === 'read') return async (...values) => { metrics.chunkReadSizes.push(values[2]); return target.read(...values); };
      if (key === 'writeFile') return async (...values) => {
        metrics.writes++; const result = await target.writeFile(...values);
        if (corruptTemporary && String(name).includes('.relay-')) await target.write(Buffer.from('!'), 0, 1, 0);
        return result;
      };
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  const module = { exports: {} };
  vm.runInNewContext(await fs.readFile(filename, 'utf8'), { module, Buffer, TextDecoder, process, setTimeout, clearTimeout,
    require: name => name === 'node:fs/promises' ? io : name === './vision.cjs' ? {
      validateVisionSnapshot: (raw, options) => { metrics.validatedBatches.push(raw.records?.length); return originalValidator(raw, options); }
    } : localRequire(name) }, { filename });
  return { relayOnce: module.exports.relayOnce, metrics };
}

test('relay copies validated source bytes exactly without changing records or collector scan time', async t => {
  const files = await workspace(t), doc = snapshot({ records: [record()] });
  doc.synthetic_extra = { preserved: '原始内容与空白不应重写' };
  const bytes = bytesOf(doc);
  await fs.writeFile(files.sourceFile, bytes);
  const sourceStat = await fs.stat(files.sourceFile);
  const result = await relayOnce(files);
  assert.equal(result.state, 'copied');
  assert.equal(result.recordCount, 1);
  assert.equal(result.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.collectorScannedAt, doc.last_scan.scanned_at_utc);
  assert.equal(result.collectorState, 'ready');
  assert.deepEqual(await fs.readFile(files.destinationFile), bytes);
  assert.deepEqual(await fs.readFile(files.sourceFile), bytes);
  assert.equal((await fs.stat(files.sourceFile)).mtimeMs, sourceStat.mtimeMs);
  const copied = JSON.parse((await fs.readFile(files.destinationFile, 'utf8')).replace(/^\uFEFF/, ''));
  assert.deepEqual(copied.last_scan, doc.last_scan);
  assert.deepEqual(copied.records, doc.records);
});

test('an empty schema-1 snapshot with a UTC scan is a legitimate copied snapshot', async t => {
  const files = await workspace(t), bytes = bytesOf(snapshot());
  await fs.writeFile(files.sourceFile, bytes);
  const result = await relayOnce(files);
  assert.equal(result.state, 'copied');
  assert.equal(result.recordCount, 0);
  assert.deepEqual(await fs.readFile(files.destinationFile), bytes);
});

test('identical source bytes return unchanged without touching destination mtime', async t => {
  const files = await workspace(t), bytes = bytesOf(snapshot());
  await fs.writeFile(files.sourceFile, bytes);
  const first = await relayOnce(files);
  const oldTime = new Date('2020-01-02T03:04:05Z');
  await fs.utimes(files.destinationFile, oldTime, oldTime);
  const before = await fs.stat(files.destinationFile);
  const second = await relayOnce(files);
  assert.equal(second.state, 'unchanged');
  assert.equal(second.sha256, first.sha256);
  assert.equal((await fs.stat(files.destinationFile)).mtimeMs, before.mtimeMs);
  assert.deepEqual(await fs.readFile(files.destinationFile), bytes);
});

test('identical bytes are fully validated once and do not allocate or validate a second record collection', async t => {
  const files = await workspace(t), bytes = bytesOf(snapshot({ records: [record()] }));
  await fs.writeFile(files.sourceFile, bytes); await fs.writeFile(files.destinationFile, bytes);
  const relay = await instrumentedRelay();
  assert.equal((await relay.relayOnce(files)).state, 'unchanged');
  assert.deepEqual(relay.metrics.validatedBatches, [1]);
  assert.deepEqual(relay.metrics.wholeFileReads, [files.sourceFile, files.destinationFile]);
  assert.equal(relay.metrics.writes, 0);
});

test('equal sizes and timestamps never allow different source content to skip validation or rollback protection', async t => {
  const files = await workspace(t), source = bytesOf(snapshot({ scannedAt: '2026-10-14T08:00:00Z', records: [record()] }));
  const destination = bytesOf(snapshot({ scannedAt: '2026-10-15T08:00:00Z', records: [record()] }));
  assert.equal(source.length, destination.length);
  await fs.writeFile(files.sourceFile, source); await fs.writeFile(files.destinationFile, destination);
  const time = new Date('2026-10-15T08:00:00Z');
  await fs.utimes(files.sourceFile, time, time); await fs.utimes(files.destinationFile, time, time);
  const relay = await instrumentedRelay();
  await assert.rejects(relay.relayOnce(files), { code: 'VISION_RELAY_ROLLBACK' });
  assert.deepEqual(relay.metrics.validatedBatches, [1, 1]);
  assert.deepEqual(await fs.readFile(files.destinationFile), destination);
});

test('identical invalid bytes, an invalid last record and the complete-batch record limit are still rejected', async t => {
  const files = await workspace(t);
  const invalid = [snapshot({ records: [{}] }), snapshot({ records: [record(), { ...record(), measurements: [] }] }), snapshot({ records: Array.from({ length: 20001 }, () => ({})) })];
  for (const document of invalid) {
    const bytes = bytesOf(document); await fs.writeFile(files.sourceFile, bytes); await fs.writeFile(files.destinationFile, bytes);
    const relay = await instrumentedRelay();
    await assert.rejects(relay.relayOnce(files), { code: 'VISION_RELAY_FORMAT' });
    assert.deepEqual(relay.metrics.wholeFileReads, [files.sourceFile], 'Invalid source cannot use byte equality to bypass validation');
    assert.equal(relay.metrics.writes, 0); assert.deepEqual(await fs.readFile(files.destinationFile), bytes);
  }
});

test('a newer target with invalid measurement data is repaired only after full target validation', async t => {
  const files = await workspace(t), source = bytesOf(snapshot({ scannedAt: '2026-10-14T08:00:00Z', records: [record()] }));
  const broken = record(); broken.measurements[60].nominal = 'invalid';
  await fs.writeFile(files.sourceFile, source); await fs.writeFile(files.destinationFile, bytesOf(snapshot({ scannedAt: '2026-10-15T08:00:00Z', records: [broken] })));
  const relay = await instrumentedRelay(), result = await relay.relayOnce(files);
  assert.equal(result.state, 'copied'); assert.equal(result.replacedInvalidTarget, true);
  assert.deepEqual(relay.metrics.validatedBatches, [1, 1]); assert.deepEqual(await fs.readFile(files.destinationFile), source);
});

test('temporary-copy verification reads bounded chunks and detects corruption before replacing the destination', async t => {
  const files = await workspace(t), document = snapshot({ records: [record()] });
  document.synthetic_padding = 'x'.repeat(200000); const bytes = bytesOf(document);
  await fs.writeFile(files.sourceFile, bytes);
  const relay = await instrumentedRelay(); assert.equal((await relay.relayOnce(files)).state, 'copied');
  assert.deepEqual(relay.metrics.wholeFileReads, [files.sourceFile]);
  assert.ok(relay.metrics.chunkReadSizes.length > 3); assert.ok(relay.metrics.chunkReadSizes.every(size => size <= 64 * 1024));
  assert.deepEqual(await fs.readFile(files.destinationFile), bytes);
  const originalTarget = bytesOf(snapshot({ scannedAt: document.last_scan.scanned_at_utc })); await fs.writeFile(files.destinationFile, originalTarget);
  const corrupt = await instrumentedRelay({ corruptTemporary: true });
  await assert.rejects(corrupt.relayOnce(files), { code: 'VISION_RELAY_VERIFY' });
  assert.deepEqual(await fs.readFile(files.destinationFile), originalTarget);
  assert.deepEqual(await fs.readFile(files.sourceFile), bytes);
  assert.equal((await fs.readdir(files.root)).some(name => name.includes('.relay-')), false);
});

test('malformed UTF-8, JSON, schema and records never replace a valid destination', async t => {
  const files = await workspace(t), prior = bytesOf(snapshot());
  await fs.writeFile(files.destinationFile, prior);
  const invalid = [Buffer.from([0xff, 0xfe]), Buffer.from('{"PRIVATE-SYNTHETIC-PAYLOAD":'), bytesOf({ ...snapshot(), schema_version: 2 }), bytesOf(snapshot({ records: [{}] }))];
  for (const bytes of invalid) {
    await fs.writeFile(files.sourceFile, bytes);
    await assert.rejects(relayOnce(files), safeError([files.sourceFile, files.destinationFile]));
    assert.deepEqual(await fs.readFile(files.destinationFile), prior);
    assert.deepEqual(await fs.readFile(files.sourceFile), bytes);
  }
});

test('source files larger than 128 MiB are rejected before replacing a destination', async t => {
  const files = await workspace(t), prior = bytesOf(snapshot());
  await fs.writeFile(files.destinationFile, prior);
  const handle = await fs.open(files.sourceFile, 'w');
  try { await handle.truncate(128 * 1024 * 1024 + 1); } finally { await handle.close(); }
  await assert.rejects(relayOnce(files), safeError([files.sourceFile, files.destinationFile]));
  assert.deepEqual(await fs.readFile(files.destinationFile), prior);
});

test('a valid source repairs a corrupt destination', async t => {
  const files = await workspace(t), bytes = bytesOf(snapshot({ records: [record()] }));
  await fs.writeFile(files.sourceFile, bytes);
  await fs.writeFile(files.destinationFile, '{corrupt destination');
  assert.equal((await relayOnce(files)).state, 'copied');
  assert.deepEqual(await fs.readFile(files.destinationFile), bytes);
});

test('an older collector scan cannot overwrite a newer valid destination', async t => {
  const files = await workspace(t), source = bytesOf(snapshot({ scannedAt: '2026-10-14T08:00:00Z' })), destination = bytesOf(snapshot({ scannedAt: '2026-10-15T08:00:00Z' }));
  await fs.writeFile(files.sourceFile, source);
  await fs.writeFile(files.destinationFile, destination);
  await assert.rejects(relayOnce(files), safeError([files.sourceFile, files.destinationFile], 'VISION_RELAY_ROLLBACK'));
  assert.deepEqual(await fs.readFile(files.destinationFile), destination);
  assert.deepEqual(await fs.readFile(files.sourceFile), source);
});

test('identical source and destination paths are refused without modifying the file', async t => {
  const files = await workspace(t), bytes = bytesOf(snapshot());
  await fs.writeFile(files.sourceFile, bytes);
  await assert.rejects(relayOnce({ sourceFile: files.sourceFile, destinationFile: files.sourceFile }), { code: 'VISION_RELAY_SAME_PATH' });
  assert.deepEqual(await fs.readFile(files.sourceFile), bytes);
});

test('different paths resolving to the same source file are refused', async t => {
  const files = await workspace(t), bytes = bytesOf(snapshot());
  await fs.writeFile(files.sourceFile, bytes);
  try { await fs.symlink(files.sourceFile, files.destinationFile, 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(error.code)) { t.skip('file symlinks unavailable for this OS/account'); return; }
    throw error;
  }
  await assert.rejects(relayOnce(files), { code: 'VISION_RELAY_SAME_PATH' });
  assert.deepEqual(await fs.readFile(files.sourceFile), bytes);
});

test('hard links to the same underlying file are refused without modifying the source', async t => {
  const files = await workspace(t), bytes = bytesOf(snapshot());
  await fs.writeFile(files.sourceFile, bytes);
  try { await fs.link(files.sourceFile, files.destinationFile); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(error.code)) { t.skip('hard links unavailable for this OS/account'); return; }
    throw error;
  }
  await assert.rejects(relayOnce(files), { code: 'VISION_RELAY_SAME_PATH' });
  assert.deepEqual(await fs.readFile(files.sourceFile), bytes);
});

test('collector errors remain visible and are not rewritten as a successful scan', async t => {
  const files = await workspace(t), doc = snapshot({ errors: [{ message: 'synthetic unreadable file' }], deferred: 2 }), bytes = bytesOf(doc);
  await fs.writeFile(files.sourceFile, bytes);
  const result = await relayOnce(files);
  assert.equal(result.collectorState, 'error');
  assert.equal(result.collectorScannedAt, doc.last_scan.scanned_at_utc);
  assert.deepEqual(await fs.readFile(files.destinationFile), bytes);
});

test('old collector scans remain waiting and deferred files do not fabricate scan errors', async t => {
  const files = await workspace(t), doc = snapshot({ scannedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), deferred: 2 }), bytes = bytesOf(doc);
  await fs.writeFile(files.sourceFile, bytes);
  const result = await relayOnce(files);
  assert.equal(result.collectorState, 'waiting');
  assert.equal(result.collectorScannedAt, doc.last_scan.scanned_at_utc);
  assert.deepEqual(await fs.readFile(files.destinationFile), bytes);
});

test('missing, invalid or future scan time remains an error without inventing a current scan', async t => {
  const files = await workspace(t);
  const documents = [{ schema_version: 1, records: [] }, snapshot({ scannedAt: '2026-10-15T08:00:00+08:00' }), snapshot({ scannedAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() })];
  for (const [index, doc] of documents.entries()) {
    const bytes = bytesOf(doc), destinationFile = path.join(files.root, `scan-${index}.json`);
    await fs.writeFile(files.sourceFile, bytes);
    const result = await relayOnce({ sourceFile: files.sourceFile, destinationFile });
    assert.equal(result.collectorState, 'error');
    assert.equal(result.collectorScannedAt, index < 2 ? null : doc.last_scan.scanned_at_utc);
    assert.deepEqual(await fs.readFile(destinationFile), bytes);
  }
});

function fakeChild() {
  const child = new EventEmitter();
  child.connected = true; child.sent = []; child.kills = [];
  child.send = (message, callback) => { child.sent.push(message); callback?.(); };
  child.kill = signal => { child.kills.push(signal); child.emit('synthetic-kill'); return true; };
  return child;
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('worker result waits for successful child close before resolving', { timeout: 3000 }, async () => {
  const child = fakeChild(), expected = { state: 'copied', recordCount: 0, sha256: 'a'.repeat(64), collectorScannedAt: new Date().toISOString(), collectorState: 'ready' };
  let settled = false;
  const pending = runWorker({ workerFile: 'synthetic-worker-only.cjs', config: {}, timeoutMs: 2000, spawn: () => child });
  pending.then(() => { settled = true; }, () => { settled = true; });
  child.emit('message', { type: 'result', value: expected });
  await turn();
  assert.equal(settled, false, 'IPC result alone does not prove worker has exited');
  child.emit('close', 0, null);
  assert.deepEqual(await pending, expected);
  assert.equal(child.kills.length, 0);
});

test('worker timeout kills the child and waits for close before rejecting', { timeout: 3000 }, async () => {
  const child = fakeChild();
  const killed = new Promise(resolve => child.once('synthetic-kill', resolve));
  let settled = false;
  const pending = runWorker({ workerFile: 'synthetic-worker-only.cjs', config: {}, timeoutMs: 25, spawn: () => child });
  const rejected = assert.rejects(pending, { code: 'VISION_RELAY_TIMEOUT' });
  pending.then(() => { settled = true; }, () => { settled = true; });
  await killed; await turn();
  assert.equal(child.kills.length, 1);
  assert.equal(settled, false, 'timed-out worker must close before another worker can start');
  child.emit('message', { type: 'result', value: { state: 'copied' } });
  child.emit('message', { type: 'error', code: 'VISION_RELAY_FORMAT' });
  await turn();
  assert.equal(settled, false, 'late result must not defeat timeout or close barrier');
  child.emit('close', null, 'SIGTERM');
  await rejected;
});

test('a result followed by a failed worker close is rejected', { timeout: 3000 }, async () => {
  const child = fakeChild();
  const pending = runWorker({ workerFile: 'synthetic-worker-only.cjs', config: {}, timeoutMs: 2000, spawn: () => child });
  const rejected = assert.rejects(pending, { code: 'VISION_RELAY_WORKER' });
  child.emit('message', { type: 'result', value: { state: 'copied' } });
  child.emit('close', 1, null);
  await rejected;
});

test('aborting a worker waits for close and does not accept a late successful result', { timeout: 3000 }, async () => {
  const child = fakeChild(), controller = new AbortController();
  let settled = false;
  const pending = runWorker({ workerFile: 'synthetic-worker-only.cjs', config: {}, timeoutMs: 2000, signal: controller.signal, spawn: () => child });
  const rejected = assert.rejects(pending, { code: 'VISION_RELAY_STOPPED' });
  pending.then(() => { settled = true; }, () => { settled = true; });
  controller.abort(); await turn();
  assert.equal(child.kills.length, 1);
  assert.equal(settled, false);
  child.emit('message', { type: 'result', value: { state: 'copied' } });
  child.emit('close', 0, null);
  await rejected;
});

test('stop without an instance lock creates no request and removes no existing files', async t => {
  const { root } = await workspace(t), marker = path.join(root, 'unrelated.txt');
  await fs.writeFile(marker, 'preserve synthetic marker');
  assert.equal(await requestStop(root), false);
  await assert.rejects(fs.stat(path.join(root, 'stop-request.json')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(marker, 'utf8'), 'preserve synthetic marker');
  assert.deepEqual(await fs.readdir(root), ['unrelated.txt']);
});

test('a stop request targets the locked instance and only its matching consumer removes it', async t => {
  const { root } = await workspace(t), instanceId = crypto.randomUUID(), lockFile = path.join(root, 'lock.json'), requestFile = path.join(root, 'stop-request.json');
  const lock = JSON.stringify({ instanceId, pid: 123456789, startedAt: '2026-10-15T08:00:00Z' });
  await fs.writeFile(lockFile, lock);
  assert.equal(await requestStop(root), true);
  assert.deepEqual(JSON.parse(await fs.readFile(requestFile, 'utf8')), { instanceId });
  assert.equal(await consumeStopRequest(root, instanceId), true);
  await assert.rejects(fs.stat(requestFile), { code: 'ENOENT' });
  assert.equal(await fs.readFile(lockFile, 'utf8'), lock, 'requesting or consuming stop must never delete the owner lock');
  assert.equal(await consumeStopRequest(root, instanceId), false);
  assert.deepEqual(await fs.readdir(root), ['lock.json'], 'atomic stop-request write leaves no temporary files');
});

test('a stale stop request cannot stop another instance and is retained unchanged', async t => {
  const { root } = await workspace(t), oldInstance = crypto.randomUUID(), currentInstance = crypto.randomUUID(), requestFile = path.join(root, 'stop-request.json');
  const request = JSON.stringify({ instanceId: oldInstance });
  await fs.writeFile(requestFile, request);
  const lock = JSON.stringify({ instanceId: currentInstance, pid: 123456789 });
  await fs.writeFile(path.join(root, 'lock.json'), lock);
  assert.equal(await consumeStopRequest(root, currentInstance), false);
  assert.equal(await fs.readFile(requestFile, 'utf8'), request);
  assert.equal(await fs.readFile(path.join(root, 'lock.json'), 'utf8'), lock);
});

test('the actual IPC worker copies only the supplied synthetic temporary snapshot', { timeout: 15000 }, async t => {
  const files = await workspace(t), doc = snapshot({ records: [record()] }), bytes = bytesOf(doc);
  await fs.writeFile(files.sourceFile, bytes);
  const result = await runWorker({ workerFile: path.resolve(__dirname, '../vision-relay.cjs'), config: { sourceFile: files.sourceFile, destinationFile: files.destinationFile }, timeoutMs: 10000 });
  assert.equal(result.state, 'copied');
  assert.equal(result.recordCount, 1);
  assert.equal(result.collectorScannedAt, doc.last_scan.scanned_at_utc);
  assert.equal(result.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(await fs.readFile(files.sourceFile), bytes);
  assert.deepEqual(await fs.readFile(files.destinationFile), bytes);
});
