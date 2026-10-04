"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { canonicalSha256 } = require("../lib/work-rules/receipt");
const { RETAIL_KV_SOURCE } = require("../lib/personnel-retail-kv");
const { openSqliteApplicationPersistence } = require("../lib/persistence/sqlite/provider");
const { ensureSqliteApplicationSchema } = require("../lib/persistence/sqlite/operations/application-schema");
const { SQLITE_WORK_RULE_STORE_CATALOG } = require("../lib/persistence/sqlite/work-rule-store-catalog");
const { SQLITE_CUSTOM_WORK_RULES_CATALOG } = require("../lib/persistence/sqlite/custom-work-rules-catalog");
const { SQLITE_WORK_RULE_GOVERNANCE_CATALOG } = require("../lib/persistence/sqlite/work-rule-governance-catalog");
const { SQLITE_COLLECTIVE_AGREEMENTS_CATALOG } = require("../lib/persistence/sqlite/collective-agreements-catalog");
const { createWorkRuleStoreRepository } = require("../lib/persistence/repositories/work-rule-store");
const { createCollectiveAgreementsRepository } = require("../lib/persistence/repositories/collective-agreements");
const { createWorkRuleGovernanceRepository } = require("../lib/persistence/repositories/work-rule-governance");
const { seedBuiltinWorkRuleProfiles, versionSnapshot } = require("../lib/work-rules/store");
const { createCollectiveAgreement, addCollectiveAgreementVersion,
  createBusinessUnit, addBusinessUnitScopes, prepareCollectiveAgreementAssignment } = require("../lib/collective-agreements");
const { previewWorkRuleGovernance, createWorkRuleReviewRequest, recordWorkRuleReviewDecision,
  finalizeWorkRuleReviewRequest } = require("../lib/work-rules/governance");
const { loadRetailKvBindingSnapshot, resolveRetailKvApproval } = require("../lib/work-rules/retail-kv-binding");

const PROFILE = Object.freeze({ id: "at-retail-kv-angestellte-2026", version: "2026.5", title: "KV fixture",
  status: "active", assignable: false, snapshotSchemaVersion: 2, validFrom: "2026-01-01", validTo: "2026-12-31",
  catalogVersion: "fixture", defaultEnforcementMode: "monitor", sourceRefs: [RETAIL_KV_SOURCE.id],
  applicability: { jurisdiction: "AT", sector: "retail" }, limits: {}, ruleIds: [] });
const PROFILE_ID = `${PROFILE.id}@${PROFILE.version}`;
const OPTIONS = { expectedProfileVersionId: PROFILE_ID,
  expectedProfileContentSha256: canonicalSha256(versionSnapshot(PROFILE, [], [RETAIL_KV_SOURCE])) };
const DATE = "2026-10-05";
const CONTEXT = [{ locationId: "L1", departmentId: "1" }];
const actor = (id, extras = {}) => ({ employeeNumber: id, role: "hr", qualification: "fachlich",
  permissionUsed: "collective_agreements:approve", now: "2026-10-03T08:00:00.000Z", ...extras });

async function approve(fixture, assignmentId, { operation = "approve_kv_assignment", effectiveOn = "2026-01-01",
  reviewers = [actor("REVIEW-1"), actor("REVIEW-2")], finalize = true } = {}) {
  const input = { operation, subjectType: "collective_agreement_assignment", subjectId: assignmentId,
    payload: { effectiveOn } };
  const preview = await previewWorkRuleGovernance(fixture.repositories.governance, input, actor("AUTHOR"));
  assert.equal(preview.outcome, "pass");
  let request = await createWorkRuleReviewRequest(fixture.repositories.governance,
    { ...input, clientRequestId: `request-${assignmentId}-${operation}`, basisSha256: preview.basisSha256,
      conflictRunId: preview.conflictRunId, reason: "Quellenstand und Betriebsteil unabhängig geprüft.",
      sourceReference: "Dokumentierte Fachprüfung" }, actor("AUTHOR"));
  for (const reviewer of reviewers) request = await recordWorkRuleReviewDecision(fixture.repositories.governance,
    request.id, { decision: "approve", reason: "Quelle und Anwendbarkeit unabhängig geprüft." }, reviewer);
  if (finalize) await finalizeWorkRuleReviewRequest(fixture.repositories.governance, request.id,
    { reason: "Getrennte Freigaben vollständig geprüft.", sourceReference: "Dokumentierte Fachprüfung",
      basisSha256: request.basisSha256 }, actor("AUTHOR"));
  return request;
}

