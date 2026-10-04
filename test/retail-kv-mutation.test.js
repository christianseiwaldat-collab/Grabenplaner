"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { recordRetailKvChange: record } = require("../lib/work-rules/retail-kv-mutation");
const { normalizeRetailKv, RETAIL_KV_SOURCE: source } = require("../lib/personnel-retail-kv");
const { RETAIL_KV_PROFILE: profile, RETAIL_KV_RULES: rules, RETAIL_KV_SOURCES: sources } = require("../lib/work-rules/retail-kv");
const { seedBuiltinWorkRuleProfiles } = require("../lib/work-rules/store");
const { addDays } = require("../lib/work-rules/calendar");
const { openSqliteApplicationPersistence } = require("../lib/persistence/sqlite/provider");
const { SQLITE_APPLICATION_CATALOG } = require("../lib/persistence/sqlite/application-catalog");
const { ensureSqliteApplicationSchema } = require("../lib/persistence/sqlite/operations/application-schema");
const { createApplicationRepositories } = require("../lib/persistence/application-repositories");
const { createCollectiveAgreement, createBusinessUnit, prepareCollectiveAgreementAssignment } = require("../lib/collective-agreements");
const { previewWorkRuleGovernance, createWorkRuleReviewRequest, recordWorkRuleReviewDecision, finalizeWorkRuleReviewRequest } = require("../lib/work-rules/governance");
const EMPLOYEE = "00002", WEEK = "2026-10-05";
const actor = employeeNumber => ({ employeeNumber, role: "hr", qualification: "fachlich", permissionUsed: "collective_agreements:approve" });

function encrypted(value) {
  const keyId = Buffer.from("synthetic"), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", crypto.randomBytes(32), iv);
  const payload = Buffer.concat([cipher.update(JSON.stringify({ employment: { retailKv: value } })), cipher.final()]);
  return "enc:v2:" + Buffer.concat([Buffer.from([keyId.length]), keyId, iv, cipher.getAuthTag(), payload]).toString("base64url");
}

