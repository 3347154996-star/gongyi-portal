'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMesVisionConnector } = require('../lib/vision-mes.cjs');

const BARCODE = 'SYNTHETIC-0000123';
const PROCESS = 'synthetic-process-1';
const TIME = '2026-02-03T04:05:06.000Z';
const SESSION = { token: 'synthetic-session-only' };
const PATHS = ['/api/parameter_unqualified/getgxcode', '/api/parameter_unqualified'];
function point(index = 0, overrides = {}) {
  return { id: 0, parameter_unqualified_sheet_id: 0, param_key: `synthetic-point-${index}`,
    param_name: `合成测点 ${index}`, param_up: '1', param_down: '-1', value: '0.25',
    rework_value: null, result: 'OK', origin_result: 'OK', is_rework: 0, ...overrides };
}
function data(overrides = {}) {
  return { id: 0, barcode: BARCODE, list: [point()], create_time: '0001-01-01T00:00:00',
    source_type: 'unqualified', quality_result: 'synthetic-workflow-only',
    cx_code: 'synthetic-line', cx_name: '合成线体', gw_code: 'synthetic-station', gw_name: '合成工位',
    sb_code: 'synthetic-device', sb_name: '合成设备', item_code: 'synthetic-part', item_name: '合成物料', ...overrides };
}
function setup({ processes = [{ value: PROCESS, label: '合成尺寸工序' }], lookup = data(), processResponse, lookupResponse, requestError } = {}) {
  const calls = [];
  const service = createMesVisionConnector({ now: () => Date.parse(TIME), request: async (path, options) => {
    calls.push({ path, ...options });
    if (requestError) throw requestError;
    assert.ok(PATHS.includes(path), 'only read endpoints are used');
    assert.equal(options.method, 'GET');
    return structuredClone(path === PATHS[0]
      ? processResponse ?? { code: 0, data: processes }
      : lookupResponse ?? { code: 0, data: lookup });
  } });
  return { service, calls };
}
const lookupQuery = (overrides = {}) => ({ action: 'lookup', barcode: BARCODE, processId: PROCESS, ...overrides });
const rejectsStatus = (promise, status) => assert.rejects(promise, error => error.status === status);

test('process choices use only the barcode GET and remove unknown upstream fields', async () => {
  const { service, calls } = setup({ processes: [{ value: 123, label: '合成尺寸工序', employee: 'not-for-output' }] });
  const result = await service.read({ action: 'processes', barcode: ` ${BARCODE} `, method: 'POST', path: '/not-allowed' }, SESSION);
  assert.deepEqual(result, { action: 'processes', barcode: BARCODE, processes: [{ id: '123', name: '合成尺寸工序' }],
    fetchedAt: TIME, coverage: { mode: 'lookup', complete: false, eligibleForLineRate: false }, capabilities: { batchSync: false } });
  assert.deepEqual(calls, [{ path: PATHS[0], method: 'GET', token: SESSION.token, query: { barcode: BARCODE } }]);
});

test('lookup accepts a dynamic 59-point result without creating a full-line rate or record identity', async () => {
  const { service, calls } = setup({ lookup: data({ list: Array.from({ length: 59 }, (_, i) => point(i, i === 58 ? { value: '1.25', result: 'NG' } : {})) }) });
  const result = await service.read(lookupQuery(), SESSION);
  assert.deepEqual(calls.map(c => ({ path: c.path, query: c.query })), [
    { path: PATHS[0], query: { barcode: BARCODE } }, { path: PATHS[1], query: { barcode: BARCODE, id: PROCESS } },
  ]);
  assert.equal(result.measurements.length, 59);
  assert.deepEqual(result.pointSummary, { total: 59, ok: 58, ng: 1, unknown: 0 });
  assert.equal(result.measuredAt, null);
  assert.equal(result.sourceRecordedAt, null);
  assert.equal(result.sourceResult, null);
  assert.equal(result.coverage.eligibleForLineRate, false);
  assert.equal(result.capabilities.batchSync, false);
  for (const field of ['id', 'recordId', 'passRate', 'totalRecords']) assert.equal(Object.hasOwn(result, field), false);
  assert.equal(result.lineName, '合成线体');
  assert.equal(result.deviceName, '合成设备');
  assert.equal(result.measurements[58].unit, null);
});

