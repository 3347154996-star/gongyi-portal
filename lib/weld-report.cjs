'use strict';

/*
 * Pure weld-report calculations based on independently verified report rules.
 * No company material numbers, historical records or figures are embedded.
 * Every qualifying source row counts as one point, including
 * exact duplicates. QR uniqueness is limited to the same product and period.
 *
 * buildWeldReport(rows, {
 *   fieldMap: { material:'materialCode', defect:'defectContent', qr:'qrCode',
 *     location:'defectLocation', remark:'remark', recordedAt:'createdAt', id:'id' },
 *   materialGroups:{front:['FRONT_PRIMARY','FRONT_SECONDARY'],rear:['REAR_PRIMARY','REAR_SECONDARY']},
 *   startDate:'YYYY-MM-DD', endDate:'YYYY-MM-DD', source:'API description',
 *   timeZone:'Asia/Shanghai', historyRows:[...], trendEndDate:'YYYY-MM-DD',
 *   coverage:[{startDate,endDate,complete:true,source}],
 *   historyWeeks:[{startDate,endDate,coverage:'complete',source,
 *     products:{front:{defectPoints,pieces,materials:[...],defects:[...]},rear:{...}}}]
 * })
 * fieldMap values may be dotted paths, path arrays, or pure accessor functions.
 * Historical aggregates need explicit material/defect scopes for comparison.
 * Coverage is supplied by the caller; observed events never prove completeness.
 * A full source-covered week with no records can be zero. An absent historical
 * week without complete coverage is null, never fabricated zero.
 */

const LINES = Object.freeze(['11', '12', '13', '14']);
const DEFECTS = Object.freeze(['焊偏', '焊穿']);
const MATERIAL_GROUPS = Object.freeze({
  front: Object.freeze(['FRONT_PRIMARY', 'FRONT_SECONDARY']),
  rear: Object.freeze(['REAR_PRIMARY', 'REAR_SECONDARY'])
});
const DEFAULT_FIELD_MAP = Object.freeze({
  material: '物料编码', defect: '缺陷内容', qr: '二维码',
  location: '缺陷位置', remark: '备注', recordedAt: '录入时间', id: 'id'
});
const REQUIRED_FIELDS = Object.freeze(['material', 'defect', 'qr', 'location', 'recordedAt']);
const DAY_MS = 86400000;
const text = value => value == null ? '' : String(value).trim();
const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const zeros = () => Object.fromEntries(LINES.map(line => [line, 0]));

function resolveMaterialGroups(options = {}) {
  const groups = {};
  for (const key of ['front', 'rear']) {
    const supplied = options.materialGroups && options.materialGroups[key];
    const values = supplied === undefined ? MATERIAL_GROUPS[key] : supplied;
    if (!Array.isArray(values) || values.length === 0 || values.some(value => !text(value))) throw new TypeError(`materialGroups.${key} must be a nonempty array`);
    groups[key] = [...new Set(values.map(text))];
  }
  if (groups.front.some(value => groups.rear.includes(value))) throw new TypeError('front and rear material groups must not overlap');
  return groups;
}

function getField(row, accessor) {
  if (typeof accessor === 'function') return accessor(row);
  const path = Array.isArray(accessor) ? accessor : String(accessor || '').split('.');
  return path.reduce((value, key) => value == null ? undefined : value[key], row);
}

function validDay(year, month, day) {
  const value = new Date(Date.UTC(year, month - 1, day));
  return value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === day;
}

