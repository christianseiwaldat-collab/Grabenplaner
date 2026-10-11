'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const UI=require('../test-support/personnel-dashboard-ui');
const options={skip:process.env.GP_WINDOW_BROWSER_TEST!=='1',timeout:60000};
async function browser(){const {chromium}=require(process.env.GP_BROWSER_TEST_MODULE||'playwright');return chromium.launch({headless:true,...(process.env.GP_BROWSER_EXECUTABLE?{executablePath:process.env.GP_BROWSER_EXECUTABLE}:{}),args:['--no-first-run']});}
const card=id=>`[data-personnel-dashboard-field="${id}"]`;
const editor='[data-gp-window-id="personnel-dashboard-field-editor"]';
async function loaded(page){await page.waitForFunction(()=>Object.values(infoRecords()).every(row=>row.status!=='loading'));}
async function edit(page,id){await page.locator(`[data-dashboard-field-menu="card:${id}"]`).click();await page.locator('[data-field-edit]').click();assert.equal(await page.locator(editor).evaluate(node=>node.open&&!node.matches(':modal')),true);}
async function choose(page,...ids){await page.locator(`${editor} [data-field-content]`).evaluateAll(nodes=>nodes.forEach(node=>{node.checked=false;}));for(const id of ids)await page.locator(`${editor} [data-field-content="${id}"]`).check();}
async function save(page){await page.locator(`${editor} [type=submit]`).click();await page.waitForFunction(()=>!document.querySelector('[data-gp-window-id="personnel-dashboard-field-editor"]').open);await loaded(page);}

test('Personal close hides a floating field, persists on reload and customizer restores its saved geometry',options,async()=>{
 const b=await browser();try{const page=await b.newPage({viewport:{width:1440,height:1000}});const {errors}=await UI.prepare(page,{workspace:true});
 const id='collectiveAgreements';await page.evaluate(async()=>{const value=personalWorkspace().store.value;value.fields['card:collectiveAgreements']={geometry:{x:500,y:80,width:360,height:300}};await personalWorkspace().store.change(value);});
 assert.equal(await page.locator('[data-dashboard-floating="card:collectiveAgreements"]').count(),1);
 await page.locator('[data-dashboard-field-menu="card:collectiveAgreements"]').click();assert.equal(await page.locator('[data-field-close]').textContent().then(value=>value.trim()),'Feld schließen');await page.locator('[data-field-close]').click();
 await page.waitForFunction(()=>savedPersonal['BEISPIEL-01']?.fields['card:collectiveAgreements']?.hidden===true);
 assert.equal(await page.locator(card(id)).isVisible(),false);assert.equal(await page.locator('[data-dashboard-floating="card:collectiveAgreements"]').count(),0);assert.equal(await page.locator('[data-field-menu]').isVisible(),false);assert.equal(await page.evaluate(()=>document.activeElement.id),'personnelDashboardCustomizeButton');
 await page.evaluate(()=>{personalWorkspace().store.invalidate();syncPersonnelDashboardWorkspace();});await page.waitForFunction(()=>personalWorkspace().store.ready);assert.equal(await page.locator(card(id)).isVisible(),false);
 await page.locator('#personnelDashboardCustomizeButton').click();await page.locator('[data-personnel-dashboard-visible="collectiveAgreements"]').check();await page.locator('#savePersonnelDashboardLayout').click();await page.waitForFunction(()=>document.querySelector('#personnelDashboardCustomizer').classList.contains('hidden'));
 assert.equal(await page.locator(card(id)).isVisible(),true);assert.equal(await page.locator('[data-dashboard-floating="card:collectiveAgreements"]').count(),1);assert.deepEqual(await page.evaluate(()=>savedPersonal['BEISPIEL-01'].fields['card:collectiveAgreements'].geometry),{x:500,y:80,width:360,height:300});
 await page.screenshot({path:path.join(UI.screenshotDirectory(),'dashboard-floating-close-restored.png')});assert.deepEqual(errors,[]);
 }finally{await b.close();}
});