async function fixture({ source = {}, approved = true, scope = { scopeType: "location", scopeKey: "L1" },
  reviewers, finalize = true, effectiveOn, profile = PROFILE, rules = [], catalog } = {}) {
  const application = openSqliteApplicationPersistence({ databasePath: ":memory:", catalog: catalog || [
    ...SQLITE_WORK_RULE_STORE_CATALOG, ...SQLITE_CUSTOM_WORK_RULES_CATALOG,
    ...SQLITE_WORK_RULE_GOVERNANCE_CATALOG, ...SQLITE_COLLECTIVE_AGREEMENTS_CATALOG,
  ] });
  ensureSqliteApplicationSchema(application.database);
  application.database.exec(`INSERT INTO locations (id,name) VALUES ('L1','One'),('L2','Two');
    INSERT INTO departments (id,location_id,name) VALUES (1,'L1','A'),(2,'L2','B');`);
  const repositories = { collectiveAgreements: createCollectiveAgreementsRepository(application.provider),
    governance: createWorkRuleGovernanceRepository(application.provider),
    workRuleStore: createWorkRuleStoreRepository(application.provider) };
  await seedBuiltinWorkRuleProfiles(repositories.workRuleStore,
    [{ profile, rules, sources: [RETAIL_KV_SOURCE] }]);
  const versionPayload = { versionLabel: "2026", validFrom: "2026-01-01", validTo: "2026-12-31",
    sourceTitle: RETAIL_KV_SOURCE.title, sourceUrl: RETAIL_KV_SOURCE.url,
    sourceRetrievedOn: RETAIL_KV_SOURCE.retrievedOn, sourceSha256: RETAIL_KV_SOURCE.sha256,
    linkedProfileVersionId: PROFILE_ID, ...source };
  const agreement = await createCollectiveAgreement(repositories.collectiveAgreements,
    { code: "HANDEL-2026", title: RETAIL_KV_SOURCE.title, version: versionPayload }, "AUTHOR");
  const unit = await createBusinessUnit(repositories.collectiveAgreements,
    { code: "UNIT", name: "Unit", legalEntityName: "Example", scopes: [scope] }, "AUTHOR");
  const assignment = await prepareCollectiveAgreementAssignment(repositories.collectiveAgreements,
    { agreementVersionId: agreement.currentVersionId, businessUnitId: unit.id,
      validFrom: "2026-01-01", validTo: "2026-12-31", rationale: "Explizit geprüfte betriebliche Anwendbarkeit." }, "AUTHOR");
  const result = { ...application, repositories, agreement, unit, assignment, versionPayload,
    period: { confirmed: true, group: "salaried", validFrom: "2026-01-01", validTo: "2026-12-31",
      sourceVersion: RETAIL_KV_SOURCE.id, sourceSha256: RETAIL_KV_SOURCE.sha256,
      collectiveAgreementVersionId: agreement.currentVersionId, approvedAssignmentId: assignment.id },
    close: async () => { await application.provider.close(); application.database.close(); } };
  if (approved) result.request = await approve(result, assignment.id, { reviewers, finalize, effectiveOn });
  return result;
}

async function resolve(value, period = value.period, date = DATE, context = CONTEXT, repositories = value.repositories,
  options = OPTIONS) {
  return resolveRetailKvApproval(await loadRetailKvBindingSnapshot(repositories, options), period, date, context);
}

test("retail KV binding uses the genuine existing two-person review and finalized approval", async t => {
  const value = await fixture(); t.after(value.close);
  const writesBefore = value.database.prepare("SELECT total_changes() AS count").get().count;
  const snapshot = await loadRetailKvBindingSnapshot(value.repositories, OPTIONS);
  const repeated = await loadRetailKvBindingSnapshot(value.repositories, OPTIONS);
  const result = resolveRetailKvApproval(snapshot, value.period, DATE, CONTEXT);
  assert.equal(result.verified, true, JSON.stringify(result));
  assert.match(snapshot.inputSha256, /^[a-f0-9]{64}$/);
  assert.match(result.receiptSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(snapshot).sort(), ["inputSha256", "schemaVersion"]);
  assert.equal(snapshot.inputSha256, repeated.inputSha256);
  assert.equal(value.database.prepare("SELECT total_changes() AS count").get().count, writesBefore);
  assert.doesNotMatch(JSON.stringify({ snapshot, result }), /AUTHOR|REVIEW|sourceReference|agreementVersionId|L1/);
});

test("a fabricated snapshot or approver array cannot establish applicability", async () => {
  assert.equal(resolveRetailKvApproval({ schemaVersion: 1, approvals: ["a", "b"] },
    { confirmed: true }, DATE, CONTEXT).verified, false);
});

