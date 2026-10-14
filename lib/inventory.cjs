'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

class InventoryError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message); this.name = 'InventoryError'; this.status = status; this.statusCode = status;
    this.code = code; Object.assign(this, extra);
  }
}
const fail = (status, code, message, extra) => new InventoryError(status, code, message, extra);
const copy = value => JSON.parse(JSON.stringify(value));
const text = value => value == null ? '' : String(value).trim();
const SCALE = 1000000n;

// Quantities are decimal values with at most six places, not coercible booleans or formulas.
function decimal(value, field, positive = false) {
  if (!['number', 'string'].includes(typeof value)) throw fail(400, 'invalid_quantity', `${field}需要填写有效数字。`);
  const source = typeof value === 'string' ? value : String(value);
  if (source.length > 32 || !/^\d+(?:\.\d{1,6})?$/.test(source)) throw fail(400, 'invalid_quantity', `${field}必须是非负数，最多保留六位小数。`);
  const [whole, fraction = ''] = source.split('.');
  const units = BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0'));
  if (units > BigInt(Number.MAX_SAFE_INTEGER) || (positive && units === 0n)) throw fail(400, 'invalid_quantity', `${field}超出有效范围${positive ? '，且必须大于零' : ''}。`);
  return { value: Number(units) / 1000000, units };
}
function sourceStock(value) {
  try { return decimal(typeof value === 'string' ? value.trim() : value, '原系统库存'); }
  catch (_) { return null; }
}
function sourceReceiptId(value) {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) return null;
  const id = text(value);
  return id && id.length <= 200 && !/[\u0000-\u001f\u007f]/.test(id) ? id : null;
}
function expectedSourceIdentity(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw fail(400, 'invalid_source_identity', '仓库来源标识无效，请刷新备件后重新操作。');
  return value;
}
function actorIdentity(actor, review = false) {
  if (!actor || typeof actor.account !== 'string' || !actor.account.trim() || actor.account.length > 100) throw fail(401, 'authentication_required', '请先登录个人账号。');
  if (!['member', 'reviewer', 'admin'].includes(actor.role)) throw fail(403, 'forbidden', '当前账号没有库存操作权限。');
  if (review && !['reviewer', 'admin'].includes(actor.role)) throw fail(403, 'review_forbidden', '仅复核人员或管理员可以复核盘点。');
  return { account: actor.account.trim(), name: text(actor.name || actor.account).slice(0, 100), role: actor.role };
}
function requestKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$/.test(value)) throw fail(400, 'invalid_request_id', '请求编号无效，请刷新后重新操作。');
  return value;
}
function itemKey(value) {
  if (!['string', 'number'].includes(typeof value) || !text(value) || text(value).length > 200) throw fail(400, 'invalid_item', '请选择明确的备件记录。');
  return text(value);
}
function note(value, label) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > 1000 || /\u0000/.test(value)) throw fail(400, 'invalid_remark', `${label}不能超过 1000 个字符。`);
  return value.trim();
}
function serializeError(error) {
  return { status: error.status || 503, code: error.code || 'operation_failed', message: error.message, ...(error.recordId ? { recordId: error.recordId } : {}) };
}
function replayError(saved) { return fail(saved.status, saved.code, saved.message, saved.recordId ? { recordId: saved.recordId } : {}); }

