'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createVisionService, parseCsv } = require('../lib/vision.cjs');

const quote = x => /[,"\r\n]/.test(String(x)) ? '"' + String(x).replaceAll('"', '""') + '"' : String(x);
function fixture({ part = 'Tesla_Front12', sn = 'SYNTHETIC-TEST-001', time = '2026/10/13 00:05:49', result = 'OK', deviation = '0.1', count = 61, reverse = false, filename, name } = {}) {
  const measurements = Array.from({ length: count }, (_, i) => [i === 0 && name ? name : `测点_${i + 1}`, '10', '-0.5', '0.5', i < 59 ? 'Yes' : 'No', i === 0 ? deviation : '0.1', i === 0 && /^nan$/i.test(deviation) ? 'NAN' : 'OK']);
  if (reverse) measurements.reverse();
  const rows = [['PartName', part, '', '', '', '', ''], ['SN', sn, '', '', '', '', ''], ['TimeStamp', time, '', '', '', '', ''], ['Result', result, '', '', '', '', ''], ['Name', 'Nominal', 'Lower_SL', 'Upper_SL', 'IsCritical', 'Dev', 'OK/NG'], ...measurements];
  return { filename: filename || `${part}_${time.replaceAll('/', '').replace(' ', '-').replaceAll(':', '')}.csv`, deviceId: 'test-device', content: rows.map(row => row.map(quote).join(',')).join('\r\n') + '\r\n' };
}
async function setup(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-vision-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, service: createVisionService({ root, now: () => Date.parse('2026-10-13T09:00:00Z'), ...options }) };
}
function collectorRecord(input) {
  const row = parseCsv(input);
  return { schema_version: 1, record_id: 'client-id-must-not-be-trusted', logical_key: 'client-key-must-not-be-trusted', device_id: row.deviceId, part_name: row.partName, serial_number: row.serialNumber, measured_at_local: row.measuredAt, source_result: row.sourceResult, source_file: input.filename,
    measurements: row.measurements.map(m => ({ name: m.name, nominal: m.nominal, lower_limit: m.lowerLimit, upper_limit: m.upperLimit, is_critical: m.isCritical, deviation: m.deviation, deviation_raw: m.deviationRaw, source_result: m.sourceResult, unit: null })) };
}
async function inputFile(root, records, extras = {}) {
  await fs.mkdir(path.join(root, 'runtime'), { recursive: true });
  await fs.writeFile(path.join(root, 'runtime/vision-input.json'), JSON.stringify({ schema_version: 1, records, last_scan: { scanned_at_utc: '2026-10-13T09:00:00+00:00', errors: [], deferred: 0 }, ...extras }));
}

test('CSV preserves UTF-8, quoted names, original results, 61 values and unknown units', () => {
  const source = fixture({ name: '测点,"甲"' }); source.content = Buffer.from('\uFEFF' + source.content);
  const row = parseCsv(source);
  assert.equal(row.measurements.length, 61);
  assert.equal(row.measurements[0].name, '测点,"甲"');
  assert.equal(row.measurements[0].unit, null);
  assert.equal(row.measuredAt, '2026-10-13T00:05:49');
  assert.equal(row.measurements.filter(m => m.isCritical).length, 59);
});

test('ALLmeasure and failure excluded in filename, path and metadata', () => {
  for (const filename of ['Tesla_Front12_ALLmeasure_20261013-000549.csv', 'D:\\backup\\Tesla_Front12_ALLmeasure\\Tesla_Front12_20261013-000549.csv', 'D:\\backup\\failure\\Tesla_Front12_20261013-000549.csv']) assert.throws(() => parseCsv(fixture({ filename })), /全检|普通/);
  const bad = fixture(); bad.content = bad.content.replace('PartName,Tesla_Front12', 'PartName,Tesla_Front12_ALLmeasure');
  assert.throws(() => parseCsv(bad), /型号/);
  assert.throws(() => parseCsv(fixture({ filename: 'Tesla_Front11_20261013-000549.csv' })), /型号/);
});

test('rejects incomplete, malformed, unsupported and invalid numeric CSV', () => {
  assert.throws(() => parseCsv(fixture({ count: 60 })), /61/);
  for (const deviation of ['', 'Infinity', '0x10', 'abc']) assert.throws(() => parseCsv(fixture({ deviation })), /偏差/);
  assert.throws(() => parseCsv(fixture({ time: '2026/02/30 00:05:49' })), /时间/);
  assert.throws(() => parseCsv(fixture({ result: 'PASS' })), /OK 或 NG/);
  const missingEnd = fixture(); missingEnd.content = missingEnd.content.trimEnd();
  assert.throws(() => parseCsv(missingEnd), /写入完成/);
  const duplicate = fixture(); duplicate.content = duplicate.content.replace('测点_2,', '测点_1,');
  assert.throws(() => parseCsv(duplicate), /重复/);
  const invalidUTF8 = fixture(); invalidUTF8.content = Buffer.concat([Buffer.from([0xff]), Buffer.from(invalidUTF8.content)]);
  assert.throws(() => parseCsv(invalidUTF8), /UTF-8/);
});

test('NaN becomes null with an explicit warning, without inventing an overall result', () => {
  const row = parseCsv(fixture({ deviation: 'NaN', result: 'OK' }));
  assert.equal(row.measurements[0].deviation, null);
  assert.equal(row.measurements[0].deviationRaw, 'NaN');
  assert.equal(row.sourceResult, 'OK');
  assert.match(row.warnings[0], /NaN/);
  const source = fixture(); source.content = source.content.replace('测点_61,10,-0.5,0.5,No,0.1,OK', '测点_61,10,-0.5,0.5,No,0.8,NG');
  const noncritical = parseCsv(source);
  assert.equal(noncritical.sourceResult, 'OK');
  assert.equal(noncritical.measurements[60].sourceResult, 'NG');
});

