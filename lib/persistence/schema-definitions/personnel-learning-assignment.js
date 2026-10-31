"use strict";

// Canonical historical SQL definitions shared by PostgreSQL conversion and legacy readers.
const PERSONNEL_LEARNING_ASSIGNMENT_MIGRATION_ID =
  "v0.92.8-personnel-learning-training-assignments";

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

const PERSONNEL_LEARNING_ASSIGNMENT_TABLE_DEFINITIONS = Object.freeze([
  definition("personnel_learning_assignments", `
    CREATE TABLE IF NOT EXISTS personnel_learning_assignments (
      id TEXT PRIMARY KEY CHECK(TRIM(id) <> ''),
      process_module_id TEXT NOT NULL CHECK(TRIM(process_module_id) <> ''),
      learner_employee_number TEXT NOT NULL CHECK(TRIM(learner_employee_number) <> ''),
      ${sha256Column("receipt_sha256")},
      created_by TEXT NOT NULL CHECK(TRIM(created_by) <> ''),
      created_at TEXT NOT NULL CHECK(TRIM(created_at) <> ''),
      UNIQUE(process_module_id, learner_employee_number),
      UNIQUE(id, process_module_id),
      FOREIGN KEY (process_module_id) REFERENCES personnel_learning_modules(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (learner_employee_number) REFERENCES employees(personnel_number)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );
  `),
  definition("personnel_learning_assignment_revisions", `
    CREATE TABLE IF NOT EXISTS personnel_learning_assignment_revisions (
      assignment_id TEXT NOT NULL,
      revision_number INTEGER NOT NULL CHECK(revision_number >= 1),
      process_module_id TEXT NOT NULL CHECK(TRIM(process_module_id) <> ''),
      process_version_number INTEGER NOT NULL CHECK(process_version_number >= 1),
      active INTEGER NOT NULL CHECK(active IN (0, 1)),
      trainer_bindings_json TEXT NOT NULL
        CHECK(json_valid(trainer_bindings_json) AND json_type(trainer_bindings_json) = 'array'),
      ${sha256Column("trainer_bindings_sha256")},
      change_type TEXT NOT NULL
        CHECK(change_type IN ('assigned','trainers_updated','cancelled','restored')),
      ${sha256Column("previous_receipt_sha256", { allowEmpty: true })},
      ${sha256Column("receipt_sha256")},
      changed_by TEXT NOT NULL CHECK(TRIM(changed_by) <> ''),
      changed_at TEXT NOT NULL CHECK(TRIM(changed_at) <> ''),
      PRIMARY KEY (assignment_id, revision_number),
      UNIQUE(receipt_sha256),
      FOREIGN KEY (assignment_id, process_module_id)
        REFERENCES personnel_learning_assignments(id, process_module_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (process_module_id, process_version_number)
        REFERENCES personnel_learning_module_versions(module_id, version_number)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );
  `),
]);

