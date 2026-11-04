'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createPreview}=require('../test-support/report-design-preview.cjs');
test('GP chart design, article price visibility and PDF choices work in the real browser components',{
 skip:process.env.GP_REPORT_DESIGN_BROWSER_TEST!=='1',timeout:90000,
},async t=>{
 const f=createPreview(),server=f.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>{server.closeAllConnections();server.close();});
 const{chromium}=require(process.env.GP_BROWSER_TEST_MODULE||'playwright'),browser=await chromium.launch({headless:true,...(process.env.GP_BROWSER_EXECUTABLE?{executablePath:process.env.GP_BROWSER_EXECUTABLE}:{}),args:['--no-first-run']});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1600,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const url='http://127.0.0.1:'+server.address().port,shots=process.env.GP_REPORT_DESIGN_SCREENSHOTS;
 const shot=async name=>{if(shots){fs.mkdirSync(shots,{recursive:true});await page.mouse.move(1550,20);await page.screenshot({path:path.join(shots,name),fullPage:false});}};
 await page.goto(url+'/reports');await page.waitForFunction(()=>document.querySelector('#salesReportJobSubmit')?.disabled===false);
 await page.locator('#salesReportJobMetrics input[value=grossMargin]').check();await page.locator('#salesAnalyticsRequestQuery').fill('Oktober · Umsatz und Rohertrag');
 await page.locator('#salesReportJobChartType').evaluate(e=>e.closest('details').open=true);await page.getByRole('button',{name:'Diagramme gestalten …'}).click();
 const win=page.locator('[data-chart-design-window]');await win.waitFor({state:'visible'});await win.locator('[name=annotation][value=grossMargin]').check();await win.locator('[name=showAbsolute]').check();
 await win.locator('[name=backgroundColor]').fill('#102a24');assert.equal(await win.locator('[data-design-preview] text').first().getAttribute('fill'),'#f1f7f4');await win.locator('[name=backgroundColor]').fill('#ffffff');
 await shot('01-Diagramme-GP-Fenster.png');await win.locator('[data-design-apply]').click();await win.waitFor({state:'hidden'});
 await page.locator('#salesReportTemplateSave').click();await page.waitForFunction(()=>document.querySelector('#salesReportTemplateTitle').textContent.includes('Vorlage:'));
 assert.equal(f.templates[0].query.chartDesign.corners,'rounded');assert.deepEqual(f.templates[0].query.chartDesign.annotations,['grossMargin']);
 await page.getByRole('button',{name:'Diagramme gestalten …'}).click();await win.locator('[name=corners]').selectOption('square');await win.locator('[name=showComparison]').uncheck();await win.locator('[data-design-close]').click();await win.waitFor({state:'hidden'});
 await page.getByRole('button',{name:'Diagramme gestalten …'}).click();assert.equal(await win.locator('[name=corners]').inputValue(),'rounded','cancelled edits do not replace saved choices');await win.locator('[data-design-close]').click();
 await page.goto(url+'/article');await page.waitForFunction(()=>document.querySelector('[data-master-prices]')?.disabled===false);
 const master=page.locator('[data-master-prices]');await master.uncheck();assert.equal(await page.locator('.article-overview-price:visible').count(),0);await page.reload();await page.waitForFunction(()=>document.querySelector('[data-master-prices]')?.disabled===false);assert.equal(await page.locator('[data-master-prices]').isChecked(),false);await page.locator('[data-master-prices]').check();
 await page.locator('#salesArticlePdfButton').click();const pdf=page.locator('[data-gp-print-id=article-sheet-pdf]');await pdf.waitFor({state:'visible'});
 await page.waitForFunction(()=>document.querySelector('[data-gp-print-id=article-sheet-pdf] [data-gp-print-download]')?.disabled===false);
 assert.equal(await pdf.locator('[name=section][value=prices]').isChecked(),false);assert.equal(await pdf.locator('[name=section][value=master]').isChecked(),true);
 await pdf.locator('[name=sheetLayout]').selectOption('editorial');await pdf.locator('[name=sheetAccent]').fill('#2463b5');
 await page.waitForFunction(()=>document.querySelector('[data-gp-print-id=article-sheet-pdf] [data-gp-print-download]')?.disabled===false);
 await pdf.locator('[data-gp-print-form]').evaluate(e=>{e.scrollTop=0;});await shot('02-Artikelstamm-PDF-ohne-Preise.png');
 await pdf.locator('[data-sheet-preset=sales]').click();await page.waitForFunction(()=>document.querySelector('[data-gp-print-id=article-sheet-pdf] [data-gp-print-download]')?.disabled===false);
 assert.equal(await pdf.locator('[name=section][value=prices]').isChecked(),true);assert.equal(await pdf.locator('[name=pricePart][value=purchase]').isChecked(),false);
 await shot('03-Artikel-PDF-mit-VK-Preisen.png');await pdf.locator('[data-gp-print-close]').click();
 assert.equal(errors.length,0,errors.join('\n'));
});
