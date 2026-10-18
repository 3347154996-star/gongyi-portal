'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMesVisionReportConnector } = require('../lib/vision-mes-report.cjs');

const NOW = Date.parse('2026-02-03T04:00:00.000Z');
const SESSION = { token: 'synthetic-session-only' };
const LINE = { value: 11, label: 'CX_TEST1-合成视觉尺寸线' };
const CATALOG = '/api/Cx/select';
const REPORT = '/api/ProcessReport';
const DETAIL = '/api/ProcessReport/detail/';
const query = overrides => ({ action: 'report', lineId: '11', start: '2026-02-03T00:00', end: '2026-02-03T23:59', ...overrides });
const rejectsStatus = (promise, status) => assert.rejects(promise, error => error.status === status);
function record(index = 0, overrides = {}) {
  return { id: index + 1, barCode: `SYNTHETIC-${index}`, endTime: new Date(NOW - 60000 - index * 1000).toISOString(),
    type: index % 5 === 0 ? 'NG' : 'OK', productLineCode: 'CX_TEST1', productLineName: '合成视觉尺寸线',
    gxCode: 'PROCESS_TEST', gxName: '合成尺寸检测工序', equipmentCode: 'DEVICE_TEST', equipmentName: '合成检具',
    itemCode: 'PART_TEST', itemName: '合成零件', stationCode: 'STATION_TEST', stationName: '合成工位',
    peoPleName: 'excluded-personal-field', traceUUID: `synthetic-trace-${index}`, ...overrides };
}
function point(index = 0, overrides = {}) {
  return { param_Name: `合成测点${index}`, key: `point-${index}`, param_UP: '1', param_DOWN: '-1',
    value: '0.2', result: 'OK', ...overrides };
}
function setup({ rows = [record()], lines = [LINE], pages, detail = [point()], config = {}, now: suppliedNow, onCall } = {}) {
  const calls = [];
  let clock = NOW, reportCalls = 0;
  const now = suppliedNow || (() => clock);
  const service = createMesVisionReportConnector({ config, now, request: async (path, options) => {
    calls.push({ path, ...options });
    assert.equal(options.method, 'GET');
    assert.ok(path === CATALOG || path === REPORT || /^\/api\/ProcessReport\/detail\/\d+$/.test(path), 'only known read paths');
    if (onCall) await onCall(path, options, calls.length);
    if (path === CATALOG) return { code: 0, data: structuredClone(lines) };
    if (path.startsWith(DETAIL)) return { code: 0, data: structuredClone(detail) };
    reportCalls++;
    if (pages) return structuredClone(await pages(options.query, reportCalls));
    return { code: 0, total: rows.length, data: structuredClone(rows.slice((options.query.page - 1) * 200, options.query.page * 200)) };
  } });
  return { service, calls, setNow: value => { clock = value; } };
}

test('catalog discovers dimensional lines without hardcoded company IDs and honors an available configured default', async () => {
  const { service, calls } = setup({ lines: [LINE, { value: 12, label: 'CX_TEST2-合成光学线' },
    { value: 13, label: 'CX_TEST3-合成焊接线' }, { value: 14, label: '未确认格式尺寸线' }],
  config: { vision: { mes: { defaultLineId: '12' } } } });
  const result = await service.read({ action: 'catalog' }, SESSION);
  assert.deepEqual(result.lines, [
    { id: '11', code: 'CX_TEST1', name: '合成视觉尺寸线', label: LINE.label },
    { id: '12', code: 'CX_TEST2', name: '合成光学线', label: 'CX_TEST2-合成光学线' },
  ]);
  assert.equal(result.defaultLineId, '12');
  assert.deepEqual(calls[0].query, { DYGS_ID: 0 });
  const missingDefault = setup({ config: { vision: { mes: { defaultLineId: '999' } } } });
  assert.equal((await missingDefault.service.read({ action: 'catalog' }, SESSION)).defaultLineId, '11');
});

test('complete range uses paged process records, frozen local time, and a final first-page consistency check', async () => {
  const rows = Array.from({ length: 215 }, (_, i) => record(i));
  const { service, calls } = setup({ rows });
  const result = await service.read(query(), SESSION);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.eligibleForLineRate, true);
  assert.deepEqual(result.summary, { total: 215, ok: 172, ng: 43, unknown: 0, denominator: 215, passRate: 80 });
  assert.deepEqual(calls.filter(c => c.path === REPORT).map(c => c.query.page), [1, 2, 1]);
  assert.equal(result.filters.start, '2026-02-03 00:00:00');
  assert.equal(result.filters.end, '2026-02-03 12:00:00');
  for (const c of calls.filter(c => c.path === REPORT)) {
    assert.equal(c.query.cx_id, '11');
    assert.equal(c.query.size, 200);
    assert.equal(c.query.pageShow, true);
    assert.equal(c.query.end, result.filters.end);
    assert.equal(c.query.orderName, 'endTime');
    assert.equal(c.query.orderType, 2);
    assert.equal(Object.hasOwn(c.query, 'result'), false);
  }
  assert.equal(result.records[0].recordId, '1');
  assert.equal(result.records[0].measuredAt, '2026-02-03T11:59:00+08:00');
  assert.equal(Object.hasOwn(result.records[0], 'peoPleName'), false);
});