test('missing data gives empty counts and does not claim a successful live connection', async t => {
  const { service } = await setup(t);
  const report = await service.report();
  assert.equal(report.source.state, 'missing');
  assert.equal(report.summary.totalRecords, 0);
  assert.equal(report.summary.passRate, null);
  assert.equal(report.source.updatedAt, null);
});

test('manual CSV and collector JSON share semantic identity; supplied IDs are ignored', async t => {
  const { service, root } = await setup(t);
  assert.equal((await service.importCsv(fixture())).imported, 1);
  assert.equal((await service.importCsv(fixture({ reverse: true, deviation: '0.1000' }))).duplicates, 1);
  const input = collectorRecord(fixture());
  await inputFile(root, [input]);
  const report = await service.report();
  assert.equal(report.total, 1);
  assert.match(report.records[0].id, /^[a-f0-9]{64}$/);
  assert.equal(report.source.mode, 'file');
  const freshService = createVisionService({ root });
  assert.equal((await freshService.report()).total, 1);
});

test('same SN at a different time or device remains a separate detection', async t => {
  const { service } = await setup(t);
  await service.importCsv(fixture());
  await service.importCsv(fixture({ time: '2026/10/13 00:06:49' }));
  await service.importCsv({ ...fixture(), deviceId: 'another-test-device' });
  const report = await service.report();
  assert.equal(report.summary.totalRecords, 3);
  assert.equal(report.summary.eligibleRecords, 3);
  assert.equal(report.source.mode, 'import');
});

test('different versions of one detection are retained and excluded from rates even with a result filter', async t => {
  const { service } = await setup(t);
  await service.importCsv(fixture());
  const result = await service.importCsv(fixture({ result: 'NG', deviation: '0.8' }));
  assert.equal(result.conflicts, 1);
  const report = await service.report();
  assert.deepEqual(report.summary, { totalRecords: 2, eligibleRecords: 0, okRecords: 0, ngRecords: 0, conflictRecords: 2, passRate: null });
  assert.ok(report.records.every(r => r.identityConflict));
  const onlyOk = await service.report({ result: 'OK' });
  assert.equal(onlyOk.total, 1);
  assert.equal(onlyOk.summary.eligibleRecords, 0);
});

test('filters and pagination apply correctly while summary covers all filtered records', async t => {
  const { service } = await setup(t);
  await service.importCsv(fixture({ part: 'Tesla_Front11', time: '2026/10/12 00:05:49' }));
  await service.importCsv(fixture({ time: '2026/10/13 00:05:49' }));
  await service.importCsv(fixture({ sn: 'SYNTHETIC-TEST-002', time: '2026/10/13 00:06:49', result: 'NG' }));
  const report = await service.report(new URLSearchParams({ start: '2026-10-13', end: '2026-10-13', part: 'Tesla_Front12', search: 'test', pageSize: '1', page: '2' }));
  assert.equal(report.total, 2); assert.equal(report.records.length, 1);
  assert.equal(report.summary.passRate, 0.5); assert.equal(report.records[0].sourceResult, 'OK');
  for (const query of [{ start: '2026-02-30' }, { start: '2026-10-14', end: '2026-10-13' }, { part: 'Tesla_Front12_ALLmeasure' }, { result: 'PASS' }, { page: 0 }, { pageSize: 201 }, { page: '1e2' }]) await assert.rejects(service.report(query), { status: 400 });
});

test('daily trend uses each day denominator, preserves missing dates and ignores pagination', async t => {
  const { service } = await setup(t);
  await service.importCsv(fixture({ sn: 'SYNTHETIC-DAY10-OK', time: '2026/10/10 00:05:49' }));
  for (let i = 0; i < 3; i++) await service.importCsv(fixture({ sn: `SYNTHETIC-DAY12-${i}`, time: '2026/10/12 00:05:49', result: i === 0 ? 'OK' : 'NG' }));
  const first = await service.report({ pageSize: 1 });
  assert.equal(first.records.length, 1);
  assert.deepEqual(first.dailyTrend, [
    { date: '2026-10-10', totalRecords: 1, eligibleRecords: 1, okRecords: 1, ngRecords: 0, conflictRecords: 0, passRate: 1 },
    { date: '2026-10-12', totalRecords: 3, eligibleRecords: 3, okRecords: 1, ngRecords: 2, conflictRecords: 0, passRate: 1 / 3 }
  ]);
  assert.equal(first.summary.passRate, 2 / 4);
  assert.notEqual(first.summary.passRate, (1 + 1 / 3) / 2);
  for (const page of [2, 4, 99]) {
    const next = await service.report({ pageSize: 1, page });
    assert.deepEqual(next.dailyTrend, first.dailyTrend);
    assert.deepEqual(next.summary, first.summary);
  }
});

test('daily trend respects model, date, search and result filters separately and together', async t => {
  const { service } = await setup(t);
  for (const [day, part, sn, result] of [
    ['12', 'Tesla_Front11', 'SYNTHETIC-KEEP-A', 'OK'],
    ['12', 'Tesla_Front11', 'SYNTHETIC-KEEP-B', 'NG'],
    ['12', 'Tesla_Front12', 'SYNTHETIC-KEEP-C', 'NG'],
    ['13', 'Tesla_Front11', 'SYNTHETIC-KEEP-D', 'OK'],
    ['13', 'Tesla_Front12', 'SYNTHETIC-OTHER-E', 'OK'],
    ['14', 'Tesla_Front12', 'SYNTHETIC-KEEP-F', 'NG']
  ]) await service.importCsv(fixture({ part, sn, time: `2026/10/${day} 00:05:49`, result }));
  const cases = [
    [{ part: 'Tesla_Front11' }, [['2026-10-12', 2, 1, 1, 0.5], ['2026-10-13', 1, 1, 0, 1]]],
    [{ start: '2026-10-13', end: '2026-10-14' }, [['2026-10-13', 2, 2, 0, 1], ['2026-10-14', 1, 0, 1, 0]]],
    [{ search: 'keep' }, [['2026-10-12', 3, 1, 2, 1 / 3], ['2026-10-13', 1, 1, 0, 1], ['2026-10-14', 1, 0, 1, 0]]],
    [{ result: 'NG' }, [['2026-10-12', 2, 0, 2, 0], ['2026-10-14', 1, 0, 1, 0]]],
    [{ part: 'Tesla_Front11', start: '2026-10-12', end: '2026-10-12', search: 'keep', result: 'NG' }, [['2026-10-12', 1, 0, 1, 0]]]
  ];
  for (const [query, expected] of cases) {
    const report = await service.report({ ...query, pageSize: 1 });
    assert.deepEqual(report.dailyTrend.map(day => [day.date, day.totalRecords, day.okRecords, day.ngRecords, day.passRate]), expected);
    assert.ok(report.dailyTrend.every(day => day.eligibleRecords === day.totalRecords && day.conflictRecords === 0));
    assert.equal(report.dailyTrend.reduce((sum, day) => sum + day.totalRecords, 0), report.summary.totalRecords);
  }
});

