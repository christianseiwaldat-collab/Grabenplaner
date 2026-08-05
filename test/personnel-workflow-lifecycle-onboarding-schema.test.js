"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");

const {
  ensureSqlitePersonnelWorkflowInstanceSchema,
  inspectSqlitePersonnelWorkflowInstanceRows,
  inspectSqlitePersonnelWorkflowInstanceSchema,
} = require("../lib/persistence/sqlite/operations/personnel-workflow-instance-schema");
const {
  personnelWorkflowInstanceReceiptBody,
} = require("../lib/personnel-workflow-instance-receipt");

const STARTED_AT = "2026-08-03T09:00:00.000Z";
const OPERATION_ID = "11111111-1111-4111-8111-111111111111";

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function createDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE custom_process_runs (
      id TEXT PRIMARY KEY,
      process_id TEXT NOT NULL,
      process_revision INTEGER NOT NULL,
      trigger_type TEXT NOT NULL,
      trigger_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      location_id TEXT,
      department_id INTEGER,
      triggered_by TEXT NOT NULL,
      activation_count INTEGER NOT NULL DEFAULT 1,
      resolved_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE custom_process_run_steps (
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      activated_at TEXT,
      completed_at TEXT,
      completed_by TEXT NOT NULL DEFAULT '',
      completion_note TEXT NOT NULL DEFAULT '',
      completion_request_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, step_id),
      FOREIGN KEY (run_id) REFERENCES custom_process_runs(id)
    );
    CREATE TABLE custom_process_publications (
      id TEXT PRIMARY KEY,
      process_id TEXT NOT NULL,
      source_revision INTEGER NOT NULL,
      version_number INTEGER NOT NULL,
      workflow_code TEXT NOT NULL,
      workflow_type TEXT NOT NULL,
      authority_level TEXT NOT NULL,
      requirement_kind TEXT NOT NULL,
      data_classification TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      location_id TEXT,
      department_id INTEGER,
      snapshot_json TEXT NOT NULL,
      snapshot_sha256 TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      published_by TEXT NOT NULL,
      published_at TEXT NOT NULL,
      archived_at TEXT
    );
    CREATE TABLE custom_process_publication_archives (
      publication_id TEXT PRIMARY KEY
    );
    CREATE TABLE candidates (
      id TEXT PRIMARY KEY,
      state TEXT,
      revision INTEGER
    );
    CREATE TABLE candidate_applications (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      status TEXT,
      revision INTEGER,
      desired_location_id TEXT,
      desired_department_id INTEGER,
      UNIQUE (id, candidate_id)
    );
    CREATE TABLE employees (
      personnel_number TEXT PRIMARY KEY,
      active INTEGER NOT NULL,
      home_location_id TEXT,
      preferred_department_id INTEGER
    );
    CREATE TABLE locations (id TEXT PRIMARY KEY, active INTEGER NOT NULL);
    CREATE TABLE departments (
      id INTEGER PRIMARY KEY,
      location_id TEXT NOT NULL,
      active INTEGER NOT NULL
    );
    CREATE TABLE portal_users (
      employee_number TEXT PRIMARY KEY,
      password_hash TEXT,
      role TEXT,
      active INTEGER
    );
    CREATE TABLE portal_roles (
      id TEXT PRIMARY KEY,
      permissions TEXT
    );
    CREATE TABLE portal_access_scopes (
      employee_number TEXT,
      location_id TEXT,
      department_id INTEGER
    );
    CREATE TABLE portal_permission_grants (
      employee_number TEXT,
      permission TEXT
    );
    CREATE TABLE portal_permission_denials (
      employee_number TEXT,
      permission TEXT
    );
    CREATE TABLE portal_permission_scope_grants (
      employee_number TEXT,
      permission TEXT,
      location_id TEXT,
      department_id INTEGER
    );

    CREATE TABLE personnel_employment_episodes (
      id TEXT PRIMARY KEY,
      employee_number TEXT NOT NULL,
      state TEXT NOT NULL
    );
    CREATE TABLE personnel_lifecycle_cases (
      id TEXT PRIMARY KEY,
      case_type TEXT NOT NULL,
      employment_episode_id TEXT NOT NULL,
      state TEXT NOT NULL,
      location_id TEXT,
      department_id INTEGER
    );
    CREATE TABLE personnel_lifecycle_case_package_bindings (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      publication_id TEXT NOT NULL,
      version_number INTEGER NOT NULL
    );
    CREATE TABLE personnel_lifecycle_case_package_runs (
      package_binding_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE,
      run_operation_id TEXT NOT NULL UNIQUE
    );
  `);
  ensureSqlitePersonnelWorkflowInstanceSchema(database);
  return database;
}

function insertOnboardingContract(database) {
  const snapshotJson = JSON.stringify({
    id: "process-onboarding",
    revision: 1,
    title: "Onboarding",
    scope: { type: "location", locationId: "LOC-1", departmentId: null },
    steps: [{
      id: "system-prepare",
      title: "Vorbereiten",
      responsibilityType: "system",
      responsibilityReference: "",
      conditionType: "always",
      notificationChannels: [],
    }],
  });
  database.exec(`
    INSERT INTO locations (id, active) VALUES ('LOC-1', 1);
    INSERT INTO employees (
      personnel_number, active, home_location_id, preferred_department_id
    ) VALUES ('EMP-7', 1, 'LOC-1', NULL);
  `);
  database.prepare(`
    INSERT INTO custom_process_publications (
      id, process_id, source_revision, version_number, workflow_code,
      workflow_type, authority_level, requirement_kind, data_classification,
      scope_type, location_id, department_id, snapshot_json, snapshot_sha256,
      receipt_sha256, published_by, published_at
    ) VALUES (
      'publication-onboarding', 'process-onboarding', 1, 2, 'standard.onboarding',
      'onboarding', 'central', 'mandatory', 'standard',
      'location', 'LOC-1', NULL, ?, ?, ?, 'PL-PLUS', ?
    )
  `).run(snapshotJson, sha256(snapshotJson), "b".repeat(64), STARTED_AT);
  database.exec(`
    INSERT INTO personnel_employment_episodes (
      id, employee_number, state
    ) VALUES ('episode-1', 'EMP-7', 'employment_active');
    INSERT INTO personnel_lifecycle_cases (
      id, case_type, employment_episode_id, state, location_id, department_id
    ) VALUES ('case-1', 'onboarding', 'episode-1', 'approved', 'LOC-1', NULL);
    INSERT INTO personnel_lifecycle_case_package_bindings (
      id, case_id, publication_id, version_number
    ) VALUES ('package-1', 'case-1', 'publication-onboarding', 2);
  `);
  return snapshotJson;
}

function insertRun(database, runId, operationId) {
  database.prepare(`
    INSERT INTO custom_process_runs (
      id, process_id, process_revision, trigger_type, trigger_key, status,
      location_id, department_id, triggered_by, activation_count,
      created_at, updated_at
    ) VALUES (
      ?, 'process-onboarding', 1, 'personnel_manual', ?, 'open',
      'LOC-1', NULL, 'PL-PLUS', 1, ?, ?
    )
  `).run(runId, `personnel:${operationId}`, STARTED_AT, STARTED_AT);
}

function insertBinding(database, runId, operationId) {
  const binding = {
    run_id: runId,
    publication_id: "publication-onboarding",
    operation_id: operationId,
    subject_type: "employee",
    candidate_id: null,
    application_id: null,
    candidate_revision: null,
    application_revision: null,
    employee_number: "EMP-7",
    location_id: "LOC-1",
    department_id: null,
    request_sha256: "a".repeat(64),
    started_by: "PL-PLUS",
    started_at: STARTED_AT,
  };
  const receipt = sha256(JSON.stringify(personnelWorkflowInstanceReceiptBody(binding)));
  return database.prepare(`
    INSERT INTO custom_process_run_bindings (
      run_id, publication_id, operation_id, subject_type,
      candidate_id, application_id, candidate_revision, application_revision,
      employee_number, request_sha256, receipt_sha256, started_by, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    binding.run_id,
    binding.publication_id,
    binding.operation_id,
    binding.subject_type,
    binding.candidate_id,
    binding.application_id,
    binding.candidate_revision,
    binding.application_revision,
    binding.employee_number,
    binding.request_sha256,
    receipt,
    binding.started_by,
    binding.started_at,
  );
}

