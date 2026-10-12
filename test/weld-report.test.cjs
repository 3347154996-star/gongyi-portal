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

test('dashboard defaults to all materials, lines and defects, including missing values', () => {
  const rows = [
    row(), row({ '物料编码': 'REAR_PRIMARY', '缺陷内容': '咬边', productionLine: '21线' }),
    row({ '物料编码': 'SYN-OTHER', '缺陷内容': '', productionLine: '试制A线' }),
    row({ '物料编码': '', '二维码': 'unrecognized', '缺陷内容': '外观待判' })
  ];
  const result = weld.buildWeldDashboard(rows, period);
  assert.deepEqual(result.selected, { product: 'all', line: 'all', defects: [], defectType: 'all', op: 'all', location: 'all' });
  assert.equal(result.overview.recordCount, 4);
  assert.equal(result.overview.pieceCount, 3);
  assert.equal(result.overview.materialCount, 3);
  assert.equal(result.overview.lineCount, 3);
  assert.equal(result.overview.defectTypeCount, 4);
  assert.equal(result.overview.unknownLineCount, 1);
  assert.deepEqual(result.filteredRows, rows);
  assert.ok(result.defectSummary.some(item => item.defect === '未填写' && item.recordCount === 1));
  assert.ok(result.lineSummary.some(item => item.line === '待识别线体' && item.recordCount === 1));
  assert.equal(result.options.products.find(item => item.value === 'other').count, 2);
  assert.equal(result.source.complete, null);
  assert.ok(result.notes.some(note => note.includes('不等于一个已经完成的补焊点')));
});

test('dashboard involved pieces use material plus QR while duplicate source logs remain', () => {
  const rows = [row(), row(), row({ '物料编码': 'FRONT_SECONDARY' }),
    row({ '物料编码': 'REAR_PRIMARY' }), row({ '二维码': '' }), row({ '物料编码': '' })];
  const result = weld.buildWeldDashboard(rows, period);
  assert.equal(result.overview.recordCount, 6);
  assert.equal(result.overview.pieceCount, 3);
  assert.equal(result.overview.recordsPerPiece, 2);
  assert.equal(result.overview.duplicateRowsRetained, 1);
  assert.equal(result.diagnostics.missingPieceKeyRows, 2);
  assert.equal(result.diagnostics.missingQrRows, 1);
  assert.equal(result.diagnostics.missingMaterialRows, 1);
  assert.equal(weld.buildWeldDashboard([row({ '二维码': '' })], period).overview.recordsPerPiece, null);
  assert.equal(weld.buildWeldReport(rows, period).products.front.pieces, 1, 'legacy composite-group QR dedupe remains unchanged');
});

test('dashboard explicit production line fields take priority and retain conflict evidence', () => {
  const result = weld.buildWeldDashboard([
    row({ productionLine: '21', lineName: '22线', line: '23线' }),
    row({ productionLine: ' ', lineName: '装配A线', line: '装配A线' }),
    row({ '二维码': 'unsupported-qr', line: '研制B线' })
  ], period);
  assert.deepEqual(new Set(result.lineSummary.map(item => item.line)), new Set(['21线前副', '装配A线', '研制B线']));
  assert.equal(result.diagnostics.explicitLineConflicts, 1);
  assert.equal(result.diagnostics.qrFieldConflicts, 2);
  assert.deepEqual(result.diagnostics.lineSources, { explicit: 3, rule: 0, legacyQr: 0, unknown: 0 });
});

test('dashboard QR fallback never generalizes the verified suffix to arbitrary line numbers', () => {
  const rows = [row({ '二维码': 'DEMO21A001' }), row({ '二维码': 'DEMO11A001' }),
    row({ '二维码': 'DEMO999A001', '备注': '21线' }), row({ '二维码': 'DEMO12A001suffix' })];
  const result = weld.buildWeldDashboard(rows, period);
  assert.equal(result.lineSummary.find(item => item.line === '前副（线体待确认）').recordCount, 3);
  assert.equal(result.lineSummary.find(item => item.line === '11线前副').recordCount, 1);
  assert.equal(result.diagnostics.lineSources.legacyQr, 1);
  assert.equal(weld.buildWeldDashboard(rows, { ...period, allowLegacyQr: false }).overview.unknownLineCount, 4);
  const other = weld.buildWeldDashboard([row({ '物料编码': 'SYN-OTHER' }), row()], {
    ...period, materialGroups: { front: ['SYN-F1'], rear: ['SYN-R1'] }
  });
  assert.equal(other.overview.unknownLineCount, 2, 'matching QR suffix alone is insufficient outside configured product materials');
  const configured = weld.buildWeldDashboard([row({ '物料编码': 'SYN-F1' })], {
    ...period, materialGroups: { front: ['SYN-F1'], rear: ['SYN-R1'] }
  });
  assert.equal(configured.lineSummary[0].line, '11线前副');
});

