'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createPortal } = require('../server.cjs');
const { makeAdminConfig } = require('../lib/admin.cjs');
const { createSource } = require('../lib/source.cjs');
const { createAutoSource } = require('../lib/auto-source.cjs');
const password = 'synthetic-mes-portal-test-password';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gongyi-vision-mes-'));
  const calls = [];
  let readHook = null;
  const autoSource = {
    start() {}, stop() {}, status() { return {state:'ready', configured:true}; },
    async read(module, query) {
      calls.push({module, query});
      if (readHook) return readHook(module, query);
      return {barcode:query.barcode, processes:[{id:'test-process', name:'合成工序'}], coverage:{mode:'lookup', complete:false, eligibleForLineRate:false}};
    }
  };
  const server = createPortal({root, config:{admin:makeAdminConfig('00001', password)}, autoSource,
    inventoryService:{async capabilities(){return {};}},
    visionService:{start(){},stop(){}}, matchingGapService:{start(){},stop(){}}
  });
  await new Promise(resolve=>server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{
    server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));
    assert.ok(path.basename(root).startsWith('gongyi-vision-mes-'));
    await fs.rm(root,{recursive:true,force:true});
  });
  async function request(route,{cookie,method='GET',body,headers={}}={}) {
    const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...headers},body:body?JSON.stringify(body):undefined});
    const text=await response.text();
    return {status:response.status,body:text?JSON.parse(text):null,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  const admin=(await request('/local/login',{method:'POST',body:{username:'00001',password}})).cookie;
  await request('/local/members',{method:'POST',cookie:admin,body:{account:'00002',name:'合成成员',role:'member',active:true,password,createOnly:true}});
  const member=(await request('/local/login',{method:'POST',body:{username:'00002',password}})).cookie;
  return {request,calls,admin,member,setReadHook(value){readHook=value;}};
}

test('MES lookups require login and stay separate from legacy vision statistics',async t=>{
  const app=await fixture(t);
  for(const route of ['/local/vision/mes/processes?barcode=SYN-001','/local/vision/mes/lookup?barcode=SYN-001&processId=test-process']) {
    assert.equal((await app.request(route)).status,401);
  }
  assert.equal(app.calls.length,0);
  const response=await app.request('/local/vision/mes/processes?barcode=SYN-001',{cookie:app.member});
  assert.equal(response.status,200);
  assert.equal(response.body.coverage.eligibleForLineRate,false);
  assert.deepEqual(app.calls,[{module:'visionMes',query:{action:'processes',barcode:'SYN-001',processId:''}}]);
});

