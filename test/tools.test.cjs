'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createToolsService } = require('../lib/tools.cjs');
const JSZip = require('../public/tools/vendor/jszip.min.js');
const root = path.join(__dirname, '../public/tools');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('tools manifest and schemas describe working local entries, and remote adapters stay disabled', () => {
  const service = createToolsService(), manifest = service.manifest();
  assert.equal(manifest.uploadsEnabled, false);
  assert.deepEqual(manifest.tools.map(t => t.id), ['weld-export', 'measurement-compare']);
  for (const tool of manifest.tools) {
    assert.ok(fs.existsSync(path.join(root, tool.entry.replace('/tools/', ''))));
    const contract = service.contract(tool.id);
    assert.equal(contract.version, '1.0.0'); assert.equal(contract.remoteAdapter.enabled, false);
    assert.equal(contract.inputSchema.type, 'object'); assert.equal(contract.outputSchema.type, 'object');
    assert.throws(() => service.runRemote(tool.id), error => error.statusCode === 501 && error.code === 'tool_adapter_disabled');
  }
  manifest.tools[0].remote.enabled = true;
  assert.equal(service.manifest().tools[0].remote.enabled, false);
  assert.throws(() => service.contract('__proto__'), error => error.statusCode === 404);
  assert.throws(() => service.runRemote('missing'), error => error.statusCode === 404);
});

test('tool entry assets load from same origin with no executable inline scripts or handlers', () => {
  for (const id of ['weld-export', 'measurement-compare']) {
    const html = read(`${id}/index.html`);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
    assert.doesNotMatch(read(`${id}/app.js`), /\son(?:click|change|load|error)\s*=\s*['"]/i);
    for (const script of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (/application\/json/.test(script[1])) { assert.equal(JSON.parse(script[2]), null); continue; }
      assert.match(script[1], /src=/); assert.equal(script[2].trim(), '');
    }
    for (const match of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/g)) {
      assert.doesNotMatch(match[1], /^https?:|^\/\//);
      assert.ok(fs.existsSync(path.resolve(root, id, match[1])), match[1]);
    }
  }
});

function weldContext() {
  const nodes = new Map(), get = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, innerHTML: '', textContent: '', disabled: false, style: {}, addEventListener() {}, click() {}, scrollIntoView() {}, classList: { add() {}, remove() {} } });
    return nodes.get(id);
  };
  const context = vm.createContext({ window: {}, document: { getElementById: get }, navigator: {}, setTimeout, console });
  vm.runInContext(read('weld-export/app.js'), context);
  return { context, get };
}
const weldText = `MODULE Test\nTASK PERS welddata weld1:=[10,0,[11,0,24,100]];\nPROC WL_DEMO()\n! Synthetic seam <img src=x>\nArcLStart p1,v100,seam1,weld1,fine,tool0;\nArcLEnd p2,v100,seam1,weld1,fine,tool0;\nENDPROC\nENDMODULE`;
const file = (name, content, relativePath = '') => ({ name, size: Buffer.byteLength(content), webkitRelativePath: relativePath, text: async () => content });
test('weld import parses task-specific data and clears stale main calls on subsequent import', async () => {
  const { context, get } = weldContext();
  await context.window.WeldExportTool.importFiles([
    file('MainModule.mod', 'IF DEMO_START=1 THEN\nWL_DEMO;\nENDIF', 'Backup/TASK1/MainModule.mod'),
    file('Test.mod', weldText, 'Backup/TASK1/Test.mod')
  ]);
  let result = context.window.WeldExportTool.getResult();
  assert.equal(result.rowCount, 1); assert.equal(result.rows[0][1], 'TASK1');
  assert.equal(result.rows[0][9], 10); assert.equal(result.rows[0][10], 23.62);
  assert.equal(result.rows[0][12], 24); assert.equal(result.rows[0][13], 236.22);
  assert.match(get('resTable').innerHTML, /&lt;img src=x&gt;/);
  assert.doesNotMatch(get('resTable').innerHTML, /<img src=x>/);
  await context.window.WeldExportTool.importFiles([file('Test.mod', weldText, 'Backup/TASK1/Test.mod')]);
  assert.equal(context.window.WeldExportTool.getResult().rowCount, 0, 'No stale main call from the earlier backup');
  get('showAll').checked = true; context.applyFilter();
  assert.equal(context.window.WeldExportTool.getResult().rowCount, 1);
  context.window.WeldExportTool.reset();
  assert.equal(context.window.WeldExportTool.getResult().rowCount, 0);
});
test('weld input limits preserve prior results and spreadsheet-text exports neutralize formulas', async () => {
  const { context, get } = weldContext();
  await context.window.WeldExportTool.importFiles([{ name: 'large.mod', size: 17 * 1024 * 1024, text: () => { throw Error('must not read'); } }]);
  assert.match(get('impMsg').textContent, /文件过大/);
  assert.equal(context.csvCell('=1+1'), "'=1+1");
  assert.equal(context.csvCell(-2), '-2');
  assert.equal(context.csvCell('a\tb'), '"a\tb"');
});
test('folder traversal reads all directory batches, not just the first browser batch', async () => {
  const { context } = weldContext(); const out = [];
  const entry = n => ({ name: n + '.mod', isFile: true, file: resolve => resolve({ name: n + '.mod' }) });
  const batches = [[entry('first')], [entry('second')], []];
  await context.walk({ isDirectory: true, createReader: () => ({ readEntries: resolve => resolve(batches.shift()) }) }, out, 'TASK1');
  assert.deepEqual(out.map(f => f._wp), ['TASK1/first.mod', 'TASK1/second.mod']);
});

