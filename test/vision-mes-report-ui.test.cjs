'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const user = { authenticated: true, account: 'synthetic-reader', role: 'member' };
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const catalog = { defaultLineId: 'B', lines: [{ id: 'A', code: 'A01', name: '合成线 A' }, { id: 'B', code: 'B01', name: '合成线 B' }] };
const records = [{ recordId: 'R2', barcode: 'SAME-PART', measuredAt: '2026-10-16 19:34:00', partName: '合成件', deviceName: '合成检具', result: 'OK' }, { recordId: 'R1', barcode: 'SAME-PART', measuredAt: '2026-10-16 17:46:00', partName: '合成件', deviceName: '合成检具', result: 'NG' }];
function report(url, extra = {}) { const filters = Object.fromEntries(new URL(url, 'http://localhost').searchParams); return { action: 'report', line: { id: filters.lineId, name: '合成线 ' + filters.lineId }, records: records.map(item => ({ ...item })), summary: { total: 2, ok: 1, ng: 1, unknown: 0, denominator: 2, passRate: 50 }, coverage: { complete: true, eligibleForLineRate: true, mode: filters.queryMode === 'count' ? 'recent' : 'range', sourceTotal: 2, readRows: 2, note: '已按所选方式查询。', firstMeasuredAt: records[1].measuredAt, lastMeasuredAt: records[0].measuredAt }, filters: { ...filters, start: filters.start ? filters.start.replace('T', ' ') + ':00' : '2000-01-01 00:00:00', end: filters.end ? filters.end.replace('T', ' ') + ':00' : '2026-10-16 20:00:00' }, fetchedAt: '2026-10-16T12:00:00Z', warnings: [], ...extra }; }
const detail = (recordId = 'R2') => ({ recordId, barcode: 'SAME-PART', measuredAt: recordId === 'R2' ? '2026-10-16 19:34:00' : '2026-10-16 17:46:00', lineName: '合成线 B', deviceName: '合成检具', processName: '合成工序', partName: '合成物料', sourceResult: recordId === 'R2' ? 'OK' : 'NG', measurements: [{ name: 'P1', actual: 0.2, lowerLimit: -1, upperLimit: 1, result: 'OK' }, { name: 'P2', actual: 1.5, lowerLimit: -1, upperLimit: 1, result: 'NG' }, { name: 'P3', actual: null, actualRaw: '无数值', result: null, resultRaw: '未知来源' }], warnings: ['测点与整件结论分别保留。'] });
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function fixture(fetcher, options = {}) {
  const nodes = new Map(), requests = [], events = [], timers = new Map(), htmlWrites = [], documentHandlers = new Map(); let timerId = 0;
  const stored = options.stored || new Map(), reportCalls = [], filterCalls = [], materialCalls = []; let reportIsOpen = false;
  class Node {
    constructor(tag = 'div', id = '') { this.tagName = tag; this.id = id; this.children = []; this.attributes = {}; this.handlers = new Map(); this.value = ''; this.hidden = false; this.disabled = false; this.open = false; this.checked = false; this.dataset = {}; this.style = {}; this._text = ''; this._html = ''; this.clientWidth = 1000; this.clientHeight = 260; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set innerHTML(value) { this._html = value; htmlWrites.push(value); for (const match of value.matchAll(/\bid="([^"]+)"/g)) node(match[1]); }
    get innerHTML() { return this._html; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    removeAttribute(key) { delete this.attributes[key]; }
    append(...items) { this.children.push(...items); for (const item of items) if (item.id) nodes.set(item.id, item); }
    prepend(...items) { this.children.unshift(...items); for (const item of items) if (item.id) nodes.set(item.id, item); }
    replaceChildren(...items) { this._text = ''; this.children = [...items]; }
    querySelector(selector) { if (selector === '.mes-report-presets') return node('preset-group'); if (selector === 'svg') return node('chart-svg'); return null; }
    querySelectorAll(selector) { return selector === '[data-mes-period]' ? ['today', 'week', 'month'].map(period => { const item = node('period-' + period); item.dataset.mesPeriod = period; return item; }) : []; }
    addEventListener(type, handler) { this.handlers.set(type, handler); }
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
    showModal() { this.open = true; }
    close() { this.open = false; }
  }
  function node(id) { if (!nodes.has(id)) nodes.set(id, new Node('div', id)); return nodes.get(id); }
  node('visionWorkbench'); node('mesVisionWorkbench');
  const context = vm.createContext({
    document: { body: node('body'), hidden: false, getElementById: node, createElement: tag => new Node(tag), addEventListener: (type, handler) => documentHandlers.set(type, handler), dispatchEvent: event => events.push(event.type) },
    window: { addEventListener() {}, dispatchEvent: event => events.push(event.type), PortalWorkbench: { sourceStamp: value => value + ' 北京时间' }, sessionStorage: { getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) }, PortalPreferences: { get: () => options.preferences || {} }, PortalReport: { canOpen: input => Boolean(input.report?.coverage?.complete && input.report?.records.length), isOpen: () => reportIsOpen, open: input => { reportCalls.push(input); reportIsOpen = true; documentHandlers.get('portal:report-open')?.({ detail: { kind: input.kind } }); } } },
    AbortController, URLSearchParams, Event: class { constructor(type) { this.type = type; } }, CustomEvent: class { constructor(type) { this.type = type; } },
    setTimeout: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => { requests.push({ url, options }); return fetcher ? fetcher(url, options) : response(url.endsWith('/catalog') ? catalog : url.includes('/detail?') ? detail(new URL(url, 'http://localhost').searchParams.get('recordId')) : report(url)); },
  });
  if (options.sharedFilters) {
    const realFilters = require('../public/shared-filter.js');
    context.window.PortalFilters = { ...realFilters, mountDateRange(config) { filterCalls.push(config); return { weekControls: node('week-controls'), reset(period) { const dates = realFilters.range(period); config.start.value = dates.start + 'T00:00'; config.end.value = dates.end + 'T23:59'; config.mode.value = period; }, sync() { config.mode.value = realFilters.infer(config.start.value.slice(0, 10), config.end.value.slice(0, 10)); } }; }, enhanceMaterialSelect(select) { materialCalls.push(select.id); return { clear() { materialCalls.push('clear'); }, refresh() { materialCalls.push('refresh'); } }; } };
  }
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/vision-mes-report.js'), 'utf8'), context);
  const api = context.window.MesVisionReportWorkbench;
  const fire = (id, type, extra = {}) => node(id).handlers.get(type)?.({ preventDefault() {}, ...extra });
  const settle = async () => { for (let index = 0; index < 5; index++) await new Promise(setImmediate); };
  const start = async () => { api.setContext(user, true); await settle(); };
  const submit = async () => { fire('mesReportForm', 'submit'); await settle(); };
  const closeReport = () => { reportIsOpen = false; documentHandlers.get('portal:report-close')?.({ detail: { kind: 'vision-mes' } }); };
  return { node, api, fire, requests, events, timers, htmlWrites, context, documentHandlers, settle, start, submit, stored, reportCalls, filterCalls, materialCalls, closeReport };
}

test('default company view auto-discovers lines, uses configured default and counts each retest separately', async () => {
  const f = fixture(); await f.start();
  assert.equal(f.api.isFileMode(), false); assert.equal(f.node('visionWorkbench').hidden, false);
  assert.equal(f.node('mesReportLine').value, 'B'); assert.equal(f.requests.length, 2);
  const query = new URL(f.requests[1].url, 'http://localhost').searchParams;
  assert.equal(query.get('lineId'), 'B'); assert.equal(query.get('queryMode'), 'time'); assert.equal(query.get('limit'), '0'); assert.match(query.get('start'), /T00:00$/); assert.match(query.get('end'), /T23:59$/);
  assert.equal(f.node('mesReportRows').children.length, 2); assert.equal(f.node('mesReportTotal').textContent, '2');
  assert.equal(f.node('mesReportOK').textContent, '1'); assert.equal(f.node('mesReportNG').textContent, '1'); assert.equal(f.node('mesReportRate').textContent, '50.0%');
  assert.match(f.node('mesReportScope').textContent, /时间范围内全部/);
  assert.equal(f.node('mesReportCountField').hidden, true); assert.equal(f.node('mesReportLimit').disabled, true);
  assert.match(f.node('mesReportChart').innerHTML, /mes-report-chart-dot/);
  assert.equal(f.node('mesReportTrendDetail').hidden, false);
  assert.match(f.node('mesReportTrendDetail').textContent, /合格 1 \/ 可统计 1 次/);
  for (const request of f.requests) { assert.equal(request.options.credentials, 'same-origin'); assert.equal(request.options.body, undefined); }
  f.api.setContext(user, true); await f.settle(); assert.equal(f.requests.length, 2);
});

test('time mode preserves hours and minutes and barcode, ignores hidden count and accepts normalized source dates', async () => {
  const f = fixture(); await f.start();
  f.node('mesReportStart').value = '2026-10-15T08:30'; f.node('mesReportEnd').value = '2026-10-16T17:45'; f.node('mesReportLimit').value = '100'; f.node('mesReportBarcode').value = 'SAME-PART';
  f.fire('mesReportForm', 'input'); assert.equal(f.node('mesReportDraft').hidden, false);
  await f.submit();
  const query = new URL(f.requests.at(-1).url, 'http://localhost').searchParams;
  assert.equal(query.get('start'), '2026-10-15T08:30'); assert.equal(query.get('end'), '2026-10-16T17:45'); assert.equal(query.get('barcode'), 'SAME-PART'); assert.equal(query.get('limit'), '0');
  assert.equal(f.node('mesReportError').hidden, true); assert.equal(f.node('mesReportDraft').hidden, true);
  assert.match(f.node('mesReportScope').textContent, /2026-10-15 08:30:00/);
  f.node('mesReportRangeMode').value = 'week'; f.fire('mesReportRangeMode', 'change');
  assert.equal(f.node('mesReportDraft').hidden, false); assert.equal(f.requests.length, 3);
});

test('incomplete coverage hides both the aggregate rate and the chart even if a source supplies a rate', async () => {
  const f = fixture(url => response(url.endsWith('/catalog') ? catalog : report(url, { coverage: { complete: false, eligibleForLineRate: false, note: '只取得部分记录。' } })));
  await f.start();
  assert.equal(f.node('mesReportTotalLabel').textContent, '已读取检测次数');
  assert.equal(f.node('mesReportRate').textContent, '—'); assert.equal(f.node('mesReportChart').hidden, true);
  assert.match(f.node('mesReportTrendEmpty').textContent, /未完整读取/); assert.match(f.node('mesReportCoverage').textContent, /不能用于/);
});

test('a complete single-barcode query is not mislabeled as an incomplete line report', async () => {
  const f = fixture(url => response(url.endsWith('/catalog') ? catalog : report(url, { coverage: { complete: true, eligibleForLineRate: false }, filters: { ...Object.fromEntries(new URL(url, 'http://localhost').searchParams) } })));
  await f.start();
  assert.equal(f.node('mesReportStatusTitle').textContent, '公司检测记录已读取');
  assert.equal(f.node('mesReportTotalLabel').textContent, '检测次数');
  assert.equal(f.node('mesReportRate').textContent, '—');
  assert.match(f.node('mesReportRateNote').textContent, /工件查询/);
  assert.doesNotMatch(f.node('mesReportCoverage').textContent, /未完整读取/);
});

test('record detail uses the selected report id, keeps per-point unknowns and supports only-NG filtering', async () => {
  const f = fixture(); await f.start();
  f.fire('mesReportRows', 'click', { target: { closest: () => ({ dataset: { mesRecordId: 'R1' } }) } }); await f.settle();
  assert.match(f.requests.at(-1).url, /\/detail\?recordId=R1$/); assert.equal(f.node('mesReportDetailDialog').open, true);
  assert.match(f.node('mesReportDetailMeta').textContent, /17:46:00/); assert.match(f.node('mesReportDetailIdentity').textContent, /NG/);
  assert.equal(f.node('mesReportDetailRows').children.length, 3); assert.match(f.node('mesReportDetailRows').textContent, /无数值.*未判定未知来源/);
  f.node('mesReportDetailOnlyNG').checked = true; f.fire('mesReportDetailOnlyNG', 'change'); assert.equal(f.node('mesReportDetailRows').children.length, 1);
  f.fire('mesReportDetailClose', 'click'); assert.equal(f.node('mesReportDetailDialog').open, false); assert.equal(f.node('mesReportDetailRows').children.length, 0);
});

test('automatic refresh pauses while a detail is open and resumes after closing without replacing the dialog', async () => {
  const f = fixture(); await f.start();
  const queuedRefresh = [...f.timers.values()][0].callback;
  f.fire('mesReportRows', 'click', { target: { closest: () => ({ dataset: { mesRecordId: 'R1' } }) } }); await f.settle();
  assert.equal(f.node('mesReportDetailDialog').open, true); assert.equal(f.timers.size, 0);
  assert.equal(f.node('mesReportPolling').textContent, '查看测点时暂停自动刷新');
  const requestCount = f.requests.length;
  queuedRefresh(); await f.settle();
  f.context.document.hidden = true; f.documentHandlers.get('visibilitychange')();
  f.context.document.hidden = false; f.documentHandlers.get('visibilitychange')(); await f.settle();
  assert.equal(f.requests.length, requestCount); assert.equal(f.node('mesReportDetailDialog').open, true);
  assert.match(f.node('mesReportDetailMeta').textContent, /17:46:00/);
  f.fire('mesReportDetailClose', 'click'); assert.equal(f.timers.size, 1);
  const [timerId, timer] = [...f.timers.entries()][0]; f.timers.delete(timerId); timer.callback(); await f.settle();
  assert.equal(f.requests.length, requestCount + 1); assert.match(f.requests.at(-1).url, /\/report\?/);
  assert.equal(f.node('mesReportDetailDialog').open, false);
});

test('zoned detection timestamps are displayed and charted as concise Beijing time', async () => {
  const f = fixture(url => response(url.endsWith('/catalog') ? catalog : url.includes('/detail?') ? { ...detail('R2'), measuredAt: '2026-10-16T19:34:00.000+08:00' } : report(url, { records: [{ ...records[0], measuredAt: '2026-10-16T19:34:00+08:00' }, { ...records[1], measuredAt: '2026-10-16T09:46:00Z' }] })));
  await f.start();
  assert.match(f.node('mesReportRows').textContent, /2026-10-16 19:34:00/);
  assert.match(f.node('mesReportRows').textContent, /2026-10-16 17:46:00/);
  assert.doesNotMatch(f.node('mesReportRows').textContent, /\+08:00|09:46:00Z/);
  assert.match(f.node('mesReportTrendDetail').textContent, /19:30/);
  assert.match(f.node('mesVisionReportWorkbench').innerHTML, /查询与检测时间均为北京时间/);
  f.fire('mesReportRows', 'click', { target: { closest: () => ({ dataset: { mesRecordId: 'R2' } }) } }); await f.settle();
  assert.match(f.node('mesReportDetailMeta').textContent, /检测时间（北京时间）2026-10-16 19:34:00/);
  assert.doesNotMatch(f.node('mesReportDetailMeta').textContent, /\+08:00|\.000/);
});

test('client pagination preserves separate records and does not issue extra company requests', async () => {
  const many = Array.from({ length: 105 }, (_, index) => ({ ...records[index % 2], recordId: 'ROW-' + index }));
  const f = fixture(url => response(url.endsWith('/catalog') ? catalog : report(url, { records: many })));
  await f.start(); assert.equal(f.node('mesReportRows').children.length, 50);
  f.fire('mesReportNext', 'click'); assert.equal(f.node('mesReportRows').children.length, 50); assert.match(f.node('mesReportPage').textContent, /^2 \/ 3/);
  f.fire('mesReportNext', 'click'); assert.equal(f.node('mesReportRows').children.length, 5); assert.equal(f.node('mesReportNext').disabled, true);
  f.node('mesReportPageSize').value = '20'; f.fire('mesReportPageSize', 'change'); assert.equal(f.node('mesReportRows').children.length, 20); assert.match(f.node('mesReportPage').textContent, /^1 \/ 6/);
  assert.equal(f.requests.length, 2);
});

test('only the company source is presented and returning to this module reuses its queried data', async () => {
  const f = fixture(); await f.start();
  assert.equal(f.timers.size, 1);
  assert.doesNotMatch(f.htmlWrites.join(''), /mesReportViewFile|采集文件|mesVisionSourceSwitch/);
  f.api.setContext(user, false); assert.equal(f.node('visionWorkbench').hidden, true); assert.equal(f.timers.size, 0);
  f.api.setContext(user, true); await f.settle();
  assert.equal(f.api.isFileMode(), false); assert.equal(f.requests.length, 2); assert.equal(f.timers.size, 1);
  assert.deepEqual(f.events, []);
});

test('late report results cannot overwrite a newer query or restore data after logout', async () => {
  const first = gate(), next = gate(); let reports = 0;
  const f = fixture(url => url.endsWith('/catalog') ? response(catalog) : ++reports === 1 ? first.promise : next.promise);
  f.api.setContext(user, true); await f.settle(); const oldUrl = f.requests[1].url;
  f.node('mesReportBarcode').value = 'NEW'; f.fire('mesReportForm', 'submit'); await f.settle();
  assert.equal(f.requests[1].options.signal.aborted, true);
  next.resolve(response(report(f.requests[2].url, { records: [{ ...records[0], barcode: 'NEW' }] }))); await f.settle();
  first.resolve(response(report(oldUrl))); await f.settle();
  assert.match(f.node('mesReportRows').textContent, /NEW/); assert.doesNotMatch(f.node('mesReportRows').textContent, /SAME-PART/);
  f.api.setContext(null, false);
  assert.equal(f.node('visionWorkbench').hidden, true); assert.equal(f.node('mesReportRows').children.length, 0); assert.equal(f.node('mesReportBarcode').value, ''); assert.equal(f.timers.size, 0);
});

test('a current portal 401 clears results but source failures preserve the previous clearly stale report', async () => {
  let failed = false;
  const f = fixture(url => url.endsWith('/catalog') ? response(catalog) : failed ? response({ message: '公司连接暂不可用' }, 428) : response(report(url)));
  await f.start(); failed = true; f.fire('mesReportRefresh', 'click'); await f.settle();
  assert.equal(f.node('mesReportRows').children.length, 2); assert.match(f.node('mesReportStatusMessage').textContent, /上次成功/); assert.match(f.node('mesReportError').textContent, /公司连接/); assert.deepEqual(f.events, []);
  const expired = fixture(() => response({ message: 'expired' }, 401)); await expired.start();
  assert.deepEqual(expired.events, ['portal:session-expired']); assert.equal(expired.node('mesVisionReportWorkbench').hidden, true); assert.equal(expired.node('mesReportRows').children.length, 0);
});

test('untrusted names and raw dimensions never become executable markup, and chart hover is local', async () => {
  const bad = '<img src=x onerror=alert(1)>';
  const f = fixture(url => response(url.endsWith('/catalog') ? { ...catalog, lines: [{ id: 'B', name: bad }] } : report(url, { records: records.map(item => ({ ...item, partName: bad })) })));
  await f.start(); assert.match(f.node('mesReportRows').textContent, /<img src=x/);
  assert.equal(f.htmlWrites.some(markup => markup.includes(bad)), false);
  const before = f.requests.length;
  f.fire('mesReportChart', 'pointermove', { clientX: 500 });
  assert.equal(f.node('mesReportTooltip').hidden, false); assert.match(f.node('mesReportTooltip').textContent, /OK.*NG/); assert.equal(f.requests.length, before);
  f.fire('mesReportChart', 'pointerleave'); assert.equal(f.node('mesReportTooltip').hidden, true);
});

test('invalid dates, view limit or control characters do not call the company service', async () => {
  const f = fixture(); await f.start();
  f.node('mesReportStart').value = '2026-10-16T20:00'; f.node('mesReportEnd').value = '2026-10-16T10:00'; await f.submit(); assert.match(f.node('mesReportError').textContent, /不能晚于/);
  f.node('mesReportStart').value = '2026-10-16T08:00'; f.fire('mesReportModeCount', 'change'); f.node('mesReportLimit').value = 'custom'; f.node('mesReportLimitCount').value = '20001'; await f.submit(); assert.match(f.node('mesReportError').textContent, /查看数量/);
  f.node('mesReportLimit').value = '500'; f.node('mesReportBarcode').value = 'A\u0000B'; await f.submit(); assert.match(f.node('mesReportError').textContent, /工件码/);
  assert.equal(f.requests.length, 2);
});

test('device, material, result and a custom recent count form one applied query and preserve missing facet choices', async () => {
  const initialFacets = { parts: [{ code: 'P-A', name: '物料甲' }, { code: 'P-B', name: '物料乙' }], devices: [{ code: 'D-A', name: '设备甲' }] };
  let count = 0;
  const f = fixture(url => response(url.endsWith('/catalog') ? catalog : report(url, { facets: ++count === 1 ? initialFacets : { parts: [], devices: [] } })));
  await f.start();
  assert.match(f.node('mesReportPart').textContent, /物料甲 · P-A/);
  f.node('mesReportPart').value = 'P-A'; f.node('mesReportDevice').value = 'D-A'; f.node('mesReportResult').value = 'NG';
  f.fire('mesReportModeCount', 'change'); f.node('mesReportLimit').value = 'custom'; f.node('mesReportLimitCount').value = '00250'; f.fire('mesReportForm', 'change');
  assert.equal(f.node('mesReportCustomLimit').hidden, false); assert.equal(f.node('mesReportLimitCount').disabled, false);
  await f.submit();
  const applied = new URL(f.requests.at(-1).url, 'http://localhost').searchParams;
  assert.equal(applied.get('partCode'), 'P-A'); assert.equal(applied.get('deviceCode'), 'D-A'); assert.equal(applied.get('result'), 'NG'); assert.equal(applied.get('limit'), '250');
  assert.equal(f.node('mesReportDraft').hidden, true); assert.equal(f.node('mesReportError').hidden, true);
  assert.match(f.node('mesReportScope').textContent, /最近 250 次.*物料甲 · P-A.*设备甲 · D-A.*NG/);
  f.node('mesReportPart').value = 'P-B'; f.fire('mesReportForm', 'change'); f.fire('mesReportRefresh', 'click'); await f.settle();
  assert.equal(new URL(f.requests.at(-1).url, 'http://localhost').searchParams.get('partCode'), 'P-A');
  assert.equal(f.node('mesReportPart').value, 'P-B'); assert.match(f.node('mesReportPart').textContent, /物料甲 · P-A/); assert.match(f.node('mesReportPart').textContent, /物料乙 · P-B/);
  assert.equal(f.node('mesReportDraft').hidden, false); assert.equal(f.node('mesReportExport').disabled, true);
  assert.match(f.node('mesVisionReportWorkbench').innerHTML, /并非公司完整目录/);
});

test('shared date and searchable-material controls are used without discarding precise time ranges', async () => {
  const f = fixture(undefined, { sharedFilters: true, preferences: { dateRange: 'yesterday', pageSize: 20 } }); await f.start();
  assert.equal(f.filterCalls.length, 1); assert.equal(f.filterCalls[0].allowAll, false); assert.equal(f.materialCalls[0], 'mesReportPart');
  assert.equal(f.node('mesReportRangeMode').value, 'yesterday'); assert.equal(f.node('mesReportPageSize').value, '20');
  const range = require('../public/shared-filter.js').range('yesterday');
  assert.equal(f.node('mesReportStart').value, range.start + 'T00:00');
  f.node('mesReportStart').value = '2026-10-15T08:21'; f.node('mesReportEnd').value = '2026-10-16T17:42'; f.filterCalls[0].onDraft();
  assert.equal(f.requests.length, 2); assert.equal(f.node('mesReportDraft').hidden, false);
  await f.submit(); assert.equal(new URL(f.requests.at(-1).url, 'http://localhost').searchParams.get('end'), '2026-10-16T17:42');
});

test('result filtering shows counts while withholding the aggregate rate and curve with its specific reason', async () => {
  const f = fixture(url => {
    if (url.endsWith('/catalog')) return response(catalog);
    const filtered = new URL(url, 'http://localhost').searchParams.get('result') === 'NG';
    return response(report(url, filtered ? { coverage: { complete: true, eligibleForLineRate: false, rateUnavailableReason: '仅查询 NG 结果，不能计算线体合格率。' }, summary: { total: 1, ok: 0, ng: 1, unknown: 0, denominator: 1, passRate: null }, records: [records[1]] } : {}));
  }); await f.start(); f.node('mesReportResult').value = 'NG'; await f.submit();
  assert.equal(f.node('mesReportTotal').textContent, '1'); assert.equal(f.node('mesReportNG').textContent, '1'); assert.equal(f.node('mesReportRate').textContent, '—');
  assert.match(f.node('mesReportRateNote').textContent, /按结果筛选/); assert.match(f.node('mesReportTrendEmpty').textContent, /仅查询 NG/);
  assert.equal(f.node('mesReportChart').hidden, true); assert.equal(f.node('mesReportExport').disabled, false);
});

test('report receives the applied data and immediate client interval and pauses queued and visibility refreshes', async () => {
  const f = fixture(); await f.start();
  assert.equal(f.node('mesReportExport').disabled, false);
  for (const interval of ['5', '30']) { f.node('mesReportInterval').value = interval; f.fire('mesReportInterval', 'change'); assert.match(f.node('mesReportTrendSubtitle').textContent, new RegExp(interval + ' 分钟')); }
  assert.equal(f.requests.length, 2);
  const queued = [...f.timers.values()][0].callback;
  f.fire('mesReportExport', 'click');
  assert.equal(f.reportCalls.length, 1); const input = f.reportCalls[0];
  assert.equal(input.kind, 'vision-mes'); assert.equal(input.account, user.account); assert.equal(input.interval, '30'); assert.equal(input.query.lineId, 'B'); assert.equal(input.query.limit, '0'); assert.equal(input.query.queryMode, 'time'); assert.equal(input.report.summary.total, 2); assert.equal(input.loadedAt, input.report.fetchedAt);
  assert.equal(f.timers.size, 0); assert.match(f.node('mesReportPolling').textContent, /报告预览期间/);
  queued(); await f.settle(); f.context.document.hidden = true; f.documentHandlers.get('visibilitychange')(); f.context.document.hidden = false; f.documentHandlers.get('visibilitychange')(); await f.settle();
  assert.equal(f.requests.length, 2); assert.equal(f.reportCalls[0].report.records.length, 2);
  f.closeReport(); assert.equal(f.timers.size, 1);
});

test('report creation stays disabled for draft, validation error, busy, incomplete and empty data', async () => {
  const pending = gate(); let reports = 0;
  const f = fixture(url => url.endsWith('/catalog') ? response(catalog) : ++reports === 1 ? response(report(url)) : pending.promise); await f.start();
  f.node('mesReportBarcode').value = 'DRAFT'; f.fire('mesReportForm', 'input'); assert.equal(f.node('mesReportExport').disabled, true); f.fire('mesReportExport', 'click'); assert.equal(f.reportCalls.length, 0);
  f.node('mesReportBarcode').value = ''; f.node('mesReportStart').value = 'INVALID'; await f.submit(); assert.equal(f.node('mesReportExport').disabled, true);
  f.node('mesReportStart').value = '2026-10-16T00:00'; f.node('mesReportEnd').value = '2026-10-16T23:59'; f.fire('mesReportForm', 'submit'); await f.settle(); assert.equal(f.node('mesReportExport').disabled, true);
  pending.resolve(response(report(f.requests.at(-1).url, { coverage: { complete: false, eligibleForLineRate: false } }))); await f.settle(); assert.equal(f.node('mesReportExport').disabled, true);
  const empty = fixture(url => response(url.endsWith('/catalog') ? catalog : report(url, { records: [], summary: { total: 0, ok: 0, ng: 0, unknown: 0, denominator: 0, passRate: null } }))); await empty.start(); assert.equal(empty.node('mesReportExport').disabled, true);
});

test('only applied filters, page, page size and interval restore for the same account and clear on account change', async () => {
  const stored = new Map(), many = Array.from({ length: 105 }, (_, index) => ({ ...records[index % 2], recordId: 'SAVED-' + index }));
  const fetcher = url => response(url.endsWith('/catalog') ? catalog : report(url, { records: many, facets: { parts: [{ code: 'P-A', name: '物料甲' }], devices: [{ code: 'D-A', name: '设备甲' }] } }));
  const f = fixture(fetcher, { stored }); await f.start();
  f.node('mesReportLine').value = 'A'; f.node('mesReportStart').value = '2026-10-15T08:21'; f.node('mesReportEnd').value = '2026-10-16T17:42'; f.node('mesReportPart').value = 'P-A'; f.node('mesReportDevice').value = 'D-A'; f.node('mesReportBarcode').value = 'APPLIED'; await f.submit();
  f.node('mesReportPageSize').value = '20'; f.fire('mesReportPageSize', 'change'); f.fire('mesReportNext', 'click'); f.node('mesReportInterval').value = '5'; f.fire('mesReportInterval', 'change');
  f.node('mesReportBarcode').value = 'UNAPPLIED'; f.fire('mesReportForm', 'change');
  const restored = fixture(fetcher, { stored, sharedFilters: true }); await restored.start();
  assert.equal(restored.node('mesReportLine').value, 'A'); assert.equal(restored.node('mesReportStart').value, '2026-10-15T08:21'); assert.equal(restored.node('mesReportRangeMode').value, 'custom'); assert.equal(restored.node('mesReportBarcode').value, 'APPLIED'); assert.equal(restored.node('mesReportModeTime').checked, true); assert.equal(restored.node('mesReportCountField').hidden, true); assert.equal(restored.node('mesReportPart').value, 'P-A'); assert.equal(restored.node('mesReportDevice').value, 'D-A'); assert.equal(restored.node('mesReportInterval').value, '5'); assert.match(restored.node('mesReportPage').textContent, /^2 \/ 6/);
  assert.equal(stored.size, 1);
  restored.api.setContext({ ...user, account: 'different-reader' }, true); await restored.settle();
  assert.equal(restored.node('mesReportBarcode').value, ''); assert.equal(restored.node('mesReportPart').value, ''); assert.equal(restored.node('mesReportLine').value, 'B'); assert.match(restored.node('mesReportPage').textContent, /^1 \/ 3/);
  assert.equal([...stored.keys()].some(key => key.includes(user.account)), false);
  restored.api.setContext(null, false); assert.equal(stored.size, 0);
});

test('count mode disables dates, sends no date constraints and returns to an unlimited time query', async () => {
  const f = fixture(undefined, { sharedFilters: true }); await f.start();
  f.node('mesReportStart').value = 'INVALID'; f.node('mesReportEnd').value = ''; f.node('mesReportRangeMode').value = 'companyWeek';
  f.fire('mesReportModeCount', 'change'); f.node('mesReportLimit').value = '100'; f.fire('mesReportForm', 'change');
  assert.equal(f.node('mesReportRangeField').hidden, true); assert.equal(f.node('mesReportStartField').hidden, true); assert.equal(f.node('mesReportEndField').hidden, true);
  assert.equal(f.node('mesReportStart').disabled, true); assert.equal(f.node('mesReportEnd').disabled, true); assert.equal(f.node('week-controls').hidden, true);
  assert.equal(f.node('mesReportCountField').hidden, false); assert.equal(f.node('mesReportLimit').disabled, false); assert.equal(f.node('mesReportDraft').hidden, false);
  await f.submit();
  const count = new URL(f.requests.at(-1).url, 'http://localhost').searchParams;
  assert.equal(count.get('queryMode'), 'count'); assert.equal(count.get('limit'), '100'); assert.equal(count.has('start'), false); assert.equal(count.has('end'), false); assert.equal(f.node('mesReportError').hidden, true);
  assert.match(f.node('mesReportScope').textContent, /按数量.*最近 100 次检测.*不应用时间筛选.*记录时段：2026-10-16 17:46:00 至 2026-10-16 19:34:00/);
  assert.doesNotMatch(f.node('mesReportScope').textContent, /2000-01-01/);
  f.node('mesReportStart').value = 'ANOTHER INVALID'; f.fire('mesReportForm', 'input'); assert.equal(f.node('mesReportDraft').hidden, true);
  f.fire('mesReportExport', 'click'); assert.equal(f.reportCalls[0].query.queryMode, 'count'); assert.equal('start' in f.reportCalls[0].query, false); assert.equal('end' in f.reportCalls[0].query, false); f.closeReport();
  f.node('mesReportStart').value = '2026-10-15T08:00'; f.node('mesReportEnd').value = '2026-10-16T18:00'; f.fire('mesReportModeTime', 'change'); f.node('mesReportLimit').value = 'custom'; f.node('mesReportLimitCount').value = 'INVALID';
  await f.submit(); const time = new URL(f.requests.at(-1).url, 'http://localhost').searchParams;
  assert.equal(time.get('queryMode'), 'time'); assert.equal(time.get('limit'), '0'); assert.equal(time.get('start'), '2026-10-15T08:00'); assert.equal(time.get('end'), '2026-10-16T18:00'); assert.equal(f.node('mesReportError').hidden, true);
  assert.equal(f.node('mesReportRangeField').hidden, false); assert.equal(f.node('mesReportCountField').hidden, true); assert.equal(f.node('mesReportLimitCount').disabled, true);
});

test('changing modes while an earlier request is pending keeps the result applied to its actual mode', async () => {
  const waiting = gate(); let calls = 0;
  const f = fixture(url => url.endsWith('/catalog') ? response(catalog) : ++calls === 1 ? response(report(url)) : waiting.promise); await f.start();
  f.fire('mesReportModeCount', 'change'); f.node('mesReportLimit').value = '1000'; f.fire('mesReportForm', 'submit'); await f.settle(); const requested = f.requests.at(-1).url;
  f.fire('mesReportModeTime', 'change'); waiting.resolve(response(report(requested))); await f.settle();
  assert.equal(f.node('mesReportModeTime').checked, true); assert.equal(f.node('mesReportDraft').hidden, false); assert.equal(f.node('mesReportExport').disabled, true); assert.match(f.node('mesReportScope').textContent, /按数量.*最近 1000/);
  f.fire('mesReportRefresh', 'click'); await f.settle(); assert.equal(new URL(f.requests.at(-1).url, 'http://localhost').searchParams.get('queryMode'), 'count');
});

test('legacy combined date and limit storage migrates to time only and removed lines are never recreated', async () => {
  const legacyKey = 'portal:vision-mes:view:v1:' + encodeURIComponent(user.account), stored = new Map([[legacyKey, JSON.stringify({ filters: { lineId: 'REMOVED-LINE', start: '2026-10-15T08:12', end: '2026-10-16T18:13', limit: '500', barcode: '', partCode: '', deviceCode: '', result: 'all' }, page: 3, size: 20, interval: '30' })]]);
  const f = fixture(undefined, { stored }); await f.start();
  const query = new URL(f.requests.at(-1).url, 'http://localhost').searchParams;
  assert.equal(query.get('queryMode'), 'time'); assert.equal(query.get('limit'), '0'); assert.equal(query.get('start'), '2026-10-15T08:12'); assert.equal(query.get('end'), '2026-10-16T18:13'); assert.equal(query.get('lineId'), 'B');
  assert.equal(f.node('mesReportLine').children.some(option => option.value === 'REMOVED-LINE'), false); assert.equal(f.node('mesReportModeTime').checked, true); assert.equal(f.node('mesReportCountField').hidden, true); assert.match(f.node('mesReportPage').textContent, /^1/);
  assert.equal(stored.has(legacyKey), false); assert.equal([...stored.keys()][0], 'portal:vision-mes:view:v2:' + encodeURIComponent(user.account));
});

test('count mode restores only its number rather than reusing prior date filters', async () => {
  const stored = new Map(), f = fixture(undefined, { stored }); await f.start(); f.fire('mesReportModeCount', 'change'); f.node('mesReportLimit').value = 'custom'; f.node('mesReportLimitCount').value = '275'; await f.submit();
  const saved = JSON.parse([...stored.values()][0]); assert.equal(saved.filters.queryMode, 'count'); assert.equal(saved.filters.start, undefined); assert.equal(saved.filters.end, undefined);
  const restored = fixture(undefined, { stored }); await restored.start(); const query = new URL(restored.requests.at(-1).url, 'http://localhost').searchParams;
  assert.equal(restored.node('mesReportModeCount').checked, true); assert.equal(restored.node('mesReportLimit').value, 'custom'); assert.equal(restored.node('mesReportLimitCount').value, '275'); assert.equal(query.has('start'), false); assert.equal(query.has('end'), false); assert.equal(query.get('limit'), '275');
});

test('materials split by production line, retain unknowns and keep both code and line in query and report', async () => {
  const facets = { parts: [{ code: 'P-A', name: '合成物料' }], devices: [], materialLines: [{ code: 'P-A', name: '合成物料', productionLine: '11' }, { code: 'P-A', name: '合成物料', productionLine: '12' }, { code: 'P-A', name: '合成物料', productionLine: '1' }, { code: 'P-A', name: '合成物料', productionLine: 'unknown' }] };
  let read = 0;
  const fetcher = url => response(url.endsWith('/catalog') ? catalog : report(url, { facets: ++read <= 1 ? facets : { parts: [], devices: [], materialLines: [] }, records: [{ ...records[0], productionLine: '11' }, { ...records[1], productionLine: 'unknown' }] }));
  const stored = new Map(), f = fixture(fetcher, { stored }); await f.start();
  const options = f.node('mesReportPart').children;
  assert.match(f.node('mesReportPart').textContent, /全部线.*11线.*12线.*线号待确认/); assert.match(f.node('mesReportRows').textContent, /合成件 · 11线.*合成件 · 线号待确认/);
  const line11 = options.find(option => option.textContent.includes('11线')).value, line1 = options.find(option => option.textContent.includes(' · 1线')).value, unknown = options.find(option => option.textContent.includes('线号待确认')).value;
  f.node('mesReportPart').value = line11; await f.submit();
  let query = new URL(f.requests.at(-1).url, 'http://localhost').searchParams; assert.equal(query.get('partCode'), 'P-A'); assert.equal(query.get('productionLine'), '11'); assert.equal(f.node('mesReportPart').value, line11); assert.match(f.node('mesReportScope').textContent, /合成物料 · 11线/);
  f.fire('mesReportExport', 'click'); assert.equal(f.reportCalls[0].query.partCode, 'P-A'); assert.equal(f.reportCalls[0].query.productionLine, '11'); f.closeReport();
  const restored = fixture(fetcher, { stored }); await restored.start(); query = new URL(restored.requests.at(-1).url, 'http://localhost').searchParams; assert.equal(query.get('productionLine'), '11'); assert.equal(restored.node('mesReportPart').value, line11);
  f.node('mesReportPart').value = unknown; await f.submit(); query = new URL(f.requests.at(-1).url, 'http://localhost').searchParams; assert.equal(query.get('productionLine'), 'unknown');
  f.node('mesReportPart').value = line1; await f.submit(); query = new URL(f.requests.at(-1).url, 'http://localhost').searchParams; assert.equal(query.get('productionLine'), '1');
  f.node('mesReportPart').value = 'P-A'; await f.submit(); query = new URL(f.requests.at(-1).url, 'http://localhost').searchParams; assert.equal(query.get('productionLine'), ''); assert.equal(query.get('partCode'), 'P-A');
});