test('daily trend keeps global conflict exclusions when a result filter hides another version', async t => {
  const { service } = await setup(t);
  await service.importCsv(fixture({ sn: 'SYNTHETIC-CONFLICT', time: '2026/10/12 00:05:49' }));
  await service.importCsv(fixture({ sn: 'SYNTHETIC-CONFLICT', time: '2026/10/12 00:05:49', result: 'NG', deviation: '0.8' }));
  await service.importCsv(fixture({ sn: 'SYNTHETIC-VALID', time: '2026/10/13 00:05:49' }));
  const all = await service.report();
  assert.deepEqual(all.dailyTrend[0], { date: '2026-10-12', totalRecords: 2, eligibleRecords: 0, okRecords: 0, ngRecords: 0, conflictRecords: 2, passRate: null });
  const onlyOk = await service.report({ result: 'OK' });
  assert.deepEqual(onlyOk.dailyTrend, [
    { date: '2026-10-12', totalRecords: 1, eligibleRecords: 0, okRecords: 0, ngRecords: 0, conflictRecords: 1, passRate: null },
    { date: '2026-10-13', totalRecords: 1, eligibleRecords: 1, okRecords: 1, ngRecords: 0, conflictRecords: 0, passRate: 1 }
  ]);
  const onlyNg = await service.report({ result: 'NG' });
  assert.deepEqual(onlyNg.dailyTrend, [{ date: '2026-10-12', totalRecords: 1, eligibleRecords: 0, okRecords: 0, ngRecords: 0, conflictRecords: 1, passRate: null }]);
  assert.equal(onlyNg.summary.passRate, null);
});

test('daily trend is empty for no data or a filter matching no detection', async t => {
  const { service } = await setup(t);
  assert.deepEqual((await service.report()).dailyTrend, []);
  await service.importCsv(fixture());
  const noDate = await service.report({ start: '2026-10-14', end: '2026-10-15' });
  assert.deepEqual(noDate.dailyTrend, []);
  assert.equal(noDate.summary.passRate, null);
  assert.deepEqual((await service.report({ search: 'SYNTHETIC-NOT-PRESENT' })).dailyTrend, []);
});

test('single-day hourly trend uses sparse local hours and the full filtered denominators before pagination', async t => {
  const { service } = await setup(t);
  for (const [time, result, sn] of [
    ['2026/10/13 01:59:59', 'OK', 'SYNTHETIC-HOUR01'],
    ['2026/10/13 23:00:00', 'OK', 'SYNTHETIC-HOUR23-A'],
    ['2026/10/13 23:15:00', 'NG', 'SYNTHETIC-HOUR23-B'],
    ['2026/10/13 23:59:59', 'NG', 'SYNTHETIC-HOUR23-C'],
    ['2026/10/14 01:00:00', 'NG', 'SYNTHETIC-NEXT-DAY']
  ]) await service.importCsv(fixture({ time, result, sn }));
  const query = { start: '2026-10-13', end: '2026-10-13', pageSize: 1 };
  const report = await service.report(query);
  assert.deepEqual(report.hourlyTrend, [
    { hour: '2026-10-13T01:00', totalRecords: 1, eligibleRecords: 1, okRecords: 1, ngRecords: 0, conflictRecords: 0, passRate: 1 },
    { hour: '2026-10-13T23:00', totalRecords: 3, eligibleRecords: 3, okRecords: 1, ngRecords: 2, conflictRecords: 0, passRate: 1 / 3 }
  ]);
  assert.equal(report.records.length, 1);
  assert.equal(report.summary.passRate, 0.5);
  assert.equal(report.dailyTrend[0].passRate, 0.5);
  for (const field of ['totalRecords', 'eligibleRecords', 'okRecords', 'ngRecords', 'conflictRecords']) {
    assert.equal(report.hourlyTrend.reduce((sum, point) => sum + point[field], 0), report.dailyTrend[0][field]);
  }
  assert.deepEqual((await service.report({ ...query, page: 4 })).hourlyTrend, report.hourlyTrend);
  assert.deepEqual((await service.report({ ...query, result: 'NG' })).hourlyTrend, [
    { hour: '2026-10-13T23:00', totalRecords: 2, eligibleRecords: 2, okRecords: 0, ngRecords: 2, conflictRecords: 0, passRate: 0 }
  ]);
});

test('hourly trend is null without an explicit single-day range and empty for a day without records', async t => {
  const { service } = await setup(t);
  await service.importCsv(fixture());
  for (const query of [{}, { start: '2026-10-13' }, { end: '2026-10-13' }, { start: '2026-10-12', end: '2026-10-13' }]) {
    assert.equal((await service.report(query)).hourlyTrend, null);
  }
  const empty = await service.report({ start: '2026-10-14', end: '2026-10-14' });
  assert.deepEqual(empty.hourlyTrend, []);
  assert.deepEqual(empty.dailyTrend, []);
});

