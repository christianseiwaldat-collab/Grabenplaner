"use strict";

const {
  buildPersonnelLearningProgressState,
  personnelLearningProgressRevisionReceiptSha256,
  progressStepStatesSha256,
} = require("../../../personnel-learning-progress");

const PERSONNEL_LEARNING_PROGRESS_MIGRATION_ID =
  "v0.92.8-personnel-learning-progress-revisions";

function definition(name, sql) {
  return Object.freeze({ name, sql: String(sql || "").trim() });
}

function sha256Column(column, { allowEmpty = false } = {}) {
  const valid = `(
          length(${column}) = 64
          AND ${column} = lower(${column})
          AND ${column} NOT GLOB '*[^0-9a-f]*'
        )`;
  return `${column} TEXT NOT NULL${allowEmpty ? " DEFAULT ''" : ""}
        CHECK(${allowEmpty ? `${column} = '' OR ${valid}` : valid})`;
}

const PERSONNEL_LEARNING_PROGRESS_TABLE_DEFINITIONS = Object.freeze([
  definition("personnel_learning_assignment_progress_revisions", `
    CREATE TABLE IF NOT EXISTS personnel_learning_assignment_progress_revisions (
      assignment_id TEXT NOT NULL CHECK(TRIM(assignment_id) <> ''),
      revision_number INTEGER NOT NULL CHECK(revision_number >= 1),
      ${sha256Column("assignment_revision_receipt_sha256")},
      process_module_id TEXT NOT NULL CHECK(TRIM(process_module_id) <> ''),
      process_version_number INTEGER NOT NULL CHECK(process_version_number >= 1),
      step_states_json TEXT NOT NULL
        CHECK(json_valid(step_states_json) AND json_type(step_states_json) = 'array'),
      ${sha256Column("step_states_sha256")},
      total_step_count INTEGER NOT NULL CHECK(total_step_count BETWEEN 1 AND 40),
      completed_step_count INTEGER NOT NULL
        CHECK(completed_step_count BETWEEN 0 AND total_step_count),
      required_step_count INTEGER NOT NULL
        CHECK(required_step_count BETWEEN 0 AND total_step_count),
      required_completed_count INTEGER NOT NULL
        CHECK(required_completed_count BETWEEN 0 AND required_step_count),
      finalized INTEGER NOT NULL CHECK(finalized IN (0, 1)),
      result TEXT NOT NULL
        CHECK(result IN ('pending','passed','follow_up_required','not_passed')),
      assessment_note TEXT NOT NULL DEFAULT ''
        CHECK(length(assessment_note) <= 600 AND instr(assessment_note, char(0)) = 0),
      change_type TEXT NOT NULL
        CHECK(change_type IN ('progress_recorded','completed','corrected')),
      correction_reason TEXT NOT NULL DEFAULT ''
        CHECK(length(correction_reason) <= 600 AND instr(correction_reason, char(0)) = 0),
      ${sha256Column("previous_receipt_sha256", { allowEmpty: true })},
      ${sha256Column("receipt_sha256")},
      actor_kind TEXT NOT NULL
        CHECK(actor_kind IN ('learner','trainer','leadership','branch_account')),
      changed_by TEXT NOT NULL CHECK(TRIM(changed_by) <> ''),
      changed_at TEXT NOT NULL CHECK(TRIM(changed_at) <> ''),
      PRIMARY KEY (assignment_id, revision_number),
      UNIQUE(receipt_sha256),
      CHECK((finalized = 0 AND result = 'pending' AND assessment_note = '')
        OR (finalized = 1 AND result <> 'pending')),
      CHECK((change_type = 'corrected' AND TRIM(correction_reason) <> '')
        OR (change_type <> 'corrected' AND correction_reason = '')),
      FOREIGN KEY (assignment_id) REFERENCES personnel_learning_assignments(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (assignment_revision_receipt_sha256)
        REFERENCES personnel_learning_assignment_revisions(receipt_sha256)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (process_module_id, process_version_number)
        REFERENCES personnel_learning_module_versions(module_id, version_number)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );
  `),
]);

