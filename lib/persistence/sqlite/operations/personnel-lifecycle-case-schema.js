"use strict";

const PERSONNEL_LIFECYCLE_CASE_FOUNDATION_MIGRATION_ID =
  "v0.91-personnel-lifecycle-case-foundation";

function definition(name, sql) {
  return Object.freeze({ name, sql: String(sql || "").trim() });
}

function protectedPayload(column = "protected_payload") {
  return `${column} TEXT NOT NULL DEFAULT ''
        CHECK(${column} = '' OR ${column} LIKE 'enc:v2:%')`;
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

const PERSONNEL_LIFECYCLE_CASE_TABLE_DEFINITIONS = Object.freeze([
  definition("personnel_employment_episodes", `
    CREATE TABLE IF NOT EXISTS personnel_employment_episodes (
      id TEXT PRIMARY KEY CHECK(TRIM(id) <> ''),
      employee_number TEXT NOT NULL CHECK(TRIM(employee_number) <> ''),
      sequence_number INTEGER NOT NULL CHECK(sequence_number >= 1),
      predecessor_episode_id TEXT UNIQUE,
      state TEXT NOT NULL
        CHECK(state IN ('employment_active','exit_in_progress','employment_ended')),
      ${protectedPayload()},
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
      created_by TEXT NOT NULL CHECK(TRIM(created_by) <> ''),
      created_at TEXT NOT NULL CHECK(TRIM(created_at) <> ''),
      updated_by TEXT NOT NULL CHECK(TRIM(updated_by) <> ''),
      updated_at TEXT NOT NULL CHECK(TRIM(updated_at) <> ''),
      UNIQUE(employee_number, sequence_number),
      CHECK(predecessor_episode_id IS NULL OR predecessor_episode_id <> id),
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (predecessor_episode_id) REFERENCES personnel_employment_episodes(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );
  `),
  definition("personnel_lifecycle_cases", `
    CREATE TABLE IF NOT EXISTS personnel_lifecycle_cases (
      id TEXT PRIMARY KEY CHECK(TRIM(id) <> ''),
      case_type TEXT NOT NULL CHECK(case_type IN ('onboarding','offboarding')),
      employment_episode_id TEXT NOT NULL,
      predecessor_case_id TEXT UNIQUE,
      state TEXT NOT NULL,
      responsible_actor_id TEXT NOT NULL CHECK(TRIM(responsible_actor_id) <> ''),
      scope_type TEXT NOT NULL CHECK(scope_type IN ('location','department')),
      location_id TEXT NOT NULL,
      department_id INTEGER,
      ${sha256Column("scope_snapshot_sha256")},
      ${protectedPayload()},
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
      created_by TEXT NOT NULL CHECK(TRIM(created_by) <> ''),
      created_at TEXT NOT NULL CHECK(TRIM(created_at) <> ''),
      updated_by TEXT NOT NULL CHECK(TRIM(updated_by) <> ''),
      updated_at TEXT NOT NULL CHECK(TRIM(updated_at) <> ''),
      CHECK(
        (case_type = 'onboarding' AND state IN (
          'prepared','approved','active','completed','cancelled'
        ))
        OR (case_type = 'offboarding' AND state IN (
          'internally_prepared','communication_released','employee_informed',
          'active','completed','cancelled'
        ))
      ),
      CHECK(
        (scope_type = 'location' AND department_id IS NULL)
        OR (scope_type = 'department' AND department_id IS NOT NULL)
      ),
      CHECK(predecessor_case_id IS NULL OR predecessor_case_id <> id),
      FOREIGN KEY (employment_episode_id) REFERENCES personnel_employment_episodes(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (predecessor_case_id) REFERENCES personnel_lifecycle_cases(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (department_id) REFERENCES departments(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );
  `),
  definition("personnel_lifecycle_case_reference_dates", `
    CREATE TABLE IF NOT EXISTS personnel_lifecycle_case_reference_dates (
      id TEXT PRIMARY KEY CHECK(TRIM(id) <> ''),
      case_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      previous_revision_id TEXT UNIQUE,
      ${protectedPayload()},
      ${sha256Column("receipt_sha256")},
      changed_by TEXT NOT NULL CHECK(TRIM(changed_by) <> ''),
      changed_at TEXT NOT NULL CHECK(TRIM(changed_at) <> ''),
      UNIQUE(case_id, revision),
      CHECK(previous_revision_id IS NULL OR previous_revision_id <> id),
      FOREIGN KEY (case_id) REFERENCES personnel_lifecycle_cases(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (previous_revision_id)
        REFERENCES personnel_lifecycle_case_reference_dates(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );
  `),
  definition("personnel_lifecycle_case_package_bindings", `
    CREATE TABLE IF NOT EXISTS personnel_lifecycle_case_package_bindings (
      id TEXT PRIMARY KEY CHECK(TRIM(id) <> ''),
      case_id TEXT NOT NULL,
      publication_id TEXT NOT NULL,
      version_number INTEGER NOT NULL CHECK(version_number >= 1),
      ${sha256Column("scope_snapshot_sha256")},
      ${sha256Column("receipt_sha256")},
      bound_by TEXT NOT NULL CHECK(TRIM(bound_by) <> ''),
      bound_at TEXT NOT NULL CHECK(TRIM(bound_at) <> ''),
      UNIQUE(case_id, publication_id),
      FOREIGN KEY (case_id) REFERENCES personnel_lifecycle_cases(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (publication_id) REFERENCES custom_process_publications(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );
  `),
  definition("personnel_lifecycle_case_assignments", `
    CREATE TABLE IF NOT EXISTS personnel_lifecycle_case_assignments (
      id TEXT PRIMARY KEY CHECK(TRIM(id) <> ''),
      case_id TEXT NOT NULL,
      step_reference TEXT NOT NULL CHECK(TRIM(step_reference) <> ''),
      assignee_actor_id TEXT NOT NULL CHECK(TRIM(assignee_actor_id) <> ''),
      predecessor_assignment_id TEXT UNIQUE,
      ${sha256Column("receipt_sha256")},
      assigned_by TEXT NOT NULL CHECK(TRIM(assigned_by) <> ''),
      assigned_at TEXT NOT NULL CHECK(TRIM(assigned_at) <> ''),
      CHECK(predecessor_assignment_id IS NULL OR predecessor_assignment_id <> id),
      FOREIGN KEY (case_id) REFERENCES personnel_lifecycle_cases(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (predecessor_assignment_id)
        REFERENCES personnel_lifecycle_case_assignments(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );
  `),
  definition("personnel_lifecycle_case_events", `
    CREATE TABLE IF NOT EXISTS personnel_lifecycle_case_events (
      id TEXT PRIMARY KEY CHECK(TRIM(id) <> ''),
      case_id TEXT NOT NULL,
      sequence_number INTEGER NOT NULL CHECK(sequence_number >= 1),
      event_type TEXT NOT NULL CHECK(length(TRIM(event_type)) BETWEEN 3 AND 80),
      data_classification TEXT NOT NULL CHECK(data_classification IN (
        'operational_standard','personal_restricted','hr_confidential',
        'offboarding_strict_confidential','employee_released'
      )),
      ${protectedPayload()},
      ${sha256Column("previous_receipt_sha256", { allowEmpty: true })},
      ${sha256Column("receipt_sha256")},
      actor_id TEXT NOT NULL CHECK(TRIM(actor_id) <> ''),
      occurred_at TEXT NOT NULL CHECK(TRIM(occurred_at) <> ''),
      UNIQUE(case_id, sequence_number),
      FOREIGN KEY (case_id) REFERENCES personnel_lifecycle_cases(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );
  `),
  definition("personnel_lifecycle_confidential_access_events", `
    CREATE TABLE IF NOT EXISTS personnel_lifecycle_confidential_access_events (
      id TEXT PRIMARY KEY CHECK(TRIM(id) <> ''),
      case_id TEXT NOT NULL,
      sequence_number INTEGER NOT NULL CHECK(sequence_number >= 1),
      actor_id TEXT NOT NULL CHECK(TRIM(actor_id) <> ''),
      action TEXT NOT NULL CHECK(length(TRIM(action)) BETWEEN 3 AND 80),
      occurred_at TEXT NOT NULL CHECK(TRIM(occurred_at) <> ''),
      result TEXT NOT NULL CHECK(result IN ('allowed','denied','not_found')),
      purpose_code TEXT NOT NULL CHECK(length(TRIM(purpose_code)) BETWEEN 3 AND 80),
      ${sha256Column("previous_receipt_sha256", { allowEmpty: true })},
      ${sha256Column("receipt_sha256")},
      UNIQUE(case_id, sequence_number),
      FOREIGN KEY (case_id) REFERENCES personnel_lifecycle_cases(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );
  `),
]);

const PERSONNEL_LIFECYCLE_CASE_TABLE_NAMES = Object.freeze(
  PERSONNEL_LIFECYCLE_CASE_TABLE_DEFINITIONS.map(({ name }) => name),
);

const PERSONNEL_LIFECYCLE_CASE_TRIGGER_DEFINITIONS = Object.freeze(
  PERSONNEL_LIFECYCLE_CASE_TABLE_NAMES.flatMap((tableName) => [
    definition(`trg_${tableName}_o2_insert_blocked`, `
      CREATE TRIGGER IF NOT EXISTS trg_${tableName}_o2_insert_blocked
      BEFORE INSERT ON ${tableName}
      BEGIN
        SELECT RAISE(ABORT, 'personnel lifecycle O2 persistence is read-only');
      END;
    `),
    definition(`trg_${tableName}_o2_update_blocked`, `
      CREATE TRIGGER IF NOT EXISTS trg_${tableName}_o2_update_blocked
      BEFORE UPDATE ON ${tableName}
      BEGIN
        SELECT RAISE(ABORT, 'personnel lifecycle O2 persistence is read-only');
      END;
    `),
    definition(`trg_${tableName}_o2_delete_blocked`, `
      CREATE TRIGGER IF NOT EXISTS trg_${tableName}_o2_delete_blocked
      BEFORE DELETE ON ${tableName}
      BEGIN
        SELECT RAISE(ABORT, 'personnel lifecycle O2 persistence is read-only');
      END;
    `),
  ]),
);

const PERSONNEL_LIFECYCLE_CASE_TRIGGER_NAMES = Object.freeze(
  PERSONNEL_LIFECYCLE_CASE_TRIGGER_DEFINITIONS.map(({ name }) => name),
);

const PERSONNEL_LIFECYCLE_CASE_REQUIRED_TABLES = Object.freeze([
  "employees",
  "locations",
  "departments",
  "custom_process_publications",
]);

function normalizeDefinitionSql(sql, type) {
  const prefix = type === "table"
    ? /^create table if not exists /i
    : /^create trigger if not exists /i;
  return String(sql || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*;\s*$/, "")
    .replace(prefix, `create ${type} `)
    .toLowerCase();
}

function inspectDefinitions(database, type, definitions) {
  const read = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = ? AND name = ?",
  );
  const missing = [];
  const invalid = [];
  for (const item of definitions) {
    const row = read.get(type, item.name);
    if (!row?.sql) missing.push(item.name);
    else if (normalizeDefinitionSql(row.sql, type) !== normalizeDefinitionSql(item.sql, type)) {
      invalid.push(item.name);
    }
  }
  return Object.freeze({
    missing: Object.freeze(missing),
    invalid: Object.freeze(invalid),
  });
}

