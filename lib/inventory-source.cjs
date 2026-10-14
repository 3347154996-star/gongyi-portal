'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const CANONICAL = new Set(['itemId','code','name','specification','location','unit','quantity','actualQuantity','beforeStock','operatorAccount','operatorName','requestId','reason']);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const text = value => value == null ? '' : String(value).trim();
const PROFILES = new Set(['power-udp', 'power-mold']);
const copy = value => JSON.parse(JSON.stringify(value));
const numericFlag = value => Number.isFinite(Number(value)) ? Number(value) : 0;
function activeRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  const mark = row.deleteMark;
  // Absent legacy flags are allowed; malformed nonempty values must not become active rows.
  return mark == null || mark === false || (['string','number'].includes(typeof mark) && Number.isFinite(Number(mark)) && Number(mark) === 0);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}
const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function cleanRow(row) { return Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('__'))); }
function fail(message, status = 503, outcome) { const error = new Error(message); error.status = status; if (outcome) error.outcome = outcome; return error; }
function safeField(value) { return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value) && !['__proto__','constructor','prototype'].includes(value); }
function valueAt(object, field) {
  if (typeof field !== 'string' || !/^[A-Za-z][A-Za-z0-9_.]{0,99}$/.test(field)) return undefined;
  let value = object; for (const key of field.split('.')) { if (!safeField(key) || value == null || !own(value, key)) return undefined; value = value[key]; } return value;
}
function createInventoryConnector(config, { allRows, fetchImpl = fetch } = {}) {
  const scopeFile = config.inventoryScopePath || path.join(__dirname, '..', 'runtime', 'inventory-scope.json');
  // Snapshots are bound to the actual upstream session, not a caller-supplied material code.
  const loadedCatalogs = new WeakMap();
  const catalogLoads = new WeakMap();
  const profile = () => text(config.inventoryConnection?.profile);
  const warehouseKey = () => text(config.inventoryConnection?.warehouseKey);
  const validWarehouse = () => /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(warehouseKey());
  const scopeFingerprint = scope => fingerprint([...new Set((scope || []).map(row => JSON.stringify([row.code,row.name,row.specification])))].sort());
  function binding() {
    let base;
    try { base = new URL(config.apiBase); if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error(); }
    catch (_) { throw fail('公司仓库来源地址无效，请管理员核对。'); }
    const inventoryProfile = profile() || 'custom-mold';
    const inventoryLabel = text(config.inventoryConnection?.label) || '工艺部备件库';
    const sourceIdentity = fingerprint({ apiOrigin: base.origin, apiBase: base.pathname.replace(/\/+$/, '') || '/',
      tenant: text(config.tenantId), profile: inventoryProfile, warehouseKey: warehouseKey() || (profile() ? '' : 'legacy-mold') });
    return { sourceIdentity, inventoryProfile, inventoryLabel };
  }
  function contract(kind) {
    const spec = config.inventoryWrites?.[kind];
    if (!spec || spec.verified !== true || !text(spec.verificationNote)) return null;
    // Explicit operator-reviewed contracts only. Never substitute the UDP inventory module.
    if (!/^\/api\/Mold_[A-Za-z0-9_/-]+$/.test(spec.path || '') || !['POST','PUT'].includes(spec.method)) return null;
    if (!spec.fields || typeof spec.fields !== 'object' || Array.isArray(spec.fields)) return null;
    const entries = Object.entries(spec.fields);
    if (entries.some(([key, value]) => !CANONICAL.has(key) || !safeField(value)) || new Set(entries.map(([,v]) => v)).size !== entries.length) return null;
    const required = ['itemId','operatorAccount','operatorName','requestId', kind === 'adjust' ? 'actualQuantity' : 'quantity'];
    if (required.some(key => !safeField(spec.fields[key]))) return null;
    if (['outbound','adjust'].includes(kind) && (!safeField(spec.fields.beforeStock) || spec.atomicStockCheck !== true)) return null;
    if (spec.staticFields && (typeof spec.staticFields !== 'object' || Array.isArray(spec.staticFields) || Object.keys(spec.staticFields).some(key => !safeField(key) || entries.some(([,v])=>v===key)))) return null;
    if (typeof spec.receiptField !== 'string' || !/^[A-Za-z][A-Za-z0-9_.]{0,99}$/.test(spec.receiptField)) return null;
    return spec;
  }
  function inventoryCapabilities() {
    if (profile()) {
      const supported = PROFILES.has(profile());
      return Object.fromEntries(['inbound','outbound','adjust'].map(kind => {
        const moldOutbound = profile() === 'power-mold' && kind === 'outbound';
        const enabled = supported && validWarehouse() && !moldOutbound && config.inventoryConnection?.writes?.[kind] === true;
        const reason = !supported ? '公司仓库接入方式无效，请管理员核对。' : !validWarehouse() ? '管理员需配置稳定的仓库标识。' : moldOutbound ? 'Mold 出库接口尚未核实，暂未开放。' : enabled ? '' : '管理员尚未开启此仓库操作。';
        return [kind, { enabled, reason }];
      }));
    }
    return Object.fromEntries(['inbound','outbound','adjust'].map(kind => [kind, { enabled: Boolean(contract(kind)), reason: contract(kind) ? '' : ({inbound:'公司系统入库字段、人员记录及成功回执尚待核实。',outbound:'公司系统出库接口及成功回执尚待核实。',adjust:'公司系统盘点调账接口及成功回执尚待核实。'})[kind] }]));
  }
  function loadScope() {
    let scope;
    try { scope = config.inventoryScope || JSON.parse(fs.readFileSync(scopeFile, 'utf8').replace(/^\uFEFF/, '')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw fail('工艺部备件范围文件无法读取，请管理员核对。'); }
    if (!scope || !Array.isArray(scope.records) || scope.records.length > 10000 || !scope.records.length || scope.records.some(row => !row || typeof row !== 'object' || (!text(row.code) && !text(row.specification) && !text(row.name)))) throw fail('工艺部备件范围无效，请管理员核对物料编号和型号。');
    return scope.records.map(row => ({code:text(row.code),name:text(row.name),specification:text(row.specification)}));
  }
  async function inventoryCatalog(options, session) {
    const load = {}, upstreamRevision = session?.inventoryRevision || 0;
    if (session && typeof session === 'object') { loadedCatalogs.delete(session); catalogLoads.set(session,load); }
    const scope = loadScope();
    const bound = binding();
    if (!scope) return {...bound,rows:[],complete:false,scopeConfigured:false,scopeCount:0,unmatched:[],fetchedAt:null,note:'管理员需先导入工艺部备件范围。'};
    if (profile() && !PROFILES.has(profile())) throw fail('公司仓库接入方式无效，请管理员核对。');
    if (profile() && !validWarehouse()) return {...bound,rows:[],complete:false,scopeConfigured:true,scopeCount:scope.length,unmatched:[],fetchedAt:null,note:'管理员需配置稳定的仓库标识。'};
    const scopeVersion = scopeFingerprint(scope);
    const result = await allRows('spares', {}, session);
    if ((session?.inventoryRevision || 0) !== upstreamRevision || (session && typeof session === 'object' && catalogLoads.get(session) !== load)) {
      throw fail('库存查询或操作已更新，请重新查询备件。',409);
    }
    if (!result || !Array.isArray(result.rows)) throw fail('公司仓库列表格式无效，请稍后重新查询。');
    if (binding().sourceIdentity !== bound.sourceIdentity || scopeFingerprint(loadScope()) !== scopeVersion) throw fail('仓库设置已变更，请重新查询备件。',409);
    const codes = new Set(scope.map(row=>row.code).filter(Boolean));
    const models = new Set(scope.filter(row=>!row.code).map(row=>row.specification).filter(Boolean));
    const rows = result.rows.filter(row=>activeRow(row) && (codes.has(text(row.bjbh)) || models.has(text(row.specifications))));
    const unmatched = scope.filter(entry=>!rows.some(row=>entry.code ? text(row.bjbh)===entry.code : entry.specification && text(row.specifications)===entry.specification))
      .map(entry=>({...entry,reason:entry.code?'公司系统中未找到此物料编号。':entry.specification?'未提供物料编号，型号也未与公司记录对应。':'未提供物料编号或完整型号，需要先补充物料资料。'}));
    if (session && typeof session === 'object') loadedCatalogs.set(session, { ...bound, scopeVersion, complete: result.complete === true, rows: copy(rows) });
    return {...result,...bound,rows,scopeConfigured:true,scopeCount:scope.length,unmatched};
  }
  function powerOperation(kind, operation, session) {
    const capability = inventoryCapabilities()[kind];
    if (!capability?.enabled) throw fail(capability?.reason || '未开放此库存操作。');
    const scope = loadScope(), bound = binding(), loaded = loadedCatalogs.get(session);
    if (!scope || !loaded?.complete || loaded.scopeVersion !== scopeFingerprint(scope) || loaded.sourceIdentity !== bound.sourceIdentity || operation.sourceIdentity !== bound.sourceIdentity) {
      throw fail('仓库来源或备件范围已变化，请重新查询后提交。',409);
    }
    const item = operation.item;
    const id = item && ['string','number'].includes(typeof item.id) ? text(item.id) : '';
    const matches = loaded.rows.filter(row => text(row.id) === id);
    if (!id || matches.length !== 1 || !item || fingerprint(cleanRow(item)) !== fingerprint(cleanRow(matches[0]))) {
      throw fail('备件记录不属于本次仓库查询或记录不唯一，请重新查询。',409);
    }
    const row = matches[0], stock = row.nowStock;
    if (!['string','number'].includes(typeof stock) || !text(stock) || !Number.isFinite(Number(stock)) || Number(stock) < 0 || Number(stock) !== operation.beforeStock) {
      throw fail('备件库存尚未核对，请重新查询后提交。',409);
    }
    const amount = kind === 'adjust' ? operation.actualQuantity : operation.quantity;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || (kind !== 'adjust' && amount === 0)) throw fail('请输入有效的库存数量。',400);
    if (kind === 'outbound' && amount > Number(stock)) throw fail('库存不足，请重新核对数量。',409);
    const module = bound.inventoryProfile === 'power-udp' ? 'UDP' : 'Mold';
    if (kind === 'adjust') return { path:`/api/${module}_SparepartsDetailed`, method:'PUT', payload:{...cleanRow(row),nowStock:amount} };
    let payload;
    if (module === 'UDP') {
      const fields = ['sparepartName','bjbh','bjmc','specifications','price','manufacturer','location','unit'];
      payload = {pid:row.id,...Object.fromEntries(fields.filter(key => row[key] !== undefined).map(key => [key,row[key]])),
        isSubstitution:numericFlag(row.isSubstitution),isStandard:numericFlag(row.isStandard)};
    } else payload = {...cleanRow(row),pid:row.id};
    if (kind === 'inbound') Object.assign(payload,{inType:1,inNumber:amount});
    else {
      if (!text(operation.actor?.name)) throw fail('领用人尚未确认，请重新登录。',403);
      Object.assign(payload,{outType:1,outNumber:amount,outPeople:text(operation.actor.name),isReplace:0,remark:operation.reason || ''});
    }
    return {path:`/api/${module}_Spareparts${kind === 'inbound' ? 'InStock' : 'OutStock'}`,method:'POST',payload};
  }
  async function inventoryWrite(kind, operation, session) {
    const power = Boolean(profile());
    const spec = power ? null : contract(kind); if (!power && !spec) throw fail(inventoryCapabilities()[kind]?.reason || '未开放此库存操作。');
    if (!session?.token) throw fail('公司系统会话尚未建立。', 428);
    const item = operation.item || {}, actor = operation.actor || {};
    const canonical = {itemId:item.id,code:item.bjbh,name:item.bjmc,specification:item.specifications,location:item.location,unit:item.unit,
      quantity:operation.quantity,actualQuantity:operation.actualQuantity,beforeStock:operation.beforeStock,operatorAccount:actor.account,operatorName:actor.name,requestId:operation.requestId,reason:operation.reason || ''};
    let request;
    if (power) request = powerOperation(kind,operation,session);
    else {
      const payload = {...spec.staticFields};
      for (const [key, field] of Object.entries(spec.fields)) { if (canonical[key] !== undefined && canonical[key] !== null) payload[field] = canonical[key]; }
      request = {path:spec.path,method:spec.method,payload};
    }
    const headers = {Accept:'application/json','Content-Type':'application/json',language:config.language || '0',Authorization:`Bearer ${session.token}`};
    if (config.tenantId) headers['TENANT-ID'] = String(config.tenantId);
    let response;
    try { response = await fetchImpl(new URL(request.path,config.apiBase),{method:request.method,headers,body:JSON.stringify(request.payload),redirect:'error',signal:AbortSignal.timeout(18000)}); }
    catch (_) { throw fail('公司系统未返回明确结果，请核对原系统单据；本次操作不会自动重试。',503,'unknown'); }
    if (!response || typeof response !== 'object') throw fail('公司系统响应格式无效，库存结果待核实。',503,'unknown');
    if (response.status === 401 || response.status === 403) throw fail('公司系统未授权本次库存操作，请管理员核对权限。',response.status);
    if (!response.ok) throw fail('公司系统响应异常，库存结果待核实；请勿重复提交。',503,'unknown');
    let result; try { result = await response.json(); } catch (_) { throw fail('公司系统回执无法解析，库存结果待核实。',503,'unknown'); }
    if (!result || typeof result !== 'object' || Array.isArray(result) || !own(result,'code')) throw fail('公司系统回执缺少成功标记，库存结果待核实。',503,'unknown');
    if (power) {
      if (typeof result.code !== 'number' || !Number.isFinite(result.code)) throw fail('公司系统成功标记格式不明确，库存结果待核实。',503,'unknown');
      if (result.code !== 0) throw fail('公司系统拒绝了本次库存操作，请核对业务条件。',[401,403].includes(result.code) ? result.code : 422);
      session.sourceCache?.clear(); session.sourcePending?.clear(); loadedCatalogs.delete(session);
      return {confirmed:true,acknowledgement:'company-success'};
    }
    if (!(result.code === 0 || result.code === '0')) throw fail('公司系统拒绝了本次库存操作，请核对业务条件。',422);
    const receipt = valueAt(result,spec.receiptField);
    if (!['string','number'].includes(typeof receipt) || !text(receipt)) throw fail('公司系统未返回可核对的单据编号，库存结果待核实。',503,'unknown');
    session.sourceCache?.clear(); session.sourcePending?.clear();
    return {receiptId:text(receipt)};
  }
  return {inventoryCapabilities,inventoryCatalog,inventoryWrite};
}
module.exports = {createInventoryConnector};
