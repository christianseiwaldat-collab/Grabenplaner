'use strict';
// Real internal-window DOM checks, with synthetic data and no GP database.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const root=path.join(__dirname,'..');
test('GP windows retain native modal semantics, resize at edges and restore compact/docked searches',
  {skip:process.env.GP_WINDOW_BROWSER_TEST!=='1',timeout:60000},async()=>{
    const {chromium}=require(process.env.GP_BROWSER_TEST_MODULE || 'playwright');
    const browser=await chromium.launch({headless:true,...(process.env.GP_BROWSER_EXECUTABLE?{executablePath:process.env.GP_BROWSER_EXECUTABLE}:{}),args:['--no-first-run']});
    const errors=[];
    try {
      const page=await browser.newPage({viewport:{width:1400,height:1000}});page.setDefaultTimeout(8000);page.on('pageerror',error=>errors.push(error.message));
      await page.route('**/*',route=>route.abort());
      await page.setContent('<style>body{margin:0;zoom:1.25}dialog{border:0;border-radius:12px;padding:0;width:420px;background:#faf9f5}.modal-header{display:flex;justify-content:space-between;padding:12px}.modal-header h2{margin:0}form{padding:16px}.search{background:white;border:1px solid #215345;display:flex;flex-direction:column}.search header{display:flex;height:44px;flex:none;align-items:center}.search main{flex:1;overflow:auto}button{min-height:24px}#dock{position:fixed;bottom:0;left:40px}</style>'
        +'<button id="open">Dialog öffnen</button><dialog id="demo"><form><div class="modal-header"><h2>Angaben</h2><button type="button" id="close">×</button></div><label>Name<input id="name"></label></form></dialog>'
        +'<button id="dock">Suche</button><section id="search" class="search" hidden><header data-article-window-title><button data-article-window-move>Artikelsuche</button><button data-article-window-minimize>−</button><button data-article-window-close>×</button></header><main data-article-window-body><input id="query"></main><button data-article-window-resize></button><span data-article-window-status></span></section>');
      await page.addStyleTag({path:path.join(root,'public/gp-window.css')});
      await page.addStyleTag({path:path.join(root,'public/sales-article-search-window.css')});
      for(const file of ['gp-window-preferences.js','gp-window.js','sales-article-search-window.js'])await page.addScriptTag({path:path.join(root,'public',file)});
      await page.evaluate(()=>{
        window.actor='SYNTHETIC';window.saved=[];
        window.dialogs=GpWindow.installDocument(document,{actorKey:()=>actor,canUse:()=>Boolean(actor),scale:()=>1.25,
          readPreferences:async()=>({gpWindows:{version:1,windows:{existing:{x:1,y:2,width:300,height:200,minimized:false}}}}),writePreferences:async value=>saved.push(value)});
        document.querySelector('#open').onclick=()=>document.querySelector('#demo').showModal();document.querySelector('#close').onclick=()=>document.querySelector('#demo').close();
        window.search=SalesArticleSearchWindow.attach(document.querySelector('#search'),{bounds:()=>GpWindow.viewportBounds({width:innerWidth,height:innerHeight},1.25),scale:()=>1.25,canUse:()=>Boolean(actor),
          change:value=>saved.push(value),closeTarget:()=>document.querySelector('#dock'),onFreshSearch:()=>document.querySelector('#query').value='',onClose:()=>{window.wasDocked=true;}});
        document.querySelector('#dock').onclick=()=>search.reopenFresh();search.set({version:2,x:300,y:100,width:600,height:500,minimized:false});search.activate();
      });
      assert.equal(await page.locator('#search .gp-window-edge').count(),8);
      await page.locator('#query').fill('Sony');await page.locator('[data-article-window-minimize]').click();
      assert.equal(await page.evaluate(()=>search.fitted.width),260);assert.equal(await page.evaluate(()=>search.preferred.width),600);
      await page.locator('[data-article-window-minimize]').click();assert.equal(await page.evaluate(()=>search.fitted.width),600);
      const west=page.locator('#search [data-gp-window-edge="w"]'),westBox=await west.boundingBox();
      await page.mouse.move(westBox.x+westBox.width/2,westBox.y+westBox.height/2);await page.mouse.down();await page.mouse.move(westBox.x+westBox.width/2+50,westBox.y+westBox.height/2+100);await page.mouse.up();
      assert.equal(await page.evaluate(()=>search.preferred.x),340);assert.equal(await page.evaluate(()=>search.preferred.width),560);assert.equal(await page.evaluate(()=>search.preferred.height),500);
      await page.locator('[data-article-window-close]').click();await page.waitForFunction(()=>search.docked);
      assert.equal(await page.locator('#search').isVisible(),false);await page.evaluate(()=>{search.suspend();search.activate();});assert.equal(await page.locator('#search').isVisible(),false);
      await page.locator('#dock').click();assert.equal(await page.locator('#query').inputValue(),'');assert.equal(await page.evaluate(()=>search.preferred.width),560);
      await page.evaluate(()=>search.suspend());await page.locator('#open').click();await page.waitForFunction(()=>document.querySelector('#demo').classList.contains('gp-window'));
      assert.equal(await page.locator('#demo .gp-window-edge').count(),8);assert.equal(await page.evaluate(()=>document.querySelector('#demo').matches(':modal')),true);
      const east=page.locator('#demo [data-gp-window-edge="e"]'),before=await page.locator('#demo').boundingBox(),eastBox=await east.boundingBox();
      await page.mouse.move(eastBox.x+eastBox.width/2,eastBox.y+eastBox.height/2);await page.mouse.down();await page.mouse.move(eastBox.x+eastBox.width/2+100,eastBox.y+eastBox.height/2);await page.mouse.up();
      const after=await page.locator('#demo').boundingBox();assert.ok(Math.abs(after.width-before.width-100)<2);assert.ok(Math.abs(after.x-before.x)<2);
      await page.waitForFunction(()=>saved.some(value=>value.windows?.demo));assert.equal(await page.evaluate(()=>saved.find(value=>value.windows?.demo).windows.existing.width),300);
      await page.locator('#demo [data-gp-window-close]').click();await page.addStyleTag({content:'.gp-centering-test:has([data-editor]:not([hidden])){inset:50% auto auto 50%;transform:translate(-50%,-50%)}'});await page.evaluate(()=>{const dynamic=document.createElement('dialog');dynamic.id='dynamic';dynamic.className='gp-centering-test';dynamic.innerHTML='<form data-editor><h3>Neue Angaben</h3><input><button type="button" onclick="this.closest(\'dialog\').close()">Schließen</button></form>';document.body.append(dynamic);dynamic.showModal();});
      await page.waitForFunction(()=>document.querySelector('#dynamic').classList.contains('gp-window'));assert.equal(await page.locator('#dynamic .gp-window-edge').count(),8);
      assert.equal(await page.locator('#dynamic .gp-dialog-window-title').count(),1);assert.equal(await page.locator('#dynamic').evaluate(node=>getComputedStyle(node).transform),'none');await page.evaluate(()=>document.querySelector('#dynamic').close());
      await page.evaluate(()=>{const manual=document.createElement('dialog');manual.id='manual';manual.dataset.gpWindowManual='';manual.innerHTML='<header class="modal-header"><strong>Meine Aktionen</strong><button data-manual-min>−</button></header><main data-manual-body>Persönliche Aktionen</main>';document.body.append(manual);manual.show();window.manualWindow=GpWindow.attach(manual,{nativeDialog:true,title:manual.querySelector('header'),body:manual.querySelector('main'),toggle:manual.querySelector('button'),scale:()=>1.25,geometry:{x:100,y:80,width:300,height:200,minimized:false}});manualWindow.activate();});
      const manualBox=await page.locator('#manual').boundingBox();assert.ok(Math.abs(manualBox.x-125)<2);assert.ok(Math.abs(manualBox.y-100)<2);assert.ok(Math.abs(manualBox.width-375)<2);
      await page.locator('[data-manual-min]').click();assert.equal(await page.evaluate(()=>manualWindow.fitted.width),260);assert.equal(await page.locator('[data-manual-body]').isVisible(),false);await page.evaluate(()=>{manualWindow.destroy();document.querySelector('#manual').remove();});
      await page.emulateMedia({reducedMotion:'reduce'});await page.evaluate(()=>search.reopenFresh());await page.locator('[data-article-window-close]').click();await page.waitForFunction(()=>search.docked);
      await page.evaluate(()=>{document.querySelector('#demo').showModal();});await page.waitForFunction(()=>document.querySelector('#demo').open);
      await page.evaluate(()=>{actor='';dialogs.synchronize();});assert.equal(await page.locator('#demo').isVisible(),false);
      assert.deepEqual(errors,[]);
    } finally {await browser.close();}
  });

