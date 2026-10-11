"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const Info = require("../public/personnel-dashboard-info.js");
const m = (type, value, scope) => Info.summarize(type, value, scope);
test("Personalbestand trennt aktiv/inaktiv; fehlender Status ist ein Teilstand", () => {
  assert.deepEqual(m("employees", { employees: [{active:true}, {active:false}] }).metrics.map(x=>x.value), [2,1,1]);
  const partial=m("employees", {employees:[{active:true},{}]});
  assert.equal(partial.status,"partial");assert.deepEqual(partial.metrics.map(x=>x.value),[2,1]);
  assert.throws(()=>m("employees",{}));
});
test("Positionen und Kostenstellen zählen Registereinträge, keine Personalzuordnungen",()=>{
  assert.deepEqual(m("positions",[{active:true,employee_count:100},{active:false}]).metrics.map(x=>x.value),[2,1,1]);
  assert.deepEqual(m("costCenters",{costCenters:[]}).metrics.map(x=>x.value),[0,0,0]);
});
test("Bewerbungsstichprobe behauptet ohne vollständige Quelle keinen Gesamtbestand",()=>{
  const candidates=Array.from({length:50},()=>({state:"active"}));
  const value={candidates,pagination:{limit:50,offset:0,hasMore:true},capabilities:{canReadCandidates:true}};
  const partial=m("candidates",value);assert.equal(partial.status,"partial");assert.deepEqual(partial.metrics.map(x=>x.value),[null,50]);
  assert.match(partial.caption,/Erste 50/);
  assert.deepEqual(m("candidates",{...value,pagination:{...value.pagination,total:120}}).metrics.map(x=>x.value),[120,50]);
  assert.throws(()=>m("candidates",{...value,pagination:{...value.pagination,total:10}}));
});
test("Vollständige erste Bewerbungsseite und leerer Bestand sind echte Gesamtwerte",()=>{
  for(const candidates of [[],[{}]])assert.equal(m("candidates",{candidates,pagination:{limit:50,offset:0,hasMore:false},capabilities:{canReadCandidates:true}}).metrics[0].value,candidates.length);
  assert.throws(()=>m("candidates",{candidates:[],pagination:{limit:50,offset:0,hasMore:false},capabilities:{canReadCandidates:false}}),{status:403});
});
test("Katalogsummen sind Gesamtbereich, überlappende Entwürfe und Veröffentlichungen bleiben getrennt",()=>{
  const result=m("learning",{modules:[],capabilities:{canRead:true},summary:{visible:7,published:5,drafts:3}});
  assert.deepEqual(result.metrics.map(x=>x.value),[7,5,3]);assert.match(result.caption,/zugleich veröffentlicht/);
  assert.throws(()=>m("learning",{modules:[],capabilities:{canRead:true},summary:{visible:0,published:0}}));
});
test("M5 Instanzen zählen open/resolved und nicht Schritte oder O8-Vorlagen",()=>{
  assert.deepEqual(m("workflows",{capabilities:{canRead:true},instances:[{status:"open",progress:{totalSteps:10}},{status:"resolved"}]}).metrics.map(x=>x.value),[2,1]);
  assert.throws(()=>m("workflows",{capabilities:{canRead:true},instances:[{status:"active"}]}));
});
test("Zugewiesene On-/Offboarding-Schritte haben getrennte Quellen und eindeutige Identität",()=>{
  for(const type of ["onboarding","offboarding"]){
    const capability=type==="onboarding"?"canReadOnboardingTasks":"canReadOffboardingTasks";
    const value={capabilities:{[capability]:true},tasks:[{runId:"r",stepId:"s"}]};
    assert.equal(m(type,value).metrics[0].value,1);assert.match(m(type,value).caption,/persönlich zugewiesene/);
    assert.throws(()=>m(type,{...value,tasks:[...value.tasks,...value.tasks]}));
  }
});
test("Antragszahlen sind entscheidbare Kategorien, kein Jahres- oder Quartalswert",()=>{
  const result=m("absence",{requests:[{status:"approved"}],counts:{vacation:2,timeOff:3,total:5}});
  assert.deepEqual(result.metrics.map(x=>x.value),[2,3]);assert.match(result.caption,/kein Jahres- oder Quartalswert/);
  assert.throws(()=>m("absence",{requests:[],counts:{vacation:2,timeOff:3,total:4}}));
});

