'use strict';
// Local extension point. No transport, persistence, cross-window messaging or upload.
(() => {
  const registry = new Map();
  const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
  window.PortalToolBridge = Object.freeze({
    version: '1.0.0',
    remote: Object.freeze({ enabled: false, reason: '尚未配置远端处理适配器。' }),
    register(id, adapter) {
      if (!/^[a-z][a-z0-9-]+$/.test(id) || registry.has(id)) throw new Error('工具标识无效或已注册。');
      if (!adapter || ['importFiles', 'getResult', 'reset'].some(key => typeof adapter[key] !== 'function')) throw new Error('工具适配器缺少必要操作。');
      registry.set(id, adapter);
    },
    capabilities() { return { version: '1.0.0', processing: 'browser', remoteEnabled: false, tools: [...registry.keys()] }; },
    async importFiles(id, files) { const adapter = registry.get(id); if (!adapter) throw new Error('未注册此工具。'); return adapter.importFiles(files); },
    getResult(id) { return clone(registry.get(id)?.getResult()); },
    reset(id) { const adapter = registry.get(id); if (!adapter) throw new Error('未注册此工具。'); adapter.reset(); },
    notify(id, summary) {
      if (!registry.has(id)) return;
      // The event deliberately carries counts only: never file names, paths, SNs or data rows.
      const counts = {};
      for (const key of ['fileCount', 'rowCount', 'pairCount', 'itemCount']) if (Number.isSafeInteger(summary?.[key]) && summary[key] >= 0) counts[key] = summary[key];
      window.dispatchEvent(new CustomEvent('portal-tool:result', { detail: { version: '1.0.0', toolId: id, processing: 'browser', ...counts } }));
    },
    runRemote() { return Promise.reject(Object.assign(new Error('远端适配器尚未启用；文件仍只在当前浏览器中处理。'), { code: 'tool_adapter_disabled' })); }
  });
  if (location.protocol === 'file:') document.querySelectorAll('[data-portal-return]').forEach(link => { link.hidden = true; });
})();
