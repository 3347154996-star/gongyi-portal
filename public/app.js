(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const MODULES = {
    weld: {title:'补焊点',description:'默认查看当天实时缺陷记录，也可按日期、产品和线体查询趋势。',notice:'统计源自焊接不合格日志。日志条数不等于产品数，也不能据此确认已完成补焊。'},
    alarm: {title:'安灯报警',description:'按所选时间、线体和部门查看报警处理进度。',notice:'范围内的报警记录，不代表全部设备即时状态。'},
    vision: {title:'视觉检具',description:'按线体和检具查看检测结果、合格率趋势与测点明细。',notice:'仅纳入普通检测，排除 ALLmeasure 全检。统计按检测次数计算，同一 SN 复测分别保留。'},
    spares: {title:'备件管理',description:'入库、出库与盘点，在手机和电脑上完成；成员操作按登录工号留痕。',notice:'库存变化以公司系统回写确认为准。'}
  };
  const state = {status:null,authenticated:false,connected:false,module:'weld',view:'live',sparesView:'cards',defects:[],defectDraft:[],defectOptions:[],weldDefectType:'all',weldOp:'all',weldLocation:'all',page:1,size:50,result:null,error:'',loading:false,request:null,polling:true,interval:30,timer:null,statusTimer:null,cache:new Map(),statusLoading:false,statusRequest:null,authEpoch:0};
  let toastTimer;
  const importState={result:null,controller:null,revision:0};
  const weldDetail={snapshot:null,line:'all',actions:[]};
  const weldRanking={parent:null,mode:'observed',items:[]};
  function today(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
  function shiftDate(day,amount){const date=new Date(day+'T12:00:00Z');date.setUTCDate(date.getUTCDate()+amount);return date.toISOString().slice(0,10);}
  function dateTime(value){if(!value||/^(?:0000|0001)[-/]/.test(String(value)))return '—';const date=new Date(value);if(Number.isNaN(date.getTime()))return String(value);if(date.getFullYear()<=1)return '—';return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(date);}
  function numberText(value){return typeof value==='number'&&Number.isFinite(value)?value.toLocaleString('zh-CN'):'—';}
  function countValue(value){return value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value))?Number(value):null;}
  function errorText(error){return String(error&&error.message||'请求未完成，请稍后重试。').slice(0,350);}
  function notify(message){$('#toast').textContent=message;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),3600);}
  async function api(path,options={}){
    const response=await fetch(path,{credentials:'same-origin',cache:'no-store',...options});
    let data;try{data=await response.json();}catch(_){throw new Error('服务未返回可识别的数据，请检查本地服务是否正常。');}
    if(!response.ok){const error=new Error(data.message||data.error||data.note||`读取失败（HTTP ${response.status}）`);error.status=response.status;error.sourceStatus=data.sourceStatus;throw error;}
    return data;
  }
  function cacheKey(){return state.module;}
  function routeKey(){return state.module==='weld'?'weld-live':state.module;}
  function closeNav(){$('body').classList.remove('nav-open');$('#menuButton').setAttribute('aria-expanded','false');$('#navBackdrop').hidden=true;}
  function clearTimer(){if(state.timer){clearTimeout(state.timer);state.timer=null;}}
  function cancelRequest(){const request=state.request;if(request){state.request=null;request.controller.abort();clearTimeout(request.timeout);}state.loading=false;}
  function allowPolling(){return true;}
  function sourceState(){return state.status?.sourceStatus||{state:state.connected?'ready':'unconfigured',configured:state.connected};}
  function canRead(){return state.authenticated&&(state.connected||sourceState().configured===true);}
  function stopPolling(){state.polling=false;clearTimer();renderPolling();}
  function schedulePolling(){clearTimer();if(state.polling&&state.connected&&!document.hidden&&!state.request)state.timer=setTimeout(()=>loadData('poll'),state.interval*1000);}
  function renderPolling(){
    const allowed=allowPolling();$('#intervalField').hidden=!allowed;$('#pollButton').hidden=!allowed;
    $('#pollButton').disabled=!canRead();$('#pollButton').textContent=state.polling?'暂停自动刷新':'启动自动刷新';$('#pollButton').setAttribute('aria-pressed',String(state.polling));$('#pollButton').classList.toggle('active',state.polling);
    $('#pollStatus').textContent=!canRead()?'数据源配置完成后自动读取':state.polling?(document.hidden?'页面不可见，自动刷新已暂停':!state.connected?'等待数据源恢复后继续刷新':state.loading?'正在读取；完成后继续刷新':`自动刷新 · 每 ${state.interval} 秒`):'自动刷新已暂停';
    $$('.live-chip').forEach(chip=>{chip.classList.toggle('paused',!state.polling||!state.connected);chip.innerHTML=`<span aria-hidden="true"></span>${state.polling&&state.connected?'自动更新':'等待 / 暂停'}`;});
  }
  function safeSourceUrl(){
    const urls=state.status&&state.status.sourceUrls;let value=urls&&urls[state.module];if(value&&typeof value==='object')value=value.url;
    if(typeof value!=='string'||!value)return null;try{const url=new URL(value,location.href);return ['http:','https:'].includes(url.protocol)?url.href:null;}catch(_){return null;}
  }
  function renderConnection(){
    window.InventoryWorkbench?.setContext(state.authenticated?state.status:null,state.module==='spares');
    window.VisionWorkbench?.setContext(state.authenticated?state.status:null,state.module==='vision');
    $('#appShell').hidden=!state.authenticated;$('#loginScreen').hidden=state.authenticated;document.body.classList.toggle('logged-out',!state.authenticated);
    if(!state.authenticated){closeAlarmDetail();closeWeldDefectDetail();}
    const sourceInfo=sourceState(),labels={unconfigured:'待配置数据源',connecting:'数据源连接中',ready:'数据源已就绪',error:'数据源暂不可用'};
    $('#connectionBadge').textContent=labels[sourceInfo.state]||'检查数据源';$('#connectionBadge').classList.toggle('connected',state.connected);
    $('#loginButton').hidden=!state.authenticated||state.status?.role!=='admin';$('#logoutButton').hidden=!state.authenticated;
    $('#sourceStatusLine').className='source-status-line '+sourceInfo.state;
    $('#sourceStatusText').textContent=(typeof state.status?.environmentLabel==='string'&&state.status.environmentLabel.trim())||(sourceInfo.state==='ready'?'已配置数据源，正在按当前条件读取真实业务记录。':sourceInfo.state==='connecting'?'正在自动连接已配置的数据源，请稍候。':sourceInfo.state==='error'?`数据源暂不可用。${sourceInfo.error?' '+sourceInfo.error:''}${sourceInfo.retryAt?' 系统将于 '+dateTime(sourceInfo.retryAt)+' 自动重试。':' 请管理员检查数据源设置。'}`:'尚未配置数据源，请管理员从右上角“数据源设置”完成一次性配置。');
    $('#accountLabel').textContent=state.authenticated?`${state.status?.name||'工号'} · ${state.status?.account||'已登录'}${state.status?.role==='admin'?' · 管理员':state.status?.role==='reviewer'?' · 盘点复核人':''}`:'尚未登录';
    $('#queryButton').disabled=!canRead()||state.loading;$('#refreshButton').disabled=!canRead()||state.loading;
    $('#previewImport').disabled=!state.authenticated||!validImportFile($('#importFile').files[0])||Boolean(importState.controller);
    const source=safeSourceUrl();$('#sourceLink').hidden=!source;if(source)$('#sourceLink').href=source;
    if(state.module==='vision'){$('#connectionBadge').textContent='视觉检具数据';$('#connectionBadge').classList.remove('connected','error');$('#loginButton').hidden=true;$('#sourceLink').hidden=true;}
    renderPolling();
  }
  function invalidateStatusRequest(){state.authEpoch++;clearTimeout(state.statusTimer);state.statusTimer=null;const request=state.statusRequest;state.statusRequest=null;state.statusLoading=false;if(request)request.controller.abort();}
  async function checkStatus({read=false}={}){
    if(state.statusRequest)return state.statusRequest.promise;
    const request={controller:new AbortController(),epoch:state.authEpoch};state.statusRequest=request;state.statusLoading=true;renderConnection();
    request.promise=(async()=>{
      try{
        const wasReady=state.connected,status=await api('/local/status',{signal:request.controller.signal});if(state.statusRequest!==request||request.epoch!==state.authEpoch)return;
        state.status=status;state.authenticated=Boolean(status.authenticated);state.connected=state.authenticated&&Boolean(status.connected);$('#connectionBadge').classList.remove('error');
        if(!state.authenticated){clearTimer();cancelRequest();if($('#connectionDialog').open)$('#connectionDialog').close();}
        if(!state.connected)clearTimer();
        if(state.connected&&(read||!wasReady&&(state.polling||!state.result))&&!state.request)await loadData('initial');else renderResult();
      }catch(error){
        if(state.statusRequest!==request||request.epoch!==state.authEpoch||error.name==='AbortError')return;
        state.connected=false;if(error.status===401)state.authenticated=false;clearTimer();state.error='数据源状态读取失败：'+errorText(error);
        if(state.status)state.status.sourceStatus={...sourceState(),state:'error',error:state.error,retryAt:null};
        $('#connectionBadge').classList.add('error');$('#loginError').textContent=state.error;$('#loginError').hidden=false;renderResult();
      }finally{if(state.statusRequest===request&&request.epoch===state.authEpoch){state.statusRequest=null;state.statusLoading=false;renderConnection();scheduleStatus();}}
    })();
    return request.promise;
  }
  function scheduleStatus(){clearTimeout(state.statusTimer);state.statusTimer=null;if(state.authenticated&&!document.hidden)state.statusTimer=setTimeout(()=>checkStatus(),state.connected?30000:10000);}
  function querySnapshot(){
    const live=state.module==='weld'&&state.view==='live';const rolling=live||$('#rangeMode').value==='today';
    const start=rolling?today():$('#startDate').value,end=rolling?today():$('#endDate').value;
    if(rolling){$('#startDate').value=start;$('#endDate').value=end;}
    const keyword=$('#keywordInput').value.trim();const category=state.module==='spares'?$('#categoryFilter').value:'all';
    return {module:state.module,view:state.view,page:state.page,size:state.size,start,end,keyword,category,stock:$('#stockFilter').value||'all',rolling,materialName:$('#materialFilter').value||'all',line:state.module==='alarm'?$('#alarmLineFilter').value:$('#weldLineFilter').value,defects:[...state.defects],defectType:state.weldDefectType,op:state.weldOp,location:state.weldLocation,status:$('#alarmStatusFilter').value,group:'all',department:$('#alarmDepartmentFilter').value};
  }
  function scopeText(query){if(!query)return '';const filters=[];if(query.keyword)filters.push('关键词：'+query.keyword);if(query.module==='spares'&&query.category!=='all')filters.push(query.category==='pin'?'定位销':'伸缩气缸');if(query.module==='spares'&&query.stock!=='all')filters.push('库存：'+({out:'缺货',low:'低库存',normal:'库存充足',unknown:'待核实'}[query.stock]||query.stock));if(query.module==='weld'){if(query.materialName&&query.materialName!=='all')filters.push('物料：'+query.materialName);filters.push(query.line&&query.line!=='all'?'线体：'+query.line:'全部线体');filters.push(query.defects?.length?'缺陷：'+query.defects.join('、'):'全部缺陷');if(query.defectType&&query.defectType!=='all')filters.push('不良分类：'+query.defectType);if(query.op&&query.op!=='all')filters.push('工位：'+weldOpLabel(query.op));if(query.location&&query.location!=='all')filters.push('位置：'+query.location);}if(query.module==='alarm'){if(query.status!=='all')filters.push('状态：'+({unresponded:'未响应',processing:'处理中',awaiting_restore:'待复线',completed:'已完成',unknown:'未知'}[query.status]||query.status));if(query.line!=='all')filters.push('产线 / 区域：'+query.line);if(query.department&&query.department!=='all')filters.push('部门：'+query.department);}return (query.module==='spares'?'库存快照':query.start+' 至 '+query.end)+(filters.length?' · '+filters.join(' · '):'');}
  function validateQuery(query){if(!/^\d{4}-\d{2}-\d{2}$/.test(query.start)||!/^\d{4}-\d{2}-\d{2}$/.test(query.end))return '请填写有效的开始和结束日期。';if(query.start>query.end)return '开始日期不能晚于结束日期。';return '';}
  async function loadData(reason='manual'){
    if(state.module==='spares'||state.module==='vision')return;
    if(!canRead()||state.request||(document.hidden&&reason==='poll'))return;
    const query=querySnapshot(),invalid=validateQuery(query);$('#queryError').hidden=!invalid;$('#queryError').textContent=invalid;if(invalid){stopPolling();return;}
    clearTimer();const controller=new AbortController();const request={controller,key:cacheKey(),query,reason,timedOut:false};request.timeout=setTimeout(()=>{request.timedOut=true;controller.abort();},60000);state.request=request;state.loading=true;state.error='';renderConnection();renderResult();
    const params=new URLSearchParams({page:String(query.page),size:String(query.size),keyword:query.keyword,category:query.category});if(query.module!=='spares'){params.set('start',query.start);params.set('end',query.end);}else params.set('stock',query.stock);if(query.module==='weld'){params.set('view',query.view);params.set('materialName',query.materialName||'all');params.set('line',query.line||'all');query.defects.forEach(defect=>params.append('defect',defect));params.set('defectType',query.defectType||'all');params.set('op',query.op||'all');params.set('location',query.location||'all');}if(query.module==='alarm'){params.set('status',query.status||'all');params.set('line',query.line||'all');params.set('group',query.group||'all');params.set('department',query.department||'all');}
    try{
      const data=await api(`/local/data/${query.module}?${params}`,{signal:controller.signal});
      if(state.request!==request)return;if(!data||!Array.isArray(data.rows))throw new Error('接口记录格式不符合约定，未覆盖上次成功数据。');
      state.result={data,query,successAt:data.fetchedAt||new Date().toISOString()};state.cache.set(request.key,state.result);state.error='';state.connected=true;if(state.status?.sourceStatus)state.status.sourceStatus={...state.status.sourceStatus,state:'ready',configured:true,error:null};updateFilterOptions(data,query);
    }catch(error){
      if(state.request!==request)return;if(error.name==='AbortError'&&!request.timedOut)return;
      state.error=request.timedOut?'读取超时，请稍后重试。':errorText(error);
      if(error.status===401){invalidateStatusRequest();state.authenticated=false;state.connected=false;stopPolling();state.error='门户登录已过期，请重新使用工号登录。';$('#passwordInput').value='';$('#loginError').textContent=state.error;$('#loginError').hidden=false;}
      else if(error.status===428){state.connected=false;clearTimer();if(error.sourceStatus&&state.status)state.status.sourceStatus=error.sourceStatus;state.error=errorText(error)+' 门户登录仍然有效。';scheduleStatus();}
      else if(error.status===403){stopPolling();state.error='当前账号没有读取此模块的权限，自动刷新已停止。请向系统管理员核对权限。';}
    }finally{
      clearTimeout(request.timeout);if(state.request===request){state.request=null;state.loading=false;renderConnection();renderResult();schedulePolling();}
    }
  }
  function valueText(value){if(value==null||value==='')return '—';if(typeof value==='object'){try{return JSON.stringify(value);}catch(_){return '—';}}if(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}(?:T|\s|$)/.test(value))return dateTime(value);return String(value);}
  function renderTable(data){
    let columns=Array.isArray(data.columns)?data.columns.filter(c=>c&&typeof c.key==='string'):[];
    if(!columns.length&&data.rows.length)columns=Object.keys(data.rows[0]).map(key=>({key,label:key}));
    if(state.module==='alarm')columns=columns.filter(column=>column.key!=='groupName');
    if(!data.rows.length)return '<div class="empty-state">接口本次返回 0 条记录。请结合日期、筛选条件和完整性提示判断。</div>';
    if(!columns.length)return '<div class="empty-state">已收到记录，但没有可展示的字段。</div>';
    return `<div class="table-wrap" tabindex="0" aria-label="业务记录，可横向滚动"><table><thead><tr>${columns.map(c=>`<th scope="col">${escape(c.label||c.key)}</th>`).join('')}</tr></thead><tbody>${data.rows.map(row=>`<tr>${columns.map(c=>`<td>${state.module==='alarm'&&c.key==='_alarmStatusLabel'?`<span class="alarm-status ${['unresponded','processing','awaiting_restore','completed','unknown'].includes(row._alarmStatus)?row._alarmStatus:'unknown'}">${escape(valueText(row[c.key]))}</span>`:escape(valueText(state.module==='spares'&&c.key==='createOn'?dateTime(row[c.key]):row[c.key]))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  const COLORS=['#477fcc','#46b7c7','#efa144','#75ae5f','#e3c458','#aeb7c5','#9586bb','#cf8498'];
  function lineColor(line){let hash=0;for(const char of String(line).trim())hash=(hash*31+char.charCodeAt(0))>>>0;return COLORS[hash%COLORS.length];}
  function list(value){return Array.isArray(value)?value:[];}
  function decimal(value,digits=2){return Number.isFinite(value)?value.toFixed(digits):'—';}
  function percent(value){return Number.isFinite(value)?(value*100).toFixed(1)+'%':'—';}
  function dashboardMetric(label,value,note,tone=''){return '<article class="dashboard-metric '+tone+'"><span>'+escape(label)+'</span><strong>'+escape(value)+'</strong><small>'+escape(note)+'</small></article>';}
  function chartPanel(title,content,note='',wide=false){return '<section class="panel dashboard-panel '+(wide?'wide':'')+'"><div class="panel-heading"><h2>'+escape(title)+'</h2></div>'+content+(note?'<p class="report-note">'+escape(note)+'</p>':'')+'</section>';}
  function emptyChart(message='当前范围暂无可展示记录'){return '<div class="chart-empty">'+escape(message)+'</div>';}
  function horizontalBars(items,{label='label',value='count',color='#416daf',unit='条',maxItems=10}={}){
    const rows=list(items).slice(0,maxItems),max=Math.max(1,...rows.map(item=>Number(item[value])||0));
    return rows.length?'<div class="ranking-bars">'+rows.map((item,index)=>'<div class="ranking-row"><span class="ranking-index">'+(index+1)+'</span><span class="ranking-name" title="'+escape(item[label])+'">'+escape(item[label])+'</span><div class="ranking-track"><span style="width:'+Math.max(0,Number(item[value])||0)/max*100+'%;background:'+(typeof color==='function'?color(item,index):color)+'"></span></div><strong>'+numberText(item[value])+'<small> '+escape(unit)+'</small></strong></div>').join('')+'</div>':emptyChart();
  }
  function trendChart(items,{daily=false,value='recordCount',title='条数'}={}){
    const rows=list(items),max=Math.max(1,...rows.map(item=>Number(item[value])||0));
    if(!rows.length)return emptyChart('尚未取得所选范围的趋势数据');
    return '<div class="timeline-chart" tabindex="0" aria-label="'+escape(title)+'趋势，可横向滚动">'+rows.map(item=>{const n=item[value],missing=n==null,date=item.date||item.startDate||item.label||'',label=daily?date.slice(5):date+(item.endDate?' 至 '+item.endDate:'');return '<div class="timeline-point '+(missing?'missing':'')+'"><strong>'+numberText(n)+'</strong><div class="timeline-space">'+(missing?'<span class="timeline-missing">未覆盖</span>':'<div class="timeline-bar" style="height:'+Math.max(n>0?3:0,Number(n)/max*125)+'px"></div>')+'</div><span>'+escape(label)+'</span>'+(!daily?'<small>'+(item.coverageStatus==='complete'?'覆盖已核对':missing?'数据缺失':'部分覆盖 / 待核实')+'</small>':'')+'</div>';}).join('')+'</div>';
  }
  function combinedTrend(items){
    const rows=list(items).slice(-5);if(!rows.length)return emptyChart('尚未取得五周趋势数据');
    const width=900,left=62,right=66,top=36,bottom=223,plot=width-left-right,step=plot/rows.length;
    const maxCount=Math.max(4,Math.ceil(Math.max(...rows.map(row=>Number(row.recordCount)||0))/4)*4),ratios=rows.map(row=>row.recordCount!=null&&Number.isFinite(row.recordsPerPiece)?row.recordsPerPiece:null),maxRatio=Math.max(1,...ratios.filter(value=>value!==null))*1.08;
    const x=index=>left+step*(index+.5),yCount=value=>bottom-Number(value)/maxCount*(bottom-top),yRatio=value=>bottom-Number(value)/maxRatio*(bottom-top);
    const grid=Array.from({length:5},(_,index)=>{const y=bottom-index/4*(bottom-top);return '<line x1="'+left+'" y1="'+y+'" x2="'+(width-right)+'" y2="'+y+'" class="combo-grid"/><text x="'+(left-12)+'" y="'+(y+5)+'" text-anchor="end" class="combo-count-tick">'+numberText(maxCount*index/4)+'</text><text x="'+(width-right+12)+'" y="'+(y+5)+'" class="combo-ratio-tick">'+(maxRatio*index/4).toFixed(2)+'</text>';}).join('');
    const bars=rows.map((row,index)=>{const center=x(index),missing=row.recordCount==null,w=Math.min(53,step*.36),y=missing?bottom:yCount(row.recordCount),from=String(row.startDate||row.label||'').slice(5),to=String(row.endDate||'').slice(5);return (missing?'<rect x="'+(center-w/2)+'" y="'+(top+45)+'" width="'+w+'" height="'+(bottom-top-45)+'" rx="4" class="combo-missing"/><text x="'+center+'" y="'+(bottom-22)+'" text-anchor="middle" class="combo-missing-text">缺失</text>':'<rect x="'+(center-w/2)+'" y="'+y+'" width="'+w+'" height="'+Math.max(0,bottom-y)+'" rx="3" class="combo-bar"><title>'+escape(row.startDate)+' 至 '+escape(row.endDate)+'：'+numberText(row.recordCount)+' 条</title></rect><text x="'+center+'" y="'+(y-9)+'" text-anchor="middle" class="combo-bar-label">'+numberText(row.recordCount)+'</text>')+'<text x="'+center+'" y="247" text-anchor="middle" class="combo-date">'+escape(from)+(to?' — '+escape(to):'')+'</text><text x="'+center+'" y="268" text-anchor="middle" class="combo-coverage">'+(row.coverageStatus==='complete'?'覆盖已核对':missing?'未取得历史':'部分覆盖 / 待核实')+'</text>';}).join('');
    let path='',active=false;ratios.forEach((value,index)=>{if(value===null){active=false;return;}path+=(active?' L ':' M ')+x(index)+' '+yRatio(value);active=true;});
    const points=ratios.map((value,index)=>value===null?'':'<circle cx="'+x(index)+'" cy="'+yRatio(value)+'" r="4.5" class="combo-dot"><title>'+decimal(value)+' 条/件</title></circle><text x="'+(x(index)+12)+'" y="'+(yRatio(value)-9)+'" class="combo-ratio-label">'+decimal(value)+'</text>').join('');
    return '<div class="combo-chart-wrap" tabindex="0" aria-label="五周趋势：蓝色柱为日志条数，橙色折线为条每件，缺失数据不连线"><svg class="combo-chart" viewBox="0 0 900 292" role="img" aria-label="日志条数和条每件趋势"><text x="'+left+'" y="17" class="combo-axis-title">日志条数</text><text x="'+(width-right)+'" y="17" text-anchor="end" class="combo-ratio-title">条 / 件</text>'+grid+bars+'<path d="'+path+'" class="combo-line"/>'+points+'</svg></div><div class="chart-legend"><span style="--legend-color:#477fcc">日志条数（左轴）</span><span style="--legend-color:#ef9d3f">条 / 件（右轴）</span></div>';
  }
  function opDonuts(groups){
    const rows=list(groups);if(!rows.length)return emptyChart('当前范围尚无 OP 工位汇总');
    return '<div class="op-donut-grid">'+rows.map(group=>{let cursor=0;const items=list(group.items),color=(item,index)=>item.op==='其他'?COLORS[5]:COLORS[index%5],segments=items.map((item,index)=>{const start=cursor;cursor+=(Number(item.count)||0)/Math.max(1,Number(group.recordCount)||0)*100;return color(item,index)+' '+start+'% '+cursor+'%';});return '<article class="op-donut-card"><h3><i style="background:'+lineColor(group.line)+'"></i><span class="op-line-name">'+escape(group.line)+'</span><span class="op-line-caption">OP 工位占比</span></h3><div class="op-donut-body"><div class="op-ring" style="--ring-fill:'+(group.recordCount>0?'conic-gradient('+segments.join(',')+')':'#edf1f6')+'"><div><strong>'+numberText(group.recordCount)+'</strong><span>日志条数</span></div></div><div class="op-donut-legend">'+items.map((item,index)=>'<div><span><i style="background:'+color(item,index)+'"></i>'+escape(item.op)+'</span><strong>'+percent(item.share)+'</strong><small>'+numberText(item.count)+' 条</small></div>').join('')+'</div></div></article>';}).join('')+'</div>';
  }
  function fillOptions(id,options,current,{multiple=false,allLabel='全部'}={}){
    const select=$(id),values=multiple?list(current):[current||'all'],items=list(options).filter(item=>item&&item.value!==undefined),seen=new Set();
    let normalized=items.filter(item=>{const value=String(item.value);if(seen.has(value)||multiple&&value==='all')return false;seen.add(value);return true;});
    if(!multiple&&!seen.has('all'))normalized=[{value:'all',label:allLabel},...normalized];
    values.filter(value=>value&&value!=='all'&&!seen.has(String(value))).forEach(value=>normalized.push({value,label:value}));
    select.innerHTML=normalized.map(item=>'<option value="'+escape(item.value)+'"'+(values.includes(String(item.value))?' selected':'')+'>'+escape(item.label||item.value)+(item.value!=='all'&&Number.isFinite(item.count)?' ('+item.count+')':'')+'</option>').join('');
    if(!multiple){select.value=current||'all';select.title=select.selectedOptions[0]?.textContent||'';}
  }
  function updateFilterOptions(data,query){
    if(query.module==='weld'){
      const options=data.report?.options||{};fillOptions('#materialFilter',options.materialNames,query.materialName,{allLabel:'全部物料'});fillOptions('#weldLineFilter',options.lines,query.line,{allLabel:'全部线体'});state.defectOptions=list(options.defects);renderDefectPicker();
    }else if(query.module==='alarm'){
      const options=data.alarmReport?.options||{};fillOptions('#alarmStatusFilter',options.statuses||options.status,query.status,{allLabel:'全部状态'});fillOptions('#alarmLineFilter',options.lines,query.line,{allLabel:'全部产线 / 区域'});fillOptions('#alarmDepartmentFilter',options.departments,query.department,{allLabel:'全部部门'});
    }else if(query.module==='spares'){
      const options=data.sparesReport?.options||{};if(options.categories)fillOptions('#categoryFilter',options.categories,query.category,{allLabel:'全部备件'});if(options.stocks)fillOptions('#stockFilter',options.stocks,query.stock,{allLabel:'全部库存状态'});
    }
  }
  function positionDefectPicker(){
    const picker=$('#defectPicker');if(!picker.open)return;const panel=picker.querySelector('.defect-picker-panel'),anchor=picker.querySelector('summary').getBoundingClientRect(),viewportWidth=document.documentElement.clientWidth,viewportHeight=document.documentElement.clientHeight,width=Math.min(540,viewportWidth-24),gap=7;
    const below=Math.floor(viewportHeight-12-anchor.bottom-gap),above=Math.floor(anchor.top-gap-12),openBelow=below>=260||below>=above,maxHeight=Math.max(120,Math.min(312,openBelow?below:above,viewportHeight-24));
    panel.style.width=width+'px';panel.style.maxHeight=maxHeight+'px';$('#defectOptions').style.maxHeight=Math.min(168,Math.max(36,maxHeight-136))+'px';
    const height=Math.min(Math.ceil(panel.getBoundingClientRect().height),maxHeight),left=Math.max(12,Math.min(anchor.left,viewportWidth-width-12));let top=openBelow?anchor.bottom+gap:anchor.top-height-gap;top=Math.max(12,Math.min(top,viewportHeight-height-12));panel.style.left=left+'px';panel.style.top=top+'px';
  }
  function updateDefectDraftHint(){$('#defectDraftHint').textContent=state.defectDraft.length?'已勾选'+state.defectDraft.length+'种，应用后生效':'全部缺陷';}
  function renderDefectPicker(){
    const options=[...state.defectOptions],seen=new Set(options.map(item=>String(item.value)));state.defectDraft.forEach(value=>{if(!seen.has(value))options.push({value,label:value});});
    $('#defectSelectionLabel').textContent=state.defects.length?'已选 '+state.defects.length+' 种缺陷':'全部缺陷';
    $('#defectOptions').innerHTML=options.length?options.map(item=>'<label class="defect-option '+(state.defectDraft.includes(String(item.value))?'selected':'')+'"><input type="checkbox" value="'+escape(item.value)+'"'+(state.defectDraft.includes(String(item.value))?' checked':'')+'><span>'+escape(item.label||item.value)+'</span><small>'+numberText(item.count)+'</small></label>').join(''):'<p>读取数据后显示可选缺陷。</p>';
    $('#defectChips').innerHTML=state.defects.map(value=>'<button type="button" class="defect-chip" data-remove-defect="'+escape(value)+'" aria-label="移除 '+escape(value)+' 筛选">'+escape(value)+'<span aria-hidden="true">×</span></button>').join('');
    updateDefectDraftHint();
    if($('#defectPicker').open)positionDefectPicker();
  }
  function weldOpLabel(value){return value==='其他'?'未识别工位':value;}
  function renderWeldDrill(){
    const host=$('#weldDrillFilters'),active=state.module==='weld'&&(state.weldDefectType!=='all'||state.weldOp!=='all'||state.weldLocation!=='all');host.hidden=!active;
    host.innerHTML=active?'<span>明细定位</span>'+(state.weldDefectType!=='all'?'<button type="button" class="weld-drill-chip" data-clear-drill="defectType">分类：'+escape(state.weldDefectType)+' <span aria-hidden="true">×</span></button>':'')+(state.weldOp!=='all'?'<button type="button" class="weld-drill-chip" data-clear-drill="op">工位：'+escape(weldOpLabel(state.weldOp))+' <span aria-hidden="true">×</span></button>':'')+(state.weldLocation!=='all'?'<button type="button" class="weld-drill-chip" data-clear-drill="location">位置：'+escape(state.weldLocation)+' <span aria-hidden="true">×</span></button>':'')+'<button type="button" class="weld-drill-clear" data-clear-drill="all">清除定位</button>':'';
  }
  function resetWeldDrill(){state.weldDefectType='all';state.weldOp='all';state.weldLocation='all';renderWeldDrill();}
  function defectRanking(report){
    const parents=list(report.defectTypeSummary);if(parents.length&&!parents.some(parent=>parent.defectType===weldRanking.parent))weldRanking.parent=parents[0].defectType;
    const parent=parents.find(item=>item.defectType===weldRanking.parent),source=parent?list(parent.defects):list(report.defectSummary),denominator=parent?parent.recordCount:report.overview?.recordCount;
    const rows=source.filter(item=>weldRanking.mode==='catalog'||(!item.catalogOnly&&Number(item.recordCount)>0));weldRanking.items=rows.map(item=>({...item,filters:{...item.filters,...(parent?{defectType:parent.defectType}:{})},_displayShare:typeof item.recordCount==='number'&&typeof denominator==='number'&&denominator>0?item.recordCount/denominator:null}));
    const parentControl=parents.length>1?'<label class="defect-parent-picker"><span>不良分类</span><select id="defectParentPicker">'+parents.map(item=>'<option value="'+escape(item.defectType)+'"'+(item.defectType===weldRanking.parent?' selected':'')+'>'+escape(item.defectType)+' · '+numberText(item.recordCount)+' 条</option>').join('')+'</select></label>':'<div class="defect-parent-label"><span>不良分类</span><strong>'+escape(parent?.defectType||'暂未取得原始分类')+'</strong></div>';
    const toolbar='<div class="defect-rank-toolbar">'+parentControl+'<div class="defect-catalog-switch" role="group" aria-label="分类显示范围"><button type="button" data-defect-catalog="observed" aria-pressed="'+(weldRanking.mode==='observed')+'" class="'+(weldRanking.mode==='observed'?'active':'')+'">有记录</button><button type="button" data-defect-catalog="catalog" aria-pressed="'+(weldRanking.mode==='catalog')+'" class="'+(weldRanking.mode==='catalog'?'active':'')+'">完整分类</button></div></div>';
    const catalogStatus=report.catalogStatus,warning=weldRanking.mode==='catalog'&&catalogStatus&&catalogStatus.complete!==true?'<p class="defect-catalog-warning">'+escape(catalogStatus.note||'来源分类尚未完整取得，当前显示已取得的项。')+'</p>':'';
    const observedCount=source.filter(item=>!item.catalogOnly&&Number(item.recordCount)>0).length,parentHint=parent?'<p class="defect-parent-hint">'+(parents.length>1?'共 '+parents.length+' 个原始分类，可切换；':'')+'当前显示 <strong>'+escape(parent.defectType)+'</strong> · '+observedCount+' 种有记录 / 已取得 '+source.length+' 种来源细类</p>':'';
    return toolbar+parentHint+warning+'<div class="defect-rank-header"><span>原始不良内容</span><span>日志条数</span><span>占该类</span><span></span></div><div class="defect-rank-list">'+(rows.length?weldRanking.items.map((item,index)=>'<button type="button" class="defect-rank-row '+(item.catalogOnly?'catalog-only':'')+'" data-defect-detail="'+index+'" aria-label="查看'+escape(item.defect)+'的线体、工位和位置明细"><span class="defect-rank-name"><i style="background:'+COLORS[index%COLORS.length]+'"></i>'+escape(item.defect)+'</span><strong>'+ (item.recordCount===null?'<small>未见记录</small>':numberText(item.recordCount))+'</strong><span class="defect-rank-share">'+percent(item._displayShare)+'</span><span class="defect-rank-arrow" aria-hidden="true">›</span></button>').join(''):emptyChart('当前分类在本次读取中没有可展示记录'))+'</div><p class="defect-rank-note">'+(weldRanking.mode==='catalog'?'显示已取得的完整来源分类；未见记录且覆盖未核实时不记为 0。':'仅显示当前筛选下有记录的不良内容；占比以该分类已读日志为分母。')+' 点击内容查看线体 → OP → 位置。</p>';
  }
  function closeWeldDefectDetail(){const dialog=$('#weldDefectDialog');if(dialog?.open)dialog.close();weldDetail.snapshot=null;weldDetail.actions=[];if($('#weldDefectBody'))$('#weldDefectBody').innerHTML='';}
  function weldDetailAction(filters,label='查看记录'){
    const index=weldDetail.actions.push(filters)-1;return '<button type="button" class="weld-detail-records" data-weld-records="'+index+'">'+escape(label)+' <span aria-hidden="true">↗</span></button>';
  }
  function renderWeldDefectDetail(){
    const snapshot=weldDetail.snapshot;if(!snapshot)return;const item=snapshot.item,lines=list(item.lines),visible=lines.filter(line=>weldDetail.line==='all'||line.line===weldDetail.line);weldDetail.actions=[];
    const options='<option value="all">全部线体</option>'+lines.map(line=>'<option value="'+escape(line.line)+'"'+(weldDetail.line===line.line?' selected':'')+'>'+escape(line.line)+' · '+numberText(line.recordCount)+' 条</option>').join('');
    const classification=item.classification||{},parentTypes=list(classification.parentTypes),content=classification.content||item.defect,parentsMarkup=parentTypes.length?parentTypes.map(parent=>'<span>'+escape(parent.label||parent.value)+'</span>').join(''):'<span>原始分类暂未取得</span>';
    const classificationMarkup='<div class="weld-source-classification"><div><span>不良分类</span><div class="weld-source-parents">'+parentsMarkup+'</div></div><div><span>原始不良内容</span><strong>'+escape(content)+'</strong>'+(/[\/／]/.test(content)?'<small class="weld-combined-label">原系统合并项 · 保留原名称统计</small>':'')+'</div></div><p class="weld-source-note">'+escape('按原系统实际分类展示；未单独记录的子类型不再拆分。')+'</p>'+(item.catalogOnly?'<p class="weld-catalog-notice">'+(item.recordCount===null?'本次读取未见此项记录，日志覆盖尚未完整核实，不能据此认定为 0。':'本次已核对的读取范围内，此项为 0 条记录。')+'</p>':'');
    const tree=visible.length?visible.map((line,lineIndex)=>'<details class="weld-detail-line" style="--detail-color:'+lineColor(line.line)+'"><summary><span class="weld-tree-chevron" aria-hidden="true">›</span><span class="weld-tree-label"><strong>'+escape(line.line)+'</strong><span class="weld-tree-bar"><i style="width:'+Math.max(0,Math.min(100,Number(line.share)*100||0))+'%"></i></span></span><span class="weld-tree-count"><strong>'+numberText(line.recordCount)+' <small>条</small></strong><small>占该缺陷 '+percent(line.share)+'</small></span></summary><div class="weld-line-content"><div class="weld-level-intro"><span>按 OP 工位拆分 · 涉及 '+numberText(line.pieceCount)+' 件</span>'+weldDetailAction(line.filters||{defects:[item.defect],line:line.line})+'</div>'+list(line.ops).map(op=>'<details class="weld-detail-op"><summary><span class="weld-tree-chevron" aria-hidden="true">›</span><strong>'+escape(op.label||weldOpLabel(op.op))+'</strong><span>'+numberText(op.recordCount)+' 条 <small>· 占本线 '+percent(op.share)+'</small></span></summary><div class="weld-op-content"><div class="weld-level-intro"><span>缺陷位置 · 涉及 '+numberText(op.pieceCount)+' 件</span>'+weldDetailAction(op.filters||{defects:[item.defect],line:line.line,op:op.op})+'</div><div class="weld-location-list">'+list(op.locations).map(location=>'<div class="weld-location-row"><span>'+escape(location.location)+'</span><strong>'+numberText(location.recordCount)+' <small>条</small></strong><small>占工位 '+percent(location.share)+'</small>'+weldDetailAction(location.filters||{defects:[item.defect],line:line.line,op:op.op,location:location.location})+'</div>').join('')+'</div></div></details>').join('')+'</div></details>').join(''):emptyChart('当前没有可展示的线体层级记录');
    $('#weldDefectTitle').textContent=item.defect||'缺陷明细';
    $('#weldDefectBody').innerHTML='<div class="weld-detail-overview"><div><span>缺陷日志</span><strong>'+numberText(item.recordCount)+' <small>条</small></strong></div><div><span>涉及件数</span><strong>'+numberText(item.pieceCount)+' <small>件</small></strong></div><div><span>占该类已读日志</span><strong>'+percent(snapshot.share??item.share)+'</strong></div></div>'+classificationMarkup+'<div class="weld-detail-toolbar"><label for="defectDetailLine">查看线体</label><select id="defectDetailLine">'+options+'</select>'+weldDetailAction(item.filters||{defects:[item.defect]},'查看此缺陷记录')+'</div><p class="weld-detail-guide">先看各线贡献，再展开 OP 与位置；各层占比均以其上一级日志数为分母。</p><div class="weld-detail-tree">'+tree+'</div><p class="weld-detail-footnote">'+escape(scopeText(snapshot.query))+'。涉及件数按料号＋二维码去重。读取于 '+escape(dateTime(snapshot.successAt))+'；弹窗保留打开时快照，页面自动刷新不会打断当前查看。</p>';
  }
  function openWeldDefectDetail(index){
    if(!state.authenticated||state.module!=='weld')return;const item=weldRanking.items[index];if(!item)return;
    weldDetail.snapshot={item,share:item._displayShare,query:{...state.result.query,defects:[...state.result.query.defects]},successAt:state.result.successAt};weldDetail.line='all';renderWeldDefectDetail();if(!$('#weldDefectDialog').open)$('#weldDefectDialog').showModal();
  }
  async function locateWeldRecords(index){
    const snapshot=weldDetail.snapshot,filters=weldDetail.actions[index];if(!snapshot||!filters||!state.authenticated)return;
    const query=snapshot.query;cancelRequest();clearTimer();state.page=1;state.defects=[...(filters.defects||[snapshot.item.defect])];state.defectDraft=[...state.defects];state.weldDefectType=filters.defectType||query.defectType||'all';state.weldOp=filters.op||query.op||'all';state.weldLocation=filters.location||query.location||'all';
    for(const [id,value] of [['#materialFilter',query.materialName||'all'],['#weldLineFilter',filters.line||query.line||'all']]){const select=$(id);if(![...select.options].some(option=>option.value===value))select.add(new Option(value,value));select.value=value;select.title=select.selectedOptions[0]?.textContent||'';}
    const rolling=query.rolling&&query.start===today()&&query.end===today();$('#rangeMode').value=rolling?'today':'custom';state.view=rolling?'live':'weekly';$('#startDate').value=query.start;$('#endDate').value=query.end;$('#keywordInput').value=query.keyword||'';closeWeldDefectDetail();renderDefectPicker();renderWeldDrill();await loadData('drill');$(state.error?'#readStatus':'#recordsTitle').scrollIntoView({behavior:'auto',block:'start'});
  }
  function renderWeldReport(){
    if(state.module!=='weld')return;
    const host=$('#weldReport'),report=state.result?.data.report,overview=report?.overview,live=(state.result?.query.view||state.view)==='live';
    $('#weldReportTitle').textContent=live?'当天缺陷概览':'所选日期缺陷统计';$('#recordsTitle').textContent=live?'最新焊接不合格记录':'焊接不合格记录明细';
    $('#weldReportSubtitle').textContent='默认全部线体、全部缺陷；筛选同步作用于统计和明细，不从当前分页推算全量。';
    if(!overview){host.className='empty-state';host.textContent=state.result?'本次接口尚未提供全范围统计，以下只展示已读取明细。':'数据源就绪后自动加载真实缺陷日志。';return;}
    host.className='dashboard-content';
    const notes=list(report.notes),diagnostic=report.diagnostics||{},lineRows=list(report.lineSummary),defects=list(report.defectSummary),top=list(report.topLocations),trend=live?report.dailyTrend:report.trend;
    const lineLabels=lineRows.map(row=>row.line),maxLocation=Math.max(1,...top.map(row=>Number(row.recordCount)||0));
    const topChart=top.length?'<div class="location-bars">'+top.map(row=>'<div class="location-row"><div class="location-label"><span>'+escape(row.location)+'</span><strong>'+numberText(row.recordCount)+' 条</strong></div><div class="location-track">'+list(row.byLine).map(item=>'<span style="width:'+(Number(item.count)||0)/maxLocation*100+'%;background:'+lineColor(item.line)+'" title="'+escape(item.line)+'：'+numberText(item.count)+' 条"></span>').join('')+'</div></div>').join('')+'</div><div class="chart-legend">'+lineLabels.map(line=>'<span style="--legend-color:'+lineColor(line)+'">'+escape(line)+'</span>').join('')+'</div>':emptyChart();
    const detail=top.length?'<div class="table-wrap" tabindex="0"><table><thead><tr><th>缺陷位置</th><th>日志条数</th><th>涉及件数</th><th>占比</th><th>线体分布</th><th>缺陷分布</th></tr></thead><tbody>'+top.map(row=>'<tr><td>'+escape(row.location)+'</td><td>'+numberText(row.recordCount)+'</td><td>'+numberText(row.pieceCount)+'</td><td>'+percent(row.share)+'</td><td>'+escape(list(row.byLine).map(item=>item.line+' '+item.count).join(' / '))+'</td><td>'+escape(list(row.byDefect).map(item=>item.defect+' '+item.count).join(' / '))+'</td></tr>').join('')+'</tbody></table></div>':emptyChart('当前没有位置明细');
    const lineTable=lineRows.length?'<div class="table-wrap" tabindex="0"><table><thead><tr><th>线体</th><th>日志条数</th><th>涉及件数</th><th>条 / 件</th><th>缺陷分布</th></tr></thead><tbody>'+lineRows.map(row=>'<tr><td>'+escape(row.line)+'</td><td>'+numberText(row.recordCount)+'</td><td>'+numberText(row.pieceCount)+'</td><td>'+decimal(row.recordsPerPiece)+'</td><td>'+escape(list(row.byDefect).map(item=>item.defect+' '+item.count).join(' / '))+'</td></tr>').join('')+'</tbody></table></div>':emptyChart();
    const materials=list(report.materialSummary),materialCards=materials.length?'<div class="material-overview">'+materials.map((item,index)=>'<article class="material-card" style="--material-color:'+COLORS[index%COLORS.length]+'"><div class="material-title"><strong>'+escape(item.materialName||'未填写物料名称')+'</strong><span>'+escape(item.material||'料号待核实')+'</span></div><div class="material-stats"><span><strong>'+numberText(item.recordCount)+'</strong>日志条数</span><span><strong>'+numberText(item.pieceCount)+'</strong>涉及件数</span><span><strong>'+decimal(item.recordsPerPiece)+'</strong>条 / 件</span></div></article>').join('')+'</div>':emptyChart('当前筛选未取得物料汇总');
    const warnings=[];if(overview.unknownLineCount)warnings.push(numberText(overview.unknownLineCount)+' 条记录的线体待识别');if(overview.missingQrCount)warnings.push(numberText(overview.missingQrCount)+' 条记录缺少二维码');if(overview.duplicateRowsRetained)warnings.push(numberText(overview.duplicateRowsRetained)+' 条重复记录按源口径保留');
    host.innerHTML='<div class="dashboard-kpis weld-kpis">'+dashboardMetric('缺陷日志条数',numberText(overview.recordCount),'当前筛选内的源记录')+dashboardMetric('涉及件数',numberText(overview.pieceCount),'按料号＋二维码去重')+dashboardMetric('条 / 件',decimal(overview.recordsPerPiece),'日志条数 ÷ 涉及件数')+dashboardMetric('已识别线体',numberText(overview.lineCount),'待确认线体单独显示')+dashboardMetric('缺陷类型',numberText(overview.defectTypeCount),'当前筛选的类型数')+dashboardMetric('涉及料号',numberText(overview.materialCount),'当前筛选的不同料号')+'</div>'+(warnings.length?'<div class="notice warning">'+warnings.map(escape).join('；')+'。</div>':'')+'<div class="dashboard-grid">'+chartPanel('按物料查看 · 产品与料号',materialCards,'待识别线体的记录仍按真实物料单独展示，不推测生产线归属。',true)+chartPanel('线体日志分布',horizontalBars(lineRows,{label:'line',value:'recordCount',color:item=>lineColor(item.line),maxItems:lineRows.length}),'按日志条数排名，不代表产量不良率。')+chartPanel('缺陷类型分布',defectRanking(report))+chartPanel('各线 OP 工位占比 · Top 5 + 其他',opDonuts(report.lineOpSummary),'每条线以自身筛选后的日志为分母，未识别工位并入“其他”。',true)+chartPanel(live?'所选日期趋势':'近五周趋势',live?trendChart(trend,{daily:true}):combinedTrend(trend),'未覆盖的日期保留缺失，不补零、不计算不完整期间的环比。',true)+chartPanel('缺陷位置 Top 5 · 线体构成',topChart,'位置未填写的记录仍包含在总条数中。',true)+chartPanel('各线体汇总',lineTable,'各线按同料号＋二维码去重，跨线件数不宜直接相加。',true)+chartPanel('Top 5 位置明细',detail,'',true)+'</div>'+(notes.length?'<div class="report-footnotes">'+notes.map(note=>'<p>'+escape(note)+'</p>').join('')+'</div>':'')+'<p class="report-note">本页展示缺陷日志及涉及件数，不能据此认定完工补焊数量。</p>';
  }
  function alarmElapsed(value){
    if(!value)return '时间待核实';const timestamp=Date.parse(value),elapsed=Date.now()-timestamp;
    if(!Number.isFinite(timestamp)||elapsed<0)return '时间待核实';
    const minutes=Math.floor(elapsed/60000);if(minutes<1)return '不足 1 分钟';
    const days=Math.floor(minutes/1440),hours=Math.floor(minutes%1440/60),rest=minutes%60;
    return (days?days+' 天 ':'')+(hours?hours+' 小时 ':'')+(!days&&(!hours||rest)?rest+' 分钟':'');
  }
  function alarmDepartmentBadge(department,report){
    const options=list(report.options?.departments).filter(item=>item.value!=='all'&&item.value!=='部门待确认');
    const position=options.findIndex(item=>item.value===department),tone=department==='部门待确认'||position<0?'unknown':String(position%5);
    return '<span class="alarm-dept-badge dept-'+tone+'">'+escape(department||'部门待确认')+'</span>';
  }
  function alarmWorkBoard(report){
    const board=report.workBoard;if(!board||!Array.isArray(board.columns))return '<div id="alarmWorkBoard" class="empty-state">尚未取得全量处理队列，请刷新后重试。下方明细不用于推算队列总量。</div>';
    const stages=[{status:'unresponded',label:'待响应',note:'等待责任部门响应',duration:'已等待'},{status:'processing',label:'处理中',note:'已响应，正在处理',duration:'处理中已持续'},{status:'awaiting_restore',label:'待复线',note:'处理结束，等待复线',duration:'已等待复线'}];
    return '<div id="alarmWorkBoard" class="alarm-work-board">'+stages.map(stage=>{
      const columnIndex=board.columns.findIndex(item=>item.status===stage.status),column=board.columns[columnIndex],cards=list(column?.cards);
      return '<section class="alarm-lane '+stage.status+'" aria-label="'+stage.label+'报警"><div class="alarm-lane-heading"><div><span class="alarm-lane-dot" aria-hidden="true"></span><h3>'+stage.label+'</h3><span class="alarm-lane-count">'+numberText(column?.count)+' <small>条</small></span></div><button type="button" class="alarm-lane-filter" data-alarm-status="'+stage.status+'" aria-label="筛选'+stage.label+'报警">筛选 ↗</button></div><p class="alarm-lane-subtitle">'+stage.note+'</p><div class="alarm-card-list" data-lane-scroll="'+stage.status+'" tabindex="0" aria-label="'+stage.label+'报警队列，可滚动">'+(cards.length?cards.map((card,index)=>'<button type="button" class="alarm-work-card" data-alarm-card="'+columnIndex+':'+index+'" aria-label="查看'+escape(card.equipment||'设备名称待核实')+'报警详情"><span class="alarm-card-top"><strong>'+escape(card.equipment||'设备名称待核实')+'</strong><span class="alarm-card-arrow" aria-hidden="true">↗</span></span><span class="alarm-card-tags"><span class="alarm-line-badge">'+escape(card.line||'线体待核实')+'</span>'+alarmDepartmentBadge(card.department,report)+'</span>'+(card.description?'<span class="alarm-card-description">'+escape(card.description)+'</span>':'')+'<span class="alarm-card-bottom"><span>'+stage.duration+'</span><strong>'+escape(alarmElapsed(card.stageStartedAt))+'</strong></span></button>').join(''):'<div class="alarm-lane-empty"><span aria-hidden="true">—</span><p>本次读取中没有此阶段记录</p></div>')+'</div></section>';
    }).join('')+'</div><p class="alarm-board-note">一张卡对应一条报警，同设备多条报警分别保留；持续时间按当前阶段起点计算。'+(board.complete===true?'':' 本次数据覆盖尚未完整核实。')+'</p>';
  }
  function closeAlarmDetail(){const dialog=$('#alarmDetailDialog');if(dialog?.open)dialog.close();if($('#alarmDetailBody'))$('#alarmDetailBody').innerHTML='';}
  function openAlarmDetail(key){
    const indices=/^(\d+):(\d+)$/.exec(key);if(!indices||!state.authenticated)return;
    const report=state.result?.data.alarmReport,card=report?.workBoard?.columns?.[Number(indices[1])]?.cards?.[Number(indices[2])];if(!card)return;
    $('#alarmDetailTitle').textContent=card.equipment||'报警详情';
    const fields=[['报警编号',card.idSource==='display'?'展示编号 '+valueText(card.id)+'（源编号缺失）':valueText(card.id)],['设备编号',valueText(card.equipmentCode)],['线体 / 区域',valueText(card.line)],['归口部门',valueText(card.department)],['当前状态',valueText(card.statusLabel)],['报警时间',dateTime(card.createdAt)],['响应时间',dateTime(card.responseAt)],['处理结束',dateTime(card.dealtAt)],['当前阶段持续',alarmElapsed(card.stageStartedAt)]];
    $('#alarmDetailBody').innerHTML='<div class="alarm-detail-badges"><span class="alarm-status '+(['unresponded','processing','awaiting_restore'].includes(card.status)?card.status:'unknown')+'">'+escape(card.statusLabel||'状态待核实')+'</span>'+alarmDepartmentBadge(card.department,report)+'</div><dl class="alarm-detail-grid">'+fields.map(([label,value])=>'<div><dt>'+escape(label)+'</dt><dd>'+escape(value)+'</dd></div>').join('')+'</dl><div class="alarm-detail-description"><h3>报警描述</h3><p>'+escape(card.description||'原记录未填写描述')+'</p></div><p class="alarm-detail-note">数据读取于 '+escape(dateTime(state.result.successAt))+'。这是打开详情时的只读快照；返回队列后可继续刷新。</p>';
    if(!$('#alarmDetailDialog').open)$('#alarmDetailDialog').showModal();
  }
  function renderAlarmReport(){
    if(state.module!=='alarm')return;
    const host=$('#alarmReport'),report=state.result?.data.alarmReport,kpis=report?.overview||report?.kpis;
    if(!kpis){host.className='empty-state';host.textContent=state.result?'报警分析汇总尚未返回，以下明细保持原样。':'数据源就绪后自动加载真实报警记录。';return;}
    const laneScroll=new Map([...host.querySelectorAll('[data-lane-scroll]')].map(element=>[element.dataset.laneScroll,element.scrollTop])),expanded=new Set([...host.querySelectorAll('details[open][id]')].map(element=>element.id));
    host.className='dashboard-content';
    const colors={unresponded:'#ce454b',processing:'#6264d8',awaiting_restore:'#bb8015',completed:'#438268',unknown:'#8793a6'},steps=[{value:'unresponded',key:'unresponded',label:'待响应',note:'等待责任部门响应'},{value:'processing',key:'processing',label:'处理中',note:'已响应，处理中'},{value:'awaiting_restore',key:'awaitingRestore',label:'待复线',note:'已处理，等待复线'},{value:'completed',key:'completed',label:'已完成',note:'原系统已闭环'}];
    const selected=state.result.query;
    const progress='<div class="alarm-compact-summary"><div><span>当前范围</span><strong>'+numberText(kpis.recordCount)+'</strong><span>条报警</span></div><div><span>未闭环</span><strong>'+numberText(kpis.openCount)+'</strong><span>条</span></div><div class="alarm-summary-actions"><button type="button" class="'+(selected.status==='all'?'selected':'')+'" data-alarm-status="all">全部状态</button><button type="button" class="completed '+(selected.status==='completed'?'selected':'')+'" data-alarm-status="completed">已完成 <strong>'+numberText(kpis.completedCount)+'</strong></button><button type="button" class="'+(selected.status==='unknown'?'selected':'')+'" data-alarm-status="unknown">状态待核实 <strong>'+numberText(kpis.unknownCount)+'</strong></button></div></div>'+alarmWorkBoard(report);
    const lines=list(report.lineStatusMatrix||report.lineSummary);
    const matrix=lines.length?'<p class="matrix-summary">共 '+numberText(lines.length)+' 条线体 / 区域'+(lines.length>8?' · 滚动查看其余线体':'')+' · 点击数字筛选</p><div class="table-wrap line-matrix-wrap" tabindex="0" aria-label="线体处理进度，可上下及横向滚动"><table class="line-matrix"><thead><tr><th>线体 / 区域</th>'+steps.map(step=>'<th><i style="background:'+colors[step.value]+'"></i>'+step.label+'</th>').join('')+'<th>状态待核实</th><th>总报警</th></tr></thead><tbody>'+lines.map(line=>'<tr><th scope="row"><button type="button" class="matrix-line-name" data-alarm-line="'+escape(line.name)+'" data-alarm-status="all">'+escape(line.name)+'</button></th>'+steps.map(step=>'<td><button type="button" class="matrix-count '+step.value+(line[step.key]===0?' is-zero':'')+'" data-alarm-line="'+escape(line.name)+'" data-alarm-status="'+step.value+'" aria-label="'+escape(line.name)+'，'+step.label+'，'+numberText(line[step.key])+' 条">'+numberText(line[step.key])+'</button></td>').join('')+'<td><button type="button" class="matrix-count unknown'+(line.unknown===0?' is-zero':'')+'" data-alarm-line="'+escape(line.name)+'" data-alarm-status="unknown">'+numberText(line.unknown)+'</button></td><td><strong>'+numberText(line.total)+'</strong></td></tr>').join('')+'</tbody></table></div>':emptyChart('当前范围暂无线体进度数据');
    const departments=list(report.departmentSummary);
    const departmentCards=departments.length?'<div class="department-grid">'+departments.map(dept=>'<article class="department-card '+(dept.name==='部门待确认'?'unmapped':'')+'"><div class="department-heading"><button type="button" data-alarm-department="'+escape(dept.name)+'">'+escape(dept.name)+'</button><strong>'+numberText(dept.total)+' <small>条</small></strong></div>'+(dept.name==='部门待确认'?'<p>部门归属待确认，暂不归入已配置部门。</p>':'<p>按已配置的报警类别规则归口</p>')+'<div class="department-progress">'+steps.map(step=>'<button type="button" data-alarm-department="'+escape(dept.name)+'" data-alarm-status="'+step.value+'"><span>'+step.label+'</span><strong style="color:'+colors[step.value]+'">'+numberText(dept[step.key])+'</strong></button>').join('')+'</div></article>').join('')+'</div>':emptyChart('暂无部门归属数据');
    const duration=report.durations||{},durationMetric=(key,label)=>{const item=duration[key]||{};return dashboardMetric(label,decimal(item.averageMinutes,1)+' 分钟','有效样本 '+numberText(item.sampleCount)+' 条');};
    const overview='<div id="alarmOverview" class="dashboard-kpis alarm-kpis">'+dashboardMetric('总报警',numberText(kpis.recordCount),'所选创建日期范围内的记录')+dashboardMetric('未闭环',numberText(kpis.openCount),'原系统明确标记尚未闭环')+dashboardMetric('状态待核实',numberText(kpis.unknownCount),'缺失或冲突的状态信息')+durationMetric('response','平均响应时长')+durationMetric('handling','平均处理时长')+durationMetric('closure','平均复线时长')+'</div>';
    const statuses=list(report.statusCounts),total=statuses.reduce((sum,item)=>sum+(Number(item.count)||0),0);let cursor=0;const slices=statuses.map(item=>{const start=cursor;cursor+=(Number(item.count)||0)/Math.max(1,total)*100;return (colors[item.value]||'#a4b3c8')+' '+start+'% '+cursor+'%';});
    const ring='<div class="status-distribution"><div class="status-ring" style="--ring-fill:'+(total>0?'conic-gradient('+slices.join(',')+')':'#edf1f6')+'"><div><strong>'+numberText(kpis.recordCount)+'</strong><span>总报警</span></div></div><div class="status-legend">'+statuses.map(item=>'<div><span class="status-legend-name"><i style="background:'+(colors[item.value]||'#a4b3c8')+'"></i>'+escape(item.label||item.name)+'</span><strong>'+numberText(item.count)+'</strong><small>'+percent(total?item.count/total:0)+'</small></div>').join('')+'</div></div>';
    host.innerHTML='<nav class="analysis-nav" aria-label="报警分析导航"><button type="button" data-scroll="alarmWorkBoard">处理队列</button><button type="button" data-scroll="alarmLineMatrix">线体进度</button><button type="button" data-scroll="alarmDepartment">部门进度</button><button type="button" data-scroll="alarmOverview">总览与趋势</button><button type="button" data-scroll="recordsTitle">报警明细</button></nav>'+progress+
      '<details id="alarmLineMatrix" class="alarm-auxiliary work-section"><summary><span>线体处理进度</span><small>'+numberText(lines.length)+' 条线体 / 区域 · 展开矩阵</small></summary>'+chartPanel('线体处理进度',matrix,'按原系统线体或已配置规则细分；未匹配时保留原区域。')+'</details>'+
      '<details id="alarmDepartment" class="alarm-auxiliary work-section"><summary><span>部门处理进度</span><small>查看部门分布与归口依据</small></summary><div class="department-panel-content">'+departmentCards+'<p class="report-note">按已配置的报警类别规则归口；未匹配的记录保留“部门待确认”。点击部门或进度可筛选。</p></div></details>'+
      '<div class="section-heading"><div><h2>总览与趋势</h2><p class="muted">时长只使用有效且时序合理的记录；缺失趋势保留空缺。</p></div></div>'+overview+chartPanel('每日报警趋势',trendChart(report.dailyTrend,{daily:true,value:'total',title:'报警条数'}),'按所选创建日期范围统计，不代表全系统历史待处理数量。',true)+
      '<details id="alarmMoreAnalysis" class="secondary-analysis"><summary>更多分析：状态分布、设备与区域排行</summary><div class="dashboard-grid">'+chartPanel('报警状态分布',ring,'未闭环数可能包含部分状态待核实的记录。')+chartPanel('设备报警 Top 10',horizontalBars(report.equipmentTop,{label:'name',color:'#4679b5'}))+chartPanel('产线 / 区域 Top 10',horizontalBars(report.lineTop,{label:'name',color:'#679aaa'}),'',true)+'</div></details><details id="alarmStatisticsNotes" class="alarm-stat-notes"><summary>统计说明</summary><div><p>数据源时间：'+escape(dateTime(state.result.data.sourceTime))+'；读取时间：'+escape(dateTime(state.result.successAt))+'。</p>'+[...list(report.notes),state.result.data.note].filter(Boolean).map(note=>'<p>'+escape(note)+'</p>').join('')+'</div></details>';
    for(const [lane,scrollTop] of laneScroll){const element=host.querySelector('[data-lane-scroll="'+lane+'"]');if(element)element.scrollTop=scrollTop;}
    for(const id of expanded){const detail=document.getElementById(id);if(detail)detail.open=true;}
  }
  function renderSparesReport(){
    if(state.module!=='spares')return;const host=$('#sparesReport'),report=state.result?.data.sparesReport,overview=report?.overview;
    if(!overview){host.className='empty-state';host.textContent='尚未取得全量库存汇总，不能用当前分页推算缺货总数。';return;}
    host.className='dashboard-content';host.innerHTML='<div class="dashboard-kpis spare-kpis">'+dashboardMetric('备件种类',numberText(overview.total),'当前筛选范围的备件记录')+dashboardMetric('缺货',numberText(overview.outCount),'库存不大于零','tone-warn')+dashboardMetric('低库存',numberText(overview.lowCount),'低于已设置的最小库存','tone-orange')+dashboardMetric('库存充足',numberText(overview.normalCount),'达到已设置的最小库存','tone-green')+dashboardMetric('待核实',numberText(overview.unknownCount),'数量或阈值信息不足','tone-muted')+'</div>'+list(report.notes).map(note=>'<p class="report-note">'+escape(note)+'</p>').join('');
  }
  function renderSpareCards(data){
    if(!data.rows.length)return '<div class="empty-state">当前筛选没有备件记录。请结合筛选条件和读取完整性判断。</div>';
    const labels={out:'缺货',low:'低库存',normal:'库存充足',unknown:'待核实'};
    return '<div class="spare-card-grid">'+data.rows.map(row=>{const status=Object.hasOwn(labels,row._stockStatus)?row._stockStatus:'unknown',qty=countValue(row._stockQuantity),min=countValue(row._stockMin),max=countValue(row._stockMax),gap=countValue(row._stockGap);return '<article class="spare-card '+status+'"><div class="spare-card-heading"><div><h3>'+escape(row.bjmc||'未填写备件名称')+'</h3><p>'+escape(row.bjbh||'编号待核实')+'</p></div><span class="stock-pill '+status+'">'+labels[status]+'</span></div><div class="spare-stock"><div><span>当前库存</span><strong>'+numberText(qty)+'</strong></div><div class="spare-thresholds"><span>最小 <b>'+numberText(min)+'</b></span><span>最大 <b>'+numberText(max)+'</b></span>'+(gap!==null&&gap>0?'<span class="spare-gap">距最低值差 '+numberText(gap)+'</span>':'')+'</div></div><div class="spare-location"><span>库位</span><strong>'+escape(row.location||'未填写')+'</strong></div><details class="spare-details"><summary>规格与详细信息</summary><dl><div><dt>规格型号</dt><dd>'+escape(row.specifications||'未填写')+'</dd></div><div><dt>备件类型</dt><dd>'+escape(row.sparepartName||'未填写')+'</dd></div><div><dt>备件二维码</dt><dd>'+escape(row.BarCode||'未填写')+'</dd></div><div><dt>创建时间</dt><dd>'+escape(dateTime(row.createOn))+'</dd></div></dl></details></article>';}).join('')+'</div>';
  }
  function renderResult(){
    const result=state.result,data=result&&result.data,status=$('#readStatus');status.className='read-status';
    if(state.error){status.classList.add('error');status.textContent=`读取失败：${state.error}${result?' 当前保留上次成功数据（'+scopeText(result.query)+'）。':' 尚无成功数据可显示。'}`;}
    else if(state.loading){status.classList.add('loading');status.textContent=result?'正在读取当前条件，暂时显示上次成功数据。':'正在读取真实接口，请稍候…';}
    else if(result){status.classList.add('success');status.textContent=`已成功读取本页 ${data.rows.length} 条记录。${data.note?' '+data.note:''}`;}
    else status.textContent=state.connected?'数据源已就绪，正在准备读取当前模块。':sourceState().configured?'数据源准备中，恢复后会自动读取。':'尚未配置数据源，当前没有可显示的真实数据。';
    if(state.module==='alarm'){
      if(!state.error&&result)status.textContent=(state.loading?'正在刷新，保留上次结果 · ':'')+'本次已读 '+numberText(countValue(data.total))+' 条 · 更新 '+dateTime(result.successAt)+' · '+(data.complete===true?'分页条数已核对':'数据覆盖待核实');
      const count=[$('#alarmStatusFilter').value].filter(value=>value&&value!=='all').length;$('#alarmMoreLabel').textContent='更多筛选'+(count?' · '+count+' 项':'');
    }
    $('#recordTotal').textContent=data?numberText(countValue(data.total)):'—';
    $('#totalCaption').textContent=data?`当前条件下实际已读取的记录${countValue(data.sourceTotal)!==null?'；来源报告总量 '+numberText(countValue(data.sourceTotal))+' 条':''}${state.module==='weld'?'。不等于补焊点数或去重件数。':''}`:'等待真实接口返回';
    $('#lastSuccess').textContent=result?dateTime(result.successAt):'—';$('#sourceTime').textContent=data?dateTime(data.sourceTime):'—';
    $('#completeness').textContent=!data?'完整性尚未核实':data.complete===true?'分页条数已核对（截至本次读取）':data.complete===false?'数据可能不完整，请结合读取提示核对':'接口未确认完整性';
    $('#dataTable').className=data?'':'empty-state';$('#dataTable').innerHTML=data?(state.module==='spares'&&state.sparesView==='cards'?renderSpareCards(data):renderTable(data)):(state.connected?'当前模块尚无成功读取结果。':'数据源就绪后自动读取真实记录。');
    $('#resultScope').textContent=result?`当前展示：${scopeText(result.query)} · 图表与明细使用相同筛选。`:'查询后展示接口字段。';
    const page=data?Number(data.page)||result.query.page:state.page,size=data?Number(data.size)||result.query.size:state.size,total=data?countValue(data.total):null,pages=total!==null?Math.max(1,Math.ceil(total/size)):null;
    $('#pageSummary').textContent=data?`本页 ${data.rows.length} 条${Number.isFinite(total)?' / 共 '+total.toLocaleString('zh-CN')+' 条':''}`:'尚未读取';$('#pageNumber').textContent=data?`${page}${pages?' / '+pages:''}`:'—';
    $('#prevPage').disabled=!state.connected||state.loading||!data||page<=1;$('#nextPage').disabled=!state.connected||state.loading||!data||(pages!==null?page>=pages:data.rows.length<size);
    renderWeldDrill();renderWeldReport();renderAlarmReport();renderSparesReport();
  }
  function resetDates(){const day=today();$('#rangeMode').value='today';$('#startDate').value=day;$('#endDate').value=day;syncDateFields();}
  function syncDateFields(){const spares=state.module==='spares',rolling=$('#rangeMode').value==='today';if(state.module==='weld')state.view=rolling?'live':'weekly';$('#rangeModeField').hidden=spares;$('#startField').hidden=spares;$('#endField').hidden=spares;$('#startDate').disabled=spares;$('#endDate').disabled=spares;if(rolling)$('#startDate').value=$('#endDate').value=today();}
  function layoutAlarmFilters(){
    const alarm=state.module==='alarm',actions=$('#alarmFilterActions'),more=$('#alarmMoreFilters'),form=$('#queryForm');actions.hidden=!alarm;
    if(alarm){
      ['#rangeModeField','#alarmStatusField'].forEach(id=>$('#alarmMoreFields').append($(id)));
      actions.insertBefore($('#quickRanges'),more);actions.insertBefore($('#refreshRow'),more);
    }else{
      form.insertBefore($('#rangeModeField'),$('#startField'));form.insertBefore($('#alarmStatusField'),$('#alarmLineField'));
      const panel=form.parentElement;panel.insertBefore($('#quickRanges'),$('#queryError'));panel.insertBefore($('#refreshRow'),$('#queryError'));more.open=false;
    }
  }
  function renderModule(){
    document.body.classList.toggle('inventory-mode',state.module==='spares');
    document.body.classList.toggle('vision-mode',state.module==='vision');
    document.body.classList.toggle('alarm-mode',state.module==='alarm');if(state.module!=='alarm')closeAlarmDetail();if(state.module!=='weld')closeWeldDefectDetail();
    layoutAlarmFilters();
    const config=MODULES[state.module],title=config.title;$('#pageTitle').textContent=title;$('#breadcrumb').textContent=title;$('#pageDescription').textContent=config.description;$('#moduleNotice').textContent=config.notice;
    document.title=title+' · 工艺部业务门户';$$('.nav-link').forEach(link=>{const active=link.dataset.route===routeKey();link.classList.toggle('active',active);if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');});
    $('#weldReportSection').hidden=state.module!=='weld';$('#categoryField').hidden=state.module!=='spares';$('#importSection').hidden=state.module!=='spares';
    $('#alarmReportSection').hidden=state.module!=='alarm';['#materialField','#weldLineField','#defectField'].forEach(id=>$(id).hidden=state.module!=='weld');['#alarmStatusField','#alarmLineField','#alarmDepartmentField'].forEach(id=>$(id).hidden=state.module!=='alarm');
    $('#quickRanges').hidden=state.module!=='alarm';
    $('#stockField').hidden=state.module!=='spares';$('#sparesReportSection').hidden=state.module!=='spares';
    $('#recordsTitle').textContent=state.module==='weld'?(state.view==='live'?'最新焊接不合格记录':'焊接不合格记录明细'):state.module==='alarm'?'报警记录明细':'备件记录明细';
    $$('[data-view]').forEach(button=>{const active=button.dataset.view===state.view;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
    renderConnection();renderResult();
  }
  function switchModule(){const id=location.hash.slice(1);closeWeldDefectDetail();resetWeldDrill();cancelRequest();clearTimer();if(id==='alarm'||id==='spares'||id==='vision'){state.module=id;}else{state.module='weld';state.view='live';if(id!=='weld-live')history.replaceState(null,'','#weld-live');}state.page=1;state.result=state.cache.get(cacheKey())||null;state.error='';$('#keywordInput').value='';$('#categoryFilter').value='all';$('#stockFilter').value='all';['#materialFilter','#weldLineFilter','#alarmStatusFilter','#alarmLineFilter','#alarmDepartmentFilter'].forEach(id=>$(id).value='all');state.defects=[];state.defectDraft=[];$('#defectPicker').open=false;renderDefectPicker();resetDates();closeNav();state.polling=!['spares','vision'].includes(state.module);renderModule();if(canRead())loadData('route');}
  function queryChanged(){cancelRequest();clearTimer();state.page=1;loadData('filter');}
  function openSourceConnection(){if(!state.authenticated||state.status?.role!=='admin')return;$('#sourceConnectError').hidden=true;$('#sourcePasswordInput').value='';if(!$('#connectionDialog').open)$('#connectionDialog').showModal();$('#sourceUsernameInput').focus();}

  function validImportFile(file){return Boolean(file&&/\.csv$/i.test(file.name)&&file.size>0&&file.size<=1024*1024);}
  function resetImport(message='选择文件后点击“预览校验”。文件仅交给本地服务检查，不会提交入库。'){
    importState.revision++;if(importState.controller)importState.controller.abort();importState.controller=null;importState.result=null;
    $('#downloadPrepared').disabled=true;$('#previewImport').textContent='预览校验';$('#importPreview').className='empty-state compact';$('#importPreview').textContent=message;
    $('#previewImport').disabled=!state.authenticated||!validImportFile($('#importFile').files[0]);
  }
  function renderImport(result){
    const errors=Array.isArray(result.errors)?result.errors:[],warnings=Array.isArray(result.warnings)?result.warnings:[],rows=Array.isArray(result.rows)?result.rows:[];
    const issues=(items,title,kind)=>items.length?`<details class="import-issues ${kind}" ${kind==='errors'?'open':''}><summary>${title}（${items.length} 项）</summary><ul>${items.slice(0,30).map(item=>`<li>${item.row?'第 '+escape(item.row)+' 行：':''}${item.column?escape(item.column)+' · ':''}${escape(item.message||item)}</li>`).join('')}</ul>${items.length>30?'<p>仅展开前 30 项，请先修正后重新校验。</p>':''}</details>`:'';
    $('#importPreview').className='import-result';
    $('#importPreview').innerHTML=`<div class="import-summary ${result.valid?'valid':'invalid'}"><strong>${result.valid?'清单校验通过':'清单需要修正'}</strong><span>共 ${escape(result.totalRows??rows.length)} 行 · 通过 ${escape(result.validRows??rows.filter(row=>row.valid).length)} 行</span><p>${result.valid?'可以下载本地准备文件。下载并不代表原系统已接收入库。':'请修正错误后重新选择文件；未通过时不生成入库准备文件。'}</p></div>${issues(errors,'错误','errors')}${issues(warnings,'警告','warnings')}${rows.length?`<div class="table-wrap" tabindex="0" aria-label="入库清单预览"><table><thead><tr><th>行号</th><th>备件编号</th><th>备件名称</th><th>备件类型</th><th>入库数量</th><th>库位</th><th>备注</th><th>校验结果</th></tr></thead><tbody>${rows.slice(0,100).map(row=>{const value=row.values||{},raw=row.rawValues||{};return `<tr><td>${escape(row.rowNumber)}</td><td>${escape(value.code)}</td><td>${escape(value.name)}</td><td>${escape(value.category||row.category||'待确认')}</td><td>${escape(value.quantity??raw.quantity??'')}</td><td>${escape(value.location)}</td><td>${escape(value.remark)}</td><td class="${row.valid?'validation-ok':'validation-error'}">${row.valid?'通过':escape((row.errors||[]).map(item=>item.message||item).join('；')||'需修正')}</td></tr>`;}).join('')}</tbody></table></div>${rows.length>100?'<p class="import-help">页面预览前 100 行；下载文件包含全部通过校验的清单行。</p>':''}`:''}`;
    $('#downloadPrepared').disabled=!(result.valid===true&&rows.length>0&&rows.every(row=>row.valid));
  }
  async function previewImport(){
    const file=$('#importFile').files[0];if(!state.authenticated||!validImportFile(file)||importState.controller)return;
    resetImport('正在读取并校验所选清单…');const revision=importState.revision,controller=new AbortController();importState.controller=controller;
    $('#previewImport').disabled=true;$('#previewImport').textContent='正在校验…';
    try{const content=await file.text();if(revision!==importState.revision)return;const result=await api('/local/import-preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:file.name,content}),signal:controller.signal});if(revision!==importState.revision)return;if(!Array.isArray(result.rows))throw new Error('校验结果格式不符合约定，请检查本地服务。');importState.result=result;renderImport(result);}
    catch(error){if(revision!==importState.revision)return;$('#importPreview').className='empty-state compact validation-error';$('#importPreview').textContent='校验失败：'+errorText(error);if(error.status===401){invalidateStatusRequest();state.authenticated=false;state.connected=false;stopPolling();cancelRequest();$('#loginError').textContent='门户登录已过期，请重新登录后校验文件。';$('#loginError').hidden=false;renderConnection();}}
    finally{if(revision===importState.revision){importState.controller=null;$('#previewImport').textContent='预览校验';$('#previewImport').disabled=!state.authenticated||!validImportFile($('#importFile').files[0]);}}
  }
  function downloadPrepared(){
    const result=importState.result;if(!result?.valid||!Array.isArray(result.rows)||!result.rows.length||result.rows.some(row=>!row.valid))return;
    const cell=value=>{let text=String(value??'');if(/^[\s\uFEFF]*[=+\-@]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';};
    const lines=[['备件编号','备件名称','备件类型','入库数量','库位','备注'],...result.rows.map(row=>{const value=row.values;return [value.code,value.name,value.category||row.category||'',value.quantity,value.location,value.remark];})];
    const url=URL.createObjectURL(new Blob(['\uFEFF'+lines.map(row=>row.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='入库清单-已校验.csv';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);notify('已下载准备文件；未向原系统提交入库。');
  }

  $('#menuButton').addEventListener('click',()=>{const open=!document.body.classList.contains('nav-open');document.body.classList.toggle('nav-open',open);$('#menuButton').setAttribute('aria-expanded',String(open));$('#navBackdrop').hidden=!open;});
  $('#navBackdrop').addEventListener('click',closeNav);document.addEventListener('keydown',event=>{if(event.key==='Escape')closeNav();});
  $('#loginButton').addEventListener('click',openSourceConnection);
  $('#closeConnectionDialog').addEventListener('click',()=>$('#connectionDialog').close());$('#connectionDialog').addEventListener('close',()=>{$('#sourcePasswordInput').value='';});
  $('#loginForm').addEventListener('submit',async event=>{
    event.preventDefault();const username=$('#usernameInput').value.trim(),password=$('#passwordInput').value;if(!username||!password)return;
    invalidateStatusRequest();cancelRequest();$('#loginSubmit').disabled=true;$('#loginError').hidden=true;
    try{const pending=api('/local/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});$('#passwordInput').value='';await pending;invalidateStatusRequest();cancelRequest();state.cache.clear();state.result=null;state.error='';await checkStatus();if(!state.authenticated)throw new Error('尚未确认门户登录，请检查工号或本地服务。');$('#usernameInput').value='';$('#importFile').value='';resetImport();state.polling=!['spares','vision'].includes(state.module);renderConnection();renderResult();if(canRead()&&!state.result)await loadData('login');else schedulePolling();}
    catch(error){$('#loginError').hidden=false;$('#loginError').textContent=errorText(error);}
    finally{$('#passwordInput').value='';$('#loginSubmit').disabled=false;}
  });
  $('#connectionForm').addEventListener('submit',async event=>{
    event.preventDefault();const username=$('#sourceUsernameInput').value.trim(),password=$('#sourcePasswordInput').value;if(!username||!password||!state.authenticated||state.status?.role!=='admin')return;
    invalidateStatusRequest();cancelRequest();clearTimer();$('#sourceConnectSubmit').disabled=true;$('#sourceConnectSubmit').textContent='正在验证…';$('#sourceConnectError').hidden=true;
    try{const pending=api('/local/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});$('#sourcePasswordInput').value='';const result=await pending;invalidateStatusRequest();cancelRequest();if(result.sourceStatus&&state.status)state.status.sourceStatus=result.sourceStatus;state.connected=result.connected===true;state.cache.clear();state.result=null;state.error='';await checkStatus();if(!state.authenticated)throw new Error('门户登录已过期，请重新使用工号登录。');if(!state.connected)throw new Error('设置尚未验证成功，请检查账号权限或数据源状态。');$('#sourceUsernameInput').value='';$('#connectionDialog').close();state.polling=!['spares','vision'].includes(state.module);renderConnection();if(!state.result)await loadData('configure');else schedulePolling();notify('数据源设置已保存，今后登录门户会自动读取。');}
    catch(error){if(error.sourceStatus&&state.status)state.status.sourceStatus=error.sourceStatus;if(error.status===401)await checkStatus();if(!state.authenticated){$('#connectionDialog').close();$('#loginError').textContent='门户登录已过期，请重新使用工号登录。';$('#loginError').hidden=false;}else{$('#sourceConnectError').textContent=errorText(error);$('#sourceConnectError').hidden=false;}renderConnection();scheduleStatus();}
    finally{$('#sourcePasswordInput').value='';$('#sourceConnectSubmit').disabled=false;$('#sourceConnectSubmit').textContent='验证并保存设置';}
  });
  $('#logoutButton').addEventListener('click',async()=>{stopPolling();cancelRequest();invalidateStatusRequest();$('#logoutButton').disabled=true;try{await api('/local/logout',{method:'POST'});invalidateStatusRequest();cancelRequest();state.authenticated=false;state.connected=false;state.status=null;state.result=null;state.cache.clear();state.error='';$('#usernameInput').value='';$('#passwordInput').value='';$('#sourceUsernameInput').value='';$('#sourcePasswordInput').value='';$('#connectionDialog').close();$('#importFile').value='';resetImport();renderConnection();renderResult();notify('已退出门户并清除当前页面的数据。');}catch(error){notify('退出请求失败：'+errorText(error));}finally{$('#logoutButton').disabled=false;scheduleStatus();}});
  $('#alarmReport').addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button)return;if(button.dataset.alarmCard){openAlarmDetail(button.dataset.alarmCard);return;}if(button.dataset.scroll){const target=document.getElementById(button.dataset.scroll);if(target?.tagName==='DETAILS')target.open=true;target?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});return;}
    const fields=[['alarmStatus','#alarmStatusFilter'],['alarmLine','#alarmLineFilter'],['alarmDepartment','#alarmDepartmentFilter']];let changed=false;for(const [key,id] of fields){if(button.dataset[key]!==undefined){const select=$(id),value=button.dataset[key];if(![...select.options].some(option=>option.value===value))select.add(new Option(value,value));select.value=value;changed=true;}}if(changed){queryChanged();$('#queryForm').scrollIntoView({behavior:'auto',block:'start'});}
  });
  $('#closeAlarmDetail').addEventListener('click',closeAlarmDetail);
  $('#alarmDetailDialog').addEventListener('click',event=>{if(event.target===$('#alarmDetailDialog')){const bounds=event.target.getBoundingClientRect();if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)closeAlarmDetail();}});
  $('#weldReport').addEventListener('click',event=>{const mode=event.target.closest('[data-defect-catalog]');if(mode){weldRanking.mode=mode.dataset.defectCatalog;renderWeldReport();$('#weldReport').querySelector('[data-defect-catalog="'+weldRanking.mode+'"]')?.focus();return;}const button=event.target.closest('[data-defect-detail]');if(button)openWeldDefectDetail(Number(button.dataset.defectDetail));});
  $('#weldReport').addEventListener('change',event=>{if(event.target.id==='defectParentPicker'){weldRanking.parent=event.target.value;renderWeldReport();$('#defectParentPicker')?.focus();}});
  $('#closeWeldDefectDetail').addEventListener('click',closeWeldDefectDetail);
  $('#weldDefectDialog').addEventListener('cancel',event=>{event.preventDefault();closeWeldDefectDetail();});
  $('#weldDefectDialog').addEventListener('click',event=>{if(event.target===$('#weldDefectDialog')){const bounds=event.target.getBoundingClientRect();if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)closeWeldDefectDetail();}});
  $('#weldDefectBody').addEventListener('click',event=>{const button=event.target.closest('[data-weld-records]');if(button)locateWeldRecords(Number(button.dataset.weldRecords));});
  $('#weldDefectBody').addEventListener('change',event=>{if(event.target.id==='defectDetailLine'){weldDetail.line=event.target.value;renderWeldDefectDetail();$('#defectDetailLine').focus();}});
  $('#weldDrillFilters').addEventListener('click',event=>{const button=event.target.closest('[data-clear-drill]');if(!button)return;if(button.dataset.clearDrill==='location')state.weldLocation='all';else{state.weldOp='all';state.weldLocation='all';if(button.dataset.clearDrill!=='op')state.weldDefectType='all';}renderWeldDrill();queryChanged();});
  $('#queryForm').addEventListener('submit',event=>{event.preventDefault();queryChanged();});$('#refreshButton').addEventListener('click',()=>loadData('manual'));
  $('#rangeMode').addEventListener('change',()=>{if(state.module==='weld')resetWeldDrill();syncDateFields();queryChanged();});['#categoryFilter','#stockFilter','#materialFilter','#weldLineFilter','#alarmStatusFilter','#alarmLineFilter','#alarmDepartmentFilter'].forEach(id=>$(id).addEventListener('change',()=>{if(id==='#materialFilter'||id==='#weldLineFilter')resetWeldDrill();if(id==='#materialFilter'){$('#weldLineFilter').value='all';$('#weldLineFilter').title='全部线体';}queryChanged();}));
  ['#startDate','#endDate'].forEach(id=>$(id).addEventListener('change',()=>{if(state.module==='alarm'||state.module==='weld'){$('#rangeMode').value='custom';if(state.module==='weld'){state.view='weekly';resetWeldDrill();}}}));
  $$('[data-spares-view]').forEach(button=>button.addEventListener('click',()=>{state.sparesView=button.dataset.sparesView;$$('[data-spares-view]').forEach(item=>{const active=item.dataset.sparesView===state.sparesView;item.classList.toggle('active',active);item.setAttribute('aria-pressed',String(active));});renderResult();}));
  $$('[data-days]').forEach(button=>button.addEventListener('click',()=>{const days=Number(button.dataset.days),day=today();$('#rangeMode').value=days===1?'today':'custom';$('#startDate').value=shiftDate(day,1-days);$('#endDate').value=day;syncDateFields();queryChanged();}));
  $('#defectOptions').addEventListener('change',event=>{const checkbox=event.target.closest('input[type="checkbox"]');if(!checkbox)return;state.defectDraft=checkbox.checked?[...new Set([...state.defectDraft,checkbox.value])]:state.defectDraft.filter(value=>value!==checkbox.value);checkbox.closest('.defect-option').classList.toggle('selected',checkbox.checked);updateDefectDraftHint();});
  $('#defectAll').addEventListener('click',()=>{state.defectDraft=[];renderDefectPicker();});$('#defectClear').addEventListener('click',()=>{state.defectDraft=[];renderDefectPicker();});
  $('#defectWeld').addEventListener('click',()=>{state.defectDraft=['焊偏','焊穿'];renderDefectPicker();});
  $('#defectPicker').addEventListener('toggle',()=>{if($('#defectPicker').open){state.defectDraft=[...state.defects];renderDefectPicker();}});
  $('#applyDefects').addEventListener('click',()=>{resetWeldDrill();state.defects=[...state.defectDraft];$('#defectPicker').open=false;renderDefectPicker();queryChanged();});
  $('#defectChips').addEventListener('click',event=>{const button=event.target.closest('[data-remove-defect]');if(!button)return;resetWeldDrill();state.defects=state.defects.filter(value=>value!==button.dataset.removeDefect);state.defectDraft=[...state.defects];renderDefectPicker();queryChanged();});
  $('#pageSize').addEventListener('change',()=>{state.size=Number($('#pageSize').value);queryChanged();});
  $('#prevPage').addEventListener('click',()=>{state.page=Math.max(1,(Number(state.result?.data.page)||state.result?.query.page||1)-1);loadData('page');});
  $('#nextPage').addEventListener('click',()=>{state.page=(Number(state.result?.data.page)||state.result?.query.page||1)+1;loadData('page');});
  $('#pollButton').addEventListener('click',()=>{if(state.polling){stopPolling();return;}if(!canRead())return;state.polling=true;renderPolling();if(!state.request)loadData('poll');});
  $('#pollInterval').addEventListener('change',()=>{state.interval=Number($('#pollInterval').value);renderPolling();schedulePolling();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimer();invalidateStatusRequest();if(state.polling)cancelRequest();renderPolling();}else{checkStatus();if(state.polling&&state.connected){renderPolling();loadData('poll');}}});
  $$('[data-view]').forEach(button=>button.addEventListener('click',()=>{if(state.view===button.dataset.view)return;cancelRequest();stopPolling();state.view=button.dataset.view;state.page=1;state.result=state.cache.get(cacheKey())||null;state.error='';resetDates();renderModule();if(state.connected)loadData('view');}));
  $('#importFile').addEventListener('change',()=>{const file=$('#importFile').files[0];resetImport(!file?undefined:!validImportFile(file)?'请选择非空的 CSV UTF-8 文件，大小不超过 1 MB；Excel 文件请先另存为 CSV。':`已选择 ${file.name}（${Math.ceil(file.size/1024)} KB），点击“预览校验”检查清单。`);});
  $('#previewImport').addEventListener('click',previewImport);$('#downloadPrepared').addEventListener('click',downloadPrepared);
  document.addEventListener('click',event=>{if($('#defectPicker').open&&!$('#defectPicker').contains(event.target))$('#defectPicker').open=false;});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')$('#defectPicker').open=false;});
  window.addEventListener('resize',positionDefectPicker);document.addEventListener('scroll',positionDefectPicker,true);
  window.addEventListener('hashchange',switchModule);window.addEventListener('beforeunload',()=>{clearTimer();invalidateStatusRequest();cancelRequest();});
  document.addEventListener('portal:session-expired',()=>{invalidateStatusRequest();cancelRequest();state.authenticated=false;state.connected=false;state.status=null;state.cache.clear();state.result=null;stopPolling();renderConnection();renderResult();$('#loginError').textContent='门户登录已过期，请重新使用工号登录。';$('#loginError').hidden=false;});
  document.addEventListener('portal:refresh-status',()=>{invalidateStatusRequest();checkStatus();});
  switchModule();checkStatus({read:true});
})();
