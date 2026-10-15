'use strict';
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { PortalError } = require('./source.cjs');
const { createVisionCatalog } = require('./vision-catalog.cjs');
const { createVisionSource } = require('./vision-source.cjs');

const PARTS = Object.freeze(['Tesla_Front11', 'Tesla_Front12']);
const FILE_RE = /^(Tesla_Front11|Tesla_Front12)_(\d{8}-\d{6})\.csv$/;
const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const ITEM_RESULTS = ['OK', 'NG', 'NAN', 'NaN', 'NA', 'N/A'];
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_RECORDS = 20000;
const error = message => new PortalError(message, 400);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function text(value, name, max = 250) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw error(`${name}格式无效。`);
  return value.trim();
}
function validDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
function timestamp(value) {
  const v = text(value, '检测时间', 30).replaceAll('/', '-').replace(' ', 'T');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(v) || !validDay(v.slice(0, 10)) || Number(v.slice(11, 13)) > 23 || Number(v.slice(14, 16)) > 59 || Number(v.slice(17)) > 59) throw error('检测时间格式无效。');
  return v;
}
function sourceFilename(filename, part) {
  const parts = text(filename, 'CSV 文件名', 2048).split(/[\\/]/);
  if (parts.some(x => x.toLowerCase() === 'failure' || x.toLowerCase().endsWith('_allmeasure'))) throw error('全检和 failure 目录不在采集范围内。');
  const match = FILE_RE.exec(parts.at(-1));
  if (!match || (part && match[1] !== part)) throw error('仅接受当前已适配型号的普通检测 CSV 文件，文件名须与型号一致。');
  if (parts.slice(0, -1).some(segment => PARTS.includes(segment) && segment !== match[1])) throw error('CSV 所在型号目录与文件名不一致。');
  return match;
}
function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw error(`${name}必须为有限数值。`);
  return value === 0 ? 0 : value;
}
function csvNumber(value, name) {
  if (!NUMBER_RE.test(value)) throw error(`${name}不是有效数字。`);
  return finite(Number(value), name);
}
function get(row, camel, snake) { return Object.hasOwn(row, camel) ? row[camel] : row[snake]; }