test('recent 500 counts detection events inside the time window, including repeat tests', async () => {
  const rows = Array.from({ length: 725 }, (_, i) => record(i, { barCode: 'SYNTHETIC-RETEST' }));
  const { service, calls } = setup({ rows });
  const result = await service.read(query({ limit: '500' }), SESSION);
  assert.equal(result.coverage.mode, 'recent');
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.sourceTotal, 725);
  assert.equal(result.coverage.readRows, 600);
  assert.equal(result.records.length, 500);
  assert.equal(new Set(result.records.map(r => r.recordId)).size, 500);
  assert.deepEqual(calls.filter(c => c.path === REPORT).map(c => c.query.page), [1, 2, 3, 1]);
});

test('a recent selection with fewer source records is complete only after exhausting the source', async () => {
  const { service } = setup({ rows: Array.from({ length: 20 }, (_, i) => record(i)) });
  const result = await service.read(query({ limit: 100 }), SESSION);
  assert.equal(result.summary.total, 20);
  assert.equal(result.coverage.complete, true);
});

test('same barcode with separate record IDs retains original NG and subsequent OK as separate events', async () => {
  const { service } = setup({ rows: [record(0, { barCode: 'SYNTHETIC-RETEST', type: 'OK' }), record(1, { barCode: 'SYNTHETIC-RETEST', type: 'NG' })] });
  const result = await service.read(query({ barcode: 'SYNTHETIC-RETEST' }), SESSION);
  assert.deepEqual(result.summary, { total: 2, ok: 1, ng: 1, unknown: 0, denominator: 2, passRate: null });
  assert.equal(result.coverage.eligibleForLineRate, false);
  assert.match(result.coverage.note, /单个工件/);
});

test('empty range is complete but has no numeric pass rate', async () => {
  const { service } = setup({ rows: [] });
  const result = await service.read(query(), SESSION);
  assert.equal(result.coverage.complete, true);
  assert.deepEqual(result.summary, { total: 0, ok: 0, ng: 0, unknown: 0, denominator: 0, passRate: null });
});

test('input and session validation happen before upstream access', async () => {
  const { service, calls } = setup();
  await rejectsStatus(service.read(query(), null), 428);
  for (const q of [query({ action: 'POST' }), query({ lineId: '../x' }), query({ start: '2026-02-30' }),
    query({ start: '2026-02-03T24:00' }), query({ start: '2026-02-04' }), query({ limit: 20001 }),
    query({ barcode: 'bad\ncode' })]) await rejectsStatus(service.read(q, SESSION), 400);
  assert.equal(calls.length, 0);
  await rejectsStatus(service.read(query({ lineId: '999' }), SESSION), 400);
  assert.equal(calls.length, 1);
});

test('date-only end means the local end of day and explicit offsets describe the same interval', async () => {
  const { service } = setup({ rows: [record(0, { endTime: '2026-02-02T23:59:59.500+08:00' })] });
  const result = await service.read(query({ start: '2026-02-02T00:00+08:00', end: '2026-02-02' }), SESSION);
  assert.equal(result.filters.end, '2026-02-02 23:59:59.999');
  assert.equal(result.coverage.complete, true);
});

test('a minute-precision end includes that full minute before the frozen present', async () => {
  const { service } = setup({ rows: [record(0, { endTime: '2026-02-03T10:30:59.500+08:00' })] });
  const result = await service.read(query({ end: '2026-02-03T10:30' }), SESSION);
  assert.equal(result.filters.end, '2026-02-03 10:30:59.999');
  assert.equal(result.coverage.complete, true);
});

test('unknown result is retained without inferring OK from a numeric range', async () => {
  const { service } = setup({ rows: [record(0, { type: 'UNCONFIRMED' }), record(1)] });
  const result = await service.read(query(), SESSION);
  assert.equal(result.records[0].result, null);
  assert.equal(result.summary.unknown, 1);
  assert.equal(result.summary.denominator, 1);
  assert.equal(result.summary.passRate, null);
  assert.equal(result.coverage.complete, false);
});

