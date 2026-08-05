"use strict";

const { createHash } = require("node:crypto");
const {
  personnelWorkflowInstanceReceiptBody,
  personnelWorkflowTaskAssignmentReceiptBody,
} = require("../../../personnel-workflow-instance-receipt");

const PERSONNEL_WORKFLOW_INSTANCE_MIGRATION_ID =
  "v0.89-personnel-workflow-instances";

function definition(name, sql) {
  return Object.freeze({ name, sql: String(sql || "").trim() });
}

const PERSONNEL_WORKFLOW_INSTANCE_TABLE_DEFINITIONS = Object.freeze([
  definition("custom_process_run_bindings", `
    CREATE TABLE IF NOT EXISTS custom_process_run_bindings (
      run_id TEXT PRIMARY KEY,
      publication_id TEXT NOT NULL,
      operation_id TEXT NOT NULL UNIQUE
        CHECK(
          length(operation_id) = 36
          AND operation_id = lower(operation_id)
          AND substr(operation_id, 9, 1) = '-'
          AND substr(operation_id, 14, 1) = '-'
          AND substr(operation_id, 15, 1) = '4'
          AND substr(operation_id, 19, 1) = '-'
          AND substr(operation_id, 20, 1) IN ('8','9','a','b')
          AND substr(operation_id, 24, 1) = '-'
          AND substr(operation_id, 1, 8) NOT GLOB '*[^0-9a-f]*'
          AND substr(operation_id, 10, 4) NOT GLOB '*[^0-9a-f]*'
          AND substr(operation_id, 15, 4) NOT GLOB '*[^0-9a-f]*'
          AND substr(operation_id, 20, 4) NOT GLOB '*[^0-9a-f]*'
          AND substr(operation_id, 25, 12) NOT GLOB '*[^0-9a-f]*'
        ),
      subject_type TEXT NOT NULL CHECK(subject_type IN ('candidate','employee')),
      candidate_id TEXT,
      application_id TEXT,
      candidate_revision INTEGER
        CHECK(candidate_revision IS NULL OR candidate_revision >= 1),
      application_revision INTEGER
        CHECK(application_revision IS NULL OR application_revision >= 1),
      employee_number TEXT,
      request_sha256 TEXT NOT NULL
        CHECK(
          length(request_sha256) = 64
          AND request_sha256 = lower(request_sha256)
          AND request_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
      receipt_sha256 TEXT NOT NULL
        CHECK(
          length(receipt_sha256) = 64
          AND receipt_sha256 = lower(receipt_sha256)
          AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
      started_by TEXT NOT NULL CHECK(TRIM(started_by) <> ''),
      started_at TEXT NOT NULL,
      CHECK(
        (subject_type = 'candidate'
          AND candidate_id IS NOT NULL
          AND application_id IS NOT NULL
          AND candidate_revision IS NOT NULL
          AND application_revision IS NOT NULL
          AND employee_number IS NULL)
        OR (subject_type = 'employee'
          AND candidate_id IS NULL
          AND application_id IS NULL
          AND candidate_revision IS NULL
          AND application_revision IS NULL
          AND employee_number IS NOT NULL)
      ),
      FOREIGN KEY (run_id) REFERENCES custom_process_runs(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (publication_id) REFERENCES custom_process_publications(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (candidate_id) REFERENCES candidates(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (application_id, candidate_id)
        REFERENCES candidate_applications(id, candidate_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );
  `),
  definition("custom_process_run_step_assignments", `
    CREATE TABLE IF NOT EXISTS custom_process_run_step_assignments (
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      employee_number TEXT NOT NULL,
      responsibility_type TEXT NOT NULL
        CHECK(responsibility_type IN ('role','employee')),
      responsibility_reference TEXT NOT NULL
        CHECK(TRIM(responsibility_reference) <> ''),
      assigned_by TEXT NOT NULL CHECK(TRIM(assigned_by) <> ''),
      assigned_at TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL
        CHECK(
          length(receipt_sha256) = 64
          AND receipt_sha256 = lower(receipt_sha256)
          AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
      PRIMARY KEY (run_id, step_id),
      FOREIGN KEY (run_id) REFERENCES custom_process_run_bindings(run_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (run_id, step_id)
        REFERENCES custom_process_run_steps(run_id, step_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );
  `),
]);

const PERSONNEL_WORKFLOW_INSTANCE_TABLE_NAMES = Object.freeze(
  PERSONNEL_WORKFLOW_INSTANCE_TABLE_DEFINITIONS.map(({ name }) => name),
);

