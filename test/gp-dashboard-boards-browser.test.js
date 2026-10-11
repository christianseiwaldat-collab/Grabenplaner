'use strict';
// Real Start markup and shared dashboard controller; synthetic accounts and preferences only.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const repo=path.resolve(__dirname,'..'),publicRoot=path.join(repo,'public');
const html=fs.readFileSync(path.join(publicRoot,'index.html'),'utf8');
const start=html.indexOf('<section id="startDashboardView"'),end=html.indexOf('<section id="filialAdministrationView"',start);
const personnelIds=['employees','positions','applications','workflows','learning','tasks','requests','timeTracking','costCenters','ruleDrafts','collectiveAgreements','vacations'];
const personnelMarkup='<section id="personnelDashboardSection"><header><h1>Personaldashboard</h1></header><div class="personnel-dashboard-grid" id="personnelDashboardGrid">'+personnelIds.map(id=>'<article class="personnel-dashboard-card" data-personnel-dashboard-field="'+id+'"><header><h3>'+id+'</h3><p class="card-description">BEISPIEL Beschreibung</p></header><div data-synthetic-information></div><button type="button">Bereich öffnen</button></article>').join('')+'</div></section>';
let evidence;
function screenshotDirectory(){
  if(evidence)return evidence;
  const base=process.env.GP_DASHBOARD_SCREENSHOT_DIR||process.env.GP_WINDOW_SCREENSHOT_DIR;
  if(!base)return null;
  evidence=path.join(base,'boards-'+new Date().toISOString().replace(/[^0-9]/g,'')+'-'+process.pid);fs.mkdirSync(evidence,{recursive:true});return evidence;
}
async function screenshot(page,name){const directory=screenshotDirectory();if(directory){await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.join(directory,name),fullPage:true,animations:'disabled'});}}
async function prepare(page,kind,seed={}){
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  if(!page.url().startsWith('http://127.0.0.1/')){
    await page.route('http://127.0.0.1/**',route=>route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:'<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>'}));
    await page.goto('http://127.0.0.1/');
  }
  await page.setContent('<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main class="dashboard-test">'+(kind==='start'?html.slice(start,end):personnelMarkup)+'</main></body></html>');
  for(const file of ['styles.css','gp-window.css','start-dashboard-workspace.css','personnel-dashboard-workspace.css','gp-dashboard-boards.css'])await page.addStyleTag({path:path.join(publicRoot,file)});
  await page.addStyleTag({content:'.dashboard-test{box-sizing:border-box;max-width:1320px;margin:24px auto;padding:0 34px}#startDashboardView,#personnelDashboardSection{display:block!important}#startDashboardCustomizer{display:none!important}@media(max-width:700px){.dashboard-test{margin:12px auto;padding:0 '+(kind==='start'?14:12)+'px}}'});
  for(const file of ['gp-window-preferences.js','gp-window.js','gp-dashboard-boards.js','start-dashboard-workspace-preferences.js','personnel-dashboard-workspace-preferences.js','start-dashboard-workspace-geometry.js','start-dashboard-workspace.js'])await page.addScriptTag({path:path.join(publicRoot,file)});
  await page.evaluate(({kind,seed})=>{
    window.testActor='BEISPIEL-A';window.testSession={id:'A'};window.testAllowed=true;
    window.persisted=structuredClone(seed);window.calls=[];window.holdWrites=false;window.heldWrites=[];window.failWrites=false;window.saveErrors=[];
    const model=kind==='start'?StartDashboardWorkspacePreferences:PersonnelDashboardWorkspacePreferences;
    const property=kind==='start'?'startDashboardWorkspace':'personnelDashboardWorkspace';window.testProperty=property;
    const root=document.getElementById(kind==='start'?'startDashboardView':'personnelDashboardSection');root.classList.add('view','active');
    root.querySelectorAll('.hidden').forEach(node=>node.classList.remove('hidden'));
    window.allowedIds=new Set(model.IDS);
    if(kind==='start')for(const select of root.querySelectorAll('select'))select.innerHTML='<option>BEISPIEL Filiale</option>';
    window.gpWindows=GpWindow.installDocument(document,{actorKey:()=>testActor,canUse:()=>testAllowed,readPreferences:async()=>({version:1,windows:{}}),writePreferences:async()=>{}});
    window.workspaceOptions={root,model,property,boards:true,scopeName:kind,grid:root.querySelector(kind==='start'?'#startDashboardGrid':'#personnelDashboardGrid'),key:()=>testActor,sessionReference:()=>testSession,canUse:()=>testAllowed,allowed:id=>allowedIds.has(id)||id.startsWith('custom:'),hideable:()=>true,closeHidesField:true,awaitEditorSave:true,localOnly:()=>false,error:error=>saveErrors.push(error.message),
      api:async(url,options={})=>{
        const actor=testActor;calls.push({actor,method:options.method||'GET',value:options.body?JSON.parse(options.body):null});
        if(options.method==='PUT'){
          if(holdWrites)await new Promise(resolve=>heldWrites.push({resolve,actor,options}));
          if(failWrites)throw Error('synthetic preference write failure');
          if(!options.signal.aborted)persisted[actor]=JSON.parse(options.body)[property];
          return {};
        }
        return {[property]:persisted[actor]??model.empty()};
      }};
    if(kind==='personnel'){
      workspaceOptions.discover=()=>[...root.querySelectorAll('[data-personnel-dashboard-field]')].map(element=>({id:'card:'+element.dataset.personnelDashboardField,element,title:element.querySelector('h3'),description:element.querySelector('.card-description')}));
      workspaceOptions.contentOptions=id=>model.contentOptions(id);
      workspaceOptions.contentSelection=(id,value)=>model.content(value,id);
    }
    window.controller=StartDashboardWorkspace.create(workspaceOptions);
  },{kind,seed});
  await page.waitForFunction(()=>controller.store.ready);return errors;
}
const tab=(page,n)=>page.locator('[data-dashboard-tab="dashboard-'+n+'"]');
async function selectTab(page,n){
  try{await tab(page,n).click();}catch(error){
    await screenshot(page,'tab-click-failure-'+n+'.png');
    const geometry=await page.evaluate(n=>{const tab=document.querySelector('[data-dashboard-tab="dashboard-'+n+'"]'),header=document.querySelector('.topbar');return {scrollY,tab:tab?.getBoundingClientRect().toJSON(),header:header?.getBoundingClientRect().toJSON()};},n);
    throw Error(error.message+'; viewport geometry: '+JSON.stringify(geometry));
  }
  await page.waitForFunction(()=>controller.store.ready);
}
async function edit(page,id){await page.locator('[data-dashboard-field-menu="'+id+'"]').click();await page.locator('[data-field-edit]').click();}
async function saveEditor(page){await page.locator('[data-field-editor] [type=submit]').click();await page.waitForFunction(()=>!document.querySelector('[data-field-editor]').closest('dialog').open);}
async function settings(page){await page.locator('[data-dashboard-settings]').click();await page.locator('[data-dashboard-settings-form]').waitFor({state:'visible'});}
async function saveSettings(page){await page.locator('[data-dashboard-settings-form] [type=submit]').click();await page.waitForFunction(()=>!document.querySelector('[data-dashboard-settings-form]').closest('dialog').open);}
async function addNote(page,title,text){await page.locator('[data-dashboard-add]').click();const form=page.locator('[data-dashboard-note-form]');await form.locator('[name=title]').fill(title);await form.locator('[name=text]').fill(text);await form.locator('[type=submit]').click();await page.waitForFunction(()=>!document.querySelector('[data-dashboard-note-form]').closest('dialog').open);const cards=page.locator('[data-dashboard-custom]');await cards.last().waitFor({state:'visible'});return cards.last().getAttribute('data-dashboard-custom');}
async function prefs(page){return page.evaluate(()=>controller.store.value);}
function contrast(first,second){
  const luminance=color=>{
    const components=color.match(/[\d.]+/g).slice(0,3).map(value=>{const channel=Number(value)/255;return channel<=0.04045?channel/12.92:((channel+0.055)/1.055)**2.4;});
    return components[0]*0.2126+components[1]*0.7152+components[2]*0.0722;
  };
  const a=luminance(first),b=luminance(second);return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
}