test('Personal contents: ZA-only, empty fields, reload, other actor and rights preserve selected data boundaries',options,async()=>{
 const b=await browser();try{const page=await b.newPage({viewport:{width:1440,height:1000}});const {errors}=await UI.prepare(page,{workspace:true});
 await edit(page,'requests');assert.equal(await page.locator(`${editor} [data-field-content]`).count(),4);await choose(page,'absence.timeOff');await save(page);
 assert.deepEqual(await page.evaluate(()=>savedPersonal['BEISPIEL-01'].fields['card:requests'].content),['absence.timeOff']);
 assert.deepEqual(await page.locator(`${card('requests')} dt`).allTextContents(),['Zeitausgleich: entscheidbar']);assert.deepEqual(await page.locator(`${card('requests')} h4`).allTextContents(),['Zeitausgleichsanträge']);assert.doesNotMatch(await page.locator(`${card('requests')} .personnel-dashboard-info`).textContent(),/Urlaub/);
 await page.evaluate(()=>{calls=[];syncPersonnelDashboardInformation({force:true});});await loaded(page);const calls=await page.evaluate(()=>calls);assert.ok(calls.includes('/api/portal/v1/absence-requests'));assert.ok(!calls.some(url=>url.includes('amu-reports')||url.includes('sickness-cases')));
 await page.evaluate(()=>{personalWorkspace().store.invalidate();syncPersonnelDashboardWorkspace();});await page.waitForFunction(()=>personalWorkspace().store.ready);await loaded(page);assert.deepEqual(await page.locator(`${card('requests')} dt`).allTextContents(),['Zeitausgleich: entscheidbar']);
 await edit(page,'employees');await choose(page,'employees.active');await save(page);assert.deepEqual(await page.locator(`${card('employees')} dt`).allTextContents(),['Aktiv']);
 await edit(page,'employees');await choose(page);await save(page);assert.deepEqual(await page.evaluate(()=>savedPersonal['BEISPIEL-01'].fields['card:employees'].content),[]);assert.equal(await page.locator(`${card('employees')} dt`).count(),0);assert.match(await page.locator(`${card('employees')} .personnel-dashboard-info`).textContent(),/Keine Kennzahlen ausgewählt/);
 await page.evaluate(()=>{calls=[];syncPersonnelDashboardInformation({force:true});});await loaded(page);assert.ok(!(await page.evaluate(()=>calls)).includes('/api/personnel-directory'));
 await page.evaluate(()=>{state.portalSession={...state.portalSession,user:{...state.portalSession.user,employeeNumber:'BEISPIEL-02'}};syncPersonnelDashboardWorkspace();});await page.waitForFunction(()=>personalWorkspace().store.ready);await loaded(page);assert.equal(await page.locator(`${card('employees')} dt`).count(),3);assert.equal(await page.locator(`${card('requests')} dt`).count(),4);
 await page.evaluate(()=>{state.portalSession={...state.portalSession,user:{...state.portalSession.user,employeeNumber:'BEISPIEL-01'}};syncPersonnelDashboardWorkspace();});await page.waitForFunction(()=>personalWorkspace().store.ready);await loaded(page);assert.equal(await page.locator(`${card('employees')} dt`).count(),0);assert.deepEqual(await page.locator(`${card('requests')} dt`).allTextContents(),['Zeitausgleich: entscheidbar']);
 await page.evaluate(()=>{calls=[];denied.add('vacation');syncPersonnelDashboardInformation({force:true});});await loaded(page);assert.ok(!(await page.evaluate(()=>calls)).includes('/api/portal/v1/absence-requests'));assert.equal(await page.locator(`${card('requests')} dt`).count(),0);assert.match(await page.locator(`${card('requests')} .personnel-dashboard-info`).textContent(),/Nicht freigegeben/);
 assert.deepEqual(errors,[]);
 }finally{await b.close();}
});