const PERSONNEL_WORKFLOW_INSTANCE_BASE_TRIGGER_DEFINITIONS = Object.freeze([
  definition("trg_custom_process_run_bindings_relation_insert", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_run_bindings_relation_insert
    BEFORE INSERT ON custom_process_run_bindings
    WHEN NOT EXISTS (
      SELECT 1
      FROM custom_process_runs run
      JOIN custom_process_publications publication
        ON publication.id = NEW.publication_id
      LEFT JOIN custom_process_publication_archives archive
        ON archive.publication_id = publication.id
      LEFT JOIN candidates candidate
        ON candidate.id = NEW.candidate_id
      LEFT JOIN candidate_applications application
        ON application.id = NEW.application_id
        AND application.candidate_id = NEW.candidate_id
      LEFT JOIN employees employee
        ON employee.personnel_number = NEW.employee_number
      LEFT JOIN locations run_location
        ON run_location.id = run.location_id
      LEFT JOIN departments run_department
        ON run_department.id = run.department_id
      WHERE run.id = NEW.run_id
        AND run.process_id = publication.process_id
        AND run.process_revision = publication.source_revision
        AND run.trigger_type = 'personnel_manual'
        AND run.trigger_key = 'personnel:' || NEW.operation_id
        AND run.status = 'open'
        AND run.activation_count = 1
        AND run.triggered_by = NEW.started_by
        AND NOT EXISTS (
          SELECT 1 FROM custom_process_run_steps existing_step
          WHERE existing_step.run_id = NEW.run_id
        )
        AND archive.publication_id IS NULL
        AND publication.data_classification = 'standard'
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(publication.snapshot_json, '$.steps') snapshot_step
          WHERE json_type(snapshot_step.value, '$.notificationChannels') IS NOT NULL
            AND (
              json_type(snapshot_step.value, '$.notificationChannels') <> 'array'
              OR json_array_length(
                snapshot_step.value,
                '$.notificationChannels'
              ) <> 0
            )
        )
        AND (
          (run.location_id IS NULL AND run.department_id IS NULL)
          OR (
            run.location_id IS NOT NULL
            AND run_location.active = 1
            AND (
              run.department_id IS NULL
              OR (
                run_department.active = 1
                AND run_department.location_id = run.location_id
              )
            )
          )
        )
        AND (
          publication.scope_type = 'company'
          OR (
            publication.scope_type = 'location'
            AND publication.location_id IS run.location_id
          )
          OR (
            publication.scope_type = 'department'
            AND publication.location_id IS run.location_id
            AND publication.department_id IS run.department_id
          )
        )
        AND (
          (
            NEW.subject_type = 'candidate'
            AND candidate.state = 'active'
            AND application.id IS NOT NULL
            AND candidate.revision = NEW.candidate_revision
            AND application.revision = NEW.application_revision
            AND application.status NOT IN (
              'converted','rejected','withdrawn','archived'
            )
            AND run.location_id IS application.desired_location_id
            AND run.department_id IS application.desired_department_id
            AND publication.workflow_type IN ('application','preboarding')
            AND (
              publication.workflow_type <> 'preboarding'
              OR application.status IN ('accepted','preboarding')
            )
          )
          OR (
            NEW.subject_type = 'employee'
            AND employee.active = 1
            AND run.location_id IS employee.home_location_id
            AND run.department_id IS employee.preferred_department_id
            AND publication.workflow_type IN (
              'training','position_change','department_change','location_change',
              'return_from_absence'
            )
          )
          OR (
            NEW.subject_type = 'employee'
            AND publication.workflow_type = 'onboarding'
            AND employee.active = 1
            AND run.location_id IS employee.home_location_id
            AND run.department_id IS employee.preferred_department_id
            AND EXISTS (
              SELECT 1 FROM sqlite_master
              WHERE type = 'table'
                AND name = 'personnel_lifecycle_case_package_runs'
            )
            AND EXISTS (
              SELECT 1 FROM sqlite_master
              WHERE type = 'table'
                AND name = 'personnel_lifecycle_case_package_bindings'
            )
            AND EXISTS (
              SELECT 1 FROM sqlite_master
              WHERE type = 'table'
                AND name = 'personnel_lifecycle_cases'
            )
            AND EXISTS (
              SELECT 1 FROM sqlite_master
              WHERE type = 'table'
                AND name = 'personnel_employment_episodes'
            )
          )
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel workflow instance binding is invalid');
    END;
  `),
  definition("trg_custom_process_run_bindings_immutable_update", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_run_bindings_immutable_update
    BEFORE UPDATE ON custom_process_run_bindings
    BEGIN
      SELECT RAISE(ABORT, 'personnel workflow instance bindings are immutable');
    END;
  `),
  definition("trg_custom_process_run_bindings_immutable_delete", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_run_bindings_immutable_delete
    BEFORE DELETE ON custom_process_run_bindings
    BEGIN
      SELECT RAISE(ABORT, 'personnel workflow instance bindings are immutable');
    END;
  `),
  definition("trg_custom_process_run_assignments_relation_insert", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_run_assignments_relation_insert
    BEFORE INSERT ON custom_process_run_step_assignments
    WHEN NOT EXISTS (
      SELECT 1
      FROM custom_process_run_bindings binding
      JOIN custom_process_runs run ON run.id = binding.run_id
      JOIN custom_process_publications publication
        ON publication.id = binding.publication_id
      JOIN custom_process_run_steps run_step
        ON run_step.run_id = binding.run_id
        AND run_step.step_id = NEW.step_id
      JOIN json_each(publication.snapshot_json, '$.steps') snapshot_step
        ON json_extract(snapshot_step.value, '$.id') = NEW.step_id
      JOIN portal_users portal_user
        ON portal_user.employee_number = NEW.employee_number
      JOIN employees employee
        ON employee.personnel_number = portal_user.employee_number
      JOIN portal_roles portal_role
        ON portal_role.id = portal_user.role
      WHERE binding.run_id = NEW.run_id
        AND run.status = 'open'
        AND run_step.status = 'pending'
        AND NEW.assigned_by = binding.started_by
        AND NEW.assigned_at = binding.started_at
        AND json_extract(snapshot_step.value, '$.responsibilityType')
          = NEW.responsibility_type
        AND json_extract(snapshot_step.value, '$.responsibilityReference')
          = NEW.responsibility_reference
        AND (
          (NEW.responsibility_type = 'employee'
            AND NEW.employee_number = NEW.responsibility_reference)
          OR (NEW.responsibility_type = 'role'
            AND portal_user.role = NEW.responsibility_reference)
        )
        AND portal_user.active = 1
        AND employee.active = 1
        AND portal_user.role NOT IN ('it_admin','developer','local')
        AND TRIM(COALESCE(portal_user.password_hash, '')) <> ''
        AND NOT EXISTS (
          SELECT 1
          FROM portal_permission_denials denial
          WHERE denial.employee_number = portal_user.employee_number
            AND denial.permission = 'personnel:workflows:read'
        )
        AND (
          EXISTS (
            SELECT 1
            FROM json_each(COALESCE(portal_role.permissions, '[]')) role_permission
            WHERE role_permission.value = 'personnel:workflows:read'
          )
          OR EXISTS (
            SELECT 1
            FROM portal_permission_grants permission_grant
            WHERE permission_grant.employee_number = portal_user.employee_number
              AND permission_grant.permission = 'personnel:workflows:read'
          )
        )
        AND (
          portal_user.role IN ('hr','admin')
          OR (
            portal_user.role = 'manager'
            AND run.location_id IS NOT NULL
            AND (
              EXISTS (
                SELECT 1
                FROM portal_access_scopes access_scope
                WHERE access_scope.employee_number = portal_user.employee_number
                  AND access_scope.location_id = run.location_id
                  AND access_scope.department_id = 0
              )
              OR (
                NOT EXISTS (
                  SELECT 1
                  FROM portal_access_scopes any_scope
                  WHERE any_scope.employee_number = portal_user.employee_number
                )
                AND employee.home_location_id = run.location_id
              )
            )
          )
          OR (
            portal_user.role = 'department_manager'
            AND run.location_id IS NOT NULL
            AND run.department_id IS NOT NULL
            AND (
              EXISTS (
                SELECT 1
                FROM portal_access_scopes access_scope
                WHERE access_scope.employee_number = portal_user.employee_number
                  AND access_scope.location_id = run.location_id
                  AND access_scope.department_id = run.department_id
              )
              OR (
                NOT EXISTS (
                  SELECT 1
                  FROM portal_access_scopes any_scope
                  WHERE any_scope.employee_number = portal_user.employee_number
                )
                AND employee.home_location_id = run.location_id
                AND employee.preferred_department_id = run.department_id
              )
            )
          )
        )
        AND (
          portal_user.role IN ('hr','admin')
          OR (
            portal_user.role = 'manager'
            AND EXISTS (
              SELECT 1
              FROM portal_permission_scope_grants permission_scope
              WHERE permission_scope.employee_number = portal_user.employee_number
                AND permission_scope.permission = 'personnel:workflows:read'
                AND permission_scope.location_id = run.location_id
                AND permission_scope.department_id = 0
            )
          )
          OR (
            portal_user.role = 'department_manager'
            AND EXISTS (
              SELECT 1
              FROM portal_permission_scope_grants permission_scope
              WHERE permission_scope.employee_number = portal_user.employee_number
                AND permission_scope.permission = 'personnel:workflows:read'
                AND permission_scope.location_id = run.location_id
                AND permission_scope.department_id = run.department_id
            )
          )
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel workflow task assignment is invalid');
    END;
  `),
  definition("trg_custom_process_run_assignments_immutable_update", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_run_assignments_immutable_update
    BEFORE UPDATE ON custom_process_run_step_assignments
    BEGIN
      SELECT RAISE(ABORT, 'personnel workflow task assignments are immutable');
    END;
  `),
  definition("trg_custom_process_run_assignments_immutable_delete", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_run_assignments_immutable_delete
    BEFORE DELETE ON custom_process_run_step_assignments
    BEGIN
      SELECT RAISE(ABORT, 'personnel workflow task assignments are immutable');
    END;
  `),
  definition("trg_custom_process_runs_personnel_core_immutable", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_runs_personnel_core_immutable
    BEFORE UPDATE OF
      id, process_id, process_revision, trigger_type, trigger_key,
      location_id, department_id, triggered_by, activation_count, created_at
    ON custom_process_runs
    WHEN EXISTS (
      SELECT 1 FROM custom_process_run_bindings binding
      WHERE binding.run_id = OLD.id
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel workflow instance core is immutable');
    END;
  `),
  definition("trg_custom_process_runs_personnel_reopen_forbidden", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_runs_personnel_reopen_forbidden
    BEFORE UPDATE OF status, resolved_at ON custom_process_runs
    WHEN EXISTS (
        SELECT 1 FROM custom_process_run_bindings binding
        WHERE binding.run_id = OLD.id
      )
      AND NOT (
        (NEW.status = OLD.status AND NEW.resolved_at IS OLD.resolved_at)
        OR (
          OLD.status = 'open'
          AND NEW.status = 'resolved'
          AND NEW.resolved_at IS NOT NULL
          AND TRIM(NEW.resolved_at) <> ''
          AND EXISTS (
            SELECT 1
            FROM custom_process_run_steps existing_step
            WHERE existing_step.run_id = OLD.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM custom_process_run_steps unfinished
            WHERE unfinished.run_id = OLD.id
              AND unfinished.status NOT IN ('completed','skipped')
          )
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'personnel workflow instance state transition is invalid');
    END;
  `),
  definition("trg_custom_process_runs_personnel_protected_delete", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_runs_personnel_protected_delete
    BEFORE DELETE ON custom_process_runs
    WHEN EXISTS (
      SELECT 1 FROM custom_process_run_bindings binding
      WHERE binding.run_id = OLD.id
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel workflow instances cannot be deleted');
    END;
  `),
  definition("trg_custom_process_run_steps_personnel_protected_delete", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_run_steps_personnel_protected_delete
    BEFORE DELETE ON custom_process_run_steps
    WHEN EXISTS (
      SELECT 1 FROM custom_process_run_bindings binding
      WHERE binding.run_id = OLD.run_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel workflow instance steps cannot be deleted');
    END;
  `),
  definition("trg_custom_process_run_steps_personnel_relation_insert", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_run_steps_personnel_relation_insert
    BEFORE INSERT ON custom_process_run_steps
    WHEN EXISTS (
      SELECT 1 FROM custom_process_run_bindings binding
      WHERE binding.run_id = NEW.run_id
    )
      AND NOT EXISTS (
        SELECT 1
        FROM custom_process_run_bindings binding
        JOIN custom_process_runs run ON run.id = binding.run_id
        JOIN custom_process_publications publication
          ON publication.id = binding.publication_id
        JOIN json_each(publication.snapshot_json, '$.steps') snapshot_step
          ON json_extract(snapshot_step.value, '$.id') = NEW.step_id
        WHERE binding.run_id = NEW.run_id
          AND run.status = 'open'
          AND CAST(snapshot_step.key AS INTEGER) + 1 = NEW.sort_order
          AND NEW.status = 'pending'
          AND NEW.activated_at IS NULL
          AND NEW.completed_at IS NULL
          AND NEW.completed_by = ''
          AND NEW.completion_note = ''
          AND NEW.completion_request_id = ''
      )
    BEGIN
      SELECT RAISE(ABORT, 'personnel workflow instance step is invalid');
    END;
  `),
  definition("trg_custom_process_run_steps_personnel_core_immutable", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_run_steps_personnel_core_immutable
    BEFORE UPDATE ON custom_process_run_steps
    WHEN EXISTS (
      SELECT 1 FROM custom_process_run_bindings binding
      WHERE binding.run_id = OLD.run_id
    )
      AND NOT (
        NEW.run_id IS OLD.run_id
        AND NEW.step_id IS OLD.step_id
        AND NEW.sort_order IS OLD.sort_order
        AND NEW.created_at IS OLD.created_at
        AND EXISTS (
          SELECT 1
          FROM custom_process_run_bindings binding
          JOIN custom_process_publications publication
            ON publication.id = binding.publication_id
          JOIN json_each(publication.snapshot_json, '$.steps') snapshot_step
            ON json_extract(snapshot_step.value, '$.id') = OLD.step_id
          WHERE binding.run_id = OLD.run_id
            AND CAST(snapshot_step.key AS INTEGER) + 1 = OLD.sort_order
            AND NOT EXISTS (
              SELECT 1
              FROM custom_process_run_steps prior_step
              WHERE prior_step.run_id = OLD.run_id
                AND prior_step.sort_order < OLD.sort_order
                AND prior_step.status NOT IN ('completed','skipped')
            )
            AND (
              (
                OLD.status = 'pending'
                AND NEW.status = 'active'
                AND json_extract(snapshot_step.value, '$.responsibilityType')
                  IN ('role','employee')
                AND NEW.activated_at IS NOT NULL
                AND TRIM(NEW.activated_at) <> ''
                AND NEW.completed_at IS NULL
                AND NEW.completed_by = ''
                AND NEW.completion_note = ''
                AND NEW.completion_request_id = ''
                AND NOT EXISTS (
                  SELECT 1
                  FROM custom_process_run_steps other_active
                  WHERE other_active.run_id = OLD.run_id
                    AND other_active.step_id <> OLD.step_id
                    AND other_active.status = 'active'
                )
                AND EXISTS (
                  SELECT 1
                  FROM custom_process_run_step_assignments assignment
                  WHERE assignment.run_id = OLD.run_id
                    AND assignment.step_id = OLD.step_id
                )
              )
              OR (
                OLD.status = 'pending'
                AND NEW.status = 'completed'
                AND json_extract(snapshot_step.value, '$.responsibilityType') = 'system'
                AND NEW.activated_at IS NOT NULL
                AND TRIM(NEW.activated_at) <> ''
                AND NEW.completed_at IS NOT NULL
                AND TRIM(NEW.completed_at) <> ''
                AND NEW.completed_by = 'system'
                AND NEW.completion_note = ''
                AND NEW.completion_request_id = ''
                AND NOT EXISTS (
                  SELECT 1
                  FROM custom_process_run_steps other_active
                  WHERE other_active.run_id = OLD.run_id
                    AND other_active.status = 'active'
                )
              )
              OR (
                OLD.status = 'active'
                AND NEW.status IN ('completed','skipped')
                AND json_extract(snapshot_step.value, '$.responsibilityType')
                  IN ('role','employee')
                AND NEW.activated_at IS OLD.activated_at
                AND NEW.completed_at IS NOT NULL
                AND TRIM(NEW.completed_at) <> ''
                AND NEW.completion_note = ''
                AND length(NEW.completion_request_id) = 64
                AND NEW.completion_request_id = lower(NEW.completion_request_id)
                AND NEW.completion_request_id NOT GLOB '*[^0-9a-f]*'
                AND (
                  NEW.status <> 'skipped'
                  OR COALESCE(
                    json_extract(snapshot_step.value, '$.conditionType'),
                    'always'
                  ) <> 'always'
                )
                AND EXISTS (
                  SELECT 1
                  FROM custom_process_run_step_assignments assignment
                  WHERE assignment.run_id = OLD.run_id
                    AND assignment.step_id = OLD.step_id
                    AND assignment.employee_number = NEW.completed_by
                )
              )
            )
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'personnel workflow instance step transition is invalid');
    END;
  `),
]);

const PERSONNEL_WORKFLOW_INSTANCE_LIFECYCLE_TRIGGER_DEFINITION = definition(
  "trg_custom_process_run_bindings_lifecycle_onboarding_insert",
  `
    CREATE TRIGGER IF NOT EXISTS
      trg_custom_process_run_bindings_lifecycle_onboarding_insert
    BEFORE INSERT ON custom_process_run_bindings
    WHEN NEW.subject_type = 'employee'
      AND EXISTS (
        SELECT 1
        FROM custom_process_publications publication
        WHERE publication.id = NEW.publication_id
          AND publication.workflow_type = 'onboarding'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM custom_process_runs run
        JOIN custom_process_publications publication
          ON publication.id = NEW.publication_id
        JOIN personnel_lifecycle_case_package_runs package_run
          ON package_run.run_id = NEW.run_id
        JOIN personnel_lifecycle_case_package_bindings package_binding
          ON package_binding.id = package_run.package_binding_id
        JOIN personnel_lifecycle_cases lifecycle_case
          ON lifecycle_case.id = package_binding.case_id
        JOIN personnel_employment_episodes employment_episode
          ON employment_episode.id = lifecycle_case.employment_episode_id
        WHERE run.id = NEW.run_id
          AND publication.workflow_type = 'onboarding'
          AND package_run.run_operation_id = NEW.operation_id
          AND package_binding.publication_id = NEW.publication_id
          AND package_binding.version_number = publication.version_number
          AND lifecycle_case.case_type = 'onboarding'
          AND lifecycle_case.state = 'approved'
          AND lifecycle_case.location_id IS run.location_id
          AND lifecycle_case.department_id IS run.department_id
          AND employment_episode.employee_number = NEW.employee_number
          AND employment_episode.state = 'employment_active'
      )
    BEGIN
      SELECT RAISE(ABORT, 'personnel workflow lifecycle binding is invalid');
    END;
  `,
);

const PERSONNEL_WORKFLOW_INSTANCE_ALL_TRIGGER_DEFINITIONS = Object.freeze([
  ...PERSONNEL_WORKFLOW_INSTANCE_BASE_TRIGGER_DEFINITIONS,
  PERSONNEL_WORKFLOW_INSTANCE_LIFECYCLE_TRIGGER_DEFINITION,
]);
const PERSONNEL_WORKFLOW_INSTANCE_TRIGGER_DEFINITIONS =
  PERSONNEL_WORKFLOW_INSTANCE_ALL_TRIGGER_DEFINITIONS;

const PERSONNEL_WORKFLOW_INSTANCE_TRIGGER_NAMES = Object.freeze(
  PERSONNEL_WORKFLOW_INSTANCE_ALL_TRIGGER_DEFINITIONS.map(({ name }) => name),
);

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
  return { missing: Object.freeze(missing), invalid: Object.freeze(invalid) };
}

function inspectSqlitePersonnelWorkflowInstanceSchema(database) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Inspektionsdatenbank wird benoetigt.");
  }
  const tables = inspectDefinitions(
    database,
    "table",
    PERSONNEL_WORKFLOW_INSTANCE_TABLE_DEFINITIONS,
  );
  const lifecycleTablesAvailable = lifecycleRelationTablesAvailable(database);
  const expectedTriggerDefinitions = lifecycleTablesAvailable
    ? PERSONNEL_WORKFLOW_INSTANCE_ALL_TRIGGER_DEFINITIONS
    : PERSONNEL_WORKFLOW_INSTANCE_BASE_TRIGGER_DEFINITIONS;
  const triggers = inspectDefinitions(
    database,
    "trigger",
    expectedTriggerDefinitions,
  );
  const unexpectedLifecycleTrigger = !lifecycleTablesAvailable
    && Boolean(database.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'trigger' AND name = ? LIMIT 1
    `).get(PERSONNEL_WORKFLOW_INSTANCE_LIFECYCLE_TRIGGER_DEFINITION.name));
  const invalidTriggers = Object.freeze([
    ...triggers.invalid,
    ...(unexpectedLifecycleTrigger
      ? [PERSONNEL_WORKFLOW_INSTANCE_LIFECYCLE_TRIGGER_DEFINITION.name]
      : []),
  ]);
  const issues = Object.freeze([
    ...tables.missing.map((name) => `table-missing:${name}`),
    ...tables.invalid.map((name) => `table-invalid:${name}`),
    ...triggers.missing.map((name) => `trigger-missing:${name}`),
    ...triggers.invalid.map((name) => `trigger-invalid:${name}`),
    ...(unexpectedLifecycleTrigger
      ? [`trigger-unexpected:${PERSONNEL_WORKFLOW_INSTANCE_LIFECYCLE_TRIGGER_DEFINITION.name}`]
      : []),
  ]);
  return Object.freeze({
    valid: issues.length === 0,
    absent: tables.missing.length === PERSONNEL_WORKFLOW_INSTANCE_TABLE_DEFINITIONS.length
      && triggers.missing.length === expectedTriggerDefinitions.length,
    issues,
    missingTables: tables.missing,
    invalidTables: tables.invalid,
    missingTriggers: triggers.missing,
    invalidTriggers,
  });
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function safeSnapshot(value) {
  try {
    const snapshot = JSON.parse(String(value || ""));
    return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
      ? snapshot
      : null;
  } catch {
    return null;
  }
}

const PERSONNEL_WORKFLOW_INSTANCE_REQUIRED_TABLES = Object.freeze([
  "custom_process_runs",
  "custom_process_run_steps",
  "custom_process_publications",
  "custom_process_publication_archives",
  "candidates",
  "candidate_applications",
  "employees",
  "locations",
  "departments",
  "portal_users",
  "portal_roles",
  "portal_access_scopes",
  "portal_permission_grants",
  "portal_permission_denials",
  "portal_permission_scope_grants",
]);

function sqliteTableExists(database, name) {
  return Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1
  `).get(name));
}

