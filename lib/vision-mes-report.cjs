'use strict';

const { randomBytes } = require('node:crypto');
const PATHS = Object.freeze({ catalog: '/api/Cx/select', report: '/api/ProcessReport', detail: '/api/ProcessReport/detail/' });
const PAGE_SIZE = 200;
const ANALYSIS_BATCH_SIZE = 20, ANALYSIS_MAX_RECORDS = 1000;
// This connector already rejects pre-2000 measurement timestamps. Count mode
// searches its entire supported history, rather than silently defaulting today.
const HISTORY_START = '2000-01-01 00:00:00';
const EXCLUDED_LINE_NAME = /^TSL四期(?:前|后)(?:副|幅)在线尺寸检测$/i;
const OFFSET = 8 * 60 * 60 * 1000;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const fail = (message, status = 502) => Object.assign(new Error(message), { name: 'MesVisionReportError', status });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length <= 1000 && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : null;
function id(value, status = 502) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== 'string' || !/^[1-9]\d{0,17}$/.test(value)) throw fail('MES 记录或线体标识格式无效。', status);
  return value;
}
function unwrap(response) {
  if (!object(response)) throw fail('MES 返回格式变化，未取得可信结果。');
  if (Number(response.code) === 401) throw fail('MES 登录已失效，请重新连接。', 401);
  if (Number(response.code) === 403) throw fail('当前账号没有此 MES 查询的读取权限。', 403);
  if (response.code !== 0 && response.code !== '0') throw fail('MES 未允许本次查询，请核对查询权限。');
  return response.data;
}
function time(value, { endOfDay = false, status = 400 } = {}) {
  const raw = text(value);
  const match = raw && /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(raw);
  if (!match || Number(match[1]) < 2000) throw fail('检测时间格式无效。', status);
  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  const h = hour === undefined ? endOfDay ? 23 : 0 : Number(hour);
  const m = minute === undefined ? endOfDay ? 59 : 0 : Number(minute);
  const s = second === undefined ? endOfDay ? 59 : 0 : Number(second);
  if (h > 23 || m > 59 || s > 59) throw fail('检测时间格式无效。', status);
  const datePart = `${year}-${month}-${day}`;
  const date = new Date(`${datePart}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== datePart) throw fail('检测时间不是有效日期。', status);
  const ms = fraction ? Number((fraction + '000').slice(0, 3)) : second === undefined && endOfDay ? 999 : 0;
  const iso = `${datePart}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}${zone || '+08:00'}`;
  const epoch = Date.parse(iso);
  if (!Number.isFinite(epoch)) throw fail('检测时间格式无效。', status);
  return epoch;
}
function localTime(epoch, iso = false) {
  const value = new Date(epoch + OFFSET).toISOString();
  const base = value.slice(0, 19) + (value.slice(19, 23) === '.000' ? '' : value.slice(19, 23));
  return iso ? `${base}+08:00` : base.replace('T', ' ');
}
function bounded(value, fallback, maximum) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}
function optionalFilter(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const cleaned = text(value);
  if (!cleaned || cleaned.length > 200) throw fail(`${label}格式无效。`, 400);
  return cleaned;
}
function recentLimit(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'string' && /^\d{1,5}$/.test(value.trim())) value = Number(value.trim());
  if (!Number.isInteger(value) || value < 0 || value > 20000) throw fail('最近检测次数须为 1–20000 的整数，或选择日期内全部。', 400);
  return value;
}
function productionLineFromBarcode(barcode) {
  // The verified production suffix has two line digits before A/B. A date may
  // immediately precede those digits; a greedy digit run would absorb the date.
  const match = /([0-9]{2})[AB][0-9]+$/i.exec(barcode);
  return match && Number(match[1]) > 0 ? String(Number(match[1])) : 'unknown';
}
function productionLineFilter(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value === 'unknown') return value;
  if (typeof value !== 'string' || !/^\d{1,2}$/.test(value) || Number(value) < 1) throw fail('请选择有效的 SN 生产线号或待确认。', 400);
  return String(Number(value));
}
function normalizeRecord(row, line, start, end) {
  if (!object(row)) throw fail('MES 工序记录包含无效条目。');
  const recordId = id(row.id), barcode = text(row.barCode);
  if (!barcode) throw fail('MES 工序记录缺少有效工件码。');
  if (text(row.productLineCode) !== line.code) throw fail('MES 返回了其他线体的记录。');
  const epoch = time(row.endTime, { status: 502 });
  if (epoch < start || epoch > end) throw fail('MES 返回的检测时间超出查询范围。');
  const rawResult = text(row.type);
  const result = rawResult && ['OK', 'NG'].includes(rawResult.toUpperCase()) ? rawResult.toUpperCase() : null;
  return { recordId, barcode, measuredAt: localTime(epoch, true), lineId: line.id, lineCode: line.code,
    lineName: text(row.productLineName) || line.name, productionLine: productionLineFromBarcode(barcode),
    processCode: text(row.gxCode), processName: text(row.gxName),
    deviceCode: text(row.equipmentCode), deviceName: text(row.equipmentName), partCode: text(row.itemCode),
    partName: text(row.itemName), stationCode: text(row.stationCode), stationName: text(row.stationName), result };
}
function numberField(value) {
  if (value === undefined || value === null) return { value: null, raw: null };
  if (typeof value === 'number') return { value: Number.isFinite(value) ? value === 0 ? 0 : value : null, raw: String(value) };
  const raw = text(value);
  return { value: raw && NUMBER.test(raw) && Number.isFinite(Number(raw)) ? Number(raw) || 0 : null, raw };
}
function normalizeDetail(data, record) {
  if (!Array.isArray(data) || data.length > 10000) throw fail('MES 参数详情格式无效或超过读取上限。');
  const measurements = [], keys = new Set();
  let additionalFieldCount = 0, missingValues = 0, missingLimits = 0, disagreements = 0;
  for (const row of data) {
    if (!object(row)) throw fail('MES 参数详情包含无效条目。');
    const name = text(row.param_Name);
    // The process response also contains unnamed collection status fields. They
    // are not configured measurement points and must not inflate point counts.
    if (!name) { additionalFieldCount++; continue; }
    const key = text(row.key) || name;
    if (keys.has(key)) throw fail('MES 测点标识重复，无法确认对应关系。');
    keys.add(key);
    const actual = numberField(row.value), lower = numberField(row.param_DOWN), upper = numberField(row.param_UP);
    const rawResult = text(row.result), normalized = rawResult && rawResult.toUpperCase();
    const result = ['OK', 'NG'].includes(normalized) ? normalized : null;
    const equal = row.is_equal === 1 || row.is_equal === '1' || row.is_equal === true;
    const expected = numberField(row.specific_value);
    if (lower.value !== null && upper.value !== null && lower.value > upper.value) throw fail('MES 测点下限大于上限。');
    if (actual.value === null) missingValues++;
    if (equal ? expected.value === null : lower.value === null || upper.value === null) missingLimits++;
    if (actual.value !== null && result && (equal ? expected.value !== null : lower.value !== null && upper.value !== null)) {
      const inRange = equal ? actual.value === expected.value : actual.value >= lower.value && actual.value <= upper.value;
      if ((inRange ? 'OK' : 'NG') !== result) disagreements++;
    }
    measurements.push({ key, name, actual: actual.value, actualRaw: actual.raw, lowerLimit: lower.value,
      lowerLimitRaw: lower.raw, upperLimit: upper.value, upperLimitRaw: upper.raw, result, resultRaw: rawResult,
      originResult: null, originResultRaw: null, reworkActual: null, reworkActualRaw: null, isRework: null,
      unit: null, critical: null, isEqual: equal, expectedValue: expected.value });
  }
  const pointSummary = { total: measurements.length, ok: 0, ng: 0, unknown: 0 };
  for (const row of measurements) pointSummary[row.result === 'OK' ? 'ok' : row.result === 'NG' ? 'ng' : 'unknown']++;
  const warnings = ['检测结论采用工序报表的原始结果；测点 NG 数不代替工件判定。', '来源未提供测点单位，未自动解释为尺寸偏差。'];
  if (additionalFieldCount) warnings.push(`${additionalFieldCount} 项无测点名称的采集字段未计入测点数量。`);
  if (missingValues) warnings.push(`${missingValues} 项实际值缺失或不是数值，未替换为 0。`);
  if (missingLimits) warnings.push(`${missingLimits} 项缺少完整判定范围。`);
  if (disagreements) warnings.push(`${disagreements} 项数值范围与来源判定不一致，保留来源判定。`);
  if (!measurements.length) warnings.push('本条记录未返回有名称的测点。');
  return { ...record, sourceResult: record.result, sourceType: 'ProcessReport', sourceRecordedAt: null,
    measurements, pointSummary, additionalFieldCount, warnings };
}

function createMesVisionReportConnector({ request, now = Date.now, config = {} }) {
  if (typeof request !== 'function' || typeof now !== 'function') throw new TypeError('MES report requires request and now functions.');
  // Other portal modules have their own top-level page limit. Do not silently
  // inherit that unrelated limit for the dimensional report.
  const maxPages = bounded(config.vision?.mes?.maxPages, 150, 150);
  const maxDurationMs = bounded(config.maxDurationMs, 45000, 45000);
  const maxSessions = bounded(config.maxSessions, 8, 32);
  const maxCachedRecords = bounded(config.maxCachedRecords, 30000, 30000);
  const cacheTtlMs = bounded(config.cacheTtlMs, 30 * 60 * 1000, 30 * 60 * 1000);
  const analysisConfig = config.vision?.mes || {};
  const snapshotTtlMs = bounded(analysisConfig.analysisSnapshotTtlMs, 30 * 60 * 1000, 30 * 60 * 1000);
  const maxSnapshots = bounded(analysisConfig.analysisMaxSnapshots, 32, 64);
  const detailCacheTtlMs = bounded(analysisConfig.analysisDetailCacheTtlMs, 5 * 60 * 1000, 5 * 60 * 1000);
  const maxDetailCacheEntries = bounded(analysisConfig.analysisDetailCacheEntries, 1000, 1000);
  const maxDetailCachePoints = bounded(analysisConfig.analysisDetailCachePoints, 75000, 75000);
  const sessions = new Map();
  const detailCache = new Map(), detailPending = new Map(), detailQueue = [];
  let cachedPoints = 0, activeDetails = 0;
  function trimDetailCache() {
    for (const [key, value] of detailCache) if (now() >= value.expiresAt) { cachedPoints -= value.size; detailCache.delete(key); }
    while (detailCache.size > maxDetailCacheEntries || cachedPoints > maxDetailCachePoints) {
      const key = detailCache.keys().next().value; cachedPoints -= detailCache.get(key).size; detailCache.delete(key);
    }
  }
  function limitedDetail(task) {
    if (detailQueue.length >= 64) return Promise.reject(fail('测点读取队列繁忙，请稍后重试。', 429));
    return new Promise((resolve, reject) => {
      detailQueue.push({ task, resolve, reject }); drainDetails();
    });
  }
  function drainDetails() {
    while (activeDetails < 2 && detailQueue.length) {
      const job = detailQueue.shift(); activeDetails++;
      // Hold the slot until the actual upstream promise settles, even if its
      // caller's deadline races first. Timed-out reads must not exceed the cap.
      Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => { activeDetails--; drainDetails(); });
    }
  }
  function cache(token) {
    for (const [key, value] of sessions) if (now() - value.updatedAt > cacheTtlMs) sessions.delete(key);
    let value = sessions.get(token);
    if (!value) value = { records: new Map(), snapshots: new Map(), updatedAt: now() };
    sessions.delete(token);
    sessions.set(token, value);
    while (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value);
    return value;
  }
  function remember(token, records) {
    const entry = cache(token);
    // Retain the latest displayed records first when a bounded cache is full.
    for (const record of [...records].reverse()) { entry.records.delete(record.recordId); entry.records.set(record.recordId, record); }
    while (entry.records.size > maxCachedRecords) entry.records.delete(entry.records.keys().next().value);
    entry.updatedAt = now();
  }
  function snapshotScope(value, required = false) {
    if (value === undefined || value === null || value === '') {
      if (required) throw fail('测点分析需要有效的门户登录会话，请重新查询。', 400);
      return null;
    }
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw fail('门户分析会话标识无效。', 400);
    return value;
  }
  function createSnapshot(token, scope, records, filters, complete) {
    const base = { available: false, snapshotId: null, total: records.length, batchSize: ANALYSIS_BATCH_SIZE, maxRecords: ANALYSIS_MAX_RECORDS, expiresAt: null };
    if (!complete) return { ...base, reason: '检测记录未完整读取，不能生成全范围测点分析。' };
    if (!records.length) return { ...base, reason: '当前范围没有检测记录。' };
    if (records.length > ANALYSIS_MAX_RECORDS) return { ...base, reason: `测点分析最多支持 ${ANALYSIS_MAX_RECORDS} 次完整检测，请缩小时间范围或数量；不会抽样。` };
    if (!scope) return { ...base, reason: '缺少门户登录会话信息，请刷新后重新查询。' };
    const entry = cache(token), createdAt = now();
    for (const [key, value] of entry.snapshots) if (createdAt >= value.expiresAt) entry.snapshots.delete(key);
    const snapshotId = randomBytes(24).toString('hex'), expiresAt = createdAt + snapshotTtlMs;
    entry.snapshots.set(snapshotId, { scope, expiresAt, records: records.map(row => Object.freeze({ ...row })), filters: Object.freeze({ ...filters }) });
    while (entry.snapshots.size > maxSnapshots) entry.snapshots.delete(entry.snapshots.keys().next().value);
    entry.updatedAt = createdAt;
    return { ...base, available: true, snapshotId, expiresAt: new Date(expiresAt).toISOString(), reason: null };
  }
  function findSnapshot(token, scope, snapshotId) {
    if (typeof snapshotId !== 'string' || !/^[a-f0-9]{48}$/.test(snapshotId)) throw fail('测点分析快照标识无效，请重新查询。', 400);
    const entry = cache(token), snapshot = entry.snapshots.get(snapshotId);
    if (!snapshot || snapshot.scope !== scope) throw fail('测点分析快照不属于当前登录会话或已失效，请重新查询。', 404);
    if (now() >= snapshot.expiresAt) { entry.snapshots.delete(snapshotId); throw fail('测点分析快照已过期，请重新查询。', 410); }
    entry.snapshots.delete(snapshotId); entry.snapshots.set(snapshotId, snapshot); entry.updatedAt = now();
    return snapshot;
  }
  async function read(q, session) {
    if (!object(q) || !['catalog', 'report', 'detail', 'analysis'].includes(q.action)) throw fail('请选择有效的 MES 报表操作。', 400);
    if (!session || typeof session.token !== 'string' || !session.token) throw fail('请先建立公司数据源连接。', 428);
    const started = now(), wallStarted = Date.now();
    const scope = snapshotScope(q._viewerScope, q.action === 'analysis');
    const remainingTime = () => Math.min(maxDurationMs - (now() - started), maxDurationMs - (Date.now() - wallStarted));
    async function get(path, query) {
      const remaining = remainingTime();
      if (remaining <= 0) throw fail('MES 查询已达到时间上限，尚未读取完整范围。', 504);
      let timer;
      try {
        return await Promise.race([
          path.startsWith(PATHS.detail) ? limitedDetail(() => {
            if (remainingTime() <= 0) throw fail('测点查询已达到时间上限，请重试该批次。', 504);
            return request(path, { method: 'GET', token: session.token, query });
          }) : request(path, { method: 'GET', token: session.token, query }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(fail('MES 查询超时，尚未读取完整范围。', 504)), remaining); }),
        ]);
      } finally { clearTimeout(timer); }
    }
    const fetched = () => new Date(now()).toISOString();
    async function analysisDetail(record) {
      const key = JSON.stringify([session.token, scope, record]);
      trimDetailCache();
      const cached = detailCache.get(key);
      if (cached) { detailCache.delete(key); detailCache.set(key, cached); return structuredClone(cached.detail); }
      if (detailPending.has(key)) return structuredClone(await detailPending.get(key));
      const pending = (async () => {
        const detail = { ...normalizeDetail(unwrap(await get(PATHS.detail + encodeURIComponent(record.recordId), {})), record), detailFetchedAt: fetched() };
        const size = Math.max(1, detail.measurements.length);
        detailCache.set(key, { detail, size, expiresAt: now() + detailCacheTtlMs }); cachedPoints += size; trimDetailCache();
        return detail;
      })();
      detailPending.set(key, pending);
      try { return structuredClone(await pending); } finally { if (detailPending.get(key) === pending) detailPending.delete(key); }
    }
    if (q.action === 'analysis') {
      const snapshot = findSnapshot(session.token, scope, q.snapshotId);
      const rawOffset = q.offset === undefined ? 0 : q.offset;
      const offset = typeof rawOffset === 'string' && /^\d{1,4}$/.test(rawOffset) ? Number(rawOffset) : rawOffset;
      if (!Number.isInteger(offset) || offset < 0 || offset >= snapshot.records.length || offset % ANALYSIS_BATCH_SIZE !== 0) throw fail('测点分析批次位置无效。', 400);
      const batch = snapshot.records.slice(offset, offset + ANALYSIS_BATCH_SIZE), items = [], errors = [];
      let cursor = 0, authError = null;
      async function worker() {
        while (cursor < batch.length && !authError) {
          const localIndex = cursor++, record = batch[localIndex], index = offset + localIndex;
          try { items.push({ index, ...await analysisDetail(record) }); }
          catch (error) {
            if (error.status === 401 || error.status === 403) { authError = error; break; }
            errors.push({ index, recordId: record.recordId, message: '该次检测的测点未成功读取，请重试此批次。' });
          }
        }
      }
      await Promise.all([worker(), worker()]);
      if (authError) throw authError;
      findSnapshot(session.token, scope, q.snapshotId);
      items.sort((a, b) => a.index - b.index); errors.sort((a, b) => a.index - b.index);
      return { action: 'analysis', sourceType: 'ProcessReport', snapshotId: q.snapshotId, total: snapshot.records.length,
        offset, nextOffset: offset + batch.length < snapshot.records.length ? offset + batch.length : null,
        items, errors, complete: errors.length === 0, batchSize: ANALYSIS_BATCH_SIZE,
        filters: { ...snapshot.filters }, expiresAt: new Date(snapshot.expiresAt).toISOString(), fetchedAt: fetched(),
        warnings: ['此批完整不等于全范围完整；需读取全部批次并核对记录数量。', '公司接口不提供详情事务快照；测点按需读取，可能与其他批次的读取时刻不同。', '测点可能复用五分钟内已成功读取的缓存，各条 detailFetchedAt 保留实际读取时刻。', '来源未提供关键测点标识，critical 为 null，不自动推断。'] };
    }
    if (q.action === 'detail') {
      const recordId = id(q.recordId, 400), entry = cache(session.token), record = entry.records.get(recordId);
      if (!record) throw fail('该记录不在当前会话的查询结果中，请重新查询列表后查看。', 400);
      const detail = normalizeDetail(unwrap(await get(PATHS.detail + encodeURIComponent(recordId), {})), record);
      return { action: 'detail', ...detail, fetchedAt: fetched(), coverage: { mode: 'detail', complete: true, eligibleForLineRate: false } };
    }
    // Validate query values before making any upstream requests.
    let lineId, start, end, limit, barcode, partCode, deviceCode, result, queryMode, productionLine;
    if (q.action === 'report') {
      lineId = id(q.lineId, 400);
      queryMode = q.queryMode === undefined || q.queryMode === null || q.queryMode === '' ? null : q.queryMode;
      if (queryMode !== null && !['time', 'count'].includes(queryMode)) throw fail('请选择按时间或按数量查询。', 400);
      const today = localTime(started).slice(0, 10);
      start = queryMode === 'count' ? time(HISTORY_START) : time(q.start || today);
      end = queryMode === 'count' ? started : Math.min(time(q.end || localTime(started), { endOfDay: true }), started);
      if (start > end) throw fail('开始时间不能晚于有效结束时间。', 400);
      limit = queryMode === 'time' ? 0 : recentLimit(q.limit);
      if (queryMode === 'count' && !limit) throw fail('按数量查询须填写 1–20000 的最近检测次数。', 400);
      barcode = optionalFilter(q.barcode, '工件码');
      partCode = optionalFilter(q.partCode, '物料编号');
      deviceCode = optionalFilter(q.deviceCode, '检具编号');
      productionLine = productionLineFilter(q.productionLine);
      result = q.result === undefined || q.result === null || q.result === '' ? 'all' : text(q.result);
      if (!['all', 'OK', 'NG'].includes(result)) throw fail('检测结论只能选择全部、OK 或 NG。', 400);
    }
    const rawLines = unwrap(await get(PATHS.catalog, { DYGS_ID: 0 }));
    if (!Array.isArray(rawLines) || rawLines.length > 10000) throw fail('MES 线体目录格式无效。');
    const lineIds = new Set(), lines = [];
    for (const raw of rawLines) {
      if (!object(raw)) throw fail('MES 线体目录包含无效条目。');
      const label = text(raw.label);
      if (!label || !/尺寸|视觉|光学/.test(label)) continue;
      const parsed = /^([A-Za-z0-9_]+)-(.+)$/.exec(label);
      if (!parsed) continue;
      if (EXCLUDED_LINE_NAME.test(parsed[2])) continue;
      const value = id(raw.value);
      if (lineIds.has(value)) throw fail('MES 线体目录包含重复标识。');
      lineIds.add(value);
      lines.push({ id: value, code: parsed[1], name: parsed[2], label });
    }
    if (q.action === 'catalog') {
      const configured = String(config.vision?.mes?.defaultLineId || '');
      const defaultLineId = lines.some(row => row.id === configured) ? configured : lines[0]?.id || null;
      return { action: 'catalog', sourceType: 'ProcessReport', lines, defaultLineId, fetchedAt: fetched() };
    }
    const line = lines.find(row => row.id === lineId);
    if (!line) throw fail('所选线体不在当前账号的尺寸检测目录中。', 400);
    const filters = { lineId, start: localTime(start), end: localTime(end), limit, barcode, partCode, deviceCode, result, productionLine, timezone: 'Asia/Shanghai',
      ...(queryMode ? { queryMode } : {}) };
    const matches = row => (!partCode || row.partCode === partCode) && (!deviceCode || row.deviceCode === deviceCode)
      && (!productionLine || row.productionLine === productionLine) && (result === 'all' || row.result === result);
    const issues = new Set(), records = [], matchedRecords = [], seen = new Map(), processes = new Set();
    const partFacets = new Map(), deviceFacets = new Map(), materialLineFacets = new Map();
    let sourceTotal = null, readRows = 0, duplicateRows = 0, lastEpoch = Infinity, ended = false, reachedTarget = false;
    let firstPageFingerprint = null;
    const pageQuery = page => ({ cx_id: lineId, start: filters.start, end: filters.end, page, size: PAGE_SIZE,
      pageShow: true, orderName: 'endTime', orderType: 2, ...(barcode ? { barcode } : {}) });
    for (let page = 1; page <= maxPages; page++) {
      let response, data;
      try {
        response = await get(PATHS.report, pageQuery(page));
        data = unwrap(response);
      } catch (error) {
        if (error.status === 401 || error.status === 403 || !readRows) throw error;
        issues.add('查询中断或达到时间上限，已读取的记录仅供查看。');
        break;
      }
      if (!Array.isArray(data) || data.length > PAGE_SIZE || !Number.isSafeInteger(response.total) || response.total < 0) {
        issues.add('来源分页结构或总数无效。'); break;
      }
      if (sourceTotal === null) { sourceTotal = response.total; firstPageFingerprint = JSON.stringify(data); }
      else if (response.total !== sourceTotal) issues.add('读取过程中来源总数发生变化，请重新查询。');
      readRows += data.length;
      for (const row of data) {
        let record;
        try { record = normalizeRecord(row, line, start, end); }
        catch { issues.add('部分记录的标识、线体或检测时间无效，已排除。'); continue; }
        if (barcode && record.barcode !== barcode) { issues.add('来源返回了其他工件的记录，已排除。'); continue; }
        if (!record.processCode || !record.processName || !/尺寸|视觉|光学/.test(record.processName)) {
          issues.add('部分记录工序不明或未确认为尺寸检测工序，暂不计算合格率。');
        } else {
          processes.add(JSON.stringify([record.processCode, record.processName]));
          if (processes.size > 1) issues.add('来源包含多个工序，未混算为同一尺寸检测合格率。');
        }
        const epoch = time(record.measuredAt, { status: 502 });
        if (epoch > lastEpoch) issues.add('来源未按检测时间倒序返回，最近记录范围不可信。');
        lastEpoch = epoch;
        if (record.result === null) issues.add('存在未知工序判定，暂不计算合格率。');
        const signature = JSON.stringify(record);
        if (seen.has(record.recordId)) {
          duplicateRows++;
          issues.add('来源分页出现重复记录，无法确认读取范围完整。');
          if (seen.get(record.recordId) !== signature) issues.add('同一记录标识返回了冲突内容。');
          continue;
        }
        seen.set(record.recordId, signature);
        records.push(record);
        // These are observed choices from this read, before local filters. They
        // are deliberately not represented as a complete company directory.
        if (record.partCode && !partFacets.has(record.partCode)) partFacets.set(record.partCode, { code: record.partCode, name: record.partName || record.partCode });
        if (record.partCode) {
          const key = JSON.stringify([record.partCode, record.productionLine]);
          if (!materialLineFacets.has(key)) materialLineFacets.set(key, { code: record.partCode, name: record.partName || record.partCode, productionLine: record.productionLine });
        }
        if (record.deviceCode && !deviceFacets.has(record.deviceCode)) deviceFacets.set(record.deviceCode, { code: record.deviceCode, name: record.deviceName || record.deviceCode });
        if (matches(record)) matchedRecords.push(record);
      }
      if (records.length > sourceTotal || readRows > sourceTotal) issues.add('分页条数与来源总数不一致。');
      // Keep paging past non-matching rows: the latest N is selected after the
      // material, device and result filters, not from the first N source rows.
      reachedTarget = Boolean(limit && matchedRecords.length >= limit);
      ended = readRows >= sourceTotal;
      if (ended || reachedTarget) break;
      if (data.length < PAGE_SIZE) { issues.add('来源提前结束分页，未读取完整范围。'); break; }
      if (page === maxPages) issues.add('已达到读取页数上限，未读取完整范围。');
    }
    if (!ended && !reachedTarget) issues.add('所选范围尚未读取完整。');
    if (ended && seen.size !== sourceTotal) issues.add('去重后的记录数量与来源总数不一致。');
    // This API exposes no snapshot token. Recheck the same frozen first page so
    // concurrent additions/edits do not silently become a complete statistic.
    if (!issues.size && (ended || reachedTarget)) {
      try {
        const verification = await get(PATHS.report, pageQuery(1));
        const rows = unwrap(verification);
        if (verification.total !== sourceTotal || JSON.stringify(rows) !== firstPageFingerprint) issues.add('复核时来源记录发生变化，请重新查询。');
      } catch (error) {
        if (error.status === 401 || error.status === 403) throw error;
        issues.add('未完成来源一致性复核，暂不计算合格率。');
      }
    }
    matchedRecords.sort((a, b) => time(b.measuredAt) - time(a.measuredAt));
    const selected = limit ? matchedRecords.slice(0, limit) : matchedRecords;
    const complete = issues.size === 0 && (ended || reachedTarget);
    const summary = { total: selected.length, ok: 0, ng: 0, unknown: 0, denominator: 0, passRate: null };
    for (const record of selected) summary[record.result === 'OK' ? 'ok' : record.result === 'NG' ? 'ng' : 'unknown']++;
    summary.denominator = summary.ok + summary.ng;
    const rateScopeReason = [barcode ? '当前限定单个工件，不显示线体合格率。' : '',
      result !== 'all' ? `当前仅查看 ${result} 记录，未包含全部判定，不显示合格率。` : ''].filter(Boolean).join(' ');
    const eligibleForLineRate = complete && !rateScopeReason;
    if (eligibleForLineRate && summary.denominator) summary.passRate = summary.ok / summary.denominator * 100;
    const scopeNote = `${partCode || deviceCode || productionLine ? '统计仅限所选物料、检具及 SN 线号条件匹配的检测。' : ''}${rateScopeReason}`;
    const note = complete
      ? `${limit ? `已读取${queryMode === 'count' ? '当前筛选条件下' : '所选时间和筛选条件内'}最近 ${selected.length} 次检测` : '已读取所选时间范围内符合筛选条件的全部检测'}；同一工件复测按不同检测记录保留。${queryMode === 'count' ? `搜索公司当前可读取的 ${HISTORY_START.slice(0, 10)} 起历史，不受页面日期条件限制。${selected.length < limit && ended ? '来源已读完，符合条件的检测不足指定数量。' : ''}` : ''}${scopeNote}`
      : `${Array.from(issues).join(' ')} ${scopeNote}`.trim();
    const byCode = (a, b) => a.code.localeCompare(b.code);
    const facets = { parts: [...partFacets.values()].sort(byCode), devices: [...deviceFacets.values()].sort(byCode),
      materialLines: [...materialLineFacets.values()].sort((a, b) => byCode(a, b) || a.productionLine.localeCompare(b.productionLine, 'en', { numeric: true })) };
    remember(session.token, selected);
    const analysisSnapshot = createSnapshot(session.token, scope, selected, filters, complete);
    return { action: 'report', sourceType: 'ProcessReport', line, records: selected, summary, filters, facets, analysisSnapshot, fetchedAt: fetched(),
      coverage: { complete, eligibleForLineRate, mode: limit ? 'recent' : 'range',
        sourceTotal, readRows, duplicateRows, sourceExhausted: ended,
        firstMeasuredAt: selected.at(-1)?.measuredAt || null, lastMeasuredAt: selected[0]?.measuredAt || null,
        note, rateUnavailableReason: complete ? rateScopeReason || null : note }, warnings: Array.from(issues) };
  }
  return { read };
}

module.exports = { createMesVisionReportConnector };
