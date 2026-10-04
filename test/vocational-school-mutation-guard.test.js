"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { captureVocationalSchoolMutationGuard: capture } = require("../lib/work-rules/vocational-school-mutation-guard");
const { RETAIL_KV_PROFILE, RETAIL_KV_RULES, RETAIL_KV_SOURCES } = require("../lib/work-rules/retail-kv");
const { versionSnapshot } = require("../lib/work-rules/store");
const { canonicalSha256 } = require("../lib/work-rules/receipt");
const kvId = `${RETAIL_KV_PROFILE.id}@${RETAIL_KV_PROFILE.version}`;
const kvSnapshot = versionSnapshot(RETAIL_KV_PROFILE, Object.values(RETAIL_KV_RULES), Object.values(RETAIL_KV_SOURCES));
const { profileId: ignoredProfileId, version: ignoredVersion, sources: kvSources, ...kvStoredRules } = kvSnapshot;
const kvRow = { id: kvId, profileId: RETAIL_KV_PROFILE.id, version: RETAIL_KV_PROFILE.version, layer: "collective_agreement", status: "published", validFrom: RETAIL_KV_PROFILE.validFrom, validTo: RETAIL_KV_PROFILE.validTo, contentSha256: canonicalSha256(kvSnapshot), rules: kvStoredRules, sources: kvSources };

const target = { employeeNumber: "SYNTHETIC", weekStart: "2032-07-05" };
const futureTarget = { ...target, throughWeekStart: "2032-10-25" };

