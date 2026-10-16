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
  assert.deepEqual(result.summary, { total: 2, ok: 1, ng: 1, unknown: 0, denominator: 2, passRate: 50 });
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
    query({ start: '2026-02-03T24:00' }), query({ start: '2026-02-04' }), query({ limit: 150 }),
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
