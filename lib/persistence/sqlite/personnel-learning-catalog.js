"use strict";

const {
  PERSONNEL_LEARNING_STATEMENTS: S,
} = require("../statements/personnel-learning");

const moduleSelect = `
  SELECT
    id,
    module_code AS moduleCode,
    module_type AS moduleType,
    receipt_sha256 AS receiptSha256,
    created_by AS createdBy,
    created_at AS createdAt
  FROM personnel_learning_modules
`;

const versionSelect = `
  SELECT
    module_id AS moduleId,
    version_number AS versionNumber,
    title,
    content_json AS content,
    content_sha256 AS contentSha256,
    scope_type AS scopeType,
    scope_location_id AS scopeLocationId,
    scope_department_id AS scopeDepartmentId,
    scope_snapshot_json AS scopeSnapshot,
    scope_snapshot_sha256 AS scopeSnapshotSha256,
    previous_receipt_sha256 AS previousReceiptSha256,
    receipt_sha256 AS receiptSha256,
    created_by AS createdBy,
    created_at AS createdAt
  FROM personnel_learning_module_versions
`;

const eventSelect = `
  SELECT
    id,
    module_id AS moduleId,
    sequence_number AS sequenceNumber,
    event_type AS eventType,
    module_version_number AS moduleVersionNumber,
    event_payload_json AS eventPayload,
    event_payload_sha256 AS eventPayloadSha256,
    previous_receipt_sha256 AS previousReceiptSha256,
    receipt_sha256 AS receiptSha256,
    actor_id AS actorId,
    occurred_at AS occurredAt
  FROM personnel_learning_module_events
`;

const competencySelect = `
  SELECT
    id,
    employee_number AS employeeNumber,
    skill_module_id AS skillModuleId,
    receipt_sha256 AS receiptSha256,
    created_by AS createdBy,
    created_at AS createdAt
  FROM personnel_learning_employee_competencies
`;

const competencyRevisionSelect = `
  SELECT
    competency_id AS competencyId,
    revision_number AS revisionNumber,
    skill_module_id AS skillModuleId,
    skill_version_number AS skillVersionNumber,
    competency_level AS competencyLevel,
    trainer_authorized AS trainerAuthorized,
    active,
    change_type AS changeType,
    previous_receipt_sha256 AS previousReceiptSha256,
    receipt_sha256 AS receiptSha256,
    changed_by AS changedBy,
    changed_at AS changedAt
  FROM personnel_learning_employee_competency_revisions
`;

const assignmentSelect = `
  SELECT
    id,
    process_module_id AS processModuleId,
    learner_employee_number AS learnerEmployeeNumber,
    receipt_sha256 AS receiptSha256,
    created_by AS createdBy,
    created_at AS createdAt
  FROM personnel_learning_assignments
`;

const assignmentRevisionSelect = `
  SELECT
    assignment_id AS assignmentId,
    revision_number AS revisionNumber,
    process_module_id AS processModuleId,
    process_version_number AS processVersionNumber,
    active,
    trainer_bindings_json AS trainerBindings,
    trainer_bindings_sha256 AS trainerBindingsSha256,
    change_type AS changeType,
    previous_receipt_sha256 AS previousReceiptSha256,
    receipt_sha256 AS receiptSha256,
    changed_by AS changedBy,
    changed_at AS changedAt
  FROM personnel_learning_assignment_revisions
`;

const progressRevisionSelect = `
  SELECT
    assignment_id AS assignmentId,
    revision_number AS revisionNumber,
    assignment_revision_receipt_sha256 AS assignmentRevisionReceiptSha256,
    process_module_id AS processModuleId,
    process_version_number AS processVersionNumber,
    step_states_json AS stepStates,
    step_states_sha256 AS stepStatesSha256,
    total_step_count AS totalStepCount,
    completed_step_count AS completedStepCount,
    required_step_count AS requiredStepCount,
    required_completed_count AS requiredCompletedCount,
    finalized,
    result,
    assessment_note AS assessmentNote,
    change_type AS changeType,
    correction_reason AS correctionReason,
    previous_receipt_sha256 AS previousReceiptSha256,
    receipt_sha256 AS receiptSha256,
    actor_kind AS actorKind,
    changed_by AS changedBy,
    changed_at AS changedAt
  FROM personnel_learning_assignment_progress_revisions
`;