function fixture() {
  const basis = {
    employee: { personnel_number: "SYNTHETIC", position_id: "synthetic-apprentice", position_employment_classification: "apprentice", home_location_id: "SYNTHETIC-A", preferred_department_id: 1 },
    protectedRecord: { employee_number: "SYNTHETIC", protected_payload: "PRIVATE_SYNTHETIC_CIPHERTEXT", social_security_lookup: "PRIVATE_SYNTHETIC_LOOKUP" },
    settings: [{ key: "break_rule_enabled", value: "1" }, { key: "break_after_minutes", value: "360" }],
    shifts: [{ id: 1, employee_number: "SYNTHETIC", location_id: "SYNTHETIC-A", department_id: 1, duty_code: "", shift_date: "2032-07-06", start_time: "13:00", end_time: "17:00" }],
    options: [{ id: 1, employee_number: "SYNTHETIC", date_from: "2032-07-06", date_to: "2032-07-06", option_type: "vocational_school", all_day: 0, start_time: "08:00", end_time: "12:00", school_details_json: JSON.stringify({ version: 1, kind: "regular", confirmed: true, sourceReference: "PRIVATE_SYNTHETIC_SCHOOL_BASIS" }) }],
    locations: [{ id: "SYNTHETIC-A", active: 1, day_settings_json: JSON.stringify({ tuesday: { lunchEnabled: true, lunchStart: "12:00", lunchEnd: "12:30" } }) }, { id: "SYNTHETIC-B", active: 1, day_settings_json: "{}" }],
    departments: [{ id: 1, location_id: "SYNTHETIC-A", active: 1 }],
    holidays: [{ id: 1, location_id: "SYNTHETIC-A", block_date: "2032-07-06", is_public_holiday: 0 }],
    legacyAssignments: [{ id: "synthetic-legacy", profileVersionId: "synthetic-profile@1", active: 1, scopeType: "employee", scopeKey: "SYNTHETIC", validFrom: "2032-01-01", validTo: null, enforcementMode: "monitor", applicabilityConfirmed: true }],
    governedRevisions: [{ id: "synthetic-revision", profile_version_id: "synthetic-custom@1", expanded_scopes_json: '[{"type":"location","key":"SYNTHETIC-A"}]', valid_from: "2032-01-01", valid_to: null, enforcement_mode: "monitor", applicability_confirmed: 1 }],
    governedEvents: [{ id: "synthetic-event", assignment_revision_id: "synthetic-revision", event_type: "activated", effective_on: "2032-01-01", receipt_sha256: "a".repeat(64) }],
    governanceEvents: [{ id: "synthetic-governance", aggregate_type: "work_rule_assignment_revision", aggregate_id: "synthetic-revision", event_type: "activated", receipt_sha256: "d".repeat(64) }],
    profiles: { "synthetic-profile@1": { id: "synthetic-profile@1", contentSha256: "b".repeat(64), rules: { limits: { daily: 480 } }, sources: [{ id: "synthetic-law", version: "1" }] }, "synthetic-custom@1": { id: "synthetic-custom@1", contentSha256: "c".repeat(64), rules: { limits: { daily: 450 } }, sources: [] } },
  };
  basis.profiles[kvId] = structuredClone(kvRow);
  const calls = [];
  function read(name, value) {
    return async (...args) => { calls.push({ name, args }); return structuredClone(typeof value === "function" ? value(...args) : basis[value]); };
  }
  // Contract-level read fixture; no native database claim for these unit cases.
  const { createPersistenceProviderFacade } = require("../lib/persistence/contract");
  const { SQLITE_CAPABILITIES } = require("../lib/persistence/sqlite/provider");
  const { createWorkRuleStoreRepository } = require("../lib/persistence/repositories/work-rule-store");
  const access = createPersistenceProviderFacade({ providerId: "sqlite", capabilities: SQLITE_CAPABILITIES,
    query: async (statement, parameters) => {
      if (statement.id === "work-rule-store.get-profile-version") {
        calls.push({ name: "profile", args: [parameters.id] });
        const row = basis.profiles[parameters.id]; if (!row) return [];
        return [structuredClone({ id: row.id, profileId: row.profileId || row.id.split("@")[0], version: row.version || "1",
          layer: row.layer || "law", status: row.status || "published", validFrom: row.validFrom || "2026-01-01", validTo: row.validTo || null,
          rules: row.rules, sources: row.sources, contentSha256: row.contentSha256, profileName: row.profileName || row.id })];
      }
      if (statement.id === "work-rule-store.list-all-assignments") {
        calls.push({ name: "legacyAssignments", args: [true] });
        return basis.legacyAssignments.map(row => structuredClone({ ...row, profileId: row.profileVersionId.split("@")[0], profileName: "Synthetic",
          profileVersion: "1", applicabilityConfirmed: row.applicabilityConfirmed === true, active: !!row.active,
          confirmedBy: "SYNTHETIC-HR", confirmedAt: "2032-01-01", createdBy: "SYNTHETIC-HR", createdAt: "2032-01-01" }));
      }
      throw new Error("Unexpected synthetic read " + statement.id);
    }, execute: async () => { throw new Error("Unit read fixture must not write"); },
    beginTransaction: async () => { throw new Error("Unit read fixture must not start a transaction"); }, close: async () => {} });
  const repositories = {
    planningSettings: {
      listSettings: read("settings", "settings"), listGlobalDayBlocks: read("holidays", "holidays"),
      listWorkRuleShiftsForRange: read("shifts", "shifts"), listOverlappingWeekOptions: read("options", "options"),
    },
    absenceManagement: { workRuleEvaluationEmployee: read("employee", "employee") },
    organizationPersonnel: { getPersonnelSensitiveRecord: read("protectedRecord", "protectedRecord"), listLocations: read("locations", "locations"), listDepartments: read("departments", "departments") },
    workRules: createWorkRuleStoreRepository(access),
    collectiveAgreements: { listVersions: read("kvVersions", () => []), listAssignments: read("kvAssignments", () => []), getScopeTarget: read("kvScopeTarget", () => null) },
    workRuleGovernance: { allCollectiveAssignmentEvents: read("kvEvents", () => []), collectiveAssignment: read("kvAssignment", () => null), businessUnitScopes: read("kvScopes", () => []), activeScopeTarget: read("kvActiveScopeTarget", () => null), reviewRequestById: read("kvReviewRequest", () => null), reviewDecisions: read("kvReviewDecisions", () => []), conflictRunById: read("kvConflictRun", () => null), governanceEventsForReview: read("kvReviewEvents", () => []), collectiveAssignmentEvents: read("kvAssignmentEvents", () => []), schemaTables: read("schemaTables", () => []), assignmentRevisionsWithProfile: read("governedRevisions", "governedRevisions"), assignmentEvents: read("governedEvents", id => basis.governedEvents.filter(event => event.assignment_revision_id === id)), listGovernanceEvents: read("governanceEvents", "governanceEvents") },
  };
  return { basis, repositories, calls };
}

