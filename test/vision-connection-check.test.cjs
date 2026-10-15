'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { checkVisionConnection } = require('../check-vision-connection.cjs');
const now = () => Date.parse('2026-10-15T04:00:00Z');
const snapshot = (scan = '2026-10-15T04:00:00Z') => ({ schema_version: 1, records: [], last_scan: { scanned_at_utc: scan, errors: [] } });

test('connection check validates a readable snapshot without creating a record store or changing input', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vision-readonly-check-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'synthetic.json');
  const original = JSON.stringify(snapshot());
  await fs.writeFile(filename, original);
  const result = await checkVisionConnection({ root, env: {}, config: { vision: { dataFile: filename } }, now });
  assert.equal(result.state, 'ready');
  assert.equal(result.recordCount, 0);
  assert.equal(await fs.readFile(filename, 'utf8'), original);
  assert.deepEqual(await fs.readdir(root), ['synthetic.json']);
  assert.equal(JSON.stringify(result).includes(filename), false);
});

test('readability is distinguished from stale, invalid-time and collector-error states', async () => {
  async function check(document) { return checkVisionConnection({ now, sourceReader: { read: async () => document } }); }
  assert.equal((await check(snapshot('2026-10-15T01:59:59Z'))).state, 'waiting');
  for (const timestamp of ['', '2026-02-30T04:00:00Z', '2026-10-15T04:01:00Z']) {
    const result = await check(snapshot(timestamp));
    assert.equal(result.state, 'error');
    assert.equal(result.code, 'VISION_SCAN_TIME');
  }
  const document = snapshot();
  document.last_scan.errors.push({ path: 'PRIVATE-SHARE/PART-SN.csv', error: 'private-error' });
  const result = await check(document);
  assert.equal(result.code, 'VISION_COLLECTOR_ERRORS');
  assert.equal(result.collectorErrorCount, 1);
  assert.equal(JSON.stringify(result).includes('PRIVATE-SHARE'), false);
  assert.equal(JSON.stringify(result).includes('private-error'), false);
});

test('format failures and unreadable inputs never return source records or pretend ready', async () => {
  const invalid = snapshot(); invalid.records = [{ serial_number: 'PRIVATE-SN', part_name: 'unsupported' }];
  const result = await checkVisionConnection({ now, sourceReader: { read: async () => invalid } });
  assert.equal(result.code, 'VISION_SOURCE_FORMAT');
  assert.equal(JSON.stringify(result).includes('PRIVATE-SN'), false);
  const missing = await checkVisionConnection({ root: process.cwd(), env: {}, config: { vision: { dataFile: 'runtime/synthetic-does-not-exist.json' } }, now });
  assert.equal(missing.state, 'error');
  assert.equal(missing.code, 'ENOENT');
});
