'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createSource} = require('../lib/source.cjs');
const {createAutoSource} = require('../lib/auto-source.cjs');
const {createInventoryService} = require('../lib/inventory.cjs');

const MEMBER={account:'000123',name:'合成成员',role:'member'};
const REVIEWER={account:'000456',name:'合成复核人',role:'reviewer'};
const TARGET={id:'scope-original-id',bjbh:'000101',bjmc:'合成定位销',specifications:'TEST-A',sparepartName:'定位销',
  location:'L-1',unit:'个',nowStock:8,price:12,manufacturer:'合成厂商',isSubstitution:'0',isStandard:'1',
  deleteMark:0,systemField:'must-preserve',__derived:'must-omit'};
const clone=value=>JSON.parse(JSON.stringify(value));
const reply=(value,status=200)=>({ok:status>=200&&status<300,status,json:async()=>clone(value)});
function gate(){let release;const promise=new Promise(resolve=>{release=resolve;});return{promise,release};}
function fixture(t,{profile='power-udp',rows,maxPages=50,onGet,onWrite,writeReply}={}){
  const temporaryRoot=path.resolve(os.tmpdir()),root=fs.mkdtempSync(path.join(temporaryRoot,'portal-profile-integration-'));
  const records=rows ? clone(rows) : [
    ...Array.from({length:199},(_,i)=>({...TARGET,id:`outside-${i}`,bjbh:`OTHER-${i}`,specifications:`OTHER-${i}`})),
    clone(TARGET),{...TARGET,id:'second-scope-id',bjbh:'000102',specifications:'TEST-B',nowStock:3},
    {...TARGET,id:'deleted-id',deleteMark:1}
  ];
  const config={apiBase:'https://synthetic-company.example.invalid/',loginToken:'',maxPages,
    inventoryConnection:{profile,warehouseKey:'gongyi-spares',label:'合成工艺部仓库',writes:{inbound:true,outbound:true,adjust:true}},
    inventoryScope:{records:[{code:'000101',name:'合成定位销',specification:'TEST-A'},{code:'000102',name:'合成定位销',specification:'TEST-B'}]}};
  const calls={login:[],get:[],write:[]},module=profile==='power-udp'?'UDP':'Mold';
  const source=createSource(config,async(url,request)=>{
    assert.equal(url.origin,'https://synthetic-company.example.invalid');
    if(url.pathname==='/api/User_Login'){
      calls.login.push(JSON.parse(request.body));
      return reply({code:0,data:{token:'synthetic-company-session'}});
    }
    assert.equal(request.headers.Authorization,'Bearer synthetic-company-session');
    if(request.method==='GET'){
      assert.equal(url.pathname,`/api/${module}_SparepartsDetailed`);
      const page=Number(url.searchParams.get('page')),size=Number(url.searchParams.get('size'));
      const captured=clone(records);calls.get.push({path:url.pathname,page,size});
      if(onGet)await onGet({page,size,call:calls.get.length});
      return reply({code:0,total:captured.length,data:captured.slice((page-1)*size,page*size)});
    }
    const body=JSON.parse(request.body),call={path:url.pathname,method:request.method,body};calls.write.push(call);
    if(onWrite)await onWrite(call);
    if(writeReply)return writeReply(call);
    const row=records.find(r=>String(r.id)===String(request.method==='PUT'?body.id:body.pid));
    assert.ok(row,'upstream operation targets a real synthetic row');
    if(request.method==='PUT')row.nowStock=body.nowStock;
    else if(url.pathname.endsWith('InStock'))row.nowStock+=body.inNumber;
    else if(url.pathname.endsWith('OutStock'))row.nowStock-=body.outNumber;
    else assert.fail('Unexpected write target');
    return reply({code:0});
  });
  const auto=createAutoSource({source,credentialStore:{load:async()=>({username:'synthetic-user',password:'synthetic-password'})},
    setTimer:()=>({unref(){}}),clearTimer:()=>{}});
  const inventory=createInventoryService({root,source:auto});
  t.after(()=>{
    auto.stop();
    if(path.dirname(root)!==temporaryRoot||!path.basename(root).startsWith('portal-profile-integration-'))throw new Error('Unexpected test directory');
    fs.rmSync(root,{recursive:true,force:true});
  });
  return{root,config,records,calls,source,auto,inventory};
}

