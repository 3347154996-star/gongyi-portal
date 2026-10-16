'use strict';

const PATHS = Object.freeze({ processes: '/api/parameter_unqualified/getgxcode', lookup: '/api/parameter_unqualified' });
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const MAX_POINTS = 10000;
// Keep this adapter independent of source.cjs: that module owns the authenticated
// request function and may require this module while it is initializing.
const fail = (message, status = 502) => Object.assign(new Error(message), { name: 'MesVisionError', status });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function cleanText(value, label, max, { optional = false, status = 502 } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value) || !value.trim()) throw fail(`${label}格式无效。`, status);
  return value.trim();
}
function processId(value, status = 502) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) value = String(value);
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw fail('工序标识格式无效。', status);
  return value;
}
function envelope(response) {
  if (!object(response)) throw fail('MES 返回格式变化，未取得可信查询结果。');
  if (response.code === 401 || response.code === '401') throw fail('MES 登录已失效，请重新连接。', 401);
  if (response.code === 403 || response.code === '403') throw fail('当前账号没有此 MES 查询的读取权限。', 403);
  if (response.code !== 0 && response.code !== '0') throw fail('MES 未允许本次查询，请核对工件码及查询权限。');
  return response.data;
}
function normalizeProcesses(response) {
  const data = envelope(response);
  if (!Array.isArray(data) || data.length > 1000) throw fail('MES 工序列表格式无效或超过读取上限。');
  const ids = new Set();
  return data.map(item => {
    if (!object(item)) throw fail('MES 工序列表包含无效条目。');
    const id = processId(item.value), name = cleanText(item.label, '工序名称', 500);
    if (ids.has(id)) throw fail('MES 工序列表存在重复标识，无法确认所选工序。');
    ids.add(id);
    return { id, name };
  });
}
function numberField(value, label) {
  if (value === undefined || value === null) return { value: null, raw: null };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw fail(`${label}不是有限数值。`);
    return { value: value === 0 ? 0 : value, raw: String(value) };
  }
  if (typeof value !== 'string' || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) throw fail(`${label}格式无效。`);
  const text = value.trim();
  if (!text || /^(?:nan|na|n\/a)$/i.test(text)) return { value: null, raw: value };
  if (!NUMBER.test(text) || !Number.isFinite(Number(text))) throw fail(`${label}不是有效的数值或缺测标记。`);
  return { value: Number(text) === 0 ? 0 : Number(text), raw: value };
}
function resultField(value) {
  if (value === undefined || value === null || value === '') return { value: null, raw: value === '' ? '' : null };
  const text = cleanText(value, '测点原始判定', 80);
  const normalized = text.toUpperCase();
  return { value: ['OK', 'NG'].includes(normalized) ? normalized : null, raw: value };
}
function reworkFlag(value) {
  if (value === undefined || value === null) return null;
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  throw fail('MES 返工勾选标记格式无效。');
}
function sourceTime(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = cleanText(value, '来源记录时间', 50).replace(' ', 'T');
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})?$/.exec(text);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) throw fail('MES 来源记录时间格式无效。');
  const day = new Date(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== match[1] || !Number.isFinite(Date.parse(text))) throw fail('MES 来源记录时间不是有效日期。');
  // .NET's default timestamp is a missing value, never a real detection time.
  if (match[1] === '0001-01-01') return null;
  return text;
}
function normalizeLookup(response, barcode, process) {
  const data = envelope(response);
  if (!object(data) || !Array.isArray(data.list) || data.list.length > MAX_POINTS) throw fail('MES 测点列表格式无效或超过读取上限。');
  const returnedBarcode = cleanText(data.barcode, 'MES 返回工件码', 200);
  if (returnedBarcode !== barcode) throw fail('MES 返回工件码与本次查询不一致，已停止展示结果。');
  const keys = new Set();
  const measurements = data.list.map(item => {
    if (!object(item)) throw fail('MES 测点列表包含无效条目。');
    const name = cleanText(item.param_name, '测点名称', 500);
    const key = item.param_key === undefined || item.param_key === null || item.param_key === '' ? name : cleanText(item.param_key, '测点标识', 500);
    if (keys.has(key)) throw fail('MES 测点标识重复，无法确认测点对应关系。');
    keys.add(key);
    const actual = numberField(item.value, '实际值');
    const lower = numberField(item.param_down, '下限'), upper = numberField(item.param_up, '上限');
    if (lower.value !== null && upper.value !== null && lower.value > upper.value) throw fail('MES 测点下限大于上限。');
    const result = resultField(item.result), origin = resultField(item.origin_result);
    const rework = numberField(item.rework_value, '返工参数');
    return { key, name, actual: actual.value, actualRaw: actual.raw,
      lowerLimit: lower.value, lowerLimitRaw: lower.raw, upperLimit: upper.value, upperLimitRaw: upper.raw,
      result: result.value, resultRaw: result.raw, originResult: origin.value, originResultRaw: origin.raw,
      reworkActual: rework.value, reworkActualRaw: rework.raw, isRework: reworkFlag(item.is_rework), unit: null };
  });
  const pointSummary = { total: measurements.length, ok: 0, ng: 0, unknown: 0 };
  let missingValues = 0, missingLimits = 0, resultDisagreements = 0;
  for (const item of measurements) {
    pointSummary[item.result === 'OK' ? 'ok' : item.result === 'NG' ? 'ng' : 'unknown']++;
    if (item.actual === null) missingValues++;
    if (item.lowerLimit === null || item.upperLimit === null) missingLimits++;
    if (item.actual !== null && item.lowerLimit !== null && item.upperLimit !== null && item.result !== null) {
      const comparison = item.actual >= item.lowerLimit && item.actual <= item.upperLimit ? 'OK' : 'NG';
      if (comparison !== item.result) resultDisagreements++;
    }
  }
  const warnings = ['仅查询当前工件与工序，不代表产线全部检测；不计算产线合格率。', '实际值及上下限保留来源含义；单位未确认，不自动解释为尺寸偏差。', '尚未核验来源检测时间；查询时间和来源记录时间均不作为检测时间。'];
  if (!measurements.length) warnings.push('本次未返回测点，不能据此判断工件合格或没有缺陷。');
  if (missingValues) warnings.push(`${missingValues} 项实际值缺失或为缺测标记，未替换为 0。`);
  if (missingLimits) warnings.push(`${missingLimits} 项缺少完整上下限。`);
  if (pointSummary.unknown) warnings.push(`${pointSummary.unknown} 项原始判定未知，未推算为 OK 或 NG。`);
  if (resultDisagreements) warnings.push(`${resultDisagreements} 项数值范围与来源判定不一致，仍保留来源判定。`);
  const metadata = {};
  for (const [output, input, label] of [
    ['lineCode', 'cx_code', '线体编号'], ['lineName', 'cx_name', '线体名称'],
    ['stationCode', 'gw_code', '工位编号'], ['stationName', 'gw_name', '工位名称'],
    ['deviceCode', 'sb_code', '设备编号'], ['deviceName', 'sb_name', '设备名称'],
    ['partCode', 'item_code', '物料编号'], ['partName', 'item_name', '物料名称'],
  ]) metadata[output] = cleanText(data[input], label, 500, { optional: true });
  return { barcode, processId: process.id, processName: process.name, ...metadata,
    measuredAt: null, sourceRecordedAt: sourceTime(data.create_time),
    sourceType: cleanText(data.source_type, '来源类型', 100, { optional: true }),
    // quality_result is a workflow confirmation, not a verified overall test result.
    sourceResult: null, measurements, pointSummary, warnings };
}

