'use strict';
const { normalizeDate } = require('./weld-report.cjs');

const STATUS = Object.freeze({
  unresponded: '待响应', processing: '处理中', awaiting_restore: '待复线',
  completed: '已完成', unknown: '状态待核实'
});
const UNKNOWN_DEPARTMENT = '部门待确认';
const text = value => value == null ? '' : String(value).trim();

function stamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const s = value.trim();
  const match = /^(20\d{2})-\d{2}-\d{2}[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,7})?)?(?:Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] || 0) > 59) return null;
  const date = s.slice(0, 10);
  if (normalizeDate(date) !== date) return null;
  const n = Date.parse(s.replace(' ', 'T') + (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s) ? '' : '+08:00'));
  return Number.isFinite(n) ? n : null;
}

function alarmStatus(row) {
  const closed = text(row.isClose);
  if (closed === '1') return 'completed';
  if (closed !== '0') return 'unknown';
  // A restoration timestamp contradicts an explicitly open source state.
  // Do not silently turn that conflict into a completed or waiting stage.
  if (stamp(row.trackOn) !== null) return 'unknown';
  if (stamp(row.dealTime) !== null) return 'awaiting_restore';
  if (text(row.responseState) === '1' || stamp(row.responseTime) !== null) return 'processing';
  if (text(row.responseState) === '0') return 'unresponded';
  return 'unknown';
}

const value = (row, key, unknown) => text(row[key]) || unknown;

function ranking(rows, key, unknown) {
  const groups = new Map();
  for (const row of rows) {
    const name = value(row, key, unknown);
    if (!groups.has(name)) groups.set(name, { name, count: 0, openCount: 0 });
    const group = groups.get(name);
    group.count++;
    if (text(row.isClose) === '0') group.openCount++;
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
}

function filterOptions(rows, key, unknown) {
  return ranking(rows, key, unknown).map(item => ({ value: item.name, label: item.name, count: item.count }));
}

function duration(rows, from, to) {
  let sum = 0, sampleCount = 0, invalidCount = 0;
  for (const row of rows) {
    const a = stamp(row[from]), b = stamp(row[to]);
    if (a !== null && b !== null && b >= a) { sum += (b - a) / 60000; sampleCount++; }
    else invalidCount++;
  }
  return { averageMinutes: sampleCount ? Math.round(sum / sampleCount * 10) / 10 : null, sampleCount, invalidCount };
}

function departmentResolver(rules = []) {
  if (!Array.isArray(rules)) throw new TypeError('departmentRules must be an array');
  const compiled = rules.map(rule => {
    const definition = rule && (rule.pattern === undefined ? rule.groupPattern : rule.pattern);
    if (!rule || !text(rule.department) || (typeof definition !== 'string' && !(definition instanceof RegExp))) {
      throw new TypeError('Each department rule needs department and pattern or groupPattern');
    }
    if (!text(definition)) throw new TypeError('department pattern cannot be empty');
    const pattern = definition instanceof RegExp ? new RegExp(definition.source, definition.flags.replace(/[gy]/g, '')) : new RegExp(definition);
    return { department: text(rule.department), field: text(rule.field) || 'groupName', pattern };
  });
  return row => {
    const matchedRules = compiled.filter(rule => {
      const fieldValue = text(rule.field.split('.').reduce((value, key) => value == null ? undefined : value[key], row));
      return fieldValue && rule.pattern.test(fieldValue);
    });
    const matches = [...new Set(matchedRules.map(rule => rule.department))];
    return { name: matches.length === 1 ? matches[0] : UNKNOWN_DEPARTMENT, conflict: matches.length > 1,
      sourceFields: [...new Set(matchedRules.map(rule => rule.field))] };
  };
}

function lineResolver(rules = []) {
  if (!Array.isArray(rules)) throw new TypeError('alarmLineRules must be an array');
  const compiled = rules.map(rule => {
    if (!rule || !text(rule.line) || !text(rule.regionPattern) || !text(rule.equipmentPattern)) throw new TypeError('Each alarm line rule needs line, regionPattern and equipmentPattern');
    const regex = pattern => pattern instanceof RegExp ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')) : new RegExp(pattern);
    return { name: text(rule.line), region: regex(rule.regionPattern), equipment: regex(rule.equipmentPattern) };
  });
  return row => {
    const productionLine = text(row.productionLine), lineName = text(row.lineName), region = text(row.line), equipment = text(row.equipment);
    const conflict = Boolean(productionLine && lineName && productionLine !== lineName);
    if (productionLine || lineName) return { name: productionLine || lineName, source: 'explicit', conflict, origin: region };
    const match = region && equipment ? compiled.find(rule => rule.region.test(region) && rule.equipment.test(equipment)) : null;
    return { name: match ? match.name : region || '未填写区域', source: match ? 'rule' : region ? 'region' : 'unknown', conflict, origin: region };
  };
}

function statusSummary(rows, key, unknown) {
  const groups = new Map();
  for (const row of rows) {
    const name = value(row, key, unknown);
    if (!groups.has(name)) groups.set(name, {
      name, total: 0, unresponded: 0, processing: 0, awaitingRestore: 0, completed: 0, unknown: 0, open: 0
    });
    const group = groups.get(name);
    group.total++;
    const statusKey = row._alarmStatus === 'awaiting_restore' ? 'awaitingRestore' : row._alarmStatus;
    group[statusKey]++;
    if (text(row.isClose) === '0') group.open++;
  }
  return [...groups.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'zh-CN'));
}

