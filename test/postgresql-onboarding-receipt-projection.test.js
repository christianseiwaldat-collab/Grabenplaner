"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const catalog = require("../lib/persistence/postgresql/core/catalog");
const base = require("../lib/persistence/postgresql/contracts/block-4-catalog.json");
const extension = require("../lib/persistence/postgresql/contracts/onboarding-receipt-projection-catalog-v1.json");
const { createPersistenceProviderFacade } = require("../lib/persistence/contract");
const { POSTGRESQL_CAPABILITIES } = require("../lib/persistence/postgresql/provider");
const { createCustomProcessManagementRepository } = require("../lib/persistence/repositories/custom-process-management");
const {
  createPersonnelLifecycleOnboardingExecutionService,
  normalizedStartInput,
  requestSha256,
} = require("../lib/personnel-lifecycle-onboarding-execution");
const { personnelLifecycleOnboardingOperationReceiptBody } = require("../lib/personnel-lifecycle-onboarding-receipt");
const id = "custom-process-management.onboarding-operation-by-id";
const source = catalog.sourceEntries().find(entry => entry.statement.id === id);
const sha = value => crypto.createHash("sha256").update(value).digest("hex");

test("onboarding projection preserves the historical source contract and qualifies exactly one compiled query", () => {
  assert.equal(catalog.sourceContract(source), base.entries.find(entry => entry.statementId === id).sourceContract);
  assert.equal(extension.entries.length, 1);
  assert.equal(extension.entries[0].statementId, id);
  const result = catalog.compileCoreEntry(source);
  assert.match(result.providerEntry.sql, /'result_payload' , operation \. result_payload ,/);
  assert.doesNotMatch(result.providerEntry.sql, /result_payload\s*\)\s*::\s*jsonb/);
  assert.equal(sha(result.providerEntry.sql), extension.entries[0].sqlSha256);
  assert.equal(catalog.createCoreCatalog().entries.length, 1125);
});

test("changed source, an unreviewed query and a changed projection receipt fail closed", () => {
  assert.throws(() => catalog.compileCoreEntry({ ...source, sql: source.sql + "\n-- unreviewed change" }), /Unreviewed onboarding receipt projection/);
  const compiled = catalog.sourceEntries().map(catalog.compileCoreEntry);
  const other = compiled.find(entry => entry.provenance.statementId !== id);
  const originalSql = other.providerEntry.sql;
  other.providerEntry.sql += " -- unreviewed";
  assert.throws(() => catalog.assertCoreCatalogLock(compiled, base), /Core catalog lock drift/);
  other.providerEntry.sql = originalSql;
  const originalHash = extension.entries[0].sqlSha256;
  try {
    extension.entries[0].sqlSha256 = "f".repeat(64);
    assert.throws(() => catalog.assertCoreCatalogLock(compiled, base), /Core catalog lock drift/);
  } finally {
    extension.entries[0].sqlSha256 = originalHash;
  }
  catalog.assertCoreCatalogLock(compiled, base);
});

for (const [name, reviewedExtension] of [
  ["onboarding", extension],
  ["payroll", require("../lib/persistence/postgresql/contracts/payroll-handoff-department-catalog-v1.json")],
]) {
  test(`${name} qualification requires both valid binding hashes and compares each actual contract`, () => {
    const compiled = catalog.sourceEntries().map(catalog.compileCoreEntry);
    const record = reviewedExtension.entries[0];
    const fields = ["parameterBindingsSha256", "parameterOrderSha256"];
    const originals = Object.fromEntries(fields.map(field => [field, record[field]]));
    try {
      for (const field of fields) {
        delete record[field];
        assert.throws(() => catalog.assertCoreCatalogLock(compiled, base), /Qualified query binding hashes are required/);
        record[field] = originals[field];
        for (const invalid of [null, "", "bad-hash", "F".repeat(64), "a".repeat(63)]) {
          record[field] = invalid;
          assert.throws(() => catalog.assertCoreCatalogLock(compiled, base), /Qualified query binding hashes are required/);
        }
        record[field] = "f".repeat(64);
        assert.throws(() => catalog.assertCoreCatalogLock(compiled, base), /Core catalog lock drift/);
        record[field] = originals[field];
      }
      for (const field of fields) delete record[field];
      assert.throws(() => catalog.assertCoreCatalogLock(compiled, base), /Qualified query binding hashes are required/);
    } finally {
      Object.assign(record, originals);
    }
    catalog.assertCoreCatalogLock(compiled, base);
  });
}