test('mixed dimensional processes preserve records but cannot produce one line rate', async () => {
  const { service } = setup({ rows: [record(0), record(1, { gxCode: 'OTHER_PROCESS', gxName: '合成光学复检工序' })] });
  const result = await service.read(query(), SESSION);
  assert.equal(result.records.length, 2);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.eligibleForLineRate, false);
  assert.equal(result.summary.passRate, null);
  assert.match(result.coverage.note, /多个工序/);
});

test('missing or non-dimensional process metadata preserves records while suppressing rates', async () => {
  for (const process of [{ gxCode: null }, { gxName: '' }, { gxName: '合成一般生产工序' }]) {
    const { service } = setup({ rows: [record(0), record(1, process)] });
    const result = await service.read(query(), SESSION);
    assert.equal(result.records.length, 2);
    assert.equal(result.coverage.complete, false);
    assert.equal(result.summary.passRate, null);
    assert.match(result.coverage.note, /工序不明或未确认为尺寸/);
  }
});

test('wrong line, invalid default time, out of range and unrelated barcode cannot enter a complete result', async () => {
  for (const invalid of [{ productLineCode: 'OTHER_LINE' }, { endTime: '0001-01-01T00:00:00' },
    { endTime: '2026-02-04T00:00:00' }, { endTime: '2026-02-30T00:00:00' }, { id: 0 }]) {
    const { service } = setup({ rows: [record(0), record(1, invalid)] });
    const result = await service.read(query(), SESSION);
    assert.equal(result.coverage.complete, false);
    assert.equal(result.records.length, 1);
    assert.equal(result.summary.passRate, null);
  }
  const unrelated = setup({ rows: [record(0), record(1)] });
  const result = await unrelated.service.read(query({ barcode: 'SYNTHETIC-0' }), SESSION);
  assert.equal(result.records.length, 1);
  assert.equal(result.coverage.complete, false);
});

test('duplicate identifiers are not counted twice and conflicting contents suppress rates', async () => {
  for (const second of [record(0), record(0, { type: 'OK' })]) {
    const { service } = setup({ rows: [record(0), second] });
    const result = await service.read(query(), SESSION);
    assert.equal(result.summary.total, 1);
    assert.equal(result.coverage.duplicateRows, 1);
    assert.equal(result.coverage.complete, false);
    assert.equal(result.summary.passRate, null);
  }
});

test('identical duplicate IDs still suppress a recent rate before reaching source exhaustion', async () => {
  const data = Array.from({ length: 200 }, (_, i) => record(i));
  data[1] = structuredClone(data[0]);
  const { service } = setup({ pages: () => ({ code: 0, total: 400, data }) });
  const result = await service.read(query({ limit: 100 }), SESSION);
  assert.equal(result.records.length, 100);
  assert.equal(result.coverage.duplicateRows, 1);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.summary.passRate, null);
});

test('out-of-order pages cannot be labeled a trusted recent selection', async () => {
  const { service } = setup({ rows: [record(1), record(0)] });
  const result = await service.read(query({ limit: 100 }), SESSION);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.summary.passRate, null);
  assert.match(result.coverage.note, /倒序/);
});

test('changing totals and changing first-page contents suppress rates', async () => {
  const rows = Array.from({ length: 205 }, (_, i) => record(i));
  const changingTotal = setup({ pages: (q, call) => ({ code: 0, total: call === 1 ? 205 : 206,
    data: rows.slice((q.page - 1) * 200, q.page * 200) }) });
  const result = await changingTotal.service.read(query(), SESSION);
  assert.equal(result.coverage.complete, false);
  assert.match(result.coverage.note, /总数发生变化/);
  const changingFirst = setup({ pages: (q, call) => ({ code: 0, total: 1,
    data: [record(0, { type: call === 1 ? 'NG' : 'OK' })] }) });
  const changed = await changingFirst.service.read(query(), SESSION);
  assert.equal(changed.coverage.complete, false);
  assert.equal(changed.summary.passRate, null);
  assert.match(changed.coverage.note, /复核/);
});

test('page cap, premature page ending and malformed envelope remain incomplete', async () => {
  const rows = Array.from({ length: 405 }, (_, i) => record(i));
  const capped = setup({ rows, config: { vision: { mes: { maxPages: 1 } } } });
  const result = await capped.service.read(query(), SESSION);
  assert.equal(result.summary.total, 200);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.summary.passRate, null);
  const early = setup({ pages: () => ({ code: 0, total: 9, data: [record()] }) });
  assert.equal((await early.service.read(query(), SESSION)).coverage.complete, false);
  const malformed = setup({ pages: () => ({ code: 0, total: '1', data: [record()] }) });
  assert.equal((await malformed.service.read(query(), SESSION)).coverage.complete, false);
});

