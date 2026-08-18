"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  competencyReceiptSha256,
  competencyRevisionReceiptSha256,
} = require("../lib/personnel-learning-competencies");
const { normalizePersonnelLearningSkillInput } = require("../lib/personnel-learning-skills");
const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  PERSONNEL_LEARNING_COMPETENCY_INDEX_NAMES,
  PERSONNEL_LEARNING_COMPETENCY_MIGRATION_ID,
  PERSONNEL_LEARNING_COMPETENCY_TABLE_NAMES,
  PERSONNEL_LEARNING_COMPETENCY_TRIGGER_NAMES,
  inspectSqlitePersonnelLearningCompetencyRows,
  inspectSqlitePersonnelLearningCompetencySchema,
} = require("../lib/persistence/sqlite/operations/personnel-learning-competency-schema");
const {
  moduleEventReceiptSha256,
  moduleReceiptSha256,
  moduleVersionReceiptSha256,
  sha256Text,
} = require("../lib/persistence/sqlite/operations/personnel-learning-schema");
const {
  runSqliteStartupSchemaMigrations,
} = require("../lib/persistence/sqlite/operations/startup-schema-migrations");
const { openSqliteLegacyDatabase } = require("../lib/persistence/sqlite/provider");
const { canonicalSha256 } = require("../lib/work-rules/receipt");

const LOCATION = "competency-foundation-location";
const EMPLOYEE = "COMPETENCY-FOUNDATION-EMPLOYEE";
const ACTOR = "COMPETENCY-FOUNDATION-ACTOR";

function runMigrations(database, onBackup = () => {}, databaseExistedBeforeOpen = true) {
  return runSqliteStartupSchemaMigrations({
    database,
    databaseExistedBeforeOpen,
    appVersion: "0.92.8-competency-test",
    ensureApplicationSchema: () => ensureSqliteApplicationSchema(database),
    createPreMigrationBackup: onBackup,
    workRuleSha256: canonicalSha256,
  });
}

function insertFoundation(database) {
  database.prepare(`
    INSERT INTO locations (id, name, active) VALUES (?, 'Kompetenzfiliale', 1)
  `).run(LOCATION);
  database.prepare(`
    INSERT INTO employees (
      personnel_number, full_name, nickname, home_location_id, active
    ) VALUES (?, 'Kompetenz Testperson', 'Kompetenz', ?, 1)
  `).run(EMPLOYEE, LOCATION);
}

function eventRow({ moduleId, sequenceNumber, eventType, versionNumber = null, previous = "" }) {
  const payloadJson = JSON.stringify(versionNumber
    ? { versionNumber } : { catalogEntity: "skill" });
  const row = {
    id: `${moduleId}:event:${sequenceNumber}`,
    module_id: moduleId,
    sequence_number: sequenceNumber,
    event_type: eventType,
    module_version_number: versionNumber,
    event_payload_sha256: sha256Text(payloadJson),
    previous_receipt_sha256: previous,
    actor_id: ACTOR,
    occurred_at: `2026-08-18T10:0${sequenceNumber}:00.000Z`,
  };
  row.receipt_sha256 = moduleEventReceiptSha256(row);
  return { ...row, event_payload_json: payloadJson };
}

