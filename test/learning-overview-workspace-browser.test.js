"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),path=require("node:path"),fs=require("node:fs");
const fixture=require("../test-support/learning-workspace-ui");
test("learning overview and exact page matrix stay readable in desktop and real 390px touch layout",{skip:process.env.GP_WINDOW_BROWSER_TEST!=="1",timeout:60000},async()=>{
  const {chromium}=require(process.env.GP_BROWSER_TEST_MODULE||"playwright"),browser=await chromium.launch({headless:true,...(process.env.GP_BROWSER_EXECUTABLE?{executablePath:process.env.GP_BROWSER_EXECUTABLE}:{}),args:["--no-first-run"]});
  const measurements=[];
  try{for(const mode of [{name:"desktop",viewport:{width:1440,height:1000}},{name:"mobile",viewport:{width:390,height:844},isMobile:true,hasTouch:true}]){
    const context=await browser.newContext(mode),page=await context.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));
    await fixture.prepare(page,{areas:["team"]});await page.evaluate(()=>team.load());
    assert.deepEqual(await page.locator('#personnelLearningSection > details[data-learning-area]').evaluateAll(nodes=>nodes.map(node=>node.dataset.learningArea)),["assignments","team","competencies","skills","processes","knowledge"]);
    assert.deepEqual(await page.locator('.learning-workspace-group h3').allTextContents(),["Schulungen begleiten","Fähigkeiten entwickeln","Wissen & Vorlagen"]);
    assert.equal(await page.locator('#personnelLearningSection > :last-child > summary > strong').textContent(),"Wissenskatalog");
    assert.equal(await page.evaluate(()=>innerWidth),mode.viewport.width);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.match(await page.locator(".learning-team-page-summary").textContent(),/Diese Seite · 25 % erfüllt/);
    assert.match(await page.locator(".learning-team-page-summary").textContent(),/2 angezeigten Personen/);
    assert.match(await page.locator(".learning-team-pagination").textContent(),/von 120 Personen/);
    assert.equal(await page.locator(".learning-team-table").isVisible(),mode.name==="desktop");
    assert.equal(await page.locator(".learning-team-people").isVisible(),mode.name==="mobile");
    assert.equal(await page.locator(".learning-team-person").count(),2);
    assert.deepEqual(await page.locator(".learning-team-table tbody .learning-team-status").allTextContents(),await page.locator(".learning-team-people .learning-team-status").allTextContents());
    const fonts=await page.evaluate(()=>[...document.querySelectorAll('#personnelLearningDashboardPanel :is(small,h5,p,.field>span,.personnel-learning-skill-level-rail b),#personnelLearningTeam :is(label,small,.learning-team-status,.learning-team-pagination)')].filter(n=>n.checkVisibility()).map(n=>({tag:n.tagName,class:n.className,size:parseFloat(getComputedStyle(n).fontSize)})));
    assert.ok(fonts.length>25);assert.deepEqual(fonts.filter(f=>f.size<13),[],"Every visible overview/matrix label and metadata must be at least 13 CSS px");
    await page.screenshot({path:path.join(fixture.screenshotDirectory(),`block12-${mode.name}-overview.png`),fullPage:true});
    await page.locator('[data-learning-area="team"]').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(fixture.screenshotDirectory(),`block12-${mode.name}-matrix.png`),fullPage:false});
    assert.deepEqual(errors,[]);measurements.push({mode:mode.name,width:mode.viewport.width,minFont:Math.min(...fonts.map(f=>f.size)),textNodes:fonts.length,touch:mode.hasTouch===true});await context.close();
  }}finally{await browser.close();}
  fs.writeFileSync(path.join(fixture.screenshotDirectory(),"block12-font-measurements.json"),JSON.stringify(measurements,null,2)+"\n");
});
test("team requirement normal save succeeds while replaced editor and account ABA discard late responses",{skip:process.env.GP_WINDOW_BROWSER_TEST!=="1",timeout:60000},async()=>{
  const {chromium}=require(process.env.GP_BROWSER_TEST_MODULE||"playwright"),browser=await chromium.launch({headless:true,...(process.env.GP_BROWSER_EXECUTABLE?{executablePath:process.env.GP_BROWSER_EXECUTABLE}:{}),args:["--no-first-run"]});
  try{const page=await browser.newPage();await fixture.prepare(page,{areas:["team"]});await page.evaluate(()=>team.load());await page.locator(".learning-team-requirements summary").click();
    await page.locator('[data-edit="rule-a"]').click();await page.locator('.learning-team-dialog [name="title"]').fill("Normal erfolgreich speichern");await page.locator('.learning-team-dialog [type="submit"]').click();
    await page.waitForFunction(()=>teamWrites.length===1&&!document.querySelector('.learning-team-dialog')?.open&&optionsReads===2);
    assert.equal(await page.evaluate(()=>teamWrites[0].expectedReceipt),"a".repeat(64));
    await page.locator('[data-edit="rule-a"]').click();await page.evaluate(()=>holdSave=true);await page.locator('.learning-team-dialog [type="submit"]').click();await page.waitForFunction(()=>typeof releaseSave==="function");
    await page.locator('[data-edit="rule-b"]').click();await page.locator('.learning-team-dialog [name="title"]').fill("Neuer ungespeicherter Entwurf");await page.evaluate(()=>releaseSave());
    await page.waitForTimeout(100);assert.equal(await page.locator('.learning-team-dialog [name="title"]').inputValue(),"Neuer ungespeicherter Entwurf");assert.equal(await page.locator('.learning-team-dialog').getAttribute("open"),"");assert.equal(await page.evaluate(()=>optionsReads),2);
    await page.evaluate(()=>{releaseSave=null;});await page.locator('.learning-team-dialog [type="submit"]').click();await page.waitForFunction(()=>typeof releaseSave==="function");
    await page.evaluate(()=>{actor="BEISPIEL-B";manager.synchronize();actor="BEISPIEL-A";manager.synchronize();});await page.locator('[data-edit="rule-a"]').click();await page.locator('.learning-team-dialog [name="title"]').fill("Gleicher Account neue Sitzung");await page.evaluate(()=>releaseSave());
    await page.waitForTimeout(100);assert.equal(await page.locator('.learning-team-dialog [name="title"]').inputValue(),"Gleicher Account neue Sitzung");assert.equal(await page.evaluate(()=>optionsReads),2);
    await page.locator('.learning-team-dialog [data-gp-window-toggle]').click();assert.equal(await page.locator('.learning-team-dialog [name="title"]').inputValue(),"Gleicher Account neue Sitzung");await page.locator('.learning-team-dialog [data-gp-window-toggle]').click();assert.equal(await page.locator('.learning-team-dialog [name="title"]').inputValue(),"Gleicher Account neue Sitzung");
  }finally{await browser.close();}
});
