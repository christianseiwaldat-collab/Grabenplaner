"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  personnelWorkflowPublicationReceiptBody,
} = require("../lib/personnel-workflow-publication-receipt");
const {
  personnelWorkflowInstanceReceiptBody,
  personnelWorkflowTaskAssignmentReceiptBody,
} = require("../lib/personnel-workflow-instance-receipt");
const {
  PERSONNEL_WORKFLOW_MIGRATION_ID,
  PERSONNEL_WORKFLOW_TABLE_NAMES,
  PERSONNEL_WORKFLOW_TRIGGER_DEFINITIONS,
  inspectSqlitePersonnelWorkflowRows,
  inspectSqlitePersonnelWorkflowSchema,
} = require("../lib/persistence/sqlite/operations/personnel-workflow-schema");
const {
  PERSONNEL_WORKFLOW_INSTANCE_MIGRATION_ID,
  PERSONNEL_WORKFLOW_INSTANCE_TABLE_NAMES,
  PERSONNEL_WORKFLOW_INSTANCE_TRIGGER_DEFINITIONS,
  inspectSqlitePersonnelWorkflowInstanceRows,
  inspectSqlitePersonnelWorkflowInstanceSchema,
} = require("../lib/persistence/sqlite/operations/personnel-workflow-instance-schema");
const {
  runSqliteStartupSchemaMigrations,
} = require("../lib/persistence/sqlite/operations/startup-schema-migrations");
const {
  openSqliteLegacyDatabase,
} = require("../lib/persistence/sqlite/provider");
const { canonicalSha256 } = require("../lib/work-rules/receipt");

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function runMigrations(database, {
  databaseExistedBeforeOpen = false,
  onBackup = () => {},
} = {}) {
  return runSqliteStartupSchemaMigrations({
    database,
    databaseExistedBeforeOpen,
    appVersion: "0.89-personnel-workflow-test",
    ensureApplicationSchema: () => ensureSqliteApplicationSchema(database),
    createPreMigrationBackup: onBackup,
    workRuleSha256: canonicalSha256,
  });
}

