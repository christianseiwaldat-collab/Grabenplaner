
"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {withFixture,NOW,OLD_HASH,NEW_HASH}=require("../test-support/security-audit/login-concurrency-fixture.cjs");
const {runLoginTransaction}=require("../lib/portal-login-security");
const {createApplicationRepositories}=require("../lib/persistence/application-repositories");
const start=NOW.toISOString(),absolute="2026-10-18T13:00:00.000Z",idle="2026-10-18T12:30:00.000Z";
for(const kind of ["sqlite","postgresql"])test(kind+": session limits and credential transitions",{skip:kind==="postgresql"&&!process.env.GP_CORE_MIGRATOR_URL,timeout:150000},async t=>withFixture(kind,async f=>{
 const transaction=work=>runLoginTransaction(f.provider,createApplicationRepositories,work);
 const insert=(repo,org,id="session",options={})=>repo[org?"insertOrganizationSession":"insertEmployeeSession"]({
  id,employeeNumber:"00001",accountId:"audit-org",tokenHash:id,authenticatedAt:start,absoluteExpiresAt:absolute,expiresAt:idle,...options});
 const lookup=(repo,org,id,now)=>repo[org?"getOrganizationSessionByToken":"getEmployeeSessionByToken"]({tokenHash:id,now,businessDate:"2026-10-18"});
 const touch=(repo,org,id,now,expiresAt)=>repo[org?"touchOrganizationSession":"touchEmployeeSession"]({id,now,expiresAt});
 for(const org of [false,true]){
  const channel=org?"organization":"browser";
  await t.test(channel+": missing authentication origin cannot create a session",async()=>{
   await f.reset(channel);await assert.rejects(async()=>insert(f.repositories.portalAccess,org,"bad",{authenticatedAt:undefined}),{code:"PERSISTENCE_STATEMENT_INVALID"});
   assert.equal(await f.activeSessions(channel),0);
  });
  await t.test(channel+": absolute/idle boundaries cannot be renewed or resurrected",async()=>{
   await f.reset(channel);const r=f.repositories.portalAccess;await insert(r,org);
   assert.ok(await lookup(r,org,"session",start));
   assert.equal((await touch(r,org,"session","2026-10-18T12:10:00.000Z","2026-10-18T20:00:00.000Z")).rowsAffected,1);
   const row=await lookup(r,org,"session","2026-10-18T12:59:59.999Z");
   assert.equal(row.expires_at,absolute);assert.equal(row.authenticated_at,start);assert.equal(row.absolute_expires_at,absolute);
   assert.equal(await lookup(r,org,"session",absolute),null);
   assert.equal((await touch(r,org,"session",absolute,"2026-10-18T20:00:00.000Z")).rowsAffected,0);
   await insert(r,org,"idle");assert.equal(await lookup(r,org,"idle",idle),null);
   assert.equal((await touch(r,org,"idle",idle,absolute)).rowsAffected,0);
  });
  await t.test(channel+": overlapping touches cannot shorten the persisted expiry",async()=>{
   await f.reset(channel);await insert(f.repositories.portalAccess,org);
   await Promise.all(["2026-10-18T12:55:00.000Z","2026-10-18T12:40:00.000Z"].map(end=>transaction(repos=>touch(repos.portalAccess,org,"session","2026-10-18T12:10:00.000Z",end))));
   assert.equal((await lookup(f.repositories.portalAccess,org,"session",start)).expires_at,"2026-10-18T12:55:00.000Z");
  });
  await t.test(channel+": touch after committed revocation stays rejected",async()=>{
   await f.reset(channel);await insert(f.repositories.portalAccess,org);
   await transaction(async r=>{await r.portalAccess[org?"revokeOrganizationSessionById":"revokeEmployeeSessionById"]({id:"session"});});
   assert.equal((await transaction(r=>touch(r.portalAccess,org,"session",start,absolute))).rowsAffected,0);
   assert.equal(await lookup(f.repositories.portalAccess,org,"session",start),null);
  });
 }
 await t.test("two password changes with the same verified hash have one winner",async()=>{
  await f.reset("browser");const results=await Promise.all([NEW_HASH,NEW_HASH+"-second"].map(passwordHash=>transaction(r=>r.portalAccess.changeEmployeePassword({employeeNumber:"00001",expectedPasswordHash:OLD_HASH,passwordHash,passwordPolicyVersion:1,now:start}))));
  assert.equal(results.reduce((n,r)=>n+r.rowsAffected,0),1);
  assert.equal((await f.snapshot("browser")).password_policy_version,1);
  assert.equal((await f.repositories.mobileAuth.updateMobilePassword({employeeNumber:"00001",expectedPasswordHash:OLD_HASH,passwordHash:"stale",passwordPolicyVersion:1})).rowsAffected,0);
 });
 await t.test("policy acknowledgement is CAS and does not clear forced change",async()=>{
  await f.reset("browser");await f.execute("UPDATE portal_users SET must_change_password=1,password_policy_version=0 WHERE employee_number='00001'");
  const input={employeeNumber:"00001",expectedPasswordHash:OLD_HASH,passwordPolicyVersion:1,mustChangePassword:false,now:start};
  assert.equal((await f.repositories.portalAccess.recordEmployeePasswordPolicy(input)).rowsAffected,1);
  assert.equal((await f.snapshot("browser")).must_change_password,1);
  assert.equal((await f.repositories.portalAccess.recordEmployeePasswordPolicy({...input,expectedPasswordHash:"stale"})).rowsAffected,0);
  await f.repositories.organizationPersonnel.upsertPortalUserAccount({employeeNumber:"00001",passwordHash:OLD_HASH,role:"employee",active:true,mustChangePassword:false,passwordChanged:false});
  const row=await f.snapshot("browser");assert.equal(row.must_change_password,1);assert.equal(row.password_policy_version,1);
 });
 await t.test("organization policy acknowledgement cannot recognize an old credential",async()=>{
  await f.reset("organization");const r=f.repositories.portalAccess;
  assert.equal((await r.recordOrganizationPasswordPolicy({accountId:"audit-org",expectedPasswordHash:"stale",passwordPolicyVersion:1,now:start})).rowsAffected,0);
  assert.equal((await r.recordOrganizationPasswordPolicy({accountId:"audit-org",expectedPasswordHash:OLD_HASH,passwordPolicyVersion:1,now:start})).rowsAffected,1);
  assert.equal((await f.snapshot("organization")).password_policy_version,1);
 });
 await t.test("password, revoke, replacement and audit rollback together",async()=>{
  await f.reset("browser");await insert(f.repositories.portalAccess,false,"old");
  await assert.rejects(transaction(async r=>{
   assert.equal((await r.portalAccess.changeEmployeePassword({employeeNumber:"00001",expectedPasswordHash:OLD_HASH,passwordHash:NEW_HASH,passwordPolicyVersion:1,now:start})).rowsAffected,1);
   await r.portalAccess.revokeEmployeeSessionsForEmployee({employeeNumber:"00001"});
   await insert(r.portalAccess,false,"replacement");
   await r.organizationPersonnel.insertAudit("00001","synthetic.security.change","portal_user","00001");
   throw Error("synthetic audit/commit rollback");
  }),/synthetic audit\/commit rollback/);
  assert.equal((await f.snapshot("browser")).password_hash,OLD_HASH);
  assert.ok(await lookup(f.repositories.portalAccess,false,"old",start));assert.equal(await lookup(f.repositories.portalAccess,false,"replacement",start),null);
 });
 await t.test("mobile rotation CAS preserves original lifetime and rejects overflow",async()=>{
  await f.reset("mobile");await f.login("mobile",await f.snapshot("mobile"));
  const row=(await f.all("SELECT * FROM mobile_sessions WHERE employee_number='00001' AND revoked_at IS NULL"))[0];
  const input={sessionId:row.id,expectedRefreshTokenHash:row.refresh_token_hash,accessTokenHash:"new-access",refreshTokenHash:"new-refresh",accessExpiresAt:"2026-10-18T12:15:00.000Z",now:start};
  assert.equal((await f.repositories.mobileAuth.rotateSession({...input,accessExpiresAt:"2026-10-19T00:00:00.000Z"})).rowsAffected,0);
  const results=await Promise.all([0,1].map(i=>transaction(r=>r.mobileAuth.rotateSession({...input,accessTokenHash:"access-"+i,refreshTokenHash:"refresh-"+i}))));
  assert.equal(results.reduce((n,r)=>n+r.rowsAffected,0),1);
  const after=(await f.all("SELECT * FROM mobile_sessions WHERE id=$1",[row.id]))[0];assert.equal(after.refresh_expires_at,row.refresh_expires_at);
  assert.equal((await f.repositories.mobileAuth.refreshSession({...input,expectedRefreshTokenHash:after.refresh_token_hash,now:row.refresh_expires_at,deviceLabel:"Synthetic",appVersion:"1"})).rowsAffected,0);
 });
 await t.test("silent mobile refresh preserves activity and exact authentication origin",async()=>{
  await f.reset("mobile");const r=f.repositories.mobileAuth,origin="2026-10-18T12:00:00.123Z";
  await r.insertSession({id:"precision",employeeNumber:"00001",accessTokenHash:"precision-access",accessExpiresAt:idle,
   refreshTokenHash:"precision-refresh",refreshExpiresAt:absolute,authenticatedAt:origin,installationIdHash:"synthetic-device",
   platform:"android",deviceLabel:"Synthetic",appVersion:"1"});
  const before=(await f.all("SELECT * FROM mobile_sessions WHERE id='precision'"))[0];
  assert.equal(before.created_at,origin);assert.equal(before.last_seen_at,origin);
  assert.equal((await r.refreshSession({sessionId:"precision",expectedRefreshTokenHash:"precision-refresh",accessTokenHash:"refreshed-access",
   refreshTokenHash:"refreshed-refresh",accessExpiresAt:"2026-10-18T12:45:00.000Z",now:"2026-10-18T12:30:00.000Z",deviceLabel:"Synthetic",appVersion:"1"})).rowsAffected,1);
  const after=(await f.all("SELECT * FROM mobile_sessions WHERE id='precision'"))[0];
  assert.equal(after.created_at,origin);assert.equal(after.last_seen_at,origin);assert.equal(after.refresh_expires_at,absolute);
 });
 await t.test("administrator reset token revocation shares transaction and rolls back",async()=>{
  await f.reset("browser");
  await f.execute("INSERT INTO portal_password_reset_tokens(id,employee_number,token_hash,email_fingerprint,expires_at) VALUES('reset','00001','hash-reset','synthetic',$1)",[absolute]);
  await assert.rejects(transaction(async r=>{await r.organizationPersonnel.revokePasswordResetTokens("00001");throw Error("synthetic rollback");}),/synthetic rollback/);
  assert.equal((await f.all("SELECT revoked_at FROM portal_password_reset_tokens WHERE id='reset'"))[0].revoked_at,null);
  await f.repositories.organizationPersonnel.revokePasswordResetTokens("00001");
  assert.ok((await f.all("SELECT revoked_at FROM portal_password_reset_tokens WHERE id='reset'"))[0].revoked_at);
 });
}));
