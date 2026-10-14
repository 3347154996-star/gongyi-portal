(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const n = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';
  const measureNumber = value => typeof value === 'number' && Number.isFinite(value) ? String(value) : '—';
  const stamp = value => value ? String(value).replace('T',' ').replace(/\.\d+Z$/,' UTC').replace(/Z$/,' UTC') : '—';
  const resultBadge = result => `<span class="vis-result ${result==='OK'?'ok':result==='NG'?'ng':'unknown'}">${esc(result || '待核实')}</span>`;
  const emptyFilters = () => ({start:'',end:'',part:'all',result:'all',search:'',interval:'auto',recentLimit:'all',lineId:'all',deviceId:'all'});
  const state = {status:null,account:null,active:false,epoch:0,report:null,reportQuery:null,trendDate:null,page:1,size:50,request:null,detailRequest:null,importRequest:null,timer:null,error:'',lastRead:null,fleet:null,liveSource:null,catalogRequest:null,saveDeviceRequest:null,catalogError:'',filters:emptyFilters()};
  let trendCache=null,trendTableCache=null;
  const root = document.createElement('section');
  root.id='visionWorkbench';root.className='vision-workbench';root.hidden=true;root.setAttribute('aria-label','视觉检具检测数据');
  root.innerHTML=`
    <section class="vis-panel vis-fleet" aria-labelledby="visFleetTitle">
      <div class="vis-panel-heading"><div><p class="vis-section-kicker">检测设备管理</p><h2 id="visFleetTitle">线体与检具</h2><p>选择线体和检具，查看对应检测记录与合格率。</p></div><div class="vis-fleet-actions"><a id="visGuideLink" class="button" href="/vision-connection-guide.html" target="_blank" rel="noopener">接入流程 ↗</a><button id="visAddDevice" class="button primary" type="button" hidden>＋ 登记检具</button></div></div>
      <div class="vis-fleet-filters"><label class="field"><span>所属线体</span><select id="visLineSelect"><option value="all">全部线体</option></select></label><label class="field"><span>检测设备</span><select id="visDeviceSelect"><option value="all">全部检具</option></select></label><p id="visFleetCount">正在读取检具台账…</p></div>
      <p id="visCatalogError" class="vis-message error" role="alert" hidden></p><div id="visFleetCards" class="vis-fleet-cards"></div>
      <p class="vis-hint vis-fleet-footnote">“待配置”只表示已登记，完成数据格式适配、连接和验收后才会显示检测数据。</p>
    </section>
    <p id="visPendingNotice" class="vis-message" role="status" hidden></p>
    <div class="vis-source" id="visSource" role="status"><span class="vis-source-mark" aria-hidden="true">◎</span><div><strong id="visSourceTitle">等待读取检测数据</strong><p id="visSourceMessage">登录后读取已接入的检测记录。</p><small id="visSourceTime"></small></div><button id="visRefresh" type="button" class="button">刷新数据</button></div>
    <form id="visQueryForm" class="vis-query vis-panel" aria-label="视觉检具筛选条件">
      <div id="visPeriodChoices" class="vis-period-choices" role="group" aria-label="快捷时间范围"><span>快捷时间</span><button type="button" data-vis-period="today" aria-pressed="false">今天</button><button type="button" data-vis-period="week" aria-pressed="false">近7天</button><button type="button" data-vis-period="month" aria-pressed="false" title="最近30天，含今天">近1个月</button><button type="button" data-vis-period="all" aria-pressed="true">全部</button><small>近1个月按最近30天计算</small></div>
      <label class="field vis-datetime"><span>开始时间（选填）</span><input id="visStart" type="datetime-local" step="60"></label>
      <label class="field vis-datetime"><span>结束时间（选填）</span><input id="visEnd" type="datetime-local" step="60"></label>
      <label class="field"><span>零件型号</span><select id="visPart"><option value="all">全部普通检测</option><option value="Tesla_Front11">Tesla_Front11</option><option value="Tesla_Front12">Tesla_Front12</option></select></label>
      <label class="field"><span>检测结论</span><select id="visResult"><option value="all">全部结果</option><option value="OK">OK · 合格</option><option value="NG">NG · 不合格</option></select></label>
      <label class="field vis-search"><span>零件 SN / 检具 / 型号</span><input id="visSearch" type="search" placeholder="输入关键词查询" autocomplete="off" maxlength="150"></label>
      <div class="vis-query-actions"><button class="button primary" type="submit">查询</button><button class="button" id="visReset" type="button">重置</button></div>
      <div class="vis-recent-choices"><label for="visRecentLimit">查看数量</label><select id="visRecentLimit"><option value="all">全部记录</option><option value="100">最近 100 条</option><option value="500">最近 500 条</option><option value="1000">最近 1000 条</option><option value="custom">自定义数量</option></select><label id="visRecentCustom" class="vis-recent-custom" hidden><span>最近</span><input id="visRecentCount" disabled type="number" min="1" max="20000" step="1" value="500" aria-label="最近检测记录数量"><span>条</span></label><small id="visSelectionNote">在当前条件下按检测时间取最新记录，重复检测按多条计数。</small></div>
      <p class="vis-hint">时间留空不限范围；结束时间包含该分钟内的全部检测。时间按检具原始记录显示。</p>
    </form>
    <p id="visError" class="vis-message error" role="alert" hidden></p>
    <div class="vis-stats" aria-label="当前筛选统计"><article><span>检测记录</span><strong id="visTotal">—</strong><small>按检测次数计数</small></article><article><span>合格 OK</span><strong id="visOK">—</strong><small>原始整体结论</small></article><article class="vis-stat-ng"><span>不合格 NG</span><strong id="visNG">—</strong><small>原始整体结论</small></article><article><span>检测合格率</span><strong id="visRate">—</strong><small>OK / 可统计记录</small></article></div>
    <p id="visConflictNote" class="vis-message warning" hidden></p>
    <section class="vis-panel vis-trend" aria-labelledby="visTrendTitle">
      <div class="vis-panel-heading"><div><h2 id="visTrendTitle">合格率趋势</h2><p id="visTrendSubtitle">查看每个时间段的检测表现</p></div><div class="vis-trend-toolbar"><label for="visInterval">统计间隔</label><select id="visInterval"><option value="auto">自动</option><option value="5m">5 分钟</option><option value="15m">15 分钟</option><option value="30m">30 分钟</option><option value="hour">1 小时</option><option value="day">1 天</option></select><span class="vis-trend-legend"><i aria-hidden="true"></i><span id="visTrendLegend">每日合格率</span></span></div></div>
      <div id="visTrendEmpty" class="vis-empty">等待读取合格率趋势。</div>
      <div id="visTrendChart" class="vis-trend-chart" hidden></div>
      <div id="visTrendDetail" class="vis-trend-detail" role="status" hidden></div>
      <p id="visTrendHint" class="vis-hint" hidden></p>
      <details id="visTrendData" class="vis-trend-data" hidden><summary>查看每日数据</summary><div id="visTrendTable" class="vis-table-wrap" tabindex="0" aria-label="每日合格率数据，可横向滚动"></div></details>
    </section>
    <section class="vis-panel vis-records" aria-labelledby="visRecordsTitle"><div class="vis-panel-heading"><div><h2 id="visRecordsTitle">检测记录</h2><p id="visScope">尚未读取记录。</p></div><span id="visPolling" class="vis-polling">打开此页时每 30 秒刷新</span></div><div id="visTable" class="vis-empty">等待读取检测记录。</div><div class="vis-pagination"><label class="inline-field"><span>每页</span><select id="visPageSize" aria-label="检测记录每页条数"><option value="20">20 条</option><option value="50" selected>50 条</option><option value="100">100 条</option></select></label><div><button id="visPrev" type="button" class="button" disabled>上一页</button><span id="visPageNumber">—</span><button id="visNext" type="button" class="button" disabled>下一页</button></div></div></section>
    <details id="visImportPanel" class="vis-panel vis-import" hidden><summary>导入检测 CSV <span>管理员</span></summary><p>选择从检具备份目录取得的单个 CSV，加入门户记录。导入文件不会建立现场自动同步。</p><form id="visImportForm"><label class="field"><span>检具标识</span><input id="visDevice" value="vision-01" required maxlength="100" autocomplete="off"><small>同一台检具请保持同一标识，便于识别重复记录。</small></label><label class="field vis-import-file"><span>普通检测 CSV 文件</span><input id="visFile" type="file" accept=".csv,text/csv" required><small>仅 Front11 / Front12，排除 ALLmeasure 全检；单个文件不超过 1 MB。</small></label><button id="visImportButton" type="submit" class="button primary">导入记录</button></form><p id="visImportMessage" class="vis-message" role="status" hidden></p></details>`;
  $('.filter-panel').before(root);
  const dialog = document.createElement('dialog');
  dialog.id='visDetailDialog';dialog.className='vis-dialog';dialog.setAttribute('aria-labelledby','visDetailTitle');
  dialog.innerHTML='<div class="dialog-heading"><div><p class="eyebrow">视觉检具 · 测点明细</p><h2 id="visDetailTitle">检测详情</h2></div><button id="visCloseDetail" type="button" class="icon-button" aria-label="关闭检测详情">×</button></div><div id="visDetailBody"></div>';
  document.body.append(dialog);

  const deviceDialog=document.createElement('dialog');
  deviceDialog.id='visDeviceDialog';deviceDialog.className='vis-dialog vis-device-dialog';deviceDialog.setAttribute('aria-labelledby','visDeviceDialogTitle');
  deviceDialog.innerHTML=`<div class="dialog-heading"><div><p class="eyebrow">线体与检具</p><h2 id="visDeviceDialogTitle">登记新检具</h2></div><button id="visDeviceClose" type="button" class="icon-button" aria-label="关闭检具登记">×</button></div><p class="vis-device-intro">先保存检具资料，作为后续接入清单。登记后状态为“待配置”，不会立即读取该路径或连接设备。</p><form id="visDeviceForm" class="vis-device-form">
    <label class="field"><span>所属线体</span><select id="visDraftLine" required></select></label><label id="visDraftLineNameField" class="field"><span>新线体名称</span><input id="visDraftLineName" maxlength="80" placeholder="填写现场实际线体名称"></label>
    <label class="field"><span>检具名称</span><input id="visDraftName" required maxlength="100" placeholder="如：一号检具"></label><label class="field"><span>唯一设备编号</span><input id="visDraftId" required pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}" maxlength="64" placeholder="如：vision-02" autocomplete="off"><small>每台检具使用不同编号；现有 vision-01 保持不变。</small></label>
    <label class="field"><span>计划连接方式</span><select id="visDraftTransport"><option value="share">厂内共享文件</option><option value="upload">上传到服务器（需另行适配）</option></select></label><label class="field"><span>测点数量（选填）</span><input id="visDraftCount" type="number" min="1" max="10000" step="1" placeholder="以真实检测文件为准"></label>
    <label class="field vis-device-wide"><span>共享路径 / 接入地址（选填）</span><input id="visDraftPath" maxlength="1024" placeholder="填写输出数据的共享路径，或留空待确认" autocomplete="off"><small>此处仅登记地址，不做连接测试。不要填写账号、密码或访问密钥。</small></label>
    <label class="field vis-device-wide"><span>零件型号（选填）</span><input id="visDraftParts" maxlength="1000" placeholder="多个型号用逗号分隔"></label><label class="field vis-device-wide"><span>备注（选填）</span><textarea id="visDraftNotes" rows="3" maxlength="1000" placeholder="如：样例是否已准备、计划部署位置、现场联系人"></textarea></label>
    <p id="visDraftMessage" class="vis-message vis-device-wide" role="status" hidden></p><div class="vis-device-form-actions vis-device-wide"><button id="visDeviceCancel" type="button" class="button">取消</button><button id="visSaveDevice" type="submit" class="button primary">保存为待配置</button></div>
  </form>`;
  document.body.append(deviceDialog);

  function pendingSelection() {
    const devices=state.fleet?.devices||[];
    if(state.filters.deviceId!=='all')return devices.find(device=>device.id===state.filters.deviceId)?.status==='pending';
    const lineDevices=devices.filter(device=>device.lineId===state.filters.lineId);
    return state.filters.lineId!=='all'&&lineDevices.length>0&&lineDevices.every(device=>device.status==='pending');
  }
  function renderFleet() {
    const fleet=state.fleet,devices=fleet?.devices||[],admin=state.status?.role==='admin';
    $('#visAddDevice').hidden=!admin;
    $('#visLineSelect').innerHTML='<option value="all">全部线体</option>'+(fleet?.lines||[]).map(line=>`<option value="${esc(line.id)}">${esc(line.name)}</option>`).join('');
    $('#visLineSelect').value=state.filters.lineId;
    const inLine=devices.filter(device=>state.filters.lineId==='all'||device.lineId===state.filters.lineId);
    $('#visDeviceSelect').innerHTML='<option value="all">全部检具</option>'+inLine.map(device=>`<option value="${esc(device.id)}">${esc(device.name)}${device.status==='pending'?'（待配置）':''}</option>`).join('');
    $('#visDeviceSelect').value=state.filters.deviceId;
    const configured=devices.filter(device=>device.status==='configured').length;
    $('#visFleetCount').textContent=fleet?`${fleet.lines.length} 条线体 · ${configured} 台已配置 · ${devices.length-configured} 台待配置`:state.catalogError?'台账暂未读取':state.status?.authenticated?'正在读取检具台账…':'登录后查看检具台账';
    message('#visCatalogError',state.catalogError);
    const statusFor=device=>{
      if(device.status==='pending')return {text:'待配置',tone:'pending',detail:'已登记资料，尚未接入检测数据'};
      const source=state.liveSource;
      if(source?.state==='ready')return {text:source.mode==='import'?'手动导入':'文件可读取',tone:'ready',detail:source.mode==='import'?'当前为已导入记录':'采集扫描：'+stamp(source.collectorCheckedAt)};
      if(source?.state==='waiting')return {text:'等待采集更新',tone:'waiting',detail:'最后扫描：'+stamp(source.collectorCheckedAt)};
      if(source?.state==='error'||source?.state==='missing')return {text:'需要检查',tone:'error',detail:'请查看下方数据来源提示'};
      return {text:'待读取状态',tone:'waiting',detail:'配置已登记，读取状态尚未确认'};
    };
    $('#visFleetCards').innerHTML=inLine.map(device=>{const status=statusFor(device);return `<article class="vis-device-card ${state.filters.deviceId===device.id?'selected':''}"><button type="button" class="vis-device-select" data-vis-device="${esc(device.id)}" aria-pressed="${state.filters.deviceId===device.id}"><span class="vis-device-card-top"><span class="vis-device-icon" aria-hidden="true">检</span><span class="vis-device-status ${status.tone}"><i aria-hidden="true"></i>${status.text}</span></span><strong>${esc(device.name)}</strong><span class="vis-device-meta">${esc(device.lineName)} · ${esc(device.id)}</span><span class="vis-device-parts">${esc(device.partNames?.length?device.partNames.join(' / '):'零件型号待确认')}</span><span class="vis-device-scan">${esc(status.detail)}</span></button><div class="vis-device-card-footer"><span>${device.transport==='upload'?'计划上传至服务器':'厂内共享文件'}${device.measurementCount?' · '+n(device.measurementCount)+' 测点':''}</span>${admin&&device.status==='pending'?`<button type="button" data-vis-edit-device="${esc(device.id)}">编辑资料</button>`:`<span>${device.status==='pending'?'待验收':'当前接入'}</span>`}</div></article>`;}).join('')+(fleet&&admin?'<button class="vis-device-add-card" type="button" data-vis-add><span aria-hidden="true">＋</span><strong>接入其他检具</strong><small>登记线体、设备与数据来源<br>保存后等待配置与验收</small></button>':'');
    const pending=pendingSelection()||Boolean(state.report?.scope?.pending);
    $('#visPendingNotice').hidden=!pending;
    $('#visPendingNotice').textContent=pending?'此范围的检具尚未接入。已保存登记资料，完成格式适配、连接与验收后才会出现真实检测记录。':'';
    $('#visImportPanel').hidden=!admin||pending;
    if(pending){$('#visImportPanel').open=false;for(const id of ['#visTotal','#visOK','#visNG','#visRate'])$(id).textContent='—';if(state.report?.scope?.pending)$('#visTable').textContent='该检具尚未接入，暂无检测记录。';}
  }
  async function loadCatalog() {
    if(!state.active||!state.status?.authenticated)return;
    const request=requestFor('catalogRequest');
    try {
      const fleet=await api('/local/vision/catalog',{signal:request.controller.signal});
      if(!isCurrent('catalogRequest',request))return;
      if(!Array.isArray(fleet.lines)||!Array.isArray(fleet.devices))throw new Error('检具台账格式无法读取。');
      state.fleet=fleet;state.catalogError='';
    } catch(error){if(isCurrent('catalogRequest',request)&&(error.name!=='AbortError'||request.timedOut))state.catalogError='检具台账读取失败，请刷新页面重试。';}
    finally {clearTimeout(request.timeout);if(isCurrent('catalogRequest',request)){state.catalogRequest=null;renderFleet();updateControls();}}
  }
  function chooseDevice(lineId,deviceId) {
    clearTimer();cancel('request');
    state.filters.lineId=lineId;state.filters.deviceId=deviceId;state.report=null;state.reportQuery=null;state.error='';state.trendDate=null;state.page=1;
    closeDetail();renderReport();applyFilters();
  }
  function draftLineChanged() {
    const isNew=$('#visDraftLine').value==='new';
    $('#visDraftLineNameField').hidden=!isNew;$('#visDraftLineName').required=isNew;$('#visDraftLineName').disabled=!isNew;
  }
  function closeDeviceDialog() {
    cancel('saveDeviceRequest');deviceDialog.close();$('#visDeviceForm').reset();$('#visDraftId').readOnly=false;message('#visDraftMessage','');$('#visSaveDevice').disabled=false;
  }
  function openDeviceDialog(deviceId) {
    if(!state.active||state.status?.role!=='admin'||!state.fleet)return;
    const device=state.fleet.devices.find(item=>item.id===deviceId);
    if(device&&device.status!=='pending')return;
    $('#visDeviceForm').reset();message('#visDraftMessage','');$('#visSaveDevice').disabled=false;
    $('#visDeviceDialogTitle').textContent=device?'编辑待配置检具':'登记新检具';
    $('#visDraftLine').innerHTML=state.fleet.lines.map(line=>`<option value="${esc(line.id)}">${esc(line.name)}</option>`).join('')+'<option value="new">＋ 新增线体</option>';
    $('#visDraftLine').value=device?.lineId||(state.filters.lineId!=='all'?state.filters.lineId:'new');draftLineChanged();
    let number=2;while(state.fleet.devices.some(item=>item.id==='vision-'+String(number).padStart(2,'0')))number++;
    $('#visDraftId').value=device?.id||'vision-'+String(number).padStart(2,'0');$('#visDraftId').readOnly=Boolean(device);
    $('#visDraftName').value=device?.name||'';$('#visDraftTransport').value=device?.transport||'share';$('#visDraftPath').value=device?.sourcePath||'';$('#visDraftParts').value=device?.partNames?.join(', ')||'';$('#visDraftCount').value=device?.measurementCount||'';$('#visDraftNotes').value=device?.notes||'';
    deviceDialog.showModal();
  }
  async function saveDevice(event) {
    event.preventDefault();if(!state.active||state.status?.role!=='admin'||state.saveDeviceRequest||!$('#visDeviceForm').reportValidity())return;
    const line=$('#visDraftLine').value,count=$('#visDraftCount').value;
    const input={deviceId:$('#visDraftId').value.trim(),name:$('#visDraftName').value.trim(),...(line==='new'?{lineName:$('#visDraftLineName').value.trim()}:{lineId:line}),transport:$('#visDraftTransport').value,sourcePath:$('#visDraftPath').value.trim(),partNames:$('#visDraftParts').value.split(/[,，;；\n]/).map(value=>value.trim()).filter(Boolean),measurementCount:count?Number(count):null,notes:$('#visDraftNotes').value.trim()};
    const request=requestFor('saveDeviceRequest');$('#visSaveDevice').disabled=true;message('#visDraftMessage','正在保存登记资料…');
    try {
      const result=await api('/local/vision/catalog',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal:request.controller.signal});
      if(!isCurrent('saveDeviceRequest',request))return;
      await loadCatalog();if(!isCurrent('saveDeviceRequest',request))return;
      const device=state.fleet?.devices.find(item=>item.id===(result.device?.id||input.deviceId));
      if(!device)throw new Error('登记已提交，但台账未刷新。请关闭窗口并刷新页面核对。');
      closeDeviceDialog();chooseDevice(device.lineId,device.id);
    } catch(error){if(isCurrent('saveDeviceRequest',request)&&(error.name!=='AbortError'||request.timedOut))message('#visDraftMessage',request.timedOut?'登记结果尚未确认，请刷新台账核对后再操作。':String(error.message||'登记未完成。').slice(0,300),'error');}
    finally {clearTimeout(request.timeout);if(isCurrent('saveDeviceRequest',request)){state.saveDeviceRequest=null;$('#visSaveDevice').disabled=false;}}
  }

  function message(selector,text,tone='info') { const el=$(selector);el.textContent=text;el.className='vis-message '+tone;el.hidden=!text; }
  function clearTimer() { clearTimeout(state.timer);state.timer=null; }
  function cancel(name) { const request=state[name];state[name]=null;if(request){clearTimeout(request.timeout);request.controller.abort();} }
  function closeDetail() { cancel('detailRequest');dialog.close();$('#visDetailBody').replaceChildren(); }
  function active() { return state.active && state.status?.authenticated && !document.hidden; }
  function schedule() { clearTimer();if(active()&&!state.request)state.timer=setTimeout(()=>loadReport('poll'),30000); }
  function requestFor(name) { cancel(name);const request={controller:new AbortController(),epoch:state.epoch,timedOut:false};request.timeout=setTimeout(()=>{request.timedOut=true;request.controller.abort();},30000);state[name]=request;return request; }
  function isCurrent(name,request) { return state[name]===request && request.epoch===state.epoch && state.status?.authenticated; }
  async function api(path,options={}) {
    const response=await fetch(path,{credentials:'same-origin',cache:'no-store',...options});
    let body;try { body=await response.json(); } catch (_) { const error=new Error('门户返回内容无法读取，请稍后刷新。');error.status=response.status;if(response.status===401&&!options.signal?.aborted)document.dispatchEvent(new CustomEvent('portal:session-expired'));throw error; }
    if(!response.ok) { const error=new Error(body.message||body.error||'读取未完成，请稍后重试。');error.status=response.status;if(response.status===401&&!options.signal?.aborted)document.dispatchEvent(new CustomEvent('portal:session-expired'));throw error; }
    return body;
  }
  function setContext(status,selected) {
    const oldActive=state.active,account=status?.authenticated?status.account:null,accountChanged=account!==state.account;
    if(!status?.authenticated || accountChanged)resetPrivateState();
    state.status=status;state.account=account;state.active=Boolean(selected&&status?.authenticated);root.hidden=!state.active;
    $('#visImportPanel').hidden=status?.role!=='admin'||Boolean(state.report?.scope?.pending);$('#visAddDevice').hidden=status?.role!=='admin';
    if(status?.role!=='admin'){closeDeviceDialog();$('#visImportPanel').open=false;cancel('importRequest');$('#visFile').value='';message('#visImportMessage','');}
    if(!state.active){clearTimer();cancel('request');cancel('catalogRequest');closeDeviceDialog();closeDetail();if(oldActive){state.epoch++;if(state.importRequest)message('#visImportMessage','上次导入的提交结果尚未确认，请刷新检测记录核实。','warning');cancel('importRequest');}}else if(!oldActive||accountChanged){loadCatalog();loadReport('route');}
    renderFleet();updateControls();
  }
  function resetPrivateState() {
    state.epoch++;clearTimer();cancel('request');cancel('detailRequest');cancel('importRequest');state.report=null;state.reportQuery=null;state.trendDate=null;state.error='';state.lastRead=null;state.page=1;state.filters=emptyFilters();state.fleet=null;state.liveSource=null;state.catalogError='';cancel('catalogRequest');closeDeviceDialog();
    $('#visTrendData').open=false;
    $('#visQueryForm').reset();$('#visInterval').value='auto';$('#visRecentCustom').hidden=true;$('#visRecentCount').disabled=true;$('#visImportForm').reset();$('#visImportPanel').open=false;message('#visImportMessage','');closeDetail();renderReport();
  }
  function updateControls() {
    $('#visRefresh').disabled=!state.active||Boolean(state.request);$('#visRefresh').textContent=state.request?'正在读取…':'刷新数据';
    $('#visImportButton').disabled=!state.active||state.status?.role!=='admin'||Boolean(state.importRequest);$('#visImportButton').textContent=state.importRequest?'正在导入…':'导入记录';
    const total=Number(state.report?.total)||0,page=Number(state.report?.page)||1,size=Number(state.report?.pageSize)||state.size;
    $('#visPrev').disabled=!state.active||Boolean(state.request)||page<=1;$('#visNext').disabled=!state.active||Boolean(state.request)||page*size>=total;
    $('#visPolling').textContent=document.hidden?'页面不可见，刷新已暂停':state.request?'正在刷新检测记录…':'打开此页时每 30 秒刷新';
    root.setAttribute('aria-busy',String(Boolean(state.request)));
    for(const id of ['#visLineSelect','#visDeviceSelect'])$(id).disabled=!state.active||!state.fleet||Boolean(state.request);
    $('#visAddDevice').disabled=!state.active||!state.fleet;
    updatePeriodChoices();
  }
  function periodDates(period) {
    if(period==='all')return {start:'',end:''};
    const now=new Date(),days={today:1,week:7,month:30}[period];
    const localDay=date=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
    return {start:localDay(new Date(now.getFullYear(),now.getMonth(),now.getDate()-days+1,12))+'T00:00',end:localDay(now)+'T23:59'};
  }
  function updatePeriodChoices() {
    for(const button of $('#visPeriodChoices').querySelectorAll('[data-vis-period]')){
      const dates=periodDates(button.dataset.visPeriod);
      button.setAttribute('aria-pressed',String(state.filters.start===dates.start&&state.filters.end===dates.end));
      button.disabled=!state.active;
    }
  }
  function renderSource() {
    const source=state.report?.source;
    const missingFile=source?.state==='missing'&&Boolean(source.collectorCheckedAt||source.updatedAt||state.report?.total);
    const isStale=Boolean(state.error||source?.state==='error'||missingFile),waiting=source?.state==='waiting';
    $('#visSource').className='vis-source '+(isStale?'warning':waiting?'waiting':source?.state==='ready'?'ready':'');
    $('#visSourceTitle').textContent=state.error?'检测数据读取异常':source?.state==='error'?'采集数据需要检查':missingFile?'采集文件暂时无法读取':source?.state==='pending'?'该检具尚未接入':waiting?'共享可读取，等待采集更新':source?.state==='ready'?(source.mode==='import'?'已导入检测文件':'检测数据可读取'):source?.state==='missing'?'等待接入检测数据':'等待读取检测数据';
    $('#visSourceMessage').textContent=state.error?(state.report?'当前保留上次成功读取的数据，可能不是最新结果。':'本次未能读取检测记录，请刷新重试。'):source?.message||'登录后读取已接入的检测记录。';
    const times=[];if(source?.mode==='file')times.push('采集端最后扫描：'+(source.collectorCheckedAt?stamp(source.collectorCheckedAt):'未提供'));if(source?.checkedAt)times.push('门户查询：'+stamp(source.checkedAt));else if(state.lastRead)times.push('门户读取：'+new Date(state.lastRead).toLocaleTimeString('zh-CN',{hour12:false}));if(source?.updatedAt)times.push('门户最近入库：'+stamp(source.updatedAt));$('#visSourceTime').textContent=times.join(' · ');
    root.classList.toggle('vis-stale',isStale);
  }
  function renderReport() {
    const report=state.report,summary=report?.summary;
    $('#visTotal').textContent=n(summary?.totalRecords);$('#visOK').textContent=n(summary?.okRecords);$('#visNG').textContent=n(summary?.ngRecords);$('#visRate').textContent=typeof summary?.passRate==='number'&&Number.isFinite(summary.passRate)?(summary.passRate*100).toFixed(1)+'%':'—';
    const conflicts=Number(summary?.conflictRecords)||0;message('#visConflictNote',conflicts?`${n(conflicts)} 条记录存在版本冲突，已保留供核查，但不纳入 OK、NG 和合格率。可统计 ${n(summary.eligibleRecords)} 条。`:'','warning');
    const q=state.reportQuery;$('#visScope').textContent=q?`${stamp(q.start||'最早记录')} 至 ${stamp(q.end||'最新记录')} · ${q.part==='all'?'普通 Front11 / Front12':q.part} · ${q.result==='all'?'全部结果':q.result}${q.search?' · 关键词包含 '+q.search:''}${q.recentLimit!=='all'?' · 最近 '+q.recentLimit+' 条检测':''}`:'尚未读取记录。';
    const selection=report?.selection;
    $('#visSelectionNote').textContent=selection?.recentLimit?`符合条件 ${n(selection.matchedRecords)} 条，取最新 ${n(selection.selectedRecords)} 条参与统计。重复检测按多条计数。`:'在当前条件下按检测时间取最新记录，重复检测按多条计数。';
    const records=report?.records||[];$('#visTable').className=records.length?'vis-table-wrap':'vis-empty';
    $('#visTable').innerHTML=records.length?`<table><thead><tr><th scope="col">零件 SN</th><th scope="col">检测时间</th><th scope="col">型号</th><th scope="col">检具</th><th scope="col">整体结论</th><th scope="col">测点</th><th scope="col">查看</th></tr></thead><tbody>${records.map(record=>`<tr class="${record.identityConflict?'vis-conflict-row':''}"><td class="vis-sn">${esc(record.serialNumber)}${record.identityConflict?'<small class="vis-conflict-label">版本冲突 · 未参与统计</small>':''}</td><td class="vis-nowrap">${esc(stamp(record.measuredAt))}</td><td>${esc(record.partName)}</td><td>${esc(record.deviceId)}</td><td>${resultBadge(record.sourceResult)}</td><td>${n(record.itemCount)}</td><td><button class="vis-detail-button" type="button" data-vision-detail="${esc(record.id)}" aria-label="查看 ${esc(record.serialNumber)} 的测点详情">测点详情 <span aria-hidden="true">→</span></button></td></tr>`).join('')}</tbody></table>`:report?(report.source?.state==='missing'?'尚未接入检测数据。管理员可以先导入一份普通检测 CSV。':'当前条件下没有检测记录。'):'等待读取检测记录。';
    if(records.length){$('#visTable').tabIndex=0;$('#visTable').setAttribute('aria-label','检测记录，可横向滚动');}else{$('#visTable').removeAttribute('tabindex');$('#visTable').removeAttribute('aria-label');}
    const pages=report?Math.max(1,Math.ceil(report.total/report.pageSize)):0;$('#visPageNumber').textContent=report?`${report.page} / ${pages} 页 · ${n(report.total)} 条`:'—';
    message('#visError',state.error);renderSource();renderTrend();renderFleet();updateControls();
  }
  const trendRate = value => typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;
  const trendPercent = value => trendRate(value)?(value*100).toFixed(1)+'%':'—';
  const trendStamp = value => value.replace('T',' ');
  const intervalLabels = {'5m':'5 分钟','15m':'15 分钟','30m':'30 分钟',hour:'1 小时',day:'1 天'};
  function trendView() {
    const trend=state.report?.trend,raw=trend?.points;
    return {interval:trend?.interval||'day',minutes:trend?.bucketMinutes||1440,available:Array.isArray(raw),points:Array.isArray(raw)?raw.map(point=>({...point,date:point.period})):[]};
  }
  function trendRange(date,minutes) {
    if(date.length===10)return date;
    const end=new Date(Date.parse(date+':00Z')+(minutes-1)*60000).toISOString().slice(0,16);
    return trendStamp(date)+' – '+(date.slice(0,10)===end.slice(0,10)?end.slice(11):trendStamp(end));
  }
  function hideTrendTooltip() { if(trendCache?.tooltip)trendCache.tooltip.hidden=true; }
  function selectTrendDate(date,showTooltip=false) {
    const cache=trendCache,point=cache?.byDate.get(date);
    if(!point)return;
    if(cache.selected!==point){
      if(cache.selected?.node){cache.selected.node.setAttribute('aria-pressed','false');cache.selected.node.setAttribute('tabindex','-1');}
      cache.selected=point;state.trendDate=date;
      point.node.setAttribute('aria-pressed','true');point.node.setAttribute('tabindex','0');
      const range=trendRange(date,cache.minutes);
      $('#visTrendDetail').innerHTML=`<span class="vis-trend-date">${esc(range)}</span><strong>${trendPercent(point.passRate)}</strong><span>合格 <b>${n(point.okRecords)}</b> / 可统计 <b>${n(point.eligibleRecords)}</b> 次</span><span>不合格 <b>${n(point.ngRecords)}</b> 次${point.conflictRecords?' · 冲突 '+n(point.conflictRecords)+' 条未计入':''}</span>`;
      cache.tooltip.innerHTML=`<span class="vis-tooltip-date">${esc(range)}</span><strong>${trendPercent(point.passRate)}<small>合格率</small></strong><div><span>合格 OK</span><b>${n(point.okRecords)} 次</b></div><div><span>不合格 NG</span><b>${n(point.ngRecords)} 次</b></div><div><span>可统计检测</span><b>${n(point.eligibleRecords)} 次</b></div>${point.conflictRecords?`<p>冲突 ${n(point.conflictRecords)} 条未计入</p>`:''}`;
      cache.crosshair.setAttribute('x1',point.x);cache.crosshair.setAttribute('x2',point.x);
      cache.selection.setAttribute('cx',point.x);cache.selection.setAttribute('cy',point.y);
      cache.tooltipPoint=null;
    }
    if(showTooltip){
      cache.tooltip.hidden=false;
      if(cache.tooltipPoint!==point){
        const tooltipWidth=cache.tooltip.offsetWidth,tooltipHeight=cache.tooltip.offsetHeight;
        cache.tooltip.style.left=Math.max(8,Math.min(cache.width-tooltipWidth-8,point.x+(point.x>cache.width/2?-tooltipWidth-16:16)))+'px';
        cache.tooltip.style.top=Math.max(8,Math.min(cache.height-tooltipHeight-8,point.y-tooltipHeight/2))+'px';
        cache.tooltipPoint=point;
      }
    }
  }
  function trackTrendPointer(event) {
    const cache=trendCache;if(!cache)return;
    const rect=cache.svg.getBoundingClientRect(),x=(event.clientX-rect.left)*cache.width/rect.width,y=(event.clientY-rect.top)*cache.height/rect.height;
    if(x<cache.left||x>cache.width-cache.right||y<cache.top-12||y>cache.bottom+8){hideTrendTooltip();return;}
    // Points are ordered once at render time; movement only updates the chosen point.
    let low=0,high=cache.valid.length-1;
    while(low<high){const mid=Math.floor((low+high)/2);if(cache.valid[mid].x<x)low=mid+1;else high=mid;}
    const next=cache.valid[low],previous=cache.valid[Math.max(0,low-1)];
    selectTrendDate(Math.abs(previous.x-x)<=Math.abs(next.x-x)?previous.date:next.date,true);
  }
  function renderTrendTable() {
    if(!$('#visTrendData').open||!trendTableCache||trendTableCache.rendered)return;
    const {points,minutes,period}=trendTableCache;
    $('#visTrendTable').innerHTML=`<table><thead><tr><th scope="col">检测${period}</th><th scope="col">合格率</th><th scope="col">合格 OK</th><th scope="col">不合格 NG</th><th scope="col">可统计次数</th><th scope="col">冲突记录</th></tr></thead><tbody>${points.map(point=>`<tr><td class="vis-nowrap">${esc(trendRange(point.date,minutes))}</td><td>${trendPercent(point.passRate)}</td><td>${n(point.okRecords)}</td><td>${n(point.ngRecords)}</td><td>${n(point.eligibleRecords)}</td><td>${n(point.conflictRecords)}</td></tr>`).join('')}</tbody></table>`;
    trendTableCache.rendered=true;
  }
  function renderTrend() {
    const chart=$('#visTrendChart'),empty=$('#visTrendEmpty'),hint=$('#visTrendHint'),detail=$('#visTrendDetail'),data=$('#visTrendData');
    const {interval,minutes,available,points}=trendView(),intraday=minutes<1440,unit=intervalLabels[interval],period=intraday?'时段':'日期';
    trendCache=null;trendTableCache=null;
    $('#visTrendLegend').textContent=intraday?'每 '+unit+' 合格率':'每日合格率';
    $('#visTrendSubtitle').textContent=state.report?`每 ${unit} 一个点 · ${n(points.length)} 个有记录的${period} · 移动鼠标查看明细`:'查看每个时间段的检测表现';
    data.querySelector('summary').textContent=intraday?'查看分时数据':'查看每日数据';
    $('#visTrendTable').setAttribute('aria-label','分段合格率数据，可横向滚动');
    chart.replaceChildren();detail.replaceChildren();$('#visTrendTable').replaceChildren();chart.hidden=true;detail.hidden=true;hint.hidden=true;data.hidden=!points.length;empty.hidden=false;
    if(!points.length){state.trendDate=null;data.open=false;empty.textContent=!state.report?'等待读取合格率趋势。':!available?'趋势数据暂未提供，请稍后刷新。':state.report?.scope?.pending?'检具尚未接入，完成配置后显示真实曲线。':'当前筛选条件下没有检测记录。';return;}
    trendTableCache={points,minutes,period,rendered:false};renderTrendTable();
    const valid=points.filter(point=>trendRate(point.passRate));
    if(!valid.length){state.trendDate=null;empty.textContent='当前记录均存在冲突，暂无可计算的合格率。';return;}
    chart.hidden=false;empty.hidden=true;detail.hidden=false;hint.hidden=false;
    // Treat original local timestamps as a uniform axis, without timezone conversion.
    const step=minutes*60000,dateMs=date=>Date.parse(date+(date.length===10?'T00:00:00Z':':00Z'));
    const first=dateMs(points[0].date),last=dateMs(points.at(-1).date),span=last-first;
    const width=Math.max(260,Math.round(chart.clientWidth||800)),height=320,left=46,right=24,top=24,bottom=266,plot=width-left-right;
    const x=date=>span?left+(dateMs(date)-first)/span*plot:left+plot/2,y=rate=>bottom-rate*(bottom-top),xy=point=>`${x(point.date).toFixed(2)},${y(point.passRate).toFixed(2)}`;
    const grid=Array.from({length:11},(_,i)=>{const rate=i/10;return `<line x1="${left}" x2="${width-right}" y1="${y(rate)}" y2="${y(rate)}" class="vis-trend-grid ${i%2===0?'major':''}"/><text x="${left-10}" y="${y(rate)+4}" text-anchor="end" class="vis-trend-label">${i*10}%</text>`;}).join('');
    const tickCount=span?Math.min(Math.round(span/step)+1,Math.max(2,Math.min(9,Math.floor(plot/110)+1))):1;
    const tickDates=Array.from({length:tickCount},(_,i)=>new Date(first+(tickCount===1?0:Math.round(span/step*i/(tickCount-1))*step)).toISOString().slice(0,intraday?16:10));
    const sameDay=points[0].date.slice(0,10)===points.at(-1).date.slice(0,10);
    const labels=tickDates.map(date=>`<text x="${x(date)}" y="${bottom+25}" text-anchor="middle" class="vis-trend-label">${esc(intraday?date.slice(11):date.slice(5).replace('-','/'))}${intraday&&!sameDay?`<tspan x="${x(date)}" dy="17">${date.slice(5,10).replace('-','/')}</tspan>`:''}</text>`).join('');
    const runs=[];let run=[];
    for(const point of points){if(!trendRate(point.passRate)){if(run.length)runs.push(run);run=[];continue;}if(run.length&&dateMs(point.date)-dateMs(run.at(-1).date)!==step){runs.push(run);run=[];}run.push(point);}if(run.length)runs.push(run);
    const lines=runs.filter(segment=>segment.length>1).map(segment=>{const line='M'+segment.map(xy).join(' L');return `<path class="vis-trend-area" d="${line} L${x(segment.at(-1).date)},${bottom} L${x(segment[0].date)},${bottom} Z"/><path class="vis-trend-line" data-vis-trend-segment d="${line}"/>`;}).join('');
    const dots=valid.map(point=>{const label=`${trendRange(point.date,minutes)}，合格率 ${trendPercent(point.passRate)}，合格 ${n(point.okRecords)} 次，可统计 ${n(point.eligibleRecords)} 次`;return `<g class="vis-trend-point" data-vis-trend-date="${esc(point.date)}" tabindex="-1" role="button" aria-label="${esc(label)}" aria-pressed="false"><circle class="vis-trend-hit" cx="${x(point.date)}" cy="${y(point.passRate)}" r="10"/><circle class="vis-trend-dot" cx="${x(point.date)}" cy="${y(point.passRate)}" r="${valid.length>120?2:3.5}"/></g>`;}).join('');
    chart.innerHTML=`<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="group" aria-labelledby="visTrendSvgTitle visTrendSvgDesc"><title id="visTrendSvgTitle">每 ${unit} 检测合格率曲线</title><desc id="visTrendSvgDesc">${esc(trendStamp(points[0].date))} 至 ${esc(trendStamp(points.at(-1).date))}，纵轴为 0% 至 100%。移动鼠标查看，或聚焦数据点后按左右方向键切换。完整数据见下方数据表。</desc><defs><linearGradient id="visTrendFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#3578d4" stop-opacity=".15"/><stop offset="100%" stop-color="#3578d4" stop-opacity=".01"/></linearGradient></defs>${grid}${lines}${labels}<line id="visTrendCrosshair" x1="0" x2="0" y1="${top}" y2="${bottom}" class="vis-trend-crosshair"/>${dots}<circle id="visTrendSelection" r="5.5" class="vis-trend-selection"/></svg><div id="visTrendTooltip" class="vis-trend-tooltip" role="tooltip" hidden></div>`;
    const nodes=chart.querySelectorAll('[data-vis-trend-date]');
    valid.forEach((point,i)=>{point.x=x(point.date);point.y=y(point.passRate);point.node=nodes[i];});
    trendCache={valid,byDate:new Map(valid.map(point=>[point.date,point])),selected:null,width,height,left,right,top,bottom,minutes,svg:chart.querySelector('svg'),tooltip:$('#visTrendTooltip'),crosshair:$('#visTrendCrosshair'),selection:$('#visTrendSelection')};
    hint.textContent='合格率 = 该时段 OK / 可统计次数；冲突记录不计入，无记录时不连线。筛选起止时间或最近数量可能只覆盖首尾时段的一部分。'+(valid.some(point=>point.eligibleRecords<10)?' 部分时段不足 10 次检测，请结合次数看波动。':'')+(state.reportQuery?.result!=='all'?' 当前已按检测结论筛选。':'');
    selectTrendDate(trendCache.byDate.has(state.trendDate)?state.trendDate:valid.at(-1).date);
  }
  async function loadReport(reason='manual') {
    if(!active())return;if(reason==='poll'&&state.request)return;clearTimer();const request=requestFor('request'),query={...state.filters,page:state.page,pageSize:state.size};updateControls();
    try {
      const report=await api('/local/vision/report?'+new URLSearchParams(query),{signal:request.controller.signal});
      if(!isCurrent('request',request))return;
      if(!report||!Array.isArray(report.records)||!report.summary||!report.source)throw new Error('检测数据格式不符合约定，已保留上次成功结果。');
      state.report=report;if(report.source.state!=='pending')state.liveSource=report.source;state.reportQuery=query;state.page=Number(report.page)||1;state.lastRead=Date.now();state.error='';
    } catch(error) {
      if(!isCurrent('request',request))return;if(error.name==='AbortError'&&!request.timedOut)return;
      state.error=request.timedOut?'读取检测数据超时，请稍后重试。':String(error.message||'检测数据读取失败。').slice(0,350);
    } finally {
      clearTimeout(request.timeout);if(isCurrent('request',request)){state.request=null;renderReport();schedule();}
    }
  }
  function applyFilters() {
    const start=$('#visStart').value,end=$('#visEnd').value;
    if(!$('#visQueryForm').reportValidity())return;
    if(start&&end&&start>end){message('#visError','开始时间不能晚于结束时间。');return;}
    const choice=$('#visRecentLimit').value,recentLimit=choice==='custom'?$('#visRecentCount').value:choice;
    if(recentLimit!=='all'&&(!/^\d+$/.test(recentLimit)||Number(recentLimit)<1||Number(recentLimit)>20000)){message('#visError','最近检测数量请输入 1 至 20000 的整数。');return;}
    state.filters={start,end,part:$('#visPart').value,result:$('#visResult').value,search:$('#visSearch').value.trim(),interval:$('#visInterval').value,recentLimit,lineId:state.filters.lineId,deviceId:state.filters.deviceId};state.page=1;closeDetail();loadReport('filter');
  }
  async function openDetail(id) {
    if(!state.active||!state.status?.authenticated)return;const request=requestFor('detailRequest');$('#visDetailBody').innerHTML='<p class="vis-empty">正在读取测点明细…</p>';if(!dialog.open)dialog.showModal();
    try {
      const record=await api('/local/vision/records/'+encodeURIComponent(id),{signal:request.controller.signal});if(!isCurrent('detailRequest',request))return;
      if(!Array.isArray(record.measurements))throw new Error('测点明细格式无法读取。');
      const ng=record.measurements.filter(item=>item.sourceResult==='NG').length;
      $('#visDetailBody').innerHTML=`<div class="vis-detail-summary"><div><span>零件 SN</span><strong>${esc(record.serialNumber)}</strong></div><div><span>检测时间</span><strong>${esc(stamp(record.measuredAt))}</strong></div><div><span>型号 / 检具</span><strong>${esc(record.partName)} / ${esc(record.deviceId)}</strong></div><div><span>整体结论</span>${resultBadge(record.sourceResult)}</div></div>${record.identityConflict?'<p class="vis-message warning">同一检测存在不同版本，此记录暂不参与合格率统计。</p>':''}<div class="vis-detail-caption"><strong>${n(record.measurements.length)} 项测量 · ${n(ng)} 项 NG</strong><p>整体与逐项结论均保留检具原始结果。显示原始偏差 Dev；文件未说明单位，不推算绝对尺寸。</p></div>${record.warnings?.length?`<details class="vis-detail-warnings"><summary>数据说明（${n(record.warnings.length)} 项）</summary><ul>${record.warnings.map(warning=>`<li>${esc(typeof warning==='string'?warning:warning.message||JSON.stringify(warning))}</li>`).join('')}</ul></details>`:''}<div class="vis-table-wrap" tabindex="0" aria-label="测点明细，可横向滚动"><table><thead><tr><th scope="col">测点名称</th><th scope="col">关键点</th><th scope="col">名义值</th><th scope="col">下限</th><th scope="col">上限</th><th scope="col">偏差 Dev</th><th scope="col">结论</th></tr></thead><tbody>${record.measurements.map(item=>`<tr class="${item.sourceResult==='NG'?'vis-point-ng':''}"><td>${esc(item.name)}</td><td>${item.isCritical?'<span class="vis-critical">关键</span>':'非关键'}</td><td>${measureNumber(item.nominal)}</td><td>${measureNumber(item.lowerLimit)}</td><td>${measureNumber(item.upperLimit)}</td><td class="vis-dev">${esc(item.deviationRaw??(item.deviation===null?'未取得':item.deviation))}</td><td>${resultBadge(item.sourceResult)}</td></tr>`).join('')}</tbody></table></div>`;
    } catch(error) { if(isCurrent('detailRequest',request)&&(error.name!=='AbortError'||request.timedOut))$('#visDetailBody').innerHTML=`<p class="vis-message error">${esc(request.timedOut?'读取明细超时，请关闭后重试。':error.message||'读取详情失败。')}</p>`; }
    finally {clearTimeout(request.timeout);if(isCurrent('detailRequest',request))state.detailRequest=null;}
  }
  async function importFile(event) {
    event.preventDefault();if(!state.active||state.status?.role!=='admin'||state.importRequest)return;
    const file=$('#visFile').files[0],deviceId=$('#visDevice').value.trim();
    if(!deviceId||!file||!/^Tesla_Front(?:11|12)_\d{8}-\d{6}\.csv$/i.test(file.name)||file.size<=0||file.size>1024*1024){message('#visImportMessage','请填写检具标识，并选择普通 Front11 / Front12 的非空 CSV 文件（不超过 1 MB）。ALLmeasure 全检文件不导入。','error');return;}
    const request=requestFor('importRequest');message('#visImportMessage','正在读取并导入所选检测文件…');updateControls();
    try {
      const content=await file.text();if(!isCurrent('importRequest',request))return;
      const result=await api('/local/vision/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:file.name,content,deviceId}),signal:request.controller.signal});if(!isCurrent('importRequest',request))return;
      const details=`新增 ${n(result.imported)} 条，重复 ${n(result.duplicates)} 条，冲突 ${n(result.conflicts)} 条。`;
      message('#visImportMessage',(result.message?result.message+' ':'')+details,result.conflicts?'warning':'success');$('#visFile').value='';state.page=1;await loadReport('import');
    } catch(error) {if(isCurrent('importRequest',request)&&(error.name!=='AbortError'||request.timedOut))message('#visImportMessage',request.timedOut?'导入请求超时，结果尚未确认。请刷新记录核实；重复导入同一文件不会增加检测次数。':String(error.message||'导入结果尚未确认，请刷新记录核实。').slice(0,350),'error');}
    finally {clearTimeout(request.timeout);if(isCurrent('importRequest',request)){state.importRequest=null;updateControls();}}
  }
  $('#visLineSelect').addEventListener('change',()=>chooseDevice($('#visLineSelect').value,'all'));
  $('#visDeviceSelect').addEventListener('change',()=>chooseDevice(state.filters.lineId,$('#visDeviceSelect').value));
  $('#visAddDevice').addEventListener('click',()=>openDeviceDialog());
  $('#visFleetCards').addEventListener('click',event=>{
    const edit=event.target.closest('[data-vis-edit-device]'),select=event.target.closest('[data-vis-device]');
    if(edit){openDeviceDialog(edit.dataset.visEditDevice);return;}
    if(event.target.closest('[data-vis-add]')){openDeviceDialog();return;}
    if(select){const device=state.fleet?.devices.find(item=>item.id===select.dataset.visDevice);if(device)chooseDevice(device.lineId,device.id);}
  });
  $('#visDraftLine').addEventListener('change',draftLineChanged);
  $('#visDeviceForm').addEventListener('submit',saveDevice);
  $('#visDeviceClose').addEventListener('click',closeDeviceDialog);$('#visDeviceCancel').addEventListener('click',closeDeviceDialog);
  deviceDialog.addEventListener('cancel',event=>{event.preventDefault();closeDeviceDialog();});
  $('#visQueryForm').addEventListener('submit',event=>{event.preventDefault();applyFilters();});
  $('#visPeriodChoices').addEventListener('click',event=>{const button=event.target.closest('[data-vis-period]');if(!button||button.disabled)return;const dates=periodDates(button.dataset.visPeriod);$('#visStart').value=dates.start;$('#visEnd').value=dates.end;applyFilters();});
  $('#visReset').addEventListener('click',()=>{$('#visQueryForm').reset();$('#visInterval').value='auto';$('#visRecentCustom').hidden=true;$('#visRecentCount').disabled=true;applyFilters();});$('#visRefresh').addEventListener('click',()=>loadReport());
  $('#visInterval').addEventListener('change',applyFilters);
  $('#visRecentLimit').addEventListener('change',()=>{const custom=$('#visRecentLimit').value==='custom';$('#visRecentCustom').hidden=!custom;$('#visRecentCount').disabled=!custom;if(custom)$('#visRecentCount').focus();else applyFilters();});
  $('#visRecentCount').addEventListener('change',applyFilters);
  $('#visPageSize').addEventListener('change',()=>{state.size=Number($('#visPageSize').value);state.page=1;loadReport('page');});
  $('#visPrev').addEventListener('click',()=>{state.page=Math.max(1,(Number(state.report?.page)||1)-1);loadReport('page');});$('#visNext').addEventListener('click',()=>{state.page=(Number(state.report?.page)||1)+1;loadReport('page');});
  $('#visTable').addEventListener('click',event=>{const button=event.target.closest('[data-vision-detail]');if(button)openDetail(button.dataset.visionDetail);});
  $('#visTrendData').addEventListener('toggle',renderTrendTable);
  $('#visTrendChart').addEventListener('pointermove',trackTrendPointer);
  $('#visTrendChart').addEventListener('pointerleave',hideTrendTooltip);
  $('#visTrendChart').addEventListener('pointercancel',hideTrendTooltip);
  for(const type of ['click','focusin'])$('#visTrendChart').addEventListener(type,event=>{const point=event.target.closest('[data-vis-trend-date]');if(point)selectTrendDate(point.dataset.visTrendDate,true);else if(type==='click')trackTrendPointer(event);});
  $('#visTrendChart').addEventListener('focusout',event=>{if(!event.currentTarget.contains(event.relatedTarget))hideTrendTooltip();});
  $('#visTrendChart').addEventListener('keydown',event=>{
    const point=event.target.closest('[data-vis-trend-date]'),cache=trendCache;
    if(!point||!cache)return;
    if(['Enter',' '].includes(event.key)){event.preventDefault();selectTrendDate(point.dataset.visTrendDate,true);return;}
    if(event.key==='Escape'){hideTrendTooltip();return;}
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();const index=cache.valid.indexOf(cache.byDate.get(point.dataset.visTrendDate));
    const next=event.key==='Home'?0:event.key==='End'?cache.valid.length-1:Math.max(0,Math.min(cache.valid.length-1,index+(event.key==='ArrowRight'?1:-1)));
    cache.valid[next].node.focus();
  });
  let trendWidth=0,trendResizeFrame=null;
  const trendResize=new ResizeObserver(entries=>{const width=Math.round(entries[0].contentRect.width);if(width>0&&width!==trendWidth){trendWidth=width;cancelAnimationFrame(trendResizeFrame);trendResizeFrame=requestAnimationFrame(()=>{if(state.report)renderTrend();});}});
  trendResize.observe($('#visTrendChart'));
  $('#visCloseDetail').addEventListener('click',closeDetail);dialog.addEventListener('cancel',event=>{event.preventDefault();closeDetail();});
  dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)closeDetail();}});
  $('#visImportForm').addEventListener('submit',importFile);
  document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimer();cancel('request');updateControls();}else if(state.active)loadReport('visible');});
  window.addEventListener('pagehide',()=>{clearTimer();cancel('request');cancel('detailRequest');cancel('importRequest');cancel('catalogRequest');cancel('saveDeviceRequest');});
  window.VisionWorkbench={setContext,refresh:()=>loadReport()};
})();