test('local XLSX export produces two readable OOXML sheets and stores formula-like values as text', async () => {
  const context = vm.createContext({ JSZip }); vm.runInContext(read('xlsx-export.js'), context);
  const X = context.XLSX, book = X.utils.book_new();
  X.utils.book_append_sheet(book, X.utils.aoa_to_sheet([['说明', 'Synthetic & safe']]), '说明与汇总');
  X.utils.book_append_sheet(book, X.utils.aoa_to_sheet([['程序', '速度'], ['=1+1', 23.62]]), '焊接参数');
  const zip = await JSZip.loadAsync(await X.toBytes(book));
  assert.match(await zip.file('xl/workbook.xml').async('string'), /焊接参数/);
  const sheet = await zip.file('xl/worksheets/sheet2.xml').async('string');
  assert.match(sheet, /t="inlineStr".*=1\+1/); assert.match(sheet, /<v>23\.62<\/v>/); assert.doesNotMatch(sheet, /<f[ >]/);
  assert.match(await zip.file('xl/worksheets/sheet1.xml').async('string'), /Synthetic &amp; safe/);
});

function compareContext() {
  const context = vm.createContext({});
  const code = read('measurement-compare/core.js').replace('global.MeasureCompareEngine =', 'global.classifyForTest = classify; global.MeasureCompareEngine =');
  vm.runInContext(code, context); return context;
}
function workbook(context, rows, name) {
  const sheet = { name: 'Data', cells: new Map(), rows: new Map() };
  rows.forEach((row, ri) => { const cols = new Map(); row.forEach((v, ci) => { if (v == null) return; const cell = { value: String(v), type: typeof v === 'number' ? 'n' : 's' }; cols.set(ci + 1, cell); sheet.cells.set((ci + 1) + ':' + (ri + 1), cell); }); sheet.rows.set(ri + 1, cols); });
  context.classifyForTest(sheet); return { name, sheets: [sheet], date1904: false };
}
test('measurement matching retains leading-zero SNs, applies nominal offset and excludes missing values', () => {
  const c = compareContext();
  const vision = workbook(c, [['SN', '', '', '00001234'], ['TimeStamp', '', '', '2026-10-15 08:00:00'], ['Name', '', 'Nominal', 'Dev1'], ['1_X', '', 10.05, 0.25], ['1_Y', '', 20, 0.3]], 'Synthetic vision');
  const cmm = workbook(c, [['Item', 'Check Item', 'Nominal', '00001234-10/15'], ['1', 'X', 10, 0.1], ['1', 'Y', 20, null]], 'Synthetic CMM');
  const result = c.MeasureCompareEngine.compare(vision, 'Data', cmm, 'Data');
  assert.equal(result.pairs.length, 1); assert.equal(result.pairs[0].sn, '00001234'); assert.equal(result.items.length, 1);
  assert.ok(Math.abs(result.items[0].pairs[0].diff - 0.2) < 1e-10);
  assert.equal(result.diagnostics.missing_value_count, 1);
  assert.equal(result.diagnostics.nominal_adjustments.length, 1);
});
test('measurement ambiguous CMM duplicates are not silently matched', () => {
  const c = compareContext();
  const vision = workbook(c, [['SN', '', '', '00001234'], ['Name', '', 'Nominal', 'Dev1'], ['1_X', '', 10, 0.25]], 'Synthetic vision');
  const cmm = workbook(c, [['Item', 'Check Item', 'Nominal', '00001234-10/15', '00001234-10/15'], ['1', 'X', 10, 0.1, 0.2]], 'Synthetic CMM');
  const result = c.MeasureCompareEngine.compare(vision, 'Data', cmm, 'Data');
  assert.equal(result.pairs.length, 0); assert.equal(result.diagnostics.ambiguous_cmm_sns.length, 1);
});