function normalizeDate(value, options = {}) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const input = value.trim();
    const date = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:$|[ T])/.exec(input);
    if (!date || !validDay(Number(date[1]), Number(date[2]), Number(date[3]))) return null;
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(input)) {
      const clock = /[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(input);
      if (input.length > date[0].replace(/[ T]$/, '').length &&
          (!clock || Number(clock[1]) > 23 || Number(clock[2]) > 59 || Number(clock[3] || 0) > 59)) return null;
      return `${date[1]}-${date[2].padStart(2, '0')}-${date[3].padStart(2, '0')}`;
    }
  }
  const date = value instanceof Date ? value : new Date(typeof value === 'number' && options.timestampUnit === 'seconds' ? value * 1000 : value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: options.timeZone || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function lineFromQr(value) {
  const match = /(11|12|13|14)[A-Z]\d{3}$/.exec(text(value).toUpperCase());
  return match ? match[1] : null;
}

function lineFromRemarks(value) {
  const input = text(value), matches = new Set();
  for (const match of input.matchAll(/(?<!\d)(11|12|13|14)\s*(?:线|号线|线体|产线)/g)) matches.add(match[1]);
  for (const match of input.matchAll(/(?:产线|线体|线别)\s*[:：]?\s*(11|12|13|14)(?!\d)/g)) matches.add(match[1]);
  return matches.size === 1 ? [...matches][0] : null;
}

function decodeProductionLine(qr, remark) {
  const qrLine = lineFromQr(qr), remarkLine = lineFromRemarks(remark);
  return {
    line: qrLine || remarkLine,
    source: qrLine ? 'qr' : remarkLine ? 'remark' : 'unassigned',
    qrLine, remarkLine, conflict: Boolean(qrLine && remarkLine && qrLine !== remarkLine)
  };
}

function normalizeLocation(value) {
  const normalized = text(value).replace(/OP\s*0*(\d+)/gi, (_, number) => `OP${String(Number(number)).padStart(2, '0')}`);
  const match = /^(TSL-.*?-OP\d+(?:-\d+)*)(?:-[A-Za-z]|$)/i.exec(normalized);
  return match ? match[1] : normalized;
}

function opFromLocation(value) {
  const match = /(?:^|[^A-Z])OP\s*0*(\d+)((?:-\d+)*)(?=$|[^\d])/.exec(text(value).toUpperCase());
  return match ? `OP${String(Number(match[1])).padStart(2, '0')}${match[2]}` : '其他';
}

function positionOrder(a, b) {
  const aa = /^TSL-(\d+)/i.exec(a), bb = /^TSL-(\d+)/i.exec(b);
  return (aa ? Number(aa[1]) : 999999) - (bb ? Number(bb[1]) : 999999) || lexical(a, b);
}

function opOrder(a, b) {
  const aa = a.slice(2).split('-').map(Number), bb = b.slice(2).split('-').map(Number);
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return aa.length - bb.length || lexical(a, b);
}

function countBy(rows, accessor) {
  const counts = new Map();
  for (const row of rows) { const key = accessor(row); counts.set(key, (counts.get(key) || 0) + 1); }
  return counts;
}

function stableSourceKey(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSourceKey).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSourceKey(value[key])}`).join(',')}}`;
}

function prepareRows(rows, options = {}) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  const fieldMap = { ...DEFAULT_FIELD_MAP, ...(options.fields || {}), ...(options.fieldMap || {}) };
  return rows.map((input, index) => {
    const row = input && typeof input === 'object' ? input : {};
    const values = Object.fromEntries(Object.entries(fieldMap).map(([key, accessor]) => [key, getField(row, accessor)]));
    const normalized = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, text(value)]));
    const location = normalizeLocation(normalized.location);
    return {
      ...normalized, index, date: normalizeDate(values.recordedAt, options), location,
      op: opFromLocation(location), lineInfo: decodeProductionLine(normalized.qr, normalized.remark),
      missingFields: REQUIRED_FIELDS.filter(key => !normalized[key]),
      missingKeys: REQUIRED_FIELDS.filter(key => values[key] === undefined),
      sourceKey: stableSourceKey(row)
    };
  });
}

function fieldCounts(rows, key = 'missingFields') {
  return Object.fromEntries(REQUIRED_FIELDS.map(field => [field, rows.filter(row => row[key].includes(field)).length]));
}

