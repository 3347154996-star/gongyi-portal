'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('../lib/vendor/xlsx.cjs');
const JSZip = require('../public/tools/vendor/jszip.min.js');
const { parsePenetrationWorkbook, parseDate, classifyResult } = require('../lib/penetration-parser.cjs');

const feedbackHeaders = ['序号', '日期', '线体', '全切件钢印码', '产品名称', '不合格编号', '不合格现象', '是否关键焊缝', '原件复切结果', '补切件钢印码', '补切结果'];
const initialHeaders = ['序号', '日期', '产品名称/线体', '钢印码', '熔深编号', '编号位置图', '实验判定', '熔深图片', '缺陷描述', '缺陷等级', '间隙大小', '复切结果', '调试结果'];
function workbook(sheets, format = 'xlsx') {
  const book = XLSX.utils.book_new();
  for (const [name, rows, configure] of sheets) {
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    configure?.(sheet);
    XLSX.utils.book_append_sheet(book, sheet, name);
  }
  return XLSX.write(book, { type: 'buffer', bookType: format === 'xls' ? 'biff8' : 'xlsx' });
}
function parse(buffer, category = 'full', extra = {}) { return parsePenetrationWorkbook({ buffer, category, year: 2026, month: 10, ...extra }); }

test('feedback batches inherit only their own metadata; recuts do not replace initial defects', () => {
  const result = parse(workbook([['反馈', [
    feedbackHeaders,
    [null, '2026.10.2', '合成线A', 'TRACE-1', '样例产品A'],
    [1, null, null, null, null, 'W01', '熔深不足', '/', '合格', null, 'NG2'],
    [2, null, null, null, null, 'W02', '气孔', '/', null, null, '合格'],
    feedbackHeaders,
    [null, '2026.10.3', '合成线B', 'TRACE-2', '样例产品B'],
    [1, null, null, null, null, 'W01', '咬边'],
  ], sheet => { sheet['!merges'] = [{ s: { r: 0, c: 5 }, e: { r: 1, c: 5 } }]; }]]));
  assert.equal(result.records.length, 3);
  assert.deepEqual(result.records.map(row => [row.date, row.kind, row.result, row.retest]), [
    ['2026-10-02', 'feedback', 'NG', 'NG'], ['2026-10-02', 'feedback', 'NG', 'OK'], ['2026-10-03', 'feedback', 'NG', null],
  ]);
  assert.deepEqual(result.records[0].retests, [{ stage: 'recut', result: 'OK' }, { stage: 'supplemental', result: 'NG' }]);
  assert.equal(result.records[2].product, '合成线B / 样例产品B');
  assert.equal(result.unit, '焊缝记录');
});

test('legacy XLS feedback accepts the exact nonconforming penetration-number header', () => {
  for (const format of ['xls', 'xlsx']) {
    const legacy = feedbackHeaders.map(value => value === '不合格编号' ? '不合格熔深编号' : value);
    const parsed = parse(workbook([['合成旧版', [
      legacy,
      [null, '2026.10.2', '合成线', 'TRACE-LEGACY', '合成部件'],
      [1, null, null, null, null, 'W01', '气孔'],
      [null, null, null, null, null, '不合格熔深编号', '不合格现象'],
      [2, null, null, null, null, 'W02', '气孔'],
    ], sheet => { sheet['!merges'] = [5, 6].map(column => ({ s: { r: 0, c: column }, e: { r: 1, c: column } })); }]], format));
    assert.equal(parsed.records.length, 1);
    assert.equal(parsed.records[0].point, 'W01');
    assert.equal(parsed.diagnostics.unknownDate, 1);
  }
});

test('initial records distinguish OK/NG1/NG2, unknown tests, and unused numbered templates', () => {
  const result = parse(workbook([['初检', [
    initialHeaders,
    [1, '2026-10-02', '样例产品A', 'TRACE-1', 'W1', null, 'OK'],
    [2, '2026-10-02', '样例产品A', 'TRACE-1', 'W2', null, 'NG\n1', null, '气孔', null, null, 'OK'],
    [3, '2026-10-02', '样例产品A', 'TRACE-1', 'W3', null, ' NG2 '],
    [4, '2026-10-02', '样例产品A', 'TRACE-1', 'W4'],
    [5, '2026-10-02', '样例产品A', null, 'W5'],
    [6, '2026-10-02', '样例产品A', null, 'W6'],
  ], sheet => {
    sheet.F6 = { t: 's', f: '_xlfn.DISPIMG("synthetic-location",1)', v: '位置示意图' };
    sheet.H7 = { t: 's', f: '_xlfn.DISPIMG("synthetic-measurement",1)', v: '实际测量图' };
  }]]), 'bracket');
  assert.deepEqual(result.records.map(row => row.result), ['OK', 'NG', 'NG', null, null]);
  assert.equal(result.records[1].retest, 'OK');
  assert.equal(result.diagnostics.templateRows, 1);
  assert.equal(result.diagnostics.unknownResult, 2);
  assert.equal(result.records.at(-1).trace, '');
  assert.equal(result.diagnostics.weakIdentity, 1);
});