test('hourly trend retains null for a conflict-only hour even when the other version is filtered out', async t => {
  const { service } = await setup(t);
  await service.importCsv(fixture({ time: '2026/10/13 03:05:49' }));
  await service.importCsv(fixture({ time: '2026/10/13 03:05:49', result: 'NG', deviation: '0.8' }));
  await service.importCsv(fixture({ time: '2026/10/13 05:05:49' }));
  const report = await service.report({ start: '2026-10-13', end: '2026-10-13', result: 'OK' });
  assert.deepEqual(report.hourlyTrend, [
    { hour: '2026-10-13T03:00', totalRecords: 1, eligibleRecords: 0, okRecords: 0, ngRecords: 0, conflictRecords: 1, passRate: null },
    { hour: '2026-10-13T05:00', totalRecords: 1, eligibleRecords: 1, okRecords: 1, ngRecords: 0, conflictRecords: 0, passRate: 1 }
  ]);
  assert.equal(report.dailyTrend[0].eligibleRecords, 1);
  assert.equal(report.dailyTrend[0].conflictRecords, 1);
  assert.equal(report.dailyTrend[0].passRate, 1);
});

test('minute filters include both boundary minutes completely without altering timestamps', async t => {
  const { service } = await setup(t);
  for (const [time, result] of [['10:06:59', 'NG'], ['10:07:00', 'OK'], ['10:07:59', 'NG'], ['10:08:00', 'OK']]) {
    await service.importCsv(fixture({ time: `2026/10/13 ${time}`, result }));
  }
  const report = await service.report({ start: '2026-10-13T10:07', end: '2026-10-13T10:07' });
  assert.equal(report.total, 2);
  assert.deepEqual(report.records.map(r => r.measuredAt), ['2026-10-13T10:07:59', '2026-10-13T10:07:00']);
  assert.equal(report.summary.passRate, 0.5);
  assert.equal(report.trend.interval, '15m');
  assert.equal(report.trend.bucketMinutes, 15);
  assert.deepEqual(report.trend.points, [{ period: '2026-10-13T10:00', totalRecords: 2, eligibleRecords: 2, okRecords: 1, ngRecords: 1, conflictRecords: 0, passRate: 0.5 }]);
  assert.equal(report.hourlyTrend[0].hour, '2026-10-13T10:00');
});

test('date-only and mixed bounds use whole-day start and end rather than string-length ordering', async t => {
  const { service } = await setup(t);
  for (const time of ['2026/10/13 00:00:00', '2026/10/13 12:00:00', '2026/10/13 23:59:59', '2026/10/14 00:00:00']) await service.importCsv(fixture({ time }));
  assert.equal((await service.report({ start: '2026-10-13', end: '2026-10-13' })).total, 3);
  assert.equal((await service.report({ start: '2026-10-13', end: '2026-10-13T00:00' })).total, 1);
  const afternoon = await service.report({ start: '2026-10-13T12:00', end: '2026-10-13' });
  assert.equal(afternoon.total, 2);
  assert.equal(afternoon.trend.interval, '15m');
  assert.equal(afternoon.hourlyTrend.length, 2);
  for (const query of [
    { start: '2026-10-13T12:01', end: '2026-10-13T12:00' },
    { start: '2026-10-14', end: '2026-10-13T23:59' },
    { start: '2026-10-14T00:00', end: '2026-10-13' }
  ]) await assert.rejects(service.report(query), { status: 400 });
});

test('time ranges crossing midnight retain separate local-day buckets and use daily auto grouping', async t => {
  const { service } = await setup(t);
  for (const time of ['2026/10/13 23:59:59', '2026/10/14 00:00:00', '2026/10/14 00:00:59', '2026/10/14 00:01:00']) await service.importCsv(fixture({ time }));
  const query = { start: '2026-10-13T23:59', end: '2026-10-14T00:00' };
  const report = await service.report(query);
  assert.equal(report.total, 3);
  assert.equal(report.hourlyTrend, null);
  assert.equal(report.trend.interval, 'day');
  assert.equal(report.trend.bucketMinutes, 1440);
  assert.deepEqual(report.trend.points.map(p => [p.period, p.totalRecords]), [['2026-10-13', 1], ['2026-10-14', 2]]);
  const fine = await service.report({ ...query, interval: '5m' });
  assert.deepEqual(fine.trend.points.map(p => [p.period, p.totalRecords]), [['2026-10-13T23:55', 1], ['2026-10-14T00:00', 2]]);
});

test('time and interval validation rejects impossible or unsupported values', async t => {
  const { service } = await setup(t);
  for (const value of ['2026-02-30T10:00', '2026-10-13T24:00', '2026-10-13T10:60', '2026-10-13T1:00', '2026-10-13 10:00', '2026-10-13T10:00:00', '2026-10-13T10:00Z', 0]) {
    await assert.rejects(service.report({ start: value }), { status: 400 });
    await assert.rejects(service.report({ end: value }), { status: 400 });
  }
  for (const interval of ['minute', '10m', '60m', 'DAY', 'constructor', ['5m'], 0, false]) await assert.rejects(service.report({ interval }), { status: 400 });
});

