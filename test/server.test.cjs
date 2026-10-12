'use strict';
// Loopback-only fixtures. Administrator and upstream credentials are synthetic and distinct.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const { createPortal } = require('../server.cjs');
const { PortalError } = require('../lib/source.cjs');
const { makeAdminConfig } = require('../lib/admin.cjs');
const ADMIN_USER = 'mock-admin', ADMIN_PASSWORD = 'synthetic-local-test-password';
const SOURCE_USER = 'synthetic-company-user', SOURCE_PASSWORD = 'synthetic-company-test-password';
const ADMIN_CONFIG = makeAdminConfig(ADMIN_USER, ADMIN_PASSWORD);
const QUERY = '?start=2026-10-01&end=2026-10-12&page=1&size=20';
const CSV = '备件编号,备件名称,入库数量,库位,备注\nSYN-PIN,定位销,2,示例库位,仅预览';

async function fixture(t, options = {}) {
  const calls = { login: [], read: [] };
  let clock = Date.UTC(2026, 9, 12, 0, 0, 0);
  const source = {
    async login(username, password) {
      calls.login.push({ username, password });
      if (options.login) return options.login(username, password);
      return { account: username, token: 'synthetic-upstream-token' };
    },
    async read(module, query, session) {
      calls.read.push({ module, query, account: session.account, token: session.token, hasPassword: Object.hasOwn(session, 'password') });
      if (options.read) return options.read(module, query, session);
      return { columns: [{ key: 'id', label: '示例编号' }], rows: [{ id: 'SYNTHETIC-ROW' }], total: 1, module, complete: true, sourceTotal: 1, page: query.page, size: query.size };
    }
  };
  const server = createPortal({ config: { admin: { ...ADMIN_CONFIG }, sourceBase: 'http://synthetic-source.invalid' }, source, now: () => clock });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const port = server.address().port;
  function request(method, route, data, headers = {}) {
    return new Promise((resolve, reject) => {
      const payload = data === undefined ? null : JSON.stringify(data);
      const req = http.request({ hostname: '127.0.0.1', port, method, path: route, agent: false,
        headers: { ...(payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }), ...headers } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let body; try { body = JSON.parse(text); } catch (_) { body = null; }
          resolve({ status: res.statusCode, headers: res.headers, body, text }); });
      });
      req.on('error', reject); if (payload !== null) req.write(payload); req.end();
    });
  }
  async function login(username = ADMIN_USER, password = ADMIN_PASSWORD) {
    const response = await request('POST', '/local/login', { username, password });
    return { ...response, cookie: response.headers['set-cookie']?.[0]?.split(';')[0] };
  }
  const connect = (cookie, username = SOURCE_USER, password = SOURCE_PASSWORD) => request('POST', '/local/connect', { username, password }, { Cookie: cookie });
  async function connected() { const auth = await login(); assert.equal(auth.status, 200); assert.equal((await connect(auth.cookie)).status, 200); return auth; }
  return { request, login, connect, connected, calls, port, advance: value => { clock += value; } };
}

test('anonymous status is readable but data, company connect and preview require portal login', async t => {
  const app = await fixture(t), response = await app.request('GET', '/local/status');
  assert.equal(response.status, 200);
  assert.equal(response.body.authenticated, false); assert.equal(response.body.connected, false);
  assert.equal(response.body.account, null); assert.equal(response.body.sourceAccount, null); assert.equal(response.body.writeEnabled, false);
  for (const module of ['weld', 'alarm', 'spares']) assert.equal((await app.request('GET', `/local/data/${module}${QUERY}`)).status, 401);
  assert.equal((await app.request('POST', '/local/connect', { username: SOURCE_USER, password: SOURCE_PASSWORD })).status, 401);
  assert.equal((await app.request('POST', '/local/import-preview', { filename: 'test.csv', content: CSV })).status, 401);
  assert.equal(app.calls.login.length, 0); assert.equal(app.calls.read.length, 0);
});

