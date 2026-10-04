"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-retail-kv-"));
Object.assign(process.env, { DB_PATH: path.join(root, "synthetic.db"), BACKUP_DIR: path.join(root, "backups"), GRABENPLANER_DATA_DIR: path.join(root, "data"), GRABENPLANER_HOST: "127.0.0.1", GRABENPLANER_FORCE_PORTAL: "1", GRABENPLANER_SEED_DEMO: "1", NODE_ENV: "test", TZ: "Europe/Vienna" });
const { app, db, initializeApplicationPersistence, releaseInstanceLockForTests } = require("../server");
const { RETAIL_KV_SOURCE } = require("../lib/personnel-retail-kv");
const { RETAIL_KV_PROFILE } = require("../lib/work-rules/retail-kv");
const FIELD = "employment.retailKv", SUBJECT = "kv-synthetic-subject", WEEK = "2026-10-05";
let server, url, locationId, versionId, assignmentId, review;
const users = {};
function session(id, role) {
  const token = crypto.randomBytes(32).toString("hex"), csrf = crypto.randomBytes(24).toString("hex");
  db.prepare("INSERT INTO portal_users(employee_number,password_hash,role,active,must_change_password,password_changed_at) VALUES (?,'synthetic',?,1,0,CURRENT_TIMESTAMP)").run(id, role);
  db.prepare("INSERT INTO portal_sessions(id,employee_number,token_hash,expires_at) VALUES (?,?,?,'2099-12-31T23:59:59.000Z')").run(crypto.randomUUID(), id, crypto.createHash("sha256").update(token).digest("hex"));
  return { cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`, csrf };
}
async function request(route, { method = "GET", body, auth = users.author, skipPlanningBasis = false } = {}) {
  if (method === "PUT" && body && !skipPlanningBasis) {
    const standalone = /^\/api\/portal\/v1\/personnel-records\/[^/]+$/.test(route);
    const embedded = /^\/api\/employees\/[^/]+$/.test(route);
    const record = standalone ? body : embedded ? body.personnelRecord : null;
    const source = record?.sensitive || record || {};
    const employment = source.employment || {};
    const protects = ["protectionStatus", "retailKv"].some(key => Object.hasOwn(employment,key) || Object.hasOwn(source,key));
    if (record && protects && !Object.hasOwn(record,"planningStatusBasis")) {
      const target = route.split("/").at(-1);
      const loaded = await request("/api/portal/v1/personnel-records/" + target, {auth});
      if (loaded.status === 200) record.planningStatusBasis = loaded.payload.planningStatusBasis;
    }
  }
  const headers = { Accept: "application/json", Cookie: auth.cookie };
  if (method !== "GET") headers["X-CSRF-Token"] = auth.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url + route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const payload = await response.json(); return { status: response.status, payload };
}
function status(patch = {}) {
  return { version: 1, planningEnabled: true, periods: [{ id: "private-kv-period", group: "salaried", confirmed: true, validFrom: "2026-01-01", validTo: "2026-12-31", sourceReference: "PRIVATE-KV-BASIS", collectiveAgreementVersionId: versionId, approvedAssignmentId: assignmentId, sourceVersion: RETAIL_KV_SOURCE.id, sourceSha256: RETAIL_KV_SOURCE.sha256, contractWeeklyMinutes: 2310, normalWorkModel: "standard", agreementStatus: "none_confirmed", agreementReference: "PRIVATE-KV-AGREEMENT", agreementValidFrom: "2026-01-01", agreementValidTo: "2026-12-31", agreementConfirmedBy: "PRIVATE-KV-CONFIRMER", workplaceKind: "retail_sales", workplaceConfirmed: true, exceptionModel: "none_confirmed", averagingPeriod: null, ...patch }] };
}
async function save(value = status(), auth = users.author) { return request(`/api/portal/v1/personnel-records/${SUBJECT}`, { method: "PUT", body: { sensitive: { employment: { retailKv: value } } }, auth }); }
async function plan(week = WEEK) {
  const result = await request(`/api/schedule?week=${week}&location=${locationId}`, { auth: users.manager });
  assert.equal(result.status, 200, JSON.stringify(result.payload)); return result.payload.workRuleAssessment;
}
function privateReferencesAbsent(value) {
  for (const marker of ["private-kv-period", "PRIVATE-KV-BASIS", "PRIVATE-KV-AGREEMENT", "PRIVATE-KV-CONFIRMER"]) assert.ok(!JSON.stringify(value).includes(marker), marker);
}
test.before(async () => {
  await initializeApplicationPersistence();
  const location = db.prepare("SELECT id,cost_center_id FROM locations WHERE active=1 ORDER BY id LIMIT 1").get(); locationId = location.id;
  const roles = { author: "hr", reviewer1: "hr", reviewer2: "admin", manager: "manager", developer: "developer" };
  for (const [key, role] of Object.entries(roles)) {
    const id = `kv-synthetic-${key}`;
    db.prepare("INSERT INTO employees(personnel_number,full_name,nickname,color,contracted_hours,target_workdays_per_week,home_location_id,cost_center_id,active) VALUES (?,?,?,'#25705d',38.5,5,?,?,1)").run(id, id, id, locationId, location.cost_center_id);
    users[key] = session(id, role);
    db.prepare("INSERT INTO portal_access_scopes(employee_number,location_id,assigned_by) VALUES (?,?,'synthetic')").run(id, locationId);
    for (const permission of ["work_rules:read", ...(["hr", "admin"].includes(role) ? ["collective_agreements:read", "collective_agreements:manage", "collective_agreements:assign", "collective_agreements:approve", "work_rules:review"] : [])]) db.prepare("INSERT OR IGNORE INTO portal_permission_grants(employee_number,permission,granted_by) VALUES (?,?,'synthetic')").run(id, permission);
  }
  db.prepare("INSERT INTO employees(personnel_number,full_name,nickname,color,contracted_hours,target_workdays_per_week,home_location_id,cost_center_id,active) VALUES (?,'KV Subject','KV Subject','#25705d',38.5,5,?,?,1)").run(SUBJECT, locationId, location.cost_center_id);
  for (const date of ["2026-10-10", "2026-10-17"]) db.prepare("INSERT INTO shifts(employee_number,location_id,shift_date,start_time,end_time,area,note) VALUES (?, ?, ?, '12:00','14:00','synthetic','')").run(SUBJECT, locationId, date);
  server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve)); url = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); try { db.close(); } catch {} releaseInstanceLockForTests(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });
test("new source-bound KV profile is seeded without an automatic applicability assignment", () => {
  const id = `${RETAIL_KV_PROFILE.id}@${RETAIL_KV_PROFILE.version}`;
  assert.equal(db.prepare("SELECT count(*) n FROM work_rule_profile_versions WHERE id=?").get(id).n, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM work_rule_assignments WHERE profile_version_id=?").get(id).n, 0);
});
test("register source, profile link and assignment can be prepared through real HR APIs", async () => {
  const created = await request("/api/collective-agreements", { method: "POST", body: { code: "KV-SYNTHETIC", title: "Synthetic KV", jurisdiction: "AT", version: { versionLabel: "2026 synthetic", validFrom: "2026-01-01", validTo: "2026-12-31", sourceTitle: RETAIL_KV_SOURCE.title, sourceUrl: RETAIL_KV_SOURCE.url, sourceRetrievedOn: RETAIL_KV_SOURCE.retrievedOn, sourceSha256: RETAIL_KV_SOURCE.sha256, employeeGroups: ["Handelsangestellte", "Lehrlinge"], apprenticeRelevance: "yes", linkedProfileVersionId: `${RETAIL_KV_PROFILE.id}@${RETAIL_KV_PROFILE.version}` } } });
  assert.equal(created.status, 201, JSON.stringify(created.payload)); versionId = created.payload.agreement.currentVersionId;
  const unit = await request("/api/collective-agreements/business-units", { method: "POST", body: { code: "KV-SYNTHETIC-BU", name: "Synthetic scope", legalEntityName: "Synthetic entity", scopes: [{ scopeType: "location", scopeKey: locationId }] } });
  assert.equal(unit.status, 201, JSON.stringify(unit.payload));
  const assignment = await request("/api/collective-agreements/assignments", { method: "POST", body: { agreementVersionId: versionId, businessUnitId: unit.payload.businessUnit.id, validFrom: "2026-01-01", validTo: "2026-12-31", rationale: "Synthetic confirmed applicability prepared for independent review.", referenceNote: "synthetic-evidence" } });
  assert.equal(assignment.status, 201, JSON.stringify(assignment.payload)); assignmentId = assignment.payload.assignment.id;
});
test("private HR facts persist encrypted but cannot replace the still missing independent approval", async () => {
  const result = await save(); assert.equal(result.status, 200, JSON.stringify(result.payload));
  assert.ok(result.payload.changedFields.includes(FIELD));
  assert.match(db.prepare("SELECT protected_payload FROM personnel_sensitive_records WHERE employee_number=?").get(SUBJECT).protected_payload, /^enc:v2:/);
  const assessment = await plan(); privateReferencesAbsent(assessment);
  assert.ok(assessment.findings.some(f => f.employeeNumber === SUBJECT && f.ruleId.startsWith("at.retail-kv.") && f.resultState === "unknown"));
});
test("planner accounts cannot read, delegate or directly overwrite HR KV facts", async () => {
  for (const auth of [users.manager]) {
    const record = await request(`/api/portal/v1/personnel-records/${SUBJECT}`, { auth });
    if (record.status === 200) { assert.equal(record.payload.access.fieldAccess[FIELD], "hidden"); assert.ok(!Object.hasOwn(record.payload.profile.sensitive?.employment || {}, "retailKv")); }
    else assert.equal(record.status, 403);
    assert.equal((await save(status(), auth)).status, 403);
    const alias = await request(`/api/portal/v1/personnel-records/${SUBJECT}`, { method: "PUT", body: { sensitive: { retailKv: status() } }, auth }); assert.equal(alias.status, 403);
  }
});
test("personal developer can read and edit KV facts without replacing independent applicability approval", async () => {
  const record = await request(`/api/portal/v1/personnel-records/${SUBJECT}`, { auth: users.developer });
  assert.equal(record.status, 200, JSON.stringify(record.payload));
  assert.equal(record.payload.access.fieldAccess[FIELD], "write");
  assert.equal(record.payload.profile.sensitive.employment.retailKv.periods[0].contractWeeklyMinutes, 2310);
  assert.match(record.payload.planningStatusBasis[FIELD], /^[0-9a-f]{64}$/);
  const changed = await save(status({ contractWeeklyMinutes: 2100 }), users.developer);
  assert.equal(changed.status, 200, JSON.stringify(changed.payload));
  assert.ok(changed.payload.changedFields.includes(FIELD));
  const stale = await request(`/api/portal/v1/personnel-records/${SUBJECT}`, { method: "PUT", auth: users.developer,
    body: { sensitive: { employment: { retailKv: status() } }, planningStatusBasis: record.payload.planningStatusBasis } });
  assert.equal(stale.status, 409, JSON.stringify(stale.payload));
  assert.equal(stale.payload.code, "PERSONNEL_PLANNING_STATUS_CONCURRENT_CHANGE");
  assert.ok((await plan()).findings.some(f => f.employeeNumber === SUBJECT && f.ruleId.startsWith("at.retail-kv.") && f.resultState === "unknown"));
  assert.equal(db.prepare("SELECT count(*) n FROM work_rule_assignments WHERE profile_version_id=?").get(`${RETAIL_KV_PROFILE.id}@${RETAIL_KV_PROFILE.version}`).n, 0);
  assert.equal((await save(status(), users.developer)).status, 200);
});
test("author cannot self-approve and one review cannot activate the KV binding", async () => {
  const input = { operation: "approve_kv_assignment", subjectType: "collective_agreement_assignment", subjectId: assignmentId, payload: { effectiveOn: "2026-01-01" } };
  const preview = await request("/api/work-rules/governance/preview", { method: "POST", body: input }); assert.equal(preview.status, 200, JSON.stringify(preview.payload)); assert.equal(preview.payload.preview.requiredApprovals, 2);
  const submitted = await request("/api/work-rules/governance/requests", { method: "POST", body: { ...input, clientRequestId: crypto.randomUUID(), basisSha256: preview.payload.preview.basisSha256, conflictRunId: preview.payload.preview.conflictRunId, reason: "Synthetic independent source and scope review requested.", sourceReference: "synthetic-review-evidence" } });
  assert.equal(submitted.status, 201, JSON.stringify(submitted.payload)); review = submitted.payload.request;
  const decision = { decision: "approve", reason: "Synthetic independent professional review of scope and source." };
  assert.equal((await request(`/api/work-rules/governance/requests/${review.id}/decisions`, { method: "POST", body: decision })).status, 403);
  assert.equal((await request(`/api/work-rules/governance/requests/${review.id}/decisions`, { method: "POST", body: decision, auth: users.reviewer1 })).status, 200);
  const early = await request(`/api/work-rules/governance/requests/${review.id}/finalize`, { method: "POST", body: { basisSha256: review.basisSha256, reason: "Synthetic prematurely finalized operation.", sourceReference: "synthetic-review-evidence" } }); assert.equal(early.status, 409);
  assert.ok((await plan()).findings.some(f => f.employeeNumber === SUBJECT && f.ruleId.startsWith("at.retail-kv.") && f.resultState === "unknown"));
});
test("two independent HR/Developer decisions and developer finalization connect the approved KV to actual schedule findings", async () => {
  assert.equal(db.prepare("SELECT count(*) n FROM portal_permission_grants WHERE employee_number='kv-synthetic-developer' AND permission='collective_agreements:approve'").get().n, 0);
  const second = await request(`/api/work-rules/governance/requests/${review.id}/decisions`, { method: "POST", body: { decision: "approve", reason: "Synthetic second independent professional review completed." }, auth: users.developer }); assert.equal(second.status, 200, JSON.stringify(second.payload));
  assert.equal(second.payload.request.state, "approved");
  assert.equal(second.payload.request.decisions.find(decision => decision.actorRole === "developer").qualification, "fachlich");
  const completed = await request(`/api/work-rules/governance/requests/${review.id}/finalize`, { method: "POST", auth: users.developer, body: { basisSha256: review.basisSha256, reason: "Synthetic reviewed KV assignment applied.", sourceReference: "synthetic-review-evidence" } }); assert.equal(completed.status, 200, JSON.stringify(completed.payload));
  const assessment = await plan(); privateReferencesAbsent(assessment);
  const saturday = assessment.findings.find(f => f.employeeNumber === SUBJECT && f.ruleId.includes("at.retail-kv.") && f.ruleId.includes("saturday"));
  assert.ok(saturday, JSON.stringify(assessment.findings)); assert.equal(saturday.resultState, "fail"); assert.equal(saturday.effectiveEnforcement, "advisory");
});
test("KV apprentices remain subject to both youth and confidential protection overlays", async () => {
  db.prepare("INSERT INTO shifts(employee_number,location_id,shift_date,start_time,end_time,area,note) VALUES (?,?,'2026-10-06','19:00','21:00','synthetic','')").run(SUBJECT, locationId);
  const layered = await request(`/api/portal/v1/personnel-records/${SUBJECT}`, { method: "PUT", body: { sensitive: {
    identity: { birthDate: "2010-10-01" }, employment: {
      retailKv: status({ group: "apprentice" }), apprenticeshipStatus: "active", apprenticeshipConfirmed: true,
      apprenticeshipValidFrom: "2026-01-01", apprenticeshipValidTo: "2026-12-31", apprenticeshipSourceReference: "PRIVATE-APPRENTICE-EVIDENCE",
      protectionStatus: { version: 1, planningEnabled: true, periods: [{ id: "private-protection", phase: "pregnancy", confirmed: true,
        validFrom: "2026-01-01", validTo: "2026-12-31", referenceId: "PRIVATE-PROTECTION-EVIDENCE", normalDailyMinutes: 480 }] },
    },
  } } }); assert.equal(layered.status, 200, JSON.stringify(layered.payload));
  const assessment = await plan(); privateReferencesAbsent(assessment);
  assert.ok(assessment.profiles.some(profile => profile.id === RETAIL_KV_PROFILE.id));
  assert.ok(assessment.findings.some(f => f.employeeNumber === SUBJECT && f.ruleId.startsWith("at.kjbg.") && f.resultState === "fail"));
  assert.ok(assessment.findings.some(f => f.employeeNumber === SUBJECT && f.ruleId === "at.protection.time-window" && f.resultState === "fail"));
  for (const marker of ["pregnancy", "PRIVATE-APPRENTICE-EVIDENCE", "PRIVATE-PROTECTION-EVIDENCE", "ris.mschg."]) assert.ok(!JSON.stringify(assessment).includes(marker), marker);
  const restored = await request(`/api/portal/v1/personnel-records/${SUBJECT}`, { method: "PUT", body: { sensitive: {
    identity: { birthDate: "1980-01-01" }, employment: { retailKv: status(), protectionStatus: null,
      apprenticeshipStatus: "not_apprentice", apprenticeshipConfirmed: true, apprenticeshipValidFrom: "2026-01-01",
      apprenticeshipValidTo: "2026-12-31", apprenticeshipSourceReference: "PRIVATE-NOT-APPRENTICE-EVIDENCE" },
  } } }); assert.equal(restored.status, 200, JSON.stringify(restored.payload));
});
test("basis edits revoke personal confirmation and expiry never adopts the next year's KV automatically", async () => {
  const changed = status({ contractWeeklyMinutes: 1800 }); delete changed.periods[0].confirmed;
  assert.equal((await save(changed)).status, 200);
  const record = await request(`/api/portal/v1/personnel-records/${SUBJECT}`); assert.equal(record.payload.profile.sensitive.employment.retailKv.periods[0].confirmed, false);
  assert.equal((await save(status())).status, 200);
  assert.ok((await plan("2026-12-28")).findings.some(f => f.employeeNumber === SUBJECT && f.ruleId.startsWith("at.retail-kv.") && f.resultState === "unknown"));
  for (const row of db.prepare("SELECT result_json FROM work_rule_evaluation_runs").all()) privateReferencesAbsent(JSON.parse(row.result_json));
});

test("stale KV draft cannot restore an older confirmed workplace or contract basis", async () => {
  assert.equal((await save(status())).status,200);
  const old = await request("/api/portal/v1/personnel-records/"+SUBJECT,{auth:users.author});
  const oldToken = old.payload.planningStatusBasis[FIELD];
  assert.match(oldToken,/^[0-9a-f]{64}$/);
  assert.equal((await save(status({contractWeeklyMinutes:2100,confirmed:false,workplaceConfirmed:false}),users.reviewer1)).status,200);
  const before = db.prepare("SELECT * FROM personnel_sensitive_records WHERE employee_number=?").get(SUBJECT);
  const receiptCount = db.prepare("SELECT count(*) n FROM work_rule_evaluation_runs").get().n;
  const auditCount = db.prepare("SELECT count(*) n FROM audit_log").get().n;
  const stale = await request("/api/portal/v1/personnel-records/"+SUBJECT,{method:"PUT",auth:users.author,
    body:{sensitive:{employment:{retailKv:status({contractWeeklyMinutes:2200})}},planningStatusBasis:{[FIELD]:oldToken}}});
  assert.equal(stale.status,409,JSON.stringify(stale.payload));
  assert.equal(stale.payload.code,"PERSONNEL_PLANNING_STATUS_CONCURRENT_CHANGE");
  assert.deepEqual(db.prepare("SELECT * FROM personnel_sensitive_records WHERE employee_number=?").get(SUBJECT),before);
  assert.equal(db.prepare("SELECT count(*) n FROM work_rule_evaluation_runs").get().n,receiptCount);
  assert.equal(db.prepare("SELECT count(*) n FROM audit_log").get().n,auditCount);
  const after = await request("/api/portal/v1/personnel-records/"+SUBJECT,{auth:users.author});
  assert.equal(after.payload.profile.sensitive.employment.retailKv.periods[0].contractWeeklyMinutes,2100);
  assert.equal(after.payload.profile.sensitive.employment.retailKv.periods[0].confirmed,false);
  assert.equal(after.payload.profile.sensitive.employment.retailKv.periods[0].workplaceConfirmed,false);
});