test("M5 SQLite blockiert Onboarding vor O4 ohne seine Legacy-Workflows zu beschaedigen", () => {
  const database = createDatabase();
  try {
    insertOnboardingContract(database);
    database.exec(`
      DROP TABLE personnel_lifecycle_case_package_runs;
      DROP TABLE personnel_lifecycle_case_package_bindings;
      DROP TABLE personnel_lifecycle_cases;
      DROP TABLE personnel_employment_episodes;
    `);
    ensureSqlitePersonnelWorkflowInstanceSchema(database);
    assert.equal(inspectSqlitePersonnelWorkflowInstanceSchema(database).valid, true);

    insertRun(database, "run-pre-o4", OPERATION_ID);
    assert.throws(
      () => insertBinding(database, "run-pre-o4", OPERATION_ID),
      /personnel workflow instance binding is invalid/,
    );
  } finally {
    database.close();
  }
});

test("M5 SQLite akzeptiert Onboarding nur mit der exakten Lifecycle-Paket-Run-Relation", () => {
  const database = createDatabase();
  try {
    insertOnboardingContract(database);

    const unrelatedOperationId = "22222222-2222-4222-8222-222222222222";
    insertRun(database, "run-unrelated", unrelatedOperationId);
    assert.throws(
      () => insertBinding(database, "run-unrelated", unrelatedOperationId),
      /personnel workflow lifecycle binding is invalid/,
    );
    database.prepare("DELETE FROM custom_process_runs WHERE id = 'run-unrelated'").run();

    insertRun(database, "run-onboarding", OPERATION_ID);
    database.prepare(`
      INSERT INTO personnel_lifecycle_case_package_runs (
        package_binding_id, run_id, run_operation_id
      ) VALUES ('package-1', 'run-onboarding', ?)
    `).run(OPERATION_ID);
    insertBinding(database, "run-onboarding", OPERATION_ID);
    database.prepare(`
      INSERT INTO custom_process_run_steps (
        run_id, step_id, sort_order, status, activated_at, completed_at,
        completed_by, completion_note, completion_request_id, created_at, updated_at
      ) VALUES (
        'run-onboarding', 'system-prepare', 1, 'pending', NULL, NULL,
        '', '', '', ?, ?
      )
    `).run(STARTED_AT, STARTED_AT);
    database.prepare(`
      UPDATE custom_process_run_steps
      SET status = 'completed', activated_at = ?, completed_at = ?,
          completed_by = 'system', updated_at = ?
      WHERE run_id = 'run-onboarding' AND step_id = 'system-prepare'
    `).run(STARTED_AT, STARTED_AT, STARTED_AT);
    database.prepare(`
      UPDATE custom_process_runs
      SET status = 'resolved', resolved_at = ?, updated_at = ?
      WHERE id = 'run-onboarding'
    `).run(STARTED_AT, STARTED_AT);
    database.prepare(`
      UPDATE personnel_lifecycle_cases SET state = 'active' WHERE id = 'case-1'
    `).run();

    assert.deepEqual(inspectSqlitePersonnelWorkflowInstanceRows(database).issues, []);

    database.prepare(`
      UPDATE personnel_lifecycle_case_package_runs
      SET run_operation_id = '33333333-3333-4333-8333-333333333333'
      WHERE run_id = 'run-onboarding'
    `).run();
    assert.deepEqual(inspectSqlitePersonnelWorkflowInstanceRows(database).issues, [
      "binding-relation:run-onboarding",
    ]);
  } finally {
    database.close();
  }
});
