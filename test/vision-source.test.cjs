'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createVisionSource, sourceSettings } = require('../lib/vision-source.cjs');

test('Windows deployment keeps UNC and explicit environment overrides without disclosing paths', async () => {
  let seen;
  const source = createVisionSource({ root: 'C:\\synthetic-portal', platform: 'win32', config: { vision: { dataFile: '\\\\legacy-host\\share\\vision.json' } },
    env: { PORTAL_VISION_DATA_FILE: '\\\\synthetic-host\\readonly-share\\vision.json' }, readJson: async value => { seen = value; return { schema_version: 1, records: [] }; } });
  assert.equal((await source.read()).schema_version, 1);
  assert.equal(seen, '\\\\synthetic-host\\readonly-share\\vision.json');
  assert.deepEqual(source.describe(), { kind: 'unc', configured: true, readTimeoutMs: 10000 });
  assert.equal(JSON.stringify(source.describe()).includes('synthetic-host'), false);
});

test('Linux uses an OS mounted path and rejects untranslated Windows or URL inputs before I/O', async () => {
  const settings = sourceSettings({ root: '/srv/synthetic-portal', platform: 'linux', env: {}, config: { vision: { dataFile: '/mnt/synthetic-gauge/vision.json' } } });
  assert.equal(settings.filename, '/mnt/synthetic-gauge/vision.json');
  let reads = 0;
  for (const dataFile of ['\\\\synthetic-host\\share\\vision.json', 'Z:\\vision.json', 'smb://synthetic-host/share/vision.json', 'http://synthetic-host/vision.json']) {
    const source = createVisionSource({ root: '/srv/synthetic-portal', platform: 'linux', env: {}, config: { vision: { dataFile } }, readJson: async () => { reads++; } });
    await assert.rejects(source.read(), { code: 'VISION_SOURCE_CONFIG' });
  }
  assert.equal(reads, 0);
});

test('empty override does not silently reconnect the old source; ambiguous Windows paths fail closed', async () => {
  const options = { root: 'C:\\synthetic-portal', platform: 'win32', config: { vision: { dataFile: '\\\\old-host\\share\\vision.json' } } };
  await assert.rejects(createVisionSource({ ...options, env: { PORTAL_VISION_DATA_FILE: ' ' } }).read(), { code: 'VISION_SOURCE_CONFIG' });
  for (const dataFile of ['C:relative.json', '\\relative.json', '/mnt/share/vision.json', '//?/C:/synthetic/vision.json', '//./pipe/synthetic', '\\\\synthetic-host', '//synthetic-host', '\\\\synthetic-host\\share']) {
    await assert.rejects(createVisionSource({ ...options, env: {}, config: { vision: { dataFile } } }).read(), { code: 'VISION_SOURCE_CONFIG' });
  }
});

test('file source reads UTF-8 BOM JSON without modifying the source and classifies invalid content', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vision-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'runtime'));
  const filename = path.join(root, 'runtime/vision-input.json');
  const bytes = Buffer.from('\uFEFF' + JSON.stringify({ schema_version: 1, records: [] }));
  await fs.writeFile(filename, bytes);
  const source = createVisionSource({ root, env: {} });
  assert.deepEqual(await source.read(), { schema_version: 1, records: [] });
  assert.deepEqual(await fs.readFile(filename), bytes);
  await fs.writeFile(filename, '{unfinished');
  await assert.rejects(source.read(), { code: 'VISION_SOURCE_FORMAT' });
  await fs.writeFile(filename, Buffer.from([0xff]));
  await assert.rejects(source.read(), { code: 'VISION_SOURCE_FORMAT' });
});

test('permission and connection errors contain actionable messages without raw private paths', async () => {
  for (const code of ['EACCES', 'ENOENT', 'ENETUNREACH']) {
    const source = createVisionSource({ root: process.cwd(), env: {}, readJson: async () => { throw Object.assign(new Error('private-host/private-share/record-sn'), { code }); } });
    await assert.rejects(source.read(), error => error.status === 503 && !error.message.includes('private-') && /账号|路径|文件/.test(error.message));
  }
});

