'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { PortalError } = require('./source.cjs');

const MAX_FILE_BYTES = 128 * 1024 * 1024;
function failure(message, code = 'VISION_SOURCE_CONFIG') {
  return Object.assign(new PortalError(message, 503), { code });
}

function sourceSettings({ root, config = {}, env = process.env, platform = process.platform }) {
  const override = env.PORTAL_VISION_DATA_FILE;
  const configuredPath = override !== undefined ? override : config.vision?.dataFile;
  const value = configuredPath === undefined ? 'runtime/vision-input.json' : configuredPath;
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > 4096) {
    throw failure('检具来源路径无效，请配置 vision.dataFile 或 PORTAL_VISION_DATA_FILE。');
  }
  const filename = value.trim();
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(filename)) {
    throw failure('采集来源需要文件系统路径；Windows 使用 UNC 共享路径，Linux 先只读挂载共享再填写挂载路径。');
  }
  const unc = /^(?:\\\\|\/\/)/.test(filename);
  const windowsDrive = /^[a-z]:/i.test(filename);
  if (platform !== 'win32' && (unc || windowsDrive || filename.includes('\\'))) {
    throw failure('当前系统不能直接使用 Windows 路径；请先只读挂载共享，再配置本机绝对挂载路径。');
  }
  if (platform === 'win32' && (windowsDrive && !/^[a-z]:[\\/]/i.test(filename) || /^\\[^\\]/.test(filename))) {
    throw failure('请使用完整 UNC 路径或绝对磁盘路径，不要使用依赖当前磁盘的相对路径。');
  }
  const windowsPath = filename.replaceAll('/', '\\');
  if (platform === 'win32' && /^\\\\[?.]\\/.test(windowsPath)) {
    throw failure('采集来源请使用普通 UNC 或磁盘文件路径。');
  }
  if (platform === 'win32' && unc) {
    const segments = windowsPath.slice(2).split('\\');
    if (segments.length < 3 || !segments[0] || !segments[1] || !segments.at(-1)) {
      throw failure('UNC 路径需包含服务器、共享名和采集文件名，请使用完整共享文件路径。');
    }
  }
  if (platform === 'win32' && /^\/(?!\/)/.test(filename)) {
    throw failure('当前系统为 Windows，请使用 UNC 或完整磁盘路径；Linux 挂载路径不能直接复制使用。');
  }
  const readTimeoutMs = config.vision?.readTimeoutMs ?? 10000;
  if (!Number.isInteger(readTimeoutMs) || readTimeoutMs < 1000 || readTimeoutMs > 60000) {
    throw failure('vision.readTimeoutMs 必须是 1000–60000 的整数毫秒。');
  }
  const paths = platform === 'win32' ? path.win32 : path.posix;
  return {
    filename: paths.resolve(root, filename), readTimeoutMs,
    kind: unc ? 'unc' : windowsDrive ? 'windows-path' : paths.isAbsolute(filename) ? 'absolute-path' : 'relative-path',
    configured: configuredPath !== undefined,
  };
}

async function readFileJson(filename) {
  const stat = await fs.stat(filename);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
    throw failure('采集文件不是普通文件或超过 128 MB，请按时间分批接入。', 'VISION_SOURCE_SIZE');
  }
  const bytes = await fs.readFile(filename);
  if (bytes.length > MAX_FILE_BYTES) throw failure('采集文件超过 128 MB。', 'VISION_SOURCE_SIZE');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''));
}

function readableError(error) {
  if (error instanceof PortalError) return error;
  if (error?.code === 'ENOENT') return failure('采集文件不存在，请核对共享路径及挂载状态。', 'ENOENT');
  if (['EACCES', 'EPERM'].includes(error?.code)) {
    return failure('当前运行门户的系统账号没有采集文件读取权限，请核对共享权限与文件权限。', error.code);
  }
  if (error instanceof SyntaxError || error?.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') {
    return failure('采集文件不是有效的 UTF-8 JSON，请检查采集程序输出。', 'VISION_SOURCE_FORMAT');
  }
  return failure('采集文件暂时无法读取，请核对共享连接、挂载状态及服务账号权限。', 'VISION_SOURCE_READ');
}

function createVisionSource(options) {
  let settings, configurationError;
  try { settings = sourceSettings(options); } catch (error) { configurationError = error; }
  const readJson = options.readJson || readFileJson;
  let pending = null;
  function operation() {
    if (!pending) {
      const current = Promise.resolve().then(() => readJson(settings.filename)).catch(error => { throw readableError(error); });
      pending = current;
      // A timed-out OS read can still be pending. Reuse it until it settles so
      // an unavailable SMB share cannot accumulate more filesystem operations.
      current.finally(() => { if (pending === current) pending = null; }).catch(() => {});
    }
    return pending;
  }
  async function read() {
    if (configurationError) throw configurationError;
    let timer;
    try {
      return await Promise.race([
        operation(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(failure('读取采集共享超时，保留已接收记录；请核对网络与服务账号，连接恢复后自动重试。', 'VISION_READ_TIMEOUT')), settings.readTimeoutMs);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }
  function describe() {
    return settings
      ? { kind: settings.kind, configured: settings.configured, readTimeoutMs: settings.readTimeoutMs }
      : { kind: 'invalid', configured: false, readTimeoutMs: null };
  }
  return { read, describe };
}

module.exports = { createVisionSource, sourceSettings };
