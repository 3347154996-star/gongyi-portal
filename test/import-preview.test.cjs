'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { previewImport, parseCsv, hasFormulaRisk } = require('../lib/import-preview.cjs');
const header = '备件编号,备件名称,入库数量,库位,备注';
const validRow = 'DEMO-01,定位销,3,示例A,普通备注';

test('UTF-8 BOM, CRLF, quoted commas and escaped quotes produce a local-only preview', () => {
  const csv = '\uFEFF' + header + '\r\nDEMO-01,定位销,3,示例A,"备注,含""引号"""\r\n';
  const result = previewImport(Buffer.from(csv), { filename: '示例.CSV' });
  assert.equal(result.valid, true);
  assert.equal(result.totalRows, 1);
  assert.equal(result.rows[0].values.quantity, 3);
  assert.equal(result.rows[0].values.remark, '备注,含"引号"');
  assert.equal(result.rows[0].category, '定位销');
  assert.equal(result.previewOnly, true);
  assert.ok(result.warnings.some(item => item.code === 'preview_only'));
});

test('quoted multiline fields maintain physical source row numbers', () => {
  const result = previewImport(header + '\nDEMO-01,定位销,1,A,"第一段\n第二段"\nDEMO-02,伸缩气缸,2,B,');
  assert.equal(result.valid, true);
  assert.equal(result.rows[0].values.remark, '第一段\n第二段');
  assert.equal(result.rows[1].rowNumber, 4);
  assert.equal(result.totalRows, 2);
});

test('empty code/name and non-positive/noninteger quantities fail without coercion', () => {
  for (const quantity of ['', '0', '-1', '1.2', '1e3', '1+2', '9007199254740992']) {
    const result = previewImport(header + '\n,,' + quantity + ',示例A,');
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(item => item.code === 'missing_code'));
    assert.ok(result.errors.some(item => item.code === 'missing_name'));
    assert.ok(result.errors.some(item => item.code === 'invalid_quantity'));
  }
});

test('unknown or substring-only types are not automatically classified', () => {
  for (const name of ['定位销支架', '普通气缸', '未知零件']) {
    const result = previewImport(header + `\nDEMO-01,${name},1,A,`);
    assert.equal(result.valid, false);
    assert.equal(result.rows[0].category, null);
    assert.ok(result.errors.some(item => item.code === 'unknown_category'));
  }
  const explicit = previewImport(header + ',备件类型\nDEMO-01,示例型号X,1,A,,伸缩气缸');
  assert.equal(explicit.valid, true);
  assert.equal(explicit.rows[0].categorySource, 'explicit_column');
  const conflict = previewImport(header + ',备件类型\nDEMO-01,定位销,1,A,,伸缩气缸');
  assert.ok(conflict.errors.some(item => item.code === 'category_conflict'));
});

test('verified catalog can resolve exact codes and rejects conflicts or unknown required codes', () => {
  const catalog = [{ code: 'DEMO-01', name: '示例型号X', category: '定位销' }];
  const result = previewImport(header + '\nDEMO-01,示例型号X,1,A,', { catalog, requireKnownCode: true });
  assert.equal(result.valid, true);
  assert.equal(result.rows[0].categorySource, 'catalog');
  assert.ok(previewImport(header + '\nDEMO-02,定位销,1,A,', { catalog, requireKnownCode: true }).errors.some(item => item.code === 'unknown_code'));
  assert.ok(previewImport(header + '\nDEMO-01,其他名称,1,A,', { catalog }).errors.some(item => item.code === 'catalog_name_mismatch'));
});

test('duplicate rows invalidate both copies; repeated code with distinct contents warns without merging', () => {
  const duplicate = previewImport(header + '\n' + validRow + '\n' + validRow.replace(',3,', ',03,'));
  assert.equal(duplicate.valid, false);
  assert.equal(duplicate.validRows, 0);
  assert.ok(duplicate.rows.every(row => row.errors.some(item => item.code === 'duplicate_row')));
  const repeated = previewImport(header + '\n' + validRow + '\n' + validRow.replace(',3,', ',2,'));
  assert.equal(repeated.valid, true);
  assert.equal(repeated.rows.length, 2);
  assert.ok(repeated.warnings.some(item => item.code === 'repeated_code'));
});

test('formula-like cells fail even when quoted, whitespace-prefixed or in an ignored extra column', () => {
  for (const formula of ['=1+1', '+1', '-1', '@SUM(A1)', '  =1+1', '\ttext', '\u200B=1']) assert.equal(hasFormulaRisk(formula), true);
  const result = previewImport(header + ',额外列\nDEMO-01,定位销,1,A,普通备注," =1+1"');
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(item => item.code === 'formula_cell'));
  assert.ok(result.warnings.some(item => item.code === 'unknown_column'));
});

test('required/duplicate headers and row width are explicit errors', () => {
  assert.ok(previewImport('备件编号,备件名称\nD,定位销').errors.some(item => item.code === 'missing_column'));
  assert.ok(previewImport('备件编号,备件名称,入库数量,quantity\nD,定位销,1,1').errors.some(item => item.code === 'duplicate_column'));
  assert.ok(previewImport(header + '\nD,定位销,1').errors.some(item => item.code === 'column_count_mismatch'));
});

test('byte limit, row limit and format checks reject before business preview', () => {
  assert.ok(previewImport(header + '\n' + validRow, { maxBytes: 10 }).errors.some(item => item.code === 'file_too_large'));
  const overRows = previewImport(header + '\n' + validRow + '\n' + validRow + '\n' + validRow, { maxRows: 1 });
  assert.equal(overRows.totalRows, 3);
  assert.equal(overRows.rows.length, 0);
  assert.ok(overRows.errors.some(item => item.code === 'too_many_rows'));
  assert.ok(previewImport('anything', { filename: 'input.xlsx' }).errors.some(item => item.code === 'unsupported_file_type'));
  assert.ok(previewImport('PK\x03\x04binary', { filename: 'input.csv' }).errors.some(item => item.code === 'unsupported_file_type'));
  assert.ok(previewImport(Buffer.from([0xff, 0xfe, 0x80]), { filename: 'input.csv' }).errors.some(item => item.code === 'invalid_encoding'));
});

test('malformed quoting, empty files, binary controls and excess columns fail clearly', () => {
  for (const csv of [header + '\nD,"定位销,1,A,', header + '\nD,定"位销,1,A,', header + '\nD,"定位销"bad,1,A,']) {
    assert.ok(previewImport(csv).errors.some(item => item.code === 'invalid_csv'));
  }
  assert.ok(previewImport('\n\n').errors.some(item => item.code === 'empty_file'));
  assert.ok(previewImport(header).errors.some(item => item.code === 'no_data_rows'));
  assert.ok(previewImport(header + '\nD,定位销,1,A,\x00').errors.some(item => item.code === 'invalid_control_character'));
  assert.ok(previewImport(header, { maxColumns: 2 }).errors.some(item => item.code === 'too_many_columns'));
  assert.deepEqual(parseCsv('a,b\n\n1,2\n').records.map(record => record.line), [1, 3]);
});