test("the actual new operative catalog snapshot is verified through the real store and approval workflow", async t => {
  const { RETAIL_KV_PROFILE, RETAIL_KV_RULES, RETAIL_KV_SOURCES } = require("../lib/work-rules/retail-kv");
  const rules = Object.values(RETAIL_KV_RULES), sources = Object.values(RETAIL_KV_SOURCES);
  const value = await fixture({ profile: RETAIL_KV_PROFILE, rules }); t.after(value.close);
  const options = { expectedProfileVersionId: `${RETAIL_KV_PROFILE.id}@${RETAIL_KV_PROFILE.version}`,
    expectedProfileContentSha256: canonicalSha256(versionSnapshot(RETAIL_KV_PROFILE, rules, sources)) };
  assert.equal((await resolve(value, value.period, DATE, CONTEXT, value.repositories, options)).verified, true);
});

for (const change of [
  { sourceSha256: "a".repeat(64) }, { linkedProfileVersionId: "" },
  { sourceUrl: "https://example.invalid/source.pdf" }, { sourceRetrievedOn: "2026-10-02" },
]) test(`source/profile gate rejects ${Object.keys(change)[0]}`, async t => {
  const value = await fixture({ source: change }); t.after(value.close);
  assert.equal((await resolve(value)).verified, false);
});

test("missing approval and incomplete/finalization-free reviews remain unknown", async t => {
  for (const config of [{ approved: false }, { reviewers: [actor("REVIEW-1")], finalize: false }, { finalize: false }]) {
    const value = await fixture(config); t.after(value.close);
    assert.equal((await resolve(value)).verified, false);
  }
});

test("technical or organisational decisions cannot substitute for two professional HR/admin approvals", async t => {
  for (const reviewer of [actor("REVIEW-2", { role: "developer" }),
    actor("REVIEW-2", { qualification: "organisational" }),
    actor("REVIEW-2", { permissionUsed: "work_rules:review" })]) {
    const value = await fixture({ reviewers: [actor("REVIEW-1"), reviewer] }); t.after(value.close);
    assert.equal((await resolve(value)).verified, false);
  }
});

test("author and submitter cannot approve through the existing core workflow", async t => {
  const value = await fixture({ approved: false }); t.after(value.close);
  await assert.rejects(approve(value, value.assignment.id, { reviewers: [actor("AUTHOR")], finalize: false }),
    error => error.code === "WORK_RULE_GOVERNANCE_SELF_APPROVAL");
  assert.equal((await resolve(value)).verified, false);
});

test("recorded admin professional decisions are accepted alongside HR", async t => {
  const value = await fixture({ reviewers: [actor("REVIEW-1"), actor("REVIEW-2", { role: "admin" })] }); t.after(value.close);
  assert.equal((await resolve(value)).verified, true);
});

test("an explicit registered exclusion of apprentices contradicts a personal apprentice assignment", async t => {
  const value = await fixture({ source: { apprenticeRelevance: "no" } }); t.after(value.close);
  assert.equal((await resolve(value)).verified, true);
  const result = await resolve(value, { ...value.period, group: "apprentice" });
  assert.deepEqual(result, { verified: false, reason: "personal_group_source_conflict" });
});

test("profile expected hash and personal/source links cannot be asserted by fields alone", async t => {
  const value = await fixture(); t.after(value.close);
  assert.equal((await resolve(value, value.period, DATE, CONTEXT, value.repositories,
    { ...OPTIONS, expectedProfileContentSha256: "f".repeat(64) })).verified, false);
  for (const change of [{ approvedAssignmentId: "missing" }, { collectiveAgreementVersionId: "missing" },
    { confirmed: false }, { group: "unknown" }, { sourceVersion: "old" }, { sourceSha256: "f".repeat(64) }]) {
    assert.equal((await resolve(value, { ...value.period, ...change })).verified, false);
  }
  assert.equal((await resolve(value, value.period, "2027-01-01")).verified, false);
});

test("approval dates, personal dates and deactivation boundaries are inclusive/exclusive", async t => {
  const value = await fixture({ effectiveOn: "2026-04-01" }); t.after(value.close);
  assert.equal((await resolve(value, value.period, "2026-03-31")).verified, false);
  assert.equal((await resolve(value, value.period, "2026-04-01")).verified, true);
  await approve(value, value.assignment.id, { operation: "deactivate_kv_assignment", effectiveOn: "2026-10-10" });
  assert.equal((await resolve(value, value.period, "2026-10-09")).verified, true);
  assert.equal((await resolve(value, value.period, "2026-10-10")).verified, false);
  assert.equal((await resolve(value, { ...value.period, validTo: "2026-10-08" }, "2026-10-09")).verified, false);
});

