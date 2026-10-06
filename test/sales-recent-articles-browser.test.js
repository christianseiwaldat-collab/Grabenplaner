'use strict';
// Synthetic personal-history requests in an actual browser, without GP data.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.join(__dirname,'..');
test('recent window protects hydration, decimal sorting, navigation and account boundaries',
 {skip:process.env.GP_WINDOW_BROWSER_TEST!=='1',timeout:60000},async()=>{
 const {chromium}=require(process.env.GP_BROWSER_TEST_MODULE || 'playwright');
 const browser=await chromium.launch({headless:true,...(process.env.GP_BROWSER_EXECUTABLE?{executablePath:process.env.GP_BROWSER_EXECUTABLE}:{}),args:['--no-first-run']});
 const errors=[];
 try {
  const page=await browser.newPage({viewport:{width:1400,height:1000}});page.setDefaultTimeout(8000);page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>route.abort());
  await page.setContent('<button id="dock">Letzte Artikel</button>');
  for(const file of ['gp-window.css','sales-recent-articles.css'])await page.addStyleTag({path:path.join(root,'public',file)});
  for(const file of ['gp-window-preferences.js','gp-window.js','table-layout.js','sales-recent-articles.js'])await page.addScriptTag({path:path.join(root,'public',file)});
  await page.evaluate(()=>{
   window.actor='A';window.currentView=true;window.reads=[];window.puts=[];window.posts=[];window.opened=[];window.slowWrites=false;
   window.geometryPreferences={activate:async()=>{},value:{windows:{'articles:recent':{x:100,y:120,width:680,height:430,minimized:false}}},change:async()=>{}};
   window.recent=SalesRecentArticles.mount({dock:document.querySelector('#dock'),key:()=>actor,canUse:()=>Boolean(actor),active:()=>currentView,
    columns:()=>[{id:'articleNumber',label:'Artikelnummer'},{id:'description',label:'Bezeichnung'},{id:'retailGross',label:'Preis',price:true},{id:'primaryIdentifier',label:'EAN'}],
    windowPreferences:geometryPreferences,openArticle:number=>opened.push(number),api:async(url,options={})=>{
     if(options.method==='PUT'){const request={body:JSON.parse(options.body),signal:options.signal};puts.push(request);if(slowWrites)return new Promise(resolve=>request.resolve=resolve);return {};}
     if(options.method==='POST'){posts.push(JSON.parse(options.body));return {};}
     return new Promise(resolve=>reads.push({resolve,signal:options.signal}));}});
   window.aData={articles:[{articleNumber:'2',description:'A second',retailGross:'9.1',primaryIdentifier:'EAN-2'},{articleNumber:'1',description:'A <img src="invalid"> first',retailGross:'9.05',primaryIdentifier:'EAN-1'}],
    preferences:{columns:['articleNumber','description','primaryIdentifier'],columnWidths:{description:310,primaryIdentifier:120},sort:'recent',direction:'asc'}};
  });
  await page.evaluate(()=>recent.show());await page.waitForFunction(()=>reads.length===1);
  assert.equal(await page.locator('[data-recent-column="description"]').isDisabled(),true);
  await page.evaluate(()=>{const field=document.querySelector('[data-recent-column="description"]');field.checked=false;field.dispatchEvent(new Event('change',{bubbles:true}));});
  assert.equal(await page.evaluate(()=>puts.length),0);await page.evaluate(()=>reads[0].resolve(aData));await page.waitForFunction(()=>document.querySelectorAll('tbody tr').length===2);
  assert.equal(await page.locator('[data-recent-column="description"]').isDisabled(),false);assert.equal(await page.locator('.sales-recent-articles img').count(),0);
  await page.locator('[data-recent-body] details summary').click();await page.locator('[data-recent-column="retailGross"]').check();await page.waitForFunction(()=>puts.length===1);
  assert.equal(await page.evaluate(()=>puts[0].body.columnWidths.description),310);
  await page.locator('[data-recent-sort="retailGross"]').click();assert.equal(await page.locator('tbody tr').first().getAttribute('data-recent-open'),'1');
  assert.equal(await page.locator('th:has([data-recent-sort="retailGross"])').getAttribute('aria-sort'),'ascending');
  await page.locator('[data-recent-order]').click();assert.equal(await page.locator('tbody tr').first().getAttribute('data-recent-open'),'2');
  await page.locator('tbody tr').first().locator('td').nth(1).click();assert.deepEqual(await page.evaluate(()=>opened),['2']);
  await page.locator('[data-recent-min]').click();assert.equal(await page.locator('[data-recent-body]').isVisible(),false);
  await page.evaluate(()=>{currentView=false;recent.suspend();return recent.record('3');});assert.equal(await page.evaluate(()=>reads.length),1);
  await page.evaluate(()=>{currentView=true;recent.sync();});await page.waitForFunction(()=>reads.length===2);assert.equal(await page.locator('[data-recent-body]').isVisible(),false);
  await page.evaluate(()=>reads[1].resolve(aData));await page.locator('[data-recent-min]').click();
  await page.evaluate(()=>{slowWrites=true;});await page.locator('[data-recent-sort="description"]').click();await page.waitForFunction(()=>puts.some(value=>value.resolve));
  await page.evaluate(()=>{actor='B';geometryPreferences.value.windows['articles:recent']={x:20,y:40,width:500,height:350,minimized:false};recent.sync();});
  assert.equal(await page.locator('tbody tr').count(),0);assert.equal(await page.evaluate(()=>puts.find(value=>value.resolve).signal.aborted),true);
  await page.evaluate(()=>recent.show());await page.waitForFunction(()=>reads.length===3);assert.equal(await page.locator('tbody tr').count(),0);
  assert.equal(await page.locator('[data-recent-column="description"]').isDisabled(),true);assert.equal(await page.locator('.sales-recent-articles').evaluate(node=>parseInt(node.style.width)),500);
  await page.evaluate(()=>{puts.find(value=>value.resolve).resolve({});reads[2].resolve({articles:[{articleNumber:'B',description:'Own account'}],preferences:{columns:['articleNumber','description'],columnWidths:{},sort:'recent'}});});
  await page.waitForFunction(()=>document.querySelector('tbody')?.textContent.includes('Own account'));
  assert.equal(await page.locator('tbody').textContent(),'BOwn account');
  await page.evaluate(()=>{recent.destroy();return recent.record('after-destroy');});assert.equal(await page.locator('.sales-recent-articles').count(),0);assert.equal(await page.evaluate(()=>posts.length),1);
  await page.evaluate(async()=>{const sidebar=document.createElement('aside');sidebar.id='mainSidebar';sidebar.style.cssText='position:fixed;left:0;top:0;width:240px;height:600px';document.body.append(sidebar);geometryPreferences.value={windows:{}};window.freshRecent=SalesRecentArticles.mount({dock:document.querySelector('#dock'),key:()=>actor,canUse:()=>true,active:()=>true,columns:()=>[{id:'articleNumber',label:'Artikelnummer'}],windowPreferences:geometryPreferences,api:async()=>({articles:[],preferences:{columns:['articleNumber'],sort:'recent'}}),openArticle:()=>{}});await freshRecent.show();});
  assert.equal(await page.locator('.sales-recent-articles').evaluate(node=>parseInt(node.style.left)),264);await page.evaluate(()=>freshRecent.destroy());
  assert.deepEqual(errors,[]);
 } finally {await browser.close();}
});
