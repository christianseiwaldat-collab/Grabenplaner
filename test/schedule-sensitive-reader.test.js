"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const {createPersistenceProviderFacade}=require("../lib/persistence/contract");
const {POSTGRESQL_CAPABILITIES}=require("../lib/persistence/postgresql/provider");
const {createReadScope}=require("../lib/persistence/postgresql/read-scope");
const {createOrganizationPersonnelRepository}=require("../lib/persistence/repositories/organization-personnel");
const source=fs.readFileSync(path.resolve(__dirname,"../server.js"),"utf8");
function fn(name){const from=source.search(new RegExp("^(?:async )?function "+name+"\\(","m")),to=source.indexOf("\n}",from);assert(from>=0&&to>from);return source.slice(from,to+2);}
const stageStart=source.indexOf("    const record = readSensitive ?",source.indexOf("async function evaluateScheduleWorkRules("));
const ruleRead=source.slice(stageStart,source.indexOf("    const protection =",stageStart));
assert(ruleRead.includes("personnelSensitiveProfile"));
const team=Array.from({length:21},(_,index)=>({personnel_number:"synthetic-"+index}));
function fixture(){
  const state={reads:0,decryptions:0,version:1,failRead:false,failDecrypt:false,commits:0};
  const rows=(parameters,version=state.version)=>[{employee_number:parameters.employeeNumber,social_security_lookup:"",
    protected_payload:JSON.stringify({identity:{birthDate:"2000-01-01"},privateEmail:"synthetic@example.invalid",employment:{startDate:version===1?"2026-10-12":"2026-10-22"}})}];
  const query=async(statement,parameters,version)=>{assert.equal(statement.id,"organization-personnel.personnel-sensitive-record.get");state.reads++;if(state.failRead)throw Error("synthetic read failure");return rows(parameters,version);};
  const base={providerId:"postgresql",capabilities:POSTGRESQL_CAPABILITIES,query,async execute(){throw Error("no writes");},async close(){},
    async beginTransaction(){const version=state.version;return {query:(s,p)=>query(s,p,version),async execute(){throw Error("no writes");},async commit(){state.commits++;},async rollback(){}};}};
  const underlying=createPersistenceProviderFacade(base),scope=createReadScope({getProvider:async()=>underlying});
  const provider=createPersistenceProviderFacade({...base,query:scope.query,async beginTransaction(options){return scope.join(options)||base.beginTransaction(options);}});
  const repository=createOrganizationPersonnelRepository(provider);
  const context=vm.createContext({organizationPersonnelRepository:repository,parseProtectedJson(value){state.decryptions++;if(state.failDecrypt)throw Error("synthetic protected payload failure");return JSON.parse(value);},
    personnelSensitiveProtectionContext:()=>({}),emptyPersonnelSensitiveProfile:()=>({employment:{startDate:""}}),own:(v,k)=>Object.hasOwn(v,k),
    normalizeProtectionStatus:v=>v||null,normalizeRetailKv:v=>v||null,require:id=>{assert.equal(id,"./lib/schedule-employment");return require("../lib/schedule-employment");}});
  vm.runInContext(["personnelSensitiveProfile","createScheduleSensitiveReader","projectScheduleEmployment"].map(fn).join("\n")
    +"\nasync function observedRuleRead(employeeNumber,readSensitive=null){"+ruleRead+"\nreturn {encryptedRecord,sensitive};}\n",context);
  return {state,context,repository,scope};
}
for(const optimized of [false,true])test("employment and original rule-read stage use one read/decryption per employee; snapshot="+optimized,async()=>{
  const f=fixture();let projection;
  const work=async()=>{
    const read=f.context.createScheduleSensitiveReader();
    projection=await f.context.projectScheduleEmployment(team,"2026-10-19","2026-10-25",f.repository,read);
    await Promise.all(team.map(row=>f.context.observedRuleRead(row.personnel_number,read)));
    const concurrent=await Promise.all([read("synthetic-0"),read("synthetic-0")]);assert.equal(concurrent[0],concurrent[1]);
  };
  if(optimized)await f.scope.run(work);else await work();
  assert.equal(f.state.reads,21);assert.equal(f.state.decryptions,21);assert.equal(f.state.commits,optimized?1:0);
  assert.equal(projection.employees.length,21);assert(projection.employees.every(row=>row.planningDates.length===7));
  assert.doesNotMatch(JSON.stringify(projection.employees),/protected_payload|privateEmail|birthDate|startDate/);
});
test("new requests and repository scopes never reuse protected profiles",async()=>{
  const a=fixture(),b=fixture();b.state.version=2;
  const first=a.context.createScheduleSensitiveReader();const original=await first("same");a.state.version=2;
  assert.equal((await first("same")).sensitive.employment.startDate,"2026-10-12");
  const fresh=await a.context.createScheduleSensitiveReader()("same");
  assert.equal(fresh.sensitive.employment.startDate,"2026-10-22");assert.notEqual(original,fresh);
  const other=await a.context.createScheduleSensitiveReader(b.repository)("same");assert.equal(other.sensitive.employment.startDate,"2026-10-22");
  assert.equal(a.state.reads,2);assert.equal(b.state.reads,1);
});
for(const failure of ["failRead","failDecrypt"])test("protected planning failures stay rejected within the request without retries: "+failure,async()=>{
  const f=fixture();f.state[failure]=true;const read=f.context.createScheduleSensitiveReader();
  const attempts=await Promise.allSettled([read("same"),read("same")]);assert(attempts.every(value=>value.status==="rejected"));
  await assert.rejects(f.context.projectScheduleEmployment([{personnel_number:"same"}],"2026-10-19","2026-10-25",f.repository,read));
  assert.equal(f.state.reads,1);assert.equal(f.state.decryptions,failure==="failRead"?0:1);
  f.state[failure]=false;assert((await f.context.createScheduleSensitiveReader()("same")).sensitive);
  assert.equal(f.state.reads,2);
});
test("actual enrichment shares only its local reader and next invocation reads fresh entry dates",async()=>{
  const f=fixture();let readIdentity;
  Object.assign(f.context,{getMonday:v=>v,isIsoDate:()=>true,addDays:(v,n)=>new Date(Date.parse(v)+n*86400000).toISOString().slice(0,10),
    resolvePlanningContext:async()=>({locationId:"18"}),assertSessionContextScope(){},applyScopedPdfSettings:v=>v,settingsForLocation:async()=>({}),
    planningSettingsRepository:{listScheduleEmployees:async()=>team,listScheduleShifts:async()=>[]},serializeEmployee:r=>({...r}),plannedShiftBreaks:async()=>({rawMinutes:0}),
    sessionCanReadWorkRules:()=>true,branchSupervisionAssessmentForSchedule:async()=>null,buildSaturdayServiceStats:async()=>({}),
    evaluateScheduleWorkRules:async(week,context,employees,candidate,read)=>{assert.equal(candidate,null);assert.equal(typeof read,"function");assert.notEqual(read,readIdentity);readIdentity=read;
      await Promise.all(employees.map(row=>f.context.observedRuleRead(row.personnel_number,read)));return {assessment:{outcome:"pass"}};}});
  vm.runInContext(fn("getScheduleEnrichment"),f.context);
  await f.context.getScheduleEnrichment("2026-10-19",{},{});assert.equal(f.state.reads,21);assert.equal(f.state.decryptions,21);
  f.state.version=2;await f.context.getScheduleEnrichment("2026-10-19",{},{});assert.equal(f.state.reads,42);assert.equal(f.state.decryptions,42);
  assert.match(fn("getSchedule"),/createScheduleSensitiveReader\(\)/);
  assert.match(fn("getSchedule"),/evaluateScheduleWorkRules\(weekStart, context, employees, null, readSensitive\)/);
});