function markUnrelatedStartupMigrationsApplied(database) {
  const migrationIds = [
    "v0.60-portal-mobile-foundation",
    "v0.71-cost-centers-personnel",
    "v0.87-cost-center-types",
    "v0.87-employee-cost-center-assignment",
    "v0.71-shift-locations",
    "v0.81-austrian-work-rule-engine",
    "v0.82-leave-records-privacy",
    "v0.82-protected-vacation-history",
    "v0.83-payroll-handoffs",
    "v0.84-product-readiness",
    "v0.85-loan-module-foundation",
    "v0.87-loan-photo-pdf-attachments",
    "v0.85-collective-agreement-register",
    "v0.86-work-rule-governance",
    "v0.87-block7-settings-appearance",
    "v0.87-block8-principal-separation",
    "v0.89-personal-notification-preferences",
    "v0.89-personnel-lifecycle-candidate-foundation",
    "v0.89-personnel-lifecycle-conversion",
    "v0.89-personnel-lifecycle-scoped-rights",
  ];
  const insert = database.prepare(`
    INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)
  `);
  for (const id of migrationIds) insert.run(id, "0.89-test-baseline");
  const insertType = database.prepare(`
    INSERT OR IGNORE INTO cost_center_types (
      id, code, name, is_branch, active, builtin
    ) VALUES (?, ?, ?, ?, 1, 1)
  `);
  insertType.run("branch", "FIL", "Filiale", 1);
  insertType.run("administration", "VERW", "Verwaltung", 0);
  insertType.run("production", "PROD", "Produktion", 0);
  insertType.run("other", "SONST", "Sonstige", 0);
  database.prepare(`
    INSERT OR IGNORE INTO cost_centers (
      id, code, name, type, cost_center_type_id, active
    ) VALUES ('cc-administration', 'VERW', 'Verwaltung', 'administration', 'administration', 1)
  `).run();
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_employees_organization_login_insert
    BEFORE INSERT ON employees
    WHEN EXISTS (
      SELECT 1 FROM portal_organization_accounts
      WHERE login_name = NEW.personnel_number COLLATE NOCASE
    )
    BEGIN
      SELECT RAISE(ABORT, 'PORTAL_PRINCIPAL_LOGIN_CONFLICT');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_employees_organization_login_update
    BEFORE UPDATE OF personnel_number ON employees
    WHEN EXISTS (
      SELECT 1 FROM portal_organization_accounts
      WHERE login_name = NEW.personnel_number COLLATE NOCASE
    )
    BEGIN
      SELECT RAISE(ABORT, 'PORTAL_PRINCIPAL_LOGIN_CONFLICT');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_organization_accounts_employee_login_insert
    BEFORE INSERT ON portal_organization_accounts
    WHEN EXISTS (
      SELECT 1 FROM employees
      WHERE personnel_number = NEW.login_name COLLATE NOCASE
    ) OR EXISTS (
      SELECT 1 FROM portal_users
      WHERE employee_number = NEW.login_name COLLATE NOCASE
    )
    BEGIN
      SELECT RAISE(ABORT, 'PORTAL_PRINCIPAL_LOGIN_CONFLICT');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_organization_accounts_employee_login_update
    BEFORE UPDATE OF login_name ON portal_organization_accounts
    WHEN EXISTS (
      SELECT 1 FROM employees
      WHERE personnel_number = NEW.login_name COLLATE NOCASE
    ) OR EXISTS (
      SELECT 1 FROM portal_users
      WHERE employee_number = NEW.login_name COLLATE NOCASE
    )
    BEGIN
      SELECT RAISE(ABORT, 'PORTAL_PRINCIPAL_LOGIN_CONFLICT');
    END;
  `);
}

function removePersonnelWorkflowPublicationLayer(database) {
  removePersonnelWorkflowInstanceLayer(database);
  for (const definition of PERSONNEL_WORKFLOW_TRIGGER_DEFINITIONS) {
    database.exec(`DROP TRIGGER IF EXISTS "${definition.name}"`);
  }
  for (const name of [...PERSONNEL_WORKFLOW_TABLE_NAMES].reverse()) {
    database.exec(`DROP TABLE IF EXISTS "${name}"`);
  }
  database.prepare("DELETE FROM schema_migrations WHERE id = ?")
    .run(PERSONNEL_WORKFLOW_MIGRATION_ID);
}

function removePersonnelWorkflowInstanceLayer(database) {
  for (const definition of PERSONNEL_WORKFLOW_INSTANCE_TRIGGER_DEFINITIONS) {
    database.exec(`DROP TRIGGER IF EXISTS "${definition.name}"`);
  }
  for (const name of [...PERSONNEL_WORKFLOW_INSTANCE_TABLE_NAMES].reverse()) {
    database.exec(`DROP TABLE IF EXISTS "${name}"`);
  }
  database.prepare("DELETE FROM schema_migrations WHERE id = ?")
    .run(PERSONNEL_WORKFLOW_INSTANCE_MIGRATION_ID);
}

function insertProcessFixture(database, suffix, { withRun = true } = {}) {
  const processId = `personnel-process-${suffix}`;
  const stepId = `personnel-step-${suffix}`;
  const runId = `personnel-run-${suffix}`;
  const occurredAt = "2026-08-01T12:00:00.000Z";
  const snapshotJson = JSON.stringify({
    id: processId,
    revision: 1,
    title: `Onboarding ${suffix}`,
    scope: { type: "company", locationId: null, departmentId: null },
    steps: [{
      id: stepId,
      sortOrder: 1,
      stepType: "actor",
      title: "Willkommen und Unterlagen",
    }],
  }, null, 2);
  database.prepare(`
    INSERT INTO custom_processes (
      id, title, symbol, description, category, scope_type,
      trigger_type, status, revision, created_by, updated_by,
      created_at, updated_at
    ) VALUES (?, ?, 'P', ?, 'other', 'company', 'manual', 'active', 1,
      'PL-PLUS', 'PL-PLUS', ?, ?)
  `).run(
    processId,
    `Onboarding ${suffix}`,
    `Historischer Prozess ${suffix}`,
    occurredAt,
    occurredAt,
  );
  database.prepare(`
    INSERT INTO custom_process_steps (
      id, process_id, sort_order, step_type, title, description,
      responsibility_type, responsibility_reference, responsibility_label,
      condition_type, condition_text, notification_channels, created_at, updated_at
    ) VALUES (?, ?, 1, 'actor', 'Willkommen und Unterlagen', 'Historischer Schritt',
      'role', 'manager', 'PL', 'always', '', '[]', ?, ?)
  `).run(stepId, processId, occurredAt, occurredAt);
  database.prepare(`
    INSERT INTO custom_process_revisions (
      process_id, revision, snapshot_json, created_by, created_at
    ) VALUES (?, 1, ?, 'PL-PLUS', ?)
  `).run(processId, snapshotJson, occurredAt);
  if (withRun) {
    database.prepare(`
      INSERT INTO custom_process_runs (
        id, process_id, process_revision, trigger_type, trigger_key,
        status, triggered_by, activation_count, created_at, updated_at
      ) VALUES (?, ?, 1, 'manual', ?, 'open', 'PL-PLUS', 1, ?, ?)
    `).run(runId, processId, `manual:${runId}`, occurredAt, occurredAt);
    database.prepare(`
      INSERT INTO custom_process_run_steps (
        run_id, step_id, sort_order, status, activated_at,
        created_at, updated_at
      ) VALUES (?, ?, 1, 'active', ?, ?, ?)
    `).run(runId, stepId, occurredAt, occurredAt, occurredAt);
  }
  return { occurredAt, processId, runId, snapshotJson, stepId };
}

function processDataBytes(database, processId) {
  return Buffer.from(JSON.stringify({
    process: database.prepare(`
      SELECT * FROM custom_processes WHERE id = ?
    `).get(processId),
    steps: database.prepare(`
      SELECT * FROM custom_process_steps WHERE process_id = ? ORDER BY sort_order, id
    `).all(processId),
    revisions: database.prepare(`
      SELECT * FROM custom_process_revisions WHERE process_id = ? ORDER BY revision
    `).all(processId),
    runs: database.prepare(`
      SELECT * FROM custom_process_runs WHERE process_id = ? ORDER BY created_at, id
    `).all(processId),
    runSteps: database.prepare(`
      SELECT runStep.*
      FROM custom_process_run_steps runStep
      JOIN custom_process_runs run ON run.id = runStep.run_id
      WHERE run.process_id = ?
      ORDER BY runStep.run_id, runStep.sort_order, runStep.step_id
    `).all(processId),
  }), "utf8");
}

function insertPublication(database, fixture, { snapshotSha256 } = {}) {
  const row = {
    id: `publication-${fixture.processId}`,
    process_id: fixture.processId,
    source_revision: 1,
    version_number: 1,
    workflow_code: `workflow-${fixture.processId}`,
    workflow_type: "onboarding",
    authority_level: "central",
    requirement_kind: "mandatory",
    data_classification: "standard",
    scope_type: "company",
    location_id: null,
    department_id: null,
    snapshot_json: fixture.snapshotJson,
    snapshot_sha256: snapshotSha256 || sha256(fixture.snapshotJson),
    published_by: "PL-PLUS",
    published_at: fixture.occurredAt,
  };
  row.receipt_sha256 = sha256(JSON.stringify(personnelWorkflowPublicationReceiptBody(row)));
  database.prepare(`
    INSERT INTO custom_process_publications (
      id, process_id, source_revision, version_number, workflow_code,
      workflow_type, authority_level, requirement_kind, data_classification,
      scope_type, location_id, department_id, snapshot_json, snapshot_sha256,
      receipt_sha256, published_by, published_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.process_id,
    row.source_revision,
    row.version_number,
    row.workflow_code,
    row.workflow_type,
    row.authority_level,
    row.requirement_kind,
    row.data_classification,
    row.scope_type,
    row.location_id,
    row.department_id,
    row.snapshot_json,
    row.snapshot_sha256,
    row.receipt_sha256,
    row.published_by,
    row.published_at,
  );
  return row;
}

