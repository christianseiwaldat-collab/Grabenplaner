'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'gp-login-resilience-'));
Object.assign(process.env,{DB_PATH:path.join(root,'demo.db'),BACKUP_DIR:path.join(root,'backups'),GRABENPLANER_DATA_DIR:path.join(root,'data'),GRABENPLANER_FORCE_PORTAL:'1',GRABENPLANER_SEED_DEMO:'1',NODE_ENV:'test'});
const {app,db,releaseInstanceLockForTests}=require('../server');let server,url,closed=false;
test.before(async()=>{
 db.prepare("INSERT OR IGNORE INTO locations(id,name,active) VALUES('93','Synthetic Login Branch',1)").run();
 const salt=Buffer.alloc(16,62),password='Synthetic-Login-Only-2026!',hash='scrypt-v1$'+salt.toString('base64url')+'$'+crypto.scryptSync(password,salt,64).toString('base64url');
 db.prepare("INSERT INTO employees(personnel_number,full_name,nickname,color,contracted_hours,home_location_id,active) VALUES('login-probe','Synthetic Login','Synthetic','#287a67',38.5,'93',1)").run();
 db.prepare("INSERT INTO portal_users(employee_number,password_hash,role,active,must_change_password) VALUES('login-probe',?,'developer',1,0)").run(hash);
 await new Promise(r=>{server=app.listen(0,'127.0.0.1',r);});url='http://127.0.0.1:'+server.address().port;
});
test.after(async()=>{if(server)await new Promise(r=>server.close(r));if(!closed)db.close();releaseInstanceLockForTests();assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
test('Login replaces a present cookie; page bursts do not rewrite newly created sessions',async()=>{
 async function login(cookie=''){return fetch(url+'/api/portal/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({employeeNumber:'login-probe',password:'Synthetic-Login-Only-2026!'})});}
 let response=await login();assert.equal(response.status,200,await response.text());
 let cookie=response.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
 response=await login(cookie);assert.equal(response.status,200,await response.text());cookie=response.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
 db.exec("CREATE TEMP TRIGGER no_redundant_session_touch BEFORE UPDATE ON portal_sessions BEGIN SELECT RAISE(ABORT,'Redundant session touch'); END");
 const responses=await Promise.all(Array.from({length:12},()=>fetch(url+'/api/portal/v1/session',{headers:{Cookie:cookie}})));
 for(const result of responses){assert.equal(result.status,200,await result.text());}
 db.exec('DROP TRIGGER no_redundant_session_touch');
 db.prepare("UPDATE portal_users SET active=0 WHERE employee_number='login-probe'").run();
 response=await fetch(url+'/api/portal/v1/session',{headers:{Cookie:cookie}});const body=await response.json();assert.equal(body.authenticated,false);
 // Static login assets must remain loadable even if database access is down.
 db.close();closed=true;
 response=await fetch(url+'/api-errors.js',{headers:{Cookie:cookie}});assert.equal(response.status,200);assert.match(await response.text(),/initializeApiErrors/);
});