test('measurement rejects precision-lost numeric SNs in plain and scientific notation but keeps text SNs', () => {
  for (const value of ['123456789012346000', '1.23456789012346E+17', '1e15', '1E309']) {
    const c = compareContext();
    const vision = workbook(c, [['SN', '', '', value], ['Name', '', 'Nominal', 'Dev1'], ['1_X', '', 10, 0.25]], 'Synthetic vision');
    const cmm = workbook(c, [['Item', 'Check Item', 'Nominal', value], ['1', 'X', 10, 0.1]], 'Synthetic CMM');
    vision.sheets[0].rows.get(1).get(4).type = 'n'; cmm.sheets[0].rows.get(1).get(4).type = 'n';
    const result = c.MeasureCompareEngine.compare(vision, 'Data', cmm, 'Data');
    assert.equal(result.pairs.length, 0, value); assert.equal(result.diagnostics.unsafe_numeric_sns.length, 2, value);
    vision.sheets[0].rows.get(1).get(4).type = 's'; cmm.sheets[0].rows.get(1).get(4).type = 's';
    assert.equal(c.MeasureCompareEngine.compare(vision, 'Data', cmm, 'Data').pairs.length, 1, 'Text identifiers remain exact');
  }
  const c = compareContext(), safe = 999999999999999;
  const vision = workbook(c, [['SN', '', '', safe], ['Name', '', 'Nominal', 'Dev1'], ['1_X', '', 10, 0.25]], 'Synthetic vision');
  const cmm = workbook(c, [['Item', 'Check Item', 'Nominal', safe], ['1', 'X', 10, 0.1]], 'Synthetic CMM');
  assert.equal(c.MeasureCompareEngine.compare(vision, 'Data', cmm, 'Data').pairs.length, 1, '15-digit numeric identifiers remain supported');
});

function zipReaderContext(smallLimits = false) {
  let code = read('measurement-compare/core.js').replace('global.MeasureCompareEngine =', 'global.createZipTextReaderForTest = createZipTextReader; global.MeasureCompareEngine =');
  if (smallLimits) code = code.replace('const MAX_ZIP_ENTRY_BYTES = 100 * 1024 * 1024;', 'const MAX_ZIP_ENTRY_BYTES = 64;').replace('const MAX_ZIP_TOTAL_BYTES = 200 * 1024 * 1024;', 'const MAX_ZIP_TOTAL_BYTES = 100;');
  const c = vm.createContext({ JSZip, TextDecoder, Uint8Array }); vm.runInContext(code, c); return c;
}
function replaceDeclaredSize(buffer, target, size) {
  const bytes = Buffer.from(buffer);
  for (let at = 0; at < bytes.length - 46; at++) {
    if (bytes.readUInt32LE(at) !== 0x02014b50) continue;
    const length = bytes.readUInt16LE(at + 28), name = bytes.subarray(at + 46, at + 46 + length).toString();
    if (name === target) { bytes.writeUInt32LE(size, at + 24); return bytes; }
  }
  throw new Error('Missing ZIP fixture entry');
}
test('measurement ZIP rejects declared oversized entries and aggregate before any XML expansion', async () => {
  const zip = new JSZip(); zip.file('xl/workbook.xml', '<workbook/>'); zip.file('xl/_rels/workbook.xml.rels', '<Relationships/>'); zip.file('unused.xml', 'x');
  const original = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), c = zipReaderContext();
  await assert.rejects(c.MeasureCompareEngine.readWorkbook(replaceDeclaredSize(original, 'unused.xml', 100 * 1024 * 1024 + 1), 'Synthetic.xlsx'), /解压后单个文件超过/);
  let total = replaceDeclaredSize(original, 'xl/workbook.xml', 100 * 1024 * 1024);
  total = replaceDeclaredSize(total, 'xl/_rels/workbook.xml.rels', 100 * 1024 * 1024);
  await assert.rejects(c.MeasureCompareEngine.readWorkbook(total, 'Synthetic.xlsx'), /解压后文件合计超过/);
});
test('measurement ZIP checks actual streamed bytes against limits and directory sizes', async () => {
  const c = zipReaderContext(true), zip = new JSZip(); zip.file('data.xml', 'x'.repeat(128));
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const forged = await JSZip.loadAsync(replaceDeclaredSize(bytes, 'data.xml', 32));
  await assert.rejects(c.createZipTextReaderForTest(forged)(forged.file('data.xml')), /实际展开内容超过|大小不一致/);
  const valid = new JSZip(); valid.file('data.xml', '中文与 numbers 123'); valid.file('empty.xml', '');
  const loaded = await JSZip.loadAsync(await valid.generateAsync({ type: 'nodebuffer' }));
  assert.equal(await c.createZipTextReaderForTest(loaded)(loaded.file('data.xml')), '中文与 numbers 123');
  assert.equal(await c.createZipTextReaderForTest(loaded)(loaded.file('empty.xml')), '');
});

test('extension bridge publishes only bounded counts, copies results, and refuses remote execution', async () => {
  const events = [], context = vm.createContext({ window: { dispatchEvent: e => events.push(e) }, location: { protocol: 'http:' }, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } });
  vm.runInContext(read('bridge.js'), context);
  const bridge = context.window.PortalToolBridge, result = { rows: [[1]] };
  bridge.register('weld-export', { getResult: () => result, importFiles: async () => {}, reset() {} });
  bridge.notify('weld-export', { rowCount: 1, name: 'private.txt', sn: 'private', contents: 'private' });
  assert.equal(events[0].detail.rowCount, 1); assert.equal(events[0].detail.name, undefined); assert.equal(events[0].detail.sn, undefined);
  bridge.getResult('weld-export').rows[0][0] = 9; assert.equal(result.rows[0][0], 1);
  await assert.rejects(bridge.runRemote(), error => error.code === 'tool_adapter_disabled');
});
