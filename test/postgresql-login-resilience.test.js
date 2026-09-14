'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
test('Native PostgreSQL login with an existing cookie and concurrent import/planning requests', {skip:!process.env.GP_CORE_MIGRATOR_URL,timeout:150000},async()=>{
 for(const domain of ['CORE','SALES'])for(const purpose of ['APP','READER','MIGRATOR']){
  const url=new URL(process.env[`GP_${domain}_${purpose}_URL`]);
  assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55487');assert.equal(url.pathname,'/gp_migration_'+domain.toLowerCase());
 }
 await require('../test-support/postgresql-migration/report-fixture').withReportFixture(async f=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gp-native-login-'));let subject,server;
  // Test-only dependency injection into this node:test child process. Production
  // configuration and all native environment/schema guards remain unchanged.
  const configModule=require('../lib/persistence/configuration'),original=configModule.resolvePersistenceConfiguration;
  configModule.resolvePersistenceConfiguration=()=>Object.freeze({providerId:'postgresql',databasePath:path.join(root,'core.postgresql'),databaseUrlConfigured:true,
   coreUrl:process.env.GP_CORE_APP_URL,salesUrl:process.env.GP_SALES_APP_URL,readers:{coreUrl:process.env.GP_CORE_READER_URL,salesUrl:process.env.GP_SALES_READER_URL},rehearsal:true,productActivation:false});
  Object.assign(process.env,{NODE_ENV:'test',GRABENPLANER_FORCE_PORTAL:'1',GRABENPLANER_DATA_DIR:root,BACKUP_DIR:path.join(root,'backups'),GRABENPLANER_HOST:'127.0.0.1',GRABENPLANER_INTEGRATION_KEY_ID:'synthetic-migration',GRABENPLANER_INTEGRATION_KEY:Buffer.alloc(32,78).toString('base64')});
  fs.mkdirSync(path.resolve(__dirname,'../.git'),{recursive:true});
  try{
   console.log('Native login fixture ready');
   subject=require('../server');await subject.initializeApplicationPersistence();
   console.log('Native login server initialized');
   const password='Synthetic-Native-Login-2026!';
   await f.core.migrator.query('SET ROLE gp_core_owner');await f.core.migrator.query('UPDATE gp.portal_users SET password_hash=$1,must_change_password=0 WHERE employee_number=$2',[await subject.hashPortalPassword(password),'00001']);await f.core.migrator.query('RESET ROLE');
   server=await new Promise(r=>{const s=subject.app.listen(0,'127.0.0.1',()=>r(s));});const base='http://127.0.0.1:'+server.address().port;let cookie='';
   async function request(route,body){const start=performance.now(),res=await fetch(base+route,{signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',Cookie:cookie},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
    const data=await res.json();assert.equal(res.status,200,JSON.stringify(data));return {res,data,ms:performance.now()-start};}
   for(let i=0;i<3;i++){const {res,data}=await request('/api/portal/v1/auth/login',{employeeNumber:'00001',password});assert.equal(data.authenticated,true);cookie=res.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');}
   // Force a renewal with immutable repository rows, then verify a page burst.
   await f.core.migrator.query('SET ROLE gp_core_owner');await f.core.migrator.query("UPDATE gp.portal_sessions SET expires_at=to_char(now()+interval '5 minutes','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') WHERE revoked_at IS NULL");await f.core.migrator.query('RESET ROLE');
   await request('/api/portal/v1/session');
   await f.core.migrator.query('SET ROLE gp_core_owner');await f.core.migrator.query("INSERT INTO gp.cost_centers(id,code,name,type,cost_center_type_id) VALUES('cc19','19','Synthetic 19','branch','branch'); INSERT INTO gp.locations(id,name,active,cost_center_id) VALUES('19','Synthetic 19',1,'cc19')");await f.core.migrator.query('RESET ROLE');
   const source=await require('../test-support/trade-insights-fixture').insightFixture({access:f.access,protection:f.protection,scopeId:'synthetic-migration',ownerId:'00001',branches:['18','19']});
   const work=source.ingest('Reparatur',Array.from({length:35},(_,i)=>({ReparaturNr:i+1,FilialId:'18',AName:'Synthetic concurrent repair '+i,erledigt:true})));
   const results=await Promise.all(Array.from({length:12},(_,i)=>request(i%3===0?'/api/schedule?week=2026-09-14&locationId=18':'/api/portal/v1/session')));await work;
   const maximum=Math.max(...results.map(r=>r.ms));assert.ok(maximum<10000,'Concurrent requests must stay below the reported ten-second delay');
   await f.core.migrator.query('SET ROLE gp_core_owner');await f.core.migrator.query("UPDATE gp.portal_users SET active=0 WHERE employee_number='00001'");await f.core.migrator.query('RESET ROLE');
   assert.equal((await request('/api/portal/v1/session')).data.authenticated,false);
   const asset=await fetch(base+'/api-errors.js',{headers:{Cookie:cookie}});assert.equal(asset.status,200);assert.match(await asset.text(),/initializeApiErrors/);
   await f.core.migrator.query('SET ROLE gp_core_owner');await f.core.migrator.query("UPDATE gp.portal_users SET active=1 WHERE employee_number='00001'");await f.core.migrator.query('RESET ROLE');
   console.log(JSON.stringify({nativeLogin:true,concurrentRequests:results.length,maximumMilliseconds:Math.round(maximum),revocation:true}));
  }finally{
   if(server)await new Promise(r=>{server.close(r);server.closeAllConnections();});await subject?.closePersistenceForTests();subject?.releaseInstanceLockForTests();configModule.resolvePersistenceConfiguration=original;
   assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});
  }
 },{warmWorkers:false});
});