const PERSONNEL_LEARNING_PROGRESS_TABLE_NAMES = Object.freeze(
  PERSONNEL_LEARNING_PROGRESS_TABLE_DEFINITIONS.map(({ name }) => name),
);

function immutableTriggers(tableName, message) {
  return [
    definition(`trg_${tableName}_immutable_update`, `
      CREATE TRIGGER IF NOT EXISTS trg_${tableName}_immutable_update
      BEFORE UPDATE ON ${tableName}
      BEGIN
        SELECT RAISE(ABORT, '${message} are immutable');
      END;
    `),
    definition(`trg_${tableName}_immutable_delete`, `
      CREATE TRIGGER IF NOT EXISTS trg_${tableName}_immutable_delete
      BEFORE DELETE ON ${tableName}
      BEGIN
        SELECT RAISE(ABORT, '${message} are immutable');
      END;
    `),
  ];
}

const PERSONNEL_LEARNING_PROGRESS_TRIGGER_DEFINITIONS = Object.freeze([
  definition("trg_personnel_learning_assignment_progress_revisions_chain", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_learning_assignment_progress_revisions_chain
    BEFORE INSERT ON personnel_learning_assignment_progress_revisions
    WHEN NEW.revision_number <> COALESCE((
      SELECT MAX(revision_number) + 1
      FROM personnel_learning_assignment_progress_revisions
      WHERE assignment_id = NEW.assignment_id
    ), 1)
    OR NEW.previous_receipt_sha256 <> COALESCE((
      SELECT receipt_sha256
      FROM personnel_learning_assignment_progress_revisions
      WHERE assignment_id = NEW.assignment_id
      ORDER BY revision_number DESC
      LIMIT 1
    ), '')
    OR EXISTS (
      SELECT 1
      FROM personnel_learning_assignment_progress_revisions prior
      WHERE prior.assignment_id = NEW.assignment_id
        AND (
          prior.process_module_id <> NEW.process_module_id
          OR prior.process_version_number <> NEW.process_version_number
        )
    )
    OR NOT EXISTS (
      SELECT 1
      FROM personnel_learning_assignments assignment
      JOIN personnel_learning_assignment_revisions assignment_revision
        ON assignment_revision.assignment_id = assignment.id
       AND assignment_revision.receipt_sha256 = NEW.assignment_revision_receipt_sha256
      JOIN personnel_learning_module_versions version
        ON version.module_id = NEW.process_module_id
       AND version.version_number = NEW.process_version_number
      WHERE assignment.id = NEW.assignment_id
        AND assignment.process_module_id = NEW.process_module_id
        AND assignment_revision.process_module_id = NEW.process_module_id
        AND assignment_revision.process_version_number = NEW.process_version_number
        AND assignment_revision.revision_number = (
          SELECT MAX(current_revision.revision_number)
          FROM personnel_learning_assignment_revisions current_revision
          WHERE current_revision.assignment_id = NEW.assignment_id
        )
        AND (assignment_revision.active = 1 OR NEW.change_type = 'corrected')
        AND COALESCE(json_extract(version.content_json, '$.catalogEntity'), '') <> 'skill'
    )
    OR json_array_length(NEW.step_states_json) <> COALESCE((
      SELECT json_array_length(version.content_json, '$.steps')
      FROM personnel_learning_module_versions version
      WHERE version.module_id = NEW.process_module_id
        AND version.version_number = NEW.process_version_number
    ), -1)
    OR EXISTS (
      SELECT 1
      FROM json_each(NEW.step_states_json) state
      WHERE json_type(state.value) <> 'object'
        OR (SELECT COUNT(*) FROM json_each(state.value)) <> 2
        OR json_type(state.value, '$.stepId') <> 'text'
        OR json_type(state.value, '$.completed') NOT IN ('true','false')
        OR json_extract(state.value, '$.stepId') <> COALESCE((
          SELECT json_extract(process_step.value, '$.stepId')
          FROM personnel_learning_module_versions version,
               json_each(version.content_json, '$.steps') process_step
          WHERE version.module_id = NEW.process_module_id
            AND version.version_number = NEW.process_version_number
            AND CAST(process_step.key AS INTEGER) = CAST(state.key AS INTEGER)
          LIMIT 1
        ), '')
    )
    OR NEW.total_step_count <> json_array_length(NEW.step_states_json)
    OR NEW.completed_step_count <> (
      SELECT COUNT(*)
      FROM json_each(NEW.step_states_json) state
      WHERE json_extract(state.value, '$.completed') = 1
    )
    OR NEW.required_step_count <> COALESCE((
      SELECT COUNT(*)
      FROM personnel_learning_module_versions version,
           json_each(version.content_json, '$.steps') process_step
      WHERE version.module_id = NEW.process_module_id
        AND version.version_number = NEW.process_version_number
        AND json_extract(process_step.value, '$.required') = 1
    ), -1)
    OR NEW.required_completed_count <> COALESCE((
      SELECT COUNT(*)
      FROM personnel_learning_module_versions version,
           json_each(version.content_json, '$.steps') process_step
      JOIN json_each(NEW.step_states_json) state
        ON CAST(state.key AS INTEGER) = CAST(process_step.key AS INTEGER)
      WHERE version.module_id = NEW.process_module_id
        AND version.version_number = NEW.process_version_number
        AND json_extract(process_step.value, '$.required') = 1
        AND json_extract(state.value, '$.completed') = 1
    ), -1)
    OR (NEW.finalized = 1 AND NEW.required_completed_count <> NEW.required_step_count)
    OR (
      NEW.revision_number = 1
      AND NEW.change_type <> CASE WHEN NEW.finalized = 1 THEN 'completed'
                                  ELSE 'progress_recorded' END
    )
    OR (
      NEW.revision_number > 1
      AND NEW.change_type <> CASE
        WHEN EXISTS (
          SELECT 1
          FROM personnel_learning_assignment_progress_revisions prior
          WHERE prior.assignment_id = NEW.assignment_id AND prior.finalized = 1
        ) THEN 'corrected'
        WHEN NEW.finalized = 1 THEN 'completed'
        ELSE 'progress_recorded'
      END
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel learning progress revision chain is invalid');
    END;
  `),
  ...immutableTriggers(
    "personnel_learning_assignment_progress_revisions",
    "personnel learning progress revisions",
  ),
]);

const PERSONNEL_LEARNING_PROGRESS_TRIGGER_NAMES = Object.freeze(
  PERSONNEL_LEARNING_PROGRESS_TRIGGER_DEFINITIONS.map(({ name }) => name),
);

const PERSONNEL_LEARNING_PROGRESS_INDEX_DEFINITIONS = Object.freeze([
  definition("idx_personnel_learning_progress_assignment", `
    CREATE INDEX IF NOT EXISTS idx_personnel_learning_progress_assignment
      ON personnel_learning_assignment_progress_revisions(assignment_id, revision_number)
  `),
  definition("idx_personnel_learning_progress_result", `
    CREATE INDEX IF NOT EXISTS idx_personnel_learning_progress_result
      ON personnel_learning_assignment_progress_revisions(
        finalized, result, assignment_id, revision_number
      )
  `),
]);

const PERSONNEL_LEARNING_PROGRESS_INDEX_NAMES = Object.freeze(
  PERSONNEL_LEARNING_PROGRESS_INDEX_DEFINITIONS.map(({ name }) => name),
);

const PERSONNEL_LEARNING_PROGRESS_REQUIRED_TABLES = Object.freeze([
  "personnel_learning_assignments",
  "personnel_learning_assignment_revisions",
  "personnel_learning_module_versions",
]);

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