test('membership is rechecked on every lookup, and a foreign process never reaches detail', async () => {
  const { service, calls } = setup();
  await service.read(lookupQuery(), SESSION);
  await service.read(lookupQuery(), SESSION);
  assert.deepEqual(calls.map(c => c.path), [PATHS[0], PATHS[1], PATHS[0], PATHS[1]]);
  await rejectsStatus(service.read(lookupQuery({ processId: 'foreign-process' }), SESSION), 400);
  assert.equal(calls.length, 5);
  assert.equal(calls[4].path, PATHS[0]);
  const empty = setup({ processes: [] });
  await rejectsStatus(empty.service.read(lookupQuery(), SESSION), 400);
  assert.equal(empty.calls.length, 1);
});

test('numeric source strings and independent rework judgments are preserved without recalculation', async () => {
  const { service } = setup({ lookup: data({ list: [point(0, {
    value: ' 1.2500000000000001 ', param_down: '-1e0', param_up: '+1.0', result: 'OK',
    origin_result: 'NG', rework_value: '0.000', is_rework: '1',
  }), point(1, { value: -0, param_down: 0, param_up: 0 })] }) });
  const result = await service.read(lookupQuery(), SESSION);
  const first = result.measurements[0];
  assert.equal(first.actualRaw, ' 1.2500000000000001 ');
  assert.equal(first.actual, 1.25);
  assert.equal(first.lowerLimit, -1);
  assert.equal(first.lowerLimitRaw, '-1e0');
  assert.equal(first.result, 'OK');
  assert.equal(first.originResult, 'NG');
  assert.equal(first.reworkActual, 0);
  assert.equal(first.reworkActualRaw, '0.000');
  assert.equal(first.isRework, true);
  assert.equal(result.measurements[1].actual, 0);
  assert.deepEqual(result.pointSummary, { total: 2, ok: 2, ng: 0, unknown: 0 });
  assert.ok(result.warnings.some(w => w.includes('来源判定不一致')));
});

test('missing numbers stay null and unknown source judgments stay unknown', async () => {
  const { service } = setup({ lookup: data({ list: [point(0, { value: 'NaN', result: '待核实', param_up: null }),
    point(1, { value: null, result: null }), point(2, { value: ' ', result: '' }),
    point(3, { value: 'N/A', result: 'ng' }), point(4, { value: 'NA', result: 'ok' })] }) });
  const result = await service.read(lookupQuery(), SESSION);
  assert.ok(result.measurements.every(item => item.actual === null));
  assert.deepEqual(result.measurements.map(item => item.actualRaw), ['NaN', null, ' ', 'N/A', 'NA']);
  assert.equal(result.measurements[0].result, null);
  assert.equal(result.measurements[0].resultRaw, '待核实');
  assert.equal(result.measurements[0].upperLimit, null);
  assert.deepEqual(result.pointSummary, { total: 5, ok: 1, ng: 1, unknown: 3 });
  assert.ok(result.warnings.some(w => w.includes('未替换为 0')));
  assert.ok(result.warnings.some(w => w.includes('原始判定未知')));
});

test('valid source creation time is separately labelled and never becomes detection time', async () => {
  const { service } = setup({ lookup: data({ create_time: '2026-02-03 12:34:56.1234567' }) });
  const result = await service.read(lookupQuery(), SESSION);
  assert.equal(result.sourceRecordedAt, '2026-02-03T12:34:56.1234567');
  assert.equal(result.measuredAt, null);
  assert.equal(result.fetchedAt, TIME);
  for (const value of ['2026-02-30T01:02:03', '2026-01-01T24:00:00', 'not-a-date']) {
    const invalid = setup({ lookup: data({ create_time: value }) });
    await rejectsStatus(invalid.service.read(lookupQuery(), SESSION), 502);
  }
});

test('empty process and point lists are valid empty queries, not evidence of acceptance', async () => {
  const processes = setup({ processes: [] });
  assert.deepEqual((await processes.service.read({ action: 'processes', barcode: BARCODE }, SESSION)).processes, []);
  const empty = setup({ lookup: data({ list: [] }) });
  const result = await empty.service.read(lookupQuery(), SESSION);
  assert.deepEqual(result.pointSummary, { total: 0, ok: 0, ng: 0, unknown: 0 });
  assert.equal(result.sourceResult, null);
  assert.ok(result.warnings.some(w => w.includes('未返回测点')));
});

test('invalid inputs and absent sessions fail before any upstream request', async () => {
  const { service, calls } = setup();
  for (const query of [null, [], {}, lookupQuery({ action: 'submit' }), lookupQuery({ barcode: '' }),
    lookupQuery({ barcode: 'x'.repeat(201) }), lookupQuery({ barcode: 'a\nb' }), lookupQuery({ barcode: 123 }),
    lookupQuery({ processId: '../other' }), lookupQuery({ processId: {} }), lookupQuery({ processId: 'x'.repeat(81) })]) {
    await rejectsStatus(service.read(query, SESSION), 400);
  }
  for (const session of [undefined, {}, { token: '' }, { token: 123 }]) await rejectsStatus(service.read(lookupQuery(), session), 428);
  assert.equal(calls.length, 0);
});