test("all workplaces need actual scope coverage including foreign-location shifts", async t => {
  const value = await fixture(); t.after(value.close);
  assert.equal((await resolve(value, value.period, DATE, [])).verified, false);
  assert.equal((await resolve(value, value.period, DATE,
    [...CONTEXT, { locationId: "L2", departmentId: "2" }])).verified, false);
  assert.equal((await resolve(value, value.period, DATE, [{ departmentId: "1" }])).verified, false);
});

test("department scopes require their actual location and detect location/department ambiguity", async t => {
  const value = await fixture({ scope: { scopeType: "department", scopeKey: "1" } }); t.after(value.close);
  assert.equal((await resolve(value)).verified, true);
  assert.equal((await resolve(value, value.period, DATE, [{ locationId: "L2", departmentId: "1" }])).verified, false);
  const unit = await createBusinessUnit(value.repositories.collectiveAgreements,
    { code: "SECOND", name: "Second", legalEntityName: "Example", scopes: [{ scopeType: "location", scopeKey: "L1" }] }, "AUTHOR");
  const second = await prepareCollectiveAgreementAssignment(value.repositories.collectiveAgreements,
    { agreementVersionId: value.agreement.currentVersionId, businessUnitId: unit.id,
      validFrom: "2026-01-01", validTo: "2026-12-31", rationale: "Hierarchy overlap negative scenario." }, "AUTHOR");
  // Existing governance admits distinct scope types; the binding gate closes it.
  await approve(value, second.id);
  assert.equal((await resolve(value)).verified, false);
  assert.equal((await resolve(value, { ...value.period, approvedAssignmentId: second.id }, DATE,
    [{ locationId: "L1" }])).verified, false);
});

test("a changed business-unit scope invalidates its existing approval snapshot", async t => {
  const value = await fixture(); t.after(value.close);
  const before = await loadRetailKvBindingSnapshot(value.repositories, OPTIONS);
  await addBusinessUnitScopes(value.repositories.collectiveAgreements, value.unit.id,
    [{ scopeType: "location", scopeKey: "L2" }], "AUTHOR");
  const after = await loadRetailKvBindingSnapshot(value.repositories, OPTIONS);
  assert.notEqual(before.inputSha256, after.inputSha256);
  assert.equal(resolveRetailKvApproval(after, value.period, DATE, CONTEXT).verified, false);
});

test("revoked source metadata and malformed row/receipt fail closed without private errors", async t => {
  const value = await fixture(); t.after(value.close);
  for (const change of [{ sourceState: "withdrawn" }, { validFrom: "2026-02-01" }, { contentSha256: "f".repeat(64) }]) {
    const repositories = { ...value.repositories, collectiveAgreements: { ...value.repositories.collectiveAgreements,
      listVersions: async () => (await value.repositories.collectiveAgreements.listVersions()).map(row => ({ ...row, ...change })) } };
    const result = await resolve(value, value.period, DATE, CONTEXT, repositories);
    assert.equal(result.verified, false);
    assert.doesNotMatch(JSON.stringify(result), /AUTHOR|REVIEW|private/);
  }
  const repositories = { ...value.repositories, governance: { ...value.repositories.governance,
    reviewDecisions: async id => (await value.repositories.governance.reviewDecisions(id))
      .map(row => ({ ...row, actor_employee_number: "tampered-private-person" })) } };
  assert.equal((await resolve(value, value.period, DATE, CONTEXT, repositories)).verified, false);
});

test("future register versions do not reinterpret a historical approved 2026 source", async t => {
  const value = await fixture(); t.after(value.close);
  await addCollectiveAgreementVersion(value.repositories.collectiveAgreements, value.agreement.id,
    { ...value.versionPayload, versionLabel: "2027", validFrom: "2027-01-01", validTo: "2027-12-31",
      sourceSha256: "b".repeat(64), sourceUrl: "https://example.invalid/2027.pdf", linkedProfileVersionId: "" }, "AUTHOR");
  assert.equal((await resolve(value)).verified, true);
});


