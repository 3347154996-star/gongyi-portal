'use strict';

/*
 * Pure weld-report calculations based on independently verified report rules.
 * No company material numbers, historical records or figures are embedded.
 * Legacy report rules count each qualifying source row as one point, including
 * exact duplicates. Its QR uniqueness is limited to the same product and period.
 * The general dashboard instead labels counts as logs and uses material + QR
 * for involved-piece uniqueness; it makes no claim that rework is completed.
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
  const endMonday = (options.weekStart || weekStartDate)(anchor), count = options.weekCount === undefined ? 5 : options.weekCount;
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

// General dashboard: all materials, all defects and all production lines by default.
// The legacy buildWeldReport above intentionally retains its narrower verified rules.
const UNKNOWN_LINE = '待识别线体';
const EMPTY_DEFECT = '未填写';
const EMPTY_DEFECT_TYPE = '未填写分类';
const EMPTY_LOCATION = '未填写位置';

function dashboardLineResolver(options, materialGroups) {
  const verifiedQrMaterials = new Set(Object.values(materialGroups).flat());
  const mappings = { ...(options.fields || {}), ...(options.fieldMap || {}) };
  const fields = options.lineFields || [mappings.productionLine, mappings.lineName, mappings.line,
    'productionLine', 'lineName', 'line', 'production_line', 'line_name', '产线', '线体', '生产线'].filter(Boolean);
  const normalize = value => {
    const name = text(value);
    return /^\d+$/.test(name) ? `${name}线` : name;
  };
  const rules = (options.lineRules || []).map((rule, index) => ({
    ...rule, id: rule.id || `rule-${index + 1}`,
    regex: new RegExp(rule.pattern instanceof RegExp ? rule.pattern.source : rule.pattern,
      String(rule.flags || (rule.pattern instanceof RegExp ? rule.pattern.flags : '')).replace(/[gy]/g, ''))
  }));
  return (raw, normalized) => {
    const explicit = [...new Set(fields.map(field => normalize(getField(raw, field))).filter(Boolean))];
    const legacyQr = options.allowLegacyQr === false || !verifiedQrMaterials.has(normalized.material) ? null : lineFromQr(normalized.qr);
    if (explicit.length) return { line: explicit[0], source: 'explicit', explicitConflict: explicit.length > 1,
      qrConflict: Boolean(legacyQr && explicit[0] !== `${legacyQr}线`), ruleConflict: false };
    const matches = [];
    for (const rule of rules) {
      const value = Object.hasOwn(normalized, rule.field || 'qr') ? normalized[rule.field || 'qr'] : getField(raw, rule.field);
      const match = rule.regex.exec(text(value));
      if (!match) continue;
      const extracted = rule.line !== undefined ? rule.line : match[rule.group === undefined ? 1 : rule.group];
      const line = normalize(`${rule.prefix || ''}${text(extracted)}${rule.suffix || ''}`);
      if (line && text(extracted)) matches.push({ line, id: rule.id });
    }
    const distinct = [...new Set(matches.map(item => item.line))];
    if (distinct.length === 1) return { line: distinct[0], source: 'rule', ruleId: matches[0].id, explicitConflict: false, qrConflict: false, ruleConflict: false };
    if (distinct.length > 1) return { line: UNKNOWN_LINE, source: 'unknown', explicitConflict: false, qrConflict: false, ruleConflict: true };
    if (legacyQr) return { line: `${legacyQr}线`, source: 'legacyQr', explicitConflict: false, qrConflict: false, ruleConflict: false };
    return { line: UNKNOWN_LINE, source: 'unknown', explicitConflict: false, qrConflict: false, ruleConflict: false };
  };
}

function qualifyDashboardLine(lineInfo, product, materialName, material) {
  const productName = product === 'front' ? '前副' : product === 'rear' ? '后副' : materialName || (material ? `物料 ${material}` : null);
  // A product label separates unresolved records, but does not establish any
  // physical line number. Keep that distinction in lineInfo.source.
  if (lineInfo.source === 'unknown') return {
    ...lineInfo, baseLine: lineInfo.line, productName,
    line: productName ? `${productName}（线体待确认）` : UNKNOWN_LINE
  };
  const numericLine = /^(\d+)(?:号)?线(?:体)?$/.exec(lineInfo.line);
  if (numericLine && productName) return {
    ...lineInfo, baseLine: lineInfo.line, productName,
    line: product === 'front' || product === 'rear' ? `${numericLine[1]}线${productName}` : `${numericLine[1]}线 · ${productName}`
  };
  // Full source/configured line names remain authoritative; do not append a
  // second guessed product suffix or overwrite a supplied descriptive name.
  return { ...lineInfo, baseLine: lineInfo.line, productName };
}

function dashboardMetrics(rows) {
  // An empty material cannot identify a product; do not merge it into a fake product.
  const pieces = new Set(rows.filter(row => row.material && row.qr).map(row => JSON.stringify([row.material, row.qr]))).size;
  return { recordCount: rows.length, pieceCount: pieces, recordsPerPiece: pieces ? rows.length / pieces : null };
}

function dashboardGroups(rows, key) {
  const grouped = new Map();
  for (const row of rows) {
    const value = row[key];
    if (!grouped.has(value)) grouped.set(value, []);
    grouped.get(value).push(row);
  }
  return [...grouped].sort((a, b) => b[1].length - a[1].length || lexical(a[0], b[0]));
}

/**
 * buildWeldDashboard(rows, options)
 * Default filters: {product:'all', materialName:'all', line:'all', defects:[], op:'all', location:'all'}.
 * materialName matches the trimmed source name exactly across material codes.
 * materialNames optionally fixes the selectable names and their display order.
 * Empty defects means all. OP/location filters use the normalized display keys;
 * unknown OP is '其他' and empty location is '未填写位置'.
 * Explicit productionLine/lineName/line fields precede configured lineRules.
 * lineFields accepts accessor paths/functions. JSON-configurable lineRules:
 * [{id:'demo',field:'qr',pattern:'^DEMO-L(20|21)-[A-Z0-9]+$',group:1,suffix:'线'}].
 * Only configured front/rear materials may use the verified 11..14 legacy QR
 * suffix. Other materials and arbitrary numeric suffixes are not generalized.
 * Set allowLegacyQr:false to disable this fallback.
 * Numeric lines are qualified by known product identity so front/rear products
 * do not merge. Unknown physical lines remain explicitly pending per product.
 * filteredRows contains original input references, in source order, unmodified.
 */
