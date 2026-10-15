'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPortal } = require('../server.cjs');
const { makeAdminConfig } = require('../lib/admin.cjs');

test('tool contracts require local login, work without company access and keep remote processing disabled', async t => {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'portal-tools-boundary-'));
  let upstreamCalls = 0;
  const server = createPortal({ root,
    config: { admin: makeAdminConfig('synthetic-tools-admin', 'synthetic-tools-password'), sourceBase: 'http://synthetic-source.invalid' },
    credentialStore: { async load() { return null; }, async save() { throw new Error('Unexpected credential write'); }, async remove() {} },
    source: { async login() { upstreamCalls++; throw new Error('Unexpected company login'); }, async read() { upstreamCalls++; throw new Error('Unexpected company read'); } }
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('portal-tools-boundary-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, options) => fetch(base + route, options);
  const status = await request('/local/status');
  assert.equal((await status.json()).modules.tools, true);
  for (const route of ['/local/tools', '/local/tools/v1/weld-export/contract']) {
    assert.equal((await request(route)).status, 401);
  }
  const login = await request('/local/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'synthetic-tools-admin', password: 'synthetic-tools-password' }) });
  assert.equal(login.status, 200);
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
  const manifestResponse = await request('/local/tools', { headers });
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.uploadsEnabled, false);
  assert.deepEqual(manifest.tools.map(tool => tool.id).sort(), ['measurement-compare', 'weld-export']);
  for (const tool of manifest.tools) {
    const contract = await request(`/local/tools/v1/${tool.id}/contract`, { headers });
    assert.equal(contract.status, 200);
    assert.equal((await contract.json()).remoteAdapter.enabled, false);
    const run = await request(`/local/tools/v1/${tool.id}/run`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(run.status, 501);
    assert.equal((await run.json()).code, 'tool_adapter_disabled');
    const page = await request(tool.entry);
    assert.equal(page.status, 200);
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self';/);
    assert.match(csp, /frame-ancestors 'none'/);
    const html = await page.text();
    assert.doesNotMatch(html, /<script\b[^>]*\bsrc=["']https?:/i);
    assert.doesNotMatch(html, /\son(?:click|change|input|submit|load)\s*=/i);
  }
  assert.equal((await request('/local/tools/v1/unknown/contract', { headers })).status, 404);
  assert.equal((await request('/local/tools/v1/weld-export/run', { headers })).status, 405);
  const crossSite = await request('/local/tools', { headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  assert.equal(upstreamCalls, 0);
});