// Both source formats pass through this normalizer. IDs supplied by a client
// or collector never determine identity or overwrite a previously stored row.
function normalizeRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('检测记录格式无效。');
  if (input.schema_version !== undefined && input.schema_version !== 1) throw error('不支持此采集文件版本。');
  const partName = text(get(input, 'partName', 'part_name'), '型号');
  if (!PARTS.includes(partName)) throw error('仅采集已配置的普通检测型号，全检数据已排除。');
  const sourceFile = get(input, 'sourceFile', 'source_file');
  if (sourceFile !== undefined) sourceFilename(sourceFile, partName);
  if (input.source_path !== undefined) sourceFilename(input.source_path, partName);
  const deviceId = text(get(input, 'deviceId', 'device_id'), '检具编号', 100);
  const serialNumber = text(get(input, 'serialNumber', 'serial_number'), 'SN', 200);
  const measuredAt = timestamp(get(input, 'measuredAt', 'measured_at_local'));
  const sourceResult = get(input, 'sourceResult', 'source_result');
  if (!['OK', 'NG'].includes(sourceResult)) throw error('整体结论必须是源文件中的 OK 或 NG。');
  if (!Array.isArray(input.measurements) || input.measurements.length !== 61) throw error('普通检具记录必须包含 61 项测量数据。');
  const names = new Set(), warnings = [];
  const measurements = input.measurements.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw error('测量项目格式无效。');
    const name = text(item.name, '测点名称');
    if (names.has(name)) throw error('测点名称重复。');
    names.add(name);
    const nominal = finite(item.nominal, `${name} 标称值`);
    const lowerLimit = finite(get(item, 'lowerLimit', 'lower_limit'), `${name} 下限`);
    const upperLimit = finite(get(item, 'upperLimit', 'upper_limit'), `${name} 上限`);
    if (lowerLimit > upperLimit) throw error(`${name} 下限大于上限。`);
    const isCritical = get(item, 'isCritical', 'is_critical');
    if (typeof isCritical !== 'boolean') throw error(`${name} 关键点标记无效。`);
    const sourceResult = get(item, 'sourceResult', 'source_result');
    if (!ITEM_RESULTS.includes(sourceResult)) throw error(`${name} 原始判定无效。`);
    const deviationRaw = text(get(item, 'deviationRaw', 'deviation_raw'), `${name} 原始偏差`, 100);
    let deviation;
    if (item.deviation === null && /^nan$/i.test(deviationRaw)) {
      deviation = null;
      warnings.push(`${name}：源偏差为 NaN，未替换成数值。`);
    } else {
      deviation = finite(item.deviation, `${name} 偏差`);
      if (csvNumber(deviationRaw, `${name} 原始偏差`) !== deviation) throw error(`${name} 原始偏差与数值不一致。`);
      const comparison = deviation >= lowerLimit && deviation <= upperLimit ? 'OK' : 'NG';
      if (comparison !== sourceResult) warnings.push(`${name}：偏差范围比较为 ${comparison}，保留源判定 ${sourceResult}。`);
    }
    return { name, nominal, lowerLimit, upperLimit, isCritical, deviation, deviationRaw, sourceResult, unit: null };
  });
  if (sourceFile) {
    const fileTime = sourceFilename(sourceFile, partName)[2];
    if (fileTime !== measuredAt.replaceAll('-', '').replace('T', '-').replaceAll(':', '')) warnings.push('文件名时间与记录时间不同，使用记录时间。');
  }
  const identity = [deviceId, partName, serialNumber, measuredAt];
  const semantic = [...measurements].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .map(m => [m.name, m.nominal, m.lowerLimit, m.upperLimit, m.isCritical, m.deviation, m.sourceResult]);
  return { id: digest([identity, sourceResult, semantic]), logicalKey: digest(identity), deviceId, partName, serialNumber, measuredAt, sourceResult, measurements, warnings, ...(sourceFile ? { sourceFile: sourceFile.split(/[\\/]/).at(-1) } : {}) };
}

