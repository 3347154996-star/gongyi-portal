'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const records = Array.from({ length: 3 }, (_, index) => ({ recordId: 'R' + index, barcode: 'SYN-SN-' + index, measuredAt: '2026-10-18T10:0' + index + ':00+08:00', result: index === 1 ? 'NG' : 'OK', partCode: 'P', partName: '合成物料', productionLine: '11', deviceCode: 'D', deviceName: '合成设备' }));
const report = (extra = {}) => ({ records: structuredClone(records), summary: { total: 3, ok: 2, ng: 1, unknown: 0 }, coverage: { complete: true }, line: { name: '合成检测线' }, filters: { queryMode: 'time', start: '2026-10-18 00:00:00', end: '2026-10-18 12:00:00' }, fetchedAt: '2026-10-18T04:00:00Z', analysisSnapshot: { snapshotId: 'SYN-SNAPSHOT', total: 3, batchSize: 2, maxRecords: 1000, available: true }, ...extra });
const query = { queryMode: 'time', start: '2026-10-18T00:00', end: '2026-10-18T12:00', lineId: 'L', partCode: '', deviceCode: '', productionLine: '', result: 'all', limit: '0' };
function batch(offset, extra = {}) { const end = Math.min(offset + 2, records.length); return { snapshotId: 'SYN-SNAPSHOT', total: 3, offset, nextOffset: end === 3 ? null : end, items: records.slice(offset, end).map((record, index) => ({ ...record, index: offset + index, measurements: [{ key: 'P1', name: '合成测点', actual: index + .2, lowerLimit: 0, upperLimit: 1, result: record.result }] })), errors: [], complete: true, ...extra }; }
function model(label = '合成测点 · 合成物料 · 11线') { return { complete: true, coverage: { expectedRecords: 3, loadedRecords: 3, missingRecords: 0, complete: true }, warnings: ['统计仅限本次查询。'], criticalMetadataAvailable: false, groups: [{ id: 'G1', label, pointName: label, partName: '合成物料', deviceName: '合成设备', lowerLimit: 0, upperLimit: 1, unit: null, observations: records.map((record, index) => ({ ...record, actual: [.2, 1.5, .7][index], present: true })), stats: { n: 3, avg: .8, min: .2, max: 1.5, range: 1.3, std: .65, ok: 2, ng: 1, unknown: 0, validObserved: 3, ngRate: 100 / 3, pp: null, ppk: null }, capability: { available: false, reason: '样本不足 30，暂不计算 Pp / Ppk。', warnings: [] }, control: { available: false, reason: '样本不足，暂不估计控制线。', warnings: [] } }], pareto: { items: [{ groupId: 'G1', name: label, ng: 1, validObserved: 3, ngRate: 100 / 3, cumulativePercent: 100 }], totalNG: 1, otherNG: 0 }, pie: { total: 3, ok: 2, ng: 1, unknown: 0 } }; }
function gate() { let resolve; const promise = new Promise(done => resolve = done); return { resolve, promise }; }
function fixture(options = {}) {
  const nodes = new Map(), requests = [], events = [], statsCalls = [], downloads = [], htmlWrites = [], revoked = []; let prints = 0;
  class Node {
    constructor(tag = 'div', id = '') { this.tagName = tag; this.id = id; this.children = []; this.handlers = new Map(); this.attributes = {}; this.dataset = {}; this.style = {}; this._text = ''; this._html = ''; this.value = ''; this.hidden = false; this.disabled = false; this.open = false; this.clientWidth = 1000; this.contentWindow = { focus() {}, print() { prints++; } }; }
    set textContent(value) { this._text = String(value); this.children = []; } get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set innerHTML(value) { this._html = value; htmlWrites.push(value); for (const match of value.matchAll(/\bid="([^"]+)"/g)) node(match[1]); } get innerHTML() { return this._html; }
    setAttribute(key, value) { this.attributes[key] = String(value); } removeAttribute(key) { delete this.attributes[key]; }
    append(...items) { this.children.push(...items); for (const item of items) if (item.id) nodes.set(item.id, item); } replaceChildren(...items) { this.children = [...items]; this._text = ''; }
    addEventListener(type, callback) { this.handlers.set(type, callback); } showModal() { this.open = true; } close() { this.open = false; } focus() {} remove() {} click() { downloads.push({ href: this.href, filename: this.download }); }
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: 300 }; }
  }
  const node = id => { if (!nodes.has(id)) nodes.set(id, new Node('div', id)); return nodes.get(id); };
  const context = vm.createContext({ document: { getElementById: node, createElement: tag => new Node(tag), body: node('body'), dispatchEvent: event => { events.push(event); } }, window: { addEventListener() {}, VisionMesStats: { analyze(input) { statsCalls.push(input); return options.model ? options.model(input) : model(); } } }, CustomEvent: class { constructor(type, data) { this.type = type; this.detail = data?.detail; } }, AbortController, URLSearchParams, Blob, URL: { createObjectURL(blob) { downloads.push({ blob }); return 'blob:synthetic'; }, revokeObjectURL(url) { revoked.push(url); } }, setTimeout: callback => callback(), fetch: async (url, args) => { requests.push({ url, args }); return options.fetch ? options.fetch(url, args) : response(batch(Number(new URL(url, 'http://local').searchParams.get('offset')))); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/vision-mes-analysis.js'), 'utf8'), context);
  const api = context.window.MesVisionAnalysis, fire = (id, type, props = {}) => node(id).handlers.get(type)?.({ preventDefault() {}, ...props });
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };
  const set = (changes = {}) => api.setContext({ active: true, account: 'synthetic-reader', report: report(), query, draft: false, ...changes });
  const load = async () => { fire('mvaLoad', 'click'); await settle(); };
  return { node, api, context, fire, set, load, settle, requests, events, statsCalls, downloads, htmlWrites, revoked, prints: () => prints };
}

test('loading is explicit, sequential, same-origin and covers every frozen record before analysis', async () => {
  const f = fixture(); f.set(); assert.equal(f.requests.length, 0); assert.equal(f.node('mvaLoad').disabled, false); assert.equal(f.node('mvaResults').hidden, true);
  await f.load(); assert.equal(f.requests.length, 2); assert.deepEqual(f.requests.map(item => new URL(item.url, 'http://local').searchParams.get('offset')), ['0', '2']);
  for (const request of f.requests) { assert.equal(request.args.credentials, 'same-origin'); assert.equal(request.args.cache, 'no-store'); assert.equal(request.args.body, undefined); }
  assert.equal(f.statsCalls.length, 1); assert.equal(f.statsCalls[0].details.length, 3); assert.equal(f.statsCalls[0].topN, 10); assert.equal(f.statsCalls[0].includeNonCritical, true);
  assert.equal(f.node('mvaResults').hidden, false); assert.equal(f.node('mvaExport').disabled, false); assert.equal(f.api.isBusy(), true);
  assert.match(f.node('mvaStatus').textContent, /冻结查询快照/); assert.match(f.node('mvaParetoNote').textContent, /全部 NG 1 次/); assert.match(f.node('mvaRankRows').textContent, /33.33%/);
  assert.match(f.node('mvaPie').innerHTML, /次检测/); assert.match(f.node('mesVisionAnalysis').innerHTML, /type="checkbox" disabled/);
  assert.deepEqual(f.events.filter(event => event.type === 'vision-mes-analysis-busy').map(event => event.detail.busy), [true]);
  f.fire('mvaRelease', 'click'); assert.equal(f.api.isBusy(), false); assert.equal(f.node('mvaResults').hidden, true); assert.equal(f.events.at(-1).detail.busy, false);
});

test('unavailable or oversized snapshots cannot silently sample measurements', async () => {
  const f = fixture(); f.set({ report: report({ analysisSnapshot: { available: false, total: 1200, maxRecords: 1000, reason: '最多支持 1000 次，请缩小范围。' } }) }); await f.load();
  assert.equal(f.requests.length, 0); assert.equal(f.node('mvaLoad').disabled, true); assert.match(f.node('mvaStatus').textContent, /1000/);
  f.set({ report: report({ analysisSnapshot: { available: true, total: 3, maxRecords: 2, snapshotId: 'BAD-LIMIT' } }) }); await f.load();
  assert.equal(f.requests.length, 0); assert.match(f.node('mvaError').textContent, /不一致/); assert.equal(f.statsCalls.length, 0);
});

test('cancel aborts the request and a late response cannot restore private analysis', async () => {
  const waiting = gate(), f = fixture({ fetch: () => waiting.promise }); f.set(); f.fire('mvaLoad', 'click'); await f.settle();
  assert.equal(f.node('mvaCancel').hidden, false); f.fire('mvaCancel', 'click'); assert.equal(f.requests[0].args.signal.aborted, true); assert.equal(f.api.isBusy(), false);
  waiting.resolve(response(batch(0))); await f.settle(); assert.equal(f.requests.length, 1); assert.equal(f.statsCalls.length, 0); assert.equal(f.node('mvaResults').hidden, true);
  assert.match(f.node('mvaStatus').textContent, /已取消/);
});

test('partial failures continue progress but never yield a whole-scope ranking or report', async () => {
  const f = fixture({ fetch: url => { const offset = Number(new URL(url, 'http://local').searchParams.get('offset')); return response(offset ? batch(offset) : batch(0, { items: [batch(0).items[0]], errors: [{ index: 1, recordId: 'R1', message: '合成失败' }], complete: false })); } }); f.set(); await f.load();
  assert.equal(f.requests.length, 2); assert.equal(f.statsCalls.length, 0); assert.equal(f.node('mvaResults').hidden, true); assert.equal(f.node('mvaExport').disabled, true); assert.equal(f.api.isBusy(), false); assert.match(f.node('mvaError').textContent, /1 次检测.*不会抽样替代/);
});

test('duplicate, wrong snapshot and missing batch records are rejected', async () => {
  for (const body of [batch(0, { snapshotId: 'OTHER' }), batch(0, { items: [batch(0).items[0], batch(0).items[0]] }), batch(0, { items: [batch(0).items[0]] }), batch(0, { nextOffset: 0 })]) {
    const f = fixture({ fetch: () => response(body) }); f.set(); await f.load(); assert.equal(f.statsCalls.length, 0); assert.equal(f.node('mvaResults').hidden, true); assert.equal(f.node('mvaError').hidden, false);
  }
});

test('draft changes disable export and applied snapshot changes or logout clear all analysis and preview', async () => {
  const f = fixture(); f.set(); await f.load(); f.fire('mvaExport', 'click'); assert.equal(f.node('mvaReportDialog').open, true);
  f.set({ draft: true }); assert.equal(f.node('mvaExport').disabled, true); assert.equal(f.node('mvaResults').hidden, false); assert.match(f.node('mvaStatus').textContent, /筛选已修改/);
  f.set({ report: report({ analysisSnapshot: { ...report().analysisSnapshot, snapshotId: 'NEW' } }) }); assert.equal(f.node('mvaResults').hidden, true); assert.equal(f.node('mvaReportDialog').open, false); assert.equal(f.node('mvaReportFrame').srcdoc, '');
  f.set({ account: null, active: false }); assert.equal(f.node('mesVisionAnalysis').hidden, true); assert.equal(f.node('mvaRankRows').children.length, 0); assert.equal(f.api.isBusy(), false);
});

test('draft while loading aborts rather than merging changed filters into the frozen measurements', async () => {
  const waiting = gate(), f = fixture({ fetch: () => waiting.promise }); f.set(); f.fire('mvaLoad', 'click'); await f.settle(); f.set({ draft: true });
  assert.equal(f.requests[0].args.signal.aborted, true); waiting.resolve(response(batch(0))); await f.settle(); assert.equal(f.statsCalls.length, 0); assert.equal(f.node('mvaResults').hidden, true);
});

test('measurement hover and axis changes are immediate local operations and unavailable statistics retain reasons', async () => {
  const f = fixture(); f.set(); await f.load(); const count = f.requests.length;
  f.fire('mvaTrend', 'pointermove', { clientX: 500 }); assert.equal(f.node('mvaTooltip').hidden, false); assert.match(f.node('mvaHover').textContent, /SYN-SN-1.*1.5.*NG/);
  f.fire('mvaTrend', 'keydown', { key: 'Home' }); assert.match(f.node('mvaHover').textContent, /SYN-SN-0/);
  f.node('mvaAxis').value = 'sn'; f.fire('mvaAxis', 'change'); assert.match(f.node('mvaTrend').innerHTML, /SYN-SN-/); assert.equal(f.requests.length, count);
  assert.match(f.node('mvaReasons').textContent, /样本不足 30/); assert.match(f.node('mvaStats').textContent, /Pp—Ppk—/); assert.doesNotMatch(f.node('mvaTrend').innerHTML, /估计上控制线/);
  f.fire('mvaTrend', 'pointerleave'); assert.equal(f.node('mvaTooltip').hidden, true);
});

test('analysis PDF preview and HTML export escape company text and contain no executable or remote content', async () => {
  const malicious = '<img src="https://external.example/x" onerror="alert(1)">', f = fixture({ model: () => model(malicious) }); f.set(); await f.load();
  assert.match(f.node('mvaRankRows').textContent, /<img src=/); assert.equal(f.htmlWrites.some(html => html.includes(malicious)), false);
  f.fire('mvaExport', 'click'); const html = f.node('mvaReportFrame').srcdoc; assert.match(html, /&lt;img src=&quot;/); assert.doesNotMatch(html, /<img|<script|<link/i); assert.match(html, /default-src 'none'/); assert.match(html, /size:A4 landscape/); assert.match(html, /完整测点 NG 排行/); assert.match(html, /前提条件与局限性/);
  assert.equal(f.node('mvaPrint').disabled, true); f.fire('mvaReportFrame', 'load'); f.fire('mvaPrint', 'click'); assert.equal(f.prints(), 1);
  f.fire('mvaDownload', 'click'); assert.equal(f.downloads.at(-1).filename.endsWith('.html'), true); assert.deepEqual(f.revoked, ['blob:synthetic']);
  f.set({ account: 'another-account' }); assert.equal(f.node('mvaReportDialog').open, false); assert.equal(f.node('mvaReportFrame').srcdoc, '');
});

test('parent loading and query errors block new analysis and export without pretending filters were changed', async () => {
  const f = fixture(); f.set(); await f.load(); f.set({ loading: true }); assert.equal(f.node('mvaExport').disabled, true); assert.equal(f.node('mvaLoad').disabled, true); assert.equal(f.node('mvaResults').hidden, false); assert.match(f.node('mvaStatus').textContent, /正在查询检测记录/); assert.doesNotMatch(f.node('mvaStatus').textContent, /筛选已修改/);
  f.set({ error: 'synthetic source failure' }); assert.equal(f.node('mvaExport').disabled, true); assert.match(f.node('mvaStatus').textContent, /查询失败/); f.set(); assert.equal(f.node('mvaExport').disabled, false);
  const waiting = gate(), pending = fixture({ fetch: () => waiting.promise }); pending.set(); pending.fire('mvaLoad', 'click'); await pending.settle(); pending.set({ loading: true }); assert.equal(pending.requests[0].args.signal.aborted, true); waiting.resolve(response(batch(0))); await pending.settle(); assert.equal(pending.statsCalls.length, 0);
});

test('source snapshot/cache and individual value warnings survive in the screen and printable report', async () => {
  const f = fixture({ fetch: url => { const data = batch(Number(new URL(url, 'http://local').searchParams.get('offset'))); data.warnings = ['详情可能复用 5 分钟内缓存。', '此批完整不等于全范围完整；需读取全部批次并核对记录数量。', '来源未提供关键测点标识，critical 为 null，不自动推断。', '测点可能复用五分钟内已成功读取的缓存，各条 detailFetchedAt 保留实际读取时刻。']; data.items.forEach(item => { item.warnings = ['数值范围与来源判定不一致。']; item.detailFetchedAt = '2026-10-18T03:58:00Z'; }); return response(data); } }); f.set(); await f.load();
  const warningText = f.node('mvaWarnings').textContent; assert.match(warningText, /最近 5 分钟内的读取结果/); assert.match(warningText, /实测值与来源判定不一致/); assert.match(warningText, /11:58:00/); assert.match(warningText, /并非同一时刻/); assert.doesNotMatch(warningText, /critical|detailFetchedAt|此批完整/);
  assert.equal(f.node('mvaWarnings').children.filter(item => item.textContent.includes('实测值与来源判定不一致')).length, 1); assert.equal(f.node('mvaWarnings').children.filter(item => item.textContent.includes('5 分钟')).length, 1);
  f.fire('mvaExport', 'click'); assert.match(f.node('mvaReportFrame').srcdoc, /最近 5 分钟内的读取结果/); assert.match(f.node('mvaReportFrame').srcdoc, /实测值与来源判定不一致/);
});

test('the published statistics engine accepts the component complete-detail contract without sample substitution', async () => {
  const stats = require('../public/vision-mes-statistics.js'); const f = fixture({ model: input => stats.analyze(input) }); f.set(); await f.load();
  assert.equal(f.node('mvaError').hidden, true); assert.equal(f.node('mvaResults').hidden, false); assert.equal(f.node('mvaExport').disabled, false); assert.equal(f.statsCalls[0].details.length, 3);
  assert.match(f.node('mvaStats').textContent, /Pp—Ppk—/); assert.match(f.node('mvaPie').innerHTML, /NG/);
});

test('point names lead chart labels and selectors, zero NG remains ranked and edge SN labels stay inside the chart', async () => {
  const value = model(), original = value.groups[0]; original.pointName = '位置32 X'; original.label = '合成副车架同一长范围 · 位置32 X';
  const zero = { ...original, id: 'G2', pointName: '位置35 Y', label: '合成副车架同一长范围 · 位置35 Y', stats: { ...original.stats, ng: 0, ok: 3, ngRate: 0 } }; value.groups.push(zero); value.pareto.items[0].name = original.label;
  const f = fixture({ model: () => value }); f.set(); await f.load();
  assert.match(f.node('mvaPareto').innerHTML, /rotate\(-25\)" text-anchor="end">位置32 X/); assert.equal(f.node('mvaRankRows').children.length, 2); assert.match(f.node('mvaRankRows').children[1].textContent, /位置35 Y.*0%/); assert.match(f.node('mvaPoint').children[0].textContent, /^位置32 X ·/);
  f.node('mvaAxis').value = 'sn'; f.fire('mvaAxis', 'change'); assert.match(f.node('mvaTrend').innerHTML, /text-anchor="start">SYN-SN-0/); assert.match(f.node('mvaTrend').innerHTML, /text-anchor="end">SYN-SN-2/);
});

test('whole-piece ring displays source pass rate with its denominator only for an eligible unfiltered scope', async () => {
  const scoped = report({ coverage: { complete: true, eligibleForLineRate: true }, summary: { total: 3, ok: 2, ng: 1, unknown: 0, denominator: 3, passRate: 200 / 3 } });
  const f = fixture(); f.set({ report: scoped }); await f.load(); assert.match(f.node('mvaPie').innerHTML, /66.7%/); assert.match(f.node('mvaPie').innerHTML, /OK 2 \/ 有明确整件结论 3 次/);
  for (const limited of [{ query: { ...query, barcode: 'SYN' } }, { query: { ...query, result: 'NG' } }, { report: { ...scoped, coverage: { complete: true, eligibleForLineRate: false } } }]) { const view = fixture(); view.set({ report: scoped, ...limited }); await view.load(); assert.doesNotMatch(view.node('mvaPie').innerHTML, /66.7%/); assert.match(view.node('mvaPie').innerHTML, /不显示线体合格率/); }
});