async function fixture({ seededProfile = true, approved = true, profileOverride = profile, sourceOverride = source } = {}) {
  const app = openSqliteApplicationPersistence({ databasePath: ":memory:", catalog: SQLITE_APPLICATION_CATALOG });
  ensureSqliteApplicationSchema(app.database);
  app.database.exec("INSERT INTO locations(id,name) VALUES('SYN-A','Synthetic A'),('SYN-B','Synthetic B'),('SYN-C','Unassigned C')");
  app.database.exec("INSERT INTO employees(personnel_number,full_name,nickname,home_location_id) VALUES('00002','Synthetic Person','Synthetic','SYN-A'),('00003','Other Synthetic','Other','SYN-A')");
  const repositories = createApplicationRepositories(app.provider);
  let versionId = "pending-version", assignmentId = "pending-assignment";
  if (seededProfile) {
    await seedBuiltinWorkRuleProfiles(repositories.workRules,
      [{ profile: profileOverride, rules: Object.values(rules), sources: [sourceOverride] }], sources);
    const agreement = await createCollectiveAgreement(repositories.collectiveAgreements,
      { code: "SYN-KV", title: source.title, version: { versionLabel: "2026", validFrom: source.validFrom,
        validTo: source.validTo, sourceTitle: source.title, sourceUrl: source.url,
        sourceRetrievedOn: source.retrievedOn, sourceSha256: source.sha256,
        linkedProfileVersionId: `${profile.id}@${profile.version}` } }, "AUTHOR");
    const unit = await createBusinessUnit(repositories.collectiveAgreements,
      { code: "SYN-UNIT", name: "Synthetic Unit", legalEntityName: "Synthetic Entity",
        scopes: [{ scopeType: "location", scopeKey: "SYN-A" }, { scopeType: "location", scopeKey: "SYN-B" }] }, "AUTHOR");
    const assignment = await prepareCollectiveAgreementAssignment(repositories.collectiveAgreements,
      { agreementVersionId: agreement.currentVersionId, businessUnitId: unit.id,
        validFrom: source.validFrom, validTo: source.validTo, rationale: "Synthetic independently reviewed applicability." }, "AUTHOR");
    versionId = agreement.currentVersionId; assignmentId = assignment.id;
    if (approved) {
      const input = { operation: "approve_kv_assignment", subjectType: "collective_agreement_assignment",
        subjectId: assignment.id, payload: { effectiveOn: source.validFrom } };
      const preview = await previewWorkRuleGovernance(repositories.workRuleGovernance, input, actor("AUTHOR"));
      assert.equal(preview.outcome, "pass");
      let request = await createWorkRuleReviewRequest(repositories.workRuleGovernance,
        { ...input, clientRequestId: `synthetic-${assignment.id}`, basisSha256: preview.basisSha256,
          conflictRunId: preview.conflictRunId, reason: "Synthetic independent review request.", sourceReference: "PRIVATE:register-basis" }, actor("AUTHOR"));
      for (const reviewer of ["REVIEW-1", "REVIEW-2"]) request = await recordWorkRuleReviewDecision(repositories.workRuleGovernance,
        request.id, { decision: "approve", reason: "Synthetic independent professional review." }, actor(reviewer));
      await finalizeWorkRuleReviewRequest(repositories.workRuleGovernance, request.id,
        { basisSha256: request.basisSha256, reason: "Synthetic separated approvals applied.", sourceReference: "PRIVATE:register-basis" }, actor("AUTHOR"));
    }
  }
  function status(changes = {}, periodChanges = {}) {
    return normalizeRetailKv({ version: 1, planningEnabled: true, periods: [{ id: "PRIVATE-period", group: "salaried",
      confirmed: true, validFrom: WEEK, validTo: "2026-10-25", sourceReference: "PRIVATE:personal-basis",
      collectiveAgreementVersionId: versionId, approvedAssignmentId: assignmentId, sourceVersion: source.id,
      sourceSha256: source.sha256, contractWeeklyMinutes: 2310, normalWorkModel: "standard", agreementStatus: "none_confirmed",
      agreementReference: "PRIVATE:agreement-check", agreementValidFrom: WEEK, agreementValidTo: "2026-10-25",
      agreementConfirmedBy: "PRIVATE-HR", workplaceKind: "retail_sales", workplaceConfirmed: true,
      exceptionModel: "none_confirmed", averagingPeriod: null, ...periodChanges }], ...changes });
  }
  const normalizeShifts = rows => rows.map(row => ({ id: String(row.id), employeeId: row.employee_number,
    date: row.shift_date, startTime: row.start_time, endTime: row.end_time, breakMinutes: 0,
    breakSource: "none", locationId: row.location_id, departmentId: row.department_id }));
  function insertShift(date, start = "08:00", end = "12:00", location = "SYN-A", employeeNumber = EMPLOYEE) {
    return Number(app.database.prepare("INSERT INTO shifts(employee_number,location_id,shift_date,start_time,end_time) VALUES(?,?,?,?,?)")
      .run(employeeNumber, location, date, start, end).lastInsertRowid);
  }
  async function change(options = {}) {
    const next = Object.hasOwn(options, "status") ? options.status : status();
    const protectedPayload = Object.hasOwn(options, "protectedPayload") ? options.protectedPayload : encrypted(next);
    return app.provider.transaction(async executor => {
      const bound = createApplicationRepositories(executor);
      await bound.organizationPersonnel.upsertPersonnelSensitiveRecord({ employeeNumber: EMPLOYEE,
        socialSecurityLookup: "", protectedPayload: options.storedPayload || protectedPayload, actor: "synthetic-hr" });
      await bound.organizationPersonnel.insertAudit("synthetic-hr", "personnel-record.update", "employee", EMPLOYEE,
        JSON.stringify({ fields: ["employment.retailKv"] }));
      return record(options.boundTransform ? options.boundTransform(bound) : bound, {
        employeeNumber: EMPLOYEE, previousStatus: options.previousStatus || null, status: next, protectedPayload,
        actor: "synthetic-hr", normalizeShifts: Object.hasOwn(options, "normalize") ? options.normalize : normalizeShifts,
        employee: { birthDate: "1990-01-01", birthDateConfirmed: true, apprenticeshipStatus: "not_apprentice",
          apprenticeshipConfirmed: true, apprenticeshipValidFrom: "2026-01-01", apprenticeshipValidTo: "",
          apprenticeshipSourceReference: "PRIVATE:apprenticeship-basis" },
      });
    }, { isolation: "serializable" });
  }
  return { ...app, repositories, status, change, insertShift, normalizeShifts,
    receipts: () => app.database.prepare("SELECT * FROM work_rule_evaluation_runs ORDER BY period_from,id").all(),
    writes: () => app.database.prepare("SELECT count(*) AS n FROM audit_log WHERE action='personnel-record.update'").get().n,
    async close() { await app.provider.close(); app.database.close(); } };
}