const SQLITE_PERSONNEL_LEARNING_CATALOG = Object.freeze([
  {
    statement: S.listModules,
    sql: `${moduleSelect} ORDER BY created_at, id`,
  },
  {
    statement: S.getModule,
    sql: `${moduleSelect} WHERE id = $moduleId LIMIT 1`,
  },
  {
    statement: S.insertModule,
    sql: `
      INSERT INTO personnel_learning_modules (
        id, module_code, module_type, receipt_sha256, created_by, created_at
      ) VALUES (
        $id, $moduleCode, $moduleType, $receiptSha256, $createdBy, $createdAt
      )
    `,
  },
  {
    statement: S.listVersions,
    sql: `${versionSelect}
      WHERE module_id = $moduleId
      ORDER BY version_number`,
  },
  {
    statement: S.getVersion,
    sql: `${versionSelect}
      WHERE module_id = $moduleId AND version_number = $versionNumber
      LIMIT 1`,
  },
  {
    statement: S.getLatestVersion,
    sql: `${versionSelect}
      WHERE module_id = $moduleId
      ORDER BY version_number DESC
      LIMIT 1`,
  },
  {
    statement: S.insertVersion,
    sql: `
      INSERT INTO personnel_learning_module_versions (
        module_id, version_number, title, content_json, content_sha256,
        scope_type, scope_location_id, scope_department_id,
        scope_snapshot_json, scope_snapshot_sha256,
        previous_receipt_sha256, receipt_sha256, created_by, created_at
      ) VALUES (
        $moduleId, $versionNumber, $title, $content, $contentSha256,
        $scopeType, $scopeLocationId, $scopeDepartmentId,
        $scopeSnapshot, $scopeSnapshotSha256,
        $previousReceiptSha256, $receiptSha256, $createdBy, $createdAt
      )
    `,
  },
  {
    statement: S.listEvents,
    sql: `${eventSelect}
      WHERE module_id = $moduleId
      ORDER BY sequence_number`,
  },
  {
    statement: S.getLatestEvent,
    sql: `${eventSelect}
      WHERE module_id = $moduleId
      ORDER BY sequence_number DESC
      LIMIT 1`,
  },
  {
    statement: S.insertEvent,
    sql: `
      INSERT INTO personnel_learning_module_events (
        id, module_id, sequence_number, event_type, module_version_number,
        event_payload_json, event_payload_sha256, previous_receipt_sha256,
        receipt_sha256, actor_id, occurred_at
      ) VALUES (
        $id, $moduleId, $sequenceNumber, $eventType, $moduleVersionNumber,
        $eventPayload, $eventPayloadSha256, $previousReceiptSha256,
        $receiptSha256, $actorId, $occurredAt
      )
    `,
  },
  {
    statement: S.listCompetencies,
    sql: `${competencySelect} ORDER BY employee_number, skill_module_id`,
  },
  {
    statement: S.getCompetency,
    sql: `${competencySelect}
      WHERE employee_number = $employeeNumber AND skill_module_id = $skillModuleId
      LIMIT 1`,
  },
  {
    statement: S.insertCompetency,
    sql: `
      INSERT INTO personnel_learning_employee_competencies (
        id, employee_number, skill_module_id, receipt_sha256, created_by, created_at
      ) VALUES (
        $id, $employeeNumber, $skillModuleId, $receiptSha256, $createdBy, $createdAt
      )
    `,
  },
  {
    statement: S.listCompetencyRevisions,
    sql: `${competencyRevisionSelect} ORDER BY competency_id, revision_number`,
  },
  {
    statement: S.getLatestCompetencyRevision,
    sql: `${competencyRevisionSelect}
      WHERE competency_id = $competencyId
      ORDER BY revision_number DESC
      LIMIT 1`,
  },
  {
    statement: S.insertCompetencyRevision,
    sql: `
      INSERT INTO personnel_learning_employee_competency_revisions (
        competency_id, revision_number, skill_module_id, skill_version_number,
        competency_level, trainer_authorized, active, change_type,
        previous_receipt_sha256, receipt_sha256, changed_by, changed_at
      ) VALUES (
        $competencyId, $revisionNumber, $skillModuleId, $skillVersionNumber,
        $competencyLevel, $trainerAuthorized, $active, $changeType,
        $previousReceiptSha256, $receiptSha256, $changedBy, $changedAt
      )
    `,
  },
  {
    statement: S.listAssignments,
    sql: `${assignmentSelect} ORDER BY learner_employee_number, process_module_id`,
  },
  {
    statement: S.getAssignment,
    sql: `${assignmentSelect} WHERE id = $assignmentId LIMIT 1`,
  },
  {
    statement: S.getAssignmentForLearner,
    sql: `${assignmentSelect}
      WHERE process_module_id = $processModuleId
        AND learner_employee_number = $learnerEmployeeNumber
      LIMIT 1`,
  },
  {
    statement: S.insertAssignment,
    sql: `
      INSERT INTO personnel_learning_assignments (
        id, process_module_id, learner_employee_number,
        receipt_sha256, created_by, created_at
      ) VALUES (
        $id, $processModuleId, $learnerEmployeeNumber,
        $receiptSha256, $createdBy, $createdAt
      )
    `,
  },
  {
    statement: S.listAssignmentRevisions,
    sql: `${assignmentRevisionSelect} ORDER BY assignment_id, revision_number`,
  },
  {
    statement: S.getLatestAssignmentRevision,
    sql: `${assignmentRevisionSelect}
      WHERE assignment_id = $assignmentId
      ORDER BY revision_number DESC
      LIMIT 1`,
  },
  {
    statement: S.insertAssignmentRevision,
    sql: `
      INSERT INTO personnel_learning_assignment_revisions (
        assignment_id, revision_number, process_module_id,
        process_version_number, active, trainer_bindings_json,
        trainer_bindings_sha256, change_type, previous_receipt_sha256,
        receipt_sha256, changed_by, changed_at
      ) VALUES (
        $assignmentId, $revisionNumber, $processModuleId,
        $processVersionNumber, $active, $trainerBindings,
        $trainerBindingsSha256, $changeType, $previousReceiptSha256,
        $receiptSha256, $changedBy, $changedAt
      )
    `,
  },
  {
    statement: S.listProgressRevisions,
    sql: `${progressRevisionSelect} ORDER BY assignment_id, revision_number`,
  },
  {
    statement: S.getLatestProgressRevision,
    sql: `${progressRevisionSelect}
      WHERE assignment_id = $assignmentId
      ORDER BY revision_number DESC
      LIMIT 1`,
  },
  {
    statement: S.insertProgressRevision,
    sql: `
      INSERT INTO personnel_learning_assignment_progress_revisions (
        assignment_id, revision_number, assignment_revision_receipt_sha256,
        process_module_id, process_version_number, step_states_json,
        step_states_sha256, total_step_count, completed_step_count,
        required_step_count, required_completed_count, finalized, result,
        assessment_note, change_type, correction_reason,
        previous_receipt_sha256, receipt_sha256, actor_kind, changed_by, changed_at
      ) VALUES (
        $assignmentId, $revisionNumber, $assignmentRevisionReceiptSha256,
        $processModuleId, $processVersionNumber, $stepStates,
        $stepStatesSha256, $totalStepCount, $completedStepCount,
        $requiredStepCount, $requiredCompletedCount, $finalized, $result,
        $assessmentNote, $changeType, $correctionReason,
        $previousReceiptSha256, $receiptSha256, $actorKind, $changedBy, $changedAt
      )
    `,
  },
].map((entry) => Object.freeze({ ...entry, returning: false })));

module.exports = {
  SQLITE_PERSONNEL_LEARNING_CATALOG,
};