test('unrelated top-level pagination configuration does not truncate dimensional reports', async () => {
  const { service } = setup({ rows: Array.from({ length: 205 }, (_, i) => record(i)), config: { maxPages: 1 } });
  const result = await service.read(query(), SESSION);
  assert.equal(result.records.length, 205);
  assert.equal(result.coverage.complete, true);
});

test('mid-read errors retain explicitly incomplete records while authentication failures propagate', async () => {
  const rows = Array.from({ length: 200 }, (_, i) => record(i));
  const partial = setup({ pages: q => { if (q.page === 2) throw new Error('synthetic network failure'); return { code: 0, total: 201, data: rows }; } });
  const result = await partial.service.read(query(), SESSION);
  assert.equal(result.records.length, 200);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.summary.passRate, null);
  for (const code of [401, 403]) {
    const expired = setup({ pages: q => q.page === 2 ? { code } : { code: 0, total: 201, data: rows } });
    await rejectsStatus(expired.service.read(query(), SESSION), code);
  }
});

test('deadline between pages stops enumeration and a stalled request is bounded', async () => {
  let clock = NOW;
  const rows = Array.from({ length: 205 }, (_, i) => record(i));
  const deadline = setup({ rows, config: { maxDurationMs: 60 }, now: () => clock, onCall: () => { clock += 35; } });
  const result = await deadline.service.read(query(), SESSION);
  assert.equal(result.records.length, 200);
  assert.equal(result.coverage.complete, false);
  const stalled = setup({ config: { maxDurationMs: 20 }, pages: () => new Promise(() => {}) });
  await rejectsStatus(stalled.service.read(query(), SESSION), 504);
});

test('detail requires a record from this session, excludes unnamed collection fields and keeps process verdict', async () => {
  const detail = [point(0, { result: 'NG', value: '1.2' }), point(1), ...Array.from({ length: 4 }, (_, i) => ({ key: `status-${i}`, value: '1', result: null, param_Name: '', param_UP: null, param_DOWN: null }))];
  const { service, calls } = setup({ rows: [record(0, { type: 'OK' })], detail });
  await rejectsStatus(service.read({ action: 'detail', recordId: '1' }, SESSION), 400);
  assert.equal(calls.length, 0);
  await service.read(query(), SESSION);
  await rejectsStatus(service.read({ action: 'detail', recordId: '1' }, { token: 'other-session' }), 400);
  const result = await service.read({ action: 'detail', recordId: '1' }, SESSION);
  assert.equal(result.sourceResult, 'OK');
  assert.equal(result.result, 'OK');
  assert.equal(result.sourceType, 'ProcessReport');
  assert.equal(result.recordId, '1');
  assert.equal(result.barcode, 'SYNTHETIC-0');
  assert.deepEqual(result.pointSummary, { total: 2, ok: 1, ng: 1, unknown: 0 });
  assert.equal(result.additionalFieldCount, 4);
  assert.equal(result.measurements[0].actualRaw, '1.2');
  assert.equal(result.measurements[0].unit, null);
  assert.equal(result.coverage.eligibleForLineRate, false);
  assert.equal(calls.at(-1).path, DETAIL + '1');
});

test('detail preserves zero, missing values and equality rules without recasting unknown decisions', async () => {
  const { service } = setup({ detail: [point(0, { value: 0, param_DOWN: 0, param_UP: 0 }),
    point(1, { value: 'N/A', result: 'pending', param_UP: null }),
    point(2, { value: '2', is_equal: 1, specific_value: '2', result: 'OK', param_UP: null, param_DOWN: null })] });
  await service.read(query(), SESSION);
  const result = await service.read({ action: 'detail', recordId: '1' }, SESSION);
  assert.equal(result.measurements[0].actual, 0);
  assert.equal(result.measurements[1].actual, null);
  assert.equal(result.measurements[1].actualRaw, 'N/A');
  assert.equal(result.measurements[1].result, null);
  assert.equal(result.measurements[2].isEqual, true);
  assert.equal(result.measurements[2].expectedValue, 2);
  assert.equal(result.pointSummary.unknown, 1);
});

