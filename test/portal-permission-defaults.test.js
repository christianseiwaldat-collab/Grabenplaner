"use strict";
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path'), crypto=require('node:crypto');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'gp-permission-defaults-'));
Object.assign(process.env,{DB_PATH:path.join(root,'test.db'),BACKUP_DIR:path.join(root,'backups'),GRABENPLANER_DATA_DIR:path.join(root,'data'),GRABENPLANER_FORCE_PORTAL:'1',GRABENPLANER_SEED_DEMO:'1',GRABENPLANER_TEST_AMU_SCANNER:'clean',NODE_ENV:'test'});
const subject=require('../server'),{app,db}=subject;
let server,url;
function session(number) {
 const token=crypto.randomBytes(32).toString('hex'),csrf=crypto.randomBytes(24).toString('hex'),id=crypto.randomUUID();
 db.prepare("INSERT INTO portal_sessions(id,employee_number,token_hash,expires_at) VALUES (?,?,?,'2099-01-01T00:00:00.000Z')").run(id,number,crypto.createHash('sha256').update(token).digest('hex'));
 return {id,cookie:`grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`,csrf};
}
async function request(route,actor,body) {
 const response=await fetch(url+route,{method:body?'PUT':'GET',headers:{Cookie:actor.cookie,'X-CSRF-Token':actor.csrf,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const data=await response.json(); return {status:response.status,data};
}
async function principal(actor) { return subject.loadPortalSessionFromRequest({headers:{cookie:actor.cookie}},{touch:false}); }
async function mobilePrincipal(number) {
 const id=crypto.randomUUID(), hash=value=>crypto.createHash('sha256').update(value).digest('hex');
 db.prepare(`INSERT INTO mobile_sessions (id,employee_number,access_token_hash,access_expires_at,refresh_token_hash,refresh_expires_at,installation_id_hash,platform,device_label,app_version)
 VALUES (?,?,?,'2099-01-01T00:00:00.000Z',?,'2099-01-01T00:00:00.000Z',?,'android','Synthetic rights test','0.4.0')`).run(id,number,hash(id+'a'),hash(id+'r'),hash(id+'i'));
 return subject.mobileSessionPrincipal(await subject.mobileSessionRow(id));
}
test('Developer rights, role/position defaults and persistence use the real authenticated routes',async t=>{
 const location=db.prepare('SELECT id FROM locations WHERE active=1 LIMIT 1').get().id;
 const department=Number(db.prepare("INSERT INTO departments(location_id,name,active) VALUES (?,'Testabteilung',1)").run(location).lastInsertRowid);
 for(const [number,role] of [['defaults-dev','developer'],['defaults-admin','admin'],['defaults-ma','employee'],['defaults-al','department_manager'],['998812','employee']]) {
  db.prepare("INSERT INTO employees(personnel_number,full_name,nickname,home_location_id,preferred_department_id,position_id,active) VALUES (?,?,?, ?,?,'verkaufsmitarbeiter',1)").run(number,number,number,location,department);
  db.prepare("INSERT INTO portal_users(employee_number,password_hash,role,active,must_change_password,password_changed_at) VALUES (?,'test',?,1,0,CURRENT_TIMESTAMP)").run(number,role);
 }
 server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));url='http://127.0.0.1:'+server.address().port;
 const developer=session('defaults-dev'),admin=session('defaults-admin');
 try {
  await t.test('all known rights are editable for MA and AL; Developer stays protected',async()=>{
   const response=await request('/api/portal/v1/rights',developer);assert.equal(response.status,200);
   assert(response.data.catalog.some(p=>p.id==='own_schedule:read'&&p.editable));
   assert(response.data.catalog.every(p=>p.editable));
   for(const number of ['defaults-ma','defaults-al']) {
    // Use the actual permission names published by the catalog.
    const articleAccess=response.data.catalog.find(p=>p.label==='Artikelstamm öffnen').id;
    const articleRead=response.data.catalog.find(p=>p.label==='Artikelstamm lesen').id;
    const result=await request('/api/portal/v1/rights/'+number,developer,{grantedPermissions:[articleAccess,articleRead],deniedPermissions:['own_schedule:read']});
    assert.equal(result.status,200,JSON.stringify(result.data));
    const live=await principal(session(number));assert(live.permissions.includes(articleRead));assert(!live.permissions.includes('own_schedule:read'));
    const articles=await request('/api/sales/articles',session(number));assert.equal(articles.status,200,JSON.stringify(articles.data));
    assert.equal((await request('/api/portal/v1/rights/'+number,developer,{grantedPermissions:[],deniedPermissions:[]})).status,200);
    assert(!(await principal(session(number))).permissions.includes(articleRead));
    const complete=await request('/api/portal/v1/rights/'+number,developer,{grantedPermissions:response.data.catalog.map(p=>p.id),deniedPermissions:[],scopes:[{locationId:location,departmentId:department}]});
    assert.equal(complete.status,200,JSON.stringify(complete.data));
    assert.equal((await request('/api/portal/v1/rights/'+number,developer,{grantedPermissions:[],deniedPermissions:[],scopes:[{locationId:location,departmentId:null}]})).status,200);
   }
   assert.equal((await request('/api/portal/v1/rights/defaults/role/developer',developer,{permissions:[],revision:1})).status,403);
  });
  await t.test('other actors cannot change defaults or use Developer-only permission grants',async()=>{
   assert.equal((await request('/api/portal/v1/rights/defaults',admin)).status,403);
   assert.equal((await request('/api/portal/v1/rights/defaults/role/employee',admin,{permissions:[],revision:1})).status,403);
   assert.equal((await request('/api/portal/v1/rights/defaults',developer)).status,200);
   assert.equal((await request('/api/portal/v1/rights/defaults/role/employee',developer,{permissions:['invented:permission'],revision:1})).status,400);
   assert.equal((await request('/api/portal/v1/rights/defaults/role/employee',{...developer,csrf:'wrong'},{permissions:[],revision:1})).status,403);
  });
  await t.test('role defaults change existing access, retain individual overrides and reject stale updates',async()=>{
   let entry=(await request('/api/portal/v1/rights/defaults',developer)).data.entries.find(e=>e.kind==='role'&&e.id==='employee');
   const oldSession=session('defaults-ma');
   db.prepare("INSERT INTO portal_permission_denials(employee_number,permission,denied_by) VALUES ('defaults-ma','own_schedule:read','defaults-dev')").run();
   db.prepare("INSERT INTO portal_permission_grants(employee_number,permission,granted_by) VALUES ('defaults-ma','personnel:phone:read','defaults-dev')").run();
   const permissions=entry.permissions.filter(p=>p!=='own_schedule:read');
   const result=await request('/api/portal/v1/rights/defaults/role/employee',developer,{permissions,revision:entry.revision});
   assert.equal(result.status,200,JSON.stringify(result.data));
   assert.equal(await principal(oldSession),null);
   assert(!(await principal(session('defaults-ma'))).permissions.includes('own_schedule:read'));
   assert((await principal(session('defaults-ma'))).permissions.includes('personnel:phone:read'));
   assert.equal((await request('/api/portal/v1/rights/defaults/role/employee',developer,{permissions:[],revision:entry.revision})).status,409);
   const current=result.data.entries.find(e=>e.kind==='role'&&e.id==='employee');
   assert.equal((await request('/api/portal/v1/rights/defaults/role/employee',developer,{reset:true,revision:current.revision})).status,200);
   assert(!(await principal(session('defaults-ma'))).permissions.includes('own_schedule:read'));
   assert.equal((await request('/api/portal/v1/rights/defaults/role/employee',developer,{permissions:[],revision:current.revision})).status,409);
   assert.equal((await request('/api/portal/v1/rights/defaults/position/missing-position',developer,{permissions:[],revision:0})).status,404);
   assert.equal((await request('/api/portal/v1/rights/defaults/role/employee',developer,{permissions:['sales:articles:read'],revision:current.revision+1})).status,400);
   assert.equal((await request('/api/portal/v1/rights/defaults/role/employee',developer,{permissions:['own_schedule:read','own_schedule:read'],revision:current.revision+1})).status,400);
   assert.equal((await request('/api/portal/v1/rights/defaults/position/verkaufsmitarbeiter',developer,{permissions:['sales:articles:read'],revision:0})).status,400);
   assert.equal((await request('/api/portal/v1/rights/defaults',developer)).data.entries.find(e=>e.id==='verkaufsmitarbeiter'&&e.kind==='position').revision,0);
   assert.equal((await request('/api/portal/v1/rights/defaults',developer)).data.entries.find(e=>e.id==='employee'&&e.kind==='role').customized,false);
   assert.equal((await request('/api/portal/v1/rights/defaults-ma',developer,{grantedPermissions:[],deniedPermissions:[]})).status,200);
  });
  await t.test('position overrides apply to both roles but never reduce Developer permissions',async()=>{
   const entry=(await request('/api/portal/v1/rights/defaults',developer)).data.entries.find(e=>e.kind==='position'&&e.id==='verkaufsmitarbeiter');
   const before=(await principal(developer)).permissions;
   const result=await request('/api/portal/v1/rights/defaults/position/verkaufsmitarbeiter',developer,{permissions:['own_schedule:read'],revision:entry.revision});
   assert.equal(result.status,200,JSON.stringify(result.data));
   for(const number of ['defaults-ma','defaults-al']) {
    assert.deepEqual((await principal(session(number))).permissions,['own_schedule:read']);
    assert.deepEqual((await mobilePrincipal(number)).permissions,['own_schedule:read']);
   }
   assert.deepEqual((await principal(developer)).permissions,before);
   const current=result.data.entries.find(e=>e.kind==='position'&&e.id===entry.id);
   assert.equal((await request('/api/portal/v1/rights/defaults/position/'+entry.id,developer,{reset:true,revision:current.revision})).status,200);
   assert((await principal(session('defaults-al'))).permissions.includes('schedule:write'));
  });
  await t.test('personnel edits use position standards and preserve explicit grants and denials',async()=>{
   const entry=(await request('/api/portal/v1/rights/defaults',developer)).data.entries.find(e=>e.kind==='position'&&e.id==='verkaufsmitarbeiter');
   assert.equal((await request('/api/portal/v1/rights/998812',developer,{grantedPermissions:['personnel:phone:read'],deniedPermissions:['own_schedule:read']})).status,200);
   const changed=await request('/api/portal/v1/rights/defaults/position/'+entry.id,developer,{permissions:['own_schedule:read','personnel:phone:read'],revision:entry.revision});
   assert.equal(changed.status,200,JSON.stringify(changed.data));
   const roles=(await request('/api/portal/v1/roles',developer)).data;
   assert.deepEqual(roles.positionDefaults.find(p=>p.id===entry.id).permissions,['own_schedule:read','personnel:phone:read']);
   assert(roles.catalog.some(p=>p.id==='own_schedule:read'));
   const adminRoles=await request('/api/portal/v1/roles',session('defaults-admin'));
   assert.equal(adminRoles.status,403); // The position standard revoked the admin's role-reading right too.
   const saved=await request('/api/employees/998812',developer,{
    personnelNumber:'998812',fullName:'Synthetic Personnel Test',nickname:'Synthetic',contractedHours:38.5,
    positionId:entry.id,homeLocationId:location,preferredDepartmentId:department,preferredDayOff:'',fixedWorkdays:[],color:'#2c7a68',active:true,
    accessProfile:{role:'employee',permissions:['personnel:phone:read']},
   });
   assert.equal(saved.status,200,JSON.stringify(saved.data));
   assert.deepEqual(saved.data.portal_access.rolePermissions,['own_schedule:read','personnel:phone:read']);
   assert.deepEqual(saved.data.portal_access.deniedPermissions,['own_schedule:read']);
   assert.deepEqual(saved.data.portal_access.grantedPermissions,['personnel:phone:read']);
   assert.deepEqual((await principal(session('998812'))).permissions,['personnel:phone:read']);
   const current=changed.data.entries.find(e=>e.kind==='position'&&e.id===entry.id);
   assert.equal((await request('/api/portal/v1/rights/defaults/position/'+entry.id,developer,{reset:true,revision:current.revision})).status,200);
   const restored=await principal(session('998812'));
   assert(restored.permissions.includes('personnel:phone:read'));
   assert(!restored.permissions.includes('own_schedule:read'));
   assert.equal((await request('/api/portal/v1/rights/998812',developer,{grantedPermissions:[],deniedPermissions:[]})).status,200);
  });
  await t.test('all built-in role standards can be restored',async()=>{
   const entries=(await request('/api/portal/v1/rights/defaults',developer)).data.entries;
   for(const entry of entries.filter(e=>e.kind==='role'&&!e.protected)) {
    const result=await request('/api/portal/v1/rights/defaults/role/'+entry.id,developer,{reset:true,revision:entry.revision});
    assert.equal(result.status,200,entry.id+': '+JSON.stringify(result.data));
   }
  });
  await t.test('existing assignment guards migrate without replacing unrelated definitions or data',()=>{
   const definitions=[...require('../lib/persistence/sqlite/operations/personnel-lifecycle-offboarding-schema').PERSONNEL_LIFECYCLE_OFFBOARDING_TRIGGER_DEFINITIONS,
    ...require('../lib/persistence/sqlite/operations/personnel-workflow-instance-schema').PERSONNEL_WORKFLOW_INSTANCE_TRIGGER_DEFINITIONS].filter(d=>d.sql.includes('JOIN portal_user_roles portal_role'));
   assert.equal(definitions.length,2);
   const before=db.prepare('SELECT count(*) AS n FROM employees').get().n;
   for(const definition of definitions) {
    db.exec(`DROP TRIGGER "${definition.name}"`);
    db.exec(definition.sql.replace(/JOIN portal_user_roles portal_role\s+ON portal_role\.employee_number = portal_user\.employee_number/g,'JOIN portal_roles portal_role ON portal_role.id = portal_user.role'));
   }
   const migrate=require('../lib/persistence/sqlite/operations/portal-permission-defaults-schema').ensureSqlitePortalPermissionDefaultsSchema;
   migrate(db); migrate(db);
   for(const definition of definitions) assert(db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(definition.name).sql.includes('JOIN portal_user_roles portal_role'));
   assert.equal(db.prepare('SELECT count(*) AS n FROM employees').get().n,before);
   const definition=definitions[0];db.exec(`DROP TRIGGER "${definition.name}"`);
   db.exec(definition.sql.replace('BEFORE INSERT','/* unrelated drift */ BEFORE INSERT'));
   migrate(db);
   assert(db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(definition.name).sql.includes('unrelated drift'));
   db.exec(`DROP TRIGGER "${definition.name}"`);db.exec(definition.sql);
  });
  await t.test('built-in seeding preserves customized rights and Developer grants',async()=>{
   const seeding=require('../lib/persistence/sqlite/operations/application-seeding').createSqliteApplicationSeedingOperations(db);
   const rows=db.prepare('SELECT id,name,description,permissions,sort_order FROM portal_roles').all();
   db.prepare("UPDATE portal_roles SET permissions='[]',permissions_customized=1 WHERE id='employee'").run();
   db.prepare("INSERT INTO portal_permission_grants(employee_number,permission,granted_by) VALUES ('defaults-ma','amu:file:read','defaults-dev')").run();
   seeding.seedApplicationDefaults({defaultSettings:{},planningDays:[],builtinPortalRoles:rows.map(r=>({...r,permissions:JSON.parse(r.permissions),sortOrder:r.sort_order}))});
   assert.equal(db.prepare("SELECT permissions FROM portal_roles WHERE id='employee'").get().permissions,'[]');
   assert(db.prepare("SELECT 1 FROM portal_permission_grants WHERE employee_number='defaults-ma' AND permission='amu:file:read'").get());
  });
 } finally {await new Promise(resolve=>server.close(resolve));await subject.closePersistenceForTests();}
});
