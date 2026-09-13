"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  inspectSqliteImportFile,
} = require("../lib/persistence/sqlite/operations/database-import");
const {
  personnelWorkflowPublicationReceiptBody,
} = require("../lib/personnel-workflow-publication-receipt");
const {
  personnelWorkflowInstanceReceiptBody,
  personnelWorkflowTaskAssignmentReceiptBody,
} = require("../lib/personnel-workflow-instance-receipt");
const {
  ensureSqlitePersonnelLifecycleScopedRightsSchema,
} = require("../lib/persistence/sqlite/operations/personnel-lifecycle-schema");
const {
  PERSONNEL_WORKFLOW_TRIGGER_DEFINITIONS,
  ensureSqlitePersonnelWorkflowSchema,
  inspectSqlitePersonnelWorkflowRows,
  inspectSqlitePersonnelWorkflowSchema,
} = require("../lib/persistence/sqlite/operations/personnel-workflow-schema");
const {
  PERSONNEL_WORKFLOW_INSTANCE_TRIGGER_DEFINITIONS,
  ensureSqlitePersonnelWorkflowInstanceSchema,
  inspectSqlitePersonnelWorkflowInstanceRows,
} = require("../lib/persistence/sqlite/operations/personnel-workflow-instance-schema");
const {
  openSqliteLegacyDatabase,
} = require("../lib/persistence/sqlite/provider");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fileSha256(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function temporaryWorkflowDatabase(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `grabenplaner-m4-import-${label}-`));
  const databasePath = path.join(root, "snapshot.sqlite");
  const database = openSqliteLegacyDatabase(databasePath);
  database.exec(`
    CREATE TABLE locations (
      id TEXT PRIMARY KEY,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE departments (
      id INTEGER PRIMARY KEY,
      location_id TEXT,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE custom_processes (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE custom_process_revisions (
      process_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      PRIMARY KEY (process_id, revision),
      FOREIGN KEY (process_id) REFERENCES custom_processes(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );
    CREATE TABLE custom_process_runs (
      id TEXT PRIMARY KEY,
      process_id TEXT NOT NULL,
      process_revision INTEGER NOT NULL,
      trigger_type TEXT NOT NULL DEFAULT 'manual',
      trigger_key TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      location_id TEXT,
      department_id INTEGER,
      triggered_by TEXT NOT NULL DEFAULT '',
      activation_count INTEGER NOT NULL DEFAULT 1,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (run_id, step_id)
    );
    CREATE TABLE candidates (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL DEFAULT 'active',
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE candidate_applications (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      desired_location_id TEXT,
      desired_department_id INTEGER,
      revision INTEGER NOT NULL DEFAULT 1,
      UNIQUE(id, candidate_id)
    );
    CREATE TABLE employees (
      personnel_number TEXT PRIMARY KEY,
      active INTEGER NOT NULL DEFAULT 1,
      home_location_id TEXT,
      preferred_department_id INTEGER
    );
    CREATE TABLE portal_users (
      employee_number TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'employee',
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE portal_roles (
      id TEXT PRIMARY KEY,
      permissions TEXT NOT NULL DEFAULT '[]'
    );
    CREATE VIEW portal_user_roles AS
      SELECT u.employee_number, r.id, r.permissions
      FROM portal_users u JOIN portal_roles r ON r.id = u.role;
    CREATE TABLE portal_access_scopes (
      employee_number TEXT NOT NULL,
      location_id TEXT NOT NULL,
      department_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(employee_number, location_id, department_id)
    );
    CREATE TABLE portal_permission_grants (
      employee_number TEXT NOT NULL,
      permission TEXT NOT NULL,
      PRIMARY KEY(employee_number, permission)
    );
    CREATE TABLE portal_permission_denials (
      employee_number TEXT NOT NULL,
      permission TEXT NOT NULL,
      PRIMARY KEY(employee_number, permission)
    );
  `);
  ensureSqlitePersonnelLifecycleScopedRightsSchema(database);
  return {
    database,
    databasePath,
    close() {
      database.close();
    },
    cleanup() {
      const resolvedRoot = path.resolve(root);
      if (resolvedRoot.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
        fs.rmSync(resolvedRoot, { recursive: true, force: true });
      }
    },
  };
}