test("school mutation guard detects a real KV scope change and rolls back stale option and receipt", async t => {
  const { SQLITE_APPLICATION_CATALOG } = require("../lib/persistence/sqlite/application-catalog");
  const { createApplicationRepositories } = require("../lib/persistence/application-repositories");
  const { captureVocationalSchoolMutationGuard: capture } = require("../lib/work-rules/vocational-school-mutation-guard");
  const { RETAIL_KV_PROFILE, RETAIL_KV_RULES, RETAIL_KV_SOURCES } = require("../lib/work-rules/retail-kv");
  const { getWorkRuleProfileVersion } = require("../lib/work-rules/store");
  const value = await fixture({ profile: RETAIL_KV_PROFILE, rules: Object.values(RETAIL_KV_RULES), catalog: SQLITE_APPLICATION_CATALOG });
  t.after(value.close);
  value.database.exec("INSERT INTO employees(personnel_number,full_name,nickname,home_location_id) VALUES('SYNTHETIC','Synthetic Person','Synthetic','L1')");
  const repositories = createApplicationRepositories(value.provider);
  const targets = [{ employeeNumber: "SYNTHETIC", weekStart: "2026-10-05", throughWeekStart: "2027-01-25" }];
  const before = await capture(repositories, targets);
  const options = { expectedProfileVersionId: PROFILE_ID, expectedProfileContentSha256: canonicalSha256(versionSnapshot(RETAIL_KV_PROFILE, Object.values(RETAIL_KV_RULES), Object.values(RETAIL_KV_SOURCES))) };
  assert.equal((await resolve(value, value.period, DATE, CONTEXT, value.repositories, options)).verified, true);
  const eventsBefore = value.database.prepare("SELECT COUNT(*) n FROM work_rule_governance_events").get().n;
  await addBusinessUnitScopes(value.repositories.collectiveAgreements, value.unit.id, [{ scopeType: "location", scopeKey: "L2" }], "SECOND-HR");
  assert.equal((await resolve(value, value.period, DATE, CONTEXT, value.repositories, options)).verified, false);
  assert.equal(value.database.prepare("SELECT COUNT(*) n FROM work_rule_governance_events").get().n, eventsBefore);
  const after = await value.provider.transaction(executor => capture(createApplicationRepositories(executor), targets), { isolation: "serializable" });
  assert.notEqual(after, before);
  const source = require("node:fs").readFileSync(require.resolve("../server"), "utf8").replace(/\r\n/g, "\n");
  const from = source.search(/^async function mutateVocationalSchoolOption\(/m), to = source.indexOf("\n}\n", from);
  assert.ok(from >= 0 && to > from);
  const context = require("node:vm").createContext({ persistenceProvider: { transaction: (callback, transactionOptions) => value.provider.transaction(callback, { isolation: transactionOptions.isolation }) }, createApplicationRepositories,
    captureVocationalSchoolMutationGuard: capture, httpError: (status, message, code) => Object.assign(new Error(message), { status, code }),
    recordEvaluatedWorkRuleEvaluation: async () => { throw new Error("stale receipt must not be written"); } });
  require("node:vm").runInContext(source.slice(from, to + 3), context);
  let writes = 0;
  await assert.rejects(context.mutateVocationalSchoolOption({ mutationGuard: { targets, fingerprint: before } }, async repository => {
    writes++; return repository.insertWeekOption({ employeeNumber: "SYNTHETIC", weekStart: "2026-10-05", optionType: "vocational_school", dateFrom: "2026-10-06", dateTo: "2026-10-06", allDay: true });
  }, "SYNTHETIC-HR"), { status: 409, code: "VOCATIONAL_SCHOOL_CONCURRENT_CHANGE" });
  assert.equal(writes, 0);
  assert.equal(value.database.prepare("SELECT COUNT(*) n FROM week_options").get().n, 0);
  assert.equal(value.database.prepare("SELECT COUNT(*) n FROM work_rule_evaluation_runs").get().n, 0);
});

test("strict KV snapshots preserve ordinary missing approval but reject unavailable or damaged reads", async t => {
  const value = await fixture({ approved: false }); t.after(value.close);
  const strictOptions = { ...OPTIONS, failOnInvalidSnapshot: true };
  const snapshot = await loadRetailKvBindingSnapshot(value.repositories, strictOptions);
  assert.equal(resolveRetailKvApproval(snapshot, value.period, DATE, CONTEXT).verified, false);
  const broken = { ...value.repositories, collectiveAgreements: { ...value.repositories.collectiveAgreements,
    listVersions: async () => { throw new Error("synthetic KV read unavailable"); } } };
  assert.equal(resolveRetailKvApproval(await loadRetailKvBindingSnapshot(broken, OPTIONS), value.period, DATE, CONTEXT).verified, false);
  await assert.rejects(loadRetailKvBindingSnapshot(broken, strictOptions), /synthetic KV read unavailable/);
  const incomplete = { ...value.repositories, collectiveAgreements: { ...value.repositories.collectiveAgreements, listVersions: async () => null } };
  await assert.rejects(loadRetailKvBindingSnapshot(incomplete, strictOptions), TypeError);
});