test('local admin login sets protected cookie without invoking company authentication', async t => {
  const app = await fixture(t), response = await app.login();
  assert.equal(response.status, 200); assert.equal(response.body.authenticated, true);
  assert.equal(response.body.connected, false); assert.equal(response.body.account, ADMIN_USER);
  assert.equal(app.calls.login.length, 0); assert.equal(response.text.includes(ADMIN_PASSWORD), false);
  const cookie = response.headers['set-cookie'][0];
  assert.match(cookie, /^portal_session=[a-f0-9]{64};/); assert.match(cookie, /; HttpOnly(?:;|$)/);
  assert.match(cookie, /; SameSite=Strict(?:;|$)/); assert.match(cookie, /; Path=\/(?:;|$)/); assert.match(cookie, /; Max-Age=28800(?:;|$)/);
  const headers = { Cookie: response.cookie }, status = await app.request('GET', '/local/status', undefined, headers);
  assert.equal(status.body.authenticated, true); assert.equal(status.body.connected, false); assert.equal(status.body.sourceAccount, null);
  assert.equal((await app.request('GET', `/local/data/weld${QUERY}`, undefined, headers)).status, 428);
  assert.equal(app.calls.read.length, 0);
});

test('incorrect local admin password does not set cookie or call company source', async t => {
  const app = await fixture(t), result = await app.login(ADMIN_USER, 'synthetic-wrong-local-password');
  assert.equal(result.status, 401); assert.equal(result.cookie, undefined); assert.equal(app.calls.login.length, 0);
  assert.equal((await app.request('GET', '/local/status')).body.authenticated, false);
});

