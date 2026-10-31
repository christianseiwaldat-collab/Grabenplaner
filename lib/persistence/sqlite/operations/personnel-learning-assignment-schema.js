"use strict";

const {
  assignmentReceiptSha256,
  assignmentRevisionReceiptSha256,
  buildPersonnelLearningAssignmentState,
  trainerBindingsSha256,
} = require("../../../personnel-learning-assignments");
const { isPersonnelLearningSkillContent } = require("../../../personnel-learning-skills");

const {
  PERSONNEL_LEARNING_ASSIGNMENT_MIGRATION_ID,
  PERSONNEL_LEARNING_ASSIGNMENT_TABLE_DEFINITIONS,
  PERSONNEL_LEARNING_ASSIGNMENT_TABLE_NAMES,
  PERSONNEL_LEARNING_ASSIGNMENT_TRIGGER_DEFINITIONS,
  PERSONNEL_LEARNING_ASSIGNMENT_TRIGGER_NAMES,
  PERSONNEL_LEARNING_ASSIGNMENT_INDEX_DEFINITIONS,
  PERSONNEL_LEARNING_ASSIGNMENT_INDEX_NAMES,
  PERSONNEL_LEARNING_ASSIGNMENT_REQUIRED_TABLES,
} = require("../../schema-definitions/personnel-learning-assignment");

function normalizeDefinitionSql(sql, type) {
  let normalized = String(sql || "").trim().replace(/\s+/g, " ")
    .replace(/\s*;\s*$/, "").toLowerCase();
  if (type === "table") {
    normalized = normalized.replace(/^create table if not exists /, "create table ");
  } else if (type === "trigger") {
    normalized = normalized.replace(/^create trigger if not exists /, "create trigger ");
  } else if (type === "index") {
    normalized = normalized.replace(
      /^create (unique )?index if not exists /,
      (_, unique = "") => `create ${unique}index `,
    );
  }
  return normalized;
}

function inspectDefinitions(database, type, definitions) {
  const read = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = ? AND name = ?",
  );
  const missing = [];
  const invalid = [];
  for (const item of definitions) {
    const stored = read.get(type, item.name);
    if (!stored?.sql) missing.push(item.name);
    else if (normalizeDefinitionSql(stored.sql, type)
      !== normalizeDefinitionSql(item.sql, type)) invalid.push(item.name);
  }
  return Object.freeze({
    missing: Object.freeze(missing),
    invalid: Object.freeze(invalid),
  });
}

function inspectSqlitePersonnelLearningAssignmentSchema(database) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Inspektionsdatenbank wird benoetigt.");
  }
  const tables = inspectDefinitions(
    database,
    "table",
    PERSONNEL_LEARNING_ASSIGNMENT_TABLE_DEFINITIONS,
  );
  const triggers = inspectDefinitions(
    database,
    "trigger",
    PERSONNEL_LEARNING_ASSIGNMENT_TRIGGER_DEFINITIONS,
  );
  const indexes = inspectDefinitions(
    database,
    "index",
    PERSONNEL_LEARNING_ASSIGNMENT_INDEX_DEFINITIONS,
  );
  const issues = Object.freeze([
    ...tables.missing.map((name) => `table-missing:${name}`),
    ...tables.invalid.map((name) => `table-invalid:${name}`),
    ...triggers.missing.map((name) => `trigger-missing:${name}`),
    ...triggers.invalid.map((name) => `trigger-invalid:${name}`),
    ...indexes.missing.map((name) => `index-missing:${name}`),
    ...indexes.invalid.map((name) => `index-invalid:${name}`),
  ]);
  const targetObjectsPresent = tables.missing.length
      < PERSONNEL_LEARNING_ASSIGNMENT_TABLE_DEFINITIONS.length
    || triggers.missing.length < PERSONNEL_LEARNING_ASSIGNMENT_TRIGGER_DEFINITIONS.length
    || indexes.missing.length < PERSONNEL_LEARNING_ASSIGNMENT_INDEX_DEFINITIONS.length;
  return Object.freeze({
    valid: issues.length === 0,
    absent: !targetObjectsPresent,
    issues,
    missingTables: tables.missing,
    invalidTables: tables.invalid,
    missingTriggers: triggers.missing,
    invalidTriggers: triggers.invalid,
    missingIndexes: indexes.missing,
    invalidIndexes: indexes.invalid,
  });
}

function parsedJson(value) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return null;
  }
}