test('5, 15 and 30 minute buckets round down on boundaries and retain summary and pagination totals', async t => {
  const { service } = await setup(t);
  const times = ['10:04:59', '10:05:00', '10:14:59', '10:15:00', '10:29:59', '10:30:00', '10:59:59', '11:00:00'];
  for (const [index, time] of times.entries()) await service.importCsv(fixture({ time: `2026/10/13 ${time}`, result: index % 3 === 0 ? 'NG' : 'OK' }));
  const cases = [
    ['5m', 5, [['10:00', 1], ['10:05', 1], ['10:10', 1], ['10:15', 1], ['10:25', 1], ['10:30', 1], ['10:55', 1], ['11:00', 1]]],
    ['15m', 15, [['10:00', 3], ['10:15', 2], ['10:30', 1], ['10:45', 1], ['11:00', 1]]],
    ['30m', 30, [['10:00', 5], ['10:30', 2], ['11:00', 1]]],
    ['hour', 60, [['10:00', 7], ['11:00', 1]]],
    ['day', 1440, [['2026-10-13', 8]]]
  ];
  for (const [interval, minutes, expected] of cases) {
    const query = { start: '2026-10-13', end: '2026-10-13', interval, pageSize: 1 };
    const report = await service.report(query);
    assert.equal(report.trend.interval, interval);
    assert.equal(report.trend.bucketMinutes, minutes);
    assert.deepEqual(report.trend.points.map(p => [interval === 'day' ? p.period : p.period.slice(11), p.totalRecords]), expected);
    for (const field of ['totalRecords', 'eligibleRecords', 'okRecords', 'ngRecords', 'conflictRecords']) {
      assert.equal(report.trend.points.reduce((sum, point) => sum + point[field], 0), report.summary[field]);
    }
    assert.equal(report.summary.passRate, 5 / 8);
    assert.deepEqual((await service.report({ ...query, page: 8 })).trend, report.trend);
  }
  assert.equal((await service.report()).trend.interval, 'day');
  assert.deepEqual((await service.report({ start: '2026-10-14', end: '2026-10-14', interval: '5m' })).trend.points, []);
});

test('fine trend uses all active filters and keeps conflicts excluded across a result filter', async t => {
  const { service } = await setup(t);
  const shared = { part: 'Tesla_Front11', sn: 'SYNTHETIC-FINE-KEEP', time: '2026/10/13 10:07:00' };
  await service.importCsv(fixture(shared));
  await service.importCsv(fixture({ ...shared, result: 'NG', deviation: '0.8' }));
  await service.importCsv(fixture({ ...shared, time: '2026/10/13 10:22:00' }));
  await service.importCsv(fixture({ ...shared, part: 'Tesla_Front12' }));
  await service.importCsv(fixture({ ...shared, sn: 'SYNTHETIC-FINE-OTHER' }));
  const report = await service.report({ start: '2026-10-13T10:07', end: '2026-10-13T10:22', part: 'Tesla_Front11', search: 'keep', result: 'OK', interval: '15m', pageSize: 1 });
  assert.deepEqual(report.trend.points, [
    { period: '2026-10-13T10:00', totalRecords: 1, eligibleRecords: 0, okRecords: 0, ngRecords: 0, conflictRecords: 1, passRate: null },
    { period: '2026-10-13T10:15', totalRecords: 1, eligibleRecords: 1, okRecords: 1, ngRecords: 0, conflictRecords: 0, passRate: 1 }
  ]);
  assert.equal(report.summary.totalRecords, 2);
  assert.equal(report.summary.eligibleRecords, 1);
});

test('recent limit follows all filters and drives summary, each trend and pagination together', async t => {
  const { service } = await setup(t);
  for (const [time, part, sn, result] of [
    ['2026/10/12 10:00:00', 'Tesla_Front11', 'SYNTHETIC-MATCH-OLD', 'OK'],
    ['2026/10/13 10:00:00', 'Tesla_Front11', 'SYNTHETIC-MATCH-A', 'NG'],
    ['2026/10/13 10:05:00', 'Tesla_Front11', 'SYNTHETIC-MATCH-B', 'OK'],
    ['2026/10/13 10:10:00', 'Tesla_Front11', 'SYNTHETIC-MATCH-C', 'NG'],
    ['2026/10/13 10:15:00', 'Tesla_Front12', 'SYNTHETIC-MATCH-D', 'OK'],
    ['2026/10/13 10:20:00', 'Tesla_Front11', 'SYNTHETIC-OTHER-E', 'OK'],
    ['2026/10/13 10:25:00', 'Tesla_Front11', 'SYNTHETIC-MATCH-F', 'OK']
  ]) await service.importCsv(fixture({ time, part, sn, result }));
  const query = { start: '2026-10-13T10:00', end: '2026-10-13T10:20', part: 'Tesla_Front11', search: 'match', recentLimit: '2', interval: '5m', pageSize: 1 };
  const first = await service.report(query), second = await service.report({ ...query, page: 2 });
  assert.deepEqual(first.selection, { recentLimit: 2, matchedRecords: 3, selectedRecords: 2 });
  assert.equal(first.total, 2);
  assert.equal(first.records[0].measuredAt, '2026-10-13T10:10:00');
  assert.equal(second.records[0].measuredAt, '2026-10-13T10:05:00');
  assert.deepEqual(first.summary, { totalRecords: 2, eligibleRecords: 2, okRecords: 1, ngRecords: 1, conflictRecords: 0, passRate: 0.5 });
  for (const points of [first.dailyTrend, first.hourlyTrend, first.trend.points]) {
    for (const field of ['totalRecords', 'eligibleRecords', 'okRecords', 'ngRecords', 'conflictRecords']) assert.equal(points.reduce((sum, p) => sum + p[field], 0), first.summary[field]);
  }
  for (const key of ['selection', 'summary', 'dailyTrend', 'hourlyTrend', 'trend']) assert.deepEqual(second[key], first[key]);
  assert.deepEqual((await service.report({ ...query, page: 3 })).records, []);
  const onlyOk = await service.report({ ...query, result: 'OK', recentLimit: 1 });
  assert.deepEqual(onlyOk.selection, { recentLimit: 1, matchedRecords: 1, selectedRecords: 1 });
  assert.equal(onlyOk.records[0].measuredAt, '2026-10-13T10:05:00');
});

test('recent limit has a stable tie order independent of import order and service restart', async t => {
  const firstSetup = await setup(t), secondSetup = await setup(t);
  const inputs = ['SYNTHETIC-TIE-A', 'SYNTHETIC-TIE-B', 'SYNTHETIC-TIE-C'].map(sn => fixture({ sn }));
  for (const input of inputs) await firstSetup.service.importCsv(input);
  for (const input of [...inputs].reverse()) await secondSetup.service.importCsv(input);
  const expected = inputs.map(input => parseCsv(input).id).sort().slice(0, 2);
  for (const service of [firstSetup.service, secondSetup.service, createVisionService({ root: firstSetup.root })]) {
    const report = await service.report({ recentLimit: 2 });
    assert.deepEqual(report.records.map(r => r.id), expected);
    assert.deepEqual(report.selection, { recentLimit: 2, matchedRecords: 3, selectedRecords: 2 });
  }
});