function summarizeProduct(rows, key, materials = MATERIAL_GROUPS[key]) {
  const subset = rows.filter(row => materials.includes(row.material));
  const selected = subset.filter(row => DEFECTS.includes(row.defect));
  const total = selected.length, pieces = new Set(selected.filter(row => row.qr).map(row => row.qr)).size;
  const lineCounts = zeros(), lineSourceCounts = { qr: 0, remark: 0, unassigned: 0 };
  for (const row of selected) {
    if (row.lineInfo.line) lineCounts[row.lineInfo.line]++;
    lineSourceCounts[row.lineInfo.source]++;
  }
  const top5 = [...countBy(selected.filter(row => row.location), row => row.location)]
    .sort((a, b) => b[1] - a[1] || positionOrder(a[0], b[0])).slice(0, 5)
    .map(([location, count], index) => {
      const at = selected.filter(row => row.location === location), lines = zeros();
      for (const row of at) if (row.lineInfo.line) lines[row.lineInfo.line]++;
      const code = /^(TSL-\d+)/i.exec(location);
      return { rank: index + 1, location, shortLocation: code ? code[1] : location, op: opFromLocation(location),
        total: count, share: total ? count / total : null, lines,
        unassigned: at.filter(row => !row.lineInfo.line).length,
        defectCounts: Object.fromEntries(countBy(at, row => row.defect)) };
    });
  const opShares = Object.fromEntries(LINES.map(line => {
    const at = selected.filter(row => row.lineInfo.line === line), counts = countBy(at, row => row.op);
    const known = [...counts].filter(([op]) => op !== '其他').sort((a, b) => b[1] - a[1] || opOrder(a[0], b[0]));
    const other = (counts.get('其他') || 0) + known.slice(5).reduce((sum, [, count]) => sum + count, 0);
    const items = known.slice(0, 5).concat(other ? [['其他', other]] : [])
      .map(([op, count]) => ({ op, count, share: at.length ? count / at.length : null }));
    return [line, { count: at.length, items, allCounts: Object.fromEntries(counts) }];
  }));
  const top5Total = top5.reduce((sum, item) => sum + item.total, 0);
  return {
    key, name: key === 'front' ? '前副' : '后副', materials: [...materials], available: subset.length > 0,
    allLogRecords: subset.length, defectPoints: total, pieces, pointsPerPiece: pieces ? total / pieces : null,
    defectCounts: Object.fromEntries(countBy(selected, row => row.defect)),
    lineCounts, unassignedLineCount: lineSourceCounts.unassigned, lineSourceCounts,
    top5, top5Details: top5.map(item => ({ ...item, lines: { ...item.lines }, defectCounts: { ...item.defectCounts } })),
    top5Total, top5Share: total ? top5Total / total : null, opShares,
    materialBreakdown: Object.fromEntries(materials.map(material => {
      const materialRows = selected.filter(row => row.material === material);
      return [material, { allLogRecords: subset.filter(row => row.material === material).length,
        defectPoints: materialRows.length, pieces: new Set(materialRows.filter(row => row.qr).map(row => row.qr)).size }];
    })),
    diagnostics: {
      missingFields: fieldCounts(selected), missingKeys: fieldCounts(selected, 'missingKeys'),
      missingQr: selected.filter(row => !row.qr).length,
      missingLocation: selected.filter(row => !row.location).length,
      unknownOp: selected.filter(row => row.op === '其他').length,
      unassignedLine: lineSourceCounts.unassigned, remarkFallback: lineSourceCounts.remark,
      qrRemarkConflicts: selected.filter(row => row.lineInfo.conflict).length,
      fullyDuplicateRowsRetained: total - new Set(selected.map(row => row.sourceKey)).size
    }
  };
}

function addDays(day, count) { return new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10); }
function weekStartDate(day) {
  const normalized = normalizeDate(day);
  if (!normalized) throw new TypeError('A valid date is required');
  const weekday = new Date(`${normalized}T00:00:00Z`).getUTCDay();
  return addDays(normalized, -((weekday + 6) % 7));
}
function isoWeekLabel(start) {
  const thursday = new Date(`${addDays(start, 3)}T00:00:00Z`), year = thursday.getUTCFullYear();
  const firstMonday = weekStartDate(`${year}-01-04`);
  return `${year}-W${String(Math.round((Date.parse(start) - Date.parse(firstMonday)) / (7 * DAY_MS)) + 1).padStart(2, '0')}`;
}
function scopesEqual(a, b) { return Array.isArray(a) && Array.isArray(b) && [...a].sort().join('|') === [...b].sort().join('|'); }
function coverageFor(start, end, coverage) {
  const ranges = Array.isArray(coverage) ? coverage : coverage ? [coverage] : [];
  const relevant = ranges.filter(range => range.startDate <= end && range.endDate >= start);
  const completeDays = new Set();
  for (const range of relevant.filter(item => item.complete === true)) {
    let date = range.startDate > start ? range.startDate : start;
    const limit = range.endDate < end ? range.endDate : end;
    while (date <= limit) { completeDays.add(date); date = addDays(date, 1); }
  }
  const expected = Math.round((Date.parse(end) - Date.parse(start)) / DAY_MS) + 1;
  return { status: completeDays.size === expected ? 'complete' : relevant.length ? 'partial' : 'unknown',
    completeDays: completeDays.size, expectedDays: expected, sources: [...new Set(relevant.map(item => item.source).filter(Boolean))] };
}