test('detail authorization expires and bounded cache retains the newest displayed records', async () => {
  const { service, setNow } = setup({ rows: [record(0), record(1), record(2)], config: { maxCachedRecords: 2, cacheTtlMs: 1000 } });
  await service.read(query(), SESSION);
  await service.read({ action: 'detail', recordId: '1' }, SESSION);
  await rejectsStatus(service.read({ action: 'detail', recordId: '3' }, SESSION), 400);
  setNow(NOW + 1001);
  await rejectsStatus(service.read({ action: 'detail', recordId: '1' }, SESSION), 400);
});

test('invalid or duplicate point identities reject ambiguous detail', async () => {
  for (const detail of [[point(), point()], [point(0, { param_DOWN: '2', param_UP: '1' })], [null]]) {
    const { service } = setup({ detail });
    await service.read(query(), SESSION);
    await rejectsStatus(service.read({ action: 'detail', recordId: '1' }, SESSION), 502);
  }
});

test('material and device filters are exact codes applied before selecting recent matches across pages', async () => {
  const rows = Array.from({ length: 410 }, (_, i) => record(i, {
    itemCode: i === 250 || i === 305 || i === 399 ? 'PART_PICK' : 'PART_OTHER',
    itemName: i === 250 || i === 305 || i === 399 ? '所选合成物料' : '其他合成物料',
    equipmentCode: i === 250 || i === 305 || i === 399 ? 'DEVICE_PICK' : 'DEVICE_OTHER',
    equipmentName: i === 250 || i === 305 || i === 399 ? '所选合成设备' : '其他合成设备',
  }));
  rows[1].itemCode = 'PART_PICK_SUFFIX'; rows[1].equipmentCode = 'DEVICE_PICK';
  rows[2].itemCode = 'PART_PICK'; rows[2].equipmentCode = 'DEVICE_PICK_SUFFIX';
  const { service, calls } = setup({ rows });
  const result = await service.read(query({ partCode: 'PART_PICK', deviceCode: 'DEVICE_PICK', limit: '2' }), SESSION);
  assert.deepEqual(result.records.map(r => r.recordId), ['251', '306']);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.eligibleForLineRate, true);
  assert.equal(result.coverage.sourceTotal, 410);
  assert.equal(result.coverage.readRows, 400);
  assert.equal(result.summary.passRate, 0);
  assert.equal(result.filters.partCode, 'PART_PICK');
  assert.equal(result.filters.deviceCode, 'DEVICE_PICK');
  assert.equal(result.filters.result, 'all');
  assert.equal(result.filters.limit, 2);
  assert.deepEqual(calls.filter(c => c.path === REPORT).map(c => c.query.page), [1, 2, 1]);
  for (const c of calls.filter(c => c.path === REPORT)) {
    for (const key of ['partCode', 'deviceCode', 'result', 'itemcode', 'sbbm']) assert.equal(Object.hasOwn(c.query, key), false, 'no unverified upstream filtering');
  }
});

test('facets describe observed rows before local filters and exclude duplicate or invalid source rows', async () => {
  const { service } = setup({ rows: [
    record(0, { itemCode: 'P_B', itemName: '物料 B', equipmentCode: 'D_B', equipmentName: '设备 B' }),
    record(1, { itemCode: 'P_A', itemName: '物料 A', equipmentCode: 'D_A', equipmentName: '设备 A' }),
    record(2, { itemCode: 'P_B', itemName: '物料 B', equipmentCode: 'D_B', equipmentName: '设备 B' }),
    record(3, { productLineCode: 'FOREIGN', itemCode: 'P_FOREIGN', equipmentCode: 'D_FOREIGN' }),
  ] });
  const result = await service.read(query({ partCode: 'P_A', deviceCode: 'D_A', result: 'OK' }), SESSION);
  assert.deepEqual(result.facets, { parts: [{ code: 'P_A', name: '物料 A' }, { code: 'P_B', name: '物料 B' }],
    devices: [{ code: 'D_A', name: '设备 A' }, { code: 'D_B', name: '设备 B' }],
    materialLines: [{ code: 'P_A', name: '物料 A', productionLine: 'unknown' }, { code: 'P_B', name: '物料 B', productionLine: 'unknown' }] });
  assert.deepEqual(result.records.map(r => r.recordId), ['2']);
  assert.equal(result.coverage.complete, false);
});

test('result filtering never presents a single-verdict subset as a line pass rate', async () => {
  for (const selectedResult of ['NG', 'OK']) {
    const { service } = setup({ rows: [record(0), record(1), record(2)] });
    const result = await service.read(query({ result: selectedResult }), SESSION);
    assert.ok(result.records.every(row => row.result === selectedResult));
    assert.equal(result.summary.total, selectedResult === 'NG' ? 1 : 2);
    assert.equal(result.coverage.complete, true);
    assert.equal(result.coverage.eligibleForLineRate, false);
    assert.equal(result.summary.passRate, null);
    assert.match(result.coverage.rateUnavailableReason, new RegExp(selectedResult));
    assert.match(result.coverage.note, /未包含全部判定/);
  }
});