test("ZA-only filters the metric and uses a ZA title without hiding invalid source counts",()=>{
  const input={requests:[],counts:{vacation:2,timeOff:3,total:5}};
  const result=Info.summarize('absence',input,{},['absence.timeOff']);
  assert.deepEqual(result.metrics,[{id:'absence.timeOff',label:'Zeitausgleich: entscheidbar',value:3}]);
  assert.equal(result.title,'Zeitausgleichsanträge');assert.match(result.caption,/entscheidbare Zeitausgleichsanträge/);assert.doesNotMatch(result.caption,/Urlaub/);
  assert.equal(Info.summarize('absence',input,{},['absence.vacation']).title,'Urlaubsanträge');
  assert.throws(()=>Info.summarize('absence',{...input,counts:{vacation:2,timeOff:3,total:4}},{},['absence.timeOff']));
  assert.deepEqual(Info.summarize('absence',input,{},[]).metrics,[]);
  const partial=Info.summarize('employees',{employees:[{active:true},{}]},{},['employees.active']);
  assert.equal(partial.status,'partial');assert.deepEqual(partial.metrics,[], 'partial status does not pretend the selected active metric is complete');
});
test("Meldungen werten explizite PendingCounts aus und status-only ist nicht null",()=>{
  assert.equal(m("sickness",{cases:[],pendingCount:4}).metrics[0].value,4);
  assert.equal(m("amu",{reports:[],pendingCount:2,access:{available:true}}).metrics[0].value,2);
  assert.match(m("amu",{reports:[],pendingCount:2,access:{available:true}}).metrics[0].label,/Dir zugewiesene/);
  assert.match(m("amu",{reports:[],pendingCount:2,access:{available:true}}).caption,/persönlichen Zuständigkeit/);
  assert.throws(()=>m("amu",{reports:[],pendingCount:0,access:{available:false}}),{status:403});
  assert.throws(()=>m("sickness",{cases:[]}));
});
test("Anwesenheitsbestand bindet tatsächlichen Tag, Standort und Abteilung",()=>{
  const scope={date:"2026-10-11",locationId:"18",departmentId:"2"};
  const presence={...scope,employees:[{}],locationName:"Filiale 18",departmentName:"Verkauf"};
  assert.equal(m("timeTracking",{presence},scope).metrics[0].value,1);
  assert.match(m("timeTracking",{presence},scope).caption,/2026-10-11.*Filiale 18.*Verkauf/);
  for(const change of [{date:"2026-10-10"},{locationId:"19"},{departmentId:3}])assert.throws(()=>m("timeTracking",{presence:{...presence,...change}},scope));
});
test("Regelentwürfe und aktive Zuordnungen werden nicht addiert",()=>{
  assert.deepEqual(m("ruleDrafts",{drafts:[],summary:{drafts:3,pendingReview:2,active:7}}).metrics.map(x=>x.value),[3,2,7]);
});
test("KV-Quellenfassungen und Urlaubspersonen haben fachlich getrennte Einheiten",()=>{
  assert.deepEqual(m("collectiveAgreements",{agreements:[{versions:[{},{}]}],scopeLabel:"Eigener Bereich"}).metrics.map(x=>x.value),[1,2]);
  const vacations=[{employee_number:"A"},{employee_number:"A"},{employee_number:"B"}];
  assert.deepEqual(m("vacations",{year:2026,vacations},{year:2026}).metrics.map(x=>x.value),[3,2]);
  assert.throws(()=>m("vacations",{year:2025,vacations},{year:2026}));
});
function fixture(){
  let session={},actor="A",scope=2026,visible=true,allowed=true,content;
  const pending=[],changes=[];
  const sources=()=>[{id:"employees",card:"employees",type:"employees",url:"/api/personnel-directory",allowed,scope:{year:scope},content}];
  const controller=Info.create({sources,capture:()=>({session,actor}),current:t=>t.session===session&&t.actor===actor,active:()=>visible,
    onChange:records=>changes.push(structuredClone(records)),api:(url,options)=>new Promise((resolve,reject)=>pending.push({url,options,resolve,reject}))});
  return {controller,pending,changes,change(values){if("session"in values)session=values.session;if("actor"in values)actor=values.actor;if("scope"in values)scope=values.scope;if("visible"in values)visible=values.visible;if("allowed"in values)allowed=values.allowed;if('content'in values)content=values.content;}};
}

