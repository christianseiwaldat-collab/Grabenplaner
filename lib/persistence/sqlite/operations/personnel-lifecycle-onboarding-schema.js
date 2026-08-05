"use strict";

const { createHash } = require("node:crypto");
const {
  personnelLifecycleAssignmentBindingReceiptBody,
  personnelLifecycleOnboardingOperationReceiptBody,
  personnelLifecyclePackageRunReceiptBody,
} = require("../../../personnel-lifecycle-onboarding-receipt");

const {
  PERSONNEL_LIFECYCLE_CASE_TABLE_DEFINITIONS,
  PERSONNEL_LIFECYCLE_CASE_TABLE_NAMES,
  PERSONNEL_LIFECYCLE_CASE_TRIGGER_DEFINITIONS,
} = require("./personnel-lifecycle-case-schema");

const PERSONNEL_LIFECYCLE_ONBOARDING_MIGRATION_ID =
  "v0.92-personnel-lifecycle-onboarding-execution";

function definition(name, sql) {
  return Object.freeze({ name, sql: String(sql || "").trim() });
}

function sha256Column(column) {
  return `${column} TEXT NOT NULL
        CHECK(
          length(${column}) = 64
          AND ${column} = lower(${column})
          AND ${column} NOT GLOB '*[^0-9a-f]*'
        )`;
}

function uuidV4Column(column) {
  return `${column} TEXT NOT NULL
        CHECK(
          length(${column}) = 36
          AND ${column} = lower(${column})
          AND substr(${column}, 9, 1) = '-'
          AND substr(${column}, 14, 1) = '-'
          AND substr(${column}, 15, 1) = '4'
          AND substr(${column}, 19, 1) = '-'
          AND substr(${column}, 20, 1) IN ('8','9','a','b')
          AND substr(${column}, 24, 1) = '-'
          AND substr(${column}, 1, 8) NOT GLOB '*[^0-9a-f]*'
          AND substr(${column}, 10, 4) NOT GLOB '*[^0-9a-f]*'
          AND substr(${column}, 15, 4) NOT GLOB '*[^0-9a-f]*'
          AND substr(${column}, 20, 4) NOT GLOB '*[^0-9a-f]*'
          AND substr(${column}, 25, 12) NOT GLOB '*[^0-9a-f]*'
        )`;
}

const PERSONNEL_LIFECYCLE_ONBOARDING_TABLE_DEFINITIONS = Object.freeze([
  definition("personnel_lifecycle_onboarding_operations", `
    CREATE TABLE IF NOT EXISTS personnel_lifecycle_onboarding_operations (
      ${uuidV4Column("operation_id")} PRIMARY KEY,
      case_id TEXT NOT NULL UNIQUE,
      ${sha256Column("request_sha256")},
      ${sha256Column("preview_sha256")},
      result_payload TEXT NOT NULL
        CHECK(json_valid(result_payload) AND json_type(result_payload) = 'object'),
      ${sha256Column("result_receipt_sha256")},
      actor_id TEXT NOT NULL CHECK(TRIM(actor_id) <> ''),
      occurred_at TEXT NOT NULL CHECK(TRIM(occurred_at) <> ''),
      FOREIGN KEY (case_id) REFERENCES personnel_lifecycle_cases(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );
  `),
  definition("personnel_lifecycle_case_package_runs", `
    CREATE TABLE IF NOT EXISTS personnel_lifecycle_case_package_runs (
      package_binding_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE,
      ${uuidV4Column("run_operation_id")} UNIQUE,
      family_codes_json TEXT NOT NULL CHECK(
        family_codes_json IN (
          '[]',
          '["base_security_privacy"]',
          '["personnel_administration"]',
          '["base_security_privacy","personnel_administration"]'
        )
      ),
      ${sha256Column("lifecycle_review_sha256")},
      ${sha256Column("scope_snapshot_sha256")},
      ${sha256Column("receipt_sha256")},
      linked_by TEXT NOT NULL CHECK(TRIM(linked_by) <> ''),
      linked_at TEXT NOT NULL CHECK(TRIM(linked_at) <> ''),
      UNIQUE(package_binding_id, run_id),
      FOREIGN KEY (package_binding_id)
        REFERENCES personnel_lifecycle_case_package_bindings(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (run_id) REFERENCES custom_process_runs(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );
  `),
  definition("personnel_lifecycle_case_assignment_bindings", `
    CREATE TABLE IF NOT EXISTS personnel_lifecycle_case_assignment_bindings (
      assignment_id TEXT PRIMARY KEY,
      package_binding_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      step_reference TEXT NOT NULL CHECK(TRIM(step_reference) <> ''),
      ${sha256Column("receipt_sha256")},
      bound_by TEXT NOT NULL CHECK(TRIM(bound_by) <> ''),
      bound_at TEXT NOT NULL CHECK(TRIM(bound_at) <> ''),
      UNIQUE(package_binding_id, step_reference),
      FOREIGN KEY (assignment_id)
        REFERENCES personnel_lifecycle_case_assignments(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (package_binding_id, run_id)
        REFERENCES personnel_lifecycle_case_package_runs(package_binding_id, run_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (run_id, step_reference)
        REFERENCES custom_process_run_steps(run_id, step_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );
  `),
]);

