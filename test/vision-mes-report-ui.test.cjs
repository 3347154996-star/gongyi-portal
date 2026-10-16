'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const user = { authenticated: true, account: 'synthetic-reader', role: 'member' };
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const catalog = { defaultLineId: 'B', lines: [{ id: 'A', code: 'A01', name: '合成线 A' }, { id: 'B', code: 'B01', name: '合成线 B' }] };
const records = [{ recordId: 'R2', barcode: 'SAME-PART', measuredAt: '2026-10-16 19:34:00', partName: '合成件', deviceName: '合成检具', result: 'OK' }, { recordId: 'R1', barcode: 'SAME-PART', measuredAt: '2026-10-16 17:46:00', partName: '合成件', deviceName: '合成检具', result: 'NG' }];
function report(url, extra = {}) { const filters = Object.fromEntries(new URL(url, 'http://localhost').searchParams); return { action: 'report', line: { id: filters.lineId, name: '合成线 ' + filters.lineId }, records: records.map(item => ({ ...item })), summary: { total: 2, ok: 1, ng: 1, unknown: 0, denominator: 2, passRate: 50 }, coverage: { complete: true, eligibleForLineRate: true, mode: 'recent', sourceTotal: 2, readRows: 2, note: '在日期范围内取最近记录。' }, filters: { ...filters, start: filters.start.replace('T', ' ') + ':00', end: filters.end.replace('T', ' ') + ':00' }, fetchedAt: '2026-10-16T12:00:00Z', warnings: [], ...extra }; }
const detail = (recordId = 'R2') => ({ recordId, barcode: 'SAME-PART', measuredAt: recordId === 'R2' ? '2026-10-16 19:34:00' : '2026-10-16 17:46:00', lineName: '合成线 B', deviceName: '合成检具', processName: '合成工序', partName: '合成物料', sourceResult: recordId === 'R2' ? 'OK' : 'NG', measurements: [{ name: 'P1', actual: 0.2, lowerLimit: -1, upperLimit: 1, result: 'OK' }, { name: 'P2', actual: 1.5, lowerLimit: -1, upperLimit: 1, result: 'NG' }, { name: 'P3', actual: null, actualRaw: '无数值', result: null, resultRaw: '未知来源' }], warnings: ['测点与整件结论分别保留。'] });
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function fixture(fetcher) {
  const nodes = new Map(), requests = [], events = [], timers = new Map(), htmlWrites = [], documentHandlers = new Map(); let timerId = 0;
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
    window: { addEventListener() {}, dispatchEvent: event => events.push(event.type), PortalWorkbench: { sourceStamp: value => value + ' 北京时间' } },
    AbortController, URLSearchParams, Event: class { constructor(type) { this.type = type; } }, CustomEvent: class { constructor(type) { this.type = type; } },
    setTimeout: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => { requests.push({ url, options }); return fetcher ? fetcher(url, options) : response(url.endsWith('/catalog') ? catalog : url.includes('/detail?') ? detail(new URL(url, 'http://localhost').searchParams.get('recordId')) : report(url)); },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/vision-mes-report.js'), 'utf8'), context);
  const api = context.window.MesVisionReportWorkbench;
  const fire = (id, type, extra = {}) => node(id).handlers.get(type)?.({ preventDefault() {}, ...extra });
  const settle = async () => { for (let index = 0; index < 5; index++) await new Promise(setImmediate); };
  const start = async () => { api.setContext(user, true); await settle(); };
  const submit = async () => { fire('mesReportForm', 'submit'); await settle(); };
  return { node, api, fire, requests, events, timers, htmlWrites, context, documentHandlers, settle, start, submit };
}

test('default company view auto-discovers lines, uses configured default and counts each retest separately', async () => {
  const f = fixture(); await f.start();
  assert.equal(f.api.isFileMode(), false); assert.equal(f.node('visionWorkbench').hidden, false);
  assert.equal(f.node('mesReportLine').value, 'B'); assert.equal(f.requests.length, 2);
  const query = new URL(f.requests[1].url, 'http://localhost').searchParams;
  assert.equal(query.get('lineId'), 'B'); assert.equal(query.get('limit'), '500'); assert.match(query.get('start'), /T00:00$/); assert.match(query.get('end'), /T23:59$/);
  assert.equal(f.node('mesReportRows').children.length, 2); assert.equal(f.node('mesReportTotal').textContent, '2');
  assert.equal(f.node('mesReportOK').textContent, '1'); assert.equal(f.node('mesReportNG').textContent, '1'); assert.equal(f.node('mesReportRate').textContent, '50.0%');
  assert.match(f.node('mesReportScope').textContent, /最近 500 次/);
  assert.match(f.node('mesReportChart').innerHTML, /mes-report-chart-dot/);
  assert.equal(f.node('mesReportTrendDetail').hidden, false);
  assert.match(f.node('mesReportTrendDetail').textContent, /合格 1 \/ 可统计 1 次/);
  for (const request of f.requests) { assert.equal(request.options.credentials, 'same-origin'); assert.equal(request.options.body, undefined); }
  f.api.setContext(user, true); await f.settle(); assert.equal(f.requests.length, 2);
});

test('dates include hours and minutes, recent count and barcode apply together, and normalized source dates are accepted', async () => {
  const f = fixture(); await f.start();
  f.node('mesReportStart').value = '2026-10-15T08:30'; f.node('mesReportEnd').value = '2026-10-16T17:45'; f.node('mesReportLimit').value = '100'; f.node('mesReportBarcode').value = 'SAME-PART';
  f.fire('mesReportForm', 'input'); assert.equal(f.node('mesReportDraft').hidden, false);
  await f.submit();
  const query = new URL(f.requests.at(-1).url, 'http://localhost').searchParams;
  assert.equal(query.get('start'), '2026-10-15T08:30'); assert.equal(query.get('end'), '2026-10-16T17:45'); assert.equal(query.get('barcode'), 'SAME-PART'); assert.equal(query.get('limit'), '100');
  assert.equal(f.node('mesReportError').hidden, true); assert.equal(f.node('mesReportDraft').hidden, true);
  assert.match(f.node('mesReportScope').textContent, /2026-10-15 08:30:00/);
  f.fire('preset-group', 'click', { target: { closest: () => ({ dataset: { mesPeriod: 'week' } }) } });
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

test('file mode pauses company refresh and returning uses the current report without another request', async () => {
  const f = fixture(); await f.start();
  assert.equal(f.timers.size, 1);
  f.fire('mesReportViewFile', 'click');
  assert.equal(f.api.isFileMode(), true); assert.equal(f.node('visionWorkbench').dataset.mesView, 'file'); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.events, ['vision-source-change']);
  f.fire('mesReportViewCompany', 'click'); await f.settle();
  assert.equal(f.api.isFileMode(), false); assert.equal(f.requests.length, 2); assert.equal(f.timers.size, 1);
  assert.deepEqual(f.events, ['vision-source-change', 'vision-source-change']);
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
  f.node('mesReportStart').value = '2026-10-16T08:00'; f.node('mesReportLimit').value = '999'; await f.submit(); assert.match(f.node('mesReportError').textContent, /查看数量/);
  f.node('mesReportLimit').value = '500'; f.node('mesReportBarcode').value = 'A\u0000B'; await f.submit(); assert.match(f.node('mesReportError').textContent, /工件码/);
  assert.equal(f.requests.length, 2);
});
