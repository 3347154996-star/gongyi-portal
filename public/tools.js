'use strict';
(() => {
  const root = document.getElementById('toolsWorkbench');
  if (!root) return;
  let active = false, account = null, loaded = false, loading = false, generation = 0;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  function intro() { return '<div class="tools-intro"><div><p class="tools-eyebrow">工艺文件处理</p><h2>选择工具，导入文件即可开始</h2><p>两个工具在独立页面打开，便于一边核对报表，一边查看门户。</p></div><span class="tools-local-badge">文件在浏览器内处理</span></div>'; }
  function render(data) {
    const entries = (data.tools || []).filter(tool => typeof tool.entry === 'string' && /^\/tools\/[a-z0-9-]+\/index\.html$/.test(tool.entry));
    if (!entries.length) throw new Error('暂无可用工具，请联系管理员核对配置。');
    root.innerHTML = intro() + '<div class="tools-grid">' + entries.map((tool, index) => `<article class="tools-card"><div class="tools-card-top"><span class="tools-symbol" aria-hidden="true">${index === 0 ? '↗' : '⇄'}</span><span class="tools-status">可使用</span></div><h3>${esc(tool.title)}</h3><p class="tools-description">${esc(tool.description)}</p><dl class="tools-formats"><div><dt>导入</dt><dd>${(tool.inputs || []).map(esc).join('<br>')}</dd></div><div><dt>输出</dt><dd>${(tool.outputs || []).map(esc).join(' / ')}</dd></div></dl><a class="button primary tools-open" href="${esc(tool.entry)}" target="_blank" rel="noopener">打开工具 <span aria-hidden="true">↗</span><span class="tools-sr-only">（新标签页）</span></a></article>`).join('') + '</div><div class="tools-guidance"><h3>使用与保存</h3><p>导入的文件只在当前工具页面解析。关闭页面会清除未导出的结果，请先保存需要保留的文件。</p><p>结果需结合原始报表与设备配置核对。自动同步、云端归档等能力尚未接入，当前不会自动上传报告。</p></div>';
  }
  async function load() {
    if (loading || !active) return;
    loading = true; const epoch = ++generation;
    root.innerHTML = intro() + '<p class="tools-message" role="status">正在读取工具列表…</p>';
    try {
      const response = await fetch('/local/tools', { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || '无法读取工具列表。');
      if (epoch !== generation || !active) return;
      render(data); loaded = true;
    } catch (error) {
      if (epoch !== generation || !active) return;
      root.innerHTML = intro() + `<div class="tools-message error" role="alert">${esc(error.message)} <button type="button" class="button" data-tools-retry>重新读取</button></div>`;
    } finally { if (epoch === generation) loading = false; }
  }
  root.addEventListener('click', event => { if (event.target.closest('[data-tools-retry]')) load(); });
  window.PortalTools = Object.freeze({ setContext(status, isActive) {
    const nextAccount = status?.authenticated ? status.account : null;
    if (account !== nextAccount) { generation++; loaded = false; loading = false; root.innerHTML = ''; account = nextAccount; }
    active = Boolean(isActive && status?.authenticated); root.hidden = !active;
    if (!active && loading) { generation++; loading = false; }
    if (active && !loaded) load();
  } });
})();