function lifecycleRelationTablesAvailable(database) {
  return [
    "personnel_lifecycle_case_package_runs",
    "personnel_lifecycle_case_package_bindings",
    "personnel_lifecycle_cases",
    "personnel_employment_episodes",
  ].every((name) => sqliteTableExists(database, name));
}

function sqliteTableHasColumn(database, tableName, columnName) {
  if (!sqliteTableExists(database, tableName)) return false;
  return database.prepare(`PRAGMA table_info("${tableName}")`).all()
    .some(({ name }) => name === columnName);
}

function orphanPersonnelRunIds(database) {
  if (!sqliteTableHasColumn(database, "custom_process_runs", "trigger_type")) return [];
  const bindingExists = sqliteTableHasColumn(
    database,
    "custom_process_run_bindings",
    "run_id",
  );
  const onboardingRunTableExists = sqliteTableHasColumn(
    database,
    "personnel_lifecycle_case_package_runs",
    "run_id",
  );
  const offboardingRunTableExists = sqliteTableHasColumn(
    database,
    "personnel_lifecycle_offboarding_package_runs",
    "run_id",
  );
  const joins = [
    bindingExists
      ? "LEFT JOIN custom_process_run_bindings binding ON binding.run_id = run.id"
      : "",
    onboardingRunTableExists
      ? `LEFT JOIN personnel_lifecycle_case_package_runs onboarding_run
          ON onboarding_run.run_id = run.id`
      : "",
    offboardingRunTableExists
      ? `LEFT JOIN personnel_lifecycle_offboarding_package_runs offboarding_run
          ON offboarding_run.run_id = run.id`
      : "",
  ].filter(Boolean).join("\n      ");
  const exclusions = [
    bindingExists ? "binding.run_id IS NULL" : "",
    onboardingRunTableExists ? "onboarding_run.run_id IS NULL" : "",
    offboardingRunTableExists ? "offboarding_run.run_id IS NULL" : "",
  ].filter(Boolean);
  const rows = database.prepare(`
    SELECT run.id
    FROM custom_process_runs run
    ${joins}
    WHERE run.trigger_type = 'personnel_manual'
      ${exclusions.map((condition) => `AND ${condition}`).join("\n      ")}
    ORDER BY run.id
  `).all();
  return rows.map(({ id }) => String(id));
}

