'use strict';
const assert=require('node:assert/strict'),test=require('node:test'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'gp-trade-insights-api-')),key=Buffer.alloc(32,53);
Object.assign(process.env,{DB_PATH:path.join(root,'demo.db'),BACKUP_DIR:path.join(root,'backups'),GRABENPLANER_DATA_DIR:path.join(root,'data'),GRABENPLANER_HOST:'127.0.0.1',GRABENPLANER_FORCE_PORTAL:'1',GRABENPLANER_SEED_DEMO:'1',GRABENPLANER_INTEGRATION_KEY_ID:'insights-test',GRABENPLANER_INTEGRATION_KEY:key.toString('base64'),NODE_ENV:'test'});
const {app,db,releaseInstanceLockForTests}=require('../server');let server,url,auth,source,access,protection,storeApp;
async function request(kind,body,session=auth){const response=await fetch(url+'/api/trade-insights/'+kind,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};}
test.before(async()=>{
 for(const id of ['93','94'])db.prepare('INSERT OR IGNORE INTO locations(id,name,active) VALUES(?,?,1)').run(id,'Synthetic '+id);
 db.exec("INSERT INTO employees(personnel_number,full_name,nickname,color,contracted_hours,home_location_id,active) VALUES('insights-user','Synthetic Developer','Synthetic','#287a67',38.5,'93',1); INSERT INTO portal_users(employee_number,password_hash,role,active,must_change_password) VALUES('insights-user','test-only','developer',1,0)");
 const token=crypto.randomBytes(32).toString('hex'),csrf=crypto.randomBytes(24).toString('hex');db.prepare("INSERT INTO portal_sessions(id,employee_number,token_hash,expires_at) VALUES(?,'insights-user',?,'2099-12-31T23:59:59.000Z')").run(crypto.randomUUID(),crypto.createHash('sha256').update(token).digest('hex'));
 auth={cookie:`grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`,csrf};
 storeApp=require('../lib/persistence/sqlite/provider').openSqliteApplicationPersistence({databasePath:process.env.DB_PATH,catalog:require('../lib/persistence/sqlite/application-catalog').SQLITE_APPLICATION_CATALOG});access=storeApp.provider;
 const vault=require('../lib/integration-secret-vault').createIntegrationSecretVault({activeKeyId:'insights-test',keys:{'insights-test':key}});protection=await require('../lib/data-import-managed-protection').loadManagedDataImportProtection({access,vault,create:true});
 source=await require('../test-support/trade-insights-fixture').insightFixture({access,protection,ownerId:'insights-user',branches:['93','94']});
 await source.ingest('Reparatur',[{ReparaturNr:1,FilialId:'93',KUND_NR:42,AName:'Synthetic camera',erledigt:true}]);
 await new Promise(resolve=>{server=app.listen(0,'127.0.0.1',resolve);});url='http://127.0.0.1:'+server.address().port;
});
test.after(async()=>{if(server)await new Promise(r=>server.close(r));protection?.destroy();await access?.close();storeApp?.database.close();db.close();releaseInstanceLockForTests();assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('gp-trade-insights-api-'));fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
test('Trade views use actual session authority, CSRF and protected read/write composition',async()=>{
 assert.equal((await request('context',null,null)).status,401);
 let res=await request('context');assert.equal(res.status,200,JSON.stringify(res.data));assert.equal(res.data.projection.repairWrite,true);
 res=await request('purchasing',{});assert.equal(res.status,200,JSON.stringify(res.data));assert.equal(res.data.rows.length,50);
 const cases=await request('repairs',{});assert.equal(cases.status,200,JSON.stringify(cases.data));const r=cases.data.rows[0];assert.equal(r.gpStatus,'unassigned');
 assert.equal((await request('repair-save',{id:r.id,state:'collected',expectedRevision:0},{...auth,csrf:'wrong'})).status,403);
 res=await request('repair-save',{id:r.id,state:'collected',expectedRevision:0});assert.equal(res.status,200,JSON.stringify(res.data));assert.equal(res.data.gpStatus,'collected');
 assert.equal((await request('repair-save',{id:r.id,state:'ready',expectedRevision:0})).status,409);
 db.prepare("UPDATE portal_users SET active=0 WHERE employee_number='insights-user'").run();assert.ok([401,403].includes((await request('repair-detail',{id:r.id})).status));
});