function inspectSqlitePersonnelLearningAssignmentRows(database) {
  const schema = inspectSqlitePersonnelLearningAssignmentSchema(database);
  if (schema.absent) return Object.freeze({ valid: true, absent: true, issues: Object.freeze([]) });
  if (schema.missingTables.length || schema.invalidTables.length) {
    return Object.freeze({ valid: false, absent: false, issues: schema.issues });
  }
  const dependencyTable = database.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `);
  const missingDependencyTables = [
    "personnel_learning_module_versions",
    "personnel_learning_module_events",
    "personnel_learning_employee_competencies",
    "personnel_learning_employee_competency_revisions",
  ].filter((tableName) => !dependencyTable.get(tableName));
  if (missingDependencyTables.length) {
    return Object.freeze({
      valid: false,
      absent: false,
      issues: Object.freeze(
        missingDependencyTables.map((tableName) => `dependency-table-missing:${tableName}`),
      ),
    });
  }
  const assignments = database.prepare(`
    SELECT id, process_module_id, learner_employee_number, receipt_sha256,
           created_by, created_at
    FROM personnel_learning_assignments
  `).all();
  const revisions = database.prepare(`
    SELECT assignment_id, revision_number, process_module_id,
           process_version_number, active, trainer_bindings_json,
           trainer_bindings_sha256, change_type, previous_receipt_sha256,
           receipt_sha256, changed_by, changed_at
    FROM personnel_learning_assignment_revisions
    ORDER BY assignment_id, revision_number
  `).all();
  const processVersion = database.prepare(`
    SELECT version.content_json
    FROM personnel_learning_module_versions version
    JOIN personnel_learning_module_events published
      ON published.module_id = version.module_id
     AND published.module_version_number = version.version_number
     AND published.event_type = 'published'
    WHERE version.module_id = ? AND version.version_number = ?
    LIMIT 1
  `);
  const trainerRevision = database.prepare(`
    SELECT competency.employee_number, competency.skill_module_id,
           revision.skill_version_number, revision.competency_level,
           revision.active, revision.trainer_authorized, revision.receipt_sha256
    FROM personnel_learning_employee_competencies competency
    JOIN personnel_learning_employee_competency_revisions revision
      ON revision.competency_id = competency.id
    WHERE competency.id = ? AND revision.revision_number = ?
    LIMIT 1
  `);
  const revisionsByAssignment = new Map();
  for (const revision of revisions) {
    const rows = revisionsByAssignment.get(revision.assignment_id) || [];
    rows.push(revision);
    revisionsByAssignment.set(revision.assignment_id, rows);
  }
  const issues = [];
  for (const assignment of assignments) {
    if (assignmentReceiptSha256(assignment) !== assignment.receipt_sha256) {
      issues.push(`assignment-row-invalid:${assignment.id}`);
    }
    const history = revisionsByAssignment.get(assignment.id) || [];
    try {
      buildPersonnelLearningAssignmentState({ assignment, revisions: history });
    } catch {
      issues.push(`assignment-history-invalid:${assignment.id}`);
      continue;
    }
    for (const revision of history) {
      const bindings = parsedJson(revision.trainer_bindings_json);
      if (!Array.isArray(bindings)
        || trainerBindingsSha256(bindings) !== revision.trainer_bindings_sha256
        || assignmentRevisionReceiptSha256(revision) !== revision.receipt_sha256) {
        issues.push(`assignment-receipt-invalid:${assignment.id}:${revision.revision_number}`);
        continue;
      }
      const content = parsedJson(
        processVersion.get(
          revision.process_module_id,
          revision.process_version_number,
        )?.content_json,
      );
      if (!content || isPersonnelLearningSkillContent(content)) {
        issues.push(`assignment-process-version-invalid:${assignment.id}:${revision.revision_number}`);
      }
      for (const binding of bindings) {
        const evidence = trainerRevision.get(
          binding.competencyId,
          binding.competencyRevisionNumber,
        );
        if (!evidence
          || evidence.employee_number !== binding.trainerEmployeeNumber
          || evidence.skill_module_id !== binding.skillModuleId
          || Number(evidence.skill_version_number) !== Number(binding.skillVersionNumber)
          || Number(evidence.competency_level) !== Number(binding.competencyLevel)
          || Number(evidence.active) !== 1
          || Number(evidence.trainer_authorized) !== 1
          || evidence.receipt_sha256 !== binding.competencyRevisionReceipt
          || binding.trainerEmployeeNumber === assignment.learner_employee_number) {
          issues.push(
            `assignment-trainer-binding-invalid:${assignment.id}:${revision.revision_number}`,
          );
        }
      }
    }
  }
  const assignmentIds = new Set(assignments.map(({ id }) => id));
  for (const assignmentId of revisionsByAssignment.keys()) {
    if (!assignmentIds.has(assignmentId)) issues.push(`assignment-history-orphan:${assignmentId}`);
  }
  return Object.freeze({
    valid: issues.length === 0,
    absent: false,
    issues: Object.freeze([...new Set(issues)]),
  });
}

function ensureSqlitePersonnelLearningAssignmentSchema(database) {
  if (!database || typeof database.exec !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benoetigt.");
  }
  for (const table of PERSONNEL_LEARNING_ASSIGNMENT_REQUIRED_TABLES) {
    const exists = database.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1
    `).get(table);
    if (!exists) throw new Error(`personnel learning assignment dependency missing: ${table}`);
  }
  for (const item of PERSONNEL_LEARNING_ASSIGNMENT_TABLE_DEFINITIONS) database.exec(item.sql);
  for (const item of PERSONNEL_LEARNING_ASSIGNMENT_INDEX_DEFINITIONS) database.exec(item.sql);
  for (const item of PERSONNEL_LEARNING_ASSIGNMENT_TRIGGER_DEFINITIONS) database.exec(item.sql);
}

module.exports = {
  PERSONNEL_LEARNING_ASSIGNMENT_INDEX_DEFINITIONS,
  PERSONNEL_LEARNING_ASSIGNMENT_INDEX_NAMES,
  PERSONNEL_LEARNING_ASSIGNMENT_MIGRATION_ID,
  PERSONNEL_LEARNING_ASSIGNMENT_REQUIRED_TABLES,
  PERSONNEL_LEARNING_ASSIGNMENT_TABLE_DEFINITIONS,
  PERSONNEL_LEARNING_ASSIGNMENT_TABLE_NAMES,
  PERSONNEL_LEARNING_ASSIGNMENT_TRIGGER_DEFINITIONS,
  PERSONNEL_LEARNING_ASSIGNMENT_TRIGGER_NAMES,
  ensureSqlitePersonnelLearningAssignmentSchema,
  inspectSqlitePersonnelLearningAssignmentRows,
  inspectSqlitePersonnelLearningAssignmentSchema,
};