function csvRows(content) {
  if (Buffer.isBuffer(content)) {
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(content); } catch (_) { throw error('CSV 必须使用 UTF-8 编码。'); }
  }
  if (typeof content !== 'string' || Buffer.byteLength(content) > 2 * 1024 * 1024 || !/[\r\n]$/.test(content)) throw error('CSV 内容过大、格式无效或尚未写入完成。');
  content = content.replace(/^\uFEFF/, '');
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (quoted) {
      if (ch === '"') { if (content[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else cell += ch;
      continue;
    }
    if (ch === '"') { if (cell || closed) throw error('CSV 引号格式无效。'); quoted = true; continue; }
    if (ch === ',' || ch === '\r' || ch === '\n') {
      row.push(cell); cell = ''; closed = false;
      if (ch !== ',') { rows.push(row); row = []; if (ch === '\r' && content[i + 1] === '\n') i++; }
    } else { if (closed) throw error('CSV 引号后出现无效内容。'); cell += ch; }
  }
  if (quoted) throw error('CSV 引号未闭合。');
  if (row.length || cell) { row.push(cell); rows.push(row); }
  while (rows.length && rows.at(-1).every(cell => !cell.trim())) rows.pop();
  return rows;
}
function parseCsv({ filename, content, deviceId }) {
  const match = sourceFilename(filename);
  const rows = csvRows(content);
  if (rows.length !== 66 || rows.some(row => row.length !== 7)) throw error('CSV 应包含 4 行信息、1 行表头及 61 行测量值，每行 7 列。');
  const meta = {};
  ['PartName', 'SN', 'TimeStamp', 'Result'].forEach((key, i) => {
    const row = rows[i].map(x => x.trim());
    if (row[0] !== key || row.slice(2).some(Boolean)) throw error(`CSV ${key} 信息行格式无效。`);
    meta[key] = row[1];
  });
  if (match[1] !== meta.PartName) throw error('CSV 文件名与内部型号不一致。');
  if (JSON.stringify(rows[4].map(x => x.trim())) !== JSON.stringify(['Name', 'Nominal', 'Lower_SL', 'Upper_SL', 'IsCritical', 'Dev', 'OK/NG'])) throw error('CSV 测量表头与已核验格式不一致。');
  return normalizeRecord({ deviceId, partName: meta.PartName, serialNumber: meta.SN, measuredAt: meta.TimeStamp, sourceResult: meta.Result, source_file: filename,
    measurements: rows.slice(5).map(row => {
      const [name, nominal, low, high, critical, dev, result] = row.map(x => x.trim());
      if (!['Yes', 'No', '1', '0'].includes(critical)) throw error('关键点标记必须为 Yes、No、1 或 0。');
      return { name, nominal: csvNumber(nominal, '标称值'), lowerLimit: csvNumber(low, '下限'), upperLimit: csvNumber(high, '上限'), isCritical: ['Yes', '1'].includes(critical), deviation: /^nan$/i.test(dev) ? null : csvNumber(dev, '偏差'), deviationRaw: dev, sourceResult: result };
    }) });
}
function queryValue(query, key) { return query instanceof URLSearchParams ? query.get(key) : query[key]; }
function minuteBoundary(value, end) {
  if (value === '') return '';
  if (typeof value !== 'string') throw error('请选择有效的检测日期和时间范围。');
  if (validDay(value)) return value + (end ? 'T23:59' : 'T00:00');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) && validDay(value.slice(0, 10)) && Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60) return value;
  throw error('请选择有效的检测日期和时间范围。');
}
const INTERVAL_MINUTES = Object.freeze({ '5m': 5, '15m': 15, '30m': 30, hour: 60, day: 1440 });
function queryOptions(query) {
  const read = key => queryValue(query, key);
  function scopeId(key) {
    const value = read(key);
    if (value === undefined || value === null || value === '' || value === 'all') return 'all';
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) throw error('线体或检具筛选无效。');
    return value;
  }
  const start = read('start') ?? '', end = read('end') ?? '';
  const startMinute = minuteBoundary(start, false), endMinute = minuteBoundary(end, true);
  if (startMinute && endMinute && startMinute > endMinute) throw error('开始时间不能晚于结束时间。');
  const singleDay = Boolean(start && end && start.slice(0, 10) === end.slice(0, 10));
  const rawInterval = read('interval');
  const requestedInterval = rawInterval === undefined || rawInterval === null || rawInterval === '' ? 'auto' : rawInterval;
  if (typeof requestedInterval !== 'string' || (requestedInterval !== 'auto' && !Object.hasOwn(INTERVAL_MINUTES, requestedInterval))) throw error('曲线时间粒度无效。');
  const interval = requestedInterval === 'auto' ? (singleDay ? '15m' : 'day') : requestedInterval;
  const rawRecentLimit = read('recentLimit');
  let recentLimit = null;
  if (rawRecentLimit !== undefined && rawRecentLimit !== null && rawRecentLimit !== '' && rawRecentLimit !== 'all') {
    if (!['string', 'number'].includes(typeof rawRecentLimit) || !/^\d+$/.test(String(rawRecentLimit)) || !Number.isSafeInteger(Number(rawRecentLimit)) || Number(rawRecentLimit) < 1 || Number(rawRecentLimit) > MAX_RECORDS) throw error('最近检测数量必须为 1–20000 的整数，或选择全部。');
    recentLimit = Number(rawRecentLimit);
  }
  const part = read('part') || 'all', result = read('result') || 'all';
  if (part !== 'all' && !PARTS.includes(part)) throw error('型号筛选无效，全检不在范围内。');
  if (!['all', 'OK', 'NG'].includes(result)) throw error('结论筛选无效。');
  const search = read('search') || '';
  if (typeof search !== 'string' || search.length > 200) throw error('搜索内容过长。');
  function integer(key, fallback, max) {
    const raw = read(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > max) throw error('分页参数无效。');
    return Number(raw);
  }
  return { startMinute, endMinute, singleDay, interval, recentLimit, lineId: scopeId('lineId'), deviceId: scopeId('deviceId'), part, result, search: search.trim().toLowerCase(), page: integer('page', 1, 1000000), pageSize: integer('pageSize', 50, 200) };
}

function collectorTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value) || !validDay(value.slice(0, 10))) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && value.slice(11, 19) === new Date(ms).toISOString().slice(11, 19) ? new Date(ms).toISOString() : null;
}

function aggregateTrend(rows, conflictKeys, periodKey, periodOf) {
  const periods = new Map();
  for (const row of rows) {
    const period = periodOf(row);
    if (!periods.has(period)) periods.set(period, { [periodKey]: period, totalRecords: 0, eligibleRecords: 0, okRecords: 0, ngRecords: 0, conflictRecords: 0, passRate: null });
    const point = periods.get(period);
    point.totalRecords++;
    if (conflictKeys.has(row.logicalKey)) point.conflictRecords++;
    else {
      point.eligibleRecords++;
      if (row.sourceResult === 'OK') point.okRecords++;
      else point.ngRecords++;
    }
  }
  return [...periods.values()].sort((a, b) => a[periodKey].localeCompare(b[periodKey]))
    .map(point => ({ ...point, passRate: point.eligibleRecords ? point.okRecords / point.eligibleRecords : null }));
}

function bucketPeriod(measuredAt, minutes) {
  const date = measuredAt.slice(0, 10);
  if (minutes === 1440) return date;
  const minuteOfDay = Number(measuredAt.slice(11, 13)) * 60 + Number(measuredAt.slice(14, 16));
  const rounded = Math.floor(minuteOfDay / minutes) * minutes;
  return `${date}T${String(Math.floor(rounded / 60)).padStart(2, '0')}:${String(rounded % 60).padStart(2, '0')}`;
}

function reportScope(query, catalog) {
  const line = query.lineId === 'all' ? null : catalog.lines.find(item => item.id === query.lineId);
  const device = query.deviceId === 'all' ? null : catalog.devices.find(item => item.id === query.deviceId);
  if ((query.lineId !== 'all' && !line) || (query.deviceId !== 'all' && !device)) throw error('所选线体或检具不存在，请刷新台账后重新选择。');
  if (line && device && device.lineId !== line.id) throw error('所选检具不属于当前线体。');
  const configured = catalog.devices.filter(item => item.status === 'configured');
  const eligibleDevices = device ? configured.filter(item => item.id === device.id) : line ? configured.filter(item => item.lineId === line.id) : null;
  return {
    selection: { lineId: query.lineId, deviceId: query.deviceId, pending: eligibleDevices !== null && eligibleDevices.length === 0 },
    deviceIds: eligibleDevices === null ? null : new Set(eligibleDevices.map(item => item.id)),
    pendingIds: new Set(catalog.devices.filter(item => item.status === 'pending').map(item => item.id)),
    sourceDevice: configured.find(item => item.id === 'vision-01')
  };
}

function validateVisionSnapshot(raw) {
  if (!raw || raw.schema_version !== 1 || !Array.isArray(raw.records) || raw.records.length > MAX_RECORDS) throw error('采集 JSON 版本或记录列表无效，一批最多 20000 条。');
  return raw.records.map(normalizeRecord);
}

