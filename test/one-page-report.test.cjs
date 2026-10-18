'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const report = require('../public/one-page-report.js');
const loadedAt = '2026-10-16T03:00:00.000Z', generatedAt = '2026-10-16T04:00:00.000Z';

// Synthetic records only. Pagination intentionally contains fewer records than
// the server aggregates, to detect accidental page-based reporting.
function weld() {
  return { kind: 'weld', account: 'fixture-user', loadedAt, sourceUpdatedAt: '2026-10-15 17:20:00', query: { start: '2026-10-01', end: '2026-10-15', materialName: '合成试件', line: '试制线', defects: ['合成缺陷'], page: 4, size: 20 }, report: { overview: { recordCount: 100, pieceCount: 40, defectTypeCount: 8, recordsPerPiece: 999 }, source: { complete: true }, records: [{ id: 'page-only' }], defectSummary: Array.from({ length: 8 }, (_, index) => ({ defect: '合成缺陷 ' + index, recordCount: index + 1 })), topLocations: [{ location: '合成位置', recordCount: 20, share: .99 }], dailyTrend: [{ date: '2026-10-01', recordCount: 70, pieceCount: 30, complete: true }, { date: '2026-10-02', recordCount: 30, pieceCount: 30, complete: true }] } };
}
function vision() {
  return { kind: 'vision', account: 'fixture-user', loadedAt, query: { start: '2026-10-01T08:30', end: '2026-10-15T21:00', part: 'Front11', result: 'all', lineId: 'line-demo', deviceId: 'fixture-device', recentLimit: '100' }, report: { summary: { totalRecords: 100, eligibleRecords: 96, okRecords: 90, ngRecords: 6, conflictRecords: 4, passRate: 90 / 96 }, source: { state: 'ready', updatedAt: '2026-10-16T02:30:00Z' }, selection: { matchedRecords: 500, selectedRecords: 100, recentLimit: 100 }, records: [{ sourceResult: 'NG' }], dailyTrend: [{ date: '2026-10-01', totalRecords: 10, eligibleRecords: 10, okRecords: 9, ngRecords: 1, conflictRecords: 0, passRate: .9 }, { date: '2026-10-02', totalRecords: 90, eligibleRecords: 86, okRecords: 81, ngRecords: 5, conflictRecords: 4, passRate: 81 / 86 }] } };
}

test('weld reports use aggregate counts and declared denominator, never current page or supplied shares', () => {
  const input = weld(), model = report.createModel(input, {}, generatedAt);
  assert.equal(model.metrics[0].value, '100');assert.equal(model.metrics[1].value, '40');assert.equal(model.metrics[2].value, '2.50');
  assert.equal(model.tops[1].items[0].share, .2);
  assert.equal(model.tops[0].items.length, 5);assert.equal(model.tops[0].items[0].count, 8);
  assert.match(model.notes.join(''), /不良率/);assert.match(model.notes.join(''), /未列出项仍计入总数/);
  input.report.overview.recordCount = 12345;input.report.defectSummary[7].defect = '后续更新';input.query.materialName = '未应用的草稿';
  assert.equal(model.metrics[0].value, '100');assert.equal(model.scope[1][1], '合成试件');assert.equal(model.tops[0].items[0].name, '合成缺陷 7');
});

test('vision exports preserve result filters, recent sample limit and conflict denominator', () => {
  const input = vision(), model = report.createModel(input, {}, generatedAt), html = report.renderDocument(model);
  assert.equal(model.metrics[3].value, '93.8%');assert.equal(model.distribution[0].share, .9);assert.equal(model.eligible, 96);
  assert.match(model.scope.map(item => item.join(':')).join(';'), /最近 100 条/);
  assert.match(model.notes.join(''), /匹配 500 条.*选入 100 条/);assert.match(model.notes.join(''), /未提供全范围测点汇总/);
  assert.ok(html.includes('2026-10-01 08:30'));assert.ok(html.includes('2026-10-15 21:00'));
  assert.doesNotMatch(html, /page-only/);
});