test("retail KV mutation: all known weeks and branches, overnight carry and validity boundaries share one transaction", async t => {
  const f = await fixture(); t.after(f.close);
  f.insertShift("2026-10-06", "08:00", "12:00", "SYN-A");
  f.insertShift("2026-10-06", "12:00", "16:00", "SYN-B");
  f.insertShift("2026-10-11", "22:00", "02:00", "SYN-A");
  f.insertShift("2027-07-06");
  f.insertShift("2028-10-02", "08:00", "23:00", "SYN-A", "00003");
  let boundObserved = false;
  const assessments = await f.change({ normalize: (rows, repositories) => {
    boundObserved = typeof repositories.workRules.transaction !== "function";
    assert.ok(rows.every(row => row.employee_number === EMPLOYEE));
    return f.normalizeShifts(rows);
  } });
  assert.equal(boundObserved, true);
  assert.deepEqual(assessments.map(value => value.periodFrom), [WEEK, "2026-10-12", "2026-10-19", "2026-10-26", "2027-07-05"]);
  assert.equal(f.receipts().length, 5);
  const daily = assessments[0].findings.find(value => value.ruleId === "at.retail-kv.normal.daily" && value.scope.date === "2026-10-06");
  assert.equal(daily.evidence.actualMinutes, 480);
  assert.equal(daily.state, "pass");
  assert.equal(f.writes(), 1);
});

test("retail KV mutation: genuine approval is rechecked for every actual branch and fabricated personal links remain unknown", async t => {
  const f = await fixture(); t.after(f.close);
  f.insertShift("2026-10-06"); f.insertShift("2026-10-07", "08:00", "12:00", "SYN-C");
  const assessments = await f.change();
  const day = date => assessments[0].findings.find(value => value.ruleId === "at.retail-kv.applicability" && value.scope.date === date);
  assert.equal(day("2026-10-06").state, "pass");
  assert.equal(day("2026-10-07").state, "unknown");
  const fabricated = await f.change({ status: f.status({}, { approvedAssignmentId: "fake-assignment" }) });
  assert.equal(fabricated[0].findings.find(value => value.ruleId === "at.retail-kv.applicability" && value.scope.date === "2026-10-06").state, "unknown");
});

test("retail KV mutation: source or profile without matching snapshot cannot produce receipts", async t => {
  for (const options of [{ seededProfile: false }, { profileOverride: { ...profile, limits: { ...profile.limits, normalWeeklyMinutes: 2400 } } },
    { sourceOverride: { ...source, sha256: "a".repeat(64) } }]) {
    const f = await fixture(options); t.after(f.close);
    await assert.rejects(f.change(), TypeError);
    assert.equal(f.receipts().length, 0);
    assert.equal(f.writes(), 0);
  }
});

test("retail KV mutation: absent genuine approvals remain manual review despite a fully confirmed saved record", async t => {
  const f = await fixture({ approved: false }); t.after(f.close);
  f.insertShift("2026-10-06");
  const assessments = await f.change();
  assert.equal(assessments[0].outcome, "manual_review");
  assert.equal(assessments[0].findings.find(value => value.ruleId === "at.retail-kv.applicability" && value.scope.date === "2026-10-06").state, "unknown");
});

test("retail KV mutation: protected facts, references, all register identifiers and ciphertext never reach assessments or receipts", async t => {
  const f = await fixture(); t.after(f.close); f.insertShift("2026-10-06");
  const value = f.status(), payload = encrypted(value);
  const assessments = await f.change({ status: value, protectedPayload: payload });
  const serialized = JSON.stringify({ assessments, receipts: f.receipts() });
  for (const secret of ["PRIVATE", value.periods[0].id, value.periods[0].collectiveAgreementVersionId,
    value.periods[0].approvedAssignmentId, payload, "1990-01-01", "sourceReference", "agreementConfirmedBy"]) assert.equal(serialized.includes(secret), false, secret);
  assert.ok(assessments.every(value => value.findings.every(finding => finding.sourceRefs.length === 0)));
  assert.ok(assessments.every(value => value.findings.every(finding => finding.evidence.enforcementBasis === "controlled_retail_kv_monitor")));
});

test("retail KV mutation: identical and wholly disabled statuses cause no repository reads or writes", async () => {
  const f = await fixture();
  try {
    const enabled = f.status(), disabled = f.status({ planningEnabled: false });
    for (const [previousStatus, status] of [[null, null], [null, disabled], [enabled, enabled], [disabled, disabled]]) {
      assert.deepEqual(await record({}, { employeeNumber: EMPLOYEE, previousStatus, status }), []);
    }
  } finally { await f.close(); }
});