function createMesVisionConnector({ request, now = Date.now }) {
  if (typeof request !== 'function' || typeof now !== 'function') throw new TypeError('MES vision requires request and now functions.');
  async function read(q, session) {
    if (!object(q) || !['processes', 'lookup'].includes(q.action)) throw fail('请选择有效的 MES 查询操作。', 400);
    const barcode = cleanText(q.barcode, '工件码', 200, { status: 400 });
    const id = q.action === 'lookup' ? processId(q.processId, 400) : null;
    if (!session || typeof session.token !== 'string' || !session.token) throw fail('请先建立公司数据源连接。', 428);
    // Membership is checked on every lookup. An ID observed for another barcode
    // cannot be passed directly to the detail endpoint.
    const processes = normalizeProcesses(await request(PATHS.processes, { method: 'GET', token: session.token, query: { barcode } }));
    let result;
    if (q.action === 'processes') result = { barcode, processes };
    else {
      const process = processes.find(item => item.id === id);
      if (!process) throw fail('所选工序不属于此工件或已不可用，请重新查询工序。', 400);
      const response = await request(PATHS.lookup, { method: 'GET', token: session.token, query: { barcode, id } });
      result = normalizeLookup(response, barcode, process);
    }
    return { action: q.action, ...result, fetchedAt: new Date(now()).toISOString(),
      coverage: { mode: 'lookup', complete: false, eligibleForLineRate: false },
      capabilities: { batchSync: false } };
  }
  return { read };
}

module.exports = { createMesVisionConnector };