test('workspace chrome preserves drafts/files, keeps the background usable and respects nested modal and discard gates',
  {skip:process.env.GP_WINDOW_BROWSER_TEST!=='1',timeout:60000},async()=>{
    const {chromium}=require(process.env.GP_BROWSER_TEST_MODULE || 'playwright');
    const browser=await chromium.launch({headless:true,...(process.env.GP_BROWSER_EXECUTABLE?{executablePath:process.env.GP_BROWSER_EXECUTABLE}:{}),args:['--no-first-run']});
    try {
      const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(7000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.route('**/*',route=>route.abort());
      await page.setContent('<style>body{margin:0}dialog{padding:0;border:0;width:700px;background:#faf9f5}.modal-header{display:flex}form{padding:18px}.long{height:1300px}button{min-height:24px}</style>'
        +'<button id="open">Öffnen</button><button id="background">Hintergrund</button><dialog id="work" data-gp-window-mode="workspace"><form><header class="modal-header"><div><span>Einordnung</span><h2>BEISPIEL-Entwurf</h2><p>Erklärung bleibt vollständig im Inhalt.</p></div><button type="button" class="close-button" id="legacy">×</button></header><input id="draft" required><input id="file" type="file"><button type="button" id="nested">Bestätigung</button><div class="long">Langer Inhalt</div><button type="submit">Speichern</button></form></dialog><dialog id="critical"><h2>Pflichtbestätigung</h2><input id="guard"><button id="criticalClose">Zurück</button></dialog>');
      await page.addStyleTag({path:path.join(root,'public/gp-window.css')});
      for(const file of ['gp-window-preferences.js','gp-window.js'])await page.addScriptTag({path:path.join(root,'public',file)});
      await page.evaluate(()=>{
        window.actor='A';window.saved=[];window.closes=0;window.allowClose=false;window.backgroundClicks=0;
        window.originalModal=work.showModal;window.manager=GpWindow.installDocument(document,{actorKey:()=>actor,canUse:()=>Boolean(actor),
          readPreferences:async()=>({version:1,windows:{work:{x:30,y:40,width:720,height:610,minimized:false}}}),writePreferences:async value=>saved.push(value)});
        document.querySelector('#open').onclick=()=>work.showModal();background.onclick=()=>backgroundClicks++;
        work.addEventListener('close',()=>closes++);work.addEventListener('cancel',event=>{if(!allowClose)event.preventDefault();});
        legacy.onclick=()=>work.close();nested.onclick=()=>critical.showModal();criticalClose.onclick=()=>critical.close();
        window.originalForm=work.querySelector('form');window.originalFile=file;
      });
      await page.locator('#open').click();await page.locator('#draft').fill('Ungespeicherter Entwurf');await page.locator('#file').setInputFiles({name:'BEISPIEL.txt',mimeType:'text/plain',buffer:Buffer.from('BEISPIEL')});
      assert.deepEqual(await page.evaluate(()=>{
        const ticket=GpWindow.capture(work),context=GpWindow.captureContext(document);
        const initial=GpWindow.current(ticket)&&GpWindow.currentContext(context);
        work.showModal();
        return [initial,GpWindow.current(ticket),GpWindow.currentContext(context)];
      }),[true,false,true]);
      await page.waitForFunction(()=>manager.preferences.ready);
      assert.equal(await page.evaluate(()=>work.matches(':modal')),false);assert.equal(await page.evaluate(()=>work.querySelector('form')===originalForm&&file===originalFile),true);
      assert.equal(await page.locator('#work .gp-dialog-window-title').count(),1);assert.equal(await page.locator('#work [data-gp-window-toggle]').count(),1);
      const titleBox=await page.locator('#work .gp-dialog-window-title').boundingBox();assert.equal(titleBox.height,44);
      await page.evaluate(()=>work.querySelector('.gp-dialog-body').scrollTop=400);
      assert.equal((await page.locator('#work .gp-dialog-window-title').boundingBox()).y,titleBox.y);
      assert.equal(await page.locator('#work .gp-dialog-body').evaluate(node=>node.scrollTop>0),true);
      await page.locator('#work [data-gp-window-toggle]').click();await page.locator('#background').click();
      assert.equal(await page.evaluate(()=>backgroundClicks),1);assert.equal(await page.evaluate(()=>closes),0);assert.equal(await page.evaluate(()=>work.open),true);
      await page.locator('#work [data-gp-window-toggle]').click();assert.equal(await page.locator('#draft').inputValue(),'Ungespeicherter Entwurf');
      assert.equal(await page.locator('#file').evaluate(node=>node.files[0].name),'BEISPIEL.txt');
      await page.locator('#draft').focus();await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>work.open),true);assert.equal(await page.evaluate(()=>closes),0);
      await page.locator('#work [data-gp-window-close]').click();assert.equal(await page.evaluate(()=>work.open),true);
      await page.locator('#nested').click();assert.equal(await page.evaluate(()=>critical.matches(':modal')),true);assert.equal(await page.locator('#critical [data-gp-window-toggle]').count(),0);
      await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>work.open),true);
      await page.evaluate(()=>{allowClose=true;});await page.locator('#draft').focus();await page.keyboard.press('Escape');
      await page.evaluate(()=>setTimeout(()=>{const detail=document.createElement('p');detail.textContent='Später Detailstand';work.querySelector('form').append(detail);},20));
      await page.waitForFunction(()=>!work.open);assert.equal(await page.evaluate(()=>closes),1);
      await page.locator('#open').click();await page.locator('#work [data-gp-window-toggle]').click();await page.waitForFunction(()=>saved.some(value=>value.windows.work.minimized));
      await page.evaluate(()=>{work.innerHTML='<form><h2>Neuer Entwurf</h2><input id="replacement" value="Bleibt erhalten"></form>';});
      await page.waitForFunction(()=>work.querySelector('.gp-dialog-window-title strong')?.textContent==='Neuer Entwurf');
      assert.equal(await page.locator('#work .gp-window-edge').count(),8);assert.equal(await page.locator('#work .gp-dialog-window-title').count(),1);
      assert.equal(await page.locator('#work .gp-dialog-body').isVisible(),false);await page.locator('#work [data-gp-window-toggle]').click();assert.equal(await page.locator('#replacement').inputValue(),'Bleibt erhalten');
      assert.deepEqual(await page.evaluate(()=>{
        const ticket=GpWindow.capture(work),context=GpWindow.captureContext(document);
        actor='B';manager.synchronize();actor='A';
        return [GpWindow.current(ticket,{allowClosed:true}),GpWindow.currentContext(context)];
      }),[false,false]);
      await page.evaluate(()=>actor='B');assert.equal(await page.evaluate(()=>work.open),false);assert.equal(await page.evaluate(()=>manager.preferences.value.windows.work===undefined),true);
      await page.evaluate(()=>{window.dynamic=document.createElement('dialog');dynamic.dataset.gpWindowMode='workspace';dynamic.innerHTML='<h2>Dynamisch</h2><input>';document.body.append(dynamic);GpWindow.prepare(dynamic);dynamic.showModal();});
      assert.equal(await page.evaluate(()=>dynamic.matches(':modal')),false);assert.equal(await page.locator('#work').isVisible(),false);
      await page.locator('#open').click();await page.locator('#replacement').focus();
      await page.evaluate(()=>{const paragraph=document.createElement('p');paragraph.textContent='Hintergrundupdate';dynamic.querySelector('.gp-dialog-body').append(paragraph);});
      await page.waitForTimeout(30);assert.equal(await page.evaluate(()=>work.classList.contains('is-active-window')),true);assert.equal(await page.evaluate(()=>dynamic.classList.contains('is-active-window')),false);
      await page.evaluate(()=>{manager.destroy();});assert.equal(await page.evaluate(()=>work.showModal===originalModal),true);assert.equal(await page.locator('.gp-window-edge').count(),0);
      assert.deepEqual(errors,[]);
    }finally{await browser.close();}
  });
