'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createInventoryConnector} = require('../lib/inventory-source.cjs');

const ACTOR = {account:'000123',name:'合成测试成员',role:'member'};
const ROW = {id:'original-id',bjbh:'000456',bjmc:'合成备件',sparepartName:'定位销',specifications:'S-1',
  price:12,manufacturer:'合成厂商',location:'L-1',unit:'个',isSubstitution:'0',isStandard:'1',nowStock:8,
  deleteMark:0,customSystemField:'keep-original',__derived:'must-not-send'};
const reply = (body = {code:0},status = 200) => ({ok:status>=200&&status<300,status,json:async()=>body});
function fixture(options = {}) {
  const config = {apiBase:'https://company.example.invalid/',tenantId:'synthetic-tenant',
    inventoryScope:{records:[{code:'000456',name:'合成备件',specification:'S-1'}]},
    inventoryConnection:{profile:options.profile||'power-udp',warehouseKey:'gongyi-spares',label:'工艺部备件库',writes:{inbound:true,outbound:true,adjust:true}},
    ...options.config};
  const session = {token:'synthetic-token',sourceCache:new Map([['old',1]]),sourcePending:new Map([['old',1]])};
  const calls = [], reads = [];
  const state = {rows:options.rows||[structuredClone(ROW)],complete:options.complete!==false};
  const connector = createInventoryConnector(config,{allRows:async(...args)=>{reads.push(args);return options.allRows ? options.allRows(...args) : {...state,fetchedAt:'synthetic-time'};},
    fetchImpl:async(...args)=>{calls.push(args);return options.fetchImpl ? options.fetchImpl(...args) : reply();}});
  const catalog = () => connector.inventoryCatalog({fresh:true},session);
  async function operation(extra = {}) {
    const result = await catalog();
    return {item:structuredClone(result.rows[0]),quantity:2,actualQuantity:6,beforeStock:8,actor:ACTOR,requestId:'synthetic-request-001',reason:'合成原因',sourceIdentity:result.sourceIdentity,...extra};
  }
  return {connector,config,session,calls,reads,state,catalog,operation};
}
const commonBody = {pid:ROW.id,sparepartName:ROW.sparepartName,bjbh:ROW.bjbh,bjmc:ROW.bjmc,specifications:ROW.specifications,
  price:ROW.price,manufacturer:ROW.manufacturer,location:ROW.location,unit:ROW.unit,isSubstitution:0,isStandard:1};

test('UDP inbound sends precisely the observed increment body and accepts code 0 without inventing a receipt',async()=>{
  const f=fixture(), op=await f.operation();
  const result=await f.connector.inventoryWrite('inbound',op,f.session);
  assert.deepEqual(result,{confirmed:true,acknowledgement:'company-success'});
  assert.equal(Object.hasOwn(result,'receiptId'),false);
  const [url,request]=f.calls[0];
  assert.equal(url.pathname,'/api/UDP_SparepartsInStock');
  assert.equal(request.method,'POST');
  assert.equal(request.redirect,'error');
  assert.deepEqual(JSON.parse(request.body),{...commonBody,inType:1,inNumber:2});
  assert.equal(f.session.sourceCache.size,0);
  assert.equal(f.session.sourcePending.size,0);
  assert.deepEqual(f.reads[0].slice(0,2),['spares',{}]);
  await assert.rejects(f.connector.inventoryWrite('inbound',op,f.session),e=>e.status===409);
  assert.equal(f.calls.length,1);
});

test('UDP outbound maps trusted actor name and does not send unverified account/request/stock/region fields',async()=>{
  const f=fixture(),op=await f.operation({outPeople:'forged',operatorName:'forged',region:'not-a-warehouse'});
  await f.connector.inventoryWrite('outbound',op,f.session);
  const [url,request]=f.calls[0];
  assert.equal(url.pathname,'/api/UDP_SparepartsOutStock');
  assert.deepEqual(JSON.parse(request.body),{...commonBody,outType:1,outNumber:2,outPeople:ACTOR.name,isReplace:0,remark:'合成原因'});
  assert.equal(f.calls.length,1); // No request to the power department portal log.
});

test('both profiles adjust using the fresh complete raw row and change only nowStock, omitting derived fields',async()=>{
  for(const profile of ['power-udp','power-mold']) {
    const f=fixture({profile}),op=await f.operation({actualQuantity:0});
    await f.connector.inventoryWrite('adjust',op,f.session);
    const [url,request]=f.calls[0],expected={...ROW,nowStock:0};delete expected.__derived;
    assert.equal(url.pathname,`/api/${profile==='power-udp'?'UDP':'Mold'}_SparepartsDetailed`);
    assert.equal(request.method,'PUT');
    assert.deepEqual(JSON.parse(request.body),expected);
  }
});

test('Mold inbound copies its original raw row and adds pid/type/quantity without borrowing UDP fields',async()=>{
  const f=fixture({profile:'power-mold'}),op=await f.operation();
  await f.connector.inventoryWrite('inbound',op,f.session);
  const [url,request]=f.calls[0],expected={...ROW,pid:ROW.id,inType:1,inNumber:2};delete expected.__derived;
  assert.equal(url.pathname,'/api/Mold_SparepartsInStock');
  assert.equal(request.method,'POST');
  assert.deepEqual(JSON.parse(request.body),expected);
});

