(() => {
  'use strict';
  const defaults = Object.freeze({homeModule:'weld-live',dateRange:'today',pageSize:50,compact:false,reduceMotion:false,textSize:'standard',accentTheme:'blue',reportDepartment:'工艺部',reportAuthor:'',reportShowSource:true});
  const routes = ['weld-live','alarm','vision','matching-gap','spares','tools'];
  const memory = new Map();
  let account = null, preferences = {...defaults}, storageState = 'signed-out';
  const storageKey = value => 'gongyi.portal.preferences.v1.' + encodeURIComponent(value);
  const plainText = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,60);
  function normalize(input) {
    const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    return {
      homeModule:routes.includes(value.homeModule) ? value.homeModule : defaults.homeModule,
      dateRange:['today','week','month','companyWeek','all'].includes(value.dateRange) ? value.dateRange : defaults.dateRange,
      pageSize:[20,50,100].includes(Number(value.pageSize)) ? Number(value.pageSize) : defaults.pageSize,
      compact:typeof value.compact === 'boolean' ? value.compact : defaults.compact,
      reduceMotion:typeof value.reduceMotion === 'boolean' ? value.reduceMotion : defaults.reduceMotion,
      textSize:['standard','large'].includes(value.textSize) ? value.textSize : defaults.textSize,
      accentTheme:['blue','teal','violet'].includes(value.accentTheme) ? value.accentTheme : defaults.accentTheme,
      reportDepartment:typeof value.reportDepartment === 'string' ? plainText(value.reportDepartment) : defaults.reportDepartment,
      reportAuthor:typeof value.reportAuthor === 'string' ? plainText(value.reportAuthor) : defaults.reportAuthor,
      reportShowSource:typeof value.reportShowSource === 'boolean' ? value.reportShowSource : defaults.reportShowSource
    };
  }
  function applyAppearance() {
    document.documentElement.classList.toggle('portal-compact',preferences.compact);
    document.documentElement.classList.toggle('portal-reduce-motion',preferences.reduceMotion);
    document.documentElement.classList.toggle('portal-large-text',preferences.textSize === 'large');
    for (const theme of ['blue','teal','violet']) document.documentElement.classList.toggle('portal-accent-'+theme,preferences.accentTheme === theme);
  }
  function announce(reason,persisted) {
    applyAppearance();
    document.dispatchEvent(new CustomEvent('portal:preferences-changed',{detail:{account,preferences:{...preferences},reason,persisted}}));
  }
  function get() { return {...preferences}; }
  function setAccount(value) {
    const next = typeof value === 'string' && value.trim() ? value.trim().slice(0,80) : null;
    if (next === account) return get();
    account = next;preferences = {...defaults};storageState = account ? 'available' : 'signed-out';
    if (account) {
      try {
        if (memory.has(account)) { preferences = {...memory.get(account)};storageState = 'session'; }
        else {
          const stored = window.localStorage.getItem(storageKey(account));
          if (stored) preferences = normalize(JSON.parse(stored));
        }
      } catch (_) { storageState = 'unavailable';if (memory.has(account)) { preferences = {...memory.get(account)};storageState = 'session'; } }
    }
    announce('account',null);
    return get();
  }
  function save(value,reason) {
    if (!account) return {preferences:get(),persisted:false,error:'请先登录门户，再保存个人偏好。'};
    preferences = normalize(value);
    let persisted = false,error = '';
    try {
      if (reason === 'reset') window.localStorage.removeItem(storageKey(account));
      else window.localStorage.setItem(storageKey(account),JSON.stringify(preferences));
      persisted = true;memory.delete(account);storageState = 'available';
    } catch (_) { memory.set(account,get());storageState = 'session';error = '浏览器未允许保存偏好，本次页面内已生效；关闭页面后可能恢复为原设置。'; }
    announce(reason,persisted);
    return {preferences:get(),persisted,error};
  }
  function set(partial) { return save({...preferences,...(partial && typeof partial === 'object' ? partial : {})},'save'); }
  function reset() { return save(defaults,'reset'); }
  function exportText() {
    if (!account) throw new Error('请先登录门户，再导出个人偏好。');
    return JSON.stringify({format:'gongyi-portal-preferences',version:1,preferences:normalize(preferences)},null,2);
  }
  function parseImport(text) {
    if (typeof text !== 'string' || text.length > 16384) throw new Error('请选择不超过 16 KB 的门户偏好 JSON 文件。');
    let data;try { data = JSON.parse(text); } catch (_) { throw new Error('文件不是有效的 JSON，请选择从门户导出的偏好文件。'); }
    if (!data || Array.isArray(data) || data.format !== 'gongyi-portal-preferences' || data.version !== 1 || Object.keys(data).some(key=>!['format','version','preferences'].includes(key))) throw new Error('此文件不是受支持的门户偏好备份。');
    const value=data.preferences;
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length || Object.keys(value).some(key=>!Object.hasOwn(defaults,key))) throw new Error('偏好文件包含不支持的字段，请重新导出。');
    const clean=normalize(value);
    for (const key of Object.keys(value)) if (value[key] !== clean[key]) throw new Error('偏好文件中的设置值无效，请重新导出。');
    return clean;
  }
  function importText(text) { return save(parseImport(text),'import'); }
  function storageStatus() { return {state:storageState}; }
  window.PortalPreferences = Object.freeze({get,set,reset,setAccount,defaults,exportText,parseImport,importText,storageStatus});
  document.addEventListener('portal:status',event => {
    const status = event.detail?.status ?? event.detail;
    setAccount(status?.authenticated ? status.account : null);
  });
  document.addEventListener('portal:session-expired',() => setAccount(null));
  window.addEventListener('storage',event => {
    if (!account || (event.key !== null && event.key !== storageKey(account))) return;
    try { preferences = event.newValue ? normalize(JSON.parse(event.newValue)) : {...defaults}; }
    catch (_) { preferences = {...defaults}; }
    memory.delete(account);storageState='available';announce('storage',true);
  });
  applyAppearance();
})();