test('dashboard configured line rules handle verified new formats and conflicting rules stay unknown', () => {
  const rows = [row({ '二维码': 'SYN-L21-A001' }), row({ '二维码': 'SYN-L22-A002' }),
    row({ '二维码': 'SYN-L21-A003', productionLine: '明确线体' }), row({ '二维码': 'OTHER-L21-A001' })];
  const rule = { id: 'synthetic-line-format', field: 'qr', pattern: '^SYN-L(21|22)-[A-Z][0-9]{3}$', group: 1, suffix: '线' };
  const result = weld.buildWeldDashboard(rows, { ...period, lineRules: [rule] });
  assert.deepEqual(new Set(result.lineSummary.map(item => item.line)), new Set(['21线前副', '22线前副', '明确线体', '前副（线体待确认）']));
  assert.equal(result.diagnostics.lineSources.rule, 2);
  const conflict = weld.buildWeldDashboard([rows[0]], { ...period, lineRules: [rule, { field: 'qr', pattern: '^SYN-', line: '另一线' }] });
  assert.equal(conflict.overview.unknownLineCount, 1);
  assert.equal(conflict.diagnostics.lineRuleConflicts, 1);
});

test('dashboard filters reconcile list, totals, charts, Top5 and date buckets under one scope', () => {
  const rows = [
    row({ id: 'a', productionLine: '21线', '缺陷内容': '咬边' }),
    row({ id: 'b', productionLine: '21线', '缺陷内容': '', '录入时间': '2026-10-13 09:00:00' }),
    row({ id: 'c', productionLine: '22线', '缺陷内容': '咬边' }),
    row({ id: 'd', productionLine: '21线', '缺陷内容': '焊偏' }),
    row({ id: 'e', productionLine: '21线', '缺陷内容': '咬边', '物料编码': 'REAR_PRIMARY' }),
    row({ id: 'f', productionLine: '21线', '缺陷内容': '咬边', '录入时间': '2026-10-19 09:00:00' })
  ];
  const result = weld.buildWeldDashboard(rows, { ...period, product: 'front', line: '21线前副', defects: ['咬边', '未填写'] });
  assert.deepEqual(result.filteredRows.map(item => item.id), ['a', 'b']);
  assert.equal(result.overview.recordCount, 2);
  for (const series of [result.lineSummary, result.defectSummary, result.topLocations, result.dailyTrend, result.trend]) {
    assert.equal(series.reduce((sum, item) => sum + (item.recordCount || 0), 0), 2);
  }
  for (const top of result.topLocations) {
    assert.equal(top.byLine.reduce((sum, item) => sum + item.count, 0), top.recordCount);
    assert.equal(top.byDefect.reduce((sum, item) => sum + item.count, 0), top.recordCount);
  }
  assert.equal(result.options.lines.find(item => item.value === '22线前副').count, 1, 'filter menus retain alternatives within the period');
  assert.equal(result.options.products.find(item => item.value === 'all').count, 5);
  assert.equal(result.options.products.find(item => item.value === 'rear').count, 1);
  assert.equal(result.diagnostics.outsidePeriodRows, 1);
  const keyword = weld.buildWeldDashboard(rows, { ...period, keyword: 'REAR_PRIMARY' });
  assert.deepEqual(keyword.filteredRows.map(item => item.id), ['e']);
  assert.equal(keyword.overview.recordCount, 1);
  assert.equal(keyword.lineSummary[0].recordCount, 1);
  assert.equal(keyword.topLocations[0].recordCount, 1);
});

test('dashboard missing field/date buckets remain visible by default but date filters explicitly exclude undated records', () => {
  const rows = [row(), row({ id: 'missing', '录入时间': '', '缺陷内容': '', '缺陷位置': '', '二维码': '', '物料编码': '' }),
    row({ id: 'invalid', '录入时间': '2026-02-30 09:00:00' })];
  const all = weld.buildWeldDashboard(rows);
  assert.equal(all.overview.recordCount, 3);
  assert.equal(all.dailyTrend.find(item => item.date === null).recordCount, 2);
  assert.equal(all.diagnostics.missingDateRows, 1);
  assert.equal(all.diagnostics.invalidDateRows, 1);
  assert.equal(all.diagnostics.filteredMissingFields.defect, 1);
  assert.equal(all.diagnostics.filteredMissingFields.location, 1);
  assert.ok(all.topLocations.some(item => item.location === '未填写位置' && item.recordCount === 1));
  const bounded = weld.buildWeldDashboard(rows, period);
  assert.equal(bounded.overview.recordCount, 1);
  assert.equal(bounded.diagnostics.undatedRowsExcludedByDateFilter, 2);
  assert.equal(bounded.diagnostics.outsidePeriodRows, 0);
  assert.ok(bounded.dailyTrend.every(item => item.date));
});