test("retail KV mutation: disabling and deletion append empty neutral receipts even for old out-of-source-year plans", async t => {
  const f = await fixture(); t.after(f.close); f.insertShift("2027-07-06");
  for (const status of [null, f.status({ planningEnabled: false })]) {
    const assessments = await f.change({ previousStatus: f.status(), status });
    assert.ok(assessments.some(value => value.periodFrom === "2027-07-05"));
    assert.ok(assessments.every(value => value.outcome === "pass" && value.findings.length === 0));
  }
});

test("retail KV mutation: failure on the second receipt restores ciphertext and removes audit and the first receipt", async t => {
  const f = await fixture(); t.after(f.close); f.insertShift("2026-10-06");
  const previousPayload = encrypted(f.status({ planningEnabled: false }));
  f.database.prepare("INSERT INTO personnel_sensitive_records(employee_number,social_security_lookup,protected_payload) VALUES(?,?,?)").run(EMPLOYEE, "", previousPayload);
  f.database.exec("CREATE TRIGGER synthetic_kv_receipt_failure BEFORE INSERT ON work_rule_evaluation_runs WHEN (SELECT count(*) FROM work_rule_evaluation_runs)>=1 BEGIN SELECT RAISE(ABORT,'synthetic second receipt failure'); END");
  await assert.rejects(f.change(), error => error.code === "PERSISTENCE_CHECK_VIOLATION");
  assert.equal(f.database.prepare("SELECT protected_payload FROM personnel_sensitive_records WHERE employee_number=?").get(EMPLOYEE).protected_payload, previousPayload);
  assert.equal(f.receipts().length, 0); assert.equal(f.writes(), 0);
});

test("retail KV mutation: unbound repositories, missing callbacks, missing cipher write and malformed envelopes abort the caller write", async t => {
  const f = await fixture(); t.after(f.close);
  for (const change of [{ normalize: null }, { boundTransform: bound => ({ ...bound, collectiveAgreements: {} }) },
    { storedPayload: encrypted(null) }]) await assert.rejects(f.change(change), TypeError);
  for (const protectedPayload of ["PRIVATE plaintext", "enc:v2:AAAA", "enc:v1:legacy", encrypted(null) + "=", null]) {
    await assert.rejects(f.change({ protectedPayload }));
  }
  await assert.rejects(record(f.repositories, { employeeNumber: EMPLOYEE, status: f.status(),
    protectedPayload: encrypted(f.status()), normalizeShifts: f.normalizeShifts }), TypeError);
  assert.equal(f.receipts().length, 0); assert.equal(f.writes(), 0);
});

test("retail KV mutation: invalid row dates and lossy or reassigned normalized shift facts roll back", async t => {
  const f = await fixture(); t.after(f.close); f.insertShift("2026-02-30");
  await assert.rejects(f.change(), TypeError);
  f.database.exec("UPDATE shifts SET shift_date='2026-10-06'");
  for (const normalize of [() => [], () => null, rows => f.normalizeShifts(rows).map(value => ({ ...value, employeeId: "00003" })),
    rows => f.normalizeShifts(rows).map(value => ({ ...value, locationId: "SYN-B" })),
    rows => f.normalizeShifts(rows).map(value => ({ ...value, startTime: "25:00" }))]) {
    await assert.rejects(f.change({ normalize }), TypeError);
  }
  assert.equal(f.receipts().length, 0); assert.equal(f.writes(), 0);
});

test("retail KV mutation: canonical receipt inputs are independent of repository order and bound to randomized protected bytes", async t => {
  const f = await fixture(); t.after(f.close);
  f.insertShift("2026-10-06"); f.insertShift("2026-10-07", "08:00", "12:00", "SYN-B");
  const value = f.status(), firstPayload = encrypted(value);
  await f.change({ status: value, protectedPayload: firstPayload });
  const first = f.receipts().find(row => row.period_from === WEEK).input_sha256;
  await f.change({ status: value, protectedPayload: firstPayload, normalize: rows => f.normalizeShifts(rows).reverse() });
  assert.equal(new Set(f.receipts().filter(row => row.period_from === WEEK).map(row => row.input_sha256)).size, 1);
  await f.change({ status: value, protectedPayload: encrypted(value) });
  assert.equal(new Set(f.receipts().filter(row => row.period_from === WEEK).map(row => row.input_sha256)).size, 2);
  assert.equal(f.receipts().some(row => row.input_sha256 === first), true);
});