function insertPersonnelWorkflowInstance(database, suffix = "m5", options = {}) {
  const occurredAt = "2026-08-02T09:00:00.000Z";
  const assignmentRole = options.assignmentRole || "hr";
  const locationId = options.locationId || null;
  const departmentId = options.departmentId || null;
  const scopeType = departmentId ? "department" : (locationId ? "location" : "company");
  const candidateId = `candidate-${suffix}`;
  const applicationId = `application-${suffix}`;
  const employeeNumber = `hr-${suffix}`;
  const processId = `process-${suffix}`;
  const stepId = `step-${suffix}`;
  const publicationId = `publication-${suffix}`;
  const runId = `run-${suffix}`;
  const operationId = crypto.randomUUID();
  const candidateRevision = 2;
  const applicationRevision = 3;
  const snapshotJson = JSON.stringify({
    id: processId,
    revision: 1,
    title: `Preboarding ${suffix}`,
    scope: { type: scopeType, locationId, departmentId },
    steps: [{
      id: stepId,
      type: "actor",
      title: "Unterlagen pruefen",
      responsibilityType: "role",
      responsibilityReference: assignmentRole,
      conditionType: "always",
    }],
  });
  if (locationId) {
    database.prepare(`
      INSERT INTO locations (id, name, active) VALUES (?, ?, 1)
    `).run(locationId, `Standort ${suffix}`);
  }
  if (departmentId) {
    database.prepare(`
      INSERT INTO departments (id, location_id, name, active)
      VALUES (?, ?, ?, 1)
    `).run(departmentId, locationId, `Abteilung ${suffix}`);
  }
  database.prepare(`
    INSERT INTO employees (
      personnel_number, full_name, nickname, home_location_id,
      preferred_department_id, active
    ) VALUES (?, ?, ?, ?, ?, 1)
  `).run(
    employeeNumber,
    `Empfaenger ${suffix}`,
    `Empfaenger ${suffix}`,
    options.homeLocationId || null,
    options.preferredDepartmentId || null,
  );
  database.prepare(`
    INSERT INTO portal_roles (id, name, builtin, permissions)
    VALUES (?, ?, 1, '["personnel:workflows:read"]')
    ON CONFLICT(id) DO UPDATE SET permissions = excluded.permissions
  `).run(assignmentRole, `Rolle ${assignmentRole}`);
  database.prepare(`
    INSERT INTO portal_users (employee_number, password_hash, role, active)
    VALUES (?, 'test-password-hash', ?, 1)
  `).run(employeeNumber, assignmentRole);
  database.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES (?, 'personnel:workflows:read', 'PL-PLUS')
  `).run(employeeNumber);
  if (locationId && options.generalScopeDepartmentId !== undefined) {
    database.prepare(`
      INSERT INTO portal_access_scopes (
        employee_number, location_id, department_id, assigned_by
      ) VALUES (?, ?, ?, 'PL-PLUS')
    `).run(employeeNumber, locationId, options.generalScopeDepartmentId);
  }
  if (locationId && options.permissionScopeDepartmentId !== undefined) {
    database.prepare(`
      INSERT INTO portal_permission_scope_grants (
        employee_number, permission, location_id, department_id, approved_by
      ) VALUES (?, 'personnel:workflows:read', ?, ?, 'PL-PLUS')
    `).run(employeeNumber, locationId, options.permissionScopeDepartmentId);
  }
  database.prepare(`
    INSERT INTO candidates (
      id, state, protected_payload, revision, created_by, updated_by,
      created_at, updated_at
    ) VALUES (?, 'active', 'enc:test', ?, 'PL-PLUS', 'PL-PLUS', ?, ?)
  `).run(candidateId, candidateRevision, occurredAt, occurredAt);
  database.prepare(`
    INSERT INTO candidate_applications (
      id, candidate_id, status, protected_payload, revision, status_changed_at,
      desired_location_id, desired_department_id,
      created_by, updated_by, created_at, updated_at
    ) VALUES (
      ?, ?, 'preboarding', 'enc:test', ?, ?, ?, ?,
      'PL-PLUS', 'PL-PLUS', ?, ?
    )
  `).run(
    applicationId,
    candidateId,
    applicationRevision,
    occurredAt,
    locationId,
    departmentId,
    occurredAt,
    occurredAt,
  );
  database.prepare(`
    INSERT INTO custom_processes (
      id, title, scope_type, location_id, department_id,
      trigger_type, status, revision,
      created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'manual', 'active', 1,
      'PL-PLUS', 'PL-PLUS', ?, ?)
  `).run(
    processId,
    `Preboarding ${suffix}`,
    scopeType,
    locationId,
    departmentId,
    occurredAt,
    occurredAt,
  );
  database.prepare(`
    INSERT INTO custom_process_steps (
      id, process_id, sort_order, step_type, title,
      responsibility_type, responsibility_reference, responsibility_label,
      condition_type, notification_channels, created_at, updated_at
    ) VALUES (?, ?, 1, 'actor', 'Unterlagen pruefen',
      'role', ?, 'Zustaendige Rolle', 'always', '[]', ?, ?)
  `).run(stepId, processId, assignmentRole, occurredAt, occurredAt);
  database.prepare(`
    INSERT INTO custom_process_revisions (
      process_id, revision, snapshot_json, created_by, created_at
    ) VALUES (?, 1, ?, 'PL-PLUS', ?)
  `).run(processId, snapshotJson, occurredAt);
  const publication = {
    id: publicationId,
    process_id: processId,
    source_revision: 1,
    version_number: 1,
    workflow_code: `preboarding-${suffix}`,
    workflow_type: "preboarding",
    authority_level: scopeType === "company" ? "central" : "local",
    requirement_kind: scopeType === "company" ? "mandatory" : "supplemental",
    data_classification: "standard",
    scope_type: scopeType,
    location_id: locationId,
    department_id: departmentId,
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
      location_id, department_id, triggered_by, activation_count, created_at, updated_at
    ) VALUES (
      ?, ?, 1, 'personnel_manual', ?, 'open', ?, ?, 'PL-PLUS', 1, ?, ?
    )
  `).run(
    runId,
    processId,
    `personnel:${operationId}`,
    locationId,
    departmentId,
    occurredAt,
    occurredAt,
  );
  const binding = {
    run_id: runId,
    publication_id: publicationId,
    operation_id: operationId,
    subject_type: "candidate",
    candidate_id: candidateId,
    application_id: applicationId,
    candidate_revision: candidateRevision,
    application_revision: applicationRevision,
    employee_number: null,
    location_id: locationId,
    department_id: departmentId,
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
    responsibility_reference: assignmentRole,
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
  return {
    ...binding,
    employeeNumber,
    processId,
    stepId,
  };
}

