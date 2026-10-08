"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const repo = path.join(__dirname, ".."), enabled = process.env.GP_WINDOW_BROWSER_TEST === "1";
const source = fs.readFileSync(path.join(repo, "public/app.js"), "utf8");
const controller = source.slice(source.indexOf("function renderLoanSettings()"), source.indexOf("function navigationGroups()"));
const locations = [
  {locationId:"18", locationName:"BEISPIEL West", enabled:true, returnPolicy:{requiresWitness:false}, articleLookup:{enabled:false,provider:"none",baseUrl:""}, photoPdf:{outputMode:"grayscale",originalRetention:"retain"},emailDelivery:{enabled:false,recipient:"",provider:{configured:true,loanDocumentAvailable:true}}},
  {locationId:"05", locationName:"BEISPIEL Ost", enabled:false, returnPolicy:{requiresWitness:true}, articleLookup:{enabled:false,provider:"none",baseUrl:""}, photoPdf:{outputMode:"grayscale",originalRetention:"retain"},emailDelivery:{enabled:false,recipient:"",provider:{configured:false,loanDocumentAvailable:false}}},
];
async function browser() {
  const {chromium} = require(process.env.GP_BROWSER_TEST_MODULE || "playwright");
  return chromium.launch({headless:true, ...(process.env.GP_BROWSER_EXECUTABLE ? {executablePath:process.env.GP_BROWSER_EXECUTABLE} : {}), args:["--no-first-run"]});
}
async function setup(page, {policyOnly=false}={}) {
  const errors=[];page.on("pageerror",error=>errors.push(error.message));
  await page.setContent('<main><p id="loanSettingsHint"></p><div class="loan-settings-list" id="loanSettingsList"></div></main>');
  for(const file of ["styles.css","loan-location-settings.css"]) await page.addStyleTag({path:path.join(repo,"public",file)});
  await page.addScriptTag({path:path.join(repo,"public/loan-location-settings.js")});
  await page.evaluate(({locations,policyOnly})=>{
    window.actor="BEISPIEL:A";window.policyOnly=policyOnly;window.notices=[];window.calls=[];
    window.state={loanSettings:{locations},allEmployees:[],loanSettingsLoading:false,loanSettingsLoadingKey:"",loanSettingsActor:actor,loanSettingsRequest:0};
    window.elements={loanSettingsList:document.getElementById("loanSettingsList"),loanSettingsHint:document.getElementById("loanSettingsHint")};
    window.canManageFullLoanSettings=()=>!window.policyOnly;
    window.loanSettingsActorKey=()=>actor;
    window.showToast=text=>notices.push(text);
    window.api=(route,options)=>new Promise((resolve,reject)=>calls.push({route,options,resolve,reject}));
  },{locations,policyOnly});
  await page.addScriptTag({content:controller+"\nrenderLoanSettings();"});
  await page.evaluate(()=>elements.loanSettingsList.addEventListener("submit",event=>{event.preventDefault();void saveLoanLocationSetting(event.target);}));
  return errors;
}
test("loan location disclosures preserve other drafts and post-submit edits",{skip:!enabled,timeout:60000},async()=>{
  const instance=await browser();try{
    const page=await instance.newPage({viewport:{width:900,height:850}}),errors=await setup(page);
    const west=page.locator('[data-loan-location="18"]'),east=page.locator('[data-loan-location="05"]');
    assert.equal(await west.getAttribute("open"),null);await west.locator("summary").first().click();await east.locator("summary").first().click();
    await east.locator('[name="emailRecipient"]').fill("new@example.test");
    await west.locator('[name="emailRecipient"]').fill("saved@example.test");
    await west.locator('button[type="submit"]').click();
    await west.locator('[name="emailRecipient"]').fill("later@example.test");
    await page.evaluate(location=>calls[0].resolve({location}),locations[0]);
    await page.waitForFunction(()=>document.querySelector('[data-loan-location="18"] [data-loan-setting-message]').textContent.includes("Neuere Eingaben"));
    assert.equal(await west.locator('[name="emailRecipient"]').inputValue(),"later@example.test");
    assert.equal(await east.locator('[name="emailRecipient"]').inputValue(),"new@example.test");
    assert.notEqual(await east.getAttribute("open"),null);
    const sent=await page.evaluate(()=>JSON.parse(calls[0].options.body));assert.equal(sent.emailDelivery.recipient,"saved@example.test");
    assert.deepEqual(errors,[]);
  }finally{await instance.close();}
});
test("scoped policy settings send only the return rule, and do not expose full configuration",{skip:!enabled,timeout:60000},async()=>{
  const instance=await browser();try{
    const page=await instance.newPage({viewport:{width:420,height:820}}),errors=await setup(page,{policyOnly:true});
    const west=page.locator('[data-loan-location="18"]');await west.locator("summary").first().click();
    assert.equal(await page.locator('[name="emailRecipient"],[name="enabled"],[name="lookupProvider"]').count(),0);
    await west.locator('[name="requiresWitness"]').check();await west.locator('button[type="submit"]').click();
    const call=await page.evaluate(()=>({route:calls[0].route,body:JSON.parse(calls[0].options.body)}));
    assert.equal(call.route,"/api/portal/v1/loans/settings/locations/18/return-policy");assert.deepEqual(call.body,{returnPolicy:{requiresWitness:true}});
    await page.evaluate(location=>calls[0].resolve({location}),{...locations[0],returnPolicy:{requiresWitness:true}});
    await page.waitForFunction(()=>document.querySelector('[data-loan-location="18"] [data-loan-setting-message]').textContent==="Gespeichert.");
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
  }finally{await instance.close();}
});