test('MES routes accept only read queries, fixed parameters and matching origin',async t=>{
  const app=await fixture(t),route='/local/vision/mes/lookup?barcode=SYN-001&processId=10';
  for(const method of ['POST','PUT','DELETE'])assert.equal((await app.request(route,{method,cookie:app.member,body:{}})).status,405);
  for(const query of ['&apiBase=https://other.invalid','&barcode=ANOTHER'])assert.equal((await app.request(route+query,{cookie:app.member})).status,400);
  assert.equal((await app.request(route,{cookie:app.member,headers:{Origin:'https://other.invalid'}})).status,403);
  assert.equal((await app.request(route,{cookie:app.member,headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal(app.calls.length,0);
});

test('a pending company lookup cannot return measurements after portal logout',async t=>{
  const app=await fixture(t);let started,finish;
  const ready=new Promise(resolve=>{started=resolve;});
  const gate=new Promise(resolve=>{finish=resolve;});
  app.setReadHook(async()=>{started();await gate;return {measurements:[{name:'合成测点',actual:1}]};});
  const pending=app.request('/local/vision/mes/lookup?barcode=SYN-001&processId=10',{cookie:app.member});
  await ready;
  try { await app.request('/local/logout',{cookie:app.member,method:'POST',body:{}}); } finally { finish(); }
  const response=await pending;
  assert.equal(response.status,401);assert.equal(response.body.measurements,undefined);
});

test('MES catalog, report and record detail require portal login and map to the batch source with exact string parameters',async t=>{
  const app=await fixture(t);
  const recordId='123456789012345678';
  const reportQuery={lineId:'123',start:'2026-02-03T08:01',end:'2026-02-03T09:02',limit:'500',barcode:'SYN-001'};
  const routes=['/local/vision/mes/catalog',
    '/local/vision/mes/report?'+new URLSearchParams(reportQuery),
    '/local/vision/mes/detail?recordId='+recordId];
  for(const route of routes)assert.equal((await app.request(route)).status,401,route);
  assert.equal(app.calls.length,0);
  app.setReadHook(async(module,query)=>{
    assert.equal(module,'visionMesReport');
    if(query.action==='catalog')return {action:'catalog',lines:[{id:'123',name:'合成尺寸线'}],defaultLineId:'123'};
    if(query.action==='report')return {action:'report',records:[{recordId,barcode:'SYN-001',result:'OK'}],summary:{total:1,ok:1,ng:0}};
    if(query.action==='detail')return {action:'detail',recordId:query.recordId,measurements:[{name:'合成点位',actual:0.25}]};
    assert.fail('Unexpected MES action');
  });
  const catalog=await app.request(routes[0],{cookie:app.member});
  assert.equal(catalog.status,200);assert.equal(catalog.body.lines[0].id,'123');
  const report=await app.request(routes[1],{cookie:app.member});
  assert.equal(report.status,200);assert.equal(report.body.records[0].recordId,recordId);
  const detail=await app.request(routes[2],{cookie:app.member});
  assert.equal(detail.status,200);assert.equal(detail.body.recordId,recordId);assert.equal(detail.body.measurements.length,1);
  assert.deepEqual(app.calls,[
    {module:'visionMesReport',query:{action:'catalog'}},
    {module:'visionMesReport',query:{action:'report',...reportQuery}},
    {module:'visionMesReport',query:{action:'detail',recordId}},
  ]);
});

test('every batch MES route rejects writes and cross-site access before source reads',async t=>{
  const app=await fixture(t);
  const routes=['/local/vision/mes/catalog','/local/vision/mes/report?lineId=123','/local/vision/mes/detail?recordId=456'];
  for(const route of routes){
    for(const method of ['POST','PUT','PATCH','DELETE','HEAD']){
      const response=await app.request(route,{method,cookie:app.member,...(method==='HEAD'?{}:{body:{recordId:'other'}})});
      assert.equal(response.status,405,`${method} ${route}`);
    }
    assert.equal((await app.request(route,{cookie:app.member,headers:{Origin:'https://other.invalid'}})).status,403,route);
    assert.equal((await app.request(route,{cookie:app.member,headers:{'Sec-Fetch-Site':'cross-site'}})).status,403,route);
  }
  assert.equal(app.calls.length,0);
});

test('batch MES parameter allowlists reject extra fields and every duplicated selector before source reads',async t=>{
  const app=await fixture(t);
  const invalidRoutes=[
    '/local/vision/mes/catalog?lineId=123',
    '/local/vision/mes/catalog?recordId=456',
    '/local/vision/mes/catalog?action=report',
    '/local/vision/mes/report?lineId=123&employee=synthetic-employee',
    '/local/vision/mes/report?lineId=123&apiBase=https://other.invalid',
    '/local/vision/mes/report?lineId=123&processId=456',
    '/local/vision/mes/report?lineId=123&action=detail',
    '/local/vision/mes/detail?recordId=456&lineId=123',
    '/local/vision/mes/detail?recordId=456&barcode=SYN-001',
    '/local/vision/mes/detail?recordId=456&employee=synthetic-employee',
    '/local/vision/mes/detail?recordId=456&recordId=456',
    '/local/vision/mes/detail?recordId=456&recordId=789',
  ];
  for(const [key,value] of Object.entries({lineId:'123',start:'2026-02-03',end:'2026-02-04',limit:'500',barcode:'SYN-001'})){
    const query=new URLSearchParams({lineId:'123',start:'2026-02-03',end:'2026-02-04',limit:'500',barcode:'SYN-001'});
    query.append(key,value);
    invalidRoutes.push('/local/vision/mes/report?'+query);
  }
  for(const route of invalidRoutes)assert.equal((await app.request(route,{cookie:app.member})).status,400,route);
  assert.equal(app.calls.length,0);
});

test('logout blocks all in-flight batch MES responses including catalogs, records and measurement details',async t=>{
  const app=await fixture(t);
  let started=0,ready,finish;
  const allStarted=new Promise(resolve=>{ready=resolve;});
  const gate=new Promise(resolve=>{finish=resolve;});
  app.setReadHook(async(module,query)=>{
    assert.equal(module,'visionMesReport');
    if(++started===3)ready();
    await gate;
    return {action:query.action,lines:[{name:'synthetic-private-line'}],records:[{barcode:'synthetic-private-barcode'}],
      measurements:[{name:'synthetic-private-point',actual:0.25}]};
  });
  const routes=['/local/vision/mes/catalog','/local/vision/mes/report?lineId=123','/local/vision/mes/detail?recordId=456'];
  const pending=routes.map(route=>app.request(route,{cookie:app.member}));
  await allStarted;
  try{assert.equal((await app.request('/local/logout',{cookie:app.member,method:'POST',body:{}})).status,200);}
  finally{finish();}
  const results=await Promise.all(pending);
  for(const result of results){
    assert.equal(result.status,401);
    for(const field of ['lines','records','measurements'])assert.equal(result.body[field],undefined);
    assert.equal(JSON.stringify(result.body).includes('synthetic-private'),false);
  }
  assert.deepEqual(app.calls.map(call=>call.query.action).sort(),['catalog','detail','report']);
});

test('company session refresh retries only reads and never submits MES production data',async()=>{
  let logins=0,processReads=0;
  const calls=[];
  const source=createSource({apiBase:'http://synthetic.invalid',loginToken:''},async(url,options)=>{
    calls.push({path:url.pathname,method:options.method});
    if(url.pathname==='/api/User_Login')return {ok:true,status:200,json:async()=>({code:0,data:{token:`synthetic-session-${++logins}`}})};
    if(url.pathname==='/api/parameter_unqualified/getgxcode') {
      if(++processReads===1)return {ok:false,status:401,json:async()=>({code:401})};
      return {ok:true,status:200,json:async()=>({code:0,data:[{value:'10',label:'合成在线尺寸工序'}]})};
    }
    throw new Error('Unexpected company endpoint');
  });
  const auto=createAutoSource({source,credentialStore:{async load(){return {username:'synthetic-user',password:'synthetic-password'};}}});
  try {
    const result=await auto.read('visionMes',{action:'processes',barcode:'SYN-001'});
    assert.equal(result.processes[0].id,'10');assert.equal(logins,2);assert.equal(processReads,2);
    assert.ok(calls.every(call=>call.path==='/api/User_Login'?call.method==='POST':call.method==='GET'));
    await auto.read('visionMes',{action:'processes',barcode:'SYN-001'});
    assert.equal(processReads,2);
  } finally {auto.stop();}
});
