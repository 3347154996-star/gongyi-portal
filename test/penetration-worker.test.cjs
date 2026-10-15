'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const XLSX = require('../lib/vendor/xlsx.cjs');
const JSZip = require('../public/tools/vendor/jszip.min.js');
const { scan } = require('../lib/penetration-worker.cjs');
const { readSpreadsheetBuffer } = require('../lib/spreadsheet-read.cjs');
const { createPenetrationService } = require('../lib/penetration.cjs');
const { PARSER_VERSION } = require('../lib/penetration-parser.cjs');

const fullFolder = '全切熔深新版反馈汇总表';
const bracketFolder = '快切支架熔深新版反馈汇总表';
const headings = ['序号', '日期', '线体', '全切件钢印码', '产品名称', '不合格编号', '不合格现象', '是否关键焊缝', '原件复切结果'];
async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'portal-penetration-worker-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(root)), parent);
    assert.ok(path.basename(root).startsWith('portal-penetration-worker-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, fullFolder));
  await fs.mkdir(path.join(root, bracketFolder));
  return root;
}
function workbook(trace = 'SYNTHETIC-TRACE', retest = null, date = '2026-10-02', format = 'xlsx') {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    headings, [1, date, '合成线', trace, '合成部件', 'W01', '熔深不足', '/', retest],
  ]), '合成反馈');
  return XLSX.write(book, { type: 'buffer', bookType: format === 'xls' ? 'biff8' : 'xlsx' });
}
async function writeFile(root, relative, bytes) {
  const filename = path.join(root, relative);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, bytes);
  return filename;
}

test('empty or unrecognized month directories reject instead of replacing an earlier snapshot with zero', async t => {
  const root = await fixture(t);
  const previous = { earlier: { category: 'full', month: 10, records: [{ key: 'synthetic-earlier' }] } };
  await assert.rejects(scan({ directory: root, year: 2026, previous }), /empty|unavailable/);
  await writeFile(root, path.join(fullFolder, '13月', 'outside.xlsx'), workbook());
  await writeFile(root, path.join(fullFolder, 'unrecognized', 'outside.xlsx'), workbook());
  await assert.rejects(scan({ directory: root, year: 2026, previous }), /empty|unavailable/);
  assert.equal(previous.earlier.records.length, 1);
});

test('a failed subtree retains only that subtree and cannot overwrite a successfully refreshed sibling', async t => {
  const root = await fixture(t);
  const good = path.join(fullFolder, '10月', 'a-readable');
  const blocked = path.join(fullFolder, '10月', 'b-unreadable');
  const freshFile = await writeFile(root, path.join(good, 'fresh.xlsx'), workbook('FRESH'));
  const removedFile = await writeFile(root, path.join(good, 'removed.xlsx'), workbook('REMOVED'));
  await writeFile(root, path.join(blocked, 'retained.xlsx'), workbook('RETAINED'));
  const earlier = await scan({ directory: root, year: 2026 });
  const freshKey = Object.keys(earlier.files).find(key => earlier.files[key].relativePath.endsWith('fresh.xlsx'));
  const retainedKey = Object.keys(earlier.files).find(key => earlier.files[key].relativePath.endsWith('retained.xlsx'));
  const removedKey = Object.keys(earlier.files).find(key => earlier.files[key].relativePath.endsWith('removed.xlsx'));
  await fs.writeFile(freshFile, workbook('FRESH', '合格'));
  const newTime = new Date(Date.now() + 5000);
  await fs.utimes(freshFile, newTime, newTime);
  await fs.unlink(removedFile);
  const realReaddir = fs.readdir;
  t.mock.method(fs, 'readdir', async (directory, ...args) => {
    if (path.resolve(directory) === path.join(root, blocked)) throw Object.assign(new Error('synthetic denied subtree'), { code: 'EACCES' });
    const entries = await realReaddir(directory, ...args);
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  });
  const result = await scan({ directory: root, year: 2026, previous: earlier.files });
  assert.equal(result.files[freshKey].records[0].retest, 'OK');
  assert.deepEqual(result.files[retainedKey], earlier.files[retainedKey]);
  assert.equal(result.files[removedKey], undefined);
  assert.equal(result.diagnostics.failed, 1);
  assert.equal(result.diagnostics.read, 1);
});

