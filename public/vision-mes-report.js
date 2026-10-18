(() => {
  'use strict';
  const host = document.getElementById('visionWorkbench');
  if (!host) return;
  const $ = id => document.getElementById(id);
  const create = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  };
  const text = value => typeof value === 'string' && value.trim() ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '未提供';
  const number = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';
  const percent = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value.toFixed(1) + '%' : '—';
  const kind = value => value === 'OK' || value === 'NG' ? value : 'unknown';
  const beijingTime = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const dateLabel = value => {
    if (typeof value !== 'string' || !value) return '未提供';
    if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
      const date = new Date(value);
      if (!Number.isNaN(date.valueOf())) { const parts = beijingTime.formatToParts(date), part = key => parts.find(item => item.type === key).value; return part('year') + '-' + part('month') + '-' + part('day') + ' ' + part('hour') + ':' + part('minute') + ':' + part('second'); }
    }
    return value.replace('T', ' ').replace(/\.\d+$/, '');
  };
  const rawValue = (item, key) => typeof item[key] === 'number' && Number.isFinite(item[key]) ? String(item[key]) : text(item[key + 'Raw']);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

  const root = create('section');
  root.id = 'mesVisionReportWorkbench'; root.className = 'mes-report'; root.hidden = true;
  root.innerHTML = `
    <section class="mes-report-filter vis-panel" aria-labelledby="mesReportTitle">
      <div class="mes-report-heading"><div><p class="mes-report-kicker">公司系统 · 尺寸检测</p><h2 id="mesReportTitle">线体检测结果</h2><p>选择按时间或按数量查询；同一工件的每次复测分别保留。</p></div><span id="mesReportCatalogCount" class="mes-report-label">正在读取线体…</span></div>
      <form id="mesReportForm" aria-label="公司尺寸检测筛选">
        <fieldset class="mes-report-query-mode"><legend>查询方式</legend><label><input id="mesReportModeTime" name="mesReportQueryMode" type="radio" value="time" checked><span>按时间</span></label><label><input id="mesReportModeCount" name="mesReportQueryMode" type="radio" value="count"><span>按数量</span></label></fieldset>
        <div class="mes-report-fields">
          <label id="mesReportRangeField" class="field"><span>时间范围</span><select id="mesReportRangeMode"></select></label>
          <label id="mesReportCountField" class="field" hidden><span>查看数量</span><select id="mesReportLimit" disabled><option value="100">最近 100 次</option><option value="500" selected>最近 500 次</option><option value="1000">最近 1000 次</option><option value="custom">自定义数量</option></select><span id="mesReportCustomLimit" class="mes-report-custom-limit" hidden><span>最近</span><input id="mesReportLimitCount" type="number" min="1" max="20000" step="1" value="500" disabled aria-label="最近检测次数"><span>次</span></span></label>
          <label class="field mes-report-line"><span>检测线体</span><select id="mesReportLine" required><option value="">正在读取线体…</option></select></label>
          <label class="field"><span>检测设备</span><select id="mesReportDevice"><option value="">全部设备</option></select></label>
          <label class="field"><span>检测结论</span><select id="mesReportResult"><option value="all">全部结果</option><option value="OK">OK · 合格</option><option value="NG">NG · 不合格</option></select></label>
          <label class="field"><span>物料</span><select id="mesReportPart"><option value="">全部物料</option></select></label>
          <label id="mesReportStartField" class="field"><span>开始时间</span><input id="mesReportStart" type="datetime-local" step="60" required></label>
          <label id="mesReportEndField" class="field"><span>结束时间</span><input id="mesReportEnd" type="datetime-local" step="60" required></label>
          <label class="field mes-report-search"><span>工件码 / 零件 SN（选填）</span><input id="mesReportBarcode" type="search" maxlength="150" autocomplete="off" spellcheck="false" placeholder="扫码或输入工件码，查看该工件的检测与复测"></label>
          <div class="mes-report-actions"><button id="mesReportSubmit" class="button primary" type="submit">查询记录</button><button id="mesReportReset" class="button" type="button">重置</button></div>
        </div>
        <p id="mesReportDraft" class="mes-report-draft" hidden>筛选已修改，点击“查询记录”后生效。</p><p id="mesReportModeHelp" class="mes-report-help">按时间查询所选范围内的全部检测，不限制最近数量。</p><p class="mes-report-help">查询与检测时间均为北京时间。多次检测不合并为一个工件。设备、物料选项来自本次已读取的记录，并非公司完整目录。</p>
      </form>
    </section>
    <div class="mes-report-status" role="status"><div><strong id="mesReportStatusTitle">准备查询公司检测记录</strong><p id="mesReportStatusMessage">正在读取可用的尺寸检测线体。</p><small id="mesReportReadTime"></small></div><button type="button" class="button" id="mesReportRefresh">刷新数据</button></div>
    <p id="mesReportError" class="mes-report-error" role="alert" hidden></p>
    <div class="mes-report-stat-heading"><div><h3>检测统计</h3><p>统计、趋势与报告使用同一组已应用条件。</p></div><button id="mesReportExport" type="button" class="button primary" disabled>一键报告</button></div>
    <div class="mes-report-stats" aria-label="当前查询的检测统计"><article><span id="mesReportTotalLabel">检测次数</span><strong id="mesReportTotal">—</strong><small>每次检测分别计数</small></article><article><span>合格 OK</span><strong id="mesReportOK">—</strong><small>公司系统整件结论</small></article><article class="ng"><span>不合格 NG</span><strong id="mesReportNG">—</strong><small>公司系统整件结论</small></article><article><span>检测合格率</span><strong id="mesReportRate">—</strong><small id="mesReportRateNote">OK / 有明确结论的检测次数</small></article></div>
    <p id="mesReportCoverage" class="mes-report-coverage" hidden></p>
    <section class="vis-panel mes-report-trend" aria-labelledby="mesReportTrendTitle"><div class="mes-report-panel-heading"><div><h3 id="mesReportTrendTitle">合格率趋势</h3><p id="mesReportTrendSubtitle">按当前查询返回的检测记录统计</p></div><label class="mes-report-interval">统计间隔<select id="mesReportInterval"><option value="auto">自动</option><option value="5">5 分钟</option><option value="15">15 分钟</option><option value="30">30 分钟</option><option value="60">1 小时</option><option value="1440">1 天</option></select></label></div><p id="mesReportTrendEmpty" class="mes-report-empty">查询后展示趋势。</p><div id="mesReportChart" class="mes-report-chart" hidden></div><div id="mesReportTrendDetail" class="mes-report-trend-detail" role="status" hidden></div><p id="mesReportTrendNote" class="mes-report-help" hidden></p></section>
    <div id="mesVisionAnalysisHost"></div>
    <section class="vis-panel mes-report-records" aria-labelledby="mesReportRecordsTitle"><div class="mes-report-panel-heading"><div><h3 id="mesReportRecordsTitle">检测记录</h3><p id="mesReportScope">查询后展示该范围内的检测记录。</p></div><span id="mesReportPolling" class="mes-report-label">打开此页时每 60 秒刷新</span></div><p id="mesReportRecordsEmpty" class="mes-report-empty">尚未查询检测记录。</p><div id="mesReportTableWrap" class="mes-report-table-wrap" tabindex="0" aria-label="检测记录，可横向滚动" hidden><table><thead><tr><th scope="col">工件码 / SN</th><th scope="col">检测时间</th><th scope="col">物料</th><th scope="col">检测设备</th><th scope="col">整件结论</th><th scope="col">查看</th></tr></thead><tbody id="mesReportRows"></tbody></table></div><div class="mes-report-pagination"><label>每页<select id="mesReportPageSize"><option value="20">20 条</option><option value="50" selected>50 条</option><option value="100">100 条</option></select></label><div><button type="button" class="button" id="mesReportPrev">上一页</button><span id="mesReportPage">—</span><button type="button" class="button" id="mesReportNext">下一页</button></div></div></section>
    <details id="mesReportHistory" class="mes-report-history"><summary>历史不合格参数查询 <span>用于核查历史 NG，不代表工件最新状态</span></summary></details>`;
  host.prepend(root);
  const history = $('mesVisionWorkbench');
  if (history) $('mesReportHistory').append(history); else $('mesReportHistory').hidden = true;

  const dialog = create('dialog'); dialog.id = 'mesReportDetailDialog'; dialog.className = 'mes-report-dialog'; dialog.setAttribute('aria-labelledby', 'mesReportDetailTitle');
  dialog.innerHTML = '<div class="mes-report-panel-heading"><div><p class="mes-report-kicker">公司系统 · 本次检测</p><h2 id="mesReportDetailTitle">测点详情</h2></div><button id="mesReportDetailClose" type="button" class="icon-button" aria-label="关闭公司检测详情">×</button></div><p id="mesReportDetailMessage" class="mes-report-empty" role="status">正在读取测点…</p><div id="mesReportDetailContent" hidden><div id="mesReportDetailIdentity" class="mes-report-detail-identity"></div><dl id="mesReportDetailMeta" class="mes-report-detail-meta"></dl><div class="mes-report-panel-heading mes-report-detail-counts"><strong id="mesReportDetailCounts"></strong><label class="mes-report-ng-toggle"><input id="mesReportDetailOnlyNG" type="checkbox">只看 NG</label></div><p id="mesReportDetailEmpty" class="mes-report-empty" hidden></p><div id="mesReportDetailTableWrap" class="mes-report-table-wrap" tabindex="0" aria-label="本次检测测点，可横向滚动"><table><thead><tr id="mesReportDetailColumns"></tr></thead><tbody id="mesReportDetailRows"></tbody></table></div><ul id="mesReportDetailWarnings" class="mes-report-detail-warnings" hidden></ul></div>';
  document.body.append(dialog);

  const state = { status: null, account: null, active: false, epoch: 0, catalogRequest: null, reportRequest: null, detailRequest: null, timer: null, lines: [], defaultLineId: '', applied: null, report: null, error: '', page: 1, size: 50, detail: null, chart: null, hoverIndex: -1, reportOpen: false, restoredLine: '', facetLabels: { parts: new Map(), devices: new Map() } };
  let dateFilter = null, materialSearch = null;
  function visible() { return state.active && !document.hidden; }
  function reportOpen() { return state.reportOpen || Boolean(window.PortalReport?.isOpen?.()); }
  function analysisOpen() { return Boolean(window.MesVisionAnalysis?.isBusy?.()); }
  function stopTimer() { clearTimeout(state.timer); state.timer = null; }
  function cancel(name) { const request = state[name]; state[name] = null; if (request) { clearTimeout(request.timeout); request.controller.abort(); } }
  function current(name, request) { return state[name] === request && request.epoch === state.epoch && state.active && state.status?.authenticated; }
  function begin(name) { cancel(name); const request = { controller: new AbortController(), epoch: state.epoch, timedOut: false }; request.timeout = setTimeout(() => { request.timedOut = true; request.controller.abort(); }, 60000); state[name] = request; return request; }
  function schedule() { stopTimer(); if (visible() && state.applied && !state.reportRequest && !dialog.open && !reportOpen() && !analysisOpen()) state.timer = setTimeout(() => loadReport(state.applied, false, 'poll'), 60000); }
  function closeDetail(resume = true) { cancel('detailRequest'); state.detail = null; if (dialog.open) dialog.close(); $('mesReportDetailContent').hidden = true; for (const id of ['mesReportDetailIdentity', 'mesReportDetailMeta', 'mesReportDetailRows', 'mesReportDetailWarnings']) $(id).replaceChildren(); if (resume !== false) { schedule(); controls(); } }
  function presetDates(period) {
    if (window.PortalFilters?.range) { const range = window.PortalFilters.range(period); return { start: range.start + 'T00:00', end: range.end + 'T23:59' }; }
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const part = key => parts.find(item => item.type === key).value;
    let end = part('year') + '-' + part('month') + '-' + part('day');
    if (period === 'yesterday') end = new Date(Date.parse(end + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
    if (period === 'companyWeek' && window.PortalCalendar?.weekInfo) { const week = window.PortalCalendar.weekInfo(end); return { start: week.start + 'T00:00', end: week.end + 'T23:59' }; }
    const days = period === 'month' ? 30 : period === 'week' ? 7 : 1;
    return { start: new Date(Date.parse(end + 'T12:00:00Z') - (days - 1) * 86400000).toISOString().slice(0, 10) + 'T00:00', end: end + 'T23:59' };
  }
  function queryMode() { return $('mesReportModeCount').checked ? 'count' : 'time'; }
  function setQueryMode(mode) { const count = mode === 'count'; $('mesReportModeCount').checked = count; $('mesReportModeTime').checked = !count; }
  function materialKey(partCode, productionLine) { return productionLine ? 'line:' + encodeURIComponent(JSON.stringify([partCode, productionLine])) : partCode || ''; }
  function selectedMaterial() {
    const value = $('mesReportPart').value;
    if (value.startsWith('line:')) try { const parts = JSON.parse(decodeURIComponent(value.slice(5))); if (Array.isArray(parts) && parts.length === 2 && typeof parts[0] === 'string' && typeof parts[1] === 'string' && /^(?:\d+|unknown)$/.test(parts[1])) return { partCode: parts[0], productionLine: parts[1] }; } catch (_) {}
    return { partCode: value, productionLine: '' };
  }
  function lineLabel(productionLine) { return productionLine && productionLine !== 'unknown' ? productionLine + '线' : '线号待确认'; }
  function fields() {
    const mode = queryMode(), rawLimit = $('mesReportLimit').value === 'custom' ? $('mesReportLimitCount').value : $('mesReportLimit').value;
    const query = { queryMode: mode, lineId: $('mesReportLine').value, limit: mode === 'time' ? '0' : /^\d+$/.test(rawLimit) ? String(Number(rawLimit)) : rawLimit, barcode: $('mesReportBarcode').value.trim(), deviceCode: $('mesReportDevice').value, ...selectedMaterial(), result: $('mesReportResult').value };
    if (mode === 'time') { query.start = $('mesReportStart').value; query.end = $('mesReportEnd').value; }
    return query;
  }
  function draft() { return Boolean(state.applied && Object.keys(state.applied).some(key => String(state.applied[key]) !== fields()[key])); }
  function reportInput() { return { kind: 'vision-mes', report: state.report, query: state.applied, loadedAt: state.report?.fetchedAt, account: state.account, author: state.status?.name || state.account, interval: $('mesReportInterval').value }; }
  function exportReady() { return state.active && !state.catalogRequest && !state.reportRequest && !state.error && !draft() && complete() && Boolean(state.report?.records.length) && Boolean(window.PortalReport?.canOpen?.(reportInput())); }
  function controls() {
    const busy = Boolean(state.catalogRequest || state.reportRequest);
    root.setAttribute('aria-busy', String(busy));
    $('mesReportSubmit').disabled = !state.active || !state.lines.length || busy;
    $('mesReportSubmit').textContent = busy ? '正在读取…' : '查询记录';
    $('mesReportRefresh').disabled = !state.active || busy;
    $('mesReportLine').disabled = !state.active || !state.lines.length;
    $('mesReportDraft').hidden = !draft();
    const pages = Math.max(1, Math.ceil((state.report?.records.length || 0) / state.size));
    $('mesReportPrev').disabled = !state.report || state.page <= 1;
    $('mesReportNext').disabled = !state.report || state.page >= pages;
    $('mesReportPolling').textContent = !visible() ? '自动刷新已暂停' : reportOpen() ? '报告预览期间暂停自动刷新' : dialog.open ? '查看测点时暂停自动刷新' : analysisOpen() ? '测点分析期间暂停自动刷新' : busy ? '正在读取检测记录…' : '打开此页时每 60 秒刷新';
    const count = queryMode() === 'count'; root.dataset.queryMode = count ? 'count' : 'time';
    for (const [fieldId, inputId] of [['mesReportRangeField', 'mesReportRangeMode'], ['mesReportStartField', 'mesReportStart'], ['mesReportEndField', 'mesReportEnd']]) { $(fieldId).hidden = count; $(inputId).disabled = count; }
    if (dateFilter?.weekControls) { dateFilter.weekControls.hidden = count || $('mesReportRangeMode').value !== 'companyWeek'; for (const input of dateFilter.weekControls.querySelectorAll('input,select,button')) input.disabled = count; }
    $('mesReportCountField').hidden = !count; $('mesReportLimit').disabled = !count;
    const custom = count && $('mesReportLimit').value === 'custom'; $('mesReportCustomLimit').hidden = !custom; $('mesReportLimitCount').disabled = !custom;
    $('mesReportModeHelp').textContent = count ? '按数量查询符合下方条件的最近检测，不应用时间筛选；结果会显示本次记录覆盖的时段。' : '按时间查询所选范围内的全部检测，不限制最近数量。';
    $('mesReportExport').disabled = !exportReady(); $('mesReportExport').title = exportReady() ? '按当前已应用条件生成一页报告' : '请先应用筛选并完整读取非空数据，再生成报告。';
    window.MesVisionAnalysis?.setContext?.({ report: state.report, query: state.applied, active: state.active, account: state.account, draft: draft(), loading: busy, error: state.error });
  }
  function applyPreset(period) { const value = ['today', 'yesterday', 'companyWeek', 'week', 'month'].includes(period) ? period : 'today'; if (dateFilter) dateFilter.reset(value); else { const dates = presetDates(value); $('mesReportStart').value = dates.start; $('mesReportEnd').value = dates.end; $('mesReportRangeMode').value = value; } controls(); }
  const storageKey = (account, version = 'v2') => 'portal:vision-mes:view:' + version + ':' + encodeURIComponent(account);
  function clearSaved(account) { if (account) try { window.sessionStorage?.removeItem(storageKey(account)); window.sessionStorage?.removeItem(storageKey(account, 'v1')); } catch (_) {} }
  function saveView() {
    if (!state.account || !state.applied) return;
    try { window.sessionStorage?.setItem(storageKey(state.account), JSON.stringify({ filters: state.applied, page: state.page, size: state.size, interval: $('mesReportInterval').value, labels: { part: state.facetLabels.parts.get(materialKey(state.applied.partCode, state.applied.productionLine)) || '', device: state.facetLabels.devices.get(state.applied.deviceCode) || '' } })); } catch (_) {}
  }
  function syncDateMode() {
    dateFilter?.sync();
    if (!$('mesReportStart').value.endsWith('T00:00') || !$('mesReportEnd').value.endsWith('T23:59')) { $('mesReportRangeMode').value = 'custom'; if (dateFilter?.weekControls) dateFilter.weekControls.hidden = true; }
  }
  function setLimit(value) {
    const choice = String(value), custom = !['100', '500', '1000'].includes(choice);
    $('mesReportLimit').value = custom ? 'custom' : choice; $('mesReportLimitCount').value = custom ? choice : '500';
  }
  function renderFacets(facets) {
    for (const [key, id, allLabel, appliedKey] of [['parts', 'mesReportPart', '全部物料', 'partCode'], ['devices', 'mesReportDevice', '全部设备', 'deviceCode']]) {
      const select = $(id), value = select.value || '', labels = state.facetLabels[key], options = new Map();
      for (const item of Array.isArray(facets?.[key]) ? facets[key] : []) if (item && typeof item.code === 'string' && item.code) { const hasLines = key === 'parts' && Array.isArray(facets?.materialLines) && facets.materialLines.some(line => line?.code === item.code); const label = (item.name || item.code) + (hasLines ? ' · 全部线' : '') + (item.name ? ' · ' + item.code : ''); options.set(item.code, label); labels.set(item.code, label); }
      if (key === 'parts') for (const item of Array.isArray(facets?.materialLines) ? facets.materialLines : []) if (item && typeof item.code === 'string' && item.code) {
        const productionLine = item.productionLine === null || item.productionLine === '' || item.productionLine === undefined ? 'unknown' : String(item.productionLine);
        if (!/^(?:\d+|unknown)$/.test(productionLine)) continue;
        const choice = materialKey(item.code, productionLine), label = (item.name || item.code) + ' · ' + lineLabel(productionLine) + (item.name ? ' · ' + item.code : '');
        options.set(choice, label); labels.set(choice, label);
      }
      const appliedValue = key === 'parts' ? materialKey(state.applied?.partCode, state.applied?.productionLine) : state.applied?.[appliedKey];
      for (const keep of [value, appliedValue]) if (keep && !options.has(keep)) options.set(keep, labels.get(keep) || keep);
      select.replaceChildren(); const all = create('option', allLabel); all.value = ''; select.append(all);
      for (const [code, label] of options) { const option = create('option', label); option.value = code; select.append(option); }
      select.value = value;
    }
    materialSearch?.refresh?.();
  }
  function restoreView() {
    const preferences = window.PortalPreferences?.get?.() || {};
    state.size = [20, 50, 100].includes(preferences.pageSize) ? preferences.pageSize : 50; $('mesReportPageSize').value = String(state.size);
    applyPreset(['today', 'yesterday', 'companyWeek', 'week', 'month'].includes(preferences.dateRange) ? preferences.dateRange : 'today');
    try {
      const currentSaved = window.sessionStorage?.getItem(storageKey(state.account));
      const saved = JSON.parse(currentSaved || window.sessionStorage?.getItem(storageKey(state.account, 'v1')) || 'null');
      if (!saved || !saved.filters) return;
      const filters = saved.filters, dates = ['start', 'end'];
      const mode = currentSaved && filters.queryMode === 'count' ? 'count' : 'time'; setQueryMode(mode);
      if (mode === 'time' && dates.every(key => typeof filters[key] === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(filters[key])) && filters.start <= filters.end) for (const key of dates) $('mesReport' + key[0].toUpperCase() + key.slice(1)).value = filters[key];
      const safe = (value, max) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : '';
      state.restoredLine = safe(filters.lineId, 100); $('mesReportBarcode').value = safe(filters.barcode, 150);
      $('mesReportResult').value = ['all', 'OK', 'NG'].includes(filters.result) ? filters.result : 'all';
      if (mode === 'count' && /^\d+$/.test(String(filters.limit)) && Number(filters.limit) >= 1 && Number(filters.limit) <= 20000) setLimit(String(Number(filters.limit)));
      for (const [key, selectId, labelKey, mapKey] of [['partCode', 'mesReportPart', 'part', 'parts'], ['deviceCode', 'mesReportDevice', 'device', 'devices']]) {
        const code = safe(filters[key], 150); if (!code) continue;
        const productionLine = key === 'partCode' && typeof filters.productionLine === 'string' && /^(?:\d+|unknown)$/.test(filters.productionLine) ? filters.productionLine : '';
        const choice = key === 'partCode' ? materialKey(code, productionLine) : code;
        state.facetLabels[mapKey].set(choice, safe(saved.labels?.[labelKey], 300) || code + (productionLine ? ' · ' + lineLabel(productionLine) : '')); const option = create('option', state.facetLabels[mapKey].get(choice)); option.value = choice; $(selectId).append(option); $(selectId).value = choice;
      }
      if ([20, 50, 100].includes(saved.size)) state.size = saved.size; $('mesReportPageSize').value = String(state.size);
      if (currentSaved && Number.isInteger(saved.page) && saved.page > 0 && saved.page <= 10000) state.page = saved.page;
      if (['auto', '5', '15', '30', '60', '1440'].includes(saved.interval)) $('mesReportInterval').value = saved.interval;
      if (!currentSaved) window.sessionStorage?.removeItem(storageKey(state.account, 'v1'));
      syncDateMode(); controls();
    } catch (_) {}
  }
  async function api(path, name, request) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: request.controller.signal });
    if (!current(name, request)) return null;
    if (response.status === 401) { clearSaved(state.account); reset(); state.active = false; root.hidden = true; document.dispatchEvent(new CustomEvent('portal:session-expired')); return null; }
    let body; try { body = await response.json(); } catch (_) { throw new Error('公司检测数据返回内容无法读取，请稍后重试。'); }
    if (!current(name, request)) return null;
    if (!response.ok) throw new Error(typeof body?.message === 'string' ? body.message.slice(0, 350) : '公司检测数据暂时无法读取，请稍后重试。');
    return body;
  }
  function renderCatalog() {
    const select = $('mesReportLine'), previous = state.restoredLine || select.value; select.replaceChildren();
    for (const line of state.lines) { const option = create('option', line.name || line.label || line.code || line.id); option.value = String(line.id); select.append(option); }
    select.value = state.lines.some(line => String(line.id) === previous) ? previous : state.lines.some(line => String(line.id) === state.defaultLineId) ? state.defaultLineId : String(state.lines[0]?.id || '');
    state.restoredLine = '';
    $('mesReportCatalogCount').textContent = state.lines.length ? number(state.lines.length) + ' 条尺寸检测线' : '暂无可查询线体';
    controls();
  }
  async function loadCatalog() {
    if (!visible()) return;
    const request = begin('catalogRequest'); controls(); state.error = ''; renderStatus();
    try {
      const body = await api('/local/vision/mes/catalog', 'catalogRequest', request); if (!current('catalogRequest', request)) return;
      if (!Array.isArray(body?.lines) || body.lines.some(line => !line || !['string', 'number'].includes(typeof line.id) || !String(line.id))) throw new Error('公司系统的线体列表无法读取，请刷新重试。');
      state.lines = body.lines; state.defaultLineId = String(body.defaultLineId || ''); renderCatalog();
      if (!state.lines.length) state.error = '当前账号没有可查询的尺寸检测线体。';
    } catch (error) { if (current('catalogRequest', request) && (error.name !== 'AbortError' || request.timedOut)) state.error = request.timedOut ? '读取线体超时，请刷新重试。' : error.message; }
    finally { clearTimeout(request.timeout); if (current('catalogRequest', request)) { state.catalogRequest = null; renderStatus(); controls(); if (state.lines.length && !state.report) loadReport(fields(), false); } }
  }
  function validateFilters(query) {
    if (!state.lines.some(line => String(line.id) === query.lineId)) return '请选择检测线体。';
    if (!['time', 'count'].includes(query.queryMode)) return '请选择按时间或按数量查询。';
    if (query.queryMode === 'time') {
      if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(query.start) || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(query.end)) return '请选择完整的开始与结束时间。';
      const rangeError = window.PortalFilters?.validateRange?.(query.start.slice(0, 10), query.end.slice(0, 10), { allowEmpty: false }); if (rangeError) return rangeError;
      if (query.start > query.end) return '开始时间不能晚于结束时间。';
      if (query.limit !== '0') return '按时间查询不应用最近数量。';
    } else if (query.start !== undefined || query.end !== undefined || !/^\d+$/.test(query.limit) || Number(query.limit) < 1 || Number(query.limit) > 20000) return '查看数量请输入 1 至 20000 的整数。';
    if (query.barcode.length > 150 || /[\x00-\x1f\x7f]/.test(query.barcode)) return '请检查工件码，最多 150 个字符。';
    if (!['all', 'OK', 'NG'].includes(query.result) || ['partCode', 'deviceCode'].some(key => typeof query[key] !== 'string' || query[key].length > 150 || /[\x00-\x1f\x7f]/.test(query[key]))) return '请检查物料、设备与检测结论。';
    if (typeof query.productionLine !== 'string' || query.productionLine && (!/^(?:[1-9]\d?|unknown)$/.test(query.productionLine) || !query.partCode)) return '请重新选择物料与线号。';
    return '';
  }
  async function loadReport(query, fresh, reason = 'manual') {
    if (!visible()) return;
    if ((dialog.open || reportOpen() || analysisOpen()) && reason !== 'manual') { stopTimer(); return; }
    const invalid = validateFilters(query); if (invalid) { state.error = invalid; renderStatus(); controls(); return; }
    stopTimer(); closeDetail(false); const request = begin('reportRequest'); state.error = ''; controls(); renderStatus();
    try {
      const body = await api('/local/vision/mes/report?' + new URLSearchParams(query), 'reportRequest', request); if (!current('reportRequest', request)) return;
      if (!Array.isArray(body?.records) || !body.summary || !body.coverage || body.records.some(record => !record || !['string', 'number'].includes(typeof record.recordId))) throw new Error('公司检测记录格式无法核对，已保留上次成功结果。');
      if (body.filters && (String(body.filters.queryMode || 'time') !== query.queryMode || String(body.filters.lineId) !== query.lineId || String(body.filters.limit) !== query.limit || ['barcode', 'partCode', 'deviceCode', 'productionLine'].some(key => String(body.filters[key] || '') !== query[key]) || String(body.filters.result || 'all') !== query.result)) throw new Error('返回记录与查询条件不一致，请重试。');
      state.report = body; state.applied = { ...query }; state.error = ''; if (fresh) state.page = 1;
      renderFacets(body.facets); renderReport(); saveView();
    } catch (error) { if (current('reportRequest', request) && (error.name !== 'AbortError' || request.timedOut)) state.error = request.timedOut ? '公司检测查询超时，请缩短时间范围或减少查看数量后重试。' : error.message; }
    finally { clearTimeout(request.timeout); if (current('reportRequest', request)) { state.reportRequest = null; renderStatus(); controls(); schedule(); } }
  }
  function complete() { return state.report?.coverage?.complete === true; }
  function rateAllowed() { return complete() && state.report?.coverage?.eligibleForLineRate === true; }
  function rateRestriction() {
    if (typeof state.report?.coverage?.rateUnavailableReason === 'string' && state.report.coverage.rateUnavailableReason) return state.report.coverage.rateUnavailableReason;
    if (state.applied?.result && state.applied.result !== 'all') return '当前按检测结论筛选，不显示线体合格率。';
    if (state.applied?.barcode) return '当前按工件码查询，只显示该工件各次检测结果，不展示线体合格率。';
    return '当前查询范围不适用于线体合格率，请查看检测次数与明细。';
  }
  function renderStatus() {
    $('mesReportError').hidden = !state.error; $('mesReportError').textContent = state.error;
    const busy = Boolean(state.catalogRequest || state.reportRequest), coverage = state.report?.coverage;
    $('mesReportStatusTitle').textContent = busy ? '正在读取公司系统' : state.error ? '本次读取未完成' : state.report ? complete() ? '公司检测记录已读取' : '已读取部分检测记录' : '准备查询公司检测记录';
    $('mesReportStatusMessage').textContent = state.error ? state.report ? '下方保留上次成功读取的结果，可能不是最新数据。' : '请检查连接或调整条件后重新查询。' : busy ? '正在按所选查询方式读取检测记录，请稍候。' : state.report ? coverage?.note || '统计与趋势使用当前查询范围内的检测记录。' : '请选择检测线体和查询方式。';
    $('mesReportReadTime').textContent = state.report?.fetchedAt ? '门户查询：' + (window.PortalWorkbench?.sourceStamp?.(state.report.fetchedAt) || dateLabel(state.report.fetchedAt)) : '';
  }
  function renderReport() {
    const report = state.report, summary = report?.summary;
    $('mesReportTotalLabel').textContent = report && !complete() ? '已读取检测次数' : '检测次数';
    $('mesReportTotal').textContent = number(summary?.total); $('mesReportOK').textContent = number(summary?.ok); $('mesReportNG').textContent = number(summary?.ng);
    $('mesReportRate').textContent = rateAllowed() ? percent(summary?.passRate) : '—';
    $('mesReportRateNote').textContent = report && !complete() ? '记录不完整，暂不显示合格率' : report && !rateAllowed() ? state.applied?.result !== 'all' ? '按结果筛选，不显示线体合格率' : '工件查询不显示线体合格率' : 'OK / 有明确结论的检测次数';
    const notices = [];
    if (report && !complete()) notices.push('当前记录未完整读取，不能用于该范围的合格率判断。');
    else if (report && !rateAllowed()) notices.push(rateRestriction());
    if (summary?.unknown) notices.push(number(summary.unknown) + ' 次检测没有明确的整件结论，不计入合格率。');
    if (report?.coverage?.note) notices.push(report.coverage.note);
    for (const warning of Array.isArray(report?.warnings) ? report.warnings : []) if (typeof warning === 'string') notices.push(warning);
    $('mesReportCoverage').hidden = !notices.length; $('mesReportCoverage').textContent = [...new Set(notices)].join(' ');
    const query = state.applied;
    const sampleRange = report?.coverage?.firstMeasuredAt && report?.coverage?.lastMeasuredAt ? '记录时段：' + dateLabel(report.coverage.firstMeasuredAt) + ' 至 ' + dateLabel(report.coverage.lastMeasuredAt) : '';
    $('mesReportScope').textContent = query ? [report.line?.name || report.line?.label || '所选线体', query.queryMode === 'count' ? '按数量 · 最近 ' + query.limit + ' 次检测 · 不应用时间筛选' + (sampleRange ? ' · ' + sampleRange : '') : '按时间 · ' + dateLabel(report.filters?.start || query.start) + ' 至 ' + dateLabel(report.filters?.end || query.end) + ' · 时间范围内全部', query.partCode ? '物料：' + (state.facetLabels.parts.get(materialKey(query.partCode, query.productionLine)) || query.partCode + (query.productionLine ? ' · ' + lineLabel(query.productionLine) : '')) : '全部物料', query.deviceCode ? '设备：' + (state.facetLabels.devices.get(query.deviceCode) || query.deviceCode) : '全部设备', query.result === 'all' ? '全部结果' : query.result, query.barcode ? '工件码：' + query.barcode : ''].filter(Boolean).join(' · ') : '查询后展示该范围内的检测记录。';
    renderRows(); renderTrend(); renderStatus(); controls();
  }
  function badge(value) { const result = kind(value); return create('span', result === 'unknown' ? '未判定' : result, 'vis-result ' + result.toLowerCase()); }
  function renderRows() {
    const records = state.report?.records || [], pages = Math.max(1, Math.ceil(records.length / state.size));
    state.page = Math.max(1, Math.min(state.page, pages));
    const body = $('mesReportRows'); body.replaceChildren();
    for (const record of records.slice((state.page - 1) * state.size, state.page * state.size)) {
      const row = create('tr'); const sn = create('td', text(record.barcode), 'mes-report-sn');
      const material = text(record.partName || record.partCode) + (Object.prototype.hasOwnProperty.call(record, 'productionLine') ? ' · ' + lineLabel(record.productionLine) : '');
      row.append(sn, create('td', dateLabel(record.measuredAt), 'mes-report-nowrap'), create('td', material), create('td', text(record.deviceName || record.deviceCode)));
      const result = create('td'); result.append(badge(record.result)); row.append(result);
      const action = create('td'), button = create('button', '测点详情 →', 'mes-report-detail-button'); button.type = 'button'; button.dataset.mesRecordId = String(record.recordId); button.setAttribute('aria-label', '查看 ' + text(record.barcode) + ' ' + dateLabel(record.measuredAt) + ' 的测点详情'); action.append(button); row.append(action); body.append(row);
    }
    $('mesReportTableWrap').hidden = !records.length; $('mesReportRecordsEmpty').hidden = Boolean(records.length);
    $('mesReportRecordsEmpty').textContent = state.report ? '当前查询条件下没有检测记录。' : '尚未查询检测记录。';
    $('mesReportPage').textContent = state.report ? state.page + ' / ' + pages + ' 页 · ' + number(records.length) + ' 次检测' : '—';
    controls();
  }
  function localTimestamp(value) {
    const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(dateLabel(value));
    return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] || 0)) : NaN;
  }
  function bucketLabel(time, minutes) { const date = new Date(time).toISOString(); return minutes >= 1440 ? date.slice(0, 10) : date.slice(0, 16).replace('T', ' '); }
  function trendPoints() {
    const records = state.report?.records || [], stamps = records.map(record => localTimestamp(record.measuredAt)).filter(Number.isFinite);
    const bounds = stamps.reduce((range, value) => [Math.min(range[0], value), Math.max(range[1], value)], [Infinity, -Infinity]);
    const span = stamps.length ? bounds[1] - bounds[0] : 0;
    const selected = ['auto', '5', '15', '30', '60', '1440'].includes($('mesReportInterval').value) ? $('mesReportInterval').value : 'auto';
    const minutes = selected === 'auto' ? span <= 86400000 ? 15 : span <= 7 * 86400000 ? 60 : 1440 : Number(selected);
    const step = minutes * 60000, buckets = new Map(); let missingTime = 0;
    for (const record of records) {
      const timestamp = localTimestamp(record.measuredAt); if (!Number.isFinite(timestamp)) { missingTime++; continue; }
      const time = Math.floor(timestamp / step) * step;
      if (!buckets.has(time)) buckets.set(time, { time, total: 0, ok: 0, ng: 0, unknown: 0 });
      const point = buckets.get(time); point.total++; point[kind(record.result).toLowerCase()]++;
    }
    return { minutes, missingTime, points: [...buckets.values()].sort((a, b) => a.time - b.time).map(point => ({ ...point, denominator: point.ok + point.ng, rate: point.ok + point.ng ? 100 * point.ok / (point.ok + point.ng) : null })) };
  }
  function renderTrend() {
    state.chart = null; state.hoverIndex = -1;
    const chart = $('mesReportChart'); chart.replaceChildren(); $('mesReportTrendDetail').hidden = true;
    const data = state.report && rateAllowed() ? trendPoints() : { points: [] };
    const valid = data.points.filter(point => point.rate !== null);
    chart.hidden = !valid.length; $('mesReportTrendEmpty').hidden = Boolean(valid.length); $('mesReportTrendNote').hidden = !valid.length;
    $('mesReportTrendEmpty').textContent = state.report && !complete() ? '记录未完整读取，暂不绘制合格率曲线。' : state.report && !rateAllowed() ? rateRestriction() : state.report ? '当前范围内没有可绘制的明确检测结论。' : '查询后展示趋势。';
    if (!valid.length) return;
    const minutes = data.minutes, step = minutes * 60000, width = Math.max(540, Math.round(chart.clientWidth || 1000)), height = 260, left = 47, right = 19, top = 18, bottom = 220;
    const first = data.points[0].time, last = data.points.at(-1).time, span = last - first;
    const x = time => span ? left + (time - first) / span * (width - left - right) : (left + width - right) / 2;
    const y = rate => bottom - rate / 100 * (bottom - top);
    const xy = point => x(point.time).toFixed(2) + ',' + y(point.rate).toFixed(2);
    const grid = Array.from({ length: 11 }, (_, index) => '<line class="mes-report-chart-grid ' + (index % 2 ? '' : 'major') + '" x1="' + left + '" x2="' + (width - right) + '" y1="' + y(index * 10) + '" y2="' + y(index * 10) + '"/><text x="' + (left - 9) + '" y="' + (y(index * 10) + 4) + '" text-anchor="end">' + index * 10 + '%</text>').join('');
    const runs = []; let run = [];
    for (const point of data.points) { if (point.rate === null || run.length && point.time - run.at(-1).time !== step) { if (run.length) runs.push(run); run = []; } if (point.rate !== null) run.push(point); }
    if (run.length) runs.push(run);
    const lines = runs.filter(segment => segment.length > 1).map(segment => { const line = 'M' + segment.map(xy).join(' L'); return '<path class="mes-report-chart-area" d="' + line + ' L' + x(segment.at(-1).time) + ',' + bottom + ' L' + x(segment[0].time) + ',' + bottom + ' Z"/><path class="mes-report-chart-line" d="' + line + '"/>'; }).join('');
    const ticks = span ? Math.min(7, Math.max(2, Math.floor((width - left - right) / 130))) : 1;
    const labels = Array.from({ length: ticks }, (_, index) => { const time = span ? first + span * index / (ticks - 1) : first, label = bucketLabel(time, minutes); return '<text x="' + x(time) + '" y="246" text-anchor="middle">' + escape(minutes >= 1440 ? label.slice(5) : span < 86400000 ? label.slice(11) : label.slice(5)) + '</text>'; }).join('');
    const dots = valid.map((point, index) => '<circle class="mes-report-chart-dot" data-mes-point="' + index + '" cx="' + x(point.time) + '" cy="' + y(point.rate) + '" r="' + (valid.length > 120 ? 2 : 3.5) + '" tabindex="' + (index === valid.length - 1 ? 0 : -1) + '" role="button" aria-label="' + escape(bucketLabel(point.time, minutes) + '，合格率 ' + percent(point.rate) + '，可统计 ' + point.denominator + ' 次') + '"/>').join('');
    chart.innerHTML = '<svg viewBox="0 0 ' + width + ' ' + height + '" role="group" aria-label="当前检测记录的合格率趋势，左右方向键查看相邻时段"><defs><linearGradient id="mesReportChartFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#326dd0" stop-opacity=".16"/><stop offset="100%" stop-color="#326dd0" stop-opacity=".01"/></linearGradient></defs>' + grid + lines + labels + '<line id="mesReportCrosshair" class="mes-report-crosshair" x1="0" x2="0" y1="' + top + '" y2="' + bottom + '" hidden/>' + dots + '<circle id="mesReportSelectedPoint" class="mes-report-selected-point" r="5" hidden/></svg><div id="mesReportTooltip" class="mes-report-tooltip" role="tooltip" hidden></div>';
    state.chart = { valid, minutes, width, height, left, right, first, span, x, y, tooltip: $('mesReportTooltip'), svg: chart.querySelector('svg') };
    $('mesReportTrendSubtitle').textContent = '每 ' + (minutes === 1440 ? '天' : minutes === 60 ? '小时' : minutes + ' 分钟') + '汇总 · 与上方统计使用同一批检测记录';
    $('mesReportTrendNote').textContent = '空白时段不连线；未知结论不计入合格率。' + (state.applied?.queryMode === 'count' ? '按数量查询的记录可能只覆盖首尾时段的一部分。' : '') + (data.missingTime ? number(data.missingTime) + ' 条记录缺少检测时间，未绘入曲线。' : '');
    selectPoint(valid.length - 1, false);
  }
  function selectPoint(index, tooltip) {
    const chart = state.chart; if (!chart || index < 0 || index >= chart.valid.length) return;
    const point = chart.valid[index]; state.hoverIndex = index;
    const label = bucketLabel(point.time, chart.minutes), end = chart.minutes >= 1440 ? '' : ' — ' + bucketLabel(point.time + chart.minutes * 60000, chart.minutes).slice(11);
    $('mesReportTrendDetail').hidden = false; $('mesReportTrendDetail').textContent = label + end + '　' + percent(point.rate) + '　合格 ' + point.ok + ' / 可统计 ' + point.denominator + ' 次　NG ' + point.ng + ' 次' + (point.unknown ? '　未判定 ' + point.unknown + ' 次' : '');
    const crosshair = $('mesReportCrosshair'), marker = $('mesReportSelectedPoint'); crosshair.setAttribute('x1', chart.x(point.time)); crosshair.setAttribute('x2', chart.x(point.time)); crosshair.removeAttribute('hidden'); marker.setAttribute('cx', chart.x(point.time)); marker.setAttribute('cy', chart.y(point.rate)); marker.removeAttribute('hidden');
    chart.tooltip.hidden = !tooltip;
    if (tooltip) { chart.tooltip.textContent = label + end + '\n' + percent(point.rate) + '　OK ' + point.ok + ' / ' + point.denominator + '　NG ' + point.ng; const width = $('mesReportChart').clientWidth || chart.width; chart.tooltip.style.left = Math.max(5, Math.min(width - 245, chart.x(point.time) / chart.width * width - 110)) + 'px'; chart.tooltip.style.top = Math.max(4, chart.y(point.rate) / chart.height * ($('mesReportChart').clientHeight || chart.height) - 73) + 'px'; }
  }
  function trackPointer(event) {
    const chart = state.chart; if (!chart) return;
    const bounds = chart.svg.getBoundingClientRect(); if (!bounds.width) return;
    const x = (event.clientX - bounds.left) / bounds.width * chart.width;
    const time = chart.span ? chart.first + Math.max(0, Math.min(1, (x - chart.left) / (chart.width - chart.left - chart.right))) * chart.span : chart.first;
    let left = 0, right = chart.valid.length - 1;
    while (left < right) { const middle = (left + right) >> 1; if (chart.valid[middle].time < time) left = middle + 1; else right = middle; }
    const index = left > 0 && Math.abs(chart.valid[left - 1].time - time) < Math.abs(chart.valid[left].time - time) ? left - 1 : left;
    selectPoint(index, true);
  }
  function renderDetailRows() {
    const detail = state.detail; if (!detail) return;
    const all = detail.measurements, rows = $('mesReportDetailOnlyNG').checked ? all.filter(item => item.result === 'NG') : all;
    const showEquality = all.some(item => item.isEqual === true);
    const head = $('mesReportDetailColumns'); head.replaceChildren();
    for (const name of ['测点名称', '实测值', '下限', '上限', ...(showEquality ? ['指定值要求'] : []), '测点结论']) { const cell = create('th', name); cell.setAttribute('scope', 'col'); head.append(cell); }
    const body = $('mesReportDetailRows'); body.replaceChildren();
    for (const item of rows) {
      const row = create('tr', undefined, item.result === 'NG' ? 'mes-report-point-ng' : '');
      const title = create('th', text(item.name)); title.setAttribute('scope', 'row'); row.append(title, create('td', rawValue(item, 'actual'), 'mes-report-actual'), create('td', rawValue(item, 'lowerLimit')), create('td', rawValue(item, 'upperLimit')));
      if (showEquality) row.append(create('td', item.isEqual === true ? '等于 ' + text(item.expectedValue) : '—'));
      const result = create('td'); result.append(badge(item.result)); if (kind(item.result) === 'unknown' && typeof item.resultRaw === 'string' && item.resultRaw) result.append(create('small', item.resultRaw, 'mes-report-raw-result')); row.append(result); body.append(row);
    }
    const ng = all.filter(item => item.result === 'NG').length, unknown = all.filter(item => kind(item.result) === 'unknown').length;
    $('mesReportDetailCounts').textContent = number(all.length) + ' 项测点 · ' + number(ng) + ' 项 NG' + (unknown ? ' · ' + number(unknown) + ' 项未判定' : '');
    $('mesReportDetailTableWrap').hidden = !rows.length; $('mesReportDetailEmpty').hidden = Boolean(rows.length); $('mesReportDetailEmpty').textContent = all.length ? '本次返回的测点中没有 NG。' : '本条检测记录未返回测点明细。';
  }
  async function openDetail(recordId) {
    if (!visible() || !state.report?.records.some(record => String(record.recordId) === recordId)) return;
    stopTimer(); closeDetail(false); const request = begin('detailRequest'); $('mesReportDetailMessage').textContent = '正在读取本次检测的测点…'; $('mesReportDetailMessage').hidden = false; $('mesReportDetailOnlyNG').checked = false; if (!dialog.open) dialog.showModal(); controls();
    try {
      const body = await api('/local/vision/mes/detail?' + new URLSearchParams({ recordId }), 'detailRequest', request); if (!current('detailRequest', request)) return;
      if (!body || String(body.recordId) !== recordId || !Array.isArray(body.measurements) || body.measurements.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error('测点明细与所选检测记录不一致，请重新打开。');
      state.detail = body; const identity = $('mesReportDetailIdentity'); identity.replaceChildren(); identity.append(create('strong', text(body.barcode)), badge(body.sourceResult || body.result));
      const meta = $('mesReportDetailMeta'); meta.replaceChildren();
      for (const [label, value] of [['检测时间（北京时间）', dateLabel(body.measuredAt)], ['线体', body.lineName], ['设备', body.deviceName], ['工序', body.processName], ['物料', body.partName]]) { const item = create('div'); item.append(create('dt', label), create('dd', text(value))); meta.append(item); }
      const warnings = $('mesReportDetailWarnings'); warnings.replaceChildren(); for (const item of Array.isArray(body.warnings) ? body.warnings : []) if (typeof item === 'string') warnings.append(create('li', item)); warnings.hidden = !warnings.children.length;
      $('mesReportDetailMessage').hidden = true; $('mesReportDetailContent').hidden = false; renderDetailRows();
    } catch (error) { if (current('detailRequest', request) && (error.name !== 'AbortError' || request.timedOut)) $('mesReportDetailMessage').textContent = request.timedOut ? '测点读取超时，请关闭后重试。' : error.message; }
    finally { clearTimeout(request.timeout); if (current('detailRequest', request)) state.detailRequest = null; }
  }
  function reset() {
    stopTimer(); for (const name of ['catalogRequest', 'reportRequest']) cancel(name); closeDetail(false); state.epoch++;
    state.lines = []; state.defaultLineId = ''; state.restoredLine = ''; state.report = null; state.applied = null; state.error = ''; state.page = 1; state.size = 50; state.chart = null; state.reportOpen = false; state.facetLabels = { parts: new Map(), devices: new Map() };
    $('mesReportBarcode').value = ''; $('mesReportLine').replaceChildren(); $('mesReportLine').value = ''; $('mesReportPart').value = ''; $('mesReportDevice').value = ''; $('mesReportResult').value = 'all'; setQueryMode('time'); setLimit('500'); $('mesReportInterval').value = 'auto'; $('mesReportPageSize').value = '50'; $('mesReportHistory').open = false;
    const dates = presetDates('today'); $('mesReportStart').value = dates.start; $('mesReportEnd').value = dates.end;
    materialSearch?.clear?.(); renderFacets(); syncDateMode(); renderReport();
  }
  function setContext(status, selected) {
    const account = status?.authenticated ? status.account : null, oldActive = state.active;
    const accountChanged = account !== state.account;
    if (accountChanged || !status?.authenticated) { clearSaved(state.account); reset(); }
    state.status = status; state.account = account; state.active = Boolean(account && selected);
    if (accountChanged && account) restoreView();
    root.hidden = !state.active;
    if (!state.active) { stopTimer(); cancel('catalogRequest'); cancel('reportRequest'); closeDetail(false); }
    else if (!oldActive || !state.lines.length && !state.catalogRequest) { if (!state.lines.length) loadCatalog(); else if (!state.report && !state.reportRequest) loadReport(fields(), false); else schedule(); }
    host.hidden = !state.active;
    controls();
  }
  $('mesReportForm').addEventListener('submit', event => { event.preventDefault(); loadReport(fields(), true); });
  $('mesReportForm').addEventListener('input', controls); $('mesReportForm').addEventListener('change', controls);
  for (const [id, mode] of [['mesReportModeTime', 'time'], ['mesReportModeCount', 'count']]) $(id).addEventListener('change', () => { setQueryMode(mode); controls(); });
  $('mesReportReset').addEventListener('click', () => { setQueryMode('time'); applyPreset(window.PortalPreferences?.get?.().dateRange || 'today'); setLimit('500'); $('mesReportBarcode').value = ''; $('mesReportDevice').value = ''; $('mesReportPart').value = ''; $('mesReportResult').value = 'all'; materialSearch?.clear?.(); controls(); });
  $('mesReportRefresh').addEventListener('click', () => state.lines.length ? loadReport(state.applied || fields(), false) : loadCatalog());
  $('mesReportInterval').addEventListener('change', () => { renderTrend(); saveView(); controls(); });
  $('mesReportPageSize').addEventListener('change', () => { state.size = Number($('mesReportPageSize').value); state.page = 1; renderRows(); saveView(); });
  $('mesReportPrev').addEventListener('click', () => { state.page--; renderRows(); saveView(); }); $('mesReportNext').addEventListener('click', () => { state.page++; renderRows(); saveView(); });
  $('mesReportExport').addEventListener('click', () => { if (!exportReady()) return; try { stopTimer(); window.PortalReport.open(reportInput()); state.reportOpen = true; controls(); } catch (error) { state.reportOpen = false; state.error = error.message || '报告暂时无法生成，请重新查询后重试。'; renderStatus(); controls(); schedule(); } });
  document.addEventListener('portal:report-open', () => { state.reportOpen = true; stopTimer(); controls(); });
  document.addEventListener('portal:report-close', () => { state.reportOpen = false; schedule(); controls(); });
  document.addEventListener('vision-mes-analysis-busy', () => { stopTimer(); Promise.resolve().then(() => { controls(); schedule(); }); });
  $('mesReportRows').addEventListener('click', event => { const button = event.target.closest('[data-mes-record-id]'); if (button) openDetail(button.dataset.mesRecordId); });
  $('mesReportDetailClose').addEventListener('click', closeDetail); dialog.addEventListener('cancel', event => { event.preventDefault(); closeDetail(); });
  $('mesReportDetailOnlyNG').addEventListener('change', renderDetailRows);
  $('mesReportChart').addEventListener('pointermove', trackPointer); $('mesReportChart').addEventListener('pointerleave', () => { if (state.chart) state.chart.tooltip.hidden = true; });
  $('mesReportChart').addEventListener('focusin', event => { const point = event.target.closest('[data-mes-point]'); if (point) selectPoint(Number(point.dataset.mesPoint), true); });
  $('mesReportChart').addEventListener('keydown', event => { if (!state.chart) return; if (event.key === 'Escape') { state.chart.tooltip.hidden = true; return; } if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const length = state.chart.valid.length, index = event.key === 'Home' ? 0 : event.key === 'End' ? length - 1 : Math.max(0, Math.min(length - 1, state.hoverIndex + (event.key === 'ArrowRight' ? 1 : -1))); selectPoint(index, true); });
  document.addEventListener('visibilitychange', () => { if (!visible()) { stopTimer(); cancel('catalogRequest'); cancel('reportRequest'); controls(); } else if (state.applied) { loadReport(state.applied, false, 'visible'); controls(); } else if (!state.lines.length) loadCatalog(); });
  window.addEventListener('pagehide', () => { stopTimer(); for (const name of ['catalogRequest', 'reportRequest', 'detailRequest']) cancel(name); state.epoch++; });
  let lastWidth = 0;
  if (typeof ResizeObserver === 'function') new ResizeObserver(entries => { const width = Math.round(entries[0].contentRect.width); if (width && width !== lastWidth) { lastWidth = width; if (state.report && visible()) renderTrend(); } }).observe($('mesReportChart'));
  dateFilter = window.PortalFilters?.mountDateRange?.({ mode: $('mesReportRangeMode'), start: $('mesReportStart'), end: $('mesReportEnd'), onDraft: controls, allowAll: false }) || null;
  materialSearch = window.PortalFilters?.enhanceMaterialSelect?.($('mesReportPart')) || null;
  if (!dateFilter) { $('mesReportRangeMode').innerHTML = '<option value="today">今天</option><option value="yesterday">昨天</option><option value="companyWeek">公司周（KW）</option><option value="week">近 7 天</option><option value="month">近 30 天</option><option value="custom">自定义日期</option>'; $('mesReportRangeMode').addEventListener('change', () => { if ($('mesReportRangeMode').value !== 'custom') applyPreset($('mesReportRangeMode').value); }); }
  window.MesVisionReportWorkbench = { setContext, isFileMode: () => false };
})();
