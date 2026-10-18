'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const report = require('../public/one-page-report.js');
const loadedAt = '2026-02-04T04:00:00Z';
function row(index, changes = {}) {
  return { recordId: String(index + 1), barcode: 'SYNTHETIC-SN-' + index, measuredAt: '2026-02-03T08:00:00+08:00',
    lineCode: 'SYN-LINE', lineName: '合成检测线体', partCode: 'SYN-PART', partName: '合成物料',
    deviceCode: 'SYN-DEVICE', deviceName: '合成检具', productionLine: '11', result: 'OK', ...changes };
}
function input(records = [row(0), row(1, { result: 'NG', measuredAt: '2026-02-03T08:30:00+08:00' }), row(2, { measuredAt: '2026-02-04T08:00:00+08:00' })]) {
  const ok = records.filter(record => record.result === 'OK').length, ng = records.filter(record => record.result === 'NG').length;
  return { kind: 'vision-mes', account: 'synthetic-user', author: '合成作者', loadedAt, interval: 'auto',
    query: { queryMode: 'time', lineId: '123', start: '2026-02-03T00:00', end: '2026-02-04T23:59', limit: '0', partCode: '', deviceCode: '', result: 'all', barcode: '', productionLine: '' },
    report: { line: { id: '123', name: '合成检测线体' }, records, fetchedAt: loadedAt,
      filters: { queryMode: 'time', lineId: '123', start: '2026-02-03 00:00:00', end: '2026-02-04 12:00:00.123', limit: 0, partCode: '', deviceCode: '', result: 'all', barcode: '', productionLine: '' },
      summary: { total: records.length, ok, ng, unknown: records.length - ok - ng, denominator: ok + ng, passRate: ok + ng ? ok / (ok + ng) * 100 : null },
      coverage: { complete: true, eligibleForLineRate: true }, warnings: [] } };
}

test('MES report verifies the full selection, converts percentage units and ignores page rows or fabricated point summaries', () => {
  const value = input();value.report.page = 2;value.report.rows = [row(99)];value.report.analysis = { measurementSummary: { ngCount: 999, items: [{ name: 'invented-point' }] } };
  const model = report.createModel(value), html = report.renderDocument(model);
  assert.equal(model.total, 3);assert.equal(model.metrics[3].value, '66.7%');
  assert.equal(model.trend.reduce((sum, point) => sum + point.total, 0), 3);
  assert.equal(model.partSummary[0].count, 3);assert.equal(model.deviceSummary[0].count, 3);
  assert.match(html, /未读取本次范围的全部测点明细/);
  assert.doesNotMatch(html, /invented-point|版本冲突|采集最后扫描|ALLmeasure|Front11|已采集/);
  assert.match(html, /未提供全检标识/);assert.match(html, /不能确认已排除全检/);
});

test('report scope uses the frozen effective endpoint in Beijing time rather than the future query end', () => {
  const model = report.createModel(input());
  assert.equal(model.scope.find(([key]) => key === '时间')[1], '2026-02-03 00:00:00 至 2026-02-04 12:00:00');
  assert.doesNotMatch(report.renderDocument(model), /2026-02-04 23:59/);
  assert.match(model.actualCoverage, /2026-02-03 08:00:00.*2026-02-04 08:00:00/);
  assert.match(report.renderDocument(model), /接口读取时间/);
});

test('count mode shows cross-date recent count, read cutoff and actual records, never a hidden history scan boundary', () => {
  const value = input();value.query = { queryMode: 'count', lineId: '123', limit: '500' };
  Object.assign(value.report.filters, { queryMode: 'count', start: '2000-01-01 00:00:00', limit: 500 });
  const model = report.createModel(value), scope = model.scope.map(item => item.join(':')).join(';');
  assert.match(scope, /按数量.*不受日期筛选限制/);assert.match(scope, /最近 500 次检测（实际 3 次）/);
  assert.match(scope, /读取截至:2026-02-04 12:00:00/);assert.match(scope, /本次记录时段:2026-02-03 08:00:00/);
  assert.doesNotMatch(scope, /2000-01-01/);assert.equal(model.periodLabel, '');
  assert.doesNotMatch(model.coverage, /所选时间/);
});

