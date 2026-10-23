'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..'),GiB=1024**3;
const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
const dialog=html.match(/<dialog id="vpsStorageDialog"[\s\S]*?<\/dialog>/)[0];
const report={available:true,canWrite:true,checkedAt:'2026-10-13T16:00:00.000Z',settings:{warningGiB:5,orphanAgeDays:7},
 disk:{freeBytes:53*GiB,totalBytes:96*GiB,usedBytes:40*GiB,reservedBytes:3*GiB},categories:[{label:'PostgreSQL-Daten',bytes:18*GiB},{label:'Lokale Sicherungen',bytes:14*GiB}],
 host:{system:'Linux',release:'synthetic',cpuCount:4,uptimeSeconds:86400,memoryTotalBytes:8*GiB},databases:[{domain:'core',bytes:.2*GiB},{domain:'sales',bytes:17.8*GiB}],relations:[{schema:'integration',name:'data_import_rows',totalBytes:5*GiB,dataBytes:3*GiB,indexBytes:2*GiB}],indexBytes:5.5*GiB,identityLinkBytes:2.2*GiB,
 backups:{keepCount:2,unknownCount:1,points:[{createdAt:'2026-10-13T15:00:00.000Z',bytes:7*GiB},{createdAt:'2026-10-13T06:00:00.000Z',bytes:7*GiB}],candidates:[{name:'00000000-0000-4000-8000-000000000001.pair',bytes:7*GiB,modifiedAt:'2026-09-01T12:00:00.000Z'}],planSha256:'a'.repeat(64),canCleanup:true},
 recovery:{requiredBytes:30*GiB,temporaryBytes:14*GiB,restoreMarginBytes:9*GiB,warning:false},
 imports:{pairs:[{label:'Trade_Daten.accdb',createdAt:'2026-09-01T12:00:00.000Z',successorCreatedAt:'2026-10-01T12:00:00.000Z',rows:100}],blocked:[],rows:100,changes:100,planSha256:'b'.repeat(64),canRetire:true},operation:{phase:'complete'}};
test('VPS storage uses a movable GP window; cleanup is preview-bound; mobile content stays within the viewport',
 {skip:process.env.GP_WINDOW_BROWSER_TEST!=='1',timeout:60000},async()=>{
 const {chromium}=require(process.env.GP_BROWSER_TEST_MODULE||'playwright');
 const browser=await chromium.launch({headless:true,...(process.env.GP_BROWSER_EXECUTABLE?{executablePath:process.env.GP_BROWSER_EXECUTABLE}:{}),args:['--no-first-run']});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(8000);
  await page.route('**/*',route=>route.abort());
  await page.setContent('<button id="openVpsStorage">VPS-Speicher öffnen</button><button id="background">Hintergrund</button>'+dialog);
  for(const file of ['styles.css','gp-window.css','vps-storage.css'])await page.addStyleTag({path:path.join(root,'public',file)});
  await page.addStyleTag({content:'body{zoom:1;margin:0;display:block}#openVpsStorage,#background{position:relative;z-index:0}'});
  for(const file of ['gp-window-preferences.js','gp-window.js','vps-storage.js'])await page.addScriptTag({path:path.join(root,'public',file)});
  await page.evaluate(report=>{
   window.actor='synthetic-A';window.calls=[];window.fixtureReport=report;
   window.manager=GpWindow.installDocument(document,{actorKey:()=>actor,canUse:()=>Boolean(actor),readPreferences:async()=>({gpWindows:{version:1,windows:{}}}),writePreferences:async()=>{}});
   window.storage=VpsStorage.mount({opener:document.getElementById('openVpsStorage'),dialog:document.getElementById('vpsStorageDialog'),key:()=>actor,canUse:()=>Boolean(actor),api:async(url,options={})=>{
    calls.push({url,...options});if(options.method)return {ok:true};
    if(window.deferRead)return new Promise(resolve=>window.completeRead=()=>resolve(structuredClone(fixtureReport)));
    return structuredClone(fixtureReport);
   }});
  },report);
  await page.locator('#openVpsStorage').click();
  await page.locator('.vps-storage-metrics strong').first().waitFor();
  assert.equal(await page.locator('#vpsStorageDialog').evaluate(node=>node.matches(':modal')),false);
  assert.equal(await page.locator('#vpsStorageDialog [data-gp-window-edge]').count(),8);
  await page.locator('#background').click();
  const beforeMove=await page.locator('#vpsStorageDialog').boundingBox(),title=await page.locator('#vpsStorageDialog [data-gp-window-title]').boundingBox();
  await page.mouse.move(title.x+90,title.y+20);await page.mouse.down();await page.mouse.move(title.x-110,title.y-20);await page.mouse.up();
  assert.ok((await page.locator('#vpsStorageDialog').boundingBox()).x<beforeMove.x-180);
  await page.locator('[data-storage-tab="backups"]').click();await page.locator('[data-storage-review="cleanup"]').click();
  assert.equal(await page.locator('[data-storage-confirm]').count(),1);assert.equal(await page.evaluate(()=>calls.filter(c=>c.method).length),0);
  await page.locator('[data-storage-confirm]').click();
  const cleanup=await page.evaluate(()=>calls.find(c=>c.url.endsWith('/cleanup')));assert.equal(cleanup.method,'POST');assert.equal(JSON.parse(cleanup.body).planSha256,'a'.repeat(64));assert.equal(JSON.parse(cleanup.body).confirmation,'VPS_STORAGE_CLEANUP');
  await page.waitForFunction(()=>document.querySelector('[data-storage-inspect]').disabled===false);
  await page.locator('[data-storage-tab="settings"]').click();await page.locator('input[name="warningGiB"]').fill('9');
  await page.getByRole('button',{name:'Optionen speichern'}).click();await page.waitForFunction(()=>calls.some(c=>c.url.endsWith('/settings')));
  assert.equal(await page.evaluate(()=>JSON.parse(calls.find(c=>c.url.endsWith('/settings')).body).warningGiB),9);
  await page.waitForFunction(()=>document.querySelector('[data-storage-inspect]').disabled===false);
  await page.locator('[data-storage-tab="overview"]').click();
  if(process.env.GP_STORAGE_SCREENSHOT_DIRECTORY)await page.screenshot({path:path.join(process.env.GP_STORAGE_SCREENSHOT_DIRECTORY,'vps-storage-desktop.png')});
  await page.setViewportSize({width:390,height:780});await page.locator('[data-storage-tab="backups"]').click();
  const box=await page.locator('#vpsStorageDialog').boundingBox();assert.ok(box.x>=-1&&box.x+box.width<=391);assert.ok(box.y>=-1&&box.y+box.height<=781);
  assert.equal(await page.locator('.vps-storage-shell').evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);
  if(process.env.GP_STORAGE_SCREENSHOT_DIRECTORY)await page.screenshot({path:path.join(process.env.GP_STORAGE_SCREENSHOT_DIRECTORY,'vps-storage-mobile.png')});
  await page.evaluate(()=>{actor='';storage.sync();manager.synchronize();});assert.equal(await page.locator('#vpsStorageDialog').isVisible(),false);assert.equal(await page.locator('[data-storage-content]').innerText(),'');
  await page.evaluate(()=>{actor='synthetic-B';window.deferRead=true;storage.sync();manager.synchronize();});await page.locator('#openVpsStorage').click();await page.waitForFunction(()=>typeof completeRead==='function');
  await page.evaluate(()=>{actor='';storage.sync();manager.synchronize();completeRead();});await page.waitForTimeout(50);
  assert.equal(await page.locator('[data-storage-content]').innerText(),'');assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