test('dashboard custom material groups and field paths preserve source rows and material names', () => {
  const rows = [{ data: { material: 'SYN-F1', materialName: '虚构零件甲', qr: 'SYN-QR-1', defect: '示例缺陷', line: '试制C线', date: '2026-10-12', place: '示例位置' } },
    { data: { material: 'SYN-X1', materialName: '虚构零件乙', qr: 'SYN-QR-2', defect: '另一缺陷', line: '试制D线', date: '2026-10-12', place: '另一位置' } }];
  const before = JSON.stringify(rows);
  const result = weld.buildWeldDashboard(rows, { ...period, product: 'front', source: 'synthetic-source', sourceComplete: false,
    materialGroups: { front: ['SYN-F1'], rear: ['SYN-R1'] }, fieldMap: {
      material: 'data.material', materialName: 'data.materialName', qr: 'data.qr', defect: 'data.defect',
      recordedAt: 'data.date', location: 'data.place', productionLine: input => input.data.line
    } });
  assert.equal(result.overview.recordCount, 1);
  assert.equal(result.lineSummary[0].line, '试制C线');
  assert.equal(result.materialSummary[0].materialName, '虚构零件甲');
  assert.equal(result.options.products.find(item => item.value === 'other').count, 1);
  assert.equal(result.filteredRows[0], rows[0]);
  assert.equal(result.source.label, 'synthetic-source');
  assert.equal(result.source.complete, false);
  assert.equal(JSON.stringify(rows), before);
});

test('dashboard absent days/weeks remain null unless caller proves full coverage', () => {
  const unknown = weld.buildWeldDashboard([row()], period);
  assert.equal(unknown.dailyTrend[0].recordCount, 1);
  assert.equal(unknown.dailyTrend[0].coverageStatus, 'unknown');
  assert.equal(unknown.dailyTrend[1].recordCount, null);
  assert.equal(unknown.trend[0].recordCount, null);
  assert.equal(unknown.trend[0].coverageStatus, 'missing');
  const known = weld.buildWeldDashboard([row()], { ...period, sourceComplete: true, coverage: [{ ...period, complete: true }] });
  assert.equal(known.dailyTrend[1].recordCount, 0);
  assert.equal(known.dailyTrend[1].pieceCount, 0);
  assert.equal(known.dailyTrend[1].recordsPerPiece, null);
  assert.equal(known.trend.at(-1).complete, true);
  assert.equal(known.trend[0].recordCount, null, 'no coverage evidence outside the selected period');
  assert.equal(known.source.complete, true);
});

test('dashboard partial selected week cannot inherit whole-week coverage and accepts caller week labels', () => {
  const result = weld.buildWeldDashboard([row()], { startDate: '2026-10-12', endDate: '2026-10-13',
    coverage: [{ ...period, complete: true }], weekLabel: (start, end) => `${start} 至 ${end}` });
  assert.equal(result.period.coverage.status, 'complete');
  assert.equal(result.trend.at(-1).coverageStatus, 'partial');
  assert.equal(result.trend.at(-1).complete, false);
  assert.equal(result.trend.at(-1).label, '2026-10-12 至 2026-10-18');
  assert.equal(result.trend.at(-1).recordCount, 1);
});

test('dashboard validates filters, preserves empty output, and supports unknown/blank selection', () => {
  assert.throws(() => weld.buildWeldDashboard([], { product: 'unsupported' }), /product filter/);
  assert.throws(() => weld.buildWeldDashboard([], { defects: '咬边' }), /array/);
  assert.throws(() => weld.buildWeldDashboard([], { weekCount: 0 }), /weekCount/);
  assert.throws(() => weld.buildWeldDashboard([], { topLimit: 0 }), /topLimit/);
  const empty = weld.buildWeldDashboard([], period);
  assert.equal(empty.overview.recordCount, 0);
  assert.equal(empty.overview.recordsPerPiece, null);
  assert.ok(empty.trend.every(item => item.recordCount === null));
  const blank = weld.buildWeldDashboard([row({ '二维码': 'SYN-UNKNOWN', '缺陷内容': '' }), row()], {
    ...period, line: '前副（线体待确认）', defects: ['']
  });
  assert.equal(blank.overview.recordCount, 1);
  assert.deepEqual(blank.selected.defects, ['未填写']);
});

