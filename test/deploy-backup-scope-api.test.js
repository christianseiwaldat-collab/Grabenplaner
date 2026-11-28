'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
const express=require('express'),P=require('../lib/deploy-backup-scope');
const {isLocalSystemSession}=require('../lib/personnel-lifecycle-access');
const branchPasswordReset=require('../lib/branch-account-password-reset');
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
function sourceFunction(name){const start=source.search(new RegExp('^(?:async )?function '+name+'\\(','m')),end=source.indexOf('\n}',start);assert.ok(start>=0&&end>start,name);return source.slice(start,end+2);}
function route(method,url){const start=source.indexOf(`app.${method}("${url}",`),end=source.indexOf('\n});',start);assert.ok(start>=0&&end>start,url);return source.slice(start,end+4);}
const actor=()=>({id:'synthetic-session',employeeNumber:'synthetic-admin',role:'developer',sessionKind:'employee',permissions:['backup:write','settings:write'],mustChangePassword:false});

// Real HTTP, production route bodies and auth/CSRF guards. The small repository
// fixture supplies synthetic sessions and transactional before/after state; it
// does not start the full application or claim native PostgreSQL qualification.
async function fixture(t,{raw}={}){
 const app=express(),state={raw,audits:[],actor:actor(),portalEnabled:true,live:null,auditFailure:false,transactionError:null},calls=[];
 let queue=Promise.resolve();const transactions=[];
 const persistenceProvider={transaction(work,options){
  assert.equal(options.isolation,'serializable');const execution=queue.then(async()=>{
   if(state.transactionError)throw Object.assign(new Error('synthetic transaction failure'),{code:state.transactionError});
   const tx={raw:state.raw,audits:structuredClone(state.audits),portalAccess:{syntheticTransaction:true}};transactions.push(tx);
   const result=await work(tx);state.raw=tx.raw;state.audits=tx.audits;return result;
  });queue=execution.catch(()=>{});return execution;
 }};
 const list=raw=>raw===undefined?[]:[{key:P.KEY,value:raw}];
 const registered={get:(url,handler)=>app.get(url,async(request,response)=>handler(request,response)),put:(url,handler)=>app.put(url,async(request,response)=>handler(request,response))};
 const context=vm.createContext({app:registered,process:{platform:'linux'},serverModeActive:true,crypto,Buffer,deployBackupScope:P,branchPasswordReset,BACKUP_ADMIN_ROLES:new Set(['developer','it_admin','admin']),isLocalSystemSession,
  PORTAL_CSRF_COOKIE:'grabenplaner_csrf',PORTAL_SESSION_COOKIE:'grabenplaner_session',getPortalStatus:()=>({portalEnabled:state.portalEnabled}),isLoopbackRequest:()=>true,
  planningSettingsRepository:{async listSettings(){calls.push('read');return list(state.raw);}},persistenceProvider,
  createApplicationRepositories:tx=>({portalAccess:tx.portalAccess,planningSettings:{async listSettings(){return list(tx.raw);},async upsertSetting(row){assert.equal(row.key,P.KEY);calls.push('upsert');tx.raw=row.value;}},
   organizationPersonnel:{async insertAudit(employeeNumber,event,kind,id,details){calls.push('audit');if(state.auditFailure)throw new Error('SYNTHETIC_AUDIT_FAILURE');tx.audits.push({employeeNumber,event,kind,id,details:JSON.parse(details)});}}}),
  loadPortalSessionFromRequest:async(request,options)=>{assert.equal(options.touch,false);assert.equal(options.repository.syntheticTransaction,true);calls.push('fresh-session');return state.live===null?structuredClone(request.portalSession):state.live;},
  resolvePlanningContext:async()=>({locationId:'synthetic-location'}),assertSessionContextScope:()=>{},settingsForLocation:async()=>({locale:'de-AT',[P.KEY]:state.raw}),applyScopedPdfSettings:value=>value,pastWeekEditingAllowedForActor:async()=>false,
  isSystemNotificationReceiptSettingKey:()=>false});
 for(const name of ['httpError','sha256','parseCookies','portalSessionFromRequest','safeHashEquals','portalCsrfToken','assertPortalCsrf','requirePortalSession','requirePortalAdminOrLocal','requireMaintenanceScheduleActor','assertLivePortalRoutePermission'])vm.runInContext(sourceFunction(name),context);
 app.use(express.json());app.use((request,response,next)=>{request.portalSession=state.actor?structuredClone(state.actor):null;next();});
 vm.runInContext(route('get','/api/backup/deploy-scope')+'\n'+route('put','/api/backup/deploy-scope')+'\n'+route('get','/api/settings'),context);
 const generic=source.indexOf('app.put("/api/settings",'),prefixEnd=source.indexOf('  const body = request.body;',generic);assert.ok(generic>=0&&prefixEnd>generic);
 vm.runInContext(source.slice(generic,prefixEnd)+'response.json({ok:true});\n});',context);
 app.use((error,request,response,next)=>response.status(error.status||500).json({code:error.code||'TEST_FAILURE'}));
 const server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});const base='http://127.0.0.1:'+server.address().port;
 async function request(method='GET',body,options={}){
  const token='synthetic-browser-token',csrf=context.portalCsrfToken(token),headers={cookie:`grabenplaner_session=${token}; grabenplaner_csrf=${options.cookieCsrf||csrf}`};
  if(options.csrf!==false)headers['x-csrf-token']=options.headerCsrf||csrf;if(body!==undefined)headers['content-type']='application/json';
  const response=await fetch(base+(options.route||'/api/backup/deploy-scope'),{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,headers:response.headers,body:await response.json()};
 }
 return{state,calls,transactions,context,request,put:(scope,expectedRevision='0',options)=>request('PUT',{scope,expectedRevision},options)};
}