test("guard returns only a canonical SHA, handles target order/duplicates and never decrypts private fields", async () => {
  const f = fixture();
  const digest = await capture(f.repositories, [target, futureTarget, target]);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest, await capture(f.repositories, [futureTarget, target]));
  assert.ok(!digest.includes("PRIVATE_SYNTHETIC"));
  assert.equal(f.calls.filter(call => call.name === "protectedRecord").length, 2, "one protected read per employee per capture");
  for (const call of f.calls.filter(call => call.name === "options")) {
    assert.equal(call.args[0].existingId, 0); assert.equal(call.args[0].excludedGroupId, null);
  }
  assert.ok(f.calls.filter(call => call.name === "legacyAssignments").every(call => call.args[0] === true));
});

for (const [name, change] of Object.entries({
  "shift time": basis => { basis.shifts[0].end_time = "18:00"; },
  "shift department": basis => { basis.shifts[0].department_id = 2; },
  "shift duty": basis => { basis.shifts[0].duty_code = "synthetic-sales"; },
  "removed shift": basis => { basis.shifts = []; },
  "new shift": basis => { basis.shifts.push({ ...basis.shifts[0], id: 2, shift_date: "2032-07-07" }); },
  "school confirmation/source/JSON": basis => { basis.options[0].school_details_json = '{"version":1,"confirmed":false}'; },
  "school date": basis => { basis.options[0].date_to = "2032-07-07"; },
  "school time": basis => { basis.options[0].end_time = "13:00"; },
  "school removed": basis => { basis.options = []; },
  "school added": basis => { basis.options.push({ ...basis.options[0], id: 2, date_from: "2032-07-07", date_to: "2032-07-07" }); },
  "position classification": basis => { basis.employee.position_employment_classification = "adult"; },
  "home location": basis => { basis.employee.home_location_id = "SYNTHETIC-B"; },
  "preferred department": basis => { basis.employee.preferred_department_id = 2; },
  "encrypted personal facts": basis => { basis.protectedRecord.protected_payload = "PRIVATE_SYNTHETIC_CHANGED_CIPHERTEXT"; },
  "missing personal record": basis => { basis.protectedRecord = null; },
  "missing employee": basis => { basis.employee = null; },
  "global break rule": basis => { basis.settings[0].value = "0"; },
  "location lunch window": basis => { basis.locations[0].day_settings_json = '{"tuesday":{"lunchEnabled":false}}'; },
  "location status": basis => { basis.locations[0].active = 0; },
  "department status": basis => { basis.departments[0].active = 0; },
  "holiday status": basis => { basis.holidays[0].is_public_holiday = 1; },
  "legacy activation": basis => { basis.legacyAssignments[0].active = 0; },
  "legacy applicability": basis => { basis.legacyAssignments[0].applicabilityConfirmed = false; },
  "legacy enforcement": basis => { basis.legacyAssignments[0].enforcementMode = "enforced"; },
  "legacy version binding": basis => { basis.legacyAssignments[0].profileVersionId = "synthetic-profile@2"; },
  "governed version binding": basis => { basis.governedRevisions[0].profile_version_id = "synthetic-custom@2"; },
  "governed scope expansion": basis => { basis.governedRevisions[0].expanded_scopes_json = '[]'; },
  "governed activation event": basis => { basis.governedEvents[0].event_type = "deactivated"; },
  "new governed lifecycle event": basis => { basis.governedEvents.push({ ...basis.governedEvents[0], id: "synthetic-terminal", event_type: "superseded", effective_on: "2032-07-01" }); },
  "new governed assignment": basis => { basis.governedRevisions.push({ ...basis.governedRevisions[0], id: "synthetic-revision-2" }); },
  "governance receipt event": basis => { basis.governanceEvents[0].receipt_sha256 = "e".repeat(64); },
  "custom rules with unchanged claimed SHA": basis => { basis.profiles["synthetic-custom@1"].rules.limits.daily = 420; },
  "profile sources with unchanged claimed SHA": basis => { basis.profiles["synthetic-profile@1"].sources[0].version = "2"; },
  "missing version snapshot": basis => { delete basis.profiles["synthetic-custom@1"]; },
})) {
  test(`guard detects concurrent change: ${name}`, async () => {
    const f = fixture(), before = await capture(f.repositories, [target]);
    change(f.basis);
    assert.notEqual(await capture(f.repositories, [target]), before);
  });
}