test('dashboard dynamic line OP Top5 plus other covers every filtered log with each line denominator', () => {
  const rows = [100, 40, 20, 10, 60, 30].map(op => row({ productionLine: '21线', '缺陷位置': `示例-OP${op}` }));
  rows.push(row({ productionLine: '21线', '缺陷位置': '' }),
    row({ productionLine: '试制A线', '缺陷位置': '示例-OP40-60' }),
    row({ '物料编码': 'SYN-OTHER', '缺陷位置': '无工位', '二维码': 'SYN-NO-LINE' }));
  const result = weld.buildWeldDashboard(rows, period);
  const line = result.lineOpSummary.find(item => item.line === '21线前副');
  assert.equal(line.recordCount, 7);
  assert.deepEqual(line.items.map(item => item.op), ['OP10', 'OP20', 'OP30', 'OP40', 'OP60', '其他']);
  assert.equal(line.items.at(-1).count, 2);
  assert.equal(line.items.at(-1).share, 2 / 7);
  assert.deepEqual(result.lineOpSummary.find(item => item.line === '试制A线').items, [{ op: 'OP40-60', count: 1, share: 1 }]);
  assert.deepEqual(result.lineOpSummary.find(item => item.line === '物料 SYN-OTHER（线体待确认）').items, [{ op: '其他', count: 1, share: 1 }]);
  for (const summary of result.lineOpSummary) {
    assert.equal(summary.items.reduce((sum, item) => sum + item.count, 0), summary.recordCount);
    assert.ok(Math.abs(summary.items.reduce((sum, item) => sum + item.share, 0) - 1) < 1e-12);
  }
});

test('dashboard OP summaries share product, line, defect and keyword filters with detail', () => {
  const rows = [row({ id: 'KEEP', productionLine: '21线', '缺陷内容': '气孔', '缺陷位置': 'OP40' }),
    row({ id: 'DROP', productionLine: '21线', '缺陷内容': '气孔', '缺陷位置': 'OP60' }),
    row({ id: 'KEEP-REAR', '物料编码': 'REAR_PRIMARY', productionLine: '21线', '缺陷内容': '气孔' }),
    row({ id: 'KEEP-LINE', productionLine: '22线', '缺陷内容': '气孔' }),
    row({ id: 'KEEP-DEFECT', productionLine: '21线', '缺陷内容': '咬边' })];
  const result = weld.buildWeldDashboard(rows, { ...period, product: 'front', line: '21线前副', defects: ['气孔'], keyword: 'KEEP' });
  assert.equal(result.overview.recordCount, 1);
  assert.deepEqual(result.filteredRows.map(item => item.id), ['KEEP']);
  assert.deepEqual(result.lineOpSummary, [{ line: '21线前副', recordCount: 1, items: [{ op: 'OP40', count: 1, share: 1 }] }]);
});

test('product-qualified 11..14 lines separate front and rear without changing totals or deduplication', () => {
  const materialGroups = { front: ['SYN-F1', 'SYN-F2'], rear: ['SYN-R1', 'SYN-R2'] };
  const rows = [];
  for (const line of ['11', '12', '13', '14']) for (const material of [...materialGroups.front, ...materialGroups.rear]) {
    rows.push(row({ '物料编码': material, '二维码': `SYN-${line}A001`, '物料名称': '名称不替代已配置物料组' }));
  }
  rows.push({ ...rows[0] });
  const snapshot = JSON.stringify(rows), result = weld.buildWeldDashboard(rows, { ...period, materialGroups });
  const expected = ['11线前副', '11线后副', '12线前副', '12线后副', '13线前副', '13线后副', '14线前副', '14线后副'];
  assert.deepEqual(new Set(result.lineSummary.map(item => item.line)), new Set(expected));
  assert.deepEqual(new Set(result.lineOpSummary.map(item => item.line)), new Set(expected));
  assert.deepEqual(new Set(result.options.lines.filter(item => item.value !== 'all').map(item => item.value)), new Set(expected));
  assert.equal(result.overview.recordCount, 17);
  assert.equal(result.overview.pieceCount, 16);
  assert.equal(result.overview.duplicateRowsRetained, 1);
  assert.equal(result.overview.lineCount, 8);
  assert.equal(result.overview.unknownLineCount, 0);
  assert.equal(result.diagnostics.productQualifiedLineRows, 17);
  assert.equal(result.lineSummary.reduce((sum, item) => sum + item.recordCount, 0), 17);
  assert.equal(result.lineOpSummary.reduce((sum, item) => sum + item.recordCount, 0), 17);
  assert.equal(result.topLocations[0].byLine.reduce((sum, item) => sum + item.count, 0), 17);
  assert.equal(result.defectSummary[0].byLine.reduce((sum, item) => sum + item.count, 0), 17);
  assert.equal(JSON.stringify(rows), snapshot);
});

