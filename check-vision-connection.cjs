'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createVisionSource } = require('./lib/vision-source.cjs');
const { validateVisionSnapshot } = require('./lib/vision.cjs');

async function checkVisionConnection({ root = __dirname, config = {}, env = process.env, now = Date.now, sourceReader } = {}) {
  const source = sourceReader || createVisionSource({ root, config, env });
  const result = {
    mode: 'legacy-file',
    mesVerified: false,
    scope: '仅验证历史采集文件及当前进程账号的读取能力；不验证 MES 连接、权限或数据完整性，当前门户不读取此文件。',
    source: source.describe?.() || { kind: 'file' },
  };
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
  const args = process.argv.slice(2);
  const notice = '此工具仅用于历史文件采集方案，不验证 MES；当前门户使用公司 MES 查询。MES 验证请按 docs/公司尺寸接口接入.md 执行。';
  if ((args.length === 1 && args[0] === '--help') || (args.length === 2 && args[0] === '--legacy' && args[1] === '--help')) {
    process.stdout.write(notice + '\n历史维护命令：npm run vision:check:legacy（或 npm run vision:check -- --legacy）。\n显式启用后读取本机 config.local.json；PORTAL_VISION_DATA_FILE 可覆盖历史来源路径。\n请用历史采集任务实际运行的系统账号执行。只读自检，不导入记录、不修改共享或配置。\n');
    return;
  }
  // Require an explicit mode before reading config or touching a legacy share.
  if (args.length !== 1 || args[0] !== '--legacy') {
    throw new Error('VISION_LEGACY_CHECK_ONLY: ' + notice + '\n如确需检查历史采集文件，请运行 npm run vision:check:legacy；不在命令中提供共享密码。');
  }
  let config;
  try { config = JSON.parse((await fs.readFile(path.join(__dirname, 'config.local.json'), 'utf8')).replace(/^\uFEFF/, '')); }
  catch (_) { throw new Error('历史文件检查所需的本机 config.local.json 缺失或格式无效；这不是 MES 连接检查结果。'); }
  const result = await checkVisionConnection({ config });
  // Exit after flushing: an OS-level share read can remain pending after our
  // deadline. This one-shot, read-only command must still finish on timeout.
  process.stdout.write(JSON.stringify(result, null, 2) + '\n', () => process.exit(result.state === 'error' ? 1 : 0));
}
if (require.main === module) main().catch(error => {
  process.stderr.write(error.message + '\n', () => process.exit(1));
});
module.exports = { checkVisionConnection };
