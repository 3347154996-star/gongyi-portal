'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const weld = require('../lib/weld-report.cjs');

// Entirely fictional fixtures. No production records or past report totals.
function row(overrides = {}) {
  return { '物料编码': 'FRONT_PRIMARY', '缺陷内容': '焊偏', '二维码': 'DEMO11A001',
    '缺陷位置': 'TSL-10-示例位置-OP040-BR01', '备注': '', '录入时间': '2026/10/12 09:00:00', ...overrides };
}
const period = { startDate: '2026-10-12', endDate: '2026-10-18' };

test('verified product materials stay separate and filter exactly two defects', () => {
  const report = weld.buildWeldReport([
    row(), row({ '物料编码': 'FRONT_SECONDARY' }), row({ '物料编码': 'REAR_PRIMARY' }),
    row({ '物料编码': 'REAR_SECONDARY', '缺陷位置': '名称写前副但应按料号归后副' }),
    row({ '缺陷内容': '咬边' }), row({ '物料编码': '', '缺陷位置': 'TSL-前副-OP40' })
  ], period);
  assert.equal(report.products.front.defectPoints, 2);
  assert.equal(report.products.rear.defectPoints, 2);
  assert.equal(report.products.rear.diagnostics.unknownOp, 1);
  assert.equal(report.diagnostics.unassignedTargetDefectRows, 1);
  assert.equal(report.diagnostics.nonTargetDefectRows, 1);
});

test('caller material mapping propagates through totals, exclusions, breakdown and historical scope', () => {
  const materialGroups = { front: ['SYN-F1', 'SYN-F2'], rear: ['SYN-R1'] };
  const report = weld.buildWeldReport([
    row({ '物料编码': 'SYN-F1' }), row({ '物料编码': 'SYN-F2' }),
    row({ '物料编码': 'SYN-R1' }), row()
  ], { ...period, materialGroups, coverage: [{ ...period, complete: true }], historyWeeks: [
    { startDate: '2026-10-05', endDate: '2026-10-11', coverage: 'complete', products: {
      front: { defectPoints: 1, pieces: 1, materials: ['SYN-F1', 'SYN-F2'], defects: [...weld.DEFECTS] }
    } }
  ] });
  assert.equal(report.products.front.defectPoints, 2);
  assert.equal(report.products.rear.defectPoints, 1);
  assert.deepEqual(Object.keys(report.products.front.materialBreakdown), ['SYN-F1', 'SYN-F2']);
  assert.equal(report.diagnostics.unknownMaterialRows, 1);
  assert.deepEqual(report.weeklyTrend.at(-1).products.front.materials, ['SYN-F1', 'SYN-F2']);
  assert.equal(report.weeklyTrend.at(-1).products.front.defectPoints, 2);
  assert.equal(report.weeklyTrend.at(-1).products.front.comparison.allowed, true);
  assert.throws(() => weld.buildWeldReport([], { materialGroups: { front: ['OVERLAP'], rear: ['OVERLAP'] } }), /overlap/);
});

test('points retain duplicate rows; pieces dedupe nonempty QR across combined materials', () => {
  const report = weld.buildWeldReport([row(), row(), row({ '物料编码': 'FRONT_SECONDARY' }), row({ '二维码': '' })], period);
  const front = report.products.front;
  assert.equal(front.defectPoints, 4);
  assert.equal(front.pieces, 1);
  assert.equal(front.pointsPerPiece, 4);
  assert.equal(front.diagnostics.fullyDuplicateRowsRetained, 1);
  assert.equal(front.diagnostics.missingQr, 1);
  assert.equal(front.unassignedLineCount, 1);
  assert.equal(weld.buildWeldReport([row({ '二维码': '' })], period).products.front.pointsPerPiece, null);
});

test('QR decoding is suffix-bound, supports any letter, and remark fallback must be unique', () => {
  assert.equal(weld.lineFromQr('DEMO14z999'), '14');
  assert.equal(weld.lineFromQr('DEMO14A999suffix'), null);
  assert.equal(weld.lineFromQr('DEMO15A999'), null);
  assert.equal(weld.lineFromRemarks('产线：12，12号线'), '12');
  assert.equal(weld.lineFromRemarks('11线、12线'), null);
  assert.equal(weld.lineFromRemarks('111线'), null);
  assert.deepEqual(weld.decodeProductionLine('DEMO11A001', '12线'), {
    line: '11', source: 'qr', qrLine: '11', remarkLine: '12', conflict: true
  });
  assert.equal(weld.decodeProductionLine('not-a-production-qr', '线别 13').source, 'remark');
});

test('positions remove robot suffix, keep compound OP, and Top5 ties sort numeric position', () => {
  assert.equal(weld.normalizeLocation(' TSL-2-示例-op 00040-60-BR02 '), 'TSL-2-示例-OP40-60');
  assert.equal(weld.opFromLocation('TSL-2-示例-OP40-60'), 'OP40-60');
  assert.equal(weld.opFromLocation('无工位'), '其他');
  const rows = [10, 2, 8, 4, 6, 3].map(n => row({ '缺陷位置': `TSL-${n}-示例-OP40-BR01` }));
  rows.push(row({ '缺陷位置': '' }));
  const front = weld.buildWeldReport(rows, period).products.front;
  assert.deepEqual(front.top5.map(item => item.shortLocation), ['TSL-2', 'TSL-3', 'TSL-4', 'TSL-6', 'TSL-8']);
  assert.equal(front.defectPoints, 7);
  assert.equal(front.top5Total, 5);
  assert.equal(front.diagnostics.missingLocation, 1);
  assert.ok(front.top5.every(item => Object.values(item.lines).reduce((a, b) => a + b, 0) + item.unassigned === item.total));
});

