'use strict';
// Isolated UI fixture: only synthetic inventory and vision records, no company config.
// Stock control changes this process's in-memory array only. All business writes fail closed.
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createPortal}=require('../server.cjs');
const {makeAdminConfig}=require('../lib/admin.cjs');
const {createMemberStore}=require('../lib/members.cjs');
const {createVisionService,parseCsv}=require('../lib/vision.cjs');
const {buildWeldDashboard}=require('../lib/weld-report.cjs');
const {buildAlarmReport}=require('../lib/alarm-report.cjs');
const {FIELD_MAP,COLUMNS}=require('../lib/source.cjs');
async function main(){
  const base=path.resolve(os.tmpdir()),root=await fs.mkdtemp(path.join(base,'gongyi-workbench-preview-'));
  const password='Workbench-preview-only-2026',admin=makeAdminConfig('preview-admin',password),members=createMemberStore({root,admin});
  members.save({account:'preview-member',name:'合成测试成员',role:'member',active:true,password,createOnly:true},members.get('preview-admin'));
  const items=Array.from({length:263},(_,i)=>({id:'synthetic-'+(i+1),sourceIdentity:'a'.repeat(64),code:'TEST-'+String(i+1).padStart(4,'0'),name:'合成备件 '+(i+1),specification:'TEST-MODEL-'+(i%7+1),location:'测试库位 A-'+(i%11+1),unit:'件',stock:12+i%9,selectable:true}));
  const records=Array.from({length:45},(_,i)=>({id:'synthetic-record-'+i,type:i%2?'count':'inbound',status:i%2?'pending':'applied',item:items[i],beforeStock:12,quantity:2,actualQuantity:10,difference:-2,createdAt:'2026-10-15T00:30:00Z',actor:{account:'preview-admin',name:'合成管理员'},remark:'合成测试记录'}));
  let failCatalog=false;
  const blocked=async()=>{throw Object.assign(new Error('隔离验证只允许查看，不接受库存写入。'),{status:403});};
  const inventoryService={
    async capabilities(){return {inbound:{enabled:true},outbound:{enabled:false,reason:'合成场景：出库接口尚未开放'},adjust:{enabled:false,reason:'合成场景：调账尚未开放'}};},
    async catalog({search='',code=''}={}){if(failCatalog)throw new Error('合成测试：库存读取失败');const filtered=items.filter(item=>code?item.code===code:Object.values(item).some(value=>String(value).includes(search)));return {items:structuredClone(filtered),sourceIdentity:'a'.repeat(64),complete:true,fetchedAt:new Date().toISOString(),inventoryLabel:'合成备件库 · 263 条',note:'只用于界面检查，全部为合成数据。',unmatched:[]};},
    async list({type,status}={}){if(type==='inbound')await new Promise(resolve=>setTimeout(resolve,700));return {records:records.filter(record=>(!type||record.type===type)&&(!status||record.status===status)),counts:{pending:22}};},
    transact:blocked,count:blocked,review:blocked
  };
  const csv=['PartName,Tesla_Front12,,,,,','SN,SYNTHETIC-ONLY-001,,,,,','TimeStamp,2026/10/15 08:15:00,,,,,','Result,OK,,,,,','Name,Nominal,Lower_SL,Upper_SL,IsCritical,Dev,OK/NG',...Array.from({length:61},(_,i)=>`合成测点_${i+1},10,-0.5,0.5,Yes,0.1,OK`)].join('\r\n')+'\r\n';
  const sample=parseCsv({filename:'Tesla_Front12_20261015-081500.csv',deviceId:'vision-01',content:csv});
  await fs.mkdir(path.join(root,'runtime'),{recursive:true});await fs.writeFile(path.join(root,'runtime/vision-input.json'),JSON.stringify({schema_version:1,records:[sample],last_scan:{scanned_at_utc:'2026-10-15T00:30:00Z',errors:[],deferred:0}}));
  const visionService=createVisionService({root});
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const weldRows=Array.from({length:100},(_,i)=>({id:'synthetic-weld-'+i,barcode:`SYN${11+i%3}A${String(i).padStart(3,'0')}`,item_code:'FRONT_PRIMARY',item_name:'合成前副物料',badness_location_name:`合成位置-OP${120+i%5*10}-BR${i%4+1}`,badness_type:i%2?'焊接尺寸':'焊缝外观',badness_content:i%2?'焊偏':'焊穿',gx_code:'SYN-OP-'+i%5,gx_name:'合成工序',remark:'仅用于界面验证',staff_code:'SYNTHETIC',staff_name:'合成测试员',create_time:`${day} 08:${String(i%60).padStart(2,'0')}:00`}));
  const alarmRows=Array.from({length:45},(_,i)=>({id:'synthetic-alarm-'+i,equipment:'合成设备 '+i%7,equipMentCode:'SYNTHETIC-EQ-'+i%7,line:`${11+i%3}线前副`,groupName:i%2?'合成设备组':'合成工艺组',remark:'合成测试报警',beforeProblem:'合成故障现象',dealProblem:'合成原因',causeAnalysis:'合成处理方法',createOn:`${day} 08:00:00`,responseState:i%4?1:0,isClose:i%4===3?1:0,responseTime:i%4?`${day} 08:10:00`:null,dealTime:i%4>=2?`${day} 08:25:00`:null,trackOn:i%4===3?`${day} 08:30:00`:null}));
  let expireNextRead=false,readDelay=0;const readQueries=[];
  const autoSource={start(){},stop(){},status(){return {state:'ready',configured:true,lastSuccessAt:new Date().toISOString()};},async read(module,query){
    readQueries.push({module,query:structuredClone(query),at:new Date().toISOString()});if(readDelay)await new Promise(resolve=>setTimeout(resolve,readDelay));if(expireNextRead){expireNextRead=false;throw Object.assign(new Error('合成验证：会话已失效'),{status:401});}
    const options={fieldMap:FIELD_MAP,startDate:query.start,endDate:query.end,materialName:query.materialName,line:query.line,defects:query.defects,defectType:query.defectType,op:query.op,location:query.location,keyword:query.keyword,status:query.status,department:query.department,sourceComplete:true,departmentRules:[{department:'设备部',groupPattern:'^合成设备组$'},{department:'工艺部',groupPattern:'^合成工艺组$'}]};
    const report=module==='weld'?buildWeldDashboard(weldRows,options):module==='alarm'?buildAlarmReport(alarmRows,options):null;
    const rows=report?.filteredRows||[];if(report)delete report.filteredRows;const size=query.size||50,page=Math.min(query.page||1,Math.max(1,Math.ceil(rows.length/size)));
    return {rows:rows.slice((page-1)*size,page*size),columns:COLUMNS[module]||[],page,size,total:rows.length,sourceTotal:rows.length,complete:true,fetchedAt:new Date().toISOString(),sourceTime:`${day}T08:30:00+08:00`,note:'全部为合成验证数据，无公司系统连接。',...(module==='weld'?{report}:module==='alarm'?{alarmReport:report}:{})};
  }};
  const credentialStore={async load(){throw Error('No credentials in isolated fixture');},async save(){throw Error('No credentials in isolated fixture');},async remove(){}};
  const server=createPortal({root,config:{admin,environmentLabel:'隔离验证 · 全部合成数据 · 不能修改公司库存'},source:{},autoSource,credentialStore,memberStore:members,inventoryService,visionService});
  const handlers=server.listeners('request');server.removeAllListeners('request');server.on('request',(req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    if(req.method==='POST'&&url.pathname==='/__fixture/change-stock'){const item=items.find(item=>item.id===url.searchParams.get('id'))||items[0];item.stock+=3;res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({synthetic:true,id:item.id,stock:item.stock}));}
    if(req.method==='POST'&&url.pathname==='/__fixture/fail-catalog'){failCatalog=url.searchParams.get('enabled')!=='false';res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({synthetic:true,failCatalog}));}
    if(req.method==='POST'&&url.pathname==='/__fixture/expire-next-read'){expireNextRead=true;res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({synthetic:true,expireNextRead}));}
    if(req.method==='POST'&&url.pathname==='/__fixture/read-delay'){readDelay=Math.max(0,Math.min(5000,Number(url.searchParams.get('ms'))||0));res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({synthetic:true,readDelay}));}
    if(req.method==='GET'&&url.pathname==='/__fixture/requests'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(readQueries));}
    for(const handler of handlers)handler(req,res);
  });
  server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:`http://localhost:${server.address().port}/#spares`,accounts:['preview-admin','preview-member'],password,controls:{changeStock:'POST /__fixture/change-stock?id=synthetic-21',failCatalog:'POST /__fixture/fail-catalog?enabled=true',expireNextRead:'POST /__fixture/expire-next-read',readDelay:'POST /__fixture/read-delay?ms=2000',queries:'GET /__fixture/requests'}})));
  let closing=false;const close=async()=>{if(closing)return;closing=true;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));const resolved=path.resolve(root);if(path.dirname(resolved)===base&&path.basename(resolved).startsWith('gongyi-workbench-preview-'))await fs.rm(resolved,{recursive:true,force:true});process.exit(0);};
  process.on('SIGINT',close);process.on('SIGTERM',close);process.stdin.on('data',data=>{if(String(data).trim()==='stop')close();});
}
main().catch(error=>{console.error(error);process.exitCode=1;});