function normalizedAssignmentReceiptRow(row) {
  return {
    run_id: row.run_id,
    step_id: row.step_id,
    employee_number: row.employee_number,
    responsibility_type: row.responsibility_type,
    responsibility_reference: row.responsibility_reference,
    assigned_by: row.assigned_by,
    assigned_at: row.assigned_at,
  };
}

function nonEmptyDatabaseText(value) {
  return typeof value === "string" && Boolean(value.trim());
}

function inspectPersonnelRunState(row, snapshot, runSteps, assignments, issues) {
  if (!Array.isArray(snapshot?.steps)) return;
  const runStepById = new Map(runSteps.map((step) => [step.step_id, step]));
  const assignmentByStep = new Map(assignments.map((assignment) => [
    assignment.step_id,
    assignment,
  ]));
  let firstUnfinishedSeen = false;
  let activeCount = 0;
  let stateSequenceValid = runSteps.length === snapshot.steps.length;
  for (const snapshotStep of snapshot.steps) {
    const stepId = String(snapshotStep?.id || "");
    const runStep = runStepById.get(stepId);
    if (!runStep) {
      stateSequenceValid = false;
      continue;
    }
    const finished = ["completed", "skipped"].includes(runStep.status);
    if (finished && firstUnfinishedSeen) stateSequenceValid = false;
    if (!finished) {
      if (!firstUnfinishedSeen) {
        firstUnfinishedSeen = true;
        if (runStep.status !== "active") stateSequenceValid = false;
      } else if (runStep.status !== "pending") {
        stateSequenceValid = false;
      }
    }
    if (runStep.status === "active") activeCount += 1;
    const assignment = assignmentByStep.get(stepId);
    const responsibilityType = String(snapshotStep?.responsibilityType || "");
    const conditionType = String(snapshotStep?.conditionType || "always");
    const completionFieldsEmpty = runStep.completed_at === null
      && runStep.completed_by === ""
      && runStep.completion_note === ""
      && runStep.completion_request_id === "";
    if (runStep.status === "pending") {
      if (runStep.activated_at !== null || !completionFieldsEmpty) {
        issues.push(`pending-step-state:${row.run_id}:${stepId}`);
      }
    } else if (runStep.status === "active") {
      if (responsibilityType === "system"
        || !assignment
        || !nonEmptyDatabaseText(runStep.activated_at)
        || !completionFieldsEmpty) {
        issues.push(`active-step-state:${row.run_id}:${stepId}`);
      }
    } else if (runStep.status === "completed") {
      if (!nonEmptyDatabaseText(runStep.activated_at)
        || !nonEmptyDatabaseText(runStep.completed_at)
        || runStep.completion_note !== "") {
        issues.push(`completed-step-state:${row.run_id}:${stepId}`);
      } else if (responsibilityType === "system") {
        if (assignment || runStep.completed_by !== "system"
          || runStep.completion_request_id !== "") {
          issues.push(`system-completion-state:${row.run_id}:${stepId}`);
        }
      } else if (!assignment
        || runStep.completed_by !== assignment.employee_number
        || !/^[0-9a-f]{64}$/.test(String(runStep.completion_request_id || ""))) {
        issues.push(`task-completion-state:${row.run_id}:${stepId}`);
      }
    } else if (runStep.status === "skipped") {
      if (responsibilityType === "system"
        || conditionType === "always"
        || !assignment
        || runStep.completed_by !== assignment.employee_number
        || !nonEmptyDatabaseText(runStep.activated_at)
        || !nonEmptyDatabaseText(runStep.completed_at)
        || runStep.completion_note !== ""
        || !/^[0-9a-f]{64}$/.test(String(runStep.completion_request_id || ""))) {
        issues.push(`skipped-step-state:${row.run_id}:${stepId}`);
      }
    } else {
      stateSequenceValid = false;
    }
  }
  if (!stateSequenceValid || activeCount > 1) {
    issues.push(`run-step-sequence:${row.run_id}`);
  }
  if (row.status === "open") {
    if (activeCount !== 1 || nonEmptyDatabaseText(row.resolved_at)) {
      issues.push(`open-run-state:${row.run_id}`);
    }
  } else if (row.status === "resolved") {
    if (firstUnfinishedSeen || activeCount !== 0 || !nonEmptyDatabaseText(row.resolved_at)) {
      issues.push(`resolved-run-state:${row.run_id}`);
    }
  } else {
    issues.push(`run-status:${row.run_id}`);
  }
}