test('barcode, result and ineligible coverage never produce aggregate, trend, material or device rates', () => {
  for (const restrict of [value => { value.query.barcode = 'SYNTHETIC-SN'; },
    value => { value.report.filters.barcode = 'SYNTHETIC-SN'; }, value => { value.query.result = 'NG'; },
    value => { value.report.filters.result = 'NG'; }, value => { value.report.coverage.eligibleForLineRate = false; }]) {
    const value = input();restrict(value);
    const model = report.createModel(value), html = report.renderDocument(model);
    assert.equal(model.metrics[3].value, '—');assert.equal(model.rateSuppressed, true);
    assert.ok(model.trend.every(point => point.value === null));assert.ok(model.partSummary.every(item => item.share === null));
    assert.ok(model.deviceSummary.every(item => item.share === null));
    assert.doesNotMatch(html, /class="opr-chart-rate"|<th>合格率<\/th>/);
    assert.match(html, /构成百分比不是整线合格率/);
  }
});

test('unknown judgments and null source rates stay unknown without filling zero or recalculating a rate', () => {
  const value = input([row(0, { result: null })]);value.report.coverage.eligibleForLineRate = false;
  const model = report.createModel(value);
  assert.equal(model.distribution[2].count, 1);assert.equal(model.metrics[3].value, '—');assert.equal(model.trend[0].value, null);
  const missingRate = input();missingRate.report.summary.passRate = null;
  assert.equal(report.createModel(missingRate).metrics[3].value, '—');
  const zero = input([row(0, { result: 'NG' })]);assert.equal(report.createModel(zero).metrics[3].value, '0.0%');
});

test('incomplete, empty, paginated, contradictory, duplicate or malformed snapshots cannot be exported', () => {
  const mutations = [value => { value.report.coverage.complete = false; }, value => { delete value.report.coverage.complete; },
    value => { value.report.records = []; }, value => { value.report.records.pop(); }, value => { value.report.summary.ok++; },
    value => { value.report.summary.passRate = 2 / 3; }, value => { value.report.summary.passRate = Infinity; },
    value => { value.report.records[1].recordId = value.report.records[0].recordId; },
    value => { value.report.records[0].measuredAt = '2026-02-30T12:00:00'; }, value => { value.report.records[0].result = 'PASS'; },
    value => { value.interval = '7'; }, value => { value.loadedAt = 'not-a-date'; }];
  for (const mutate of mutations) { const value = input();mutate(value);assert.equal(report.canOpen(value), false);assert.throws(() => report.createModel(value)); }
});

test('daily bucket consolidation weights counts instead of averaging percentages and preserves all selected records', () => {
  const records = [row(0, { measuredAt: '2026-02-01T12:00:00+08:00', result: 'NG' }),
    ...Array.from({ length: 100 }, (_, i) => row(i + 1, { measuredAt: '2026-02-02T12:00:00+08:00' })),
    ...Array.from({ length: 7 }, (_, i) => row(i + 101, { measuredAt: `2026-02-${String(i + 3).padStart(2, '0')}T12:00:00+08:00` }))];
  const value = input(records);value.interval = '1440';
  const model = report.createModel(value);
  assert.equal(model.trend[0].total, 101);assert.equal(model.trend[0].value, 100 / 101);assert.notEqual(model.trend[0].value, 0.5);
  assert.ok(model.trend.length <= 8);assert.equal(model.trend.reduce((sum, item) => sum + item.total, 0), 108);
});

test('explicit minute buckets use Beijing dates across UTC midnight and keep sparse periods', () => {
  const value = input([row(0, { measuredAt: '2026-02-03T15:59:59Z' }), row(1, { measuredAt: '2026-02-03T16:00:00Z' }), row(2, { measuredAt: '2026-02-03T16:10:00Z' })]);
  value.interval = '5';
  assert.deepEqual(report.createModel(value).trend.map(point => point.label), ['2026-02-03 23:55', '2026-02-04 00:00', '2026-02-04 00:10']);
});

test('automatic granularity matches the page record-span rules even for broad queries with a recent count', () => {
  for (const [hours, wording] of [[3, '按15分钟'], [24, '按15分钟'], [25, '按60分钟'], [168, '按60分钟'], [169, '按天']]) {
    const start = Date.parse('2026-02-01T00:00:00+08:00');
    const value = input([row(0, { measuredAt: new Date(start).toISOString() }), row(1, { measuredAt: new Date(start + hours * 3600000).toISOString() })]);
    value.query.start = '2026-01-01';value.query.end = '2026-03-01';value.report.filters.start = '2026-01-01';value.report.filters.end = '2026-03-01';
    assert.ok(report.createModel(value).trendNote.includes(wording));
  }
});