function inspectSqlitePersonnelLifecycleCaseSchema(database) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Inspektionsdatenbank wird benoetigt.");
  }
  const tables = inspectDefinitions(
    database,
    "table",
    PERSONNEL_LIFECYCLE_CASE_TABLE_DEFINITIONS,
  );
  const triggers = inspectDefinitions(
    database,
    "trigger",
    PERSONNEL_LIFECYCLE_CASE_TRIGGER_DEFINITIONS,
  );
  const issues = Object.freeze([
    ...tables.missing.map((name) => `table-missing:${name}`),
    ...tables.invalid.map((name) => `table-invalid:${name}`),
    ...triggers.missing.map((name) => `trigger-missing:${name}`),
    ...triggers.invalid.map((name) => `trigger-invalid:${name}`),
  ]);
  return Object.freeze({
    valid: issues.length === 0,
    absent: tables.missing.length === PERSONNEL_LIFECYCLE_CASE_TABLE_DEFINITIONS.length
      && triggers.missing.length === PERSONNEL_LIFECYCLE_CASE_TRIGGER_DEFINITIONS.length,
    issues,
    missingTables: tables.missing,
    invalidTables: tables.invalid,
    missingTriggers: triggers.missing,
    invalidTriggers: triggers.invalid,
  });
}