test("revoked return-policy permission leaves other loan settings editable without posting the rule",{skip:!enabled,timeout:60000},async()=>{
  const instance=await browser();try{
    const page=await instance.newPage(),errors=await setup(page);
    await page.evaluate(()=>{state.portalStatus={portalEnabled:true};state.portalSession={user:{permissions:["loans:settings"]}};renderLoanSettings();});
    const west=page.locator('[data-loan-location="18"]');await west.locator("summary").first().click();
    assert.equal(await west.locator('[name="requiresWitness"]').isDisabled(),true);
    await west.locator('[name="emailRecipient"]').fill("saved@example.test");await west.locator('button[type="submit"]').click();
    const sent=await page.evaluate(()=>JSON.parse(calls[0].options.body));
    assert.equal(Object.hasOwn(sent,"returnPolicy"),false);assert.equal(sent.emailDelivery.recipient,"saved@example.test");
    assert.deepEqual(errors,[]);
  }finally{await instance.close();}
});
test("old load and save responses cannot cross an account change",{skip:!enabled,timeout:60000},async()=>{
  const instance=await browser();try{
    const page=await instance.newPage(),errors=await setup(page);
    const west=page.locator('[data-loan-location="18"]');await west.locator("summary").first().click();await west.locator('button[type="submit"]').click();
    const loading=page.evaluate(()=>loadLoanSettings());await page.waitForFunction(()=>calls.length===2);
    await page.evaluate(()=>{actor="BEISPIEL:B";policyOnly=true;void loadLoanSettings();});
    await page.waitForFunction(()=>calls.length===3);
    assert.equal(await page.locator('[data-loan-location]').count(),0);
    await page.evaluate(location=>{calls[0].resolve({location});calls[1].resolve({locations:[location]});},locations[0]);await loading;
    assert.equal(await page.locator('[data-loan-location]').count(),0);
    await page.evaluate(location=>calls[2].resolve({locations:[location]}),locations[1]);
    await page.waitForFunction(()=>document.querySelector('[data-loan-location="05"]'));
    assert.equal(await page.locator('[data-loan-location="18"]').count(),0);assert.deepEqual(await page.evaluate(()=>notices),[]);assert.deepEqual(errors,[]);
  }finally{await instance.close();}
});
