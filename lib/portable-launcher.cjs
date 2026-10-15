'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PROTOCOL = 'gongyi-portal-control-v1';
const messages = {
  PORTAL_CONFIG: '门户配置缺失或无效，请保留私有配置并查看启动日志。',
  PORTAL_NETWORK: '非本机访问必须先配置 HTTPS 证书和允许的访问来源。',
  EADDRINUSE: '门户端口已被其他程序占用；没有关闭它，请先核对原来的门户窗口。',
  PORTAL_START: '门户未能启动，请查看 runtime/portable-launcher/portal.log。',
  PORTAL_START_TIMEOUT: '门户尚未确认启动完成，请稍后再双击启动或查看启动日志。',
  PORTAL_STOP_TIMEOUT: '门户仍在停止，尚未确认完成；可能有未结束的请求或共享读取，请稍后再试。',
  PORTAL_CONTROL: '未能确认本目录门户的控制连接，没有停止其他程序。',
  PORTAL_STORAGE: '启动器无法写入本机运行目录，请完整解压到具有写入权限的本地文件夹。',
  PORTAL_BROWSER: '门户已启动，但浏览器未能自动打开，请手动访问显示的地址。',
};
function failure(code) { return Object.assign(new Error(messages[code] || messages.PORTAL_START), { code }); }
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const mac = (nonce, text) => crypto.createHmac('sha256', nonce).update(text).digest('hex');
function same(left, right) {
  return typeof left === 'string' && typeof right === 'string' && /^[a-f0-9]{64}$/.test(left) && /^[a-f0-9]{64}$/.test(right) && crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
async function location(root) {
  const directory = await fs.realpath(root);
  if (!(await fs.stat(directory)).isDirectory()) throw failure('PORTAL_CONFIG');
  const identity = process.platform === 'win32' ? directory.toLowerCase() : directory;
  const key = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32);
  const runtime = path.join(directory, 'runtime', 'portable-launcher');
  return { root: directory, key, runtime, controlFile: path.join(runtime, 'control.json'), statusFile: path.join(runtime, 'status.json'),
    log: path.join(runtime, 'portal.log'), endpoint: process.platform === 'win32' ? '\\\\.\\pipe\\gongyi-portal-' + key : path.join(os.tmpdir(), 'gongyi-portal-' + key + '.sock') };
}
function listenSettings(config) {
  const port = Number(config.port) || 4173, host = config.listenHost || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof host !== 'string' || !host.trim()) throw failure('PORTAL_CONFIG');
  const tls = Boolean(config.tls?.certFile && config.tls?.keyFile), loopback = ['127.0.0.1', 'localhost'].includes(host);
  if (!loopback && (!tls || !Array.isArray(config.publicOrigins) || !config.publicOrigins.length)) throw failure('PORTAL_NETWORK');
  const origins = [];
  try { for (const candidate of config.publicOrigins || []) {
    const value = new URL(candidate);
    if (value.protocol !== 'https:' || value.username || value.password || value.pathname !== '/' || value.search || value.hash) throw Error();
    origins.push(value.origin);
  } } catch (_) { throw failure('PORTAL_NETWORK'); }
  const url = loopback ? `${tls ? 'https' : 'http'}://${host}:${port}/` : origins[0] + '/';
  return { host, port, url };
}
async function writeJson(filename, value) {
  const temporary = filename + '.' + crypto.randomUUID() + '.tmp';
  try { await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, filename); }
  finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}
