'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Calendar = require('../public/company-calendar.js');

const account = {authenticated:true,account:'synthetic-member',role:'member'};
const totals = {total:10,passed:7,failed:2,unknown:1,rate:7/9*100,rateAvailable:true,feedbackCount:3};
const feedback = {total:0,passed:0,failed:0,unknown:0,rate:null,rateAvailable:false,feedbackCount:3};
function report(changes = {}) {
  return {enabled:true,years:[2026],filters:{year:2026,month:'',week:'',category:'all',product:''},summary:{...totals},months:[{month:'2026-10',...totals}],products:[{code:'P-A123',name:'PRIVATE-PRODUCT-NAME',...totals}],categories:[{id:'bracket',...totals},{id:'full',...feedback}],sync:{state:'ready',lastSuccessAt:'2026-10-15T08:00:00Z',lastAttemptAt:'2026-10-15T08:00:00Z'},methodology:'首次检测合格率 = 快切初检合格 /（快切初检合格 + 不合格）。未判定不入分母；全切缺少总检测数，异常反馈单独统计。',...changes};
}
function response(data,status = 200) { return {ok:status >= 200 && status < 300,status,json:async () => data}; }
function gate() { let resolve;const promise = new Promise(yes => { resolve = yes; });return {promise,resolve}; }
function fixture(fetcher = () => response(report()),existing = new Map()) {
  const nodes = new Map(),timers = new Map(),listeners = new Map(),events = [],requests = [];let timerId = 0;
  function node(id) {
    if (!nodes.has(id)) {
      const callbacks = new Map();
      nodes.set(id,{id,hidden:id === 'penetrationWorkbench',value:'',innerHTML:'',textContent:'',disabled:false,scrollLeft:0,scrollTop:0,dataset:{},callbacks,
        setAttribute(){},contains:() => false,querySelector:() => null,focus(){},addEventListener(type,callback){callbacks.set(type,callback);}});
    }
    return nodes.get(id);
  }
  const document = {getElementById:node,hidden:false,activeElement:null,addEventListener(type,callback){listeners.set(type,callback);},dispatchEvent(event){events.push(event.type);listeners.get(event.type)?.(event);}};
  const window = {PortalCalendar:Calendar,addEventListener(){}};
  const context = vm.createContext({window,document,URLSearchParams,AbortController,CustomEvent:class { constructor(type) {this.type = type;} },
    sessionStorage:{getItem:key => existing.get(key)||null,setItem:(key,value) => existing.set(key,value),removeItem:key => existing.delete(key)},
    setTimeout:(callback,delay) => {const id = ++timerId;timers.set(id,{callback,delay});return id;},clearTimeout:id => timers.delete(id),
    fetch:async (url,options) => {requests.push({url,options});return fetcher(url,options);}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/penetration.js'),'utf8'),context);
  const api = window.PenetrationWorkbench;
  return {api,node,document,events,requests,timers,storage:existing,html:() => [...nodes.values()].map(value => value.innerHTML+' '+value.textContent).join('\n'),
    fire:(id,type,event = {}) => node(id).callbacks.get(type)?.({preventDefault(){},...event}),
    async poll(delay = 30000) {const [id,value] = [...timers].find(([,item]) => item.delay === delay) || [];assert.ok(value,'expected automatic refresh timer');timers.delete(id);return value.callback();}};
}

test('renders only product aliases and keeps first-pass metrics separate from full-cut feedback',async () => {
  const f = fixture();await f.api.setContext(account,true);
  assert.equal(f.node('penetrationWorkbench').hidden,false);
  assert.match(f.node('penStats').innerHTML,/首次检测合格率/);assert.match(f.node('penStats').innerHTML,/77\.78%/);
  assert.match(f.node('penStats').innerHTML,/全切异常反馈/);assert.match(f.node('penCategories').innerHTML,/不计算首次检测合格率/);
  assert.match(f.node('penProducts').innerHTML,/P-A123/);assert.doesNotMatch(f.html(),/PRIVATE-PRODUCT-NAME/);
  assert.equal(f.node('penAnalysis').hidden,false);
});

test('full-cut feedback without an initial-test denominator stays visible with no fabricated pass rate',async () => {
  const f = fixture(() => response(report({filters:{year:2026,category:'full'},summary:feedback,months:[{month:'2026-10',...feedback}],products:[{code:'P-A123',...feedback}],categories:[{id:'full',...feedback}]})));
  await f.api.setContext(account,true);
  assert.equal(f.node('penAnalysis').hidden,false);assert.equal(f.node('penEmpty').hidden,true);
  assert.doesNotMatch(f.node('penStats').innerHTML,/100%|0%/);assert.match(f.node('penStats').innerHTML,/全切异常反馈/);
  assert.match(f.node('penProducts').innerHTML,/data-label="全切反馈">3</);
});

test('unconfigured and empty states do not claim a healthy connection or full pass rate',async () => {
  const f = fixture(() => response(report({enabled:false,summary:{...feedback,feedbackCount:0},months:[],products:[],categories:[],sync:{state:'unconfigured'}})));
  await f.api.setContext(account,true);
  assert.match(f.node('penSourceTitle').textContent,/尚未接入/);assert.equal(f.node('penAnalysis').hidden,true);assert.equal(f.node('penRefresh').disabled,true);
  assert.doesNotMatch(f.node('penStats').innerHTML,/<strong>0<|100%/);
});

test('automatic and manual synchronization use applied filters without overwriting a draft',async () => {
  const f = fixture((url,options) => options.method === 'POST' ? response({sync:{state:'ready'}}) : response(report()));
  await f.api.setContext(account,true);
  f.node('penMonth').value='2026-09';await f.fire('penMonth','change');
  assert.equal(f.node('penDraftHint').hidden,false);
  await f.api.setContext(account,true);assert.equal(f.requests.length,1,'status ticks do not reload report or controls');
  await f.poll();assert.equal(new URL(f.requests.at(-1).url,'http://fixture').searchParams.get('month'),'');
  assert.equal(f.node('penMonth').value,'2026-09');
  await f.fire('penRefresh','click');
  assert.equal(f.requests.at(-2).url,'/local/penetration/sync');assert.equal(f.requests.at(-2).options.method,'POST');
  assert.equal(f.requests.at(-2).options.body,'{}');assert.equal(new URL(f.requests.at(-1).url,'http://fixture').searchParams.get('month'),'');
  assert.equal(f.node('penMonth').value,'2026-09');assert.equal(f.node('penDraftHint').hidden,false);
});

test('a submitted company week uses the confirmed Friday–Thursday range and excludes month',async () => {
  const f = fixture(url => {const params = new URL(url,'http://fixture').searchParams;return response(report({filters:{year:2026,month:params.get('month')||'',week:params.get('week')||'',category:'all',product:''}}));});
  await f.api.setContext(account,true);
  f.node('penMonth').value='2026-10';await f.fire('penMonth','change');f.node('penWeek').value='2026-KW41';await f.fire('penWeek','change');
  assert.equal(f.node('penMonth').value,'');await f.fire('penQueryForm','submit');
  const query = new URL(f.requests.at(-1).url,'http://fixture').searchParams;
  assert.equal(query.get('week'),'2026-KW41');assert.equal(query.get('month'),'');assert.match(f.node('penScope').textContent,/2026-10-02 至 2026-10-08/);
  await f.fire('penNextWeek','click');assert.equal(new URL(f.requests.at(-1).url,'http://fixture').searchParams.get('week'),'2026-KW42');
  await f.fire('penPreviousWeek','click');assert.equal(new URL(f.requests.at(-1).url,'http://fixture').searchParams.get('week'),'2026-KW41');
  f.node('penMonth').value='2026-09';await f.fire('penMonth','change');assert.equal(f.node('penWeek').value,'');
});

test('failed reads preserve snapshot and scope, while malformed aliases never appear in the UI',async () => {
  let next = response(report());const f = fixture(() => next);await f.api.setContext(account,true);
  const before = f.node('penProducts').innerHTML,scope = f.node('penScope').textContent;
  next = response({message:'PRIVATE-PATH'},503);await f.poll();
  assert.equal(f.node('penProducts').innerHTML,before);assert.equal(f.node('penScope').textContent,scope);assert.equal(f.node('penError').hidden,false);assert.doesNotMatch(f.html(),/PRIVATE-PATH/);
  next = response(report({products:[{code:'PRIVATE-PRODUCT-NAME',...totals}]}));await f.poll();
  assert.equal(f.node('penProducts').innerHTML,before);assert.match(f.node('penError').textContent,/格式未通过校验/);assert.doesNotMatch(f.html(),/PRIVATE-PRODUCT-NAME/);
});

test('logout and 401 clear visible data, stored filters and pending refreshes',async () => {
  let expired = false;const f = fixture(() => expired ? response({},401) : response(report()));
  await f.api.setContext(account,true);assert.equal(f.storage.size,1);
  expired=true;await f.poll();
  assert.equal(f.node('penetrationWorkbench').hidden,true);assert.equal(f.node('penProducts').innerHTML,'');assert.equal(f.storage.size,0);assert.equal(f.timers.size,0);assert.deepEqual(f.events,['portal:session-expired']);
});

test('late responses after leaving the module or changing accounts cannot overwrite the current account',async () => {
  const pending = gate();let calls = 0;
  const f = fixture(() => ++calls === 1 ? pending.promise : response(report({products:[{code:'P-B456',...totals}]})));
  const first = f.api.setContext(account,true);
  await f.api.setContext({...account,account:'synthetic-second'},true);
  pending.resolve(response(report()));await first;
  assert.match(f.node('penProducts').innerHTML,/P-B456/);assert.doesNotMatch(f.node('penProducts').innerHTML,/P-A123/);
  assert.equal(f.storage.size,1);assert.match([...f.storage.keys()][0],/synthetic-second/);
  f.api.setContext(null,false);assert.equal(f.node('penProducts').innerHTML,'');
});

test('only filters persist and a new page restores its account query without saving business results',async () => {
  const stored = new Map([['portal:penetration:filters:v1:synthetic-member',JSON.stringify({year:2026,month:'',week:'2026-KW41',category:'bracket',product:'P-A123'})]]);
  const f = fixture(url => {const params=Object.fromEntries(new URL(url,'http://fixture').searchParams);return response(report({filters:params}));},stored);
  await f.api.setContext(account,true);
  const query = new URL(f.requests[0].url,'http://fixture').searchParams;assert.equal(query.get('week'),'2026-KW41');assert.equal(query.get('category'),'bracket');
  assert.deepEqual(Object.keys(JSON.parse([...stored.values()][0])).sort(),['category','month','product','week','year']);assert.doesNotMatch([...stored.values()][0],/passed|summary|77/);
});

test('syncing status polls until a completed snapshot arrives without another sync POST',async () => {
  let reads = 0;const f = fixture(() => response(report({sync:{state:++reads === 1 ? 'syncing' : 'ready',lastSuccessAt:'2026-10-15T08:00:00Z'}})));
  await f.api.setContext(account,true);assert.match(f.node('penSourceTitle').textContent,/正在同步/);
  await f.poll(2000);assert.equal(reads,2);assert.match(f.node('penSourceTitle').textContent,/已保存/);
  assert.equal(f.requests.filter(request => request.options.method === 'POST').length,0);assert.ok([...f.timers.values()].some(timer => timer.delay === 30000));
});

test('coverage problems remain visible and retest conclusions do not alter first-pass results',async () => {
  const f = fixture(() => response(report({summary:{...totals,retestPassed:3,retestFailed:1,retestUnknown:9},diagnostics:{files:12,read:4,failed:1,conflicts:2,unsupportedSheets:3,templateRows:200,PRIVATE_FILE_NAME:99}})));
  await f.api.setContext(account,true);
  assert.equal(f.node('penCoverageWarning').hidden,false);assert.match(f.node('penCoverageWarning').textContent,/读取失败项 1.*冲突记录 2.*未识别工作表 3/);
  assert.doesNotMatch(f.node('penCoverageWarning').textContent,/模板|200/);assert.match(f.node('penDiagnostics').innerHTML,/排除预填模板行/);
  assert.match(f.node('penRetests').innerHTML,/未记录复检结论<\/dt><dd>9/);assert.match(f.node('penRetests').innerHTML,/不表示已安排或尚待复检/);
  assert.match(f.node('penStats').innerHTML,/77\.78%/);assert.doesNotMatch(f.html(),/PRIVATE_FILE_NAME/);
});

test('a server product option outside the filtered rows remains selectable by its alias',async () => {
  const f = fixture(() => response(report({productOptions:['P-A123','P-B456']})));await f.api.setContext(account,true);
  assert.match(f.node('penProduct').innerHTML,/P-B456/);assert.doesNotMatch(f.node('penProducts').innerHTML,/P-B456/);
});

test('partial reads and explicit incomplete states show saved data without claiming full annual coverage',async () => {
  for (const change of [
    {sync:{state:'error',lastSuccessAt:'2026-10-10T08:00:00Z',lastAttemptAt:'2026-10-15T08:00:00Z'},diagnostics:{files:20,failed:2}},
    {sync:{state:'incomplete',lastSuccessAt:null,lastAttemptAt:'2026-10-15T08:00:00Z'}},
    {complete:false,sync:{state:'ready'}},
    {sync:{state:'ready'},diagnostics:{staleFiles:3,incompleteGroups:1}}
  ]) {
    const f = fixture(() => response(report(change)));await f.api.setContext(account,true);
    assert.equal(f.node('penSourceTitle').textContent,'部分来源未同步完成');
    assert.match(f.node('penSourceMessage').textContent,/可能包含上次缓存.*不代表完整年度检测/);
    assert.match(f.node('penProducts').innerHTML,/P-A123/);assert.match(f.node('penStats').innerHTML,/77\.78%/);
    assert.equal(f.node('penAnalysis').hidden,false);assert.match(f.html(),/已读取记录 · 月度趋势/);
    if(change.diagnostics)assert.equal(f.node('penCoverageWarning').hidden,false);
    if(change.diagnostics?.staleFiles){assert.match(f.node('penCoverageWarning').textContent,/旧规则缓存待重读（未计入） 3/);assert.match(f.node('penCoverageWarning').textContent,/不完整月份\/类别 1/);}
  }
});

test('supporting inspection reports are explained as deliberate exclusions without a coverage warning',async () => {
  const f = fixture(() => response(report({diagnostics:{supportingSheets:17,supportingWorkbooks:6}})));await f.api.setContext(account,true);
  assert.equal(f.node('penCoverageWarning').hidden,true);assert.equal(f.node('penSourceTitle').textContent,'已保存的熔深统计');
  assert.match(f.node('penDiagnostics').innerHTML,/排除独立报告工作表<\/dt><dd>17/);assert.match(f.node('penDiagnostics').innerHTML,/排除独立报告文件<\/dt><dd>6/);
  assert.match(f.node('penCoverage').textContent,/全切仅纳入异常反馈汇总；独立检测报告不混算/);
  assert.match(f.node('penStats').innerHTML,/77\.78%/);
});