test('company connect passes only company credentials to mock and does not persist credentials', async t => {
  const writes = [];
  for (const method of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream']) t.mock.method(fs, method, () => { writes.push(method); throw new Error('Unexpected filesystem write'); });
  for (const method of ['writeFile', 'appendFile']) t.mock.method(fs.promises, method, async () => { writes.push(method); throw new Error('Unexpected filesystem write'); });
  const app = await fixture(t), auth = await app.login(); assert.equal(app.calls.login.length, 0);
  const enteredCompanyUser = `  ${SOURCE_USER}  `;
  const response = await app.connect(auth.cookie, enteredCompanyUser);
  assert.equal(response.status, 200); assert.equal(response.body.connected, true); assert.equal(response.body.sourceAccount, enteredCompanyUser);
  assert.deepEqual(app.calls.login, [{ username: enteredCompanyUser, password: SOURCE_PASSWORD }]); assert.deepEqual(writes, []);
  for (const secret of [ADMIN_PASSWORD, SOURCE_PASSWORD, 'synthetic-upstream-token']) assert.equal(response.text.includes(secret), false);
  const status = await app.request('GET', '/local/status', undefined, { Cookie: auth.cookie });
  assert.equal(status.body.authenticated, true); assert.equal(status.body.account, ADMIN_USER);
  assert.equal(status.body.sourceAccount, enteredCompanyUser); assert.equal(status.body.connected, true);
});

test('connected reads receive upstream session without password and cache exact successful query', async t => {
  const app = await fixture(t), auth = await app.connected(), headers = { Cookie: auth.cookie };
  const read = await app.request('GET', `/local/data/weld${QUERY}`, undefined, headers);
  assert.equal(read.status, 200); assert.deepEqual(read.body.rows, [{ id: 'SYNTHETIC-ROW' }]);
  assert.equal(app.calls.read[0].account, undefined); assert.equal(app.calls.read[0].token, 'synthetic-upstream-token'); assert.equal(app.calls.read[0].hasPassword, false);
  assert.equal(app.calls.read[0].query.start, '2026-10-01'); assert.equal(app.calls.read[0].query.page, 1); assert.equal(app.calls.read[0].query.size, 20);
  await app.request('GET', `/local/data/weld${QUERY}`, undefined, headers); assert.equal(app.calls.read.length, 1);
});

test('switching company connection isolates old read context and rejects stale results/cache', async t => {
  let releaseOldRead, markOldReadStarted, oldTokenAfterRelease;
  const oldReadGate = new Promise(resolve => { releaseOldRead = resolve; });
  const oldReadStarted = new Promise(resolve => { markOldReadStarted = resolve; });
  const oldToken = 'synthetic-token-old', newToken = 'synthetic-token-new';
  const app = await fixture(t, {
    login: async username => ({ account: username, token: username === SOURCE_USER ? oldToken : newToken }),
    read: async (module, query, context) => {
      if (context.token === oldToken) {
        markOldReadStarted();
        await oldReadGate;
        oldTokenAfterRelease = context.token;
        return { rows: [{ id: 'OLD-SOURCE-ROW' }], total: 1 };
      }
      return { rows: [{ id: 'NEW-SOURCE-ROW' }], total: 1 };
    }
  });
  t.after(() => releaseOldRead());
  const auth = await app.connected(), headers = { Cookie: auth.cookie };
  const pendingOld = app.request('GET', `/local/data/weld${QUERY}`, undefined, headers);
  pendingOld.catch(() => {});
  await oldReadStarted;
  const switched = await app.connect(auth.cookie, 'synthetic-second-company-user');
  assert.equal(switched.status, 200);
  assert.equal(switched.body.sourceAccount, 'synthetic-second-company-user');
  const fresh = await app.request('GET', `/local/data/weld${QUERY}`, undefined, headers);
  assert.equal(fresh.status, 200);
  assert.deepEqual(fresh.body.rows, [{ id: 'NEW-SOURCE-ROW' }]);
  releaseOldRead();
  const stale = await pendingOld;
  assert.equal(stale.status, 428);
  assert.equal(stale.text.includes('OLD-SOURCE-ROW'), false);
  assert.equal(oldTokenAfterRelease, oldToken);
  assert.deepEqual(app.calls.read.map(call => call.token), [oldToken, newToken]);
  const cachedFresh = await app.request('GET', `/local/data/weld${QUERY}`, undefined, headers);
  assert.equal(cachedFresh.status, 200);
  assert.deepEqual(cachedFresh.body.rows, [{ id: 'NEW-SOURCE-ROW' }]);
  assert.equal(app.calls.read.length, 2);
});

test('disconnect clears upstream token and cached data while preserving local admin login', async t => {
  const app = await fixture(t), auth = await app.connected(), headers = { Cookie: auth.cookie };
  assert.equal((await app.request('GET', `/local/data/spares${QUERY}`, undefined, headers)).status, 200);
  assert.equal((await app.request('POST', '/local/disconnect', {}, headers)).body.connected, false);
  const status = await app.request('GET', '/local/status', undefined, headers);
  assert.equal(status.body.authenticated, true); assert.equal(status.body.connected, false);
  assert.equal(status.body.account, ADMIN_USER); assert.equal(status.body.sourceAccount, null);
  assert.equal((await app.request('GET', `/local/data/spares${QUERY}`, undefined, headers)).status, 428); assert.equal(app.calls.read.length, 1);
});

test('logout expires portal cookie and rejects reuse regardless of company connection', async t => {
  const app = await fixture(t), auth = await app.connected(), headers = { Cookie: auth.cookie };
  const response = await app.request('POST', '/local/logout', {}, headers);
  assert.equal(response.status, 200); assert.match(response.headers['set-cookie'][0], /^portal_session=;/); assert.match(response.headers['set-cookie'][0], /Max-Age=0/);
  const status = await app.request('GET', '/local/status', undefined, headers);
  assert.equal(status.body.authenticated, false); assert.equal(status.body.connected, false);
  assert.equal((await app.request('GET', `/local/data/alarm${QUERY}`, undefined, headers)).status, 401); assert.equal((await app.connect(auth.cookie)).status, 401);
});

test('upstream read 401 becomes 428 and clears company connection but retains admin session', async t => {
  const app = await fixture(t, { read: async module => { if (module === 'alarm') throw new PortalError('Synthetic expired company session', 401); return { rows: [], columns: [], total: 0 }; } });
  const auth = await app.connected(), headers = { Cookie: auth.cookie };
  assert.equal((await app.request('GET', `/local/data/spares${QUERY}`, undefined, headers)).status, 200);
  assert.equal((await app.request('GET', `/local/data/alarm${QUERY}`, undefined, headers)).status, 428);
  const status = await app.request('GET', '/local/status', undefined, headers);
  assert.equal(status.body.authenticated, true); assert.equal(status.body.account, ADMIN_USER);
  assert.equal(status.body.connected, false); assert.equal(status.body.sourceAccount, null);
  assert.equal((await app.request('GET', `/local/data/spares${QUERY}`, undefined, headers)).status, 428); assert.equal(app.calls.read.length, 2);
});

test('wrong company credentials return 400 and keep portal administrator signed in', async t => {
  const app = await fixture(t, { login: async () => { throw new PortalError('Synthetic bad company credentials', 401); } });
  const auth = await app.login(); assert.equal((await app.connect(auth.cookie)).status, 400);
  const status = await app.request('GET', '/local/status', undefined, { Cookie: auth.cookie });
  assert.equal(status.body.authenticated, true); assert.equal(status.body.connected, false); assert.equal(status.body.account, ADMIN_USER);
});

test('source 403 preserves sessions; local session expires after eight hours', async t => {
  const app = await fixture(t, { read: async module => { if (module === 'alarm') throw new PortalError('Synthetic denied module', 403); return { rows: [], columns: [], total: 0 }; } });
  const auth = await app.connected(), headers = { Cookie: auth.cookie };
  assert.equal((await app.request('GET', `/local/data/alarm${QUERY}`, undefined, headers)).status, 403);
  const status = await app.request('GET', '/local/status', undefined, headers);
  assert.equal(status.body.authenticated, true); assert.equal(status.body.connected, true);
  assert.equal((await app.request('GET', `/local/data/spares${QUERY}`, undefined, headers)).status, 200);
  app.advance(8 * 60 * 60 * 1000 + 1);
  const expired = await app.request('GET', '/local/status', undefined, headers);
  assert.equal(expired.body.authenticated, false); assert.equal(expired.body.connected, false);
  assert.equal((await app.request('GET', `/local/data/weld${QUERY}`, undefined, headers)).status, 401);
});

test('Host, Origin and cross-site request defenses protect reads and company connect', async t => {
  const app = await fixture(t), auth = await app.connected();
  for (const headers of [{ Host: `attacker.invalid:${app.port}` }, { Origin: 'https://attacker.invalid' }, { Origin: `http://localhost:${app.port}` }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await app.request('GET', `/local/data/weld${QUERY}`, undefined, { Cookie: auth.cookie, ...headers })).status, 403);
  }
  assert.equal((await app.request('POST', '/local/connect', { username: SOURCE_USER, password: SOURCE_PASSWORD }, { Cookie: auth.cookie, Origin: 'https://attacker.invalid' })).status, 403);
  const same = await app.request('GET', '/local/status', undefined, { Cookie: auth.cookie, Origin: `http://127.0.0.1:${app.port}`, 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(same.status, 200); assert.equal(same.body.authenticated, true);
  assert.equal((await app.request('GET', '/local/status', undefined, { Host: `localhost:${app.port}` })).status, 200);
  assert.equal(app.calls.read.length, 0); assert.equal(app.calls.login.length, 1);
});

test('static routing cannot expose private config, admin hashes or source code', async t => {
  const app = await fixture(t);
  for (const route of ['/config.local.json', '/server.cjs', '/lib/admin.cjs', '/lib/source.cjs', '/%2e%2e%2fconfig.local.json', '/..%5cconfig.local.json']) {
    const response = await app.request('GET', route); assert.equal(response.status, 404, route); assert.equal(response.text.includes(ADMIN_CONFIG.passwordHash), false);
  }
  const response = await app.request('GET', '/local/status');
  assert.equal(response.headers['x-content-type-options'], 'nosniff'); assert.equal(response.headers['x-frame-options'], 'DENY'); assert.match(response.headers['content-security-policy'], /default-src 'self'/);
});

test('CSV preview requires local admin login but not company connectivity', async t => {
  const app = await fixture(t), auth = await app.login(), headers = { Cookie: auth.cookie };
  const response = await app.request('POST', '/local/import-preview', { filename: 'synthetic.csv', content: CSV }, headers);
  assert.equal(response.status, 200); assert.equal(response.body.previewOnly, true); assert.equal(response.body.valid, true); assert.equal(response.body.totalRows, 1);
  assert.equal(response.body.rows[0].values.quantity, 2); assert.equal(response.body.rows[0].category, '定位销'); assert.equal(app.calls.login.length, 0); assert.equal(app.calls.read.length, 0);
  const badFormat = await app.request('POST', '/local/import-preview', { filename: 'synthetic.xlsx', content: CSV }, headers);
  assert.equal(badFormat.body.valid, false); assert.ok(badFormat.body.errors.some(item => item.code === 'unsupported_file_type'));
  const formula = await app.request('POST', '/local/import-preview', { filename: 'synthetic.csv', content: CSV.replace('仅预览', '=1+1') }, headers);
  assert.equal(formula.body.valid, false); assert.ok(formula.body.errors.some(item => item.code === 'formula_cell'));
  assert.equal((await app.request('POST', '/local/import-preview', { filename: 'synthetic.csv', content: {} }, headers)).status, 400);
});
