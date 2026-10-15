'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const QueryState = require('../public/portal-state.js');

// A small DOM fixture exercises the actual asynchronous request/error handlers.
// Layout and native browser behavior are verified separately in browser QA.
function fixture(fetchResponse) {
  const nodes = new Map(), callbacks = new Map(), storage = new Map(), requests = [];
  let nextTimer = 1;
  function node(selector) {
    if (!nodes.has(selector)) {
      const classes = new Set();
      nodes.set(selector, {
        id: selector.slice(1), tagName: /Filter$|#rangeMode|#pageSize/.test(selector) ? 'SELECT' : 'DIV',
        value: /Filter$/.test(selector) ? 'all' : '', innerHTML: '', textContent: '', hidden: false, disabled: false,
        open: false, files: [], children: [], scrollLeft: 0, scrollTop: 0, options: [{ value: 'all', textContent: '全部' }],
        get selectedOptions() { return this.options.filter(option => option.value === this.value); },
        classList: { add: (...values) => values.forEach(value => classes.add(value)), remove: (...values) => values.forEach(value => classes.delete(value)), toggle: (value, on) => on ? classes.add(value) : classes.delete(value), contains: value => classes.has(value) },
        addEventListener() {}, setAttribute() {}, removeAttribute() {}, querySelectorAll: () => [],
        contains: () => false, close() { this.open = false; }, before() {}, after() {}, focus() {},
        add(option) { this.options.push(option); }
      });
    }
    return nodes.get(selector);
  }
  const document = { querySelector: node, querySelectorAll: () => [], getElementById: id => node('#' + id),
    hidden: false, activeElement: null, body: node('body'), addEventListener() {} };
  const window = { PortalState: QueryState, addEventListener() {}, scrollX: 0, scrollY: 0, scrollTo() {} };
  const context = vm.createContext({ window, document, location: { hash: '#weld-live', href: 'http://portal.test/' },
    Option: class { constructor(label, value) { this.textContent = label; this.value = value; } }, AbortController, URL, URLSearchParams,
    sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    setTimeout: callback => { const id = nextTimer++; callbacks.set(id, callback); return id; }, clearTimeout: id => callbacks.delete(id),
    fetch: async url => { requests.push(url); return fetchResponse(url); } });
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const bootstrap = 'switchModule();checkStatus({read:true});';
  assert.ok(source.includes(bootstrap), 'fixture must replace only the normal application bootstrap');
  vm.runInContext(source.replace(bootstrap, 'window.testApp={state,queries,loadData,queryChanged};'), context);
  const app = window.testApp;
  const query = QueryState.normalizeQuery({ rolling: false, start: '2026-10-01', end: '2026-10-14', keyword: '已提交条件' }, 'weld', '2026-10-15');
  Object.assign(app.state, { authenticated: true, connected: true, polling: true,
    status: { authenticated: true, account: 'fixture-employee', role: 'member', sourceStatus: { state: 'ready', configured: true } },
    result: { data: { rows: [{ id: 'private-old-row' }], columns: [{ key: 'id' }], total: 1, page: 1, size: 50 }, query, successAt: '2026-10-15T08:00:00Z' } });
  app.queries.account = 'fixture-employee';app.queries.modules.weld = { query, polling: true, interval: 30, history: [] };
  node('#rangeMode').value = 'custom';node('#startDate').value = query.start;node('#endDate').value = query.end;node('#keywordInput').value = query.keyword;
  node('#appShell').hidden = false;node('#loginScreen').hidden = true;
  return { app, node, requests, callbacks, storage };
}

test('data 401 clears private state and immediately returns to login after request cancellation', async () => {
  const f = fixture(() => ({ ok: false, status: 401, json: async () => ({ message: 'expired' }) }));
  await f.app.loadData('manual');
  assert.equal(f.app.state.request, null);
  assert.equal(f.app.state.result, null);
  assert.equal(f.app.state.authenticated, false);
  assert.equal(f.node('#appShell').hidden, true);
  assert.equal(f.node('#loginScreen').hidden, false);
  assert.equal(f.node('#loginError').hidden, false);
  assert.match(f.node('#loginError').textContent, /登录已过期/);
  assert.equal(f.callbacks.size, 0, 'expired sessions must not retain polling timers');
  assert.equal(f.storage.size, 0, 'account query state is removed on expiry');
});

test('invalid date submission keeps automatic refresh alive on the committed query', async () => {
  const f = fixture(() => ({ ok: true, status: 200, json: async () => ({ rows: [], total: 0, page: 1, size: 50 }) }));
  f.node('#startDate').value = '2026-10-20';f.node('#endDate').value = '2026-10-15';f.node('#keywordInput').value = '尚未提交草稿';
  f.app.queryChanged();
  assert.equal(f.requests.length, 0, 'invalid dates must never reach the API');
  assert.equal(f.node('#queryError').hidden, false);assert.match(f.node('#queryError').textContent, /开始日期不能晚于/);
  assert.equal(f.app.state.polling, true);assert.ok(f.app.state.timer);assert.equal(f.node('#queryButton').disabled, false);
  const poll = f.callbacks.get(f.app.state.timer);assert.equal(typeof poll, 'function');await poll();
  const url = new URL(f.requests[0], 'http://portal.test');
  assert.equal(url.searchParams.get('start'), '2026-10-01');assert.equal(url.searchParams.get('end'), '2026-10-14');assert.equal(url.searchParams.get('keyword'), '已提交条件');
  assert.equal(f.node('#startDate').value, '2026-10-20');assert.equal(f.node('#keywordInput').value, '尚未提交草稿');
  assert.equal(f.app.state.polling, true);assert.ok(f.app.state.timer);
});

test('resolved product names update the applied query and its unchanged login-session controls',async()=>{
  const old='P-1234567890ABCDEF',name='合成产品 <A&B>';
  const f=fixture(()=>({ok:true,status:200,json:async()=>({rows:[],total:0,resolvedQuery:{materialName:name,keyword:name,defects:[name+'_缺陷']}})}));
  Object.assign(f.app.queries.modules.weld.query,{materialName:old,keyword:old,defects:[old+'_缺陷']});
  f.app.state.defects=[old+'_缺陷'];f.app.state.defectDraft=[old+'_缺陷'];
  f.node('#materialFilter').options.push({value:old,textContent:old});f.node('#materialFilter').value=old;f.node('#keywordInput').value=old;
  await f.app.loadData('manual');
  assert.equal(f.app.state.result.query.materialName,name);assert.equal(f.app.state.result.query.keyword,name);
  assert.equal(f.node('#materialFilter').value,name);assert.equal(f.node('#keywordInput').value,name);
  assert.deepEqual([...f.app.state.result.query.defects],[name+'_缺陷']);assert.deepEqual([...f.app.state.defects],[name+'_缺陷']);assert.deepEqual([...f.app.state.defectDraft],[name+'_缺陷']);
});

test('resolved product names do not overwrite a keyword draft changed during the request',async()=>{
  let release;const pending=new Promise(resolve=>{release=resolve});
  const f=fixture(()=>pending),old='P-1234567890ABCDEF';
  f.app.queries.modules.weld.query.keyword=old;f.node('#keywordInput').value=old;
  const task=f.app.loadData('manual');f.node('#keywordInput').value='新草稿';
  release({ok:true,status:200,json:async()=>({rows:[],total:0,resolvedQuery:{keyword:'合成来源名称'}})});await task;
  assert.equal(f.app.state.result.query.keyword,'合成来源名称');assert.equal(f.node('#keywordInput').value,'新草稿');
});