test("future horizon includes a newly planned previously empty week and the final Sunday", async () => {
  const f = fixture(), before = await capture(f.repositories, [futureTarget]);
  f.basis.shifts.push({ ...f.basis.shifts[0], id: 2, shift_date: "2032-10-31", location_id: "SYNTHETIC-B" });
  assert.notEqual(await capture(f.repositories, [futureTarget]), before);
  assert.deepEqual(f.calls.find(call => call.name === "shifts").args[0], { dateFrom: "2032-03-15", dateTo: "2032-11-07" });
  const withNewShift = await capture(f.repositories, [futureTarget]);
  f.basis.locations[1].day_settings_json = '{"sunday":{"lunchEnabled":true}}';
  assert.notEqual(await capture(f.repositories, [futureTarget]), withNewShift, "future shift location settings must be captured");
});

test("guard captures the separate planning protection snapshot and detects changed actual rules", async () => {
  const f = fixture();
  const id = "at-planning-protection-monitor@2026.4";
  f.basis.profiles[id] = { id, contentSha256: "f".repeat(64), rules: { limits: { daily: 540 } }, sources: [] };
  const before = await capture(f.repositories, [target]);
  assert.ok(f.calls.some(call => call.name === "profile" && call.args[0] === id));
  f.basis.profiles[id].rules.limits.daily = 480;
  assert.notEqual(await capture(f.repositories, [target]), before);
  const changed = await capture(f.repositories, [target]);
  delete f.basis.profiles[id];
  assert.notEqual(await capture(f.repositories, [target]), changed);
});

test("row order, unrelated personnel shifts and facts outside the protected horizon do not change the guard", async () => {
  const f = fixture(), before = await capture(f.repositories, [target]);
  f.basis.settings.reverse(); f.basis.locations.reverse();
  f.basis.shifts.push({ ...f.basis.shifts[0], id: 2, employee_number: "UNRELATED_SYNTHETIC" });
  f.basis.shifts.push({ ...f.basis.shifts[0], id: 3, shift_date: "2032-07-19" });
  f.basis.options.push({ ...f.basis.options[0], id: 2, employee_number: "UNRELATED_SYNTHETIC" });
  f.basis.options.push({ ...f.basis.options[0], id: 3, date_from: "2032-03-14", date_to: "2032-03-14" });
  f.basis.holidays.push({ id: 2, location_id: "SYNTHETIC-A", block_date: "2032-03-14", is_public_holiday: 1 });
  f.basis.locations.find(row => row.id === "SYNTHETIC-B").day_settings_json = "unrelated";
  assert.equal(await capture(f.repositories, [target]), before);
});

test("invalid or incomplete captures fail closed without returning partial fingerprints", async () => {
  for (const targets of [null, [{}], [{ ...target, employeeNumber: "" }], [{ ...target, weekStart: "2032-07-06" }], [{ ...target, weekStart: "2032-02-30" }], [{ ...target, throughWeekStart: "2032-06-28" }], [{ ...target, throughWeekStart: null }]]) {
    await assert.rejects(capture(fixture().repositories, targets), TypeError);
  }
  const f = fixture(); delete f.repositories.workRuleGovernance.assignmentEvents;
  await assert.rejects(capture(f.repositories, [target]), TypeError);
  const failing = fixture(); failing.repositories.organizationPersonnel.getPersonnelSensitiveRecord = async () => { throw new Error("synthetic read unavailable"); };
  await assert.rejects(capture(failing.repositories, [target]), /synthetic read unavailable/);
});

