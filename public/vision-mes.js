(() => {
  'use strict';

  const host = document.getElementById('visionWorkbench');
  if (!host) return;
  const root = document.createElement('section');
  root.id = 'mesVisionWorkbench';
  root.className = 'mes-vision vis-panel';
  root.hidden = true;
  root.setAttribute('aria-labelledby', 'mesVisionTitle');
  root.innerHTML = `
    <div class="mes-vision-heading">
      <div><p class="mes-vision-kicker">公司系统 · 历史不合格参数</p><h2 id="mesVisionTitle">查询历史不合格参数</h2><p>查询不合格处理记录中的测点；同一工件后续复测可能已合格。</p></div>
      <span class="mes-vision-label">历史记录</span>
    </div>
    <form id="mesVisionForm" class="mes-vision-query" aria-label="公司系统工件尺寸查询">
      <label class="field mes-vision-barcode"><span>工件码 / 零件 SN</span><input id="mesVisionBarcode" type="text" required maxlength="150" autocomplete="off" spellcheck="false" placeholder="扫码后按回车，或输入工件码"></label>
      <button id="mesVisionSubmit" class="button primary" type="submit">查询历史参数</button>
      <button id="mesVisionClear" class="button" type="button">清空</button>
    </form>
    <div id="mesVisionProcessField" class="mes-vision-process" hidden><label class="field"><span>检测工序</span><select id="mesVisionProcess" aria-label="选择检测工序"></select></label><p id="mesVisionProcessHint"></p></div>
    <p id="mesVisionMessage" class="mes-vision-message" role="status" aria-live="polite">输入工件码后，从公司系统读取该工件的检测参数。</p>
    <p id="mesVisionDraft" class="mes-vision-draft" hidden>工件码已修改，按回车或点击“查询历史参数”后更新结果。</p>
    <section id="mesVisionResult" aria-label="当前工件尺寸结果" hidden>
      <div class="mes-vision-result-heading"><div><span>当前工件</span><strong id="mesVisionResultBarcode"></strong></div><div id="mesVisionCounts" class="mes-vision-counts" aria-label="测点数量"></div></div>
      <dl id="mesVisionMeta" class="mes-vision-meta"></dl>
      <div class="mes-vision-table-heading"><div><h3>测点明细</h3><p id="mesVisionTableCount"></p></div><label class="mes-vision-ng-filter"><input id="mesVisionOnlyNG" type="checkbox">只看 NG</label></div>
      <p id="mesVisionEmpty" class="mes-vision-empty" hidden></p>
      <div id="mesVisionTableWrap" class="mes-vision-table-wrap" tabindex="0" aria-label="测点明细，可横向滚动"><table><thead><tr id="mesVisionColumns"></tr></thead><tbody id="mesVisionRows"></tbody></table></div>
      <ul id="mesVisionWarnings" class="mes-vision-warnings" hidden></ul>
    </section>
    <p class="mes-vision-scope">这里是不合格处理记录，不代表该工件最新检测结果，也不参与合格率统计。最新与复测结果请以上方“检测记录”为准。</p>`;
  host.prepend(root);

  const $ = id => document.getElementById(id);
  const state = { status: null, account: null, active: false, epoch: 0, request: null, barcode: '', processes: [], processId: '', result: null };
  const text = value => value === null || value === undefined || value === '' ? '未提供' : typeof value === 'number' ? Number.isFinite(value) ? String(value) : '未提供' : typeof value === 'string' ? value : '未提供';
  const measuredValue = (item, key) => typeof item[key] === 'number' && Number.isFinite(item[key]) ? String(item[key]) : typeof item[key + 'Raw'] === 'string' && item[key + 'Raw'].trim() ? item[key + 'Raw'] : text(item[key]);
  const resultKind = value => value === 'OK' || value === 'NG' ? value : 'unknown';
  const countText = value => value.toLocaleString('zh-CN');
  const element = (tag, value, className) => {
    const node = document.createElement(tag);
    if (value !== undefined) node.textContent = String(value);
    if (className) node.className = className;
    return node;
  };
  function message(value, error = false) {
    $('mesVisionMessage').textContent = value;
    $('mesVisionMessage').className = 'mes-vision-message' + (error ? ' error' : '');
    $('mesVisionMessage').setAttribute('role', error ? 'alert' : 'status');
  }
  function cancel() {
    const request = state.request;
    state.request = null;
    if (request) { clearTimeout(request.timeout); request.controller.abort(); }
  }
  function current(request) {
    return state.request === request && request.epoch === state.epoch && state.active && state.status?.authenticated;
  }
  function controls() {
    const busy = Boolean(state.request);
    root.setAttribute('aria-busy', String(busy));
    $('mesVisionSubmit').disabled = !state.active || busy;
    $('mesVisionSubmit').textContent = busy ? '正在查询…' : '查询历史参数';
    $('mesVisionBarcode').disabled = !state.active;
    $('mesVisionClear').disabled = !state.active;
    $('mesVisionProcess').disabled = !state.active || state.processes.length < 2;
    $('mesVisionOnlyNG').disabled = !state.active || !state.result;
    $('mesVisionDraft').hidden = !state.barcode || $('mesVisionBarcode').value.trim() === state.barcode;
  }
  function start() {
    cancel();
    const request = { controller: new AbortController(), epoch: state.epoch, timedOut: false };
    request.timeout = setTimeout(() => { request.timedOut = true; request.controller.abort(); }, 45000);
    state.request = request;
    controls();
    return request;
  }
  function clearResult() {
    state.result = null;
    $('mesVisionResult').hidden = true;
    for (const id of ['mesVisionMeta', 'mesVisionCounts', 'mesVisionRows', 'mesVisionWarnings']) $(id).replaceChildren();
    $('mesVisionResultBarcode').textContent = '';
    $('mesVisionTableCount').textContent = '';
    $('mesVisionOnlyNG').checked = false;
    $('mesVisionEmpty').textContent = '';
    $('mesVisionWarnings').hidden = true;
  }
  function reset() {
    cancel(); state.epoch++;
    state.barcode = ''; state.processId = ''; state.processes = [];
    $('mesVisionBarcode').value = '';
    $('mesVisionProcess').replaceChildren();
    $('mesVisionProcessField').hidden = true;
    $('mesVisionProcessHint').textContent = '';
    clearResult();
    message('输入工件码后，从公司系统读取该工件的检测参数。');
    controls();
  }
  async function api(path, request) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: request.controller.signal });
    if (!current(request)) return null;
    if (response.status === 401) {
      reset(); state.active = false; root.hidden = true; controls();
      document.dispatchEvent(new CustomEvent('portal:session-expired'));
      return null;
    }
    let body;
    try { body = await response.json(); } catch (_) { throw new Error('公司尺寸查询返回内容无法读取，请稍后重试。'); }
    if (!current(request)) return null;
    if (!response.ok) {
      throw new Error(typeof body?.message === 'string' ? body.message.slice(0, 350) : '公司尺寸数据暂时无法读取，请稍后重试。');
    }
    return body;
  }
  function validateProcesses(body, barcode) {
    if (!body || body.barcode !== barcode || !Array.isArray(body.processes)) throw new Error('工件工序数据无法核对，请重新查询。');
    const ids = new Set();
    return body.processes.map(process => {
      if (!process || !['string', 'number'].includes(typeof process.id) || !String(process.id).trim() || ids.has(String(process.id))) throw new Error('公司系统返回的工序信息不完整，请重新查询。');
      const id = String(process.id); ids.add(id);
      return { ...process, id };
    });
  }
  function renderProcesses() {
    const select = $('mesVisionProcess'); select.replaceChildren();
    if (state.processes.length > 1) { const option = element('option', '请选择要查看的检测工序'); option.value = ''; select.append(option); }
    for (const process of state.processes) {
      const label = [process.name || process.id, process.lineName, process.deviceName].filter(Boolean).join(' · ');
      const option = element('option', label); option.value = process.id; select.append(option);
    }
    select.value = state.processId;
    $('mesVisionProcessField').hidden = !state.processes.length;
    $('mesVisionProcessHint').textContent = state.processes.length > 1 ? '该工件有多个工序，选择后查看对应测点。' : '已选择该工件返回的唯一工序。';
    controls();
  }
  function renderRows() {
    if (!state.result) return;
    const all = state.result.measurements;
    const onlyNG = $('mesVisionOnlyNG').checked;
    const rows = onlyNG ? all.filter(item => item.result === 'NG') : all;
    const hasRework = all.some(item => item.reworkActual !== null && item.reworkActual !== undefined || typeof item.reworkActualRaw === 'string' && item.reworkActualRaw.trim());
    const columns = $('mesVisionColumns'); columns.replaceChildren();
    for (const name of ['测点名称', '来源实测值', '下限', '上限', ...(hasRework ? ['返工参数'] : []), '来源判定']) { const column = element('th', name); column.setAttribute('scope', 'col'); columns.append(column); }
    const body = $('mesVisionRows'); body.replaceChildren();
    for (const item of rows) {
      const kind = resultKind(item.result);
      const row = element('tr', undefined, kind === 'NG' ? 'mes-vision-row-ng' : kind === 'unknown' ? 'mes-vision-row-unknown' : '');
      row.append(element('th', text(item.name)), element('td', measuredValue(item, 'actual'), 'mes-vision-actual'), element('td', measuredValue(item, 'lowerLimit')), element('td', measuredValue(item, 'upperLimit')));
      row.firstElementChild.setAttribute('scope', 'row');
      if (hasRework) row.append(element('td', measuredValue(item, 'reworkActual')));
      const cell = element('td');
      cell.append(element('span', kind === 'unknown' ? '未判定' : kind, 'vis-result ' + kind.toLowerCase()));
      if (kind === 'unknown' && typeof item.resultRaw === 'string' && item.resultRaw) cell.append(element('small', item.resultRaw, 'mes-vision-raw-result'));
      const original = resultKind(item.originResult) !== 'unknown' ? item.originResult : typeof item.originResultRaw === 'string' ? item.originResultRaw : '';
      if (original && original !== item.result && original !== item.resultRaw) cell.append(element('small', '原始判定：' + original, 'mes-vision-raw-result'));
      if (item.isRework === true) cell.append(element('small', '有返工标记', 'mes-vision-raw-result'));
      row.append(cell); body.append(row);
    }
    $('mesVisionTableCount').textContent = onlyNG ? '显示 ' + countText(rows.length) + ' 项 NG / 共 ' + countText(all.length) + ' 项测点' : '共 ' + countText(all.length) + ' 项测点 · 实测值、范围与结论按公司系统返回显示';
    $('mesVisionTableWrap').hidden = rows.length === 0;
    $('mesVisionEmpty').hidden = rows.length !== 0;
    $('mesVisionEmpty').textContent = all.length ? '本次返回的测点中没有 NG。' : '该工序未返回测点数据，请核对工件或选择其他工序。';
  }
  function renderResult() {
    const result = state.result;
    $('mesVisionResult').hidden = false;
    $('mesVisionResultBarcode').textContent = state.barcode;
    const counts = { OK: 0, NG: 0, unknown: 0 };
    for (const item of result.measurements) counts[resultKind(item.result)]++;
    const badges = $('mesVisionCounts'); badges.replaceChildren();
    for (const [label, count, tone] of [['测点', result.measurements.length, 'total'], ['NG', counts.NG, 'ng'], ['OK', counts.OK, 'ok'], ['未判定', counts.unknown, 'unknown']]) {
      if (tone === 'unknown' && !count) continue;
      const badge = element('span', undefined, 'mes-vision-count ' + tone);
      badge.append(element('strong', countText(count)), element('span', label)); badges.append(badge);
    }
    const process = state.processes.find(item => item.id === state.processId) || {};
    const originalTime = value => value ? (window.PortalWorkbench?.deviceStamp?.(value) || String(value).replace('T', ' ')) : '未提供';
    const queryTime = value => value ? (window.PortalWorkbench?.sourceStamp?.(value) || originalTime(value)) : '未提供';
    const metadata = [['工序', result.processName || process.name], ['线体', result.lineName || process.lineName], ['设备', result.deviceName || process.deviceName], ['物料', result.partName], ['检测时间', originalTime(result.measuredAt)], ['查询时间', queryTime(result.fetchedAt)]];
    if (result.sourceRecordedAt) metadata.push(['来源记录时间', originalTime(result.sourceRecordedAt)]);
    const meta = $('mesVisionMeta'); meta.replaceChildren();
    for (const [label, value] of metadata) { const item = element('div'); item.append(element('dt', label), element('dd', text(value))); meta.append(item); }
    const warnings = $('mesVisionWarnings'); warnings.replaceChildren();
    for (const warning of Array.isArray(result.warnings) ? result.warnings : []) if (typeof warning === 'string') warnings.append(element('li', warning));
    warnings.hidden = !warnings.children.length;
    renderRows(); controls();
  }
  async function readDetails(request, processId) {
    const query = new URLSearchParams({ barcode: state.barcode, processId });
    const barcode = state.barcode;
    const body = await api('/local/vision/mes/lookup?' + query, request);
    if (!current(request)) return;
    if (!body || body.barcode !== barcode || String(body.processId) !== processId || !Array.isArray(body.measurements) || body.measurements.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error('尺寸数据与当前工件或工序不一致，请重新查询。');
    state.result = body;
    renderResult();
    message(body.measurements.length ? '已读取该工件的历史不合格参数；这不是最新检测结论。' : '该工序暂未返回历史不合格参数。');
  }
  function finish(request, error) {
    clearTimeout(request.timeout);
    if (!current(request)) return;
    if (error && (error.name !== 'AbortError' || request.timedOut)) message(request.timedOut ? '公司尺寸查询超时，请稍后重新查询。' : error.message || '公司尺寸查询失败，请重试。', true);
    state.request = null; controls();
  }
  async function queryBarcode(event) {
    event?.preventDefault();
    if (!state.active || !state.status?.authenticated) return;
    const barcode = $('mesVisionBarcode').value.trim();
    if (!barcode || barcode.length > 150 || /[\x00-\x1f\x7f]/.test(barcode)) { message('请输入有效的工件码，最多 150 个字符。', true); return; }
    cancel(); state.barcode = barcode; state.processes = []; state.processId = '';
    clearResult(); renderProcesses();
    const request = start(); message('正在查询该工件的检测工序…');
    try {
      const body = await api('/local/vision/mes/processes?' + new URLSearchParams({ barcode }), request);
      if (!current(request)) return;
      state.processes = validateProcesses(body, barcode);
      state.processId = state.processes.length === 1 ? state.processes[0].id : '';
      renderProcesses();
      if (state.processes.length === 1) { message('正在读取该工件的测点数据…'); await readDetails(request, state.processId); }
      else message(state.processes.length ? '已找到多个工序，请选择要查看的检测工序。' : '公司系统未返回该工件的检测工序，请核对工件码。');
      finish(request);
    } catch (error) { finish(request, error); }
  }
  async function chooseProcess() {
    if (!state.active || !state.status?.authenticated) return;
    const id = $('mesVisionProcess').value;
    cancel(); clearResult(); state.processId = id;
    if (!state.processes.some(process => process.id === id)) { message('请选择要查看的检测工序。'); controls(); return; }
    const request = start(); message('正在读取所选工序的测点数据…');
    try { await readDetails(request, id); finish(request); } catch (error) { finish(request, error); }
  }
  function setContext(status, selected) {
    const account = status?.authenticated ? status.account : null;
    const active = Boolean(account && selected);
    if (account !== state.account || !status?.authenticated) reset();
    if (state.active && !active) { cancel(); state.epoch++; if (!state.result && state.barcode) message('查询已暂停，请重新查询。'); }
    state.status = status; state.account = account; state.active = active;
    root.hidden = !active; controls();
  }
  $('mesVisionForm').addEventListener('submit', queryBarcode);
  $('mesVisionProcess').addEventListener('change', chooseProcess);
  $('mesVisionBarcode').addEventListener('input', controls);
  $('mesVisionOnlyNG').addEventListener('change', renderRows);
  $('mesVisionClear').addEventListener('click', () => { if (!state.active) return; reset(); $('mesVisionBarcode').focus(); });
  window.addEventListener('pagehide', () => { cancel(); state.epoch++; });
  window.MesVisionWorkbench = { setContext };
})();
