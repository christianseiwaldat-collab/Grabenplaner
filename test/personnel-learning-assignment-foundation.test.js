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

const { insertOrganization, insertPublishedModule, insertPublishedModuleVersion, insertTrainerCompetency, insertAssignment, insertAssignmentRevision, populatedDatabase, insertProgressRevision, skillInput, processInput } = require("../test-support/personnel-learning/fixture");

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