test('same material separates SN production lines, preserving unknown line numbers distinctly from the MES detection line', () => {
  const value = input([row(0, { productionLine: '11' }), row(1, { productionLine: '12', result: 'NG' }), row(2, { productionLine: 'unknown' }), row(3, { productionLine: '11' })]);
  value.report.filters.productionLine = '11';
  const model = report.createModel(value);
  assert.equal(model.partSummary.length, 3);assert.deepEqual(model.partSummary.map(item => item.count).sort(), [1, 1, 2]);
  assert.match(model.partSummary.find(item => item.productionLine === '11').name, /生产 11 线/);
  assert.match(model.partSummary.find(item => item.productionLine === 'unknown').name, /生产线号待确认/);
  assert.equal(model.scope.find(([key]) => key === '检测线体')[1], '合成检测线体');
  assert.match(model.scope.find(([key]) => key === '生产线号')[1], /11 线/);
  value.report.filters.productionLine = 'unknown';assert.equal(report.createModel(value).scope.find(([key]) => key === '生产线号')[1], '线号待确认');
});

test('export model is an immutable aggregate snapshot and the HTML has no executable source content or external dependencies', () => {
  const attack = '</style><script>bad()</script><img src=x onerror="bad()">';
  const value = input();value.report.records[0].partName = attack;value.report.line.name = attack;value.report.warnings = [attack];
  const model = report.createModel(value, { reportAuthor: attack, reportShowSource: false });
  const before = JSON.stringify(model);value.report.records[0].result = 'NG';value.report.summary.total = 900;value.query.result = 'NG';
  assert.equal(JSON.stringify(model), before);
  const html = report.renderDocument(model);
  assert.doesNotMatch(html, /<script|<img|<link|<iframe|<form|onerror="bad\(\)"/);assert.match(html, /&lt;script&gt;/);
  assert.match(html, /default-src 'none'/);assert.match(html, /size:A4 landscape/);assert.match(html, /第 1 \/ 1 页/);
  assert.match(html, /未提供全检标识/);assert.match(html, /不生成 NG 测点总数或排名/);
  assert.doesNotMatch(html, /SYNTHETIC-SN-0/);
});

test('preview lifecycle exposes only report kind, clears on logout, and cannot clear a reopened snapshot with an old close event', () => {
  const listeners = {}, events = [], frame = { srcdoc: '', addEventListener() {} }, button = { disabled: true, addEventListener() {}, focus() {} }, label = { textContent: '' };
  const dialog = { open: false, setAttribute() {}, addEventListener(name, handler) { listeners['dialog:' + name] = handler; },
    showModal() { this.open = true; }, close() { this.open = false; },
    querySelector(selector) { return selector === 'iframe' ? frame : selector.includes('status') || selector.includes('Title') ? label : button; }, querySelectorAll() { return [button]; } };
  const document = { body: { append() {} }, activeElement: button, createElement: () => dialog,
    addEventListener(name, handler) { listeners[name] = handler; }, dispatchEvent(event) { events.push(event); } };
  const context = { document, Intl, Date, setTimeout, CustomEvent: class { constructor(type, options) { this.type = type;this.detail = options.detail; } } };
  vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../public/one-page-report.js'), 'utf8'), context);
  const api = context.PortalReport;api.setContext('synthetic-user');api.open(input());
  assert.equal(api.isOpen(), true);assert.equal(events[0].type, 'portal:report-open');assert.deepEqual(Object.keys(events[0].detail), ['kind']);
  api.clear();assert.equal(api.isOpen(), false);assert.equal(events[1].type, 'portal:report-close');
  api.open(input());listeners['dialog:close']();assert.equal(api.isOpen(), true);
  listeners['portal:session-expired']();assert.equal(api.isOpen(), false);assert.doesNotMatch(frame.srcdoc, /合成物料/);
  assert.equal(events.at(-1).type, 'portal:report-close');assert.throws(() => api.open(input()), /登录状态已变化/);
});
