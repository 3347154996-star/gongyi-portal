'use strict';

// Loopback-only integration tests. Every source is a mock; no company API is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const { createPortal } = require('../server.cjs');
const { PortalError } = require('../lib/source.cjs');

const SYNTHETIC_ACCOUNT = 'synthetic-test-user';
const SYNTHETIC_PASSWORD = 'synthetic-test-password-only';
const DATA_QUERY = '?start=2026-10-01&end=2026-10-12&page=1&size=20';

async function fixture(t, options = {}) {
  const calls = { login: [], read: [] };
  let clock = Date.UTC(2026, 9, 12, 0, 0, 0);
  const source = {
    async login(username, password) {
      calls.login.push({ username, password });
      if (options.login) return options.login(username, password);
      return { account: username, token: 'synthetic-token-kept-in-memory' };
    },
    async read(module, query, session) {
      calls.read.push({ module, query, account: session.account, token: session.token,
        hasPassword: Object.hasOwn(session, 'password') });
      if (options.read) return options.read(module, query, session);
      return { columns: [{ key: 'id', label: '示例编号' }], rows: [{ id: 'SYNTHETIC-ROW' }],
        total: 1, module, complete: true, sourceTotal: 1, page: query.page, size: query.size };
    }
  };
  const server = createPortal({ config: { sourceBase: 'http://synthetic-source.invalid' }, source, now: () => clock });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const port = server.address().port;
  function request(method, route, data, headers = {}) {
    return new Promise((resolve, reject) => {
      const payload = data === undefined ? null : JSON.stringify(data);
      const req = http.request({ hostname: '127.0.0.1', port, method, path: route, agent: false,
        headers: { ...(payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }), ...headers } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body; try { body = JSON.parse(text); } catch (_) { body = null; }
          resolve({ status: res.statusCode, headers: res.headers, body, text });
        });
      });
      req.on('error', reject);
      if (payload !== null) req.write(payload);
      req.end();
    });
  }
  async function login(username = SYNTHETIC_ACCOUNT, password = SYNTHETIC_PASSWORD) {
    const response = await request('POST', '/local/login', { username, password });
    const cookie = response.headers['set-cookie']?.[0]?.split(';')[0];
    return { ...response, cookie };
  }
  return { request, login, calls, port, advance: milliseconds => { clock += milliseconds; } };
}

test('anonymous status is readable but protected data/import routes reject before source calls', async t => {
  const app = await fixture(t);
  const status = await app.request('GET', '/local/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.connected, false);
  assert.equal(status.body.account, null);
  assert.equal(status.body.writeEnabled, false);
  for (const module of ['weld', 'alarm', 'spares']) {
    const response = await app.request('GET', `/local/data/${module}${DATA_QUERY}`);
    assert.equal(response.status, 401);
  }
  assert.equal((await app.request('POST', '/local/import-preview', { filename: 'test.csv', content: 'code' })).status, 401);
  assert.equal(app.calls.read.length, 0);
});

test('credentials pass unchanged to mock login, never reach responses or filesystem write APIs', async t => {
  const writes = [];
  for (const method of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream']) {
    t.mock.method(fs, method, () => { writes.push(method); throw new Error('Unexpected filesystem write during authentication'); });
  }
  for (const method of ['writeFile', 'appendFile']) {
    t.mock.method(fs.promises, method, async () => { writes.push(`promises.${method}`); throw new Error('Unexpected filesystem write during authentication'); });
  }
  const app = await fixture(t);
  const response = await app.login(`  ${SYNTHETIC_ACCOUNT}  `);
  assert.equal(response.status, 200);
  assert.deepEqual(app.calls.login, [{ username: SYNTHETIC_ACCOUNT, password: SYNTHETIC_PASSWORD }]);
  assert.equal(response.body.account, SYNTHETIC_ACCOUNT);
  assert.equal(response.text.includes(SYNTHETIC_PASSWORD), false);
  assert.equal(response.text.includes('synthetic-token-kept-in-memory'), false);
  assert.deepEqual(writes, []);
  const cookie = response.headers['set-cookie'][0];
  assert.match(cookie, /^portal_session=[a-f0-9]{64};/);
  assert.match(cookie, /; HttpOnly(?:;|$)/);
  assert.match(cookie, /; SameSite=Strict(?:;|$)/);
  assert.match(cookie, /; Path=\/(?:;|$)/);
  assert.match(cookie, /; Max-Age=28800(?:;|$)/);
});

test('authenticated status and source reads use an in-memory session and cache exact queries', async t => {
  const app = await fixture(t);
  const auth = await app.login();
  const headers = { Cookie: auth.cookie };
  const status = await app.request('GET', '/local/status', undefined, headers);
  assert.equal(status.body.connected, true);
  assert.equal(status.body.account, SYNTHETIC_ACCOUNT);
  assert.equal(status.body.writeEnabled, false);
  const read = await app.request('GET', `/local/data/weld${DATA_QUERY}`, undefined, headers);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.rows, [{ id: 'SYNTHETIC-ROW' }]);
  assert.equal(app.calls.read[0].account, SYNTHETIC_ACCOUNT);
  assert.equal(app.calls.read[0].token, 'synthetic-token-kept-in-memory');
  assert.equal(app.calls.read[0].hasPassword, false);
  assert.equal(app.calls.read[0].query.start, '2026-10-01');
  assert.equal(app.calls.read[0].query.page, 1);
  assert.equal(app.calls.read[0].query.size, 20);
  await app.request('GET', `/local/data/weld${DATA_QUERY}`, undefined, headers);
  assert.equal(app.calls.read.length, 1);
});

