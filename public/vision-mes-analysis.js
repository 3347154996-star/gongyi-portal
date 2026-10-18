(() => {
  'use strict';
  const host = document.getElementById('mesVisionAnalysisHost') || document.getElementById('mesVisionReportWorkbench');
  if (!host) return;
  const $ = id => document.getElementById(id);
  const node = (tag, value, className) => { const element = document.createElement(tag); if (value !== undefined) element.textContent = String(value); if (className) element.className = className; return element; };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[value]));
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const num = (value, digits = 4) => finite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: digits }) : '—';
  const short = (value, length = 24) => { const text = Array.from(String(value || '')); return text.length > length ? text.slice(0, length - 1).join('') + '…' : text.join(''); };
  const epoch = value => typeof value === 'string' ? Date.parse(value.replace(' ', 'T') + (/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? '' : '+08:00')) : NaN;
  const stamp = value => { const time = epoch(value); return Number.isFinite(time) ? new Date(time + 28800000).toISOString().slice(0, 19).replace('T', ' ') : '未提供'; };
  const root = node('section'); root.id = 'mesVisionAnalysis'; root.className = 'mva'; root.hidden = true;
  root.innerHTML = `<section class="vis-panel mva-load-panel"><div class="mva-heading"><div><p class="mva-kicker">测点分析 · 当前查询快照</p><h3>NG 测点与测量趋势</h3><p>完整读取当前检测记录的测点后，查看 NG 排行、测量波动与统计指标。</p></div><div class="mva-actions"><button type="button" class="button primary" id="mvaLoad">加载全部测点</button><button type="button" class="button" id="mvaCancel" hidden>取消</button><button type="button" class="button" id="mvaRelease" hidden>结束分析</button><button type="button" class="button" id="mvaExport" disabled>分析报告 / PDF</button></div></div><p id="mvaStatus" class="mva-status" role="status"></p><progress id="mvaProgress" max="1" value="0" hidden aria-label="测点加载进度"></progress><p id="mvaError" class="mva-error" role="alert" hidden></p><label class="mva-critical"><input type="checkbox" disabled>仅关键测点 <span>来源未提供关键 / 非关键标识，当前包含全部测点。</span></label></section><div id="mvaResults" hidden><div class="mva-overview"><section class="vis-panel"><div class="mva-heading"><div><h3>NG 测点帕累托</h3><p id="mvaParetoNote"></p></div></div><div id="mvaPareto" class="mva-pareto"></div></section><section class="vis-panel"><h3>整件检测结果</h3><div id="mvaPie" class="mva-pie"></div><p class="mva-help">采用公司系统的整件结论；同一件的每次复测分别计数。</p></section></div><section class="vis-panel"><div class="mva-heading"><div><h3>NG 测点排行</h3><p>不同物料、生产线、设备及规格分别统计；点击测点可查看趋势。</p></div><span id="mvaRankCount" class="mva-chip"></span></div><div class="mva-table-wrap"><table><thead><tr><th>排名</th><th>测点 / 范围</th><th>NG 次数</th><th>有结论次数</th><th>NG 占比</th><th></th></tr></thead><tbody id="mvaRankRows"></tbody></table></div><div class="mva-pager"><button type="button" class="button" id="mvaRankPrev">上一页</button><span id="mvaRankPage"></span><button type="button" class="button" id="mvaRankNext">下一页</button></div></section><section class="vis-panel mva-point-panel"><div class="mva-heading"><div><h3>测点实际值趋势</h3><p>北京时间；鼠标移动或左右方向键查看相邻检测。</p></div><label class="mva-axis">横轴<select id="mvaAxis"><option value="time">检测时间</option><option value="sn">工件 SN（检测顺序）</option></select></label></div><div class="mva-point-choice"><label><span>查找测点</span><input id="mvaPointSearch" type="search" autocomplete="off" placeholder="输入测点、物料或设备名称"></label><label><span>选择测点与范围</span><select id="mvaPoint"></select></label></div><div id="mvaPointMeta" class="mva-help"></div><div id="mvaTrend" class="mva-trend" tabindex="0" aria-label="测点实际值趋势，左右方向键查看相邻检测"></div><div id="mvaHover" class="mva-hover" role="status"></div><div id="mvaStats" class="mva-stats"></div><div id="mvaReasons" class="mva-reasons"></div></section><section class="mva-footnote"><strong>前提条件与局限性</strong><ul id="mvaWarnings"></ul></section></div>`;
  host.append(root);
  const dialog = node('dialog'); dialog.id = 'mvaReportDialog'; dialog.className = 'mva-report-dialog'; dialog.setAttribute('aria-labelledby', 'mvaReportTitle');
  dialog.innerHTML = `<div class="mva-heading"><div><h2 id="mvaReportTitle">测点分析报告</h2><p>A4 横向；点击“打印 / 保存 PDF”后，在打印窗口选择保存为 PDF。内容较多时分页。</p></div><div class="mva-actions"><button type="button" class="button primary" id="mvaPrint" disabled>打印 / 保存 PDF</button><button type="button" class="button" id="mvaDownload">下载 HTML</button><button type="button" class="button" id="mvaReportClose">关闭</button></div></div><iframe id="mvaReportFrame" title="测点分析报告预览" sandbox="allow-same-origin allow-modals" referrerpolicy="no-referrer"></iframe>`;
  document.body.append(dialog);
  const state = { active: false, account: null, report: null, query: null, draft: false, contextLoading: false, contextError: '', identity: '', epoch: 0, controller: null, loading: false, model: null, details: [], sourceWarnings: [], detailTimes: [], loaded: 0, errors: [], message: '', error: '', groupId: '', rankPage: 1, chart: null, selectedIndex: -1, busySent: false, exportHtml: '' };
  const snapshot = () => state.report?.analysisSnapshot;
  const held = () => state.loading || Boolean(state.model);
  function busy() { const value = state.active && held(); if (value === state.busySent) return; state.busySent = value; document.dispatchEvent(new CustomEvent('vision-mes-analysis-busy', { detail: { busy: value } })); }
  function exportAllowed() { return state.active && !state.draft && !state.contextLoading && !state.contextError && !state.loading && !state.error && state.model?.complete === true; }
  function reason() { if (state.contextLoading) return '正在查询检测记录；下方分析仍对应上次成功查询，查询完成前暂停加载与导出。'; if (state.contextError) return '本次检测记录查询失败；下方保留上次成功查询的分析，重新查询成功后可继续。'; if (!state.report) return '先查询检测记录，再加载测点。'; if (state.draft) return '筛选已修改，请先应用筛选；当前分析仍对应上次查询。'; if (!window.VisionMesStats?.analyze) return '测点统计组件尚未就绪，请刷新页面。'; if (!snapshot()?.available) return snapshot()?.reason || '当前查询未具备完整测点分析条件，请缩小查询范围后重试。'; return ''; }
  function controls() {
    const blocked = reason(); root.hidden = !state.active; root.setAttribute('aria-busy', String(state.loading));
    $('mvaLoad').disabled = !state.active || Boolean(blocked) || state.loading; $('mvaLoad').textContent = state.model ? '重新加载测点' : '加载全部测点';
    $('mvaCancel').hidden = !state.loading; $('mvaRelease').hidden = !held() || state.loading; $('mvaExport').disabled = !exportAllowed();
    $('mvaProgress').hidden = !state.loading; $('mvaProgress').max = snapshot()?.total || 1; $('mvaProgress').value = state.loaded;
    $('mvaStatus').textContent = state.draft || state.contextLoading || state.contextError ? blocked : state.loading ? '正在读取测点：' + state.loaded + ' / ' + snapshot().total + ' 次检测；分析期间暂停自动刷新。' : state.model ? '已完整读取 ' + state.loaded + ' 次检测的测点。检测范围为冻结查询快照，测点逐批读取；结束分析后恢复自动刷新。' : state.message || blocked || '将读取当前查询的全部 ' + snapshot().total + ' 次检测；需逐批加载，自动刷新会暂时暂停。';
    $('mvaError').hidden = !state.error; $('mvaError').textContent = state.error;
    $('mvaResults').hidden = !state.model?.complete;
    busy();
  }
  function clearReportPreview() { if (dialog.open) dialog.close(); $('mvaReportFrame').srcdoc = ''; state.exportHtml = ''; $('mvaPrint').disabled = true; }
  function stop(message = '') { state.epoch++; state.controller?.abort(); state.controller = null; state.loading = false; state.model = null; state.details = []; state.sourceWarnings = []; state.detailTimes = []; state.loaded = 0; state.errors = []; state.message = message; state.error = ''; state.chart = null; state.groupId = ''; state.rankPage = 1; clearReportPreview(); for (const id of ['mvaRankRows', 'mvaPoint', 'mvaTrend', 'mvaHover', 'mvaStats', 'mvaReasons', 'mvaWarnings', 'mvaPareto', 'mvaPie']) $(id).replaceChildren(); controls(); }
  function setContext(context = {}) {
    const next = context.report?.analysisSnapshot?.snapshotId || '', account = context.account || null;
    const identity = next || (context.report ? String(context.report.fetchedAt || '') + '|' + JSON.stringify(context.query || {}) : '');
    const changed = identity !== state.identity || account !== state.account;
    const active = Boolean(context.active && account);
    if (changed || !active) { state.active = false; stop(); }
    state.identity = identity; state.account = account; state.report = context.report || null; state.query = context.query || null; state.active = active; state.draft = Boolean(context.draft); state.contextLoading = Boolean(context.loading); state.contextError = typeof context.error === 'string' ? context.error : '';
    if ((state.draft || state.contextLoading || state.contextError) && state.loading) stop('查询条件或检测记录状态已改变，已取消测点加载；请重新查询后继续。');
    controls();
  }
  async function load() {
    if (!state.active || reason() || state.loading) return;
    stop(); state.loading = true; const generation = state.epoch, source = snapshot(), controller = new AbortController(); state.controller = controller; controls();
    const items = [], errors = [], sourceWarnings = new Set(), detailTimes = [], seen = new Set(), indexes = new Set(); let offset = 0;
    try {
      if (!Number.isInteger(source.total) || source.total < 1 || source.total > (source.maxRecords || 1000) || source.total !== state.report.records.length || !source.snapshotId) throw new Error('测点快照与当前检测范围不一致，请重新查询。');
      const expected = new Map(state.report.records.map((record, index) => [String(record.recordId), index]));
      while (offset !== null) {
        const response = await fetch('/local/vision/mes/analysis?' + new URLSearchParams({ snapshotId: source.snapshotId, offset: String(offset) }), { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (generation !== state.epoch || !state.active) return;
        let body; try { body = await response.json(); } catch (_) { throw new Error('测点批次返回内容无法读取，请重试。'); }
        if (generation !== state.epoch || !state.active) return;
        if (response.status === 401) { stop('登录已失效，请重新登录。'); document.dispatchEvent(new CustomEvent('portal:session-expired')); return; }
        if (!response.ok) throw new Error(typeof body?.message === 'string' ? body.message.slice(0, 350) : '测点快照暂时无法读取，请重新查询后重试。');
        if (!body || body.snapshotId !== source.snapshotId || body.total !== source.total || body.offset !== offset || !Array.isArray(body.items) || !Array.isArray(body.errors)) throw new Error('测点批次与当前查询快照不一致。');
        const next = body.nextOffset;
        if (next !== null && (!Number.isInteger(next) || next <= offset || next >= source.total)) throw new Error('测点批次顺序无效，未生成分析。');
        const end = next === null ? source.total : next, batch = [...body.items, ...body.errors];
        if (end - offset !== batch.length) throw new Error('测点批次缺少检测记录，未生成分析。');
        for (const item of batch) {
          if (!item || !Number.isInteger(item.index) || item.index < offset || item.index >= end || indexes.has(item.index) || !expected.has(String(item.recordId)) || expected.get(String(item.recordId)) !== item.index || seen.has(String(item.recordId))) throw new Error('测点批次存在重复或范围不符的记录，未生成分析。');
          indexes.add(item.index); seen.add(String(item.recordId));
        }
        for (const warning of Array.isArray(body.warnings) ? body.warnings : []) if (typeof warning === 'string' && warning) sourceWarnings.add(warning);
        for (const item of body.items) { if (!Array.isArray(item.measurements)) throw new Error('测点明细格式无效，未生成分析。'); items.push(item); for (const warning of Array.isArray(item.warnings) ? item.warnings : []) if (typeof warning === 'string' && warning) sourceWarnings.add(warning); if (Number.isFinite(epoch(item.detailFetchedAt))) detailTimes.push(item.detailFetchedAt); }
        errors.push(...body.errors); if (body.complete !== true && !body.errors.length) throw new Error('测点批次尚不完整，未生成分析。');
        state.loaded = indexes.size; controls(); offset = next;
      }
      if (errors.length || items.length !== source.total || seen.size !== source.total) throw new Error(errors.length + ' 次检测的测点读取失败，未生成完整排行或统计。请重试；不会抽样替代。');
      const model = window.VisionMesStats.analyze({ report: state.report, details: items, includeNonCritical: true, topN: 10 });
      if (generation !== state.epoch || !state.active) return;
      if (!model?.complete || !Array.isArray(model.groups)) throw new Error('测点统计无法确认覆盖全部检测，未生成完整分析。');
      state.details = items; state.sourceWarnings = [...sourceWarnings]; state.detailTimes = detailTimes; state.model = model; state.groupId = model.pareto?.items?.[0]?.groupId || model.groups[0]?.id || ''; state.error = ''; state.message = ''; render();
    } catch (error) { if (generation === state.epoch && error.name !== 'AbortError') { state.error = error.message || '测点分析失败，请重试。'; state.message = '本次未取得完整测点数据；可重新加载全部测点。'; state.model = null; } }
    finally { if (generation === state.epoch) { state.loading = false; state.controller = null; controls(); } }
  }
  function pointName(group) { return group?.pointName || group?.name || group?.pointKey || group?.label || '未命名测点'; }
  function pointScope(group) { if (!group) return ''; return [group.partName || group.partCode, group.productionLine === 'unknown' ? '线号待确认' : group.productionLine ? group.productionLine + '线' : '', group.deviceName || group.deviceCode, group.isEqual ? '指定值 ' + num(group.expectedValue) : '规格 ' + num(group.lowerLimit) + ' ～ ' + num(group.upperLimit)].filter(Boolean).join(' · '); }
  function pointLabel(group) { return pointName(group) + (pointScope(group) ? ' · ' + pointScope(group) : ''); }
  function ranking() { return (state.model?.groups || []).slice().sort((a, b) => (b.stats?.ng || 0) - (a.stats?.ng || 0) || pointLabel(a).localeCompare(pointLabel(b), 'zh-CN')); }
  function selected() { return state.model?.groups.find(group => group.id === state.groupId) || null; }
  function paretoSvg() {
    const data = state.model?.pareto, items = data?.items || [];
    if (!items.length) return '<p class="mva-empty">本次完整测点数据没有 NG 判定。</p>';
    const width = Math.max(680, items.length * 49), height = 290, left = 43, right = width - 43, top = 20, bottom = 218, max = Math.max(1, ...items.map(item => item.ng)), step = (right - left) / items.length;
    const x = index => left + step * (index + .5), y = value => bottom - value / max * (bottom - top), pctY = value => bottom - value / 100 * (bottom - top);
    const grid = Array.from({ length: 5 }, (_, index) => { const value = index * max / 4; return '<line class="mva-grid" x1="' + left + '" x2="' + right + '" y1="' + y(value) + '" y2="' + y(value) + '"/><text x="' + (left - 7) + '" y="' + (y(value) + 4) + '" text-anchor="end">' + num(value, 1) + '</text><text x="' + (right + 7) + '" y="' + (y(value) + 4) + '">' + index * 25 + '%</text>'; }).join('');
    const names = items.map(item => pointName(state.model.groups.find(group => group.id === item.groupId)));
    const bars = items.map((item, index) => { const group = state.model.groups.find(group => group.id === item.groupId), name = group ? pointName(group) : item.name, full = (group ? pointLabel(group) : item.name) + '：NG ' + item.ng + ' 次，累计 ' + num(item.cumulativePercent, 1) + '%', repeated = names.filter(value => value === name).length > 1, extra = repeated && group ? [group.productionLine && group.productionLine !== 'unknown' ? group.productionLine + '线' : '待确认', group.deviceName || group.deviceCode].filter(Boolean).join(' · ') : ''; return '<g role="img" aria-label="' + esc(full) + '"><title>' + esc(full) + '</title><rect class="mva-bar" x="' + (x(index) - step * .3) + '" y="' + y(item.ng) + '" width="' + step * .6 + '" height="' + (bottom - y(item.ng)) + '"/><text x="' + x(index) + '" y="' + (y(item.ng) - 6) + '" text-anchor="middle">' + num(item.ng, 0) + '</text><text transform="translate(' + x(index) + ',238) rotate(-25)" text-anchor="end">' + esc(short(name, 14)) + (extra ? '<tspan x="0" dy="13">' + esc(short(extra, 14)) + '</tspan>' : '') + '</text></g>'; }).join('');
    return '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="NG 测点次数与累计比例帕累托图">' + grid + bars + '<polyline class="mva-cumulative" points="' + items.map((item, index) => x(index) + ',' + pctY(item.cumulativePercent)).join(' ') + '"/>' + items.map((item, index) => '<circle class="mva-cumulative-dot" cx="' + x(index) + '" cy="' + pctY(item.cumulativePercent) + '" r="3"/>').join('') + '</svg>';
  }
  function pieSvg() {
    const pie = state.model?.pie || {}, total = pie.total || 0, data = [['OK', pie.ok || 0, '#2582bb'], ['NG', pie.ng || 0, '#d16b48'], ['未判定', pie.unknown || 0, '#a2afbf']]; let offset = 0;
    const arcs = data.map(([name, value, color]) => { const portion = total ? value / total : 0, arc = '<circle cx="110" cy="105" r="72" fill="none" stroke="' + color + '" stroke-width="22" pathLength="100" stroke-dasharray="' + portion * 100 + ' ' + (100 - portion * 100) + '" stroke-dashoffset="' + (-offset) + '" transform="rotate(-90 110 105)"/>'; offset += portion * 100; return arc; }).join('');
    const summary = state.report?.summary, limited = [state.query, state.report?.filters].some(filters => filters?.barcode || filters?.result && filters.result !== 'all'), rateAllowed = state.report?.coverage?.complete === true && state.report?.coverage?.eligibleForLineRate === true && !limited && finite(summary?.passRate) && summary.denominator > 0;
    const rate = '<div class="mva-pie-rate"><span>检测合格率</span><strong>' + (rateAllowed ? summary.passRate.toFixed(1) + '%' : '—') + '</strong><small>' + (rateAllowed ? 'OK ' + num(summary.ok, 0) + ' / 有明确整件结论 ' + num(summary.denominator, 0) + ' 次' : '当前限定范围不显示线体合格率') + '</small></div>';
    return '<svg viewBox="0 0 220 210" role="img" aria-label="整件 OK、NG 与未判定检测数量"><circle cx="110" cy="105" r="72" fill="none" stroke="#edf1f7" stroke-width="22"/>' + arcs + '<text x="110" y="106" text-anchor="middle" class="mva-pie-total">' + num(total, 0) + '</text><text x="110" y="129" text-anchor="middle">次检测</text></svg><div class="mva-pie-details"><div class="mva-pie-legend">' + data.map(([name, value, color]) => '<span><i style="background:' + color + '"></i>' + name + '<strong>' + num(value, 0) + '</strong></span>').join('') + '</div>' + rate + '</div>';
  }
  function renderRank() {
    const rows = ranking(), pages = Math.max(1, Math.ceil(rows.length / 20)); state.rankPage = Math.min(pages, Math.max(1, state.rankPage));
    const body = $('mvaRankRows'); body.replaceChildren();
    rows.slice((state.rankPage - 1) * 20, state.rankPage * 20).forEach((group, index) => { const tr = node('tr'), identity = node('td'); identity.append(node('strong', pointName(group), 'mva-point-name'), node('small', pointScope(group), 'mva-point-scope')); tr.append(node('td', (state.rankPage - 1) * 20 + index + 1), identity, node('td', num(group.stats.ng, 0), group.stats.ng ? 'mva-ng' : ''), node('td', num(group.stats.validObserved, 0)), node('td', finite(group.stats.ngRate) ? num(group.stats.ngRate, 2) + '%' : '—')); const td = node('td'), button = node('button', '查看趋势', 'mva-link'); button.type = 'button'; button.dataset.groupId = group.id; td.append(button); tr.append(td); body.append(tr); });
    if (!rows.length) { const tr = node('tr'), td = node('td', '没有可分析的命名测点。'); td.colSpan = 6; tr.append(td); body.append(tr); }
    $('mvaRankCount').textContent = rows.length + ' 组测点 · 含 0 NG'; $('mvaRankPage').textContent = state.rankPage + ' / ' + pages + ' 页'; $('mvaRankPrev').disabled = state.rankPage <= 1; $('mvaRankNext').disabled = state.rankPage >= pages;
  }
  function renderOptions() { const needle = $('mvaPointSearch').value.trim().toLocaleLowerCase(), select = $('mvaPoint'); select.replaceChildren(); for (const group of state.model?.groups || []) { const label = pointLabel(group); if (needle && !String(label).toLocaleLowerCase().includes(needle) && group.id !== state.groupId) continue; const option = node('option', label); option.value = group.id; select.append(option); } select.value = state.groupId; }
  function statEntries(group) { const value = group?.stats || {}; return [['样本数', value.n], ['平均值 Avg', value.avg], ['最大值 Max', value.max], ['最小值 Min', value.min], ['极差 Range', value.range], ['标准差 Std', value.std], ['OK', value.ok], ['NG', value.ng], ['未判定', value.unknown], ['Pp', value.pp], ['Ppk', value.ppk]]; }
  function groupNotes(group) { return [group.capability?.available ? 'Pp / Ppk 为本次样本的估计值，不能据此证明过程稳定。' : group.capability?.reason, group.control?.available ? group.control.label || '控制线为当前样本估计，请结合过程稳定性判断。' : group.control?.reason, ...(group.capability?.warnings || []), ...(group.control?.warnings || [])].filter(value => typeof value === 'string' && value); }
  function trendData(group, width = 1000) {
    const observations = group?.observations || [], useTime = $('mvaAxis').value !== 'sn', valid = observations.map((item, index) => ({ item, index, time: epoch(item.measuredAt) })).filter(row => finite(row.item.actual));
    if (!valid.length) return null;
    const lines = [['上规格 USL', group.upperLimit, '#c97632', false], ['下规格 LSL', group.lowerLimit, '#c97632', false], ...(group.control?.available ? [['估计上控制线', group.control.ucl, '#7986bb', true], ['估计中心线', group.control.mean, '#6c9b7a', true], ['估计下控制线', group.control.lcl, '#7986bb', true]] : [])].filter(line => finite(line[1]));
    const values = [...valid.map(row => row.item.actual), ...lines.map(line => line[1])]; let min = Math.min(...values), max = Math.max(...values); const padding = (max - min || Math.max(Math.abs(max) * .05, .1)) * .12; min -= padding; max += padding;
    const times = valid.map(row => row.time).filter(Number.isFinite), lowTime = times.length ? Math.min(...times) : 0, highTime = times.length ? Math.max(...times) : 0;
    const left = 62, right = width - 28, top = 24, bottom = 251;
    const x = row => useTime && Number.isFinite(row.time) && highTime > lowTime ? left + (row.time - lowTime) / (highTime - lowTime) * (right - left) : observations.length > 1 ? left + row.index / (observations.length - 1) * (right - left) : (left + right) / 2;
    const y = value => bottom - (value - min) / (max - min) * (bottom - top);
    return { valid, observations, useTime, min, max, x, y, width, height: 300, left, right, top, bottom, lines };
  }
  function trendSvg(chart) {
    if (!chart) return '<p class="mva-empty">该测点没有可绘制的数值，缺失值未补为 0。</p>';
    const { valid, x, y, lines, min, max, left, right, top, bottom, width } = chart;
    const grid = Array.from({ length: 6 }, (_, index) => { const value = min + (max - min) * index / 5; return '<line class="mva-grid" x1="' + left + '" x2="' + right + '" y1="' + y(value) + '" y2="' + y(value) + '"/><text x="' + (left - 8) + '" y="' + (y(value) + 4) + '" text-anchor="end">' + num(value, 3) + '</text>'; }).join('');
    let previous = -2; const path = valid.map(row => { const command = row.index === previous + 1 ? 'L' : 'M'; previous = row.index; return command + x(row).toFixed(2) + ',' + y(row.item.actual).toFixed(2); }).join(' ');
    const references = lines.map(([label, value, color, dashed]) => '<line x1="' + left + '" x2="' + right + '" y1="' + y(value) + '" y2="' + y(value) + '" stroke="' + color + '" stroke-width="1.3"' + (dashed ? ' stroke-dasharray="5 4"' : '') + '/><text x="' + (right - 3) + '" y="' + (y(value) - 5) + '" text-anchor="end" fill="' + color + '">' + esc(label) + ' ' + num(value, 4) + '</text>').join('');
    const labelIndexes = [...new Set(Array.from({ length: Math.min(5, valid.length) }, (_, index) => Math.round(index * (valid.length - 1) / Math.max(1, Math.min(5, valid.length) - 1))))];
    const labels = labelIndexes.map((index, tick) => { const row = valid[index], label = chart.useTime ? stamp(row.item.measuredAt).slice(5, 16) : short(row.item.barcode || row.item.recordId, 16), anchor = labelIndexes.length === 1 ? 'middle' : tick === 0 ? 'start' : tick === labelIndexes.length - 1 ? 'end' : 'middle'; return '<text x="' + x(row) + '" y="280" text-anchor="' + anchor + '">' + esc(label) + '</text>'; }).join('');
    return '<svg viewBox="0 0 ' + width + ' 300" role="img" aria-label="测点实测值、规格限与估计控制线">' + grid + references + '<path class="mva-value-line" d="' + path + '"/>' + valid.map(row => '<circle class="mva-value-dot ' + (row.item.result === 'NG' ? 'ng' : row.item.result === 'OK' ? 'ok' : 'unknown') + '" cx="' + x(row) + '" cy="' + y(row.item.actual) + '" r="' + (valid.length > 200 ? 2 : 3) + '"/>').join('') + labels + '<line id="mvaCrosshair" class="mva-crosshair" x1="0" x2="0" y1="' + top + '" y2="' + bottom + '" hidden/><circle id="mvaMarker" class="mva-marker" r="5" hidden/></svg><div id="mvaTooltip" class="mva-tooltip" hidden></div>';
  }
  function showObservation(index, tooltip = false) {
    const chart = state.chart; if (!chart || !chart.valid[index]) return; state.selectedIndex = index;
    const row = chart.valid[index], value = row.item, label = stamp(value.measuredAt) + '　SN ' + (value.barcode || '未提供') + '　实测 ' + num(value.actual, 6) + '　' + (['OK', 'NG'].includes(value.result) ? value.result : '未判定');
    $('mvaHover').textContent = label;
    const marker = $('mvaMarker'), cross = $('mvaCrosshair'); marker.setAttribute('cx', chart.x(row)); marker.setAttribute('cy', chart.y(value.actual)); marker.removeAttribute('hidden'); cross.setAttribute('x1', chart.x(row)); cross.setAttribute('x2', chart.x(row)); cross.removeAttribute('hidden');
    const tip = $('mvaTooltip'); tip.hidden = !tooltip; tip.textContent = label; tip.style.left = Math.max(6, Math.min(chart.width - 285, chart.x(row) - 135)) / chart.width * 100 + '%'; tip.style.top = Math.max(6, chart.y(value.actual) - 78) + 'px';
  }
  function renderPoint() {
    const group = selected(); $('mvaStats').replaceChildren(); $('mvaReasons').replaceChildren(); state.chart = null; state.selectedIndex = -1; $('mvaHover').textContent = '';
    if (!group) { $('mvaTrend').innerHTML = '<p class="mva-empty">当前查询没有可分析的命名测点。</p>'; $('mvaPointMeta').textContent = ''; return; }
    $('mvaPointMeta').textContent = pointLabel(group) + ' · 单位：' + (group.unit || '来源未提供');
    const chart = trendData(group, Math.max(640, $('mvaTrend').clientWidth || 1000)); state.chart = chart; $('mvaTrend').innerHTML = trendSvg(chart);
    for (const [label, value] of statEntries(group)) { const item = node('div'); item.append(node('span', label), node('strong', num(value, label === 'Pp' || label === 'Ppk' ? 3 : 5))); $('mvaStats').append(item); }
    for (const message of groupNotes(group)) $('mvaReasons').append(node('p', message));
    if (chart) showObservation(chart.valid.length - 1);
  }
  function render() {
    $('mvaPareto').innerHTML = paretoSvg(); $('mvaPie').innerHTML = pieSvg();
    const pareto = state.model.pareto || {}; $('mvaParetoNote').textContent = '柱：NG 次数 · 曲线：累计 NG 比例。前 ' + (pareto.items?.length || 0) + ' 组；全部 NG ' + num(pareto.totalNG, 0) + ' 次' + (pareto.otherNG ? '，其余 ' + num(pareto.otherNG, 0) + ' 次。' : '。');
    $('mvaWarnings').replaceChildren(); for (const message of analysisWarnings()) $('mvaWarnings').append(node('li', message));
    renderRank(); renderOptions(); renderPoint(); controls();
  }
  function analysisWarnings() {
    const times = state.detailTimes.map(epoch).sort((a, b) => a - b), timeNote = times.length ? '测点读取时间：' + stamp(new Date(times[0]).toISOString()) + ' 至 ' + stamp(new Date(times.at(-1)).toISOString()) + '（北京时间），与工件检测时间不同。' : '';
    const normalize = value => {
      if (typeof value !== 'string' || !value) return '';
      if (/^此批完整不等于全范围完整/.test(value) && state.model?.complete) return '';
      if (/事务快照|其他批次的读取时刻/.test(value)) return '检测范围已固定，测点分批读取，并非同一时刻的状态；读取完整不证明现场上传完整。';
      if (/detailFetchedAt|(?:五|5)\s*分钟内.*缓存|缓存.*(?:五|5)\s*分钟/.test(value)) return '部分测点可能使用最近 5 分钟内的读取结果，实际读取时间如下。';
      if (/critical|来源未.*关键|来源未明确.*是否关键/.test(value)) return '来源未提供关键测点标识，当前包含全部测点。';
      if (/测点 NG.*(?:工件|判定)|复测不合并/.test(value)) return '整件结论与测点 NG 分别统计；同件复测分别计次。';
      if (/来源.*单位.*(?:不补|未自动)/.test(value)) return '来源未提供单位；实测值不自动当作毫米或尺寸偏差。';
      if (/^\d+ 项无测点名称的采集字段/.test(value)) return '未配置测点名称的采集状态项不计入测点。';
      if (/^\d+ 项实际值缺失/.test(value)) return '部分实测值缺失或无法识别，未补为 0。';
      if (/^\d+ 项缺少完整判定范围/.test(value)) return '部分测点未提供完整规格范围。';
      if (/数值范围与来源判定不一致/.test(value)) return '部分实测值与来源判定不一致，保留来源原判定。';
      return value;
    };
    return [...new Set(['检测范围已固定，测点分批读取，并非同一时刻的状态；读取完整不证明现场上传完整。', ...state.sourceWarnings, ...(state.model?.warnings || []), timeNote].map(normalize))].filter(Boolean);
  }
  function reportHtml() {
    const group = selected(), rank = ranking(), model = state.model, query = state.query || {}, records = state.report.records;
    const times = records.map(record => epoch(record.measuredAt)).filter(Number.isFinite), actualRange = times.length ? stamp(new Date(Math.min(...times)).toISOString()) + ' 至 ' + stamp(new Date(Math.max(...times)).toISOString()) : '未提供';
    const scope = query.queryMode === 'count' ? '按数量：最近 ' + query.limit + ' 次；不应用页面日期筛选' : '按时间：' + stamp(state.report.filters?.start || query.start) + ' 至 ' + stamp(state.report.filters?.end || query.end);
    const warnings = [...new Set([...analysisWarnings(), ...(group ? groupNotes(group) : [])])];
    const style = '@page{size:A4 landscape;margin:12mm}*{box-sizing:border-box}body{margin:0;font:12px/1.6 system-ui,"Microsoft YaHei",sans-serif;color:#294b70}main{max-width:1120px;margin:auto;padding:24px}h1{font-size:24px}h2{font-size:17px;margin:22px 0 10px}p{margin:6px 0;color:#647c95}section{break-inside:avoid}svg{width:100%;max-height:300px;display:block}svg text{font:10px system-ui;fill:#69809a}.pair{display:grid;grid-template-columns:3fr 1fr;gap:22px}.mva-pie-total{font-size:28px;font-weight:700}.mva-pie-legend span{display:flex;gap:10px}.mva-pie-legend i{width:10px;height:10px;display:inline-block}.mva-pie-rate{margin-top:12px;border-top:1px solid #dde5ee;padding-top:8px}.mva-pie-rate>span,.mva-pie-rate>small{display:block;font-size:10px}.mva-pie-rate>strong{display:block;font-size:22px;color:#315f8b}.mva-grid{stroke:#e7edf4;stroke-dasharray:3 4}.mva-bar{fill:#3b7dc3}.mva-cumulative{stroke:#dc8c3c;fill:none;stroke-width:2}.mva-cumulative-dot{fill:#dc8c3c}.mva-value-line{fill:none;stroke:#2f83bb;stroke-width:1.5}.mva-value-dot{fill:#2f83bb}.mva-value-dot.ng{fill:#d76d42}.mva-value-dot.unknown{fill:#9eacbb}.mva-tooltip,[hidden]{display:none!important}table{width:100%;border-collapse:collapse;font-size:11px}th,td{text-align:left;padding:7px 9px;border-bottom:1px solid #dce5ee}th{background:#f2f6fb}thead{display:table-header-group}tr{break-inside:avoid}.stats{display:grid;grid-template-columns:repeat(6,1fr);gap:8px}.stats>div{border:1px solid #dbe5ef;padding:8px}.stats strong{display:block;font-size:17px}ul{padding-left:18px}.foot{font-size:10px;margin-top:16px}@media print{main{padding:0;max-width:none}h2{break-after:avoid}}';
    const rankRows = rank.map((item, index) => '<tr><td>' + (index + 1) + '</td><td>' + esc(pointLabel(item)) + '</td><td>' + num(item.stats.ng, 0) + '</td><td>' + num(item.stats.validObserved, 0) + '</td><td>' + (finite(item.stats.ngRate) ? num(item.stats.ngRate, 2) + '%' : '—') + '</td></tr>').join('');
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><title>公司测点分析报告</title><style>' + style + '</style></head><body><main><h1>公司测点分析报告</h1><p>' + esc(state.report.line?.name || '所选检测线体') + ' · ' + esc(scope) + '</p><p>实际记录：' + esc(actualRange) + ' · 完整检测 ' + records.length + ' 次 · 查询时间 ' + esc(stamp(state.report.fetchedAt)) + '（北京时间）</p><p>物料 ' + esc(query.partCode || '全部') + ' · 生产线号 ' + esc(query.productionLine === 'unknown' ? '线号待确认' : query.productionLine || '全部') + ' · 设备 ' + esc(query.deviceCode || '全部') + ' · 整件结果 ' + esc(!query.result || query.result === 'all' ? '全部结果' : query.result) + (query.barcode ? ' · 工件 ' + esc(query.barcode) : '') + '</p><section class="pair"><div><h2>NG 测点帕累托 · 前 ' + (model.pareto?.items?.length || 0) + ' 组</h2>' + paretoSvg() + '<p>全部测点 NG ' + num(model.pareto?.totalNG, 0) + ' 次；图外其余 ' + num(model.pareto?.otherNG || 0, 0) + ' 次。</p></div><div><h2>整件检测结果</h2>' + pieSvg() + '</div></section>' + (group ? '<section><h2>测点趋势 · ' + esc(pointLabel(group)) + '</h2><p>横轴：' + ($('mvaAxis').value === 'sn' ? '工件 SN（检测顺序）' : '检测时间') + ' · 单位：' + esc(group.unit || '来源未提供') + ' · 规格：' + num(group.lowerLimit) + ' ～ ' + num(group.upperLimit) + '</p>' + trendSvg(trendData(group, 1000)) + '<div class="stats">' + statEntries(group).map(([label, value]) => '<div>' + esc(label) + '<strong>' + num(value, 5) + '</strong></div>').join('') + '</div></section>' : '') + '<h2>完整测点 NG 排行（含 0 NG）</h2><table><thead><tr><th>排名</th><th>测点 / 范围</th><th>NG 次数</th><th>有结论次数</th><th>NG 占比</th></tr></thead><tbody>' + (rankRows || '<tr><td colspan="5">本次测点没有 NG 判定。</td></tr>') + '</tbody></table><section><h2>前提条件与局限性</h2><ul>' + warnings.map(value => '<li>' + esc(value) + '</li>').join('') + '</ul></section><p class="foot">来源：公司 MES 查询快照。关键 / 非关键标识未提供，当前包含全部测点。生成时间：' + esc(stamp(new Date().toISOString())) + '。</p></main></body></html>';
  }
  $('mvaLoad').addEventListener('click', load); $('mvaCancel').addEventListener('click', () => stop('已取消测点加载，未生成分析。')); $('mvaRelease').addEventListener('click', () => stop('已结束分析，自动刷新已恢复。'));
  $('mvaRankPrev').addEventListener('click', () => { state.rankPage--; renderRank(); }); $('mvaRankNext').addEventListener('click', () => { state.rankPage++; renderRank(); });
  $('mvaRankRows').addEventListener('click', event => { const button = event.target.closest('[data-group-id]'); if (button && state.model?.groups.some(group => group.id === button.dataset.groupId)) { state.groupId = button.dataset.groupId; renderOptions(); renderPoint(); $('mvaTrend').focus(); } });
  $('mvaPointSearch').addEventListener('input', renderOptions); $('mvaPoint').addEventListener('change', () => { state.groupId = $('mvaPoint').value; renderPoint(); }); $('mvaAxis').addEventListener('change', renderPoint);
  $('mvaTrend').addEventListener('pointermove', event => { const chart = state.chart; if (!chart) return; const bounds = $('mvaTrend').getBoundingClientRect(), x = (event.clientX - bounds.left) / bounds.width * chart.width; let best = 0, distance = Infinity; for (let index = 0; index < chart.valid.length; index++) { const gap = Math.abs(chart.x(chart.valid[index]) - x); if (gap < distance) { distance = gap; best = index; } } showObservation(best, true); });
  $('mvaTrend').addEventListener('pointerleave', () => { if (state.chart) $('mvaTooltip').hidden = true; });
  $('mvaTrend').addEventListener('keydown', event => { if (!state.chart) return; if (event.key === 'Escape') { $('mvaTooltip').hidden = true; return; } if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const last = state.chart.valid.length - 1; showObservation(event.key === 'Home' ? 0 : event.key === 'End' ? last : Math.max(0, Math.min(last, state.selectedIndex + (event.key === 'ArrowRight' ? 1 : -1))), true); });
  $('mvaExport').addEventListener('click', () => { if (!exportAllowed()) return; state.exportHtml = reportHtml(); $('mvaPrint').disabled = true; $('mvaReportFrame').srcdoc = state.exportHtml; dialog.showModal(); });
  $('mvaReportFrame').addEventListener('load', () => { $('mvaPrint').disabled = !state.exportHtml; });
  $('mvaPrint').addEventListener('click', () => { if (!state.exportHtml || $('mvaPrint').disabled) return; $('mvaReportFrame').contentWindow?.focus(); $('mvaReportFrame').contentWindow?.print(); });
  $('mvaDownload').addEventListener('click', () => { if (!state.exportHtml) return; const url = URL.createObjectURL(new Blob([state.exportHtml], { type: 'text/html;charset=utf-8' })), link = node('a'); link.href = url; link.download = '公司测点分析-' + new Date().toISOString().slice(0, 10) + '.html'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); });
  $('mvaReportClose').addEventListener('click', clearReportPreview); dialog.addEventListener('cancel', event => { event.preventDefault(); clearReportPreview(); });
  window.addEventListener('pagehide', () => stop());
  window.MesVisionAnalysis = { setContext, isBusy: () => state.active && held() };
})();