test('recognized months parse XLS and XLSX while lock files and unrelated folders are excluded', async t => {
  const root = await fixture(t);
  await writeFile(root, path.join(fullFolder, '1月', 'old.xls'), workbook('JANUARY', null, '2026-01-02', 'xls'));
  await writeFile(root, path.join(fullFolder, '10月', 'current.xlsx'), workbook('OCTOBER'));
  await writeFile(root, path.join(fullFolder, '10月', '~$temporary.xlsx'), Buffer.from('incomplete lock file'));
  await writeFile(root, path.join('验证件', '10月', 'outside.xlsx'), workbook('NOT-IN-SCOPE'));
  const result = await scan({ directory: root, year: 2026 });
  assert.equal(result.diagnostics.files, 2);
  assert.equal(result.diagnostics.failed, 0);
  assert.deepEqual(Object.values(result.files).flatMap(file => file.records.map(row => row.date)).sort(), ['2026-01-02', '2026-10-02']);
  const reused = await scan({ directory: root, year: 2026, previous: result.files });
  assert.equal(reused.diagnostics.reused, 2);
  assert.equal(reused.diagnostics.read, 0);
});

test('an emptied or missing earlier month preserves its records while other months refresh', async t => {
  const root = await fixture(t);
  const earlierFile = await writeFile(root, path.join(fullFolder, '1月', 'earlier.xlsx'), workbook('JANUARY', null, '2026-01-02'));
  const currentFile = await writeFile(root, path.join(fullFolder, '10月', 'current.xlsx'), workbook('OCTOBER'));
  const previous = await scan({ directory: root, year: 2026 });
  const earlierKey = Object.keys(previous.files).find(key => previous.files[key].month === 1);
  const currentKey = Object.keys(previous.files).find(key => previous.files[key].month === 10);
  await fs.unlink(earlierFile);
  await fs.writeFile(currentFile, workbook('OCTOBER', '合格'));
  const newTime = new Date(Date.now() + 5000);
  await fs.utimes(currentFile, newTime, newTime);
  const emptied = await scan({ directory: root, year: 2026, previous: previous.files });
  assert.deepEqual(emptied.files[earlierKey], previous.files[earlierKey]);
  assert.equal(emptied.files[currentKey].records[0].retest, 'OK');
  assert.equal(emptied.diagnostics.failed, 1);
  assert.equal(emptied.diagnostics.incompleteGroups, 1);
  await fs.rmdir(path.dirname(earlierFile));
  const missing = await scan({ directory: root, year: 2026, previous: emptied.files });
  assert.deepEqual(missing.files[earlierKey], previous.files[earlierKey]);
  assert.equal(missing.diagnostics.failed, 1);
  assert.equal(missing.diagnostics.incompleteGroups, 1);
});

test('an older parser entry is reparsed even if source size and mtime did not change', async t => {
  const root = await fixture(t);
  await writeFile(root, path.join(fullFolder, '10月', 'current.xlsx'), workbook());
  const original = await scan({ directory: root, year: 2026 });
  const [key, oldEntry] = Object.entries(original.files)[0];
  const previous = { [key]: { ...oldEntry, version: PARSER_VERSION - 1, records: [{ ...oldEntry.records[0], result: 'OK' }] } };
  const updated = await scan({ directory: root, year: 2026, previous });
  assert.equal(updated.diagnostics.reused, 0);
  assert.equal(updated.diagnostics.read, 1);
  assert.equal(updated.files[key].version, PARSER_VERSION);
  assert.equal(updated.files[key].records[0].result, 'NG');
  assert.equal(previous[key].version, PARSER_VERSION - 1);
});

test('an unsupported workbook is a failed source, retaining its earlier valid entry', async t => {
  const root = await fixture(t);
  const filename = await writeFile(root, path.join(fullFolder, '10月', 'source.xlsx'), workbook());
  const previous = await scan({ directory: root, year: 2026 });
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['只有说明，没有已识别检测表头']]), '说明');
  await fs.writeFile(filename, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  const result = await scan({ directory: root, year: 2026, previous: previous.files });
  assert.equal(result.diagnostics.failed, 1);
  assert.deepEqual(result.files, previous.files);
});

