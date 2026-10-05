'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'gp-sidebar-notepad-api-'));
Object.assign(process.env,{DB_PATH:path.join(root,'synthetic.db'),BACKUP_DIR:path.join(root,'backups'),GRABENPLANER_DATA_DIR:path.join(root,'data'),GRABENPLANER_HOST:'127.0.0.1',GRABENPLANER_FORCE_PORTAL:'1',GRABENPLANER_SEED_DEMO:'1',GRABENPLANER_INTEGRATION_KEY_ID:'synthetic-notepad',GRABENPLANER_INTEGRATION_KEY:crypto.randomBytes(32).toString('base64'),NODE_ENV:'test',TZ:'Europe/Vienna'});
const subject=require('../server'),model=require('../public/sidebar-notepad-preferences');
const route='/api/portal/v1/ui-preferences',users={};let server,baseUrl,closed=false;
const note=(text,more={})=>({...model.empty(),text,...more});
async function request({method='GET',body,user=users.developer,csrf=true,url=baseUrl}={}){
  const headers={Accept:'application/json'};if(user)headers.Cookie=user.cookie;if(user&&csrf&&method!=='GET')headers['X-CSRF-Token']=user.csrf;
  if(body!==undefined)headers['Content-Type']='application/json';
  const response=await fetch(url+route,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,headers:response.headers,payload:await response.json()};
}
const stored=user=>subject.db.prepare('SELECT value FROM portal_user_preferences WHERE employee_number=? AND preference_key=?').get(user.id,model.KEY)?.value;
async function close(){if(closed)return;closed=true;if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await subject.closePersistenceForTests();subject.releaseInstanceLockForTests();}
test.before(async()=>{
  await subject.initializeApplicationPersistence();const db=subject.db,location=db.prepare('SELECT id FROM locations WHERE active=1 ORDER BY id LIMIT 1').get();
  for(const role of ['developer','employee','hr']){
    const id='notepad-'+role,token=crypto.randomBytes(32).toString('hex'),csrf=crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO employees(personnel_number,full_name,nickname,home_location_id,active) VALUES(?,?,?,?,1)').run(id,id,id,location.id);
    db.prepare("INSERT INTO portal_users(employee_number,password_hash,role,active,must_change_password,password_changed_at) VALUES(?,'synthetic',?,1,0,CURRENT_TIMESTAMP)").run(id,role);
    db.prepare("INSERT INTO portal_sessions(id,employee_number,token_hash,expires_at) VALUES(?,?,?,'2099-12-31T23:59:59.000Z')").run(crypto.randomUUID(),id,crypto.createHash('sha256').update(token).digest('hex'));
    users[role]={id,cookie:`grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`,csrf};
  }
  const id='notepad-organization',token=crypto.randomBytes(32).toString('hex'),csrf=crypto.randomBytes(24).toString('hex');
  db.prepare("INSERT INTO portal_organization_accounts(id,login_name,display_name,account_type,password_hash,active,must_change_password) VALUES(?,?,?,'branch','synthetic',1,0)").run(id,id,id);
  db.prepare("INSERT INTO portal_organization_sessions(id,account_id,token_hash,expires_at) VALUES(?,?,?,'2099-12-31T23:59:59.000Z')").run(crypto.randomUUID(),id,crypto.createHash('sha256').update(token).digest('hex'));
  users.organization={id,cookie:`grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`,csrf};
  server=subject.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));baseUrl='http://127.0.0.1:'+server.address().port;
});
test.after(async()=>{await close();fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
test('personal developer saves exact text, geometry and open state privately and encrypted at rest',async()=>{
  const before=await request();assert.equal(before.status,200);assert.deepEqual(before.payload.sidebarNotepad,model.empty());assert.match(before.headers.get('cache-control'),/no-store/);
  const value=note('  BEISPIEL: persönliche Notiz\n<img src=x onerror=alert(1)>  ',{height:345,open:true});
  const saved=await request({method:'PUT',body:{sidebarNotepad:value}});assert.equal(saved.status,200,JSON.stringify(saved.payload));assert.deepEqual(saved.payload.sidebarNotepad,value);
  const raw=stored(users.developer);assert.match(raw,/^gp-integration-secret:v1:/);assert.ok(!raw.includes('persönliche Notiz'));assert.deepEqual((await request()).payload.sidebarNotepad,value);
  assert.deepEqual((await request({user:users.employee})).payload.sidebarNotepad,model.empty());
  const employee=await request({user:users.employee,method:'PUT',body:{sidebarNotepad:note('Nur Mitarbeiter B')}});assert.equal(employee.status,200);
  assert.deepEqual((await request()).payload.sidebarNotepad,value);
});
test('CSRF, anonymous and organization accounts cannot change personal notes',async()=>{
  const before=stored(users.developer),body={sidebarNotepad:note('Forged')};
  assert.equal((await request({method:'PUT',body,csrf:false})).status,403);
  assert.equal((await request({method:'PUT',body,user:null})).status,401);
  assert.equal((await request({method:'PUT',body,user:users.organization})).status,403);
  assert.equal((await request({user:users.organization})).status,403);
  assert.equal(stored(users.developer),before);assert.equal(stored(users.organization),undefined);
});
test('invalid values fail before persistence, while ordinary preferences preserve the note',async()=>{
  const before=stored(users.developer);
  for(const sidebarNotepad of [note('x'.repeat(20001)),note('x',{height:119}),{...note('x'),employeeNumber:users.employee.id},note('bad\0text')])assert.equal((await request({method:'PUT',body:{sidebarNotepad}})).status,400);
  const result=await request({method:'PUT',body:{pageThemes:{rightsDashboard:'dark'}}});assert.equal(result.status,200);assert.equal(stored(users.developer),before);
  assert.equal((await request({user:users.hr,method:'PUT',body:{sidebarNotepad:note('HR note')}})).status,200);
  const boundary=await request({user:users.hr,method:'PUT',body:{sidebarNotepad:note('字'.repeat(20000))}});assert.equal(boundary.status,200);assert.equal(boundary.payload.sidebarNotepad.text.length,20000);
});
test('password-change and deactivation stop access; authenticated ciphertext cannot be moved to a different account',async()=>{
  const db=subject.db,body={sidebarNotepad:note('Forbidden')},before=stored(users.developer);
  db.prepare('UPDATE portal_users SET must_change_password=1 WHERE employee_number=?').run(users.developer.id);
  const blocked=await request({method:'PUT',body});assert.ok([403,428].includes(blocked.status),JSON.stringify(blocked));
  const read=await request();assert.ok(read.status===428||(read.status===200&&read.payload.sidebarNotepad===null));
  db.prepare('UPDATE portal_users SET must_change_password=0,active=0 WHERE employee_number=?').run(users.developer.id);
  assert.equal((await request()).status,401);assert.equal(stored(users.developer),before);
  db.prepare('UPDATE portal_users SET active=1 WHERE employee_number=?').run(users.developer.id);
  const savedB=stored(users.employee);
  db.prepare('UPDATE portal_user_preferences SET value=? WHERE employee_number=? AND preference_key=?').run(before,users.employee.id,model.KEY);
  assert.equal((await request({user:users.employee})).payload.sidebarNotepad,null);
  db.prepare('UPDATE portal_user_preferences SET value=? WHERE employee_number=? AND preference_key=?').run(savedB,users.employee.id,model.KEY);
});
test('corrupt note stays unavailable and is not silently erased by unrelated preference writes',async()=>{
  const db=subject.db,before=stored(users.developer);
  db.prepare('UPDATE portal_user_preferences SET value=? WHERE employee_number=? AND preference_key=?').run('damaged',users.developer.id,model.KEY);
  assert.equal((await request()).payload.sidebarNotepad,null);
  assert.equal((await request({method:'PUT',body:{pageThemes:{rightsDashboard:'light'}}})).status,200);assert.equal(stored(users.developer),'damaged');
  db.prepare('UPDATE portal_user_preferences SET value=? WHERE employee_number=? AND preference_key=?').run(before,users.developer.id,model.KEY);
});
test('a fresh application process restores the same account note with the configured key', {timeout:30000},async()=>{
  const expected=(await request()).payload.sidebarNotepad;await close();
  const script="const app=require(process.argv[1]);let server;process.on('message',async message=>{if(message==='stop'){await new Promise(r=>{server.close(r);server.closeAllConnections();});await app.closePersistenceForTests();app.releaseInstanceLockForTests();process.disconnect();}});(async()=>{await app.initializeApplicationPersistence();server=app.app.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));})().catch(error=>{console.error(error);process.exitCode=1;process.disconnect();});";
  const child=spawn(process.execPath,['-e',script,path.join(__dirname,'../server')],{env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  let stderr='';child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-8000);});child.stdout.resume();
  const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  let startDeadline;
  try{
    const ready=await Promise.race([new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);}),exited.then(result=>{throw Error('Restart failed: '+JSON.stringify(result)+' '+stderr);}),new Promise((resolve,reject)=>{startDeadline=setTimeout(()=>reject(Error('Synthetic restart did not become ready')),10000);})]);clearTimeout(startDeadline);
    const response=await request({url:'http://127.0.0.1:'+ready.port});assert.equal(response.status,200,JSON.stringify(response.payload));assert.deepEqual(response.payload.sidebarNotepad,expected);
  }finally{clearTimeout(startDeadline);if(child.connected)child.send('stop');const timer=setTimeout(()=>child.kill(),5000);try{const result=await exited;assert.equal(result.code,0,stderr);}finally{clearTimeout(timer);}}
});