function insertEvent(database, row) {
  database.prepare(`
    INSERT INTO personnel_learning_module_events (
      id, module_id, sequence_number, event_type, module_version_number,
      event_payload_json, event_payload_sha256, previous_receipt_sha256,
      receipt_sha256, actor_id, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.module_id, row.sequence_number, row.event_type,
    row.module_version_number, row.event_payload_json, row.event_payload_sha256,
    row.previous_receipt_sha256, row.receipt_sha256, row.actor_id, row.occurred_at,
  );
}

function insertPublishedSkill(database, suffix = "base") {
  const moduleId = `competency-skill-${suffix}`;
  const normalized = normalizePersonnelLearningSkillInput({
    skillCode: `competency.${suffix}`,
    title: `Kompetenz ${suffix}`,
    category: "Fachwissen",
    summary: "Revisionsgebundene Testfähigkeit.",
    tags: ["Test"],
    versionNote: "Erstfassung",
    scope: { type: "location", locationId: LOCATION, departmentId: null },
    levelDefinitions: Array.from({ length: 10 }, (_entry, index) => ({
      level: index + 1,
      label: `Stufe ${index + 1}`,
      description: `Nachweisbare Definition für Stufe ${index + 1}.`,
    })),
  });
  const moduleRow = {
    id: moduleId,
    module_code: normalized.moduleCode,
    module_type: normalized.moduleType,
    created_by: ACTOR,
    created_at: "2026-08-18T10:00:00.000Z",
  };
  moduleRow.receipt_sha256 = moduleReceiptSha256(moduleRow);
  database.prepare(`
    INSERT INTO personnel_learning_modules (
      id, module_code, module_type, receipt_sha256, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    moduleRow.id, moduleRow.module_code, moduleRow.module_type,
    moduleRow.receipt_sha256, moduleRow.created_by, moduleRow.created_at,
  );
  const created = eventRow({ moduleId, sequenceNumber: 1, eventType: "created" });
  insertEvent(database, created);

  const contentJson = JSON.stringify(normalized.content);
  const scopeSnapshotJson = JSON.stringify({
    type: normalized.scope.type,
    locationId: normalized.scope.locationId,
  });
  const version = {
    module_id: moduleId,
    version_number: 1,
    title: normalized.title,
    content_json: contentJson,
    content_sha256: sha256Text(contentJson),
    scope_type: normalized.scope.type,
    scope_location_id: normalized.scope.locationId,
    scope_department_id: normalized.scope.departmentId,
    scope_snapshot_json: scopeSnapshotJson,
    scope_snapshot_sha256: sha256Text(scopeSnapshotJson),
    previous_receipt_sha256: "",
    created_by: ACTOR,
    created_at: "2026-08-18T10:02:00.000Z",
  };
  version.receipt_sha256 = moduleVersionReceiptSha256(version);
  database.prepare(`
    INSERT INTO personnel_learning_module_versions (
      module_id, version_number, title, content_json, content_sha256,
      scope_type, scope_location_id, scope_department_id, scope_snapshot_json,
      scope_snapshot_sha256, previous_receipt_sha256, receipt_sha256,
      created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    version.module_id, version.version_number, version.title, version.content_json,
    version.content_sha256, version.scope_type, version.scope_location_id,
    version.scope_department_id, version.scope_snapshot_json,
    version.scope_snapshot_sha256, version.previous_receipt_sha256,
    version.receipt_sha256, version.created_by, version.created_at,
  );
  const added = eventRow({
    moduleId,
    sequenceNumber: 2,
    eventType: "version_added",
    versionNumber: 1,
    previous: created.receipt_sha256,
  });
  insertEvent(database, added);
  const published = eventRow({
    moduleId,
    sequenceNumber: 3,
    eventType: "published",
    versionNumber: 1,
    previous: added.receipt_sha256,
  });
  insertEvent(database, published);
  return { moduleId, version };
}

function insertCompetency(database, skillId) {
  const identity = {
    id: "competency-foundation-profile",
    employeeNumber: EMPLOYEE,
    skillModuleId: skillId,
    createdBy: ACTOR,
    createdAt: "2026-08-18T11:00:00.000Z",
  };
  identity.receiptSha256 = competencyReceiptSha256(identity);
  database.prepare(`
    INSERT INTO personnel_learning_employee_competencies (
      id, employee_number, skill_module_id, receipt_sha256, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    identity.id, identity.employeeNumber, identity.skillModuleId,
    identity.receiptSha256, identity.createdBy, identity.createdAt,
  );
  const revision = {
    competencyId: identity.id,
    revisionNumber: 1,
    skillModuleId: skillId,
    skillVersionNumber: 1,
    competencyLevel: 6,
    trainerAuthorized: true,
    active: true,
    changeType: "assigned",
    previousReceiptSha256: "",
    changedBy: ACTOR,
    changedAt: "2026-08-18T11:00:00.000Z",
  };
  revision.receiptSha256 = competencyRevisionReceiptSha256(revision);
  database.prepare(`
    INSERT INTO personnel_learning_employee_competency_revisions (
      competency_id, revision_number, skill_module_id, skill_version_number,
      competency_level, trainer_authorized, active, change_type,
      previous_receipt_sha256, receipt_sha256, changed_by, changed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    revision.competencyId, revision.revisionNumber, revision.skillModuleId,
    revision.skillVersionNumber, revision.competencyLevel,
    Number(revision.trainerAuthorized), Number(revision.active), revision.changeType,
    revision.previousReceiptSha256, revision.receiptSha256,
    revision.changedBy, revision.changedAt,
  );
  return { identity, revision };
}

test("Block 4 legt getrennte unveränderliche Kompetenz- und Revisionstabellen an", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    ensureSqliteApplicationSchema(database);
    insertFoundation(database);
    const skill = insertPublishedSkill(database);
    const profile = insertCompetency(database, skill.moduleId);
    assert.deepEqual(PERSONNEL_LEARNING_COMPETENCY_TABLE_NAMES, [
      "personnel_learning_employee_competencies",
      "personnel_learning_employee_competency_revisions",
    ]);
    assert.equal(PERSONNEL_LEARNING_COMPETENCY_INDEX_NAMES.length, 4);
    assert.equal(PERSONNEL_LEARNING_COMPETENCY_TRIGGER_NAMES.length, 6);
    assert.equal(inspectSqlitePersonnelLearningCompetencySchema(database).valid, true);
    assert.deepEqual(inspectSqlitePersonnelLearningCompetencyRows(database), {
      valid: true,
      absent: false,
      issues: [],
    });
    assert.throws(() => database.prepare(`
      UPDATE personnel_learning_employee_competencies SET created_by = 'ANDERE'
      WHERE id = ?
    `).run(profile.identity.id), /immutable/);
    assert.throws(() => database.prepare(`
      DELETE FROM personnel_learning_employee_competency_revisions
      WHERE competency_id = ? AND revision_number = 1
    `).run(profile.identity.id), /immutable/);
    assert.throws(() => database.prepare(`
      INSERT INTO personnel_learning_employee_competency_revisions (
        competency_id, revision_number, skill_module_id, skill_version_number,
        competency_level, trainer_authorized, active, change_type,
        previous_receipt_sha256, receipt_sha256, changed_by, changed_at
      ) VALUES (?, 3, ?, 1, 6, 0, 1, 'updated', ?, ?, ?, ?)
    `).run(
      profile.identity.id, skill.moduleId, profile.revision.receiptSha256,
      "1".repeat(64), ACTOR, "2026-08-18T12:00:00.000Z",
    ), /revision chain is invalid/);
  } finally {
    database.close();
  }
});

test("Block 4 akzeptiert nur veröffentlichte Skill-Versionen mit vollständiger 10er-Leiter", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    ensureSqliteApplicationSchema(database);
    insertFoundation(database);
    const skill = insertPublishedSkill(database, "publication");
    const profile = insertCompetency(database, skill.moduleId);
    const invalid = {
      competencyId: profile.identity.id,
      revisionNumber: 2,
      skillModuleId: skill.moduleId,
      skillVersionNumber: 99,
      competencyLevel: 7,
      trainerAuthorized: false,
      active: true,
      changeType: "updated",
      previousReceiptSha256: profile.revision.receiptSha256,
      changedBy: ACTOR,
      changedAt: "2026-08-18T12:00:00.000Z",
    };
    invalid.receiptSha256 = competencyRevisionReceiptSha256(invalid);
    assert.throws(() => database.prepare(`
      INSERT INTO personnel_learning_employee_competency_revisions (
        competency_id, revision_number, skill_module_id, skill_version_number,
        competency_level, trainer_authorized, active, change_type,
        previous_receipt_sha256, receipt_sha256, changed_by, changed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      invalid.competencyId, invalid.revisionNumber, invalid.skillModuleId,
      invalid.skillVersionNumber, invalid.competencyLevel,
      Number(invalid.trainerAuthorized), Number(invalid.active), invalid.changeType,
      invalid.previousReceiptSha256, invalid.receiptSha256,
      invalid.changedBy, invalid.changedAt,
    ), /revision chain is invalid|FOREIGN KEY/);
  } finally {
    database.close();
  }
});