for(const profile of ['power-udp','power-mold']){
  test(`${profile}: real source and auto source paginate all rows before scope selection`,async t=>{
    const f=fixture(t,{profile}),catalog=await f.inventory.catalog();
    assert.equal(catalog.complete,true);
    assert.equal(catalog.scopeConfigured,true);
    assert.deepEqual(catalog.items.map(r=>r.id),['scope-original-id','second-scope-id']);
    assert.ok(catalog.items.every(r=>r.selectable));
    assert.match(catalog.sourceIdentity,/^[a-f0-9]{64}$/);
    assert.ok(catalog.items.every(r=>r.sourceIdentity===catalog.sourceIdentity));
    assert.deepEqual(f.calls.get.map(r=>[r.page,r.size]),[[1,200],[2,200]]);
    assert.equal(f.calls.login.length,1);
    assert.equal(f.calls.write.length,0);
  });

  test(`${profile}: end-to-end inbound persists company-success without inventing a document and replays locally`,async t=>{
    const f=fixture(t,{profile}),catalog=await f.inventory.catalog();
    const input={kind:'inbound',itemId:TARGET.id,quantity:2,expectedStock:8,expectedSourceIdentity:catalog.sourceIdentity,
      requestId:'integration-inbound-001',remark:'合成入库'};
    const result=await f.inventory.transact(input,MEMBER);
    assert.equal(result.status,'applied');assert.equal(result.confirmationMethod,'company-success');
    assert.equal(result.acknowledgement,'company-success');assert.equal(Object.hasOwn(result,'receiptId'),false);
    assert.equal(result.actor.account,MEMBER.account);
    assert.equal(f.calls.write.length,1);assert.equal(f.calls.login.length,1);
    const write=f.calls.write[0];assert.equal(write.method,'POST');
    assert.equal(write.path,`/api/${profile==='power-udp'?'UDP':'Mold'}_SparepartsInStock`);
    const expected=profile==='power-mold'?{...TARGET,pid:TARGET.id,inType:1,inNumber:2}:{
      pid:TARGET.id,sparepartName:TARGET.sparepartName,bjbh:TARGET.bjbh,bjmc:TARGET.bjmc,specifications:TARGET.specifications,
      price:TARGET.price,manufacturer:TARGET.manufacturer,location:TARGET.location,unit:TARGET.unit,isSubstitution:0,isStandard:1,inType:1,inNumber:2};
    delete expected.__derived;assert.deepEqual(write.body,expected);
    assert.deepEqual(await f.inventory.transact(input,MEMBER),result);assert.equal(f.calls.write.length,1);
    const refreshed=await f.inventory.catalog();assert.equal(refreshed.items.find(r=>r.id===TARGET.id).stock,10);
    const restarted=createInventoryService({root:f.root,source:f.auto});
    assert.deepEqual(await restarted.transact(input,MEMBER),result);assert.equal(f.calls.write.length,1);
  });

  test(`${profile}: count submission stays local and reviewer applies the original-row PUT`,async t=>{
    const f=fixture(t,{profile}),catalog=await f.inventory.catalog();
    const counted=await f.inventory.count({itemId:TARGET.id,actualQuantity:5,expectedStock:8,
      expectedSourceIdentity:catalog.sourceIdentity,requestId:'integration-count-001',remark:'合成盘点'},MEMBER);
    assert.equal(counted.status,'pending');assert.equal(f.calls.write.length,0);
    const review={id:counted.id,action:'approve',requestId:'integration-review-001',reason:'合成核对'};
    const applied=await f.inventory.review(review,REVIEWER);
    assert.equal(applied.status,'applied');assert.equal(applied.confirmationMethod,'company-success');
    assert.equal(Object.hasOwn(applied,'receiptId'),false);
    assert.equal(applied.reviewer.account,REVIEWER.account);
    const expected={...TARGET,nowStock:5};delete expected.__derived;
    assert.deepEqual(f.calls.write,[{path:`/api/${profile==='power-udp'?'UDP':'Mold'}_SparepartsDetailed`,method:'PUT',body:expected}]);
    assert.deepEqual(await f.inventory.review(review,REVIEWER),applied);assert.equal(f.calls.write.length,1);
    assert.equal((await f.inventory.catalog()).items.find(r=>r.id===TARGET.id).stock,5);
  });
}

test('Mold outbound is refused by the full service even when its configuration flag is true',async t=>{
  const f=fixture(t,{profile:'power-mold'}),catalog=await f.inventory.catalog();
  assert.equal((await f.inventory.capabilities()).outbound.enabled,false);
  await assert.rejects(f.inventory.transact({kind:'outbound',itemId:TARGET.id,quantity:1,expectedStock:8,
    expectedSourceIdentity:catalog.sourceIdentity,requestId:'integration-out-disabled'},MEMBER),e=>e.status===503);
  assert.equal(f.calls.write.length,0);
});

