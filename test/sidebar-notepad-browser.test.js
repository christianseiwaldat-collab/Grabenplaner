'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');
test('personal notepad overlays the viewport, preserves preferred size and supports mouse, touch, keyboard and account changes',{
  skip:process.env.GP_SIDEBAR_NOTEPAD_BROWSER_TEST!=='1',timeout:60000,
},async()=>{
  const {chromium}=require(process.env.GP_BROWSER_TEST_MODULE||'playwright');
  const browser=await chromium.launch({headless:true,...(process.env.GP_BROWSER_EXECUTABLE?{executablePath:process.env.GP_BROWSER_EXECUTABLE}:{}),args:['--no-first-run']});
  const failures=[];
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000},hasTouch:true});
    const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>failures.push(error.message));
    const css=['styles.css','mobile-refinements.css','gp-window.css','sidebar-notepad.css'].map(name=>fs.readFileSync(path.join(root,'public',name),'utf8')).join('\n');
    await page.setContent('<style>'+css+'</style><aside class="sidebar" id="mainSidebar"><div class="brand"><strong>BEISPIEL: GP</strong></div><div class="sidebar-session">Persönliches Testkonto</div><nav class="main-nav" aria-label="Hauptnavigation">'+['Dashboard','Filialverwaltung','Personal','Verkauf','Logistik','Datenschutz'].map(label=>'<button class="nav-item" type="button">'+label+'</button>').join('')+'</nav><div id="sidebarNotepad" hidden></div></aside>');
    for(const name of ['gp-window-preferences.js','gp-window.js','sidebar-notepad-preferences.js','sidebar-notepad.js'])await page.addScriptTag({path:path.join(root,'public',name)});
    await page.evaluate(()=>{
      window.actor='A';window.allowed=true;window.requests=[];window.persisted={A:{version:1,text:'Schon gespeichert',height:240,open:false},B:{version:1,text:'Nur Konto B',height:180,open:true}};
      window.loadGate=true;window.options={sidebar:document.querySelector('#mainSidebar'),menu:document.querySelector('.main-nav'),key:()=>actor+':personal',identity:()=>actor,canUse:()=>allowed,delay:250,
        api:async(url,options={})=>{const owner=actor;requests.push({owner,method:options.method||'GET',body:options.body});
          if(options.method!=='PUT'&&loadGate){loadGate=false;await new Promise(resolve=>window.resolveInitialLoad=resolve);}
          if(options.signal?.aborted)throw new DOMException('aborted','AbortError');
          if(options.method==='PUT'){persisted[owner]=JSON.parse(options.body).sidebarNotepad;return{};}
          return{sidebarNotepad:structuredClone(persisted[owner]||SidebarNotepadPreferences.empty())};}};
      window.controller=SidebarNotepad.mount(document.querySelector('#sidebarNotepad'),options);
    });
    const text=page.locator('[data-notepad-text]'),panel=page.locator('[data-notepad-panel]'),handle=page.locator('[data-notepad-resize]'),toggle=page.locator('[data-notepad-toggle]');
    async function waitFitted(){
      // CSS zoom takes effect before the queued layout frame reanchors the
      // overlay. Wait for its actual viewport fit before reading drag targets.
      await page.waitForFunction(()=>{
        const panel=document.querySelector('[data-notepad-panel]'),sidebar=document.querySelector('#mainSidebar');
        if(!panel||panel.hidden||!controller.store.ready)return false;
        const rect=panel.getBoundingClientRect(),viewport=visualViewport||{width:innerWidth,height:innerHeight,offsetLeft:0,offsetTop:0};
        const scale=sidebar.offsetWidth?sidebar.getBoundingClientRect().width/sidebar.offsetWidth:1;
        return Math.abs(rect.width-Math.min(controller.store.value.width*scale,viewport.width))<1
          &&Math.abs(rect.height-Math.min(controller.store.value.height*scale,viewport.height))<1
          &&Math.abs(rect.left-(viewport.offsetLeft||0))<.5
          &&Math.abs(rect.bottom-(viewport.offsetTop||0)-viewport.height)<.5;
      });
    }
    const menuHeight=await page.locator('.main-nav').evaluate(e=>e.offsetHeight);
    await toggle.click();assert.equal(await panel.isVisible(),true);assert.equal(await text.isDisabled(),true);
    assert.equal(await page.evaluate(()=>requests.filter(r=>r.method==='PUT').length),0);
    await page.evaluate(()=>resolveInitialLoad());await page.waitForFunction(()=>controller.store.ready);await page.evaluate(()=>controller.flush());
    assert.equal(await text.inputValue(),'Schon gespeichert');assert.equal(await panel.isVisible(),true);
    const literal='<img src=x onerror=alert(1)>\nPersönliche Notizen bleiben erhalten.';
    await text.fill(literal);await page.evaluate(()=>controller.flush());assert.equal(await page.evaluate(()=>persisted.A.text),literal);assert.equal(await panel.locator('img').count(),0);
    await page.locator('[data-notepad-close]').click();assert.equal(await panel.isVisible(),false);await page.evaluate(()=>controller.flush());assert.equal(await page.evaluate(()=>persisted.A.text),literal);assert.equal(await page.evaluate(()=>persisted.A.open),false);
    await toggle.click();await page.evaluate(()=>controller.flush());assert.equal(await text.inputValue(),literal);
    await waitFitted();
    const before=await panel.evaluate(e=>e.offsetHeight),box=await handle.boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2,box.y+box.height/2-80,{steps:6});await page.mouse.up();await page.evaluate(()=>controller.flush());
    assert.equal(await page.evaluate(()=>persisted.A.height),before+80);
    await handle.press('ArrowUp');await page.evaluate(()=>controller.flush());assert.equal(await page.evaluate(()=>persisted.A.height),before+90);
    assert.equal(await handle.evaluate(e=>document.activeElement===e),true);
    const layout=await panel.evaluate(e=>({left:e.getBoundingClientRect().left,bottom:e.getBoundingClientRect().bottom,parent:e.parentElement.tagName}));
    assert.equal(layout.left,0);assert.equal(layout.bottom,1000);assert.equal(layout.parent,'BODY');assert.equal(await page.locator('.main-nav').evaluate(e=>e.offsetHeight),menuHeight);
    const right=panel.locator('[data-gp-window-edge="e"]');await right.press('ArrowRight');await page.evaluate(()=>controller.flush());assert.equal(await page.evaluate(()=>persisted.A.width),250);
    await waitFitted();
    const corner=await panel.locator('[data-gp-window-edge="ne"]').boundingBox();
    await page.mouse.move(corner.x+corner.width/2,corner.y+corner.height/2);await page.mouse.down();await page.mouse.move(corner.x+corner.width/2+50,corner.y+corner.height/2-30,{steps:4});await page.mouse.up();await page.evaluate(()=>controller.flush());
    assert.equal(await page.evaluate(()=>persisted.A.width),300);assert.equal(await page.evaluate(()=>persisted.A.height),before+120);
    await page.evaluate(()=>{document.documentElement.style.setProperty('--app-font-scale','1.5');document.documentElement.style.setProperty('--app-font-scale-inverse',String(1/1.5));});
    await waitFitted();
    assert.equal(await panel.evaluate(e=>e.getBoundingClientRect().height/e.offsetHeight),1.5);
    const zoomBefore=await page.evaluate(()=>persisted.A.height),scaled=await handle.boundingBox();
    await page.mouse.move(scaled.x+scaled.width/2,scaled.y+scaled.height/2);await page.mouse.down();await page.mouse.move(scaled.x+scaled.width/2,scaled.y+scaled.height/2+60,{steps:4});await page.mouse.up();await page.evaluate(()=>controller.flush());
    assert.equal(await page.evaluate(()=>persisted.A.height),zoomBefore-40);
    await page.evaluate(()=>{document.documentElement.style.setProperty('--app-font-scale','1');document.documentElement.style.setProperty('--app-font-scale-inverse','1');controller.store.change({...controller.store.value,width:900,height:900});});await page.evaluate(()=>controller.flush());
    const writesBefore=await page.evaluate(()=>requests.filter(r=>r.method==='PUT').length);
    await page.setViewportSize({width:390,height:640});await page.evaluate(()=>document.body.classList.add('mobile-navigation-open'));
    await waitFitted();
    assert.equal(await page.evaluate(()=>persisted.A.height),900);assert.equal(await page.evaluate(()=>persisted.A.width),900);assert.equal(await page.evaluate(()=>requests.filter(r=>r.method==='PUT').length),writesBefore);
    const mobile=await panel.boundingBox();assert.ok(mobile.x>=0&&mobile.x+mobile.width<=390);assert.ok(mobile.y>=0&&mobile.y+mobile.height<=640);
    const touchBefore=await panel.evaluate(e=>e.offsetHeight),touchBox=await handle.boundingBox(),client=await context.newCDPSession(page),x=touchBox.x+touchBox.width/2,y=touchBox.y+touchBox.height/2;
    await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
    await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+50}]});
    await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.evaluate(()=>controller.flush());
    assert.equal(await page.evaluate(()=>persisted.A.height),Math.max(120,touchBefore-50));
    assert.equal(await page.evaluate(()=>persisted.A.width),900);
    await handle.press('Home');await page.evaluate(()=>controller.flush());assert.equal(await page.evaluate(()=>persisted.A.height),120);
    await page.setViewportSize({width:150,height:100});
    await waitFitted();
    await handle.press('End');await right.press('Home');await page.evaluate(()=>controller.flush());
    assert.ok(await page.evaluate(()=>persisted.A.width>=SidebarNotepadPreferences.MIN_WIDTH&&persisted.A.height>=SidebarNotepadPreferences.MIN_HEIGHT));
    assert.deepEqual(failures,[]);
    await page.setViewportSize({width:390,height:640});
    await waitFitted();
    await text.press('Escape');assert.equal(await panel.isVisible(),false);assert.equal(await toggle.evaluate(e=>document.activeElement===e),true);await page.evaluate(()=>controller.flush());
    await page.evaluate(async()=>{actor='B';await controller.sync();});assert.equal(await text.inputValue(),'Nur Konto B');
    await page.evaluate(async()=>{actor='A';await controller.sync();});await toggle.click();assert.equal(await text.inputValue(),literal);
    let prompted=false;page.once('dialog',async dialog=>{prompted=true;await dialog.dismiss();});await page.locator('[data-notepad-clear]').click();assert.equal(prompted,true);assert.equal(await text.inputValue(),literal);
    page.once('dialog',dialog=>dialog.accept());await page.locator('[data-notepad-clear]').click();await page.evaluate(()=>controller.flush());assert.equal(await text.inputValue(),'');assert.equal(await page.evaluate(()=>persisted.A.text),'');assert.equal(await page.evaluate(()=>persisted.B.text),'Nur Konto B');
    await page.evaluate(()=>{const api=options.api;let fail=true;options.api=async(url,options)=>{if(options.method==='PUT'&&fail){fail=false;throw Error('synthetic-offline');}return api(url,options);};});
    await text.fill('Letzte Notiz');assert.equal(await page.evaluate(()=>controller.prepareLogout()),false);assert.equal(await text.isDisabled(),false);assert.equal(await text.inputValue(),'Letzte Notiz');
    await page.evaluate(()=>{const api=options.api;options.api=async(url,options)=>{if(options.method==='PUT')await new Promise(resolve=>window.resolveLogoutWrite=resolve);return api(url,options);};window.logout=controller.prepareLogout();});
    assert.equal(await text.isDisabled(),true);assert.equal(await toggle.isDisabled(),true);
    await page.evaluate(()=>resolveLogoutWrite());assert.equal(await page.evaluate(()=>logout),true);assert.equal(await page.evaluate(()=>persisted.A.text),'Letzte Notiz');
    await page.evaluate(async()=>{allowed=false;await controller.sync();});assert.equal(await page.locator('#sidebarNotepad').isVisible(),false);assert.equal(await text.inputValue(),'');
    await page.evaluate(()=>controller.destroy());assert.equal(await toggle.count(),0);assert.deepEqual(failures,[]);
    await context.close();
  }finally{await browser.close();}
});