function sqliteTableExists(database, name) {
  return Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1
  `).get(name));
}

function inspectSqlitePersonnelLifecycleCaseRows(database) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Inspektionsdatenbank wird benoetigt.");
  }
  const schema = inspectSqlitePersonnelLifecycleCaseSchema(database);
  if (schema.absent) {
    return Object.freeze({ valid: true, absent: true, issues: Object.freeze([]) });
  }
  if (!schema.valid) {
    return Object.freeze({
      valid: false,
      absent: false,
      issues: Object.freeze(["schema-invalid"]),
    });
  }
  const issues = [];
  for (const tableName of PERSONNEL_LIFECYCLE_CASE_REQUIRED_TABLES) {
    if (!sqliteTableExists(database, tableName)) issues.push(`dependency-missing:${tableName}`);
  }
  for (const tableName of PERSONNEL_LIFECYCLE_CASE_TABLE_NAMES) {
    const count = Number(database.prepare(
      `SELECT COUNT(*) AS count FROM "${tableName}"`,
    ).get().count || 0);
    if (count !== 0) issues.push(`o2-data-present:${tableName}:${count}`);
    for (const violation of database.prepare(`PRAGMA foreign_key_check("${tableName}")`).all()) {
      issues.push(`foreign-key:${tableName}:${violation.rowid ?? "unknown"}`);
    }
  }
  return Object.freeze({
    valid: issues.length === 0,
    absent: false,
    issues: Object.freeze(issues),
  });
}

function ensureSqlitePersonnelLifecycleCaseSchema(database) {
  if (!database || typeof database.exec !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benoetigt.");
  }
  for (const item of PERSONNEL_LIFECYCLE_CASE_TABLE_DEFINITIONS) database.exec(item.sql);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_personnel_employment_episodes_employee
      ON personnel_employment_episodes(employee_number, sequence_number);
    CREATE INDEX IF NOT EXISTS idx_personnel_lifecycle_cases_episode
      ON personnel_lifecycle_cases(employment_episode_id, case_type, state, created_at);
    CREATE INDEX IF NOT EXISTS idx_personnel_lifecycle_cases_scope
      ON personnel_lifecycle_cases(location_id, department_id, case_type, state);
    CREATE INDEX IF NOT EXISTS idx_personnel_lifecycle_case_reference_dates_case
      ON personnel_lifecycle_case_reference_dates(case_id, revision);
    CREATE INDEX IF NOT EXISTS idx_personnel_lifecycle_case_package_bindings_case
      ON personnel_lifecycle_case_package_bindings(case_id, publication_id);
    CREATE INDEX IF NOT EXISTS idx_personnel_lifecycle_case_assignments_case
      ON personnel_lifecycle_case_assignments(case_id, step_reference, assigned_at);
    CREATE INDEX IF NOT EXISTS idx_personnel_lifecycle_case_events_case
      ON personnel_lifecycle_case_events(case_id, sequence_number);
    CREATE INDEX IF NOT EXISTS idx_personnel_lifecycle_confidential_access_events_case
      ON personnel_lifecycle_confidential_access_events(case_id, sequence_number);
  `);
  for (const item of PERSONNEL_LIFECYCLE_CASE_TRIGGER_DEFINITIONS) database.exec(item.sql);
}

module.exports = {
  PERSONNEL_LIFECYCLE_CASE_FOUNDATION_MIGRATION_ID,
  PERSONNEL_LIFECYCLE_CASE_REQUIRED_TABLES,
  PERSONNEL_LIFECYCLE_CASE_TABLE_DEFINITIONS,
  PERSONNEL_LIFECYCLE_CASE_TABLE_NAMES,
  PERSONNEL_LIFECYCLE_CASE_TRIGGER_DEFINITIONS,
  PERSONNEL_LIFECYCLE_CASE_TRIGGER_NAMES,
  ensureSqlitePersonnelLifecycleCaseSchema,
  inspectSqlitePersonnelLifecycleCaseRows,
  inspectSqlitePersonnelLifecycleCaseSchema,
};
