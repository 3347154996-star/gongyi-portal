const test = require('node:test');
const assert = require('node:assert/strict');
const stats = require('../public/vision-mes-statistics.js');

function sample(values, change = {}) {
  const records = values.map((value, i) => ({ recordId: String(i + 1), barcode: 'SYNTHETIC-RETEST', measuredAt: new Date(Date.UTC(2026, 0, 1, i)).toISOString(),
    lineCode: 'LINE', processCode: 'PROC', partCode: 'PART', partName: '合成物料', deviceCode: 'DEVICE', deviceName: '合成检具', productionLine: '11', result: i % 2 ? 'NG' : 'OK' }));
  const details = records.map((record, i) => ({ ...record, measurements: [{ key: 'x', name: '合成 X 点', actual: values[i], actualRaw: String(values[i]), lowerLimit: -10, upperLimit: 10, result: 'OK', ...change }] }));
  return { report: { records, coverage: { complete: true }, filters: { result: 'all' } }, details };
}
function close(actual, expected, epsilon = 1e-10) { assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`); }

test('sample standard deviation, numerical counts and raw source judgments remain independent', () => {
  const input = sample([1, 2, 3, null, NaN, '4']);
  input.details[0].measurements[0].result = 'NG';input.details[3].measurements[0].result = null;
  const result = stats.analyze(input), group = result.groups[0];
  assert.equal(result.complete, true);assert.equal(group.stats.n, 3);assert.equal(group.stats.avg, 2);assert.equal(group.stats.std, 1);
  assert.equal(group.stats.min, 1);assert.equal(group.stats.max, 3);assert.equal(group.stats.range, 2);
  assert.equal(group.stats.ng, 1);assert.equal(group.stats.ok, 4);assert.equal(group.stats.unknown, 1);assert.equal(group.stats.validObserved, 5);assert.equal(group.stats.ngRate, 20);
  assert.equal(group.stats.missing, 3);assert.equal(group.observations[5].actual, null);assert.equal(group.observations[5].actualRaw, '4');
  assert.deepEqual(result.pie, { total: 6, ok: 3, ng: 3, unknown: 0 });assert.match(group.capability.reason, /少于 30/);
});

test('Pp and Ppk use overall sample sd at 30 values and retain negative Ppk', () => {
  const input = sample(Array.from({ length: 30 }, (_, i) => i));
  const group = stats.analyze(input).groups[0], expectedSd = Math.sqrt(77.5);
  close(group.stats.std, expectedSd);close(group.stats.pp, 20 / (6 * expectedSd));close(group.stats.ppk, (10 - 14.5) / (3 * expectedSd));
  assert.ok(group.stats.ppk < 0);assert.equal(group.capability.available, true);assert.match(group.capability.warnings.join(' '), /少于 50/);
  assert.match(group.capability.warnings.join(' '), /稳定性、正态性和样本独立性/);
  assert.equal(stats.analyze(sample(input.details.slice(0, 29).map((_, i) => i))).groups[0].stats.pp, null);
});

test('indices reject zero variance, single-sided, equal, reversed, incomplete identities and selected samples', () => {
  const cases = [
    [sample(Array(30).fill(2)), /零波动/],
    [sample(Array.from({ length: 30 }, (_, i) => i), { lowerLimit: null }), /双侧/],
    [sample(Array.from({ length: 30 }, (_, i) => i), { isEqual: true, expectedValue: 2 }), /等值/],
    [sample(Array.from({ length: 30 }, (_, i) => i), { lowerLimit: 10, upperLimit: 10 }), /规格上下限/],
    [sample(Array.from({ length: 30 }, (_, i) => i), { lowerLimit: 20, upperLimit: 10 }), /规格上下限/]
  ];
  for (const [input, reason] of cases) { const group = stats.analyze(input).groups[0];assert.equal(group.stats.pp, null);assert.equal(group.stats.ppk, null);assert.match(group.capability.reason, reason); }
  const identity = sample(Array.from({ length: 30 }, (_, i) => i));identity.report.records.forEach(row => row.deviceCode = '');identity.details.forEach(row => row.deviceCode = '');
  assert.match(stats.analyze(identity).groups[0].capability.reason, /标识不完整/);
  for (const filters of [{ barcode: 'SYNTHETIC-RETEST' }, { result: 'NG' }, { result: 'OK' }]) {
    const input = sample(Array.from({ length: 30 }, (_, i) => i));input.report.filters = filters;
    const group = stats.analyze(input).groups[0];assert.equal(group.stats.pp, null);assert.match(group.capability.reason, /限定/);assert.equal(group.control.available, false);
  }
});

test('numeric missing and unknown judgment block capability even with sufficient valid numeric samples', () => {
  for (const measurement of [{ actual: null }, { result: null }]) {
    const input = sample(Array.from({ length: 32 }, (_, i) => i));Object.assign(input.details[0].measurements[0], measurement);
    const group = stats.analyze(input).groups[0];assert.equal(group.capability.available, false);assert.match(group.capability.reason, /缺失/);
  }
});

test('different parts, production lines, devices, processes and specifications never share one group', () => {
  const input = sample([1, 2, 3, 4, 5, 6, 7]);
  for (const [i, field, value] of [[1, 'partCode', 'PART2'], [2, 'productionLine', '12'], [3, 'deviceCode', 'DEVICE2'], [4, 'processCode', 'PROC2']]) {
    input.report.records[i][field] = value;input.details[i][field] = value;
  }
  input.details[5].measurements[0].upperLimit = 20;input.details[6].measurements[0].unit = 'mm';
  const groups = stats.analyze(input).groups;assert.equal(groups.length, 7);
  const versions = groups.filter(group => group.specChanged);assert.equal(versions.length, 3);
  for (const group of versions) { assert.equal(group.stats.pp, null);assert.match(group.capability.reason, /规格或单位变化/);assert.equal(group.control.available, false); }
  assert.equal(groups.find(group => group.productionLine === '12').stats.n, 1);
});

test('pareto totals point events, denominators use observed judgments, top N cumulative does not become 100%', () => {
  const input = sample([1, 2, 3]);
  input.details.forEach((detail, index) => { detail.measurements = Array.from({ length: 12 }, (_, j) => ({ key: 'p' + j, name: '点' + j, actual: 1, lowerLimit: -2, upperLimit: 2, result: j === 0 || index === 0 ? 'NG' : 'OK' })); });
  const result = stats.analyze({ ...input, topN: 10 });
  assert.equal(result.pareto.totalNG, 14);assert.equal(result.pareto.items.length, 10);assert.equal(result.pareto.items[0].ng, 3);assert.equal(result.pareto.items[0].validObserved, 3);
  assert.equal(result.pareto.items[0].ngRate, 100);assert.equal(result.pareto.otherNG, 2);close(result.pareto.items[9].cumulativePercent, 12 / 14 * 100);
  assert.equal(result.pie.ng, 1);assert.equal(result.groups[0].observations.length, 3);
});

test('complete details are required for pareto and indices, with duplicate and foreign detail fail closed', () => {
  const input = sample([1, 2, 3]);input.details.pop();
  const result = stats.analyze(input);assert.equal(result.complete, false);assert.equal(result.coverage.expectedRecords, 3);assert.equal(result.coverage.loadedRecords, 2);
  assert.deepEqual(result.coverage.missingRecordIds, ['3']);assert.deepEqual(result.pareto.items, []);assert.equal(result.pareto.available, false);assert.equal(result.groups[0].stats.pp, null);
  const empty = sample([1]);empty.details[0].measurements = [];assert.equal(stats.analyze(empty).complete, false);
  const coverage = sample([1]);coverage.report.coverage.complete = false;assert.equal(stats.analyze(coverage).complete, false);
  for (const bad of [{ recordId: 'foreign', measurements: [] }, input.details[0]]) assert.throws(() => stats.analyze({ ...input, details: [...input.details, bad] }), /详情/);
});

test('missing point observations remain null and moving ranges never bridge missing data', () => {
  const input = sample([0, 100, 2, 4]);input.details[1].measurements = [{ key: 'other', name: '另一点', actual: 100, result: 'OK' }];
  const group = stats.analyze(input).groups.find(group => group.pointKey === 'x');
  assert.equal(group.observations[1].present, false);assert.equal(group.observations[1].actual, null);assert.equal(group.stats.n, 3);
  assert.equal(group.control.pairs, 1);assert.equal(group.control.mrBar, 2);
  close(group.control.ucl, 2 + 3 * 2 / 1.128);close(group.control.lcl, 2 - 3 * 2 / 1.128);
});

test('I-MR follows the published NIST example, distinguished from specification limits', () => {
  const group = stats.analyze(sample([49.6, 47.6, 49.9, 51.3, 47.8, 51.2, 52.6, 52.4, 53.6, 52.1])).groups[0];
  close(group.stats.avg, 50.81);close(group.control.mrBar, 16.9 / 9);close(group.control.ucl, 55.80408983451536);close(group.control.lcl, 45.81591016548463);
  assert.equal(group.upperLimit, 10);assert.match(group.control.label, /估计控制界限.*不是规格/);assert.match(group.control.warnings.join(' '), /不是来源提供的/);
});

test('time sorting is chronological and deterministic; equal timestamps are not treated as known adjacent order', () => {
  const input = sample([1, 10, 3, 5]);input.report.records[1].measuredAt = input.report.records[0].measuredAt;input.details[1].measuredAt = input.details[0].measuredAt;
  input.report.records.reverse();input.details.reverse();
  const group = stats.analyze(input).groups[0];assert.deepEqual(group.observations.map(row => row.recordId), ['1', '2', '3', '4']);
  assert.equal(group.control.pairs, 1);assert.equal(group.control.mrBar, 2);assert.match(group.control.warnings.join(' '), /同时间/);
  const frozen = sample([1, 2]);frozen.report.records[1].measuredAt = frozen.report.records[0].measuredAt;frozen.details[1].measuredAt = frozen.details[0].measuredAt;
  assert.equal(stats.analyze(frozen).groups[0].control.available, false);
});

test('critical filtering never guesses unknown metadata or treats absent flags as false', () => {
  const input = sample([1, 2, 3]);input.details[0].measurements[0].isCritical = true;input.details[1].measurements[0].isCritical = false;
  const all = stats.analyze(input);assert.equal(all.criticalMetadataAvailable, false);assert.equal(all.coverage.unknownCritical, 1);assert.equal(all.groups[0].stats.n, 3);
  const critical = stats.analyze({ ...input, includeNonCritical: false });assert.equal(critical.coverage.excludedNonCritical, 2);assert.equal(critical.groups[0].stats.n, 1);assert.match(critical.warnings.join(' '), /未知.*未纳入/);
});

test('invalid dates, duplicate records, duplicate point keys and mismatched identities are rejected', () => {
  const cases = [input => input.report.records.push(input.report.records[0]), input => input.report.records[0].measuredAt = '2026-02-30T00:00:00',
    input => input.details[0].measurements.push(input.details[0].measurements[0]), input => input.details[0].barcode = 'OTHER', input => input.topN = 0];
  for (const change of cases) { const input = sample([1]);change(input);assert.throws(() => stats.analyze(input)); }
});

test('summary count mismatch rejects a sliced page masquerading as full selected records', () => {
  const input = sample([1, 2]);input.report.summary = { total: 100 };
  assert.throws(() => stats.analyze(input), /当前分页/);
  input.report.summary.total = 2;assert.equal(stats.analyze(input).complete, true);
});

test('input is not mutated, map details work, empty data does not create zero samples or fabricated ratios', () => {
  const input = sample([1, 2]);const before = structuredClone(input);stats.analyze({ ...input, details: new Map(input.details.map(row => [row.recordId, row])) });assert.deepEqual(input, before);
  const empty = stats.analyze(sample([]));assert.deepEqual(empty.groups, []);assert.deepEqual(empty.pareto.items, []);assert.equal(empty.pareto.totalNG, 0);
  assert.deepEqual(stats.moments([null, '', NaN, Infinity]), { n: 0, avg: null, min: null, max: null, range: null, std: null });
  assert.equal(stats.moments([2]).std, null);assert.equal(stats.moments([Number.MAX_VALUE, -Number.MAX_VALUE]).std, null);
});