test('process responses reject ambiguous and malformed identities and avoid forwarding upstream messages', async () => {
  for (const response of [{ code: 0, data: {} }, { code: 0, data: [null] },
    { code: 0, data: [{ value: PROCESS, label: '合成' }, { value: PROCESS, label: '重复' }] },
    { code: 0, data: [{ value: '../other', label: '合成' }] },
    { code: 0, data: [{ value: PROCESS, label: '' }] }, { data: [] },
    { code: 500, msg: 'synthetic-sensitive-error-marker', data: [] }]) {
    const { service, calls } = setup({ processResponse: response });
    await assert.rejects(service.read(lookupQuery(), SESSION), error => error.status === 502 && !error.message.includes('synthetic-sensitive-error-marker'));
    assert.equal(calls.length, 1);
  }
});

test('upstream auth errors preserve retry status and request failures do not synthesize results', async () => {
  for (const code of [401, '401', 403, '403']) {
    const { service } = setup({ processResponse: { code, message: 'do-not-echo', data: null } });
    await assert.rejects(service.read(lookupQuery(), SESSION), error => error.status === Number(code) && !error.message.includes('do-not-echo'));
  }
  const error = Object.assign(new Error('synthetic-network-failure'), { status: 503 });
  const { service } = setup({ requestError: error });
  await assert.rejects(service.read(lookupQuery(), SESSION), received => received === error);
});

test('detail responses reject mismatched barcodes and malformed point structures', async () => {
  for (const lookup of [null, data({ barcode: 'SYNTHETIC-OTHER' }), data({ barcode: null }), data({ list: {} }),
    data({ list: [null] }), data({ list: [point(), point()] }), data({ list: [point(0, { param_name: '' })] }),
    data({ list: Array.from({ length: 10001 }, (_, index) => point(index)) })]) {
    const { service } = setup({ lookup });
    await rejectsStatus(service.read(lookupQuery(), SESSION), 502);
  }
});

test('non-finite, malformed and reversed measurement values fail atomically', async () => {
  for (const overrides of [{ value: Infinity }, { value: 'Infinity' }, { value: '1e999' }, { value: true },
    { value: {} }, { value: '1.2mm' }, { value: '1\t2' }, { param_down: 2, param_up: 1 },
    { result: true }, { is_rework: 2 }, { rework_value: 'not-a-number' }]) {
    const { service } = setup({ lookup: data({ list: [point(0), point(1, overrides)] }) });
    await rejectsStatus(service.read(lookupQuery(), SESSION), 502);
  }
});

test('response allowlist excludes credentials, personnel, files, workflow state and unknown fields', async () => {
  const source = data({ employee_name: 'synthetic-person-private', imgfile: 'synthetic-image-private',
    token: 'synthetic-token-private', password: 'synthetic-password-private', explain: 'synthetic-note-private',
    list_unbind: ['synthetic-unbound-private'], quality_result: 'synthetic-quality-private',
    list: [point(0, { employee_name: 'synthetic-point-person-private', extra: 'synthetic-point-extra-private' })] });
  const before = structuredClone(source);
  const { service } = setup({ lookup: source });
  const result = await service.read(lookupQuery(), SESSION);
  const serialized = JSON.stringify(result);
  for (const marker of ['synthetic-person-private', 'synthetic-image-private', 'synthetic-token-private', 'synthetic-password-private',
    'synthetic-note-private', 'synthetic-unbound-private', 'synthetic-quality-private', 'synthetic-point-person-private', 'synthetic-point-extra-private']) {
    assert.equal(serialized.includes(marker), false);
  }
  assert.deepEqual(source, before);
});

test('measurements can omit optional fields, but still retain a stable key and unknown unit', async () => {
  const { service } = setup({ lookup: { barcode: BARCODE, list: [{ param_name: '合成单点', value: '0' }] } });
  const result = await service.read(lookupQuery(), SESSION);
  assert.equal(result.measurements[0].key, '合成单点');
  assert.equal(result.measurements[0].actual, 0);
  assert.equal(result.measurements[0].isRework, null);
  assert.equal(result.measurements[0].reworkActual, null);
  assert.equal(result.measurements[0].unit, null);
  assert.equal(result.lineName, null);
  assert.equal(result.sourceRecordedAt, null);
  assert.deepEqual(result.pointSummary, { total: 1, ok: 0, ng: 0, unknown: 1 });
});