function createInventoryService({ root, source, now = Date.now, authorizeActor }) {
  if (!root || !source) throw new TypeError('库存服务需要 root 和 source。');
  const directory = path.join(root, 'runtime');
  const filename = path.join(directory, 'inventory.json');
  const lockfile = path.join(directory, 'inventory.lock');
  const recoveryLockfile = path.join(directory, 'inventory-recovery.lock');
  let state = { version: 1, records: [], requests: {} };
  let tail = Promise.resolve();
  let storageFault = false;
  let fileSeen = false;
  const timestamp = () => new Date(now()).toISOString();

  async function save(next) {
    await fs.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `.inventory-${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(next, null, 2), 'utf8');
      await handle.sync();
      await handle.close(); handle = null;
      await fs.rename(temporary, filename);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporary).catch(() => {});
    }
  }
  async function commit(next) {
    try { await save(next); state = next; fileSeen = true; }
    catch (_) { throw fail(503, 'storage_unavailable', '本机库存记录暂时无法保存，操作未能完成。'); }
  }
  async function loadState(recoverIntents = false) {
    if (storageFault) return; // Never erase an in-memory unknown result after a failed final save.
    let saved;
    try { saved = await fs.readFile(filename, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT' && !fileSeen) { state = { version: 1, records: [], requests: {} }; return; }
      throw fail(503, 'storage_unavailable', '无法读取本机库存记录，请管理员检查。');
    }
    try {
      const loaded = JSON.parse(saved.replace(/^\uFEFF/, ''));
      if (loaded.version !== 1 || !Array.isArray(loaded.records) || !loaded.requests || typeof loaded.requests !== 'object' || Array.isArray(loaded.requests)) throw new Error('invalid store');
      let recovered = false;
      if (recoverIntents) for (const entry of Object.values(loaded.requests)) {
        if (entry.status !== 'intent') continue;
        const record = loaded.records.find(item => item.id === entry.recordId);
        if (!record) throw new Error('missing intent record');
        record.status = 'unknown'; record.updatedAt = timestamp();
        record.message = '上次操作在确认前中断，请管理员核对原系统，不要重复提交。';
        entry.status = 'unknown';
        entry.error = serializeError(fail(503, 'outcome_unknown', record.message, { recordId: record.id }));
        recovered = true;
      }
      if (recovered) await save(loaded);
      state = loaded; fileSeen = true;
    } catch (_) { throw fail(503, 'storage_unavailable', '本机库存记录损坏或无法恢复，请管理员检查；已停止写入。'); }
  }
  const busy = () => fail(409, 'inventory_busy', '另一项库存操作正在处理，请稍后查看记录再提交；异常持续时请管理员核对。');
  async function readLock(file) {
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 4096) return null;
      const owner = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(owner.nonce)) return null;
      return owner;
    } catch (_) { return null; }
  }
  function ownerGone(owner) {
    if (!owner) return false;
    try { process.kill(owner.pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; } // EPERM and ambiguous errors never permit reclamation.
  }
  async function newLock(file) {
    const owner = { pid: process.pid, nonce: crypto.randomUUID(), createdAt: timestamp() };
    const handle = await fs.open(file, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(owner), 'utf8'); await handle.sync(); }
    catch (error) { await handle.close().catch(() => {}); await fs.unlink(file).catch(() => {}); throw error; }
    await handle.close();
    return owner;
  }
  async function releaseLock(file, owner) {
    const current = await readLock(file);
    if (!current || current.pid !== owner.pid || current.nonce !== owner.nonce) throw fail(503, 'storage_unavailable', '库存操作锁状态异常，请管理员核对。');
    await fs.unlink(file);
  }
  async function acquireLock() {
    try { await fs.mkdir(directory, { recursive: true }); }
    catch (_) { throw fail(503, 'storage_unavailable', '本机库存记录目录无法写入。'); }
    try { return await newLock(lockfile); }
    catch (error) { if (error.code !== 'EEXIST') throw fail(503, 'storage_unavailable', '本机库存操作锁无法保存。'); }
    if (!ownerGone(await readLock(lockfile))) throw busy();
    // One reclaimer at a time prevents a stale-owner check from deleting a newly acquired lock.
    // A crashed reclaimer leaves this short-lived guard for explicit administrator inspection.
    let guard;
    try { guard = await newLock(recoveryLockfile); }
    catch (error) { if (error.code === 'EEXIST') throw busy(); throw fail(503, 'storage_unavailable', '库存操作锁无法恢复，请管理员核对。'); }
    try {
      const stale = await readLock(lockfile);
      if (!ownerGone(stale)) throw busy();
      await fs.unlink(lockfile);
      try { return await newLock(lockfile); }
      catch (error) { if (error.code === 'EEXIST') throw busy(); throw error; }
    } finally { await releaseLock(recoveryLockfile, guard); }
  }
  const ready = loadState(); // Recovery must wait for the process-wide file lock, never run during another write.
  ready.catch(() => {});
  function serial(task) {
    const result = tail.then(async () => {
      await ready;
      const owner = await acquireLock();
      try { await loadState(true); return await task(); }
      finally {
        try { await releaseLock(lockfile, owner); }
        catch (_) { storageFault = true; throw fail(503, 'storage_unavailable', '库存记录锁未能正常释放，请管理员核对；已暂停写入。'); }
      }
    });
    tail = result.catch(() => {});
    return result;
  }
  async function authorized(trustedActor, review = false) {
    const fresh = typeof authorizeActor === 'function' ? await authorizeActor(trustedActor, { review }) : trustedActor;
    const actor = actorIdentity(fresh, review);
    if (actor.account !== text(trustedActor.account)) throw fail(403, 'authorization_changed', '账号状态已经改变，请重新登录。');
    return actor;
  }
  function findRequest(actor, requestId, payload) {
    const key = crypto.createHash('sha256').update(actor.account + '\0' + requestId).digest('hex');
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const existing = state.requests[key];
    if (existing && existing.fingerprint !== fingerprint) throw fail(409, 'idempotency_conflict', '这个请求编号已经用于其他内容，请重新发起操作。');
    if (existing) {
      if (existing.error) throw replayError(existing.error);
      if (existing.status === 'completed') return { key, fingerprint, result: copy(existing.result) };
      throw fail(503, 'outcome_unknown', '此请求尚未确认，请管理员核对原系统，不要重复提交。', { recordId: existing.recordId });
    }
    if (storageFault) throw fail(503, 'storage_unavailable', '上次写入后的本机保存失败，请管理员核对记录；已暂停写入。');
    return { key, fingerprint };
  }
  function blocked(itemId, sourceIdentity) {
    // A legacy unknown has no reliable origin, so it stays blocking until explicitly reconciled.
    const record = state.records.find(entry => entry.itemId === itemId && entry.status === 'unknown' &&
      (entry.sourceIdentity === undefined || sourceIdentity === undefined || entry.sourceIdentity === sourceIdentity));
    if (record) throw fail(409, 'item_outcome_unknown', '这件备件有未确认的库存操作，请管理员核对原系统后处理。', { recordId: record.id });
  }
  async function readCatalog() {
    let result;
    try { result = await source.inventoryCatalog({ fresh: true }); }
    catch (_) { throw fail(503, 'source_unavailable', '暂时无法取得原系统最新库存，请稍后再试。'); }
    if (!result || !Array.isArray(result.rows)) throw fail(503, 'source_unavailable', '原系统库存返回格式无效。');
    const sourceIdentity = result.sourceIdentity;
    if (Object.hasOwn(result, 'sourceIdentity') && (typeof sourceIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(sourceIdentity))) {
      throw fail(503, 'source_identity_unavailable', '公司仓库来源标识无法确认，暂时不能操作。');
    }
    const ids = new Map();
    for (const row of result.rows) {
      const id = row && ['string', 'number'].includes(typeof row.id) ? text(row.id) : '';
      if (id) ids.set(id, (ids.get(id) || 0) + 1);
    }
    const entries = result.rows.map(row => {
      row = row && typeof row === 'object' ? row : {};
      const id = ['string', 'number'].includes(typeof row.id) ? text(row.id) : '';
      const stock = sourceStock(row.nowStock);
      const item = {
        id, code: text(row.bjbh), name: text(row.bjmc), specification: text(row.specifications),
        location: text(row.location), unit: text(row.unit), stock: stock ? stock.value : null,
        barcode: text(row.BarCode), selectable: Boolean(id && ids.get(id) === 1 && stock && result.complete === true),
        ...(sourceIdentity !== undefined ? { sourceIdentity } : {})
      };
      if (!item.selectable) item.reason = !id ? '原系统记录缺少唯一标识。' : ids.get(id) !== 1 ? '原系统记录标识重复。' : !stock ? '原系统库存数值无效。' : '库存数据尚未完整取得。';
      return { item, raw: row, stock };
    });
    return { entries, result };
  }
  async function catalog({ search = '', code = '' } = {}) {
    await ready;
    const query = text(search).toLocaleLowerCase();
    const exact = text(code);
    let internalId = null, labelSourceIdentity;
    if (exact.startsWith('GY-SPARE:')) {
      let encodedId = exact.slice('GY-SPARE:'.length);
      if (encodedId.startsWith('v1:')) {
        const versioned = /^v1:([a-f0-9]{64}):(.+)$/.exec(encodedId);
        if (!versioned) throw fail(400, 'invalid_barcode', '备件标签的仓库标识或记录编号无效，请重新打印标签。');
        labelSourceIdentity = versioned[1]; encodedId = versioned[2];
      }
      try { internalId = decodeURIComponent(encodedId); }
      catch (_) { throw fail(400, 'invalid_barcode', '备件标签格式无效，请重新扫描或手动查询。'); }
      if (!internalId || internalId !== internalId.trim() || internalId.length > 200 || /[\u0000-\u001f\u007f]/.test(internalId)) throw fail(400, 'invalid_barcode', '备件标签缺少有效记录编号，请重新扫描。');
    }
    const { entries, result } = await readCatalog();
    if (internalId !== null) {
      if (labelSourceIdentity === undefined && result.sourceIdentity !== undefined) {
        throw fail(409, 'legacy_barcode', '此标签缺少仓库来源标识，请重新打印标签后扫码，或手动查找备件。');
      }
      if (labelSourceIdentity !== result.sourceIdentity) {
        throw fail(409, 'source_identity_mismatch', '此标签不属于当前仓库来源，请核对仓库后重新查找。');
      }
    }
    const items = entries.map(entry => entry.item).filter(item => (!exact || (internalId !== null ? item.id === internalId : item.code === exact || item.barcode === exact)) && (!query || [item.code, item.name, item.specification, item.location].some(value => value.toLocaleLowerCase().includes(query))));
    return { items, complete: result.complete === true, fetchedAt: result.fetchedAt || null,
      ...(result.sourceIdentity !== undefined ? { sourceIdentity: result.sourceIdentity } : {}),
      ...(typeof result.inventoryProfile === 'string' ? { inventoryProfile: result.inventoryProfile } : {}),
      ...(typeof result.inventoryLabel === 'string' ? { inventoryLabel: result.inventoryLabel } : {}),
      ...(Array.isArray(result.unmatched) ? { unmatched: copy(result.unmatched) } : {}),
      ...(typeof result.scopeConfigured === 'boolean' ? { scopeConfigured: result.scopeConfigured } : {}),
      ...(Number.isInteger(result.scopeCount) ? { scopeCount: result.scopeCount } : {}),
      ...(result.note ? { note: text(result.note) } : {}) };
  }
  async function freshItem(itemId) {
    const { entries, result } = await readCatalog();
    if (result.complete !== true) throw fail(503, 'incomplete_catalog', '原系统库存尚未完整取得，暂时不能提交。');
    const matches = entries.filter(entry => entry.item.id === itemId);
    if (matches.length !== 1 || !matches[0].item.selectable) throw fail(409, 'ambiguous_item', '备件记录缺失或不唯一，请重新查询并确认型号、库位。');
    return { ...matches[0], sourceRevision: result.sourceRevision, sourceIdentity: result.sourceIdentity };
  }
  async function capabilities() {
    await ready;
    let value = {};
    try { value = await source.inventoryCapabilities(); } catch (_) {}
    return Object.fromEntries(['inbound', 'outbound', 'adjust'].map(kind => [kind, {
      enabled: value?.[kind]?.enabled === true && typeof source.inventoryWrite === 'function' && !storageFault,
      reason: storageFault ? '本机记录保存异常，已暂停写入。' : text(value?.[kind]?.reason) || (value?.[kind]?.enabled === true ? '' : '原系统尚未开放此项写入能力。')
    }]));
  }
  async function requireCapability(kind) {
    const value = (await capabilities())[kind];
    if (!value.enabled) throw fail(503, 'capability_disabled', value.reason || '原系统尚未开放此项写入能力。');
  }
  function ensureStock(entry, expected) {
    if (entry.stock.units !== expected.units) throw fail(409, 'stale_stock', '库存已发生变化，请刷新库存后重新确认数量。');
  }
  function ensureSourceIdentity(entry, expected) {
    if (entry.sourceIdentity !== expected) throw fail(409, 'source_identity_mismatch', '仓库来源已经变化或未被确认，请重新查询备件；原盘点需回到对应仓库处理。');
  }
  function makeRecord(type, payload, actor, entry) {
    const at = timestamp();
    return { id: crypto.randomUUID(), type, kind: type, itemId: entry.item.id, item: copy(entry.item),
      beforeStock: entry.stock.value, expectedStock: payload.expectedStock, status: 'pending', actor: copy(actor),
      requestId: payload.requestId, remark: payload.remark, createdAt: at, updatedAt: at,
      ...(entry.sourceIdentity !== undefined ? { sourceIdentity: entry.sourceIdentity } : {}) };
  }
  function requestEntry(actor, payload, context, record, status) {
    return { account: actor.account, requestId: payload.requestId, fingerprint: context.fingerprint, status,
      recordId: record.id, createdAt: timestamp() };
  }
  async function finishLocal(record, actor, payload, context, trustedActor) {
    const fresh = await authorized(trustedActor, payload.action === 'review');
    if (payload.action === 'review') record.reviewer = fresh; else record.actor = fresh;
    const next = copy(state);
    const index = next.records.findIndex(item => item.id === record.id);
    if (index < 0) next.records.push(record); else next.records[index] = record;
    next.requests[context.key] = { ...requestEntry(actor, payload, context, record, 'completed'), result: copy(record) };
    await commit(next);
    return copy(record);
  }
  async function sourceWrite(kind, record, actor, payload, context, entry, trustedActor) {
    actor = await authorized(trustedActor, kind === 'adjust');
    const intent = copy(state);
    const index = intent.records.findIndex(item => item.id === record.id);
    if (index < 0) intent.records.push(record); else intent.records[index] = record;
    intent.requests[context.key] = requestEntry(actor, payload, context, record, 'intent');
    await commit(intent); // No external side effect until the intent is durable.
    let receipt, receiptId, dispatched = false;
    try {
      actor = await authorized(trustedActor, kind === 'adjust');
      dispatched = true;
      receipt = await source.inventoryWrite(kind, { item: copy(entry.raw), quantity: record.quantity,
        actualQuantity: record.actualQuantity, beforeStock: entry.stock.value, actor: copy(actor),
        requestId: payload.requestId, sourceRevision: entry.sourceRevision,
        ...(entry.sourceIdentity !== undefined ? { sourceIdentity: entry.sourceIdentity } : {}),
        reason: payload.reason || payload.remark || '' });
      receiptId = sourceReceiptId(receipt?.receiptId);
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || receipt.outcome === 'unknown' || receipt.confirmed === false || receipt.ok === false || receipt.success === false ||
          (receipt.confirmed !== true && receiptId === null)) {
        const error = new Error('Unconfirmed source response'); error.outcome = 'unknown'; throw error;
      }
    } catch (error) {
      const unknown = dispatched && error?.outcome === 'unknown';
      const next = copy(state);
      const failedRecord = next.records.find(item => item.id === record.id);
      failedRecord.status = unknown ? 'unknown' : record.type === 'count' ? 'pending' : 'rejected';
      failedRecord.updatedAt = timestamp();
      failedRecord.message = !dispatched ? '账号状态或权限已变化，本次操作未提交。' : unknown ? '原系统写入结果尚未确认，请管理员核对，不要重复提交。' : '原系统未接受本次写入，请核对后重新发起。';
      const failure = fail(!dispatched ? error.status || 403 : 503, !dispatched ? error.code || 'authorization_changed' : unknown ? 'outcome_unknown' : 'source_write_failed', failedRecord.message, { recordId: record.id });
      next.requests[context.key].status = unknown ? 'unknown' : 'failed';
      next.requests[context.key].error = serializeError(failure);
      try { await commit(next); }
      catch (_) { markUncertain(record.id, context.key); throw fail(503, 'outcome_unknown', '写入后的本机记录保存失败，请管理员核对原系统，不要重复提交。', { recordId: record.id }); }
      throw failure;
    }
    const next = copy(state);
    const completed = next.records.find(item => item.id === record.id);
    completed.status = 'applied'; completed.updatedAt = timestamp(); delete completed.message;
    // A company acknowledgement can confirm the operation without issuing a document ID.
    // Keep its actual evidence separate from the portal's own record/request identifiers.
    completed.confirmationMethod = receiptId !== null ? 'receipt' : 'company-success';
    if (receiptId !== null) completed.receiptId = receiptId;
    if (receipt.confirmed === true) completed.confirmed = true;
    if (typeof receipt.acknowledgement === 'string' && receipt.acknowledgement.trim() && receipt.acknowledgement.length <= 200 && !/[\u0000-\u001f\u007f]/.test(receipt.acknowledgement)) {
      completed.acknowledgement = receipt.acknowledgement.trim();
    }
    // Only an explicitly returned authoritative stock is stored as afterStock.
    const confirmedStock = sourceStock(receipt.afterStock);
    if (confirmedStock) completed.afterStock = confirmedStock.value;
    next.requests[context.key].status = 'completed'; next.requests[context.key].result = copy(completed);
    try { await commit(next); }
    catch (_) { markUncertain(record.id, context.key); throw fail(503, 'outcome_unknown', '原系统已响应，但本机记录保存失败，请管理员核对，不要重复提交。', { recordId: record.id }); }
    return copy(completed);
  }
  function markUncertain(recordId, key) {
    storageFault = true;
    const record = state.records.find(item => item.id === recordId);
    record.status = 'unknown'; record.updatedAt = timestamp();
    record.message = '原系统写入后的本机记录保存失败，请管理员核对，不要重复提交。';
    state.requests[key].status = 'unknown';
    state.requests[key].error = serializeError(fail(503, 'outcome_unknown', record.message, { recordId }));
    // The durable file still contains intent; startup turns that into unknown too.
  }

  async function transact(input, trustedActor) {
    const actor = actorIdentity(trustedActor);
    if (!input || !['inbound', 'outbound'].includes(input.kind)) throw fail(400, 'invalid_kind', '请选择入库或出库操作。');
    const amount = decimal(input.quantity, '操作数量', true);
    const expected = decimal(input.expectedStock, '确认库存');
    const payload = { action: 'transact', kind: input.kind, itemId: itemKey(input.itemId), quantity: amount.value,
      expectedStock: expected.value, expectedSourceIdentity: expectedSourceIdentity(input.expectedSourceIdentity), requestId: requestKey(input.requestId), remark: note(input.remark, '备注') };
    return serial(async () => {
      const currentActor = await authorized(trustedActor, payload.action === 'review');
      const context = findRequest(currentActor, payload.requestId, payload);
      if (context.result) return context.result;
      const entry = await freshItem(payload.itemId);
      ensureSourceIdentity(entry, payload.expectedSourceIdentity);
      blocked(payload.itemId, entry.sourceIdentity);
      ensureStock(entry, expected);
      if (payload.kind === 'outbound' && amount.units > entry.stock.units) throw fail(409, 'insufficient_stock', '可用库存不足，请核对出库数量。');
      await requireCapability(payload.kind);
      const record = makeRecord(payload.kind, payload, currentActor, entry); record.quantity = amount.value;
      return sourceWrite(payload.kind, record, currentActor, payload, context, entry, trustedActor);
    });
  }
  async function count(input, trustedActor) {
    const actor = actorIdentity(trustedActor);
    if (!input) throw fail(400, 'invalid_input', '请填写盘点数量。');
    const actual = decimal(input.actualQuantity, '实盘数量');
    const expected = decimal(input.expectedStock, '确认库存');
    const payload = { action: 'count', itemId: itemKey(input.itemId), actualQuantity: actual.value,
      expectedStock: expected.value, expectedSourceIdentity: expectedSourceIdentity(input.expectedSourceIdentity), requestId: requestKey(input.requestId), remark: note(input.remark, '备注') };
    return serial(async () => {
      const currentActor = await authorized(trustedActor, payload.action === 'review');
      const context = findRequest(currentActor, payload.requestId, payload);
      if (context.result) return context.result;
      const entry = await freshItem(payload.itemId); ensureSourceIdentity(entry, payload.expectedSourceIdentity); ensureStock(entry, expected);
      const record = makeRecord('count', payload, currentActor, entry);
      record.actualQuantity = actual.value; record.difference = Number(actual.units - entry.stock.units) / 1000000;
      record.status = record.difference === 0 ? 'unchanged' : 'pending';
      return finishLocal(record, currentActor, payload, context, trustedActor);
    });
  }
  async function review(input, trustedActor) {
    const actor = actorIdentity(trustedActor, true);
    if (!input || !['approve', 'reject'].includes(input.action)) throw fail(400, 'invalid_review', '请选择通过或驳回。');
    const payload = { action: 'review', id: itemKey(input.id), decision: input.action,
      requestId: requestKey(input.requestId), reason: note(input.reason, '复核说明') };
    return serial(async () => {
      const currentActor = await authorized(trustedActor, payload.action === 'review');
      const context = findRequest(currentActor, payload.requestId, payload);
      if (context.result) return context.result;
      const previous = state.records.find(item => item.id === payload.id);
      if (!previous || previous.type !== 'count') throw fail(404, 'count_not_found', '未找到这条盘点记录。');
      if (previous.status !== 'pending') throw fail(409, 'already_reviewed', '这条盘点记录已处理，请刷新列表。');
      const entry = await freshItem(previous.itemId);
      ensureSourceIdentity(entry, previous.sourceIdentity);
      blocked(previous.itemId, entry.sourceIdentity);
      const record = copy(previous); delete record.message;
      record.reviewer = copy(currentActor); record.reviewReason = payload.reason; record.reviewedAt = timestamp(); record.updatedAt = record.reviewedAt;
      if (payload.decision === 'reject') { record.status = 'rejected'; return finishLocal(record, currentActor, payload, context, trustedActor); }
      ensureStock(entry, decimal(previous.beforeStock, '盘点时库存'));
      await requireCapability('adjust');
      return sourceWrite('adjust', record, currentActor, payload, context, entry, trustedActor);
    });
  }
  async function list({ type, status } = {}, trustedActor) {
    actorIdentity(trustedActor);
    return serial(async () => {
      await authorized(trustedActor);
      const counts = { pending: 0, rejected: 0, applied: 0, unchanged: 0, unknown: 0, total: state.records.length };
      for (const record of state.records) counts[record.status] = (counts[record.status] || 0) + 1;
      const records = state.records.filter(record => (!type || record.type === type) && (!status || record.status === status)).slice().reverse();
      return { records: copy(records), counts };
    });
  }
  return { catalog, capabilities, transact, count, review, list };
}

module.exports = { createInventoryService, InventoryError };