function inspectSqlitePersonnelWorkflowInstanceRows(database) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Inspektionsdatenbank wird benoetigt.");
  }
  const schema = inspectSqlitePersonnelWorkflowInstanceSchema(database);
  if (schema.absent) {
    const issues = Object.freeze(orphanPersonnelRunIds(database)
      .map((runId) => `orphan-personnel-run:${runId}`));
    return Object.freeze({
      valid: issues.length === 0,
      absent: true,
      issues,
    });
  }
  if (!schema.valid) {
    const orphanIssues = orphanPersonnelRunIds(database)
      .map((runId) => `orphan-personnel-run:${runId}`);
    return Object.freeze({
      valid: false,
      absent: false,
      issues: Object.freeze(["schema-invalid", ...orphanIssues]),
    });
  }
  const missingDependencies = PERSONNEL_WORKFLOW_INSTANCE_REQUIRED_TABLES
    .filter((name) => !sqliteTableExists(database, name));
  if (missingDependencies.length) {
    return Object.freeze({
      valid: false,
      absent: false,
      issues: Object.freeze(missingDependencies
        .map((name) => `dependency-missing:${name}`)),
    });
  }
  const lifecycleTablesAvailable = lifecycleRelationTablesAvailable(database);
  const lifecycleRelationSelect = lifecycleTablesAvailable
    ? `,
      package_run.package_binding_id AS lifecycle_package_binding_id,
      package_run.run_operation_id AS lifecycle_run_operation_id,
      package_binding.publication_id AS lifecycle_publication_id,
      package_binding.version_number AS lifecycle_version_number,
      lifecycle_case.case_type AS lifecycle_case_type,
      lifecycle_case.state AS lifecycle_case_state,
      lifecycle_case.location_id AS lifecycle_case_location_id,
      lifecycle_case.department_id AS lifecycle_case_department_id,
      employment_episode.employee_number AS lifecycle_employee_number,
      employment_episode.state AS lifecycle_episode_state`
    : `,
      NULL AS lifecycle_package_binding_id,
      NULL AS lifecycle_run_operation_id,
      NULL AS lifecycle_publication_id,
      NULL AS lifecycle_version_number,
      NULL AS lifecycle_case_type,
      NULL AS lifecycle_case_state,
      NULL AS lifecycle_case_location_id,
      NULL AS lifecycle_case_department_id,
      NULL AS lifecycle_employee_number,
      NULL AS lifecycle_episode_state`;
  const lifecycleRelationJoins = lifecycleTablesAvailable
    ? `
    LEFT JOIN personnel_lifecycle_case_package_runs package_run
      ON package_run.run_id = binding.run_id
    LEFT JOIN personnel_lifecycle_case_package_bindings package_binding
      ON package_binding.id = package_run.package_binding_id
    LEFT JOIN personnel_lifecycle_cases lifecycle_case
      ON lifecycle_case.id = package_binding.case_id
    LEFT JOIN personnel_employment_episodes employment_episode
      ON employment_episode.id = lifecycle_case.employment_episode_id`
    : "";
  const rows = database.prepare(`
    SELECT binding.*,
      run.process_id, run.process_revision, run.trigger_type, run.trigger_key, run.status,
      run.resolved_at,
      run.location_id, run.department_id, run.triggered_by, run.activation_count,
      publication.process_id AS publication_process_id,
      publication.source_revision AS publication_source_revision,
      publication.version_number, publication.workflow_type, publication.data_classification,
      publication.scope_type, publication.location_id AS publication_location_id,
      publication.department_id AS publication_department_id,
      publication.snapshot_json,
      candidate.id AS related_candidate_id,
      application.id AS related_application_id,
      employee.personnel_number AS related_employee_number
      ${lifecycleRelationSelect}
    FROM custom_process_run_bindings binding
    LEFT JOIN custom_process_runs run ON run.id = binding.run_id
    LEFT JOIN custom_process_publications publication
      ON publication.id = binding.publication_id
    LEFT JOIN candidates candidate ON candidate.id = binding.candidate_id
    LEFT JOIN candidate_applications application
      ON application.id = binding.application_id
      AND application.candidate_id = binding.candidate_id
    LEFT JOIN employees employee
      ON employee.personnel_number = binding.employee_number
    ${lifecycleRelationJoins}
    ORDER BY binding.started_at, binding.run_id
  `).all();
  const issues = [];
  const readSteps = database.prepare(`
    SELECT * FROM custom_process_run_steps
    WHERE run_id = ? ORDER BY sort_order, step_id
  `);
  const readAssignments = database.prepare(`
    SELECT * FROM custom_process_run_step_assignments
    WHERE run_id = ? ORDER BY step_id
  `);
  const orphanRunIds = orphanPersonnelRunIds(database);
  for (const runId of orphanRunIds) issues.push(`orphan-personnel-run:${runId}`);
  const orphanAssignments = database.prepare(`
    SELECT assignment.run_id, assignment.step_id
    FROM custom_process_run_step_assignments assignment
    LEFT JOIN custom_process_run_bindings binding
      ON binding.run_id = assignment.run_id
    LEFT JOIN custom_process_run_steps run_step
      ON run_step.run_id = assignment.run_id
      AND run_step.step_id = assignment.step_id
    LEFT JOIN employees employee
      ON employee.personnel_number = assignment.employee_number
    WHERE binding.run_id IS NULL
      OR run_step.run_id IS NULL
      OR employee.personnel_number IS NULL
    ORDER BY assignment.run_id, assignment.step_id
  `).all();
  for (const assignment of orphanAssignments) {
    issues.push(`orphan-assignment:${assignment.run_id}:${assignment.step_id}`);
  }
  for (const row of rows) {
    const snapshot = safeSnapshot(row.snapshot_json);
    const candidateValid = row.subject_type === "candidate"
      && row.related_candidate_id === row.candidate_id
      && row.related_application_id === row.application_id
      && Number.isSafeInteger(Number(row.candidate_revision))
      && Number(row.candidate_revision) >= 1
      && Number.isSafeInteger(Number(row.application_revision))
      && Number(row.application_revision) >= 1
      && ["application", "preboarding"].includes(row.workflow_type);
    const legacyEmployeeValid = row.subject_type === "employee"
      && row.related_employee_number === row.employee_number
      && row.candidate_revision === null
      && row.application_revision === null
      && [
        "training", "position_change", "department_change", "location_change",
        "return_from_absence",
      ].includes(row.workflow_type);
    const lifecycleOnboardingValid = lifecycleTablesAvailable
      && row.subject_type === "employee"
      && row.related_employee_number === row.employee_number
      && row.candidate_id === null
      && row.application_id === null
      && row.candidate_revision === null
      && row.application_revision === null
      && row.workflow_type === "onboarding"
      && nonEmptyDatabaseText(row.lifecycle_package_binding_id)
      && row.lifecycle_run_operation_id === row.operation_id
      && row.lifecycle_publication_id === row.publication_id
      && Number(row.lifecycle_version_number) === Number(row.version_number)
      && row.lifecycle_case_type === "onboarding"
      && ["active", "completed", "cancelled"].includes(row.lifecycle_case_state)
      && (row.lifecycle_case_location_id ?? null) === (row.location_id ?? null)
      && Number(row.lifecycle_case_department_id || 0) === Number(row.department_id || 0)
      && row.lifecycle_employee_number === row.employee_number
      && ["employment_active", "exit_in_progress", "employment_ended"]
        .includes(row.lifecycle_episode_state);
    const notificationChannelsValid = Array.isArray(snapshot?.steps)
      && snapshot.steps.every((step) => (
        step?.notificationChannels === undefined
        || (Array.isArray(step.notificationChannels)
          && step.notificationChannels.length === 0)
      ));
    const scopeValid = row.scope_type === "company"
      || (row.scope_type === "location"
        && row.publication_location_id === row.location_id)
      || (row.scope_type === "department"
        && row.publication_location_id === row.location_id
        && Number(row.publication_department_id || 0) === Number(row.department_id || 0));
    const relationValid = snapshot
      && row.process_id === row.publication_process_id
      && Number(row.process_revision) === Number(row.publication_source_revision)
      && snapshot.id === row.process_id
      && Number(snapshot.revision) === Number(row.process_revision)
      && Array.isArray(snapshot.steps)
      && row.trigger_type === "personnel_manual"
      && row.trigger_key === `personnel:${row.operation_id}`
      && row.triggered_by === row.started_by
      && Number(row.activation_count) === 1
      && row.data_classification === "standard"
      && notificationChannelsValid
      && scopeValid
      && (candidateValid || legacyEmployeeValid || lifecycleOnboardingValid);
    if (!relationValid) issues.push(`binding-relation:${row.run_id}`);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(String(row.operation_id || ""))) {
      issues.push(`operation-id:${row.run_id}`);
    }
    if (!/^[0-9a-f]{64}$/.test(String(row.request_sha256 || ""))) {
      issues.push(`request-hash:${row.run_id}`);
    }
    if (sha256(JSON.stringify(personnelWorkflowInstanceReceiptBody(row)))
      !== row.receipt_sha256) {
      issues.push(`binding-receipt:${row.run_id}`);
    }
    if (!Array.isArray(snapshot?.steps)) continue;
    const runSteps = readSteps.all(row.run_id);
    const assignments = readAssignments.all(row.run_id);
    const runStepById = new Map(runSteps.map((step) => [step.step_id, step]));
    const assignmentByStep = new Map(assignments.map((assignment) => [
      assignment.step_id,
      assignment,
    ]));
    const snapshotStepIds = new Set();
    inspectPersonnelRunState(row, snapshot, runSteps, assignments, issues);
    for (const [index, step] of snapshot.steps.entries()) {
      const stepId = String(step?.id || "");
      if (!stepId || snapshotStepIds.has(stepId)) {
        issues.push(`snapshot-step:${row.run_id}`);
        continue;
      }
      snapshotStepIds.add(stepId);
      const runStep = runStepById.get(stepId);
      if (!runStep || Number(runStep.sort_order) !== index + 1) {
        issues.push(`run-step:${row.run_id}:${stepId}`);
      }
      const assignment = assignmentByStep.get(stepId);
      if (step.responsibilityType === "system") {
        if (assignment) issues.push(`system-assignment:${row.run_id}:${stepId}`);
        if (runStep?.status === "completed" && runStep.completed_by !== "system") {
          issues.push(`system-completion:${row.run_id}:${stepId}`);
        }
        continue;
      }
      if (!assignment
        || assignment.responsibility_type !== step.responsibilityType
        || assignment.responsibility_reference !== step.responsibilityReference) {
        issues.push(`task-assignment:${row.run_id}:${stepId}`);
        continue;
      }
      if (assignment.assigned_by !== row.started_by
        || assignment.assigned_at !== row.started_at) {
        issues.push(`assignment-origin:${row.run_id}:${stepId}`);
      }
      if (assignment.responsibility_type === "employee"
        && assignment.employee_number !== assignment.responsibility_reference) {
        issues.push(`employee-assignment:${row.run_id}:${stepId}`);
      }
      if (sha256(JSON.stringify(personnelWorkflowTaskAssignmentReceiptBody(
        normalizedAssignmentReceiptRow(assignment),
      ))) !== assignment.receipt_sha256) {
        issues.push(`assignment-receipt:${row.run_id}:${stepId}`);
      }
      if (["completed", "skipped"].includes(runStep?.status)
        && runStep.completed_by !== assignment.employee_number) {
        issues.push(`task-completion:${row.run_id}:${stepId}`);
      }
    }
    if (runSteps.some((step) => !snapshotStepIds.has(step.step_id))) {
      issues.push(`unexpected-run-step:${row.run_id}`);
    }
    if (assignments.some((assignment) => !snapshotStepIds.has(assignment.step_id))) {
      issues.push(`unexpected-assignment:${row.run_id}`);
    }
  }
  return Object.freeze({
    valid: issues.length === 0,
    absent: false,
    issues: Object.freeze(issues),
  });
}