for(const kind of ['start','personnel'])test(kind+' dashboards: three named views, reversible hiding, own notes, reload and account boundaries',{
  skip:process.env.GP_DASHBOARD_BROWSER_TEST!=='1',timeout:120000,
},async t=>{
  const {chromium}=require(process.env.GP_BROWSER_TEST_MODULE||'playwright');
  const browser=await chromium.launch({headless:true,...(process.env.GP_BROWSER_EXECUTABLE?{executablePath:process.env.GP_BROWSER_EXECUTABLE}:{}),args:['--no-first-run']});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(7000);const errors=await prepare(page,kind);
    const fieldId=kind==='start'?'group:branch':'card:requests',fieldSelector=kind==='start'?'[data-start-dashboard-group="branch"]':'[data-personnel-dashboard-field="requests"]';
    const geometry={x:40,y:32,width:420,height:360};let noteId;
    await t.test('closing a field hides it and settings restores its label and geometry',async()=>{
      assert.equal(await page.locator('[data-dashboard-tab]').count(),3);
      assert.equal(await page.evaluate(()=>controller.store.document.version),2);
      await page.evaluate(async({fieldId,geometry})=>{const value=controller.store.value;value.fields[fieldId]={title:'Ansicht Eins',geometry};await controller.store.change(value);},{fieldId,geometry});
      await page.locator('[data-dashboard-field-menu="'+fieldId+'"]').click();await page.locator('[data-field-close]').click();
      await page.waitForFunction(id=>controller.store.value.fields[id]?.hidden===true,fieldId);assert.equal(await page.locator(fieldSelector).isVisible(),false);
      await settings(page);assert.equal(await page.locator('[data-dashboard-choice="'+fieldId+'"]').isChecked(),false);await page.locator('[data-dashboard-choice="'+fieldId+'"]').check();await saveSettings(page);
      assert.equal(await page.locator(fieldSelector).isVisible(),true);assert.deepEqual((await prefs(page)).fields[fieldId].geometry,geometry);assert.equal((await prefs(page)).fields[fieldId].title,'Ansicht Eins');
    });
    await t.test('second and third views retain independent labels, contents, visibility and notes',async()=>{
      await selectTab(page,2);assert.equal((await prefs(page)).fields[fieldId]?.title,undefined);
      await settings(page);await page.locator('[data-dashboard-settings-form] [name=dashboardName]').fill('Meine Aufgaben');await saveSettings(page);assert.match(await tab(page,2).textContent(),/Meine Aufgaben/);
      await edit(page,fieldId);await page.locator('[data-field-editor] [name=title]').fill('Ansicht Zwei');
      if(kind==='personnel'){await page.locator('[data-field-content]').evaluateAll(nodes=>nodes.forEach(node=>node.checked=false));await page.locator('[data-field-content="absence.timeOff"]').check();}
      await saveEditor(page);
      if(kind==='personnel')assert.deepEqual((await prefs(page)).fields[fieldId].content,['absence.timeOff']);
      noteId=await addNote(page,'Meine Notiz','<script>window.noteRan=true</script>\nEinfacher Text <img src=x onerror=alert(1)>');
      const note=page.locator('[data-dashboard-custom="'+noteId+'"]');assert.match(await note.textContent(),/<script>window.noteRan=true<\/script>/);assert.equal(await note.locator('script,img').count(),0);assert.equal(await page.evaluate(()=>window.noteRan),undefined);
      assert.ok((await note.boundingBox()).width>=250,'Own desktop note uses a readable card width');
      await selectTab(page,3);assert.equal((await prefs(page)).fields[fieldId]?.title,undefined);assert.equal(await page.locator('[data-dashboard-custom]').count(),0);
      await settings(page);await page.locator('[data-dashboard-settings-form] [name=dashboardName]').fill('Mein Überblick über die persönlichen Aufgaben und Notizen');await saveSettings(page);
      await selectTab(page,1);assert.equal((await prefs(page)).fields[fieldId].title,'Ansicht Eins');assert.deepEqual((await prefs(page)).fields[fieldId].geometry,geometry);assert.equal(await page.locator('[data-dashboard-custom]').count(),0);
      await selectTab(page,2);assert.equal((await prefs(page)).fields[fieldId].title,'Ansicht Zwei');assert.equal(await note.isVisible(),true);
      await edit(page,noteId);await page.locator('[data-field-editor] [name=note]').fill('Geänderte persönliche Notiz');await saveEditor(page);assert.match(await note.textContent(),/Geänderte persönliche Notiz/);
      await note.locator('[data-dashboard-field-menu]').click();await page.locator('[data-field-close]').click();assert.equal(await note.isVisible(),false);
      await settings(page);await page.locator('[data-dashboard-choice="'+noteId+'"]').check();await saveSettings(page);assert.equal(await note.isVisible(),true);
      await note.locator('[data-dashboard-field-menu]').click();await page.locator('[data-field-color="blue"]').click();await page.waitForFunction(id=>controller.store.value.fields[id]?.color==='blue',noteId);
      await screenshot(page,kind+'-desktop-named-dashboard.png');
    });
    await t.test('fresh document load restores the active named view and excludes another account',async()=>{
      const seed=await page.evaluate(()=>structuredClone(persisted));await page.evaluate(()=>{controller.destroy();gpWindows.destroy();});await prepare(page,kind,seed);
      assert.match(await tab(page,2).textContent(),/Meine Aufgaben/);assert.match(await tab(page,3).textContent(),/Mein Überblick/);assert.equal((await prefs(page)).fields[fieldId].title,'Ansicht Zwei');
      assert.match(await page.locator('[data-dashboard-custom="'+noteId+'"]').textContent(),/Geänderte persönliche Notiz/);
      await page.evaluate(()=>{testActor='BEISPIEL-B';testSession={id:'B'};controller.sync();});await page.waitForFunction(()=>controller.store.ready);
      assert.equal((await prefs(page)).fields[fieldId]?.title,undefined);assert.equal(await page.locator('[data-dashboard-custom]').count(),0);assert.doesNotMatch(await tab(page,2).textContent(),/Meine Aufgaben/);
      await page.evaluate(()=>{testActor='BEISPIEL-A';testSession={id:'A-new'};controller.sync();});await page.waitForFunction(()=>controller.store.ready);assert.equal((await prefs(page)).fields[fieldId].title,'Ansicht Zwei');
    });
    await t.test('mobile tabs scroll within their bar and settings retain desktop geometry',async()=>{
      await page.setViewportSize({width:390,height:844});
      await selectTab(page,1);assert.deepEqual((await prefs(page)).fields[fieldId].geometry,geometry);assert.equal(await page.locator('[data-dashboard-floating="'+fieldId+'"]').count(),0);
      await selectTab(page,2);assert.ok((await page.locator('[data-dashboard-custom="'+noteId+'"]').boundingBox()).width>=300,'Own mobile note fills the available card width');await settings(page);
      const overflow=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,offenders:[...document.querySelectorAll('body *')].filter(node=>node.getClientRects().length&&node.getBoundingClientRect().right>innerWidth+1).slice(0,20).map(node=>({id:node.id,className:node.className,right:node.getBoundingClientRect().right}))}));
      assert.ok(overflow.scrollWidth<=overflow.width+1,JSON.stringify(overflow));
      const choices=await page.locator('[data-dashboard-choice]').evaluateAll(nodes=>nodes.map(node=>node.closest('label').getBoundingClientRect().height));assert.ok(choices.every(height=>height>=44));
      await screenshot(page,kind+'-mobile-dashboard-settings.png');await saveSettings(page);
      const tabs=await page.locator('[data-dashboard-tab]').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().height));assert.ok(tabs.every(height=>height>=44));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
      assert.equal(await page.locator('.gp-dashboard-tabs').evaluate(node=>node.scrollWidth>node.clientWidth&&['auto','scroll'].includes(getComputedStyle(node).overflowX)),true);
      await tab(page,2).focus();await page.keyboard.press('ArrowRight');assert.equal(await tab(page,3).getAttribute('aria-selected'),'true');await page.keyboard.press('Home');assert.equal(await tab(page,1).getAttribute('aria-selected'),'true');
      await selectTab(page,2);await screenshot(page,kind+'-mobile-dashboard.png');await page.setViewportSize({width:1440,height:1000});await selectTab(page,1);assert.equal(await page.locator('[data-dashboard-floating="'+fieldId+'"]').count(),1);assert.deepEqual((await prefs(page)).fields[fieldId].geometry,geometry);
    });
    await t.test('dark selected tabs and shared settings retain readable contrast',async()=>{
      await page.setViewportSize({width:900,height:850});
      try{
        await page.evaluate(()=>{workspaceOptions.root.dataset.pageTheme='dark';document.documentElement.dataset.activePageTheme='dark';});await settings(page);
        const colors=await page.evaluate(()=>{
          const selected=document.querySelector('[data-dashboard-tab][aria-selected="true"]'),dialog=document.querySelector('[data-dashboard-settings-form]').closest('dialog');
          const tab=getComputedStyle(selected),panel=getComputedStyle(dialog);
          return {tabText:tab.color,tabBackground:tab.backgroundColor,dialogBackground:panel.backgroundColor,labelText:[...dialog.querySelectorAll('label')].map(label=>getComputedStyle(label).color),actions:[...dialog.querySelectorAll('.gp-dashboard-dialog-actions button')].map(button=>{const style=getComputedStyle(button);return {label:button.textContent,color:style.color,background:style.backgroundColor};})};
        });
        assert.ok(contrast(colors.tabText,colors.tabBackground)>=4.5,JSON.stringify(colors));
        assert.ok(colors.labelText.every(color=>contrast(color,colors.dialogBackground)>=4.5),JSON.stringify(colors));
        assert.ok(colors.actions.every(action=>contrast(action.color,action.background)>=4.5),JSON.stringify(colors.actions));
        assert.ok(Number(colors.dialogBackground.match(/[\d.]+/g)[0])<80,'Shared settings use the dark surface outside the page view');
        const directory=screenshotDirectory();if(directory)await page.screenshot({path:path.join(directory,kind+'-dark-settings-compact.png'),animations:'disabled'});
        await page.locator('[data-dashboard-settings-form] [data-dashboard-dialog-close]').click();
      }finally{
        await page.evaluate(()=>{delete workspaceOptions.root.dataset.pageTheme;delete document.documentElement.dataset.activePageTheme;document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());});await page.setViewportSize({width:1440,height:1000});
      }
    });
    await t.test('failed note creation and a slow retry retain one identity and preserve newer text',async()=>{
      await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close()));await selectTab(page,1);
      await page.locator('[data-dashboard-add]').click();const form=page.locator('[data-dashboard-note-form]');await form.locator('[name=title]').fill('Mein Entwurf');await form.locator('[name=text]').fill('Erste Fassung');
      await page.evaluate(()=>{failWrites=true;});await form.locator('[type=submit]').click();await page.waitForFunction(()=>document.querySelector('[data-dashboard-note-form] [data-dashboard-error]').textContent.includes('Speichern fehlgeschlagen'));
      assert.equal(await form.isVisible(),true);assert.equal(await page.locator('[data-dashboard-custom]').count(),1);assert.deepEqual(await page.evaluate(()=>saveErrors),['synthetic preference write failure']);
      const id=await page.locator('[data-dashboard-custom]').getAttribute('data-dashboard-custom');assert.equal(await page.evaluate(()=>workspaceOptions.model.getBoard(persisted['BEISPIEL-A']).customFields.length),0);
      await page.evaluate(()=>{failWrites=false;holdWrites=true;saveErrors=[];});await form.locator('[type=submit]').click();await page.waitForFunction(()=>heldWrites.length===1);await form.locator('[name=text]').fill('Die neuere Fassung bleibt erhalten');
      await page.evaluate(()=>{holdWrites=false;heldWrites.shift().resolve();});await page.waitForFunction(()=>document.querySelector('[data-dashboard-note-form] [data-dashboard-error]').textContent.includes('Neuere Änderungen'));assert.equal(await form.isVisible(),true);assert.equal(await form.locator('[name=text]').inputValue(),'Die neuere Fassung bleibt erhalten');assert.equal(await page.locator('[data-dashboard-custom]').count(),1);
      await form.locator('[type=submit]').click();await page.waitForFunction(()=>!document.querySelector('[data-dashboard-note-form]').closest('dialog').open);
      assert.equal(await page.locator('[data-dashboard-custom]').count(),1);assert.equal(await page.locator('[data-dashboard-custom]').getAttribute('data-dashboard-custom'),id);assert.match(await page.locator('[data-dashboard-custom]').textContent(),/Die neuere Fassung bleibt erhalten/);
      assert.deepEqual(await page.evaluate(()=>workspaceOptions.model.getBoard(persisted['BEISPIEL-A']).customFields.map(note=>note.text)),['Die neuere Fassung bleibt erhalten']);
      await page.locator('[data-dashboard-custom] [data-dashboard-field-menu]').click();await page.locator('[data-field-remove]').click();assert.equal(await page.locator('[data-dashboard-custom]').count(),0);
    });
    await t.test('logout cancels a pending save and reopening cannot receive stale personal data',async()=>{
      await page.evaluate(()=>{holdWrites=true;const value=controller.store.value;value.fields[Object.keys(value.fields)[0]].title='Speicherung läuft';void controller.store.change(value);});await page.waitForFunction(()=>heldWrites.length===1);
      await page.evaluate(()=>{testAllowed=false;testActor='';testSession=null;controller.sync();});assert.equal(await page.locator('[data-dashboard-custom]').count(),0);assert.equal(await page.locator('[data-dashboard-tab]').filter({hasText:'Meine Aufgaben'}).count(),0);
      await page.evaluate(()=>{heldWrites.shift().resolve();holdWrites=false;testAllowed=true;testActor='BEISPIEL-B';testSession={id:'B-next'};controller.sync();});await page.waitForFunction(()=>controller.store.ready);
      assert.equal((await prefs(page)).fields[fieldId]?.title,undefined);assert.equal(await page.evaluate(()=>persisted['BEISPIEL-B']),undefined);assert.equal(await page.locator('[data-field-menu]').isVisible(),false);
    });
    assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>saveErrors),[]);
  }finally{await browser.close();}
});