test("content changes abort old source requests and ignore their late results",async()=>{
  const f=fixture(),old=f.controller.sync();f.change({content:['employees.active']});const next=f.controller.sync();
  assert.equal(f.pending[0].options.signal.aborted,true);
  f.pending[1].resolve({employees:[{active:false},{active:true}]});f.pending[0].resolve({employees:[]});await Promise.all([old,next]);
  assert.deepEqual(f.controller.records.employees.metrics,[{id:'employees.active',label:'Aktiv',value:1}]);
});
test("Ladestatus, gültiger leerer Bestand und Wiederverwendung derselben Anfrage",async()=>{
  const f=fixture(),p=f.controller.sync();assert.equal(f.controller.records.employees.status,"loading");
  f.controller.sync();assert.equal(f.pending.length,1);f.pending[0].resolve({employees:[]});await p;
  assert.equal(f.controller.records.employees.status,"succeeded");assert.equal(f.controller.records.employees.metrics[0].value,0);
});
test("Rechteentzug verhindert API und entfernt geschützte Zahlen sofort",async()=>{
  const f=fixture(),old=f.controller.sync();f.change({allowed:false});await f.controller.sync();
  assert.equal(f.pending[0].options.signal.aborted,true);assert.equal(f.controller.records.employees.status,"denied");
  f.pending[0].resolve({employees:[{active:true}]});await old;assert.equal(f.controller.records.employees.metrics.length,0);
});
test("Sitzung-ABA und Actorwechsel ignorieren verspätete Antworten und Fehler",async()=>{
  for(const change of [{session:{}},{actor:"B"}]){
    const f=fixture(),old=f.controller.sync();f.change(change);const next=f.controller.sync();
    f.pending[0].reject(new Error("old"));f.pending[1].resolve({employees:[]});await Promise.all([old,next]);
    assert.equal(f.controller.records.employees.status,"succeeded");assert.equal(f.controller.records.employees.metrics[0].value,0);
  }
});
test("Bereichs-/Jahreswechsel erhält nur neue Quelle",async()=>{
  const f=fixture(),old=f.controller.sync();f.change({scope:2027});const next=f.controller.sync();
  f.pending[1].resolve({employees:[]});f.pending[0].resolve({employees:[{active:true}]});await Promise.all([old,next]);
  assert.equal(f.controller.records.employees.metrics[0].value,0);
});
test("Wegnavigation leert Zahlen, bricht Request ab und erneutes Öffnen lädt neu",async()=>{
  const f=fixture(),old=f.controller.sync();f.change({visible:false});await f.controller.sync();
  assert.deepEqual(f.controller.records,{});assert.equal(f.pending[0].options.signal.aborted,true);
  f.pending[0].resolve({employees:[{active:true}]});await old;assert.deepEqual(f.controller.records,{});
  f.change({visible:true});const next=f.controller.sync();f.pending[1].resolve({employees:[]});await next;assert.equal(f.controller.records.employees.status,"succeeded");
});
test("Fehler und verweigerte Quellen bleiben sichtbar ohne Nullersatz, expliziter Refresh erholt",async()=>{
  const f=fixture(),first=f.controller.sync();f.pending[0].reject(new Error("offline"));await first;
  assert.equal(f.controller.records.employees.status,"failed");assert.deepEqual(f.controller.records.employees.metrics,[]);
  const second=f.controller.sync({force:true});f.pending[1].reject(Object.assign(new Error("forbidden"),{status:403}));await second;
  assert.equal(f.controller.records.employees.status,"denied");
  const third=f.controller.sync({force:true});f.pending[2].resolve({employees:[]});await third;assert.equal(f.controller.records.employees.status,"succeeded");
});