test('trend consolidation preserves all log totals and unknown coverage without summing distinct pieces', () => {
  const input = weld();
  input.report.dailyTrend = Array.from({ length: 23 }, (_, i) => ({ date: '2026-10-' + String(i + 1).padStart(2, '0'), recordCount: i, pieceCount: 1, complete: i !== 2 }));
  input.report.dailyTrend[4].recordCount = null;
  const model = report.createModel(input);
  assert.ok(model.trend.length <= report.TREND_LIMIT);
  assert.equal(model.trend.reduce((sum, point) => sum + (point.value || 0), 0), 249);
  assert.equal(model.trend[0].partial, true);assert.equal(model.trend[1].partial, true);
  assert.equal(model.trend[0].pieceCount, undefined);
  input.report.dailyTrend = [{ date: '2026-10-01', recordCount: null, complete: false }];
  const unknown = report.createModel(input);assert.equal(unknown.trend[0].value, null);assert.match(report.renderDocument(unknown), /opr-weld-gap/);
});

test('vision merged trends weight by counts and preserve unknown rates', () => {
  const input = vision();
  input.report.dailyTrend = Array.from({ length: 9 }, (_, i) => ({ date: '2026-10-' + String(i + 1).padStart(2, '0'), totalRecords: i ? 100 : 1, eligibleRecords: i ? 100 : 1, okRecords: i ? 100 : 0, ngRecords: i ? 0 : 1, conflictRecords: 0, passRate: i ? 1 : 0 }));
  let model = report.createModel(input);
  assert.equal(model.trend[0].value, 100 / 101);assert.notEqual(model.trend[0].value, .5);
  input.report.dailyTrend[0].passRate = null;
  model = report.createModel(input);assert.equal(model.trend[0].value, null);
  input.report.summary.passRate = null;
  assert.equal(report.createModel(input).metrics[3].value, '—');
});

test('zero detection denominator remains unknown, never 0% or 100%', () => {
  const input = vision();input.report.summary = { totalRecords: 3, eligibleRecords: 0, okRecords: 0, ngRecords: 0, conflictRecords: 3, passRate: null };
  input.report.dailyTrend = [{ date: '2026-10-01', totalRecords: 3, eligibleRecords: 0, okRecords: 0, ngRecords: 0, conflictRecords: 3, passRate: null }];
  const model = report.createModel(input);assert.equal(model.metrics[3].value, '—');assert.equal(model.trend[0].value, null);assert.equal(model.distribution[2].share, 1);
});

test('required aggregate fields, loaded snapshots, pending sources and contradictory rates are rejected', () => {
  for (const change of [input => { delete input.query; }, input => { input.loadedAt = 'invalid'; }, input => { input.report.summary.totalRecords++; }, input => { input.report.summary.passRate = .1; }, input => { input.report.scope = { pending: true }; }, input => { delete input.report.summary; }]) {
    const input = vision();change(input);assert.equal(report.canOpen(input), false);assert.throws(() => report.createModel(input));
  }
  const input = weld();input.report.overview.pieceCount = 101;assert.equal(report.canOpen(input), false);
});