test('Personal field editor retains failed/newer edits and an old completion cannot close a reopened editor',options,async()=>{
 const b=await browser();try{const page=await b.newPage({viewport:{width:1440,height:1000}});const {errors}=await UI.prepare(page,{workspace:true});
 await edit(page,'requests');await choose(page,'absence.timeOff');await page.evaluate(()=>{preferenceFailure=true;});await page.locator(`${editor} [type=submit]`).click();await page.waitForFunction(()=>document.querySelector('[data-field-error]').textContent.includes('nicht gespeichert'));
 assert.equal(await page.locator(editor).evaluate(node=>node.open),true);assert.equal(await page.locator(`${editor} [data-field-content="absence.timeOff"]`).isChecked(),true);assert.equal(await page.evaluate(()=>savedPersonal['BEISPIEL-01']),undefined);
 await page.evaluate(()=>{preferenceFailure=false;holdPreferenceWrites=true;});await page.locator(`${editor} [type=submit]`).click();await page.waitForFunction(()=>heldPreferenceWrites.length===1);await page.locator(`${editor} [data-field-content="absence.vacation"]`).check();await page.evaluate(()=>{holdPreferenceWrites=false;heldPreferenceWrites.shift().resolve();});await page.waitForFunction(()=>document.querySelector('[data-field-error]').textContent.includes('Neuere Änderungen'));
 assert.equal(await page.locator(editor).evaluate(node=>node.open),true);assert.deepEqual(await page.evaluate(()=>savedPersonal['BEISPIEL-01'].fields['card:requests'].content),['absence.timeOff']);await save(page);assert.deepEqual(await page.evaluate(()=>savedPersonal['BEISPIEL-01'].fields['card:requests'].content),['absence.vacation','absence.timeOff']);
 await edit(page,'requests');await choose(page,'amu.total');await page.evaluate(()=>{holdPreferenceWrites=true;});await page.locator(`${editor} [type=submit]`).click();await page.waitForFunction(()=>heldPreferenceWrites.length===1);await page.locator(`${editor} [data-field-back]`).click();await edit(page,'employees');await page.evaluate(()=>{holdPreferenceWrites=false;heldPreferenceWrites.shift().resolve();});await page.waitForTimeout(30);assert.equal(await page.locator(editor).evaluate(node=>node.open),true);assert.equal(await page.locator(`${editor} [type=submit]`).isEnabled(),true);
 await page.locator(`${editor} [data-field-back]`).click();await edit(page,'requests');await page.evaluate(()=>{holdPreferenceWrites=true;});await page.locator(`${editor} [type=submit]`).click();await page.waitForFunction(()=>heldPreferenceWrites.length===1);await page.evaluate(()=>{state.portalSession={...state.portalSession,user:{...state.portalSession.user,employeeNumber:'BEISPIEL-02'}};syncPersonnelDashboardWorkspace();});await page.waitForFunction(()=>personalWorkspace().store.ready);await edit(page,'employees');await page.evaluate(()=>{holdPreferenceWrites=false;heldPreferenceWrites.shift().resolve();});await page.waitForTimeout(30);assert.equal(await page.locator(editor).evaluate(node=>node.open),true);assert.equal(await page.evaluate(()=>savedPersonal['BEISPIEL-02']),undefined);assert.equal(await page.locator(`${editor} [type=submit]`).isEnabled(),true);
 assert.deepEqual(errors,[]);
 }finally{await b.close();}
});

test('Personal 390px touch contents and field close are compact and preserve desktop geometry',options,async()=>{
 const b=await browser();try{const page=await b.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const {errors}=await UI.prepare(page,{workspace:true});
 await page.locator('[data-dashboard-field-menu="card:requests"]').tap();await page.locator('[data-field-edit]').tap();await choose(page,'absence.timeOff');assert.equal(await page.locator(`${editor} [data-field-content]`).evaluateAll(nodes=>nodes.every(node=>parseFloat(getComputedStyle(node.closest('label')).minHeight)>=44)),true);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.screenshot({path:path.join(UI.screenshotDirectory(),'dashboard-mobile-content-editor.png')});await save(page);assert.deepEqual(await page.locator(`${card('requests')} dt`).allTextContents(),['Zeitausgleich: entscheidbar']);
 await page.evaluate(async()=>{const value=personalWorkspace().store.value;value.fields['card:collectiveAgreements']={geometry:{x:500,y:80,width:360,height:300}};await personalWorkspace().store.change(value);});await page.locator('[data-dashboard-field-menu="card:collectiveAgreements"]').tap();await page.locator('[data-field-close]').tap();await page.waitForFunction(()=>savedPersonal['BEISPIEL-01'].fields['card:collectiveAgreements'].hidden===true);
 assert.equal(await page.locator(card('collectiveAgreements')).isVisible(),false);assert.deepEqual(await page.evaluate(()=>savedPersonal['BEISPIEL-01'].fields['card:collectiveAgreements'].geometry),{x:500,y:80,width:360,height:300});await page.setViewportSize({width:1440,height:1000});assert.equal(await page.locator('[data-dashboard-floating="card:collectiveAgreements"]').count(),0);assert.equal(await page.locator(card('collectiveAgreements')).isVisible(),false);assert.deepEqual(errors,[]);
 }finally{await b.close();}
});
