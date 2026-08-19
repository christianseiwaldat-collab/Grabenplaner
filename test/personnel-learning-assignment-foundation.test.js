"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assignmentReceiptSha256,
  assignmentRevisionReceiptSha256,
  trainerBindingsSha256,
} = require("../lib/personnel-learning-assignments");
const {
  personnelLearningProgressRevisionReceiptSha256,
  progressStepStatesSha256,
} = require("../lib/personnel-learning-progress");
const {
  competencyReceiptSha256,
  competencyRevisionReceiptSha256,
} = require("../lib/personnel-learning-competencies");
const {
  normalizePersonnelLearningTemplateInput,
} = require("../lib/personnel-learning-catalog");
const {
  normalizePersonnelLearningSkillInput,
} = require("../lib/personnel-learning-skills");
const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  PERSONNEL_LEARNING_ASSIGNMENT_INDEX_NAMES,
  PERSONNEL_LEARNING_ASSIGNMENT_MIGRATION_ID,
  PERSONNEL_LEARNING_ASSIGNMENT_TABLE_NAMES,
  PERSONNEL_LEARNING_ASSIGNMENT_TRIGGER_NAMES,
  inspectSqlitePersonnelLearningAssignmentRows,
  inspectSqlitePersonnelLearningAssignmentSchema,
} = require("../lib/persistence/sqlite/operations/personnel-learning-assignment-schema");
const {
  PERSONNEL_LEARNING_PROGRESS_INDEX_NAMES,
  PERSONNEL_LEARNING_PROGRESS_MIGRATION_ID,
  PERSONNEL_LEARNING_PROGRESS_TABLE_NAMES,
  PERSONNEL_LEARNING_PROGRESS_TRIGGER_NAMES,
  inspectSqlitePersonnelLearningProgressRows,
  inspectSqlitePersonnelLearningProgressSchema,
} = require("../lib/persistence/sqlite/operations/personnel-learning-progress-schema");
const {
  moduleEventReceiptSha256,
  moduleReceiptSha256,
  moduleVersionReceiptSha256,
} = require("../lib/persistence/sqlite/operations/personnel-learning-schema");
const {
  runSqliteStartupSchemaMigrations,
} = require("../lib/persistence/sqlite/operations/startup-schema-migrations");
const { openSqliteLegacyDatabase } = require("../lib/persistence/sqlite/provider");
const { canonicalSha256 } = require("../lib/work-rules/receipt");

const LOCATION_A = "assignment-foundation-a";
const LOCATION_B = "assignment-foundation-b";
const LEARNER = "ASSIGNMENT-LEARNER";
const TRAINER = "ASSIGNMENT-TRAINER";
const ACTOR = "ASSIGNMENT-ACTOR";

function runMigrations(database, onBackup = () => {}, databaseExistedBeforeOpen = true) {
  return runSqliteStartupSchemaMigrations({
    database,
    databaseExistedBeforeOpen,
    appVersion: "0.92.8-assignment-test",
    ensureApplicationSchema: () => ensureSqliteApplicationSchema(database),
    createPreMigrationBackup: onBackup,
    workRuleSha256: canonicalSha256,
  });
}

function insertOrganization(database) {
  database.prepare("INSERT INTO locations (id, name, active) VALUES (?, ?, 1)")
    .run(LOCATION_A, "Lernfiliale A");
  database.prepare("INSERT INTO locations (id, name, active) VALUES (?, ?, 1)")
    .run(LOCATION_B, "Lernfiliale B");
  database.prepare(`
    INSERT INTO employees (
      personnel_number, full_name, nickname, home_location_id, active
    ) VALUES (?, ?, ?, ?, 1)
  `).run(LEARNER, "Lernende Person", "Lernend", LOCATION_A);
  database.prepare(`
    INSERT INTO employees (
      personnel_number, full_name, nickname, home_location_id, active
    ) VALUES (?, ?, ?, ?, 1)
  `).run(TRAINER, "Filialübergreifende Trainerperson", "Training", LOCATION_B);
}