test('qualified line filters keep every aggregate and detail on one product-specific line', () => {
  const rows = [row({ id: 'F1', '物料编码': 'FRONT_PRIMARY' }), row({ id: 'F2', '物料编码': 'FRONT_SECONDARY' }),
    row({ id: 'R1', '物料编码': 'REAR_PRIMARY' }), row({ id: 'F12', '二维码': 'SYN12A001' })];
  const result = weld.buildWeldDashboard(rows, { ...period, line: '11线前副' });
  assert.deepEqual(result.filteredRows.map(item => item.id), ['F1', 'F2']);
  assert.equal(result.overview.recordCount, 2);
  assert.equal(result.overview.pieceCount, 2);
  assert.deepEqual(result.lineSummary.map(item => item.line), ['11线前副']);
  assert.deepEqual(result.lineOpSummary.map(item => item.line), ['11线前副']);
  assert.deepEqual(result.topLocations[0].byLine, [{ line: '11线前副', count: 2 }]);
  assert.equal(result.dailyTrend.reduce((sum, item) => sum + (item.recordCount || 0), 0), 2);
  assert.equal(result.trend.reduce((sum, item) => sum + (item.recordCount || 0), 0), 2);
  assert.ok(result.options.lines.some(item => item.value === '11线后副'), 'the other product stays available as a distinct option');
});

test('unrecognized physical lines stay separate by source product name without inventing QR mappings', () => {
  const rows = [row({ '物料编码': 'SYN-A1', item_name: '合成车型甲后副', '二维码': 'SYN11A001' }),
    row({ '物料编码': 'SYN-B1', item_name: '合成车型乙后副', '二维码': 'SYN12A001' }),
    row({ '物料编码': 'SYN-A2', item_name: '合成车型甲后副', '二维码': 'UNVERIFIED' }),
    row({ '物料编码': 'SYN-NO-NAME-1', '二维码': 'UNVERIFIED' }),
    row({ '物料编码': 'SYN-NO-NAME-2', '二维码': 'UNVERIFIED' }),
    row({ '物料编码': '', '二维码': 'UNVERIFIED' })];
  const result = weld.buildWeldDashboard(rows, { ...period, fieldMap: { materialName: 'item_name' } });
  const names = result.lineSummary.map(item => item.line);
  assert.ok(names.includes('合成车型甲后副（线体待确认）'));
  assert.ok(names.includes('合成车型乙后副（线体待确认）'));
  assert.ok(names.includes('物料 SYN-NO-NAME-1（线体待确认）'));
  assert.ok(names.includes('物料 SYN-NO-NAME-2（线体待确认）'));
  assert.ok(names.includes('待识别线体'));
  assert.equal(result.lineSummary.find(item => item.line === '合成车型甲后副（线体待确认）').recordCount, 2);
  assert.equal(result.overview.recordCount, 6);
  assert.equal(result.overview.unknownLineCount, 6);
  assert.equal(result.overview.lineCount, 0);
  assert.equal(result.diagnostics.pendingProductLineGroups, 5);
  assert.ok(result.lineOpSummary.every(item => names.includes(item.line)));
  const filtered = weld.buildWeldDashboard(rows, { ...period, fieldMap: { materialName: 'item_name' }, line: '合成车型甲后副（线体待确认）' });
  assert.equal(filtered.overview.recordCount, 2);
  assert.equal(filtered.overview.lineCount, 0);
});

test('full explicit line names remain intact while reliable numeric fields use known product identities', () => {
  const rows = [row({ '物料编码': 'FRONT_PRIMARY', productionLine: '11线前副' }),
    row({ '物料编码': 'REAR_PRIMARY', productionLine: '11线后副' }),
    row({ '物料编码': 'FRONT_PRIMARY', productionLine: '21' }),
    row({ '物料编码': 'REAR_PRIMARY', productionLine: '21号线' }),
    row({ '物料编码': 'SYN-OTHER', '物料名称': '合成车型丙后副', productionLine: '22线' }),
    row({ '物料编码': 'SYN-OTHER', '物料名称': '合成车型丙后副', productionLine: '来源明确完整线体名称' })];
  const result = weld.buildWeldDashboard(rows, period);
  assert.deepEqual(new Set(result.lineSummary.map(item => item.line)), new Set([
    '11线前副', '11线后副', '21线前副', '21线后副', '22线 · 合成车型丙后副', '来源明确完整线体名称'
  ]));
  assert.equal(result.overview.recordCount, 6);
  assert.equal(result.overview.unknownLineCount, 0);
  assert.equal(result.overview.lineCount, 6);
});