test("retail KV mutation: a known adjacent Saturday is counted rather than replaced by an empty-week green", async t => {
  const f = await fixture(); t.after(f.close);
  f.insertShift("2026-10-10", "10:00", "15:00"); f.insertShift("2026-10-17", "08:00", "12:00");
  const assessments = await f.change();
  const week = assessments.find(value => value.periodFrom === WEEK);
  const saturday = week.findings.find(value => value.ruleId === "at.retail-kv.saturday-free"
    && value.evidence.precedingSaturday === "2026-10-10");
  assert.equal(saturday.state, "fail");
  assert.equal(saturday.evidence.nextSaturdayShiftCount, 1);
  assert.deepEqual(saturday.scope.dates, ["2026-10-10", "2026-10-17"]);
});

test("retail KV mutation: unquantified school, training, branch, appointment, meeting and other events remove a daily green without exposing notes", async t => {
  const f = await fixture(); t.after(f.close); f.insertShift("2026-10-06");
  const status = f.status(), protectedPayload = encrypted(status);
  const baseline = await f.change({ status, protectedPayload });
  assert.equal(baseline[0].findings.find(value => value.ruleId === "at.retail-kv.normal.daily" && value.scope.date === "2026-10-06").state, "pass");
  const inputHashes = new Set(f.receipts().filter(row => row.period_from === WEEK).map(row => row.input_sha256));
  for (const type of ["vocational_school", "school", "branch", "external_appointment", "team_meeting", "other"]) {
    f.database.exec("DELETE FROM week_options");
    f.database.prepare("INSERT INTO week_options(employee_number,week_start,date_from,date_to,option_type,note) VALUES(?,?,?,?,?,?)")
      .run(EMPLOYEE, WEEK, "2026-10-06", "2026-10-06", type, "PRIVATE medical or business note");
    const assessments = await f.change({ status, protectedPayload });
    const daily = assessments[0].findings.find(value => value.ruleId === "at.retail-kv.normal.daily" && value.scope.date === "2026-10-06");
    assert.equal(daily.state, "unknown", type);
    assert.equal(daily.evidence.unquantifiedAdditionalWork, true, type);
    assert.equal(JSON.stringify({ assessments, receipts: f.receipts() }).includes("PRIVATE medical or business note"), false);
    for (const row of f.receipts().filter(row => row.period_from === WEEK)) inputHashes.add(row.input_sha256);
  }
  assert.equal(inputHashes.size, 7);
});

test("retail KV mutation: a fully approved 182-day period is projected in every receipt and distant additional work removes its average pass", async t => {
  const f = await fixture(); t.after(f.close);
  const start = "2026-04-06", end = "2026-10-04";
  for (let offset = 0; offset < 182; offset += 1) f.insertShift(addDays(start, offset), "08:00", "08:30");
  const status = f.status({}, { validFrom: start, validTo: end, normalWorkModel: "durchrechnung26Weeks",
    agreementStatus: "documented", agreementValidFrom: start, agreementValidTo: "",
    averagingPeriod: { start, end, confirmed: true, carryMinutes: 60 } });
  const protectedPayload = encrypted(status);
  const baseline = await f.change({ status, protectedPayload });
  const first = baseline.find(value => value.periodFrom === start);
  const average = first.findings.find(value => value.ruleId === "at.retail-kv.averaging");
  assert.equal(average.state, "pass");
  assert.equal(average.evidence.completePeriod, true);
  assert.equal(average.evidence.actualMinutesPerWeek, (182 * 30 + 60) / 26);
  assert.deepEqual(average.scope, { type: "rolling_weeks", start, end, windowWeeks: 26 });
  const last = baseline.find(value => value.periodFrom === "2026-09-28");
  assert.equal(last.findings.find(value => value.ruleId === "at.retail-kv.averaging").state, "pass");
  const firstInput = f.receipts().find(row => row.period_from === start).input_sha256;
  f.database.prepare("INSERT INTO week_options(employee_number,week_start,date_from,date_to,option_type,note) VALUES(?,?,?,?,?,?)")
    .run(EMPLOYEE, "2026-09-21", "2026-09-25", "2026-09-25", "school", "PRIVATE distant training note");
  const updated = await f.change({ status, protectedPayload });
  const updatedFirst = updated.find(value => value.periodFrom === start);
  assert.equal(updatedFirst.findings.find(value => value.ruleId === "at.retail-kv.averaging").state, "unknown");
  assert.equal(new Set(f.receipts().filter(row => row.period_from === start).map(row => row.input_sha256)).size, 2);
  assert.ok(f.receipts().some(row => row.input_sha256 === firstInput));
  assert.equal(JSON.stringify({ updated, receipts: f.receipts() }).includes("PRIVATE distant training note"), false);
});
