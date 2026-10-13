'use strict';
// Real shared UI, synthetic pictures/camera and a local server. No provider calls.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const publicRoot=path.resolve(__dirname,'../public');
const options={skip:process.env.GP_IMAGE_LAYOUT_BROWSER_TEST!=='1',timeout:90000};
function functionSource(file,name){const text=fs.readFileSync(path.join(publicRoot,file),'utf8'),start=text.indexOf('function '+name+'('),end=text.indexOf('\nfunction ',start+1);assert(start>=0);return text.slice(start,end<0?text.length:end);}
function keyboardViewport(){if(parent!==window)return;const real=visualViewport,shim=new EventTarget();let keyboard=null;for(const name of ['width','height','offsetLeft','offsetTop','scale'])Object.defineProperty(shim,name,{get:()=>keyboard?.[name]??real[name]});Object.defineProperty(window,'visualViewport',{value:shim});window.testKeyboard=value=>{keyboard=value;shim.dispatchEvent(new Event('resize'));shim.dispatchEvent(new Event('scroll'));};for(const type of ['resize','scroll'])real.addEventListener(type,()=>shim.dispatchEvent(new Event(type)));}
async function fixture(mode='edit',native=false){
  assert(['edit','trade'].includes(mode));
  const cameraPage='<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,interactive-widget=resizes-content"><link rel="stylesheet" href="/gp-gallery.css"><link rel="stylesheet" href="/gp-photo-capture.css"><style>body{margin:0;padding:12px;background:#f3f1ea;color:#183c33}dialog{background:white;border:1px solid #b5c9be;border-radius:12px;padding:0}.window-titlebar{display:flex;align-items:center;justify-content:space-between}dialog main{overflow:auto;padding:12px}.window-controls{display:flex;gap:6px}</style></head><body><button id="settings">Einstellungen</button><section id="camera"></section><dialog id="sample" aria-labelledby="title"><header class="window-titlebar" data-window-title tabindex="0"><h2 id="title">BEISPIEL</h2><div class="window-controls"><button data-window-toggle>−</button><button id="close" aria-label="Fenster schließen">×</button></div></header><main><label>Name<input id="draft"></label></main></dialog><script type="module">import {attachStudioWindow} from "/gp-gallery-window.mjs";import {mountPhotoCapture} from "/gp-photo-capture.mjs";const close=document.getElementById("close");window.shell=attachStudioWindow(document.getElementById("sample"),{key:"test.sample",width:660,height:610});window.samples=[];window.camera=mountPhotoCapture(document.getElementById("camera"),{mode:"edit",autoCamera:()=>false,onConfirm:async(photo,prompt)=>{samples.push({bytes:photo.blob.size,prompt});return {text:"BEISPIEL",tokens:100,cost:0};}});document.getElementById("settings").onclick=()=>shell.show();close.onclick=()=>close.closest("dialog").close();window.ready=true;</script></body></html>';
  const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://127.0.0.1');if(url.pathname==='/api/portal/v1/private-workspaces/example-camera/page'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(cameraPage.replace('mode:"edit"','nativeCamera:()=>'+native+',mode:'+JSON.stringify(mode)));return;}if(url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,interactive-widget=resizes-content"></head><body></body></html>');return;}const file=path.resolve(publicRoot,url.pathname.slice(1));if(file.startsWith(publicRoot+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile()){res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.css')?'text/css':/\.(mjs|js)$/.test(file)?'text/javascript':'application/octet-stream'});res.end(fs.readFileSync(file));}else{res.writeHead(404);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  const {chromium}=require(process.env.GP_BROWSER_TEST_MODULE||'playwright');const browser=await chromium.launch({headless:true,...(process.env.GP_BROWSER_EXECUTABLE?{executablePath:process.env.GP_BROWSER_EXECUTABLE}:{}),args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
  const context=await browser.newContext({viewport:{width:1440,height:1000},permissions:['camera']});await context.addInitScript(keyboardViewport);await context.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());const page=await context.newPage(),errors=[];page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);
  return {origin,page,context,errors,async close(){await browser.close();await new Promise(resolve=>server.close(resolve));}};
}
async function assertInside(locator,width,height){const b=await locator.boundingBox();assert(b);assert(b.x>=-1&&b.y>=-1&&b.x+b.width<=width+1&&b.y+b.height<=height+1,JSON.stringify(b));}

