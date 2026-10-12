'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSparesReport, stockNumber, classifyStock } = require('../lib/spares-report.cjs');

// All spare names, numbers and quantities are synthetic fixtures.
const row = (values = {}) => ({ bjbh: 'SYN-PIN', bjmc: '示例定位销', nowStock: 5, minStock: 3, maxStock: 10, ...values });

test('safe stock parser rejects coercion and missing values while keeping valid signed decimals', () => {
  for (const value of [null, undefined, '', ' ', true, false, [], [1], {}, NaN, Infinity, 'NaN', 'Infinity', '0x10', '1,000', '12件', '1e3', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(stockNumber(value), null, `invalid input type ${typeof value}`);
  }
  assert.equal(stockNumber(' 0 '), 0);
  assert.equal(stockNumber('-2.5'), -2.5);
  assert.equal(stockNumber('+4.0'), 4);
  assert.equal(stockNumber('.5'), 0.5);
  assert.equal(stockNumber(0.25), 0.25);
});

test('stock state boundaries distinguish missing lower limits from confirmed normal', () => {
  assert.equal(classifyStock(row({ nowStock: 0, minStock: null }))._stockStatus, 'out');
  assert.equal(classifyStock(row({ nowStock: -1 }))._stockStatus, 'out');
  assert.equal(classifyStock(row({ nowStock: 2 }))._stockStatus, 'low');
  assert.equal(classifyStock(row({ nowStock: 3 }))._stockStatus, 'normal');
  assert.equal(classifyStock(row({ nowStock: 5, minStock: 0 }))._stockStatus, 'normal');
  assert.equal(classifyStock(row({ nowStock: 5, minStock: '' }))._stockStatus, 'unknown');
  assert.equal(classifyStock(row({ nowStock: 5, minStock: -1 }))._stockStatus, 'unknown');
  assert.equal(classifyStock(row({ nowStock: null }))._stockStatus, 'unknown');
  assert.equal(classifyStock(row({ maxStock: null }))._stockStatus, 'normal');
});

test('gap requires valid quantity and minimum and keeps negative-stock deficit', () => {
  assert.equal(classifyStock(row({ nowStock: -2, minStock: 3 }))._stockGap, 5);
  assert.equal(classifyStock(row({ nowStock: 2, minStock: 3 }))._stockGap, 1);
  assert.equal(classifyStock(row({ nowStock: 5, minStock: 3 }))._stockGap, 0);
  assert.equal(classifyStock(row({ nowStock: null }))._stockGap, null);
  assert.equal(classifyStock(row({ minStock: null }))._stockGap, null);
  assert.equal(classifyStock(row({ maxStock: -1 }))._stockMax, null);
});

test('only explicitly named target categories are included and duplicate records stay visible', () => {
  const rows = [row(), row(), row({ bjmc: '示例伸缩气缸' }), row({ bjmc: '普通气缸', sparepartName: '伸缩气缸' }), row({ bjmc: '示例螺栓' }), row({ bjmc: '' })];
  const result = buildSparesReport(rows);
  assert.equal(result.overview.total, 3);
  assert.equal(result.options.categories.find(item => item.value === 'pin').count, 2);
  assert.equal(result.options.categories.find(item => item.value === 'cylinder').count, 1);
  assert.equal(result.diagnostics.excludedCategoryRows, 3);
  assert.equal(result.cards.length, 3);
});

test('default sort puts out and low stock first, then unknown and normal, preserving name tie order', () => {
  const rows = [row({ bjbh: 'normal', nowStock: 7 }), row({ bjbh: 'unknown', minStock: '' }),
    row({ bjbh: 'low', nowStock: 1 }), row({ bjbh: 'out-a', nowStock: 0 }), row({ bjbh: 'out-b', nowStock: -1 })];
  const result = buildSparesReport(rows);
  assert.deepEqual(result.filteredRows.map(item => item.bjbh), ['out-a', 'out-b', 'low', 'unknown', 'normal']);
  assert.deepEqual(result.overview, { total: 5, outCount: 2, lowCount: 1, normalCount: 1, unknownCount: 1 });
  assert.equal(result.overview.total, result.overview.outCount + result.overview.lowCount + result.overview.normalCount + result.overview.unknownCount);
});

test('category, keyword and stock filters apply identically to cards and detail while menu counts keep alternatives', () => {
  const rows = [row({ bjbh: 'SYN-A', bjmc: '示例定位销A', nowStock: 0 }), row({ bjbh: 'SYN-B', bjmc: '示例定位销B', nowStock: 1 }),
    row({ bjbh: 'SYN-C', bjmc: '示例伸缩气缸', nowStock: 1 }), row({ bjbh: 'OTHER', nowStock: 1 })];
  const result = buildSparesReport(rows, { category: 'pin', keyword: 'syn-', stock: 'low' });
  assert.equal(result.overview.total, 1);
  assert.equal(result.overview.lowCount, 1);
  assert.deepEqual(result.cards, result.filteredRows);
  assert.deepEqual(result.filteredRows.map(item => item.bjbh), ['SYN-B']);
  assert.equal(result.options.stocks.find(item => item.value === 'out').count, 1);
  assert.equal(result.options.stocks.find(item => item.value === 'all').count, 2);
  assert.equal(result.options.categories.find(item => item.value === 'all').count, 3);
  assert.equal(result.options.categories.find(item => item.value === 'cylinder').count, 1);
});

test('augmented row fields preserve source values and never mutate originals', () => {
  const rows = [row({ nowStock: '2', minStock: '3.5', maxStock: '', location: '示例库位', specifications: '示例规格' })];
  const before = JSON.stringify(rows);
  const result = buildSparesReport(rows);
  const card = result.cards[0];
  assert.equal(card.nowStock, '2');
  assert.equal(card._stockQuantity, 2);
  assert.equal(card._stockMin, 3.5);
  assert.equal(card._stockMax, null);
  assert.equal(card._stockGap, 1.5);
  assert.equal(card._stockStatus, 'low');
  assert.equal(card._stockStatusLabel, '低库存');
  assert.equal(card.location, '示例库位');
  assert.equal(rows[0]._stockStatus, undefined);
  assert.equal(JSON.stringify(rows), before);
});

test('uncertain numeric fields stay null with diagnostics and quantities are never added across parts', () => {
  const result = buildSparesReport([row({ nowStock: '2件', minStock: ' ' }), row({ bjmc: '示例伸缩气缸', minStock: 6, maxStock: 4 })]);
  assert.equal(result.overview.unknownCount, 1);
  assert.equal(result.overview.lowCount, 1);
  assert.equal(result.diagnostics.missingOrInvalidQuantityRows, 1);
  assert.equal(result.diagnostics.missingOrInvalidMinRows, 1);
  assert.equal(result.diagnostics.conflictingBoundsRows, 1);
  assert.equal(Object.hasOwn(result.overview, 'quantity'), false);
  assert.ok(result.notes.some(note => note.includes('不适合简单相加')));
});

test('overlapping explicit category names are counted once in total and remain selectable in either category', () => {
  const rows = [row({ bjmc: '示例定位销伸缩气缸组件' })];
  const all = buildSparesReport(rows);
  assert.equal(all.overview.total, 1);
  assert.equal(all.diagnostics.overlappingCategoryRows, 1);
  assert.equal(buildSparesReport(rows, { category: 'pin' }).overview.total, 1);
  assert.equal(buildSparesReport(rows, { category: 'cylinder' }).overview.total, 1);
});

test('empty results retain full filter options and reject invalid filter names', () => {
  const result = buildSparesReport([]);
  assert.equal(result.overview.total, 0);
  assert.equal(result.options.categories.length, 3);
  assert.equal(result.options.stocks.length, 5);
  assert.deepEqual(result.cards, []);
  assert.throws(() => buildSparesReport([], { category: 'unknown' }), /category/);
  assert.throws(() => buildSparesReport([], { stock: 'bad' }), /stock filter/);
  assert.throws(() => buildSparesReport(null), /array/);
});