const PERSONNEL_LEARNING_ASSIGNMENT_TABLE_NAMES = Object.freeze(
  PERSONNEL_LEARNING_ASSIGNMENT_TABLE_DEFINITIONS.map(({ name }) => name),
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

const PERSONNEL_LEARNING_ASSIGNMENT_TRIGGER_DEFINITIONS = Object.freeze([
  definition("trg_personnel_learning_assignments_process", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_learning_assignments_process
    BEFORE INSERT ON personnel_learning_assignments
    WHEN NOT EXISTS (
      SELECT 1
      FROM personnel_learning_module_versions version
      WHERE version.module_id = NEW.process_module_id
        AND COALESCE(json_extract(version.content_json, '$.catalogEntity'), '') <> 'skill'
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel learning assignment process is invalid');
    END;
  `),
  ...immutableTriggers(
    "personnel_learning_assignments",
    "personnel learning assignments",
  ),
  definition("trg_personnel_learning_assignment_revisions_chain", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_learning_assignment_revisions_chain
    BEFORE INSERT ON personnel_learning_assignment_revisions
    WHEN NEW.revision_number <> COALESCE((
      SELECT MAX(revision_number) + 1
      FROM personnel_learning_assignment_revisions
      WHERE assignment_id = NEW.assignment_id
    ), 1)
    OR NEW.previous_receipt_sha256 <> COALESCE((
      SELECT receipt_sha256
      FROM personnel_learning_assignment_revisions
      WHERE assignment_id = NEW.assignment_id
      ORDER BY revision_number DESC
      LIMIT 1
    ), '')
    OR NEW.process_module_id <> COALESCE((
      SELECT process_module_id
      FROM personnel_learning_assignments
      WHERE id = NEW.assignment_id
    ), '')
    OR NOT EXISTS (
      SELECT 1
      FROM personnel_learning_module_versions version
      JOIN personnel_learning_module_events published
        ON published.module_id = version.module_id
       AND published.module_version_number = version.version_number
       AND published.event_type = 'published'
      WHERE version.module_id = NEW.process_module_id
        AND version.version_number = NEW.process_version_number
        AND COALESCE(json_extract(version.content_json, '$.catalogEntity'), '') <> 'skill'
    )
    OR json_array_length(NEW.trainer_bindings_json) NOT BETWEEN 1 AND 12
    OR EXISTS (
      SELECT 1
      FROM json_each(NEW.trainer_bindings_json) binding
      WHERE json_type(binding.value) <> 'object'
        OR (SELECT COUNT(*) FROM json_each(binding.value)) <> 7
        OR json_type(binding.value, '$.competencyId') <> 'text'
        OR json_type(binding.value, '$.competencyRevisionNumber') <> 'integer'
        OR json_type(binding.value, '$.competencyRevisionReceipt') <> 'text'
        OR json_type(binding.value, '$.trainerEmployeeNumber') <> 'text'
        OR json_type(binding.value, '$.skillModuleId') <> 'text'
        OR json_type(binding.value, '$.skillVersionNumber') <> 'integer'
        OR json_type(binding.value, '$.competencyLevel') <> 'integer'
        OR json_extract(binding.value, '$.trainerEmployeeNumber') = COALESCE((
          SELECT learner_employee_number
          FROM personnel_learning_assignments
          WHERE id = NEW.assignment_id
        ), '')
        OR NOT EXISTS (
          SELECT 1
          FROM personnel_learning_employee_competencies competency
          JOIN personnel_learning_employee_competency_revisions revision
            ON revision.competency_id = competency.id
           AND revision.revision_number = CAST(
             json_extract(binding.value, '$.competencyRevisionNumber') AS INTEGER
           )
          JOIN employees trainer
            ON trainer.personnel_number = competency.employee_number
          WHERE competency.id = json_extract(binding.value, '$.competencyId')
            AND competency.employee_number = json_extract(
              binding.value, '$.trainerEmployeeNumber'
            )
            AND competency.skill_module_id = json_extract(binding.value, '$.skillModuleId')
            AND revision.skill_module_id = competency.skill_module_id
            AND revision.skill_version_number = CAST(
              json_extract(binding.value, '$.skillVersionNumber') AS INTEGER
            )
            AND revision.competency_level = CAST(
              json_extract(binding.value, '$.competencyLevel') AS INTEGER
            )
            AND revision.receipt_sha256 = json_extract(
              binding.value, '$.competencyRevisionReceipt'
            )
            AND revision.active = 1
            AND revision.trainer_authorized = 1
            AND (NEW.active = 0 OR trainer.active = 1)
        )
    )
    OR (
      SELECT COUNT(*)
      FROM json_each(NEW.trainer_bindings_json)
    ) <> (
      SELECT COUNT(DISTINCT json_extract(value, '$.competencyId'))
      FROM json_each(NEW.trainer_bindings_json)
    )
    OR (NEW.revision_number = 1 AND (NEW.change_type <> 'assigned' OR NEW.active <> 1))
    OR (NEW.revision_number > 1 AND NEW.change_type = 'assigned')
    OR (
      NEW.revision_number > 1
      AND NEW.change_type = 'trainers_updated'
      AND (
        NEW.active <> 1
        OR COALESCE((
          SELECT active
          FROM personnel_learning_assignment_revisions
          WHERE assignment_id = NEW.assignment_id
          ORDER BY revision_number DESC
          LIMIT 1
        ), 0) <> 1
      )
    )
    OR (
      NEW.revision_number > 1
      AND NEW.change_type = 'cancelled'
      AND (
        NEW.active <> 0
        OR COALESCE((
          SELECT active
          FROM personnel_learning_assignment_revisions
          WHERE assignment_id = NEW.assignment_id
          ORDER BY revision_number DESC
          LIMIT 1
        ), 0) <> 1
      )
    )
    OR (
      NEW.revision_number > 1
      AND NEW.change_type = 'restored'
      AND (
        NEW.active <> 1
        OR COALESCE((
          SELECT active
          FROM personnel_learning_assignment_revisions
          WHERE assignment_id = NEW.assignment_id
          ORDER BY revision_number DESC
          LIMIT 1
        ), 1) <> 0
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel learning assignment revision chain is invalid');
    END;
  `),
  ...immutableTriggers(
    "personnel_learning_assignment_revisions",
    "personnel learning assignment revisions",
  ),
]);

const PERSONNEL_LEARNING_ASSIGNMENT_TRIGGER_NAMES = Object.freeze(
  PERSONNEL_LEARNING_ASSIGNMENT_TRIGGER_DEFINITIONS.map(({ name }) => name),
);

const PERSONNEL_LEARNING_ASSIGNMENT_INDEX_DEFINITIONS = Object.freeze([
  definition("idx_personnel_learning_assignments_learner", `
    CREATE INDEX IF NOT EXISTS idx_personnel_learning_assignments_learner
      ON personnel_learning_assignments(learner_employee_number, process_module_id)
  `),
  definition("idx_personnel_learning_assignments_process", `
    CREATE INDEX IF NOT EXISTS idx_personnel_learning_assignments_process
      ON personnel_learning_assignments(process_module_id, learner_employee_number)
  `),
  definition("idx_personnel_learning_assignment_revisions_active", `
    CREATE INDEX IF NOT EXISTS idx_personnel_learning_assignment_revisions_active
      ON personnel_learning_assignment_revisions(active, assignment_id, revision_number)
  `),
  definition("idx_personnel_learning_assignment_revisions_process", `
    CREATE INDEX IF NOT EXISTS idx_personnel_learning_assignment_revisions_process
      ON personnel_learning_assignment_revisions(
        process_module_id, process_version_number, assignment_id, revision_number
      )
  `),
]);

const PERSONNEL_LEARNING_ASSIGNMENT_INDEX_NAMES = Object.freeze(
  PERSONNEL_LEARNING_ASSIGNMENT_INDEX_DEFINITIONS.map(({ name }) => name),
);

const PERSONNEL_LEARNING_ASSIGNMENT_REQUIRED_TABLES = Object.freeze([
  "employees",
  "personnel_learning_modules",
  "personnel_learning_module_versions",
  "personnel_learning_module_events",
  "personnel_learning_employee_competencies",
  "personnel_learning_employee_competency_revisions",
]);

module.exports = {
  PERSONNEL_LEARNING_ASSIGNMENT_MIGRATION_ID,
  PERSONNEL_LEARNING_ASSIGNMENT_TABLE_DEFINITIONS,
  PERSONNEL_LEARNING_ASSIGNMENT_TABLE_NAMES,
  PERSONNEL_LEARNING_ASSIGNMENT_TRIGGER_DEFINITIONS,
  PERSONNEL_LEARNING_ASSIGNMENT_TRIGGER_NAMES,
  PERSONNEL_LEARNING_ASSIGNMENT_INDEX_DEFINITIONS,
  PERSONNEL_LEARNING_ASSIGNMENT_INDEX_NAMES,
  PERSONNEL_LEARNING_ASSIGNMENT_REQUIRED_TABLES,
};
