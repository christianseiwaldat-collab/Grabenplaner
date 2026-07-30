"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  OFFICIAL_RETENTION_SOURCES,
} = require("../lib/retention-policy");
const {
  createGovernanceStore,
} = require("../lib/governance-store");
const {
  createGovernanceStoreRepository,
} = require("../lib/persistence/repositories/governance-store");
const {
  SQLITE_GOVERNANCE_STORE_CATALOG,
} = require("../lib/persistence/sqlite/governance-store-catalog");
const {
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");

function fixture() {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_GOVERNANCE_STORE_CATALOG,
  });
  application.database.exec(`
    CREATE TABLE retention_policy_versions (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      duration_days INTEGER,
      start_trigger TEXT NOT NULL,
      disposition TEXT NOT NULL,
      legal_basis TEXT NOT NULL,
      source_json TEXT NOT NULL,
      configuration_json TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(category, version)
    );
    CREATE TABLE retention_preview_runs (
      id TEXT PRIMARY KEY,
      as_of TEXT NOT NULL,
      result_json TEXT NOT NULL,
      result_sha256 TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE legal_holds (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      subject_employee_number TEXT,
      reason TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      active INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      released_by TEXT,
      released_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE privacy_requests (
      id TEXT PRIMARY KEY,
      employee_number TEXT NOT NULL,
      request_type TEXT NOT NULL,
      status TEXT NOT NULL,
      identity_status TEXT NOT NULL,
      received_at TEXT NOT NULL,
      due_at TEXT NOT NULL,
      extended_due_at TEXT,
      assigned_to TEXT NOT NULL,
      protected_payload TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE privacy_request_events (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor_employee_number TEXT NOT NULL,
      protected_payload TEXT NOT NULL,
      previous_receipt_sha256 TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (request_id) REFERENCES privacy_requests(id)
    );
    CREATE TABLE vacation_account_revisions (
      id TEXT PRIMARY KEY,
      employee_number TEXT NOT NULL,
      leave_year INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      total_days REAL NOT NULL,
      eu_minimum_days REAL NOT NULL,
      national_additional_days REAL NOT NULL,
      weekly_workdays REAL NOT NULL,
      leave_year_start TEXT NOT NULL,
      leave_year_end TEXT NOT NULL,
      expiry_candidate_on TEXT,
      expiry_status TEXT NOT NULL,
      calculation_json TEXT NOT NULL,
      sources_json TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      supersedes_id TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE vacation_account_events (
      id TEXT PRIMARY KEY,
      employee_number TEXT NOT NULL,
      leave_year INTEGER NOT NULL,
      account_revision_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tranche_type TEXT NOT NULL,
      amount_days REAL NOT NULL,
      effective_on TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (account_revision_id) REFERENCES vacation_account_revisions(id)
    );
    CREATE TABLE time_record_statements (
      id TEXT PRIMARY KEY,
      employee_number TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      source_sha256 TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      supersedes_id TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE time_record_statement_events (
      id TEXT PRIMARY KEY,
      statement_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor_employee_number TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (statement_id) REFERENCES time_record_statements(id)
    );
    CREATE TABLE payroll_handoffs (
      id TEXT PRIMARY KEY,
      period_month TEXT NOT NULL,
      location_id TEXT NOT NULL,
      department_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      supersedes_id TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE payroll_handoff_events (
      id TEXT PRIMARY KEY,
      handoff_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      actor_employee_number TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      FOREIGN KEY (handoff_id) REFERENCES payroll_handoffs(id)
    );
  `);
  const repository = createGovernanceStoreRepository(application.provider);
  const store = createGovernanceStore(repository, {
    protectJson: (value) => JSON.stringify(value),
    parseProtectedJson: (value) => JSON.parse(value),
    now: () => new Date("2026-07-29T10:00:00.000Z"),
  });
  return {
    database: application.database,
    repository,
    store,
    async close() {
      await application.provider.close();
      application.database.close();
    },
  };
}

function retentionRule() {
  return {
    schemaVersion: 1,
    id: "retention-provider-test-v1",
    version: "1",
    category: "provider_test_records",
    title: "Provider-Testdaten nach Ende des Zwecks",
    status: "active",
    validFrom: "2026-01-01",
    validTo: null,
    sources: [OFFICIAL_RETENTION_SOURCES.eu_gdpr],
    startTrigger: "purpose_ended",
    retention: { value: 30, unit: "days" },
    disposition: "manual_review",
    legalHold: { behavior: "exclude_while_active" },
  };
}

