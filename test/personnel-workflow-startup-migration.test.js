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
  PERSONNEL_WORKFLOW_MIGRATION_ID,
  PERSONNEL_WORKFLOW_TABLE_NAMES,
  PERSONNEL_WORKFLOW_TRIGGER_DEFINITIONS,
  inspectSqlitePersonnelWorkflowRows,
  inspectSqlitePersonnelWorkflowSchema,
} = require("../lib/persistence/sqlite/operations/personnel-workflow-schema");
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
  for (const definition of PERSONNEL_WORKFLOW_TRIGGER_DEFINITIONS) {
    database.exec(`DROP TRIGGER IF EXISTS "${definition.name}"`);
  }
  for (const name of [...PERSONNEL_WORKFLOW_TABLE_NAMES].reverse()) {
    database.exec(`DROP TABLE IF EXISTS "${name}"`);
  }
  database.prepare("DELETE FROM schema_migrations WHERE id = ?")
    .run(PERSONNEL_WORKFLOW_MIGRATION_ID);
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
