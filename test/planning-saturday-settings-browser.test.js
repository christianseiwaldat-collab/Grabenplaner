"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {createSalesReportLibraryPreview}=require('../test-support/sales-report-library-preview.cjs');
test('all three real planning controls synchronize by location; the weekly example is 32/34 and local preview remains responsive',{
 skip:process.env.GP_SALES_ANALYTICS_BROWSER_TEST!=='1',timeout:45000
},async t=>{
 const preview=createSalesReportLibraryPreview(),server=preview.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
 const {chromium}=require(process.env.GP_BROWSER_TEST_MODULE||'playwright'),browser=await chromium.launch({headless:true,executablePath:process.env.GP_BROWSER_EXECUTABLE});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1500,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(8000);
 await page.goto('http://127.0.0.1:'+server.address().port+'/planning');
 const ready=()=>page.waitForFunction(()=>[...document.querySelectorAll('[data-saturday-planning]')].every(c=>!c.disabled));await ready();
 assert.equal(await page.locator('[data-saturday-planning]:checked').count(),3);assert.match(await page.locator('#hoursOverview').innerText(),/32 Stunden[\s\S]*34 Stunden/);
 for(const name of ['schedule','settings','editor']) {
  await page.locator('[data-saturday-planning="'+name+'"]').uncheck();await ready();assert.equal(await page.locator('[data-saturday-planning]:checked').count(),0);assert.equal(preview.snapshot().planning['18'],false);assert.doesNotMatch(await page.locator('#hoursOverview').innerText(),/34 Stunden/);
  await page.locator('[data-saturday-planning="'+name+'"]').check();await ready();assert.equal(await page.locator('[data-saturday-planning]:checked').count(),3);assert.equal(preview.snapshot().planning['18'],true);
 }
 await page.locator('[data-saturday-planning="schedule"]').uncheck();await ready();await page.locator('#previewLocation').selectOption('05');await page.waitForFunction(()=>document.querySelector('[data-saturday-planning]').dataset.locationId==='05');await ready();assert.equal(await page.locator('[data-saturday-planning]:checked').count(),3);
 await page.locator('#previewLocation').selectOption('18');await page.waitForFunction(()=>document.querySelector('[data-saturday-planning]').dataset.locationId==='18');await ready();assert.equal(await page.locator('[data-saturday-planning]:checked').count(),0);
 await page.locator('[data-saturday-planning="settings"]').check();await ready();
 if(process.env.GP_SALES_ANALYTICS_SCREENSHOTS){fs.mkdirSync(process.env.GP_SALES_ANALYTICS_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.GP_SALES_ANALYTICS_SCREENSHOTS,'13-planning-saturday-synchronized.png'),fullPage:true});}
 await page.route('**/api/portal/v1/planning-saturday-settings/18',route=>route.request().method()==='PUT'?route.fulfill({status:503,body:'Unavailable'}):route.continue());
 await page.locator('[data-saturday-planning="schedule"]').uncheck();await ready();assert.equal(await page.locator('[data-saturday-planning]:checked').count(),3);assert.equal(preview.snapshot().planning['18'],true);assert.match(await page.locator('#previewError').innerText(),/nicht gespeichert/);
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
});
