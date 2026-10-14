'use strict';
// Synthetic, loopback-only browser checks. Never reads live config/runtime.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.env.VISION_PLAYWRIGHT_PATH || 'playwright');
const { createPortal } = require('../server.cjs');
const { makeAdminConfig } = require('../lib/admin.cjs');
const { createVisionService, parseCsv } = require('../lib/vision.cjs');
const projectRoot = path.resolve(__dirname, '..');
const selector = '#visTrendChart g[data-vis-trend-date]';
const dailyDates = ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13'];
const focusDay = '2026-10-13';
const recentDay = '2026-10-14';
function csv(day, clock, sn, result = 'OK', part = 'Tesla_Front12') {
  const rows = [
    ['PartName', part, '', '', '', '', ''], ['SN', sn, '', '', '', '', ''],
    ['TimeStamp', `${day.replaceAll('-', '/')} ${clock}`, '', '', '', '', ''],
    ['Result', result, '', '', '', '', ''], ['Name', 'Nominal', 'Lower_SL', 'Upper_SL', 'IsCritical', 'Dev', 'OK/NG'],
    ...Array.from({ length: 61 }, (_, i) => [`合成测点_${i + 1}`, '10.123456', '-0.000015', '0.000015', i < 59 ? 'Yes' : 'No', result === 'NG' && i === 0 ? '0.1' : '0.000001', result === 'NG' && i === 0 ? 'NG' : 'OK']),
  ];
  return { filename: `${part}_${day.replaceAll('-', '')}-${clock.replaceAll(':', '')}.csv`, deviceId: 'trend-isolated-test', content: rows.map(row => row.join(',')).join('\r\n') + '\r\n' };
}
function hhmm(minute, seconds = 0) { return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`; }
function localDates() {
  const today = new Date(); today.setHours(12, 0, 0, 0);
  return Object.fromEntries([0, -6, -7, -29, -30, 1].map(offset => {
    const value = new Date(today); value.setDate(value.getDate() + offset);
    return [offset, `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`];
  }));
}
function dataset(days) {
  const records = [], add = (...args) => records.push(parseCsv(csv(...args)));
  for (let i = 0; i < 8; i++) add(dailyDates[0], hhmm(480 + i), `SYNTHETIC-DAILY-A-${i}`, i < 4 ? 'OK' : 'NG');
  add(dailyDates[1], '08:00:00', 'SYNTHETIC-DAILY-CONFLICT', 'OK');
  add(dailyDates[1], '08:00:00', 'SYNTHETIC-DAILY-CONFLICT', 'NG');
  for (let i = 0; i < 8; i++) add(dailyDates[2], hhmm(480 + i), `SYNTHETIC-DAILY-C-${i}`);
  for (let i = 0; i < 12; i++) add(dailyDates[3], hhmm(480 + i), `SYNTHETIC-DAILY-D-${i}`, i < 9 ? 'OK' : 'NG');
  // Twelve 15-minute periods, with 09:15 containing only conflicting records.
  for (let i = 0; i < 36; i++) if (i < 15 || i > 17) add(focusDay, hhmm(480 + 5 * i), `SYNTHETIC-GRANULAR-${i}`, i % 7 === 0 || i % 11 === 0 ? 'NG' : 'OK');
  add(focusDay, '09:15:00', 'SYNTHETIC-GRANULAR-CONFLICT', 'OK');
  add(focusDay, '09:15:00', 'SYNTHETIC-GRANULAR-CONFLICT', 'NG');
  ['07:59:59', '08:00:00', '08:04:59', '08:05:00', '08:59:00', '08:59:59', '09:00:00'].forEach((clock, i) => add(focusDay, clock, `SYNTHETIC-MINUTE-${i}`));
  for (let i = 0; i < 650; i++) add(recentDay, hhmm(480 + i), `SYNTHETIC-RECENT-${String(i).padStart(4, '0')}`, i % 5 === 0 ? 'NG' : 'OK');
  for (const offset of [0, -6, -7, -29, -30, 1]) add(days[offset], '08:00:00', `SYNTHETIC-PERIOD-${offset}`, 'NG');
  add(days[0], '08:01:00', 'SYNTHETIC-PERIOD-OTHER-PART', 'NG', 'Tesla_Front11');
  add(days[0], '08:02:00', 'SYNTHETIC-PERIOD-OTHER-RESULT', 'OK');
  return records;
}
async function main() {
  const tempBase = path.resolve(os.tmpdir()), root = await fs.mkdtemp(path.join(tempBase, 'gongyi-vision-trend-'));
  let server, browser;
  try {
    const days = localDates(), records = dataset(days);
    await fs.mkdir(path.join(root, 'runtime'));
    await fs.writeFile(path.join(root, 'runtime/vision-input.json'), JSON.stringify({ schema_version: 1, records, last_scan: { scanned_at_utc: new Date().toISOString(), errors: [], deferred: 0 } }));
    const vision = createVisionService({ root, config: { vision: { maxScanAgeSeconds: 3600 } } });
    const credentialStore = { async load() { return null; }, async save() { throw Error('Isolated browser check'); }, async remove() {} };
    const autoSource = { start() {}, stop() {}, status() { return { state: 'unconfigured', configured: false }; }, async read() { throw Error('No company connection in isolated check'); } };
    server = createPortal({ root, config: { admin: makeAdminConfig('vision-trend-check', 'Vision-trend-check-only-2026'), environmentLabel: '合成数据 · 视觉趋势验证' }, credentialStore, autoSource, inventoryService: { async capabilities() { return {}; } }, visionService: vision });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, channel: 'msedge' });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    const errors = [], externalRequests = []; let reportRequests = 0;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (new URL(request.url()).pathname === '/local/vision/report') reportRequests++; });
    await page.route('**/*', route => { if (new URL(route.request().url()).origin === origin) return route.continue(); externalRequests.push(route.request().url()); return route.abort(); });
    const pointDates = () => page.locator(selector).evaluateAll(points => points.map(point => point.dataset.visTrendDate));
    const settled = total => page.waitForFunction(expected => {
      const root = document.querySelector('#visionWorkbench');
      return root?.getAttribute('aria-busy') === 'false' && document.querySelector('#visTotal')?.textContent.replaceAll(',', '') === String(expected);
    }, total);
    const responseFor = async action => {
      const [response] = await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === '/local/vision/report' && response.status() === 200), action()]);
      const report = await response.json(); await settled(report.total); return report;
    };
    const query = async values => {
      for (const [key, value] of Object.entries(values)) {
        const ids = { start: '#visStart', end: '#visEnd', search: '#visSearch', part: '#visPart', result: '#visResult', interval: '#visInterval', recentLimit: '#visRecentLimit', recentCount: '#visRecentCount' };
        if (['part', 'result', 'interval', 'recentLimit'].includes(key)) await page.locator(ids[key]).selectOption(String(value));
        else await page.locator(ids[key]).fill(String(value));
      }
      await page.waitForFunction(() => document.querySelector('#visionWorkbench')?.getAttribute('aria-busy') === 'false');
      return responseFor(() => page.locator('#visQueryForm button[type=submit]').click());
    };
    const assertRenderedTrend = async report => {
      assert.deepEqual(await pointDates(), report.trend.points.filter(point => point.passRate !== null).map(point => point.period));
      assert.equal(report.trend.points.reduce((total, point) => total + point.totalRecords, 0), report.summary.totalRecords);
    };
    await page.goto(origin + '/#vision');
    await page.locator('#usernameInput').fill('vision-trend-check');
    await page.locator('#passwordInput').fill('Vision-trend-check-only-2026');
    await page.locator('#loginSubmit').click();
    await settled(records.length);
    assert.equal(await page.locator('#visStart').getAttribute('type'), 'datetime-local');
    assert.equal(await page.locator('#visEnd').getAttribute('type'), 'datetime-local');
    assert.equal(await page.locator('#visStart').getAttribute('step'), '60');
    assert.equal(await page.locator('#visEnd').getAttribute('step'), '60');

    let report = await query({ search: 'SYNTHETIC-DAILY-', interval: 'auto' });
    assert.equal(report.total, 30); assert.equal(report.trend.interval, 'day');
    assert.deepEqual(report.trend.points.map(point => point.passRate), [0.5, null, 1, 0.75]);
    await assertRenderedTrend(report);
    const dailyGeometry = await page.locator('#visTrendChart').evaluate(chart => ({
      points: [...chart.querySelectorAll('g[data-vis-trend-date]')].map(point => Number(point.querySelector('circle').getAttribute('cx'))),
      segments: [...chart.querySelectorAll('[data-vis-trend-segment]')].map(line => line.getAttribute('d')),
    }));
    assert.equal(dailyGeometry.segments.length, 1);
    const dailyXs = dailyGeometry.segments[0].match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi).map(Number).filter((_, i) => i % 2 === 0);
    assert.ok(dailyXs.every(x => x >= dailyGeometry.points[1] - 0.1), 'Line never bridges the null day.');
    assert.equal(await page.locator('#visTrendData').evaluate(details => details.open), false);
    assert.equal(await page.locator('#visTrendTable table').count(), 0, 'Collapsed daily data is not generated eagerly.');
    await page.locator('#visTrendData summary').click();
    await page.waitForFunction(() => document.querySelectorAll('#visTrendTable tbody tr').length === 4);
    assert.equal(await page.locator('#visTrendTable tbody tr').count(), 4);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Expanded daily table stays inside mobile page.');
    await page.locator('#visTrendData summary').click();
    await page.setViewportSize({ width: 1440, height: 1050 });

    // Start/end are minute-precision and the complete final minute is included.
    report = await query({ start: `${focusDay}T08:00`, end: `${focusDay}T08:59`, search: 'SYNTHETIC-MINUTE-', interval: '5m' });
    assert.equal(report.total, 5);
    assert.ok(report.records.some(record => record.measuredAt.endsWith('08:59:59')));
    assert.ok(!report.records.some(record => record.measuredAt.endsWith('09:00:00')));
    assert.deepEqual(report.trend.points.map(point => [point.period.slice(-5), point.totalRecords]), [['08:00', 2], ['08:05', 1], ['08:55', 2]]);
    await assertRenderedTrend(report);
    report = await query({ end: `${focusDay}T08:04` });
    assert.equal(report.total, 2); assert.ok(report.records.some(record => record.measuredAt.endsWith('08:04:59')));
    assert.equal(await page.locator(selector).count(), 1);
    assert.equal(await page.locator('[data-vis-trend-segment]').count(), 0, 'One real bucket never invents a line.');

    // Switch granularity without changing the selected records or global rate.
    const granular = { start: `${focusDay}T00:00`, end: `${focusDay}T23:59`, search: 'SYNTHETIC-GRANULAR-' };
    const bucketCounts = { '5m': 34, '15m': 12, '30m': 6, hour: 3, day: 1 };
    for (const interval of Object.keys(bucketCounts)) {
      report = await query({ ...granular, interval });
      assert.equal(report.total, 35); assert.equal(report.trend.interval, interval);
      assert.equal(report.trend.points.length, bucketCounts[interval]);
      await assertRenderedTrend(report);
    }
    report = await query({ interval: 'auto' });
    assert.equal(report.trend.interval, '15m'); assert.equal(report.trend.bucketMinutes, 15);
    assert.equal(report.trend.points.find(point => point.period.endsWith('09:15')).passRate, null);
    const nullPeriod = `${focusDay}T09:15`;
    assert.ok(!(await pointDates()).includes(nullPeriod));
    await assertRenderedTrend(report);

    // Recent N applies after the other filters; stats, curve, and pagination agree.
    report = await query({ start: '', end: '', search: 'SYNTHETIC-RECENT-', recentLimit: '500', interval: '15m' });
    assert.equal(report.selection.matchedRecords, 650); assert.equal(report.selection.selectedRecords, 500); assert.equal(report.selection.recentLimit, 500);
    assert.equal(report.total, 500); assert.equal(report.summary.totalRecords, 500);
    assert.equal(report.records[0].serialNumber, 'SYNTHETIC-RECENT-0649');
    assert.equal(report.trend.points.reduce((sum, point) => sum + point.totalRecords, 0), 500);
    assert.match(await page.locator('#visScope').innerText(), /500/);
    const retainedTrend = report.trend.points;
    const nextPage = await responseFor(() => page.locator('#visNext').click());
    assert.equal(nextPage.page, 2); assert.deepEqual(nextPage.trend.points, retainedTrend); await assertRenderedTrend(nextPage);
    report = await query({ recentLimit: 'custom', recentCount: '37' });
    assert.equal(report.total, 37); assert.equal(report.selection.matchedRecords, 650); assert.equal(report.selection.selectedRecords, 37); assert.equal(report.selection.recentLimit, 37);
    assert.equal(report.records.at(-1).serialNumber, 'SYNTHETIC-RECENT-0613');
    await assertRenderedTrend(report);
    report = await query({ result: 'NG', recentLimit: '100' });
    assert.equal(report.selection.matchedRecords, 130); assert.equal(report.total, 100);
    assert.equal(report.summary.ngRecords, 100); assert.equal(report.records[0].serialNumber, 'SYNTHETIC-RECENT-0645');
    report = await query({ recentLimit: '1000' });
    assert.equal(report.total, 130); assert.equal(report.selection.selectedRecords, 130);

    // Quick periods use the full first and last day and retain non-date filters.
    await page.locator('#visRecentLimit').selectOption('all');
    await page.locator('#visPart').selectOption('Tesla_Front12');
    await page.locator('#visResult').selectOption('NG');
    await page.locator('#visSearch').fill('SYNTHETIC-PERIOD-');
    const periods = [
      { key: 'today', start: `${days[0]}T00:00`, end: `${days[0]}T23:59`, count: 1 },
      { key: 'week', start: `${days[-6]}T00:00`, end: `${days[0]}T23:59`, count: 2 },
      { key: 'month', start: `${days[-29]}T00:00`, end: `${days[0]}T23:59`, count: 4 },
      { key: 'all', start: '', end: '', count: 6 },
    ];
    for (const period of periods) {
      report = await responseFor(() => page.locator(`#visPeriodChoices [data-vis-period="${period.key}"]`).click());
      assert.equal(report.total, period.count); assert.equal(await page.locator('#visStart').inputValue(), period.start); assert.equal(await page.locator('#visEnd').inputValue(), period.end);
      assert.equal(await page.locator('#visPart').inputValue(), 'Tesla_Front12'); assert.equal(await page.locator('#visResult').inputValue(), 'NG'); assert.equal(await page.locator('#visSearch').inputValue(), 'SYNTHETIC-PERIOD-');
    }

    report = await query({ ...granular, result: 'all', recentLimit: 'all', interval: '15m' });
    await assertRenderedTrend(report);
    await page.locator('.vis-trend').scrollIntoViewIfNeeded();
    const svg = await page.locator('#visTrendChart svg').elementHandle();
    const pointHandle = await page.locator(selector).first().elementHandle();
    const coords = await page.locator('#visTrendChart svg').evaluate(svg => {
      const matrix = svg.getScreenCTM(), box = svg.viewBox.baseVal;
      return [...svg.querySelectorAll('g[data-vis-trend-date]')].map((group, index, points) => {
        const point = svg.createSVGPoint(); point.x = Number(group.querySelector('circle').getAttribute('cx')) + (index === points.length - 1 ? -2 : 2); point.y = box.height * 0.58;
        const screen = point.matrixTransform(matrix); return { date: group.dataset.visTrendDate, x: screen.x, y: screen.y };
      });
    });
    const requestsBeforeHover = reportRequests, latency = [];
    for (const index of [0, 3, 7, 10, 2, 6, 1, 9, 4, 8, 0, 10]) {
      const target = coords[index], started = performance.now();
      await page.mouse.move(target.x, target.y);
      await page.waitForFunction(period => document.querySelector('#visTrendDetail')?.textContent.includes(period.replace('T', ' ')), target.date);
      latency.push(performance.now() - started);
      assert.equal(await svg.evaluate(node => node === document.querySelector('#visTrendChart svg')), true, 'Hover preserves the same SVG node.');
      assert.equal(await pointHandle.evaluate(node => node === document.querySelector('#visTrendChart g[data-vis-trend-date]')), true, 'Hover preserves plotted points.');
    }
    const hoverRequests = reportRequests - requestsBeforeHover;
    assert.equal(hoverRequests, 0, 'Rapid hover must not request data.');
    await page.locator('#visTrendTooltip').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#visTrendCrosshair').evaluate(line => !line.hasAttribute('hidden') && getComputedStyle(line).display !== 'none' && getComputedStyle(line).visibility !== 'hidden'), true);
    await page.locator('#visTrendSelection').waitFor({ state: 'visible' });
    await page.locator('.vis-trend').screenshot({ path: path.join(projectRoot, '预览-视觉合格率悬停.png') });
    await page.mouse.move(1, 1); await page.locator('#visTrendTooltip').waitFor({ state: 'hidden' });
    const actualPoints = await pointDates();
    const keyboardPoint = page.locator(`${selector}[data-vis-trend-date="${actualPoints[3]}"]`);
    await keyboardPoint.focus(); await keyboardPoint.press('ArrowRight');
    await page.waitForFunction(period => document.querySelector('#visTrendDetail')?.textContent.includes(period.replace('T', ' ')), actualPoints[4]);
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(period => document.querySelector('#visTrendDetail')?.textContent.includes(period.replace('T', ' ')), actualPoints[3]);
    await page.keyboard.press('Enter'); await page.keyboard.press('Space');
    assert.match(await page.locator('#visTrendDetail').innerText(), /%/);
    await page.mouse.move(1, 1); await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
    await page.screenshot({ path: path.join(projectRoot, '预览-视觉合格率.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Datetime and interval controls fit on mobile.');
    await page.locator('#visTrendData summary').click();
    await page.waitForFunction(() => document.querySelectorAll('#visTrendTable tbody tr').length === 12);
    assert.equal(await page.locator('#visTrendTable tbody tr').count(), 12);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Expanded interval data fits on mobile.');
    await page.locator('#visTrendData summary').click(); await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(projectRoot, '预览-视觉合格率手机.png'), fullPage: true });
    await page.locator('#visQueryForm').screenshot({ path: path.join(projectRoot, '预览-视觉筛选手机.png') });
    await page.locator('.vis-trend').screenshot({ path: path.join(projectRoot, '预览-视觉趋势手机.png') });
    await page.setViewportSize({ width: 320, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Datetime fields do not overflow a 320px page.');
    for (const id of ['#visStart', '#visEnd']) assert.equal(await page.locator(id).evaluate(input => { const box = input.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; }), true, 'The complete datetime input stays within the narrow viewport.');
    await page.setViewportSize({ width: 390, height: 844 });

    report = await query({ search: 'SYNTHETIC-NOT-PRESENT' });
    assert.equal(report.total, 0); assert.equal(await page.locator(selector).count(), 0); await page.locator('#visTrendEmpty').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#visTrendTooltip').isVisible(), false);
    report = await query({ search: 'SYNTHETIC-GRANULAR-' }); await assertRenderedTrend(report);
    await page.locator('#logoutButton').click(); await page.locator('#loginScreen').waitFor({ state: 'visible' });
    assert.equal(await page.locator(selector).count(), 0); assert.equal(await page.locator('#visTrendTable tbody tr').count(), 0);
    assert.equal(await page.locator('#visTrendTooltip').isVisible(), false);
    assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
    const sorted = [...latency].sort((a, b) => a - b), rounded = value => Math.round(value * 10) / 10;
    console.log(JSON.stringify({ syntheticRecords: records.length, minuteEndInclusive: true, granularities: ['auto', '5m', '15m', '30m', 'hour', 'day'], recentLimits: [500, 37, 100, 1000], recentAfterFilters: true, paginationIndependent: true, nullGap: true, lazyTrendTable: true, shortcutDays: [1, 7, 30], shortcutMinutes: ['00:00', '23:59'], keyboard: ['ArrowLeft', 'ArrowRight', 'Enter', 'Space'], hover: { samples: latency.length, p50Ms: rounded(sorted[Math.floor(sorted.length / 2)]), p95Ms: rounded(sorted[Math.ceil(sorted.length * 0.95) - 1]), maxMs: rounded(sorted.at(-1)), additionalRequests: hoverRequests, svgRebuilt: false }, mobileWidthsWithoutOverflow: [390, 320], emptyAndLogoutClear: true, pageErrors: errors, externalRequests, screenshots: ['预览-视觉合格率.png', '预览-视觉合格率手机.png', '预览-视觉合格率悬停.png', '预览-视觉筛选手机.png', '预览-视觉趋势手机.png'] }));
  } finally {
    if (browser) await browser.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== tempBase || !path.basename(resolved).startsWith('gongyi-vision-trend-')) throw Error('Refusing cleanup outside the expected temporary directory.');
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