function comparison(current, previous) {
  if (!previous) return { allowed: false, reason: 'no_previous_week' };
  if (current.coverage !== 'complete' || previous.coverage !== 'complete') return { allowed: false, reason: 'coverage_not_complete' };
  if (!scopesEqual(current.materials, previous.materials) || !scopesEqual(current.defects, previous.defects)) return { allowed: false, reason: 'scope_not_comparable' };
  if (current.defectPoints == null || previous.defectPoints == null) return { allowed: false, reason: 'missing_data' };
  return { allowed: true, reason: null,
    defectPointsPercent: previous.defectPoints > 0 ? (current.defectPoints - previous.defectPoints) / previous.defectPoints * 100 : null,
    pointsPerPiecePercent: previous.pointsPerPiece > 0 && current.pointsPerPiece != null ? (current.pointsPerPiece - previous.pointsPerPiece) / previous.pointsPerPiece * 100 : null,
    zeroBaseline: previous.defectPoints === 0 || previous.pointsPerPiece === 0 };
}

function weeklyTrendPrepared(rows, options) {
  const materialGroups = resolveMaterialGroups(options);
  const observed = rows.map(row => row.date).filter(Boolean).sort();
  const anchor = normalizeDate(options.trendEndDate || options.endDate || options.end || options.now || observed.at(-1), options);
  if (!anchor) return [];
  const endMonday = weekStartDate(anchor), count = options.weekCount === undefined ? 5 : options.weekCount;
  if (!Number.isInteger(count) || count < 1 || count > 52) throw new RangeError('weekCount must be 1..52');
  const weeks = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    const startDate = addDays(endMonday, -7 * offset), endDate = addDays(startDate, 6);
    const inWeek = rows.filter(row => row.date && row.date >= startDate && row.date <= endDate);
    const coverage = coverageFor(startDate, endDate, options.coverage);
    const historic = (options.historyWeeks || []).find(week => week.startDate === startDate && week.endDate === endDate);
    const products = {};
    for (const key of ['front', 'rear']) {
      const summary = summarizeProduct(inWeek, key, materialGroups[key]), aggregated = historic && historic.products && historic.products[key];
      if (aggregated) {
        const points = Number.isFinite(aggregated.defectPoints) && aggregated.defectPoints >= 0 ? aggregated.defectPoints : null;
        const pieces = Number.isFinite(aggregated.pieces) && aggregated.pieces >= 0 ? aggregated.pieces : null;
        products[key] = { defectPoints: points, pieces,
          pointsPerPiece: points != null && pieces > 0 ? points / pieces : null,
          materials: Array.isArray(aggregated.materials) ? [...aggregated.materials] : null,
          defects: Array.isArray(aggregated.defects) ? [...aggregated.defects] : null,
          coverage: historic.coverage === 'complete' ? 'complete' : historic.coverage === 'partial' ? 'partial' : 'unknown',
          basis: 'historical-aggregate', source: historic.source || null, observedRecords: null };
      } else {
        const available = summary.available || coverage.status === 'complete';
        products[key] = { defectPoints: available ? summary.defectPoints : null, pieces: available ? summary.pieces : null,
          pointsPerPiece: available ? summary.pointsPerPiece : null, materials: [...materialGroups[key]], defects: [...DEFECTS],
          coverage: available ? coverage.status : coverage.status === 'partial' ? 'partial' : 'missing',
          basis: 'provided-records', source: options.source || null, observedRecords: summary.allLogRecords };
      }
      products[key].comparison = comparison(products[key], weeks.at(-1)?.products[key]);
    }
    weeks.push({ startDate, endDate, label: typeof options.weekLabel === 'function' ? options.weekLabel(startDate, endDate) : isoWeekLabel(startDate),
      observedStart: inWeek.map(row => row.date).sort()[0] || null,
      observedEnd: inWeek.map(row => row.date).sort().at(-1) || null,
      coverage, products });
  }
  return weeks;
}

