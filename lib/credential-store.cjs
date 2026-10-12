'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

class CredentialStoreError extends Error {
  constructor(message, status = 503) { super(message); this.status = status; }
}
function validateCredentials(value) {
  if (!value || typeof value.username !== 'string' || !value.username || value.username.length > 100 ||
      typeof value.password !== 'string' || !value.password || value.password.length > 500) {
    throw new CredentialStoreError('请填写有效的数据源账号和密码。', 400);
  }
  return { username: value.username, password: value.password };
}

// Only this fixed program is placed on the command line. Secret input uses stdin.
const DPAPI_PROGRAM = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  Add-Type -AssemblyName System.Security
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.action -eq 'protect') {
    $bytes = [Text.Encoding]::UTF8.GetBytes([string]$request.data)
    $encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Convert]::ToBase64String($encrypted))
  } elseif ($request.action -eq 'unprotect') {
    $bytes = [Convert]::FromBase64String([string]$request.data)
    $plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))
  } else { exit 1 }
} catch { exit 1 }
`;
function dpapi(action, data, { platform = process.platform, spawnImpl = spawn } = {}) {
  if (platform !== 'win32') return Promise.reject(new CredentialStoreError('此系统不支持本机 Windows 加密保存，请由维护人员使用环境变量配置数据源。'));
  return new Promise((resolve, reject) => {
    const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawnImpl(executable, ['-NoProfile', '-NonInteractive', '-Command', DPAPI_PROGRAM], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const failure = () => new CredentialStoreError('本机加密凭据无法处理，请使用保存它的 Windows 用户，或重新设置数据源。');
    const timer = setTimeout(() => { child.kill(); finish(failure()); }, 15000);
    child.on('error', () => finish(failure()));
    child.stdin.on('error', () => finish(failure()));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 131072) { child.kill(); finish(failure()); } });
    child.stderr.resume(); // Never expose PowerShell diagnostics or secret input.
    child.on('close', code => code === 0 ? finish(null, output) : finish(failure()));
    child.stdin.end(JSON.stringify({ action, data }));
  });
}
function createCredentialStore({ root, env = process.env, platform = process.platform, protect, unprotect } = {}) {
  const directory = path.join(root, 'runtime');
  const filename = path.join(directory, 'source-credentials.dpapi.json');
  const encrypt = protect || (value => dpapi('protect', value, { platform }));
  const decrypt = unprotect || (value => dpapi('unprotect', value, { platform }));
  const environmentConfigured = () => Object.hasOwn(env, 'PORTAL_SOURCE_USERNAME') || Object.hasOwn(env, 'PORTAL_SOURCE_PASSWORD');
  function assertWritable() {
    if (environmentConfigured()) throw new CredentialStoreError('数据源由环境变量管理，请由维护人员修改环境变量后重启服务。', 409);
  }
  async function load() {
    if (environmentConfigured()) {
      try { return validateCredentials({ username: env.PORTAL_SOURCE_USERNAME, password: env.PORTAL_SOURCE_PASSWORD }); }
      catch (_) { throw new CredentialStoreError('数据源环境变量不完整，请同时配置账号和密码。'); }
    }
    let document;
    try {
      const stat = await fs.stat(filename);
      if (stat.size > 131072) throw new Error();
      document = JSON.parse(await fs.readFile(filename, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new CredentialStoreError('本机数据源设置无法读取，请重新设置。');
    }
    if (document.version !== 1 || document.protection !== 'DPAPI-CurrentUser' || typeof document.ciphertext !== 'string') {
      throw new CredentialStoreError('本机数据源设置格式不受支持，请重新设置。');
    }
    try { return validateCredentials(JSON.parse(await decrypt(document.ciphertext))); }
    catch (_) { throw new CredentialStoreError('无法解密本机数据源设置，请使用原 Windows 用户或重新设置。'); }
  }
  async function save(value) {
    assertWritable();
    const credentials = validateCredentials(value);
    const ciphertext = await encrypt(JSON.stringify(credentials));
    if (typeof ciphertext !== 'string' || !ciphertext) throw new CredentialStoreError('本机加密保存失败，数据源设置未更新。');
    const data = JSON.stringify({ version: 1, protection: 'DPAPI-CurrentUser', ciphertext });
    const temporary = path.join(directory, `.source-credentials-${randomUUID()}.tmp`);
    try {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, filename);
    } catch (_) { throw new CredentialStoreError('加密设置无法保存到本机，数据源设置未更新。'); }
    finally { await fs.unlink(temporary).catch(() => {}); }
  }
  async function remove() {
    assertWritable();
    try { await fs.unlink(filename); } catch (error) { if (error.code !== 'ENOENT') throw new CredentialStoreError('无法删除本机数据源设置。'); }
  }
  return { load, save, remove, assertWritable };
}
module.exports = { createCredentialStore, CredentialStoreError, validateCredentials, dpapi };