test("guard performs qualified existing repository reads inside a real SQLite transaction without nested transactions", async () => {
  const { openSqliteApplicationPersistence } = require("../lib/persistence/sqlite/provider");
  const { SQLITE_APPLICATION_CATALOG } = require("../lib/persistence/sqlite/application-catalog");
  const { createApplicationRepositories } = require("../lib/persistence/application-repositories");
  const { ensureSqliteApplicationSchema } = require("../lib/persistence/sqlite/operations/application-schema");
  const { seedBuiltinWorkRuleProfiles } = require("../lib/work-rules/store");
  const { database, provider } = openSqliteApplicationPersistence({ databasePath: ":memory:", catalog: SQLITE_APPLICATION_CATALOG });
  try {
    ensureSqliteApplicationSchema(database);
    await seedBuiltinWorkRuleProfiles(createApplicationRepositories(provider).workRules, [{ profile: RETAIL_KV_PROFILE, rules: Object.values(RETAIL_KV_RULES), sources: Object.values(RETAIL_KV_SOURCES) }]);
    const before = await capture(createApplicationRepositories(provider), [futureTarget]);
    const inTransaction = await provider.transaction(executor => capture(createApplicationRepositories(executor), [futureTarget]));
    assert.equal(inTransaction, before);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM week_options").get().n, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM personnel_sensitive_records").get().n, 0);
  } finally { await provider.close(); database.close(); }
});


test("guard includes the KV version snapshot and rejects damaged actual rules", async () => {
  const f = fixture(); await capture(f.repositories, [target]);
  assert.ok(f.calls.some(call => call.name === "profile" && call.args[0] === kvId));
  f.basis.profiles[kvId].rules.limits = { changedSyntheticLimit: 123 };
  await assert.rejects(capture(f.repositories, [target]), /Prüfsumme/);
});

test("guard covers the final evaluated week's complete KV following week", async () => {
  const f = fixture(); const before = await capture(f.repositories, [futureTarget]);
  f.basis.shifts.push({ ...f.basis.shifts[0], id: 3, shift_date: "2032-11-07", location_id: "SYNTHETIC-B" });
  assert.notEqual(await capture(f.repositories, [futureTarget]), before);
  const after = await capture(f.repositories, [futureTarget]);
  f.basis.options.push({ ...f.basis.options[0], id: 4, date_from: "2032-11-07", date_to: "2032-11-07" });
  assert.notEqual(await capture(f.repositories, [futureTarget]), after);
});

test("guard rejects incomplete or failed shared KV reads instead of certifying unknown", async () => {
  for (const [name, methods] of Object.entries({ collectiveAgreements: ["listVersions", "listAssignments", "getScopeTarget"], workRuleGovernance: ["allCollectiveAssignmentEvents", "collectiveAssignment", "businessUnitScopes", "activeScopeTarget", "reviewRequestById", "reviewDecisions", "conflictRunById", "governanceEventsForReview", "collectiveAssignmentEvents", "schemaTables"] })) {
    for (const method of methods) {
      const f = fixture(); delete f.repositories[name][method];
      await assert.rejects(capture(f.repositories, [target]), TypeError);
    }
  }
  const f = fixture(); f.repositories.collectiveAgreements.listVersions = async () => { throw new Error("synthetic KV source read failed"); };
  await assert.rejects(capture(f.repositories, [target]), /synthetic KV source read failed/);
  const missing = fixture(); delete missing.basis.profiles[kvId];
  await assert.rejects(capture(missing.repositories, [target]), /RETAIL_KV_BINDING_PROFILE_INCOMPLETE/);
});
