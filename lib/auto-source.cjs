'use strict';
const { PortalError } = require('./source.cjs');
const { validateCredentials } = require('./credential-store.cjs');

function createAutoSource({ source, credentialStore, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let state = 'unconfigured', configured = false, message = null, retryAt = null;
  let context = null, version = 0, revision = 0, loginFlight = null, configuring = false;
  let failures = 0, blocked = false, timer = null, stopped = false, manualRetryAt = 0, writeBusy = false;
  let cache = new Map(), pending = new Map();
  const status = () => ({ state, configured, retryAt: retryAt === null ? null : new Date(retryAt).toISOString(), error: message });
  const unavailable = () => new PortalError(message || (state === 'unconfigured' ? '管理员需首次设置数据源，之后会自动读取。' : '数据源正在连接，请稍后重试。'), 428);
  function cancelTimer() { if (timer !== null) clearTimer(timer); timer = null; }
  function invalidate() { context = null; revision++; cache = new Map(); pending = new Map(); }
  function commit(auth) {
    if (!auth || typeof auth.token !== 'string' || !auth.token) throw new PortalError('数据源没有返回有效连接。', 502);
    invalidate(); context = { token: auth.token };
    state = 'ready'; configured = true; message = null; retryAt = null; failures = 0; blocked = false; cancelTimer();
    return context;
  }
  function recordFailure(error) {
    invalidate(); state = 'error'; failures++;
    blocked = error.status === 400 || error.status === 401 || error.status === 403 || failures >= 3;
    message = error.status === 400 || error.status === 401 ? '公司系统未接受数据源登录，请管理员核对授权账号及原系统登录条件。' :
      error.status === 403 ? '公司系统拒绝数据源登录，请管理员核对账号权限。' : '暂时无法建立数据源连接，请确认公司网络及本机设置。';
    cancelTimer();
    retryAt = blocked ? null : now() + (failures === 1 ? 60000 : 300000);
    if (blocked && error.status !== 400 && error.status !== 401 && error.status !== 403) message += ' 自动尝试已暂停，请管理员核对设置。';
    if (retryAt !== null && !stopped) {
      timer = setTimer(() => { timer = null; start(); }, Math.max(1, retryAt - now()));
      timer?.unref?.();
    }
  }
  async function ensureReady() {
    if (stopped) throw unavailable();
    if (context) return context;
    if (loginFlight) return loginFlight;
    if (blocked || (retryAt !== null && now() < retryAt)) throw unavailable();
    const snapshot = version;
    state = 'connecting'; message = null; retryAt = null;
    const work = (async () => {
      let credentials;
      try {
        credentials = await credentialStore.load();
        if (snapshot !== version || stopped) throw unavailable();
        if (!credentials) { configured = false; state = 'unconfigured'; throw unavailable(); }
        configured = true;
        if (!source) throw new PortalError('数据源地址尚未配置。', 503);
        const auth = await source.login(credentials.username, credentials.password);
        if (snapshot !== version || stopped) throw unavailable();
        return commit(auth);
      } catch (error) {
        if (snapshot === version && !stopped && state !== 'unconfigured') recordFailure(error);
        throw unavailable();
      } finally { if (credentials) credentials.password = ''; }
    })();
    loginFlight = work;
    try { return await work; } finally { if (loginFlight === work) loginFlight = null; }
  }
  function start() { if (!stopped) ensureReady().catch(() => {}); }
  async function configure(value) {
    if (writeBusy) throw new PortalError('正在提交库存操作，请完成后再修改数据源。',409);
    if (configuring) throw new PortalError('数据源设置正在验证，请等待本次完成。', 409);
    if (now() < manualRetryAt) throw new PortalError('数据源设置尝试过于频繁，请一分钟后再试。', 429);
    credentialStore.assertWritable?.();
    if (!source) throw new PortalError('公司系统地址尚未配置，请联系维护人员。', 503);
    const credentials = validateCredentials(value);
    configuring = true;
    try {
      const auth = await source.login(credentials.username, credentials.password);
      if (!auth || typeof auth.token !== 'string' || !auth.token) throw new PortalError('数据源没有返回有效连接。', 502);
      await credentialStore.save(credentials);
      version++; loginFlight = null; manualRetryAt = 0;
      commit(auth);
      return status();
    } catch (error) {
      manualRetryAt = now() + 60000;
      if (!context) { state = 'error'; message = '数据源设置未成功验证或保存，请核对原系统登录条件及本机设置。'; }
      // Failed candidates never replace the working account or its credentials.
      throw new PortalError(error.status === 409 ? error.message : '数据源设置未成功验证或保存，请核对原系统登录条件及本机设置。', error.status === 401 ? 400 : error.status || 503);
    } finally { credentials.password = ''; configuring = false; }
  }
  async function clear() {
    if (writeBusy) throw new PortalError('正在提交库存操作，请完成后再修改数据源。',409);
    if (configuring) throw new PortalError('数据源设置正在验证，请等待本次完成。', 409);
    await credentialStore.remove(); version++; loginFlight = null; invalidate(); cancelTimer();
    configured = false; state = 'unconfigured'; message = null; retryAt = null; failures = 0; blocked = false;
    return status();
  }
  async function performRead(module, query, snapshot) {
    let used = await ensureReady();
    for (let attempt = 0; attempt < 2; attempt++) {
      if (snapshot !== version) throw new PortalError('数据源设置已变更，请重新查询。', 428);
      const usedRevision = revision;
      try {
        const result = await source.read(module, query, used);
        if (snapshot !== version) throw new PortalError('数据源设置已变更，请重新查询。', 428);
        return { result, revision: usedRevision };
      } catch (error) {
        if (snapshot !== version) throw new PortalError('数据源设置已变更，请重新查询。', 428);
        if (error.status !== 401) throw error;
        if (attempt === 1) {
          recordFailure(new PortalError('数据源重新登录后仍未获授权。', 401));
          throw unavailable();
        }
        if (context === used) { invalidate(); state = 'connecting'; }
        used = await ensureReady();
      }
    }
  }
  async function read(module, query) {
    await ensureReady();
    const snapshot = version;
    const key = module + JSON.stringify(query);
    const ttl = module === 'spares' ? 29000 : 14000;
    const existing = cache.get(key);
    if (existing && now() - existing.at < ttl) return existing.data;
    const pendingMap = pending;
    if (!pendingMap.has(key)) pendingMap.set(key, performRead(module, query, snapshot));
    const work = pendingMap.get(key);
    try {
      const value = await work;
      if (snapshot !== version) throw new PortalError('数据源设置已变更，请重新查询。', 428);
      if (value.revision === revision) {
        cache.set(key, { at: now(), data: value.result });
        while (cache.size > 24) cache.delete(cache.keys().next().value);
      }
      return value.result;
    } finally { if (pendingMap.get(key) === work) pendingMap.delete(key); }
  }
  const inventoryCapabilities = () => source?.inventoryCapabilities?.() || Object.fromEntries(['inbound','outbound','adjust'].map(key=>[key,{enabled:false,reason:'公司系统库存接口尚未配置。'}]));
  async function inventoryCatalog(options = {}) {
    let used = await ensureReady(); const snapshot = version;
    if (!source?.inventoryCatalog) throw new PortalError('公司系统备件范围尚未配置。',503);
    for(let attempt=0;attempt<2;attempt++){
      try {
        const result = await source.inventoryCatalog(options,used);
        if (snapshot !== version) throw new PortalError('数据源设置已变更，请重新查询。',428);
        return {...result,sourceRevision:snapshot};
      } catch(error) {
        if(snapshot!==version)throw new PortalError('数据源设置已变更，请重新查询。',428);
        if(error.status!==401)throw error;
        if(attempt===1){recordFailure(new PortalError('公司库存读取重新登录后仍未获授权。',401));throw unavailable();}
        if(context===used){invalidate();state='connecting';}
        used=await ensureReady();
      }
    }
  }
  async function inventoryWrite(kind,operation) {
    if (writeBusy || configuring) throw new PortalError('库存操作或数据源设置正在处理，请稍后再试。',409);
    writeBusy = true; let used;
    try {
      used = await ensureReady(); const snapshot = version;
      if(operation.sourceRevision !== undefined && operation.sourceRevision !== snapshot) throw new PortalError('数据源设置已变更，请重新查询备件后提交。',409);
      if (!source?.inventoryWrite) throw new PortalError('公司系统库存写入尚未配置。',503);
      revision++; used.inventoryRevision=(used.inventoryRevision||0)+1;
      // A write is sent once. Authentication refresh/retry is reserved for reads.
      const result = await source.inventoryWrite(kind,operation,used);
      if (snapshot !== version) { const error = new PortalError('写入期间数据源变更，请核对原系统单据。',503); error.outcome='unknown'; throw error; }
      return result;
    } finally { writeBusy=false; revision++; cache=new Map(); pending=new Map(); if(used){used.inventoryRevision=(used.inventoryRevision||0)+1;used.sourceCache?.clear();used.sourcePending?.clear();} }
  }
  function stop() { stopped = true; version++; invalidate(); cancelTimer(); }
  return { status, start, ensureReady, configure, clear, read, stop, inventoryCapabilities, inventoryCatalog, inventoryWrite };
}
module.exports = { createAutoSource };