test('dedicated API defaults to full and returns no-store sanitized state, including malformed-storage fallback',async t=>{
 const f=await fixture(t);let result=await f.request();assert.equal(result.status,200);assert.deepEqual(result.body,P.response(P.read(undefined)));assert.equal(result.headers.get('cache-control'),'no-store');assert.equal(f.transactions.length,0);
 f.state.raw='PRIVATE_INVALID_VALUE';result=await f.request();assert.equal(result.body.scope,'full');assert.equal(result.body.valid,false);assert.match(result.body.revision,/^invalid-[a-f0-9]{64}$/);assert.equal(JSON.stringify(result.body).includes('PRIVATE_INVALID_VALUE'),false);
});

test('read and write require an authenticated backup administrator; local-system bypass is rejected',async t=>{
 const f=await fixture(t);
 for(const candidate of [null,{...actor(),role:'employee'},{...actor(),permissions:['settings:write']},{...actor(),employeeNumber:'local',localSystem:true,sessionKind:'local'},{...actor(),mustChangePassword:true}]){
  f.state.actor=candidate;for(const method of ['GET','PUT']){
   const result=await f.request(method,method==='PUT'?{scope:'deploy-owned',expectedRevision:'0'}:undefined);
   assert.equal(result.status,candidate===null?401:candidate.mustChangePassword?428:403);
  }
 }
 assert.equal(f.transactions.length,0);assert.equal(f.state.raw,undefined);
 for(const role of ['developer','it_admin','admin']){f.state.actor={...actor(),role};assert.equal((await f.request()).status,200);}
 f.context.process.platform='win32';assert.equal((await f.put('deploy-owned')).status,409);
});

test('PUT enforces the real session-bound CSRF cookie/header pair before starting a transaction',async t=>{
 const f=await fixture(t);
 for(const options of [{csrf:false},{headerCsrf:'x'.repeat(64)},{cookieCsrf:'y'.repeat(64),headerCsrf:'y'.repeat(64)}]){
  const result=await f.put('deploy-owned','0',options);assert.equal(result.status,403);assert.equal(result.body.code,'PORTAL_CSRF_INVALID');
 }
 assert.equal(f.transactions.length,0);assert.equal(f.state.audits.length,0);
});