const PERSONNEL_LIFECYCLE_ONBOARDING_TABLE_NAMES = Object.freeze(
  PERSONNEL_LIFECYCLE_ONBOARDING_TABLE_DEFINITIONS.map(({ name }) => name),
);

const PERSONNEL_LIFECYCLE_ONBOARDING_INDEX_DEFINITIONS = Object.freeze([
  definition("ux_personnel_lifecycle_onboarding_nonterminal_episode", `
    CREATE UNIQUE INDEX IF NOT EXISTS
      ux_personnel_lifecycle_onboarding_nonterminal_episode
    ON personnel_lifecycle_cases(employment_episode_id)
    WHERE case_type = 'onboarding'
      AND state IN ('prepared','approved','active');
  `),
  definition("ux_personnel_lifecycle_current_episode_per_employee", `
    CREATE UNIQUE INDEX IF NOT EXISTS
      ux_personnel_lifecycle_current_episode_per_employee
    ON personnel_employment_episodes(employee_number)
    WHERE state IN ('employment_active','exit_in_progress');
  `),
  definition("idx_personnel_lifecycle_onboarding_operations_actor", `
    CREATE INDEX IF NOT EXISTS idx_personnel_lifecycle_onboarding_operations_actor
    ON personnel_lifecycle_onboarding_operations(actor_id, occurred_at, operation_id);
  `),
  definition("idx_personnel_lifecycle_case_package_runs_run", `
    CREATE INDEX IF NOT EXISTS idx_personnel_lifecycle_case_package_runs_run
    ON personnel_lifecycle_case_package_runs(run_id, package_binding_id);
  `),
  definition("idx_personnel_lifecycle_case_assignment_bindings_run", `
    CREATE INDEX IF NOT EXISTS idx_personnel_lifecycle_case_assignment_bindings_run
    ON personnel_lifecycle_case_assignment_bindings(run_id, step_reference);
  `),
]);

function immutableTriggers(tableName, message) {
  return [
    definition(`trg_${tableName}_o4_immutable_update`, `
      CREATE TRIGGER IF NOT EXISTS trg_${tableName}_o4_immutable_update
      BEFORE UPDATE ON ${tableName}
      BEGIN
        SELECT RAISE(ABORT, '${message} are immutable');
      END;
    `),
    definition(`trg_${tableName}_o4_immutable_delete`, `
      CREATE TRIGGER IF NOT EXISTS trg_${tableName}_o4_immutable_delete
      BEFORE DELETE ON ${tableName}
      BEGIN
        SELECT RAISE(ABORT, '${message} are immutable');
      END;
    `),
  ];
}