test("Personalmodul M4 Startup: Legacy-Prozessdaten bleiben bytegleich und werden nicht automatisch publiziert", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  const backups = [];
  try {
    runMigrations(database);
    markUnrelatedStartupMigrationsApplied(database);
    removePersonnelWorkflowPublicationLayer(database);
    const fixture = insertProcessFixture(database, "legacy");
    const before = processDataBytes(database, fixture.processId);

    const result = runMigrations(database, {
      databaseExistedBeforeOpen: true,
      onBackup: () => backups.push({
        processSha256: sha256(processDataBytes(database, fixture.processId)),
        publicationTablePresent: Boolean(database.prepare(`
          SELECT 1 FROM sqlite_master
          WHERE type = 'table' AND name = 'custom_process_publications'
        `).get()),
      }),
    });

    assert.equal(result.personnelWorkflowMigrationRequired, true);
    assert.deepEqual(backups, [{
      processSha256: sha256(before),
      publicationTablePresent: false,
    }]);
    assert.deepEqual(processDataBytes(database, fixture.processId), before);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM custom_process_publications")
      .get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?")
      .get(PERSONNEL_WORKFLOW_MIGRATION_ID).count, 1);
    assert.equal(inspectSqlitePersonnelWorkflowSchema(database).valid, true);
    assert.equal(inspectSqlitePersonnelWorkflowRows(database).valid, true);

    const rerun = runMigrations(database, {
      databaseExistedBeforeOpen: true,
      onBackup: () => backups.push("unexpected-second-backup"),
    });
    assert.equal(rerun.personnelWorkflowMigrationRequired, false);
    assert.equal(backups.length, 1);
    assert.deepEqual(processDataBytes(database, fixture.processId), before);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM custom_process_publications")
      .get().count, 0);
  } finally {
    database.close();
  }
});

