'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {createSource,parseQuery}=require('../lib/source.cjs');
const config={apiBase:'http://example.invalid',loginToken:'',materialGroups:{front:['FRONT_PRIMARY','FRONT_SECONDARY'],rear:['REAR_PRIMARY','REAR_SECONDARY']}};
const response=data=>({ok:true,status:200,json:async()=>data});
const q=(extra={})=>({start:'2026-09-21',end:'2026-09-27',view:'weekly',page:1,size:50,keyword:'',category:'all',...extra});
const row=(i)=>({id:i,barcode:`DEMO-${i}-11A001`,item_code:'FRONT_PRIMARY',item_name:'Synthetic fixture',badness_location_name:'TSL-01-OP010-A',badness_content:'焊偏',create_time:'2026-09-25 12:00:00'});
test('login uses source client protocol and business token, not alternate client token',async()=>{
  let sent;const source=createSource(config,async(url,options)=>{sent={url,options};return response({code:0,data:{token:'mock-business-session',access_token:'mock-other-session'}});});
  assert.deepEqual(await source.login('mock-user','mock-password'),{account:'mock-user',token:'mock-business-session'});
  const payload=JSON.parse(sent.options.body);assert.equal(payload.account,'mock-user');assert.equal(payload.pwd,createHash('md5').update('mock-password').digest('hex'));assert.equal(Object.hasOwn(payload,'token'),false);assert.equal(sent.options.redirect,'error');
});
test('all pages contribute to aggregates and changing display page reuses fetched data',async()=>{
  const calls=[];const source=createSource(config,async(url,options)=>{calls.push({url,options});const page=Number(url.searchParams.get('page'));return response({code:0,total:201,data:page===1?Array.from({length:200},(_,i)=>row(i)):[row(200)]});});const session={token:'mock-token'};
  const first=await source.read('weld',q(),session);assert.equal(first.total,201);assert.equal(first.rows.length,50);assert.equal(first.report.products.front.defectPoints,201);assert.equal(first.complete,true);assert.equal(calls.length,2);assert.equal(calls[0].options.headers.Authorization,'Bearer mock-token');assert.equal(calls[0].url.searchParams.get('start'),'2026-09-21 00:00:00');
  const next=await source.read('weld',q({page:2}),session);assert.equal(next.rows.length,50);assert.equal(calls.length,2);assert.equal(next.fetchedAt,first.fetchedAt);
});
test('page cap yields partial report and unknown weekly coverage',async()=>{
  const source=createSource({...config,maxPages:1},async()=>response({code:0,total:250,data:Array.from({length:200},(_,i)=>row(i))}));const result=await source.read('weld',q(),{token:'mock'});
  assert.equal(result.complete,false);assert.equal(result.total,200);assert.equal(result.sourceTotal,250);assert.equal(result.report.period.coverage.status,'partial');assert.match(result.note,/上限/);
});
test('changing source total is reported partial, exact duplicated rows are preserved',async()=>{
  let i=0;const source=createSource(config,async()=>response(++i===1?{code:0,total:202,data:Array(200).fill(row(1))}:{code:0,total:201,data:[row(1)]}));const result=await source.read('weld',q(),{token:'mock'});assert.equal(result.complete,false);assert.equal(result.report.products.front.defectPoints,201);assert.equal(result.report.products.front.pieces,1);
});
test('source date filtering is verified locally instead of trusting unsupported query',async()=>{
  const source=createSource(config,async()=>response({code:0,total:2,data:[row(1),{...row(2),create_time:'2026-08-01 00:00:00'}]}));const result=await source.read('weld',q(),{token:'mock'});assert.equal(result.total,1);assert.equal(result.complete,false);assert.match(result.note,/范围外/);
});
test('overlapping record ids between source pages cannot claim complete coverage',async()=>{
  const records=Array.from({length:200},(_,i)=>row(i));
  const source=createSource(config,async()=>response({code:0,total:400,data:records}));
  const result=await source.read('weld',q(),{token:'mock'});
  assert.equal(result.total,400);assert.equal(result.complete,false);assert.match(result.note,/重复记录ID/);
});
test('a changing intermediate total remains partial even when the final total returns to its original value',async()=>{
  let page=0;const source=createSource(config,async()=>{page++;return response({code:0,total:page===2?601:600,data:Array.from({length:200},(_,i)=>row((page-1)*200+i))});});
  const result=await source.read('weld',q(),{token:'mock'});assert.equal(result.total,600);assert.equal(result.complete,false);
});
test('spare module uses Mold catalog and filters requested categories without source mutation',async()=>{
  const calls=[];const source=createSource(config,async(url,options)=>{calls.push({url,options});return response({code:0,total:3,data:[{bjbh:'MOCK-1',bjmc:'定位销',nowStock:2},{bjbh:'MOCK-2',bjmc:'伸缩气缸',nowStock:3},{bjbh:'MOCK-3',bjmc:'螺栓',nowStock:4}]});});const result=await source.read('spares',q(),{token:'mock'});assert.equal(result.total,2);assert.equal(calls[0].url.pathname,'/api/Mold_SparepartsDetailed');assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].url.searchParams.has('start'),false);
});
test('rejects missing totals, unexpected list format and authentication failures',async()=>{
  for(const payload of [{code:0,total:null,data:[]},{code:0,total:0,data:{}},{code:401,msg:'登录过期'}]){const source=createSource(config,async()=>response(payload));await assert.rejects(source.read('weld',q(),{token:'mock'}));}
});
test('invalid dates and excessive spans are rejected; live window rolls to today',()=>{
  assert.throws(()=>parseQuery(new URLSearchParams('start=2026-02-31&end=2026-03-02'),'weld'));
  assert.throws(()=>parseQuery(new URLSearchParams('start=2026-01-01&end=2026-12-31'),'weld'));
  const live=parseQuery(new URLSearchParams('view=live&start=2026-01-01&end=2026-01-01'),'weld');assert.equal(live.start,live.end);assert.notEqual(live.start,'2026-01-01');
});
