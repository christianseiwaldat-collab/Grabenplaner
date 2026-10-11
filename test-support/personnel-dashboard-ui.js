"use strict";
const path=require("node:path"),fs=require("node:fs");
const {root,read,section,functionSource,screenshotDirectory}=require("./learning-workspace-ui");
const names=["defaultPersonnelDashboardLayout","normalizePersonnelDashboardLayout","personnelDashboardCatalog","orderedPersonnelDashboardItems","startDashboardWorkspaceActorKey","captureGpContext","gpContextCurrent","canUsePersonnelDashboardInformation","personnelDashboardInformationSources","syncPersonnelDashboardInformation","renderPersonnelDashboardInformation","renderPersonnelDashboard"];
const workspaceNames=["canUseStartDashboardWorkspace","canUsePersonnelDashboardWorkspace","personnelDashboardWorkspaceFieldAllowed","personnelDashboardWorkspaceFields","applyPersonnelDashboardWorkspace","syncPersonnelDashboardWorkspace","renderPersonnelDashboardCustomizer","updatePersonnelDashboardCustomizerStatus","openPersonnelDashboardCustomizer","closePersonnelDashboardCustomizer","movePersonnelDashboardDraft","persistPersonnelDashboardLayout","savePersonnelDashboardConfiguration"];
const app=read("app.js"),ids=app.slice(app.indexOf("const PERSONNEL_DASHBOARD_ITEM_IDS"),app.indexOf("function defaultPersonnelDashboardLayout"));
const source=ids+"\nlet personnelDashboardInformation=null,personnelDashboardWorkspace=null;\n"+names.map(n=>functionSource(n)).join("\n")+"\nwindow.infoRecords=()=>personnelDashboardInformation?.records||{};";
const workspaceSource=source+"\nlet personnelDashboardWorkspaceApplying=false,personnelDashboardWorkspaceOwner=null,personnelDashboardCustomizerRevision=0,personnelDashboardConfigurationSaveContext=null;\n"+workspaceNames.map(n=>functionSource(n)).join("\n")+"\nwindow.personalWorkspace=()=>personnelDashboardWorkspace;";
async function prepare(page,{workspace=false}={}){
  if(workspace)page.setDefaultTimeout(6000);
  const errors=[];page.on("pageerror",e=>errors.push(e.message));await page.route("**/*",route=>route.abort());
  await page.setContent('<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main class="synthetic-personnel">'+section("personnelDashboardSection")+'</main></body></html>');
  for(const name of workspace?["styles.css","gp-window.css","start-dashboard-workspace.css","personnel-dashboard-workspace.css"]:["styles.css","personnel-dashboard-workspace.css"])await page.addStyleTag({path:path.join(root,"public",name)});
  await page.addStyleTag({content:'.synthetic-personnel{max-width:1320px;margin:32px auto;padding:0 24px;box-sizing:border-box}#personnelDashboardSection{display:block!important}@media(max-width:700px){.synthetic-personnel{padding:0 12px;margin:20px auto}}'});
  await page.addScriptTag({path:path.join(root,"public","personnel-dashboard-info.js")});
  if(workspace)for(const name of ["gp-window-preferences.js","gp-window.js","start-dashboard-workspace-preferences.js","personnel-dashboard-workspace-preferences.js","start-dashboard-workspace-geometry.js","start-dashboard-workspace.js"])await page.addScriptTag({path:path.join(root,"public",name)});
  await page.evaluate(({source,workspace,events})=>{
    const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
    window.escapeHtml=window.escapeHtmlAttribute=esc;window.isLocalStartDashboardWorkspace=()=>false;
    window.elements=Object.fromEntries([...document.querySelectorAll("[id]")].map(n=>[n.id,n]));
    window.state={portalStatus:{portalEnabled:true,installationFeatures:{},capabilities:{timeTracking:true}},portalSession:{authenticated:true,user:{employeeNumber:"BEISPIEL-01",role:"developer",sessionKind:"employee",active:true,isEmployee:true,permissions:["time:read","sickness:read"]}},currentView:"personnelAdministration",personnelAdministrationTab:"dashboard",centralVacationYear:2026,locationId:"18",departmentId:"2",personnelDashboardLayout:{version:1,order:[],hidden:[]}};
    window.denied=new Set();for(const name of ["canOpenPersonnelAdministrationModule","canOpenPersonnelAdministrationView","canReadCentralPersonnel","canManagePositions","canReadCandidatePreboarding","canOpenWorkflowCenter","canReadPersonnelWorkflowInstances","canReadPersonnelLearningCatalog","canReadPersonnelTasks","canReadManagerRequests","canReadManagedTimeTracking","canReadCostCenters","canAccessCustomWorkRuleGovernance","canReadCollectiveAgreements","canReadCentralVacations","canReadLifecycleOnboardingTasks","canReadLifecycleOffboardingTasks"])window[name]=()=>!denied.has(name);
    window.hasGovernancePermission=p=>state.portalSession?.user?.permissions?.includes(p)===true;
    window.managerRequestTabAvailability=()=>({vacation:!denied.has("vacation"),amu:!denied.has("amu")});
    window.calls=[];window.held=[];window.hold=false;window.failSources=new Set();window.forbiddenSources=new Set();
    window.savedPersonal={};window.savedLegacy={};window.preferenceWrites=[];window.heldPreferenceReads=[];window.heldPreferenceWrites=[];window.holdPreferenceReads=false;window.holdPreferenceWrites=false;window.preferenceFailure=false;window.showToast=(message)=>{window.lastToast=message;};
    window.api=async(url,options)=>{
      calls.push(url);const path=new URL(url,"https://example.invalid").pathname;
      const employeeCount=window.syntheticEmployeeCount??3;
      if(path==="/api/portal/v1/ui-preferences"){
        const actor=state.portalSession?.user?.employeeNumber;
        if(options?.method==="PUT"){
          const value=JSON.parse(options.body);preferenceWrites.push({actor,value});
          if(holdPreferenceWrites)await new Promise((resolve,reject)=>heldPreferenceWrites.push({resolve,reject,options}));
          if(preferenceFailure)throw Error("synthetic save failure");
          if(!options.signal.aborted){savedPersonal[actor]=value.personnelDashboardWorkspace;savedLegacy[actor]=value.personnelDashboardLayout;}
          return structuredClone(value);
        }
        const payload={personnelDashboardWorkspace:savedPersonal[actor]??null,personnelDashboardLayout:savedLegacy[actor]??{version:1,order:[],hidden:[]}};
        if(holdPreferenceReads)await new Promise(resolve=>heldPreferenceReads.push({resolve,options}));
        return structuredClone(payload);
      }
      if(hold)await new Promise(resolve=>held.push({url,options,resolve}));
      if(forbiddenSources.has(path))throw Object.assign(new Error("forbidden"),{status:403});if(failSources.has(path))throw new Error("synthetic unavailable");
      if(path==="/api/personnel-directory")return {employees:Array.from({length:employeeCount},(_,index)=>({active:index<2}))};
      if(path==="/api/positions")return [{active:true},{active:false}];
      if(path==="/api/cost-centers")return {costCenters:[{active:true},{active:true},{active:false}]};
      if(path.endsWith("/candidates"))return {capabilities:{canReadCandidates:true},candidates:Array.from({length:50},()=>({state:"active"})),pagination:{limit:50,offset:0,hasMore:true}};
      if(path.endsWith("/workflow-instances"))return {capabilities:{canRead:true},instances:[{status:"open"},{status:"resolved"}]};
      if(path.endsWith("/modules"))return {capabilities:{canRead:true},modules:[],summary:{visible:14,published:9,drafts:6}};
      if(path.endsWith("/onboarding/tasks"))return {capabilities:{canReadOnboardingTasks:true},tasks:[{runId:"r",stepId:"s"}]};
      if(path.endsWith("/offboarding/tasks"))return {capabilities:{canReadOffboardingTasks:true},tasks:[]};
      if(path.endsWith("/absence-requests"))return {requests:[],counts:{vacation:2,timeOff:1,total:3}};
      if(path.endsWith("/amu-reports"))return {reports:[],pendingCount:2,access:{available:true}};
      if(path.endsWith("/sickness-cases"))return {cases:[],pendingCount:3};
      if(path.endsWith("/time-presence")){const q=new URL(url,"https://example.invalid").searchParams;return {presence:{date:q.get("date"),locationId:q.get("locationId"),departmentId:q.get("departmentId"),locationName:"Filiale Innenstadt mit ausführlicher Standortbezeichnung",departmentName:"Verkauf und persönliche Kundenberatung",employees:[{},{}]}};}
      if(path==="/api/work-rules/drafts")return {drafts:[],summary:{drafts:5,pendingReview:2,active:3}};
      if(path==="/api/collective-agreements/registry")return {agreements:[{versions:[{},{}]},{versions:[{}]}],scopeLabel:"KV-Register mit Zuordnungen des eigenen freigegebenen Bereichs"};
      if(path==="/api/personnel-vacations")return {year:Number(new URL(url,"https://example.invalid").searchParams.get("year")),vacations:[{employee_number:"A"},{employee_number:"A"},{employee_number:"B"}]};
      throw Error("unexpected synthetic endpoint "+url);
    };
    if(workspace)window.gpWindows=GpWindow.installDocument(document,{actorKey:()=>state.portalSession?.user?.employeeNumber||"",canUse:()=>state.portalSession?.authenticated===true,readPreferences:async()=>({version:1,windows:{}}),writePreferences:async()=>{}});
    else window.syncPersonnelDashboardWorkspace=()=>{};
    (0,eval)(source);
    window.navigated=[];elements.personnelDashboardSection.addEventListener("click",event=>{const button=event.target.closest("[data-personnel-dashboard-item]");if(button)navigated.push(button.dataset.personnelDashboardItem);});
    document.getElementById("personnelDashboardRefreshButton").addEventListener("click",()=>syncPersonnelDashboardInformation({force:true}));
    if(workspace)(0,eval)(events);
    renderPersonnelDashboard();
  },{source:workspace?workspaceSource:source,workspace,events:app.slice(app.indexOf('elements.personnelDashboardCustomizeButton?.addEventListener'),app.indexOf('elements.personnelLearningSearch?.addEventListener',app.indexOf('elements.personnelDashboardCustomizeButton?.addEventListener')))});
  await page.waitForFunction(()=>Object.keys(infoRecords()).length===15&&Object.values(infoRecords()).every(r=>r.status!=="loading"));
  if(workspace){await page.evaluate(()=>gpWindows.preferences.activate());await page.waitForFunction(()=>personalWorkspace()?.store.ready&&gpWindows.preferences.ready,{},{timeout:5000}).catch(async error=>{throw Error(error.message+'; page errors: '+errors.join('; ')+'; readiness: '+JSON.stringify(await page.evaluate(()=>({store:personalWorkspace()?.store.ready,failed:personalWorkspace()?.store.failed,gp:gpWindows.preferences?.ready,canUse:canUsePersonnelDashboardWorkspace(),toast:window.lastToast,calls:calls.filter(url=>url.includes('preferences'))}))));});}
  return {errors};
}
module.exports={root,read,source,workspaceSource,prepare,screenshotDirectory};