test("Block 4 Startup-Migration sichert einmal, markiert idempotent und stoppt bei Datenschemadrift", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    let backups = 0;
    const initial = runMigrations(database, () => { backups += 1; }, false);
    assert.equal(initial.personnelLearningCompetencyMigrationRequired, true);
    assert.equal(backups, 0);
    assert.ok(database.prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
      .get(PERSONNEL_LEARNING_COMPETENCY_MIGRATION_ID));

    const triggerName = "trg_personnel_learning_employee_competency_revisions_chain";
    database.exec(`DROP TRIGGER ${triggerName}`);
    const repaired = runMigrations(database, () => { backups += 1; });
    assert.equal(repaired.personnelLearningCompetencyMigrationRequired, true);
    assert.equal(backups, 1);
    assert.equal(inspectSqlitePersonnelLearningCompetencySchema(database).valid, true);
    const repeated = runMigrations(database);
    assert.equal(repeated.personnelLearningCompetencyMigrationRequired, false);
    assert.equal(backups, 1);

    insertFoundation(database);
    const skill = insertPublishedSkill(database, "drift");
    insertCompetency(database, skill.moduleId);
    database.exec(`
      DROP TRIGGER trg_personnel_learning_employee_competency_revisions_immutable_delete;
      DROP TRIGGER trg_personnel_learning_employee_competency_revisions_immutable_update;
      DROP TABLE personnel_learning_employee_competency_revisions;
    `);
    assert.throws(() => runMigrations(database), (error) => (
      error?.code === "PERSONNEL_LEARNING_COMPETENCY_SCHEMA_DATA_PRESENT"
    ));
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM personnel_learning_employee_competencies
    `).get().count, 1);
  } finally {
    database.close();
  }
});