test('recent result filter continues until matching count is reached rather than truncating before filtering', async () => {
  const rows = Array.from({ length: 450 }, (_, i) => record(i, { type: i === 230 || i === 300 || i === 420 ? 'NG' : 'OK' }));
  const { service, calls } = setup({ rows });
  const result = await service.read(query({ result: 'NG', limit: 2 }), SESSION);
  assert.deepEqual(result.records.map(row => row.recordId), ['231', '301']);
  assert.equal(result.coverage.readRows, 400);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.summary.passRate, null);
  assert.deepEqual(calls.filter(c => c.path === REPORT).map(c => c.query.page), [1, 2, 1]);
});

test('empty local selection reads the full source and remains empty without inventing a pass rate', async () => {
  const rows = Array.from({ length: 205 }, (_, i) => record(i));
  const { service, calls } = setup({ rows });
  const result = await service.read(query({ partCode: 'ABSENT_PART', limit: 1 }), SESSION);
  assert.equal(result.records.length, 0);
  assert.equal(result.coverage.readRows, 205);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.summary.passRate, null);
  assert.equal(result.filters.partCode, 'ABSENT_PART');
  assert.deepEqual(result.facets.parts, [{ code: 'PART_TEST', name: '合成零件' }]);
  assert.deepEqual(calls.filter(c => c.path === REPORT).map(c => c.query.page), [1, 2, 1]);
});

test('capped local search does not label zero matching rows as a complete empty result', async () => {
  const rows = Array.from({ length: 205 }, (_, i) => record(i, { itemCode: i >= 200 ? 'LATER_PART' : 'FIRST_PART' }));
  const { service } = setup({ rows, config: { vision: { mes: { maxPages: 1 } } } });
  const result = await service.read(query({ partCode: 'LATER_PART', limit: 1 }), SESSION);
  assert.equal(result.records.length, 0);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.eligibleForLineRate, false);
  assert.equal(result.summary.passRate, null);
  assert.equal(result.coverage.sourceTotal, 205);
});

test('unknown verdicts are not hidden by a local result filter to fabricate completeness', async () => {
  const { service } = setup({ rows: [record(0), record(1, { type: null })] });
  const result = await service.read(query({ result: 'NG' }), SESSION);
  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.unknown, 0);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.summary.passRate, null);
  assert.match(result.coverage.note, /未知工序判定/);
});

test('custom recent count accepts the full integer range and rejects ambiguous or invalid filters before reading', async () => {
  for (const limit of [0, 1, 150, 20000, '1', '20000']) {
    const { service } = setup();
    const result = await service.read(query({ limit, partCode: '', deviceCode: '', result: 'all' }), SESSION);
    assert.equal(result.filters.limit, Number(limit));
    assert.equal(result.filters.partCode, null);
    assert.equal(result.filters.deviceCode, null);
    assert.equal(result.coverage.complete, true);
  }
  const { service, calls } = setup();
  for (const invalid of [{ limit: -1 }, { limit: 20001 }, { limit: 1.5 }, { limit: true }, { limit: '1e2' },
    { limit: [] }, { partCode: [] }, { deviceCode: 'bad\ncode' }, { result: 'unknown' }, { result: 'ng' }, { result: {} }]) {
    await rejectsStatus(service.read(query(invalid), SESSION), 400);
  }
  assert.equal(calls.length, 0);
});

test('facet options from a stopped recent read do not claim unobserved older material or device choices', async () => {
  const rows = Array.from({ length: 205 }, (_, i) => record(i, { itemCode: i >= 200 ? 'OLDER_PART' : 'NEWER_PART',
    equipmentCode: i >= 200 ? 'OLDER_DEVICE' : 'NEWER_DEVICE' }));
  const { service } = setup({ rows });
  const result = await service.read(query({ limit: 1 }), SESSION);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.readRows, 200);
  assert.deepEqual(result.facets.parts.map(row => row.code), ['NEWER_PART']);
  assert.deepEqual(result.facets.devices.map(row => row.code), ['NEWER_DEVICE']);
});