test('actual article workspace keeps full-width details and viewport window geometry',
  {skip:process.env.GP_WINDOW_BROWSER_TEST!=='1',timeout:60000},async()=>{
    const {chromium}=require(process.env.GP_BROWSER_TEST_MODULE || 'playwright');
    const browser=await chromium.launch({headless:true,...(process.env.GP_BROWSER_EXECUTABLE?{executablePath:process.env.GP_BROWSER_EXECUTABLE}:{}),args:['--no-first-run']});
    const errors=[];
    try {
      const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8'),start=html.indexOf('<section id="salesArticleCatalogView"'),end=html.indexOf('<section id="crmView"',start);
      assert.ok(start>=0&&end>start);const page=await browser.newPage({viewport:{width:1600,height:1000}});page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>route.abort());
      await page.setContent('<div class="app-shell"><aside id="mainSidebar" class="sidebar">GP-Menü</aside><main class="main-content">'+html.slice(start,end)+'</main></div>');
      for(const file of ['styles.css','mobile-refinements.css','gp-window.css','sales-article-search-window.css'])await page.addStyleTag({path:path.join(root,'public',file)});
      for(const file of ['gp-window-preferences.js','gp-window.js','sales-article-search-window.js'])await page.addScriptTag({path:path.join(root,'public',file)});
      await page.evaluate(()=>{document.querySelector('#salesArticleCatalogView').classList.add('active');window.articleSearch=SalesArticleSearchWindow.attach(document.querySelector('#salesArticleSearchWindow'),{bounds:()=>GpWindow.viewportBounds({width:innerWidth,height:innerHeight},parseFloat(getComputedStyle(document.body).zoom)||1),scale:()=>parseFloat(getComputedStyle(document.body).zoom)||1,canUse:()=>true,change:()=>{}});articleSearch.set({version:2,x:800,y:160,width:560,height:620,minimized:false});articleSearch.activate();});
      const workspace=page.locator('.sales-article-catalog-workspace'),detail=page.locator('#salesArticleDetail'),search=page.locator('#salesArticleSearchWindow');
      const workBox=await workspace.boundingBox(),detailBox=await detail.boundingBox();assert.ok(Math.abs(workBox.x-detailBox.x)<2&&Math.abs(workBox.width-detailBox.width)<2);
      assert.equal(await workspace.evaluate(node=>getComputedStyle(node).display),'block');assert.equal(await search.evaluate(node=>getComputedStyle(node).display),'flex');
      assert.equal(await page.locator('[data-article-window-title]').evaluate(node=>getComputedStyle(node).display),'flex');assert.equal(await page.locator('[data-article-window-close]').evaluate(node=>getComputedStyle(node).borderTopWidth),'0px');
      await page.getByRole('searchbox',{name:'Artikelnr., Bezeichnung oder EAN',exact:true}).waitFor();
      assert.equal(await page.locator('#salesArticleSearchQuery').getAttribute('placeholder'),'Artikelnr., Bezeichnung oder EAN');
      assert.equal(await page.locator('#salesArticleSearchQuery').evaluate(node=>node.closest('label').querySelector('span').getBoundingClientRect().height),1);
      assert.equal(await page.locator('#salesArticleColumns > summary').textContent(),'Spaltenansicht');
      for(const id of ['salesArticleAdvancedSearch','salesArticleColumns']) {
        const disclosure=await page.locator('#'+id+' > summary').evaluate(node=>({display:getComputedStyle(node).display,height:node.getBoundingClientRect().height,width:node.getBoundingClientRect().width,parentWidth:node.parentElement.getBoundingClientRect().width}));
        assert.equal(disclosure.display,'list-item');assert.ok(disclosure.height<23);assert.ok(disclosure.width<170,'Disclosure remains a compact text action');
      }
      await page.evaluate(()=>articleSearch.set({version:2,x:0,y:0,width:560,height:620,minimized:false}));const left=await search.boundingBox();assert.ok(Math.abs(left.x)<1&&Math.abs(left.y)<1);
      await page.evaluate(()=>{document.documentElement.style.setProperty('--app-font-scale','1.25');articleSearch.refresh();});const zoomed=await search.boundingBox();assert.ok(Math.abs(zoomed.width-700)<2);
      await page.locator('[data-article-window-minimize]').click();const small=await search.boundingBox();assert.ok(Math.abs(small.width-325)<2);await page.locator('[data-article-window-minimize]').click();assert.ok(Math.abs((await search.boundingBox()).width-700)<2);
      assert.deepEqual(errors,[]);
    }finally{await browser.close();}
  });
