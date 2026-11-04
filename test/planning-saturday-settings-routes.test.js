"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),vm=require('node:vm'),fs=require('node:fs');
const planningSaturdayCredit=require('../lib/planning-saturday-credit');
const source=fs.readFileSync(require.resolve('../server'),'utf8');
function fn(name){const a=source.indexOf('function '+name+'('),b=source.indexOf('\n}',a);assert(a>=0&&b>a);return source.slice(a,b+2);}
test('the mounted setting route protects scope, CSRF and live permission revocation; all views share one location key',async t=>{
 const app=express();app.use(express.json());let settings={},writes=0,audits=0;
 let actor={employeeNumber:'test',role:'manager',permissions:['schedule:write','schedule:read'],scopes:[{locationId:'18',departmentId:null}]},liveActor=actor;
 const error=(status,message,code)=>Object.assign(Error(message),{status,code});
 const context=vm.createContext({app,planningSaturdayCredit,GLOBAL_SCOPE_PORTAL_ROLES:new Set(['admin']),isLocalSystemSession:a=>a?.localSystem===true,httpError:error,
  requirePortalAnyPermissionOrLocal:(req,permissions,opts={})=>{if(!actor)throw error(401,'Login');if(!permissions.some(p=>actor.permissions.includes(p)))throw error(403,'Permission');if(opts.csrf&&req.get('X-CSRF-Token')!=='test')throw error(403,'CSRF');return actor;},
  validateActiveLocationExists:async id=>{if(!['18','05'].includes(id))throw error(404,'Location');},getSettings:()=>settings,
  persistenceProvider:{transaction:async work=>work({})},createApplicationRepositories:()=>({planningSettings:{upsertSetting:async({key,value})=>{settings[key]=value;writes++;}},organizationPersonnel:{insertAudit:async()=>{audits++;}}}),
  livePersonnelLearningRoleAdministrationActor:async()=>liveActor,refreshApplicationSettingsSnapshot:async()=>{},
 });
 vm.runInContext(fn('sessionHasGlobalScope')+'\n'+fn('assertSessionContextScope'),context);
 const a=source.indexOf('planningSaturdayCredit.registerRoutes(app, {'),b=source.indexOf('app.get("/api/portal/v1/cross-location-schedule-settings"',a);assert(a>0&&b>a);vm.runInContext(source.slice(a,b),context);
 app.use((e,req,res,next)=>res.status(e.status||500).json({error:e.message,code:e.code}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
 const request=(id='18',body,csrf=true)=>fetch('http://127.0.0.1:'+server.address().port+'/api/portal/v1/planning-saturday-settings/'+id,{method:body===undefined?'GET':'PUT',headers:{'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':'test'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 assert.deepEqual(await(await request()).json(),{locationId:'18',enabled:true});
 assert.equal((await request('18',{enabled:false},false)).status,403);assert.equal(writes,0);
 assert.equal((await request('18',{enabled:'false'})).status,400);assert.equal((await request('18',{enabled:false,actual:true})).status,400);
 assert.equal((await request('05',{enabled:false})).status,403);
 actor={...actor,scopes:[{locationId:'18',departmentId:1}]};assert.equal((await request('18',{enabled:false})).status,403);
 actor={...actor,scopes:[{locationId:'18',departmentId:null}]};liveActor={...actor,permissions:[]};assert.equal((await request('18',{enabled:false})).status,403);assert.equal(writes,0);
 liveActor={...actor,scopes:[]};assert.equal((await request('18',{enabled:false})).status,403);assert.equal(writes,0);
 liveActor=actor;assert.deepEqual(await(await request('18',{enabled:false})).json(),{locationId:'18',enabled:false});assert.equal(writes,1);assert.equal(audits,1);
 actor={...actor,role:'admin'};liveActor=actor;assert.equal((await(await request('05')).json()).enabled,true);assert.equal(settings[planningSaturdayCredit.settingKey('18')],'0');
 actor={...actor,permissions:['schedule:read']};liveActor=actor;assert.equal((await request('18',{enabled:true})).status,403);assert.equal((await request()).status,200);
});