test('time mode reads the whole chosen interval even when an obsolete recent limit is supplied', async () => {
  const { service, calls } = setup({ rows: Array.from({ length: 205 }, (_, i) => record(i)) });
  const result = await service.read(query({ queryMode: 'time', limit: '1' }), SESSION);
  assert.equal(result.filters.queryMode, 'time');
  assert.equal(result.filters.limit, 0);
  assert.equal(result.summary.total, 205);
  assert.equal(result.coverage.mode, 'range');
  assert.equal(result.coverage.sourceExhausted, true);
  assert.equal(result.coverage.complete, true);
  assert.deepEqual(calls.filter(c => c.path === REPORT).map(c => c.query.page), [1, 2, 1]);
});

test('count mode ignores stale client dates and finds recent records across dates and pages', async () => {
  const rows = Array.from({ length: 425 }, (_, i) => record(i, {
    endTime: new Date(NOW - i * 3600000 - 60000).toISOString(),
  }));
  const { service, calls } = setup({ rows });
  const result = await service.read(query({ queryMode: 'count', limit: '205', start: 'not-a-date', end: '1900-01-01' }), SESSION);
  assert.equal(result.filters.queryMode, 'count');
  assert.equal(result.filters.start, '2000-01-01 00:00:00');
  assert.equal(result.filters.end, '2026-02-03 12:00:00');
  assert.equal(result.summary.total, 205);
  assert.equal(result.coverage.sourceExhausted, false);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.lastMeasuredAt, result.records[0].measuredAt);
  assert.equal(result.coverage.firstMeasuredAt, result.records.at(-1).measuredAt);
  assert.ok(result.coverage.firstMeasuredAt.startsWith('2026-01-'));
  assert.deepEqual(calls.filter(c => c.path === REPORT).map(c => c.query.page), [1, 2, 1]);
  assert.ok(calls.filter(c => c.path === REPORT).every(c => c.query.start === result.filters.start && c.query.end === result.filters.end));
  assert.match(result.coverage.note, /2000-01-01/);
});

test('count mode with fewer matches is complete only after supported history is exhausted', async () => {
  const rows = [record(0), record(1, { endTime: '2024-01-03 11:00:00' }), record(2, { endTime: '2000-01-01 00:00:00' })];
  const { service } = setup({ rows });
  const result = await service.read({ action: 'report', lineId: '11', queryMode: 'count', limit: 500 }, SESSION);
  assert.equal(result.summary.total, 3);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.sourceExhausted, true);
  assert.equal(result.coverage.firstMeasuredAt, '2000-01-01T00:00:00+08:00');
  assert.match(result.coverage.note, /不足指定数量/);
  const capped = setup({ rows: Array.from({ length: 205 }, (_, i) => record(i)), config: { vision: { mes: { maxPages: 1 } } } });
  const partial = await capped.service.read(query({ queryMode: 'count', limit: 500 }), SESSION);
  assert.equal(partial.coverage.complete, false);
  assert.equal(partial.coverage.sourceExhausted, false);
  assert.equal(partial.summary.passRate, null);
});

test('empty count history is complete with null sample dates while invalid modes or counts never read', async () => {
  const empty = setup({ rows: [] });
  const result = await empty.service.read(query({ queryMode: 'count', limit: 1 }), SESSION);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.sourceExhausted, true);
  assert.equal(result.coverage.firstMeasuredAt, null);
  assert.equal(result.coverage.lastMeasuredAt, null);
  const { service, calls } = setup();
  for (const invalid of [{ queryMode: 'count', limit: 0 }, { queryMode: 'count' }, { queryMode: 'count', limit: 20001 },
    { queryMode: 'both' }, { queryMode: true }, { queryMode: ['time'] }]) {
    await rejectsStatus(service.read(query(invalid), SESSION), 400);
  }
  assert.equal(calls.length, 0);
});

test('legacy callers retain combined date and recent filtering when queryMode is absent', async () => {
  const { service } = setup({ rows: [record(0), record(1)] });
  const result = await service.read(query({ limit: 1 }), SESSION);
  assert.equal(Object.hasOwn(result.filters, 'queryMode'), false);
  assert.equal(result.filters.start, '2026-02-03 00:00:00');
  assert.equal(result.filters.limit, 1);
  assert.equal(result.summary.total, 1);
});

test('production line decoding uses only the two digits in the final A or B production marker', async () => {
  const samples = [
    ['SYN2628911A140', '11'], ['SYN2628911B001', '11'], ['SYN2628912A998', '12'],
    ['SYN2628912b7', '12'], ['SYN2628921A101', '21'], ['SYN2628999B010', '99'],
    ['SYN2628901A001', '1'], ['SYN2628900A001', 'unknown'], ['SYN11A140-middle', 'unknown'],
    ['SYN11C140', 'unknown'], ['SYN11A', 'unknown'], ['SYN7A140', 'unknown'],
    ['SYN11A140-NOT-PRODUCTION', 'unknown'], ['SYN-NO-MARKER', 'unknown'],
  ];
  const { service } = setup({ rows: samples.map(([barCode], i) => record(i, { barCode })) });
  const result = await service.read(query(), SESSION);
  assert.deepEqual(result.records.map(row => row.productionLine), samples.map(([, line]) => line));
  assert.equal(result.coverage.complete, true, 'unknown SN line identity does not invent an unknown inspection verdict');
});

