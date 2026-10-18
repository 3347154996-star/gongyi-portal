(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PortalReport = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';
  const TOP_LIMIT = 5, TREND_LIMIT = 8;
  const COLORS = ['#087dc2', '#20b6c8', '#6ea944', '#9b75c1', '#ed9862', '#7894ae'];
  const calendar = root.PortalCalendar || (typeof require === 'function' ? require('./company-calendar.js') : null);
  const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const ratio = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
  const text = value => typeof value === 'string' ? value : '';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const number = value => count(value) ? value.toLocaleString('zh-CN') : '—';
  const percent = value => ratio(value) ? (value * 100).toFixed(1) + '%' : '—';
  const list = value => Array.isArray(value) ? value : [];
  const validDay = value => { const day = new Date(text(value) + 'T00:00:00Z');return /^\d{4}-\d{2}-\d{2}$/.test(text(value)) && Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value; };
  const shortened = (value, limit = 70) => { const chars = Array.from(text(value)); return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : chars.join(''); };
  const selection = (value, fallback) => value && value !== 'all' ? text(value) : fallback;
  function timestamp(value) {
    if (value === null || value === undefined || value === '') return '未提供';
    // Device dates without a zone are wall-clock values, not UTC instants.
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.test(value)) return value.replace('T', ' ');
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '未提供' : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  }
  function getProblem(input) {
    if (!input || !['weld', 'vision', 'vision-mes'].includes(input.kind)) return '请选择补焊点或视觉检具报告。';
    if (!input.query || typeof input.query !== 'object' || !input.loadedAt || Number.isNaN(new Date(input.loadedAt).getTime())) return '请先查询并成功读取数据，再导出报告。';
    if (!input.report || typeof input.report !== 'object') return '尚未取得完整统计接口的数据，请先查询。';
    if (input.kind === 'vision-mes') return mesProblem(input);
    if (input.kind === 'weld') {
      const v = input.report.overview;
      if (!v || !count(v.recordCount) || !count(v.pieceCount) || v.pieceCount > v.recordCount) return '补焊汇总数据缺失或不一致，无法生成报告。';
    } else {
      const v = input.report.summary;
      if (input.report.scope?.pending || input.report.source?.state === 'pending') return '所选检具尚未接入，暂无可导出的检测数据。';
      if (!v || !['totalRecords', 'eligibleRecords', 'okRecords', 'ngRecords', 'conflictRecords'].every(key => count(v[key])) || v.okRecords + v.ngRecords !== v.eligibleRecords || v.eligibleRecords + v.conflictRecords !== v.totalRecords) return '检测汇总数据缺失或分母不一致，请刷新后重试。';
      if (v.passRate !== null && v.passRate !== undefined && (!ratio(v.passRate) || !v.eligibleRecords || Math.abs(v.passRate - v.okRecords / v.eligibleRecords) > 1e-8)) return '合格率与检测汇总不一致，请刷新后重试。';
    }
    return '';
  }
  function canOpen(input) { return !getProblem(input); }
  // MES reports contain a complete selected record set, unlike the paginated
  // legacy vision API. Validate that set before calculating any export totals.
  function mesTime(value) {
    if (typeof value !== 'string') return NaN;
    const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,7})?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
    if (!match || !validDay(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] || 0) > 59) return NaN;
    return Date.parse(value.replace(' ', 'T') + (match[5] ? '' : '+08:00'));
  }
  function mesInterval(input) {
    const value = input.interval ?? 'auto';
    if (value === 'auto') {
      const bounds = input.report.records.reduce((range, record) => { const value = Math.floor(mesTime(record.measuredAt) / 1000) * 1000;return [Math.min(range[0], value), Math.max(range[1], value)]; }, [Infinity, -Infinity]);
      const span = bounds[1] - bounds[0];
      return span <= 86400000 ? 15 : span <= 7 * 86400000 ? 60 : 1440;
    }
    const minutes = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
    return [5, 15, 30, 60, 1440].includes(minutes) ? minutes : null;
  }
  function mesStamp(value) {
    if (validDay(value)) return value;
    const epoch = typeof value === 'number' ? value : mesTime(value);
    return Number.isFinite(epoch) ? new Date(epoch + 28800000).toISOString().slice(0, 19).replace('T', ' ') : '未提供';
  }
  function mesProblem(input) {
    const report = input.report, summary = report.summary;
    if (report.coverage?.complete !== true) return '公司检测记录尚未完整读取，请查询成功后再导出。';
    if (!Array.isArray(report.records) || !report.records.length) return '当前筛选没有检测记录，暂无可导出的报告。';
    if (!summary || !['total', 'ok', 'ng', 'unknown', 'denominator'].every(key => count(summary[key])) || summary.total !== report.records.length || summary.ok + summary.ng !== summary.denominator || summary.denominator + summary.unknown !== summary.total) return '公司检测汇总与全部筛选记录不一致，不能从当前分页生成报告。';
    const counts = { ok: 0, ng: 0, unknown: 0 }, ids = new Set();
    for (const record of report.records) {
      if (!record || typeof record !== 'object' || typeof record.recordId !== 'string' || !record.recordId.trim() || ids.has(record.recordId) || !['OK', 'NG', null].includes(record.result) || !Number.isFinite(mesTime(record.measuredAt))) return '公司检测记录标识、时间或结论无效，请重新查询。';
      ids.add(record.recordId);counts[record.result === 'OK' ? 'ok' : record.result === 'NG' ? 'ng' : 'unknown']++;
    }
    if (Object.keys(counts).some(key => counts[key] !== summary[key])) return '公司检测汇总与逐次检测结论不一致，请重新查询。';
    if (summary.passRate != null && (typeof summary.passRate !== 'number' || !Number.isFinite(summary.passRate) || summary.passRate < 0 || summary.passRate > 100 || !summary.denominator || Math.abs(summary.passRate - summary.ok / summary.denominator * 100) > 1e-8)) return '公司检测合格率与汇总不一致，请重新查询。';
    if (mesInterval(input) === null) return '请选择有效的报告统计间隔。';
    return '';
  }
  function mesLimited(input) {
    return [input.query, input.report.filters].some(filters => Boolean(text(filters?.barcode).trim()) || Boolean(filters?.result && filters.result !== 'all'));
  }
  function mesGroups(records, field, showRate) {
    const groups = new Map();
    for (const record of records) {
      const code = text(record[field + 'Code']), name = text(record[field + 'Name']), productionLine = /^\d+$/.test(text(record.productionLine)) ? record.productionLine : 'unknown';
      const identity = code || name || '', key = field === 'part' ? identity + '\0' + productionLine : identity;
      const label = (name || code || '未提供') + (field === 'part' ? ' · ' + (productionLine === 'unknown' ? '生产线号待确认' : '生产 ' + productionLine + ' 线') : '');
      if (!groups.has(key)) groups.set(key, { name: label, code, productionLine: field === 'part' ? productionLine : null, count: 0, ok: 0, ng: 0, unknown: 0, missing: !identity });
      const group = groups.get(key);group.count++;group[record.result === 'OK' ? 'ok' : record.result === 'NG' ? 'ng' : 'unknown']++;
    }
    return [...groups.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN')).map(group => ({ ...group, share: showRate && !group.unknown && group.ok + group.ng ? group.ok / (group.ok + group.ng) : null }));
  }
  function mesScope(input) {
    const filters = { ...input.query, ...input.report.filters }, line = input.report.line || {};
    const selectedName = field => {
      const code = filters[field + 'Code'];
      if (!code || code === 'all') return field === 'part' ? '全部物料' : '全部设备';
      const record = input.report.records.find(item => item[field + 'Code'] === code);
      return record?.[field + 'Name'] ? text(record[field + 'Name']) + '（' + text(code) + '）' : text(code);
    };
    const limit = Number(filters.limit) || 0, byCount = filters.queryMode === 'count';
    const times = byCount ? input.report.records.map(record => mesTime(record.measuredAt)).sort((a, b) => a - b) : [];
    const timeFields = byCount ? [['查询方式', '按数量 · 不受日期筛选限制'], ['读取截至', mesStamp(filters.end || input.report.fetchedAt || input.loadedAt)], ['本次记录时段', mesStamp(times[0]) + ' 至 ' + mesStamp(times.at(-1))]] : [['查询方式', '按时间'], ['时间', mesStamp(filters.start) + ' 至 ' + mesStamp(filters.end)]];
    const productionLine = !filters.productionLine || filters.productionLine === 'all' ? '全部生产线号' : filters.productionLine === 'unknown' ? '线号待确认' : text(filters.productionLine) + ' 线（由 SN 识别）';
    const fields = [...timeFields, ['检测线体', text(line.name) || text(line.code) || text(filters.lineId)], ['生产线号', productionLine],
      ['物料', selectedName('part')], ['设备', selectedName('device')], ['检测结果', selection(filters.result, '全部结果')],
      ['样本范围', limit ? (byCount ? '当前物料、设备及其他条件下最近 ' : '当前时间及筛选内最近 ') + limit + ' 次检测（实际 ' + input.report.records.length + ' 次）' : '当前时间及筛选范围全部检测']];
    if (filters.barcode) fields.push(['工件码', text(filters.barcode)]);
    if (fields.reduce((sum, field) => sum + field[1].length, 0) > 1600) throw new Error('筛选条件文字过长，无法排入可读的一页报告；请缩小选择范围后导出。');
    return fields;
  }
  function fillMesModel(model, input) {
    const { report } = input, summary = report.summary, limited = mesLimited(input);
    const showRate = report.coverage.eligibleForLineRate === true && !limited && !summary.unknown && summary.passRate != null;
    const parts = mesGroups(report.records, 'part', showRate), devices = mesGroups(report.records, 'device', showRate);
    model.title = '公司尺寸检测报告';model.sourceLabel = 'MES 工序检测报表';model.scope = mesScope(input);
    model.periodLabel = '';
    const filters = { ...input.query, ...report.filters }, byCount = filters.queryMode === 'count';
    try { const week = !byCount && calendar?.weekInfo(text(filters.start).slice(0, 10));if (week && week.start === text(filters.start).slice(0, 10) && week.end === text(filters.end).slice(0, 10)) model.periodLabel = week.year + ' · ' + week.label + ' 公司周'; } catch (_) { /* Keep an incomplete week unlabelled. */ }
    model.updatedAt = timestamp(report.fetchedAt || input.loadedAt);model.rateSuppressed = !showRate;
    model.metrics = [{ label: '检测次数', value: number(summary.total), unit: '次 · 复测分别计数' }, { label: '合格 OK', value: number(summary.ok), unit: '次' },
      { label: '不合格 NG', value: number(summary.ng), unit: '次' }, { label: '检测合格率', value: showRate ? percent(summary.passRate / 100) : '—', unit: showRate ? 'OK / 有明确结论的检测次数' : '当前筛选不提供整线合格率' },
      { label: '物料 / 生产线', value: number(parts.filter(item => !item.missing).length), unit: '组 · 本次查询' }, { label: '已识别设备', value: number(devices.filter(item => !item.missing).length), unit: '台 · 本次查询' }];
    model.coverage = (byCount ? '当前筛选内最近检测数量已完整读取' : '所选时间与条件的检测记录已完整读取') + (limited ? ' · 工件或结论限定，不代表整线' : ' · 截至本次读取');
    model.coverageWarning = !showRate;model.total = summary.total;model.eligible = summary.denominator;
    model.distribution = [{ name: '合格 OK', count: summary.ok, share: summary.ok / summary.total }, { name: '不合格 NG', count: summary.ng, share: summary.ng / summary.total }, { name: '判定未知', count: summary.unknown, share: summary.unknown / summary.total }];
    model.partSummary = parts.slice(0, 5);model.deviceSummary = devices.slice(0, 4);
    model.omittedParts = Math.max(0, parts.length - 5);model.omittedDevices = Math.max(0, devices.length - 4);
    const times = report.records.map(record => mesTime(record.measuredAt)).sort((a, b) => a - b);
    model.actualCoverage = mesStamp(times[0]) + ' 至 ' + mesStamp(times.at(-1));
    const minutes = mesInterval(input), bins = new Map();
    for (const record of report.records) {
      const bucket = Math.floor((mesTime(record.measuredAt) + 28800000) / (minutes * 60000)) * minutes * 60000;
      const date = new Date(bucket).toISOString(), label = minutes === 1440 ? date.slice(0, 10) : date.slice(0, 16).replace('T', ' ');
      if (!bins.has(label)) bins.set(label, { label, total: 0, ok: 0, ng: 0, unknown: 0 });
      const bin = bins.get(label);bin.total++;bin[record.result === 'OK' ? 'ok' : record.result === 'NG' ? 'ng' : 'unknown']++;
    }
    const points = [...bins.values()].sort((a, b) => a.label.localeCompare(b.label)), step = Math.ceil(points.length / TREND_LIMIT);
    for (let index = 0; index < points.length; index += step) {
      const batch = points.slice(index, index + step), sum = key => batch.reduce((value, item) => value + item[key], 0), eligible = sum('ok') + sum('ng');
      model.trend.push({ label: batch.length === 1 ? batch[0].label : batch[0].label + ' 至 ' + batch.at(-1).label,
        total: sum('total'), ok: sum('ok'), ng: sum('ng'), conflicts: sum('unknown'), eligible,
        value: showRate && eligible ? sum('ok') / eligible : null, partial: false, points: batch.length });
    }
    model.trendTitle = showRate ? '② 检测量与合格率 · 本次筛选范围' : '② 检测数量趋势 · 当前限定范围';
    model.trendNote = '北京时间按' + (minutes === 1440 ? '天' : minutes + '分钟') + '分组；相邻有记录时段最多合并为 8 组，未出现时段不补零。' + (showRate ? '合并率＝组内 OK 总数 ÷ 有明确结论的检测总数，不平均各时段百分比。' : '已隐藏合格率曲线，不从限定样本重新推算整线合格率。');
    model.notes = ['统计对象是本次完整查询范围内的检测记录；同一工件复测按不同记录 ID 分别计数，不是工件最终结论或一次通过率。',
      showRate ? '合格率采用原始整件 OK/NG：OK ' + number(summary.ok) + ' 次 ÷ 有明确结论 ' + number(summary.denominator) + ' 次；物料及趋势使用各自的同一口径分母。' : '当前工件、结果或来源口径限定，不显示整线合格率；趋势、物料和设备也不重新推算合格率。',
      '测点详情仅按需查询，未取得全范围测点集合，因此不生成 NG 测点总数或排名。测点判定不能替代整件判定。',
      '生产线号按来源提供的 SN 解析结果分组；未识别项保留为待确认，与 MES 检测线体目录分别显示。',
      '公司报表未提供全检标识，不能确认已排除全检；需由 MES 维护人员核对上传范围。',
      '本报告为本轮查询快照，不受后续刷新影响；读取完整不证明现场上传完整，分页复核也不等于事务快照。'];
    if (summary.unknown) model.notes.push('保留 ' + number(summary.unknown) + ' 次未知判定，没有补成 OK 或 NG。');
    for (const warning of list(report.warnings)) if (text(warning)) model.notes.push(text(warning));
    return model;
  }
  function splitTrend(points, kind) {
    if (!points.length) return [];
    const groups = [], step = Math.ceil(points.length / TREND_LIMIT);
    for (let index = 0; index < points.length; index += step) {
      const batch = points.slice(index, index + step), first = batch[0], last = batch.at(-1);
      const start = text(first.date || first.period || first.label), end = text(last.date || last.period || last.label);
      const label = start === end ? start : start + ' 至 ' + end;
      if (kind === 'weld') {
        const known = batch.filter(item => count(item.recordCount));
        const value = known.length ? known.reduce((sum, item) => sum + item.recordCount, 0) : null;
        // A sum of daily distinct pieces counts daily occurrences, not distinct
        // pieces over the whole period. Keep the two denominators separate.
        const validPieces = batch.every(item => validDay(item.date) && count(item.recordCount) && count(item.pieceCount) && item.pieceCount <= item.recordCount && (!item.recordCount || item.pieceCount > 0));
        const dailyPieceOccurrences = validPieces ? batch.reduce((sum, item) => sum + item.pieceCount, 0) : null;
        groups.push({ label, value, dailyPieceOccurrences, average: dailyPieceOccurrences > 0 ? value / dailyPieceOccurrences : null, partial: known.length !== batch.length || batch.some(item => item.complete !== true), points: batch.length });
      } else {
        const valid = batch.every(item => ['eligibleRecords', 'okRecords', 'ngRecords', 'conflictRecords'].every(key => count(item[key])) && item.okRecords + item.ngRecords === item.eligibleRecords && (item.eligibleRecords ? ratio(item.passRate) && Math.abs(item.passRate - item.okRecords / item.eligibleRecords) < 1e-8 : item.passRate == null));
        const eligible = valid ? batch.reduce((sum, item) => sum + item.eligibleRecords, 0) : null;
        const ok = valid ? batch.reduce((sum, item) => sum + item.okRecords, 0) : null;
        const conflicts = valid ? batch.reduce((sum, item) => sum + item.conflictRecords, 0) : null;
        groups.push({ label, value: valid && eligible ? ok / eligible : null, total: valid ? eligible + conflicts : null, eligible, ok, ng: valid ? batch.reduce((sum, item) => sum + item.ngRecords, 0) : null, conflicts, partial: !valid, points: batch.length });
      }
    }
    return groups;
  }
  function scopeFor(kind, query) {
    const fields = [['时间', (text(query.start).replace('T', ' ') || '最早已采集记录') + ' 至 ' + (text(query.end).replace('T', ' ') || '最新已采集记录')], ['物料', selection(kind === 'weld' ? query.materialName : query.part, kind === 'weld' ? '全部物料' : '全部普通检测物料')]];
    if (kind === 'weld') {
      fields.push(['线体', selection(query.line, '全部线体')], ['缺陷', selection(query.defectType, '全部分类') + ' / ' + (list(query.defects).length ? query.defects.map(text).join('、') : '全部内容')]);
      if (query.op && query.op !== 'all') fields.push(['工位', text(query.op)]);
      if (query.location && query.location !== 'all') fields.push(['位置', text(query.location)]);
      if (query.keyword) fields.push(['关键词', text(query.keyword)]);
    } else {
      fields.push(['线体 / 检具', selection(query.lineId, '全部线体') + ' / ' + selection(query.deviceId, '全部检具')], ['检测结果', selection(query.result, '全部结果')], ['样本范围', query.recentLimit && query.recentLimit !== 'all' ? '当前条件下最近 ' + text(String(query.recentLimit)) + ' 条' : '当前条件下全部已采集记录']);
      if (query.search) fields.push(['关键词', text(query.search)]);
    }
    // Never silently truncate applied filters in an exported document.
    if (fields.reduce((sum, field) => sum + field[1].length, 0) > 1600) throw new Error('筛选条件文字过长，无法排入可读的一页报告；请缩小选择范围后导出。');
    return fields;
  }
  function topItems(items, key, denominator) {
    return list(items).filter(item => item && count(item.recordCount)).slice().sort((a, b) => b.recordCount - a.recordCount || text(a[key]).localeCompare(text(b[key]), 'zh-CN')).slice(0, TOP_LIMIT).map(item => ({ name: text(item[key]) || '未填写', count: item.recordCount, share: denominator > 0 ? item.recordCount / denominator : null }));
  }
  function createModel(input, preferences = {}, generatedAt = new Date().toISOString()) {
    const problem = getProblem(input);
    if (problem) throw new Error(problem);
    const { kind, query, report } = input;
    const model = { kind, title: kind === 'weld' ? '补焊点分析报告' : '视觉检具检测报告', department: shortened(text(preferences.reportDepartment).trim() || '工艺部', 60), author: shortened(text(preferences.reportAuthor).trim() || text(input.author).trim() || text(input.account), 60), generatedAt: timestamp(generatedAt), loadedAt: timestamp(input.loadedAt), updatedAt: timestamp(input.sourceUpdatedAt ?? report.source?.updatedAt), showSource: preferences.reportShowSource !== false, scope: kind === 'vision-mes' ? [] : scopeFor(kind, query), notes: [], sourceNote: shortened(text(input.warning), 180), metrics: [], trend: [], tops: [], sourceLabel: kind === 'weld' ? '焊接不合格日志' : '普通 Front11 / Front12 检测记录' };
    model.periodLabel = '';
    try { const week = calendar?.weekInfo(text(query.start).slice(0, 10));if (week && week.start === text(query.start).slice(0, 10) && week.end === text(query.end).slice(0, 10)) model.periodLabel = week.year + ' · ' + week.label + ' 公司周'; } catch (_) { /* An open or partial range has no single KW label. */ }
    if (kind === 'vision-mes') return fillMesModel(model, input);
    if (kind === 'weld') {
      const v = report.overview, complete = input.apiComplete ?? report.source?.complete;
      model.metrics = [{ label: '缺陷日志', value: number(v.recordCount), unit: '条' }, { label: '涉及件数', value: number(v.pieceCount), unit: '件' }, { label: '日志 / 件', value: v.pieceCount ? (v.recordCount / v.pieceCount).toFixed(2) : '—', unit: '条 / 件' }, { label: '缺陷内容', value: number(v.defectTypeCount), unit: '种' }];
      model.metrics.push({ label: '已识别线体', value: number(v.lineCount), unit: '条线' }, { label: '涉及料号', value: number(v.materialCount), unit: '种' });
      model.coverage = complete === true ? '接口分页条数已核对 · 截至本次读取' : complete === false ? '数据可能不完整 · 仅统计本次已读取记录' : '完整性未确认 · 仅统计本次已读取记录';
      model.coverageWarning = complete !== true;
      model.trend = splitTrend(list(report.dailyTrend), kind);
      model.trendTitle = '所选范围 · 数量与平均补焊点';
      model.trendNote = (model.trend.some(point => point.points > 1) ? '相邻日期最多合为 8 组；均值＝组内日志数 ÷ 各日去重件数合计（日去重件次），并非跨日去重件数。' : '均值＝当日日志数 ÷ 当日涉及件数。') + ' * 为覆盖待核实；数据或有效分母缺失时折线断开。';
      model.tops = [{ title: '缺陷内容 Top 5', items: topItems(report.defectSummary, 'defect', v.recordCount) }, { title: '缺陷位置 Top 5', items: topItems(report.topLocations, 'location', v.recordCount) }];
      model.total = v.recordCount;
      const allLines = list(report.lineSummary).filter(item => count(item.recordCount)).slice().sort((a, b) => b.recordCount - a.recordCount || text(a.line).localeCompare(text(b.line), 'zh-CN'));
      model.lines = allLines.slice(0, 5).map((item, index) => ({ name: text(item.line), count: item.recordCount, color: COLORS[index] }));
      if (allLines.length > 5) model.lines.push({ name: '其他线体', count: allLines.slice(5).reduce((sum, item) => sum + item.recordCount, 0), color: COLORS[5], other: true });
      model.locations = list(report.topLocations).filter(item => count(item.recordCount)).slice().sort((a, b) => b.recordCount - a.recordCount).slice(0, TOP_LIMIT).map(item => {
        const byLine = list(item.byLine).filter(row => count(row.count));
        return { name: text(item.location), count: item.recordCount, share: v.recordCount ? item.recordCount / v.recordCount : null,
          byLine: model.lines.map(line => ({ name: line.name, color: line.color, count: byLine.filter(row => line.other ? !model.lines.filter(other => !other.other).some(other => other.name === row.line) : row.line === line.name).reduce((sum, row) => sum + row.count, 0) })) };
      });
      model.lineOps = list(report.lineOpSummary).filter(item => count(item.recordCount)).slice().sort((a, b) => b.recordCount - a.recordCount).slice(0, 4).map(item => ({ name: text(item.line), count: item.recordCount, items: list(item.items).filter(row => count(row.count)).slice(0, 6).map(row => ({ name: text(row.op), count: row.count, share: item.recordCount ? row.count / item.recordCount : null })) }));
      model.omittedLines = Math.max(0, list(report.lineOpSummary).length - model.lineOps.length);
      const seenDays = list(report.dailyTrend).filter(point => count(point.recordCount) && point.recordCount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(point.date)).map(point => point.date).sort();
      model.actualCoverage = seenDays.length ? seenDays[0] + ' 至 ' + seenDays.at(-1) + ' · 有记录 ' + seenDays.length + ' 天' : '当前范围无有日期的缺陷日志';
      model.notes = ['统计对象为已查询范围的缺陷日志，不能据此认定已完成补焊点数、完工件数或产品不良率。', '涉及件数按全期非空物料编码＋二维码去重；缺少组合键的日志仍计入条数。趋势合组的日去重件次不等于全期涉及件数。', 'Top 占比＝该项日志条数 ÷ 当前筛选已读日志总条数；仅展示前 5 项，未列出项仍计入总数。'];
      if (v.missingQrCount || v.missingMaterialCount || v.duplicateRowsRetained) model.notes.push('数据核查：缺二维码 ' + number(v.missingQrCount) + ' 条；缺料号 ' + number(v.missingMaterialCount) + ' 条；重复源日志保留 ' + number(v.duplicateRowsRetained) + ' 条。');
    } else {
      const v = report.summary, selected = report.selection;
      model.metrics = [{ label: '检测记录', value: number(v.totalRecords), unit: '条' }, { label: '合格 OK', value: number(v.okRecords), unit: '次' }, { label: '不合格 NG', value: number(v.ngRecords), unit: '次' }, { label: '合格率', value: percent(v.passRate), unit: 'OK / 可统计次数' }, { label: '版本冲突', value: number(v.conflictRecords), unit: '条 · 不参与合格率' }, { label: '涉及检具', value: number(report.analysis?.coverage?.deviceCount), unit: '台 · 本次选入记录' }];
      model.coverage = report.source?.state === 'ready' ? '当前已采集记录汇总 · 不代表设备全历史' : '采集状态需核查 · 仅统计已保存记录';
      model.coverageWarning = report.source?.state !== 'ready';
      const hourly = report.trend?.bucketMinutes < 1440 && text(query.start).slice(0, 10) === text(query.end).slice(0, 10);
      const rawTrend = hourly ? report.trend?.points : Array.isArray(report.dailyTrend) && report.dailyTrend.length ? report.dailyTrend : report.trend?.points;
      model.trend = splitTrend(list(rawTrend), kind);
      model.trendTitle = hourly ? '检测量与合格率 · 所选日分时趋势' : '检测量与合格率 · 所选范围趋势';
      model.trendNote = '相邻已记录时段最多合并为 8 组；合格率按各组 OK 总数 ÷ 可统计总数计算。未出现日期不补零，无有效分母显示 —。';
      model.distribution = [{ name: '合格 OK', count: v.okRecords, share: v.totalRecords ? v.okRecords / v.totalRecords : null }, { name: '不合格 NG', count: v.ngRecords, share: v.totalRecords ? v.ngRecords / v.totalRecords : null }, { name: '冲突 / 排除', count: v.conflictRecords, share: v.totalRecords ? v.conflictRecords / v.totalRecords : null }];
      model.eligible = v.eligibleRecords;
      model.total = v.totalRecords;
      model.collectorCheckedAt = timestamp(report.source?.collectorCheckedAt);
      const analysis = report.analysis;
      model.actualCoverage = analysis?.coverage?.firstMeasuredAt ? timestamp(analysis.coverage.firstMeasuredAt) + ' 至 ' + timestamp(analysis.coverage.lastMeasuredAt) : '未取得实际检测时间覆盖';
      model.pointSummary = analysis?.measurementSummary && count(analysis.measurementSummary.ngCount) ? { ngCount: analysis.measurementSummary.ngCount, unknownCount: analysis.measurementSummary.unknownCount,
        items: list(analysis.measurementSummary.items).filter(item => ['ngCount', 'eligibleCount', 'unknownCount'].every(key => count(item[key])) && item.ngCount <= item.eligibleCount).slice(0, 5).map(item => ({ name: text(item.name), context: text(item.partName) + ' / ' + text(item.deviceId), count: item.ngCount, eligible: item.eligibleCount, unknown: item.unknownCount, share: item.eligibleCount ? item.ngCount / item.eligibleCount : null })) } : null;
      model.partSummary = list(analysis?.partSummary).slice(0, 5).map(item => ({ name: text(item.partName), count: item.totalRecords, ng: item.ngRecords, conflicts: item.conflictRecords, share: item.eligibleRecords ? item.okRecords / item.eligibleRecords : null }));
      model.deviceSummary = list(analysis?.deviceSummary).slice(0, 4).map(item => ({ name: text(item.deviceId), count: item.totalRecords, ng: item.ngRecords, share: item.eligibleRecords ? item.okRecords / item.eligibleRecords : null }));
      model.notes = ['仅纳入已接入检具的普通检测，排除 ALLmeasure 全检；统计按检测次数，同一 SN 复测分别保留。', '合格率＝OK 次数 ÷ 可统计次数（' + number(v.eligibleRecords) + ' 次）；版本冲突 ' + number(v.conflictRecords) + ' 条不纳入 OK、NG 和合格率。', model.pointSummary ? '测点按型号＋检具＋名称分别汇总，排除版本冲突；NG率＝该测点NG次数 ÷ 该测点有效判定次数，未判定不计作OK。整体结论保留检具原始结果。' : '当前接口未提供全范围测点汇总，本报告不从当前分页或单条明细推算测点 Top。'];
      if (selected && count(selected.matchedRecords) && count(selected.selectedRecords)) model.notes.push('样本范围：条件匹配 ' + number(selected.matchedRecords) + ' 条，本报告选入 ' + number(selected.selectedRecords) + ' 条' + (selected.recentLimit !== null && selected.recentLimit !== undefined ? '（最近 ' + number(selected.recentLimit) + ' 条限制）' : '') + '；分页不改变统计范围。');
      if (report.source?.state !== 'ready') model.notes.push('采集状态：' + shortened(text(report.source?.message) || '请核查来源覆盖与更新时间。', 140));
    }
    return model;
  }
  const PAPER_CSS = `
*{box-sizing:border-box}html{color-scheme:light}body{margin:0;background:#e8edf3;color:#17334b;font-family:"Microsoft YaHei","PingFang SC",Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}.opr-sheet{width:281mm;height:194mm;padding:6mm;background:white;margin:10px auto;overflow:hidden}.opr-content{zoom:var(--opr-scale,1)}.opr-head{display:flex;align-items:center;justify-content:space-between;gap:18px;border-bottom:3px solid #087dc2;padding-bottom:8px}.opr-kicker{font-size:9px;letter-spacing:1.5px;color:#7290a5;margin:0 0 3px}.opr-head h1{font-size:23px;line-height:1.25;margin:0;color:#006fad;font-weight:800}.opr-period{display:inline-block;margin-left:12px;padding:3px 7px;border-radius:4px;background:#eaf4fd;font-size:12px;vertical-align:middle;letter-spacing:0}.opr-department{font-size:10px;max-width:210px;text-align:right;line-height:1.5;overflow-wrap:anywhere}.opr-scope{margin:8px 0 6px;display:flex;flex-wrap:wrap;gap:3px 18px;font-size:10px;line-height:1.5}.opr-scope>div{display:flex;gap:6px;min-width:0;max-width:100%}.opr-scope dt{color:#74879b;flex:none;margin:0}.opr-scope dd{margin:0;overflow-wrap:anywhere;font-weight:600}.opr-coverage{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:5px 8px;background:#edf8f7;color:#247768;border-radius:4px;font-size:9px;margin:0 0 8px;line-height:1.4}.opr-coverage.warning{background:#fff5df;color:#805c17}.opr-coverage span:last-child{text-align:right}.opr-kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-bottom:9px}.opr-kpi{padding:6px 9px;border-radius:5px;background:#eef6fc;border-left:3px solid #087dc2}.opr-kpi:nth-child(2){background:#eaf7f4;border-color:#27997d}.opr-kpi:nth-child(3){background:#fff3e8;border-color:#e7954a}.opr-kpi:nth-child(4){background:#eff0fc;border-color:#8175c2}.opr-kpi:nth-child(5){background:#f1f4f7;border-color:#879aae}.opr-kpi:nth-child(6){background:#eef7e8;border-color:#7eac58}.opr-kpi-label{font-size:10px;color:#5c7389}.opr-kpi strong{display:inline-block;font-size:23px;line-height:1.3;color:#153b59;margin-right:7px}.opr-kpi small{font-size:8px;color:#6d8093}.opr-section{border:1px solid #dce7ee;border-radius:6px;padding:9px 10px;min-width:0;background:white}.opr-section h2{font-size:12px;margin:0 0 7px;line-height:1.4;font-weight:800;color:#174f76}.opr-section h2 b{color:#087dc2;margin-right:5px}.opr-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-bottom:9px}.opr-grid-top>.opr-section{min-height:165px}.opr-grid-bottom>.opr-section{min-height:158px}.opr-note{font-size:8px;line-height:1.5;color:#6b8095;margin:5px 0 0}.opr-table{width:100%;border-collapse:collapse;font-size:9px;table-layout:fixed}.opr-table th{background:#eaf3fa;color:#476881;font-size:8px;font-weight:600;padding:5px 4px;text-align:right}.opr-table th:first-child{text-align:left;width:49%}.opr-table td{border-bottom:1px solid #e7edf2;padding:4px;text-align:right;vertical-align:middle;line-height:1.35}.opr-table td:first-child{text-align:left;overflow-wrap:anywhere}.opr-table td:nth-child(n+2){white-space:nowrap}.opr-table tr:nth-child(even) td{background:#f8fbfd}.opr-table tfoot td{background:#e9f3fa;font-weight:700}.opr-table small{display:block;font-size:7px;color:#71879a;line-height:1.3}.opr-table .opr-point-name{width:56%}.opr-empty{padding:25px 10px;background:#f8fafc;border:1px dashed #cbd7e1;color:#7b8fa2;font-size:10px;text-align:center}.opr-legend{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:8px;color:#58718a;margin:5px 0}.opr-legend span{display:inline-flex;align-items:center;gap:4px}.opr-legend i{display:inline-block;width:7px;height:7px;border-radius:2px;background:var(--color)}.opr-location{display:grid;grid-template-columns:minmax(95px,40%) 1fr 35px;align-items:center;gap:6px;margin:6px 0;font-size:9px}.opr-location-label{line-height:1.3;overflow-wrap:anywhere}.opr-location-count{text-align:right;font-weight:700}.opr-track{height:12px;background:#f0f4f8;display:flex;border-radius:2px;overflow:hidden}.opr-track>span{background:var(--color);width:var(--share)}.opr-op-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px 12px}.opr-op{min-width:0}.opr-op-title{font-size:9px;display:flex;justify-content:space-between;gap:5px;margin-bottom:4px;color:#355b79}.opr-op-title strong{overflow-wrap:anywhere}.opr-op .opr-track{height:11px}.opr-op .opr-legend{font-size:7px;gap:3px 5px;margin:4px 0}.opr-trend{height:116px;display:grid;grid-template-columns:repeat(var(--columns),minmax(0,1fr));gap:9px;border-bottom:1px solid #d7e3ec}.opr-trend-item{display:flex;flex-direction:column;justify-content:flex-end;align-items:center;min-width:0;height:100%}.opr-trend-value{font-size:10px;font-weight:700;line-height:17px}.opr-trend-bar-space{height:72px;width:100%;display:flex;align-items:flex-end;justify-content:center}.opr-trend-bar{height:var(--bar);width:46%;background:#087dc2;border-radius:3px 3px 0 0}.opr-trend-item:nth-child(2n) .opr-trend-bar{background:#26a9c5}.opr-trend-bar.partial,.opr-trend-item:nth-child(2n) .opr-trend-bar.partial{background:repeating-linear-gradient(135deg,#75b4d7,#75b4d7 4px,#c9e3f2 4px,#c9e3f2 8px)}.opr-trend-bar.missing{height:1px;background:#aab9c5}.opr-trend-label{font-size:7px;color:#6b8095;text-align:center;margin:4px 0 0;line-height:1.3;min-height:22px;overflow-wrap:anywhere}.opr-dual-chart{width:100%;height:136px;display:block;overflow:visible}.opr-weld-average-chart{height:156px}.opr-dual-chart text{font-family:inherit;fill:#6b8095;font-size:9px}.opr-dual-chart .opr-chart-count{font-size:10px;fill:#135a86;font-weight:700}.opr-dual-chart .opr-chart-rate{font-size:10px;fill:#b56e34;font-weight:700}.opr-dual-chart .opr-chart-axis{font-size:8px}.opr-dual-chart .opr-trend-item{display:initial}.opr-distribution{display:flex;align-items:center;gap:16px}.opr-donut{width:112px;height:112px;flex:none}.opr-donut text{font-family:inherit;text-anchor:middle;fill:#234967;font-size:9px}.opr-donut .opr-donut-total{font-size:21px;font-weight:700}.opr-result-list{flex:1;min-width:0}.opr-result-row{display:flex;justify-content:space-between;gap:10px;margin:9px 0;font-size:10px}.opr-result-row span{display:flex;align-items:center;gap:6px}.opr-result-row i{width:7px;height:7px;border-radius:2px;background:var(--color)}.opr-result-row strong{white-space:nowrap}.opr-result-row small{font-weight:400;font-size:9px;margin-left:7px;color:#7890a3}.opr-defect-strip{margin-top:7px;font-size:8px;line-height:1.6;display:flex;gap:4px 10px;flex-wrap:wrap}.opr-defect-strip strong{color:#416582}.opr-defect-strip span{color:#70869b}.opr-mini-table th:first-child{width:58%}.opr-source-detail{font-size:8px;line-height:1.5;margin:5px 0 0;color:#5c7790;overflow-wrap:anywhere}.opr-notes{border-top:1px solid #dce5ed;padding-top:6px;margin-top:8px}.opr-notes h2{display:inline;font-size:9px;margin:0 7px 0 0;color:#4b6b84}.opr-notes ol{display:inline;margin:0;padding:0;font-size:8px;line-height:1.55;color:#637c91;list-style:none}.opr-notes li{display:inline}.opr-notes li+li:before{content:' · ';color:#95aaba}.opr-source{font-size:8px;line-height:1.5;color:#6e8092;margin:3px 0 0;overflow-wrap:anywhere}.opr-footer{display:flex;justify-content:space-between;gap:10px;font-size:8px;color:#8095a8;border-top:1px solid #e3eaf0;margin-top:5px;padding-top:5px}.opr-footer span{overflow-wrap:anywhere}.opr-footer span:last-child{white-space:nowrap}@page{size:A4 landscape;margin:8mm}@media print{html,body{width:281mm;margin:0;padding:0;background:white}.opr-sheet{width:281mm;height:193.5mm;margin:0;padding:6mm;break-inside:avoid;break-after:avoid}.opr-content{break-inside:avoid}}
`;
  function empty(message = '本次范围暂无可统计数据') { return '<div class="opr-empty">' + esc(message) + '</div>'; }
  function section(title, body, note = '') { return '<section class="opr-section"><h2>' + esc(title) + '</h2>' + body + (note ? '<p class="opr-note">' + esc(note) + '</p>' : '') + '</section>'; }
  function legend(items) { return '<div class="opr-legend">' + items.map((item, i) => '<span><i style="--color:' + (item.color || COLORS[i % COLORS.length]) + '"></i>' + esc(shortened(item.name, 35)) + '</span>').join('') + '</div>'; }
  function compactLabel(value) { return shortened(value.replaceAll(/\b20\d{2}-/g, '').replaceAll('T', ' ').replace(' 至 ', ' ～ '), 60); }
  function trendMarkup(model) {
    const points = model.trend;
    if (!points.length) return section(model.trendTitle, empty('接口未提供所选范围趋势；未用当前分页推算。'), model.trendNote);
    const validAverage = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const maximum = Math.max(2, Math.ceil(Math.max(...points.map(point => count(point.value) ? point.value : 0)) / 2) * 2);
    const maxAverage = Math.max(1, ...points.map(point => validAverage(point.average) ? point.average : 0)) * 1.3;
    const left = 34, right = 438, top = 42, bottom = 119, step = (right - left) / points.length;
    const x = index => left + step * (index + .5), y = value => bottom - value / maxAverage * (bottom - top);
    const averageText = value => validAverage(value) ? value.toFixed(2) : '—';
    let svg = '<svg class="opr-dual-chart opr-weld-average-chart" viewBox="0 0 480 158" role="img" aria-label="日志数量柱形及平均补焊点折线，左轴日志条数，右轴平均补焊点"><defs><pattern id="opr-weld-partial" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill="#c9e3f2"/><rect width="4" height="7" fill="#75b4d7"/></pattern></defs><text x="0" y="10" class="opr-chart-axis">日志数量（条）</text><text x="475" y="10" text-anchor="end" class="opr-chart-axis">平均补焊点（' + (points.some(point => point.points > 1) ? '条/日去重件次' : '条/件') + '）</text>';
    for (const fraction of [0, .5, 1]) {
      const position = bottom - fraction * (bottom - top);
      svg += '<line x1="' + left + '" x2="' + right + '" y1="' + position + '" y2="' + position + '" stroke="#e5edf3"/><text x="29" y="' + (position + 3) + '" text-anchor="end" class="opr-chart-axis">' + number(maximum * fraction) + '</text><text x="444" y="' + (position + 3) + '" class="opr-chart-axis">' + averageText(maxAverage * fraction) + '</text>';
    }
    points.forEach((point, index) => {
      const center = x(index), valid = count(point.value), barWidth = Math.min(28, step * .46), height = valid ? point.value / maximum * (bottom - top) : 0;
      svg += '<g class="opr-trend-item"><title>' + esc(point.label) + '：日志 ' + number(point.value) + ' 条，日去重件次 ' + number(point.dailyPieceOccurrences) + '，平均 ' + averageText(point.average) + '</title><text x="' + center + '" y="28" text-anchor="middle" class="opr-chart-count">' + number(point.value) + (point.partial && valid ? '*' : '') + '</text>';
      svg += valid ? '<rect class="opr-weld-bar" x="' + (center - barWidth / 2) + '" y="' + (bottom - height) + '" width="' + barWidth + '" height="' + height + '" rx="2" fill="' + (point.partial ? 'url(#opr-weld-partial)' : '#168fc3') + '"/>' : '<rect class="opr-weld-gap" x="' + (center - barWidth / 2) + '" y="' + (top + 14) + '" width="' + barWidth + '" height="' + (bottom - top - 14) + '" fill="#fafcfd" stroke="#cbd8e3" stroke-dasharray="3 3"/>';
      const labels = compactLabel(point.label).split(' ～ ');
      svg += '<text x="' + center + '" y="134" text-anchor="middle">' + esc(shortened(labels[0], 18)) + (labels[1] ? '<tspan x="' + center + '" dy="11">～ ' + esc(shortened(labels[1], 18)) + '</tspan>' : '') + '</text></g>';
    });
    let line = '', connected = false;
    points.forEach((point, index) => { if (!validAverage(point.average)) { connected = false;return; }line += (connected ? ' L ' : ' M ') + x(index) + ' ' + y(point.average);connected = true; });
    svg += '<path class="opr-weld-average-line" d="' + line + '" fill="none" stroke="#ed8a2b" stroke-width="2.3" stroke-linejoin="round"/>';
    points.forEach((point, index) => {
      if (!validAverage(point.average)) return;
      svg += '<circle class="opr-weld-average-dot" cx="' + x(index) + '" cy="' + y(point.average) + '" r="3.3" fill="white" stroke="#ed8a2b" stroke-width="2"/><text class="opr-chart-rate opr-weld-average-value" x="' + x(index) + '" y="' + (y(point.average) - 8) + '" text-anchor="middle" stroke="white" stroke-width="2.5" style="paint-order:stroke fill">' + averageText(point.average) + '</text>';
    });
    svg += '</svg>';
    return section(model.trendTitle, svg + legend([{ name: '日志数量（左轴）', color: '#168fc3' }, { name: '平均补焊点（右轴）', color: '#ed8a2b' }]), model.trendNote);
  }
  function dualTrend(model) {
    const points = model.trend;if (!points.length) return section(model.trendTitle, empty('当前范围暂无可统计趋势。'));
    const maximum = Math.max(1, ...points.map(point => count(point.total) ? point.total : 0)), W = 480, left = 29, right = 450, top = 23, bottom = 112, step = (right - left) / points.length;
    const x = index => left + step * (index + .5), y = rate => bottom - rate * (bottom - top);
    let svg = '<svg class="opr-dual-chart" viewBox="0 0 480 155" role="img" aria-label="' + (model.rateSuppressed ? '限定范围检测数量柱形图' : '检测量柱形及合格率曲线，合格率纵轴0至100%') + '"><text x="0" y="10" class="opr-chart-axis">检测量（次）</text>' + (model.rateSuppressed ? '' : '<text x="428" y="10" class="opr-chart-axis">合格率</text>');
    for (const value of [0, .5, 1]) svg += '<line x1="' + left + '" x2="' + right + '" y1="' + y(value) + '" y2="' + y(value) + '" stroke="#e1eaf1"/><text x="24" y="' + (y(value) + 3) + '" text-anchor="end" class="opr-chart-axis">' + Math.round(maximum * value) + '</text>' + (model.rateSuppressed ? '' : '<text x="455" y="' + (y(value) + 3) + '" class="opr-chart-axis">' + value * 100 + '%</text>');
    // Only connect consecutive known observations. Missing rates are gaps.
    points.forEach((point, i) => {
      if (count(point.total)) {
        let offset = 0;
        [[point.ok, '#087dc2'], [point.ng, '#e7954a'], [point.conflicts, '#a5b5c4']].forEach(([value, color]) => { if (!count(value)) return;const height = value / maximum * (bottom - top);svg += '<rect x="' + (x(i) - Math.min(step * .24, 15)) + '" y="' + (bottom - offset - height) + '" width="' + Math.min(step * .48, 30) + '" height="' + height + '" fill="' + color + '"/>';offset += height; });
        svg += '<text class="opr-chart-count" style="fill:' + (offset >= 17 ? '#fff' : '#135a86') + '" x="' + x(i) + '" y="' + (offset >= 17 ? bottom - 5 : bottom - offset - 5) + '" text-anchor="middle">' + number(point.total) + '</text>';
      }
      if (ratio(point.value)) {
        if (i && ratio(points[i - 1].value)) svg += '<line x1="' + x(i - 1) + '" x2="' + x(i) + '" y1="' + y(points[i - 1].value) + '" y2="' + y(point.value) + '" stroke="#d1843e" stroke-width="2"/>';
        svg += '<circle cx="' + x(i) + '" cy="' + y(point.value) + '" r="3" fill="#d1843e" stroke="white" stroke-width="1"/><text class="opr-chart-rate" x="' + x(i) + '" y="' + Math.max(17, y(point.value) - 7) + '" text-anchor="middle">' + percent(point.value) + '</text>';
      }
      const label = compactLabel(point.label), pieces = label.split(' ～ ');
      svg += '<text x="' + x(i) + '" y="128" text-anchor="middle">' + esc(shortened(pieces[0], 18)) + (pieces[1] ? '<tspan x="' + x(i) + '" dy="11">～ ' + esc(shortened(pieces[1], 18)) + '</tspan>' : '') + '</text>';
    });
    svg += '</svg>';
    return section(model.trendTitle, svg + legend([{ name: 'OK', color: '#087dc2' }, { name: 'NG', color: '#e7954a' }, { name: model.kind === 'vision-mes' ? '判定未知' : '冲突', color: '#a5b5c4' }, ...(model.rateSuppressed ? [] : [{ name: '合格率', color: '#d1843e' }])]), model.trendNote);
  }
  function locationsMarkup(model) {
    const maximum = Math.max(1, ...model.locations.map(item => item.count));
    const rows = model.locations.map(item => '<div class="opr-location"><span class="opr-location-label">' + esc(shortened(item.name, 45)) + '</span><div class="opr-track">' + (item.byLine.length ? item.byLine : [{ count: item.count, color: COLORS[0] }]).map(line => '<span title="' + esc(line.name || '') + '" style="--share:' + (line.count / maximum * 100).toFixed(4) + '%;--color:' + line.color + '"></span>').join('') + '</div><strong class="opr-location-count">' + number(item.count) + '</strong></div>').join('');
    return section('① 缺陷位置 Top 5 · 各线贡献', model.locations.length ? rows + legend(model.lines) : empty(), '按当前筛选日志条数排序；相同颜色对应同一线体。');
  }
  function locationTable(model) {
    const lines = model.lines, total = model.locations.reduce((sum, item) => sum + item.count, 0);
    const table = '<table class="opr-table"><thead><tr><th>缺陷位置</th>' + lines.map(line => '<th title="' + esc(line.name) + '">' + esc(shortened(line.name, 9)) + '</th>').join('') + '<th>合计</th><th>占比</th></tr></thead><tbody>' + model.locations.map(item => '<tr><td>' + esc(shortened(item.name, 52)) + '</td>' + item.byLine.map(line => '<td>' + number(line.count) + '</td>').join('') + '<td><strong>' + number(item.count) + '</strong></td><td>' + percent(item.share) + '</td></tr>').join('') + '</tbody><tfoot><tr><td>Top 5 合计</td>' + lines.map((_, i) => '<td>' + number(model.locations.reduce((sum, item) => sum + item.byLine[i].count, 0)) + '</td>').join('') + '<td>' + number(total) + '</td><td>' + percent(model.total ? total / model.total : null) + '</td></tr></tfoot></table>';
    const defects = model.tops[0].items;
    return section('③ 位置明细与主要缺陷', model.locations.length ? table + '<div class="opr-defect-strip"><strong>缺陷 Top 5</strong>' + defects.map(item => '<span>' + esc(shortened(item.name, 16)) + ' ' + number(item.count) + '条</span>').join('') + '</div>' : empty(), '位置占比以本次 ' + number(model.total) + ' 条日志为分母；未列出项仍计入总数。');
  }
  function lineOpsMarkup(model) {
    const allOps = [...new Set(model.lineOps.flatMap(line => line.items.map(item => item.name)))].sort();
    const color = name => name === '其他' ? '#a5b5c4' : COLORS[allOps.indexOf(name) % COLORS.length];
    const markup = '<div class="opr-op-grid">' + model.lineOps.map(line => '<div class="opr-op"><div class="opr-op-title"><strong>' + esc(shortened(line.name, 25)) + '</strong><span>' + number(line.count) + ' 条</span></div><div class="opr-track">' + line.items.map(item => '<span style="--share:' + ((item.share || 0) * 100).toFixed(4) + '%;--color:' + color(item.name) + '"></span>').join('') + '</div>' + legend(line.items.map(item => ({ name: item.name + ' ' + percent(item.share), color: color(item.name) }))) + '</div>').join('') + '</div>';
    return section('② 各线 OP 工位构成 · Top 5＋其他', model.lineOps.length ? markup : empty('本次接口未提供按线体的工位汇总。'), '每条线以自身日志数为分母；展示日志最多的 4 条线' + (model.omittedLines ? '，另 ' + model.omittedLines + ' 条线未展开' : '') + '。');
  }
  function resultMarkup(model) {
    const colors = ['#087dc2', '#e7954a', '#a5b5c4'];let offset = 0;
    const arcs = model.distribution.map((item, i) => {const share = (item.share || 0) * 100, arc = '<circle cx="60" cy="60" r="43" fill="none" stroke="' + colors[i] + '" stroke-width="15" pathLength="100" stroke-dasharray="' + share + ' ' + (100 - share) + '" stroke-dashoffset="' + (-offset) + '" transform="rotate(-90 60 60)"/>';offset += share;return arc;}).join('');
    const donut = '<svg viewBox="0 0 120 120" class="opr-donut" role="img" aria-label="' + (model.kind === 'vision-mes' ? 'OK、NG及未知判定记录构成' : 'OK、NG及冲突记录构成') + '"><circle cx="60" cy="60" r="43" fill="none" stroke="#edf2f7" stroke-width="15"/>' + arcs + '<text x="60" y="59" class="opr-donut-total">' + number(model.total) + '</text><text x="60" y="74">检测记录</text></svg>';
    return section('① 检测结果与统计范围', '<div class="opr-distribution">' + donut + '<div class="opr-result-list">' + model.distribution.map((item, i) => '<div class="opr-result-row"><span><i style="--color:' + colors[i] + '"></i>' + esc(item.name) + '</span><strong>' + number(item.count) + '<small>' + percent(item.share) + '</small></strong></div>').join('') + '</div></div>', '构成以本次 ' + number(model.total) + ' 次检测为分母；' + (model.rateSuppressed ? '构成百分比不是整线合格率。' : '合格率以 ' + number(model.eligible) + ' 次可统计检测为分母。'));
  }
  function pointMarkup(model) {
    if (model.kind === 'vision-mes') return section('③ 测点统计说明', empty('未读取本次范围的全部测点明细，不生成 NG 测点排名。'), '测点详情仅按需查询；已打开的单条明细不能代表全范围，测点 NG 数也不等于不合格检测次数。');
    const points = model.pointSummary;
    if (!points) return section('③ NG 测点 Top 5', empty('当前数据未包含完整测点汇总；本次不展示测点排名。'));
    const rows = points.items.map(item => '<tr><td>' + esc(shortened(item.name, 44)) + '<small>' + esc(shortened(item.context, 64)) + '</small></td><td>' + number(item.count) + '</td><td>' + number(item.eligible) + '</td><td>' + percent(item.share) + '</td></tr>').join('');
    return section('③ NG 测点 Top 5 · 按出现次数', rows ? '<table class="opr-table"><thead><tr><th class="opr-point-name">测点 / 型号与检具</th><th>NG</th><th>有效判定</th><th>NG率</th></tr></thead><tbody>' + rows + '</tbody></table>' : empty(model.eligible ? '本次可统计检测中，测点没有 NG 判定。' : '本次没有可统计检测，暂无测点排名。'), '所有测点 NG 共 ' + number(points.ngCount) + ' 次；未判定 ' + number(points.unknownCount) + ' 次。测点 NG 总数不等于不合格检测次数。');
  }
  function coverageMarkup(model) {
    if (model.kind === 'vision-mes') {
      const rows = model.partSummary.map(item => '<tr><td>' + esc(shortened(item.name, 43)) + '</td><td>' + number(item.count) + '</td><td>' + number(item.ng) + '</td>' + (model.rateSuppressed ? '' : '<td>' + percent(item.share) + '</td>') + '</tr>').join('');
      const devices = model.deviceSummary.map(item => item.name + ' ' + number(item.count) + '次').join(' / ');
      return section('④ 物料与设备覆盖', '<table class="opr-table opr-mini-table"><thead><tr><th>物料（最多 5 项）</th><th>检测</th><th>NG</th>' + (model.rateSuppressed ? '' : '<th>合格率</th>') + '</tr></thead><tbody>' + rows + '</tbody></table><p class="opr-source-detail"><strong>检测记录时段：</strong>' + esc(model.actualCoverage) + '<br><strong>设备（最多 4 台）：</strong>' + esc(devices || '未提供设备信息') + '</p>', '由全部 ' + number(model.total) + ' 次筛选后检测汇总，分页不改变范围；仅展开记录最多的物料和设备，未列出项仍计入总数。');
    }
    const rows = model.partSummary.map(item => '<tr><td>' + esc(shortened(item.name, 43)) + '</td><td>' + number(item.count) + '</td><td>' + number(item.ng) + '</td><td>' + percent(item.share) + '</td></tr>').join('');
    const devices = model.deviceSummary.map(item => item.name + ' ' + number(item.count) + '条').join(' / ');
    return section('④ 物料与采集覆盖', (rows ? '<table class="opr-table opr-mini-table"><thead><tr><th>物料（最多 5 项）</th><th>记录</th><th>NG</th><th>合格率</th></tr></thead><tbody>' + rows + '</tbody></table>' : empty('接口未提供物料汇总。')) + '<p class="opr-source-detail"><strong>有记录时段：</strong>' + esc(model.actualCoverage) + '<br><strong>检具（最多 4 台）：</strong>' + esc(devices || '未取得检具汇总') + '<br><strong>采集最后扫描：</strong>' + esc(model.collectorCheckedAt) + '</p>', '采集扫描时间仅说明采集器运行时间，不证明整个所选时段已完整采集。');
  }
  function renderDocument(model, scale = 1) {
    const safeScale = typeof scale === 'number' && Number.isFinite(scale) ? Math.max(0.78, Math.min(1, scale)) : 1;
    const analyses = model.kind === 'weld' ? '<div class="opr-grid opr-grid-top">' + locationsMarkup(model) + lineOpsMarkup(model) + '</div><div class="opr-grid opr-grid-bottom">' + locationTable(model) + trendMarkup(model) + '</div>' : '<div class="opr-grid opr-grid-top">' + resultMarkup(model) + dualTrend(model) + '</div><div class="opr-grid opr-grid-bottom">' + pointMarkup(model) + coverageMarkup(model) + '</div>';
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="portal-report-snapshot" content="' + esc(model.previewId || '') + '"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><title>' + esc(model.title) + '</title><style>' + PAPER_CSS + '</style></head><body><article class="opr-sheet" aria-label="A4 横向一页报告"><div class="opr-content" style="--opr-scale:' + safeScale.toFixed(3) + '"><header class="opr-head"><div><p class="opr-kicker">QUALITY REVIEW / 工艺质量分析</p><h1>' + esc(model.title) + (model.periodLabel ? '<span class="opr-period">' + esc(model.periodLabel) + '</span>' : '') + '</h1></div><div class="opr-department">' + esc(model.department) + (model.author ? '<br>编制：' + esc(model.author) : '') + '</div></header><dl class="opr-scope">' + model.scope.map(([label, value]) => '<div><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>').join('') + '</dl><div class="opr-coverage' + (model.coverageWarning ? ' warning' : '') + '"><span>' + esc(model.coverage) + '</span><span>' + (model.kind === 'weld' ? '有记录日期：' + esc(model.actualCoverage) : model.kind === 'vision-mes' ? '原始整件结论 · 不推算测点排行' : '整体判定与测点判定分别统计') + '</span></div><div class="opr-kpis">' + model.metrics.map(item => '<section class="opr-kpi"><div class="opr-kpi-label">' + esc(item.label) + '</div><strong>' + esc(item.value) + '</strong><small>' + esc(item.unit) + '</small></section>').join('') + '</div>' + analyses + '<section class="opr-notes"><h2>前提条件与局限性</h2><ol>' + model.notes.map(note => '<li>' + esc(note) + '</li>').join('') + '</ol>' + (model.showSource ? '<p class="opr-source">来源：' + esc(model.sourceLabel) + (model.kind === 'weld' ? '；来源最新记录时间：' : model.kind === 'vision-mes' ? '；接口读取时间：' : '；来源更新时间：') + esc(model.updatedAt) + '。' + (model.sourceNote ? ' ' + esc(model.sourceNote) : '') + '</p>' : '') + '</section><footer class="opr-footer"><span>数据读取：' + esc(model.loadedAt) + ' · 生成：' + esc(model.generatedAt) + '（北京时间）</span><span>查询快照 · 第 1 / 1 页</span></footer></div></article></body></html>';
  }
  let account = null, current = null, dialog = null, frame = null, previousFocus = null, previewSequence = 0;
  function lifecycle(name, kind) {
    if (typeof root.CustomEvent === 'function' && typeof root.document?.dispatchEvent === 'function') root.document.dispatchEvent(new root.CustomEvent(name, { detail: { kind } }));
  }
  function clear() {
    const previousKind = current?.model.kind;
    current = null;
    if (dialog?.open) dialog.close();
    if (frame) frame.srcdoc = '<!doctype html><html lang="zh-CN"><title>报告已清除</title><body></body></html>';
    if (previousKind) lifecycle('portal:report-close', previousKind);
  }
  function setContext(value) {
    const next = value ? String(value) : null;
    if (next !== account) clear();
    account = next;
  }
  function ensureDialog() {
    if (dialog) return;
    dialog = root.document.createElement('dialog');
    dialog.id = 'onePageReportDialog';dialog.className = 'one-page-report-dialog';dialog.setAttribute('aria-labelledby', 'onePageReportTitle');
    dialog.innerHTML = '<header class="one-page-report-header"><div><h2 id="onePageReportTitle">一页报告预览</h2><p>使用已查询的数据快照；A4 横向，可打印或另存为 PDF。</p></div><button type="button" class="button" data-report-close aria-label="关闭报告预览">关闭</button></header><div class="one-page-report-toolbar"><span data-report-status role="status">正在排版…</span><button type="button" class="button" data-report-download disabled>下载 HTML</button><button type="button" class="button primary" data-report-print disabled>打印 / 另存 PDF</button></div><div class="one-page-report-canvas"><iframe title="一页报告内容预览" sandbox="allow-same-origin allow-modals"></iframe></div><p class="one-page-report-tip">打印时选择 A4 横向，关闭浏览器页眉和页脚。报告随导出文件保存，不随页面刷新更新。</p>';
    root.document.body.append(dialog);frame = dialog.querySelector('iframe');
    const close = () => { clear();previousFocus?.focus?.(); };
    dialog.querySelector('[data-report-close]').addEventListener('click', close);
    dialog.addEventListener('cancel', event => { event.preventDefault();close(); });
    dialog.addEventListener('close', () => { if (current && !dialog.open) clear(); });
    dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
    dialog.querySelector('[data-report-print]').addEventListener('click', () => {
      if (!current?.ready || current.account !== account) return clear();
      try { frame.contentWindow.focus();frame.contentWindow.print(); }
      catch (_) { dialog.querySelector('[data-report-status]').textContent = '浏览器无法打开打印，请下载 HTML 后在浏览器中打印。'; }
    });
    dialog.querySelector('[data-report-download]').addEventListener('click', () => {
      if (!current?.ready || current.account !== account) return clear();
      const blob = new Blob([renderDocument(current.model, current.scale)], { type: 'text/html;charset=utf-8' }), url = URL.createObjectURL(blob), anchor = root.document.createElement('a');
      anchor.href = url;anchor.download = current.model.title + '_' + current.model.generatedAt.replace(/[^0-9]/g, '') + '.html';root.document.body.append(anchor);anchor.click();anchor.remove();root.setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    frame.addEventListener('load', () => {
      if (!current || current.account !== account) return;
      if (frame.contentDocument?.querySelector('meta[name="portal-report-snapshot"]')?.content !== String(current.model.previewId)) return;
      const content = frame.contentDocument?.querySelector('.opr-content'), paper = frame.contentDocument?.querySelector('.opr-sheet');
      if (!content || !paper) return;
      const available = paper.clientHeight - 2 * 6 * 96 / 25.4 - 5;
      let scale = 1;
      for (let attempt = 0; attempt < 3; attempt++) {
        const height = content.getBoundingClientRect().height;
        if (height <= available) break;
        scale *= available / height;content.style.setProperty('--opr-scale', String(scale));
      }
      const fits = scale >= 0.78 && content.getBoundingClientRect().height <= available + 1;
      current.scale = Math.max(0.78, scale);current.ready = fits;
      for (const button of dialog.querySelectorAll('[data-report-print],[data-report-download]')) button.disabled = !fits;
      dialog.querySelector('[data-report-status]').textContent = fits ? 'A4 · 1 页 · 与当前成功查询一致' : '内容过多，无法保持一页可读；请缩小筛选范围后导出。';
    });
    root.document.addEventListener('portal:session-expired', () => setContext(null));
  }
  function open(input) {
    if (!root.document) throw new Error('报告预览需要浏览器环境。');
    if (!account || String(input?.account || '') !== account) throw new Error('登录状态已变化，请重新查询后导出报告。');
    const preferences = root.PortalPreferences?.get?.() || {};
    // The model contains only aggregate values and the successful query snapshot,
    // never a reference to live state or paginated source records.
    const model = createModel(input, preferences);model.previewId = ++previewSequence;
    ensureDialog();previousFocus = root.document.activeElement;current = { model, account, ready: false, scale: 1 };
    for (const button of dialog.querySelectorAll('[data-report-print],[data-report-download]')) button.disabled = true;
    dialog.querySelector('[data-report-status]').textContent = '正在排版…';
    dialog.querySelector('#onePageReportTitle').textContent = model.title + ' · 预览';
    frame.srcdoc = renderDocument(model);
    if (!dialog.open) dialog.showModal();
    lifecycle('portal:report-open', model.kind);
    return true;
  }
  return { open, clear, setContext, isOpen: () => Boolean(current && dialog?.open), canOpen, getProblem, createModel, renderDocument, TOP_LIMIT, TREND_LIMIT };
});