test("Personalmodul M4 Startup: SQL schuetzt Publikation, Archiv und verwendete Revisionen", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    runMigrations(database);
    const published = insertProcessFixture(database, "published", { withRun: false });
    const publication = insertPublication(database, published);
    database.prepare(`
      INSERT INTO custom_process_publication_archives (
        publication_id, reason, archived_by, archived_at
      ) VALUES (?, 'Durch neue Version ersetzt', 'PL-PLUS', ?)
    `).run(publication.id, published.occurredAt);

    assert.throws(
      () => database.prepare(`
        UPDATE custom_process_publications SET published_by = 'OTHER' WHERE id = ?
      `).run(publication.id),
      /custom process publications are immutable/,
    );
    assert.throws(
      () => database.prepare("DELETE FROM custom_process_publications WHERE id = ?")
        .run(publication.id),
      /custom process publications are immutable/,
    );
    assert.throws(
      () => database.prepare(`
        UPDATE custom_process_publication_archives SET archived_by = 'OTHER'
        WHERE publication_id = ?
      `).run(publication.id),
      /custom process publication archives are immutable/,
    );
    assert.throws(
      () => database.prepare(`
        DELETE FROM custom_process_publication_archives WHERE publication_id = ?
      `).run(publication.id),
      /custom process publication archives are immutable/,
    );
    assert.throws(
      () => database.prepare(`
        UPDATE custom_process_revisions SET snapshot_json = '{}'
        WHERE process_id = ? AND revision = 1
      `).run(published.processId),
      /custom process revisions are immutable/,
    );
    assert.throws(
      () => database.prepare(`
        DELETE FROM custom_process_revisions WHERE process_id = ? AND revision = 1
      `).run(published.processId),
      /published or used custom process revisions cannot be deleted/,
    );
    assert.throws(
      () => database.prepare("DELETE FROM custom_processes WHERE id = ?")
        .run(published.processId),
      /published or used custom processes? (?:revisions )?cannot be deleted|foreign key constraint/i,
    );

    const used = insertProcessFixture(database, "used");
    assert.throws(
      () => database.prepare(`
        DELETE FROM custom_process_revisions WHERE process_id = ? AND revision = 1
      `).run(used.processId),
      /published or used custom process revisions cannot be deleted/,
    );
    assert.throws(
      () => database.prepare("DELETE FROM custom_processes WHERE id = ?")
        .run(used.processId),
      /published or used custom processes? (?:revisions )?cannot be deleted|foreign key constraint/i,
    );
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
  }
});

test("Personalmodul M4 Startup: leerer Triggerdrift wird nach genau einer Sicherung repariert", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  const backups = [];
  try {
    runMigrations(database);
    database.exec(`
      DROP TRIGGER trg_custom_process_publications_immutable_delete;
      CREATE TRIGGER trg_custom_process_publications_immutable_delete
      BEFORE DELETE ON custom_process_publications
      BEGIN
        SELECT RAISE(ABORT, 'wrong workflow publication trigger');
      END;
    `);
    assert.equal(inspectSqlitePersonnelWorkflowSchema(database).valid, false);

    const result = runMigrations(database, {
      databaseExistedBeforeOpen: true,
      onBackup: () => backups.push("pre-migration"),
    });

    assert.equal(result.personnelWorkflowMigrationRequired, true);
    assert.deepEqual(backups, ["pre-migration"]);
    assert.equal(inspectSqlitePersonnelWorkflowSchema(database).valid, true);
    assert.equal(inspectSqlitePersonnelWorkflowRows(database).valid, true);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?")
      .get(PERSONNEL_WORKFLOW_MIGRATION_ID).count, 1);
  } finally {
    database.close();
  }
});