test('timed out share reads stay single-flight and a subsequent read recovers after completion', async () => {
  let reads = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const source = createVisionSource({ root: process.cwd(), env: {}, config: { vision: { readTimeoutMs: 1000 } }, readJson: async () => { reads++; if (reads === 1) return gate; return { recovered: true }; } });
  const first = source.read(), simultaneous = source.read();
  await Promise.all([assert.rejects(first, { code: 'VISION_READ_TIMEOUT' }), assert.rejects(simultaneous, { code: 'VISION_READ_TIMEOUT' })]);
  assert.equal(reads, 1);
  const stillPending = source.read();
  release({ late: true });
  assert.deepEqual(await stillPending, { late: true });
  assert.equal(reads, 1);
  assert.deepEqual(await source.read(), { recovered: true });
  assert.equal(reads, 2);
});

async function incrementalFile(t) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'vision-source-incremental-'));
  t.after(async () => {
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('vision-source-incremental-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const filename = path.join(root, 'synthetic-input.json');
  const source = createVisionSource({ root, env: {}, config: { vision: { dataFile: filename } } });
  return { filename, source };
}
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('default incremental reader hashes original bytes and returns no document for an unchanged digest', async t => {
  const { filename, source } = await incrementalFile(t);
  const document = { schema_version: 1, records: [], last_scan: { scanned_at_utc: '2026-10-15T08:00:00Z', errors: [], deferred: 0 } };
  const bytes = Buffer.from('\uFEFF' + JSON.stringify(document, null, 2) + '\r\n');
  await fs.writeFile(filename, bytes);
  const first = await source.readIfChanged();
  assert.deepEqual(first, { unchanged: false, digest: sha256(bytes), document });
  const second = await source.readIfChanged(first.digest);
  assert.deepEqual(second, { unchanged: true, digest: first.digest });
  assert.equal(Object.hasOwn(second, 'document'), false);
  assert.deepEqual(await source.read(), document, 'read() still returns the original document API after an unchanged result');
  assert.deepEqual(await fs.readFile(filename), bytes);
});

test('incremental reader treats byte-only changes and newly parsed documents as changed', async t => {
  const { filename, source } = await incrementalFile(t);
  const initial = { schema_version: 1, records: [], syntheticRevision: 1 };
  const compact = Buffer.from(JSON.stringify(initial));
  await fs.writeFile(filename, compact);
  const first = await source.readIfChanged();
  const pretty = Buffer.from(JSON.stringify(initial, null, 2) + '\n');
  await fs.writeFile(filename, pretty);
  const formattingOnly = await source.readIfChanged(first.digest);
  assert.equal(formattingOnly.unchanged, false);
  assert.equal(formattingOnly.digest, sha256(pretty));
  assert.notEqual(formattingOnly.digest, first.digest);
  assert.deepEqual(formattingOnly.document, initial);
  const updated = { ...initial, syntheticRevision: 2 }, updatedBytes = Buffer.from(JSON.stringify(updated));
  await fs.writeFile(filename, updatedBytes);
  const changed = await source.readIfChanged(formattingOnly.digest);
  assert.deepEqual(changed, { unchanged: false, digest: sha256(updatedBytes), document: updated });
  assert.deepEqual(await source.read(), updated);
});

test('invalid JSON or UTF-8 never becomes a successful incremental token and a later valid document recovers', async t => {
  const { filename, source } = await incrementalFile(t);
  const initial = { schema_version: 1, records: [] }, initialBytes = Buffer.from(JSON.stringify(initial));
  await fs.writeFile(filename, initialBytes);
  const first = await source.readIfChanged();
  for (const invalid of [Buffer.from('{unfinished synthetic input'), Buffer.from([0xff])]) {
    await fs.writeFile(filename, invalid);
    await assert.rejects(source.readIfChanged(first.digest), { code: 'VISION_SOURCE_FORMAT' });
    await assert.rejects(source.readIfChanged(first.digest), { code: 'VISION_SOURCE_FORMAT' });
    assert.deepEqual(await fs.readFile(filename), invalid);
  }
  await fs.writeFile(filename, initialBytes);
  assert.deepEqual(await source.readIfChanged(first.digest), { unchanged: true, digest: first.digest });
  const recovered = { schema_version: 1, records: [], syntheticRecovered: true }, recoveredBytes = Buffer.from(JSON.stringify(recovered));
  await fs.writeFile(filename, recoveredBytes);
  assert.deepEqual(await source.readIfChanged(first.digest), { unchanged: false, digest: sha256(recoveredBytes), document: recovered });
});