function eventRow({ moduleId, sequenceNumber, eventType, versionNumber = null, previous = "" }) {
  const payload = versionNumber ? { versionNumber } : { created: true };
  const payloadJson = JSON.stringify(payload);
  const row = {
    id: `${moduleId}:event:${sequenceNumber}`,
    module_id: moduleId,
    sequence_number: sequenceNumber,
    event_type: eventType,
    module_version_number: versionNumber,
    event_payload_sha256: canonicalSha256(payload),
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

function insertPublishedModule(database, moduleId, normalized) {
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
  const scopeSnapshot = {
    type: normalized.scope.type,
    ...(normalized.scope.locationId ? { locationId: normalized.scope.locationId } : {}),
    ...(normalized.scope.departmentId ? { departmentId: normalized.scope.departmentId } : {}),
  };
  const scopeSnapshotJson = JSON.stringify(scopeSnapshot);
  const version = {
    module_id: moduleId,
    version_number: 1,
    title: normalized.title,
    content_json: contentJson,
    content_sha256: canonicalSha256(normalized.content),
    scope_type: normalized.scope.type,
    scope_location_id: normalized.scope.locationId,
    scope_department_id: normalized.scope.departmentId,
    scope_snapshot_json: scopeSnapshotJson,
    scope_snapshot_sha256: canonicalSha256(scopeSnapshot),
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
  return version;
}

function insertPublishedModuleVersion(database, moduleId, normalized, versionNumber = 2) {
  const previousVersion = database.prepare(`
    SELECT receipt_sha256
    FROM personnel_learning_module_versions
    WHERE module_id = ? AND version_number = ?
  `).get(moduleId, versionNumber - 1);
  const previousEvent = database.prepare(`
    SELECT sequence_number, receipt_sha256
    FROM personnel_learning_module_events
    WHERE module_id = ?
    ORDER BY sequence_number DESC
    LIMIT 1
  `).get(moduleId);
  const contentJson = JSON.stringify(normalized.content);
  const scopeSnapshot = {
    type: normalized.scope.type,
    ...(normalized.scope.locationId ? { locationId: normalized.scope.locationId } : {}),
    ...(normalized.scope.departmentId ? { departmentId: normalized.scope.departmentId } : {}),
  };
  const scopeSnapshotJson = JSON.stringify(scopeSnapshot);
  const version = {
    module_id: moduleId,
    version_number: versionNumber,
    title: normalized.title,
    content_json: contentJson,
    content_sha256: canonicalSha256(normalized.content),
    scope_type: normalized.scope.type,
    scope_location_id: normalized.scope.locationId,
    scope_department_id: normalized.scope.departmentId,
    scope_snapshot_json: scopeSnapshotJson,
    scope_snapshot_sha256: canonicalSha256(scopeSnapshot),
    previous_receipt_sha256: previousVersion.receipt_sha256,
    created_by: ACTOR,
    created_at: "2026-08-18T10:04:00.000Z",
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
    sequenceNumber: previousEvent.sequence_number + 1,
    eventType: "version_added",
    versionNumber,
    previous: previousEvent.receipt_sha256,
  });
  insertEvent(database, added);
  insertEvent(database, eventRow({
    moduleId,
    sequenceNumber: previousEvent.sequence_number + 2,
    eventType: "published",
    versionNumber,
    previous: added.receipt_sha256,
  }));
  return version;
}

function skillInput() {
  return normalizePersonnelLearningSkillInput({
    skillCode: "assignment.trainer.skill",
    title: "Drohnen inklusive Praxis",
    category: "Fachwissen",
    summary: "Revisionsgebundene Trainerfähigkeit.",
    tags: ["Praxis"],
    versionNote: "Erstfassung",
    scope: { type: "organization", locationId: null, departmentId: null },
    levelDefinitions: Array.from({ length: 10 }, (_entry, index) => ({
      level: index + 1,
      label: `Stufe ${index + 1}`,
      description: `Nachweisbare Fähigkeitsstufe ${index + 1}.`,
    })),
  });
}

function processInput() {
  return normalizePersonnelLearningTemplateInput({
    moduleCode: "assignment.training.process",
    moduleType: "training",
    title: "Drohnen-Praxisschulung",
    summary: "Transparente Einteilung.",
    objective: "Sicherer praktischer Umgang mit Drohnen.",
    estimatedMinutes: 90,
    verificationMode: "practical_check",
    tags: ["Praxis"],
    versionNote: "Erstfassung",
    scope: { type: "organization", locationId: null, departmentId: null },
    steps: [{
      stepCode: "praxis",
      title: "Praxis durchführen",
      description: "Praktische Grundlagen transparent erklären und üben.",
      required: true,
    }],
  });
}

function insertTrainerCompetency(database, skillModuleId) {
  const identity = {
    id: "assignment-trainer-competency",
    employeeNumber: TRAINER,
    skillModuleId,
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
    skillModuleId,
    skillVersionNumber: 1,
    competencyLevel: 8,
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

function insertAssignment(database, processModuleId, competency) {
  const identity = {
    id: "assignment-foundation-record",
    processModuleId,
    learnerEmployeeNumber: LEARNER,
    createdBy: ACTOR,
    createdAt: "2026-08-18T12:00:00.000Z",
  };
  identity.receiptSha256 = assignmentReceiptSha256(identity);
  database.prepare(`
    INSERT INTO personnel_learning_assignments (
      id, process_module_id, learner_employee_number, receipt_sha256,
      created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    identity.id, identity.processModuleId, identity.learnerEmployeeNumber,
    identity.receiptSha256, identity.createdBy, identity.createdAt,
  );
  const trainerBindings = [{
    competencyId: competency.identity.id,
    competencyRevisionNumber: competency.revision.revisionNumber,
    competencyRevisionReceipt: competency.revision.receiptSha256,
    trainerEmployeeNumber: TRAINER,
    skillModuleId: competency.identity.skillModuleId,
    skillVersionNumber: competency.revision.skillVersionNumber,
    competencyLevel: competency.revision.competencyLevel,
  }];
  const revision = {
    assignmentId: identity.id,
    revisionNumber: 1,
    processModuleId,
    processVersionNumber: 1,
    active: true,
    trainerBindings,
    trainerBindingsSha256: trainerBindingsSha256(trainerBindings),
    changeType: "assigned",
    previousReceiptSha256: "",
    changedBy: ACTOR,
    changedAt: "2026-08-18T12:00:00.000Z",
  };
  revision.receiptSha256 = assignmentRevisionReceiptSha256(revision);
  insertAssignmentRevision(database, revision);
  return { identity, revision };
}

function insertAssignmentRevision(database, revision) {
  database.prepare(`
    INSERT INTO personnel_learning_assignment_revisions (
      assignment_id, revision_number, process_module_id, process_version_number,
      active, trainer_bindings_json, trainer_bindings_sha256, change_type,
      previous_receipt_sha256, receipt_sha256, changed_by, changed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    revision.assignmentId, revision.revisionNumber, revision.processModuleId,
    revision.processVersionNumber, Number(revision.active),
    JSON.stringify(revision.trainerBindings), revision.trainerBindingsSha256,
    revision.changeType, revision.previousReceiptSha256, revision.receiptSha256,
    revision.changedBy, revision.changedAt,
  );
}

function populatedDatabase(database) {
  ensureSqliteApplicationSchema(database);
  insertOrganization(database);
  insertPublishedModule(database, "assignment-skill", skillInput());
  insertPublishedModule(database, "assignment-process", processInput());
  const competency = insertTrainerCompetency(database, "assignment-skill");
  const assignment = insertAssignment(database, "assignment-process", competency);
  return { competency, assignment };
}

function insertProgressRevision(database, assignment, {
  revisionNumber = 1,
  completed = true,
  finalized = true,
  result = "passed",
  changeType = finalized ? "completed" : "progress_recorded",
  correctionReason = "",
  previousReceiptSha256 = "",
  changedAt = "2026-08-18T15:00:00.000Z",
} = {}) {
  const processSteps = processInput().content.steps;
  const stepStates = [{ stepId: processSteps[0].stepId, completed }];
  const row = {
    assignmentId: assignment.identity.id,
    revisionNumber,
    assignmentRevisionReceiptSha256: assignment.revision.receiptSha256,
    processModuleId: assignment.identity.processModuleId,
    processVersionNumber: assignment.revision.processVersionNumber,
    stepStates,
    stepStatesSha256: progressStepStatesSha256(stepStates, processSteps),
    totalStepCount: 1,
    completedStepCount: completed ? 1 : 0,
    requiredStepCount: 1,
    requiredCompletedCount: completed ? 1 : 0,
    finalized,
    result,
    assessmentNote: finalized ? "Fachlich geprüft." : "",
    changeType,
    correctionReason,
    previousReceiptSha256,
    receiptSha256: "",
    actorKind: "trainer",
    changedBy: TRAINER,
    changedAt,
  };
  row.receiptSha256 = personnelLearningProgressRevisionReceiptSha256(row, processSteps);
  database.prepare(`
    INSERT INTO personnel_learning_assignment_progress_revisions (
      assignment_id, revision_number, assignment_revision_receipt_sha256,
      process_module_id, process_version_number, step_states_json,
      step_states_sha256, total_step_count, completed_step_count,
      required_step_count, required_completed_count, finalized, result,
      assessment_note, change_type, correction_reason,
      previous_receipt_sha256, receipt_sha256, actor_kind, changed_by, changed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.assignmentId, row.revisionNumber, row.assignmentRevisionReceiptSha256,
    row.processModuleId, row.processVersionNumber, JSON.stringify(row.stepStates),
    row.stepStatesSha256, row.totalStepCount, row.completedStepCount,
    row.requiredStepCount, row.requiredCompletedCount, Number(row.finalized), row.result,
    row.assessmentNote, row.changeType, row.correctionReason,
    row.previousReceiptSha256, row.receiptSha256, row.actorKind,
    row.changedBy, row.changedAt,
  );
  return row;
}

test("Block 5 speichert Prozess, lernende Person und exakte Trainer-Kompetenzrevision unveränderlich", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    const { assignment } = populatedDatabase(database);
    assert.deepEqual(PERSONNEL_LEARNING_ASSIGNMENT_TABLE_NAMES, [
      "personnel_learning_assignments",
      "personnel_learning_assignment_revisions",
    ]);
    assert.equal(PERSONNEL_LEARNING_ASSIGNMENT_INDEX_NAMES.length, 4);
    assert.equal(PERSONNEL_LEARNING_ASSIGNMENT_TRIGGER_NAMES.length, 6);
    assert.equal(inspectSqlitePersonnelLearningAssignmentSchema(database).valid, true);
    assert.deepEqual(inspectSqlitePersonnelLearningAssignmentRows(database), {
      valid: true,
      absent: false,
      issues: [],
    });
    assert.throws(() => database.prepare(`
      UPDATE personnel_learning_assignments SET created_by = 'ANDERE' WHERE id = ?
    `).run(assignment.identity.id), /immutable/);
    assert.throws(() => database.prepare(`
      DELETE FROM personnel_learning_assignment_revisions
      WHERE assignment_id = ? AND revision_number = 1
    `).run(assignment.identity.id), /immutable/);
  } finally {
    database.close();
  }
});

test("Block 5 verhindert Selbstschulung und erlaubt einen Abbruch trotz später inaktiver Trainerperson", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    const { assignment, competency } = populatedDatabase(database);
    database.prepare("UPDATE employees SET active = 0 WHERE personnel_number = ?").run(TRAINER);
    const cancelled = {
      ...assignment.revision,
      revisionNumber: 2,
      active: false,
      changeType: "cancelled",
      previousReceiptSha256: assignment.revision.receiptSha256,
      changedAt: "2026-08-18T13:00:00.000Z",
    };
    cancelled.receiptSha256 = assignmentRevisionReceiptSha256(cancelled);
    insertAssignmentRevision(database, cancelled);
    assert.equal(inspectSqlitePersonnelLearningAssignmentRows(database).valid, true);

    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare("UPDATE employees SET active = 1 WHERE personnel_number = ?").run(TRAINER);
      const selfIdentity = {
        id: "assignment-self-record",
        processModuleId: "assignment-process",
        learnerEmployeeNumber: TRAINER,
        createdBy: ACTOR,
        createdAt: "2026-08-18T14:00:00.000Z",
      };
      selfIdentity.receiptSha256 = assignmentReceiptSha256(selfIdentity);
      database.prepare(`
        INSERT INTO personnel_learning_assignments (
          id, process_module_id, learner_employee_number, receipt_sha256,
          created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        selfIdentity.id, selfIdentity.processModuleId,
        selfIdentity.learnerEmployeeNumber, selfIdentity.receiptSha256,
        selfIdentity.createdBy, selfIdentity.createdAt,
      );
      const bindings = [{
        competencyId: competency.identity.id,
        competencyRevisionNumber: 1,
        competencyRevisionReceipt: competency.revision.receiptSha256,
        trainerEmployeeNumber: TRAINER,
        skillModuleId: competency.identity.skillModuleId,
        skillVersionNumber: 1,
        competencyLevel: 8,
      }];
      const selfRevision = {
        assignmentId: selfIdentity.id,
        revisionNumber: 1,
        processModuleId: "assignment-process",
        processVersionNumber: 1,
        active: true,
        trainerBindings: bindings,
        trainerBindingsSha256: trainerBindingsSha256(bindings),
        changeType: "assigned",
        previousReceiptSha256: "",
        changedBy: ACTOR,
        changedAt: "2026-08-18T14:00:00.000Z",
      };
      selfRevision.receiptSha256 = assignmentRevisionReceiptSha256(selfRevision);
      assert.throws(() => insertAssignmentRevision(database, selfRevision), /revision chain is invalid/);
    } finally {
      database.exec("ROLLBACK");
    }
  } finally {
    database.close();
  }
});

test("Block 5 Startup-Migration sichert einmal, repariert leere Definitionen und stoppt bei Fachdaten-Drift", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    let backups = 0;
    const initial = runMigrations(database, () => { backups += 1; }, false);
    assert.equal(initial.personnelLearningAssignmentMigrationRequired, true);
    assert.equal(backups, 0);
    assert.ok(database.prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
      .get(PERSONNEL_LEARNING_ASSIGNMENT_MIGRATION_ID));

    const triggerName = "trg_personnel_learning_assignment_revisions_chain";
    database.exec(`DROP TRIGGER ${triggerName}`);
    const repaired = runMigrations(database, () => { backups += 1; });
    assert.equal(repaired.personnelLearningAssignmentMigrationRequired, true);
    assert.equal(backups, 1);
    assert.equal(inspectSqlitePersonnelLearningAssignmentSchema(database).valid, true);
    const repeated = runMigrations(database);
    assert.equal(repeated.personnelLearningAssignmentMigrationRequired, false);
    assert.equal(backups, 1);

    insertOrganization(database);
    insertPublishedModule(database, "assignment-skill", skillInput());
    insertPublishedModule(database, "assignment-process", processInput());
    const competency = insertTrainerCompetency(database, "assignment-skill");
    insertAssignment(database, "assignment-process", competency);
    database.exec(`
      DROP TRIGGER trg_personnel_learning_assignment_revisions_immutable_delete;
      DROP TRIGGER trg_personnel_learning_assignment_revisions_immutable_update;
      DROP TABLE personnel_learning_assignment_revisions;
    `);
    assert.throws(() => runMigrations(database), (error) => (
      error?.code === "PERSONNEL_LEARNING_ASSIGNMENT_SCHEMA_DATA_PRESENT"
    ));
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM personnel_learning_assignments
    `).get().count, 1);
  } finally {
    database.close();
  }
});

test("Block 6 erzwingt abgeleitete Schrittstände und eine unveränderliche Korrekturkette", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    const { assignment } = populatedDatabase(database);
    assert.deepEqual(PERSONNEL_LEARNING_PROGRESS_TABLE_NAMES, [
      "personnel_learning_assignment_progress_revisions",
    ]);
    assert.equal(PERSONNEL_LEARNING_PROGRESS_INDEX_NAMES.length, 2);
    assert.equal(PERSONNEL_LEARNING_PROGRESS_TRIGGER_NAMES.length, 3);
    const completed = insertProgressRevision(database, assignment);
    const corrected = insertProgressRevision(database, assignment, {
      revisionNumber: 2,
      completed: true,
      finalized: true,
      result: "follow_up_required",
      changeType: "corrected",
      correctionReason: "Ergebnis nach dokumentierter Rücksprache berichtigt.",
      previousReceiptSha256: completed.receiptSha256,
      changedAt: "2026-08-18T16:00:00.000Z",
    });
    assert.equal(inspectSqlitePersonnelLearningProgressSchema(database).valid, true);
    assert.deepEqual(inspectSqlitePersonnelLearningProgressRows(database), {
      valid: true,
      absent: false,
      issues: [],
    });
    assert.throws(() => insertProgressRevision(database, assignment, {
      revisionNumber: 3,
      completed: true,
      finalized: true,
      result: "passed",
      changeType: "corrected",
      correctionReason: "",
      previousReceiptSha256: corrected.receiptSha256,
    }));
    const cancelledAssignment = {
      ...assignment.revision,
      revisionNumber: 2,
      active: false,
      changeType: "cancelled",
      previousReceiptSha256: assignment.revision.receiptSha256,
      changedAt: "2026-08-18T16:15:00.000Z",
    };
    cancelledAssignment.receiptSha256 = assignmentRevisionReceiptSha256(
      cancelledAssignment,
    );
    insertAssignmentRevision(database, cancelledAssignment);
    assert.throws(() => insertProgressRevision(database, assignment, {
      revisionNumber: 3,
      completed: true,
      finalized: true,
      result: "passed",
      changeType: "corrected",
      correctionReason: "Veralteter Zuweisungsbeleg darf nicht verwendet werden.",
      previousReceiptSha256: corrected.receiptSha256,
      changedAt: "2026-08-18T16:20:00.000Z",
    }), /progress revision chain is invalid/);
    insertPublishedModuleVersion(database, assignment.identity.processModuleId, processInput());
    const assignmentVersionTwo = {
      ...cancelledAssignment,
      revisionNumber: 3,
      processVersionNumber: 2,
      active: true,
      changeType: "restored",
      previousReceiptSha256: cancelledAssignment.receiptSha256,
      changedAt: "2026-08-18T16:30:00.000Z",
    };
    assignmentVersionTwo.receiptSha256 = assignmentRevisionReceiptSha256(
      assignmentVersionTwo,
    );
    insertAssignmentRevision(database, assignmentVersionTwo);
    assert.throws(() => insertProgressRevision(database, {
      identity: assignment.identity,
      revision: assignmentVersionTwo,
    }, {
      revisionNumber: 3,
      completed: true,
      finalized: true,
      result: "passed",
      changeType: "corrected",
      correctionReason: "Unzulässiger Wechsel der gebundenen Prozessversion.",
      previousReceiptSha256: corrected.receiptSha256,
      changedAt: "2026-08-18T17:00:00.000Z",
    }), /progress revision chain is invalid/);
    assert.throws(() => database.prepare(`
      UPDATE personnel_learning_assignment_progress_revisions
      SET result = 'passed'
      WHERE assignment_id = ? AND revision_number = 2
    `).run(assignment.identity.id), /immutable/);
    assert.throws(() => database.prepare(`
      DELETE FROM personnel_learning_assignment_progress_revisions
      WHERE assignment_id = ? AND revision_number = 1
    `).run(assignment.identity.id), /immutable/);
  } finally {
    database.close();
  }
});

test("Block 6 Startup-Migration repariert leere Definitionen und stoppt bei Fortschrittsdrift", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    let backups = 0;
    const initial = runMigrations(database, () => { backups += 1; }, false);
    assert.equal(initial.personnelLearningProgressMigrationRequired, true);
    assert.equal(backups, 0);
    assert.ok(database.prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
      .get(PERSONNEL_LEARNING_PROGRESS_MIGRATION_ID));

    database.exec("DROP TRIGGER trg_personnel_learning_assignment_progress_revisions_chain");
    const repaired = runMigrations(database, () => { backups += 1; });
    assert.equal(repaired.personnelLearningProgressMigrationRequired, true);
    assert.equal(backups, 1);
    assert.equal(inspectSqlitePersonnelLearningProgressSchema(database).valid, true);
    const repeated = runMigrations(database);
    assert.equal(repeated.personnelLearningProgressMigrationRequired, false);

    const { assignment } = populatedDatabase(database);
    insertProgressRevision(database, assignment);
    database.exec(`
      DROP TRIGGER trg_personnel_learning_assignment_progress_revisions_immutable_update;
      UPDATE personnel_learning_assignment_progress_revisions
      SET receipt_sha256 = '${"b".repeat(64)}';
    `);
    assert.throws(() => runMigrations(database, () => { backups += 1; }), (error) => (
      error?.code === "PERSONNEL_LEARNING_PROGRESS_SCHEMA_DATA_PRESENT"
    ));
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count
      FROM personnel_learning_assignment_progress_revisions
    `).get().count, 1);
  } finally {
    database.close();
  }
});
