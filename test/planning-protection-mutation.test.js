"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { recordPlanningProtectionChange: record } = require("../lib/work-rules/planning-protection-mutation");
const { normalizeProtectionStatus } = require("../lib/personnel-protection-status");
const { canonicalSha256 } = require("../lib/work-rules/receipt");
const { mondayOfWeek } = require("../lib/work-rules/calendar");
const { seedBuiltinWorkRuleProfiles } = require("../lib/work-rules/store");
const { PLANNING_PROTECTION_PROFILE, PLANNING_PROTECTION_SOURCES,
  PLANNING_PROTECTION_RULE_DEFINITIONS } = require("../lib/work-rules/planning-protection");
const { openSqliteApplicationPersistence } = require("../lib/persistence/sqlite/provider");
const { SQLITE_APPLICATION_CATALOG } = require("../lib/persistence/sqlite/application-catalog");
const { createApplicationRepositories } = require("../lib/persistence/application-repositories");
const { ensureSqliteWorkRuleStoreSchema } = require("../lib/persistence/sqlite/operations/work-rule-store-schema");
const { seedCoreFixture } = require("../test-support/postgresql-migration/sqlite-source");
const baseline = require("../lib/persistence/postgresql/contracts/source-schema-v09237.json");
const EMPLOYEE = "00002", WEEK = "2032-01-05";

function protectedStatus(overrides = {}) {
  return normalizeProtectionStatus({ version: 1, planningEnabled: true, periods: [{
    id: "private-period-opaque", phase: "pregnancy", confirmed: true,
    validFrom: WEEK, validTo: "2033-12-31", referenceId: "HR:PRIVATE_REFERENCE", normalDailyMinutes: 480,
  }], ...overrides });
}