function createVisionService({ root, config = {}, now = Date.now, catalog, sourceReader }) {
  const registry = catalog || createVisionCatalog({ root, config });
  const reader = sourceReader || createVisionSource({ root, config });
  const storeFile = path.resolve(root, 'runtime/vision/records.json');
  const configuredAge = config.vision?.maxScanAgeSeconds;
  const maxScanAgeSeconds = Number.isFinite(configuredAge) && configuredAge >= 30 && configuredAge <= 86400 ? configuredAge : 7200;
  const configuredInterval = config.vision?.pollIntervalSeconds;
  const pollIntervalSeconds = Number.isFinite(configuredInterval) && configuredInterval >= 5 && configuredInterval <= 3600 ? configuredInterval : 30;
  let records = new Map(), initialized = false, latestImportedAt = null, hasManualImport = false, hasFileSource = false, lastCollectorCheckedAt = null, lastFileDigest = null;
  let queue = Promise.resolve(), initPromise = null, inFlight = null, timer = null, managed = false, running = false, generation = 0;
  let source = { state: 'missing', mode: 'file', message: '尚未接入检具采集文件。', checkedAt: null, updatedAt: null, collectorCheckedAt: null };
  const isoNow = () => new Date(now()).toISOString();
  function serialize(work) { const result = queue.then(work); queue = result.catch(() => {}); return result; }
  async function readJson(file) {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw error('采集文件不是普通文件或超过 128 MB，请按时间分批接入。');
    const bytes = await fs.readFile(file);
    if (bytes.length > MAX_FILE_BYTES) throw error('采集文件过大。');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''));
  }
  function init() {
    if (initialized) return Promise.resolve();
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        const saved = await readJson(storeFile);
        const loaded = validateVisionSnapshot(saved);
        records = new Map(loaded.map(row => [row.id, row]));
        latestImportedAt = typeof saved.latestImportedAt === 'string' ? saved.latestImportedAt : null;
        hasManualImport = saved.hasManualImport === true;
        hasFileSource = saved.hasFileSource === true;
        lastCollectorCheckedAt = collectorTime(saved.collectorCheckedAt);
      } catch (e) {
        if (e.code !== 'ENOENT') throw new PortalError('已保存的检具数据无法读取；已停止覆盖，请检查本地保存目录。', 503);
      }
      initialized = true;
    })().finally(() => { initPromise = null; });
    return initPromise;
  }
  async function save(next, manual, at, fileSource, scannedAt, canCommit) {
    const payload = JSON.stringify({ schema_version: 1, latestImportedAt: at, hasManualImport: manual, hasFileSource: fileSource, collectorCheckedAt: scannedAt, records: [...next.values()] });
    if (Buffer.byteLength(payload) > MAX_FILE_BYTES) throw error('本地检具记录超过 128 MB，请先安排数据归档；本次未新增。');
    await fs.mkdir(path.dirname(storeFile), { recursive: true });
    const temp = `${storeFile}.${randomUUID()}.tmp`;
    try {
      if (canCommit && !canCommit()) return false;
      await fs.writeFile(temp, payload, { flag: 'wx' });
      if (canCommit) {
        if (!canCommit()) return false;
        // This final local atomic commit cannot interleave with stop() after its generation check.
        fsSync.renameSync(temp, storeFile);
      } else await fs.rename(temp, storeFile);
      return true;
    } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
  }
  async function merge(incoming, manual = false, fileSource = false, scannedAt = lastCollectorCheckedAt, canCommit) {
    if (canCommit && !canCommit()) return null;
    const next = new Map(records), keys = new Set([...records.values()].map(r => r.logicalKey));
    let imported = 0, duplicates = 0, conflicts = 0;
    for (const row of incoming) {
      if (next.has(row.id)) { duplicates++; continue; }
      if (keys.has(row.logicalKey)) conflicts++;
      next.set(row.id, row); keys.add(row.logicalKey); imported++;
    }
    if (next.size > MAX_RECORDS) throw error('本地已保存记录超过 20000 条，请先安排数据归档。');
    const manualState = hasManualImport || manual, fileState = hasFileSource || fileSource, at = imported ? isoNow() : latestImportedAt;
    if (imported || manualState !== hasManualImport || fileState !== hasFileSource || scannedAt !== lastCollectorCheckedAt) {
      if (!await save(next, manualState, at, fileState, scannedAt, canCommit)) return null;
      records = next; hasManualImport = manualState; hasFileSource = fileState; latestImportedAt = at; lastCollectorCheckedAt = scannedAt;
    }
    return { imported, duplicates, conflicts, message: imported ? `已接收 ${imported} 条检测记录${conflicts ? `，其中 ${conflicts} 条存在同次检测内容冲突` : ''}。` : '记录已存在，没有重复新增。' };
  }
  async function refresh(token) {
    const checkedAt = isoNow();
    const current = () => token === generation;
    try {
      await init();
      if (!current()) return;
      // A slow network/share read must never occupy the local persistence queue.
      const doc = await reader.read();
      if (!current()) return;
      const fingerprint = digest(doc);
      const scannedAt = collectorTime(doc.last_scan?.scanned_at_utc);
      const incoming = fingerprint === lastFileDigest ? null : validateVisionSnapshot(doc);
      await serialize(async () => {
        if (!current()) return;
        if (incoming) {
          if (!await merge(incoming, false, true, scannedAt, current)) return;
          if (!current()) return;
          lastFileDigest = fingerprint;
        }
        const errors = Array.isArray(doc.last_scan?.errors) ? doc.last_scan.errors.length : 0;
        const deferred = Number.isSafeInteger(doc.last_scan?.deferred) ? doc.last_scan.deferred : 0;
        const age = scannedAt ? now() - Date.parse(scannedAt) : null;
        const freshnessIssue = !scannedAt ? '采集文件未提供有效扫描时间，无法确认是否仍在更新。' : age < -30000 ? '采集端扫描时间超前，请核对两台电脑的时钟；暂不能确认数据新鲜度。' : '';
        const waiting = !freshnessIssue && age > maxScanAgeSeconds * 1000;
        const thresholdLabel = maxScanAgeSeconds % 3600 === 0 ? `${maxScanAgeSeconds / 3600} 小时` : maxScanAgeSeconds % 60 === 0 ? `${maxScanAgeSeconds / 60} 分钟` : `${maxScanAgeSeconds} 秒`;
        const scanMessage = errors ? `采集端有 ${errors} 个文件读取失败，显示已接收记录，不代表全部检测。`
          : waiting ? `共享文件可读取，采集扫描时间已超过 ${thresholdLabel}未更新；当前显示已接收记录，等待采集更新。`
            : '显示已接收检测记录，尚未核验现场数据完整性。';
        const messages = [freshnessIssue, scanMessage, deferred ? `另有 ${deferred} 个文件等待写入完成。` : ''].filter(Boolean);
        source = { state: errors || freshnessIssue ? 'error' : waiting ? 'waiting' : 'ready', mode: 'file', message: messages.join(''), checkedAt, updatedAt: latestImportedAt, collectorCheckedAt: scannedAt };
      });
    } catch (e) {
      if (!current()) return;
      const manualOnly = hasManualImport && !hasFileSource;
      if (e.code === 'ENOENT') source = { state: manualOnly ? 'ready' : 'missing', mode: manualOnly ? 'import' : 'file', message: hasFileSource ? '自动采集文件当前缺失，显示上次已保存数据。' : manualOnly ? '当前为手动导入的数据，尚未连接自动采集文件。' : records.size ? '采集文件当前缺失，显示上次已保存数据。' : '尚未接入检具采集文件，可先导入普通检测 CSV。', checkedAt, updatedAt: latestImportedAt, collectorCheckedAt: lastCollectorCheckedAt };
      else source = { state: 'error', mode: 'file', message: `采集数据未更新，保留上次有效记录。${e instanceof PortalError ? e.message : '输入文件格式无效或暂时无法读取。'}`, checkedAt, updatedAt: latestImportedAt, collectorCheckedAt: lastCollectorCheckedAt };
    }
  }
  function schedule() {
    if (!running || inFlight || timer !== null) return;
    timer = setTimeout(() => { timer = null; void sync(); }, pollIntervalSeconds * 1000);
    timer.unref?.();
  }
  function sync() {
    if (inFlight) return inFlight;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    const flight = refresh(generation).finally(() => {
      if (inFlight === flight) inFlight = null;
      schedule();
    });
    inFlight = flight;
    return flight;
  }
  function start() {
    managed = true;
    if (running) return inFlight || Promise.resolve();
    running = true;
    if (inFlight) return inFlight.then(() => running ? sync() : undefined);
    return sync();
  }
  function stop() {
    running = false;
    generation++;
    if (timer !== null) { clearTimeout(timer); timer = null; }
  }
  function conflicts() {
    const counts = new Map(); for (const row of records.values()) counts.set(row.logicalKey, (counts.get(row.logicalKey) || 0) + 1);
    return new Set([...counts].filter(([, n]) => n > 1).map(([key]) => key));
  }
  async function report(query = {}) {
    const q = queryOptions(query);
    const scope = reportScope(q, await registry.list());
    if (!scope.selection.pending) { if (managed) await init(); else await sync(); }
    const conflictKeys = conflicts();
    let filtered = scope.selection.pending ? [] : [...records.values()].filter(r => !scope.pendingIds.has(r.deviceId) && (!scope.deviceIds || scope.deviceIds.has(r.deviceId)) && (!q.startMinute || r.measuredAt.slice(0, 16) >= q.startMinute) && (!q.endMinute || r.measuredAt.slice(0, 16) <= q.endMinute) && (q.part === 'all' || r.partName === q.part) && (q.result === 'all' || r.sourceResult === q.result) && (!q.search || [r.serialNumber, r.deviceId, r.partName].some(v => v.toLowerCase().includes(q.search))));
    filtered.sort((a, b) => b.measuredAt.localeCompare(a.measuredAt) || a.id.localeCompare(b.id));
    const matchedRecords = filtered.length;
    if (q.recentLimit !== null) filtered = filtered.slice(0, q.recentLimit);
    const eligible = filtered.filter(r => !conflictKeys.has(r.logicalKey)), ok = eligible.filter(r => r.sourceResult === 'OK').length;
    const dailyTrend = aggregateTrend(filtered, conflictKeys, 'date', row => row.measuredAt.slice(0, 10));
    const hourlyTrend = q.singleDay
      ? aggregateTrend(filtered, conflictKeys, 'hour', row => row.measuredAt.slice(0, 13) + ':00') : null;
    const bucketMinutes = INTERVAL_MINUTES[q.interval];
    const trend = { interval: q.interval, bucketMinutes, points: aggregateTrend(filtered, conflictKeys, 'period', row => bucketPeriod(row.measuredAt, bucketMinutes)) };
    return { summary: { totalRecords: filtered.length, eligibleRecords: eligible.length, okRecords: ok, ngRecords: eligible.length - ok, conflictRecords: filtered.length - eligible.length, passRate: eligible.length ? ok / eligible.length : null },
      dailyTrend, hourlyTrend, trend, selection: { recentLimit: q.recentLimit, matchedRecords, selectedRecords: filtered.length },
      records: filtered.slice((q.page - 1) * q.pageSize, q.page * q.pageSize).map(r => ({ id: r.id, deviceId: r.deviceId, partName: r.partName, serialNumber: r.serialNumber, measuredAt: r.measuredAt, sourceResult: r.sourceResult, identityConflict: conflictKeys.has(r.logicalKey), itemCount: r.measurements.length })),
      total: filtered.length, page: q.page, pageSize: q.pageSize,
      scope: scope.selection,
      source: scope.selection.pending ? { state: 'pending', mode: 'unconfigured', message: '该检具尚未接入，完成配置与验收后显示检测数据。', checkedAt: null, updatedAt: null, collectorCheckedAt: null }
        : { ...source, ...(scope.sourceDevice ? { deviceId: scope.sourceDevice.id, lineId: scope.sourceDevice.lineId } : {}) },
      filters: { parts: [...PARTS] } };
  }
  async function importCsv(input) {
    const row = parseCsv(input);
    return serialize(async () => {
      await init();
      try { return await merge([row], true); }
      catch (e) { if (e instanceof PortalError) throw e; throw new PortalError('检测记录未能保存，本次没有新增，请检查本地保存目录。', 503); }
    });
  }
  async function detail(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw error('检测记录编号无效。');
    if (managed) await init(); else await sync();
    const row = records.get(id);
    if (!row) throw new PortalError('没有找到这条检测记录。', 404);
    const { logicalKey, ...result } = row;
    return structuredClone({ ...result, identityConflict: conflicts().has(logicalKey) });
  }
  return { start, stop, sync, report, importCsv, detail, catalog: () => registry.list(), saveDraft: input => serialize(() => registry.saveDraft(input)) };
}
module.exports = { createVisionService, validateVisionSnapshot, parseCsv, PARTS };
