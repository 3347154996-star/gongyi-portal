'use strict';

/* Local inbound-list validation only. Not a production-system import contract.
 * No filesystem, network, database, or business writes occur in this module.
 * Input: UTF-8 CSV string/Buffer/Uint8Array. XLS/XLSX are explicitly unsupported.
 * previewImport(input, { filename, maxBytes, maxRows, catalog, requireKnownCode })
 * catalog (optional): [{code,name,category:'定位销'|'伸缩气缸'}].
 * Unknown names are never categorized by fuzzy substring matching. A caller may
 * provide a verified catalog, or a CSV row may explicitly declare an allowed type.
 * UI must render returned user values as text, never interpolate unescaped HTML.
 */

const DEFAULT_LIMITS = Object.freeze({ maxBytes: 1024 * 1024, maxRows: 2000, maxColumns: 50 });
const ALLOWED_CATEGORIES = Object.freeze(['定位销', '伸缩气缸']);
const COLUMN_DEFS = Object.freeze([
  { key: 'code', label: '备件编号', required: true, aliases: ['备件编号', 'code'] },
  { key: 'name', label: '备件名称', required: true, aliases: ['备件名称', 'name'] },
  { key: 'quantity', label: '入库数量', required: true, aliases: ['入库数量', 'quantity'] },
  { key: 'location', label: '库位', required: false, aliases: ['库位', '存放位置', 'location'] },
  { key: 'remark', label: '备注', required: false, aliases: ['备注', 'remark'] },
  { key: 'category', label: '备件类型', required: false, aliases: ['备件类型', '类型', 'category'] }
]);

class CsvError extends Error {
  constructor(code, message, line) { super(message); this.code = code; this.line = line; }
}

function positiveLimit(value, fallback, maximum) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function hasFormulaRisk(value) {
  // Excel may ignore leading whitespace/zero-width markers before a formula.
  const raw = String(value == null ? '' : value);
  return /^[\t\r\n]/.test(raw) || /^[=+\-@]/.test(raw.replace(/^[\s\uFEFF\u200B-\u200D]+/, ''));
}

function parseCsv(input, options = {}) {
  const maxRecords = options.maxRecords || DEFAULT_LIMITS.maxRows + 1;
  const maxColumns = options.maxColumns || DEFAULT_LIMITS.maxColumns;
  const records = [];
  let cells = [], value = '', quoted = false, closed = false;
  let line = 1, recordLine = 1, totalRecords = 0;
  function cell() {
    cells.push(value); value = ''; closed = false;
    if (cells.length > maxColumns) throw new CsvError('too_many_columns', `列数不能超过 ${maxColumns} 列。`, recordLine);
  }
  function record() {
    cell();
    if (cells.some(item => item.trim() !== '')) {
      totalRecords++;
      if (records.length < maxRecords) records.push({ cells, line: recordLine });
    }
    cells = [];
  }
  for (let i = 0; i < input.length; i++) {
    const character = input[i];
    if (quoted) {
      if (character === '"') {
        if (input[i + 1] === '"') { value += '"'; i++; }
        else { quoted = false; closed = true; }
      } else if (character === '\r' || character === '\n') {
        if (character === '\r' && input[i + 1] === '\n') i++;
        value += '\n'; line++;
      } else value += character;
      continue;
    }
    if (character === ',') { cell(); continue; }
    if (character === '\r' || character === '\n') {
      record();
      if (character === '\r' && input[i + 1] === '\n') i++;
      line++; recordLine = line; continue;
    }
    if (closed) {
      if (character === ' ' || character === '\t') continue;
      throw new CsvError('invalid_csv', '结束引号后只能是分隔符或换行。', line);
    }
    if (character === '"') {
      if (value.length) throw new CsvError('invalid_csv', '字段中的双引号需要使用 CSV 引号转义。', line);
      quoted = true;
    } else value += character;
  }
  if (quoted) throw new CsvError('invalid_csv', '存在未闭合的双引号。', recordLine);
  if (value.length || cells.length || closed) record();
  return { records, totalRecords };
}