async function request(info, action = 'status', timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(info.endpoint); let text = '', challenge, nonce, requestId, done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(failure(action === 'stop' ? 'PORTAL_STOP_TIMEOUT' : 'PORTAL_CONTROL')), timeoutMs);
    socket.on('error', error => finish(['ENOENT', 'ECONNREFUSED'].includes(error.code) ? Object.assign(failure('PORTAL_CONTROL'), { code: 'PORTAL_ABSENT' }) : failure('PORTAL_CONTROL')));
    socket.on('end', () => { if (!done) finish(failure('PORTAL_CONTROL')); });
    socket.on('data', chunk => {
      text += chunk.toString('utf8'); if (text.length > 16384) return finish(failure('PORTAL_CONTROL'));
      let newline;
      while ((newline = text.indexOf('\n')) >= 0) {
        const line = text.slice(0, newline); text = text.slice(newline + 1);
        let message; try { message = JSON.parse(line); } catch (_) { return finish(failure('PORTAL_CONTROL')); }
        if (!challenge) {
          if (message.protocol !== PROTOCOL || !/^[a-f0-9]{32}$/.test(message.challenge)) return finish(failure('PORTAL_CONTROL'));
          challenge = message.challenge; requestId = crypto.randomBytes(16).toString('hex');
          fs.readFile(info.controlFile, 'utf8').then(raw => {
            const state = JSON.parse(raw); if (state.version !== 1 || state.key !== info.key || !/^[a-f0-9]{64}$/.test(state.nonce)) throw Error();
            nonce = state.nonce; if (!done) socket.write(JSON.stringify({ action, requestId, proof: mac(nonce, challenge + '|' + requestId + '|' + action) }) + '\n');
          }).catch(() => finish(failure('PORTAL_CONTROL')));
        } else {
          if (!nonce || message.requestId !== requestId || !message.result || !same(message.proof, mac(nonce, challenge + '|' + requestId + '|reply|' + JSON.stringify(message.result)))) return finish(failure('PORTAL_CONTROL'));
          finish(null, message.result);
        }
      }
    });
  });
}
async function openBrowser(url, { spawnImpl = spawn, platform = process.platform } = {}) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw failure('PORTAL_BROWSER');
  return new Promise((resolve, reject) => {
    let child;
    try {
      if (platform === 'win32') {
        const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        child = spawnImpl(executable, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', "$ErrorActionPreference='Stop'; $url=[Console]::In.ReadToEnd(); Start-Process -FilePath $url"], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
        child.stdin.on('error', () => {}); child.stdin.end(parsed.href);
      } else child = spawnImpl(platform === 'darwin' ? 'open' : 'xdg-open', [parsed.href], { windowsHide: true, stdio: 'ignore' });
    } catch (_) { reject(failure('PORTAL_BROWSER')); return; }
    const timer = setTimeout(() => { child.kill(); reject(failure('PORTAL_BROWSER')); }, 10000);
    child.once('error', () => { clearTimeout(timer); reject(failure('PORTAL_BROWSER')); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(failure('PORTAL_BROWSER')); });
  });
}
async function startPortal({ root, browser = true, timeoutMs = 25000, spawnImpl = spawn, openBrowserImpl = openBrowser } = {}) {
  const info = await location(root); let current = null, child, childExit = null, childError = false;
  // A competing worker owns the pipe before it writes the nonce. Wait for that
  // owner; an unauthenticated pipe must never cause another service to start.
  const handshakeDeadline = Date.now() + Math.min(timeoutMs, 5000);
  while (!current) {
    try { current = await request(info); }
    catch (error) {
      if (error.code === 'PORTAL_ABSENT') break;
      if (error.code !== 'PORTAL_CONTROL' || Date.now() >= handshakeDeadline) throw error;
      await delay(100);
    }
  }
  const reused = Boolean(current);
  if (!current) {
    let log;
    try {
      await fs.mkdir(info.runtime, { recursive: true });
      try { if ((await fs.stat(info.log)).size > 1024 * 1024) await fs.rename(info.log, info.log + '.previous').catch(() => {}); } catch (_) {}
      log = await fs.open(info.log, 'a', 0o600);
      child = spawnImpl(process.execPath, [path.join(info.root, 'launch-portal.cjs'), '--worker'], { cwd: info.root, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
      child.once('error', () => { childError = true; }); child.once('exit', code => { childExit = code; }); child.unref();
    } catch (_) { throw failure('PORTAL_STORAGE'); }
    finally { if (log) await log.close(); }
  }
  const deadline = Date.now() + timeoutMs;
  do {
    if (current?.state === 'ready') {
      let browserOpened = false;
      if (browser) { try { await openBrowserImpl(current.url); browserOpened = true; } catch (_) {} }
      return { ...current, reused, browserOpened, ...(browser && !browserOpened ? { warning: messages.PORTAL_BROWSER } : {}) };
    }
    if (current?.state === 'failed') throw failure(current.code);
    if (current?.state === 'stopping') throw failure('PORTAL_STOP_TIMEOUT');
    if (childError || childExit !== null && childExit !== 0) {
      try { const status = JSON.parse(await fs.readFile(info.statusFile, 'utf8')); if (status.state === 'failed') throw failure(status.code); }
      catch (error) { if (error.code && messages[error.code]) throw error; }
      throw failure('PORTAL_START');
    }
    await delay(100);
    try { current = await request(info); } catch (error) { if (!['PORTAL_ABSENT', 'PORTAL_CONTROL'].includes(error.code)) throw error; current = null; }
  } while (Date.now() < deadline);
  throw failure('PORTAL_START_TIMEOUT');
}
async function stopPortal({ root, timeoutMs = 75000 } = {}) {
  const info = await location(root);
  try { const result = await request(info, 'stop', timeoutMs); if (result.state !== 'stopped') throw failure(result.code || 'PORTAL_STOP_TIMEOUT'); return result; }
  catch (error) { if (error.code === 'PORTAL_ABSENT') return { state: 'absent' }; throw error; }
}
async function statusPortal({ root } = {}) {
  try { return await request(await location(root)); }
  catch (error) { if (error.code === 'PORTAL_ABSENT') return { state: 'absent' }; throw error; }
}

async function runController({ root, portalModule, waitForDrain } = {}) {
  const info = await location(root), nonce = crypto.randomBytes(32).toString('hex'), sockets = new Set(), stopReplies = [];
  let state = 'starting', code = null, url = null, server = null, finalizing = false, draining = false;
  let resolveFinished; const finished = new Promise(resolve => { resolveFinished = resolve; });
  await fs.mkdir(info.runtime, { recursive: true });
  const summary = () => ({ state, ...(url ? { url } : {}), ...(code ? { code } : {}) });
  const log = text => fs.appendFile(info.log, new Date().toISOString() + ' ' + text + '\n', { mode: 0o600 }).catch(() => {});
  const control = net.createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
    if (draining) socket.unref();
    const challenge = crypto.randomBytes(16).toString('hex'); let text = '', accepted = false;
    socket.setTimeout(5000, () => socket.destroy());
    socket.write(JSON.stringify({ protocol: PROTOCOL, challenge }) + '\n');
    socket.on('data', chunk => {
      if (accepted) return; text += chunk.toString('utf8'); if (text.length > 8192) return socket.destroy();
      const newline = text.indexOf('\n'); if (newline < 0) return;
      let message; try { message = JSON.parse(text.slice(0, newline)); } catch (_) { return socket.destroy(); }
      if (!['status', 'stop'].includes(message.action) || !/^[a-f0-9]{32}$/.test(message.requestId) || !same(message.proof, mac(nonce, challenge + '|' + message.requestId + '|' + message.action))) return socket.destroy();
      accepted = true; socket.setTimeout(0);
      const reply = result => { if (!socket.destroyed) socket.end(JSON.stringify({ requestId: message.requestId, result, proof: mac(nonce, challenge + '|' + message.requestId + '|reply|' + JSON.stringify(result)) }) + '\n'); };
      if (message.action === 'status') reply(summary());
      else { stopReplies.push(reply); void stop(); }
    });
  });
  control.maxConnections = 32;
  try { await new Promise((resolve, reject) => { control.once('error', reject); control.listen(info.endpoint, resolve); }); }
  catch (error) { if (error.code === 'EADDRINUSE') return { duplicate: true, finished: Promise.resolve({ exitCode: 0 }) }; throw error; }
  control.removeAllListeners('error'); control.on('error', () => { code = 'PORTAL_CONTROL'; void stop(true); });
  async function persist() { await writeJson(info.statusFile, { ...summary(), updatedAt: new Date().toISOString() }); }
  async function finalize() {
    if (finalizing) return; finalizing = true;
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    state = code ? 'failed' : 'stopped';
    await persist().catch(() => {});
    try { const owner = JSON.parse(await fs.readFile(info.controlFile, 'utf8')); if (owner.nonce === nonce) await fs.rm(info.controlFile, { force: true }); } catch (_) {}
    await log(code ? '启动失败：' + (messages[code] || messages.PORTAL_START) : '门户已停止，活动请求和后台任务已结束。');
    for (const reply of stopReplies) reply(summary());
    control.close();
    resolveFinished({ exitCode: code ? 1 : 0 });
  }
  function drain() {
    if (draining) return; draining = true;
    // Unref only the controller. HTTP requests and filesystem/child-process work
    // keep the worker alive until the server's existing close hooks have settled.
    control.unref(); for (const socket of sockets) socket.unref();
    if (waitForDrain) Promise.resolve().then(waitForDrain).then(finalize, () => { code = 'PORTAL_START'; return finalize(); });
    else process.once('beforeExit', finalize);
  }
  async function stop(failed = false) {
    if (state === 'stopping' || draining || finalizing) return;
    if (!failed) state = 'stopping';
    await persist().catch(() => {});
    if (server) {
      await new Promise(resolve => { try { server.close(() => resolve()); server.closeIdleConnections?.(); } catch (_) { resolve(); } });
    }
    drain();
  }
  const onSignal = () => { void stop(); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  try {
    await writeJson(info.controlFile, { version: 1, key: info.key, nonce }); await persist();
    // Validate the private file without logging its content. loadConfig() alone
    // intentionally falls back to {}, which is unsuitable for a migration launcher.
    const parsed = JSON.parse((await fs.readFile(path.join(info.root, 'config.local.json'), 'utf8')).replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw failure('PORTAL_CONFIG');
    const portal = portalModule || require(path.join(info.root, 'server.cjs'));
    const config = portal.loadConfig(), listening = listenSettings(config); url = listening.url;
    if (state !== 'starting') return { finished };
    server = portal.createPortal({ config });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(listening.port, listening.host, () => { server.removeListener('error', reject); resolve(); }); });
    server.on('error', () => { code = 'PORTAL_START'; void stop(true); });
    if (state !== 'starting') return { finished };
    state = 'ready'; await persist(); await log('门户已启动：' + url);
  } catch (error) {
    code = error.code === 'EADDRINUSE' ? 'EADDRINUSE' : messages[error.code] ? error.code : error instanceof SyntaxError || error.code === 'ENOENT' ? 'PORTAL_CONFIG' : 'PORTAL_START';
    state = 'failed'; await log('启动失败：' + messages[code]); void stop(true);
  }
  return { finished };
}
async function main({ root, args = process.argv.slice(2) } = {}) {
  const action = args[0] || 'start', noBrowser = args.includes('--no-browser');
  if (!['start', 'stop', 'status', '--worker'].includes(action) || args.slice(1).some(value => value !== '--no-browser')) throw failure('PORTAL_CONFIG');
  if (action === '--worker') { const controller = await runController({ root }); return (await controller.finished).exitCode; }
  const result = action === 'start' ? await startPortal({ root, browser: !noBrowser }) : action === 'stop' ? await stopPortal({ root }) : await statusPortal({ root });
  if (action === 'start') console.log((result.reused ? '门户已在运行：' : '门户已启动：') + result.url + (result.warning ? '\n' + result.warning : ''));
  else if (action === 'stop') console.log(result.state === 'stopped' ? '门户已停止。' : '没有本启动器管理的运行实例，未停止其他程序。');
  else console.log(JSON.stringify(result));
  return action === 'start' && result.warning ? 5 : 0;
}
module.exports = { location, listenSettings, request, startPortal, stopPortal, statusPortal, runController, openBrowser, main };
