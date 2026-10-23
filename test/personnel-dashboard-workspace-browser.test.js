"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),path=require("node:path"),fs=require("node:fs");
const UI=require("../test-support/personnel-dashboard-ui");
const options={skip:process.env.GP_WINDOW_BROWSER_TEST!=="1",timeout:60000};
async function browser(){const {chromium}=require(process.env.GP_BROWSER_TEST_MODULE||"playwright");return chromium.launch({headless:true,...(process.env.GP_BROWSER_EXECUTABLE?{executablePath:process.env.GP_BROWSER_EXECUTABLE}:{}),args:["--no-first-run"]});}
for(const mobile of [false,true])test(`Personal-Informationsfelder actual ${mobile?"390px Touch":"Desktop"}: Quellen, lesbare Texte, stabile Karten und eigener Navigationsbutton`,options,async()=>{
  const b=await browser();try{
    const page=await b.newPage({viewport:mobile?{width:390,height:844}:{width:1440,height:1000},isMobile:mobile,hasTouch:mobile});const {errors}=await UI.prepare(page);
    assert.equal(await page.evaluate(()=>innerWidth),mobile?390:1440);
    assert.equal(await page.locator("article[data-personnel-dashboard-field]").count(),12);
    assert.equal(await page.locator(".personnel-dashboard-open").count(),12);
    assert.equal(await page.locator('[data-personnel-dashboard-source="candidates"]').getAttribute("data-source-status"),"partial");
    assert.match(await page.locator('[data-personnel-dashboard-source="vacations"]').textContent(),/Urlaubsjahr 2026/);
    assert.match(await page.locator('[data-personnel-dashboard-source="timeTracking"]').textContent(),/Tagesbestand, keine Stundensumme/);
    assert.deepEqual(await page.evaluate(()=>[...document.querySelector('[data-personnel-dashboard-source="employees"]').querySelectorAll("dd")].map(n=>n.textContent)),["3","2","1"]);
    const fonts=await page.evaluate(()=>[...document.querySelectorAll('.personnel-dashboard-card-copy small,.personnel-dashboard-card-copy p,.personnel-dashboard-source-caption,.personnel-dashboard-source-state,dt')].filter(n=>n.getClientRects().length).map(n=>parseFloat(getComputedStyle(n).fontSize)));
    assert.ok(fonts.length>70);assert.ok(fonts.every(n=>n>=13),"Visible labels and descriptions must be at least 13px");
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.evaluate(()=>{window.cardBefore=document.querySelector('[data-personnel-dashboard-field="employees"]');window.buttonBefore=cardBefore.querySelector("button");buttonBefore.focus();renderPersonnelDashboard();});
    assert.equal(await page.evaluate(()=>cardBefore===document.querySelector('[data-personnel-dashboard-field="employees"]')&&buttonBefore===document.activeElement),true);
    await page.locator('[data-personnel-dashboard-field="employees"] dd').first().click();assert.equal(await page.evaluate(()=>navigated.length),0);
    await page.locator('[data-personnel-dashboard-item="employees"]').click();assert.deepEqual(await page.evaluate(()=>navigated),["employees"]);
    await page.screenshot({path:path.join(UI.screenshotDirectory(),`block15-${mobile?"mobile":"desktop"}-dashboard.png`),fullPage:true});
    await page.screenshot({path:path.join(UI.screenshotDirectory(),`block15-${mobile?"mobile":"desktop"}-viewport.png`)});
    fs.writeFileSync(path.join(UI.screenshotDirectory(),`block15-${mobile?"mobile":"desktop"}-browser.json`),JSON.stringify({syntheticOnly:true,actualMarkup:true,actualAppFunctions:true,viewport:mobile?390:1440,innerWidth:await page.evaluate(()=>innerWidth),hasTouch:mobile,visibleLabelCount:fonts.length,minFontSize:Math.min(...fonts),maxFontSize:Math.max(...fonts),horizontalOverflow:false,stableCardAndFocusedButton:true,sourceCount:15,cardCount:12,pageErrors:errors},null,2)+"\n");
    assert.deepEqual(errors,[]);
  }finally{await b.close();}
});
test("Personal-Dashboard actual loader: Rechte, Sitzung-ABA, Navigation und Filter invalidieren eigene Quellen",options,async()=>{
  const b=await browser();try{
    const page=await b.newPage({viewport:{width:1440,height:1000}});const {errors}=await UI.prepare(page);
    await page.evaluate(()=>{window.cardBefore=document.querySelector('[data-personnel-dashboard-field="employees"]');hold=true;void syncPersonnelDashboardInformation({force:true});});
    await page.waitForFunction(()=>held.length===15);
    await page.evaluate(()=>{const old=state.portalSession;state.portalSession={...old,user:{...old.user}};hold=false;syntheticEmployeeCount=0;void syncPersonnelDashboardInformation();});
    await page.waitForFunction(()=>Object.values(infoRecords()).every(r=>r.status!=="loading"));
    await page.evaluate(()=>{held.forEach(r=>r.resolve());held=[];});await page.waitForTimeout(30);
    assert.equal(await page.locator('[data-personnel-dashboard-source="employees"] dd').first().textContent(),"0");
    assert.equal(await page.evaluate(()=>document.querySelector('[data-personnel-dashboard-field="employees"]')===cardBefore),true);
    await page.evaluate(()=>{hold=true;void syncPersonnelDashboardInformation({force:true});});await page.waitForFunction(()=>held.length===15);
    await page.evaluate(()=>{state.currentView="planning";void syncPersonnelDashboardInformation();});
    assert.deepEqual(await page.evaluate(()=>infoRecords()),{});
    assert.equal(await page.evaluate(()=>held.every(r=>r.options.signal.aborted)),true);
    await page.evaluate(()=>{held.forEach(r=>r.resolve());held=[];hold=false;state.currentView="personnelAdministration";state.centralVacationYear=2027;state.locationId="19";state.departmentId="3";void syncPersonnelDashboardInformation();});
    await page.waitForFunction(()=>Object.values(infoRecords()).every(r=>r.status!=="loading"));
    assert.match(await page.locator('[data-personnel-dashboard-source="vacations"]').textContent(),/Urlaubsjahr 2027/);
    assert.equal(await page.evaluate(()=>calls.some(url=>url.includes("locationId=19")&&url.includes("departmentId=3"))),true);
    await page.evaluate(()=>{denied.add("canReadCentralPersonnel");denied.add("canReadPersonnelWorkflowInstances");renderPersonnelDashboard();});
    await page.waitForFunction(()=>Object.values(infoRecords()).every(r=>r.status!=="loading"));
    assert.equal(await page.locator('[data-personnel-dashboard-field="employees"]').count(),0);
    assert.equal(await page.locator('[data-personnel-dashboard-source="workflows"]').getAttribute("data-source-status"),"denied");
    await page.evaluate(()=>{failSources.add("/api/cost-centers");forbiddenSources.add("/api/portal/v1/personnel-lifecycle/onboarding/tasks");void syncPersonnelDashboardInformation({force:true});});
    await page.waitForFunction(()=>Object.values(infoRecords()).every(r=>r.status!=="loading"));
    assert.equal(await page.locator('[data-personnel-dashboard-source="costCenters"]').getAttribute("data-source-status"),"failed");
    assert.equal(await page.locator('[data-personnel-dashboard-source="costCenters"] dd').count(),0);
    assert.equal(await page.locator('[data-personnel-dashboard-source="onboarding"]').getAttribute("data-source-status"),"denied");
    assert.equal(await page.locator('[data-personnel-dashboard-source="offboarding"]').getAttribute("data-source-status"),"succeeded");
    await page.screenshot({path:path.join(UI.screenshotDirectory(),"block15-desktop-source-states.png"),fullPage:true});
    await page.evaluate(()=>{failSources.clear();forbiddenSources.clear();});await page.getByRole("button",{name:"Kennzahlen neu laden"}).click();
    await page.waitForFunction(()=>infoRecords().costCenters.status==="succeeded");assert.deepEqual(errors,[]);
    await page.evaluate(()=>{state.portalSession=null;void syncPersonnelDashboardInformation();});
    assert.deepEqual(await page.evaluate(()=>infoRecords()),{});
    assert.equal(await page.locator("#personnelDashboardGrid dd").count(),0);
  }finally{await b.close();}
});
