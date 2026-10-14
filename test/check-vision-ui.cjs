'use strict';
// Run against preview-vision.cjs, not a production login. Optional sample CSV.
const {chromium}=require(process.env.VISION_PLAYWRIGHT_PATH||'playwright');
const assert=require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch({headless:true,channel:'msedge'});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(process.argv[2]);
    await page.locator('#usernameInput').fill('vision-preview');
    await page.locator('#passwordInput').fill('Vision-preview-only-2026');
    await page.locator('#loginSubmit').click();
    await page.waitForFunction(()=>document.querySelector('#visTotal')?.textContent==='1');
    assert.equal(await page.locator('#pageTitle').innerText(),'视觉检具');
    assert.equal(await page.locator('#visOK').innerText(),'1');
    assert.match(await page.locator('#visSourceMessage').innerText(),/手动导入/);
    await page.screenshot({path:'预览-视觉检具.png',fullPage:true});
    await page.locator('[data-vision-detail]').click();
    await page.locator('#visDetailBody tbody tr').last().waitFor();
    assert.equal(await page.locator('#visDetailBody tbody tr').count(),61);
    await page.locator('#visCloseDetail').click();
    await page.locator('#visResult').selectOption('NG');
    await page.locator('#visQueryForm button[type=submit]').click();
    await page.waitForFunction(()=>document.querySelector('#visTotal').textContent==='0');
    await page.locator('#visReset').click();
    await page.waitForFunction(()=>document.querySelector('#visTotal').textContent==='1');
    if(process.argv[3]){
      await page.locator('#visImportPanel summary').click();
      await page.locator('#visFile').setInputFiles(process.argv[3]);
      await page.locator('#visImportButton').click();
      await page.waitForFunction(()=>document.querySelector('#visImportMessage').textContent.includes('重复 1 条'));
      assert.equal(await page.locator('#visTotal').innerText(),'1');
      await page.locator('#visImportPanel summary').click();
    }
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:'预览-视觉检具手机.png',fullPage:true});
    await page.locator('[data-vision-detail]').click();
    await page.locator('#visDetailBody tbody tr').last().waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.locator('#visCloseDetail').click();
    await page.locator('#logoutButton').click();
    await page.locator('#loginScreen').waitFor({state:'visible'});
    assert.equal(await page.locator('#visTable').innerText(),'等待读取检测记录。');
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({login:true,report:true,detailItems:61,filter:true,duplicateImport:Boolean(process.argv[3]),mobileNoOverflow:true,logoutClearsData:true,pageErrors:errors}));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
