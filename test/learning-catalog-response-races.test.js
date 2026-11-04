"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),vm=require("node:vm"),{functionSource}=require("../test-support/learning-workspace-ui");
function setup(names) {
  let epoch=0;const calls=[],requests=[],controls=new Map();
  const control=id=>{if(!controls.has(id))controls.set(id,{value:"",disabled:false,checked:false,open:true,intent:1,classList:{toggle(){}},close(){this.open=false;},querySelectorAll:()=>[control("draftField")],matches:()=>false});return controls.get(id);};
  const elements=new Proxy({},{get:(target,id)=>target[id]||=control(id)});
  const state={portalSession:{authenticated:true,user:{employeeNumber:"BEISPIEL"}},personnelLearningCatalog:{keep:"current"},personnelLearningSkillCatalog:{keep:"current"},personnelLearningCompetencyCatalog:{keep:"current"},personnelLearningDashboard:{keep:"current"}};
  const context=vm.createContext({state,elements,document:{},window:{confirm:()=>true,GpWindow:{captureContext:()=>({epoch}),currentContext:t=>t.epoch===epoch,capture:dialog=>({dialog,intent:dialog.intent,epoch}),current:(t,{allowClosed=false}={})=>t.epoch===epoch&&t.intent===t.dialog.intent&&(allowClosed||t.dialog.open)}},startDashboardWorkspaceActorKey:()=>"BEISPIEL",isLocalStartDashboardWorkspace:()=>false,canManagePersonnelLearningCatalog:()=>true,canWritePersonnelLearningCompetencies:()=>true,
    personnelLearningEditorPayload:()=>({title:"BEISPIEL",scope:{type:"organization"}}),personnelLearningSkillEditorPayload:()=>({title:"BEISPIEL",scope:{type:"organization"}}),showToast:()=>calls.push("toast"),api:(url,options)=>new Promise(resolve=>requests.push({url,options,resolve}))});
  for(const name of ["renderPersonnelLearningCatalog","renderPersonnelLearningSkillCatalog","renderPersonnelLearningCompetencyCatalog","setPersonnelLearningMessage","setPersonnelLearningSkillMessage","setPersonnelLearningCompetencyMessage"])context[name]=()=>calls.push(name);
  for(const name of ["loadPersonnelLearningCatalog","loadPersonnelLearningSkillCatalog","loadPersonnelLearningCompetencyCatalog","loadPersonnelLearningDashboard"])context[name]=async()=>calls.push(name);
  for(const name of ["captureGpContext","gpContextCurrent","captureGpEditor","gpEditorCurrent","restorePersonnelLearningEditorFields","lockPersonnelLearningEditorFields",...names])vm.runInContext(functionSource(name),context);
  return {context,state,elements,calls,requests,bump(){epoch++;}};
}
for(const name of ["mutatePersonnelLearningModule","mutatePersonnelLearningSkill","withdrawPersonnelLearningCompetency"]){
  for(const condition of ["normal","replacement session","actor ABA epoch"]){test(name+" protects catalog completion: "+condition,async()=>{
    const f=setup([name]);const operation=f.context[name]({id:"BEISPIEL",employeeNumber:"BEISPIEL",skillId:"BEISPIEL",currentEventReceipt:"e".repeat(64),currentRevisionReceipt:"r".repeat(64),latestVersionNumber:2},"publish");assert.equal(f.requests.length,1);const before=f.calls.length;
    if(condition==="replacement session")f.state.portalSession={authenticated:true,user:{employeeNumber:"BEISPIEL"}};if(condition==="actor ABA epoch")f.bump();f.requests[0].resolve({});await operation;
    if(condition==="normal")assert.ok(f.calls.includes("toast"));else{assert.equal(f.calls.length,before);assert.equal(f.state.personnelLearningCatalog?.keep,"current");assert.equal(f.state.personnelLearningSkillCatalog?.keep,"current");assert.equal(f.state.personnelLearningCompetencyCatalog?.keep,"current");}
  });}
}
for(const [name,dialog,button] of [["savePersonnelLearningModule","personnelLearningModal","savePersonnelLearningButton"],["savePersonnelLearningSkill","personnelLearningSkillModal","savePersonnelLearningSkillButton"],["savePersonnelLearningCompetency","personnelLearningCompetencyModal","savePersonnelLearningCompetencyButton"]]){
  test(name+" captures payload, locks draft fields and restores controls on normal success",async()=>{
    const f=setup([name]),field=f.elements.draftField;field.disabled=false;const operation=f.context[name]({preventDefault(){}});assert.equal(f.requests.length,1);assert.equal(field.disabled,true);assert.equal(f.elements[button].disabled,true);f.requests[0].resolve({});await operation;assert.equal(f.elements[dialog].open,false);assert.equal(field.disabled,false);assert.equal(f.elements[button].disabled,false);assert.ok(f.calls.includes("toast"));
  });
}
for(const kind of ["Module","Skill"]){test(kind+" draft submits the scope shown at opening after catalog order changes",()=>{
  const field={value:"0"},state={personnelLearningCatalog:{scopes:[{type:"organization",label:"Organisation"},{type:"location",locationId:"18",label:"Filiale"}]},personnelLearningSkillCatalog:{scopes:[{type:"organization",label:"Organisation"},{type:"location",locationId:"18",label:"Filiale"}]},personnelLearningEditorSteps:[],personnelLearningSkillEditorLevels:[]};
  const elements=new Proxy({personnelLearningScope:field,personnelLearningSkillScope:field},{get:(t,k)=>t[k]||{value:""}}),context=vm.createContext({state,elements,escapeHtml:val=>val,personnelLearningScopeKey:s=>JSON.stringify(s),syncPersonnelLearningStepsFromEditor(){},syncPersonnelLearningSkillLevelsFromEditor(){},personnelLearningTargetInput:()=>null,personnelLearningAssessmentEditor:{get:()=>null}});
  const populate=kind==="Module"?"populatePersonnelLearningScopes":"populatePersonnelLearningSkillScopes",payload=kind==="Module"?"personnelLearningEditorPayload":"personnelLearningSkillEditorPayload";vm.runInContext(functionSource(populate)+"\n"+functionSource(payload),context);context[populate]();field.value="1";state.personnelLearningCatalog.scopes.reverse();state.personnelLearningSkillCatalog.scopes.reverse();assert.equal(context[payload]().scope.locationId,"18");
});}