// Real randomized AES-GCM envelope in the existing enc:v2 format; no stored
// credentials or personal data are used or read by this fixture.
function encryptSynthetic(status) {
  const keyId = Buffer.from("synthetic"), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", crypto.randomBytes(32), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ employment: { protectionStatus: status } })), cipher.final()]);
  return "enc:v2:" + Buffer.concat([Buffer.from([keyId.length]), keyId, iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}

async function fixture({ seedProfile = true } = {}) {
  const app = openSqliteApplicationPersistence({ databasePath: ":memory:", catalog: SQLITE_APPLICATION_CATALOG });
  const tables = new Set(["cost_center_types", "cost_centers", "cost_center_type_positions", "locations",
    "positions", "departments", "employees", "settings", "global_day_blocks", "shifts", "week_options",
    "personnel_sensitive_records", "audit_log", "work_rule_profiles", "work_rule_profile_versions", "work_rule_evaluation_runs"]);
  for (const object of baseline.objects.filter(object => object.type === "table" && tables.has(object.name))) app.database.exec(object.sql);
  app.database.exec("ALTER TABLE week_options ADD COLUMN school_details_json TEXT");
  ensureSqliteWorkRuleStoreSchema(app.database);
  seedCoreFixture(app.database, 3);
  app.database.exec("INSERT INTO cost_centers(id,code,name,type,cost_center_type_id) VALUES('synthetic-b','SYN-B','Synthetic B','branch','branch'); INSERT INTO locations(id,name,cost_center_id) VALUES('SYN-B','Synthetic B','synthetic-b')");
  const repositories = createApplicationRepositories(app.provider);
  if (seedProfile) await seedBuiltinWorkRuleProfiles(repositories.workRules,
    [{ profile: PLANNING_PROTECTION_PROFILE, rules: Object.values(PLANNING_PROTECTION_RULE_DEFINITIONS),
      sources: Object.values(PLANNING_PROTECTION_SOURCES) }], PLANNING_PROTECTION_SOURCES);
  function insertShift(date, start = "08:00", end = "12:00", location = "18", employeeNumber = EMPLOYEE) {
    return Number(app.database.prepare("INSERT INTO shifts(employee_number,location_id,shift_date,start_time,end_time) VALUES(?,?,?,?,?)")
      .run(employeeNumber, location, date, start, end).lastInsertRowid);
  }
  const normalizeShifts = rows => rows.map(row => ({ id: String(row.id), employeeId: row.employee_number,
    date: row.shift_date, startTime: row.start_time, endTime: row.end_time, breakMinutes: 0,
    breakSource: "none", locationId: row.location_id, departmentId: row.department_id }));
  async function change({ previousStatus = null, status = protectedStatus(), protectedPayload = encryptSynthetic(status),
    normalize = normalizeShifts, boundTransform = bound => bound } = {}) {
    return app.provider.transaction(async executor => {
      const bound = createApplicationRepositories(executor);
      await bound.organizationPersonnel.upsertPersonnelSensitiveRecord({ employeeNumber: EMPLOYEE,
        socialSecurityLookup: "", protectedPayload, actor: "synthetic-hr" });
      await bound.organizationPersonnel.insertAudit("synthetic-hr", "personnel-record.update", "employee", EMPLOYEE,
        JSON.stringify({ fields: ["employment.protectionStatus"] }));
      return record(boundTransform(bound), { employeeNumber: EMPLOYEE, previousStatus, status,
        protectedPayload, actor: "synthetic-hr", normalizeShifts: normalize });
    }, { isolation: "serializable" });
  }
  return { ...app, repositories, insertShift, change, normalizeShifts,
    receipts: () => app.database.prepare("SELECT * FROM work_rule_evaluation_runs ORDER BY period_from,id").all(),
    async close() { await app.provider.close(); app.database.close(); } };
}

test("planning protection mutation: all known weeks, including distant future and all locations, share the caller transaction", async () => {
  const f = await fixture();
  try {
    f.insertShift("2032-01-06", "08:00", "13:00", "18");
    f.insertShift("2032-01-06", "13:00", "18:00", "SYN-B");
    f.insertShift("2033-07-05");
    f.insertShift("2033-10-04", "08:00", "23:00", "18", "00003");
    let callbackBound = false;
    const assessments = await f.change({ normalize: async (rows, repositories) => {
      callbackBound = typeof repositories.workRules.transaction !== "function";
      assert.ok(rows.every(row => row.employee_number === EMPLOYEE));
      return f.normalizeShifts(rows);
    } });
    assert.equal(callbackBound, true);
    assert.deepEqual(assessments.map(value => value.periodFrom), [WEEK, mondayOfWeek("2033-07-05")]);
    assert.equal(f.receipts().length, 2);
    const finding = assessments[0].findings.find(value => value.ruleId === "at.protection.daily-max");
    assert.equal(finding.state, "fail"); assert.equal(finding.evidence.actualMinutes, 600);
    assert.equal(f.database.prepare("SELECT count(*) n FROM personnel_sensitive_records").get().n, 1);
    assert.equal(f.database.prepare("SELECT count(*) n FROM audit_log").get().n, 1);
  } finally { await f.close(); }
});

test("planning protection mutation: receipt contains only neutral findings and hides status, references, period ids and ciphertext", async () => {
  const f = await fixture();
  try {
    f.insertShift("2032-01-06");
    const status = protectedStatus(), protectedPayload = encryptSynthetic(status);
    const assessments = await f.change({ status, protectedPayload });
    const receipt = f.receipts()[0], output = JSON.stringify({ assessments, receipt });
    for (const secret of ["pregnancy", "postpartum", "breastfeeding", "employment_prohibition",
      "private-period-opaque", "HR:PRIVATE_REFERENCE", protectedPayload, "MSchG", "ris.mschg.", "sourceReference"]) {
      assert.equal(output.includes(secret), false, secret);
    }
    assert.ok(assessments[0].findings.every(value => value.sourceRefs.length === 0));
    assert.ok(assessments[0].findings.every(value => value.evidence.enforcementBasis === "controlled_protection_monitor"));
    assert.equal(receipt.scope_type, "employee"); assert.equal(receipt.scope_key, EMPLOYEE);
  } finally { await f.close(); }
});

test("planning protection mutation: overnight Sunday carryover counts on Monday without leaking dates outside each receipt week", async () => {
  const f = await fixture();
  try {
    f.insertShift("2032-01-04", "22:00", "02:00");
    f.insertShift(WEEK, "08:00", "12:00");
    const assessments = await f.change();
    assert.deepEqual(assessments.map(value => value.periodFrom), ["2031-12-29", WEEK]);
    const monday = assessments.find(value => value.periodFrom === WEEK);
    const finding = monday.findings.find(value => value.ruleId === "at.protection.daily-max" && value.scope.date === WEEK);
    assert.ok(finding);
    assert.equal(finding.evidence.actualMinutes, 360);
    for (const assessment of assessments) {
      for (const finding of assessment.findings.filter(value => value.scope.date)) {
        assert.ok(finding.scope.date >= assessment.periodFrom && finding.scope.date <= assessment.periodTo);
      }
    }
    assert.equal(f.receipts().length, 2);
  } finally { await f.close(); }
});

test("planning protection mutation: repository row ordering cannot change the canonical receipt inputs", async () => {
  const f = await fixture();
  try {
    f.insertShift("2032-01-06", "08:00", "12:00", "18");
    f.insertShift("2032-01-07", "08:00", "12:00", "SYN-B");
    const status = protectedStatus(), protectedPayload = encryptSynthetic(status);
    await f.change({ status, protectedPayload });
    const first = f.receipts().find(row => row.period_from === WEEK).input_sha256;
    await f.change({ status, protectedPayload, normalize: rows => f.normalizeShifts(rows).reverse() });
    assert.equal(new Set(f.receipts().filter(row => row.period_from === WEEK).map(row => row.input_sha256)).size, 1);
    assert.equal(f.receipts()[1].input_sha256, first);
  } finally { await f.close(); }
});

test("planning protection mutation: randomized encrypted basis changes the input hash even for identical neutral facts", async () => {
  const f = await fixture();
  try {
    f.insertShift("2032-01-06");
    const status = protectedStatus(), first = encryptSynthetic(status), second = encryptSynthetic(status);
    await f.change({ status, protectedPayload: first });
    const hash1 = f.receipts().find(row => row.period_from === WEEK).input_sha256;
    await f.change({ status, protectedPayload: second });
    const hashes = f.receipts().filter(row => row.period_from === WEEK).map(row => row.input_sha256);
    assert.equal(new Set(hashes).size, 2);
    assert.notEqual(hash1, canonicalSha256(status));
    for (const phase of ["unknown", "pregnancy", "postpartum", "breastfeeding", "not_applicable", "employment_prohibition"]) {
      assert.notEqual(hash1, canonicalSha256({ phase }));
    }
    await f.change({ status, protectedPayload: first });
    assert.equal(f.receipts().filter(row => row.period_from === WEEK && row.input_sha256 === hash1).length, 2);
  } finally { await f.close(); }
});

test("planning protection mutation: identical and wholly disabled statuses skip all receipt reads and writes", async () => {
  const disabled = protectedStatus({ planningEnabled: false }), enabled = protectedStatus();
  for (const [previousStatus, status] of [[null, null], [null, disabled], [enabled, enabled], [disabled, disabled]]) {
    assert.deepEqual(await record({}, { employeeNumber: EMPLOYEE, previousStatus, status }), []);
  }
});

test("planning protection mutation: disabling or deleting an active status records neutral empty monitor findings", async () => {
  const f = await fixture();
  try {
    f.insertShift("2032-01-06");
    for (const status of [protectedStatus({ planningEnabled: false }), null]) {
      const assessments = await f.change({ previousStatus: protectedStatus(), status });
      assert.equal(assessments[0].outcome, "pass"); assert.deepEqual(assessments[0].findings, []);
      assert.match(assessments[0].disclaimer, /aktiv modellierten/);
    }
    assert.equal(f.receipts().length, 2);
  } finally { await f.close(); }
});

test("planning protection mutation: old and new earliest boundary weeks and current no-plan week are retained", async () => {
  const f = await fixture();
  try {
    const previousStatus = protectedStatus(), status = protectedStatus({ periods: [{
      ...protectedStatus().periods[0], id: "new-private-period", validFrom: "2032-03-01",
    }] });
    const assessments = await f.change({ previousStatus, status });
    const current = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Vienna", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    assert.deepEqual(assessments.map(value => value.periodFrom), [...new Set([mondayOfWeek(current), WEEK, "2032-03-01"])].sort());
    assert.ok(assessments.every(value => value.periodTo > value.periodFrom));
  } finally { await f.close(); }
});

test("planning protection mutation: school presence requests combination review without persisting school private fields", async () => {
  const f = await fixture();
  try {
    f.insertShift("2032-01-06");
    f.database.prepare("INSERT INTO week_options(employee_number,week_start,date_from,date_to,option_type,note,school_details_json) VALUES(?,?,?,?,?,?,?)")
      .run(EMPLOYEE, WEEK, "2032-01-06", "2032-01-06", "vocational_school", "PRIVATE_SCHOOL_NOTE", '{"sourceReference":"PRIVATE_SCHOOL_REFERENCE"}');
    const assessments = await f.change();
    assert.equal(assessments[0].findings.find(value => value.ruleId === "at.protection.school-combination").state, "unknown");
    assert.equal(JSON.stringify(f.receipts()).includes("PRIVATE_SCHOOL"), false);
  } finally { await f.close(); }
});

test("planning protection mutation: a caller receipt error rolls back encrypted status, audit and earlier receipts", async () => {
  const f = await fixture();
  try {
    f.insertShift("2032-01-06"); f.insertShift("2033-07-05");
    const previousPayload = encryptSynthetic(protectedStatus({ planningEnabled: false }));
    f.database.prepare("INSERT INTO personnel_sensitive_records(employee_number,social_security_lookup,protected_payload) VALUES(?,?,?)")
      .run(EMPLOYEE, "", previousPayload);
    f.database.exec("CREATE TRIGGER synthetic_protection_receipt_failure BEFORE INSERT ON work_rule_evaluation_runs WHEN NEW.period_from>'2033-01-01' BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END");
    await assert.rejects(f.change(), error => error.code === "PERSISTENCE_CHECK_VIOLATION");
    assert.equal(f.database.prepare("SELECT protected_payload FROM personnel_sensitive_records WHERE employee_number=?").get(EMPLOYEE).protected_payload, previousPayload);
    assert.equal(f.database.prepare("SELECT count(*) n FROM audit_log").get().n, 0);
    assert.equal(f.receipts().length, 0);
  } finally { await f.close(); }
});

test("planning protection mutation: missing profile, missing bound reads and missing normalizer fail closed", async () => {
  const noProfile = await fixture({ seedProfile: false });
  try { await assert.rejects(noProfile.change(), TypeError); assert.equal(noProfile.receipts().length, 0); }
  finally { await noProfile.close(); }
  const f = await fixture();
  try {
    await assert.rejects(f.change({ normalize: null }), TypeError);
    await assert.rejects(f.change({ boundTransform: bound => ({ ...bound, planningSettings: {} }) }), TypeError);
    await assert.rejects(record(f.repositories, { employeeNumber: EMPLOYEE, previousStatus: null, status: protectedStatus(),
      protectedPayload: encryptSynthetic(protectedStatus()), normalizeShifts: f.normalizeShifts }), TypeError);
    assert.equal(f.receipts().length, 0);
    assert.equal(f.database.prepare("SELECT count(*) n FROM personnel_sensitive_records").get().n, 0);
  } finally { await f.close(); }
});

test("planning protection mutation: plaintext or malformed ciphertext cannot become the protected input fingerprint", async () => {
  const f = await fixture();
  try {
    for (const protectedPayload of ["pregnancy", "", null, "enc:v2:pregnancy", "enc:v2:AAAA", "enc:v1:legacy", encryptSynthetic(null) + "="]) {
      await assert.rejects(f.change({ protectedPayload }), TypeError);
    }
    assert.equal(f.receipts().length, 0);
  } finally { await f.close(); }
});

test("planning protection mutation: invalid stored dates and lossy shift normalization abort the caller write", async () => {
  const f = await fixture();
  try {
    f.insertShift("2032-02-30");
    await assert.rejects(f.change(), TypeError);
    f.database.exec("UPDATE shifts SET shift_date='2032-01-06'");
    for (const normalize of [() => [], () => null, rows => f.normalizeShifts(rows).map(row => ({ ...row, employeeId: "00003" }))]) {
      await assert.rejects(f.change({ normalize }), TypeError);
    }
    assert.equal(f.receipts().length, 0);
    assert.equal(f.database.prepare("SELECT count(*) n FROM audit_log").get().n, 0);
  } finally { await f.close(); }
});

test("planning protection mutation: native immutability blocks changes to the receipt's profile snapshot", async () => {
  const f = await fixture();
  try {
    const before = f.database.prepare("SELECT content_sha256 FROM work_rule_profile_versions").get().content_sha256;
    assert.throws(() => f.database.exec("UPDATE work_rule_profile_versions SET content_sha256='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'"), /immutable/);
    assert.equal(f.database.prepare("SELECT content_sha256 FROM work_rule_profile_versions").get().content_sha256, before);
    assert.equal(f.receipts().length, 0);
    assert.ok((await f.change()).length > 0);
  } finally { await f.close(); }
});
