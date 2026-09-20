'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const {monitorActivity}=require('../server-tools/linux/recovery/lib/postgresql-recovery-activity');
const {safeDiagnostics}=require('../server-tools/linux/recovery/lib/postgresql-recovery-diagnostics');
const {createSalesReportBatchWorker}=require('../lib/sales-report-batch-worker');
const file=path.resolve(__dirname,'../server-tools/linux/recovery/lib/postgresql-application-smoke.js');
const source=fs.readFileSync(file,'utf8'),localRequire=createRequire(file);
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function harness(t,{initialize,health=()=>({status:200,body:{ok:true}})}={}){
 const workspace=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'gp-smoke-startup-'))),root=path.join(workspace,'work','application');
 fs.mkdirSync(root,{recursive:true});
 t.after(()=>{assert.ok(workspace.startsWith(fs.realpathSync(os.tmpdir())+path.sep));fs.rmSync(workspace,{recursive:true});});
 fs.writeFileSync(path.join(root,'source-encryption.env'),'');
 const events=[],budgets=[],routes=[],reachedDataChecks=new Error('reached existing post-health data verification');
 const server={once(){},close(done){events.push('listener-closed');done();},closeAllConnections(){}};
 let initialized=false;
 const subject={
  async initializeApplicationPersistence(options){events.push('init-start');await initialize?.(options);initialized=true;events.push('init-done');},
  app:{listen(_port,_host,done){assert.equal(initialized,true,'listener must follow complete initialization');events.push('listen');queueMicrotask(done);return server;}},
  async closePersistenceForTests(){events.push('closed');},
 };
 const context={module:{exports:{}},Buffer,URL,performance,setTimeout,setInterval,clearInterval,queueMicrotask,
  process:{env:{},platform:process.platform,memoryUsage:process.memoryUsage},
  AbortSignal:{timeout(ms){assert.equal(initialized,true,'HTTP budget cannot begin during startup');budgets.push(ms);return AbortSignal.timeout(25);}},
  async fetch(url,{signal}){signal.throwIfAborted();const route=new URL(url).pathname;routes.push(route);const value=health(route);return {status:value.status,json:async()=>value.body};},
  require(name){
   if(name==='../../../../server')return subject;
   if(name==='../../../../lib/persistence/postgresql/application-operations/access')return {async openCoreOperations(){events.push('data-checks');throw reachedDataChecks;}};
   return localRequire(name);
  },
 };
 vm.runInNewContext(source,context,{filename:file});
 return {root,workspace,events,budgets,routes,reachedDataChecks,
  run:()=>context.module.exports.qualifyHttp({root,config:{recoveryAccounts:{gp_core_app:'synthetic-only'}}}),
  phases:()=>fs.readFileSync(path.join(root,'http-progress.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line).phase)};
}

test('delayed initialization does not spend the unchanged 180-second HTTP budgets or bypass subsequent data checks',async t=>{
 const start=deferred(),h=harness(t,{initialize:()=>start.promise}),completion=h.run();
 await new Promise(resolve=>setTimeout(resolve,60)); // Longer than the scaled HTTP budget in this fixture.
 assert.deepEqual(h.budgets,[]);assert.deepEqual(h.routes,[]);assert.deepEqual(h.events,['init-start']);
 start.resolve();await assert.rejects(completion,error=>error===h.reachedDataChecks);
 assert.deepEqual(h.budgets,[180000,180000]);assert.deepEqual(h.routes,['/api/health/live','/api/health/ready']);
 assert.deepEqual(h.events,['init-start','init-done','listen','data-checks','listener-closed','closed']);
 assert.deepEqual(h.phases(),['preparing','requiring-server','server-required','initializing-application','application-initialized','starting-listener','listener-ready','/api/health/live','/api/health/ready']);
});

for(const [name,route,status,body] of [
 ['live HTTP error','/api/health/live',503,{ok:true}],
 ['live invalid body','/api/health/live',200,{ok:false}],
 ['readiness HTTP error','/api/health/ready',503,{ready:true}],
 ['readiness invalid body','/api/health/ready',200,{ready:false}],
])test(name+' retains the original fail-closed health assertions',async t=>{
 const h=harness(t,{health:actual=>actual===route?{status,body}:{status:200,body:{ok:true}}});
 await assert.rejects(h.run(),error=>error.code==='ERR_ASSERTION'&&error.message.includes(route));
 assert.equal(h.events.includes('data-checks'),false);assert.equal(h.events.at(-1),'closed');
});

test('an initialization failure starts neither listener nor HTTP request and preserves its error',async t=>{
 const reason=new Error('synthetic initialization failed'),h=harness(t,{initialize:async()=>{throw reason;}});
 await assert.rejects(h.run(),error=>error===reason);
 assert.deepEqual(h.routes,[]);assert.deepEqual(h.budgets,[]);assert.deepEqual(h.events,['init-start','closed']);
 assert.equal(h.phases().at(-1),'initialization-failed');
});

for(const startupPhase of ['receipt-workers','report-worker'])test(startupPhase+' failure survives thread transport and private recovery projection',async t=>{
 const worker=createSalesReportBatchWorker({workerFile:path.resolve(__dirname,'../test-support/report-worker-startup-fixture.js'),workerConfiguration:{scenario:'capacity'}});
 t.after(()=>worker.stop());
 const h=harness(t,{async initialize({onProgress}){onProgress(startupPhase);await worker.run({operation:'initialize'});}});
 await assert.rejects(h.run(),{code:'IMPORT_REPORT_FAILED'});
 assert.deepEqual(h.routes,[]);assert.deepEqual(h.budgets,[]);
 const retained=safeDiagnostics(h.workspace);
 assert.equal(retained.startupFailure.startupPhase,startupPhase);
 assert.deepEqual(retained.startupFailure.diagnostic,{phase:'core-database',errorClass:'connection-capacity',originalCode:'53300'});
 assert.ok(retained.httpProgress.some(row=>row.phase===startupPhase));
 assert.doesNotMatch(JSON.stringify(retained),/PRIVATE|SECRET|PASSWORD|TOKEN|stack|message/);
 if(process.platform==='linux')assert.equal(fs.statSync(path.join(h.root,'startup-failure.json')).mode&0o777,0o600);
});

for(const mode of ['active','idle','unobservable'])test('native supervisor continues to observe '+mode+' application initialization',async t=>{
 const start=deferred(),h=harness(t,{initialize:()=>start.promise}),completion=h.run(),terminations=[];
 let now=0;
 const watch=monitorActivity({completion,now:()=>now,pause:async ms=>{await new Promise(resolve=>setImmediate(resolve));now+=ms;},report:()=>{},
  sample:async()=>{
   if(mode==='unobservable')throw new Error('private observation error');
   if(mode==='active'&&now>=195000)start.resolve();
   return {phase:'verify-application-http',sequence:1,cpuUsec:mode==='active'?now*1000:0,ioBytes:0};
  },
  terminate:async code=>{terminations.push(code);start.reject(Object.assign(new Error(code),{code}));},
 });
 if(mode==='active'){
  await assert.rejects(watch,error=>error===h.reachedDataChecks);assert.ok(now>180000);assert.deepEqual(terminations,[]);
  assert.deepEqual(h.budgets,[180000,180000]);
 }else{
  const code=mode==='idle'?'PG_RECOVERY_STALLED':'PG_RECOVERY_ACTIVITY_UNAVAILABLE';
  await assert.rejects(watch,{code});await assert.rejects(completion,{code});assert.deepEqual(terminations,[code]);
  assert.equal(now,mode==='idle'?615000:75000);assert.deepEqual(h.budgets,[]);
 }
});
