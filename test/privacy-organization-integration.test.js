"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-privacy-organization-"));
Object.assign(process.env, {
  DB_PATH: path.join(root, "synthetic.db"), BACKUP_DIR: path.join(root, "backups"),
  GRABENPLANER_DATA_DIR: path.join(root, "data"), GRABENPLANER_HOST: "127.0.0.1",
  GRABENPLANER_FORCE_PORTAL: "1", GRABENPLANER_SEED_DEMO: "1", NODE_ENV: "test", TZ: "Europe/Vienna",
  GRABENPLANER_PRIVACY_ORGANIZATION_SEED: JSON.stringify({dpoName: "PRIVATE-SYNTHETIC-DPO", worksCouncil: "absent"}),
});
const {app, db, initializeApplicationPersistence, releaseInstanceLockForTests} = require("../server");
const {PRIVACY_ORGANIZATION_SETTING_KEY: KEY} = require("../lib/privacy-organization-settings");
let server, url, locationId, activityId, approvedActivitySha;
const users = {};
async function request(route = "/api/privacy-organization", {method = "GET", body, auth = users.author, csrf = true} = {}) {
  const headers = {Accept: "application/json"};
  if (auth) headers.Cookie = auth.cookie;
  if (auth && method !== "GET" && csrf) headers["X-CSRF-Token"] = auth.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url + route, {method, headers, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  return {status: response.status, headers: response.headers, payload: await response.json()};
}
async function command(input, options = {}) {
  const current = await request(); assert.equal(current.status, 200, JSON.stringify(current.payload));
  return request("/api/privacy-organization/commands", {method: "POST", body: {...input, expectedRevision: current.payload.revision}, ...options});
}
async function okCommand(input, options) {
  const result = await command(input, options); assert.ok([200,201].includes(result.status), JSON.stringify(result)); return result.payload;
}
async function approve(id) {
  await okCommand({action: "submit", id});
  return okCommand({action: "approve", id, decision: {reason: "Synthetic independent review", evidenceReference: "SYNTHETIC-REVIEW"}}, {auth: users.reviewer});
}
function absentPrivate(value) {
  const serialized = JSON.stringify(value);
  for (const marker of [KEY, "PRIVATE-SYNTHETIC-DPO", "PRIVATE-SYNTHETIC-PROCESS", "SYNTHETIC-NOTIFICATION-RECEIPT"]) assert.ok(!serialized.includes(marker), marker);
}
test.before(async () => {
  await initializeApplicationPersistence();
  const location = db.prepare("SELECT id,cost_center_id FROM locations WHERE active=1 ORDER BY id LIMIT 1").get(); locationId = location.id;
  for (const [key,role] of Object.entries({author:"hr", reviewer:"admin", manager:"manager", developer:"developer", itAdmin:"it_admin"})) {
    const id = `privacy-synthetic-${key}`, token = crypto.randomBytes(32).toString("hex"), csrf = crypto.randomBytes(24).toString("hex");
    db.prepare("INSERT INTO employees(personnel_number,full_name,nickname,color,contracted_hours,target_workdays_per_week,home_location_id,cost_center_id,active) VALUES (?,?,?,'#25705d',38.5,5,?,?,1)").run(id,id,id,locationId,location.cost_center_id);
    db.prepare("INSERT INTO portal_users(employee_number,password_hash,role,active,must_change_password,password_changed_at) VALUES (?,'synthetic',?,1,0,CURRENT_TIMESTAMP)").run(id,role);
    db.prepare("INSERT INTO portal_sessions(id,employee_number,token_hash,expires_at) VALUES (?,?,?,'2099-12-31T23:59:59.000Z')").run(crypto.randomUUID(),id,crypto.createHash("sha256").update(token).digest("hex"));
    db.prepare("INSERT INTO portal_access_scopes(employee_number,location_id,assigned_by) VALUES (?,?,'synthetic')").run(id,locationId);
    if (role !== "developer") for (const permission of ["privacy_organization:read","privacy_organization:manage","privacy_organization:approve"]) db.prepare("INSERT OR IGNORE INTO portal_permission_grants(employee_number,permission,granted_by) VALUES (?,?,'synthetic')").run(id,permission);
    users[key] = {id,cookie:`grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`,csrf};
  }
  server = app.listen(0,"127.0.0.1"); await new Promise(resolve => server.once("listening",resolve)); url = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  try {db.close();} catch {} releaseInstanceLockForTests();
  fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
});
test("read prepares known facts without writing or creating a DPO account", async () => {
  assert.equal(db.prepare("SELECT value FROM settings WHERE key=?").get(KEY), undefined);
  const result = await request(); assert.equal(result.status,200,JSON.stringify(result.payload));
  assert.equal(result.headers.get("cache-control"),"no-store");
  assert.equal(result.payload.organization.payload.dpoName,"PRIVATE-SYNTHETIC-DPO");
  assert.equal(result.payload.organization.payload.dpoEmployeeNumber,"");
  assert.equal(result.payload.organization.payload.worksCouncil,"absent");
  assert.equal(result.payload.summary.releaseReady,false);
  assert.equal(result.payload.catalog.activityTemplates.length,12);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key=?").get(KEY),undefined);
  assert.equal(db.prepare("SELECT count(*) n FROM portal_users WHERE employee_number='PRIVATE-SYNTHETIC-DPO'").get().n,0);
});
test("real personal HR/Admin/Developer access excludes anonymous, planner and IT-admin roles even with grants", async () => {
  assert.equal((await request(undefined,{auth:null})).status,401);
  for (const auth of [users.manager,users.itAdmin]) {
    assert.equal((await request(undefined,{auth})).status,403);
    assert.equal((await command({action:"create",kind:"breach",payload:{title:"Denied"}},{auth})).status,403);
  }
  assert.equal((await command({action:"update",id:"organization",payload:{notes:"Denied csrf"}},{csrf:false})).status,403);
  const session = await request("/api/portal/v1/session");
  assert.equal(session.payload.user.sessionKind,"employee"); assert.equal(session.payload.user.isEmployee,true);
  assert.equal(session.payload.user.accountType,"employee");
});
test("protected personal developer receives all privacy capabilities without individual grants", async () => {
  assert.equal(db.prepare("SELECT count(*) n FROM portal_permission_grants WHERE employee_number=?").get(users.developer.id).n,0);
  const session = await request("/api/portal/v1/session",{auth:users.developer});
  assert.equal(session.status,200);
  assert.equal(session.payload.user.role,"developer");
  assert.equal(session.payload.user.sessionKind,"employee");
  assert.equal(session.payload.user.isEmployee,true);
  assert.equal(session.payload.user.accountType,"employee");
  for (const permission of ["privacy_organization:read","privacy_organization:manage","privacy_organization:approve"]) assert.ok(session.payload.user.permissions.includes(permission));
  const result = await request(undefined,{auth:users.developer});
  assert.equal(result.status,200,JSON.stringify(result.payload));
  assert.deepEqual(result.payload.capabilities,{read:true,manage:true,approve:true});
  assert.equal(result.headers.get("cache-control"),"no-store");
  assert.equal(db.prepare("SELECT value FROM settings WHERE key=?").get(KEY),undefined);
});
test("personal developer still requires CSRF and a changed initial password", async () => {
  const before = (await request(undefined,{auth:users.developer})).payload.revision;
  const missingCsrf = await request("/api/privacy-organization/commands",{method:"POST",auth:users.developer,csrf:false,body:{action:"create",kind:"activity",payload:{title:"Denied csrf"},expectedRevision:before}});
  assert.equal(missingCsrf.status,403);
  db.prepare("UPDATE portal_users SET must_change_password=1 WHERE employee_number=?").run(users.developer.id);
  try {
    for (const result of [await request(undefined,{auth:users.developer}),await request("/api/privacy-organization/commands",{method:"POST",auth:users.developer,body:{action:"create",kind:"activity",payload:{title:"Denied initial password"},expectedRevision:before}})]) {
      assert.equal(result.status,428); assert.equal(result.payload.code,"PORTAL_PASSWORD_CHANGE_REQUIRED");
    }
  } finally {db.prepare("UPDATE portal_users SET must_change_password=0 WHERE employee_number=?").run(users.developer.id);}
  assert.equal((await request(undefined,{auth:users.developer})).payload.revision,before);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key=?").get(KEY),undefined);
});
test("live permission denial overrides role defaults and grants", async () => {
  for(const permission of ["privacy_organization:manage","privacy_organization:read"]) {
    db.prepare("INSERT INTO portal_permission_denials(employee_number,permission,denied_by) VALUES (?,?,'synthetic')").run(users.author.id,permission);
    try {
      const read = await request(); assert.equal(read.status,permission.endsWith(":read")?403:200);
      const revision = read.status===200 ? read.payload.revision : 0;
      assert.equal((await request("/api/privacy-organization/commands",{method:"POST",body:{action:"create",kind:"activity",expectedRevision:revision,payload:{title:"Denied"}}})).status,403);
    } finally {db.prepare("DELETE FROM portal_permission_denials WHERE employee_number=? AND permission=?").run(users.author.id,permission);}
  }
});
test("named account references need a real active personal GP principal", async () => {
  const result = await command({action:"update",id:"organization",payload:{dpoEmployeeNumber:"synthetic-not-existing"}});
  assert.equal(result.status,409); assert.equal(result.payload.code,"PRIVACY_ORGANIZATION_PERSONAL_REFERENCE_INVALID");
  assert.equal(db.prepare("SELECT value FROM settings WHERE key=?").get(KEY),undefined);
});
test("independent organizational review persists encrypted snapshots and disallows self approval", async () => {
  await okCommand({action:"update",id:"organization",payload:{controllerName:"Synthetic entity",controllerContact:"Synthetic contact",controllerRole:"controller",dpoContact:"Synthetic DPO contact",privacyOwnerEmployeeNumber:users.author.id,responseContact:"Synthetic urgent contact",reviewOn:"2027-12-31"}});
  await okCommand({action:"submit",id:"organization"});
  assert.equal((await command({action:"approve",id:"organization",decision:{reason:"Self review"}})).status,403);
  const result = await okCommand({action:"approve",id:"organization",decision:{reason:"Synthetic independent review"}},{auth:users.reviewer});
  assert.equal(result.organization.status,"approved"); assert.equal(result.organization.approvedBy,users.reviewer.id);
  const stored = db.prepare("SELECT value FROM settings WHERE key=?").get(KEY).value;
  assert.match(stored,/^enc:v2:/); absentPrivate(stored);
  assert.equal(result.organization.history.length,4);
});
test("developer can author and independently review VVT without bypassing self approval", async () => {
  const payload = {title:"Synthetic developer VVT",ownerEmployeeNumber:users.developer.id,purpose:"Synthetic purpose",systemScope:"Isolated synthetic system",dataSubjects:"Employee categories",dataCategories:"Account identifiers",recipients:"None in test",processors:"None in test",storageLocations:"Test directory",transfers:"none",retention:"Synthetic retention rationale",toms:"Synthetic rights",legalBasis:"Synthetic legal review",specialCategories:"no",reviewOn:"2027-12-31"};
  const created = await okCommand({action:"create",kind:"activity",payload},{auth:users.developer});
  const id = created.records.find(record => record.payload.title===payload.title).id;
  await okCommand({action:"update",id,payload:{purpose:"Synthetic developer edit"}},{auth:users.developer});
  await okCommand({action:"submit",id},{auth:users.developer});
  const self = await command({action:"approve",id,decision:{reason:"Self review"}},{auth:users.developer});
  assert.equal(self.status,403); assert.equal(self.payload.code,"SELF_APPROVAL");
  const approved = await okCommand({action:"approve",id,decision:{reason:"Synthetic independent admin review"}},{auth:users.reviewer});
  assert.equal(approved.records.find(record=>record.id===id).approvedBy,users.reviewer.id);
  const hrCreated = await okCommand({action:"create",kind:"activity",payload:{...payload,title:"Synthetic HR VVT",ownerEmployeeNumber:users.author.id}});
  const hrId = hrCreated.records.find(record=>record.payload.title==="Synthetic HR VVT").id;
  await okCommand({action:"submit",id:hrId});
  const developerApproved = await okCommand({action:"approve",id:hrId,decision:{reason:"Synthetic independent developer review"}},{auth:users.developer});
  assert.equal(developerApproved.records.find(record=>record.id===hrId).approvedBy,users.developer.id);
  assert.match(db.prepare("SELECT value FROM settings WHERE key=?").get(KEY).value,/^enc:v2:/);
  assert.equal(db.prepare("SELECT count(*) n FROM portal_permission_grants WHERE employee_number=?").get(users.developer.id).n,0);
});
test("a developer session loses privacy authority after the live account is deactivated", async () => {
  const before = (await request()).payload.revision;
  db.prepare("UPDATE portal_users SET active=0 WHERE employee_number=?").run(users.developer.id);
  try {
    assert.equal((await request(undefined,{auth:users.developer})).status,401);
    assert.equal((await request("/api/privacy-organization/commands",{method:"POST",auth:users.developer,body:{action:"create",kind:"activity",payload:{title:"Inactive developer"},expectedRevision:before}})).status,401);
  } finally {db.prepare("UPDATE portal_users SET active=1 WHERE employee_number=?").run(users.developer.id);}
  assert.equal((await request()).payload.revision,before);
});
test("a stale tab cannot replace a newer encrypted ledger", async () => {
  const before = await request(); await okCommand({action:"create",kind:"activity",payload:{title:"Synthetic draft"}});
  const stale = await request("/api/privacy-organization/commands",{method:"POST",body:{action:"create",kind:"activity",payload:{title:"Stale write"},expectedRevision:before.payload.revision}});
  assert.equal(stale.status,409); assert.equal((await request()).payload.revision,before.payload.revision+1);
});
test("approved VVT basis is linked exactly and a later edit makes its DSFA obsolete", async () => {
  const created = await okCommand({action:"create",kind:"activity",payload:{title:"PRIVATE-SYNTHETIC-PROCESS",ownerEmployeeNumber:users.author.id,purpose:"Synthetic purpose",systemScope:"Isolated synthetic system",dataSubjects:"Employee categories",dataCategories:"Account identifiers",recipients:"None in test",processors:"None in test",storageLocations:"Test directory",transfers:"none",retention:"Synthetic retention rationale",toms:"Synthetic rights",legalBasis:"Synthetic legal review",specialCategories:"no",reviewOn:"2027-12-31"}});
  activityId = created.records.find(r => r.payload.title === "PRIVATE-SYNTHETIC-PROCESS").id;
  const approved = await approve(activityId); approvedActivitySha = approved.records.find(r => r.id===activityId).contentSha256;
  const dsfa = await okCommand({action:"create",kind:"dpia",payload:{title:"Synthetic DSFA",activityId,activitySha256:approvedActivitySha,screening:"not_required",screeningReasons:"Synthetic documented case assessment",screeningSourceRefs:["gdpr-2016-679","at-dsfa-v","at-dsfa-av"],dpoAdvice:"Synthetic DPO advice",reviewOn:"2027-12-31"}});
  const id = dsfa.records.find(r=>r.kind==="dpia").id; await approve(id);
  const changed = await okCommand({action:"update",id:activityId,payload:{purpose:"Changed basis"}});
  assert.equal(changed.records.find(r=>r.id===id).readiness.releaseReady,false);
  assert.ok(changed.records.find(r=>r.id===id).readiness.issues.some(i=>i.field==="activityId" || i.field==="activitySha256"));
});
test("draft data breach retains a real dispatch receipt without waiting for organizational review", async () => {
  const created = await okCommand({action:"create",kind:"breach",payload:{title:"Synthetic breach",roleInIncident:"controller",breachConfirmed:"yes",controllerAwareAt:new Date().toISOString(),risk:"unknown",authorityDecision:"unknown"}});
  const id = created.records.find(r=>r.kind==="breach").id;
  const result = await okCommand({action:"record_notification",id,decision:{channel:"authority",phase:"initial",sentAt:new Date().toISOString(),evidenceReference:"SYNTHETIC-NOTIFICATION-RECEIPT"}});
  assert.equal(result.records.find(r=>r.id===id).status,"draft");
  assert.equal(result.records.find(r=>r.id===id).deadlines.authorityState,"recorded");
});
test("private governance never enters generic settings, session, schedule or neutral audit details", async () => {
  for (const route of ["/api/settings",`/api/schedule?week=2026-10-05&location=${locationId}`,"/api/portal/v1/session"]) {
    const result = await request(route); assert.equal(result.status,200,JSON.stringify(result.payload)); absentPrivate(result.payload);
  }
  const rows = db.prepare("SELECT * FROM audit_log WHERE action='privacy-organization.command'").all();
  assert.ok(rows.length>0); absentPrivate(rows);
});
test("inactive authenticated principal cannot retain read or mutation authority", async () => {
  const before = (await request()).payload.revision;
  db.prepare("UPDATE portal_users SET active=0 WHERE employee_number=?").run(users.author.id);
  try {
    assert.equal((await request()).status,401);
    assert.equal((await request("/api/privacy-organization/commands",{method:"POST",body:{action:"create",kind:"breach",expectedRevision:before,payload:{title:"Denied"}}})).status,401);
  } finally {db.prepare("UPDATE portal_users SET active=1 WHERE employee_number=?").run(users.author.id);}
  assert.equal((await request()).payload.revision,before);
});
test("authenticated ciphertext corruption fails closed without replacing protected evidence", async () => {
  const stored = db.prepare("SELECT value FROM settings WHERE key=?").get(KEY).value;
  db.prepare("UPDATE settings SET value='enc:v2:corrupt' WHERE key=?").run(KEY);
  try {
    const result = await request(); assert.equal(result.status,503); assert.equal(result.payload.code,"PRIVACY_ORGANIZATION_INTEGRITY_FAILED");
    assert.equal(db.prepare("SELECT value FROM settings WHERE key=?").get(KEY).value,"enc:v2:corrupt");
  } finally {db.prepare("UPDATE settings SET value=? WHERE key=?").run(stored,KEY);}
});
test("audit failure rolls back the encrypted write and history together", async () => {
  const before = db.prepare("SELECT value FROM settings WHERE key=?").get(KEY).value;
  db.exec("CREATE TRIGGER privacy_synthetic_audit_failure BEFORE INSERT ON audit_log WHEN NEW.action='privacy-organization.command' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  try {
    const result=await command({action:"update",id:"organization",payload:{notes:"Must roll back"}});
    assert.equal(result.status,500);
    assert.equal(db.prepare("SELECT value FROM settings WHERE key=?").get(KEY).value,before);
  } finally {db.exec("DROP TRIGGER privacy_synthetic_audit_failure");}
});
test("missing records return an explicit 404", async () => {
  const result=await command({action:"update",id:"synthetic-nonexistent",payload:{title:"Missing"}});
  assert.equal(result.status,404); assert.equal(result.payload.code,"NOT_FOUND");
});