function buildWorkBoard(rows, sourceComplete) {
  const columns = ['unresponded', 'processing', 'awaiting_restore'].map(status => ({ status, label: STATUS[status], count: 0, cards: [] }));
  const byStatus = new Map(columns.map(column => [column.status, column]));
  rows.forEach((row, index) => {
    const column = byStatus.get(row._alarmStatus);
    if (!column) return;
    const created = stamp(row.createOn), responded = stamp(row.responseTime), dealt = stamp(row.dealTime);
    const stages = row._alarmStatus === 'unresponded' ? [created] : row._alarmStatus === 'processing' ? [created, responded] : [created, responded, dealt];
    const knownStages = stages.filter(time => time !== null);
    const ordered = knownStages.every((time, at) => at === 0 || time >= knownStages[at - 1]);
    const start = stages.at(-1);
    const sourceId = (typeof row.id === 'string' && text(row.id)) || (typeof row.id === 'number' && Number.isFinite(row.id));
    column.cards.push({
      id: sourceId ? row.id : `display-${index + 1}`, idSource: sourceId ? 'source' : 'display',
      equipment: value(row, 'equipment', '未填写设备'), equipmentCode: text(row.equipMentCode) || null,
      line: row._alarmLine, department: row._alarmDepartment, group: value(row, 'groupName', '未填写小组'),
      status: row._alarmStatus, statusLabel: row._alarmStatusLabel,
      createdAt: created === null ? null : text(row.createOn),
      responseAt: responded === null ? null : text(row.responseTime),
      dealtAt: dealt === null ? null : text(row.dealTime),
      // UTC ISO avoids browser-local timezone guesses. Future timestamps require
      // the UI's current-time check; this pure calculation does not read a clock.
      stageStartedAt: start !== null && ordered ? new Date(start).toISOString() : null,
      description: text(row.beforeProblem) || null
    });
    column.count++;
  });
  return {
    columns,
    unknownCount: rows.filter(row => row._alarmStatus === 'unknown').length,
    completedCount: rows.filter(row => row._alarmStatus === 'completed').length,
    totalOpenCount: rows.filter(row => text(row.isClose) === '0').length,
    complete: typeof sourceComplete === 'boolean' ? sourceComplete : null
  };
}