function insertEmployeeWorkflowInstance(database, label) {
  const processId = `process-${label}`;
  const publicationId = `publication-${label}`;
  const runId = `run-${label}`;
  const stepId = `step-${label}`;
  const employeeNumber = `employee-${label}`;
  const operationId = crypto.randomUUID();
  const occurredAt = "2026-08-02T10:00:00.000Z";
  const snapshotJson = JSON.stringify({
    id: processId,
    revision: 1,
    scope: { type: "company", locationId: null, departmentId: null },
    steps: [{
      id: stepId,
      title: "Schulung bestaetigen",
      responsibilityType: "role",
      responsibilityReference: "hr",
    }],
  });
  database.prepare(`
    INSERT INTO employees (personnel_number, active) VALUES (?, 1)
  `).run(employeeNumber);
  database.prepare(`
    INSERT OR IGNORE INTO portal_roles (id, permissions)
    VALUES ('hr', '["personnel:workflows:read"]')
  `).run();
  database.prepare(`
    INSERT INTO portal_users (employee_number, password_hash, role, active)
    VALUES (?, 'test-password-hash', 'hr', 1)
  `).run(employeeNumber);
  database.prepare("INSERT INTO custom_processes (id) VALUES (?)").run(processId);
  database.prepare(`
    INSERT INTO custom_process_revisions (process_id, revision, snapshot_json)
    VALUES (?, 1, ?)
  `).run(processId, snapshotJson);
  const publication = {
    id: publicationId,
    process_id: processId,
    source_revision: 1,
    version_number: 1,
    workflow_code: `training-${label}`,
    workflow_type: "training",
    authority_level: "central",
    requirement_kind: "mandatory",
    data_classification: "standard",
    scope_type: "company",
    location_id: null,
    department_id: null,
    snapshot_json: snapshotJson,
    snapshot_sha256: sha256(snapshotJson),
    published_by: "PL-PLUS",
    published_at: occurredAt,
  };
  publication.receipt_sha256 = sha256(JSON.stringify(
    personnelWorkflowPublicationReceiptBody(publication),
  ));
  database.prepare(`
    INSERT INTO custom_process_publications (
      id, process_id, source_revision, version_number, workflow_code,
      workflow_type, authority_level, requirement_kind, data_classification,
      scope_type, location_id, department_id, snapshot_json, snapshot_sha256,
      receipt_sha256, published_by, published_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    publication.id,
    publication.process_id,
    publication.source_revision,
    publication.version_number,
    publication.workflow_code,
    publication.workflow_type,
    publication.authority_level,
    publication.requirement_kind,
    publication.data_classification,
    publication.scope_type,
    publication.location_id,
    publication.department_id,
    publication.snapshot_json,
    publication.snapshot_sha256,
    publication.receipt_sha256,
    publication.published_by,
    publication.published_at,
  );
  database.prepare(`
    INSERT INTO custom_process_runs (
      id, process_id, process_revision, trigger_type, trigger_key, status,
      triggered_by, activation_count, created_at, updated_at
    ) VALUES (?, ?, 1, 'personnel_manual', ?, 'open', 'PL-PLUS', 1, ?, ?)
  `).run(runId, processId, `personnel:${operationId}`, occurredAt, occurredAt);
  const binding = {
    run_id: runId,
    publication_id: publicationId,
    operation_id: operationId,
    subject_type: "employee",
    candidate_id: null,
    application_id: null,
    candidate_revision: null,
    application_revision: null,
    employee_number: employeeNumber,
    location_id: null,
    department_id: null,
    request_sha256: "a".repeat(64),
    started_by: "PL-PLUS",
    started_at: occurredAt,
  };
  binding.receipt_sha256 = sha256(JSON.stringify(
    personnelWorkflowInstanceReceiptBody(binding),
  ));
  database.prepare(`
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
    binding.receipt_sha256,
    binding.started_by,
    binding.started_at,
  );
  database.prepare(`
    INSERT INTO custom_process_run_steps (run_id, step_id, sort_order)
    VALUES (?, ?, 1)
  `).run(runId, stepId);
  const assignment = {
    run_id: runId,
    step_id: stepId,
    employee_number: employeeNumber,
    responsibility_type: "role",
    responsibility_reference: "hr",
    assigned_by: binding.started_by,
    assigned_at: binding.started_at,
  };
  assignment.receipt_sha256 = sha256(JSON.stringify(
    personnelWorkflowTaskAssignmentReceiptBody(assignment),
  ));
  database.prepare(`
    INSERT INTO custom_process_run_step_assignments (
      run_id, step_id, employee_number, responsibility_type,
      responsibility_reference, assigned_by, assigned_at, receipt_sha256
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    assignment.run_id,
    assignment.step_id,
    assignment.employee_number,
    assignment.responsibility_type,
    assignment.responsibility_reference,
    assignment.assigned_by,
    assignment.assigned_at,
    assignment.receipt_sha256,
  );
  database.prepare(`
    UPDATE custom_process_run_steps
    SET status = 'active', activated_at = ?, updated_at = ?
    WHERE run_id = ? AND step_id = ?
  `).run(occurredAt, occurredAt, runId, stepId);
  return { publicationId, runId };
}

function replacePublicationContract(database, publicationId, change) {
  const immutableTrigger = PERSONNEL_WORKFLOW_TRIGGER_DEFINITIONS.find(
    ({ name }) => name === "trg_custom_process_publications_immutable_update",
  );
  const current = database.prepare(`
    SELECT * FROM custom_process_publications WHERE id = ?
  `).get(publicationId);
  const replacement = change({ ...current });
  replacement.snapshot_sha256 = sha256(replacement.snapshot_json);
  replacement.receipt_sha256 = sha256(JSON.stringify(
    personnelWorkflowPublicationReceiptBody(replacement),
  ));
  database.exec("DROP TRIGGER trg_custom_process_publications_immutable_update");
  database.prepare(`
    UPDATE custom_process_publications
    SET workflow_type = ?, snapshot_json = ?, snapshot_sha256 = ?, receipt_sha256 = ?
    WHERE id = ?
  `).run(
    replacement.workflow_type,
    replacement.snapshot_json,
    replacement.snapshot_sha256,
    replacement.receipt_sha256,
    replacement.id,
  );
  database.exec(immutableTrigger.sql);
}

function publicationReceiptBody(row) {
  return {
    schemaVersion: 1,
    id: row.id,
    processId: row.processId,
    sourceRevision: row.sourceRevision,
    versionNumber: row.versionNumber,
    workflowCode: row.workflowCode,
    workflowType: row.workflowType,
    authorityLevel: row.authorityLevel,
    requirementKind: row.requirementKind,
    dataClassification: row.dataClassification,
    scope: {
      type: row.scopeType,
      locationId: row.locationId,
      departmentId: row.departmentId,
    },
    snapshotSha256: row.snapshotSha256,
    publishedBy: row.publishedBy,
    publishedAt: row.publishedAt,
  };
}

function insertPublication(database, { manipulatedSnapshotHash = false } = {}) {
  const snapshot = {
    id: "process-onboarding",
    revision: 1,
    scope: {
      type: "company",
      locationId: null,
      departmentId: null,
    },
    steps: [{ id: "welcome", title: "Willkommen" }],
  };
  const snapshotJson = JSON.stringify(snapshot);
  database.prepare("INSERT INTO custom_processes (id) VALUES (?)")
    .run(snapshot.id);
  database.prepare(`
    INSERT INTO custom_process_revisions (process_id, revision, snapshot_json)
    VALUES (?, ?, ?)
  `).run(snapshot.id, snapshot.revision, snapshotJson);

  const publication = {
    id: "publication-onboarding-v1",
    processId: snapshot.id,
    sourceRevision: snapshot.revision,
    versionNumber: 1,
    workflowCode: "onboarding-standard",
    workflowType: "onboarding",
    authorityLevel: "central",
    requirementKind: "mandatory",
    dataClassification: "standard",
    scopeType: "company",
    locationId: null,
    departmentId: null,
    snapshotSha256: manipulatedSnapshotHash ? "f".repeat(64) : sha256(snapshotJson),
    publishedBy: "PL-PLUS",
    publishedAt: "2026-08-01T12:00:00.000Z",
  };
  const receiptSha256 = sha256(JSON.stringify(publicationReceiptBody(publication)));
  database.prepare(`
    INSERT INTO custom_process_publications (
      id, process_id, source_revision, version_number, workflow_code,
      workflow_type, authority_level, requirement_kind, data_classification,
      scope_type, location_id, department_id, snapshot_json, snapshot_sha256,
      receipt_sha256, published_by, published_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    publication.id,
    publication.processId,
    publication.sourceRevision,
    publication.versionNumber,
    publication.workflowCode,
    publication.workflowType,
    publication.authorityLevel,
    publication.requirementKind,
    publication.dataClassification,
    publication.scopeType,
    publication.locationId,
    publication.departmentId,
    snapshotJson,
    publication.snapshotSha256,
    receiptSha256,
    publication.publishedBy,
    publication.publishedAt,
  );
}

test("Personalmodul M4 Import: Altstaende ohne Publikationsschicht bleiben read-only kompatibel", () => {
  const fixture = temporaryWorkflowDatabase("legacy");
  try {
    fixture.close();
    const before = fileSha256(fixture.databasePath);

    const inspection = inspectSqliteImportFile(fixture.databasePath);

    assert.equal(inspection.personnelWorkflowSchemaState, "pre-m4-compatible");
    assert.equal(inspection.protectedInspectionError, false);
    assert.equal(fileSha256(fixture.databasePath), before);
  } finally {
    try { fixture.database.close(); } catch {}
    fixture.cleanup();
  }
});

test("Personalmodul M4 Import: vollstaendiges Schema mit gueltiger Publikation wird akzeptiert", () => {
  const fixture = temporaryWorkflowDatabase("valid");
  try {
    ensureSqlitePersonnelWorkflowSchema(fixture.database);
    insertPublication(fixture.database);
    assert.equal(inspectSqlitePersonnelWorkflowSchema(fixture.database).valid, true);
    assert.equal(inspectSqlitePersonnelWorkflowRows(fixture.database).valid, true);
    fixture.close();
    const before = fileSha256(fixture.databasePath);

    const inspection = inspectSqliteImportFile(fixture.databasePath);

    assert.equal(inspection.personnelWorkflowSchemaState, "m4");
    assert.equal(inspection.protectedInspectionError, false);
    assert.equal(fileSha256(fixture.databasePath), before);
  } finally {
    try { fixture.database.close(); } catch {}
    fixture.cleanup();
  }
});

test("Personalmodul M4 Import: ein partielles Schema wird fail-closed abgelehnt", () => {
  const fixture = temporaryWorkflowDatabase("partial");
  try {
    ensureSqlitePersonnelWorkflowSchema(fixture.database);
    fixture.database.exec("DROP TRIGGER trg_custom_process_publications_immutable_delete");
    fixture.close();

    const inspection = inspectSqliteImportFile(fixture.databasePath);

    assert.equal(inspection.personnelWorkflowSchemaState, "invalid");
    assert.equal(inspection.protectedInspectionError, true);
  } finally {
    try { fixture.database.close(); } catch {}
    fixture.cleanup();
  }
});

test("Personalmodul M4 Import: manipulierte Publikationsdaten werden fail-closed abgelehnt", () => {
  const fixture = temporaryWorkflowDatabase("manipulated");
  try {
    ensureSqlitePersonnelWorkflowSchema(fixture.database);
    insertPublication(fixture.database, { manipulatedSnapshotHash: true });
    assert.equal(inspectSqlitePersonnelWorkflowSchema(fixture.database).valid, true);
    assert.deepEqual(inspectSqlitePersonnelWorkflowRows(fixture.database).issues, [
      "snapshot-hash:publication-onboarding-v1",
    ]);
    fixture.close();

    const inspection = inspectSqliteImportFile(fixture.databasePath);

    assert.equal(inspection.personnelWorkflowSchemaState, "invalid");
    assert.equal(inspection.protectedInspectionError, true);
  } finally {
    try { fixture.database.close(); } catch {}
    fixture.cleanup();
  }
});

test("Personalmodul M5 Import: vollstaendiges leeres Sidecar-Schema wird read-only akzeptiert", () => {
  const fixture = temporaryWorkflowDatabase("m5-valid");
  try {
    ensureSqlitePersonnelWorkflowSchema(fixture.database);
    ensureSqlitePersonnelWorkflowInstanceSchema(fixture.database);
    fixture.close();
    const before = fileSha256(fixture.databasePath);

    const inspection = inspectSqliteImportFile(fixture.databasePath);

    assert.equal(inspection.personnelWorkflowSchemaState, "m4");
    assert.equal(inspection.personnelWorkflowInstanceSchemaState, "m5");
    assert.equal(inspection.protectedInspectionError, false);
    assert.equal(fileSha256(fixture.databasePath), before);
  } finally {
    try { fixture.database.close(); } catch {}
    fixture.cleanup();
  }
});

test("Personalmodul M5 Import: partielles Sidecar-Schema wird fail-closed abgelehnt", () => {
  const fixture = temporaryWorkflowDatabase("m5-partial");
  try {
    ensureSqlitePersonnelWorkflowSchema(fixture.database);
    ensureSqlitePersonnelWorkflowInstanceSchema(fixture.database);
    fixture.database.exec(`
      DROP TRIGGER "${PERSONNEL_WORKFLOW_INSTANCE_TRIGGER_DEFINITIONS[0].name}"
    `);
    fixture.close();

    const inspection = inspectSqliteImportFile(fixture.databasePath);

    assert.equal(inspection.personnelWorkflowInstanceSchemaState, "invalid");
    assert.equal(inspection.protectedInspectionError, true);
  } finally {
    try { fixture.database.close(); } catch {}
    fixture.cleanup();
  }
});

test("Personalmodul M5 Import: verwaister personnel_manual-Run ohne Sidecars wird abgelehnt", () => {
  const fixture = temporaryWorkflowDatabase("m5-orphan");
  try {
    fixture.database.prepare("INSERT INTO custom_processes (id) VALUES ('orphan-process')")
      .run();
    fixture.database.prepare(`
      INSERT INTO custom_process_runs (
        id, process_id, process_revision, trigger_type, trigger_key, triggered_by
      ) VALUES (
        'orphan-run', 'orphan-process', 1, 'personnel_manual', 'orphan-key', 'PL-PLUS'
      )
    `).run();
    fixture.close();
    const before = fileSha256(fixture.databasePath);

    const inspection = inspectSqliteImportFile(fixture.databasePath);

    assert.equal(inspection.personnelWorkflowInstanceSchemaState, "invalid");
    assert.equal(inspection.protectedInspectionError, true);
    assert.equal(fileSha256(fixture.databasePath), before);
  } finally {
    try { fixture.database.close(); } catch {}
    fixture.cleanup();
  }
});

function assertM5SemanticImportRejected(label, changePublication) {
  const fixture = temporaryWorkflowDatabase(label);
  try {
    ensureSqlitePersonnelWorkflowSchema(fixture.database);
    ensureSqlitePersonnelWorkflowInstanceSchema(fixture.database);
    const instance = insertEmployeeWorkflowInstance(fixture.database, label);
    replacePublicationContract(
      fixture.database,
      instance.publicationId,
      changePublication,
    );
    assert.equal(inspectSqlitePersonnelWorkflowRows(fixture.database).valid, true);
    assert.deepEqual(inspectSqlitePersonnelWorkflowInstanceRows(fixture.database).issues, [
      `binding-relation:${instance.runId}`,
    ]);
    fixture.close();
    const before = fileSha256(fixture.databasePath);

    const inspection = inspectSqliteImportFile(fixture.databasePath);

    assert.equal(inspection.personnelWorkflowSchemaState, "m4");
    assert.equal(inspection.personnelWorkflowInstanceSchemaState, "invalid");
    assert.equal(inspection.protectedInspectionError, true);
    assert.equal(fileSha256(fixture.databasePath), before);
  } finally {
    try { fixture.database.close(); } catch {}
    fixture.cleanup();
  }
}

test("Personalmodul M5 Import: custom_personnel-Bindung bleibt fail-closed", () => {
  assertM5SemanticImportRejected("m5-deferred-type", (publication) => ({
    ...publication,
    workflow_type: "custom_personnel",
  }));
});

test("Personalmodul M5 Import: Snapshot-Benachrichtigungen bleiben fail-closed", () => {
  assertM5SemanticImportRejected("m5-notifications", (publication) => {
    const snapshot = JSON.parse(publication.snapshot_json);
    snapshot.steps[0].notificationChannels = ["email"];
    return {
      ...publication,
      snapshot_json: JSON.stringify(snapshot),
    };
  });
});
