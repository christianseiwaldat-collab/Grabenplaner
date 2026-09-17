'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../public/app.js'),'utf8').replace(/\r\n/g,'\n');
function extract(name,async=true){const start=source.indexOf(`${async?'async ':''}function ${name}(`),end=source.indexOf('\n}\n',start);assert.ok(start>=0&&end>start);return source.slice(start,end+3);}
function fixture(){
  const calls=[],renders=[],state={portalSession:{id:'first'},portalStatus:{}},document={hidden:false};
  const f=vm.createContext({state,document,Date,elements:{managerVacationRequestList:{},requestsNavButton:{classList:{toggle(){}}}},
    api(url){return new Promise((resolve,reject)=>calls.push({url,resolve,reject}));},escapeHtml:String,
    renderRequestNavigation:()=>renders.push('navigation'),renderManagerRequests:()=>renders.push('requests'),renderStartDashboardPersonnelWidgets:()=>renders.push('dashboard')});
  vm.runInContext('let managerRequestsInFlight=null, managerRequestsLastRefresh=0, planningPeriodController=null;\n'+
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
test('a changed account neither consumes nor displays the previous account response',async()=>{
  const x=fixture(),old=x.f.loadManagerVacationRequests();x.state.portalSession={id:'second'};
  const current=x.f.loadManagerVacationRequests();assert.equal(x.calls.length,8);
  x.complete(0,4);await old;assert.equal(x.renders.length,0);
  x.complete(4,8);await current;assert.equal(x.renders.length,3);
});
test('week navigation renders the complete planning area without rebuilding other administration pages',()=>{
  const calls=[],ctx={state:{data:{settings:{}}},hasManagementBrandingAccess:()=>true};
  for(const name of [...extract('render',false).matchAll(/\b(render\w+|applyShellBranding)\(/g)].map(m=>m[1]).filter(n=>n!=='render'))ctx[name]=()=>calls.push(name);
  vm.runInNewContext(extract('render',false),ctx);ctx.render({period:'schedule'});
  for(const name of ['renderHeader','renderSummary','renderTimeline','renderWorkRuleAssessment','renderBranchSupervisionAssessment','renderHoursOverview','renderRemarks'])assert.ok(calls.includes(name),name);
  for(const name of ['renderSettings','renderEmployees','renderVacations','renderLoanManagementFilters'])assert.ok(!calls.includes(name),name);
  calls.length=0;ctx.render({period:'vacation'});assert.deepEqual(calls,['applyShellBranding','renderContextNavigation','renderVacations']);
});
