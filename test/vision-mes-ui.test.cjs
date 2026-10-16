'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const account = { authenticated: true, account: 'synthetic-member', role: 'member' };
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const processResponse = (barcode = 'PART-A', processes = [{ id: 'P1', name: '合成尺寸工序' }]) => ({ barcode, processes });
const detailResponse = (barcode = 'PART-A', processId = 'P1', extra = {}) => ({ barcode, processId, processName: '合成尺寸工序', lineName: '测试线体', deviceName: '测试检具', partName: '合成物料', measuredAt: null, fetchedAt: '2026-10-16T04:00:00Z', measurements: [{ name: '位置 A_X', actual: 0.2, lowerLimit: -1, upperLimit: 1, result: 'OK' }, { name: '位置 B_Y', actual: 1.2, lowerLimit: -1, upperLimit: 1, result: 'NG' }, { name: '位置 C_Z', actual: null, actualRaw: '未检测', lowerLimit: null, upperLimit: 1, result: null, resultRaw: '待判定' }], warnings: [], ...extra });

function fixture(fetcher = url => response(url.includes('/processes?') ? processResponse() : detailResponse())) {
  const nodes = new Map(), requests = [], events = [], timers = new Map(), htmlWrites = [];
  let timerId = 0;
  class Node {
    constructor(tagName = 'div', id = '') { this.tagName = tagName; this.id = id; this.children = []; this.attributes = {}; this.handlers = new Map(); this.value = ''; this.hidden = false; this.disabled = false; this.checked = false; this._text = ''; this._html = ''; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set innerHTML(value) { this._html = value; htmlWrites.push(value); for (const match of value.matchAll(/\bid="([^"]+)"/g)) node(match[1]); }
    get innerHTML() { return this._html; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    append(...children) { this.children.push(...children); }
    prepend(...children) { this.children.unshift(...children); if (this.id === 'visionWorkbench') for (const child of children) nodes.set(child.id, child); }
    replaceChildren(...children) { this._text = ''; this.children = [...children]; }
    get firstElementChild() { return this.children[0] || null; }
    addEventListener(type, handler) { this.handlers.set(type, handler); }
    focus() { this.focused = true; }
  }
  function node(id) { if (!nodes.has(id)) nodes.set(id, new Node('div', id)); return nodes.get(id); }
  node('visionWorkbench');
  const context = vm.createContext({
    document: { getElementById: node, createElement: tag => new Node(tag), dispatchEvent: event => events.push(event.type) },
    window: { addEventListener() {}, PortalWorkbench: { deviceStamp: value => String(value).replace('T', ' '), sourceStamp: value => String(value) + ' 北京时间' } },
    AbortController, URLSearchParams,
    CustomEvent: class { constructor(type) { this.type = type; } },
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => { requests.push({ url, options }); return fetcher(url, options); },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/vision-mes.js'), 'utf8'), context);
  const api = context.window.MesVisionWorkbench;
  api.setContext(account, true);
  const fire = (id, type) => node(id).handlers.get(type)?.({ preventDefault() {} });
  const query = barcode => { node('mesVisionBarcode').value = barcode; return fire('mesVisionForm', 'submit'); };
  return { api, node, requests, events, htmlWrites, timers, fire, query };
}

test('a unique process is queried automatically and measurement counts remain separate from line pass rates', async () => {
  const f = fixture();
  await f.query(' PART-A ');
  assert.deepEqual(f.requests.map(item => item.url), ['/local/vision/mes/processes?barcode=PART-A', '/local/vision/mes/lookup?barcode=PART-A&processId=P1']);
  for (const { options } of f.requests) { assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store'); assert.equal(options.method, undefined); assert.equal(options.body, undefined); }
  assert.equal(f.node('mesVisionResult').hidden, false);
  assert.equal(f.node('mesVisionResultBarcode').textContent, 'PART-A');
  assert.equal(f.node('mesVisionRows').children.length, 3);
  assert.match(f.node('mesVisionCounts').textContent, /3测点1NG1OK1未判定/);
  assert.doesNotMatch(f.node('mesVisionCounts').textContent, /%/);
  assert.match(f.node('mesVisionMeta').textContent, /检测时间未提供/);
  assert.equal(f.node('mesVisionProcess').disabled, true);
  f.node('mesVisionOnlyNG').checked = true; f.fire('mesVisionOnlyNG', 'change');
  assert.equal(f.node('mesVisionRows').children.length, 1);
  assert.match(f.node('mesVisionRows').textContent, /位置 B_Y/);
  assert.match(f.node('mesVisionTableCount').textContent, /1 项 NG \/ 共 3 项/);
  assert.equal(f.timers.size, 0);
});

test('multiple processes require an explicit selection and switching clears prior details', async () => {
  const pending = gate();
  const f = fixture(url => url.includes('/processes?') ? response(processResponse('PART-A', [{ id: 'P1', name: '前工序' }, { id: 'P2', name: '后工序' }])) : url.includes('processId=P2') ? pending.promise : response(detailResponse()));
  await f.query('PART-A');
  assert.equal(f.requests.length, 1); assert.equal(f.node('mesVisionResult').hidden, true);
  assert.equal(f.node('mesVisionProcess').disabled, false);
  f.node('mesVisionProcess').value = 'P1'; await f.fire('mesVisionProcess', 'change');
  assert.equal(f.node('mesVisionResult').hidden, false);
  f.node('mesVisionProcess').value = 'P2'; const reading = f.fire('mesVisionProcess', 'change');
  assert.equal(f.node('mesVisionResult').hidden, true); assert.equal(f.node('mesVisionRows').children.length, 0);
  pending.resolve(response(detailResponse('PART-A', 'P2', { processName: '后工序' }))); await reading;
  assert.match(f.node('mesVisionMeta').textContent, /后工序/);
});

test('missing numbers and unknown decisions preserve source text without inferring OK or a timestamp', async () => {
  const f = fixture(url => response(url.includes('/processes?') ? processResponse() : detailResponse('PART-A', 'P1', { sourceRecordedAt: '2026-10-16 10:20:00', measurements: [{ name: 'P', actual: null, actualRaw: '设备未返回', lowerLimit: null, lowerLimitRaw: '-1?', upperLimit: 0, result: null, resultRaw: '复核中' }] })));
  await f.query('PART-A');
  assert.match(f.node('mesVisionRows').textContent, /设备未返回-1\?0未判定复核中/);
  assert.match(f.node('mesVisionMeta').textContent, /检测时间未提供/);
  assert.match(f.node('mesVisionMeta').textContent, /来源记录时间2026-10-16 10:20:00/);
  f.node('mesVisionOnlyNG').checked = true; f.fire('mesVisionOnlyNG', 'change');
  assert.equal(f.node('mesVisionTableWrap').hidden, true);
  assert.equal(f.node('mesVisionEmpty').textContent, '本次返回的测点中没有 NG。');
});

test('source labels, raw values and warnings are rendered as text rather than injected HTML', async () => {
  const malicious = '<img src=x onerror=alert(1)>';
  const f = fixture(url => response(url.includes('/processes?') ? processResponse('PART-A', [{ id: 'P1', name: malicious }]) : detailResponse('PART-A', 'P1', { lineName: malicious, measurements: [{ name: malicious, actual: null, actualRaw: malicious, result: null, resultRaw: malicious }], warnings: [malicious] })));
  await f.query('PART-A');
  assert.match(f.node('mesVisionRows').textContent, /<img src=x/);
  assert.equal(f.node('mesVisionWarnings').textContent, malicious);
  assert.equal(f.htmlWrites.length, 1);
  assert.doesNotMatch(f.htmlWrites[0], /<img src=x/);
});

test('a late process response or 401 from an earlier scan cannot replace or expire the latest result', async () => {
  const old = gate();
  const f = fixture(url => url.includes('barcode=OLD') ? old.promise : response(url.includes('/processes?') ? processResponse('NEW') : detailResponse('NEW')));
  const first = f.query('OLD');
  await f.query('NEW');
  assert.equal(f.requests[0].options.signal.aborted, true);
  old.resolve(response({ message: 'old session expired' }, 401)); await first;
  assert.equal(f.node('mesVisionResultBarcode').textContent, 'NEW');
  assert.deepEqual(f.events, []);
  assert.equal(f.node('mesVisionResult').hidden, false);
});

test('logout aborts an in-flight detail and clears private result and barcode fields', async () => {
  const waiting = gate(), started = gate();
  const f = fixture(url => { if (url.includes('/processes?')) return response(processResponse()); started.resolve(); return waiting.promise; });
  const reading = f.query('PART-A');
  await started.promise;
  assert.equal(f.requests.length, 2);
  f.api.setContext(null, false);
  assert.equal(f.requests[1].options.signal.aborted, true);
  assert.equal(f.node('mesVisionBarcode').value, '');
  assert.equal(f.node('mesVisionWorkbench').hidden, true);
  assert.equal(f.node('mesVisionRows').children.length, 0);
  f.api.setContext({ ...account, account: 'different-user' }, true);
  waiting.resolve(response(detailResponse())); await reading;
  assert.equal(f.node('mesVisionResult').hidden, true);
  assert.equal(f.node('mesVisionResultBarcode').textContent, '');
});

test('rework parameters remain separate and never replace source actual values or source decisions', async () => {
  const f = fixture(url => response(url.includes('/processes?') ? processResponse() : detailResponse('PART-A', 'P1', { measurements: [{ name: 'P', actual: 1.4, lowerLimit: -1, upperLimit: 1, result: 'NG', originResult: 'OK', reworkActual: 0.3, isRework: true }] })));
  await f.query('PART-A');
  assert.equal(f.node('mesVisionColumns').textContent, '测点名称来源实测值下限上限返工参数来源判定');
  const row = f.node('mesVisionRows').children[0];
  assert.equal(row.children[1].textContent, '1.4');
  assert.equal(row.children[4].textContent, '0.3');
  assert.equal(row.children[5].textContent, 'NG原始判定：OK有返工标记');
  assert.match(f.node('mesVisionCounts').textContent, /1NG0OK/);
});

test('current portal 401 clears the panel while upstream errors remain visible without ending the portal session', async () => {
  const expired = fixture(() => response({ message: 'session expired' }, 401));
  await expired.query('PART-A');
  assert.deepEqual(expired.events, ['portal:session-expired']);
  assert.equal(expired.node('mesVisionWorkbench').hidden, true);
  assert.equal(expired.node('mesVisionBarcode').value, '');
  const upstream = fixture(() => response({ message: '公司系统账号需要重新连接。' }, 428));
  await upstream.query('PART-A');
  assert.deepEqual(upstream.events, []);
  assert.match(upstream.node('mesVisionMessage').textContent, /重新连接/);
  assert.equal(upstream.node('mesVisionMessage').attributes.role, 'alert');
  assert.equal(upstream.node('mesVisionSubmit').disabled, false);
});

test('empty, malformed or mismatched responses cannot reuse old details', async () => {
  let mode = 'valid';
  const f = fixture(url => response(url.includes('/processes?') ? processResponse('PART-A', mode === 'empty' ? [] : [{ id: 'P1', name: '工序' }]) : mode === 'wrong' ? detailResponse('PART-B') : detailResponse()));
  await f.query('PART-A');
  mode = 'wrong'; await f.query('PART-A');
  assert.equal(f.node('mesVisionResult').hidden, true);
  assert.equal(f.node('mesVisionRows').children.length, 0);
  assert.match(f.node('mesVisionMessage').textContent, /不一致/);
  mode = 'empty'; await f.query('PART-A');
  assert.match(f.node('mesVisionMessage').textContent, /未返回.*工序/);
  const count = f.requests.length;
  await f.query(' '); await f.query('A\u0000B');
  assert.equal(f.requests.length, count);
});

test('changing the draft barcode keeps its result explicitly identified and clear cancels work', async () => {
  const f = fixture(); await f.query('PART-A');
  f.node('mesVisionBarcode').value = 'PART-B'; f.fire('mesVisionBarcode', 'input');
  assert.equal(f.node('mesVisionDraft').hidden, false);
  assert.equal(f.node('mesVisionResultBarcode').textContent, 'PART-A');
  f.fire('mesVisionClear', 'click');
  assert.equal(f.node('mesVisionBarcode').value, '');
  assert.equal(f.node('mesVisionResult').hidden, true);
  assert.equal(f.node('mesVisionDraft').hidden, true);
  assert.equal(f.node('mesVisionBarcode').focused, true);
});

test('timeout is reported and leaving the vision route prevents a late result from appearing', async () => {
  const timeout = fixture((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); })));
  const reading = timeout.query('PART-A');
  [...timeout.timers.values()][0](); await reading;
  assert.match(timeout.node('mesVisionMessage').textContent, /超时/);
  assert.equal(timeout.node('mesVisionSubmit').disabled, false);
  const late = gate(), f = fixture(() => late.promise);
  const pending = f.query('PART-A'); f.api.setContext(account, false);
  assert.equal(f.requests[0].options.signal.aborted, true);
  late.resolve(response(processResponse())); await pending;
  f.api.setContext(account, true);
  assert.equal(f.requests.length, 1);
  assert.equal(f.node('mesVisionResult').hidden, true);
});
