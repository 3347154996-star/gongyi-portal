(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VisionMesStats = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const str = value => typeof value === 'string' ? value.trim() : '';
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const percent = (value, total) => total ? value / total * 100 : null;
  const key = values => JSON.stringify(values);
  const judge = value => value === 'OK' || value === 'NG' ? value : null;
  const unavailable = reason => ({ available: false, reason, warnings: [] });
  const METHODS = Object.freeze({ minCapabilitySamples: 30, standardDeviation: 'sample (n-1)',
    control: 'individuals moving range (d2=1.128)', ratesUnit: 'percent (0..100)' });
  function stamp(value) {
    if (typeof value !== 'string') return null;
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,7})?)?(Z|[+-]\d{2}:\d{2})?$/);
    if (!match) return null;
    const [, year, month, day, hour, minute, second = '00', fraction = '', zone = '+08:00'] = match;
    const calendar = new Date(Date.UTC(+year, +month - 1, +day));
    if (+year < 100 || calendar.getUTCFullYear() !== +year || calendar.getUTCMonth() !== +month - 1 || calendar.getUTCDate() !== +day || +hour > 23 || +minute > 59 || +second > 59) return null;
    const result = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}${fraction}${zone}`);
    return Number.isFinite(result) ? result : null;
  }
  function moments(values) {
    let n = 0, avg = 0, m2 = 0, min = Infinity, max = -Infinity;
    for (const value of values) if (finite(value)) {
      n++;const delta = value - avg;avg += delta / n;m2 += delta * (value - avg);
      min = Math.min(min, value);max = Math.max(max, value);
    }
    const safe = value => finite(value) ? value : null;
    return { n, avg: n ? safe(avg) : null, min: n ? min : null, max: n ? max : null,
      range: n ? safe(max - min) : null, std: n > 1 && finite(m2) ? safe(Math.sqrt(Math.max(0, m2 / (n - 1)))) : null };
  }
  function capability(group, complete, selected) {
    const s = group.stats;
    let reason = !complete ? '检测记录或测点详情未完整读取。' : selected ? '样本限定了工件码或检测结论，不能估算整体过程性能。' :
      group.identityIncomplete ? '物料、生产线号或检具标识不完整，无法确认样本同组。' : group.specChanged ? '同一测点存在规格或单位变化，各版本分别显示，不计算 Pp/Ppk。' :
      group.isEqual ? '等值判定没有双侧连续规格区间。' : !finite(group.lowerLimit) || !finite(group.upperLimit) ? '缺少双侧规格限，单侧规格不计算本模块的 Pp/Ppk。' :
      group.upperLimit <= group.lowerLimit ? '规格上下限相同或无效。' : s.n < METHODS.minCapabilitySamples ? '有效数值样本少于 30，暂不估算 Pp/Ppk。' :
      s.missing || s.unknown ? '存在缺失数值、缺失测点或未知判定，不能确认完整样本分布。' : !finite(s.std) ? '数值尺度导致波动计算不可用。' : s.std === 0 ? '样本零波动，不能将 Pp/Ppk 表示为无穷大。' : null;
    if (reason) return { ...unavailable(reason), pp: null, ppk: null };
    const pp = (group.upperLimit - group.lowerLimit) / (6 * s.std);
    const ppk = Math.min((group.upperLimit - s.avg) / (3 * s.std), (s.avg - group.lowerLimit) / (3 * s.std));
    if (!finite(pp) || !finite(ppk)) return { ...unavailable('数值尺度导致能力估算不可用。'), pp: null, ppk: null };
    const warnings = ['仅为当前样本的整体性能估算；过程稳定性、正态性和样本独立性尚未验证，不能据此认定过程具备能力。'];
    if (s.n < 50) warnings.unshift('有效样本少于 50，估算不确定性较大；30 是本模块显示下限，并非能力认可标准。');
    return { available: true, reason: null, pp, ppk, warnings };
  }
  function control(group, complete, selected) {
    const base = { label: '估计控制界限（I-MR），不是规格限', mean: group.stats.avg, ucl: null, lcl: null, mrBar: null, pairs: 0 };
    const reason = !complete ? '测点详情未完整读取。' : selected ? '样本被工件码或检测结论截取，不估算过程控制界限。' :
      group.identityIncomplete ? '同组标识不完整。' : group.specChanged ? '规格或单位发生变化，不跨规格估计控制界限。' : group.isEqual ? '等值判定不适用连续值 I-MR 估计。' : null;
    if (reason) return { ...base, ...unavailable(reason) };
    const ranges = [], times = new Map();
    for (const row of group.observations) times.set(row.timestamp, (times.get(row.timestamp) || 0) + 1);
    for (let i = 1; i < group.observations.length; i++) {
      const previous = group.observations[i - 1], current = group.observations[i];
      if (finite(previous.actual) && finite(current.actual) && previous.timestamp !== null && current.timestamp > previous.timestamp && times.get(previous.timestamp) === 1 && times.get(current.timestamp) === 1) ranges.push(Math.abs(current.actual - previous.actual));
    }
    if (!ranges.length) return { ...base, ...unavailable('没有可确认先后顺序的相邻有效数值对；不跨缺失值或相同时间计算移动极差。') };
    const mrBar = moments(ranges).avg;
    if (!finite(mrBar) || mrBar <= 0 || !finite(base.mean)) return { ...base, pairs: ranges.length, ...unavailable('移动极差为零或不可用，不生成退化的控制界限。') };
    const width = 3 * mrBar / 1.128, ucl = base.mean + width, lcl = base.mean - width;
    if (!finite(ucl) || !finite(lcl)) return { ...base, ...unavailable('数值尺度导致控制界限不可用。') };
    const warnings = ['由本次样本估计，未验证稳定性及独立性；不是来源提供的 UCL/LCL，不是 USL/LSL。'];
    if (group.stats.n < 30) warnings.unshift('样本少于 30，控制界限仅供探索，不作为正式控制基线。');
    if (group.observations.some((row, i, rows) => i && row.timestamp === rows[i - 1].timestamp)) warnings.push('同时间检测的先后顺序未知，未用该相邻对计算移动极差。');
    return { ...base, available: true, reason: null, ucl, lcl, mrBar, pairs: ranges.length, warnings };
  }
  function detailArray(details) {
    if (Array.isArray(details)) return details;
    if (details instanceof Map) return [...details.values()];
    if (object(details)) return Object.values(details);
    return [];
  }
  function analyze(input) {
    if (!object(input) || !object(input.report) || !Array.isArray(input.report.records)) throw new TypeError('需要完整检测列表及对应测点详情。');
    const report = input.report, includeNonCritical = input.includeNonCritical !== false;
    if (report.summary && (!Number.isSafeInteger(report.summary.total) || report.summary.total !== report.records.length)) throw new TypeError('检测汇总与记录数量不一致，不能使用当前分页代替完整样本。');
    const topN = input.topN === undefined ? 10 : input.topN;
    if (!Number.isInteger(topN) || topN < 1 || topN > 100) throw new TypeError('排行数量必须为 1–100 的整数。');
    const records = new Map(), ordered = [], bases = new Map(), groups = new Map(), versions = new Map();
    for (const record of report.records) {
      if (!object(record) || !str(record.recordId) || records.has(record.recordId) || !['OK', 'NG', null].includes(record.result)) throw new TypeError('检测记录标识重复、缺失或结论无效。');
      const timestamp = stamp(record.measuredAt);
      if (timestamp === null) throw new TypeError('检测时间无效，不能按时间统计。');
      const productionLine = /^(?:[1-9]|[1-9]\d)$/.test(str(record.productionLine)) ? record.productionLine : 'unknown';
      const baseId = key([str(record.lineCode), str(record.processCode), str(record.partCode), productionLine, str(record.deviceCode)]);
      const row = { ...record, productionLine, timestamp, baseId };
      records.set(row.recordId, row);ordered.push(row);
      if (!bases.has(baseId)) bases.set(baseId, []);bases.get(baseId).push(row);
    }
    const order = (a, b) => a.timestamp - b.timestamp || a.recordId.localeCompare(b.recordId, 'en');
    ordered.sort(order);for (const rows of bases.values()) rows.sort(order);
    const loaded = new Set();let excludedNonCritical = 0, unknownCritical = 0, knownCritical = 0, emptyDetails = 0;
    for (const detail of detailArray(input.details)) {
      if (!object(detail) || !records.has(detail.recordId) || loaded.has(detail.recordId) || !Array.isArray(detail.measurements)) throw new TypeError('测点详情与检测列表不对应，或详情重复。');
      const record = records.get(detail.recordId);
      for (const field of ['barcode', 'partCode', 'deviceCode', 'productionLine', 'measuredAt', 'lineCode', 'processCode']) {
        if (detail[field] !== undefined && detail[field] !== record[field]) throw new TypeError('测点详情身份与检测记录不一致。');
      }
      loaded.add(detail.recordId);if (!detail.measurements.length) emptyDetails++;
      const seen = new Set();
      for (const measurement of detail.measurements) {
        if (!object(measurement) || !str(measurement.key) || !str(measurement.name) || seen.has(measurement.key)) throw new TypeError('测点标识或名称无效，不能确认点位对应关系。');
        seen.add(measurement.key);
        const critical = typeof measurement.isCritical === 'boolean' ? measurement.isCritical : null;
        if (critical === null) unknownCritical++;else knownCritical++;
        if (!includeNonCritical && critical !== true) { excludedNonCritical++;continue; }
        const lowerLimit = finite(measurement.lowerLimit) ? measurement.lowerLimit : null;
        const upperLimit = finite(measurement.upperLimit) ? measurement.upperLimit : null;
        const unit = str(measurement.unit) || null, isEqual = measurement.isEqual === true;
        const pointBase = key([record.baseId, measurement.key]);
        const spec = key([lowerLimit, upperLimit, isEqual, isEqual && finite(measurement.expectedValue) ? measurement.expectedValue : null, unit]);
        const id = key([pointBase, spec]);
        if (!versions.has(pointBase)) versions.set(pointBase, new Set());versions.get(pointBase).add(spec);
        if (!groups.has(id)) groups.set(id, { id, baseId: record.baseId, pointBase, pointKey: measurement.key, pointName: measurement.name, name: measurement.name,
          partCode: str(record.partCode), partName: str(record.partName), deviceCode: str(record.deviceCode), deviceName: str(record.deviceName), productionLine: record.productionLine,
          lowerLimit, upperLimit, unit, isEqual, expectedValue: finite(measurement.expectedValue) ? measurement.expectedValue : null,
          identityIncomplete: !str(record.partCode) || !str(record.deviceCode) || record.productionLine === 'unknown', values: new Map() });
        groups.get(id).values.set(record.recordId, { recordId: record.recordId, barcode: str(record.barcode), measuredAt: record.measuredAt, timestamp: record.timestamp,
          actual: finite(measurement.actual) ? measurement.actual : null, actualRaw: typeof measurement.actualRaw === 'string' ? measurement.actualRaw : null,
          result: judge(measurement.result), present: true });
      }
    }
    const missingRecordIds = ordered.filter(row => !loaded.has(row.recordId)).map(row => row.recordId);
    const complete = report.coverage?.complete === true && missingRecordIds.length === 0 && emptyDetails === 0;
    const coverage = { expectedRecords: records.size, loadedRecords: loaded.size, missingRecords: missingRecordIds.length, missingRecordIds,
      emptyDetails, complete, excludedNonCritical, unknownCritical };
    const selected = !!str(report.filters?.barcode) || !!(report.filters?.result && report.filters.result !== 'all');
    const warnings = ['每个检测记录分别计次，复测不合并；测点 NG 次数不等于不合格工件数。', 'Pp/Ppk 使用本组全部有限数值的样本标准差；未验证稳定性、正态性及独立性，仅为估算。', '来源单位缺失时不补毫米，也不将实际值自动解释为尺寸偏差。'];
    if (!complete) warnings.unshift('检测列表或全部测点详情未完整读取，不提供完整 NG 排行及过程性能指标。');
    if (emptyDetails) warnings.push(`${emptyDetails} 条检测没有返回测点，不能确认测点覆盖完整。`);
    if (unknownCritical) warnings.push(`来源未明确 ${unknownCritical} 个测点事件是否关键，不根据名称或判定猜测。`);
    if (!includeNonCritical) warnings.push('仅包含来源明确标记为关键的测点；关键性未知的测点未纳入。');
    const resultGroups = [];
    for (const group of groups.values()) {
      group.specChanged = versions.get(group.pointBase).size > 1;
      group.label = `${group.partName || group.partCode || '物料未注明'} · ${group.productionLine === 'unknown' ? '生产线号待确认' : '生产 ' + group.productionLine + ' 线'} · ${group.deviceName || group.deviceCode || '检具未注明'} · ${group.pointName}` + (group.specChanged ? ` · 规格 ${group.lowerLimit ?? '—'}～${group.upperLimit ?? '—'}${group.unit || ''}` : '');
      group.observations = bases.get(group.baseId).map(record => group.values.get(record.recordId) || { recordId: record.recordId, barcode: str(record.barcode), measuredAt: record.measuredAt,
        timestamp: record.timestamp, actual: null, actualRaw: null, result: null, present: false });
      const observed = group.observations.filter(row => row.present);
      const ok = observed.filter(row => row.result === 'OK').length, ng = observed.filter(row => row.result === 'NG').length;
      group.stats = { ...moments(observed.map(row => row.actual)), observed: observed.length, ok, ng, unknown: observed.length - ok - ng,
        missing: group.observations.filter(row => !finite(row.actual)).length, validObserved: ok + ng, ngRate: percent(ng, ok + ng), pp: null, ppk: null };
      group.capability = capability(group, complete, selected);group.stats.pp = group.capability.pp;group.stats.ppk = group.capability.ppk;
      group.control = control(group, complete, selected);
      delete group.values;delete group.baseId;delete group.pointBase;resultGroups.push(group);
    }
    resultGroups.sort((a, b) => b.stats.ng - a.stats.ng || a.label.localeCompare(b.label, 'zh-CN') || a.id.localeCompare(b.id, 'en'));
    const allNG = resultGroups.filter(group => group.stats.ng > 0), totalNG = allNG.reduce((sum, group) => sum + group.stats.ng, 0);
    let cumulative = 0;
    const items = complete ? allNG.slice(0, topN).map(group => { cumulative += group.stats.ng;return { groupId: group.id, name: group.label, ng: group.stats.ng,
      validObserved: group.stats.validObserved, ngRate: group.stats.ngRate, cumulativePercent: percent(cumulative, totalNG) }; }) : [];
    const pie = { total: records.size, ok: ordered.filter(row => row.result === 'OK').length, ng: ordered.filter(row => row.result === 'NG').length, unknown: ordered.filter(row => row.result === null).length };
    return { complete, coverage, criticalMetadataAvailable: knownCritical > 0 && unknownCritical === 0, includeNonCritical, warnings, methods: METHODS,
      groups: resultGroups, pareto: { available: complete, complete, items, totalNG, otherNG: totalNG - cumulative }, pie };
  }
  return Object.freeze({ analyze, moments, methods: METHODS });
}));
