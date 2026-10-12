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
  const first=await source.read('weld',q(),session);assert.equal(first.total,201);assert.equal(first.rows.length,50);assert.equal(first.report.overview.recordCount,201);assert.equal(first.complete,true);assert.equal(calls.length,2);assert.equal(calls[0].options.headers.Authorization,'Bearer mock-token');assert.equal(calls[0].url.searchParams.get('start'),'2026-09-21 00:00:00');
  const next=await source.read('weld',q({page:2}),session);assert.equal(next.rows.length,50);assert.equal(calls.length,2);assert.equal(next.fetchedAt,first.fetchedAt);
});
test('page cap yields partial report and unknown weekly coverage',async()=>{
  const source=createSource({...config,maxPages:1},async()=>response({code:0,total:250,data:Array.from({length:200},(_,i)=>row(i))}));const result=await source.read('weld',q(),{token:'mock'});
  assert.equal(result.complete,false);assert.equal(result.total,200);assert.equal(result.sourceTotal,250);assert.equal(result.report.period.coverage.status,'partial');assert.match(result.note,/上限/);
});
test('changing source total is reported partial, exact duplicated rows are preserved',async()=>{
  let i=0;const source=createSource(config,async()=>response(++i===1?{code:0,total:202,data:Array(200).fill(row(1))}:{code:0,total:201,data:[row(1)]}));const result=await source.read('weld',q(),{token:'mock'});assert.equal(result.complete,false);assert.equal(result.report.overview.recordCount,201);assert.equal(result.report.overview.pieceCount,1);
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
test('all materials and defects are included by default and selected filters align summary and detail',async()=>{
  const data=[row(1),{...row(2),item_code:'OTHER_PART',badness_content:'气孔',lineName:'其他线体'}, {...row(3),badness_content:'漏焊'}];
  const source=createSource(config,async()=>response({code:0,total:3,data}));const session={token:'mock'};
  const all=await source.read('weld',q(),session);assert.equal(all.report.overview.recordCount,3);assert.equal(all.report.overview.defectTypeCount,3);
  const filtered=await source.read('weld',q({defects:['气孔'],line:'其他线体'}),session);assert.equal(filtered.total,1);assert.equal(filtered.report.overview.recordCount,1);assert.equal(filtered.rows[0].item_code,'OTHER_PART');
});
test('keyword filters alarm report and paginated detail equally',async()=>{
  const data=[{equipment:'示例设备甲',isClose:0,responseState:0,line:'示例区域',createOn:'2026-09-25 12:00:00'},{equipment:'示例设备乙',isClose:1,line:'其他区域',createOn:'2026-09-25 12:00:00'}];
  const source=createSource(config,async()=>response({code:0,total:2,data}));const r=await source.read('alarm',q({keyword:'甲'}),{token:'mock'});
  assert.equal(r.total,1);assert.equal(r.alarmReport.overview.recordCount,1);assert.equal(r.rows[0]._alarmStatus,'unresponded');assert.equal(r.alarmReport.dailyTrend.reduce((sum,d)=>sum+d.total,0),1);
});
test('repeated defect selections and alarm filters parse predictably',()=>{
  const p=new URLSearchParams('defect=焊偏&defect=气孔&defect=气孔&product=other&line=示例线&status=processing&group=示例小组');const parsed=parseQuery(p,'weld');
  assert.deepEqual(parsed.defects,['焊偏','气孔']);assert.equal(parsed.product,'other');assert.equal(parsed.status,'processing');assert.equal(parsed.line,'示例线');
});

test('weld drill-down applies exact normalized OP and location before page slicing',async()=>{
  const data=[row(1),{...row(2),badness_location_name:'TSL-02-OP020-A'}, {...row(3),badness_location_name:'TSL-02-OP020-B'}, {...row(4),badness_location_name:'TSL-03-OP020-A'}];
  const source=createSource(config,async()=>response({code:0,total:data.length,data}));
  const parsed=parseQuery(new URLSearchParams({start:'2026-09-21',end:'2026-09-27',defect:'焊偏',line:'11线前副',op:'OP20',location:'TSL-02-OP20',size:'1'}),'weld');
  const result=await source.read('weld',parsed,{token:'mock'});
  assert.equal(result.total,2);assert.equal(result.rows.length,1);assert.equal(result.report.overview.recordCount,2);
  assert.equal(result.report.selected.op,'OP20');assert.equal(result.report.selected.location,'TSL-02-OP20');
  assert.equal(result.report.defectSummary[0].lines[0].ops[0].locations[0].recordCount,2);
  assert.equal(parseQuery(new URLSearchParams(),'weld').op,'all');
  assert.throws(()=>parseQuery(new URLSearchParams({location:'X'.repeat(501)}),'weld'),/筛选内容过长/);
});

test('verified classification dictionary augments observed details and is cached within the source session',async()=>{
  let dictionaryReads=0;
  const data=[{...row(1),badness_type:'示例焊接类',badness_type_id:'synthetic-type',badness_content_id:'synthetic-offset'}];
  const source=createSource(config,async url=>{
    if(url.pathname==='/api/unqualified/getall/badness_content'){
      dictionaryReads++;assert.equal(url.searchParams.get('id'),'synthetic-type');
      return response({code:0,data:[{label:'焊偏',value:'synthetic-offset'},{label:'断焊/未满焊',value:'synthetic-combined'}]});
    }
    return response({code:0,total:1,data});
  });
  const session={token:'mock'},result=await source.read('weld',q(),session);
  assert.equal(result.report.catalogStatus.complete,true);assert.equal(result.report.defectTypeSummary[0].defectType,'示例焊接类');
  const combined=result.report.defectTypeSummary[0].defects.find(item=>item.defect==='断焊/未满焊');
  assert.equal(combined.recordCount,0);assert.equal(result.total,1);
  const filtered=await source.read('weld',q({defectType:'其他示例类'}),session);assert.equal(filtered.total,0);assert.equal(dictionaryReads,1);
});

test('dictionary denial keeps authorized business records and does not force new source login',async()=>{
  let dictionaryReads=0;
  const source=createSource(config,async url=>{
    if(url.pathname==='/api/unqualified/getall/badness_content'){dictionaryReads++;return {ok:false,status:403};}
    return response({code:0,total:1,data:[{...row(1),badness_type:'示例焊接类',badness_type_id:'synthetic-type'}]});
  });
  const session={token:'mock'},result=await source.read('weld',q(),session);
  assert.equal(result.total,1);assert.equal(result.complete,true);assert.equal(result.report.catalogStatus.available,false);
  assert.equal(result.report.defectTypeSummary[0].defects[0].defect,'焊偏');
  await source.read('weld',q(),session);assert.equal(dictionaryReads,1);
});

test('known catalog cannot certify classifications with missing source parent IDs',async()=>{
  const source=createSource(config,async url=>url.pathname==='/api/unqualified/getall/badness_content'
    ?response({code:0,data:[{value:'synthetic-offset',label:'焊偏'}]})
    :response({code:0,total:2,data:[{...row(1),badness_type:'示例类',badness_type_id:'synthetic-type'},{...row(2),badness_type:'未映射示例类'}]}));
  const result=await source.read('weld',q(),{token:'mock'});
  assert.equal(result.total,2);assert.equal(result.complete,true);assert.equal(result.report.catalogStatus.available,true);
  assert.equal(result.report.catalogStatus.complete,false);assert.equal(result.report.catalogStatus.unresolvedRows,1);
  assert.equal(result.report.defectTypeSummary.length,2);
});
test('duplicate IDs within one source page remain records but invalidate completeness',async()=>{
  const source=createSource(config,async()=>response({code:0,total:2,data:[row(1),row(1)]}));const r=await source.read('weld',q(),{token:'mock'});assert.equal(r.total,2);assert.equal(r.complete,false);assert.match(r.note,/重复记录ID/);
});
test('spare status filtering uses all fetched rows before pagination and prioritizes shortage',async()=>{
  const data=[{bjmc:'定位销正常',nowStock:5,minStock:3},{bjmc:'定位销缺货',nowStock:0,minStock:3},{bjmc:'定位销缺下限',nowStock:2}];
  const source=createSource(config,async()=>response({code:0,total:3,data}));const session={token:'mock'};
  const all=await source.read('spares',q({size:1}),session);assert.equal(all.rows[0]._stockStatus,'out');assert.equal(all.sparesReport.overview.total,3);
  const subset=await source.read('spares',q({stock:'unknown'}),session);assert.equal(subset.total,1);assert.equal(subset.rows[0].bjmc,'定位销缺下限');assert.equal(subset.sparesReport.overview.unknownCount,1);
});
