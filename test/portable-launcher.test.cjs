'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { location, listenSettings, request, startPortal, stopPortal, statusPortal, runController, openBrowser } = require('../lib/portable-launcher.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const close = server => new Promise(resolve => server.close(resolve));
async function freePort() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await close(server); return port; }
async function workspace(t) {
  const parent = await fs.realpath(os.tmpdir());
  const base = await fs.mkdtemp(path.join(parent, 'portal-launcher-test-'));
  const root = path.join(base, '解压 空格 & (测试)'); await fs.mkdir(path.join(root, 'lib'), { recursive: true });
  const config = { port: await freePort(), listenHost: '127.0.0.1', syntheticSecret: 'DO-NOT-LOG-SYNTHETIC' };
  await fs.writeFile(path.join(root, 'config.local.json'), JSON.stringify(config));
  await fs.copyFile(path.resolve(__dirname, '../lib/portable-launcher.cjs'), path.join(root, 'lib', 'portable-launcher.cjs'));
  await fs.copyFile(path.resolve(__dirname, '../launch-portal.cjs'), path.join(root, 'launch-portal.cjs'));
  await fs.writeFile(path.join(root, 'server.cjs'), `
    const fs = require('node:fs'); const path = require('node:path');
    exports.loadConfig = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'config.local.json'), 'utf8'));
    exports.createPortal = () => {
      fs.appendFileSync(path.join(__dirname, 'created.txt'), 'created\\n');
      const server = require('node:http').createServer((req, res) => res.end('synthetic portal'));
      server.on('close', () => setTimeout(() => fs.writeFileSync(path.join(__dirname, 'cleanup.txt'), 'finished'), 120));
      return server;
    };`);
  t.after(async () => {
    await stopPortal({ root, timeoutMs: 5000 }).catch(() => {});
    await delay(100);
    const resolved = await fs.realpath(base); assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('portal-launcher-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { root, config, info: await location(root) };
}
async function cli(root, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'launch-portal.cjs'), ...args], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    child.on('error', reject); child.on('close', code => resolve({ code, output }));
  });
}
test('listener policy matches loopback and HTTPS/publicOrigins requirement', () => {
  assert.deepEqual(listenSettings({}), { host: '127.0.0.1', port: 4173, url: 'http://127.0.0.1:4173/' });
  assert.equal(listenSettings({ tls: { certFile: 'cert' } }).url, 'http://127.0.0.1:4173/');
  for (const config of [{ listenHost: '0.0.0.0' }, { listenHost: '::1' }, { listenHost: '0.0.0.0', tls: { certFile: 'cert', keyFile: 'key' } }, { publicOrigins: ['https://u:p@example.invalid'] }]) assert.throws(() => listenSettings(config), { code: 'PORTAL_NETWORK' });
  assert.equal(listenSettings({ listenHost: '0.0.0.0', tls: { certFile: 'cert', keyFile: 'key' }, publicOrigins: ['https://portal.example.invalid:8443'] }).url, 'https://portal.example.invalid:8443/');
});
test('CLI starts in a Unicode directory, reuses service, and confirms drained stop', async t => {
  const { root, config, info } = await workspace(t);
  const first = await cli(root, ['start', '--no-browser']); assert.equal(first.code, 0, first.output); assert.match(first.output, new RegExp('http://127\\.0\\.0\\.1:' + config.port));
  assert.equal(await (await fetch(`http://127.0.0.1:${config.port}/`)).text(), 'synthetic portal');
  const again = await cli(root, ['start', '--no-browser']); assert.equal(again.code, 0, again.output); assert.match(again.output, /已在运行/);
  assert.equal((await fs.readFile(path.join(root, 'created.txt'), 'utf8')).trim(), 'created');
  const stopped = await cli(root, ['stop']); assert.equal(stopped.code, 0, stopped.output); assert.match(stopped.output, /已停止/);
  assert.equal(await fs.readFile(path.join(root, 'cleanup.txt'), 'utf8'), 'finished');
  assert.deepEqual(await statusPortal({ root }), { state: 'absent' });
  assert.equal((await cli(root, ['stop'])).code, 0);
  assert.ok(!(await fs.readFile(info.log, 'utf8')).includes(config.syntheticSecret));
});
test('simultaneous starts create only one portal and all reuse its authenticated endpoint', async t => {
  const { root } = await workspace(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => startPortal({ root, browser: false, timeoutMs: 8000 })));
  assert.ok(results.every(value => value.state === 'ready'));
  assert.equal((await fs.readFile(path.join(root, 'created.txt'), 'utf8')).trim(), 'created');
  assert.equal((await stopPortal({ root, timeoutMs: 5000 })).state, 'stopped');
});
test('worker naturally exits zero after stop and removes nonce only after its background work finishes', async t => {
  const { root, info } = await workspace(t); const worker = cli(root, ['--worker']);
  const deadline = Date.now() + 5000;
  while ((await statusPortal({ root }).catch(() => ({ state: 'starting' }))).state !== 'ready') { assert.ok(Date.now() < deadline); await delay(25); }
  assert.equal((await stopPortal({ root, timeoutMs: 5000 })).state, 'stopped');
  const result = await worker; assert.equal(result.code, 0, result.output);
  assert.equal(await fs.readFile(path.join(root, 'cleanup.txt'), 'utf8'), 'finished');
  await assert.rejects(fs.stat(info.controlFile), { code: 'ENOENT' });
  assert.deepEqual(await statusPortal({ root }), { state: 'absent' });
});
test('worker naturally exits nonzero and releases its pipe after a listen error', async t => {
  const { root, config, info } = await workspace(t); const foreign = net.createServer();
  await new Promise(resolve => foreign.listen(config.port, '127.0.0.1', resolve)); t.after(() => close(foreign));
  const result = await cli(root, ['--worker']); assert.equal(result.code, 1);
  assert.equal(await fs.readFile(path.join(root, 'cleanup.txt'), 'utf8'), 'finished');
  await assert.rejects(fs.stat(info.controlFile), { code: 'ENOENT' });
  assert.deepEqual(await statusPortal({ root }), { state: 'absent' });
});
test('stale state is replaced without using a PID, and stopped portal can restart', async t => {
  const { root, info } = await workspace(t); await fs.mkdir(info.runtime, { recursive: true });
  await fs.writeFile(info.controlFile, JSON.stringify({ version: 1, key: info.key, nonce: 'a'.repeat(64), pid: process.pid }));
  assert.equal((await startPortal({ root, browser: false })).state, 'ready');
  assert.equal((await stopPortal({ root, timeoutMs: 5000 })).state, 'stopped');
  assert.equal((await startPortal({ root, browser: false })).state, 'ready');
  assert.equal((await fs.readFile(path.join(root, 'created.txt'), 'utf8')).trim().split('\n').length, 2);
});
test('wrong nonce cannot stop an existing portal', async t => {
  const { root, info, config } = await workspace(t); await startPortal({ root, browser: false });
  const original = await fs.readFile(info.controlFile, 'utf8'); const wrong = JSON.parse(original); wrong.nonce = '0'.repeat(64);
  await fs.writeFile(info.controlFile, JSON.stringify(wrong));
  try { await assert.rejects(stopPortal({ root, timeoutMs: 1500 }), { code: 'PORTAL_CONTROL' }); assert.equal((await fetch(`http://127.0.0.1:${config.port}/`)).status, 200); }
  finally { await fs.writeFile(info.controlFile, original); }
});
test('occupied HTTP port is reported without terminating its owner; failed worker cleans up', async t => {
  const { root, config } = await workspace(t); const foreign = http.createServer((req, res) => res.end('unrelated'));
  await new Promise(resolve => foreign.listen(config.port, '127.0.0.1', resolve)); t.after(() => close(foreign));
  await assert.rejects(startPortal({ root, browser: false, timeoutMs: 5000 }), { code: 'EADDRINUSE' });
  assert.equal(await (await fetch(`http://127.0.0.1:${config.port}/`)).text(), 'unrelated');
  await delay(300); assert.deepEqual(await statusPortal({ root }), { state: 'absent' });
  assert.equal(await fs.readFile(path.join(root, 'cleanup.txt'), 'utf8'), 'finished');
});
test('invalid configuration fails without starting data services or leaving a controller', async t => {
  const { root } = await workspace(t); await fs.writeFile(path.join(root, 'config.local.json'), '{broken');
  await assert.rejects(startPortal({ root, browser: false, timeoutMs: 5000 }), { code: 'PORTAL_CONFIG' });
  await delay(200); assert.deepEqual(await statusPortal({ root }), { state: 'absent' });
  await assert.rejects(fs.stat(path.join(root, 'created.txt')), { code: 'ENOENT' });
});
test('unsafe network configuration is rejected before createPortal', async t => {
  const { root, config } = await workspace(t); await fs.writeFile(path.join(root, 'config.local.json'), JSON.stringify({ ...config, listenHost: '0.0.0.0' }));
  await assert.rejects(startPortal({ root, browser: false, timeoutMs: 5000 }), { code: 'PORTAL_NETWORK' });
  await assert.rejects(fs.stat(path.join(root, 'created.txt')), { code: 'ENOENT' });
});
test('stop waits for an active response and background cleanup; a timeout does not claim success', async t => {
  const { root, config } = await workspace(t); let response, releaseDrain;
  const pendingDrain = new Promise(resolve => { releaseDrain = resolve; });
  const server = http.createServer((req, res) => { response = res; });
  const controller = await runController({ root, portalModule: { loadConfig: () => config, createPortal: () => server }, waitForDrain: () => pendingDrain });
  const incoming = fetch(`http://127.0.0.1:${config.port}/`, { headers: { connection: 'close' } }); while (!response) await delay(5);
  await assert.rejects(stopPortal({ root, timeoutMs: 120 }), { code: 'PORTAL_STOP_TIMEOUT' });
  assert.equal((await statusPortal({ root })).state, 'stopping');
  let complete = false; const stopping = stopPortal({ root, timeoutMs: 3000 }).then(result => { complete = true; return result; });
  response.end('write completed'); await (await incoming).text(); await delay(50); assert.equal(complete, false);
  releaseDrain(); assert.equal((await stopping).state, 'stopped'); await controller.finished;
});
test('initial nonce publication delay is retried without spawning a second portal', async t => {
  const { root, config, info } = await workspace(t); let created = 0;
  const server = http.createServer((req, res) => res.end('ready'));
  const controller = await runController({ root, portalModule: { loadConfig: () => config, createPortal: () => { created++; return server; } }, waitForDrain: () => Promise.resolve() });
  const original = await fs.readFile(info.controlFile, 'utf8'); await fs.rm(info.controlFile);
  const publication = delay(180).then(() => fs.writeFile(info.controlFile, original));
  const ready = await startPortal({ root, browser: false, spawnImpl: () => { throw Error('must not spawn'); } }); await publication;
  assert.equal(ready.reused, true); assert.equal(created, 1);
  await stopPortal({ root, timeoutMs: 2000 }); await controller.finished;
});
test('unverified pipe never starts a worker or accepts an unauthenticated stop', async t => {
  const { root, info } = await workspace(t); let spawned = false;
  const foreign = net.createServer(socket => { socket.end('{"protocol":"unknown"}\n'); });
  await new Promise(resolve => foreign.listen(info.endpoint, resolve)); t.after(() => close(foreign));
  await assert.rejects(startPortal({ root, browser: false, timeoutMs: 150, spawnImpl: () => { spawned = true; } }), { code: 'PORTAL_CONTROL' });
  assert.equal(spawned, false);
});
test('Windows browser launch passes URL through stdin and hides only helper window', async () => {
  let captured;
  const url = 'https://portal.example.invalid:8443/?a=%27%3B&b=%24%28calc%29';
  await openBrowser(url, { platform: 'win32', spawnImpl: (file, args, options) => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.kill = () => {};
    let input = ''; child.stdin.on('data', chunk => { input += chunk; });
    child.stdin.on('finish', () => { captured = { file, args, options, input }; child.emit('close', 0); }); return child;
  } });
  assert.equal(captured.options.windowsHide, true); assert.equal(captured.input, url); assert.ok(!captured.args.join(' ').includes(url));
  assert.ok(!captured.options.shell); assert.ok(captured.args.includes('-NonInteractive'));
});
test('browser failure reports ready service with manual URL instead of rolling it back', async t => {
  const { root } = await workspace(t); const result = await startPortal({ root, openBrowserImpl: async () => { throw Error('browser unavailable'); } });
  assert.equal(result.state, 'ready'); assert.equal(result.browserOpened, false); assert.match(result.warning, /手动访问/);
  assert.equal((await statusPortal({ root })).state, 'ready');
});