async function portalLaunch(f,{native=false,facing='environment'}={}){
 const {page}=f;await page.setViewportSize({width:412,height:820});
 await page.setContent('<main><h1>Startseite</h1><div id="tiles" class="mobile-home-tiles"></div></main>');
 for(const file of ['portal.css','gp-private-workspaces.css'])await page.addStyleTag({url:f.origin+'/'+file});
 for(const file of ['navigation-history.js','gp-private-workspaces.js'])await page.addScriptTag({url:f.origin+'/'+file});
 await page.evaluate(({native,facing})=>{
  window.actor={accountId:'BEISPIEL',permissions:['BEISPIEL']};window.allowed=true;window.reads=0;window.exits=0;
  window.workspaces=GpPrivateWorkspaces.mount({document,getActor:()=>actor,load:async()=>{reads++;return allowed?[{id:'example-camera',title:'BEISPIEL',url:'/api/portal/v1/private-workspaces/example-camera/page',camera:true,nativeCamera:native,cameraSettings:{autoCamera:true,cameraFacing:facing},launch:{label:'Foto.beschreiben.BEISPIEL',color:'#0064dd'}}]:[];},onExit:()=>exits++,onChange:()=>{document.getElementById('tiles').innerHTML=workspaces.launches.map(i=>'<button data-open style="--mobile-home-tile-color:'+i.launch.color+'" class="gp-private-launch"><span class="mobile-home-tile-accent"></span><span><strong>'+i.launch.label+'</strong></span><b>›</b></button>').join('');}});
  window.navigation=GrabenplanerNavigationHistory.create({window,app:'portal',keys:['tab'],read:()=>({tab:'home'}),apply:()=>{}});navigation.start();
  document.getElementById('tiles').onclick=()=>workspaces.open('example-camera');void workspaces.synchronize();
 },{native,facing});
 await page.locator('[data-open]').waitFor();
}

test('authenticated mobile startup never paints dashboard, login or schedule before home, including slow session checks',options,async()=>{
 const f=await fixture();try{
  const {page,context}=f;await page.setViewportSize({width:390,height:844});
  let release;const pending=new Promise(resolve=>release=resolve);
  const status={portalEnabled:true,operationMode:'server',branding:{},capabilities:{locationSchedule:true}};
  const user={isEmployee:false,accountId:'BEISPIEL',accountType:'branch',loginName:'BEISPIEL',nickname:'Beispiel',role:'branch_account',roleName:'Filialkonto',permissions:['schedule:location:view'],homeLocationId:'BEISPIEL',scopes:[{locationId:'BEISPIEL'}]};
  await context.route('**/api/**',async route=>{
   const url=new URL(route.request().url());let body={};
   if(url.pathname.endsWith('/status'))body=status;
   else if(url.pathname.endsWith('/session')){await pending;body={authenticated:true,user,status};}
   else if(url.pathname.endsWith('/private-workspaces'))body={workspaces:['camera','edit','product'].map((id,i)=>({id:'example-'+id,title:'BEISPIEL',url:'/api/portal/v1/private-workspaces/example-'+id+'/page',camera:true,launch:{label:['Foto.beschreiben.BEISPIEL','Foto.bearbeiten.BEISPIEL','Foto erkennen'][i],color:'#0064dd'}}))};
   else if(url.pathname.endsWith('/personnel-learning/dashboard')){await route.fulfill({status:403,json:{error:'Nicht freigegeben'}});return;}
   else if(url.pathname.endsWith('/location-dashboard/schedule'))body={weekStart:'2026-10-12',weekEnd:'2026-10-18',calendarWeek:42,shifts:[{date:'2026-10-14',employeeName:'BEISPIEL',startTime:'09:00',endTime:'18:00'}],location:{name:'BEISPIEL'},displaySettings:{},focusDate:url.searchParams.get('focus')==='current'?'2026-10-14':null};
   await route.fulfill({json:body});
  });
  for(const name of ['index.html','portal.html'])await context.route('**/'+name,route=>route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(publicRoot,name),'utf8')}));
  await context.addInitScript(()=>{
   window.painted=[];function sample(){const pending=document.body?.classList.contains('session-pending');for(const selector of ['.app-shell','#portalLogin','#scheduleView']){const e=document.querySelector(selector);if(e&&e.getBoundingClientRect().height&&getComputedStyle(e).visibility!=='hidden')painted.push({selector,pending});}requestAnimationFrame(sample);}requestAnimationFrame(sample);
  });
  await page.goto(f.origin+'/index.html');await page.locator('.session-entry-status').waitFor();
  assert.equal(await page.locator('.app-shell').isVisible(),false);await page.waitForTimeout(150);assert.deepEqual(await page.evaluate(()=>painted),[]);
  release();await page.waitForURL('**/portal.html*');await page.getByRole('heading',{name:'Startseite',exact:true}).waitFor();
  assert.equal(await page.locator('#portalLogin').isVisible(),false);assert.equal(await page.locator('#scheduleView').isVisible(),false);assert.deepEqual(await page.evaluate(()=>painted),[]);
  assert.deepEqual(f.errors,[]);
  await page.locator('[data-private-workspace]').first().waitFor();
  for(const tile of await page.locator('[data-private-workspace]').all()){const b=await tile.boundingBox(),w=await tile.locator('strong').boundingBox();assert(w.x>=b.x&&w.x+w.width<=b.x+b.width);assert(b.width<200);}
  if(process.env.GP_MOBILE_PROOF_DIR){fs.mkdirSync(process.env.GP_MOBILE_PROOF_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.GP_MOBILE_PROOF_DIR,'mobile-startup.png')});}
  await page.locator('[data-mobile-home-tab=schedule]').click();
  await page.waitForFunction(()=>{const d=document.querySelector('[data-schedule-date="2026-10-14"]'),h=document.querySelector('.portal-header');return d&&Math.abs(d.getBoundingClientRect().top-h.getBoundingClientRect().bottom-8)<2;});
  if(process.env.GP_MOBILE_PROOF_DIR)await page.screenshot({path:path.join(process.env.GP_MOBILE_PROOF_DIR,'mobile-schedule-focus.png')});
  await page.goto(f.origin+'/portal.html?tab=schedule');await page.waitForFunction(()=>{const d=document.querySelector('[data-schedule-date="2026-10-14"]'),h=document.querySelector('.portal-header');return d&&Math.abs(d.getBoundingClientRect().top-h.getBoundingClientRect().bottom-8)<2;});
  assert.deepEqual(f.errors,[]);

 }finally{await f.close();}
});