function classifyItem(values, options = {}) {
  const explicit = values.category || '';
  if (explicit && !ALLOWED_CATEGORIES.includes(explicit)) return { category: null, source: null, error: 'unsupported_category' };
  const exactName = ALLOWED_CATEGORIES.includes(values.name) ? values.name : null;
  const catalog = Array.isArray(options.catalog) ? options.catalog : [];
  const matches = catalog.filter(item => String(item.code).trim() === values.code);
  if (matches.length > 1) return { category: null, source: null, error: 'ambiguous_catalog' };
  if (matches.length === 1) {
    const category = String(matches[0].category || '').trim();
    if (!ALLOWED_CATEGORIES.includes(category)) return { category: null, source: 'catalog', error: 'unsupported_category' };
    if ((explicit && explicit !== category) || (exactName && exactName !== category)) return { category: null, source: 'catalog', error: 'category_conflict' };
    if (matches[0].name && String(matches[0].name).trim() !== values.name) return { category, source: 'catalog', error: 'catalog_name_mismatch' };
    return { category, source: 'catalog', error: null };
  }
  if (options.requireKnownCode) return { category: null, source: null, error: 'unknown_code' };
  if (explicit && exactName && explicit !== exactName) return { category: null, source: null, error: 'category_conflict' };
  if (explicit) return { category: explicit, source: 'explicit_column', error: null };
  if (exactName) return { category: exactName, source: 'exact_name', error: null };
  return { category: null, source: null, error: 'unknown_category' };
}