test('untrusted labels, filters, notes and author cannot inject markup, scripts or styles', () => {
  const attack = '</style><script>alert("x")</script><img src=x onerror="bad()">&\'"';
  const input = weld();input.query.materialName = attack;input.query.keyword = attack;input.report.defectSummary[7].defect = attack;input.warning = attack;
  const model = report.createModel(input, { reportDepartment: attack, reportAuthor: attack }), html = report.renderDocument(model);
  assert.doesNotMatch(html, /<script|<img|onerror="bad\(\)"/);assert.match(html, /&lt;script&gt;/);assert.match(html, /&quot;/);assert.match(html, /&#39;/);
  assert.equal((html.match(/<style>/g) || []).length, 1);assert.equal((html.match(/<\/style>/g) || []).length, 1);
  assert.match(html, /default-src 'none'/);assert.doesNotMatch(html, /<link|<iframe|<form/);
});

test('one-page layout caps ranking and trend size; excessive filters fail instead of silent truncation', () => {
  const input = weld();input.report.defectSummary = Array.from({ length: 200 }, (_, i) => ({ defect: '合成名称'.repeat(100), recordCount: i }));
  input.report.topLocations = input.report.defectSummary.map(item => ({ ...item, location: item.defect }));
  input.report.dailyTrend = Array.from({ length: 366 }, (_, i) => ({ date: '合成日期' + i, recordCount: i, complete: true }));
  const model = report.createModel(input), html = report.renderDocument(model);
  assert.equal(model.tops.length, 2);assert.equal(model.tops[0].items.length, 5);assert.equal(model.tops[1].items.length, 5);assert.ok(model.trend.length <= 8);
  assert.equal((html.match(/class="opr-sheet"/g) || []).length, 1);assert.equal((html.match(/class="opr-trend-item"/g) || []).length, 8);
  assert.match(html, /size:A4 landscape/);assert.match(html, /第 1 \/ 1 页/);assert.match(html, /--opr-scale:1\.000/);assert.match(report.renderDocument(model, .01), /--opr-scale:0\.780/);
  input.query.defects = ['条件'.repeat(900)];assert.throws(() => report.createModel(input), /无法排入可读的一页报告/);
});

test('hiding optional source notes cannot hide coverage, sample restrictions or timestamps', () => {
  const input = vision();input.report.source.state = 'waiting';input.report.source.message = '合成采集状态';input.warning = '可选备注';
  const model = report.createModel(input, { reportShowSource: false }, generatedAt), html = report.renderDocument(model);
  assert.match(html, /采集状态需核查/);assert.match(html, /合成采集状态/);assert.match(html, /匹配 500 条/);assert.match(html, /版本冲突 4 条/);assert.match(html, /数据读取：2026\/10\/16 11:00/);assert.match(html, /生成：2026\/10\/16 12:00/);
  assert.doesNotMatch(html, /可选备注|来源记录更新时间：/);
});

test('weld partial-source status survives report preferences and preserves raw device timestamp', () => {
  const input = weld();input.report.source.complete = false;
  let model = report.createModel(input, { reportShowSource: false });assert.equal(model.coverageWarning, true);assert.match(report.renderDocument(model), /数据可能不完整/);
  model = report.createModel(input);assert.equal(model.updatedAt, '2026-10-15 17:20:00');
  input.sourceUpdatedAt = '2026-10-15';assert.equal(report.createModel(input).updatedAt, '2026-10-15');
});

test('report author uses explicit preferences, then current display name, then account', () => {
  const input = weld();input.author = '合成姓名';
  assert.equal(report.createModel(input, { reportAuthor: '指定编制人' }).author, '指定编制人');
  assert.equal(report.createModel(input, { reportAuthor: '  ' }).author, '合成姓名');
  delete input.author;assert.equal(report.createModel(input).author, 'fixture-user');
});

test('account change and expiry clear preview contents, retained snapshot and export actions', () => {
  const events = {}, frame = { srcdoc: '', addEventListener() {} }, button = { disabled: true, addEventListener() {}, focus() {} }, status = { textContent: '' };
  const dialog = { open: false, innerHTML: '', setAttribute() {}, addEventListener(name, callback) { events['dialog:' + name] = callback; }, showModal() { this.open = true; }, close() { this.open = false; }, querySelector(selector) { return selector === 'iframe' ? frame : selector.includes('status') || selector.includes('Title') ? status : button; }, querySelectorAll() { return [button]; } };
  const document = { activeElement: button, body: { append() {} }, createElement(tag) { assert.equal(tag, 'dialog');return dialog; }, addEventListener(name, callback) { events[name] = callback; } };
  const context = { document, Intl, Date, setTimeout, PortalPreferences: { get: () => ({}) } };
  vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../public/one-page-report.js'), 'utf8'), context);
  const api = context.PortalReport;
  api.setContext('fixture-user');assert.equal(api.open(weld()), true);assert.equal(dialog.open, true);assert.ok(frame.srcdoc.includes('合成试件'));
  api.setContext('other-user');assert.equal(dialog.open, false);assert.ok(!frame.srcdoc.includes('合成试件'));assert.throws(() => api.open(weld()), /登录状态已变化/);
  api.setContext('fixture-user');api.open(weld());events['portal:session-expired']();assert.equal(dialog.open, false);assert.ok(!frame.srcdoc.includes('合成试件'));assert.throws(() => api.open(weld()), /登录状态已变化/);
});

test('company week badge uses Friday to Thursday only and line grouping preserves totals', () => {
  const input = weld();input.query.start = '2026-10-02';input.query.end = '2026-10-08';
  input.report.lineSummary = Array.from({ length: 7 }, (_, i) => ({ line: '合成' + (i + 1) + '线', recordCount: 10 }));
  input.report.topLocations = [{ location: '合成位置', recordCount: 14, byLine: input.report.lineSummary.map(row => ({ line: row.line, count: 2 })) }];
  const model = report.createModel(input);assert.equal(model.periodLabel, '2026 · KW41 公司周');
  assert.equal(model.lines.length, 6);assert.equal(model.lines.at(-1).name, '其他线体');assert.equal(model.locations[0].byLine.at(-1).count, 4);
  assert.equal(model.locations[0].byLine.reduce((sum, item) => sum + item.count, 0), 14);
  input.query.start = '2026-10-05';input.query.end = '2026-10-11';assert.equal(report.createModel(input).periodLabel, '');
});

test('vision report uses aggregate point denominators and copies context without raw detection data', () => {
  const input = vision();input.report.analysis = { coverage: { deviceCount: 2, partCount: 1, firstMeasuredAt: '2026-10-01T10:00:00', lastMeasuredAt: '2026-10-15T20:00:00' }, measurementSummary: { ngCount: 4, unknownCount: 2, items: [{ name: '汇总测点', deviceId: '设备甲', partName: '型号乙', ngCount: 4, eligibleCount: 20, unknownCount: 2, ngRate: .99 }] }, partSummary: [{ partName: '型号乙', totalRecords: 100, eligibleRecords: 96, okRecords: 90, ngRecords: 6 }], deviceSummary: [{ deviceId: '设备甲', totalRecords: 100, eligibleRecords: 96, okRecords: 90, ngRecords: 6 }] };
  const model = report.createModel(input), html = report.renderDocument(model);
  assert.equal(model.pointSummary.items[0].share, .2);assert.equal(model.pointSummary.items[0].context, '型号乙 / 设备甲');
  assert.equal(model.trend.reduce((sum, item) => sum + item.total, 0), 100);assert.match(html, /检测量与合格率/);assert.match(html, /有效判定/);assert.match(html, /未判定 2 次/);
  input.report.analysis.measurementSummary.items[0].name = '随后改变';assert.equal(model.pointSummary.items[0].name, '汇总测点');
  assert.doesNotMatch(html, /page-only|serialNumber/);
});

test('long-range weld reports retain all selected days instead of the last-five-week dashboard series', () => {
  const input = weld();input.query.start = '2026-01-01';input.query.end = '2026-03-31';
  input.report.overview.recordCount = 90;
  input.report.dailyTrend = Array.from({ length: 90 }, (_, index) => ({ date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10), recordCount: 1, pieceCount: 1, complete: true }));
  // The dashboard series is intentionally confined to five weeks. It must not
  // substitute for the selected-range series merely because the range is long.
  input.report.trend = Array.from({ length: 5 }, (_, index) => ({ startDate: '2026-03-' + String(index * 7 + 1).padStart(2, '0'), label: '近五周-' + index, recordCount: 999, complete: true }));
  const model = report.createModel(input);
  assert.equal(model.trendTitle, '所选范围 · 数量与平均补焊点');
  assert.equal(model.trend.reduce((sum, item) => sum + item.value, 0), 90);
  assert.match(model.trend[0].label, /^2026-01-01/);
  assert.match(model.trend.at(-1).label, /2026-03-31$/);
  assert.ok(model.trend.length <= report.TREND_LIMIT);
  assert.doesNotMatch(report.renderDocument(model), /近五周-|999/);
});