function buildWeldDashboard(rows, options = {}) {
  const materialGroups = resolveMaterialGroups(options), decodeLine = dashboardLineResolver(options, materialGroups);
  const mappings = { ...(options.fields || {}), ...(options.fieldMap || {}) };
  const prepared = prepareRows(rows, options).map((row, index) => {
    const raw = rows[index], materialName = text(getField(raw, mappings.materialName || '物料名称'));
    const product = materialGroups.front.includes(row.material) ? 'front' : materialGroups.rear.includes(row.material) ? 'rear' : 'other';
    const lineInfo = qualifyDashboardLine(decodeLine(raw, row), product, materialName, row.material);
    return { ...row, raw, lineInfo, line: lineInfo.line, defect: row.defect || EMPTY_DEFECT,
      defectType: text(getField(raw, mappings.defectType || 'badness_type')) || EMPTY_DEFECT_TYPE,
      location: row.location || EMPTY_LOCATION, materialName, product };
  });
  const dates = prepared.map(row => row.date).filter(Boolean).sort();
  const rawStart = options.startDate || options.start, rawEnd = options.endDate || options.end;
  const startDate = rawStart ? normalizeDate(rawStart, options) : dates[0] || null;
  const endDate = rawEnd ? normalizeDate(rawEnd, options) : dates.at(-1) || null;
  if ((rawStart && !startDate) || (rawEnd && !endDate) || (startDate && endDate && startDate > endDate)) throw new RangeError('Invalid reporting period');
  const bounded = Boolean(rawStart || rawEnd);
  const periodRows = prepared.filter(row => !bounded || (row.date && (!rawStart || row.date >= startDate) && (!rawEnd || row.date <= endDate)));
  const selected = { product: options.product || 'all', materialName: text(options.materialName) || 'all', line: options.line || 'all', defects: options.defects == null ? [] : options.defects,
    defectType: text(options.defectType) || 'all', op: text(options.op) || 'all', location: text(options.location) || 'all' };
  if (!['all', 'front', 'rear', 'other'].includes(selected.product)) throw new RangeError('Invalid product filter');
  if (!Array.isArray(selected.defects)) throw new TypeError('defects must be an array; [] means all');
  selected.defects = [...new Set(selected.defects.map(value => text(value) || EMPTY_DEFECT))];
  selected.line = text(selected.line) || 'all';
  const keyword = text(options.keyword).toLowerCase();
  const filtered = periodRows.filter(row =>
    (selected.product === 'all' || row.product === selected.product) &&
    (selected.materialName === 'all' || row.materialName === selected.materialName) &&
    (selected.line === 'all' || row.line === selected.line) &&
    (!selected.defects.length || selected.defects.includes(row.defect)) &&
    (selected.defectType === 'all' || row.defectType === selected.defectType) &&
    (selected.op === 'all' || row.op === selected.op) &&
    (selected.location === 'all' || row.location === selected.location) &&
    (!keyword || Object.values(row.raw || {}).some(value => text(value).toLowerCase().includes(keyword)))
  );
  const total = filtered.length, metrics = dashboardMetrics(filtered);
  const byDefect = values => dashboardGroups(values, 'defect').map(([defect, items]) => ({ defect, count: items.length }));
  const byLine = values => dashboardGroups(values, 'line').map(([line, items]) => ({ line, count: items.length }));
  const materialSummaryOf = values => dashboardGroups(values, 'material').map(([material, items]) => {
    const names = [...new Set(items.map(row => row.materialName).filter(Boolean))];
    return { material, materialName: names[0] || null, materialNames: names, product: items[0].product,
      label: material ? (names[0] ? `${material} · ${names[0]}` : material) : '物料未填写', ...dashboardMetrics(items) };
  });
  const lineGroups = dashboardGroups(filtered, 'line');
  const lineSummary = lineGroups.map(([line, items]) => ({ line, ...dashboardMetrics(items), share: total ? items.length / total : null, byDefect: byDefect(items) }));
  const lineOpSummary = lineGroups.map(([line, items]) => {
    const counts = countBy(items, row => row.op);
    const known = [...counts].filter(([op]) => op !== '其他').sort((a, b) => b[1] - a[1] || opOrder(a[0], b[0]));
    const other = (counts.get('其他') || 0) + known.slice(5).reduce((sum, [, count]) => sum + count, 0);
    return { line, recordCount: items.length, items: known.slice(0, 5).concat(other ? [['其他', other]] : [])
      .map(([op, count]) => ({ op, count, share: count / items.length })) };
  });
  const classificationNote = '来源层级为不良分类→不良内容；本次未提供比不良内容更深的独立子类型字段，联合名称保持原样。';
  const summarizeDefects = (values, typeContext = 'all') => dashboardGroups(values, 'defect').map(([defect, items]) => {
    const defectFilters = { defectType: typeContext, defects: [defect] };
    const lines = dashboardGroups(items, 'line').map(([line, lineItems]) => {
      const lineFilters = { ...defectFilters, line };
      const ops = dashboardGroups(lineItems, 'op')
        .sort((a, b) => b[1].length - a[1].length || (a[0] === '其他' ? 1 : b[0] === '其他' ? -1 : opOrder(a[0], b[0])))
        .map(([op, opItems]) => {
          const opFilters = { ...lineFilters, op };
          const locations = dashboardGroups(opItems, 'location')
            .sort((a, b) => b[1].length - a[1].length || positionOrder(a[0], b[0]))
            .map(([location, locationItems]) => ({ location, label: location, ...dashboardMetrics(locationItems),
              share: locationItems.length / opItems.length, filters: { ...opFilters, location } }));
          return { op, label: op === '其他' ? '未识别工位' : op, ...dashboardMetrics(opItems),
            share: opItems.length / lineItems.length, filters: opFilters, locations };
        });
      return { line, ...dashboardMetrics(lineItems), share: lineItems.length / items.length, filters: lineFilters, ops };
    });
    return { defect, ...dashboardMetrics(items), share: values.length ? items.length / values.length : null,
      observedRows: items.length, catalogOnly: false,
      classification: { parentTypes: dashboardGroups(items, 'defectType').map(([value, parentItems]) => ({ value, label: value, recordCount: parentItems.length })),
        content: defect, furtherSubtypeStatus: 'not_provided', note: classificationNote },
      byLine: byLine(items), filters: defectFilters, lines };
  });
  const defectSummary = summarizeDefects(filtered, selected.defectType);
  if (options.defectCatalog !== undefined && !Array.isArray(options.defectCatalog)) throw new TypeError('defectCatalog must be an array');
  const catalog = new Map();
  for (const entry of options.defectCatalog || []) {
    if (!entry || typeof entry.defectType !== 'string' || !text(entry.defectType) || !Array.isArray(entry.defects)) continue;
    const type = text(entry.defectType);
    if (!catalog.has(type)) catalog.set(type, new Set());
    for (const name of entry.defects) if (typeof name === 'string' && text(name)) catalog.get(type).add(text(name));
  }
  const observedTypeGroups = new Map(dashboardGroups(filtered, 'defectType'));
  const typeNames = [...new Set([...observedTypeGroups.keys(), ...catalog.keys()])]
    .filter(type => selected.defectType === 'all' || type === selected.defectType);
  const defectTypeSummary = typeNames.map(defectType => {
    const items = observedTypeGroups.get(defectType) || [], observed = items.length > 0;
    const emptyMetrics = { recordCount: options.sourceComplete === true ? 0 : null,
      pieceCount: options.sourceComplete === true ? 0 : null, recordsPerPiece: null };
    const defects = summarizeDefects(items, defectType), observedNames = new Set(defects.map(item => item.defect));
    for (const defect of catalog.get(defectType) || []) {
      if (observedNames.has(defect)) continue;
      defects.push({ defect, ...emptyMetrics, share: options.sourceComplete === true && items.length ? 0 : null,
        observedRows: 0, catalogOnly: true,
        classification: { parentTypes: [{ value: defectType, label: defectType, recordCount: emptyMetrics.recordCount }],
          content: defect, furtherSubtypeStatus: 'not_provided', note: classificationNote },
        byLine: [], lines: [], filters: { defectType, defects: [defect] } });
    }
    defects.sort((a, b) => (b.recordCount ?? -1) - (a.recordCount ?? -1) || lexical(a.defect, b.defect));
    return { defectType, ...(observed ? dashboardMetrics(items) : emptyMetrics), observedRows: items.length, catalogOnly: !observed,
      share: observed ? (total ? items.length / total : null) : options.sourceComplete === true && total ? 0 : null,
      filters: { defectType }, defects };
  }).sort((a, b) => (b.recordCount ?? -1) - (a.recordCount ?? -1) || lexical(a.defectType, b.defectType));
  const catalogStatus = { provided: Array.isArray(options.defectCatalog), typeCount: catalog.size,
    contentCount: [...catalog.values()].reduce((sum, names) => sum + names.size, 0),
    sourceComplete: typeof options.sourceComplete === 'boolean' ? options.sourceComplete : null };
  const periodTypeCounts = new Map(dashboardGroups(periodRows, 'defectType').map(([type, items]) => [type, items.length]));
  const limit = options.topLimit === undefined ? 5 : options.topLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new RangeError('topLimit must be 1..50');
  const topLocations = dashboardGroups(filtered, 'location')
    .sort((a, b) => b[1].length - a[1].length || positionOrder(a[0], b[0])).slice(0, limit)
    .map(([location, items], index) => ({ rank: index + 1, location, ...dashboardMetrics(items),
      share: total ? items.length / total : null, byLine: byLine(items), byDefect: byDefect(items) }));
  const rawCoverage = Array.isArray(options.coverage) ? options.coverage : options.coverage ? [options.coverage] : [];
  // A selected partial date window cannot prove that the containing full week is complete.
  const coverageRanges = rawCoverage.map(range => ({ ...range,
    startDate: rawStart && range.startDate < startDate ? startDate : range.startDate,
    endDate: rawEnd && range.endDate > endDate ? endDate : range.endDate
  })).filter(range => range.startDate <= range.endDate);
  function timeSummary(start, end) {
    const at = filtered.filter(row => row.date && row.date >= start && row.date <= end);
    const coverage = coverageFor(start, end, coverageRanges);
    const present = at.length > 0 || coverage.status === 'complete';
    return { ...(present ? dashboardMetrics(at) : { recordCount: null, pieceCount: null, recordsPerPiece: null }),
      observedRows: at.length, coverageStatus: present ? coverage.status : coverage.status === 'partial' ? 'partial' : 'missing',
      complete: coverage.status === 'complete', source: options.source || null };
  }
  const dailyTrend = [];
  if (startDate && endDate) {
    const span = Math.round((Date.parse(endDate) - Date.parse(startDate)) / DAY_MS) + 1;
    if (span > 3660) throw new RangeError('Daily trend date range exceeds ten years');
    for (let day = startDate; day <= endDate; day = addDays(day, 1)) dailyTrend.push({ date: day, label: day, ...timeSummary(day, day) });
  }
  const undated = filtered.filter(row => !row.date);
  if (undated.length) dailyTrend.push({ date: null, label: '日期未填写或无效', ...dashboardMetrics(undated), observedRows: undated.length, coverageStatus: 'unknown', complete: false, source: options.source || null });
  const trend = [];
  const anchor = normalizeDate(options.trendEndDate || endDate || options.now, options);
  const weekCount = options.weekCount === undefined ? 5 : options.weekCount;
  if (!Number.isInteger(weekCount) || weekCount < 1 || weekCount > 52) throw new RangeError('weekCount must be 1..52');
  if (anchor) for (let offset = weekCount - 1; offset >= 0; offset--) {
    const start = addDays((options.weekStart || weekStartDate)(anchor), -7 * offset), end = addDays(start, 6);
    trend.push({ startDate: start, endDate: end,
      label: typeof options.weekLabel === 'function' ? options.weekLabel(start, end) : isoWeekLabel(start), ...timeSummary(start, end) });
  }
  const lineSources = { explicit: 0, rule: 0, legacyQr: 0, unknown: 0 };
  for (const row of filtered) lineSources[row.lineInfo.source]++;
  const duplicateRowsRetained = total - new Set(filtered.map(row => row.sourceKey)).size;
  const overview = { ...metrics,
    materialCount: new Set(filtered.map(row => row.material).filter(Boolean)).size,
    lineCount: new Set(filtered.filter(row => row.lineInfo.source !== 'unknown').map(row => row.line)).size,
    defectTypeCount: new Set(filtered.map(row => row.defect)).size,
    unknownLineCount: lineSources.unknown, missingQrCount: filtered.filter(row => !row.qr).length,
    missingMaterialCount: filtered.filter(row => !row.material).length, duplicateRowsRetained };
  const productNames = { all: '全部物料', front: '前副快捷组', rear: '后副快捷组', other: '其他物料' };
  if (options.materialNames !== undefined && (!Array.isArray(options.materialNames) ||
    options.materialNames.some(name => typeof name !== 'string' || !text(name)))) throw new TypeError('materialNames must be an array of nonempty strings');
  const materialNameCounts = new Map(dashboardGroups(periodRows.filter(row => row.materialName), 'materialName').map(([name, items]) => [name, items.length]));
  const materialNames = !options.materialNames?.length ? [...materialNameCounts.keys()] : [...new Set(options.materialNames.map(text))];
  const materialLineRows = selected.materialName === 'all' ? periodRows : periodRows.filter(row => row.materialName === selected.materialName);
  return {
    overview, lineSummary, lineOpSummary, defectSummary, defectTypeSummary, catalogStatus, topLocations, materialSummary: materialSummaryOf(filtered), trend, dailyTrend,
    filteredRows: filtered.map(row => row.raw), selected,
    options: {
      products: Object.entries(productNames).map(([value, label]) => ({ value, label, count: value === 'all' ? periodRows.length : periodRows.filter(row => row.product === value).length })),
      materialNames: [{ value: 'all', label: '全部物料', count: periodRows.length }, ...materialNames.map(value => ({ value, label: value,
        count: materialNameCounts.get(value) || (options.sourceComplete === true ? 0 : null) }))],
      lines: [{ value: 'all', label: '全部线体', count: materialLineRows.length }, ...dashboardGroups(materialLineRows, 'line').map(([value, items]) => ({ value, label: value, count: items.length }))],
      defects: dashboardGroups(periodRows, 'defect').map(([value, items]) => ({ value, label: value, count: items.length })),
      defectTypes: [...new Set([...periodTypeCounts.keys(), ...catalog.keys()])]
        .map(value => { const count = periodTypeCounts.get(value) || 0;
          return { value, label: value, count: count || (options.sourceComplete === true ? 0 : null) }; }),
      materials: materialSummaryOf(periodRows).map(item => ({ value: item.material, label: item.label, count: item.recordCount }))
    },
    period: { startDate, endDate, coverage: startDate && endDate ? coverageFor(startDate, endDate, coverageRanges) : null },
    source: { label: options.source || null, inputRows: prepared.length, periodRows: periodRows.length, filteredRows: total,
      complete: typeof options.sourceComplete === 'boolean' ? options.sourceComplete : null },
    diagnostics: {
      inputMissingFields: fieldCounts(prepared), filteredMissingFields: fieldCounts(filtered),
      missingDateRows: prepared.filter(row => !row.recordedAt).length,
      invalidDateRows: prepared.filter(row => row.recordedAt && !row.date).length,
      outsidePeriodRows: prepared.filter(row => row.date && ((rawStart && row.date < startDate) || (rawEnd && row.date > endDate))).length,
      undatedRowsExcludedByDateFilter: bounded ? prepared.filter(row => !row.date).length : 0,
      unknownLineRows: lineSources.unknown, missingMaterialRows: overview.missingMaterialCount,
      missingQrRows: overview.missingQrCount, missingPieceKeyRows: filtered.filter(row => !row.material || !row.qr).length,
      explicitLineConflicts: filtered.filter(row => row.lineInfo.explicitConflict).length,
      qrFieldConflicts: filtered.filter(row => row.lineInfo.qrConflict).length,
      lineRuleConflicts: filtered.filter(row => row.lineInfo.ruleConflict).length,
      productQualifiedLineRows: filtered.filter(row => row.lineInfo.source !== 'unknown' && row.line !== row.lineInfo.baseLine).length,
      pendingProductLineGroups: new Set(filtered.filter(row => row.lineInfo.source === 'unknown').map(row => row.line)).size,
      lineSources, duplicateRowsRetained
    },
    notes: [
      '统计对象是筛选后的缺陷日志；一条日志不等于一个已经完成的补焊点，也不代表完工件数。',
      '涉及件数按非空物料编码与非空二维码的组合去重；重复源日志仍逐条保留。缺少组合键的记录计入日志条数，但不计件数。',
      '默认全部物料、全部线体、全部缺陷；物料名称按来源去除首尾空白后精确筛选，同名不同料号均保留，不合并相似名称。',
      '物料名称选项按配置顺序展示，未配置时使用当期观测名称；各选项计数为所选日期内的日志条数，无观测记录且来源不完整时计数未知。全部物料包含所有已读取记录。',
      '明确线体字段优先，配置规则其次；只有配置的前副/后副物料采用已验证的11至14线二维码末尾规则，其他无法确认的显示待识别线体。',
      '已确认的数字线号结合产品身份区分，例如11线前副与11线后副。产品身份来自配置物料组或原始物料名称；完整线体名称按来源保留。',
      '未知物理线体按产品名称分别显示线体待确认；名称缺失时按物料编码区分。这些只是待确认分组，不代表已识别的物理产线，也不计入已识别线体数量。',
      '各线OP占比以该线全部筛选后日志为分母，前五个已知OP之外的工位和未识别工位归入其他。',
      '每种缺陷可按线体、OP、位置展开全部已读记录，各层占比以直属上层日志数为分母；未识别工位和未填写位置仍计入总数。',
      '来源不良分类与不良内容分层展示；当前不良内容本身就是来源子项，不再按名称猜更细子类型，缺少父类的记录保留未填写分类。',
      '完整分类来自调用方提供的来源字典，字典无观测子项仅在本次来源完整时显示0，否则显示缺失；字典选项数量不等于当期有记录的子项数量。',
      '层级日志条数可逐级核对；同一件可能涉及多个OP或位置，各分支涉及件数不宜直接相加。缺陷联合名称保持原样，不按斜杠拆成多条记录。',
      '图表和明细使用相同筛选。时间趋势只反映已读取的日期；未证明完整覆盖且没有记录的期间显示缺失，不补零。'
    ]
  };
}

module.exports = { LINES, DEFECTS, MATERIAL_GROUPS, DEFAULT_FIELD_MAP, resolveMaterialGroups, normalizeDate,
  lineFromQr, lineFromRemarks, decodeProductionLine, normalizeLocation, opFromLocation,
  weekStartDate, isoWeekLabel, buildWeeklyTrend, buildWeldReport, summarizeWeldRows: buildWeldReport,
  UNKNOWN_LINE, EMPTY_DEFECT, EMPTY_DEFECT_TYPE, buildWeldDashboard };