function previewImport(input, options = {}) {
  const limits = {
    maxBytes: positiveLimit(options.maxBytes, DEFAULT_LIMITS.maxBytes, 10 * 1024 * 1024),
    maxRows: positiveLimit(options.maxRows, DEFAULT_LIMITS.maxRows, 10000),
    maxColumns: positiveLimit(options.maxColumns, DEFAULT_LIMITS.maxColumns, 100)
  };
  const result = { columns: [], rows: [], errors: [], warnings: [], valid: false, totalRows: 0,
    validRows: 0, previewOnly: true, supportedFormats: ['csv'], limits };
  const issue = (row, column, code, message) => ({ row, column, code, message });
  function fail(code, message, row = null) { result.errors.push(issue(row, null, code, message)); return result; }
  if (options.filename && !/\.csv$/i.test(String(options.filename))) return fail('unsupported_file_type', '当前仅支持 CSV UTF-8 入库清单预览；不支持 XLS/XLSX，也不是原系统模板导入。');
  let content;
  const isBytes = Buffer.isBuffer(input) || input instanceof Uint8Array;
  if (!isBytes && typeof input !== 'string') return fail('invalid_input', '请提供 CSV 文件内容。');
  const bytes = isBytes ? input.byteLength : Buffer.byteLength(input, 'utf8');
  if (bytes > limits.maxBytes) return fail('file_too_large', `文件不能超过 ${limits.maxBytes} 字节。`);
  if (isBytes) {
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(input); }
    catch (_) { return fail('invalid_encoding', '文件需要为 UTF-8 编码，请在 Excel 中另存为 CSV UTF-8。'); }
  } else content = input;
  content = content.replace(/^\uFEFF/, '');
  if (content.startsWith('PK\u0003\u0004')) return fail('unsupported_file_type', '检测到压缩工作簿内容，请另存为 CSV UTF-8；不能只改文件扩展名。');
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(content)) return fail('invalid_control_character', '文件包含不支持的控制字符或二进制内容。');
  let parsed;
  try { parsed = parseCsv(content, { maxRecords: limits.maxRows + 1, maxColumns: limits.maxColumns }); }
  catch (error) { return fail(error.code || 'invalid_csv', error.message, error.line || null); }
  if (!parsed.totalRecords) return fail('empty_file', '文件没有表头或数据。');
  result.totalRows = parsed.totalRecords - 1;
  if (result.totalRows > limits.maxRows) return fail('too_many_rows', `数据行不能超过 ${limits.maxRows} 行。`);
  const header = parsed.records[0], seenHeaders = new Set(), seenKeys = new Set();
  result.columns = header.cells.map((raw, index) => {
    const label = raw.trim(), definition = COLUMN_DEFS.find(item => item.aliases.includes(label));
    if (hasFormulaRisk(raw)) result.errors.push(issue(header.line, label || `第${index + 1}列`, 'formula_cell', '表头含有公式风险字符。'));
    if (!label) result.errors.push(issue(header.line, `第${index + 1}列`, 'empty_header', '表头不能为空。'));
    if (seenHeaders.has(label) || (definition && seenKeys.has(definition.key))) result.errors.push(issue(header.line, label, 'duplicate_column', '出现重复列或映射到同一字段的列。'));
    seenHeaders.add(label);
    if (definition) seenKeys.add(definition.key);
    else result.warnings.push(issue(header.line, label, 'unknown_column', '该列不参与入库清单校验，但仍检查公式风险。'));
    return { key: definition ? definition.key : null, label, index, required: Boolean(definition && definition.required) };
  });
  for (const definition of COLUMN_DEFS.filter(item => item.required)) {
    if (!seenKeys.has(definition.key)) result.errors.push(issue(header.line, definition.label, 'missing_column', `缺少必需列：${definition.label}。`));
  }
  if (!result.totalRows) return fail('no_data_rows', '表头下方没有数据行。');
  const seenRows = new Map(), seenCodes = new Map();
  for (const record of parsed.records.slice(1)) {
    const values = Object.fromEntries(COLUMN_DEFS.map(item => [item.key, '']));
    const output = { rowNumber: record.line, values, category: null, categorySource: null, valid: false, errors: [], warnings: [] };
    function rowError(column, code, message) {
      const item = issue(record.line, column, code, message); output.errors.push(item); result.errors.push(item);
    }
    function rowWarning(column, code, message) {
      const item = issue(record.line, column, code, message); output.warnings.push(item); result.warnings.push(item);
    }
    if (record.cells.length !== header.cells.length) rowError(null, 'column_count_mismatch', '数据列数与表头不一致，请检查逗号和引号。');
    record.cells.forEach((raw, index) => {
      const column = result.columns[index];
      if (hasFormulaRisk(raw)) rowError(column ? column.label : `第${index + 1}列`, 'formula_cell', '检测到公式风险内容；请改成普通文本后重新上传。');
      if (column && column.key) values[column.key] = raw.trim();
    });
    if (!values.code) rowError('备件编号', 'missing_code', '备件编号不能为空。');
    if (!values.name) rowError('备件名称', 'missing_name', '备件名称不能为空。');
    const quantityValid = /^\d+$/.test(values.quantity) && Number.isSafeInteger(Number(values.quantity)) && Number(values.quantity) > 0;
    if (!quantityValid) rowError('入库数量', 'invalid_quantity', '入库数量必须是正整数，不接受小数、科学计数或表达式。');
    output.rawValues = { ...values };
    const category = classifyItem(values, options);
    output.category = category.category; output.categorySource = category.source;
    const categoryMessages = {
      unsupported_category: '仅支持定位销和伸缩气缸，其他类型不能预览为有效入库行。',
      ambiguous_catalog: '已核对清单中同一编号对应多条记录，需先确认。',
      category_conflict: '名称、类型或已核对清单的分类相互冲突。',
      catalog_name_mismatch: '名称与该编号对应的已核对清单不一致。',
      unknown_code: '该编号不在已核对清单中，不能自动匹配。',
      unknown_category: '无法确认物品类型。请填写明确的备件类型，或先完成编号与台账的核对。'
    };
    if (category.error) rowError('备件类型', category.error, categoryMessages[category.error]);
    const identity = JSON.stringify([values.code, values.name, quantityValid ? Number(values.quantity) : values.quantity, values.location, values.remark, category.category || values.category]);
    if (seenRows.has(identity)) {
      const first = seenRows.get(identity);
      rowError(null, 'duplicate_row', `与文件第 ${first.rowNumber} 行重复，不能自动合并或重复入库。`);
      if (!first.errors.some(error => error.code === 'duplicate_row')) {
        const error = issue(first.rowNumber, null, 'duplicate_row', '该行在文件中重复出现，请核对后保留正确记录。');
        first.errors.push(error); result.errors.push(error); first.valid = false;
      }
    } else seenRows.set(identity, output);
    if (values.code && seenCodes.has(values.code) && !output.errors.some(error => error.code === 'duplicate_row')) rowWarning('备件编号', 'repeated_code', '同一编号出现多行，请确认不是重复入库；模块不会自动合并数量。');
    else if (values.code) seenCodes.set(values.code, output);
    values.quantity = quantityValid ? Number(values.quantity) : null;
    output.valid = output.errors.length === 0;
    result.rows.push(output);
  }
  result.validRows = result.rows.filter(row => row.valid).length;
  result.valid = result.errors.length === 0 && result.totalRows > 0;
  result.warnings.push(issue(null, null, 'preview_only', '此结果仅为入库清单本地校验与预览；未写入生产系统，也未验证原系统模板导入契约。'));
  return result;
}

module.exports = { DEFAULT_LIMITS, ALLOWED_CATEGORIES, COLUMN_DEFS, hasFormulaRisk, parseCsv, classifyItem,
  previewImport, previewCsv: previewImport, validateImportPreview: previewImport };