const PERSONNEL_LIFECYCLE_ONBOARDING_TRIGGER_DEFINITIONS = Object.freeze([
  definition("trg_personnel_employment_episodes_o4_insert_guard", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_employment_episodes_o4_insert_guard
    BEFORE INSERT ON personnel_employment_episodes
    WHEN NOT (
      NEW.state = 'employment_active'
      AND NEW.protected_payload LIKE 'enc:v2:%'
      AND NEW.revision = 1
      AND NEW.created_by = NEW.updated_by
      AND NEW.created_at = NEW.updated_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O4 employment episode is invalid');
    END;
  `),
  ...immutableTriggers(
    "personnel_employment_episodes",
    "personnel lifecycle O4 employment episodes",
  ),

  definition("trg_personnel_lifecycle_cases_o4_insert_guard", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_lifecycle_cases_o4_insert_guard
    BEFORE INSERT ON personnel_lifecycle_cases
    WHEN NOT (
      NEW.case_type = 'onboarding'
      AND NEW.state = 'prepared'
      AND NEW.protected_payload LIKE 'enc:v2:%'
      AND NEW.revision = 1
      AND NEW.created_by = NEW.updated_by
      AND NEW.created_at = NEW.updated_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O4 permits onboarding cases only');
    END;
  `),
  definition("trg_personnel_lifecycle_cases_o4_transition_guard", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_lifecycle_cases_o4_transition_guard
    BEFORE UPDATE ON personnel_lifecycle_cases
    WHEN NOT (
      OLD.case_type = 'onboarding'
      AND NEW.id IS OLD.id
      AND NEW.case_type IS OLD.case_type
      AND NEW.employment_episode_id IS OLD.employment_episode_id
      AND NEW.predecessor_case_id IS OLD.predecessor_case_id
      AND NEW.responsible_actor_id IS OLD.responsible_actor_id
      AND NEW.scope_type IS OLD.scope_type
      AND NEW.location_id IS OLD.location_id
      AND NEW.department_id IS OLD.department_id
      AND NEW.scope_snapshot_sha256 IS OLD.scope_snapshot_sha256
      AND NEW.protected_payload IS OLD.protected_payload
      AND NEW.created_by IS OLD.created_by
      AND NEW.created_at IS OLD.created_at
      AND NEW.revision = OLD.revision + 1
      AND TRIM(NEW.updated_by) <> ''
      AND TRIM(NEW.updated_at) <> ''
      AND (
        (OLD.state = 'prepared' AND NEW.state IN ('approved','cancelled'))
        OR (OLD.state = 'approved' AND NEW.state IN ('active','cancelled'))
        OR (OLD.state = 'active' AND NEW.state IN ('completed','cancelled'))
      )
      AND (
        NEW.state <> 'active'
        OR (
          EXISTS (
            SELECT 1
            FROM personnel_lifecycle_case_package_bindings binding
            WHERE binding.case_id = OLD.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM personnel_lifecycle_case_package_bindings binding
            LEFT JOIN personnel_lifecycle_case_package_runs package_run
              ON package_run.package_binding_id = binding.id
            WHERE binding.case_id = OLD.id
              AND package_run.package_binding_id IS NULL
          )
        )
      )
      AND (
        NEW.state <> 'completed'
        OR NOT EXISTS (
          SELECT 1
          FROM personnel_lifecycle_case_package_bindings binding
          JOIN personnel_lifecycle_case_package_runs package_run
            ON package_run.package_binding_id = binding.id
          JOIN custom_process_runs run ON run.id = package_run.run_id
          WHERE binding.case_id = OLD.id
            AND run.status <> 'resolved'
        )
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O4 case transition is invalid');
    END;
  `),
  definition("trg_personnel_lifecycle_cases_o4_delete_blocked", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_lifecycle_cases_o4_delete_blocked
    BEFORE DELETE ON personnel_lifecycle_cases
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O4 cases cannot be deleted');
    END;
  `),

  definition("trg_personnel_lifecycle_case_reference_dates_o4_insert_guard", `
    CREATE TRIGGER IF NOT EXISTS
      trg_personnel_lifecycle_case_reference_dates_o4_insert_guard
    BEFORE INSERT ON personnel_lifecycle_case_reference_dates
    WHEN NOT EXISTS (
      SELECT 1
      FROM personnel_lifecycle_cases lifecycle_case
      WHERE lifecycle_case.id = NEW.case_id
        AND lifecycle_case.case_type = 'onboarding'
        AND lifecycle_case.state IN ('prepared','approved','active')
        AND NEW.protected_payload LIKE 'enc:v2:%'
        AND (
          (NEW.revision = 1 AND NEW.previous_revision_id IS NULL)
          OR EXISTS (
            SELECT 1
            FROM personnel_lifecycle_case_reference_dates previous
            WHERE previous.id = NEW.previous_revision_id
              AND previous.case_id = NEW.case_id
              AND NEW.revision = previous.revision + 1
              AND previous.revision = (
                SELECT MAX(latest.revision)
                FROM personnel_lifecycle_case_reference_dates latest
                WHERE latest.case_id = NEW.case_id
              )
          )
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O4 reference dates are invalid');
    END;
  `),
  ...immutableTriggers(
    "personnel_lifecycle_case_reference_dates",
    "personnel lifecycle O4 reference dates",
  ),

  definition("trg_personnel_lifecycle_case_package_bindings_o4_insert_guard", `
    CREATE TRIGGER IF NOT EXISTS
      trg_personnel_lifecycle_case_package_bindings_o4_insert_guard
    BEFORE INSERT ON personnel_lifecycle_case_package_bindings
    WHEN NOT EXISTS (
      SELECT 1
      FROM personnel_lifecycle_cases lifecycle_case
      JOIN custom_process_publications publication
        ON publication.id = NEW.publication_id
      LEFT JOIN custom_process_publication_archives archive
        ON archive.publication_id = publication.id
      WHERE lifecycle_case.id = NEW.case_id
        AND lifecycle_case.case_type = 'onboarding'
        AND lifecycle_case.state = 'approved'
        AND publication.workflow_type = 'onboarding'
        AND publication.version_number = NEW.version_number
        AND archive.publication_id IS NULL
        AND (
          publication.scope_type = 'company'
          OR (
            publication.scope_type = 'location'
            AND publication.location_id = lifecycle_case.location_id
          )
          OR (
            publication.scope_type = 'department'
            AND publication.location_id = lifecycle_case.location_id
            AND publication.department_id = lifecycle_case.department_id
          )
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O4 package binding is invalid');
    END;
  `),
  ...immutableTriggers(
    "personnel_lifecycle_case_package_bindings",
    "personnel lifecycle O4 package bindings",
  ),

  definition("trg_personnel_lifecycle_case_assignments_o4_insert_guard", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_lifecycle_case_assignments_o4_insert_guard
    BEFORE INSERT ON personnel_lifecycle_case_assignments
    WHEN NOT EXISTS (
      SELECT 1
      FROM personnel_lifecycle_cases lifecycle_case
      JOIN portal_users portal_user
        ON portal_user.employee_number = NEW.assignee_actor_id
      JOIN employees employee
        ON employee.personnel_number = portal_user.employee_number
      WHERE lifecycle_case.id = NEW.case_id
        AND lifecycle_case.case_type = 'onboarding'
        AND lifecycle_case.state = 'approved'
        AND portal_user.active = 1
        AND employee.active = 1
        AND portal_user.role NOT IN ('it_admin','developer','local')
        AND TRIM(COALESCE(portal_user.password_hash, '')) <> ''
        AND EXISTS (
          SELECT 1
          FROM personnel_lifecycle_case_package_bindings binding
          JOIN custom_process_publications publication
            ON publication.id = binding.publication_id
          JOIN json_each(publication.snapshot_json, '$.steps') snapshot_step
            ON json_extract(snapshot_step.value, '$.id') = NEW.step_reference
          WHERE binding.case_id = NEW.case_id
            AND json_extract(snapshot_step.value, '$.responsibilityType')
              IN ('role','employee')
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O4 assignment is invalid');
    END;
  `),
  ...immutableTriggers(
    "personnel_lifecycle_case_assignments",
    "personnel lifecycle O4 assignments",
  ),

  definition("trg_personnel_lifecycle_case_events_o4_insert_guard", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_lifecycle_case_events_o4_insert_guard
    BEFORE INSERT ON personnel_lifecycle_case_events
    WHEN NOT EXISTS (
      SELECT 1
      FROM personnel_lifecycle_cases lifecycle_case
      WHERE lifecycle_case.id = NEW.case_id
        AND lifecycle_case.case_type = 'onboarding'
        AND NEW.protected_payload LIKE 'enc:v2:%'
        AND NEW.data_classification IN (
          'operational_standard','personal_restricted','hr_confidential'
        )
        AND (
          (
            NEW.sequence_number = 1
            AND NEW.previous_receipt_sha256 = ''
            AND NOT EXISTS (
              SELECT 1 FROM personnel_lifecycle_case_events existing
              WHERE existing.case_id = NEW.case_id
            )
          )
          OR EXISTS (
            SELECT 1
            FROM personnel_lifecycle_case_events previous
            WHERE previous.case_id = NEW.case_id
              AND previous.sequence_number = NEW.sequence_number - 1
              AND previous.receipt_sha256 = NEW.previous_receipt_sha256
              AND previous.sequence_number = (
                SELECT MAX(latest.sequence_number)
                FROM personnel_lifecycle_case_events latest
                WHERE latest.case_id = NEW.case_id
              )
          )
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O4 event is invalid');
    END;
  `),
  ...immutableTriggers(
    "personnel_lifecycle_case_events",
    "personnel lifecycle O4 events",
  ),

  definition("trg_personnel_lifecycle_confidential_access_events_o4_insert_blocked", `
    CREATE TRIGGER IF NOT EXISTS
      trg_personnel_lifecycle_confidential_access_events_o4_insert_blocked
    BEFORE INSERT ON personnel_lifecycle_confidential_access_events
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle confidential access remains locked until O5');
    END;
  `),
  definition("trg_personnel_lifecycle_confidential_access_events_o4_update_blocked", `
    CREATE TRIGGER IF NOT EXISTS
      trg_personnel_lifecycle_confidential_access_events_o4_update_blocked
    BEFORE UPDATE ON personnel_lifecycle_confidential_access_events
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle confidential access remains locked until O5');
    END;
  `),
  definition("trg_personnel_lifecycle_confidential_access_events_o4_delete_blocked", `
    CREATE TRIGGER IF NOT EXISTS
      trg_personnel_lifecycle_confidential_access_events_o4_delete_blocked
    BEFORE DELETE ON personnel_lifecycle_confidential_access_events
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle confidential access remains locked until O5');
    END;
  `),

  definition("trg_personnel_lifecycle_case_package_runs_o4_insert_guard", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_lifecycle_case_package_runs_o4_insert_guard
    BEFORE INSERT ON personnel_lifecycle_case_package_runs
    WHEN NOT EXISTS (
      SELECT 1
      FROM personnel_lifecycle_case_package_bindings binding
      JOIN personnel_lifecycle_cases lifecycle_case
        ON lifecycle_case.id = binding.case_id
      JOIN custom_process_publications publication
        ON publication.id = binding.publication_id
      JOIN custom_process_runs run ON run.id = NEW.run_id
      LEFT JOIN custom_process_run_bindings legacy_binding
        ON legacy_binding.run_id = run.id
      WHERE binding.id = NEW.package_binding_id
        AND lifecycle_case.case_type = 'onboarding'
        AND lifecycle_case.state = 'approved'
        AND publication.workflow_type = 'onboarding'
        AND binding.version_number = publication.version_number
        AND NEW.scope_snapshot_sha256 = binding.scope_snapshot_sha256
        AND run.process_id = publication.process_id
        AND run.process_revision = publication.source_revision
        AND run.trigger_type = 'personnel_manual'
        AND run.trigger_key = 'personnel:' || NEW.run_operation_id
        AND run.status = 'open'
        AND run.activation_count = 1
        AND run.location_id = lifecycle_case.location_id
        AND run.department_id IS lifecycle_case.department_id
        AND legacy_binding.run_id IS NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O4 package run linkage is invalid');
    END;
  `),
  ...immutableTriggers(
    "personnel_lifecycle_case_package_runs",
    "personnel lifecycle O4 package run linkages",
  ),

  definition("trg_personnel_lifecycle_case_assignment_bindings_o4_insert_guard", `
    CREATE TRIGGER IF NOT EXISTS
      trg_personnel_lifecycle_case_assignment_bindings_o4_insert_guard
    BEFORE INSERT ON personnel_lifecycle_case_assignment_bindings
    WHEN NOT EXISTS (
      SELECT 1
      FROM personnel_lifecycle_case_assignments assignment
      JOIN personnel_lifecycle_case_package_bindings package_binding
        ON package_binding.id = NEW.package_binding_id
        AND package_binding.case_id = assignment.case_id
      JOIN personnel_lifecycle_case_package_runs package_run
        ON package_run.package_binding_id = package_binding.id
        AND package_run.run_id = NEW.run_id
      JOIN personnel_lifecycle_cases lifecycle_case
        ON lifecycle_case.id = assignment.case_id
      JOIN custom_process_publications publication
        ON publication.id = package_binding.publication_id
      JOIN custom_process_run_steps run_step
        ON run_step.run_id = NEW.run_id
        AND run_step.step_id = NEW.step_reference
      JOIN json_each(publication.snapshot_json, '$.steps') snapshot_step
        ON json_extract(snapshot_step.value, '$.id') = NEW.step_reference
      WHERE assignment.id = NEW.assignment_id
        AND assignment.step_reference = NEW.step_reference
        AND lifecycle_case.case_type = 'onboarding'
        AND lifecycle_case.state = 'approved'
        AND run_step.status IN ('pending','active')
        AND json_extract(snapshot_step.value, '$.responsibilityType')
          IN ('role','employee')
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O4 assignment linkage is invalid');
    END;
  `),
  ...immutableTriggers(
    "personnel_lifecycle_case_assignment_bindings",
    "personnel lifecycle O4 assignment linkages",
  ),

  definition("trg_personnel_lifecycle_onboarding_operations_o4_insert_guard", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_lifecycle_onboarding_operations_o4_insert_guard
    BEFORE INSERT ON personnel_lifecycle_onboarding_operations
    WHEN NOT EXISTS (
      SELECT 1
      FROM personnel_lifecycle_cases lifecycle_case
      WHERE lifecycle_case.id = NEW.case_id
        AND lifecycle_case.case_type = 'onboarding'
        AND lifecycle_case.state = 'active'
        AND lifecycle_case.updated_by = NEW.actor_id
        AND EXISTS (
          SELECT 1
          FROM personnel_lifecycle_case_package_bindings binding
          WHERE binding.case_id = NEW.case_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM personnel_lifecycle_case_package_bindings binding
          LEFT JOIN personnel_lifecycle_case_package_runs package_run
            ON package_run.package_binding_id = binding.id
          WHERE binding.case_id = NEW.case_id
            AND package_run.package_binding_id IS NULL
        )
        AND NOT EXISTS (
          SELECT 1
          FROM personnel_lifecycle_case_assignments assignment
          LEFT JOIN personnel_lifecycle_case_assignment_bindings assignment_binding
            ON assignment_binding.assignment_id = assignment.id
          WHERE assignment.case_id = NEW.case_id
            AND assignment_binding.assignment_id IS NULL
        )
        AND NOT EXISTS (
          SELECT 1
          FROM personnel_lifecycle_case_package_bindings binding
          JOIN custom_process_publications publication
            ON publication.id = binding.publication_id
          JOIN json_each(publication.snapshot_json, '$.steps') snapshot_step
          WHERE binding.case_id = NEW.case_id
            AND json_extract(snapshot_step.value, '$.responsibilityType')
              IN ('role','employee')
            AND NOT EXISTS (
              SELECT 1
              FROM personnel_lifecycle_case_assignment_bindings assignment_binding
              WHERE assignment_binding.package_binding_id = binding.id
                AND assignment_binding.step_reference =
                  json_extract(snapshot_step.value, '$.id')
            )
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O4 operation ledger is incomplete');
    END;
  `),
  ...immutableTriggers(
    "personnel_lifecycle_onboarding_operations",
    "personnel lifecycle O4 operation ledger entries",
  ),
]);

const PERSONNEL_LIFECYCLE_ONBOARDING_TRIGGER_NAMES = Object.freeze(
  PERSONNEL_LIFECYCLE_ONBOARDING_TRIGGER_DEFINITIONS.map(({ name }) => name),
);
const O5_REPLACED_O4_TRIGGER_NAMES = new Set([
  "trg_personnel_employment_episodes_o4_immutable_update",
  "trg_personnel_lifecycle_cases_o4_insert_guard",
  "trg_personnel_lifecycle_cases_o4_transition_guard",
  "trg_personnel_lifecycle_case_reference_dates_o4_insert_guard",
  "trg_personnel_lifecycle_case_assignments_o4_insert_guard",
  "trg_personnel_lifecycle_case_events_o4_insert_guard",
  "trg_personnel_lifecycle_confidential_access_events_o4_insert_blocked",
  "trg_personnel_lifecycle_confidential_access_events_o4_update_blocked",
  "trg_personnel_lifecycle_confidential_access_events_o4_delete_blocked",
]);

const PERSONNEL_LIFECYCLE_ONBOARDING_REQUIRED_TABLES = Object.freeze([
  ...PERSONNEL_LIFECYCLE_CASE_TABLE_NAMES,
  "custom_process_publications",
  "custom_process_publication_archives",
  "custom_process_runs",
  "custom_process_run_steps",
  "custom_process_run_bindings",
  "portal_users",
  "employees",
]);

function normalizeDefinitionSql(sql, type) {
  let normalized = String(sql || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*;\s*$/, "")
    .toLowerCase();
  if (type === "table") {
    normalized = normalized.replace(/^create table if not exists /i, "create table ");
  } else if (type === "trigger") {
    normalized = normalized.replace(/^create trigger if not exists /i, "create trigger ");
  } else if (type === "index") {
    normalized = normalized.replace(
      /^create (unique )?index if not exists /i,
      (_, unique) => `create ${unique || ""}index `,
    );
  }
  return normalized;
}

function sqliteObject(database, type, name) {
  return database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = ? AND name = ?
  `).get(type, name);
}

function inspectDefinitions(database, type, definitions) {
  const missing = [];
  const invalid = [];
  for (const item of definitions) {
    const row = sqliteObject(database, type, item.name);
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

function inspectBaseTables(database) {
  return inspectDefinitions(
    database,
    "table",
    PERSONNEL_LIFECYCLE_CASE_TABLE_DEFINITIONS,
  );
}

function inspectSqlitePersonnelLifecycleOnboardingSchema(database) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Inspektionsdatenbank wird benoetigt.");
  }
  const baseTables = inspectBaseTables(database);
  const tables = inspectDefinitions(
    database,
    "table",
    PERSONNEL_LIFECYCLE_ONBOARDING_TABLE_DEFINITIONS,
  );
  const indexes = inspectDefinitions(
    database,
    "index",
    PERSONNEL_LIFECYCLE_ONBOARDING_INDEX_DEFINITIONS,
  );
  const triggers = inspectDefinitions(
    database,
    "trigger",
    PERSONNEL_LIFECYCLE_ONBOARDING_TRIGGER_DEFINITIONS,
  );
  const offboardingSchemaPresent = Boolean(sqliteObject(
    database,
    "table",
    "personnel_lifecycle_offboarding_operations",
  ));
  const effectiveMissingTriggers = offboardingSchemaPresent
    ? triggers.missing.filter((name) => !O5_REPLACED_O4_TRIGGER_NAMES.has(name))
    : triggers.missing;
  const effectiveInvalidTriggers = offboardingSchemaPresent
    ? triggers.invalid.filter((name) => !O5_REPLACED_O4_TRIGGER_NAMES.has(name))
    : triggers.invalid;
  const unexpectedO2Triggers = PERSONNEL_LIFECYCLE_CASE_TRIGGER_DEFINITIONS
    .filter(({ name }) => sqliteObject(database, "trigger", name))
    .map(({ name }) => name);
  const issues = Object.freeze([
    ...baseTables.missing.map((name) => `base-table-missing:${name}`),
    ...baseTables.invalid.map((name) => `base-table-invalid:${name}`),
    ...tables.missing.map((name) => `table-missing:${name}`),
    ...tables.invalid.map((name) => `table-invalid:${name}`),
    ...indexes.missing.map((name) => `index-missing:${name}`),
    ...indexes.invalid.map((name) => `index-invalid:${name}`),
    ...effectiveMissingTriggers.map((name) => `trigger-missing:${name}`),
    ...effectiveInvalidTriggers.map((name) => `trigger-invalid:${name}`),
    ...unexpectedO2Triggers.map((name) => `o2-trigger-still-active:${name}`),
  ]);
  return Object.freeze({
    valid: issues.length === 0,
    absent: tables.missing.length === PERSONNEL_LIFECYCLE_ONBOARDING_TABLE_DEFINITIONS.length
      && triggers.missing.length === PERSONNEL_LIFECYCLE_ONBOARDING_TRIGGER_DEFINITIONS.length,
    issues,
    missingTables: tables.missing,
    invalidTables: tables.invalid,
    missingIndexes: indexes.missing,
    invalidIndexes: indexes.invalid,
    missingTriggers: triggers.missing,
    invalidTriggers: triggers.invalid,
    unexpectedO2Triggers: Object.freeze(unexpectedO2Triggers),
    offboardingSchemaPresent,
  });
}

function countRows(database, tableName) {
  return Number(database.prepare(
    `SELECT COUNT(*) AS count FROM "${tableName}"`,
  ).get().count || 0);
}

function receiptSha256(body) {
  return createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");
}

function inspectSqlitePersonnelLifecycleOnboardingRows(database) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Inspektionsdatenbank wird benoetigt.");
  }
  const schema = inspectSqlitePersonnelLifecycleOnboardingSchema(database);
  if (!schema.valid) {
    return Object.freeze({ valid: false, issues: Object.freeze(["schema-invalid"]) });
  }
  const issues = [];
  for (const tableName of [
    ...PERSONNEL_LIFECYCLE_CASE_TABLE_NAMES,
    ...PERSONNEL_LIFECYCLE_ONBOARDING_TABLE_NAMES,
  ]) {
    for (const violation of database.prepare(`PRAGMA foreign_key_check("${tableName}")`).all()) {
      issues.push(`foreign-key:${tableName}:${violation.rowid ?? "unknown"}`);
    }
  }
  if (!schema.offboardingSchemaPresent) {
    const offboardingCount = Number(database.prepare(`
      SELECT COUNT(*) AS count
      FROM personnel_lifecycle_cases
      WHERE case_type <> 'onboarding'
    `).get().count || 0);
    if (offboardingCount) issues.push(`offboarding-data-present:${offboardingCount}`);
  }
  for (const row of database.prepare(`
    SELECT * FROM personnel_lifecycle_case_package_runs
  `).all()) {
    if (receiptSha256(personnelLifecyclePackageRunReceiptBody(row)) !== row.receipt_sha256) {
      issues.push(`package-run-receipt:${row.package_binding_id}`);
    }
  }
  for (const row of database.prepare(`
    SELECT * FROM personnel_lifecycle_case_assignment_bindings
  `).all()) {
    if (receiptSha256(
      personnelLifecycleAssignmentBindingReceiptBody(row),
    ) !== row.receipt_sha256) {
      issues.push(`assignment-binding-receipt:${row.assignment_id}`);
    }
  }
  for (const row of database.prepare(`
    SELECT * FROM personnel_lifecycle_onboarding_operations
  `).all()) {
    if (receiptSha256(
      personnelLifecycleOnboardingOperationReceiptBody(row),
    ) !== row.result_receipt_sha256) {
      issues.push(`operation-receipt:${row.operation_id}`);
    }
  }
  return Object.freeze({ valid: issues.length === 0, issues: Object.freeze(issues) });
}

function onboardingSchemaError(code, message, details = []) {
  const error = new Error(message);
  error.code = code;
  error.details = Object.freeze([...details]);
  return error;
}

function ensureRequiredTables(database) {
  const missing = PERSONNEL_LIFECYCLE_ONBOARDING_REQUIRED_TABLES.filter((name) => (
    !sqliteObject(database, "table", name)
  ));
  if (missing.length) {
    throw onboardingSchemaError(
      "PERSONNEL_LIFECYCLE_ONBOARDING_SCHEMA_DEPENDENCY_MISSING",
      "Das O4-Onboarding-Schema kann ohne seine kanonischen Grundlagen nicht geoeffnet werden.",
      missing,
    );
  }
  const base = inspectBaseTables(database);
  if (base.missing.length || base.invalid.length) {
    throw onboardingSchemaError(
      "PERSONNEL_LIFECYCLE_ONBOARDING_SCHEMA_BASE_INVALID",
      "Das O2-Fallschema ist nicht kanonisch.",
      [...base.missing, ...base.invalid],
    );
  }
}

function ensureInitialO2State(database) {
  const o4TableCount = PERSONNEL_LIFECYCLE_ONBOARDING_TABLE_NAMES.filter((name) => (
    sqliteObject(database, "table", name)
  )).length;
  if (o4TableCount) return;
  const invalidO2Triggers = inspectDefinitions(
    database,
    "trigger",
    PERSONNEL_LIFECYCLE_CASE_TRIGGER_DEFINITIONS,
  );
  if (invalidO2Triggers.missing.length || invalidO2Triggers.invalid.length) {
    throw onboardingSchemaError(
      "PERSONNEL_LIFECYCLE_ONBOARDING_SCHEMA_O2_GUARD_INVALID",
      "Die O2-Schreibsperre ist vor der O4-Migration nicht kanonisch.",
      [...invalidO2Triggers.missing, ...invalidO2Triggers.invalid],
    );
  }
  const populated = PERSONNEL_LIFECYCLE_CASE_TABLE_NAMES
    .map((name) => [name, countRows(database, name)])
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name}:${count}`);
  if (populated.length) {
    throw onboardingSchemaError(
      "PERSONNEL_LIFECYCLE_ONBOARDING_SCHEMA_DATA_PRESENT",
      "Die O4-Migration verweigert einen unerwartet befuellten O2-Stand.",
      populated,
    );
  }
}

function ensureSqlitePersonnelLifecycleOnboardingSchema(database) {
  if (!database || typeof database.exec !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benoetigt.");
  }
  ensureRequiredTables(database);
  const current = inspectSqlitePersonnelLifecycleOnboardingSchema(database);
  if (current.valid) return current;
  ensureInitialO2State(database);

  const existingO4Rows = [
    ...PERSONNEL_LIFECYCLE_CASE_TABLE_NAMES,
    ...PERSONNEL_LIFECYCLE_ONBOARDING_TABLE_NAMES,
  ]
    .filter((name) => sqliteObject(database, "table", name))
    .map((name) => [name, countRows(database, name)])
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name}:${count}`);
  if (existingO4Rows.length) {
    throw onboardingSchemaError(
      "PERSONNEL_LIFECYCLE_ONBOARDING_SCHEMA_DRIFT_WITH_DATA",
      "Ein abweichender O4-Stand mit Daten wird nicht automatisch repariert.",
      existingO4Rows,
    );
  }

  database.exec("SAVEPOINT personnel_lifecycle_o4_schema");
  try {
    for (const item of PERSONNEL_LIFECYCLE_ONBOARDING_TABLE_DEFINITIONS) {
      database.exec(item.sql);
    }
    for (const item of PERSONNEL_LIFECYCLE_ONBOARDING_INDEX_DEFINITIONS) {
      database.exec(item.sql);
    }
    for (const item of PERSONNEL_LIFECYCLE_CASE_TRIGGER_DEFINITIONS) {
      database.exec(`DROP TRIGGER IF EXISTS "${item.name}"`);
    }
    for (const item of PERSONNEL_LIFECYCLE_ONBOARDING_TRIGGER_DEFINITIONS) {
      database.exec(item.sql);
    }
    const result = inspectSqlitePersonnelLifecycleOnboardingSchema(database);
    if (!result.valid) {
      throw onboardingSchemaError(
        "PERSONNEL_LIFECYCLE_ONBOARDING_SCHEMA_INVALID",
        "Das O4-Onboarding-Schema konnte nicht kanonisch hergestellt werden.",
        result.issues,
      );
    }
    database.exec("RELEASE SAVEPOINT personnel_lifecycle_o4_schema");
    return result;
  } catch (error) {
    database.exec("ROLLBACK TO SAVEPOINT personnel_lifecycle_o4_schema");
    database.exec("RELEASE SAVEPOINT personnel_lifecycle_o4_schema");
    throw error;
  }
}

module.exports = {
  PERSONNEL_LIFECYCLE_ONBOARDING_INDEX_DEFINITIONS,
  PERSONNEL_LIFECYCLE_ONBOARDING_MIGRATION_ID,
  PERSONNEL_LIFECYCLE_ONBOARDING_REQUIRED_TABLES,
  PERSONNEL_LIFECYCLE_ONBOARDING_TABLE_DEFINITIONS,
  PERSONNEL_LIFECYCLE_ONBOARDING_TABLE_NAMES,
  PERSONNEL_LIFECYCLE_ONBOARDING_TRIGGER_DEFINITIONS,
  PERSONNEL_LIFECYCLE_ONBOARDING_TRIGGER_NAMES,
  ensureSqlitePersonnelLifecycleOnboardingSchema,
  inspectSqlitePersonnelLifecycleOnboardingRows,
  inspectSqlitePersonnelLifecycleOnboardingSchema,
};