test('every defect exposes complete line/OP/location detail without Top5 truncation or duplicated joint labels', () => {
  const rows = [1, 2, 3, 4, 5, 6, 7].map(index => row({ id: `SYN-P${index}`, '缺陷内容': '合成缺陷甲/合成缺陷乙',
    '缺陷位置': `TSL-${index}-合成位置-OP040-BR01` }));
  rows.push(row({ id: 'SYN-UNKNOWN', '缺陷内容': '合成缺陷甲/合成缺陷乙', '缺陷位置': '' }),
    row({ id: 'SYN-SECOND-LINE', '缺陷内容': '合成缺陷甲/合成缺陷乙', '二维码': 'SYN12A001', '缺陷位置': 'TSL-1-合成位置-OP20' }),
    row({ id: 'SYN-SECOND-DEFECT', '缺陷内容': '独立合成缺陷', '缺陷位置': 'TSL-1-合成位置-OP20' }));
  const result = weld.buildWeldDashboard(rows, { ...period, page: 2, size: 2 });
  assert.equal(result.defectSummary.length, 2);
  const defect = result.defectSummary.find(item => item.defect === '合成缺陷甲/合成缺陷乙');
  assert.equal(defect.recordCount, 9);
  assert.equal(result.overview.recordCount, 10);
  const line = defect.lines.find(item => item.line === '11线前副');
  assert.equal(line.ops.find(item => item.op === 'OP40').locations.length, 7, 'all positions are present, including those outside dashboard Top5');
  assert.equal(line.ops.find(item => item.op === '其他').label, '未识别工位');
  assert.equal(line.ops.find(item => item.op === '其他').locations[0].location, '未填写位置');
  for (const currentDefect of result.defectSummary) {
    assert.equal(currentDefect.lines.reduce((sum, item) => sum + item.recordCount, 0), currentDefect.recordCount);
    assert.ok(Math.abs(currentDefect.lines.reduce((sum, item) => sum + item.share, 0) - 1) < 1e-12);
    for (const currentLine of currentDefect.lines) {
      assert.equal(currentLine.ops.reduce((sum, item) => sum + item.recordCount, 0), currentLine.recordCount);
      assert.ok(Math.abs(currentLine.ops.reduce((sum, item) => sum + item.share, 0) - 1) < 1e-12);
      for (const op of currentLine.ops) {
        assert.equal(op.locations.reduce((sum, item) => sum + item.recordCount, 0), op.recordCount);
        assert.ok(Math.abs(op.locations.reduce((sum, item) => sum + item.share, 0) - 1) < 1e-12);
      }
    }
  }
});

test('hierarchy piece counts dedupe per node but remain non-additive across locations', () => {
  const rows = [row({ '缺陷位置': 'TSL-1-合成位置-OP40' }), row({ '缺陷位置': 'TSL-2-合成位置-OP40' }),
    row({ '物料编码': 'FRONT_SECONDARY', '缺陷位置': 'TSL-2-合成位置-OP40' })];
  const result = weld.buildWeldDashboard(rows, period);
  const defect = result.defectSummary[0], op = defect.lines[0].ops[0];
  assert.equal(defect.recordCount, 3);
  assert.equal(defect.pieceCount, 2);
  assert.equal(op.pieceCount, 2);
  assert.equal(op.locations.reduce((sum, item) => sum + item.pieceCount, 0), 3);
  assert.ok(result.notes.some(note => note.includes('各分支涉及件数不宜直接相加')));
});

test('hierarchy exact filters reproduce a selected branch across details, totals, OP, Top5 and trends', () => {
  const rows = [row({ id: 'KEEP', '缺陷位置': 'TSL-1-合成位置-OP040-BR01' }),
    row({ id: 'KEEP-DUPLICATE', '缺陷位置': 'TSL-1-合成位置-OP040-BR02' }),
    row({ id: 'OTHER-POSITION', '缺陷位置': 'TSL-2-合成位置-OP40' }),
    row({ id: 'OTHER-OP', '缺陷位置': 'TSL-1-合成位置-OP60' }),
    row({ id: 'OTHER-LINE', '二维码': 'SYN12A001', '缺陷位置': 'TSL-1-合成位置-OP40' }),
    row({ id: 'OTHER-DEFECT', '缺陷内容': '另一缺陷', '缺陷位置': 'TSL-1-合成位置-OP40' })];
  const before = JSON.stringify(rows), all = weld.buildWeldDashboard(rows, period);
  const defect = all.defectSummary.find(item => item.defect === '焊偏');
  const line = defect.lines.find(item => item.line === '11线前副'), op = line.ops.find(item => item.op === 'OP40');
  const location = op.locations.find(item => item.location === 'TSL-1-合成位置-OP40');
  assert.deepEqual(location.filters, { defectType: 'all', defects: ['焊偏'], line: '11线前副', op: 'OP40', location: 'TSL-1-合成位置-OP40' });
  const selected = weld.buildWeldDashboard(rows, { ...period, ...location.filters });
  assert.deepEqual(selected.filteredRows.map(item => item.id), ['KEEP', 'KEEP-DUPLICATE']);
  assert.equal(selected.overview.recordCount, location.recordCount);
  assert.equal(selected.overview.pieceCount, location.pieceCount);
  assert.equal(selected.selected.op, 'OP40');
  assert.equal(selected.selected.location, 'TSL-1-合成位置-OP40');
  assert.equal(selected.lineOpSummary[0].recordCount, 2);
  assert.equal(selected.topLocations[0].recordCount, 2);
  assert.equal(selected.trend.reduce((sum, item) => sum + (item.recordCount || 0), 0), 2);
  assert.equal(selected.dailyTrend.reduce((sum, item) => sum + (item.recordCount || 0), 0), 2);
  assert.equal(JSON.stringify(rows), before);
});