test("Personalmodul M4 Startup: nichtleerer Daten-Drift bricht nach Sicherung unveraendert ab", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  const backups = [];
  try {
    runMigrations(database);
    const fixture = insertProcessFixture(database, "drift", { withRun: false });
    const publication = insertPublication(database, fixture, {
      snapshotSha256: "f".repeat(64),
    });
    assert.deepEqual(inspectSqlitePersonnelWorkflowRows(database).issues, [
      `snapshot-hash:${publication.id}`,
    ]);

    assert.throws(
      () => runMigrations(database, {
        databaseExistedBeforeOpen: true,
        onBackup: () => backups.push(database.prepare(`
          SELECT snapshot_sha256 FROM custom_process_publications WHERE id = ?
        `).get(publication.id).snapshot_sha256),
      }),
      (error) => error?.code === "PERSONNEL_WORKFLOW_SCHEMA_DATA_PRESENT",
    );
    assert.deepEqual(backups, ["f".repeat(64)]);
    assert.equal(database.prepare(`
      SELECT snapshot_sha256 FROM custom_process_publications WHERE id = ?
    `).get(publication.id).snapshot_sha256, "f".repeat(64));
    assert.deepEqual(inspectSqlitePersonnelWorkflowRows(database).issues, [
      `snapshot-hash:${publication.id}`,
    ]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?")
      .get(PERSONNEL_WORKFLOW_MIGRATION_ID).count, 1);
  } finally {
    database.close();
  }
});

test("Personalmodul M5 Startup: Sidecar-Schema wird additiv ohne Legacy-Backfill migriert", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  const backups = [];
  try {
    runMigrations(database);
    markUnrelatedStartupMigrationsApplied(database);
    removePersonnelWorkflowInstanceLayer(database);
    const legacy = insertProcessFixture(database, "pre-m5");
    const before = processDataBytes(database, legacy.processId);

    const result = runMigrations(database, {
      databaseExistedBeforeOpen: true,
      onBackup: () => backups.push("pre-migration"),
    });

    assert.equal(result.personnelWorkflowInstanceMigrationRequired, true);
    assert.deepEqual(backups, ["pre-migration"]);
    assert.deepEqual(processDataBytes(database, legacy.processId), before);
    assert.equal(inspectSqlitePersonnelWorkflowInstanceSchema(database).valid, true);
    assert.equal(inspectSqlitePersonnelWorkflowInstanceRows(database).valid, true);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM custom_process_run_bindings
    `).get().count, 0);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?
    `).get(PERSONNEL_WORKFLOW_INSTANCE_MIGRATION_ID).count, 1);

    const rerun = runMigrations(database, {
      databaseExistedBeforeOpen: true,
      onBackup: () => backups.push("unexpected"),
    });
    assert.equal(rerun.personnelWorkflowInstanceMigrationRequired, false);
    assert.deepEqual(backups, ["pre-migration"]);
  } finally {
    database.close();
  }
});

