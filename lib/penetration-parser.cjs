'use strict';
const crypto = require('node:crypto');
const XLSX = require('./vendor/xlsx.cjs');

const PARSER_VERSION = 2;
const MAX_FILE_BYTES = 160 * 1024 * 1024;
const MAX_CELLS = 2_000_000;
const MAX_RECORDS = 100_000;
const norm = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, '').trim();
const text = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const blank = value => !norm(value) || /^(?:[-—_/\\]|无|暂无|待定|待检|未检|未检测|待复切|未复切|待确认|待判定|未判定|未完成|NA|N\/A)+$/i.test(norm(value));
// SheetJS represents Excel errors as numeric codes (for example #N/A = 42).
// Such cached errors are neither a result nor evidence that a template was tested.
const cellValue = cell => cell?.t === 'e' ? undefined : cell?.v;

function classifyResult(value, { feedback = false, followup = false } = {}) {
  const valueText = norm(value).toUpperCase();
  if (blank(valueText)) return null;
  if (/^(?:NG\d*|NOK|FAIL(?:ED)?|不合格|不符合(?:要求)?|报废|×|✕)(?:$|[（(:：,，、])/.test(valueText)) return 'NG';
  if (/^(?:OK|PASS(?:ED)?|合格|符合要求|无缺陷|√|✓)$/.test(valueText)) return 'OK';
  if (feedback) return 'NG';
  if (followup && /熔深|咬边|气孔|未熔合|烧穿|裂纹|焊偏|焊穿|缺焊|间隙|未焊透|凹陷|夹渣|缩孔|漏焊|不融合/.test(valueText)) return 'NG';
  return null;
}

function calendarDate(year, month, day) {
  if (![year, month, day].every(Number.isInteger) || year < 1900 || year > 2199 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null;
}

function parseDate(cell, { year, date1904 = false } = {}) {
  if (!cell || cell.t === 'e' || cell.v === undefined || cell.v === null) return null;
  const value = cell.v;
  if (value instanceof Date) return calendarDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1000) {
    const date = XLSX.SSF.parse_date_code(value, { date1904 });
    return date && calendarDate(date.y, date.m, date.d);
  }
  // Small numeric dates in these feedback sheets use a visible month.day convention.
  // The display format matters: 1.10 formatted with two decimals must stay January 10.
  const display = typeof value === 'number' && cell.w && /^\d{1,2}[./-]\d{1,2}$/.test(norm(cell.w)) ? cell.w : value;
  const valueText = norm(display);
  let match = /^(\d{4})[年./-](\d{1,2})[月./-](\d{1,2})(?:日)?(?:[T ]?\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)?)?$/.exec(valueText);
  if (match) return calendarDate(+match[1], +match[2], +match[3]);
  match = /^(\d{1,2})[月./-](\d{1,2})日?$/.exec(valueText);
  return match && Number.isInteger(year) ? calendarDate(year, +match[1], +match[2]) : null;
}

function headerSchema(cells) {
  const headings = [...cells.entries()].map(([column, cell]) => [column, norm(cellValue(cell))]);
  const find = regex => headings.find(([, value]) => regex.test(value))?.[0];
  const date = find(/^(?:日期|检测日期|检验日期|送检日期)$/);
  const point = find(/^(?:不合格编号|不合格熔深编号|熔深编号|焊缝编号|位置编号)$/);
  const finding = find(/^(?:不合格现象|缺陷描述)$/);
  const judgment = find(/^(?:实验判定|试验判定|实验室判定|检验结果|检测结果)$/);
  if (date === undefined || point === undefined || finding === undefined && judgment === undefined) return null;
  const product = find(/^(?:产品名称(?:\/线体)?|产品型号|零件名称)$/);
  const line = find(/^(?:线体|生产线|产品名称\/线体)$/);
  const trace = headings.find(([, value]) => /钢印码|二维码|追溯码/.test(value) && !/补切|复切|调试|[2二]/.test(value))?.[0];
  const photo = find(/^(?:熔深图片|熔深图)$/);
  const gap = find(/^间隙大小$/);
  const followups = headings.filter(([column, value]) => {
    if (column === finding || column === judgment) return false;
    if (/复切|复检|补切|补检|调试/.test(value) && !/图|钢印|二维码|编号|现象|描述|日期|时间/.test(value)) return true;
    return finding !== undefined && column > finding && value === '不合格现象';
  }).map(([column, value]) => ({ column, stage: /调试/.test(value) ? 'debug' : /补/.test(value) ? 'supplemental' : /复/.test(value) ? 'recut' : 'followup' }));
  return { date, point, finding, judgment, product, line, trace, photo, gap, followups, kind: judgment === undefined ? 'feedback' : 'initial' };
}

