'use strict';
// One synthetic record, a controlled clock, and a temporary loopback portal.
// Never reads company config or live runtime and never restarts a live service.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.env.VISION_PLAYWRIGHT_PATH || 'playwright');
const { createPortal } = require('../server.cjs');
const { makeAdminConfig } = require('../lib/admin.cjs');
const { createVisionService, parseCsv } = require('../lib/vision.cjs');

function syntheticRecord() {
  const rows = [
    ['PartName', 'Tesla_Front12', '', '', '', '', ''],
    ['SN', 'SYNTHETIC-FRESHNESS-001', '', '', '', '', ''],
    ['TimeStamp', '2026/10/14 12:00:00', '', '', '', '', ''],
    ['Result', 'OK', '', '', '', '', ''],
    ['Name', 'Nominal', 'Lower_SL', 'Upper_SL', 'IsCritical', 'Dev', 'OK/NG'],
    ...Array.from({ length: 61 }, (_, i) => [`合成测点_${i + 1}`, '10', '-0.5', '0.5', i < 59 ? 'Yes' : 'No', '0.1', 'OK']),
  ];
  return parseCsv({ filename: 'Tesla_Front12_20261014-120000.csv', deviceId: 'freshness-isolated-test', content: rows.map(row => row.join(',')).join('\r\n') + '\r\n' });
}

