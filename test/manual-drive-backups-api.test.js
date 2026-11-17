'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),express=require('express');
const P=require('../lib/manual-drive-backups'),{isLocalSystemSession}=require('../lib/personnel-lifecycle-access');
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8'),ID='12345678-1234-4123-8123-123456789abc',SHA='a'.repeat(64),NOW='2026-11-17T10:00:00.000Z';
function fn(name){const start=source.search(new RegExp('^(?:async )?function '+name+'\\(','m')),end=source.indexOf('\n}',start);assert.ok(start>=0&&end>start,name);return source.slice(start,end+2);}
function route(method,url){const start=source.indexOf(`app.${method}("${url}",`),end=source.indexOf('\n});',start);assert.ok(start>=0&&end>start,url);return source.slice(start,end+4);}
const actor=()=>({id:'synthetic-session',employeeNumber:'synthetic-admin',role:'developer',sessionKind:'employee',permissions:['backup:write'],mustChangePassword:false});
const model=operation=>({available:true,providerId:'google_drive',generatedAt:NOW,verifiedAt:NOW,stale:false,busy:!!operation,backups:[],operation:operation||null});
async function fixture(t){
 const state={actor:actor(),live:null,audits:[],calls:[],brokerError:null,reauthError:false,latestResponse:null},app=express();let context;
 const api={...P,async exchange(action,options={}){state.calls.push({action,options,afterFinish:state.latestResponse?.writableFinished===true});if(state.brokerError)throw Object.assign(new Error('synthetic'),{code:state.brokerError});if(action==='list')return model(null);return model({requestId:options.requestId,action:action==='dispatch'?'create':action,state:'queued',phase:'queued',requestedAt:NOW,startedAt:null,finishedAt:null,snapshotId:options.snapshotId||null,errorCode:null});}};
 const provider={async transaction(work,options){assert.equal(options.isolation,'serializable');return work({});}};
 context=vm.createContext({app,process:{platform:'linux'},serverModeActive:true,crypto,Buffer,console:{warn:()=>{}},manualDriveBackups:api,persistenceProvider:provider,isLocalSystemSession,
  BACKUP_ADMIN_ROLES:new Set(['developer','it_admin','admin']),PORTAL_CSRF_COOKIE:'grabenplaner_csrf',PORTAL_SESSION_COOKIE:'grabenplaner_session',getPortalStatus:()=>({portalEnabled:true}),isLoopbackRequest:()=>true,
  createApplicationRepositories:()=>({portalAccess:{},organizationPersonnel:{async insertAudit(...args){state.audits.push(args);}}}),
  loadPortalSessionFromRequest:async()=>state.live===null?structuredClone(state.actor):state.live,
  requireBackupAdminReauthentication:async(request,response,options)=>{state.calls.push({action:'reauth',options});if(state.reauthError)throw Object.assign(new Error('denied'),{status:403,code:'BACKUP_ADMIN_AUTH_FAILED'});request.portalSession={...request.portalSession,id:'replacement-session'};state.actor=request.portalSession;response.setHeader('X-GP-Session-Changed','1');},
 });
 for(const name of ['httpError','sha256','parseCookies','portalSessionFromRequest','safeHashEquals','portalCsrfToken','assertPortalCsrf','requirePortalSession','requirePortalAdminOrLocal','requireMaintenanceScheduleActor','assertLivePortalRoutePermission','driveBackupHttpError','authorizeDriveBackupMutation','dispatchDriveBackupAfterResponse'])vm.runInContext(fn(name),context);
 app.use(express.json());app.use((req,res,next)=>{req.portalSession=state.actor?structuredClone(state.actor):null;state.latestResponse=res;next();});
 for(const [method,url] of [['get','/api/backup/drive'],['post','/api/backup/drive'],['delete','/api/backup/drive/:snapshotId']])vm.runInContext(route(method,url),context);
 app.use((error,request,response,next)=>response.status(error.status||500).json({code:error.code||'TEST_FAILURE'}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 async function request(method='GET',body,{csrf=true,snapshotId=SHA}={}){
  const token='synthetic-browser-token',proof=context.portalCsrfToken(token),headers={cookie:`grabenplaner_session=${token}; grabenplaner_csrf=${proof}`};if(csrf)headers['x-csrf-token']=proof;if(body!==undefined)headers['content-type']='application/json';
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/backup/drive'+(method==='DELETE'?'/'+snapshotId:''),{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,headers:response.headers,body:await response.json()};
 }
 return{state,request,context};
}
test('Drive listing is backup-admin-only and no-store; local-system/ordinary employee bypass is refused',async t=>{
 const f=await fixture(t);assert.equal((await f.request()).headers.get('cache-control'),'no-store');
 for(const candidate of [null,{...actor(),role:'employee'},{...actor(),permissions:[]},{...actor(),employeeNumber:'local',localSystem:true,sessionKind:'local'}]){f.state.actor=candidate;assert.equal((await f.request()).status,candidate===null?401:403);}
});
test('create requires CSRF and strict UUID-only input; password/path/command cannot enter the privileged request',async t=>{
 const f=await fixture(t);assert.equal((await f.request('POST',{requestId:ID},{csrf:false})).status,403);
 for(const body of [{requestId:'bad'},{requestId:ID,path:'/tmp'},{requestId:ID,currentPassword:'synthetic-only'},{requestId:ID,command:'backup'}])assert.equal((await f.request('POST',body)).status,400);
 assert.equal(f.state.calls.length,0);assert.equal(f.state.audits.length,0);
});
test('accepted create is audited, asynchronous, identity-bound and dispatched only after HTTP finish',async t=>{
 const f=await fixture(t),result=await f.request('POST',{requestId:ID});assert.equal(result.status,202);assert.equal(result.body.operation.requestId,ID);assert.equal(result.body.operation.action,'create');
 assert.equal(f.state.audits.length,1);assert.equal(f.state.audits[0][1],'backup.drive.create.requested');assert.equal(JSON.parse(f.state.audits[0][4]).restoreRequested,false);
 assert.deepEqual(f.state.calls.map(v=>v.action),['create','dispatch']);assert.equal(f.state.calls[0].afterFinish,false);assert.equal(f.state.calls[1].afterFinish,true);assert.equal(f.state.calls.some(v=>v.action==='reauth'),false);
});
test('fresh in-transaction revocation prevents queue and audit despite a stale request actor',async t=>{
 const f=await fixture(t);for(const live of [false,{...actor(),id:'other'},{...actor(),role:'employee'},{...actor(),permissions:[]},{...actor(),mustChangePassword:true}]){f.state.live=live;const result=await f.request('POST',{requestId:ID});assert.ok([401,403,428].includes(result.status));}
 assert.equal(f.state.calls.length,0);assert.equal(f.state.audits.length,0);
});
test('delete needs exact confirmation, current-password reauth and full snapshot SHA; secret is never forwarded',async t=>{
 const f=await fixture(t),body={requestId:ID,currentPassword:'synthetic-secret-only',confirmation:'DELETE_BACKUP'};
 assert.equal((await f.request('DELETE',{...body,confirmation:'DELETE_ALL'})).status,400);assert.equal((await f.request('DELETE',body,{snapshotId:'a'.repeat(8)})).status,400);
 f.state.reauthError=true;assert.equal((await f.request('DELETE',body)).status,403);assert.equal(f.state.audits.length,0);
 f.state.reauthError=false;const result=await f.request('DELETE',body);assert.equal(result.status,202);assert.equal(result.headers.get('x-gp-session-changed'),'1');assert.equal(result.body.operation.snapshotId,SHA);
 const forwarded=f.state.calls.filter(v=>['delete','dispatch'].includes(v.action));assert.equal(forwarded.length,2);assert.equal(JSON.stringify(forwarded).includes('synthetic-secret-only'),false);assert.equal(forwarded[0].options.snapshotId,SHA);
});
test('busy/missing/protected/conflicting and unavailable broker results are truthful safe HTTP errors',async t=>{
 const f=await fixture(t);for(const [code,status] of [['DRIVE_BACKUP_BUSY',409],['DRIVE_BACKUP_NOT_FOUND',409],['DRIVE_BACKUP_PROTECTED',409],['DRIVE_BACKUP_REQUEST_CONFLICT',409],['DRIVE_BACKUP_UNAVAILABLE',503]]){f.state.brokerError=code;const result=await f.request('POST',{requestId:ID});assert.equal(result.status,status);assert.equal(result.body.code,code);}
 assert.equal(f.state.calls.some(v=>v.action==='dispatch'),false);
});