test('unknown OP and missing location are explicit exact filters rather than keyword guesses', () => {
  const rows = [row({ id: 'MISSING', '缺陷内容': '', '缺陷位置': '' }),
    row({ id: 'NO-OP', '缺陷位置': '合成位置但未给工位' }),
    row({ id: 'REAL-OP', '缺陷位置': 'OP40', '备注': '包含未填写位置和其他等字样' })];
  const all = weld.buildWeldDashboard(rows, { ...period, op: null, location: null });
  assert.equal(all.overview.recordCount, 3);
  assert.equal(all.selected.op, 'all');
  assert.equal(all.selected.location, 'all');
  const unknown = weld.buildWeldDashboard(rows, { ...period, op: '其他' });
  assert.deepEqual(unknown.filteredRows.map(item => item.id), ['MISSING', 'NO-OP']);
  const missing = weld.buildWeldDashboard(rows, { ...period, op: '其他', location: '未填写位置' });
  assert.deepEqual(missing.filteredRows.map(item => item.id), ['MISSING']);
  assert.deepEqual(missing.defectSummary[0].lines[0].ops[0].locations[0].filters,
    { defectType: 'all', defects: ['未填写'], line: '11线前副', op: '其他', location: '未填写位置' });
  assert.equal(weld.buildWeldDashboard(rows, { ...period, op: 'OP400' }).overview.recordCount, 0);
});

test('source parent types partition repeated content labels without relabeling missing parents', () => {
  const rows = [row({ id: 'A-X', badness_type: '合成分类甲', '缺陷内容': '合成内容X' }),
    row({ id: 'B-X', badness_type: '合成分类乙', '缺陷内容': '合成内容X' }),
    row({ id: 'NO-X', badness_type: '', '缺陷内容': '合成内容X' }),
    row({ id: 'A-Y', badness_type: '合成分类甲', '缺陷内容': '合成内容Y' })];
  const snapshot = JSON.stringify(rows), report = weld.buildWeldDashboard(rows, period);
  assert.equal(report.defectTypeSummary.reduce((sum, item) => sum + item.recordCount, 0), 4);
  assert.equal(report.defectSummary.find(item => item.defect === '合成内容X').recordCount, 3);
  assert.equal(report.defectTypeSummary.find(item => item.defectType === '合成分类甲').recordCount, 2);
  assert.equal(report.defectTypeSummary.find(item => item.defectType === '未填写分类').recordCount, 1);
  const classification = report.defectSummary.find(item => item.defect === '合成内容X').classification;
  assert.equal(classification.parentTypes.length, 3);
  assert.equal(classification.parentTypes.reduce((sum, item) => sum + item.recordCount, 0), 3);
  assert.equal(classification.content, '合成内容X');
  assert.equal(classification.furtherSubtypeStatus, 'not_provided');
  assert.equal(report.catalogStatus.provided, false);
  assert.equal(JSON.stringify(rows), snapshot);
});

test('typed defect hierarchy filters reproduce exact parent/content/line/OP/location branches', () => {
  const rows = [row({ id: 'A', raw: { type: '合成分类甲' }, '缺陷内容': '合成联合内容甲/乙' }),
    row({ id: 'B', raw: { type: '合成分类乙' }, '缺陷内容': '合成联合内容甲/乙' }),
    row({ id: 'UNKNOWN', '缺陷内容': '合成联合内容甲/乙' })];
  const settings = { ...period, fieldMap: { defectType: 'raw.type' } };
  const report = weld.buildWeldDashboard(rows, settings);
  const type = report.defectTypeSummary.find(item => item.defectType === '合成分类甲');
  const content = type.defects[0], location = content.lines[0].ops[0].locations[0];
  assert.equal(content.defect, '合成联合内容甲/乙');
  assert.equal(content.share, 1);
  assert.equal(type.share, 1 / 3);
  assert.equal(location.filters.defectType, '合成分类甲');
  const selected = weld.buildWeldDashboard(rows, { ...settings, ...location.filters });
  assert.deepEqual(selected.filteredRows.map(item => item.id), ['A']);
  assert.equal(selected.defectTypeSummary.length, 1);
  assert.equal(selected.defectSummary[0].filters.defectType, '合成分类甲');
  assert.equal(selected.selected.defectType, '合成分类甲');
  assert.equal(selected.overview.recordCount, 1);
  assert.deepEqual(weld.buildWeldDashboard(rows, { ...settings, defectType: '未填写分类' }).filteredRows.map(item => item.id), ['UNKNOWN']);
});

