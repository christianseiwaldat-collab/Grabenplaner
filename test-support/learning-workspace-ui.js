"use strict";
const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict");
const root=path.resolve(__dirname,"..");
const read=name=>fs.readFileSync(path.join(root,"public",name),"utf8");
function section(id,file="index.html") {
  const source=read(file),match=source.match(new RegExp('<section\\b[^>]*\\bid="'+id+'"[^>]*>'));
  assert.ok(match,id);const tags=/<\/?section\b[^>]*>/g;tags.lastIndex=match.index;let depth=0,tag;
  while((tag=tags.exec(source))){depth+=tag[0].startsWith("</")?-1:1;if(!depth)return source.slice(match.index,tags.lastIndex);}
  throw Error("Unclosed section "+id);
}
function functionSource(name,file="app.js") {
  const source=read(file).replace(/\r\n/g,"\n");let start=source.indexOf("function "+name+"(");const end=source.indexOf("\n}\n",start);
  if(source.slice(start-6,start)==="async ")start-=6;
  assert.ok(start>=0&&end>start,name);return source.slice(start,end+3);
}
function dialog(id,file="index.html") {
  const source=read(file),match=source.match(new RegExp('<dialog\\b[^>]*\\bid="'+id+'"[^>]*>'));assert.ok(match,id);
  return source.slice(match.index,source.indexOf("</dialog>",match.index)+9);
}
const dashboardFunctions=["personnelLearningProgressResultLabel","personnelLearningProgressStatusLabel","personnelLearningDashboardProfile","personnelLearningScheduleMarkup","renderPersonnelLearningDashboardSkillTree","renderPersonnelLearningDashboard"].map(name=>functionSource(name)).join("\n");
async function prepare(page,{areas=[],dialogs=[]}={}) {
  await page.route("**/*",route=>route.abort());
  await page.setContent('<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main class="synthetic-learning">'+section("personnelLearningSection")+'</main>'+dialogs.map(id=>dialog(id)).join("")+'</body></html>');
  for(const name of ["styles.css","learning-library.css","personnel-learning-workspace.css","gp-window.css"])await page.addStyleTag({path:path.join(root,"public",name)});
  await page.addStyleTag({content:".synthetic-learning{max-width:1320px;margin:32px auto;padding:0 24px;box-sizing:border-box}#personnelLearningSection{display:block!important}@media(max-width:700px){.synthetic-learning{padding:0 12px;margin:20px auto}}"});
  for(const name of ["gp-window-preferences.js","gp-window.js","learning-team.js"])await page.addScriptTag({path:path.join(root,"public",name)});
  await page.evaluate(({source,areas})=>{
    const esc=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
    window.escapeHtml=window.escapeHtmlAttribute=esc;window.personnelWorkflowTimestamp=()=>"11.10.2026, 09:00";
    window.actor="BEISPIEL-A";window.manager=GpWindow.installDocument(document,{actorKey:()=>actor,canUse:()=>Boolean(actor),readPreferences:async()=>({version:1,windows:{}}),writePreferences:async()=>{}});
    window.elements=Object.fromEntries([...document.querySelectorAll("[id]")].map(node=>[node.id,node]));
    const competency={skillCode:"VERKAUF-01",skillTitle:"Persönliche Beratung und anspruchsvolle Kundengespräche",skillCategory:"Verkauf & Service",level:6,trainerAuthorized:true,levelDefinition:{label:"Selbstständige Beratung",description:"Berät bei komplexen Anliegen sicher, dokumentiert passende Lösungen und begleitet neue Kolleginnen und Kollegen."},levelDefinitions:Array.from({length:10},(_,i)=>({level:i+1,label:"Entwicklungsstufe "+(i+1)}))};
    const profiles=[{employee:{employeeNumber:"BEISPIEL-01",fullName:"Alexandra Beispiel mit langem Familiennamen",locationName:"Filiale Innenstadt"},competencies:[competency]},{employee:{employeeNumber:"BEISPIEL-02",fullName:"Martin Beispiel",locationName:"Filiale Innenstadt"},competencies:[{...competency,level:3,trainerAuthorized:false}]}];
    window.state={personnelLearningDashboard:{generatedAt:"2026-10-11T07:00:00Z",summary:{activeAssignments:8,inProgress:3,completed:4,attentionRequired:1,competencies:18,trainerSkills:5},viewer:{scope:{locationName:"Filiale Innenstadt",departmentName:"Verkauf"}},capabilities:{canViewTeam:true,canManageAssignments:true},profiles,assignments:[{id:"BEISPIEL-training",learner:profiles[0].employee,process:{title:"Beratung bei komplexen Kundengesprächen und Reklamationen",versionNumber:2},progress:{status:"in_progress",percent:50,completedStepCount:2,totalStepCount:4},trainers:[{trainerName:"Patricia Beispiel",skillTitle:"Beratung",currentEligible:true}],schedule:{dueDate:"2026-10-18"}}]}};
    (0,eval)(source);renderPersonnelLearningDashboard();
    window.learningOptions={locations:[{id:"18",name:"Filiale Innenstadt"}],positions:[{id:"sales",name:"Verkauf"}],roles:[{id:"employee",name:"Mitarbeiter"}],canManage:true,scopes:[{type:"organization",label:"Organisation"}],modules:[{id:"skill",title:"Persönliche Beratung",version:2,type:"skill",scope:{type:"organization"}},{id:"training",title:"Sicherer Umgang mit Reklamationen",version:1,type:"training",scope:{type:"organization"}}],rules:[{id:"rule-a",canManage:true,receiptSha256:"a".repeat(64),payload:{title:"Persönliche Beratung und anspruchsvolle Kundengespräche",type:"skill",moduleId:"skill",minLevel:5,moduleVersionNumber:2,active:true,scope:{type:"organization",label:"Organisation"}}},{id:"rule-b",canManage:true,receiptSha256:"b".repeat(64),payload:{title:"Pflichtschulung: Reklamationen nachvollziehbar bearbeiten",type:"training",moduleId:"training",moduleVersionNumber:1,active:true,scope:{type:"organization",label:"Organisation"}}}]};
    window.teamWrites=[];window.optionsReads=0;window.holdSave=false;window.releaseSave=null;
    window.team=GrabenplanerLearningTeam.mount(document.getElementById("personnelLearningTeam"),{api:async(url,request={})=>{
      if(url.endsWith("/team/options")){optionsReads++;const value=structuredClone(learningOptions);if(window.teamHoldOptions)await new Promise(resolve=>{window.teamReleaseOptions=resolve;});return value;}
      if(request.method){teamWrites.push(JSON.parse(request.body));if(holdSave)await new Promise(resolve=>{releaseSave=resolve;});return {};}
      const params=new URL(url,"https://synthetic.invalid").searchParams;
      if(window.teamHoldResult)await new Promise(resolve=>{window.teamReleaseResult=resolve;});
      return {summary:{percent:25,fulfilled:1,required:4,open:3,dueSoon:1},rules:structuredClone(learningOptions.rules),people:profiles.map((p,i)=>({...p.employee,positionName:"Verkauf und Kundenservice",roleName:"Mitarbeiter",cells:[{status:i?"lowerLevel":"fulfilled",actual:i?3:6},{status:i?"inProgress":"dueSoon",until:"2026-10-18"}]})),total:120,offset:Number(params.get("offset")),pageSize:Number(params.get("pageSize"))};
    }});
    for(const area of areas)document.querySelector('[data-learning-area="'+area+'"]').open=true;
  },{source:dashboardFunctions,areas});
}
function screenshotDirectory(){const directory=path.resolve(process.env.GP_WINDOW_SCREENSHOT_DIR||path.join(root,"..","output","gp-22-blocks-20261011"));assert.ok(!directory.toLowerCase().startsWith(root.toLowerCase()+path.sep));fs.mkdirSync(directory,{recursive:true});return directory;}
module.exports={root,read,section,dialog,functionSource,prepare,screenshotDirectory};
