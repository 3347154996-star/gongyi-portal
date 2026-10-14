'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { PortalError } = require('./source.cjs');

const DEFAULT_LINE = Object.freeze({ id: 'front-subframe', name: '前副车架' });
const DEFAULT_DEVICE = Object.freeze({ id: 'vision-01', name: '前副车架检具', lineId: DEFAULT_LINE.id, lineName: DEFAULT_LINE.name, status: 'configured', transport: 'share', partNames: ['Tesla_Front11', 'Tesla_Front12'], measurementCount: 61 });
const LIMITS = Object.freeze({ maxDevices: 100, maxLines: 100, maxPartNames: 50, maxMeasurementCount: 10000, maxNotesLength: 1000 });
const MAX_BYTES = 1024 * 1024;
const invalid = message => new PortalError(message, 400);
const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function identifier(value, label) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value) || value.toLowerCase() === 'all') throw invalid(`${label}须为 1–64 位字母、数字、下划线或连字符，不能使用 all。`);
  return value;
}
function field(value, label, max, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw invalid(`${label}格式无效或超过 ${max} 字符。`);
  const clean = value.trim().normalize('NFC');
  if (!clean && !optional) throw invalid(`${label}不能为空。`);
  return clean;
}
function notes(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw invalid('备注格式无效或超过 1000 字符。');
  const normalized = value.replace(/\r\n/g, '\n');
  if (normalized.length > LIMITS.maxNotesLength || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(normalized)) throw invalid('备注格式无效或超过 1000 字符。');
  return normalized.trim().normalize('NFC');
}
function parts(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > LIMITS.maxPartNames) throw invalid('零件型号列表无效，最多登记 50 个型号。');
  const result = value.map(name => field(name, '零件型号', 120));
  if (new Set(result).size !== result.length) throw invalid('零件型号不能重复。');
  return result;
}
function measurementCount(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 1 || value > LIMITS.maxMeasurementCount) throw invalid('测点数须为 1–10000 的整数，暂不确定时可留空。');
  return value;
}
function transport(value) {
  if (!['share', 'upload'].includes(value)) throw invalid('登记接入方式须为 share 或 upload。');
  return value;
}
function lineKey(name) { return name.normalize('NFC').toLowerCase(); }
function validateStoredDevice(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.status !== 'pending') throw invalid('台账草稿格式无效。');
  const id = identifier(raw.id, '检具编号');
  if (id === DEFAULT_DEVICE.id) throw invalid('台账不能覆盖已配置的检具。');
  return { id, name: field(raw.name, '检具名称', 100), lineId: identifier(raw.lineId, '线体编号'), lineName: field(raw.lineName, '线体名称', 100), status: 'pending', transport: transport(raw.transport), sourcePath: field(raw.sourcePath, '来源位置', 1024, true), partNames: parts(raw.partNames), measurementCount: measurementCount(raw.measurementCount), notes: notes(raw.notes) };
}
function snapshot(drafts) {
  const lines = new Map([[DEFAULT_LINE.id, { ...DEFAULT_LINE }]]), names = new Map([[lineKey(DEFAULT_LINE.name), DEFAULT_LINE.id]]), ids = new Set([DEFAULT_DEVICE.id]);
  if (drafts.length + 1 > LIMITS.maxDevices) throw invalid('检具台账最多登记 100 台，包含当前已配置检具。');
  for (const draft of drafts) {
    if (ids.has(draft.id)) throw invalid('台账存在重复检具编号。');
    ids.add(draft.id);
    const knownLine = lines.get(draft.lineId), knownName = names.get(lineKey(draft.lineName));
    if ((knownLine && knownLine.name !== draft.lineName) || (knownName && knownName !== draft.lineId)) throw invalid('台账中的线体编号与名称不一致。');
    lines.set(draft.lineId, { id: draft.lineId, name: draft.lineName });
    names.set(lineKey(draft.lineName), draft.lineId);
  }
  return { lines: [...lines.values()], devices: [structuredClone(DEFAULT_DEVICE), ...structuredClone(drafts)], limits: { ...LIMITS } };
}

// Register intended connections only: no source path is opened or contacted.
// One catalog instance is shared by the portal's report and registration routes.
function createVisionCatalog({ root, config = {} }) {
  const storeFile = path.resolve(root, 'runtime/vision/catalog.json');
  let queue = Promise.resolve();
  function serialize(work) { const result = queue.then(work); queue = result.catch(() => {}); return result; }
  async function readDrafts() {
    try {
      const stat = await fs.stat(storeFile);
      if (!stat.isFile() || stat.size > MAX_BYTES) throw invalid('台账文件大小或类型无效。');
      const bytes = await fs.readFile(storeFile);
      if (bytes.length > MAX_BYTES) throw invalid('台账文件过大。');
      const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''));
      if (data?.schema_version !== 1 || !Array.isArray(data.devices)) throw invalid('台账文件版本或结构无效。');
      const drafts = data.devices.map(validateStoredDevice);
      snapshot(drafts);
      return drafts;
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw new PortalError('检具台账无法读取或校验失败；已停止覆盖，请检查台账文件。', 503);
    }
  }
  async function save(drafts) {
    const payload = JSON.stringify({ schema_version: 1, devices: drafts });
    if (Buffer.byteLength(payload) > MAX_BYTES) throw invalid('检具台账超过存储上限。');
    const temporary = `${storeFile}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(storeFile), { recursive: true });
      await fs.writeFile(temporary, payload, { flag: 'wx' });
      await fs.rename(temporary, storeFile);
    } catch (_) { throw new PortalError('检具登记未能保存，本次未修改台账。', 503); }
    finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  async function list() { return serialize(async () => snapshot(await readDrafts())); }
  async function saveDraft(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('请填写有效的检具登记信息。');
    const deviceId = identifier(input.deviceId, '检具编号');
    if (deviceId === DEFAULT_DEVICE.id) throw new PortalError('当前检具已配置，不能用待配置登记覆盖。', 409);
    return serialize(async () => {
      const drafts = await readDrafts(), catalog = snapshot(drafts), existing = drafts.find(device => device.id === deviceId);
      let line;
      if (input.lineId !== undefined && input.lineId !== null && input.lineId !== '') {
        const lineId = identifier(input.lineId, '线体编号');
        line = catalog.lines.find(item => item.id === lineId);
        if (!line) throw invalid('所选线体不存在，请选择已有线体或填写新线体名称。');
      } else {
        const name = field(input.lineName, '线体名称', 100);
        line = catalog.lines.find(item => lineKey(item.name) === lineKey(name));
        if (!line) line = { id: 'line-' + createHash('sha256').update(lineKey(name)).digest('hex').slice(0, 20), name };
      }
      const retained = key => owns(input, key) ? input[key] : existing?.[key];
      const device = { id: deviceId, name: field(input.name, '检具名称', 100), lineId: line.id, lineName: line.name, status: 'pending', transport: transport(input.transport), sourcePath: field(retained('sourcePath'), '来源位置', 1024, true), partNames: parts(retained('partNames')), measurementCount: measurementCount(retained('measurementCount')), notes: notes(retained('notes')) };
      const next = drafts.filter(item => item.id !== device.id);
      next.push(device);
      snapshot(next);
      await save(next);
      return { device: structuredClone(device), message: '检具已登记为待配置；尚未读取来源或建立自动接入，完成配置与验收后显示数据。' };
    });
  }
  return { list, saveDraft };
}

module.exports = { createVisionCatalog };