function buildWeeklyTrend(rows, options = {}) { return weeklyTrendPrepared(prepareRows(rows, options), options); }

function buildWeldReport(rows, options = {}) {
  const materialGroups = resolveMaterialGroups(options);
  const prepared = prepareRows(rows, options), dates = prepared.map(row => row.date).filter(Boolean).sort();
  const rawStart = options.startDate || options.start, rawEnd = options.endDate || options.end;
  const startDate = rawStart ? normalizeDate(rawStart, options) : dates[0] || null;
  const endDate = rawEnd ? normalizeDate(rawEnd, options) : dates.at(-1) || null;
  if ((rawStart && !startDate) || (rawEnd && !endDate) || (startDate && endDate && startDate > endDate)) throw new RangeError('Invalid reporting period');
  const selected = prepared.filter(row => row.date && (!startDate || row.date >= startDate) && (!endDate || row.date <= endDate));
  const targetMaterials = Object.values(materialGroups).flat();
  const products = Object.fromEntries(['front', 'rear'].map(key => [key, summarizeProduct(selected, key, materialGroups[key])]));
  return {
    period: { startDate, endDate, coverage: startDate && endDate ? coverageFor(startDate, endDate, options.coverage) : null },
    source: { label: options.source || null, inputRows: prepared.length, datedRows: dates.length,
      periodRows: selected.length, selectedDefectRows: products.front.defectPoints + products.rear.defectPoints,
      sourceFieldMap: Object.fromEntries(Object.entries({ ...DEFAULT_FIELD_MAP, ...(options.fields || {}), ...(options.fieldMap || {}) })
        .map(([key, value]) => [key, typeof value === 'function' ? '[accessor]' : value])) },
    products,
    diagnostics: {
      missingFields: fieldCounts(prepared), missingKeys: fieldCounts(prepared, 'missingKeys'),
      invalidDateRows: prepared.filter(row => !row.date && row.recordedAt).length,
      missingDateRows: prepared.filter(row => !row.recordedAt).length,
      outsidePeriodRows: prepared.filter(row => row.date && ((startDate && row.date < startDate) || (endDate && row.date > endDate))).length,
      unknownMaterialRows: selected.filter(row => !targetMaterials.includes(row.material)).length,
      unassignedTargetDefectRows: selected.filter(row => DEFECTS.includes(row.defect) && !targetMaterials.includes(row.material)).length,
      nonTargetDefectRows: selected.filter(row => targetMaterials.includes(row.material) && !DEFECTS.includes(row.defect)).length,
      unassignedLineRows: products.front.unassignedLineCount + products.rear.unassignedLineCount
    },
    weeklyTrend: weeklyTrendPrepared(options.historyRows ? prepareRows(options.historyRows, options) : prepared, { ...options, endDate }),
    methodology: {
      numerator: '焊偏或焊穿每条源记录计1点，完全重复记录保留。',
      denominator: '同产品组、同期间、同缺陷筛选内的非空二维码唯一数。',
      ratio: '点每件=补焊点/涉及补焊件数；不是产量不良率。',
      location: '规范OP零填充并移除机器人后缀；复合OP保留；空位置仍计总点但不进位置Top5。',
      line: '优先二维码末尾产线；备注仅在唯一可判定时兜底；冲突以二维码为准。',
      history: '默认ISO周一至周日；无完整覆盖证明或物料/缺陷口径不可比时不算环比。',
      limitation: '指标仅反映传入记录；事件时间分布不能证明接口取数完整。'
    }
  };
}

module.exports = { LINES, DEFECTS, MATERIAL_GROUPS, DEFAULT_FIELD_MAP, resolveMaterialGroups, normalizeDate,
  lineFromQr, lineFromRemarks, decodeProductionLine, normalizeLocation, opFromLocation,
  weekStartDate, isoWeekLabel, buildWeeklyTrend, buildWeldReport, summarizeWeldRows: buildWeldReport };
