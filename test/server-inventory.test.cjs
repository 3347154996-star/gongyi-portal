'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createPortal}=require('../server.cjs');
const {makeAdminConfig}=require('../lib/admin.cjs');
const password='synthetic-password-2026';
async function fixture(t,{unknown=false,enabled=true,metadata={}}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'gongyi-server-stock-'));
  const rows=[{id:'synthetic-id-1',bjbh:'00012',bjmc:'测试专用定位销',specifications:'TEST-1',location:'TEST-A1',unit:'件',nowStock:12}];
  const writes=[];
  const source={
    async login(){return {token:'synthetic-token'};},
    async read(){return {rows:[],columns:[],complete:true};},
    inventoryCapabilities(){return Object.fromEntries(['inbound','outbound','adjust'].map(kind=>[kind,{enabled,reason:enabled?'':'测试能力关闭'}]));},
    async inventoryCatalog(){return {rows:structuredClone(rows),complete:true,fetchedAt:new Date().toISOString(),...metadata};},
    async inventoryWrite(kind,operation){writes.push({kind,operation:structuredClone(operation)});const row=rows.find(row=>row.id===operation.item.id);row.nowStock=kind==='adjust'?operation.actualQuantity:row.nowStock+(kind==='inbound'?1:-1)*operation.quantity;if(unknown){const error=new Error('synthetic-uncertain-result');error.outcome='unknown';throw error;}return {receiptId:'SYNTHETIC-'+writes.length};}
  };
  const credentialStore={async load(){return {username:'synthetic-source',password};},async save(){},async remove(){}};
  const server=createPortal({root,config:{admin:makeAdminConfig('00001',password)},source,credentialStore});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  async function request(method,route,data,cookie){const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:data===undefined?undefined:JSON.stringify(data)});return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};}
  async function login(account,pw=password){const result=await request('POST','/local/login',{username:account,password:pw});assert.equal(result.status,200);return result.cookie;}
  const admin=await login('00001');
  for(const [account,name,role] of [['00002','测试领用员','member'],['00003','测试复核员','reviewer']])assert.equal((await request('POST','/local/members',{account,name,role,active:true,password,createOnly:true},admin)).status,200);
  return {request,login,admin,member:await login('00002'),reviewer:await login('00003'),rows,writes};
}
test('stock HTTP flow binds identity to login, enforces roles and records source-confirmed receipt',async t=>{
  const app=await fixture(t);
  const status=await app.request('GET','/local/status',undefined,app.member);assert.equal(status.body.role,'member');assert.equal(status.body.name,'测试领用员');assert.equal(status.body.inventoryCapabilities.outbound.enabled,true);
  for(const cookie of [app.member,app.reviewer])assert.equal((await app.request('GET','/local/data/spares',undefined,cookie)).status,403);
  for(const [method,route,data] of [['GET','/local/members'],['POST','/local/members',{account:'00099'}],['POST','/local/connect',{username:'x',password:'x'}],['POST','/local/disconnect',{}]])assert.equal((await app.request(method,route,data,app.member)).status,403);
  const catalog=await app.request('GET','/local/inventory/catalog?code=00012',undefined,app.member);assert.equal(catalog.body.items[0].code,'00012');assert.equal(catalog.body.items[0].selectable,true);
  const input={kind:'outbound',itemId:'synthetic-id-1',quantity:2,expectedStock:12,requestId:'synthetic-out-01',actor:{account:'00001',role:'admin'}};
  const result=await app.request('POST','/local/inventory/transactions',input,app.member);assert.equal(result.status,200);assert.equal(result.body.status,'applied');assert.equal(result.body.actor.account,'00002');assert.equal(app.writes[0].operation.actor.account,'00002');assert.equal(app.rows[0].nowStock,10);
  assert.equal((await app.request('POST','/local/inventory/transactions',input,app.member)).body.id,result.body.id);assert.equal(app.writes.length,1);
  assert.equal((await app.request('POST','/local/inventory/transactions',{...input,quantity:3},app.member)).status,409);
  const recordList=await app.request('GET','/local/inventory/records',undefined,app.member);assert.equal(recordList.body.records.length,1);assert.equal(recordList.body.records[0].receiptId,'SYNTHETIC-1');
  const count=await app.request('POST','/local/inventory/counts',{itemId:'synthetic-id-1',actualQuantity:8,expectedStock:10,requestId:'synthetic-count-01'},app.member);assert.equal(count.body.status,'pending');assert.equal(app.rows[0].nowStock,10);
  const review={id:count.body.id,action:'approve',requestId:'synthetic-review-01',reason:'测试复核'};
  assert.equal((await app.request('POST','/local/inventory/review',review,app.member)).status,403);
  const approved=await app.request('POST','/local/inventory/review',review,app.reviewer);assert.equal(approved.status,200);assert.equal(approved.body.status,'applied');assert.equal(approved.body.reviewer.account,'00003');assert.equal(app.rows[0].nowStock,8);
});
test('catalog HTTP route preserves long warehouse-bound QR labels and source display metadata',async t=>{
  const sourceIdentity='a'.repeat(64);
  const app=await fixture(t,{metadata:{sourceIdentity,inventoryProfile:'mold',inventoryLabel:'工艺部仓库'}});
  const id='备件/'.repeat(35);
  app.rows[0].id=id;
  const code=`GY-SPARE:v1:${sourceIdentity}:${encodeURIComponent(id)}`;
  assert.ok(code.length>200&&code.length<=2048);
  const response=await app.request('GET',`/local/inventory/catalog?${new URLSearchParams({code})}`,undefined,app.member);
  assert.equal(response.status,200);
  assert.equal(response.body.items.length,1);
  assert.equal(response.body.items[0].id,id);
  assert.equal(response.body.sourceIdentity,sourceIdentity);
  assert.equal(response.body.items[0].sourceIdentity,sourceIdentity);
  assert.equal(response.body.inventoryProfile,'mold');
  assert.equal(response.body.inventoryLabel,'工艺部仓库');
  const otherCode=`GY-SPARE:v1:${'b'.repeat(64)}:${encodeURIComponent(id)}`;
  const other=await app.request('GET',`/local/inventory/catalog?${new URLSearchParams({code:otherCode})}`,undefined,app.member);
  assert.equal(other.status,409);
  assert.equal(other.body.code,'source_identity_mismatch');
  assert.equal(app.writes.length,0);
});