test("Personalmodul M5 Startup: Binding akzeptiert nur den frischen idempotenten Run", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    runMigrations(database);
    const fixture = insertPersonnelWorkflowInstance(database, "binding-guard");
    const insertRun = (runId, triggerKey) => database.prepare(`
      INSERT INTO custom_process_runs (
        id, process_id, process_revision, trigger_type, trigger_key, status,
        triggered_by, activation_count, created_at, updated_at
      ) VALUES (?, ?, 1, 'personnel_manual', ?, 'open', ?, 1, ?, ?)
    `).run(
      runId,
      fixture.processId,
      triggerKey,
      fixture.started_by,
      fixture.started_at,
      fixture.started_at,
    );
    const insertBinding = (runId, operationId, overrides = {}) => {
      const binding = {
        ...fixture,
        run_id: runId,
        operation_id: operationId,
        ...overrides,
      };
      binding.receipt_sha256 = sha256(JSON.stringify(
        personnelWorkflowInstanceReceiptBody(binding),
      ));
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
        binding.receipt_sha256,
        binding.started_by,
        binding.started_at,
      );
    };

    const wrongKeyOperationId = crypto.randomUUID();
    const wrongKeyRunId = "run-binding-wrong-key";
    insertRun(wrongKeyRunId, `wrong:${wrongKeyOperationId}`);
    assert.throws(
      () => insertBinding(wrongKeyRunId, wrongKeyOperationId),
      /personnel workflow instance binding is invalid/,
    );
    database.prepare("DELETE FROM custom_process_runs WHERE id = ?").run(wrongKeyRunId);

    const prefilledOperationId = crypto.randomUUID();
    const prefilledRunId = "run-binding-prefilled";
    insertRun(prefilledRunId, `personnel:${prefilledOperationId}`);
    database.prepare(`
      INSERT INTO custom_process_run_steps (run_id, step_id, sort_order)
      VALUES (?, ?, 1)
    `).run(prefilledRunId, fixture.stepId);
    assert.throws(
      () => insertBinding(prefilledRunId, prefilledOperationId),
      /personnel workflow instance binding is invalid/,
    );
    database.prepare("DELETE FROM custom_process_runs WHERE id = ?").run(prefilledRunId);

    const immutablePublicationTrigger = PERSONNEL_WORKFLOW_TRIGGER_DEFINITIONS.find(
      ({ name }) => name === "trg_custom_process_publications_immutable_update",
    );
    const originalPublication = database.prepare(`
      SELECT * FROM custom_process_publications WHERE id = ?
    `).get(fixture.publication_id);
    const replacePublicationContract = ({ workflowType, snapshotJson }) => {
      const replacement = {
        ...originalPublication,
        workflow_type: workflowType,
        snapshot_json: snapshotJson,
        snapshot_sha256: sha256(snapshotJson),
      };
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
      database.exec(immutablePublicationTrigger.sql);
    };

    const notificationSnapshot = JSON.parse(originalPublication.snapshot_json);
    notificationSnapshot.steps[0].notificationChannels = ["email"];
    replacePublicationContract({
      workflowType: originalPublication.workflow_type,
      snapshotJson: JSON.stringify(notificationSnapshot),
    });
    const notificationOperationId = crypto.randomUUID();
    const notificationRunId = "run-binding-notifications";
    insertRun(notificationRunId, `personnel:${notificationOperationId}`);
    assert.throws(
      () => insertBinding(notificationRunId, notificationOperationId),
      /personnel workflow instance binding is invalid/,
    );
    database.prepare("DELETE FROM custom_process_runs WHERE id = ?")
      .run(notificationRunId);

    replacePublicationContract({
      workflowType: "custom_personnel",
      snapshotJson: originalPublication.snapshot_json,
    });
    const deferredOperationId = crypto.randomUUID();
    const deferredRunId = "run-binding-deferred-type";
    insertRun(deferredRunId, `personnel:${deferredOperationId}`);
    assert.throws(
      () => insertBinding(deferredRunId, deferredOperationId, {
        subject_type: "employee",
        candidate_id: null,
        application_id: null,
        candidate_revision: null,
        application_revision: null,
        employee_number: fixture.employeeNumber,
      }),
      /personnel workflow instance binding is invalid/,
    );
    database.prepare("DELETE FROM custom_process_runs WHERE id = ?")
      .run(deferredRunId);

    replacePublicationContract({
      workflowType: originalPublication.workflow_type,
      snapshotJson: originalPublication.snapshot_json,
    });

    assert.deepEqual(inspectSqlitePersonnelWorkflowInstanceRows(database).issues, []);
  } finally {
    database.close();
  }
});

test("Personalmodul M5 Startup: SQL-Zuweisung erzwingt FL-Standort und AL-Abteilung exakt", () => {
  const cases = [
    {
      label: "manager-valid",
      accepted: true,
      assignmentRole: "manager",
      generalScopeDepartmentId: 0,
      permissionScopeDepartmentId: 0,
    },
    {
      label: "manager-department-only",
      accepted: false,
      assignmentRole: "manager",
      generalScopeDepartmentId: 901,
      permissionScopeDepartmentId: 901,
    },
    {
      label: "department-manager-valid",
      accepted: true,
      assignmentRole: "department_manager",
      generalScopeDepartmentId: 901,
      permissionScopeDepartmentId: 901,
    },
    {
      label: "department-manager-location-only",
      accepted: false,
      assignmentRole: "department_manager",
      generalScopeDepartmentId: 0,
      permissionScopeDepartmentId: 0,
    },
  ];

  for (const entry of cases) {
    const database = openSqliteLegacyDatabase(":memory:");
    try {
      runMigrations(database);
      const insert = () => insertPersonnelWorkflowInstance(database, entry.label, {
        assignmentRole: entry.assignmentRole,
        locationId: `LOC-${entry.label}`,
        departmentId: 901,
        generalScopeDepartmentId: entry.generalScopeDepartmentId,
        permissionScopeDepartmentId: entry.permissionScopeDepartmentId,
      });
      if (entry.accepted) {
        insert();
        assert.deepEqual(inspectSqlitePersonnelWorkflowInstanceRows(database).issues, []);
      } else {
        assert.throws(insert, /personnel workflow task assignment is invalid/);
      }
    } finally {
      database.close();
    }
  }
});