function ensureSqlitePersonnelWorkflowInstanceSchema(database) {
  if (!database || typeof database.exec !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benoetigt.");
  }
  for (const item of PERSONNEL_WORKFLOW_INSTANCE_TABLE_DEFINITIONS) {
    database.exec(item.sql);
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_custom_process_run_bindings_publication
      ON custom_process_run_bindings(publication_id, started_at, run_id);
    CREATE INDEX IF NOT EXISTS idx_custom_process_run_bindings_candidate
      ON custom_process_run_bindings(candidate_id, application_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_custom_process_run_bindings_employee
      ON custom_process_run_bindings(employee_number, started_at);
    CREATE INDEX IF NOT EXISTS idx_custom_process_run_assignments_employee
      ON custom_process_run_step_assignments(employee_number, assigned_at, run_id);
  `);
  for (const item of PERSONNEL_WORKFLOW_INSTANCE_BASE_TRIGGER_DEFINITIONS) {
    database.exec(item.sql);
  }
  if (lifecycleRelationTablesAvailable(database)) {
    database.exec(PERSONNEL_WORKFLOW_INSTANCE_LIFECYCLE_TRIGGER_DEFINITION.sql);
  } else {
    database.exec(
      `DROP TRIGGER IF EXISTS "${PERSONNEL_WORKFLOW_INSTANCE_LIFECYCLE_TRIGGER_DEFINITION.name}"`,
    );
  }
}

module.exports = {
  PERSONNEL_WORKFLOW_INSTANCE_MIGRATION_ID,
  PERSONNEL_WORKFLOW_INSTANCE_TABLE_DEFINITIONS,
  PERSONNEL_WORKFLOW_INSTANCE_TABLE_NAMES,
  PERSONNEL_WORKFLOW_INSTANCE_ALL_TRIGGER_DEFINITIONS,
  PERSONNEL_WORKFLOW_INSTANCE_LIFECYCLE_TRIGGER_DEFINITION,
  PERSONNEL_WORKFLOW_INSTANCE_TRIGGER_DEFINITIONS,
  PERSONNEL_WORKFLOW_INSTANCE_TRIGGER_NAMES,
  ensureSqlitePersonnelWorkflowInstanceSchema,
  inspectSqlitePersonnelWorkflowInstanceRows,
  inspectSqlitePersonnelWorkflowInstanceSchema,
};