test('material-line facets separate the same material by production line before local filters', async () => {
  const rows = [record(0, { barCode: 'SYN2628911A001' }), record(1, { barCode: 'SYN2628911B001' }),
    record(2, { barCode: 'SYN2628912A001' }), record(3, { barCode: 'SYN-UNKNOWN' }),
    record(4, { barCode: 'SYN2628911A002', itemCode: 'OTHER_PART', itemName: '其他合成物料' })];
  const { service } = setup({ rows });
  const result = await service.read(query({ partCode: 'PART_TEST', productionLine: '11' }), SESSION);
  assert.deepEqual(result.records.map(row => row.recordId), ['1', '2']);
  assert.equal(result.filters.productionLine, '11');
  assert.equal(result.summary.total, 2);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.facets.parts.length, 2);
  assert.deepEqual(result.facets.materialLines.map(({ code, productionLine }) => [code, productionLine]), [
    ['OTHER_PART', '11'], ['PART_TEST', '11'], ['PART_TEST', '12'], ['PART_TEST', 'unknown'],
  ]);
  const unknown = await service.read(query({ productionLine: 'unknown' }), SESSION);
  assert.deepEqual(unknown.records.map(row => row.recordId), ['4']);
  assert.equal(unknown.summary.total, 1);
  assert.equal(unknown.coverage.complete, true);
});

test('production-line and material filtering happen before recent selection across old dates and pages', async () => {
  const rows = Array.from({ length: 425 }, (_, i) => record(i, { barCode: `SYN2628912A${i}`,
    endTime: new Date(NOW - i * 3600000 - 60000).toISOString() }));
  rows[210].barCode = 'SYN2628911A001'; rows[320].barCode = 'SYN2628911B002'; rows[410].barCode = 'SYN2628911B003';
  const { service, calls } = setup({ rows });
  const result = await service.read(query({ queryMode: 'count', limit: 2, partCode: 'PART_TEST', productionLine: '11' }), SESSION);
  assert.deepEqual(result.records.map(row => row.recordId), ['211', '321']);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.readRows, 400);
  assert.equal(result.summary.denominator, 2);
  assert.ok(result.coverage.firstMeasuredAt.startsWith('2026-01-'));
  assert.deepEqual(calls.filter(c => c.path === REPORT).map(c => c.query.page), [1, 2, 1]);
  assert.ok(calls.filter(c => c.path === REPORT).every(c => !Object.hasOwn(c.query, 'productionLine') && !Object.hasOwn(c.query, 'queryMode')));
});

test('unsupported production line selectors are rejected before upstream reads', async () => {
  const { service, calls } = setup();
  for (const productionLine of ['0', '00', '100', '11A', '11线', 'UNKNOWN', true, [], {}]) {
    await rejectsStatus(service.read(query({ productionLine }), SESSION), 400);
  }
  assert.equal(calls.length, 0);
});

test('local catalog excludes only the requested phase-four front and rear dimensional names', async () => {
  const lines = [
    { value: 1, label: 'SYN1-TSL四期前副在线尺寸检测' }, { value: 2, label: 'SYN2-TSL四期后副在线尺寸检测' },
    { value: 3, label: 'SYN3-TSL四期前幅在线尺寸检测' }, { value: 4, label: 'SYN4-TSL四期后幅在线尺寸检测' },
    { value: 5, label: 'SYN5-TSL七期前副在线尺寸检测' }, { value: 6, label: 'SYN6-TSL四期其他尺寸检测' },
    { value: 7, label: 'SYN7-其他公司四期前副在线尺寸检测' },
  ];
  const { service, calls } = setup({ lines, config: { vision: { mes: { defaultLineId: '1' } } } });
  const catalog = await service.read({ action: 'catalog' }, SESSION);
  assert.deepEqual(catalog.lines.map(row => row.id), ['5', '6', '7']);
  assert.equal(catalog.defaultLineId, '5');
  for (const lineId of ['1', '2', '3', '4']) await rejectsStatus(service.read(query({ lineId }), SESSION), 400);
  assert.equal(calls.filter(c => c.path === REPORT).length, 0, 'excluded IDs cannot bypass the local catalog to query company reports');
});
