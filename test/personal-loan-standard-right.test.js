"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-personal-loan-right-"));
Object.assign(process.env, {
  DB_PATH:path.join(root,"test.db"), BACKUP_DIR:path.join(root,"backups"),
  GRABENPLANER_DATA_DIR:path.join(root,"data"), GRABENPLANER_HOST:"127.0.0.1",
  GRABENPLANER_FORCE_PORTAL:"1", GRABENPLANER_SEED_DEMO:"1", NODE_ENV:"test", TZ:"Europe/Vienna",
});
const subject = require("../server");
const { app, db } = subject;
const USE = "loans:self:use";
let server, base, local;
const roleByNumber = { "loan-ma":"employee", "loan-other":"employee", "loan-fl":"manager", "loan-al":"department_manager", "loan-hr":"hr" };
function auth(number) {
  const token = crypto.randomBytes(32).toString("hex"), csrf = crypto.randomBytes(24).toString("hex"), id=crypto.randomUUID();
  db.prepare("INSERT INTO portal_sessions (id,employee_number,token_hash,expires_at) VALUES (?,?,?,'2099-01-01T00:00:00.000Z')")
    .run(id,number,crypto.createHash("sha256").update(token).digest("hex"));
  return {id,csrf,cookie:`grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`};
}
async function request(route, session, method="GET", body) {
  const response = await fetch(base+route,{method,headers:{Cookie:session.cookie,Accept:"application/json",...(method!=="GET"?{"Content-Type":"application/json","X-CSRF-Token":session.csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,body:await response.json()};
}
test.before(async()=>{
  local = db.prepare("SELECT id FROM locations WHERE active=1 ORDER BY id LIMIT 1").get().id;
  db.prepare("INSERT INTO locations (id,name,min_staff,day_settings_json,active) VALUES ('87','Andere Testfiliale',1,'{}',1)").run();
  for (const [number,role] of Object.entries(roleByNumber)) {
    db.prepare("INSERT INTO employees (personnel_number,full_name,nickname,home_location_id,active) VALUES (?,?,?,?,1)").run(number,`Test ${number}`,number,number==="loan-other"?"87":local);
    db.prepare("INSERT INTO portal_users (employee_number,password_hash,role,active,must_change_password,password_changed_at) VALUES (?,'test-only',?,1,0,CURRENT_TIMESTAMP)").run(number,role);
  }
  db.prepare("INSERT INTO portal_access_scopes (employee_number,location_id,department_id,assigned_by) VALUES ('loan-fl',?,0,'loan-hr')").run(local);
  db.prepare("INSERT INTO loan_location_settings (location_id,enabled) VALUES (?,1)").run(local);
  server=app.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));base=`http://127.0.0.1:${server.address().port}`;
});
test.after(async()=>{
  if(server)await new Promise(resolve=>server.close(resolve));db.close();subject.releaseInstanceLockForTests();
  const resolvedRoot=path.resolve(root),expectedParent=path.resolve(os.tmpdir());
  assert.equal(path.dirname(resolvedRoot),expectedParent);assert.ok(path.basename(resolvedRoot).startsWith("gp-personal-loan-right-"));
  fs.rmSync(resolvedRoot,{recursive:true,force:true,maxRetries:8,retryDelay:100});
});
test("Persönliche Leihe ist ein Standardrecht, Filialkonten bleiben getrennt",async()=>{
  const roles=await subject.getPortalRoles();
  for(const role of roles.filter(r=>["employee","department_manager","manager","hr","admin","it_admin","developer"].includes(r.id)))assert.ok(role.permissions.includes(USE),role.id);
  assert.equal(roles.find(r=>r.id==="location_planner").permissions.includes(USE),false);
  const status=await request("/api/portal/v1/loans/status",auth("loan-ma"));
  assert.equal(status.status,200);assert.equal(status.body.available,true);
  for(const right of ["ownRead","ownCreate","ownReturn","overviewRead"])assert.equal(status.body.permissions[right],true,right);
  assert.equal(status.body.permissions.locationManage,false);
});
test("FL sieht für normale Mitarbeitende ausschließlich das Leihrecht der eigenen Filiale",async()=>{
  const overview=await request("/api/portal/v1/rights",auth("loan-fl"));
  assert.equal(overview.status,200);
  const employee=overview.body.users.find(u=>u.employeeNumber==="loan-ma");assert.ok(employee);
  assert.deepEqual(employee.rolePermissions,[USE]);assert.deepEqual(employee.grantedPermissions,[]);
  assert.equal(employee.manageable,true);assert.equal(Object.hasOwn(employee,"passwordConfigured"),false);
  assert.equal(overview.body.users.some(u=>u.employeeNumber==="loan-other"),false);
  assert.ok(overview.body.catalog.some(p=>p.id===USE&&p.editable));
});
test("Entzug sperrt alle persönlichen Leihpfade, widerruft Sitzungen und wird auditiert",async()=>{
  const old=auth("loan-ma"),manager=auth("loan-fl");
  const denied=await request("/api/portal/v1/rights/loan-ma",manager,"PUT",{grantedPermissions:[],deniedPermissions:[USE]});
  assert.equal(denied.status,200,JSON.stringify(denied.body));
  assert.ok(db.prepare("SELECT revoked_at FROM portal_sessions WHERE id=?").get(old.id).revoked_at);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE entity_id='loan-ma' AND action='portal.rights.update'").get().n,1);
  const employee=auth("loan-ma");
  const status=await request("/api/portal/v1/loans/status",employee);assert.equal(status.status,200);
  for(const right of ["ownRead","ownCreate","ownReturn","overviewRead"])assert.equal(status.body.permissions[right],false,right);
  for(const route of ["/api/portal/v1/loans", "/api/portal/v1/loans/open-overview"]){
    const response=await request(route,employee);assert.equal(response.status,403,`${route}: ${JSON.stringify(response.body)}`);
  }
  for(const route of ["/api/portal/v1/loans","/api/portal/v1/loans/not-a-loan/return"]){
    const response=await request(route,employee,"POST",{});assert.equal(response.status,403,`${route}: ${JSON.stringify(response.body)}`);
  }
});
test("Wiederherstellung erhält Zusatzrechte und gibt keine fremden oder anderen Rechte frei",async()=>{
  const manager=auth("loan-fl");
  for(const [target,body] of [
    ["loan-other",{grantedPermissions:[],deniedPermissions:[USE]}],
    ["loan-ma",{grantedPermissions:[USE],deniedPermissions:[]}],
    ["loan-ma",{grantedPermissions:[],deniedPermissions:["time:review"]}],
    ["loan-ma",{grantedPermissions:[],deniedPermissions:[],scopes:[{locationId:"87",departmentId:null}]}],
  ]){
    const response=await request(`/api/portal/v1/rights/${target}`,manager,"PUT",body);assert.equal(response.status,403,JSON.stringify(response.body));
  }
  db.prepare("INSERT INTO portal_permission_grants (employee_number,permission,granted_by) VALUES ('loan-ma','branch_orders:submit','loan-hr')").run();
  const restored=await request("/api/portal/v1/rights/loan-ma",manager,"PUT",{grantedPermissions:[],deniedPermissions:[]});
  assert.equal(restored.status,200,JSON.stringify(restored.body));
  assert.ok(db.prepare("SELECT permission FROM portal_permission_grants WHERE employee_number='loan-ma' AND permission='branch_orders:submit'").get());
  const status=await request("/api/portal/v1/loans/status",auth("loan-ma"));assert.equal(status.body.permissions.ownCreate,true);
});
test("AL kann keine Leihrechte anderer ändern; PL kann das Standardrecht entziehen",async()=>{
  const denied=await request("/api/portal/v1/rights/loan-ma",auth("loan-al"),"PUT",{grantedPermissions:[],deniedPermissions:[USE]});
  assert.equal(denied.status,403);
  const hr=await request("/api/portal/v1/rights/loan-ma",auth("loan-hr"),"PUT",{grantedPermissions:[],deniedPermissions:[USE]});
  assert.equal(hr.status,200,JSON.stringify(hr.body));
  const projected=subject.effectivePortalPermissionState("loan-ma","employee",[USE,"loans:self:read","loans:self:create","loans:self:return","loans:overview:read"],[USE],[USE]);
  assert.deepEqual(projected.effectivePermissions,[]);
});

test("FL behält die scoped Rechteverwaltung auch bei entzogenem eigenen Leihrecht",async()=>{
  const denied=await request("/api/portal/v1/rights/loan-fl",auth("loan-hr"),"PUT",{grantedPermissions:[],deniedPermissions:[USE]});
  assert.equal(denied.status,200,JSON.stringify(denied.body));
  const manager=auth("loan-fl"),status=await request("/api/portal/v1/loans/status",manager);
  assert.equal(status.body.permissions.ownCreate,false);
  const restored=await request("/api/portal/v1/rights/loan-ma",manager,"PUT",{grantedPermissions:[],deniedPermissions:[]});
  assert.equal(restored.status,200,JSON.stringify(restored.body));
  const outside=await request("/api/portal/v1/rights/loan-other",manager,"PUT",{grantedPermissions:[],deniedPermissions:[USE]});
  assert.equal(outside.status,403);
});