test('Mold outbound is disabled even when configured true; unrecognized profile cannot fall back to custom writes',async()=>{
  for(const profile of ['power-mold','power-other']) {
    const f=fixture({profile});
    assert.equal(f.connector.inventoryCapabilities().outbound.enabled,false);
    await assert.rejects(f.connector.inventoryWrite('outbound',{item:ROW},f.session),e=>e.status===503);
    assert.equal(f.calls.length,0);
  }
});

test('profile write flags require boolean true and disabling after catalog takes effect before dispatch',async()=>{
  for(const flag of [false,undefined,'true',1]) {
    const f=fixture();f.config.inventoryConnection.writes.inbound=flag;
    assert.equal(f.connector.inventoryCapabilities().inbound.enabled,false);
    await assert.rejects(f.connector.inventoryWrite('inbound',await f.operation(),f.session),e=>e.status===503);
    assert.equal(f.calls.length,0);
  }
  const f=fixture(),op=await f.operation();f.config.inventoryConnection.writes.inbound=false;
  await assert.rejects(f.connector.inventoryWrite('inbound',op,f.session),e=>e.status===503);
  assert.equal(f.calls.length,0);
});

test('stable warehouseKey is mandatory for new profiles without fetching a selectable catalog',async()=>{
  for(const key of [undefined,'','bad/key','a'.repeat(81)]) {
    const f=fixture();f.config.inventoryConnection.warehouseKey=key;
    assert.equal(f.connector.inventoryCapabilities().inbound.enabled,false);
    const result=await f.catalog();
    assert.deepEqual(result.rows,[]);assert.equal(result.complete,false);assert.match(result.note,/仓库标识/);
    assert.equal(f.reads.length,0);
  }
});

test('catalog excludes deleted and outside-scope rows before matching; identical codes preserve separate ids',async()=>{
  const f=fixture({rows:[ROW,{...ROW,id:'second-id'},{...ROW,id:'deleted',deleteMark:1},{...ROW,id:'deleted-string',deleteMark:'1'},
    {...ROW,id:'foreign',bjbh:'OTHER',specifications:'OTHER'},null]});
  const result=await f.catalog();
  assert.deepEqual(result.rows.map(r=>r.id),['original-id','second-id']);
  assert.equal(result.inventoryLabel,'工艺部备件库');assert.equal(result.inventoryProfile,'power-udp');
  assert.match(result.sourceIdentity,/^[a-f0-9]{64}$/);
  f.state.rows=[{...ROW,deleteMark:true}];
  const deleted=await f.catalog();assert.equal(deleted.unmatched.length,1);
});

test('sourceIdentity stays stable when stock, scope membership/order or display label changes',async()=>{
  const f=fixture(),initial=await f.catalog();
  f.state.rows[0].nowStock=6;
  f.config.inventoryConnection.label='工艺部仓库新显示名';
  f.config.inventoryScope.records.push({code:'NEW',name:'新增',specification:'S-2'});
  f.config.inventoryScope.records.reverse();
  const result=await f.catalog();
  assert.equal(result.sourceIdentity,initial.sourceIdentity);
  assert.equal(result.inventoryLabel,'工艺部仓库新显示名');
  f.config.apiBase='https://COMPANY.example.invalid:443';
  assert.equal((await f.catalog()).sourceIdentity,initial.sourceIdentity);
});

test('sourceIdentity distinguishes upstream origin/base, tenant, profile and stable warehouseKey',async()=>{
  const base=await fixture().catalog();
  for(const mutate of [f=>f.config.apiBase='https://other.example.invalid/',f=>f.config.apiBase='https://company.example.invalid/other-base',
    f=>f.config.tenantId='other-tenant',f=>f.config.inventoryConnection.profile='power-mold',f=>f.config.inventoryConnection.warehouseKey='other-warehouse']) {
    const f=fixture();mutate(f);assert.notEqual((await f.catalog()).sourceIdentity,base.sourceIdentity);
  }
});

test('new profile refuses missing/wrong sourceIdentity, another session, and an item copied from another profile',async()=>{
  const f=fixture(),op=await f.operation();
  for(const attempt of [{...op,sourceIdentity:undefined},{...op,sourceIdentity:'0'.repeat(64)}]) {
    await assert.rejects(f.connector.inventoryWrite('inbound',attempt,f.session),e=>e.status===409);
  }
  await assert.rejects(f.connector.inventoryWrite('inbound',op,{token:'another-session'}),e=>e.status===409);
  const mold=fixture({profile:'power-mold'});await mold.catalog();
  await assert.rejects(mold.connector.inventoryWrite('inbound',op,mold.session),e=>e.status===409);
  assert.equal(f.calls.length+mold.calls.length,0);
});