test('a real tile gesture opens the top-document camera picker, transfers one photo and returns Back to home',options,async()=>{
 const f=await fixture('trade',true);try{
  const {page}=f;await portalLaunch(f,{native:true,facing:'user'});
  const before=await page.evaluate(()=>history.length),chooser=page.waitForEvent('filechooser');await page.locator('[data-open]').click();
  const input=(await chooser).element();assert.equal(await input.getAttribute('capture'),'user');assert.equal(await input.getAttribute('data-workspace-camera'),'example-camera');
  const buffer=await require('sharp')({create:{width:120,height:160,channels:3,background:'#476c93'}}).jpeg().toBuffer();await input.setInputFiles({name:'BEISPIEL.jpg',mimeType:'image/jpeg',buffer});
  const child=()=>page.frames().find(p=>p.url().includes('/example-camera/page'));
  await page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.samples?.length===1);
  assert.equal(await child().evaluate(()=>samples.length),1);assert.equal(await page.evaluate(()=>history.length),before+1);
  await page.goBack();await page.locator('.gp-private-workspace-host').waitFor({state:'hidden'});
  assert.equal(new URL(page.url()).searchParams.get('tab'),'home');assert.equal(await page.locator('iframe').count(),0);assert(await page.getByRole('heading',{name:'Startseite'}).isVisible());assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('Back, camera cancellation, explicit close and revoked/changed actors leave no camera landing history',options,async()=>{
 const f=await fixture('trade',true);try{
  const {page}=f;await portalLaunch(f,{native:true});
  for(const action of ['cancel','close','back','revoke','actor']){
   const chooser=page.waitForEvent('filechooser');await page.locator('[data-open]').click();await chooser;
   if(action==='cancel')await page.locator('[data-workspace-camera]').dispatchEvent('cancel');
   if(action==='close')await page.locator('.gp-private-workspace-close').click();
   if(action==='back')await page.goBack();
   if(action==='revoke')await page.evaluate(async()=>{allowed=false;await workspaces.synchronize();});
   if(action==='actor')await page.evaluate(async()=>{actor=null;await workspaces.synchronize();});
   await page.locator('.gp-private-workspace-host').waitFor({state:'hidden'});await page.waitForFunction(()=>!history.state?.gpPrivateWorkspace);
   assert.equal(await page.locator('iframe,input[data-workspace-camera]').count(),0);assert.equal(await page.evaluate(()=>document.documentElement.style.overflow),'');
   await page.evaluate(async()=>{actor={accountId:'BEISPIEL',permissions:['BEISPIEL']};allowed=true;await workspaces.synchronize();});
  }
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('image tiles inherit the portal surface and long names fit narrow screens',options,async()=>{
 const f=await fixture();try{await portalLaunch(f);for(const width of [320,390,412,700]){
  await f.page.setViewportSize({width,height:820});const button=f.page.locator('[data-open]'),word=button.locator('strong');
  const style=await button.evaluate(e=>({background:getComputedStyle(e).backgroundImage,color:getComputedStyle(e).color}));assert(style.background.includes('gradient'));assert.notEqual(style.color,'rgb(255, 255, 255)');
  const box=await button.boundingBox(),text=await word.boundingBox();assert(text.x>=box.x&&text.x+text.width<=box.x+box.width);await assertInside(button,width,820);
 }if(process.env.GP_MOBILE_PROOF_DIR){fs.mkdirSync(process.env.GP_MOBILE_PROOF_DIR,{recursive:true});await f.page.setViewportSize({width:390,height:820});await f.page.screenshot({path:path.join(process.env.GP_MOBILE_PROOF_DIR,'mobile-tiles.png')});}assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('native capture and gallery use separate file pickers without starting browser video',options,async()=>{
 const f=await fixture('trade',true);try{const {page}=f;await page.goto(f.origin+'/api/portal/v1/private-workspaces/example-camera/page');await page.waitForFunction(()=>window.ready===true);
  const camera=page.locator('[data-photo-source=camera]'),gallery=page.locator('[data-photo-source=gallery]');assert.equal(await camera.getAttribute('capture'),'environment');assert.equal(await gallery.getAttribute('capture'),null);
  let pending=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Foto aufnehmen',exact:true}).click();assert.equal(await (await pending).element().getAttribute('data-photo-source'),'camera');
  pending=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Foto auswählen',exact:true}).click();assert.equal(await (await pending).element().getAttribute('data-photo-source'),'gallery');
  assert(!await page.locator('video').isVisible());assert.equal(await page.locator('video').evaluate(e=>e.srcObject),null);assert.equal(await page.evaluate(()=>camera.state.stage),'empty');assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('idle camera instructions have readable contrast and describe the selected capture action',options,async()=>{
 const f=await fixture('trade');
 try {
  await f.page.goto(f.origin+'/api/portal/v1/private-workspaces/example-camera/page');
  await f.page.waitForFunction(()=>window.ready===true);
  const hint=f.page.locator('.gp-photo-camera>.fine');
  assert(await hint.isVisible());
  assert.equal(await hint.textContent(),'Foto aufnehmen und das Produkt erkennen lassen.');
  const colors=await hint.evaluate(e=>({foreground:getComputedStyle(e).color,background:getComputedStyle(e.parentElement).backgroundColor}));
  const luminance=value=>{const rgb=value.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
  const a=luminance(colors.foreground),b=luminance(colors.background);
  assert((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,'Idle instruction contrast must satisfy readable normal text');
  for(const width of [320,412,700]){await f.page.setViewportSize({width,height:800});await assertInside(hint,width,800);}
  assert.deepEqual(f.errors,[]);
 } finally {await f.close();}
});
test('closed adopted windows cannot obscure definitions, and a selected module keeps the GP background usable',options,async()=>{
 const f=await fixture();try{const {page}=f;await page.setContent('<button id="background">Hintergrund</button><main id="definitions"></main>');for(const file of ['gp-definitions-registry.js','gp-definitions.js'])await page.addScriptTag({url:f.origin+'/'+file});await page.evaluate(()=>{window.definitions=GpDefinitions.mount(document.getElementById('definitions'),{canUse:()=>true,key:()=> 'BEISPIEL',loadWorkspaces:async()=>[{id:'example-camera',title:'BEISPIEL',url:'/api/portal/v1/private-workspaces/example-camera/page',camera:true}]});definitions.activate();});await page.locator('[data-gp-private-workspace]').waitFor();assert.equal(await page.locator('iframe[src]').count(),0);assert.equal(await page.locator('.gp-definition-card h2').textContent(),'Developer');await page.locator('[data-gp-private-workspace]').click();const iframe=page.frameLocator('iframe');await iframe.locator('#settings').waitFor();await page.waitForFunction(()=>document.querySelector('.gp-private-window-portal')?.hidden===true);assert.equal(await page.locator('.gp-private-window-portal').evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');await iframe.locator('#settings').click();const dialog=page.locator('dialog[open]#sample');await dialog.waitFor();await dialog.locator('#draft').fill('Entwurf behalten');const title=dialog.locator('[data-window-title]');assert((await dialog.boundingBox()).x>250);await title.focus();for(let i=0;i<70;i++)await title.press('ArrowLeft');assert((await dialog.boundingBox()).x<=12);await dialog.locator('[data-window-toggle]').click();assert.equal(Math.round((await dialog.boundingBox()).height),44);await page.locator('#background').click();await dialog.locator('[data-window-toggle]').click();assert.equal(await dialog.locator('#draft').inputValue(),'Entwurf behalten');await dialog.locator('#close').click();await page.waitForFunction(()=>document.querySelector('.gp-private-window-portal').hidden);assert.equal(await page.locator('#background').evaluate(e=>document.elementFromPoint(10,10)===e),true);await page.locator('[data-gp-definition-section="standards"]').click();assert.equal(await page.locator('.gp-definition-card h2').textContent(),'Developer');assert.deepEqual(f.errors,[]);}finally{await f.close();}
});
test('portal launch tile uses the standard grid and camera controls remain within portrait and landscape viewports',options,async()=>{
 const f=await fixture();try{const {page}=f;await page.setContent('<main><div id="tiles" class="mobile-home-tiles"></div></main>');for(const file of ['portal.css','gp-private-workspaces.css'])await page.addStyleTag({url:f.origin+'/'+file});await page.addScriptTag({url:f.origin+'/gp-private-workspaces.js'});await page.addScriptTag({content:'const esc=s=>String(s),el={mobileHomeTiles:document.getElementById("tiles")},isMobileUi=()=>true,portalState={activeTab:"home"},mobileHomeTilesForCurrentAccount=()=>[{tab:"home",label:"BEISPIEL",description:"Bereich",rgb:[35,109,81]}];let privatePortalWorkspaces;'+functionSource('portal.js','renderMobileHome')+';privatePortalWorkspaces=GpPrivateWorkspaces.mount({document,load:async()=>[{id:"example-camera",title:"BEISPIEL",url:"/api/portal/v1/private-workspaces/example-camera/page",camera:true,launch:{label:"capture",color:"#0064dd"}}],getActor:()=>({accountId:"BEISPIEL"}),onChange:renderMobileHome});privatePortalWorkspaces.synchronize();document.getElementById("tiles").onclick=e=>{if(e.target.closest("[data-private-workspace]"))privatePortalWorkspaces.open("example-camera");};'});await page.locator('[data-private-workspace]').waitFor();for(const width of [320,412,600,700]){await page.setViewportSize({width,height:800});const word=await page.locator('[data-private-workspace] strong').boundingBox(),a=await page.locator('[data-private-workspace]').boundingBox(),b=await page.locator('[data-mobile-home-tab]').boundingBox();assert(word.height<26&&word.width>40);assert.equal(a.width,b.width);assert.equal(a.height,b.height);}await page.setViewportSize({width:412,height:800});await page.locator('[data-private-workspace]').click();await page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.ready);const child=page.frames().find(p=>p.url().includes('/example-camera/page'));await child.getByRole('button',{name:'Kamera öffnen',exact:true}).click();await child.locator('video').waitFor({state:'visible'});for(const size of [{width:412,height:800},{width:320,height:568},{width:896,height:414}]){await page.setViewportSize(size);await page.waitForTimeout(100);await assertInside(child.locator('video'),size.width,size.height);for(const b of await child.locator('#camera>.buttons button:visible').all()){await assertInside(b,size.width,size.height);assert((await b.boundingBox()).height>=44);assert.equal(await b.evaluate(e=>getComputedStyle(e).borderRadius),'10px');}await assertInside(page.locator('.gp-private-workspace-close'),size.width,size.height);}await page.locator('.gp-private-workspace-close').click();assert.equal(await page.locator('.gp-private-workspace-host').isHidden(),true);assert.equal(await page.evaluate(()=>document.documentElement.style.overflow),'');assert.deepEqual(f.errors,[]);}finally{await f.close();}
});
test('IMG2IMG keeps its prompt and confirmation above a visual-only keyboard in an embedded module',options,async()=>{
 const f=await fixture();try{const {page}=f;await page.setViewportSize({width:412,height:800});await page.setContent('<iframe title="BEISPIEL" allow="camera" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>');await page.evaluate(()=>{const frame=document.querySelector('iframe');addEventListener('message',e=>{if(e.source!==frame.contentWindow||e.origin!==location.origin)return;if(e.data?.type==='gp-private-workspace-ready')frame.contentWindow.postMessage({type:'gp-private-workspace-visibility',active:true},location.origin);if(e.data?.type==='gp-private-workspace-fullscreen'){const v=visualViewport;frame.style.height=v.height+'px';frame.style.top=v.offsetTop+'px';}});visualViewport.addEventListener('resize',()=>{frame.style.height=visualViewport.height+'px';frame.style.top=visualViewport.offsetTop+'px';});frame.src='/api/portal/v1/private-workspaces/example-camera/page';});await page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.ready);const child=page.frames().find(p=>p.url().includes('/example-camera/page'));const buffer=await require('sharp')({create:{width:720,height:1280,channels:3,background:'#476c93'}}).jpeg().toBuffer();await child.locator('input[data-photo-source=gallery]').setInputFiles({name:'BEISPIEL.jpg',mimeType:'image/jpeg',buffer});await child.locator('.gp-photo-review.is-screen').waitFor();const prompt=child.locator('textarea');await prompt.fill('Bitte einen blauen Himmel ergänzen.');const photo=await child.locator('.gp-photo-review>img').getAttribute('src');assert.equal(await child.evaluate(()=>document.fullscreenElement),null);for(const visible of [{height:400},{height:320},{height:380,offsetTop:70}]){await page.evaluate(v=>testKeyboard(v),visible);await page.waitForTimeout(100);await assertInside(prompt,412,visible.height+(visible.offsetTop||0));for(const b of await child.locator('.gp-photo-overlay button:visible').all())await assertInside(b,412,visible.height+(visible.offsetTop||0));assert.equal(await prompt.inputValue(),'Bitte einen blauen Himmel ergänzen.');assert.equal(await child.locator('.gp-photo-review>img').getAttribute('src'),photo);}await child.getByRole('button',{name:'Änderung bestätigen',exact:true}).click();await child.locator('.gp-photo-result').waitFor();assert.deepEqual(await child.evaluate(()=>samples.map(s=>s.prompt)),['Bitte einen blauen Himmel ergänzen.']);assert.deepEqual(f.errors,[]);}finally{await f.close();}
});
test('the actual portal EAN scanner uses one GP titlebar and fits the mobile display without letterboxing',options,async()=>{
 const f=await fixture();try{const {page}=f;await page.setViewportSize({width:412,height:800});await page.setContent('<main id="articles"></main>');for(const file of ['portal.css','gp-window.css'])await page.addStyleTag({url:f.origin+'/'+file});for(const file of ['branch-article-calculation.js','branch-receipt-filters.js','gp-window-preferences.js','gp-window.js','article-code-scanner.js','portal-branch-sales.js'])await page.addScriptTag({url:f.origin+'/'+file});await page.evaluate(async()=>{window.streams=[];window.windows=GpWindow.installDocument(document,{actorKey:()=> 'BEISPIEL',canUse:()=>true});const user={isEmployee:false,accountId:'BEISPIEL',accountType:'branch',permissions:['branch_articles:read'],scopes:[{locationId:'18'}]};window.articles=GrabenplanerBranchSales.mount(document.getElementById('articles'),{kind:'articles',getUser:()=>user,api:async()=>({items:[]}),scannerFactory:options=>GrabenplanerArticleScanner.create({...options,decoder:async()=>({BrowserMultiFormatReader:class{async decodeFromStream(s,v){streams.push(s);v.srcObject=s;await v.play();return {stop(){}};}}})})});await articles.load();});await page.locator('[data-b=scan]').click();await page.locator('[data-b=scan-video]').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('[data-b=scan-video]').videoWidth>0);assert.equal(await page.locator('.branch-scanner-dialog').evaluate(e=>e.matches(':modal')),false);assert.equal(await page.locator('[data-b=scan-close]').isVisible(),false);assert.equal(await page.locator('.branch-scanner-dialog [data-gp-window-close]').count(),1);assert.equal(await page.locator('[data-b=scan-video]').evaluate(e=>getComputedStyle(e).objectFit),'cover');for(const size of [{width:412,height:800},{width:320,height:568},{width:896,height:414}]){await page.setViewportSize(size);await page.waitForTimeout(100);await assertInside(page.locator('.branch-scanner-dialog'),size.width,size.height);await assertInside(page.locator('[data-b=scan-video]'),size.width,size.height);}await page.locator('.branch-scanner-dialog [data-gp-window-close]').click();await page.waitForFunction(()=>streams.every(s=>s.getTracks().every(t=>t.readyState==='ended')));assert.deepEqual(f.errors,[]);}finally{await f.close();}
});
test('shared windows and embedded photo input fit GP display scaling and a visual-only keyboard',options,async()=>{
 const f=await fixture();
 try {
  const {page}=f;
  await page.setContent('<main id="definitions"></main>');
  for(const file of ['gp-definitions-registry.js','gp-definitions.js'])await page.addScriptTag({url:f.origin+'/'+file});
  await page.evaluate(()=>{
   window.preview=GpDefinitions.mount(document.getElementById('definitions'),{
    canUse:()=>true,key:()=> 'BEISPIEL',
    loadWorkspaces:async()=>[{id:'example-camera',title:'BEISPIEL',url:'/api/portal/v1/private-workspaces/example-camera/page',camera:true}],
   });
   preview.activate();
  });
  await page.locator('[data-gp-private-workspace]').click();
  await page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.ready);
  const child=page.frames().find(p=>p.url().includes('/example-camera/page'));
  for(const zoom of [1.25,1.5]){
   await page.evaluate(value=>document.body.style.zoom=String(value),zoom);
   // Setup through the source document avoids Playwright's iframe CSS-zoom coordinate rounding.
   await child.evaluate(()=>document.getElementById('settings').click());
   const dialog=page.locator('dialog[open]#sample'),title=dialog.locator('[data-window-title]');
   await title.press('End');await assertInside(dialog,1440,1000);
   await title.press('Home');const box=await dialog.boundingBox();
   assert(Math.abs(box.x+box.width/2-720)<1);
   await dialog.locator('#close').click();
  }
  await page.evaluate(()=>document.body.style.zoom='1');
  await page.setViewportSize({width:412,height:800});
  const image=await require('sharp')({create:{width:720,height:1280,channels:3,background:'#476c93'}}).jpeg().toBuffer();
  await child.locator('input[data-photo-source=gallery]').setInputFiles({name:'BEISPIEL.jpg',mimeType:'image/jpeg',buffer:image});
  await child.locator('.gp-photo-review.is-screen').waitFor();
  await child.locator('textarea').fill('Bitte einen blauen Himmel ergänzen.');
  for(const zoom of [1.25,1.5]){
   await page.evaluate(value=>{document.body.style.zoom=String(value);testKeyboard({height:320,offsetTop:70});},zoom);
   await page.waitForTimeout(150);
   const frame=await page.locator('iframe').boundingBox();
   assert(Math.abs(frame.x)<1&&Math.abs(frame.y-70)<1&&frame.width<=413&&frame.height<=321);
   const visible=await child.evaluate(()=>{
    const outer=frameElement.getBoundingClientRect(),sx=outer.width/frameElement.clientWidth,sy=outer.height/frameElement.clientHeight;
    return [...document.querySelectorAll('textarea,.gp-photo-overlay button')].filter(e=>e.getBoundingClientRect().width).map(e=>{
     const b=e.getBoundingClientRect();
     return {name:e.getAttribute('aria-label')||e.textContent,left:outer.left+b.left*sx,right:outer.left+b.right*sx,top:outer.top+b.top*sy,bottom:outer.top+b.bottom*sy};
    });
   });
   assert(visible.every(b=>b.left>=-1&&b.right<=413&&b.top>=69&&b.bottom<=391),JSON.stringify(visible));
   assert.equal(await child.locator('textarea').inputValue(),'Bitte einen blauen Himmel ergänzen.');
  }
  assert.deepEqual(f.errors,[]);
 } finally {await f.close();}
});