test('actual Personnel application uses the shared settings and refreshes selected information per dashboard',{
  skip:process.env.GP_DASHBOARD_BROWSER_TEST!=='1',timeout:60000,
},async()=>{
  const UI=require('../test-support/personnel-dashboard-ui');
  const {chromium}=require(process.env.GP_BROWSER_TEST_MODULE||'playwright');
  const browser=await chromium.launch({headless:true,...(process.env.GP_BROWSER_EXECUTABLE?{executablePath:process.env.GP_BROWSER_EXECUTABLE}:{}),args:['--no-first-run']});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(7000);
    await page.route('http://127.0.0.1/**',route=>route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:'<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>'}));await page.goto('http://127.0.0.1/');
    const {errors}=await UI.prepare(page,{workspace:true});
    await page.addStyleTag({path:path.join(publicRoot,'gp-dashboard-boards.css')});if(!await page.evaluate(()=>Boolean(window.GpDashboardBoards)))await page.addScriptTag({path:path.join(publicRoot,'gp-dashboard-boards.js')});await page.evaluate(()=>personalWorkspace().sync());
    const loaded=()=>page.waitForFunction(()=>Object.values(infoRecords()).every(row=>row.status!=='loading'));
    await page.locator('#personnelDashboardCustomizeButton').click();assert.equal(await page.locator('[data-dashboard-settings-form]').isVisible(),true);
    await page.locator('[data-dashboard-settings-form] [name=dashboardName]').fill('Personalarbeit');await page.locator('[data-dashboard-choice="card:collectiveAgreements"]').uncheck();await saveSettings(page);
    assert.equal(await page.locator('[data-personnel-dashboard-field="collectiveAgreements"]').isVisible(),false);assert.equal(await page.evaluate(()=>state.personnelDashboardLayout.hidden.includes('collectiveAgreements')),true);
    await tab(page,2).click();await loaded();assert.equal(await page.locator('[data-personnel-dashboard-field="collectiveAgreements"]').isVisible(),true);
    await edit(page,'card:requests');await page.locator('[data-field-content]').evaluateAll(nodes=>nodes.forEach(node=>node.checked=false));await page.locator('[data-field-content="absence.timeOff"]').check();await saveEditor(page);await loaded();
    const labels=page.locator('[data-personnel-dashboard-field="requests"] dt');assert.deepEqual(await labels.allTextContents(),['Zeitausgleich: entscheidbar']);
    await tab(page,1).click();await loaded();assert.equal(await labels.count(),4);assert.equal(await page.locator('[data-personnel-dashboard-field="collectiveAgreements"]').isVisible(),false);
    await tab(page,2).click();await loaded();assert.deepEqual(await labels.allTextContents(),['Zeitausgleich: entscheidbar']);
    await page.evaluate(()=>{personalWorkspace().store.invalidate();syncPersonnelDashboardWorkspace();});await page.waitForFunction(()=>personalWorkspace().store.ready);await loaded();assert.deepEqual(await labels.allTextContents(),['Zeitausgleich: entscheidbar']);
    assert.equal(await page.evaluate(()=>savedPersonal['BEISPIEL-01'].version),2);
    await page.locator('#personnelDashboardCustomizeButton').click();await page.locator('[data-dashboard-choice="card:collectiveAgreements"]').uncheck();await saveSettings(page);await tab(page,1).click();await loaded();
    await page.locator('#personnelDashboardCustomizeButton').click();await page.locator('[data-dashboard-choice="card:collectiveAgreements"]').check();await saveSettings(page);assert.equal(await page.locator('[data-personnel-dashboard-field="collectiveAgreements"]').isVisible(),true);
    await tab(page,2).click();await loaded();assert.equal(await page.locator('[data-personnel-dashboard-field="collectiveAgreements"]').isVisible(),false);
    await screenshot(page,'actual-personnel-app-selected-information.png');assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