function replayFixture(changeRow = () => {}) {
  const input = normalizedStartInput({
    operationId: "11111111-1111-4111-8111-111111111111", employeeNumber: "EMP-ORDER",
    expectedPreviewSha256: "b".repeat(64), responsibleActorId: "HR-ORDER", confirmation: "START_ONBOARDING",
    confirmations: { responsibility: true, packages: true, lifecycleReviews: true, assignments: true, atomicStart: true },
    referenceDates: { contractualEntryDate: "2026-08-01", firstWorkingDay: "2026-08-03", onboardingTargetDate: "2026-08-31" },
    packageBindings: [{ publicationId: "publication-order", versionNumber: 1, familyCodes: ["base_security_privacy"], reviewConfirmed: true, assignments: [] }],
  });
  const originalResult = {
    contractVersion: "o4-v0.1", employeeNumber: input.employeeNumber, caseId: "case-order", state: "active",
    packageCount: 1, assignmentCount: 0, packages: [{ publicationId: "publication-order", runId: "run-order" }], replayed: false,
  };
  const row = { operation_id: input.operationId, case_id: originalResult.caseId, request_sha256: requestSha256(input),
    preview_sha256: input.expectedPreviewSha256, result_payload: JSON.stringify(originalResult), actor_id: "HR-ORDER",
    occurred_at: "2026-08-03T12:00:00.000Z" };
  row.result_receipt_sha256 = sha(JSON.stringify(personnelLifecycleOnboardingOperationReceiptBody(row)));
  changeRow(row);
  const observed = { reads: [], writes: 0, commits: 0, rollbacks: 0 };
  const query = async statement => {
    observed.reads.push(statement.id);
    if (statement.id === id) return [{ data: structuredClone(row) }];
    if (statement.id === "custom-process-management.onboarding-case-by-id") return [{ data: { id: originalResult.caseId } }];
    throw new Error("Unexpected replay read: " + statement.id);
  };
  const execute = async () => { observed.writes += 1; throw new Error("Replay must never write"); };
  const provider = createPersistenceProviderFacade({ providerId: "onboarding-replay-fixture", capabilities: POSTGRESQL_CAPABILITIES,
    query, execute, beginTransaction: async () => ({ query, execute,
      commit: async () => { observed.commits += 1; }, rollback: async () => { observed.rollbacks += 1; } }), close: async () => {} });
  const service = createPersonnelLifecycleOnboardingExecutionService(createCustomProcessManagementRepository(provider), {
    instantiatePersonnelLifecycleOnboardingInTransaction: async () => { throw new Error("Replay must never instantiate"); },
    protectJson: () => { throw new Error("Replay must never encrypt new data"); },
    parseProtectedJson: () => { throw new Error("Replay must never load unrelated protected data"); },
  });
  const access = { actorId: "HR-ORDER", namedActor: true, central: true, canReadOnboarding: true, canPrepareOnboarding: true,
    canApproveOnboarding: true, canExecuteOnboarding: true, canReadPackages: true, canWritePackages: true,
    canPublishPackages: true, canWriteAssignments: true };
  return { input, originalResult, observed, provider, start: value => service.start(value || input, { actorId: "HR-ORDER", access }) };
}

test("an existing original-order receipt replays through the real service without a write or replacement hash", async () => {
  const fixture = replayFixture();
  try {
    assert.deepEqual(await fixture.start(), { ...fixture.originalResult, replayed: true });
    assert.equal(fixture.observed.writes, 0);
    assert.equal(fixture.observed.commits, 1);
    assert.equal(fixture.observed.rollbacks, 0);
  } finally { await fixture.provider.close(); }
});

for (const [name, change] of [
  ["parsed JSON with a reordered result", row => {
    const result = JSON.parse(row.result_payload);
    row.result_payload = Object.fromEntries(Object.entries(result).reverse());
  }],
  ["a changed original payload", row => { row.result_payload = row.result_payload.replace('"assignmentCount":0', '"assignmentCount":1'); }],
  ["a changed occurrence timestamp", row => { row.occurred_at = "2026-08-03T12:00:01.000Z"; }],
]) {
  test(`the unchanged service integrity guard rejects ${name} before a write`, async () => {
    const fixture = replayFixture(change);
    try {
      await assert.rejects(fixture.start(), error => error.code === "PERSONNEL_LIFECYCLE_ONBOARDING_INTEGRITY_FAILED");
      assert.equal(fixture.observed.writes, 0);
      assert.equal(fixture.observed.commits, 0);
      assert.equal(fixture.observed.rollbacks, 1);
    } finally { await fixture.provider.close(); }
  });
}

test("an intact historical receipt still rejects a different operation request", async () => {
  const fixture = replayFixture();
  try {
    const changed = structuredClone(fixture.input);
    changed.referenceDates.onboardingTargetDate = "2026-09-01";
    await assert.rejects(fixture.start(changed), error => error.code === "PERSONNEL_LIFECYCLE_ONBOARDING_OPERATION_CONFLICT");
    assert.equal(fixture.observed.writes, 0);
    assert.equal(fixture.observed.commits, 0);
    assert.equal(fixture.observed.rollbacks, 1);
  } finally { await fixture.provider.close(); }
});