test("Personalmodul M5 Startup: historische Bindung bleibt nach Archivierung und Subject-Aenderung valide", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    runMigrations(database);
    const fixture = insertPersonnelWorkflowInstance(database, "history");
    assert.deepEqual(inspectSqlitePersonnelWorkflowInstanceRows(database).issues, []);

    database.prepare(`
      INSERT INTO custom_process_publication_archives (
        publication_id, reason, archived_by, archived_at
      ) VALUES (?, 'Durch eine neue Version ersetzt', 'PL-PLUS', ?)
    `).run(fixture.publication_id, "2026-08-03T08:00:00.000Z");
    database.prepare(`
      UPDATE candidates
      SET state = 'archived', revision = revision + 1,
          archived_at = '2026-08-03T08:00:00.000Z',
          updated_at = '2026-08-03T08:00:00.000Z'
      WHERE id = ?
    `).run(fixture.candidate_id);
    database.prepare(`
      UPDATE candidate_applications
      SET status = 'converted', revision = revision + 1,
          status_changed_at = '2026-08-03T08:00:00.000Z',
          updated_at = '2026-08-03T08:00:00.000Z'
      WHERE id = ? AND candidate_id = ?
    `).run(fixture.application_id, fixture.candidate_id);

    assert.deepEqual(inspectSqlitePersonnelWorkflowInstanceRows(database).issues, []);
    assert.throws(
      () => database.prepare(`
        UPDATE custom_process_runs SET process_revision = 2 WHERE id = ?
      `).run(fixture.run_id),
      /personnel workflow instance core is immutable/,
    );
    assert.throws(
      () => database.prepare(`
        UPDATE custom_process_run_steps SET sort_order = 2
        WHERE run_id = ? AND step_id = ?
      `).run(fixture.run_id, fixture.stepId),
      /personnel workflow instance step transition is invalid/,
    );
    assert.throws(
      () => database.prepare(`
        INSERT INTO custom_process_run_steps (run_id, step_id, sort_order)
        VALUES (?, 'unexpected-step', 2)
      `).run(fixture.run_id),
      /personnel workflow instance step is invalid/,
    );
    assert.throws(
      () => database.prepare(`
        DELETE FROM custom_process_run_steps WHERE run_id = ? AND step_id = ?
      `).run(fixture.run_id, fixture.stepId),
      /personnel workflow instance steps cannot be deleted/,
    );
    database.prepare(`
      UPDATE custom_process_run_steps
      SET status = 'completed', completed_at = ?, completed_by = ?,
          completion_request_id = ?, updated_at = ?
      WHERE run_id = ? AND step_id = ?
    `).run(
      "2026-08-03T08:00:00.000Z",
      fixture.employeeNumber,
      "b".repeat(64),
      "2026-08-03T08:00:00.000Z",
      fixture.run_id,
      fixture.stepId,
    );
    database.prepare(`
      UPDATE custom_process_runs
      SET status = 'resolved', resolved_at = '2026-08-03T08:00:00.000Z'
      WHERE id = ?
    `).run(fixture.run_id);
    assert.throws(
      () => database.prepare(`
        UPDATE custom_process_runs SET status = 'open', resolved_at = NULL
        WHERE id = ?
      `).run(fixture.run_id),
      /personnel workflow instance state transition is invalid/,
    );
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
  }
});

test("Personalmodul M5 Startup: verwaister personnel_manual-Run stoppt fail-closed nach Sicherung", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  const backups = [];
  try {
    runMigrations(database);
    removePersonnelWorkflowInstanceLayer(database);
    const fixture = insertProcessFixture(database, "orphan");
    database.prepare(`
      UPDATE custom_process_runs SET trigger_type = 'personnel_manual' WHERE id = ?
    `).run(fixture.runId);
    assert.deepEqual(inspectSqlitePersonnelWorkflowInstanceRows(database).issues, [
      `orphan-personnel-run:${fixture.runId}`,
    ]);

    assert.throws(
      () => runMigrations(database, {
        databaseExistedBeforeOpen: true,
        onBackup: () => backups.push("pre-migration"),
      }),
      (error) => error?.code === "PERSONNEL_WORKFLOW_INSTANCE_SCHEMA_DATA_PRESENT",
    );
    assert.deepEqual(backups, ["pre-migration"]);
    assert.equal(database.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'custom_process_run_bindings'
    `).get(), undefined);
    assert.equal(database.prepare(`
      SELECT trigger_type FROM custom_process_runs WHERE id = ?
    `).get(fixture.runId).trigger_type, "personnel_manual");
  } finally {
    database.close();
  }
});
