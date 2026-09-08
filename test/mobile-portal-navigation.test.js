"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname,"..","public","portal.js"),"utf8");
function declaration(name,next) { return source.slice(source.indexOf(`function ${name}(`),source.indexOf(`function ${next}(`)); }

test("Touch-Geräte im Querformat behalten auch mit Desktop-Kennung die mobile Bedienung",()=>{
  for(const filename of ["portal.js","app.js"]){
    const script=fs.readFileSync(path.join(__dirname,"..","public",filename),"utf8");
    const deviceMode=script.slice(script.indexOf("function applyDeviceMode()"),script.indexOf("\napplyDeviceMode();"));
    for(const [width,touch,expected] of [[932,true,"mobile"],[932,false,"desktop"],[1440,true,"desktop"],[390,false,"mobile"]]){
      const context={document:{documentElement:{dataset:{}}},navigator:{userAgent:"Macintosh Safari"},portalState:{session:null},window:{matchMedia(query){return {matches:query.includes("pointer")?touch:width<=Number(query.match(/max-width: (\d+)/)[1])};}}};
      vm.createContext(context);vm.runInContext(deviceMode,context);context.applyDeviceMode();
      assert.equal(context.document.documentElement.dataset.uiMode,expected,`${filename}: ${width}, touch=${touch}`);
    }
  }
});
test("Mobile Standardnavigation lässt Platz für Start und Mehr und zeigt Anträge direkt",()=>{
  const context={availablePersonalMobileModules:()=>["time","tasks","schedule","requests","loan","sickness"],isLeadershipUser:()=>false};
  vm.createContext(context);vm.runInContext(declaration("defaultPersonalMobileSelection","createMobileNavigationDraft"),context);
  assert.deepEqual(Array.from(context.defaultPersonalMobileSelection()),["time","schedule","requests"]);
  context.availablePersonalMobileModules=()=>["schedule","loan"];
  assert.deepEqual(Array.from(context.defaultPersonalMobileSelection()),["schedule","loan"]);
});
function navigationRuntime({mobile,modules}) {
  const buttons=["home","history","timeOff","vacation","leadershipMore"].map(tab=>({dataset:{tab},attributes:{},classList:{toggle(key,value){this[key]=value;}},setAttribute(key,value){this.attributes[key]=value;}}));
  const context={portalState:{mobileLeadership:mobile},effectiveMobileModules:()=>modules,mobileModuleByTab:new Map([["history","requests"]]),mobileMoreSecondaryTabs:new Set(["timeOff","vacation"]),document:{querySelectorAll:()=>buttons,querySelector:()=>null}};
  vm.createContext(context);vm.runInContext(declaration("syncPortalTabButtons","renderMobileMoreShortcuts"),context);
  return {buttons,context};
}
test("ZA und Urlaub bleiben mobil unter Anträge orientiert, am Desktop in ihrem eigenen Tab",()=>{
  for(const tab of ["timeOff","vacation"]){
    for(const mobile of [true,false]){
      const {buttons,context}=navigationRuntime({mobile,modules:["time","schedule","requests","more"]});
      context.syncPortalTabButtons(tab);
      assert.deepEqual(buttons.filter(b=>b.classList.active).map(b=>b.dataset.tab),[mobile?"history":tab]);
      assert.equal(buttons.find(b=>b.classList.active).attributes["aria-selected"],"true");
    }
  }
});
test("Bei persönlicher Navigation ohne Anträge bleibt der Weg über Mehr markiert",()=>{
  const {buttons,context}=navigationRuntime({mobile:true,modules:["time","schedule","more"]});
  context.syncPortalTabButtons("timeOff");
  assert.deepEqual(buttons.filter(b=>b.classList.active).map(b=>b.dataset.tab),["leadershipMore"]);
});