async function main() {
  const tempBase = path.resolve(os.tmpdir());
  const root = await fs.mkdtemp(path.join(tempBase, 'gongyi-vision-freshness-'));
  let server, browser;
  try {
    const firstScan = Date.parse('2026-10-14T04:00:00Z');
    let current = firstScan + 121000;
    const record = syntheticRecord(), input = path.join(root, 'runtime/vision-input.json');
    await fs.mkdir(path.dirname(input));
    const writeSnapshot = scannedAt => fs.writeFile(input, JSON.stringify({ schema_version: 1, records: [record], last_scan: { scanned_at_utc: new Date(scannedAt).toISOString(), errors: [], deferred: 0 } }));
    await writeSnapshot(firstScan);
    const vision = createVisionService({ root, now: () => current });
    const credentialStore = { async load() { return null; }, async save() { throw Error('Isolated check only'); }, async remove() {} };
    const autoSource = { start() {}, stop() {}, status() { return { state: 'unconfigured', configured: false }; }, async read() { throw Error('No company connection in isolated check'); } };
    server = createPortal({ root, now: () => current, config: { admin: makeAdminConfig('vision-freshness-check', 'Vision-freshness-check-only-2026'), environmentLabel: '合成数据 · 采集更新时间验证' }, credentialStore, autoSource, inventoryService: { async capabilities() { return {}; } }, visionService: vision });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, channel: 'msedge' });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    const errors = [], externalRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => { if (new URL(route.request().url()).origin === origin) return route.continue(); externalRequests.push(route.request().url()); return route.abort(); });
    const settled = () => page.waitForFunction(() => document.querySelector('#visionWorkbench')?.getAttribute('aria-busy') === 'false' && document.querySelector('#visTotal')?.textContent === '1');
    const refresh = async (action = () => page.locator('#visRefresh').click()) => {
      const [response] = await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === '/local/vision/report' && response.status() === 200), action()]);
      const report = await response.json(); await settled(); return report;
    };
    const currentAppearance = () => page.evaluate(() => ({
      title: document.querySelector('#visSourceTitle').textContent,
      warning: document.querySelector('#visSource').classList.contains('warning'),
      error: document.querySelector('#visSource').classList.contains('error'),
      stale: document.querySelector('#visionWorkbench').classList.contains('vis-stale'),
      statsOpacity: getComputedStyle(document.querySelector('.vis-stats')).opacity,
      bannerBackground: getComputedStyle(document.querySelector('#visSource')).backgroundColor,
      queryDisabled: document.querySelector('#visQueryForm button[type=submit]').disabled,
      refreshDisabled: document.querySelector('#visRefresh').disabled,
    }));

    await page.goto(origin + '/#vision');
    await page.locator('#usernameInput').fill('vision-freshness-check');
    await page.locator('#passwordInput').fill('Vision-freshness-check-only-2026');
    await page.locator('#loginSubmit').click();
    await settled();
    const first = await vision.report();
    assert.equal(first.source.state, 'ready', 'A scan 2 minutes 1 second old uses the new default threshold.');
    assert.equal((await currentAppearance()).warning, false);
    assert.equal((await currentAppearance()).stale, false);

    current = firstScan + 901000;
    const fifteenMinutes = await refresh();
    assert.equal(fifteenMinutes.source.state, 'ready', 'A scan 15 minutes 1 second old is still within the two-hour default.');
    assert.deepEqual(fifteenMinutes.summary, first.summary);
    assert.equal((await currentAppearance()).warning, false); assert.equal((await currentAppearance()).stale, false);

    current = firstScan + 7201000;
    const waiting = await refresh();
    assert.equal(waiting.source.state, 'waiting');
    assert.deepEqual(waiting.summary, first.summary);
    const appearance = await currentAppearance();
    assert.equal(appearance.title, '共享可读取，等待采集更新');
    assert.equal(appearance.warning, false); assert.equal(appearance.error, false); assert.equal(appearance.stale, false);
    assert.equal(appearance.statsOpacity, '1');
    assert.equal(appearance.queryDisabled, false); assert.equal(appearance.refreshDisabled, false);
    assert.match(await page.locator('#visSourceMessage').innerText(), /2\s*小时.*等待采集更新/);
    await page.locator('#visSource').screenshot({ path: path.join(path.resolve(__dirname, '..'), '预览-视觉等待采集.png') });

    await page.locator('#visSearch').fill('SYNTHETIC-FRESHNESS-001');
    const queried = await refresh(() => page.locator('#visQueryForm button[type=submit]').click());
    assert.equal(queried.total, 1); assert.equal(queried.source.state, 'waiting');
    assert.equal(await page.locator('#visTable tbody tr').count(), 1);
    assert.equal(await page.locator('#visOK').innerText(), '1');

    await writeSnapshot(current);
    const recovered = await refresh();
    assert.equal(recovered.source.state, 'ready');
    assert.equal(recovered.source.collectorCheckedAt, new Date(current).toISOString());
    assert.deepEqual(recovered.summary, first.summary);
    assert.equal((await currentAppearance()).warning, false); assert.equal((await currentAppearance()).stale, false);
    assert.equal(await page.locator('#visSourceTitle').innerText(), '检测数据可读取');

    await fs.writeFile(input, '{ incomplete synthetic JSON');
    const invalid = await refresh();
    assert.equal(invalid.source.state, 'error');
    assert.deepEqual(invalid.summary, first.summary);
    const invalidAppearance = await currentAppearance();
    assert.equal(invalidAppearance.warning, true); assert.equal(invalidAppearance.stale, true);
    assert.equal(await page.locator('#visTotal').innerText(), '1');
    assert.equal(await page.locator('#visOK').innerText(), '1');
    assert.match(await page.locator('#visSourceMessage').innerText(), /保留.*记录|无法读取|格式无效/);
    assert.notEqual(invalidAppearance.bannerBackground, appearance.bannerBackground);
    assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
    console.log(JSON.stringify({ scanAge121Seconds: 'ready', scanAge901Seconds: 'ready', scanAge7201Seconds: 'waiting', waitingTitle: appearance.title, waitingBannerBackground: appearance.bannerBackground, waitingStatsOpacity: appearance.statsOpacity, queryWorksWhileWaiting: true, freshScanRecoversReady: true, invalidJson: 'error', invalidJsonKeepsStats: true, pageErrors: errors, externalRequests, screenshot: '预览-视觉等待采集.png' }));
  } finally {
    if (browser) await browser.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== tempBase || !path.basename(resolved).startsWith('gongyi-vision-freshness-')) throw Error('Refusing cleanup outside expected temporary directory.');
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
