"use strict";

const {
  buildPersonnelLearningProgressState,
  personnelLearningProgressRevisionReceiptSha256,
  progressStepStatesSha256,
} = require("../../../personnel-learning-progress");

const {
  PERSONNEL_LEARNING_PROGRESS_MIGRATION_ID,
  PERSONNEL_LEARNING_PROGRESS_TABLE_DEFINITIONS,
  PERSONNEL_LEARNING_PROGRESS_TABLE_NAMES,
  PERSONNEL_LEARNING_PROGRESS_TRIGGER_DEFINITIONS,
  PERSONNEL_LEARNING_PROGRESS_TRIGGER_NAMES,
  PERSONNEL_LEARNING_PROGRESS_INDEX_DEFINITIONS,
  PERSONNEL_LEARNING_PROGRESS_INDEX_NAMES,
  PERSONNEL_LEARNING_PROGRESS_REQUIRED_TABLES,
} = require("../../schema-definitions/personnel-learning-progress");

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

function inspectSqlitePersonnelLearningProgressSchema(database) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Inspektionsdatenbank wird benoetigt.");
  }
  const tables = inspectDefinitions(
    database,
    "table",
    PERSONNEL_LEARNING_PROGRESS_TABLE_DEFINITIONS,
  );
  const triggers = inspectDefinitions(
    database,
    "trigger",
    PERSONNEL_LEARNING_PROGRESS_TRIGGER_DEFINITIONS,
  );
  const indexes = inspectDefinitions(
    database,
    "index",
    PERSONNEL_LEARNING_PROGRESS_INDEX_DEFINITIONS,
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
      < PERSONNEL_LEARNING_PROGRESS_TABLE_DEFINITIONS.length
    || triggers.missing.length < PERSONNEL_LEARNING_PROGRESS_TRIGGER_DEFINITIONS.length
    || indexes.missing.length < PERSONNEL_LEARNING_PROGRESS_INDEX_DEFINITIONS.length;
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

function inspectSqlitePersonnelLearningProgressRows(database) {
  const schema = inspectSqlitePersonnelLearningProgressSchema(database);
  if (schema.absent) {
    return Object.freeze({ valid: true, absent: true, issues: Object.freeze([]) });
  }
  if (schema.missingTables.length || schema.invalidTables.length) {
    return Object.freeze({ valid: false, absent: false, issues: schema.issues });
  }
  const dependencyTable = database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1
  `);
  const missingDependencies = PERSONNEL_LEARNING_PROGRESS_REQUIRED_TABLES.filter(
    (tableName) => !dependencyTable.get(tableName),
  );
  if (missingDependencies.length) {
    return Object.freeze({
      valid: false,
      absent: false,
      issues: Object.freeze(missingDependencies.map((tableName) => (
        `dependency-table-missing:${tableName}`
      ))),
    });
  }
  const rows = database.prepare(`
    SELECT assignment_id, revision_number, assignment_revision_receipt_sha256,
           process_module_id, process_version_number, step_states_json,
           step_states_sha256, total_step_count, completed_step_count,
           required_step_count, required_completed_count, finalized, result,
           assessment_note, change_type, correction_reason,
           previous_receipt_sha256, receipt_sha256, actor_kind, changed_by, changed_at
    FROM personnel_learning_assignment_progress_revisions
    ORDER BY assignment_id, revision_number
  `).all();
  const processVersion = database.prepare(`
    SELECT content_json
    FROM personnel_learning_module_versions
    WHERE module_id = ? AND version_number = ?
    LIMIT 1
  `);
  const assignmentRevision = database.prepare(`
    SELECT assignment_id, process_module_id, process_version_number
    FROM personnel_learning_assignment_revisions
    WHERE receipt_sha256 = ?
    LIMIT 1
  `);
  const byAssignment = new Map();
  for (const row of rows) {
    const entries = byAssignment.get(row.assignment_id) || [];
    entries.push(row);
    byAssignment.set(row.assignment_id, entries);
  }
  const issues = [];
  for (const [assignmentId, revisions] of byAssignment) {
    const first = revisions[0];
    const version = processVersion.get(
      first.process_module_id,
      first.process_version_number,
    );
    const content = parsedJson(version?.content_json);
    const processSteps = content?.steps;
    try {
      buildPersonnelLearningProgressState({ revisions, processSteps });
    } catch {
      issues.push(`progress-history-invalid:${assignmentId}`);
      continue;
    }
    for (const revision of revisions) {
      const states = parsedJson(revision.step_states_json);
      const evidence = assignmentRevision.get(
        revision.assignment_revision_receipt_sha256,
      );
      if (!Array.isArray(states)
        || revision.step_states_sha256 !== progressStepStatesSha256(states, processSteps)
        || revision.receipt_sha256 !== personnelLearningProgressRevisionReceiptSha256(
          revision,
          processSteps,
        )) {
        issues.push(`progress-receipt-invalid:${assignmentId}:${revision.revision_number}`);
      }
      if (!evidence
        || evidence.assignment_id !== assignmentId
        || evidence.process_module_id !== revision.process_module_id
        || Number(evidence.process_version_number) !== Number(
          revision.process_version_number,
        )) {
        issues.push(`progress-assignment-evidence-invalid:${assignmentId}:${revision.revision_number}`);
      }
      if (revision.process_module_id !== first.process_module_id
        || Number(revision.process_version_number) !== Number(first.process_version_number)) {
        issues.push(`progress-process-binding-invalid:${assignmentId}:${revision.revision_number}`);
      }
    }
  }
  return Object.freeze({
    valid: issues.length === 0,
    absent: false,
    issues: Object.freeze([...new Set(issues)]),
  });
}

function ensureSqlitePersonnelLearningProgressSchema(database) {
  if (!database || typeof database.exec !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benoetigt.");
  }
  for (const table of PERSONNEL_LEARNING_PROGRESS_REQUIRED_TABLES) {
    const exists = database.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1
    `).get(table);
    if (!exists) throw new Error(`personnel learning progress dependency missing: ${table}`);
  }
  for (const item of PERSONNEL_LEARNING_PROGRESS_TABLE_DEFINITIONS) database.exec(item.sql);
  for (const item of PERSONNEL_LEARNING_PROGRESS_INDEX_DEFINITIONS) database.exec(item.sql);
  for (const item of PERSONNEL_LEARNING_PROGRESS_TRIGGER_DEFINITIONS) database.exec(item.sql);
}

module.exports = {
  PERSONNEL_LEARNING_PROGRESS_INDEX_DEFINITIONS,
  PERSONNEL_LEARNING_PROGRESS_INDEX_NAMES,
  PERSONNEL_LEARNING_PROGRESS_MIGRATION_ID,
  PERSONNEL_LEARNING_PROGRESS_REQUIRED_TABLES,
  PERSONNEL_LEARNING_PROGRESS_TABLE_DEFINITIONS,
  PERSONNEL_LEARNING_PROGRESS_TABLE_NAMES,
  PERSONNEL_LEARNING_PROGRESS_TRIGGER_DEFINITIONS,
  PERSONNEL_LEARNING_PROGRESS_TRIGGER_NAMES,
  ensureSqlitePersonnelLearningProgressSchema,
  inspectSqlitePersonnelLearningProgressRows,
  inspectSqlitePersonnelLearningProgressSchema,
};