test('missing, duplicate, changed or out-of-scope original item cannot be written even with correct identity',async()=>{
  const f=fixture(),op=await f.operation();
  for(const item of [{...op.item,id:''},{...op.item,id:'not-loaded'},{...op.item,nowStock:99},{...op.item,bjbh:'OUTSIDE'},{...op.item,location:'other'}]) {
    await assert.rejects(f.connector.inventoryWrite('adjust',{...op,item},f.session),e=>e.status===409);
  }
  const duplicate=fixture({rows:[ROW,{...ROW,location:'different'}]}),dup=await duplicate.operation();
  await assert.rejects(duplicate.connector.inventoryWrite('inbound',dup,duplicate.session),e=>e.status===409);
  assert.equal(f.calls.length+duplicate.calls.length,0);
});

test('scope changes preserve external identity but invalidate the internal loaded snapshot until refreshed',async()=>{
  const f=fixture(),op=await f.operation();
  f.config.inventoryScope.records.push({code:'NEW',name:'new',specification:''});
  await assert.rejects(f.connector.inventoryWrite('inbound',op,f.session),e=>e.status===409);
  const fresh=await f.operation();assert.equal(fresh.sourceIdentity,op.sourceIdentity);
  await f.connector.inventoryWrite('inbound',fresh,f.session);assert.equal(f.calls.length,1);
});

test('configuration change between read and dispatch cannot use the old row against another source',async()=>{
  const f=fixture(),op=await f.operation();f.config.inventoryConnection.profile='power-mold';
  await assert.rejects(f.connector.inventoryWrite('inbound',op,f.session),e=>e.status===409);
  assert.equal(f.calls.length,0);
});

test('incomplete catalog and snapshot stock mismatch fail before external writes',async()=>{
  const incomplete=fixture({complete:false}),op=await incomplete.operation();
  await assert.rejects(incomplete.connector.inventoryWrite('inbound',op,incomplete.session),e=>e.status===409);
  const f=fixture(),fresh=await f.operation();
  await assert.rejects(f.connector.inventoryWrite('inbound',{...fresh,beforeStock:7},f.session),e=>e.status===409);
  await assert.rejects(f.connector.inventoryWrite('outbound',{...fresh,quantity:9},f.session),e=>e.status===409);
  assert.equal(f.calls.length+incomplete.calls.length,0);
});

test('profile validates finite quantities and confirmed actor before writing',async()=>{
  const f=fixture(),op=await f.operation();
  for(const quantity of [0,-1,NaN,Infinity,'2']) await assert.rejects(f.connector.inventoryWrite('inbound',{...op,quantity},f.session),e=>e.status===400);
  await assert.rejects(f.connector.inventoryWrite('adjust',{...op,actualQuantity:-1},f.session),e=>e.status===400);
  await assert.rejects(f.connector.inventoryWrite('outbound',{...op,actor:{name:''}},f.session),e=>e.status===403);
  assert.equal(f.calls.length,0);
});

test('network, HTTP errors, invalid JSON and nonnumeric success markers stay unknown without retry',async()=>{
  const variants=[async()=>{throw new Error('synthetic-secret');},async()=>null,async()=>undefined,async()=>reply({code:0},500),
    async()=>({ok:true,status:200,json:async()=>{throw new Error('synthetic-secret');}}),
    ...[null,[],{}, {code:'0'}, {code:null}, {code:false}, {code:NaN}].map(body=>async()=>reply(body))];
  for(const fetchImpl of variants) {
    const f=fixture({fetchImpl}),op=await f.operation();
    await assert.rejects(f.connector.inventoryWrite('inbound',op,f.session),e=>e.outcome==='unknown'&&!e.message.includes('synthetic-secret'));
    assert.equal(f.calls.length,1);
  }
});

test('HTTP 401/403 and explicit numeric business rejections are known failures without retries',async()=>{
  for(const [body,status,expected] of [[{},401,401],[{},403,403],[{code:9},200,422],[{code:401},200,401],[{code:403},200,403]]) {
    const f=fixture({fetchImpl:async()=>reply(body,status)}),op=await f.operation();
    await assert.rejects(f.connector.inventoryWrite('inbound',op,f.session),e=>e.status===expected&&e.outcome!=='unknown');
    assert.equal(f.calls.length,1);
  }
});

test('catalog does not retain a previously writable snapshot after a later failed read',async()=>{
  let fails=false;
  const f=fixture({allRows:async()=>{if(fails)throw new Error('read failed');return{rows:[ROW],complete:true};}}),op=await f.operation();
  fails=true;await assert.rejects(f.catalog());
  await assert.rejects(f.connector.inventoryWrite('inbound',op,f.session),e=>e.status===409);
  assert.equal(f.calls.length,0);
});

test('catalog rejects a config or scope change while the source read is pending',async()=>{
  for(const mutate of [f=>f.config.inventoryConnection.warehouseKey='another',f=>f.config.inventoryScope.records.push({code:'NEW'})]) {
    let release;
    const f=fixture({allRows:()=>new Promise(resolve=>{release=()=>resolve({rows:[ROW],complete:true});})});
    const pending=f.catalog();mutate(f);release();
    await assert.rejects(pending,e=>e.status===409);
  }
});
