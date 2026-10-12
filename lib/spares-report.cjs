'use strict';

const STOCK_STATUS = Object.freeze({ out: '缺货', low: '低库存', unknown: '待核实', normal: '正常' });
const STOCK_ORDER = Object.freeze({ out: 0, low: 1, unknown: 2, normal: 3 });
const CATEGORIES = Object.freeze({ pin: '定位销', cylinder: '伸缩气缸' });
const text = value => value == null ? '' : String(value).trim();

// Reject missing values, coercible objects/booleans, units, hex and non-finite numbers.
// Decimal quantities are retained because source units may differ by spare part.
function stockNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return null;
  const number = Number(typeof value === 'string' ? value.trim() : value);
  return Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER ? number : null;
}

function classifyStock(row) {
  const quantity = stockNumber(row.nowStock);
  const parsedMin = stockNumber(row.minStock), parsedMax = stockNumber(row.maxStock);
  const min = parsedMin !== null && parsedMin >= 0 ? parsedMin : null;
  const max = parsedMax !== null && parsedMax >= 0 ? parsedMax : null;
  const status = quantity === null ? 'unknown' : quantity <= 0 ? 'out' : min === null ? 'unknown' : quantity < min ? 'low' : 'normal';
  return {
    _stockStatus: status, _stockStatusLabel: STOCK_STATUS[status],
    _stockQuantity: quantity, _stockMin: min, _stockMax: max,
    _stockGap: quantity !== null && min !== null ? Math.max(0, min - quantity) : null
  };
}

/**
 * Pure inventory snapshot summary. Only names explicitly containing the two
 * configured category labels are included. No quantity totals across unlike
 * spare parts or units are calculated. Input records are never mutated.
 */
function buildSparesReport(rows, settings = {}) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  const selected = { category: settings.category || 'all', keyword: text(settings.keyword), stock: settings.stock || 'all' };
  if (!['all', ...Object.keys(CATEGORIES)].includes(selected.category)) throw new RangeError('Invalid spare category');
  if (!['all', ...Object.keys(STOCK_STATUS)].includes(selected.stock)) throw new RangeError('Invalid stock filter');
  const prepared = rows.map((input, index) => {
    const raw = input && typeof input === 'object' ? input : {};
    const name = text(raw.bjmc);
    const categories = Object.entries(CATEGORIES).filter(([, label]) => name.includes(label)).map(([category]) => category);
    return { raw, index, name, categories, item: { ...raw, ...classifyStock(raw) } };
  }).filter(row => row.categories.length);
  const keyword = selected.keyword.toLowerCase();
  const keywordRows = prepared.filter(row => !keyword || Object.values(row.raw).some(value => text(value).toLowerCase().includes(keyword)));
  const categoryRows = keywordRows.filter(row => selected.category === 'all' || row.categories.includes(selected.category));
  const filtered = categoryRows.filter(row => selected.stock === 'all' || row.item._stockStatus === selected.stock)
    .sort((a, b) => STOCK_ORDER[a.item._stockStatus] - STOCK_ORDER[b.item._stockStatus] || a.name.localeCompare(b.name, 'zh-CN') || a.index - b.index);
  const countStatus = (values, status) => values.filter(row => row.item._stockStatus === status).length;
  const cards = filtered.map(row => row.item);
  return {
    selected,
    overview: { total: filtered.length, outCount: countStatus(filtered, 'out'), lowCount: countStatus(filtered, 'low'),
      normalCount: countStatus(filtered, 'normal'), unknownCount: countStatus(filtered, 'unknown') },
    cards, filteredRows: cards,
    options: {
      categories: [{ value: 'all', label: '全部备件', count: keywordRows.length },
        ...Object.entries(CATEGORIES).map(([value, label]) => ({ value, label, count: keywordRows.filter(row => row.categories.includes(value)).length }))],
      stocks: [{ value: 'all', label: '全部库存状态', count: categoryRows.length },
        ...Object.entries(STOCK_STATUS).map(([value, label]) => ({ value, label, count: countStatus(categoryRows, value) }))]
    },
    diagnostics: {
      inputRows: rows.length, recognizedCategoryRows: prepared.length, excludedCategoryRows: rows.length - prepared.length,
      overlappingCategoryRows: prepared.filter(row => row.categories.length > 1).length,
      missingOrInvalidQuantityRows: filtered.filter(row => row.item._stockQuantity === null).length,
      missingOrInvalidMinRows: filtered.filter(row => row.item._stockMin === null).length,
      missingOrInvalidMaxRows: filtered.filter(row => row.item._stockMax === null).length,
      conflictingBoundsRows: filtered.filter(row => row.item._stockMin !== null && row.item._stockMax !== null && row.item._stockMax < row.item._stockMin).length
    },
    notes: [
      '仅展示名称明确包含定位销或伸缩气缸的备件，类别按原始名称判断。',
      '缺货为当前库存小于或等于0；低库存为库存大于0且低于最小库存。库存或必要下限缺失时标为待核实。',
      '正常仅表示库存已达到已知的最小库存；最大库存用于展示，不用于本次缺货判断。',
      '缺口为达到最小库存所差数量，库存与最小库存均有效时才计算。',
      '数量可能属于不同规格或计量单位，不适合简单相加；汇总卡统计备件记录条数。',
      '这是传入数据的库存快照；源系统未完整返回的数据不在本次汇总内。'
    ]
  };
}

module.exports = { buildSparesReport, stockNumber, classifyStock, STOCK_STATUS, CATEGORIES };