function buildAlarmReport(input, settings = {}) {
  if (!Array.isArray(input)) throw new TypeError('input must be an array');
  if (settings.departments !== undefined && (!Array.isArray(settings.departments) || settings.departments.some(name => !text(name)))) throw new TypeError('departments must be an array of names');
  const resolveDepartment = departmentResolver(settings.departmentRules);
  const resolveLine = lineResolver(settings.alarmLineRules);
  const declaredDepartments = [...new Set([...(settings.departments || []).map(text),
    ...(settings.departmentRules || []).map(rule => text(rule.department)), UNKNOWN_DEPARTMENT])];
  const metadata = new Map();
  const decorated = input.map(raw => {
    const original = raw && typeof raw === 'object' ? raw : {};
    const status = alarmStatus(original), department = resolveDepartment(original), line = resolveLine(original);
    const row = { ...original, _alarmStatus: status, _alarmStatusLabel: STATUS[status],
      _alarmLine: line.name, lineOrigin: line.origin, _alarmLineSource: line.source, _alarmDepartment: department.name };
    metadata.set(row, { department, line });
    return row;
  });
  const startDate = settings.startDate ? normalizeDate(settings.startDate) : null;
  const endDate = settings.endDate ? normalizeDate(settings.endDate) : null;
  if ((settings.startDate && !startDate) || (settings.endDate && !endDate) || (startDate && endDate && startDate > endDate)) throw new RangeError('Invalid alarm reporting period');
  if (startDate && endDate && (Date.parse(endDate) - Date.parse(startDate)) / 86400000 > 41) throw new RangeError('Alarm reporting period exceeds 42 days');
  const all = decorated.filter(row => {
    if (!startDate && !endDate) return true;
    const date = normalizeDate(row.createOn);
    return date && (!startDate || date >= startDate) && (!endDate || date <= endDate);
  });
  const selected = { status: Object.hasOwn(STATUS, settings.status) ? settings.status : 'all',
    line: text(settings.line) || 'all', group: text(settings.group) || 'all', department: text(settings.department) || 'all' };
  const keyword = text(settings.keyword).toLowerCase();
  const rows = all.filter(row =>
    (selected.status === 'all' || row._alarmStatus === selected.status) &&
    (selected.line === 'all' || row._alarmLine === selected.line) &&
    (selected.group === 'all' || value(row, 'groupName', '未填写小组') === selected.group) &&
    (selected.department === 'all' || row._alarmDepartment === selected.department) &&
    (!keyword || Object.values(row).some(v => text(v).toLowerCase().includes(keyword)))
  );
  const statusCounts = Object.entries(STATUS).map(([key, label]) => ({ name: label, label, value: key, count: rows.filter(row => row._alarmStatus === key).length }));
  const count = key => statusCounts.find(item => item.value === key).count;
  const overview = { recordCount: rows.length, openCount: rows.filter(row => text(row.isClose) === '0').length,
    unrespondedCount: count('unresponded'), processingCount: count('processing'), awaitingRestoreCount: count('awaiting_restore'),
    completedCount: count('completed'), unknownCount: count('unknown') };
  const days = new Map();
  if (startDate && endDate) {
    const date = new Date(startDate + 'T00:00:00Z');
    while (date.toISOString().slice(0, 10) <= endDate) {
      const day = date.toISOString().slice(0, 10);
      days.set(day, { date: day, label: day.slice(5), total: 0, open: 0, completed: 0 });
      date.setUTCDate(date.getUTCDate() + 1);
    }
  }
  for (const row of rows) {
    const date = normalizeDate(row.createOn);
    if (!date) continue;
    if (!days.has(date)) days.set(date, { date, label: date.slice(5), total: 0, open: 0, completed: 0 });
    const day = days.get(date);
    day.total++;
    if (text(row.isClose) === '0') day.open++;
    if (row._alarmStatus === 'completed') day.completed++;
  }
  const dailyTrend = [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map(day => ({
    ...day,
    total: day.total === 0 && settings.sourceComplete !== true ? null : day.total,
    open: day.total === 0 && settings.sourceComplete !== true ? null : day.open,
    completed: day.total === 0 && settings.sourceComplete !== true ? null : day.completed,
    complete: settings.sourceComplete === true
  }));
  const lineSummary = statusSummary(rows, '_alarmLine', '未填写区域');
  const observedDepartments = statusSummary(rows, '_alarmDepartment', UNKNOWN_DEPARTMENT);
  const departmentNames = [...new Set([...declaredDepartments, ...observedDepartments.map(item => item.name)])];
  const emptyCount = settings.sourceComplete === true ? 0 : null;
  const departmentSummary = departmentNames.map(name => observedDepartments.find(item => item.name === name) || {
    name, total: emptyCount, unresponded: emptyCount, processing: emptyCount, awaitingRestore: emptyCount,
    completed: emptyCount, unknown: emptyCount, open: emptyCount
  });
  const departmentOptions = filterOptions(all, '_alarmDepartment', UNKNOWN_DEPARTMENT);
  const allDepartmentNames = [...new Set([...declaredDepartments, ...departmentOptions.map(item => item.value)])];
  return {
    overview, kpis: overview, selected, filteredRows: rows, statusCounts,
    workBoard: buildWorkBoard(rows, settings.sourceComplete),
    progressBoard: statusCounts.filter(item => item.value !== 'unknown').map(({ value, label, count }) => ({ value, label, count })),
    lineSummary, lineStatusMatrix: lineSummary, departmentSummary, dailyTrend,
    equipmentTop: ranking(rows, 'equipment', '未填写设备').slice(0, 10),
    lineTop: ranking(rows, '_alarmLine', '未填写区域').slice(0, 10),
    groupTop: ranking(rows, 'groupName', '未填写小组').slice(0, 10),
    durations: { response: duration(rows, 'createOn', 'responseTime'), handling: duration(rows, 'responseTime', 'dealTime'), closure: duration(rows, 'createOn', 'trackOn') },
    options: {
      statuses: Object.entries(STATUS).map(([key, label]) => ({ value: key, label, count: all.filter(row => row._alarmStatus === key).length })),
      lines: filterOptions(all, '_alarmLine', '未填写区域'),
      groups: filterOptions(all, 'groupName', '未填写小组'),
      departments: allDepartmentNames.map(name => departmentOptions.find(item => item.value === name) || { value: name, label: name, count: emptyCount })
    },
    diagnostics: {
      restorationStateConflicts: rows.filter(row => text(row.isClose) === '0' && stamp(row.trackOn) !== null).length,
      departmentRuleConflicts: rows.filter(row => metadata.get(row).department.conflict).length,
      unmappedDepartmentRows: rows.filter(row => row._alarmDepartment === UNKNOWN_DEPARTMENT).length,
      explicitLineConflicts: rows.filter(row => metadata.get(row).line.conflict).length,
      configuredLineRows: rows.filter(row => metadata.get(row).line.source === 'rule').length,
      regionFallbackRows: rows.filter(row => metadata.get(row).line.source === 'region').length,
      missingLineRows: rows.filter(row => metadata.get(row).line.source === 'unknown').length,
      missingOrInvalidDateRows: decorated.filter(row => !normalizeDate(row.createOn)).length,
      rowsExcludedByDate: decorated.length - all.length
    },
    notes: [
      '报警数为所选创建日期内的记录数；待处理数不包含日期范围外的历史未结单。',
      '已完成以原系统isClose=1为准；未闭环且有有效解决时间为待复线，有响应标记或有效响应时间为处理中，明确未响应才列待响应。',
      '有效复线时间与未闭环标记同时存在时属于状态冲突，列入状态待核实，不擅自当作已完成或待复线。',
      '部门仅按已确认配置匹配指定字段；按报警类别归口是配置后的统计归口，不是接口原生部门字段。无匹配或多部门规则冲突时显示部门待确认，原负责小组字段保留。',
      '线体优先使用原始productionLine或lineName，其次采用已配置且同时匹配区域与设备的规则（按顺序首个命中），否则保留原line区域；不泛化猜测产线编号。',
      '响应时长：创建至响应；处理时长：响应至解决；复线时长：创建至复线。仅使用有效且顺序正确的时间样本，不删去长时异常。',
      '图表、进度卡、部门分布与明细使用同一筛选范围；未证明取数完整且没有观测的日期保留缺失。',
      '三栏看板每张卡片对应一条已读取报警，不合并同设备的多条报警，且不受明细分页影响；已完成和状态待核实记录不进入三栏。',
      '阶段计时分别从创建、响应、解决时刻开始；对应时刻缺失或已知时序倒置时不计时，未来时刻需显示待核实，不能显示负持续时间。缺失ID的展示编号仅在本次结果内有效。',
      '未返回的设备状态不作正常判断；这些汇总不代表独立设备运行状态。'
    ]
  };
}
module.exports = { buildAlarmReport, alarmStatus, stamp, STATUS, UNKNOWN_DEPARTMENT };