test('weld exported average line uses daily denominators and supports values above one', () => {
  const input = weld();input.report.dailyTrend[0].recordsPerPiece = 999;
  const model = report.createModel(input), html = report.renderDocument(model);
  assert.equal(model.metrics[2].value, '2.50');assert.equal(model.trend[0].average, 70 / 30);assert.equal(model.trend[1].average, 1);
  assert.equal(model.trend[0].dailyPieceOccurrences, 30);
  assert.equal((html.match(/class="opr-weld-average-dot"/g) || []).length, 2);
  assert.match(html, /class="[^"]*opr-weld-average-value"[^>]*>2\.33<\/text>/);
  assert.match(html, /平均补焊点（条\/件）/);assert.doesNotMatch(html, /NaN|Infinity|>999/);
});

test('merged weld average weights daily piece occurrences without changing whole-period distinct pieces', () => {
  const input = weld();input.report.overview.recordCount = 3;input.report.overview.pieceCount = 1;
  input.report.dailyTrend = Array.from({ length: 9 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2,'0')}`, recordCount: i === 0 ? 2 : i === 1 ? 1 : 0, pieceCount: i < 2 ? 1 : 0, complete: true }));
  let model = report.createModel(input);
  assert.equal(model.metrics[2].value, '3.00');assert.equal(model.trend[0].dailyPieceOccurrences, 2);assert.equal(model.trend[0].average, 1.5);
  assert.match(model.trendNote, /日去重件次.*并非跨日去重件数/);assert.equal(model.trend[1].average, null);
  input.report.dailyTrend[1].recordCount = 100;input.report.dailyTrend[1].pieceCount = 10;
  model = report.createModel(input);assert.equal(model.trend[0].average, 102 / 11);assert.notEqual(model.trend[0].average, 6);
  input.report.dailyTrend[1].pieceCount = 0;assert.equal(report.createModel(input).trend[0].average, null,'a day with logs but no valid piece denominator cannot borrow other days denominators');
});

test('exported weld average breaks across unknown days, zero denominators and invalid dates', () => {
  const input = weld(), counts = [4, null, 0, 3, 2, 5, 1, 1], pieces = [2, null, 0, 0, 1, 1, 1, 2];
  input.report.dailyTrend = counts.map((recordCount, i) => ({ date: `2026-10-${String(i + 1).padStart(2,'0')}`, recordCount, pieceCount: pieces[i], complete: i !== 5 }));
  const model = report.createModel(input), html = report.renderDocument(model);
  assert.deepEqual(model.trend.map(point => point.average), [2, null, null, null, 2, 5, 1, null]);
  assert.equal((html.match(/class="opr-weld-average-dot"/g) || []).length, 4);
  const line = html.match(/class="opr-weld-average-line" d="([^"]*)"/)[1];assert.equal((line.match(/ M /g) || []).length, 2);assert.equal((line.match(/ L /g) || []).length, 2);
  assert.match(html, />5\*<\/text>/);assert.doesNotMatch(html, /NaN|Infinity/);
  input.report.dailyTrend[0].date = '';assert.equal(report.createModel(input).trend[0].average, null);
  input.report.dailyTrend[0].date = '2026-02-30';assert.equal(report.createModel(input).trend[0].average, null);
});
