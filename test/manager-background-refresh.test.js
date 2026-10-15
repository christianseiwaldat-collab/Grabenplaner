'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../public/app.js'),'utf8').replace(/\r\n/g,'\n');
function extract(name,async=true){const start=source.indexOf(`${async?'async ':''}function ${name}(`),end=source.indexOf('\n}\n',start);assert.ok(start>=0&&end>start);return source.slice(start,end+3);}
function fixture(){
  const calls=[],renders=[],state={portalSession:{id:'first'},portalStatus:{}},document={hidden:false};
  const f=vm.createContext({state,document,Date,elements:{managerVacationRequestList:{},requestsNavButton:{classList:{toggle(){}}}},
    api(url){return new Promise((resolve,reject)=>calls.push({url,resolve,reject}));},escapeHtml:String,
    renderRequestNavigation:()=>renders.push('navigation'),renderManagerRequests:()=>renders.push('requests'),renderStartDashboardPersonnelWidgets:()=>renders.push('dashboard')});
  vm.runInContext('let managerRequestsInFlight=null, managerRequestsLastRefresh=0, planningPeriodController=null, shiftMutation=null;\n'+
    extract('loadManagerVacationRequests')+extract('refreshManagerVacationRequests'),f);
  const complete=(from=0,to=calls.length)=>calls.slice(from,to).forEach(call=>call.resolve({requests:[],reports:[],cases:[],counts:{total:2},pendingCount:1}));
  return {f,calls,renders,state,document,complete};
}
test('background refresh yields to week navigation and hidden tabs; explicit opening still loads',async()=>{
  const x=fixture();x.document.hidden=true;
  await x.f.loadManagerVacationRequests({background:true});assert.equal(x.calls.length,0);
  x.document.hidden=false;vm.runInContext('planningPeriodController={}',x.f);
  await x.f.loadManagerVacationRequests({background:true});assert.equal(x.calls.length,0);
  const opened=x.f.loadManagerVacationRequests();assert.equal(x.calls.length,4);x.complete();await opened;
});
test('focus and periodic refresh share one load; repeated focus does not immediately reload',async()=>{
  const x=fixture(),one=x.f.loadManagerVacationRequests({background:true}),two=x.f.loadManagerVacationRequests({background:true});
  assert.equal(x.calls.length,4);x.complete();await Promise.all([one,two]);assert.equal(x.renders.length,3);
  await x.f.loadManagerVacationRequests({background:true});assert.equal(x.calls.length,4);
});

test('optional manager reads wait for a shift write to settle, while an explicit opening remains available',async()=>{
  const x=fixture();vm.runInContext('shiftMutation={}',x.f);
  await x.f.loadManagerVacationRequests({background:true});assert.equal(x.calls.length,0);
  const opened=x.f.loadManagerVacationRequests();assert.equal(x.calls.length,4);x.complete();await opened;
  vm.runInContext('shiftMutation=null; managerRequestsLastRefresh=0',x.f);
  const resumed=x.f.loadManagerVacationRequests({background:true});assert.equal(x.calls.length,8);x.complete(4);await resumed;
});

test('the actual system information timer yields to writes, navigation and inactive pages, then resumes',()=>{
  const timer=source.match(/setInterval\(\(\) => \{\n[^]*?\n\}, 120000\);/);
  assert.ok(timer,'system information interval');
  let callback,reads=0,locked=false;
  const context={document:{hidden:false,body:{classList:{contains:()=>locked}}},shiftMutation:null,planningPeriodController:null,
    loadSystemInfo:()=>reads++,setInterval(fn,delay){assert.equal(delay,120000);callback=fn;}};
  vm.runInNewContext(timer[0],context);
  context.shiftMutation={};callback();assert.equal(reads,0);
  context.shiftMutation=null;context.planningPeriodController={};callback();assert.equal(reads,0);
  context.planningPeriodController=null;context.document.hidden=true;callback();assert.equal(reads,0);
  context.document.hidden=false;locked=true;callback();assert.equal(reads,0);
  locked=false;callback();assert.equal(reads,1);
});
test('a changed account neither consumes nor displays the previous account response',async()=>{
  const x=fixture(),old=x.f.loadManagerVacationRequests();x.state.portalSession={id:'second'};
  const current=x.f.loadManagerVacationRequests();assert.equal(x.calls.length,8);
  x.complete(0,4);await old;assert.equal(x.renders.length,0);
  x.complete(4,8);await current;assert.equal(x.renders.length,3);
});
test('week navigation renders the complete planning area without rebuilding other administration pages',()=>{
  const calls=[],ctx={state:{data:{settings:{}}},window:{},planningAssistantWorkspace:{synchronize:()=>calls.push('assistantSync')},canReadStartDashboardSchedule:()=>true,hasManagementBrandingAccess:()=>true,syncXoffiImport(){}};
  for(const name of [...extract('render',false).matchAll(/\b(render\w+|applyShellBranding)\(/g)].map(m=>m[1]).filter(n=>n!=='render'))ctx[name]=()=>calls.push(name);
  vm.runInNewContext(extract('render',false),ctx);ctx.render({period:'schedule'});
  for(const name of ['renderHeader','renderSummary','renderTimeline','renderWorkRuleAssessment','renderBranchSupervisionAssessment','renderHoursOverview','renderRemarks'])assert.ok(calls.includes(name),name);
  assert.ok(calls.includes('assistantSync'),'Planning refresh synchronizes the optional assistant');
  for(const name of ['renderSettings','renderEmployees','renderVacations','renderLoanManagementFilters'])assert.ok(!calls.includes(name),name);
  calls.length=0;ctx.render({period:'vacation'});assert.deepEqual(calls,['applyShellBranding','renderContextNavigation','renderVacations']);
});

test('enrichment updates assessments and hour cards without replacing the confirmed timeline or surrounding views',()=>{
  const data={workRuleAssessment:{outcome:'attention'},branchSupervisionAssessment:{outcome:'yellow'},saturdayStats:{byEmployee:{E1:{fourWeeks:2}}}};
  const calls=[],ctx={state:{data,portalSession:{id:'current'}},canReadStartDashboardSchedule:()=>true,
    planningAssistantWorkspace:{synchronize(value){assert.equal(value.data,data);assert.equal(value.session,ctx.state.portalSession);assert.equal(value.allowed,true);calls.push('assistant');}}};
  for(const name of [...extract('render',false).matchAll(/\b(render\w+|applyShellBranding|syncXoffiImport)\(/g)].map(m=>m[1]).filter(n=>n!=='render'))ctx[name]=()=>assert.fail('Unrelated render: '+name);
  ctx.renderBranchSupervisionAssessment=()=>calls.push(ctx.state.data.branchSupervisionAssessment.outcome);
  ctx.renderWorkRuleAssessment=()=>calls.push(ctx.state.data.workRuleAssessment.outcome);
  ctx.renderHoursOverview=()=>calls.push(ctx.state.data.saturdayStats.byEmployee.E1.fourWeeks);
  vm.runInNewContext(extract('render',false),ctx);ctx.render({period:'schedule-enrichment'});
  assert.deepEqual(calls,['yellow','attention',2,'assistant']);
});