function isSupportingReport(rows) {
  const value = (row, column) => norm(cellValue(rows.get(row)?.get(column)));
  if (!/Testresult/i.test(value(0, 0)) || !/结果/.test(value(0, 0)) || !/零件名称/.test(value(1, 0)) || !/报告日期/.test(value(1, 0))) return false;
  const singleRow = value(2, 0) === '序号' && value(2, 1) === '位置示意图' &&
    [14, 15].some(column => value(3, column) === '结果判定');
  const multiRow = value(2, 0) === '工位' && /^NO序号$/i.test(value(2, 1)) && /^judge判定$/i.test(value(2, 15));
  return singleRow || multiRow;
}

function parsePenetrationWorkbook({ buffer, category, year, month } = {}) {
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) throw new TypeError('熔深工作簿内容必须为二进制文件。');
  if (!['full', 'bracket'].includes(category) || !Number.isInteger(year) || year < 1900 || year > 2199 || month !== undefined && (!Number.isInteger(month) || month < 1 || month > 12)) throw new TypeError('熔深来源分类或年月无效。');
  if (!buffer.length || buffer.length > MAX_FILE_BYTES) throw new Error('熔深工作簿为空或超过读取上限。');
  const bytes = Buffer.from(buffer);
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const ole = bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'));
  if (!zip && !ole) throw new Error('仅支持有效的 XLSX 或 XLS 工作簿。');
  let workbook;
  try {
    workbook = XLSX.read(bytes, { type: 'buffer', cellNF: true, cellText: true, cellDates: false, cellStyles: false, sheetStubs: false, bookVBA: false, bookDeps: false });
  } catch {
    throw new Error('熔深工作簿无法解析，请检查文件格式、加密状态和完整性。');
  }
  const diagnostics = { sheets: workbook.SheetNames.length, supportedSheets: 0, supportingSheets: 0, supportingWorkbooks: 0, unsupportedSheets: 0, excludedOtherDates: 0, unknownDate: 0, unknownResult: 0, missingProduct: 0, duplicateRecords: 0, conflictingRecords: 0, weakIdentity: 0, ambiguousShortDates: 0, missingFormulaResults: 0, emptyRows: 0, templateRows: 0, feedbackRecords: 0, initialRecords: 0 };
  const fileHash = digest(bytes);
  const date1904 = Boolean(workbook.Workbook?.WBProps?.date1904);
  const records = [], recordMap = new Map(), products = new Set();
  let cellCount = 0;
  for (let sheetIndex = 0; sheetIndex < workbook.SheetNames.length; sheetIndex++) {
    const sheet = workbook.Sheets[workbook.SheetNames[sheetIndex]];
    const rows = new Map();
    // Do not walk !ref: photographic workbooks can claim all 1,048,576 rows.
    for (const [address, cell] of Object.entries(sheet || {})) {
      if (!/^[A-Z]+[1-9]\d*$/.test(address) || cell?.t === 'z' || cell?.v === undefined && !cell?.f) continue;
      const { r, c } = XLSX.utils.decode_cell(address);
      if (c >= 128) continue;
      if (++cellCount > MAX_CELLS) throw new Error('熔深工作簿有效单元格超过读取上限，请拆分文件。');
      if (!rows.has(r)) rows.set(r, new Map());
      rows.get(r).set(c, cell);
    }
    // Detailed full-cut reports may overlap the feedback summaries. They are
    // recognized attachments, not a complete initial-inspection denominator.
    if (category === 'full' && isSupportingReport(rows)) { diagnostics.supportingSheets++; continue; }
    const merges = (sheet?.['!merges'] || []).filter(merge => merge.s.c < 128 && merge.e.c < 128);
    const cellAt = (row, column) => {
      if (column === undefined) return undefined;
      const direct = rows.get(row)?.get(column);
      if (direct && direct.v !== undefined && direct.v !== '') return direct;
      const merge = merges.find(range => range.s.r <= row && range.e.r >= row && range.s.c <= column && range.e.c >= column);
      return merge ? rows.get(merge.s.r)?.get(merge.s.c) : direct;
    };
    let schema = null, context = {}, supported = false;
    for (const rowIndex of [...rows.keys()].sort((a, b) => a - b)) {
      const row = rows.get(rowIndex);
      const header = headerSchema(row);
      if (header) { schema = header; context = {}; supported = true; continue; }
      if (!schema) continue;
      // Initial-inspection rows are independent. Only explicit Excel merges may
      // share their trace/product/date; blanks must not borrow a previous test.
      if (schema.kind === 'initial') context = {};
      const pointCell = cellAt(rowIndex, schema.point);
      // A repeated partial header starts a new block, even where its date cell is blank.
      if (/^(?:不合格编号|不合格熔深编号|熔深编号)$/.test(norm(row.get(schema.point)?.v))) { context = {}; continue; }
      const dateCell = cellAt(rowIndex, schema.date);
      const date = parseDate(dateCell, { year, date1904 });
      if (date) {
        if (context.date && context.date !== date) context = {};
        context.date = date;
        if (typeof dateCell.v === 'number' && dateCell.v < 100 && /\.([123])$/.test(String(dateCell.v)) && !/\.\d\d$/.test(norm(dateCell.w))) diagnostics.ambiguousShortDates++;
      } else if (dateCell && !blank(dateCell.v) && norm(dateCell.v) !== '日期') {
        // A malformed explicit date must not inherit a preceding valid batch date.
        delete context.date;
      }
      for (const field of ['product', 'line', 'trace']) {
        const fieldCell = cellAt(rowIndex, schema[field]);
        if (fieldCell?.t === 'e') delete context[field];
        const value = cellValue(fieldCell);
        if (!blank(value)) context[field] = text(value, field === 'trace' ? 500 : 200);
      }
      const point = text(cellValue(pointCell), 100);
      if (blank(point) || /^(?:合计|总计|汇总|序号|不合格编号|不合格熔深编号|熔深编号|位置编号)$/.test(norm(point))) { diagnostics.emptyRows++; continue; }
      const findingCell = cellAt(rowIndex, schema.finding);
      const resultCell = cellAt(rowIndex, schema.judgment);
      if (schema.kind === 'feedback' && blank(cellValue(findingCell))) { diagnostics.emptyRows++; continue; }
      if (schema.kind === 'initial') {
        const photoCell = cellAt(rowIndex, schema.photo);
        const gapCell = cellAt(rowIndex, schema.gap);
        const tested = !blank(context.trace) || !blank(cellValue(resultCell)) || !blank(cellValue(findingCell)) ||
          !blank(cellValue(photoCell)) || /(?:DISPIMG|IMAGE)\s*\(/i.test(photoCell?.f || '') ||
          gapCell && !gapCell.f && !blank(cellValue(gapCell)) ||
          schema.followups.some(followup => !blank(cellValue(cellAt(rowIndex, followup.column))));
        if (!tested) { diagnostics.templateRows++; continue; }
      }
      if (!context.date) { diagnostics.unknownDate++; continue; }
      if (Number(context.date.slice(0, 4)) !== year || month !== undefined && Number(context.date.slice(5, 7)) !== month) { diagnostics.excludedOtherDates++; continue; }
      // Full-cut sheets reuse short component names across unrelated product lines.
      // Keep the source line in the identity instead of silently merging them.
      const product = context.product && context.line && norm(context.product) !== norm(context.line)
        ? `${context.line} / ${context.product}` : context.product || context.line;
      if (!product) { diagnostics.missingProduct++; continue; }
      const result = schema.kind === 'feedback' ? classifyResult(cellValue(findingCell), { feedback: true }) : classifyResult(cellValue(resultCell));
      if (result === null) diagnostics.unknownResult++;
      if (resultCell?.f && cellValue(resultCell) === undefined) diagnostics.missingFormulaResults++;
      const retests = [];
      for (const followup of schema.followups) {
        const value = cellValue(cellAt(rowIndex, followup.column));
        if (blank(value)) continue;
        retests.push({ stage: followup.stage, result: classifyResult(value, { followup: true }) });
      }
      const trace = context.trace || '', line = context.line || '';
      const identity = trace ? [category, schema.kind, context.date, product, line, trace, norm(point)] : [fileHash, sheetIndex, rowIndex];
      const key = digest(identity);
      const record = { key, date: context.date, product, category, kind: schema.kind, result, retest: retests.at(-1)?.result ?? null, retests, point, line, trace, source: { sheetIndex: sheetIndex + 1, row: rowIndex + 1 } };
      record.fingerprint = digest([record.result, record.retests]);
      const previous = recordMap.get(key);
      if (previous) {
        if (previous.fingerprint === record.fingerprint) diagnostics.duplicateRecords++;
        else {
          diagnostics.conflictingRecords++;
          previous.result = null; previous.retest = null; previous.conflict = true;
          previous.fingerprint = digest(['conflict', previous.fingerprint, record.fingerprint]);
        }
        continue;
      }
      if (!trace) diagnostics.weakIdentity++;
      if (records.length >= MAX_RECORDS) throw new Error('熔深工作簿记录超过读取上限，请拆分文件。');
      records.push(record); recordMap.set(key, record); products.add(product);
      diagnostics[schema.kind === 'feedback' ? 'feedbackRecords' : 'initialRecords']++;
    }
    if (supported) diagnostics.supportedSheets++; else diagnostics.unsupportedSheets++;
  }
  diagnostics.supportingWorkbooks = diagnostics.supportingSheets > 0 && diagnostics.supportedSheets === 0 ? 1 : 0;
  return { records, diagnostics, productNames: [...products], unit: '焊缝记录', format: zip ? 'xlsx' : 'xls' };
}

module.exports = { parsePenetrationWorkbook, classifyResult, parseDate, MAX_FILE_BYTES, PARSER_VERSION };
