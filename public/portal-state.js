(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PortalState = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const MODULES = ['weld', 'alarm'];
  const QUERY_FIELDS = ['keyword', 'category', 'stock', 'materialName', 'line', 'defectType', 'op', 'location', 'status', 'department'];
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const text = (value, fallback = 'all') => typeof value === 'string' ? value.slice(0, 500) : fallback;
  function normalizeQuery(raw, module, day) {
    raw = raw && typeof raw === 'object' ? raw : {};
    const rolling = raw.rolling !== false;
    const query = { module, view: module === 'weld' && !rolling ? 'weekly' : 'live',
      page: Number.isSafeInteger(Number(raw.page)) && Number(raw.page) > 0 ? Number(raw.page) : 1,
      size: [20, 50, 100].includes(Number(raw.size)) ? Number(raw.size) : 50,
      start: rolling ? day : DAY.test(raw.start) ? raw.start : day,
      end: rolling ? day : DAY.test(raw.end) ? raw.end : day, rolling, group: 'all' };
    for (const field of QUERY_FIELDS) query[field] = text(raw[field], field === 'keyword' ? '' : 'all');
    query.defects = Array.isArray(raw.defects) ? [...new Set(raw.defects.filter(value => typeof value === 'string').map(value => value.slice(0, 500)))].slice(0, 200) : [];
    return query;
  }
  // Only an explicit submit may replace a committed filter. Refresh/page/route
  // requests deliberately do not consult edited controls once a query exists.
  function requestQuery({ reason, draft, applied, module, day, page, size }) {
    const submit = ['filter', 'drill', 'view'].includes(reason);
    const query = normalizeQuery(submit || !applied ? draft : applied, module, day);
    if (reason === 'page') {
      query.page = Number.isSafeInteger(page) && page > 0 ? page : query.page;
      if ([20, 50, 100].includes(size)) query.size = size;
    }
    return query;
  }
  function sameFilters(first, second, day) {
    if (!first || !second) return !first && !second;
    const clean = query => { const value = normalizeQuery(query, query.module, day); delete value.page; delete value.size; return value; };
    return JSON.stringify(clean(first)) === JSON.stringify(clean(second));
  }
  function createSession(storage) {
    const key = account => 'gongyi.portal.filters.v2:' + encodeURIComponent(account);
    const clean = (value, day) => {
      const result = {};
      if (!value || typeof value !== 'object') return result;
      for (const module of MODULES) {
        const entry = value[module];
        if (!entry || !entry.query || entry.query.module !== module) continue;
        result[module] = { query: normalizeQuery(entry.query, module, day), polling: entry.polling !== false,
          interval: [15, 30, 60].includes(entry.interval) ? entry.interval : 30,
          history: Array.isArray(entry.history) ? entry.history.slice(-12).map(query => normalizeQuery(query, module, day)) : [] };
      }
      return result;
    };
    return {
      read(account, day) { if (!account) return {}; try { storage.removeItem('gongyi.portal.filters.v1:'+encodeURIComponent(account));return clean(JSON.parse(storage.getItem(key(account))), day); } catch (_) { return {}; } },
      write(account, value, day) { if (!account) return; try { storage.setItem(key(account), JSON.stringify(clean(value, day))); } catch (_) { /* Storage may be disabled or full; in-memory state still works. */ } },
      clear(account) { if (!account) return; try { storage.removeItem(key(account)); } catch (_) {} }
    };
  }
  function opColor(op) {
    const label = String(op || '').trim().toUpperCase();
    if (!label || ['其他', '未识别工位'].includes(label)) return '#aeb7c5';
    const colors = ['#477fcc', '#46b7c7', '#efa144', '#75ae5f', '#9586bb', '#cf8498', '#557b75', '#c2784d'];
    let hash = 0; for (const char of label) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return colors[hash % colors.length];
  }
  return { normalizeQuery, requestQuery, sameFilters, createSession, opColor };
});