test('recent limit accepts all defaults and short result sets but rejects invalid quantities', async t => {
  const { service } = await setup(t);
  await service.importCsv(fixture());
  for (const recentLimit of [undefined, '', 'all']) {
    const report = await service.report({ recentLimit });
    assert.deepEqual(report.selection, { recentLimit: null, matchedRecords: 1, selectedRecords: 1 });
  }
  for (const recentLimit of [500, '20000']) {
    const report = await service.report({ recentLimit });
    assert.deepEqual(report.selection, { recentLimit: Number(recentLimit), matchedRecords: 1, selectedRecords: 1 });
  }
  const empty = await service.report({ recentLimit: 500, search: 'SYNTHETIC-NO-MATCH' });
  assert.deepEqual(empty.selection, { recentLimit: 500, matchedRecords: 0, selectedRecords: 0 });
  assert.deepEqual(empty.trend.points, []);
  for (const recentLimit of [0, -1, 1.5, 20001, '1.0', '1e2', 'ALL', ' 500 ', false, ['1'], {}, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(service.report({ recentLimit }), { status: 400 });
});

test('recent limit cannot hide conflicts when another version lies outside the selected records', async t => {
  const { service } = await setup(t);
  await service.importCsv(fixture());
  await service.importCsv(fixture({ result: 'NG', deviation: '0.8' }));
  const report = await service.report({ start: '2026-10-13', end: '2026-10-13', recentLimit: 1 });
  assert.deepEqual(report.selection, { recentLimit: 1, matchedRecords: 2, selectedRecords: 1 });
  assert.equal(report.records[0].identityConflict, true);
  assert.deepEqual(report.summary, { totalRecords: 1, eligibleRecords: 0, okRecords: 0, ngRecords: 0, conflictRecords: 1, passRate: null });
  for (const points of [report.dailyTrend, report.hourlyTrend, report.trend.points]) {
    assert.equal(points.length, 1);
    assert.equal(points[0].conflictRecords, 1);
    assert.equal(points[0].eligibleRecords, 0);
    assert.equal(points[0].passRate, null);
  }
});

test('catalog-backed exact line and device scopes apply before recent limits and preserve legacy all scope', async t => {
  const { service } = await setup(t);
  await service.importCsv({ ...fixture({ time: '2026/10/13 10:00:00', sn: 'SYNTHETIC-CONFIGURED-OLD', result: 'NG' }), deviceId: 'vision-01' });
  await service.importCsv({ ...fixture({ time: '2026/10/13 10:05:00', sn: 'SYNTHETIC-CONFIGURED-NEW' }), deviceId: 'vision-01' });
  await service.importCsv({ ...fixture({ time: '2026/10/13 11:00:00', sn: 'SYNTHETIC-LEGACY' }), deviceId: 'legacy-device' });
  const all = await service.report();
  assert.equal(all.total, 3);
  assert.deepEqual(all.scope, { lineId: 'all', deviceId: 'all', pending: false });
  const query = { lineId: 'front-subframe', deviceId: 'vision-01', recentLimit: 1, start: '2026-10-13', end: '2026-10-13' };
  const scoped = await service.report(query);
  assert.deepEqual(scoped.selection, { recentLimit: 1, matchedRecords: 2, selectedRecords: 1 });
  assert.deepEqual(scoped.scope, { lineId: 'front-subframe', deviceId: 'vision-01', pending: false });
  assert.equal(scoped.records[0].serialNumber, 'SYNTHETIC-CONFIGURED-NEW');
  assert.equal(scoped.summary.passRate, 1);
  assert.equal(scoped.trend.points.reduce((sum, point) => sum + point.totalRecords, 0), 1);
  assert.equal(scoped.source.deviceId, 'vision-01');
  assert.equal(scoped.source.lineId, 'front-subframe');
  assert.equal((await service.report({ lineId: 'front-subframe' })).total, 2);
  assert.equal((await service.report({ deviceId: 'vision-01' })).total, 2);
});

test('pending catalog devices exclude matching legacy records and pending scopes never reuse current source data', async t => {
  const { service, root } = await setup(t);
  await service.importCsv({ ...fixture(), deviceId: 'vision-01' });
  await service.importCsv({ ...fixture({ sn: 'SYNTHETIC-NOT-CONNECTED' }), deviceId: 'synthetic-pending' });
  assert.equal((await service.report()).total, 2);
  const registration = await service.saveDraft({ deviceId: 'synthetic-pending', name: '合成待配置检具', lineName: '合成其他线体', transport: 'share', sourcePath: 'Z:\\SyntheticOnly\\never-read.json', partNames: ['SyntheticOther'], measurementCount: 42 });
  const { lineId } = registration.device;
  assert.equal((await service.catalog()).devices.length, 2);
  assert.equal((await service.report()).total, 1);
  const realStat = fs.stat.bind(fs), input = path.join(root, 'runtime/vision-input.json');
  const guard = t.mock.method(fs, 'stat', async (target, ...args) => { assert.notEqual(String(target), input, 'Pending scopes must not read the configured current source'); return realStat(target, ...args); });
  for (const query of [{ lineId }, { deviceId: 'synthetic-pending' }, { lineId, deviceId: 'synthetic-pending', recentLimit: 500 }]) {
    const report = await service.report(query);
    assert.equal(report.total, 0);
    assert.equal(report.scope.pending, true);
    assert.equal(report.source.state, 'pending');
    assert.equal(report.source.mode, 'unconfigured');
    assert.equal(report.source.checkedAt, null);
    assert.equal(report.source.updatedAt, null);
    assert.equal(report.source.collectorCheckedAt, null);
    assert.equal(report.summary.passRate, null);
    assert.deepEqual(report.dailyTrend, []);
    assert.deepEqual(report.trend.points, []);
  }
  guard.mock.restore();
  assert.equal((await createVisionService({ root }).report({ lineId })).scope.pending, true);
});

test('unknown or mismatched catalog selectors are rejected rather than falling back to all records', async t => {
  const { service } = await setup(t);
  const saved = await service.saveDraft({ deviceId: 'synthetic-pending', name: '合成待配置检具', lineName: '合成其他线体', transport: 'upload' });
  for (const query of [
    { lineId: 'unknown-line' }, { deviceId: 'unknown-device' }, { lineId: '../bad' }, { deviceId: ['vision-01'] },
    { lineId: 'front-subframe', deviceId: 'synthetic-pending' }, { lineId: saved.device.lineId, deviceId: 'vision-01' }
  ]) await assert.rejects(service.report(query), { status: 400 });
});

test('pending devices on the configured line remain empty individually without hiding its configured device', async t => {
  const { service } = await setup(t);
  await service.importCsv({ ...fixture(), deviceId: 'vision-01' });
  await service.saveDraft({ deviceId: 'synthetic-front-pending', name: '合成前副备用检具', lineId: 'front-subframe', transport: 'upload' });
  const line = await service.report({ lineId: 'front-subframe' });
  assert.equal(line.scope.pending, false); assert.equal(line.total, 1);
  const device = await service.report({ lineId: 'front-subframe', deviceId: 'synthetic-front-pending' });
  assert.equal(device.scope.pending, true); assert.equal(device.total, 0);
});

test('invalid JSON batch imports nothing and keeps the last successful records', async t => {
  const { service, root } = await setup(t);
  await service.importCsv(fixture());
  const valid = collectorRecord(fixture({ sn: 'SYNTHETIC-NEW' }));
  const invalid = collectorRecord(fixture({ sn: 'SYNTHETIC-BAD' })); invalid.measurements[0].deviation = null;
  await inputFile(root, [valid, invalid]);
  const report = await service.report();
  assert.equal(report.source.state, 'error');
  assert.equal(report.total, 1);
  assert.match(report.source.message, /保留上次/);
  assert.equal(report.source.updatedAt, '2026-10-13T09:00:00.000Z');
  await fs.writeFile(path.join(root, 'runtime/vision-input.json'), '{ incomplete');
  assert.equal((await service.report()).total, 1);
});

test('JSON does not accept forged models, names, booleans or raw numeric values', async t => {
  const { service, root } = await setup(t);
  const mutations = [r => { r.part_name = 'Tesla_Front12_ALLmeasure'; }, r => { r.source_path = 'D:\\backup\\failure\\Tesla_Front12_20261013-000549.csv'; }, r => { r.measurements[0].deviation = '0.1'; }, r => { r.measurements[0].is_critical = 'false'; }, r => { r.measurements[0].deviation_raw = '0.2'; }, r => { r.source_result = 'PASS'; }];
  for (const mutate of mutations) {
    const record = collectorRecord(fixture()); mutate(record); await inputFile(root, [record]);
    const report = await service.report(); assert.equal(report.source.state, 'error'); assert.equal(report.total, 0);
  }
});

test('source scan errors stay visible and do not assert coverage', async t => {
  const { service, root } = await setup(t);
  await inputFile(root, [collectorRecord(fixture())], { last_scan: { errors: [{ error: 'unfinished' }], deferred: 1 } });
  const report = await service.report();
  assert.equal(report.total, 1); assert.equal(report.source.state, 'error');
  assert.match(report.source.message, /不代表全部/);
});

test('default scan age is ready through 7200 seconds, waiting at 7201, and recovers without losing statistics', async t => {
  let current = Date.parse('2026-10-13T09:00:00Z');
  const { service, root } = await setup(t, { now: () => current });
  await inputFile(root, [collectorRecord(fixture())]);
  const initial = await service.report();
  assert.equal(initial.source.state, 'ready');
  current += 7200000;
  assert.equal((await service.report()).source.state, 'ready');
  current += 1000;
  const stale = await service.report();
  assert.equal(stale.source.state, 'waiting'); assert.match(stale.source.message, /共享文件可读取.*2 小时.*等待采集更新/);
  assert.doesNotMatch(stale.source.message, /断线|断连|停止读取/);
  assert.equal(stale.source.collectorCheckedAt, '2026-10-13T09:00:00.000Z');
  assert.equal(stale.total, 1);
  assert.deepEqual(stale.summary, initial.summary);
  assert.deepEqual(stale.trend, initial.trend);
  assert.equal((await service.detail(stale.records[0].id)).measurements.length, 61);
  await inputFile(root, [collectorRecord(fixture())], { last_scan: { scanned_at_utc: new Date(current).toISOString(), errors: [], deferred: 0 } });
  const fresh = await service.report();
  assert.equal(fresh.source.state, 'ready'); assert.equal(fresh.total, 1);
  assert.deepEqual(fresh.summary, initial.summary);
  assert.equal(fresh.source.updatedAt, '2026-10-13T09:00:00.000Z');
  assert.equal(fresh.source.collectorCheckedAt, '2026-10-13T11:00:01.000Z');
});

test('fresh collector scans stay ready after two hours and longer without any new detections', async t => {
  let current = Date.parse('2026-10-13T09:00:00Z');
  const { service, root } = await setup(t, { now: () => current });
  const record = collectorRecord(fixture());
  await inputFile(root, [record]);
  const before = await service.report();
  for (const elapsed of [2 * 3600000, 7 * 86400000]) {
    current += elapsed;
    await inputFile(root, [record], { last_scan: { scanned_at_utc: new Date(current).toISOString(), errors: [], deferred: 0 } });
    const after = await service.report();
    assert.equal(after.source.state, 'ready');
    assert.equal(after.source.updatedAt, before.source.updatedAt);
    assert.notEqual(after.source.collectorCheckedAt, before.source.collectorCheckedAt);
    assert.deepEqual(after.summary, before.summary);
  }
});

test('existing configured scan-age thresholds still apply and use waiting for readable stale data', async t => {
  for (const maxScanAgeSeconds of [30, 120]) {
    let current = Date.parse('2026-10-13T09:00:00Z');
    const { service, root } = await setup(t, { now: () => current, config: { vision: { maxScanAgeSeconds } } });
    await inputFile(root, [collectorRecord(fixture())]);
    current += maxScanAgeSeconds * 1000;
    assert.equal((await service.report()).source.state, 'ready');
    current += 1000;
    const report = await service.report();
    assert.equal(report.source.state, 'waiting');
    assert.match(report.source.message, maxScanAgeSeconds === 30 ? /30 秒/ : /2 分钟/);
    assert.equal(report.summary.totalRecords, 1);
  }
});

test('source scan failures remain errors even when the scan is old enough to wait', async t => {
  const { service, root } = await setup(t, { now: () => Date.parse('2026-10-13T12:00:00Z') });
  await inputFile(root, [collectorRecord(fixture())], { last_scan: { scanned_at_utc: '2026-10-13T09:00:00Z', errors: [{ error: 'synthetic read failure' }], deferred: 0 } });
  const report = await service.report();
  assert.equal(report.source.state, 'error');
  assert.match(report.source.message, /1 个文件读取失败/);
  assert.doesNotMatch(report.source.message, /等待采集更新/);
  assert.equal(report.summary.totalRecords, 1);
});

test('waiting never conceals invalid JSON, missing files or failed file reads', async t => {
  let current = Date.parse('2026-10-13T09:00:00Z');
  const { service, root } = await setup(t, { now: () => current });
  const file = path.join(root, 'runtime/vision-input.json');
  await inputFile(root, [collectorRecord(fixture())]);
  const initial = await service.report();
  current += 7201000;
  assert.equal((await service.report()).source.state, 'waiting');
  await fs.writeFile(file, '{ not valid JSON');
  const invalid = await service.report();
  assert.equal(invalid.source.state, 'error');
  assert.deepEqual(invalid.summary, initial.summary);
  await fs.rm(file);
  const missing = await service.report();
  assert.equal(missing.source.state, 'missing');
  assert.deepEqual(missing.summary, initial.summary);
  const originalStat = fs.stat.bind(fs);
  const denied = t.mock.method(fs, 'stat', async (target, ...args) => {
    if (String(target) === file) throw Object.assign(new Error('synthetic denied read'), { code: 'EACCES' });
    return originalStat(target, ...args);
  });
  const inaccessible = await service.report();
  denied.mock.restore();
  assert.equal(inaccessible.source.state, 'error');
  assert.deepEqual(inaccessible.summary, initial.summary);
});

test('missing, invalid or future collector timestamps cannot appear as a healthy file source', async t => {
  const { service, root } = await setup(t);
  for (const scanned_at_utc of [undefined, 'bad', '2026-02-30T09:00:00Z', '2026-10-13T09:01:00Z']) {
    await inputFile(root, [collectorRecord(fixture())], { last_scan: { scanned_at_utc } });
    const report = await service.report(); assert.equal(report.source.state, 'error'); assert.equal(report.total, 1);
    assert.match(report.source.message, /无法确认|不能确认/);
    assert.doesNotMatch(report.source.message, /等待采集更新/);
  }
});

test('missing former automatic source is not hidden by earlier manual imports, including after restart', async t => {
  const { service, root } = await setup(t);
  await service.importCsv(fixture());
  await inputFile(root, [collectorRecord(fixture())]);
  assert.equal((await service.report()).source.state, 'ready');
  await fs.rm(path.join(root, 'runtime/vision-input.json'));
  for (const current of [service, createVisionService({ root })]) {
    const report = await current.report(); assert.equal(report.source.state, 'missing'); assert.equal(report.source.mode, 'file');
    assert.equal(report.source.collectorCheckedAt, '2026-10-13T09:00:00.000Z'); assert.equal(report.total, 1);
  }
});

test('concurrent imports are serialized and survive restarting the service', async t => {
  const { service, root } = await setup(t);
  await Promise.all(Array.from({ length: 8 }, (_, i) => service.importCsv(fixture({ sn: `SYNTHETIC-CONCURRENT-${i}` }))));
  assert.equal((await service.report()).total, 8);
  assert.equal((await createVisionService({ root }).report()).total, 8);
  const files = await fs.readdir(path.join(root, 'runtime/vision'));
  assert.deepEqual(files, ['records.json']);
});

test('failed atomic replacement leaves old disk and in-memory records intact', async t => {
  const { service, root } = await setup(t);
  await service.importCsv(fixture());
  const store = path.join(root, 'runtime/vision/records.json'), before = await fs.readFile(store, 'utf8');
  const rename = t.mock.method(fs, 'rename', async () => { throw Object.assign(new Error('synthetic disk failure'), { code: 'EIO' }); });
  await assert.rejects(service.importCsv(fixture({ sn: 'SYNTHETIC-UNSAVED' })), { status: 503 });
  rename.mock.restore();
  assert.equal(await fs.readFile(store, 'utf8'), before);
  assert.equal((await service.report()).total, 1);
  assert.deepEqual(await fs.readdir(path.dirname(store)), ['records.json']);
});

test('details are isolated from caller mutations and unknown IDs are rejected', async t => {
  const { service } = await setup(t);
  await service.importCsv(fixture());
  const report = await service.report(), id = report.records[0].id;
  const detail = await service.detail(id);
  assert.equal(detail.measurements.length, 61);
  detail.measurements[0].deviation = 999;
  assert.equal((await service.detail(id)).measurements[0].deviation, 0.1);
  await assert.rejects(service.detail('a'.repeat(64)), { status: 404 });
  await assert.rejects(service.detail('../records.json'), { status: 400 });
});