test("Governance-Store arbeitet ausschließlich über das typisierte Repository", async () => {
  const value = fixture();
  try {
    const inserted = await value.store.insertRetentionRule(retentionRule(), "test");
    assert.equal(inserted.id, "retention-provider-test-v1");
    assert.deepEqual(await value.store.seedRetentionRules([retentionRule()], "test"), []);
    assert.equal((await value.store.retentionRuleRows()).length, 1);

    const preview = await value.store.previewRetention([{
      id: "record:1",
      category: "provider_test_records",
      subjectId: "E1",
      startTrigger: "purpose_ended",
      startAt: "2026-01-01",
    }], "2026-07-29", "test");
    assert.equal(preview.counts.candidates, 1);
    assert.equal((await value.store.latestRetentionPreview()).preview.mode, "preview_only");

    const created = await value.store.createRequest({
      employeeNumber: "E1",
      type: "access",
      scope: ["employee_master_data"],
      channel: "portal",
    });
    assert.equal(created.summary.status, "received");
    const transitioned = await value.store.transitionPrivacyRequest(
      created.state.id,
      "verify_identity",
      { status: "verified" },
      "HR1",
    );
    assert.equal(transitioned.summary.status, "in_review");
    assert.equal(
      value.database.prepare(
        "SELECT COUNT(*) AS count FROM privacy_request_events WHERE request_id = ?",
      ).get(created.state.id).count,
      2,
    );

    const vacation = await value.store.ensureVacationAccount({
      employeeNumber: "E1",
      year: 2026,
      totalDays: 25,
      weeklyWorkdays: 5,
      consumedDays: 2,
      plannedDays: 3,
      employmentStart: "2025-01-01",
      actor: "HR1",
    });
    assert.equal(vacation.revision, 1);
    assert.equal(vacation.remainingDays, 22);
    assert.equal(await value.store.verifyAuxiliaryEventIntegrity(), 1);
  } finally {
    await value.close();
  }
});

test("SQLite-Governance-Katalog stellt alle leeren Lesepfade bereit", async () => {
  const value = fixture();
  try {
    assert.deepEqual(await value.repository.listRetentionRules(), []);
    assert.deepEqual(await value.repository.listLegalHolds(), []);
    assert.equal(await value.repository.latestRetentionPreview(), null);
    assert.equal(await value.repository.privacyRequestById("missing"), null);
    assert.deepEqual(await value.repository.privacyRequestEvents("missing"), []);
    assert.deepEqual(await value.repository.listPrivacyRequests(), []);
    assert.equal(await value.repository.latestVacationAccount("E1", 2026), null);
    assert.deepEqual(await value.repository.listVacationAccounts(), []);
    assert.deepEqual(await value.repository.listVacationAccountEvents(), []);
    assert.equal(await value.repository.timeStatementById("missing"), null);
    assert.equal(await value.repository.timeStatementSuccessor("missing"), null);
    assert.deepEqual(await value.repository.listTimeStatementsForIntegrity(), []);
    assert.deepEqual(await value.repository.listTimeStatementEvents(), []);
    assert.equal(await value.repository.latestTimeStatement({
      employeeNumber: "E1",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
    }), null);
    assert.deepEqual(await value.repository.listTimeStatementsForPeriod({
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
    }), []);
    assert.equal(await value.repository.payrollHandoffById("missing"), null);
    assert.deepEqual(await value.repository.payrollHandoffEvents("missing"), []);
    assert.deepEqual(await value.repository.listPayrollHandoffReferences(), []);
    assert.equal(await value.repository.payrollHandoffEventCount(), 0);
  } finally {
    await value.close();
  }
});

test("Governance-Transaktion rollt State und Ereignis gemeinsam zurück", async () => {
  const value = fixture();
  try {
    value.database.exec(`
      CREATE TRIGGER fail_governance_event
      BEFORE INSERT ON privacy_request_events
      BEGIN
        SELECT RAISE(ABORT, 'expected governance test failure');
      END
    `);
    await assert.rejects(() => value.store.createRequest({
      employeeNumber: "E2",
      type: "rectification",
      scope: ["employee_master_data"],
      channel: "portal",
    }));
    assert.equal(
      value.database.prepare("SELECT COUNT(*) AS count FROM privacy_requests").get().count,
      0,
    );
    assert.equal(
      value.database.prepare("SELECT COUNT(*) AS count FROM privacy_request_events").get().count,
      0,
    );
  } finally {
    await value.close();
  }
});

test("Governance-Store verwaltet Legal Holds ausschließlich über den Provider", async () => {
  const value = fixture();
  try {
    await value.repository.insertLegalHold({
      id: "legal-hold:test",
      category: "personnel",
      employeeNumber: "E1",
      reasonCode: "litigation",
      validFrom: "2026-07-29",
      validTo: null,
      actor: "admin",
    });
    assert.equal(Boolean((await value.repository.listLegalHolds())[0].active), true);
    assert.equal((await value.repository.releaseLegalHold({
      id: "legal-hold:test",
      actor: "admin",
    })).rowsAffected, 1);
    assert.equal(Boolean((await value.repository.listLegalHolds())[0].active), false);
  } finally {
    await value.close();
  }
});

test("Governance-Fachmodul enthält weder SQL noch SQLite-Handles", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "lib", "governance-store.js"),
    "utf8",
  );
  assert.doesNotMatch(source, /\bdb\s*\.(?:prepare|exec)\s*\(/);
  assert.doesNotMatch(source, /\b(?:SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)\b/i);
});
