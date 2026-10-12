'use strict';
const { createHash } = require('node:crypto');
const { buildWeldDashboard, normalizeDate } = require('./weld-report.cjs');
const { buildAlarmReport } = require('./alarm-report.cjs');
const { buildSparesReport } = require('./spares-report.cjs');
const PATHS = Object.freeze({weld:'/api/hj_unqualified/logsheet',alarm:'/api/UDP_AD_ErrorInfo',spares:'/api/Mold_SparepartsDetailed'});
const columns = entries => entries.map(([key,label])=>({key,label}));
const COLUMNS = {
  weld: columns([['barcode','二维码'],['item_code','物料编号'],['item_name','物料名称'],['badness_location_name','缺陷位置'],['badness_type','缺陷大类'],['badness_content','缺陷细类'],['gx_code','工序编码'],['gx_name','工序名称'],['remark','备注'],['staff_code','员工编号'],['staff_name','员工名称'],['create_time','录入时间']]),
  alarm: columns([['_alarmLine','线体'],['_alarmDepartment','归口部门'],['equipment','设备'],['equipMentCode','设备编码'],['line','区域'],['_alarmStatusLabel','报警状态'],['remark','异常类别'],['beforeProblem','发生时问题描述'],['responseTime','响应时间'],['dealTime','解决时间'],['trackOn','复线时间'],['dealProblem','故障真实原因'],['causeAnalysis','解决对策'],['createOn','创建时间']]),
  spares: columns([['BarCode','备件二维码'],['bjbh','备件编号'],['bjmc','备件名称'],['sparepartName','备件类型'],['nowStock','当前库存'],['specifications','规格型号'],['location','库位'],['maxStock','最大库存'],['minStock','最小库存'],['createOn','创建日期']])
};
class PortalError extends Error { constructor(message,status=502){super(message);this.status=status;} }
const FIELD_MAP = {material:'item_code',materialName:'item_name',defectType:'badness_type',defect:'badness_content',qr:'barcode',location:'badness_location_name',remark:'remark',recordedAt:'create_time',id:'id'};
function dayNow(){return normalizeDate(new Date());}
function boundedInt(value,fallback,min,max){const number=Number(value);return Number.isInteger(number)&&number>=min&&number<=max?number:fallback;}
function exactFilter(params,key,max){const value=params.get(key)||'all';if(value.length>max)throw new PortalError('筛选内容过长，请重新选择工位或位置。',400);return value;}
function parseQuery(params,module){
  const today=dayNow(), live=module==='weld'&&params.get('view')==='live';
  const start=live?today:params.get('start')||today,end=live?today:params.get('end')||today;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||normalizeDate(start)!==start||normalizeDate(end)!==end||start>end)throw new PortalError('请选择有效的日期区间。',400);
  if((Date.parse(end)-Date.parse(start))/86400000>41)throw new PortalError('一次最多查询42天，请缩小日期范围。',400);
  return {start,end,view:live?'live':'weekly',page:boundedInt(params.get('page'),1,1,100000),size:boundedInt(params.get('size'),50,1,200),keyword:(params.get('keyword')||'').trim().slice(0,100),category:['pin','cylinder'].includes(params.get('category'))?params.get('category'):'all',product:['front','rear','other'].includes(params.get('product'))?params.get('product'):'all',line:(params.get('line')||'all').slice(0,160),defects:[...new Set(params.getAll('defect').filter(Boolean).map(x=>x.slice(0,100)))].slice(0,100),defectType:exactFilter(params,'defectType',160),op:exactFilter(params,'op',160),location:exactFilter(params,'location',500),status:['unresponded','processing','awaiting_restore','completed','unknown'].includes(params.get('status'))?params.get('status'):'all',group:(params.get('group')||'all').slice(0,160),department:(params.get('department')||'all').slice(0,160),stock:['out','low','normal','unknown'].includes(params.get('stock'))?params.get('stock'):'all'};
}
function createSource(config,fetchImpl=fetch){
  let base;
  try{base=new URL(config.apiBase);if(!['http:','https:'].includes(base.protocol)||base.username||base.password)throw new Error();}catch(_){throw new PortalError('请配置有效的公司系统地址。',503);}
  async function request(path,{token,method='GET',body,query}={}){
    const url=new URL(path,base);if(query)for(const [key,value] of Object.entries(query))if(value!==undefined&&value!=='')url.searchParams.set(key,String(value));
    const headers={Accept:'application/json',language:config.language||'0'};
    if(token)headers.Authorization=`Bearer ${token}`;
    if(config.tenantId)headers['TENANT-ID']=String(config.tenantId);
    if(body)headers['Content-Type']='application/json';
    let response;
    try{response=await fetchImpl(url,{method,headers,body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(18000)});}catch(_){throw new PortalError('公司系统连接超时或不可达，请确认电脑已连接公司网络。',504);}
    if(response.status===401)throw new PortalError('公司系统登录已过期，请重新登录。',401);
    if(response.status===403)throw new PortalError('当前账号没有该模块的读取权限。',403);
    if(!response.ok)throw new PortalError(`公司系统暂时无法响应（HTTP ${response.status}）。`);
    let json;try{json=await response.json();}catch(_){throw new PortalError('公司系统返回格式变化，尚未更新本次数据。');}
    if(Number(json.code)!==0){
      const msg=String(json.msg||json.message||'').slice(0,180);
      if(method==='POST'){
        const known=/密码错误|密码不正确|账号或密码/.test(msg)?'公司系统返回：账号或密码不正确。':/账号不存在|账户不存在|用户不存在/.test(msg)?'公司系统返回：账号不存在。':/锁定|禁用/.test(msg)?'公司系统返回：账号被锁定或禁用。':/验证码/.test(msg)?'公司系统要求验证，请先在原系统完成验证。':'公司系统拒绝了登录，请核对账号状态或登录接口配置。';
        throw new PortalError(known,401);
      }
      if(/登录|token|unauthor|认证|过期/i.test(msg)||Number(json.code)===401)throw new PortalError('公司系统登录已失效，请重新登录。',401);
      throw new PortalError(method==='POST'?'登录失败，请检查账号和密码。':'公司系统未允许本次查询，请核对账号权限和筛选条件。',method==='POST'?401:502);
    }
    return json;
  }
  async function login(username,password){
    if(!Object.hasOwn(config,'loginToken'))throw new PortalError('本地连接配置尚未完成，请配置系统登录参数。',503);
    const body={account:username,pwd:createHash('md5').update(password).digest('hex')};
    if(config.loginToken)body.token=config.loginToken;
    const json=await request('/api/User_Login',{method:'POST',body});
    if(typeof json.data?.token!=='string'||!json.data.token)throw new PortalError('登录响应缺少有效会话，未建立连接。');
    return {token:json.data.token,account:username};
  }
  async function allRows(module,query,session){
    const size=200,maxPages=boundedInt(config.maxPages,50,1,150),rows=[],priorIds=new Set();let total=null,complete=false,note='',firstTotal=null,overlap=false,totalChanged=false;
    const started=Date.now();
    for(let page=1;page<=maxPages;page++){
      const data=await request(PATHS[module],{token:session.token,query:{...query,page,size,_t:Date.now(),pageShow:7}});
      if(!Array.isArray(data.data))throw new PortalError('公司系统列表字段变化，未覆盖上次成功数据。');
      const reported=Number(data.total);
      if(data.total===null||data.total===undefined||data.total===''||!Number.isInteger(reported)||reported<0)throw new PortalError('公司系统缺少可信的记录总数，无法确认分页完整性。');
      if(firstTotal===null)firstTotal=reported;
      if(reported!==firstTotal)totalChanged=true;
      const pageIds=data.data.map(row=>row?.id).filter(id=>id!==undefined&&id!==null&&id!=='').map(String),currentIds=new Set(pageIds);
      if(pageIds.length!==currentIds.size)overlap=true;
      if([...currentIds].some(id=>priorIds.has(String(id))))overlap=true;
      for(const id of currentIds)priorIds.add(String(id));
      total=reported;rows.push(...data.data);
      if(data.data.length>size)throw new PortalError('公司系统未按分页大小返回，停止读取。');
      if(rows.length>=reported||data.data.length===0){complete=rows.length===reported&&!totalChanged&&!overlap;break;}
      if(Date.now()-started>43000){note='读取达到本次时间上限，仅统计已获取记录。';break;}
    }
    if(overlap)note='源系统分页出现重复记录ID，统计保留原始记录，但完整性未通过核对；请缩小日期范围后重试。';
    if(!complete&&!note)note='取数达到上限或查询期间源数据变化，仅统计已获取记录；可缩小日期范围后重试。';
    return {rows,total,complete,note,fetchedAt:new Date().toISOString()};
  }
  async function defectCatalog(rows,session){
    const parents=new Map(),conflicts=new Set();let unresolvedRows=0;
    for(const row of rows){
      const id=String(row.badness_type_id??'').trim(),name=String(row.badness_type??'').trim();
      if(!/^[A-Za-z0-9_-]{1,80}$/.test(id)||!name){unresolvedRows++;continue;}
      if(parents.has(id)&&parents.get(id)!==name)conflicts.add(id);else parents.set(id,name);
    }
    session.defectCatalogCache ||= new Map();session.defectCatalogPending ||= new Map();
    const selected=[...parents].filter(([id])=>!conflicts.has(id)).slice(0,12);
    const catalogs=await Promise.all(selected.map(async([id,name])=>{
      const cached=session.defectCatalogCache.get(id),now=Date.now();
      let entry=cached;
      if(!entry||now-entry.at>(entry.ok?3600000:30000)){
        if(!session.defectCatalogPending.has(id))session.defectCatalogPending.set(id,(async()=>{
          try{
            const json=await request('/api/unqualified/getall/badness_content',{token:session.token,query:{search:'',id}});
            if(!Array.isArray(json.data)||json.data.length>500||json.data.some(item=>typeof item?.label!=='string'||!item.label.trim()||item.value==null))throw new Error('Invalid defect dictionary');
            const names=[...new Set(json.data.map(item=>typeof item?.label==='string'&&item.value!=null?item.label.trim():'').filter(Boolean))];
            if(!names.length)throw new Error('Empty defect dictionary');
            return {at:Date.now(),ok:true,defects:names};
          }catch(_){return {at:Date.now(),ok:false,defects:[]};}
        })());
        try{entry=await session.defectCatalogPending.get(id);session.defectCatalogCache.set(id,entry);while(session.defectCatalogCache.size>24)session.defectCatalogCache.delete(session.defectCatalogCache.keys().next().value);}
        finally{session.defectCatalogPending.delete(id);}
      }
      return entry.ok?{defectType:name,defects:entry.defects}:null;
    }));
    const data=catalogs.filter(Boolean),complete=parents.size>0&&data.length===parents.size&&!conflicts.size&&!unresolvedRows;
    return {data,status:{available:data.length>0,complete,requestedTypes:parents.size,loadedTypes:data.length,unresolvedRows,note:complete?'分类名称来自原系统缺陷字典。':'完整分类暂时未取得，当前保留已有日志中的分类。'}};
  }
  async function read(module,q,session){
    const filter=module==='spares'?{}:{start:q.start+' 00:00:00',end:q.end+' 23:59:59'};
    session.sourceCache ||= new Map();session.sourcePending ||= new Map();
    const sourceKey=module+JSON.stringify(filter),cached=session.sourceCache.get(sourceKey),ttl=module==='spares'?29000:14000;
    let fetched;
    if(cached&&Date.now()-cached.at<ttl)fetched={...cached.value};
    else{
      if(!session.sourcePending.has(sourceKey))session.sourcePending.set(sourceKey,allRows(module,filter,session));
      try{fetched=await session.sourcePending.get(sourceKey);session.sourceCache.set(sourceKey,{at:Date.now(),value:fetched});while(session.sourceCache.size>6)session.sourceCache.delete(session.sourceCache.keys().next().value);fetched={...fetched};}finally{session.sourcePending.delete(sourceKey);}
    }
    let rows=fetched.rows;
    const dateKey=module==='weld'?'create_time':module==='alarm'?'createOn':null;
    if(dateKey){
      const inWindow=row=>{const day=normalizeDate(row[dateKey]);return day&&day>=q.start&&day<=q.end;};
      if(rows.some(row=>!inWindow(row))){fetched.complete=false;fetched.note='源系统返回了日期范围外或缺少日期的记录，当前仅统计可核对的范围内记录。';}
      rows=rows.filter(inWindow);
    }
    let report,alarmReport,sparesReport;
    if(module==='weld'){
      const catalog=await defectCatalog(rows,session);
      report=buildWeldDashboard(rows,{fieldMap:FIELD_MAP,materialGroups:config.materialGroups,startDate:q.start,endDate:q.end,product:q.product,line:q.line,defects:q.defects,defectType:q.defectType,defectCatalog:catalog.data,op:q.op,location:q.location,keyword:q.keyword,lineFields:config.weldLineFields,lineRules:config.weldLineRules,sourceComplete:fetched.complete,source:'焊接不合格日志',timeZone:'Asia/Shanghai',coverage:[{startDate:q.start,endDate:q.end,complete:fetched.complete&&q.end<dayNow(),source:'本次接口分页读取'}],weekLabel:(start,end)=>`${start.slice(5)} — ${end.slice(5)}`});
      report.catalogStatus={...report.catalogStatus,...catalog.status};
      rows=report.filteredRows;delete report.filteredRows;
    }
    if(module==='alarm'){
      alarmReport=buildAlarmReport(rows,{startDate:q.start,endDate:q.end,status:q.status,line:q.line,group:q.group,department:q.department,departmentRules:config.alarmDepartmentRules,departments:config.alarmDepartments,alarmLineRules:config.alarmLineRules,keyword:q.keyword,sourceComplete:fetched.complete});
      rows=alarmReport.filteredRows;delete alarmReport.filteredRows;
    }
    if(module==='spares'){sparesReport=buildSparesReport(rows,{category:q.category,keyword:q.keyword,stock:q.stock});rows=sparesReport.filteredRows;delete sparesReport.filteredRows;delete sparesReport.cards;}
    if(dateKey)rows.sort((a,b)=>String(b[dateKey]||'').localeCompare(String(a[dateKey]||'')));
    const result={rows:rows.slice((q.page-1)*q.size,q.page*q.size),total:rows.length,sourceTotal:fetched.total,page:q.page,size:q.size,fetchedAt:fetched.fetchedAt,sourceTime:dateKey?rows.map(row=>row[dateKey]).filter(Boolean).sort().at(-1)||null:null,complete:fetched.complete,columns:COLUMNS[module],note:fetched.note};
    if(module==='weld'){
      result.report=report;
      result.note+=' 图表与明细使用相同筛选范围。历史趋势仅显示已读取日期；实时累计不代表完整周。';
    }
    if(module==='alarm')result.alarmReport=alarmReport;
    if(module==='spares'){result.sparesReport=sparesReport;result.note+=' 当前展示所选备件的库存快照，日期筛选不作用于当前库存。';}
    return result;
  }
  return {login,read};
}
module.exports={createSource,parseQuery,PortalError,COLUMNS,FIELD_MAP};
