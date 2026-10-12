(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const MODULES = {
    weld: {title:'补焊点',description:'焊接不合格日志的日期区间统计与独立实时监控。',notice:'这里显示焊接不合格日志。记录数不等于产品数，也不能据此确认已完成补焊。'},
    alarm: {title:'安灯报警',description:'按日期和关键词读取报警记录，状态以原系统字段为准。',notice:'查询结果反映报警记录，不直接代表设备当前运行状态；没有记录也不等于设备正常。'},
    spares: {title:'定位销与伸缩气缸管理',description:'重点备件查询、库存快照与入库清单校验。',notice:'这里展示最近成功读取的库存快照，不按日期筛选历史库存。清单校验不会写入库存，真实入库提交尚未开放。'}
  };
  const state = {status:null,authenticated:false,connected:false,module:'weld',view:'weekly',part:'front',page:1,size:50,result:null,error:'',loading:false,request:null,polling:false,interval:30,timer:null,cache:new Map(),statusLoading:false};
  let toastTimer;
  const importState={result:null,controller:null,revision:0};
  function today(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
  function shiftDate(day,amount){const date=new Date(day+'T12:00:00Z');date.setUTCDate(date.getUTCDate()+amount);return date.toISOString().slice(0,10);}
  function dateTime(value){if(!value)return '—';const date=new Date(value);if(Number.isNaN(date.getTime()))return String(value);return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(date);}
  function numberText(value){return typeof value==='number'&&Number.isFinite(value)?value.toLocaleString('zh-CN'):'—';}
  function countValue(value){return value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value))?Number(value):null;}
  function errorText(error){return String(error&&error.message||'请求未完成，请稍后重试。').slice(0,350);}
  function notify(message){$('#toast').textContent=message;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),3600);}
  async function api(path,options={}){
    const response=await fetch(path,{credentials:'same-origin',cache:'no-store',...options});
    let data;try{data=await response.json();}catch(_){throw new Error('服务未返回可识别的数据，请检查本地服务是否正常。');}
    if(!response.ok){const error=new Error(data.message||data.error||data.note||`读取失败（HTTP ${response.status}）`);error.status=response.status;throw error;}
    return data;
  }
  function cacheKey(){return state.module==='weld'?`weld:${state.view}`:state.module;}
  function routeKey(){return state.module==='weld'?`weld-${state.view}`:state.module;}
  function closeNav(){$('body').classList.remove('nav-open');$('#menuButton').setAttribute('aria-expanded','false');$('#navBackdrop').hidden=true;}
  function clearTimer(){if(state.timer){clearTimeout(state.timer);state.timer=null;}}
  function cancelRequest(){const request=state.request;if(request){state.request=null;request.controller.abort();clearTimeout(request.timeout);}state.loading=false;}
  function allowPolling(){return state.module!=='weld'||state.view==='live';}
  function stopPolling(){state.polling=false;clearTimer();renderPolling();}
  function schedulePolling(){clearTimer();if(state.polling&&state.connected&&allowPolling()&&!document.hidden&&!state.request)state.timer=setTimeout(()=>loadData('poll'),state.interval*1000);}
  function renderPolling(){
    const allowed=allowPolling();$('#intervalField').hidden=!allowed;$('#pollButton').hidden=!allowed;
    $('#pollButton').disabled=!state.connected;$('#pollButton').textContent=state.polling?'停止自动刷新':'启动自动刷新';$('#pollButton').setAttribute('aria-pressed',String(state.polling));$('#pollButton').classList.toggle('active',state.polling);
    $('#pollStatus').textContent=!allowed?'周报按所选日期手动更新':!state.connected?'连接后可手动启动自动刷新':state.polling?(document.hidden?'页面不可见，轮询已暂停':state.loading?'正在读取；完成后继续轮询':`自动刷新已启动 · 每 ${state.interval} 秒`):'自动刷新未启动';
  }
  function safeSourceUrl(){
    const urls=state.status&&state.status.sourceUrls;let value=urls&&urls[state.module];if(value&&typeof value==='object')value=value.url;
    if(typeof value!=='string'||!value)return null;try{const url=new URL(value,location.href);return ['http:','https:'].includes(url.protocol)?url.href:null;}catch(_){return null;}
  }
  function renderConnection(){
    $('#appShell').hidden=!state.authenticated;$('#loginScreen').hidden=state.authenticated;document.body.classList.toggle('logged-out',!state.authenticated);
    $('#connectionBadge').textContent=state.connected?'公司数据已连接':state.statusLoading?'检查连接中':'公司数据未连接';$('#connectionBadge').classList.toggle('connected',state.connected);
    $('#loginButton').hidden=state.connected;$('#logoutButton').hidden=!state.authenticated;$('#connectionPrompt').hidden=state.connected;
    $('#accountLabel').textContent=state.authenticated?`门户：${state.status?.account||'已登录'}${state.status?.role==='admin'?' · 管理员':''}${state.connected&&state.status?.sourceAccount?'；数据：'+state.status.sourceAccount:''}`:'尚未登录';
    $('#queryButton').disabled=!state.connected||state.loading;$('#refreshButton').disabled=!state.connected||state.loading;
    $('#previewImport').disabled=!state.authenticated||!validImportFile($('#importFile').files[0])||Boolean(importState.controller);
    const source=safeSourceUrl();$('#sourceLink').hidden=!source;if(source)$('#sourceLink').href=source;
    renderPolling();
  }
  async function checkStatus({read=false}={}){
    if(state.statusLoading)return;state.statusLoading=true;renderConnection();
    try{const status=await api('/local/status');state.status=status;state.authenticated=Boolean(status.authenticated);state.connected=state.authenticated&&Boolean(status.connected);$('#connectionBadge').classList.remove('error');if(!state.connected)stopPolling();if(read&&state.connected){if(state.module==='weld'&&state.view==='live')state.polling=true;await loadData('initial');}else renderResult();}
    catch(error){state.connected=false;if(error.status===401)state.authenticated=false;stopPolling();$('#connectionBadge').classList.add('error');state.error=`连接状态读取失败：${errorText(error)}`;$('#loginError').textContent=state.error;$('#loginError').hidden=false;renderResult();}
    finally{state.statusLoading=false;renderConnection();}
  }
  function querySnapshot(){
    const live=state.module==='weld'&&state.view==='live';const rolling=live||$('#rangeMode').value==='today';
    const start=rolling?today():$('#startDate').value,end=rolling?today():$('#endDate').value;
    if(rolling){$('#startDate').value=start;$('#endDate').value=end;}
    const keyword=$('#keywordInput').value.trim();const category=state.module==='spares'?$('#categoryFilter').value:'all';
    return {module:state.module,view:state.view,part:state.part,page:state.page,size:state.size,start,end,keyword,category,rolling};
  }
  function scopeText(query){if(!query)return '';return `${query.module==='spares'?'库存快照':query.start+' 至 '+query.end}${query.keyword?' · 关键词：'+query.keyword:''}${query.module==='spares'&&query.category!=='all'?' · '+(query.category==='pin'?'定位销':'伸缩气缸'):''}`;}
  function validateQuery(query){if(!/^\d{4}-\d{2}-\d{2}$/.test(query.start)||!/^\d{4}-\d{2}-\d{2}$/.test(query.end))return '请填写有效的开始和结束日期。';if(query.start>query.end)return '开始日期不能晚于结束日期。';return '';}
  async function loadData(reason='manual'){
    if(!state.connected||state.request||(document.hidden&&reason==='poll'))return;
    const query=querySnapshot(),invalid=validateQuery(query);$('#queryError').hidden=!invalid;$('#queryError').textContent=invalid;if(invalid){stopPolling();return;}
    clearTimer();const controller=new AbortController();const request={controller,key:cacheKey(),query,reason,timedOut:false};request.timeout=setTimeout(()=>{request.timedOut=true;controller.abort();},60000);state.request=request;state.loading=true;state.error='';renderConnection();renderResult();
    const params=new URLSearchParams({page:String(query.page),size:String(query.size),keyword:query.keyword,category:query.category});if(query.module!=='spares'){params.set('start',query.start);params.set('end',query.end);}if(query.module==='weld')params.set('view',query.view);
    try{
      const data=await api(`/local/data/${query.module}?${params}`,{signal:controller.signal});
      if(state.request!==request)return;if(!data||!Array.isArray(data.rows))throw new Error('接口记录格式不符合约定，未覆盖上次成功数据。');
      state.result={data,query,successAt:data.fetchedAt||new Date().toISOString()};state.cache.set(request.key,state.result);state.error='';
    }catch(error){
      if(state.request!==request)return;if(error.name==='AbortError'&&!request.timedOut)return;
      state.error=request.timedOut?'读取超时，请稍后重试。':errorText(error);
      if(error.status===401){state.authenticated=false;state.connected=false;stopPolling();state.error='门户登录已过期，请重新登录管理员账号。';$('#passwordInput').value='';$('#loginError').textContent=state.error;$('#loginError').hidden=false;}
      else if(error.status===428){state.connected=false;stopPolling();state.error='公司数据连接已过期，请重新连接公司数据。门户登录仍然有效。';}
      else if(error.status===403){stopPolling();state.error='当前账号没有读取此模块的权限，自动刷新已停止。请向系统管理员核对权限。';}
    }finally{
      clearTimeout(request.timeout);if(state.request===request){state.request=null;state.loading=false;renderConnection();renderResult();schedulePolling();}
    }
  }
  function valueText(value){if(value==null||value==='')return '—';if(typeof value==='object'){try{return JSON.stringify(value);}catch(_){return '—';}}return String(value);}
  function renderTable(data){
    let columns=Array.isArray(data.columns)?data.columns.filter(c=>c&&typeof c.key==='string'):[];
    if(!columns.length&&data.rows.length)columns=Object.keys(data.rows[0]).map(key=>({key,label:key}));
    if(!data.rows.length)return '<div class="empty-state">接口本次返回 0 条记录。请结合日期、筛选条件和完整性提示判断。</div>';
    if(!columns.length)return '<div class="empty-state">已收到记录，但没有可展示的字段。</div>';
    return `<div class="table-wrap" tabindex="0" aria-label="业务记录，可横向滚动"><table><thead><tr>${columns.map(c=>`<th scope="col">${escape(c.label||c.key)}</th>`).join('')}</tr></thead><tbody>${data.rows.map(row=>`<tr>${columns.map(c=>`<td>${escape(valueText(row[c.key]))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  function renderWeldReport(){
    if(state.module!=='weld')return;
    const report=state.result&&state.result.data.report;$('#weldReportTitle').textContent=state.view==='live'?'当天累计与最新记录':'日期区间统计';
    $('#weldReportSubtitle').textContent=state.view==='live'?'累计指标以完整读取的数据为准，最新记录见下方明细。':'以接口核验后的汇总为准，不用当前分页推算全量指标。';
    const host=$('#weldReport'),product=report&&report.products&&report.products[state.part];
    if(!product){host.className='empty-state';host.textContent=state.result?'本次接口尚未提供该产品组的已核验报表。下方仅展示原始记录，不推算补焊点数或去重件数。':'尚未取得已核验的补焊统计。';return;}
    host.className='';const complete=report.period?.coverage?.status==='complete';const available=product.available!==false||complete;
    const metric=(label,value,note)=>`<article class="metric"><span>${escape(label)}</span><strong>${escape(value)}</strong><small>${escape(note)}</small></article>`;
    const fmt=value=>Number.isFinite(value)?value.toLocaleString('zh-CN'):'—';const ratio=value=>Number.isFinite(value)?value.toFixed(2):'—';const pct=value=>Number.isFinite(value)?(value*100).toFixed(1)+'%':'—';
    const palette=['#244d97','#527cbd','#85a9d5','#b3c9e5'];const lineNames=Object.keys(product.lineCounts||{});const lineColor=line=>palette[Math.max(0,lineNames.indexOf(line))%palette.length];
    const top5=Array.isArray(product.top5)?product.top5:[],max=Math.max(1,...top5.map(item=>Number(item.total)||0));
    const topChart=top5.length?top5.map(item=>`<div class="bar-row"><span class="bar-label" title="${escape(item.location)}">${escape(item.shortLocation||item.location)}</span><div class="bar-track">${Object.entries(item.lines||{}).map(([line,count])=>`<span class="bar-segment" style="width:${Math.max(0,Number(count)||0)/max*100}%;background:${lineColor(line)}" title="${escape(line)}线：${escape(count)} 点"></span>`).join('')}${Number(item.unassigned)>0?`<span class="bar-segment" style="width:${Number(item.unassigned)/max*100}%;background:#c9ced6" title="未分配产线：${escape(item.unassigned)} 点"></span>`:''}</div><strong class="bar-value">${fmt(item.total)}</strong></div>`).join(''):'<div class="chart-empty">当前没有可汇总的位置记录</div>';
    const legend=`<div class="chart-legend">${lineNames.map(line=>`<span style="--legend-color:${lineColor(line)}">${escape(line)}线</span>`).join('')}<span style="--legend-color:#c9ced6">未分配产线</span></div>`;
    const opCharts=Object.entries(product.opShares||{}).map(([line,group])=>`<div class="op-group"><h3>${escape(line)}线 <small>${fmt(group.count)} 点</small></h3>${Array.isArray(group.items)&&group.items.length?group.items.map(item=>`<div class="bar-row"><span class="bar-label">${escape(item.op)}</span><div class="bar-track"><span class="bar-fill" style="width:${Number.isFinite(item.share)?Math.max(0,Math.min(100,item.share*100)):0}%;background:${lineColor(line)}"></span></div><span class="bar-value">${pct(item.share)}</span></div>`).join(''):'<div class="chart-empty compact">该线尚无可展示记录</div>'}</div>`).join('');
    const details=Array.isArray(product.top5Details)?product.top5Details:top5;
    const detailTable=details.length?`<div class="table-wrap" tabindex="0" aria-label="缺陷位置前五明细"><table><thead><tr><th>排名</th><th>缺陷位置</th><th>OP 工位</th><th>补焊点</th><th>占比</th><th>各线分布</th><th>缺陷类型</th></tr></thead><tbody>${details.map(item=>`<tr><td>${escape(item.rank)}</td><td>${escape(item.location)}</td><td>${escape(item.op)}</td><td>${fmt(item.total)}</td><td>${pct(item.share)}</td><td>${escape(Object.entries(item.lines||{}).map(([line,count])=>`${line}线 ${count}`).join(' / '))}${Number(item.unassigned)>0?' / 未分配 '+escape(item.unassigned):''}</td><td>${escape(Object.entries(item.defectCounts||{}).map(([name,count])=>`${name} ${count}`).join(' / '))}</td></tr>`).join('')}</tbody></table></div>`:'<div class="chart-empty">暂无位置明细</div>';
    const trend=Array.isArray(report.weeklyTrend)?report.weeklyTrend.slice(-5):[];const trendMax=Math.max(1,...trend.map(week=>Number(week.products?.[state.part]?.defectPoints)||0));
    const trendChart=trend.length?`<div class="trend-grid">${trend.map(week=>{const p=week.products?.[state.part],missing=!p||p.defectPoints==null;const coverage=p?.coverage;const change=p?.comparison;const comparable=coverage==='complete'&&change?.allowed===true&&Number.isFinite(change.defectPointsPercent);const changeText=comparable?`点数环比 ${change.defectPointsPercent>0?'+':''}${change.defectPointsPercent.toFixed(1)}%`:'不计算环比';return `<div class="trend-item ${missing?'missing':''}"><span>${escape(week.startDate||'日期待核实')}<br>至 ${escape(week.endDate||'日期待核实')}</span><div class="trend-column-space">${missing?'<span class="trend-missing">缺失</span>':`<div class="trend-column" style="height:${Math.max(2,Number(p.defectPoints)/trendMax*76)}px"></div>`}</div><strong>${missing?'—':fmt(p.defectPoints)}</strong><small>${missing?'未取得历史数据':`${fmt(p.pieces)} 件 · ${ratio(p.pointsPerPiece)} 点/件`}</small><small>${coverage==='complete'?'完整覆盖':missing?'历史缺失':'覆盖不完整 / 未核实'}</small><small>${changeText}</small></div>`;}).join('')}</div>`:'<div class="chart-empty">接口尚未提供历史数据，近五周趋势暂缺。</div>';
    const diagnostic=product.diagnostics||{};const warnings=[];if(!complete)warnings.push('当前日期范围的完整覆盖尚未确认，以下为已取得记录的统计');if(!available)warnings.push('尚无该产品组记录，不能把缺失解释为零');if(diagnostic.missingQr)warnings.push(`${diagnostic.missingQr} 条记录缺少二维码，去重件数可能偏低`);if(diagnostic.unassignedLine)warnings.push(`${diagnostic.unassignedLine} 点无法判定产线`);if(diagnostic.fullyDuplicateRowsRetained)warnings.push(`${diagnostic.fullyDuplicateRowsRetained} 条完全重复记录按既定口径保留`);
    host.innerHTML=`<div class="report-meta"><strong>${escape(product.name|| (state.part==='front'?'前副':'后副'))}</strong><span>${escape(report.period?.startDate||state.result.query.start)} 至 ${escape(report.period?.endDate||state.result.query.end)}</span><span>料号 ${escape((product.materials||[]).join(' / ')||'待核实')}</span></div>${warnings.length?`<div class="notice warning">${warnings.map(escape).join('；')}。</div>`:''}<div class="report-metrics">${metric('总补焊点',available?fmt(product.defectPoints):'—','目标料号内，焊偏 / 焊穿源记录计点')}${metric('二维码去重件数',available?fmt(product.pieces):'—','同产品组、同期间的非空二维码')}${metric('点 / 件',available?ratio(product.pointsPerPiece):'—','补焊点 ÷ 去重件数，不是产量不良率')}</div><div class="report-grid"><section class="panel"><div class="panel-heading"><h2>缺陷位置 Top 5 · 按产线分布</h2></div>${topChart}${legend}<p class="report-note">位置缺失仍计入总点数，但不进入位置排名。</p></section><section class="panel"><div class="panel-heading"><h2>各线 OP 工位占比 · Top 5 + 其他</h2></div><div class="op-grid">${opCharts||'<div class="chart-empty">暂无工位分布</div>'}</div></section></div><section class="panel report-detail"><div class="panel-heading"><h2>Top 5 位置明细</h2><span class="subtle-label">合计 ${fmt(product.top5Total)} 点 · ${pct(product.top5Share)}</span></div>${detailTable}</section>${state.view==='weekly'?`<section class="panel"><div class="panel-heading"><h2>近五周趋势</h2><span class="subtle-label">按实际日期展示，不套用旧周号</span></div>${trendChart}<p class="report-note">只在相邻两期完整覆盖且物料、缺陷范围可比时显示环比；缺失数据不补零。</p></section>`:''}<p class="report-note">统计口径：焊偏 / 焊穿每条源记录计 1 点，完全重复记录保留；此处不确认已完成补焊。${escape(report.methodology?.limitation||'')}</p>`;
  }
  function renderResult(){
    const result=state.result,data=result&&result.data,status=$('#readStatus');status.className='read-status';
    if(state.error){status.classList.add('error');status.textContent=`读取失败：${state.error}${result?' 当前保留上次成功数据（'+scopeText(result.query)+'）。':' 尚无成功数据可显示。'}`;}
    else if(state.loading){status.classList.add('loading');status.textContent=result?'正在读取当前条件，暂时显示上次成功数据。':'正在读取真实接口，请稍候…';}
    else if(result){status.classList.add('success');status.textContent=`已成功读取本页 ${data.rows.length} 条记录。${data.note?' '+data.note:''}`;}
    else status.textContent=state.connected?'已连接，尚未读取当前模块。':'尚未读取数据，请先连接公司数据。';
    $('#recordTotal').textContent=data?numberText(countValue(data.total)):'—';
    $('#totalCaption').textContent=data?`当前条件下实际已读取的记录${countValue(data.sourceTotal)!==null?'；来源报告总量 '+numberText(countValue(data.sourceTotal))+' 条':''}${state.module==='weld'?'。不等于补焊点数或去重件数。':''}`:'等待真实接口返回';
    $('#lastSuccess').textContent=result?dateTime(result.successAt):'—';$('#sourceTime').textContent=data?dateTime(data.sourceTime):'—';
    $('#completeness').textContent=!data?'完整性尚未核实':data.complete===true?'分页条数已核对（截至本次读取）':data.complete===false?'数据可能不完整，请结合读取提示核对':'接口未确认完整性';
    $('#dataTable').className=data?'':'empty-state';$('#dataTable').innerHTML=data?renderTable(data):(state.connected?'当前模块尚无成功读取结果。':'连接公司数据后，点击查询读取真实记录。');
    $('#resultScope').textContent=result?`当前展示：${scopeText(result.query)}${state.module==='weld'?' · 明细包含日期范围内全部料号；前副 / 后副切换仅作用于统计区。':''}`:'查询后展示接口字段。';
    const page=data?Number(data.page)||result.query.page:state.page,size=data?Number(data.size)||result.query.size:state.size,total=data?countValue(data.total):null,pages=total!==null?Math.max(1,Math.ceil(total/size)):null;
    $('#pageSummary').textContent=data?`本页 ${data.rows.length} 条${Number.isFinite(total)?' / 共 '+total.toLocaleString('zh-CN')+' 条':''}`:'尚未读取';$('#pageNumber').textContent=data?`${page}${pages?' / '+pages:''}`:'—';
    $('#prevPage').disabled=!state.connected||state.loading||!data||page<=1;$('#nextPage').disabled=!state.connected||state.loading||!data||(pages!==null?page>=pages:data.rows.length<size);
    renderWeldReport();
  }
  function resetDates(){const day=today();const weekly=state.module==='weld'&&state.view==='weekly';$('#rangeMode').value=weekly?'custom':'today';$('#startDate').value=weekly?shiftDate(day,-6):day;$('#endDate').value=day;syncDateFields();}
  function syncDateFields(){const live=state.module==='weld'&&state.view==='live',spares=state.module==='spares';const rolling=live||$('#rangeMode').value==='today';$('#rangeModeField').hidden=live||spares;$('#startField').hidden=spares;$('#endField').hidden=spares;$('#startDate').disabled=rolling||spares;$('#endDate').disabled=rolling||spares;if(rolling)$('#startDate').value=$('#endDate').value=today();}
  function renderModule(){
    const config=MODULES[state.module],title=state.module==='weld'?(state.view==='live'?'补焊实时监控':'补焊周报'):config.title;$('#pageTitle').textContent=title;$('#breadcrumb').textContent=title;$('#pageDescription').textContent=config.description;$('#moduleNotice').textContent=config.notice;
    document.title=title+' · 工艺部业务门户';$$('.nav-link').forEach(link=>{const active=link.dataset.route===routeKey();link.classList.toggle('active',active);if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');});
    $('#weldReportSection').hidden=state.module!=='weld';$('#categoryField').hidden=state.module!=='spares';$('#importSection').hidden=state.module!=='spares';
    $('#recordsTitle').textContent=state.module==='weld'?(state.view==='live'?'最新焊接不合格记录':'焊接不合格记录明细'):state.module==='alarm'?'报警记录明细':'备件记录明细';
    $$('[data-view]').forEach(button=>{const active=button.dataset.view===state.view;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
    renderConnection();renderResult();
  }
  function switchModule(){const id=location.hash.slice(1);cancelRequest();stopPolling();if(id==='weld-live'){state.module='weld';state.view='live';}else if(id==='alarm'||id==='spares'){state.module=id;}else{state.module='weld';state.view='weekly';}state.page=1;state.result=state.cache.get(cacheKey())||null;state.error='';$('#keywordInput').value='';$('#categoryFilter').value='all';resetDates();closeNav();if(state.connected&&state.module==='weld'&&state.view==='live')state.polling=true;renderModule();if(state.connected)loadData('route');}
  function queryChanged(){cancelRequest();clearTimer();state.page=1;loadData('filter');}
  function openSourceConnection(){if(!state.authenticated)return;$('#sourceConnectError').hidden=true;$('#sourcePasswordInput').value='';if(!$('#connectionDialog').open)$('#connectionDialog').showModal();$('#sourceUsernameInput').focus();}

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
    catch(error){if(revision!==importState.revision)return;$('#importPreview').className='empty-state compact validation-error';$('#importPreview').textContent='校验失败：'+errorText(error);if(error.status===401){state.authenticated=false;state.connected=false;stopPolling();cancelRequest();$('#loginError').textContent='门户登录已过期，请重新登录后校验文件。';$('#loginError').hidden=false;renderConnection();}}
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
  $('#loginButton').addEventListener('click',openSourceConnection);$('#connectPromptButton').addEventListener('click',openSourceConnection);
  $('#closeConnectionDialog').addEventListener('click',()=>$('#connectionDialog').close());$('#connectionDialog').addEventListener('close',()=>{$('#sourcePasswordInput').value='';});
  $('#loginForm').addEventListener('submit',async event=>{
    event.preventDefault();const username=$('#usernameInput').value.trim(),password=$('#passwordInput').value;if(!username||!password)return;
    $('#loginSubmit').disabled=true;$('#loginError').hidden=true;
    try{const pending=api('/local/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});$('#passwordInput').value='';await pending;await checkStatus();if(!state.authenticated)throw new Error('尚未确认门户登录，请检查管理员账号或本地服务。');$('#usernameInput').value='';state.cache.clear();state.result=null;state.error='';$('#importFile').value='';resetImport();if(state.connected&&state.module==='weld'&&state.view==='live')state.polling=true;renderConnection();renderResult();if(state.connected)await loadData('login');}
    catch(error){$('#loginError').hidden=false;$('#loginError').textContent=errorText(error);}
    finally{$('#passwordInput').value='';$('#loginSubmit').disabled=false;}
  });
  $('#connectionForm').addEventListener('submit',async event=>{event.preventDefault();const username=$('#sourceUsernameInput').value.trim(),password=$('#sourcePasswordInput').value;if(!username||!password||!state.authenticated)return;$('#sourceConnectSubmit').disabled=true;$('#sourceConnectError').hidden=true;try{const pending=api('/local/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});$('#sourcePasswordInput').value='';await pending;await checkStatus();if(!state.authenticated)throw new Error('门户登录已过期，请重新登录管理员账号。');if(!state.connected)throw new Error('尚未确认公司数据连接，请检查账号权限或本地服务。');$('#sourceUsernameInput').value='';$('#connectionDialog').close();state.cache.clear();state.result=null;state.error='';if(state.module==='weld'&&state.view==='live')state.polling=true;renderConnection();await loadData('connect');}catch(error){if(error.status===401)await checkStatus();if(!state.authenticated){$('#connectionDialog').close();$('#loginError').textContent='门户登录已过期，请重新登录管理员账号。';$('#loginError').hidden=false;}else{$('#sourceConnectError').textContent=errorText(error);$('#sourceConnectError').hidden=false;}}finally{$('#sourcePasswordInput').value='';$('#sourceConnectSubmit').disabled=false;}});
  $('#logoutButton').addEventListener('click',async()=>{stopPolling();cancelRequest();$('#logoutButton').disabled=true;try{await api('/local/logout',{method:'POST'});state.authenticated=false;state.connected=false;state.status=null;state.result=null;state.cache.clear();state.error='';$('#usernameInput').value='';$('#passwordInput').value='';$('#sourceUsernameInput').value='';$('#sourcePasswordInput').value='';$('#connectionDialog').close();$('#importFile').value='';resetImport();renderConnection();renderResult();notify('已退出门户并清除当前页面的数据。');}catch(error){notify('退出请求失败：'+errorText(error));}finally{$('#logoutButton').disabled=false;}});
  $('#queryForm').addEventListener('submit',event=>{event.preventDefault();queryChanged();});$('#refreshButton').addEventListener('click',()=>loadData('manual'));
  $('#rangeMode').addEventListener('change',syncDateFields);$('#categoryFilter').addEventListener('change',queryChanged);
  $('#pageSize').addEventListener('change',()=>{state.size=Number($('#pageSize').value);queryChanged();});
  $('#prevPage').addEventListener('click',()=>{state.page=Math.max(1,(Number(state.result?.data.page)||state.result?.query.page||1)-1);loadData('page');});
  $('#nextPage').addEventListener('click',()=>{state.page=(Number(state.result?.data.page)||state.result?.query.page||1)+1;loadData('page');});
  $('#pollButton').addEventListener('click',()=>{if(state.polling){stopPolling();return;}if(!state.connected||!allowPolling())return;state.polling=true;renderPolling();if(!state.request)loadData('poll');});
  $('#pollInterval').addEventListener('change',()=>{state.interval=Number($('#pollInterval').value);renderPolling();schedulePolling();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimer();if(state.polling)cancelRequest();renderPolling();}else if(state.polling&&state.connected){renderPolling();loadData('poll');}});
  $$('[data-view]').forEach(button=>button.addEventListener('click',()=>{if(state.view===button.dataset.view)return;cancelRequest();stopPolling();state.view=button.dataset.view;state.page=1;state.result=state.cache.get(cacheKey())||null;state.error='';resetDates();renderModule();if(state.connected)loadData('view');}));
  $$('[data-part]').forEach(button=>button.addEventListener('click',()=>{state.part=button.dataset.part;$$('[data-part]').forEach(item=>{const active=item.dataset.part===state.part;item.classList.toggle('active',active);item.setAttribute('aria-pressed',String(active));});renderWeldReport();}));
  $('#importFile').addEventListener('change',()=>{const file=$('#importFile').files[0];resetImport(!file?undefined:!validImportFile(file)?'请选择非空的 CSV UTF-8 文件，大小不超过 1 MB；Excel 文件请先另存为 CSV。':`已选择 ${file.name}（${Math.ceil(file.size/1024)} KB），点击“预览校验”检查清单。`);});
  $('#previewImport').addEventListener('click',previewImport);$('#downloadPrepared').addEventListener('click',downloadPrepared);
  window.addEventListener('hashchange',switchModule);window.addEventListener('beforeunload',()=>{clearTimer();cancelRequest();});
  switchModule();checkStatus({read:true});
})();