test('incomplete upstream pagination never permits a write to an otherwise matched original row',async t=>{
  const f=fixture(t,{maxPages:1}),catalog=await f.inventory.catalog();
  assert.equal(catalog.complete,false);assert.equal(catalog.items[0].selectable,false);
  await assert.rejects(f.inventory.transact({kind:'inbound',itemId:TARGET.id,quantity:1,expectedStock:8,
    expectedSourceIdentity:catalog.sourceIdentity,requestId:'integration-incomplete'},MEMBER),e=>e.code==='incomplete_catalog');
  assert.equal(f.calls.write.length,0);
});

test('string success code remains unknown through the full chain and replay cannot issue a second write',async t=>{
  const f=fixture(t,{writeReply:()=>reply({code:'0'})}),catalog=await f.inventory.catalog();
  const input={kind:'inbound',itemId:TARGET.id,quantity:1,expectedStock:8,
    expectedSourceIdentity:catalog.sourceIdentity,requestId:'integration-unknown-code'};
  await assert.rejects(f.inventory.transact(input,MEMBER),e=>e.code==='outcome_unknown');
  await assert.rejects(f.inventory.transact(input,MEMBER),e=>e.code==='outcome_unknown');
  assert.equal(f.calls.write.length,1);assert.equal(f.calls.login.length,1);
  const listed=await f.inventory.list({},MEMBER);assert.equal(listed.records[0].status,'unknown');
  await assert.rejects(f.inventory.transact({...input,requestId:'integration-unknown-other'},MEMBER),e=>e.code==='item_outcome_unknown');
  assert.equal(f.calls.write.length,1);
});

test('malformed nonempty deleteMark values cannot turn source rows into selectable active inventory',async t=>{
  const values=['invalid','false',{},[],true,1,'1',0,'0',false,null,undefined];
  const rows=values.map((deleteMark,i)=>({...TARGET,id:`flag-${i}`,deleteMark}));
  const f=fixture(t,{rows}),catalog=await f.inventory.catalog();
  assert.deepEqual(catalog.items.map(r=>r.id),['flag-7','flag-8','flag-9','flag-10','flag-11']);
});

test('an older catalog response cannot replace the newer complete session snapshot',async t=>{
  const entered=gate(),release=gate();
  const f=fixture(t,{rows:[TARGET],onGet:async({call})=>{if(call===1){entered.release();await release.promise;}}});
  const old=f.auto.inventoryCatalog({fresh:true});old.catch(()=>{});await entered.promise;
  const fresh=await f.auto.inventoryCatalog({fresh:true});
  release.release();await assert.rejects(old,e=>e.status===409);
  const result=await f.auto.inventoryWrite('inbound',{item:fresh.rows[0],quantity:2,beforeStock:8,actor:MEMBER,
    requestId:'integration-new-snapshot',sourceIdentity:fresh.sourceIdentity,sourceRevision:fresh.sourceRevision});
  assert.equal(result.confirmed,true);assert.equal(f.calls.write.length,1);
});

test('a catalog crossing an in-flight write cannot restore pre-write stock into the session snapshot',async t=>{
  const writing=gate(),releaseWrite=gate(),reading=gate(),releaseRead=gate();
  const f=fixture(t,{rows:[TARGET],onWrite:async()=>{writing.release();await releaseWrite.promise;},
    onGet:async({call})=>{if(call===2){reading.release();await releaseRead.promise;}}});
  const catalog=await f.auto.inventoryCatalog({fresh:true});
  const write=f.auto.inventoryWrite('inbound',{item:catalog.rows[0],quantity:2,beforeStock:8,actor:MEMBER,
    requestId:'integration-crossed-write',sourceIdentity:catalog.sourceIdentity,sourceRevision:catalog.sourceRevision});
  await writing.promise;
  const stale=f.auto.inventoryCatalog({fresh:true});stale.catch(()=>{});await reading.promise;
  releaseWrite.release();assert.equal((await write).confirmed,true);
  releaseRead.release();await assert.rejects(stale,e=>e.status===409);
  assert.equal((await f.auto.inventoryCatalog({fresh:true})).rows[0].nowStock,10);
  assert.equal(f.calls.write.length,1);
});
