'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createPortal}=require('../server.cjs');
const {makeAdminConfig}=require('../lib/admin.cjs');
const password='synthetic-vision-password-2026';
const recordId='a'.repeat(64);

async function fixture(t,hooks={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'gongyi-server-vision-'));
  const calls={report:[],detail:[],import:[],source:0,credentials:0};
  const visionService={
    async report(query){calls.report.push(structuredClone(query));return {records:[{id:recordId,partName:'Tesla_Front12',result:'OK'}],summary:{total:1}};},
    async detail(id){calls.detail.push(id);return {id,measurements:[{name:'测试测点',deviation:0.01,result:'OK'}]};},
    async importCsv(input){calls.import.push(structuredClone(input));return {imported:1,duplicates:0,recordId};},
    ...hooks
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
  return {request,login,admin,member:await login('00002'),reviewer:await login('00003'),calls,visionService,server};
}


test('company-only portal never starts, reads or stops the retired file collector',async t=>{
  let starts=0,stops=0;
  const app=await fixture(t,{start(){starts++;},stop(){stops++;}});
  assert.equal(starts,0);
  for(const cookie of [app.admin,app.member,app.reviewer]){
    for(const [method,route,data] of [['GET','/local/vision/report'],['GET','/local/vision/records/'+recordId],['POST','/local/vision/import',{filename:'synthetic.csv',content:'synthetic'}]]){
      const result=await app.request(method,route,data,cookie);
      assert.equal(result.status,410);assert.match(result.body.message,/公司系统/);
    }
  }
  app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));
  assert.equal(stops,0);
  assert.deepEqual(app.calls,{report:[],detail:[],import:[],source:0,credentials:0});
});
test('retired inspection endpoints still require login and reject foreign origins',async t=>{
  const app=await fixture(t);
  for(const [method,route,data] of [['GET','/local/vision/report'],['GET','/local/vision/records/'+recordId],['POST','/local/vision/import',{}]]){
    assert.equal((await app.request(method,route,data)).status,401);
    assert.equal((await app.request(method,route,data,app.admin,{Origin:'https://foreign.invalid'})).status,403);
  }
  assert.deepEqual(app.calls,{report:[],detail:[],import:[],source:0,credentials:0});
});