test('logout expires the cookie and rejects reuse of the former session', async t => {
  const app = await fixture(t);
  const auth = await app.login(), headers = { Cookie: auth.cookie };
  const logout = await app.request('POST', '/local/logout', {}, headers);
  assert.equal(logout.status, 200);
  assert.equal(logout.body.connected, false);
  assert.match(logout.headers['set-cookie'][0], /^portal_session=;/);
  assert.match(logout.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal((await app.request('GET', `/local/data/alarm${DATA_QUERY}`, undefined, headers)).status, 401);
  assert.equal((await app.request('GET', '/local/status', undefined, headers)).body.connected, false);
});

test('upstream 401 invalidates session and does not cache failed reads', async t => {
  const app = await fixture(t, { read: async () => { throw new PortalError('Synthetic session expired', 401); } });
  const auth = await app.login(), headers = { Cookie: auth.cookie };
  assert.equal((await app.request('GET', `/local/data/alarm${DATA_QUERY}`, undefined, headers)).status, 401);
  assert.equal((await app.request('GET', '/local/status', undefined, headers)).body.connected, false);
  assert.equal((await app.request('GET', `/local/data/spares${DATA_QUERY}`, undefined, headers)).status, 401);
  assert.equal(app.calls.read.length, 1);
});

test('local session expires after eight hours without needing an upstream error', async t => {
  const app = await fixture(t), auth = await app.login(), headers = { Cookie: auth.cookie };
  app.advance(8 * 60 * 60 * 1000 + 1);
  assert.equal((await app.request('GET', '/local/status', undefined, headers)).body.connected, false);
  assert.equal((await app.request('GET', `/local/data/weld${DATA_QUERY}`, undefined, headers)).status, 401);
  assert.equal(app.calls.read.length, 0);
});

test('upstream 403 preserves login and allows reads of other authorized modules', async t => {
  const app = await fixture(t, { read: async module => {
    if (module === 'alarm') throw new PortalError('Synthetic module permission denied', 403);
    return { rows: [], columns: [], total: 0, module };
  } });
  const auth = await app.login(), headers = { Cookie: auth.cookie };
  assert.equal((await app.request('GET', `/local/data/alarm${DATA_QUERY}`, undefined, headers)).status, 403);
  assert.equal((await app.request('GET', '/local/status', undefined, headers)).body.connected, true);
  assert.equal((await app.request('GET', `/local/data/spares${DATA_QUERY}`, undefined, headers)).status, 200);
  assert.equal(app.calls.read.length, 2);
});

test('Host, mismatched Origin and cross-site fetches reject even with a valid session', async t => {
  const app = await fixture(t), auth = await app.login();
  for (const headers of [
    { Host: `attacker.invalid:${app.port}` },
    { Origin: 'https://attacker.invalid' },
    { Origin: `http://localhost:${app.port}` },
    { 'Sec-Fetch-Site': 'cross-site' }
  ]) {
    const response = await app.request('GET', `/local/data/weld${DATA_QUERY}`, undefined, { Cookie: auth.cookie, ...headers });
    assert.equal(response.status, 403);
  }
  const same = await app.request('GET', '/local/status', undefined, { Cookie: auth.cookie, Origin: `http://127.0.0.1:${app.port}`, 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(same.status, 200);
  assert.equal(same.body.connected, true);
  assert.equal((await app.request('GET', '/local/status', undefined, { Host: `localhost:${app.port}` })).status, 200);
  assert.equal(app.calls.read.length, 0);
});

test('static routing cannot expose private configuration, server code or parent paths', async t => {
  const app = await fixture(t);
  for (const route of ['/config.local.json', '/server.cjs', '/lib/source.cjs', '/%2e%2e%2fconfig.local.json', '/..%5cconfig.local.json', '/assets/../../config.local.json']) {
    const response = await app.request('GET', route);
    assert.equal(response.status, 404, route);
    assert.equal(response.headers['content-type'].startsWith('application/json'), true);
  }
  const status = await app.request('GET', '/local/status');
  assert.equal(status.headers['x-content-type-options'], 'nosniff');
  assert.equal(status.headers['x-frame-options'], 'DENY');
  assert.match(status.headers['content-security-policy'], /default-src 'self'/);
});

test('import-preview JSON contract passes CSV content and filename without source writes', async t => {
  const app = await fixture(t), auth = await app.login(), headers = { Cookie: auth.cookie };
  const csv = '备件编号,备件名称,入库数量,库位,备注\nSYN-PIN,定位销,2,示例库位,仅预览';
  const response = await app.request('POST', '/local/import-preview', { filename: 'synthetic.csv', content: csv }, headers);
  assert.equal(response.status, 200);
  assert.equal(response.body.previewOnly, true);
  assert.equal(response.body.valid, true);
  assert.equal(response.body.totalRows, 1);
  assert.equal(response.body.rows[0].values.quantity, 2);
  assert.equal(response.body.rows[0].category, '定位销');
  assert.equal(app.calls.read.length, 0);
  const badFormat = await app.request('POST', '/local/import-preview', { filename: 'synthetic.xlsx', content: csv }, headers);
  assert.equal(badFormat.body.valid, false);
  assert.ok(badFormat.body.errors.some(item => item.code === 'unsupported_file_type'));
  const formula = await app.request('POST', '/local/import-preview', { filename: 'synthetic.csv', content: csv.replace('仅预览', '=1+1') }, headers);
  assert.equal(formula.body.valid, false);
  assert.ok(formula.body.errors.some(item => item.code === 'formula_cell'));
  const malformed = await app.request('POST', '/local/import-preview', { filename: 'synthetic.csv', content: {} }, headers);
  assert.equal(malformed.status, 400);
});