test('each line OP top five has its own denominator and includes remaining/unknown in other', () => {
  const rows = [100, 40, 20, 10, 60, 30].map(op => row({ '缺陷位置': `TSL-${op}-示例-OP${op}` }));
  rows.push(row({ '缺陷位置': '无OP' }), row({ '二维码': 'DEMO12A001', '缺陷位置': 'TSL-1-示例-OP40-60' }));
  const result = weld.buildWeldReport(rows, period).products.front.opShares;
  assert.deepEqual(result['11'].items.map(item => item.op), ['OP10', 'OP20', 'OP30', 'OP40', 'OP60', '其他']);
  assert.equal(result['11'].items.at(-1).count, 2);
  assert.equal(result['11'].count, 7);
  assert.equal(result['12'].items[0].op, 'OP40-60');
  assert.equal(result['12'].items[0].share, 1);
  for (const line of weld.LINES) assert.equal(result[line].items.reduce((n, item) => n + item.count, 0), result[line].count);
});

test('mapping, missing-key counts, date boundaries and source metadata are explicit', () => {
  const input = [{ payload: { material: 'FRONT_PRIMARY', defect: '焊穿', code: 'DEMO11A001', position: 'OP40', time: '2026-10-11T17:00:00Z' } }, { payload: {} }];
  const snapshot = JSON.stringify(input);
  const result = weld.buildWeldReport(input, { ...period, source: 'fixture-api', fieldMap: {
    material: 'payload.material', defect: ['payload', 'defect'], qr: r => r.payload.code,
    location: 'payload.position', recordedAt: 'payload.time', remark: 'payload.remark'
  } });
  assert.equal(result.products.front.defectPoints, 1);
  assert.equal(result.source.label, 'fixture-api');
  assert.equal(result.source.sourceFieldMap.qr, '[accessor]');
  assert.equal(result.diagnostics.missingDateRows, 1);
  assert.equal(result.diagnostics.missingKeys.material, 1);
  assert.equal(JSON.stringify(input), snapshot);
  assert.equal(weld.normalizeDate('2026/2/30 10:00:00'), null);
  assert.equal(weld.normalizeDate('2026/10/12 24:00:00'), null);
  assert.equal(weld.normalizeDate('2026/10/12 3:50:21'), '2026-10-12');
  assert.throws(() => weld.buildWeldReport([], { startDate: '2026-10-13', endDate: '2026-10-12' }), /period/);
});

test('missing historical weeks are null, not zero, and events never prove full coverage', () => {
  const weeks = weld.buildWeeklyTrend([row()], { endDate: '2026-10-18' });
  assert.equal(weeks.length, 5);
  assert.equal(weeks[0].products.front.defectPoints, null);
  assert.equal(weeks[0].products.front.coverage, 'missing');
  assert.equal(weeks[4].products.front.defectPoints, 1);
  assert.equal(weeks[4].products.front.coverage, 'unknown');
  assert.equal(weeks[4].products.front.comparison.allowed, false);
  assert.equal(weeks[4].products.rear.defectPoints, null);
});

test('full explicitly covered empty periods can be zero, and complete comparable weeks permit change', () => {
  const rows = [row({ '录入时间': '2026-10-05 09:00:00' }), row(), row({ '二维码': 'DEMO11A002' })];
  const weeks = weld.buildWeeklyTrend(rows, { endDate: '2026-10-18', coverage: [
    { startDate: '2026-10-05', endDate: '2026-10-18', complete: true, source: 'complete-api-query' }
  ] });
  assert.equal(weeks[4].products.front.comparison.allowed, true);
  assert.equal(weeks[4].products.front.comparison.defectPointsPercent, 100);
  assert.equal(weeks[4].products.rear.defectPoints, 0);
  assert.equal(weeks[4].products.rear.pointsPerPiece, null);
});

test('historical scopes and partial weeks suppress comparison; legacy KW is not hardcoded', () => {
  const weeks = weld.buildWeeklyTrend([row({ '录入时间': '2026-09-25 09:00:00' })], {
    endDate: '2026-09-27', coverage: [{ startDate: '2026-09-25', endDate: '2026-09-27', complete: true }],
    historyWeeks: [{ startDate: '2026-09-14', endDate: '2026-09-20', coverage: 'complete', source: 'synthetic-history',
      products: { front: { defectPoints: 2, pieces: 1, materials: ['FRONT_PRIMARY'], defects: ['焊偏', '焊穿'] } } }]
  });
  assert.equal(weeks.at(-1).label, '2026-W39');
  assert.equal(weeks.at(-1).products.front.coverage, 'partial');
  assert.equal(weeks.at(-1).products.front.comparison.allowed, false);
  const full = weld.buildWeeklyTrend([row()], { endDate: '2026-10-18', coverage: [{ ...period, complete: true }], historyWeeks: [
    { startDate: '2026-10-05', endDate: '2026-10-11', coverage: 'complete', products: {
      front: { defectPoints: 2, pieces: 1, materials: ['FRONT_PRIMARY'], defects: [...weld.DEFECTS] }
    } }
  ] });
  assert.equal(full.at(-1).products.front.comparison.reason, 'scope_not_comparable');
});
