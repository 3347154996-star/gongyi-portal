'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createPortal}=require('../server.cjs');
const {makeAdminConfig}=require('../lib/admin.cjs');
const password='synthetic-vision-password-2026';
const recordId='a'.repeat(64);

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'gongyi-server-vision-'));
  const calls={report:[],detail:[],import:[],source:0,credentials:0};
  const visionService={
    async report(query){calls.report.push(structuredClone(query));return {records:[{id:recordId,partName:'Tesla_Front12',result:'OK'}],summary:{total:1}};},
    async detail(id){calls.detail.push(id);return {id,measurements:[{name:'测试测点',deviation:0.01,result:'OK'}]};},
    async importCsv(input){calls.import.push(structuredClone(input));return {imported:1,duplicates:0,recordId};}
  };
  const autoSource={
    start(){},stop(){},status(){return {state:'unconfigured'};},
    async read(){calls.source++;throw new Error('Vision must not read company-system data');},
    async configure(){calls.source++;throw new Error('Vision must not configure company-system credentials');}
  };
  const credentialStore={async load(){calls.credentials++;throw new Error('Vision must not load company credentials');}};
  const inventoryService={async capabilities(){return {};}};
  let server;
  t.after(async()=>{
    if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    const resolved=path.resolve(root),tempRoot=path.resolve(os.tmpdir());
    assert.ok(resolved.startsWith(tempRoot+path.sep)&&path.basename(resolved).startsWith('gongyi-server-vision-'));
    await fs.rm(resolved,{recursive:true,force:true});
  });
  server=createPortal({root,config:{admin:makeAdminConfig('00001',password)},source:{},autoSource,credentialStore,inventoryService,visionService});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const base=`http://127.0.0.1:${server.address().port}`;
  async function request(method,route,data,cookie,headers={}){
    const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...headers},body:data===undefined?undefined:JSON.stringify(data)});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  async function login(account){const result=await request('POST','/local/login',{username:account,password});assert.equal(result.status,200);return result.cookie;}
  const admin=await login('00001');
  for(const [account,name,role] of [['00002','测试视觉成员','member'],['00003','测试视觉复核员','reviewer']])assert.equal((await request('POST','/local/members',{account,name,role,active:true,password,createOnly:true},admin)).status,200);
  return {request,login,admin,member:await login('00002'),reviewer:await login('00003'),calls,visionService};
}

test('vision report, detail and import require a current portal session',async t=>{
  const app=await fixture(t);
  for(const [method,route,data] of [['GET','/local/vision/report'],['GET',`/local/vision/records/${recordId}`],['POST','/local/vision/import',{filename:'Tesla_Front12_20261013-000549.csv',content:'synthetic',deviceId:'fixture-machine'}]]){
    assert.equal((await app.request(method,route,data)).status,401);
  }
  assert.deepEqual(app.calls,{report:[],detail:[],import:[],source:0,credentials:0});
});

test('members can query visual inspection records without company-system credentials',async t=>{
  const app=await fixture(t);
  const query={start:'2026-10-01',end:'2026-10-13',part:'Tesla_Front12',result:'NG',search:'测试 SN',page:'2',pageSize:'20'};
  const report=await app.request('GET',`/local/vision/report?${new URLSearchParams(query)}`,undefined,app.member);
  assert.equal(report.status,200);assert.equal(report.body.records[0].id,recordId);
  assert.deepEqual(app.calls.report,[query]);
  const detail=await app.request('GET',`/local/vision/records/${recordId}`,undefined,app.member);
  assert.equal(detail.status,200);assert.equal(detail.body.measurements[0].name,'测试测点');
  assert.deepEqual(app.calls.detail,[recordId]);
  assert.equal(app.calls.source,0);assert.equal(app.calls.credentials,0);
});

test('only an administrator may import inspection CSV, with the original payload preserved',async t=>{
  const app=await fixture(t);
  const input={filename:'Tesla_Front12_20261013-000549.csv',content:'PartName,Tesla_Front12\r\nSN,合成样例\r\n',deviceId:'fixture-machine'};
  for(const cookie of [app.member,app.reviewer])assert.equal((await app.request('POST','/local/vision/import',input,cookie)).status,403);
  assert.equal(app.calls.import.length,0);
  const result=await app.request('POST','/local/vision/import',input,app.admin);
  assert.equal(result.status,200);assert.equal(result.body.imported,1);
  assert.deepEqual(app.calls.import,[input]);
  assert.equal(app.calls.source,0);assert.equal(app.calls.credentials,0);
});

test('vision routes reject foreign-origin requests before calling the inspection service',async t=>{
  const app=await fixture(t);
  const headers={Origin:'https://foreign-origin.invalid'};
  for(const [method,route,data] of [['GET','/local/vision/report'],['GET',`/local/vision/records/${recordId}`],['POST','/local/vision/import',{filename:'fixture.csv',content:'fixture',deviceId:'fixture-machine'}]]){
    assert.equal((await app.request(method,route,data,app.admin,headers)).status,403);
  }
  assert.deepEqual(app.calls,{report:[],detail:[],import:[],source:0,credentials:0});
});

test('logout and member deactivation revoke access to visual inspection records',async t=>{
  const app=await fixture(t);
  assert.equal((await app.request('POST','/local/logout',{},app.member)).status,200);
  assert.equal((await app.request('GET','/local/vision/report',undefined,app.member)).status,401);
  assert.equal((await app.request('GET',`/local/vision/records/${recordId}`,undefined,app.member)).status,401);
  const freshMember=await app.login('00002');
  const members=(await app.request('GET','/local/members',undefined,app.admin)).body.members;
  const member=members.find(item=>item.account==='00002');
  assert.equal((await app.request('POST','/local/members',{...member,active:false},app.admin)).status,200);
  assert.equal((await app.request('GET','/local/vision/report',undefined,freshMember)).status,401);
  assert.equal((await app.request('GET',`/local/vision/records/${recordId}`,undefined,freshMember)).status,401);
  assert.deepEqual(app.calls,{report:[],detail:[],import:[],source:0,credentials:0});
});

test('a pending visual inspection read cannot reveal records after logout',async t=>{
  const app=await fixture(t);
  let started,finish;
  const called=new Promise(resolve=>{started=resolve;});
  const gate=new Promise(resolve=>{finish=resolve;});
  app.visionService.report=async()=>{started();await gate;return {records:[{id:recordId}]};};
  const pending=app.request('GET','/local/vision/report',undefined,app.member);
  await called;
  try{assert.equal((await app.request('POST','/local/logout',{},app.member)).status,200);}finally{finish();}
  const result=await pending;
  assert.equal(result.status,401);
  assert.equal(result.body.records,undefined);
});