test('old template dates are excluded and invalid explicit dates cannot reuse an older batch', () => {
  const result = parse(workbook([['反馈', [
    feedbackHeaders,
    [1, '2024-05-06', '合成线', 'TRACE', '样例产品', 'W1', '气孔'],
    [2, '2026-10-02', '合成线', 'TRACE', '样例产品', 'W2', '气孔'],
    [3, '2026-02-30', '合成线', 'TRACE', '样例产品', 'W3', '气孔'],
    feedbackHeaders,
    [4, null, '合成线', 'TRACE', '样例产品', 'W4', '气孔'],
  ]]]));
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].point, 'W2');
  assert.equal(result.diagnostics.excludedOtherDates, 1);
  assert.equal(result.diagnostics.unknownDate, 2);
});

test('Excel error cells do not turn unused templates into inspections or fake followup observations', () => {
  for (const format of ['xls', 'xlsx']) {
    const parsed = parse(workbook([['合成错误模板', [
      initialHeaders,
      [1, '2026-10-02', '合成部件', null, 'W1'],
      [2, '2026-10-02', '合成部件', 'TRACE-ERROR', 'W2', null, 'OK'],
      [3, '2026-10-02', '合成部件', 'TRACE-UNKNOWN', 'W3'],
      [4, '2026-10-02', '合成部件', null, 'W4'],
    ], sheet => {
      for (const address of ['D2', 'G2', 'H2', 'I2', 'K2', 'L2', 'M2', 'L3', 'G4', 'L4']) sheet[address] = { t: 'e', v: 42, f: 'NA()' };
      // A real measurement image remains testing evidence even when its cached
      // image function result is an Excel error in readers without DISPIMG.
      sheet.H5 = format === 'xlsx'
        ? { t: 'e', v: 29, f: '_xlfn.DISPIMG("synthetic-measurement",1)' }
        : { t: 's', v: '实际测量图' }; // The BIFF writer cannot encode DISPIMG.
    }]], format), 'bracket');
    assert.equal(parsed.diagnostics.templateRows, 1);
    assert.deepEqual(parsed.records.map(row => [row.point, row.result]), [['W2', 'OK'], ['W3', null], ['W4', null]]);
    assert.ok(parsed.records.every(row => row.retests.length === 0 && row.retest === null));
    assert.equal(parsed.diagnostics.unknownResult, 2);
    assert.equal(parsed.diagnostics.weakIdentity, 1);
  }
});

test('semantic duplicates collapse while contradictory copies become unknown conflicts', () => {
  const same = [initialHeaders, [1, '2026-10-02', '样例产品', 'TRACE', 'W1', null, 'OK']];
  const duplicate = parse(workbook([['原表', same], ['副本', same]]), 'bracket');
  assert.equal(duplicate.records.length, 1);
  assert.equal(duplicate.diagnostics.duplicateRecords, 1);
  const conflict = parse(workbook([['原表', same], ['副本', [initialHeaders, [1, '2026-10-02', '样例产品', 'TRACE', 'W1', null, 'NG1']]]]), 'bracket');
  assert.equal(conflict.records.length, 1);
  assert.equal(conflict.records[0].result, null);
  assert.equal(conflict.records[0].conflict, true);
  assert.equal(conflict.diagnostics.conflictingRecords, 1);
});

