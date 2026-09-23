'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const {safeDiagnostics}=require('../server-tools/linux/recovery/lib/postgresql-recovery-diagnostics');
const {smokeDiagnostics,sanitizeSmokeFailure}=require('../server-tools/linux/recovery/lib/postgresql-smoke-diagnostics');
const file=path.resolve(__dirname,'../server-tools/linux/recovery/lib/postgresql-application-smoke.js'),source=fs.readFileSync(file,'utf8'),localRequire=createRequire(file);
function fixture(t){
 const workspace=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'gp-smoke-steps-'))),root=path.join(workspace,'work','application');fs.mkdirSync(root,{recursive:true});
 t.after(()=>{assert.ok(workspace.startsWith(fs.realpathSync(os.tmpdir())+path.sep));fs.rmSync(workspace,{recursive:true});});
 fs.writeFileSync(path.join(root,'source-encryption.env'),'');return {workspace,root};
}
function harness(t,{badLogin=false,badPreview=false,integrityError=null}={}){
 const {workspace,root}=fixture(t),routes=[];let imported=false,closed=false;
 const access={prepare(){return {get:async()=>({id:'synthetic-location'}),run:async()=>({})};},transaction:async work=>work(),close:async()=>{}};
 const server={once(){},close(done){done();},closeAllConnections(){}};
 const subject={initializeApplicationPersistence:async()=>{},app:{listen(_port,_host,done){queueMicrotask(done);return server;}},hashPortalPassword:async()=>'synthetic-hash',
  closePersistenceForTests:async()=>{closed=true;},ensureWorkRuleEvaluationReceiptIntegrity:async()=>{if(integrityError)throw integrityError;return 1;},runSalesReportQueueForTests:async()=>{}};
 const context={module:{exports:{}},Buffer,URL,performance,setTimeout,setInterval,clearInterval,queueMicrotask,AbortSignal,
  process:{env:{},platform:process.platform,memoryUsage:process.memoryUsage},
  async fetch(url,options={}){
   const route=new URL(url).pathname;routes.push(route);let status=200,body={ok:true},pdf=false;
   if(route==='/api/portal/v1/auth/login'&&badLogin){status=403;body={error:'SECRET',employee:'PRIVATE'};}
   else if(route==='/api/sales/articles')body={total:new URL(url).searchParams.get('query')==='Sony'||imported?1:0,items:new URL(url).searchParams.get('query')==='Sony'||imported?[{name:'PRIVATE'}]:[]};
   else if(route.endsWith('.pdf')||route.endsWith('/download'))pdf=true;
   else if(route==='/api/receipt-search/context')body={available:true};
   else if(route==='/api/sales/articles/import/catalog')body={mimeType:'application/json',format:'synthetic'};
   else if(route==='/api/sales/articles/import/preview'){status=201;body={summary:{create:badPreview?0:1},previewId:'PRIVATE',confirmationFingerprint:'a'.repeat(64),password:'SECRET'};}
   else if(route==='/api/sales/articles/import/apply'){
    if(JSON.parse(options.body).confirmationFingerprint==='0'.repeat(64))status=409;
    else{status=201;body={personalActionId:'PRIVATE'};imported=true;}
   }else if(route.endsWith('/undo'))body={alreadyUndone:true};
   else if(route==='/api/sales-report-jobs'){
    if(options.method==='POST')body={id:'synthetic-report'};
    else if(routes.filter(r=>r==='/api/sales-report-jobs').length>=3)status=401;
    else body=[{id:'synthetic-report',status:'completed',processed:1}];
   }
   return {status,headers:{getSetCookie:()=>[],get:()=>pdf?'application/pdf':'application/json'},json:async()=>body,arrayBuffer:async()=>Buffer.from('%PDF-synthetic')};
  },
  require(name){if(name==='../../../../server')return subject;if(name==='../../../../lib/persistence/postgresql/application-operations/access')return {openCoreOperations:async()=>access};return localRequire(name);},
 };
 vm.runInNewContext(source,context,{filename:file});
 return {workspace,root,routes,isClosed:()=>closed,run:()=>context.module.exports.qualifyHttp({root,config:{recoveryAccounts:{gp_core_app:'synthetic-only'}}})};
}
for(const [label,options,expected] of [
 ['login HTTP rejection',{badLogin:true},{step:'login',errorClass:'http-status',status:403,expected:200}],
 ['import preview assertion',{badPreview:true},{step:'import-preview',errorClass:'assertion'}],
 ['database operation',{integrityError:Object.assign(new Error('SELECT PRIVATE password=SECRET'),{code:'PERSISTENCE_TIMEOUT'})},{step:'work-rule-integrity',errorClass:'operation'}],
])test('full smoke retains '+label+' without private contents and still fails',async t=>{
 const h=harness(t,options);await assert.rejects(h.run(),error=>options.integrityError?error===options.integrityError:error.code==='ERR_ASSERTION');
 assert.equal(h.isClosed(),true);const retained=safeDiagnostics(h.workspace).smokeFailure;
 assert.match(retained.at,/^\d{4}-/);delete retained.at;assert.deepEqual(retained,expected);
 assert.doesNotMatch(JSON.stringify(retained),/SECRET|PRIVATE|password|SELECT|query|employee/);
 if(process.platform==='linux')assert.equal(fs.statSync(path.join(h.root,'smoke-failure.json')).mode&0o777,0o600);
});
test('successful full smoke leaves no failure diagnostic and performs the final revocation check',async t=>{
 const h=harness(t),result=await h.run();assert.equal(result.fullApplicationSmoke,true);assert.equal(result.revokedSessionRejected,true);
 assert.equal(h.routes.at(-1),'/api/sales-report-jobs');assert.equal(safeDiagnostics(h.workspace).smokeFailure,undefined);
});
test('failure projection rejects unknown steps/classes and oversized files',t=>{
 const {workspace,root}=fixture(t);
 for(const value of [{step:'SECRET',errorClass:'assertion'},{step:'import-preview',errorClass:'PRIVATE'}]){
  assert.equal(sanitizeSmokeFailure(value),null);fs.writeFileSync(path.join(root,'smoke-failure.json'),JSON.stringify(value));assert.equal(safeDiagnostics(workspace).smokeFailure,undefined);
 }
 fs.writeFileSync(path.join(root,'smoke-failure.json'),'X'.repeat(5000));assert.equal(safeDiagnostics(workspace).smokeFailure,undefined);
 const d=smokeDiagnostics(path.join(root,'missing'));assert.doesNotThrow(()=>d.failed(new Error('PRIVATE')));
});