test('deactivation, role changes and password changes revoke previous sessions',async t=>{
  const app=await fixture(t);
  let list=(await app.request('GET','/local/members',undefined,app.admin)).body.members;
  const member=list.find(row=>row.account==='00002');
  assert.equal((await app.request('POST','/local/members',{...member,active:false},app.admin)).status,200);
  assert.equal((await app.request('GET','/local/inventory/catalog',undefined,app.member)).status,401);
  assert.equal((await app.request('POST','/local/login',{username:'00002',password})).status,401);
  const reviewer=list.find(row=>row.account==='00003');
  assert.equal((await app.request('POST','/local/members',{...reviewer,role:'member'},app.admin)).status,200);
  assert.equal((await app.request('GET','/local/inventory/catalog',undefined,app.reviewer)).status,401);
  const fresh=await app.login('00003');
  assert.equal((await app.request('POST','/local/password',{oldPassword:password,newPassword:password+'-new'},fresh)).status,200);
  assert.equal((await app.request('GET','/local/inventory/catalog',undefined,fresh)).status,401);
  assert.equal((await app.request('POST','/local/login',{username:'00003',password})).status,401);
  await app.login('00003',password+'-new');
  assert.equal(JSON.stringify(list).includes('passwordHash'),false);
});
test('unknown upstream write is visible and cannot be submitted a second time',async t=>{
  const app=await fixture(t,{unknown:true});
  const input={kind:'outbound',itemId:'synthetic-id-1',quantity:2,expectedStock:12,requestId:'synthetic-unknown-01'};
  const response=await app.request('POST','/local/inventory/transactions',input,app.member);assert.equal(response.status,503);assert.equal(response.body.code,'outcome_unknown');assert.ok(response.body.recordId);
  assert.equal((await app.request('POST','/local/inventory/transactions',input,app.member)).status,503);assert.equal(app.writes.length,1);
  assert.equal((await app.request('POST','/local/inventory/transactions',{...input,requestId:'synthetic-unknown-02',expectedStock:10},app.member)).status,409);assert.equal(app.writes.length,1);
  const list=await app.request('GET','/local/inventory/records',undefined,app.admin);assert.equal(list.body.records[0].status,'unknown');
});
test('unverified company writes remain closed while counting can record discrepancies',async t=>{
  const app=await fixture(t,{enabled:false});
  assert.equal((await app.request('GET','/local/status',undefined,app.member)).body.writeEnabled,false);
  const input={kind:'inbound',itemId:'synthetic-id-1',quantity:2,expectedStock:12,requestId:'synthetic-disabled-01'};
  assert.equal((await app.request('POST','/local/inventory/transactions',input,app.member)).status,503);assert.equal(app.writes.length,0);
  const count=await app.request('POST','/local/inventory/counts',{itemId:'synthetic-id-1',actualQuantity:8,expectedStock:12,requestId:'synthetic-count-02'},app.member);assert.equal(count.status,200);assert.equal(count.body.status,'pending');assert.equal(app.writes.length,0);
});