test('verified supporting reports are cached as intentionally excluded sources without scan failure', async t => {
  const root = await fixture(t);
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Test result 结果'], ['Part name（零件名称）：合成部件；报告日期：2026.10.2'],
    ['序号', '位置示意图'], [], [], ['W01'],
  ]);
  sheet.P4 = { t: 's', v: '结果判定' }; sheet.P6 = { t: 's', v: 'OK' }; sheet['!ref'] = 'A1:P6';
  XLSX.utils.book_append_sheet(book, sheet, '合成报告');
  await writeFile(root, path.join(fullFolder, '10月', 'report.xlsx'), XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  const parsed = await scan({ directory: root, year: 2026 });
  assert.equal(parsed.diagnostics.read, 1);
  assert.equal(parsed.diagnostics.failed, 0);
  const entry = Object.values(parsed.files)[0];
  assert.equal(entry.records.length, 0);
  assert.equal(entry.diagnostics.supportingSheets, 1);
  assert.equal(entry.diagnostics.supportingWorkbooks, 1);
  assert.equal(entry.version, PARSER_VERSION);
  const reused = await scan({ directory: root, year: 2026, previous: parsed.files });
  assert.equal(reused.diagnostics.reused, 1);
});

test('photo-free ZIP output has fixed timestamps and stable bytes for repeat reads', async t => {
  const root = await fixture(t);
  const zip = await JSZip.loadAsync(workbook());
  zip.file('xl/media/synthetic.png', Buffer.alloc(1024 * 1024, 37));
  const filename = await writeFile(root, 'photos.xlsx', await zip.generateAsync({ type: 'nodebuffer' }));
  const first = await readSpreadsheetBuffer(filename);
  const second = await readSpreadsheetBuffer(filename);
  assert.deepEqual(first, second);
  const decoded = await JSZip.loadAsync(first);
  assert.equal(decoded.file('xl/media/synthetic.png'), null);
  for (const entry of Object.values(decoded.files)) assert.equal(entry.date.toISOString(), '1980-01-01T00:00:00.000Z');
  assert.ok(first.length < 100000);
});

test('failed scan checkpoints are reusable but never published as the current report', async t => {
  const root = await fixture(t);
  const entry = { version: PARSER_VERSION, fingerprint: 'synthetic-fingerprint', category: 'bracket', month: 10, records: [{ key: 'synthetic-record', date: '2026-10-02', product: '合成部件', category: 'bracket', kind: 'initial', result: 'OK', retest: null }], productNames: ['合成部件'], diagnostics: {} };
  const settings = { root, config: { penetration: { directory: root, year: 2026 } } };
  const failed = createPenetrationService({ ...settings, scanner(_input, progress) {
    progress({ key: 'synthetic-file', entry, files: 1, read: 1, failed: 0 });
    return { promise: Promise.reject(new Error('synthetic scan interruption')) };
  } });
  t.after(() => failed.stop());
  await failed.sync();
  assert.equal(failed.report().summary.total, 0);
  assert.equal(failed.status().lastSuccessAt, null);
  assert.ok((await fs.stat(path.join(root, 'runtime', 'penetration', 'pending.json'))).isFile());
  let received;
  const resumed = createPenetrationService({ ...settings, scanner(input) {
    received = input.previous;
    return { promise: Promise.resolve({ files: { 'synthetic-file': input.previous['synthetic-file'] }, diagnostics: { files: 1, reused: 1, failed: 0 } }) };
  } });
  t.after(() => resumed.stop());
  assert.equal(resumed.report().summary.total, 0);
  await resumed.sync();
  assert.deepEqual(received['synthetic-file'], entry);
  assert.equal(resumed.report().summary.total, 1);
  await assert.rejects(fs.stat(path.join(root, 'runtime', 'penetration', 'pending.json')), { code: 'ENOENT' });
});

test('late progress and completion after stop cannot write either checkpoint or business cache', async t => {
  const root = await fixture(t);
  let emit, complete;
  const service = createPenetrationService({ root, config: { penetration: { directory: root, year: 2026 } }, scanner(_input, progress) {
    emit = progress;
    return { promise: new Promise(resolve => { complete = resolve; }), cancel() {} };
  } });
  t.after(() => service.stop());
  const pending = service.sync();
  service.stop();
  for (let index = 0; index < 10; index++) emit({ key: 'late-' + index, entry: { records: [] }, files: index + 1, read: index + 1, failed: 0 });
  complete({ files: {}, diagnostics: { files: 10, read: 10, failed: 0 } });
  await pending;
  assert.equal(service.report().summary.total, 0);
  for (const name of ['pending.json', 'cache.json']) await assert.rejects(fs.stat(path.join(root, 'runtime', 'penetration', name)), { code: 'ENOENT' });
});
