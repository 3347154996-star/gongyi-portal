(() => {
  'use strict';
  const root = document.getElementById('penetrationWorkbench');
  if (!root) return;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"'\r\n\t]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','\r':'&#13;','\n':'&#10;','\t':'&#9;'}[char]));
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const alias = value => typeof value === 'string' && /^P-[A-Z0-9-]{1,64}$/.test(value);
  const productText = value => typeof value === 'string' && value.length > 0 && value.length <= 2000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
  const validProduct = (value,mode) => mode === 'original' ? productText(value) : alias(value);
  const labels = {all:'全部类别',full:'全切异常反馈',bracket:'快切支架'};
  const diagnosticLabels = {files:'发现来源文件',read:'本次读取文件',reused:'复用未变文件',failed:'读取失败项',skipped:'跳过项',staleFiles:'旧规则缓存待重读（未计入）',incompleteGroups:'不完整月份/类别',outOfScopeRecords:'排除非统计类别记录',duplicates:'跨来源去重记录',conflicts:'跨来源冲突记录',sheets:'工作表数量',supportedSheets:'已识别工作表',unsupportedSheets:'未识别工作表',supportingSheets:'排除独立报告工作表',supportingWorkbooks:'排除独立报告文件',excludedOtherDates:'排除其他日期记录',unknownDate:'日期未明确',unknownResult:'判定未明确',missingProduct:'未注明产品',duplicateRecords:'表内重复记录',conflictingRecords:'表内冲突记录',weakIdentity:'记录身份待核实',ambiguousShortDates:'短日期归属不明确',missingFormulaResults:'缺少公式结果',emptyRows:'空行',feedbackRecords:'来源反馈记录',initialRecords:'来源初检记录',templateRows:'排除预填模板行'};
  const diagnosticWarnings = new Set(['outOfScopeRecords','failed','skipped','staleFiles','incompleteGroups','conflicts','unsupportedSheets','unknownDate','unknownResult','missingProduct','conflictingRecords','weakIdentity','ambiguousShortDates','missingFormulaResults']);
  const emptyFilters = () => ({year:'',month:'',week:'',category:'all',product:''});
  const state = {account:null,active:false,epoch:0,report:null,applied:emptyFilters(),request:null,timer:null,error:'',draftVersion:0,productOptions:new Set()};
  const content = new WeakMap();
  const number = value => count(value) ? value.toLocaleString('zh-CN') : '—';
  const percent = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN',{maximumFractionDigits:2}) + '%' : '—';
  const productLabel = () => state.report?.productNamesMode === 'alias' ? '产品代号' : '产品名称';
  function filters(value = {},mode = state.report?.productNamesMode || 'original') {
    const year = /^(?:19|20|21)\d{2}$/.test(String(value.year)) ? String(value.year) : '';
    let week = '';const match = new RegExp('^'+year+'-KW(\\d{2})$').exec(value.week);
    if (year && match && window.PortalCalendar) try { week = window.PortalCalendar.range(Number(year),Number(match[1])).key; } catch (_) {}
    return {year,month:!week && year && new RegExp('^' + year + '-(?:0[1-9]|1[0-2])$').test(value.month) ? value.month : '',week,category:Object.hasOwn(labels,value.category) ? value.category : 'all',product:validProduct(value.product,mode) ? value.product : ''};
  }
  function metrics(value) {
    if (!value || !['total','passed','failed','unknown'].every(key => count(value[key])) || value.total !== value.passed + value.failed + value.unknown || !(value.rate === null || typeof value.rate === 'number' && Number.isFinite(value.rate) && value.rate >= 0 && value.rate <= 100)) throw new Error('invalid-report');
    if (value.feedbackCount !== undefined && !count(value.feedbackCount)) throw new Error('invalid-report');
    const retest = Object.fromEntries(['retestPassed','retestFailed','retestUnknown'].map(key => [key,count(value[key]) ? value[key] : null]));
    return {total:value.total,passed:value.passed,failed:value.failed,unknown:value.unknown,feedbackCount:value.feedbackCount || 0,rate:value.rateAvailable === false ? null : value.rate,rateAvailable:value.rateAvailable !== false && value.rate !== null,...retest};
  }
  function normalize(data) {
    if (!data || typeof data.enabled !== 'boolean' || !Array.isArray(data.years) || !Array.isArray(data.months) || !Array.isArray(data.products) || !Array.isArray(data.categories) || !data.sync || !['ready','syncing','error','incomplete','unconfigured'].includes(data.sync.state)) throw new Error('invalid-report');
    if(data.productNamesMode !== undefined && !['original','alias'].includes(data.productNamesMode)) throw new Error('invalid-report');
    const productNamesMode = data.productNamesMode || 'alias';
    const applied = filters(data.filters,productNamesMode);
    if(data.filters?.product && !applied.product) throw new Error('invalid-report');
    const years = [...new Set(data.years.filter(year => /^(?:19|20|21)\d{2}$/.test(String(year))).map(String))].sort().reverse();
    const months = data.months.map(row => { if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(row.month)) throw new Error('invalid-report');return {month:row.month,...metrics(row)}; }).sort((a,b) => a.month.localeCompare(b.month));
    const products = data.products.map(row => { if (!validProduct(row.code,productNamesMode)) throw new Error('invalid-report');return {code:row.code,...metrics(row)}; });
    const categories = data.categories.filter(row => ['full','bracket'].includes(row.id)).map(row => ({id:row.id,label:labels[row.id],...metrics(row)}));
    const productOptions = Array.isArray(data.productOptions) ? data.productOptions.filter(value => validProduct(value,productNamesMode)) : products.map(row => row.code);
    const diagnostics = Object.fromEntries(Object.keys(diagnosticLabels).filter(key => count(data.diagnostics?.[key])).map(key => [key,data.diagnostics[key]]));
    const incomplete = data.incomplete === true || data.complete === false || data.sync.incomplete === true || data.sync.complete === false || data.sync.state === 'incomplete' || diagnostics.failed > 0 || diagnostics.staleFiles > 0 || diagnostics.incompleteGroups > 0;
    const progress = data.sync.progress && ['files','read','failed'].every(key => count(data.sync.progress[key])) ? {files:data.sync.progress.files,read:data.sync.progress.read,failed:data.sync.progress.failed} : null;
    return {enabled:data.enabled,productNamesMode,years,filters:applied,summary:metrics(data.summary),months,products,productOptions,categories,diagnostics,incomplete,sync:{state:data.sync.state,lastSuccessAt:data.sync.lastSuccessAt,lastAttemptAt:data.sync.lastAttemptAt,progress,error:typeof data.sync.error === 'string' ? data.sync.error.slice(0,300) : ''},methodology:typeof data.methodology === 'string' ? data.methodology.slice(0,1000) : '统计口径尚未提供；请核对数据源配置。未判定记录不按合格或不合格补填。',coverageNote:typeof data.coverageNote === 'string' ? data.coverageNote.slice(0,500) : '统计范围仅限已接入记录，不能据此确认现场全部检测均已登记。'};
  }
  function stamp(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return '尚无记录';
    const date = new Date(value);if (Number.isNaN(date.getTime())) return '尚无记录';
    return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(date);
  }
  const sessionKey = account => 'portal:penetration:filters:v1:' + encodeURIComponent(account);
  function remember() { try { if (state.account) sessionStorage.setItem(sessionKey(state.account),JSON.stringify(state.applied)); } catch (_) {} }
  function restore(account) { try { return filters(JSON.parse(sessionStorage.getItem(sessionKey(account)) || '{}')); } catch (_) { return emptyFilters(); } }
  function clearSession(account) { try { if (account) sessionStorage.removeItem(sessionKey(account)); } catch (_) {} }
  root.innerHTML = `
    <section class="pen-panel pen-filters" aria-label="熔深查询条件"><form id="penQueryForm">
      <label class="field"><span>年份</span><select id="penYear"><option value="">按来源年份</option></select></label>
      <label class="field"><span>月份</span><select id="penMonth"><option value="">全年</option></select></label>
      <label class="field"><span>公司周（周五至周四）</span><select id="penWeek"><option value="">不按周筛选</option></select></label>
      <label class="field"><span>检测类别</span><select id="penCategory"><option value="all">全部类别</option><option value="full">全切异常反馈</option><option value="bracket">快切支架</option></select></label>
      <label class="field pen-product-filter"><span id="penProductLabel">产品名称</span><select id="penProduct"><option value="">全部产品名称</option></select></label>
      <div class="pen-query-actions"><button id="penQuery" class="button primary" type="submit">查询</button><button id="penReset" class="button" type="button">重置</button></div>
      <div class="pen-week-actions"><button id="penPreviousWeek" class="button" type="button">← 前一周</button><button id="penNextWeek" class="button" type="button">后一周 →</button><small>月份与公司周互斥。2026/10/02–10/08 为 KW41；跨年暂按含 1 月 1 日的周为 KW01。</small></div>
      <p id="penDraftHint" class="pen-draft" role="status" hidden>筛选已修改，点击“查询”后生效。自动刷新仍使用已应用条件。</p>
    </form></section>
    <div id="penSource" class="pen-source" role="status"><div><strong id="penSourceTitle">等待读取熔深报表</strong><p id="penSourceMessage">登录后显示已接入的统计数据。</p><small id="penSourceTime"></small></div><button id="penRefresh" class="button" type="button">同步最新数据</button></div>
    <p id="penError" class="pen-error" role="alert" hidden></p>
    <div class="pen-results-heading"><h2>首次检测与异常反馈</h2><p id="penScope">尚未应用筛选</p></div>
    <div id="penStats" class="pen-stats" aria-label="熔深合格率统计"></div>
    <p id="penMethodology" class="pen-methodology">等待数据源提供统计口径。</p>
    <p id="penCoverage" class="pen-methodology"></p>
    <p id="penCoverageWarning" class="pen-coverage-warning" role="status" hidden></p>
    <details id="penCoverageDetails" class="pen-coverage-details"><summary>数据覆盖与复检统计<span>复检不计入首次检测合格率</span></summary><div class="pen-coverage-body"><section><h3>当前范围复检结论</h3><div id="penRetests" class="pen-retests"></div></section><section><h3>数据源覆盖诊断</h3><p>来源整体读取情况，不随当前筛选缩小。</p><div id="penDiagnostics" class="pen-diagnostics"></div></section></div></details>
    <div id="penEmpty" class="pen-empty" hidden></div>
    <div id="penAnalysis" class="pen-analysis" hidden>
      <section class="pen-panel" aria-labelledby="penTrendTitle"><div class="pen-panel-heading"><div><h2 id="penTrendTitle">已读取记录 · 月度趋势</h2><p>保留类别与产品条件，按来源年份对照首次合格率和全切反馈；点击月份查看当月。</p></div><span class="pen-legend"><i aria-hidden="true"></i>合格率</span></div><div id="penTrend" class="pen-trend"></div></section>
      <section class="pen-panel" aria-labelledby="penCategoryTitle"><div class="pen-panel-heading"><div><h2 id="penCategoryTitle">检测类别</h2><p>按同一查询范围对照，分母以统计口径为准。</p></div></div><div id="penCategories" class="pen-categories"></div></section>
      <section class="pen-panel pen-products-panel" aria-labelledby="penProductsTitle"><div class="pen-panel-heading"><div><h2 id="penProductsTitle">产品名称统计</h2><p id="penProductsNote">按来源产品名称展示，结果使用当前已应用筛选。</p></div><span id="penProductCount" class="pen-table-count"></span></div><div id="penProducts" class="pen-product-table" tabindex="0" aria-label="产品名称统计表"></div></section>
    </div>`;
  function replace(id,html) {
    const node = $(id);if (content.get(node) === html) return;
    const left = node.scrollLeft,top = node.scrollTop;
    const focused = node.contains(document.activeElement) ? document.activeElement?.dataset?.penMonth : null;
    node.innerHTML = html;content.set(node,html);node.scrollLeft = left;node.scrollTop = top;
    if (focused) node.querySelector(`[data-pen-month="${focused}"]`)?.focus({preventScroll:true});
  }
  function controls() { return filters({year:$('penYear').value,month:$('penMonth').value,week:$('penWeek').value,category:$('penCategory').value,product:$('penProduct').value}); }
  function options(id,items,selected) {
    const html = items.map(([value,label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('');
    replace(id,html);$(id).value = selected;
  }
  function fillControls(value = controls()) {
    const selected = filters(value),report = state.report;
    const years = [...new Set([...(report?.years || []),...(selected.year ? [selected.year] : [])])].sort().reverse();
    options('penYear',[['','按来源年份'],...years.map(year => [year,year+' 年'])],selected.year);
    options('penMonth',[['','全年'],...(selected.year ? Array.from({length:12},(_,index) => [selected.year+'-'+String(index+1).padStart(2,'0'),(index+1)+' 月']) : [])],selected.month);
    options('penWeek',[['','不按周筛选'],...(selected.year && window.PortalCalendar ? window.PortalCalendar.weeks(Number(selected.year)).map(info => [info.key,info.label+' · '+info.start.slice(5).replace('-','/')+'–'+info.end.slice(5).replace('-','/')]) : [])],selected.week);
    options('penProduct',[['','全部'+productLabel()],...[...new Set([...state.productOptions,...(selected.product ? [selected.product] : [])])].sort().map(code => [code,code])],selected.product);
    $('penCategory').value = selected.category;
    renderDraft();
  }
  function renderDraft() { $('penDraftHint').hidden = JSON.stringify(controls()) === JSON.stringify(state.applied); }
  function scope(value) { let period = value.month ? Number(value.month.slice(-2))+' 月' : '全年';if(value.week && window.PortalCalendar){const info=window.PortalCalendar.range(Number(value.year),Number(value.week.slice(-2)));period=info.label+'（'+info.start+' 至 '+info.end+'）';}return [(value.year ? value.year+' 年' : '来源年份'),period,labels[value.category],value.product || '全部'+productLabel()].join(' · '); }
  function renderStatus() {
    const report = state.report,sync = report?.sync,busy = Boolean(state.request),syncing = sync?.state === 'syncing' || state.request?.synchronize;
    $('penQuery').disabled = busy || !state.active;$('penRefresh').disabled = busy || !state.active || report?.enabled === false || sync?.state === 'unconfigured';
    $('penRefresh').textContent = syncing ? '正在同步…' : busy ? '正在读取…' : '同步最新数据';
    $('penSource').className = 'pen-source ' + (state.error || sync?.state === 'error' || report?.incomplete ? 'error' : syncing ? 'syncing' : sync?.state || '');
    $('penSourceTitle').textContent = syncing ? '正在同步最新数据' : state.error ? '本次读取未完成' : sync?.state === 'unconfigured' || report?.enabled === false ? '熔深数据尚未接入' : report?.incomplete ? '部分来源未同步完成' : sync?.state === 'error' ? '最近一次同步未完成' : report ? '已保存的熔深统计' : busy ? '正在读取熔深统计' : '等待读取熔深报表';
    $('penSourceMessage').textContent = state.error ? (report ? '保留上次成功结果，请以当前结果范围和更新时间为准。' : '当前没有可展示的快照，请稍后重试。') : syncing ? '同步完成后自动更新。已有结果继续保留供核对。' : sync?.state === 'unconfigured' || report?.enabled === false ? '请联系管理员完成接入。未接入不表示零缺陷或全部合格。' : report?.incomplete ? '部分来源未读取成功，当前结果可能包含上次缓存；不代表完整年度检测。请查看覆盖诊断。' : sync?.state === 'error' ? '本次同步失败，当前保留已读取或上次缓存数据；年度覆盖尚未确认，请联系管理员核对。' : report ? '数据按已应用条件展示；无记录与未判定均不视为合格。' : '登录后显示已接入的统计数据。';
    $('penSourceTime').textContent = report ? '最后同步成功：'+stamp(sync.lastSuccessAt)+' · 最近尝试：'+stamp(sync.lastAttemptAt)+'（北京时间）' : '';
    if(sync?.state === 'syncing' && sync.progress) $('penSourceMessage').textContent += ' 已发现 '+number(sync.progress.files)+' 个文件，读取 '+number(sync.progress.read)+' 个，失败 '+number(sync.progress.failed)+' 项。';
    $('penError').hidden = !state.error;$('penError').textContent = state.error;
    root.setAttribute('aria-busy',String(busy));
  }
  function renderData() {
    const report = state.report,s = report?.enabled && report.sync.state !== 'unconfigured' ? report.summary : null;
    $('penProductLabel').textContent = productLabel();$('penProductsTitle').textContent = productLabel()+'统计';
    $('penProductsNote').textContent = report?.productNamesMode === 'alias' ? '按产品代号展示，结果使用当前已应用筛选。' : '按来源产品名称展示，结果使用当前已应用筛选。';
    $('penProducts').setAttribute('aria-label',productLabel()+'统计表');
    $('penScope').textContent = report ? scope(state.applied) : '尚未应用筛选';
    replace('penStats',[
      ['首次检测合格率',s ? percent(s.rate) : '—',s ? '快切已判定分母 '+number(s.passed+s.failed)+' 条' : '仅快切已判定记录','rate'],['快切初检记录',s ? number(s.total) : '—','焊缝记录数，不等于件数',''],['首次合格',s ? number(s.passed) : '—','不混入复切结果','passed'],['首次不合格',s ? number(s.failed) : '—','保留初检判定','failed'],['初检未判定',s ? number(s.unknown) : '—','不计入合格率分母','unknown'],['全切异常反馈',s ? number(s.feedbackCount) : '—','缺少总检测数，不计算合格率','feedback']
    ].map(([label,value,note,style]) => `<article class="pen-stat ${style}"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join(''));
    $('penMethodology').textContent = report?.methodology || '等待数据源提供统计口径。';
    $('penCoverage').textContent = report ? report.coverageNote + (report.coverageNote.includes('独立检测报告') ? '' : ' 全切仅纳入异常反馈汇总；独立检测报告不混算。') : '';
    const diagnostics = report?.diagnostics || {},warnings = Object.entries(diagnostics).filter(([key,value]) => diagnosticWarnings.has(key) && value > 0).map(([key,value]) => diagnosticLabels[key]+' '+number(value));
    $('penCoverageWarning').hidden = !warnings.length;$('penCoverageWarning').textContent = warnings.length ? warnings.join('；')+'。覆盖不完整项请先核对，当前结果不能代表全部检测。' : '';
    replace('penDiagnostics',Object.keys(diagnostics).length ? '<dl>'+Object.entries(diagnostics).map(([key,value]) => '<div><dt>'+diagnosticLabels[key]+'</dt><dd>'+number(value)+'</dd></div>').join('')+'</dl>' : '<p class="pen-empty compact">尚未提供覆盖诊断。</p>');
    replace('penRetests',report && report.summary.retestPassed !== null ? '<dl>'+[['复检合格',report.summary.retestPassed],['复检不合格',report.summary.retestFailed],['未记录复检结论',report.summary.retestUnknown]].map(([label,value]) => '<div><dt>'+label+'</dt><dd>'+number(value)+'</dd></div>').join('')+'</dl><p>“未记录”表示来源未提供复检结论，不表示已安排或尚待复检。</p>' : '<p class="pen-empty compact">尚未提供复检分类统计。</p>');
    const empty = !report || !report.enabled || !(report.summary.total || report.summary.feedbackCount);
    $('penEmpty').hidden = !empty;$('penAnalysis').hidden = empty;
    $('penEmpty').textContent = !report ? '尚未读取统计数据。' : !report.enabled ? '数据尚未接入，完成配置后可查看月度与产品统计。' : '当前条件没有检测记录。可调整年份、月份、类别或产品后查询。';
    if (!report) { for (const id of ['penTrend','penProducts','penCategories']) replace(id,'');$('penProductCount').textContent = '';return; }
    replace('penTrend',report.months.length ? report.months.map(row => `<button type="button" class="pen-month-row${state.applied.month === row.month ? ' selected' : ''}" data-pen-month="${esc(row.month)}" aria-label="${esc(row.month)}，首次检测合格率 ${percent(row.rate)}，快切初检 ${number(row.total)}，未判定 ${number(row.unknown)}，全切反馈 ${number(row.feedbackCount)}，查看当月"><span class="pen-month-label">${Number(row.month.slice(-2))} 月</span><span class="pen-month-track"><span style="width:${row.rate === null ? 0 : row.rate}%"></span></span><strong>${percent(row.rate)}</strong><small>快切初检 ${number(row.total)} · 未判定 ${number(row.unknown)} · 全切反馈 ${number(row.feedbackCount)}</small></button>`).join('') : '<p class="pen-empty compact">当前范围暂无月度记录。</p>');
    replace('penCategories',report.categories.length ? report.categories.map(row => row.id === 'full' ? `<article class="pen-category feedback"><div><h3>全切异常反馈</h3><strong>${number(row.feedbackCount)}</strong></div><p>缺少总检测数量，仅展示异常反馈记录，不计算首次检测合格率。</p></article>` : `<article class="pen-category"><div><h3>${esc(row.label)}</h3><strong>${percent(row.rate)}</strong></div><dl><div><dt>初检记录</dt><dd>${number(row.total)}</dd></div><div><dt>首次合格</dt><dd>${number(row.passed)}</dd></div><div><dt>首次不合格</dt><dd>${number(row.failed)}</dd></div><div><dt>未判定</dt><dd>${number(row.unknown)}</dd></div></dl></article>`).join('') : '<p class="pen-empty compact">当前范围暂无类别记录。</p>');
    $('penProductCount').textContent = report.products.length+' 个产品';
    replace('penProducts',report.products.length ? '<table><thead><tr><th scope="col">'+productLabel()+'</th><th scope="col">快切初检</th><th scope="col">首次合格</th><th scope="col">首次不合格</th><th scope="col">未判定</th><th scope="col">全切反馈</th><th scope="col">首次合格率</th></tr></thead><tbody>'+report.products.map(row => '<tr><th scope="row">'+esc(row.code)+'</th>'+[['快切初检',number(row.total)],['首次合格',number(row.passed)],['首次不合格',number(row.failed)],['未判定',number(row.unknown)],['全切反馈',number(row.feedbackCount)],['首次合格率',percent(row.rate)]].map(([label,value]) => `<td data-label="${label}">${value}</td>`).join('')+'</tr>').join('')+'</tbody></table>' : '<p class="pen-empty compact">当前范围暂无产品统计。</p>');
  }
  function clearTimer() { clearTimeout(state.timer);state.timer = null; }
  function cancel() { clearTimer();const request = state.request;state.request = null;if (request) { clearTimeout(request.timeout);request.controller.abort(); } }
  function schedule() { clearTimer();if (state.active && !document.hidden && !state.request) state.timer = setTimeout(() => load(),state.report?.sync.state === 'syncing' ? 2000 : 30000); }
  async function api(url,options) {
    const response = await fetch(url,{credentials:'same-origin',cache:'no-store',...options});
    if (response.status === 401) { const error = new Error('session-expired');error.status = 401;throw error; }
    if (!response.ok) throw new Error('request-failed');
    return response.json();
  }
  async function load({query = state.applied,apply = false,synchronize = false} = {}) {
    if (!state.active) return;
    if (state.request) { if (!apply) return;cancel(); }
    clearTimer();const selected = filters(query),initial = !state.report;
    const request = {controller:new AbortController(),epoch:state.epoch,synchronize,draftVersion:state.draftVersion,timedOut:false};
    request.timeout = setTimeout(() => { request.timedOut = true;request.controller.abort(); },60000);
    state.request = request;state.error = '';renderStatus();
    try {
      if (synchronize) await api('/local/penetration/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:request.controller.signal});
      if (state.request !== request || request.epoch !== state.epoch) return;
      const params = new URLSearchParams(selected);
      if (!selected.year) params.delete('year');if (!selected.week) params.delete('week');
      const report = normalize(await api('/local/penetration/report?'+params,{signal:request.controller.signal}));
      if (state.request !== request || request.epoch !== state.epoch) return;
      const draft = controls();if(draft.product === state.applied.product && selected.product === state.applied.product) draft.product = report.filters.product;
      state.report = report;state.applied = report.filters;state.productOptions = new Set(report.productOptions);remember();
      fillControls((apply || initial) && request.draftVersion === state.draftVersion ? state.applied : draft);
      renderData();
    } catch (error) {
      if (state.request !== request || request.epoch !== state.epoch) return;
      if (error.status === 401) { setContext(null,false);document.dispatchEvent(new CustomEvent('portal:session-expired'));return; }
      if (error.name !== 'AbortError' || request.timedOut) state.error = request.timedOut ? '读取超时，请稍后重试。' : error.message === 'invalid-report' ? '统计数据格式未通过校验，未覆盖上次成功结果。' : '读取未完成，请稍后重试；持续失败时请联系管理员。';
    } finally { if (state.request === request) { clearTimeout(request.timeout);state.request = null;renderStatus();schedule(); } }
  }
  function setContext(status,active) {
    const account = status?.authenticated && status.account ? String(status.account) : null;
    if (account !== state.account) {
      cancel();state.epoch++;clearSession(state.account);state.account = account;state.active = false;state.report = null;state.productOptions.clear();state.applied = account ? restore(account) : emptyFilters();state.error = '';state.draftVersion = 0;fillControls(state.applied);renderData();
    }
    const wasActive = state.active;state.active = Boolean(account && active);root.hidden = !state.active;
    if (!state.active) cancel();
    renderStatus();
    if (state.active && !wasActive) return load();
  }
  $('penQueryForm').addEventListener('submit',event => { event.preventDefault();return load({query:controls(),apply:true}); });
  for (const id of ['penYear','penMonth','penWeek','penCategory','penProduct']) $(id).addEventListener('change',() => { state.draftVersion++;if (id === 'penYear') fillControls({...controls(),month:'',week:''});else if (id === 'penMonth') { $('penWeek').value = '';renderDraft(); }else if (id === 'penWeek') { $('penMonth').value = '';renderDraft(); }else renderDraft(); });
  $('penReset').addEventListener('click',() => { state.draftVersion++;const query = {...emptyFilters(),year:state.report?.years[0] || ''};fillControls(query);return load({query,apply:true}); });
  $('penRefresh').addEventListener('click',() => load({synchronize:true}));
  $('penTrend').addEventListener('click',event => { const month = event.target.closest('[data-pen-month]')?.dataset.penMonth;if (!month) return;state.draftVersion++;const query = {...state.applied,month,week:'',year:month.slice(0,4)};fillControls(query);return load({query,apply:true}); });
  function moveWeek(offset) {
    if (!window.PortalCalendar) return;
    const query = controls();let base;
    if(query.week)base=window.PortalCalendar.range(Number(query.year),Number(query.week.slice(-2)));
    else if(query.month)base=window.PortalCalendar.weekInfo(query.month+'-01');
    else { const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());base=window.PortalCalendar.weekInfo(today);if(query.year&&base.year!==Number(query.year))base=window.PortalCalendar.range(Number(query.year),1); }
    const info=window.PortalCalendar.weekInfo(window.PortalCalendar.addDays(base.start,offset*7)),next={...query,year:String(info.year),month:'',week:info.key};
    if(state.report && !state.report.years.includes(String(info.year))){state.error='该公司周属于尚未接入的年份，请选择已接入年度。';renderStatus();return;}
    state.draftVersion++;fillControls(next);return load({query:next,apply:true});
  }
  $('penPreviousWeek').addEventListener('click',()=>moveWeek(-1));$('penNextWeek').addEventListener('click',()=>moveWeek(1));
  document.addEventListener('visibilitychange',() => { if (document.hidden) cancel();else if (state.active) load(); });
  window.addEventListener('beforeunload',cancel);
  window.PenetrationWorkbench = Object.freeze({setContext});
  fillControls();renderData();renderStatus();
})();