test('strict input is rejected before state or audit writes and the generic settings API cannot bypass it',async t=>{
 const f=await fixture(t);
 for(const body of [null,[],{},'full',{scope:'full',expectedRevision:0},{scope:'full',expectedRevision:['0']},{scope:'core-only',expectedRevision:'0'},{scope:'deploy-owned',expectedRevision:'0',force:true}]){
  const result=await f.request('PUT',body);assert.equal(result.status,400);if(body!==null&&typeof body!=='string')assert.equal(result.body.code,'DEPLOY_BACKUP_SCOPE_INVALID');
 }
 const blocked=await f.request('PUT',{[P.KEY]:'deploy-owned'},{route:'/api/settings'});assert.equal(blocked.status,400);assert.equal(blocked.body.code,'DEPLOY_BACKUP_SCOPE_DEDICATED_API_REQUIRED');
 const branchBlocked=await f.request('PUT',{[branchPasswordReset.SETTING_PREFIX+'synthetic-account']:'synthetic'}, {route:'/api/settings'});assert.equal(branchBlocked.status,400);assert.equal(branchBlocked.body.code,'PORTAL_ORGANIZATION_RECOVERY_PROTECTED_SETTING');
 assert.equal(f.transactions.length,0);assert.equal(f.state.raw,undefined);assert.equal(f.state.audits.length,0);
});

test('changed preference and its minimal audit are atomic; idempotent saves do not duplicate audit',async t=>{
 const f=await fixture(t),saved=await f.put('deploy-owned');assert.equal(saved.status,200);assert.equal(saved.body.scope,'deploy-owned');assert.equal(saved.headers.get('cache-control'),'no-store');
 assert.equal(f.state.audits.length,1);assert.deepEqual(f.state.audits[0],{employeeNumber:'synthetic-admin',event:'backup.deploy_scope.update',kind:'settings',id:P.KEY,details:{before:'full',after:'deploy-owned',revision:saved.body.revision}});
 assert.deepEqual(f.calls.slice(-3),['fresh-session','upsert','audit']);assert.equal(P.read(f.state.raw).scope,'deploy-owned');
 assert.equal((await f.put('deploy-owned',saved.body.revision)).status,200);assert.equal(f.state.audits.length,1);
 const before=f.state.raw;f.state.auditFailure=true;const failed=await f.put('full',saved.body.revision);assert.equal(failed.status,500);assert.equal(f.state.raw,before);assert.equal(f.state.audits.length,1);
});

test('two simultaneous saves with the same CAS anchor have one winner and one stale response',async t=>{
 const f=await fixture(t),results=await Promise.all([f.put('deploy-owned'),f.put('deploy-owned')]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(results.find(r=>r.status===409).body.code,'DEPLOY_BACKUP_SCOPE_STALE');assert.equal(f.state.audits.length,1);
 assert.equal(P.read(f.state.raw).revision,results.find(r=>r.status===200).body.revision);
 f.state.transactionError='PERSISTENCE_RETRYABLE_TRANSACTION';assert.equal((await f.put('full',P.read(f.state.raw).revision)).status,409);assert.equal(f.state.audits.length,1);
});

test('permission, role, password or session revocation observed inside the transaction blocks the write',async t=>{
 const f=await fixture(t);
 for(const live of [false,{...actor(),id:'replacement-session'},{...actor(),permissions:[]},{...actor(),role:'employee'},{...actor(),mustChangePassword:true}]){
  f.state.live=live;const result=await f.put('deploy-owned');assert.equal(result.status,live===false||live.id==='replacement-session'?401:live.mustChangePassword?428:403);
  assert.equal(f.state.raw,undefined);assert.equal(f.state.audits.length,0);
 }
 assert.equal(f.calls.filter(c=>c==='fresh-session').length,5);assert.equal(f.calls.includes('upsert'),false);
});

test('corrupt storage can be repaired with its opaque fallback revision; raw preference stays out of general settings',async t=>{
 const f=await fixture(t,{raw:'PRIVATE_INVALID_VALUE'}),initial=await f.request(),saved=await f.put('full',initial.body.revision);
 assert.equal(saved.status,200);assert.equal(saved.body.valid,true);assert.equal(saved.body.scope,'full');assert.equal(f.state.audits.length,1);
 const general=await f.request('GET',undefined,{route:'/api/settings'});assert.equal(general.status,200);assert.equal(Object.hasOwn(general.body,P.KEY),false);assert.equal(general.body.locale,'de-AT');
 assert.equal(JSON.stringify(f.state.audits).includes('PRIVATE_INVALID_VALUE'),false);
});
