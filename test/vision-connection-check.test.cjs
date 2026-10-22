'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
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
  assert.equal(result.mode, 'legacy-file');
  assert.equal(result.mesVerified, false);
  assert.match(result.scope, /不验证 MES/);
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

test('default CLI refuses legacy file reads and directs MES users to the current guide', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'check-vision-connection.cjs')], {
    encoding: 'utf8', timeout: 5000, windowsHide: true,
    env: { ...process.env, PORTAL_VISION_DATA_FILE: 'SYNTHETIC-NOT-TO-BE-READ' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /VISION_LEGACY_CHECK_ONLY/);
  assert.match(result.stderr, /不验证 MES/);
  assert.match(result.stderr, /vision:check:legacy/);
  assert.doesNotMatch(result.stderr + result.stdout, /SYNTHETIC-NOT-TO-BE-READ|config.local.json 缺失/);
});

test('both CLI help forms explain the legacy-only scope without reading config', () => {
  for (const args of [['--help'], ['--legacy', '--help']]) {
    const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'check-vision-connection.cjs'), ...args], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /仅用于历史文件采集方案，不验证 MES/);
    assert.match(result.stdout, /公司尺寸接口接入.md/);
    assert.match(result.stdout, /--legacy/);
  }
});

test('explicit legacy CLI still checks synthetic files without changing them or claiming MES access', async t => {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'vision-legacy-cli-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(root)), parent);
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.copyFile(path.join(__dirname, '..', 'check-vision-connection.cjs'), path.join(root, 'check-vision-connection.cjs'));
  await fs.cp(path.join(__dirname, '..', 'lib'), path.join(root, 'lib'), { recursive: true });
  await fs.mkdir(path.join(root, 'public'));
  await fs.copyFile(path.join(__dirname, '..', 'public', 'company-calendar.js'), path.join(root, 'public', 'company-calendar.js'));
  await fs.writeFile(path.join(root, 'config.local.json'), JSON.stringify({ vision: { dataFile: 'synthetic.json' } }));
  const original = JSON.stringify(snapshot(new Date().toISOString()));
  await fs.writeFile(path.join(root, 'synthetic.json'), original);
  const { PORTAL_VISION_DATA_FILE: _ignored, ...env } = process.env;
  const result = spawnSync(process.execPath, [path.join(root, 'check-vision-connection.cjs'), '--legacy'], {
    cwd: root, env, encoding: 'utf8', timeout: 5000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.state, 'ready');
  assert.equal(report.mode, 'legacy-file');
  assert.equal(report.mesVerified, false);
  assert.equal(await fs.readFile(path.join(root, 'synthetic.json'), 'utf8'), original);
  assert.equal((await fs.readdir(root)).includes('runtime'), false);
});

test('legacy failure and waiting results cannot be mistaken for MES verification', async () => {
  for (const read of [async () => snapshot('2026-10-15T00:00:00Z'), async () => { throw new Error('synthetic failure'); }]) {
    const result = await checkVisionConnection({ now, sourceReader: { read } });
    assert.equal(result.mode, 'legacy-file');
    assert.equal(result.mesVerified, false);
    assert.match(result.scope, /当前门户不读取此文件/);
  }
});