test('numeric date conventions, serial dates and 1904 workbooks use civil dates', () => {
  assert.equal(parseDate({ t: 'n', v: 46297 }, { year: 2026 }), '2026-10-02');
  assert.equal(parseDate({ t: 'n', v: 1.1, w: '1.10' }, { year: 2026 }), '2026-01-10');
  assert.equal(parseDate({ t: 'n', v: 1.2, w: '1.2' }, { year: 2026 }), '2026-01-02');
  assert.equal(parseDate({ t: 'n', v: 44835 }, { year: 2026, date1904: true }), '2026-10-02');
  assert.equal(parseDate({ t: 's', v: '2026年10月2日' }, { year: 2026 }), '2026-10-02');
  assert.equal(parseDate({ t: 's', v: '2026.02.30' }, { year: 2026 }), null);
});

test('XLS and cached formulas parse without executing workbook formulas', () => {
  for (const format of ['xls', 'xlsx']) {
    const buffer = workbook([['初检', [initialHeaders, [1, '2026-10-02', '样例产品', 'TRACE', 'W1', null, 'OK']], sheet => { sheet.G2 = { t: 's', f: '"OK"', v: 'OK' }; }]], format);
    const parsed = parse(buffer, 'bracket');
    assert.equal(parsed.records[0].result, 'OK');
    assert.equal(parsed.format, format);
  }
  assert.equal(classifyResult('不合格'), 'NG');
  assert.equal(classifyResult('NG1'), 'NG');
  assert.equal(classifyResult('待复切', { feedback: true }), null);
  assert.equal(classifyResult('待确认的内容'), null);
});

test('large formatted sheet dimensions do not fabricate records or scan all empty rows', async () => {
  const zip = await JSZip.loadAsync(workbook([['大范围', [initialHeaders, [1, '2026-10-02', '样例产品', 'TRACE', 'W1', null, 'OK']]]]));
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  zip.file('xl/worksheets/sheet1.xml', xml.replace(/<dimension ref="[^"]*"\/>/, '<dimension ref="A1:U1048576"/>'));
  const parsed = parse(await zip.generateAsync({ type: 'nodebuffer' }), 'bracket');
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.diagnostics.templateRows, 0);
});

test('unrecognized sheets and invalid containers fail safely without exposing names', () => {
  const parsed = parse(workbook([['合成说明页', [['合成说明', 12], ['图片占位']]]]));
  assert.equal(parsed.records.length, 0);
  assert.equal(parsed.diagnostics.unsupportedSheets, 1);
  assert.throws(() => parse(Buffer.from('not a workbook')), /仅支持有效/);
});

test('only verified full-cut detail report layouts are recognized and excluded from statistics', () => {
  const report = (variant, configure) => ['合成附件-' + variant, [
    ['Test result 结果'], ['Part name（零件名称）：合成部件；报告日期：2026.10.2'],
    variant === 'multi' ? ['工位', 'NO 序号'] : ['序号', '位置示意图'],
    [], [], ['W01', null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'OK'],
  ], sheet => {
    if (variant === 'multi') sheet.P3 = { t: 's', v: 'judge 判定' };
    else sheet[variant === 'O' ? 'O4' : 'P4'] = { t: 's', v: '结果判定' };
    configure?.(sheet);
  }];
  const sheets = [report('O'), report('P'), report('multi'), ['合成封面', [['附件说明']]]];
  const parsed = parse(workbook(sheets));
  assert.equal(parsed.records.length, 0);
  assert.equal(parsed.diagnostics.supportingSheets, 3);
  assert.equal(parsed.diagnostics.supportingWorkbooks, 1);
  assert.equal(parsed.diagnostics.unsupportedSheets, 1);
  assert.equal(parsed.diagnostics.supportedSheets, 0);
  const otherCategory = parse(workbook([report('P')]), 'bracket');
  assert.equal(otherCategory.diagnostics.supportingSheets, 0);
  for (const missing of ['A1', 'A2', 'A3', 'B3', 'P4']) {
    const unsupported = parse(workbook([report('P', sheet => { delete sheet[missing]; })]));
    assert.equal(unsupported.diagnostics.supportingSheets, 0, missing);
    assert.equal(unsupported.diagnostics.unsupportedSheets, 1, missing);
  }
  const mixed = parse(workbook([...sheets, ['合成反馈', [feedbackHeaders, [1, '2026-10-02', '合成线', 'TRACE', '合成部件', 'W01', '气孔']]]]));
  assert.equal(mixed.records.length, 1);
  assert.equal(mixed.records[0].kind, 'feedback');
  assert.equal(mixed.diagnostics.supportingSheets, 3);
  assert.equal(mixed.diagnostics.supportingWorkbooks, 0);
});
