'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createVisionSource } = require('./lib/vision-source.cjs');
const { validateVisionSnapshot } = require('./lib/vision.cjs');

async function checkVisionConnection({ root = __dirname, config = {}, env = process.env, now = Date.now, sourceReader } = {}) {
  const source = sourceReader || createVisionSource({ root, config, env });
  const result = { scope: '仅验证当前进程账号的读取能力，不代表其他服务账号或现场历史完整性。', source: source.describe?.() || { kind: 'file' } };
  let document;
  try { document = await source.read(); }
  catch (error) {
    return { ...result, state: 'error', stage: 'read', code: error.code || 'VISION_SOURCE_READ', message: error.status ? error.message : '采集文件暂时无法读取。' };
  }
  let records;
  try { records = validateVisionSnapshot(document); }
  catch (_) {
    return { ...result, state: 'error', stage: 'format', code: 'VISION_SOURCE_FORMAT', message: '文件可读取，但未通过当前检具快照格式校验；没有导入或修改任何数据。' };
  }
  result.recordCount = records.length;
  const scan = document.last_scan?.scanned_at_utc;
  const parsed = typeof scan === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(scan) ? Date.parse(scan) : NaN;
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 19) !== scan.slice(0, 19) || parsed > now() + 30000) {
    return { ...result, state: 'error', stage: 'freshness', code: 'VISION_SCAN_TIME', message: '文件可读取，但扫描时间缺失、无效或超前，请核对采集程序及两端时钟。' };
  }
  result.collectorCheckedAt = new Date(parsed).toISOString();
  result.collectorErrorCount = Array.isArray(document.last_scan?.errors) ? document.last_scan.errors.length : 0;
  if (result.collectorErrorCount) {
    return { ...result, state: 'error', stage: 'collector', code: 'VISION_COLLECTOR_ERRORS', message: '共享文件可读取，但采集程序报告文件读取错误；需要在采集电脑核对。' };
  }
  const configuredAge = config.vision?.maxScanAgeSeconds;
  const maxAge = Number.isFinite(configuredAge) && configuredAge >= 30 && configuredAge <= 86400 ? configuredAge : 7200;
  const waiting = now() - parsed > maxAge * 1000;
  return { ...result, state: waiting ? 'waiting' : 'ready', message: waiting ? '共享文件可读取，等待采集扫描更新；连接可读不代表采集程序正在运行。' : '当前账号可以读取有效采集文件；本次只读检查未导入或修改数据。' };
}

async function main() {
  if (process.argv.length > 2) {
    if (process.argv.length === 3 && process.argv[2] === '--help') {
      process.stdout.write('npm run vision:check\n读取本机 config.local.json；PORTAL_VISION_DATA_FILE 可覆盖来源路径。\n请用实际运行门户的系统账号执行。只读自检，不导入记录、不修改共享或配置。\n');
      return;
    }
    throw new Error('请使用 npm run vision:check；不需要在命令中提供共享密码。');
  }
  let config;
  try { config = JSON.parse((await fs.readFile(path.join(__dirname, 'config.local.json'), 'utf8')).replace(/^\uFEFF/, '')); }
  catch (_) { throw new Error('本机 config.local.json 缺失或格式无效，请先完成部署配置。'); }
  const result = await checkVisionConnection({ config });
  // Exit after flushing: an OS-level share read can remain pending after our
  // deadline. This one-shot, read-only command must still finish on timeout.
  process.stdout.write(JSON.stringify(result, null, 2) + '\n', () => process.exit(result.state === 'error' ? 1 : 0));
}
if (require.main === module) main().catch(error => {
  process.stderr.write(error.message + '\n', () => process.exit(1));
});
module.exports = { checkVisionConnection };
