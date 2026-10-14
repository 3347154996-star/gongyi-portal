'use strict';
// Isolated catalog UI checks. A draft stores metadata only; its path is never read.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { chromium } = require(process.env.VISION_PLAYWRIGHT_PATH || 'playwright');
const { createPortal } = require('../server.cjs');
const { makeAdminConfig } = require('../lib/admin.cjs');
const { createVisionService, parseCsv } = require('../lib/vision.cjs');
const password = 'Vision-catalog-check-only-2026';
const draftId = 'rear-synthetic-02', draftLine = '合成后副线', draftName = '合成后副检具';
const initialNotes = '仅登记合成测试，尚未接入采集。\n第二行：等待格式适配。\n\n第四行：待验收。';
const editedNotes = '修订备注，仍未连接现场。\n第二行：共享地址待确认。';
const projectRoot = path.resolve(__dirname, '..');
function sample() {
  const rows = [
    ['PartName', 'Tesla_Front12', '', '', '', '', ''], ['SN', 'SYNTHETIC-CATALOG-CURRENT-001', '', '', '', '', ''],
    ['TimeStamp', '2026/10/14 08:00:00', '', '', '', '', ''], ['Result', 'OK', '', '', '', '', ''],
    ['Name', 'Nominal', 'Lower_SL', 'Upper_SL', 'IsCritical', 'Dev', 'OK/NG'],
    ...Array.from({ length: 61 }, (_, i) => [`合成测点_${i + 1}`, '10', '-0.5', '0.5', i < 59 ? 'Yes' : 'No', '0.1', 'OK']),
  ];
  return parseCsv({ filename: 'Tesla_Front12_20261014-080000.csv', deviceId: 'vision-01', content: rows.map(row => row.join(',')).join('\r\n') + '\r\n' });
}
async function main() {
  const tempBase = path.resolve(os.tmpdir()), root = await fs.mkdtemp(path.join(tempBase, 'gongyi-vision-catalog-ui-'));
  let server, browser;
  try {
    await fs.mkdir(path.join(root, 'runtime'));
    await fs.writeFile(path.join(root, 'runtime/vision-input.json'), JSON.stringify({ schema_version: 1, records: [sample()], last_scan: { scanned_at_utc: new Date().toISOString(), errors: [], deferred: 0 } }));
    const vision = createVisionService({ root });
    const credentialStore = { async load() { return null; }, async save() { throw Error('Isolated check only'); }, async remove() {} };
    const autoSource = { start() {}, stop() {}, status() { return { state: 'unconfigured', configured: false }; }, async read() { throw Error('No company connection in isolated check'); } };
    server = createPortal({ root, config: { admin: makeAdminConfig('catalog-admin', password), environmentLabel: '合成数据 · 多线体台账验证' }, credentialStore, autoSource, inventoryService: { async capabilities() { return {}; } }, visionService: vision });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const adminLogin = await fetch(origin + '/local/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'catalog-admin', password }) });
    assert.equal(adminLogin.status, 200);
    const adminCookie = adminLogin.headers.get('set-cookie').split(';')[0];
    const memberCreated = await fetch(origin + '/local/members', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: JSON.stringify({ account: 'catalog-member', name: '合成普通成员', role: 'member', active: true, password, createOnly: true }) });
    assert.equal(memberCreated.status, 200);
    browser = await chromium.launch({ headless: true, channel: 'msedge' });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
    const page = await context.newPage(), errors = [], externalRequests = [];
    context.on('page', newPage => newPage.on('pageerror', error => errors.push(error.message)));
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => { if (new URL(route.request().url()).origin === origin) return route.continue(); externalRequests.push(route.request().url()); return route.abort(); });
    const login = async account => { await page.locator('#usernameInput').fill(account); await page.locator('#passwordInput').fill(password); await page.locator('#loginSubmit').click(); await page.locator('#appShell').waitFor({ state: 'visible' }); };
    const settled = total => page.waitForFunction(value => {
      const pending = document.querySelector('#visPendingNotice');
      const expected = value === 0 && pending && !pending.hidden ? '—' : String(value);
      return document.querySelector('#visionWorkbench')?.getAttribute('aria-busy') === 'false' && document.querySelector('#visTotal')?.textContent === expected;
    }, total);
    const responseFor = (pathname, method) => page.waitForResponse(response => new URL(response.url()).pathname === pathname && response.request().method() === method && response.status() === 200);
    const selectCard = async (id, total) => {
      const device = (await vision.catalog()).devices.find(row => row.id === id), line = await page.locator('#visLineSelect').inputValue();
      if (line !== 'all' && line !== device.lineId) await page.locator('#visLineSelect').selectOption(device.lineId);
      await page.locator(`[data-vis-device="${id}"]`).click(); await page.waitForFunction(value => document.querySelector('#visDeviceSelect')?.value === value, id); await settled(total);
    };

    await page.goto(origin + '/#vision'); await login('catalog-admin'); await settled(1);
    await page.locator('[data-vis-device="vision-01"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#visAddDevice').isVisible(), true);
    assert.equal(await page.locator('#visLineSelect').inputValue(), 'all');
    assert.equal(await page.locator('#visDeviceSelect').inputValue(), 'all');
    await selectCard('vision-01', 1);
    assert.equal(await page.locator('#visTable tbody tr').count(), 1);
    assert.equal(await page.locator('#visImportPanel').isVisible(), true);

    const guideLink = page.locator('#visGuideLink');
    assert.equal(await guideLink.getAttribute('href'), '/vision-connection-guide.html');
    let guide;
    if ((await guideLink.getAttribute('target')) === '_blank') {
      const opened = context.waitForEvent('page'); await guideLink.click(); guide = await opened;
      await guide.waitForLoadState('domcontentloaded');
      assert.match(await guide.locator('body').innerText(), /视觉检具/); assert.match(await guide.locator('body').innerText(), /连接|接入/);
      await guide.close();
    } else {
      await guideLink.click(); await page.waitForURL('**/vision-connection-guide.html');
      assert.match(await page.locator('body').innerText(), /视觉检具/); await page.goBack(); await settled(1);
    }

    await page.locator('#visAddDevice').click(); await page.locator('#visDeviceDialog').waitFor({ state: 'visible' });
    await page.locator('#visDraftLine').selectOption('new'); await page.locator('#visDraftLineName').fill(draftLine);
    await page.locator('#visDraftName').fill(draftName); await page.locator('#visDraftId').fill(draftId);
    await page.locator('#visDraftTransport').selectOption('share'); await page.locator('#visDraftPath').fill('D:\\SyntheticOnly\\rear.json');
    await page.locator('#visDraftParts').fill('Synthetic_RearA, Synthetic_RearB'); await page.locator('#visDraftCount').fill('42');
    await page.locator('#visDraftNotes').fill(initialNotes);
    await page.locator('#visDeviceDialog').screenshot({ path: path.join(projectRoot, '预览-视觉检具登记.png') });
    const saveResponse = responseFor('/local/vision/catalog', 'POST'); await page.locator('#visSaveDevice').click();
    const saved = await (await saveResponse).json(); assert.equal(saved.device.status, 'pending'); assert.equal(saved.device.id, draftId);
    assert.equal(saved.device.notes, initialNotes);
    await page.locator('#visDeviceDialog').waitFor({ state: 'hidden' }); await settled(0);
    assert.equal(await page.locator('#visDeviceSelect').inputValue(), draftId);
    assert.equal(await page.locator('#visLineSelect').inputValue(), saved.device.lineId);
    await page.locator('#visPendingNotice').waitFor({ state: 'visible' });
    assert.match(await page.locator('#visPendingNotice').innerText(), /待配置|尚未|未接入/);
    assert.equal(await page.locator('#visImportPanel').isVisible(), false);
    assert.equal(await page.locator('#visTable tbody tr').count(), 0);
    assert.equal(await page.locator('#visTrendChart [data-vis-trend-date]').count(), 0);
    assert.equal((await vision.report({ lineId: saved.device.lineId, deviceId: draftId })).source.state, 'pending');
    assert.ok(!(await page.locator('#visionWorkbench').innerText()).includes('SYNTHETIC-CATALOG-CURRENT-001'), 'Pending device must not reveal the existing device record.');

    // Pending metadata can change without becoming an active source.
    await page.locator(`[data-vis-edit-device="${draftId}"]`).click(); await page.locator('#visDeviceDialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#visDraftId').inputValue(), draftId);
    assert.equal(await page.locator('#visDraftNotes').inputValue(), initialNotes, 'Multiline notes round-trip into the edit form.');
    await page.locator('#visDraftName').fill('合成后副检具（修订）'); await page.locator('#visDraftNotes').fill(editedNotes);
    const editedResponse = responseFor('/local/vision/catalog', 'POST'); await page.locator('#visSaveDevice').click();
    const edited = await (await editedResponse).json(); assert.equal(edited.device.status, 'pending'); assert.equal(edited.device.notes, editedNotes);
    await page.locator('#visDeviceDialog').waitFor({ state: 'hidden' }); await settled(0);
    let catalog = await vision.catalog(); assert.equal(catalog.devices.find(device => device.id === draftId).name, '合成后副检具（修订）');
    await page.reload(); await page.locator(`[data-vis-device="${draftId}"]`).waitFor({ state: 'visible' });
    await selectCard(draftId, 0); assert.match(await page.locator(`[data-vis-device="${draftId}"]`).innerText(), /修订/);
    const restartedCatalog = await createVisionService({ root }).catalog(); assert.equal(restartedCatalog.devices.find(device => device.id === draftId).status, 'pending');
    assert.equal(restartedCatalog.devices.find(device => device.id === draftId).notes, editedNotes);
    await page.locator('#visLineSelect').selectOption('all');
    await page.locator('[data-vis-device="vision-01"]').waitFor({ state: 'visible' });
    await page.locator('#visFleetCards').locator('..').screenshot({ path: path.join(projectRoot, '预览-视觉多线体.png') });
    await selectCard('vision-01', 1);
    assert.equal(await page.locator('#visPendingNotice').isVisible(), false);
    assert.equal(await page.locator('#visTable tbody tr').count(), 1); assert.equal(await page.locator('#visOK').innerText(), '1');
    assert.equal(await page.locator('#visImportPanel').isVisible(), true);

    // A pending card remains clickable while a report is loading. An invalid date
    // range must not let that old report repopulate the newly selected device.
    await page.locator('#visLineSelect').selectOption('all'); await settled(1);
    let holdReady, releaseOld, completeOld, failOld;
    const oldReady = new Promise(resolve => { holdReady = resolve; });
    const oldGate = new Promise(resolve => { releaseOld = resolve; });
    const oldDone = new Promise((resolve, reject) => { completeOld = resolve; failOld = reject; });
    await page.route('**/local/vision/report?*', async route => {
      try {
        const response = await route.fetch();
        holdReady(await response.json()); await oldGate;
        await route.fulfill({ response }); completeOld();
      } catch (error) { failOld(error); }
    }, { times: 1 });
    await page.locator('#visRefresh').click();
    const heldReport = await oldReady;
    assert.equal(heldReport.records[0].serialNumber, 'SYNTHETIC-CATALOG-CURRENT-001');
    try {
      assert.equal(await page.locator('#visLineSelect').isDisabled(), true);
      await page.locator('#visStart').fill('2026-10-15T08:00');
      await page.locator('#visEnd').fill('2026-10-14T08:00');
      await page.locator(`[data-vis-device="${draftId}"]`).click();
      await page.locator('#visPendingNotice').waitFor({ state: 'visible' });
      assert.match(await page.locator('#visError').innerText(), /开始时间不能晚于结束时间/);
    } finally { releaseOld(); }
    await oldDone;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await settled(0);
    assert.equal(await page.locator('#visDeviceSelect').inputValue(), draftId);
    assert.equal(await page.locator('#visTable tbody tr').count(), 0, 'A late previous report cannot leak records into the pending selection.');
    assert.equal(await page.locator('#visTrendChart [data-vis-trend-date]').count(), 0);
    assert.equal(await page.locator('#visTotal').innerText(), '—');
    assert.ok(!(await page.locator('#visionWorkbench').innerText()).includes('SYNTHETIC-CATALOG-CURRENT-001'));
    const correctedResponse = responseFor('/local/vision/report', 'GET');
    await page.locator('[data-vis-period="all"]').click();
    assert.equal((await (await correctedResponse).json()).source.state, 'pending'); await settled(0);
    await selectCard('vision-01', 1);

    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator('#visLineSelect').selectOption('all');
    await page.locator(`[data-vis-device="${draftId}"]`).waitFor({ state: 'visible' });
    // Keep the full narrow-width section visible so the fixed header does not cover the element capture.
    await page.setViewportSize({ width: 390, height: 1700 }); await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('#visFleetCards').locator('..').screenshot({ path: path.join(projectRoot, '预览-视觉多线体手机.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(`[data-vis-edit-device="${draftId}"]`).click(); await page.locator('#visDeviceDialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#visDraftNotes').inputValue(), editedNotes, 'Edited multiline notes survive page reload.');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator('#visDeviceClose').click();
    await page.locator('#logoutButton').click(); await page.locator('#loginScreen').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-vis-device]').count(), 0, 'Logout clears catalog cards.');
    assert.equal(await page.locator('#visTable tbody tr').count(), 0, 'Logout clears detection data.');
    assert.equal(await page.locator('#visDeviceDialog').isVisible(), false);

    // A separate member login retains persisted metadata but cannot edit it.
    await login('catalog-member'); await page.locator(`[data-vis-device="${draftId}"]`).waitFor({ state: 'visible' });
    assert.equal(await page.locator('#visAddDevice').isVisible(), false);
    assert.equal(await page.locator('[data-vis-edit-device]:visible').count(), 0);
    const denied = await page.evaluate(async () => { const response = await fetch('/local/vision/catalog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: 'member-must-not-save', name: '禁止写入' }) }); return response.status; });
    assert.equal(denied, 403);
    await selectCard(draftId, 0); await page.locator('#visPendingNotice').waitFor({ state: 'visible' });
    await selectCard('vision-01', 1);
    catalog = await vision.catalog(); assert.equal(catalog.devices.some(device => device.id === 'member-must-not-save'), false);
    assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
    console.log(JSON.stringify({ initialDevice: 'vision-01', newLineAndDevice: 'pending', pendingHasNoOtherDeviceData: true, invalidFilterLateReportIsolated: true, editPending: true, multilineNotesRoundTrip: true, persistedAcrossReloadAndLogin: true, configuredDataRestored: true, mobileNoOverflow: true, memberAddAndEditHidden: true, memberPostStatus: denied, guideReadable: true, logoutClearsPrivateState: true, pageErrors: errors, externalRequests, screenshots: ['预览-视觉多线体.png', '预览-视觉检具登记.png', '预览-视觉多线体手机.png'] }));
  } finally {
    if (browser) await browser.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    const resolved = path.resolve(root); if (path.dirname(resolved) !== tempBase || !path.basename(resolved).startsWith('gongyi-vision-catalog-ui-')) throw Error('Refusing cleanup outside the expected temporary directory.');
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