test('complete source coverage permits zero-only dictionary contents without creating source records', () => {
  const rows = [row({ badness_type: '合成分类甲', '缺陷内容': '合成内容一' }),
    row({ badness_type: '合成分类甲', '缺陷内容': '合成联合内容甲/乙' }),
    row({ badness_type: '', '缺陷内容': '合成内容一' })];
  const defectCatalog = [{ defectType: '合成分类甲', defects: ['合成内容一', '合成联合内容甲/乙', '合成未观测内容'] },
    { defectType: '合成分类乙', defects: ['合成另一未观测内容'] }];
  const report = weld.buildWeldDashboard(rows, { ...period, defectCatalog, sourceComplete: true });
  const typeA = report.defectTypeSummary.find(item => item.defectType === '合成分类甲');
  assert.equal(typeA.defects.length, 3);
  const missing = typeA.defects.find(item => item.defect === '合成未观测内容');
  assert.equal(missing.recordCount, 0); assert.equal(missing.pieceCount, 0); assert.equal(missing.share, 0);
  assert.equal(missing.observedRows, 0); assert.equal(missing.catalogOnly, true); assert.deepEqual(missing.lines, []);
  assert.deepEqual(missing.filters, { defectType: '合成分类甲', defects: ['合成未观测内容'] });
  assert.equal(missing.classification.parentTypes[0].value, '合成分类甲');
  assert.equal(typeA.defects.find(item => item.defect === '合成联合内容甲/乙').recordCount, 1);
  const typeB = report.defectTypeSummary.find(item => item.defectType === '合成分类乙');
  assert.equal(typeB.recordCount, 0); assert.equal(typeB.defects[0].recordCount, 0); assert.equal(typeB.share, 0);
  assert.equal(report.defectTypeSummary.find(item => item.defectType === '未填写分类').recordCount, 1);
  assert.equal(report.overview.recordCount, 3);
  assert.equal(report.filteredRows.length, 3);
  assert.equal(report.defectSummary.length, 2, 'legacy overall summary remains observed contents only');
  assert.equal(report.defectTypeSummary.reduce((sum, item) => sum + item.recordCount, 0), 3);
  assert.deepEqual(report.catalogStatus, { provided: true, typeCount: 2, contentCount: 4, sourceComplete: true });
});

test('partial or unproven source coverage keeps unobserved dictionary contents null', () => {
  const rows = [row({ badness_type: '合成分类甲', '缺陷内容': '合成已观测内容' })];
  const defectCatalog = [{ defectType: '合成分类甲', defects: ['合成已观测内容', '合成未观测内容'] },
    { defectType: '合成分类乙', defects: ['合成另一未观测内容'] }];
  for (const sourceComplete of [false, undefined]) {
    const report = weld.buildWeldDashboard(rows, { ...period, defectCatalog, sourceComplete });
    const typeA = report.defectTypeSummary.find(item => item.defectType === '合成分类甲');
    assert.equal(typeA.defects.find(item => item.defect === '合成已观测内容').recordCount, 1);
    const missing = typeA.defects.find(item => item.defect === '合成未观测内容');
    assert.equal(missing.recordCount, null); assert.equal(missing.pieceCount, null); assert.equal(missing.share, null);
    assert.equal(missing.classification.parentTypes[0].recordCount, null);
    const typeB = report.defectTypeSummary.find(item => item.defectType === '合成分类乙');
    assert.equal(typeB.recordCount, null); assert.equal(typeB.defects[0].recordCount, null);
    assert.equal(report.options.defectTypes.find(item => item.value === '合成分类乙').count, null);
    assert.equal(report.overview.recordCount, 1);
  }
});

test('catalog de-duplicates labels, retains observed contents absent from dictionary, and obeys parent filter', () => {
  const rows = [row({ badness_type: '合成分类甲', '缺陷内容': '合成历史内容' }),
    row({ badness_type: '合成分类乙', '缺陷内容': '合成内容乙' })];
  const defectCatalog = [{ defectType: '合成分类甲', defects: ['合成内容甲', '合成内容甲'] },
    { defectType: '合成分类甲', defects: ['合成内容甲', '合成内容丙'] },
    { defectType: '合成分类乙', defects: ['合成内容乙'] }];
  const report = weld.buildWeldDashboard(rows, { ...period, defectCatalog, defectType: '合成分类甲', sourceComplete: true });
  assert.equal(report.defectTypeSummary.length, 1);
  assert.equal(report.defectTypeSummary[0].defects.length, 3);
  assert.equal(report.defectTypeSummary[0].defects.find(item => item.defect === '合成历史内容').recordCount, 1);
  assert.equal(report.overview.recordCount, 1);
  assert.equal(report.catalogStatus.contentCount, 3);
  assert.throws(() => weld.buildWeldDashboard([], { defectCatalog: {} }), /array/);
});
