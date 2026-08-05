"use strict";

const {
  PERSONNEL_LIFECYCLE_CASE_TABLE_DEFINITIONS,
  PERSONNEL_LIFECYCLE_CASE_TABLE_NAMES,
} = require("./personnel-lifecycle-case-schema");
const {
  PERSONNEL_LIFECYCLE_ONBOARDING_INDEX_DEFINITIONS,
  PERSONNEL_LIFECYCLE_ONBOARDING_TABLE_DEFINITIONS,
  PERSONNEL_LIFECYCLE_ONBOARDING_TABLE_NAMES,
  PERSONNEL_LIFECYCLE_ONBOARDING_TRIGGER_DEFINITIONS,
  inspectSqlitePersonnelLifecycleOnboardingRows,
} = require("./personnel-lifecycle-onboarding-schema");
const {
  canonicalSha256,
  deterministicUuidV4,
  personnelLifecycleOffboardingAssignmentBindingReceiptSha256,
  personnelLifecycleOffboardingAssignmentReceiptSha256,
  personnelLifecycleOffboardingCaseEventReceiptSha256,
  personnelLifecycleOffboardingConfidentialAccessReceiptSha256,
  personnelLifecycleOffboardingOperationReceiptSha256,
  personnelLifecycleOffboardingPackageBindingReceiptSha256,
  personnelLifecycleOffboardingPackageRunReceiptSha256,
  personnelLifecycleOffboardingPackageVersionReceiptSha256,
  personnelLifecycleOffboardingPackageVersionArchiveReceiptSha256,
  personnelLifecycleOffboardingReferenceDatesReceiptSha256,
  personnelLifecycleOffboardingRunTerminationReceiptSha256,
  personnelLifecycleOffboardingRuntimeStepReceiptSha256,
  personnelLifecycleOffboardingScopeSnapshotSha256,
} = require("../../../personnel-lifecycle-offboarding-receipt");
const {
  PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS,
  PERSONNEL_LIFECYCLE_OFFBOARDING_REQUIRED_PACKAGE_FAMILIES,
} = require("../../../personnel-lifecycle-offboarding-contract");

const PERSONNEL_LIFECYCLE_OFFBOARDING_MIGRATION_ID =
  "v0.93-personnel-lifecycle-offboarding-execution";

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

function protectedPayload(column) {
  return `${column} TEXT NOT NULL CHECK(${column} LIKE 'enc:v2:%')`;
}

const OFFBOARDING_FAMILY_SQL = PERSONNEL_LIFECYCLE_OFFBOARDING_REQUIRED_PACKAGE_FAMILIES
  .map((value) => `'${value}'`).join(",");
const OFFBOARDING_RUNTIME_MANIFEST_SHA256_BY_FAMILY = new Map(
  PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS.map((definitionValue) => [
    definitionValue.familyCode,
    canonicalSha256({
      stepId: definitionValue.stepId,
      orderId: definitionValue.orderId,
    }),
  ]),
);
const OFFBOARDING_RUNTIME_MANIFEST_FOR_FAMILY_SQL =
  PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS
    .map(({ familyCode }) => (
      `WHEN '${familyCode}' THEN '${OFFBOARDING_RUNTIME_MANIFEST_SHA256_BY_FAMILY.get(familyCode)}'`
    ))
    .join(" ");
const OFFBOARDING_STEP_FOR_FAMILY_SQL = PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS
  .map(({ familyCode, stepId }) => `WHEN '${familyCode}' THEN '${stepId}'`)
  .join(" ");
const OFFBOARDING_ORDER_FOR_FAMILY_SQL = PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS
  .map(({ familyCode, orderId }) => `WHEN '${familyCode}' THEN '${orderId}'`)
  .join(" ");
const OFFBOARDING_RECIPIENT_FOR_FAMILY_SQL = PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS
  .map(({ familyCode, recipientClass }) => `WHEN '${familyCode}' THEN '${recipientClass}'`)
  .join(" ");
const OFFBOARDING_EVENT_TYPE_BY_OPERATION = Object.freeze({
  prepare: "offboarding_internally_prepared",
  time_critical_approval: "offboarding_time_critical_approved",
  communication_release: "offboarding_communication_released",
  information_confirmation: "offboarding_employee_informed",
  activation: "offboarding_activated",
  task_complete: "offboarding_task_completed",
  cancellation: "offboarding_cancelled",
  close: "offboarding_completed",
});

const PERSONNEL_LIFECYCLE_OFFBOARDING_TABLE_DEFINITIONS = Object.freeze([
  definition("personnel_lifecycle_offboarding_package_versions", `
    CREATE TABLE IF NOT EXISTS personnel_lifecycle_offboarding_package_versions (
      ${uuidV4Column("id")} PRIMARY KEY,
      ${uuidV4Column("series_id")},
      runtime_process_id TEXT NOT NULL CHECK(TRIM(runtime_process_id) <> ''),
      version_number INTEGER NOT NULL CHECK(version_number >= 1),
      predecessor_version_id TEXT UNIQUE,
      family_code TEXT NOT NULL CHECK(family_code IN (${OFFBOARDING_FAMILY_SQL})),
      path_kind TEXT NOT NULL CHECK(path_kind IN ('standard','time_critical','both')),
      requirement_kind TEXT NOT NULL CHECK(requirement_kind IN ('mandatory','supplemental')),
      scope_type TEXT NOT NULL CHECK(scope_type IN ('company','location','department')),
      location_id TEXT,
      department_id INTEGER,
      data_classification TEXT NOT NULL
        CHECK(data_classification = 'offboarding_strict_confidential'),
      ${protectedPayload("protected_snapshot")},
      ${sha256Column("snapshot_sha256")},
      ${sha256Column("runtime_manifest_sha256")},
      ${sha256Column("receipt_sha256")},
      published_by TEXT NOT NULL CHECK(TRIM(published_by) <> ''),
      published_at TEXT NOT NULL CHECK(TRIM(published_at) <> ''),
      UNIQUE(series_id, version_number),
      CHECK(predecessor_version_id IS NULL OR predecessor_version_id <> id),
      CHECK(
        (scope_type = 'company' AND location_id IS NULL AND department_id IS NULL)
        OR (scope_type = 'location' AND location_id IS NOT NULL AND department_id IS NULL)
        OR (scope_type = 'department' AND location_id IS NOT NULL AND department_id IS NOT NULL)
      ),
      CHECK(requirement_kind <> 'mandatory' OR scope_type = 'company'),
      FOREIGN KEY (runtime_process_id) REFERENCES custom_processes(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (predecessor_version_id)
        REFERENCES personnel_lifecycle_offboarding_package_versions(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (department_id) REFERENCES departments(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );
  `),
  definition("personnel_lifecycle_offboarding_package_version_archives", `
    CREATE TABLE IF NOT EXISTS personnel_lifecycle_offboarding_package_version_archives (
      package_version_id TEXT PRIMARY KEY,
      reason_code TEXT NOT NULL CHECK(length(TRIM(reason_code)) BETWEEN 3 AND 80),
      ${protectedPayload("protected_payload")},
      ${sha256Column("receipt_sha256")},
      archived_by TEXT NOT NULL CHECK(TRIM(archived_by) <> ''),
      archived_at TEXT NOT NULL CHECK(TRIM(archived_at) <> ''),
      FOREIGN KEY (package_version_id)
        REFERENCES personnel_lifecycle_offboarding_package_versions(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );
  `),
  definition("personnel_lifecycle_offboarding_operations", `
    CREATE TABLE IF NOT EXISTS personnel_lifecycle_offboarding_operations (
      ${uuidV4Column("operation_id")} PRIMARY KEY,
      case_id TEXT NOT NULL,
      operation_type TEXT NOT NULL CHECK(operation_type IN (
        'prepare','time_critical_approval','communication_release',
        'information_confirmation','activation','task_complete','cancellation','close'
      )),
      subject_key TEXT NOT NULL CHECK(length(TRIM(subject_key)) BETWEEN 1 AND 200),
      ${sha256Column("request_sha256")},
      ${sha256Column("plan_receipt_sha256")},
      ${protectedPayload("protected_result_payload")},
      ${sha256Column("result_receipt_sha256")},
      actor_id TEXT NOT NULL CHECK(TRIM(actor_id) <> ''),
      occurred_at TEXT NOT NULL CHECK(TRIM(occurred_at) <> ''),
      CHECK(operation_type <> 'task_complete' OR instr(subject_key, ':') > 1),
      FOREIGN KEY (case_id) REFERENCES personnel_lifecycle_cases(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );
  `),
  definition("personnel_lifecycle_offboarding_package_bindings", `
    CREATE TABLE IF NOT EXISTS personnel_lifecycle_offboarding_package_bindings (
      ${uuidV4Column("id")} PRIMARY KEY,
      case_id TEXT NOT NULL,
      package_version_id TEXT NOT NULL,
      version_number INTEGER NOT NULL CHECK(version_number >= 1),
      ${sha256Column("scope_snapshot_sha256")},
      ${sha256Column("receipt_sha256")},
      bound_by TEXT NOT NULL CHECK(TRIM(bound_by) <> ''),
      bound_at TEXT NOT NULL CHECK(TRIM(bound_at) <> ''),
      UNIQUE(case_id, package_version_id),
      FOREIGN KEY (case_id) REFERENCES personnel_lifecycle_cases(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (package_version_id)
        REFERENCES personnel_lifecycle_offboarding_package_versions(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );
  `),
  definition("personnel_lifecycle_offboarding_package_runs", `
    CREATE TABLE IF NOT EXISTS personnel_lifecycle_offboarding_package_runs (
      package_binding_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE,
      ${uuidV4Column("run_operation_id")} UNIQUE,
      ${sha256Column("runtime_manifest_sha256")},
      ${sha256Column("scope_snapshot_sha256")},
      ${sha256Column("receipt_sha256")},
      linked_by TEXT NOT NULL CHECK(TRIM(linked_by) <> ''),
      linked_at TEXT NOT NULL CHECK(TRIM(linked_at) <> ''),
      UNIQUE(package_binding_id, run_id),
      FOREIGN KEY (package_binding_id)
        REFERENCES personnel_lifecycle_offboarding_package_bindings(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (run_id) REFERENCES custom_process_runs(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );
  `),
  definition("personnel_lifecycle_offboarding_runtime_steps", `
    CREATE TABLE IF NOT EXISTS personnel_lifecycle_offboarding_runtime_steps (
      package_binding_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      ${uuidV4Column("step_reference")},
      ${uuidV4Column("order_reference")},
      sort_order INTEGER NOT NULL CHECK(sort_order >= 1),
      recipient_class TEXT NOT NULL CHECK(recipient_class IN (
        'employee','leadership','it_security','asset_custodian','trainer',
        'payroll','hr_case','hr_confidential'
      )),
      release_gate TEXT NOT NULL CHECK(release_gate IN (
        'communication_released','employee_informed','active'
      )),
      data_classification TEXT NOT NULL CHECK(data_classification IN (
        'operational_standard','personal_restricted','hr_confidential','employee_released'
      )),
      ${protectedPayload("protected_payload")},
      ${sha256Column("receipt_sha256")},
      created_by TEXT NOT NULL CHECK(TRIM(created_by) <> ''),
      created_at TEXT NOT NULL CHECK(TRIM(created_at) <> ''),
      PRIMARY KEY (run_id, step_reference),
      UNIQUE(package_binding_id),
      UNIQUE(run_id, sort_order),
      UNIQUE(run_id, order_reference),
      FOREIGN KEY (package_binding_id, run_id)
        REFERENCES personnel_lifecycle_offboarding_package_runs(package_binding_id, run_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );
  `),
  definition("personnel_lifecycle_offboarding_assignment_bindings", `
    CREATE TABLE IF NOT EXISTS personnel_lifecycle_offboarding_assignment_bindings (
      assignment_id TEXT PRIMARY KEY,
      package_binding_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      step_reference TEXT NOT NULL,
      ${sha256Column("receipt_sha256")},
      bound_by TEXT NOT NULL CHECK(TRIM(bound_by) <> ''),
      bound_at TEXT NOT NULL CHECK(TRIM(bound_at) <> ''),
      UNIQUE(package_binding_id, step_reference),
      FOREIGN KEY (assignment_id)
        REFERENCES personnel_lifecycle_case_assignments(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (package_binding_id, run_id)
        REFERENCES personnel_lifecycle_offboarding_package_runs(package_binding_id, run_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (run_id, step_reference)
        REFERENCES personnel_lifecycle_offboarding_runtime_steps(run_id, step_reference)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );
  `),
  definition("personnel_lifecycle_offboarding_run_terminations", `
    CREATE TABLE IF NOT EXISTS personnel_lifecycle_offboarding_run_terminations (
      run_id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      ${uuidV4Column("operation_id")},
      reason_code TEXT NOT NULL CHECK(length(TRIM(reason_code)) BETWEEN 3 AND 80),
      ${protectedPayload("protected_payload")},
      ${sha256Column("receipt_sha256")},
      terminated_by TEXT NOT NULL CHECK(TRIM(terminated_by) <> ''),
      terminated_at TEXT NOT NULL CHECK(TRIM(terminated_at) <> ''),
      FOREIGN KEY (run_id) REFERENCES custom_process_runs(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (case_id) REFERENCES personnel_lifecycle_cases(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );
  `),
]);

const PERSONNEL_LIFECYCLE_OFFBOARDING_TABLE_NAMES = Object.freeze(
  PERSONNEL_LIFECYCLE_OFFBOARDING_TABLE_DEFINITIONS.map(({ name }) => name),
);

const PERSONNEL_LIFECYCLE_OFFBOARDING_INDEX_DEFINITIONS = Object.freeze([
  definition("ux_personnel_lifecycle_offboarding_nonterminal_episode", `
    CREATE UNIQUE INDEX IF NOT EXISTS
      ux_personnel_lifecycle_offboarding_nonterminal_episode
    ON personnel_lifecycle_cases(employment_episode_id)
    WHERE case_type = 'offboarding'
      AND state IN ('internally_prepared','communication_released','employee_informed','active');
  `),
  definition("ux_personnel_lifecycle_offboarding_operation_once", `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_personnel_lifecycle_offboarding_operation_once
    ON personnel_lifecycle_offboarding_operations(case_id, operation_type)
    WHERE operation_type <> 'task_complete';
  `),
  definition("ux_personnel_lifecycle_offboarding_task_operation", `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_personnel_lifecycle_offboarding_task_operation
    ON personnel_lifecycle_offboarding_operations(case_id, operation_type, subject_key)
    WHERE operation_type = 'task_complete';
  `),
  definition("idx_personnel_lifecycle_offboarding_operations_actor", `
    CREATE INDEX IF NOT EXISTS idx_personnel_lifecycle_offboarding_operations_actor
    ON personnel_lifecycle_offboarding_operations(actor_id, occurred_at, operation_id);
  `),
  definition("idx_personnel_lifecycle_offboarding_versions_scope", `
    CREATE INDEX IF NOT EXISTS idx_personnel_lifecycle_offboarding_versions_scope
    ON personnel_lifecycle_offboarding_package_versions(
      scope_type, location_id, department_id, family_code, version_number
    );
  `),
  definition("idx_personnel_lifecycle_offboarding_bindings_case", `
    CREATE INDEX IF NOT EXISTS idx_personnel_lifecycle_offboarding_bindings_case
    ON personnel_lifecycle_offboarding_package_bindings(case_id, package_version_id);
  `),
  definition("idx_personnel_lifecycle_offboarding_runtime_steps_release", `
    CREATE INDEX IF NOT EXISTS idx_personnel_lifecycle_offboarding_runtime_steps_release
    ON personnel_lifecycle_offboarding_runtime_steps(run_id, release_gate, sort_order);
  `),
  definition("idx_personnel_lifecycle_offboarding_terminations_operation", `
    CREATE INDEX IF NOT EXISTS idx_personnel_lifecycle_offboarding_terminations_operation
    ON personnel_lifecycle_offboarding_run_terminations(operation_id, run_id);
  `),
]);

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

const PRESERVED_O4_TRIGGER_DEFINITIONS = Object.freeze(
  PERSONNEL_LIFECYCLE_ONBOARDING_TRIGGER_DEFINITIONS.filter(
    ({ name }) => !O5_REPLACED_O4_TRIGGER_NAMES.has(name),
  ),
);

function immutableTriggers(tableName, message) {
  return [
    definition(`trg_${tableName}_o5_immutable_update`, `
      CREATE TRIGGER IF NOT EXISTS trg_${tableName}_o5_immutable_update
      BEFORE UPDATE ON ${tableName}
      BEGIN
        SELECT RAISE(ABORT, '${message} are immutable');
      END;
    `),
    definition(`trg_${tableName}_o5_immutable_delete`, `
      CREATE TRIGGER IF NOT EXISTS trg_${tableName}_o5_immutable_delete
      BEFORE DELETE ON ${tableName}
      BEGIN
        SELECT RAISE(ABORT, '${message} are immutable');
      END;
    `),
  ];
}

const PERSONNEL_LIFECYCLE_OFFBOARDING_OWN_TRIGGER_DEFINITIONS = Object.freeze([
  definition("trg_personnel_employment_episodes_o5_transition_guard", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_employment_episodes_o5_transition_guard
    BEFORE UPDATE ON personnel_employment_episodes
    WHEN NOT (
      NEW.id IS OLD.id
      AND NEW.employee_number IS OLD.employee_number
      AND NEW.sequence_number IS OLD.sequence_number
      AND NEW.predecessor_episode_id IS OLD.predecessor_episode_id
      AND NEW.protected_payload IS OLD.protected_payload
      AND NEW.created_by IS OLD.created_by
      AND NEW.created_at IS OLD.created_at
      AND NEW.revision = OLD.revision + 1
      AND TRIM(NEW.updated_by) <> ''
      AND TRIM(NEW.updated_at) <> ''
      AND (
        (OLD.state = 'employment_active' AND NEW.state = 'exit_in_progress'
          AND EXISTS (
            SELECT 1 FROM personnel_lifecycle_cases lifecycle_case
            WHERE lifecycle_case.employment_episode_id = OLD.id
              AND lifecycle_case.case_type = 'offboarding'
              AND lifecycle_case.state = 'communication_released'
          ))
        OR (OLD.state = 'exit_in_progress' AND NEW.state = 'employment_active'
          AND EXISTS (
            SELECT 1 FROM personnel_lifecycle_cases lifecycle_case
            WHERE lifecycle_case.employment_episode_id = OLD.id
              AND lifecycle_case.case_type = 'offboarding'
              AND lifecycle_case.state = 'cancelled'
          )
          AND NOT EXISTS (
            SELECT 1 FROM personnel_lifecycle_cases current_case
            WHERE current_case.employment_episode_id = OLD.id
              AND current_case.case_type = 'offboarding'
              AND current_case.state IN (
                'internally_prepared','communication_released','employee_informed','active'
              )
          ))
        OR (OLD.state = 'exit_in_progress' AND NEW.state = 'employment_ended'
          AND EXISTS (
            SELECT 1 FROM personnel_lifecycle_cases lifecycle_case
            WHERE lifecycle_case.employment_episode_id = OLD.id
              AND lifecycle_case.case_type = 'offboarding'
              AND lifecycle_case.state = 'completed'
          ))
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 employment transition is invalid');
    END;
  `),
  definition("trg_personnel_lifecycle_cases_o5_insert_guard", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_lifecycle_cases_o5_insert_guard
    BEFORE INSERT ON personnel_lifecycle_cases
    WHEN NOT (
      NEW.protected_payload LIKE 'enc:v2:%'
      AND NEW.revision = 1
      AND NEW.created_by = NEW.updated_by
      AND NEW.created_at = NEW.updated_at
      AND (
        (NEW.case_type = 'onboarding' AND NEW.state = 'prepared')
        OR (NEW.case_type = 'offboarding' AND NEW.state = 'internally_prepared'
          AND EXISTS (
            SELECT 1 FROM personnel_employment_episodes episode
            WHERE episode.id = NEW.employment_episode_id
              AND episode.state = 'employment_active'
          )
          AND (
            (NEW.predecessor_case_id IS NULL AND NOT EXISTS (
              SELECT 1 FROM personnel_lifecycle_cases existing_case
              WHERE existing_case.employment_episode_id = NEW.employment_episode_id
                AND existing_case.case_type = 'offboarding'
            ))
            OR EXISTS (
              SELECT 1 FROM personnel_lifecycle_cases predecessor
              WHERE predecessor.id = NEW.predecessor_case_id
                AND predecessor.employment_episode_id = NEW.employment_episode_id
                AND predecessor.case_type = 'offboarding'
                AND predecessor.state = 'cancelled'
                AND NOT EXISTS (
                  SELECT 1 FROM personnel_lifecycle_cases later_case
                  WHERE later_case.employment_episode_id = NEW.employment_episode_id
                    AND later_case.case_type = 'offboarding'
                    AND (
                      later_case.created_at > predecessor.created_at
                      OR (later_case.created_at = predecessor.created_at
                        AND later_case.id > predecessor.id)
                    )
                )
            )
          ))
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 case insert is invalid');
    END;
  `),
  definition("trg_personnel_lifecycle_cases_o5_transition_guard", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_lifecycle_cases_o5_transition_guard
    BEFORE UPDATE ON personnel_lifecycle_cases
    WHEN NOT (
      NEW.id IS OLD.id
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
        (OLD.case_type = 'onboarding' AND (
          (OLD.state = 'prepared' AND NEW.state IN ('approved','cancelled'))
          OR (OLD.state = 'approved' AND NEW.state IN ('active','cancelled'))
          OR (OLD.state = 'active' AND NEW.state IN ('completed','cancelled'))
        )
        AND (NEW.state <> 'active' OR (
          EXISTS (SELECT 1 FROM personnel_lifecycle_case_package_bindings binding
            WHERE binding.case_id = OLD.id)
          AND NOT EXISTS (
            SELECT 1 FROM personnel_lifecycle_case_package_bindings binding
            LEFT JOIN personnel_lifecycle_case_package_runs package_run
              ON package_run.package_binding_id = binding.id
            WHERE binding.case_id = OLD.id AND package_run.package_binding_id IS NULL
          )
        ))
        AND (NEW.state <> 'completed' OR NOT EXISTS (
          SELECT 1 FROM personnel_lifecycle_case_package_bindings binding
          JOIN personnel_lifecycle_case_package_runs package_run
            ON package_run.package_binding_id = binding.id
          JOIN custom_process_runs run ON run.id = package_run.run_id
          WHERE binding.case_id = OLD.id AND run.status <> 'resolved'
        )))
        OR (OLD.case_type = 'offboarding' AND (
          (OLD.state = 'internally_prepared'
            AND NEW.state = 'communication_released'
            AND EXISTS (
              SELECT 1 FROM personnel_lifecycle_offboarding_operations operation
              WHERE operation.case_id = OLD.id AND operation.operation_type = 'prepare'
            ))
          OR (OLD.state = 'internally_prepared'
            AND NEW.state = 'cancelled'
            AND EXISTS (
              SELECT 1 FROM personnel_lifecycle_offboarding_operations operation
              WHERE operation.case_id = OLD.id AND operation.operation_type = 'prepare'
            ))
          OR (OLD.state = 'communication_released'
            AND NEW.state = 'employee_informed'
            AND EXISTS (
              SELECT 1 FROM personnel_lifecycle_offboarding_operations operation
              WHERE operation.case_id = OLD.id
                AND operation.operation_type = 'communication_release'
            ))
          OR (OLD.state = 'communication_released'
            AND NEW.state = 'cancelled'
            AND EXISTS (
              SELECT 1 FROM personnel_lifecycle_offboarding_operations operation
              WHERE operation.case_id = OLD.id
                AND operation.operation_type = 'communication_release'
            ))
          OR (OLD.state = 'employee_informed' AND NEW.state = 'active'
            AND EXISTS (
              SELECT 1 FROM personnel_lifecycle_offboarding_operations operation
              WHERE operation.case_id = OLD.id
                AND operation.operation_type = 'information_confirmation'
            ))
          OR (OLD.state = 'employee_informed' AND NEW.state = 'cancelled'
            AND EXISTS (
              SELECT 1 FROM personnel_lifecycle_offboarding_operations operation
              WHERE operation.case_id = OLD.id
                AND operation.operation_type = 'information_confirmation'
            ))
          OR (OLD.state = 'active' AND NEW.state = 'completed'
            AND EXISTS (
              SELECT 1 FROM personnel_lifecycle_offboarding_operations operation
              WHERE operation.case_id = OLD.id AND operation.operation_type = 'activation'
            ))
          OR (OLD.state = 'active' AND NEW.state = 'cancelled'
            AND EXISTS (
              SELECT 1 FROM personnel_lifecycle_offboarding_operations operation
              WHERE operation.case_id = OLD.id AND operation.operation_type = 'activation'
            ))
        )
        AND (NEW.state <> 'active' OR (
          EXISTS (
            SELECT 1 FROM personnel_lifecycle_offboarding_package_bindings binding
            WHERE binding.case_id = OLD.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM personnel_lifecycle_offboarding_package_bindings binding
            LEFT JOIN personnel_lifecycle_offboarding_package_runs package_run
              ON package_run.package_binding_id = binding.id
            WHERE binding.case_id = OLD.id AND package_run.run_id IS NULL
          )
          AND NOT EXISTS (
            SELECT 1
            FROM personnel_lifecycle_offboarding_package_bindings binding
            JOIN personnel_lifecycle_offboarding_package_runs package_run
              ON package_run.package_binding_id = binding.id
            LEFT JOIN personnel_lifecycle_offboarding_runtime_steps runtime_step
              ON runtime_step.run_id = package_run.run_id
            WHERE binding.case_id = OLD.id AND runtime_step.run_id IS NULL
          )
          AND NOT EXISTS (
            SELECT 1
            FROM personnel_lifecycle_offboarding_package_bindings binding
            JOIN personnel_lifecycle_offboarding_runtime_steps runtime_step
              ON runtime_step.package_binding_id = binding.id
            LEFT JOIN custom_process_run_steps run_step
              ON run_step.run_id = runtime_step.run_id
              AND run_step.step_id = runtime_step.step_reference
              AND run_step.sort_order = runtime_step.sort_order
            WHERE binding.case_id = OLD.id AND run_step.run_id IS NULL
          )
          AND NOT EXISTS (
            SELECT 1
            FROM personnel_lifecycle_offboarding_package_bindings binding
            JOIN personnel_lifecycle_offboarding_package_runs package_run
              ON package_run.package_binding_id = binding.id
            JOIN custom_process_run_steps run_step ON run_step.run_id = package_run.run_id
            WHERE binding.case_id = OLD.id AND run_step.status <> 'pending'
          )
        ))
        AND (NEW.state <> 'completed' OR (
          EXISTS (
            SELECT 1 FROM personnel_lifecycle_offboarding_package_bindings binding
            WHERE binding.case_id = OLD.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM personnel_lifecycle_offboarding_package_bindings binding
            LEFT JOIN personnel_lifecycle_offboarding_package_runs package_run
              ON package_run.package_binding_id = binding.id
            WHERE binding.case_id = OLD.id AND package_run.run_id IS NULL
          )
          AND NOT EXISTS (
            SELECT 1
            FROM personnel_lifecycle_offboarding_package_bindings binding
            JOIN personnel_lifecycle_offboarding_package_runs package_run
              ON package_run.package_binding_id = binding.id
            JOIN custom_process_runs run ON run.id = package_run.run_id
            WHERE binding.case_id = OLD.id AND run.status <> 'resolved'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM personnel_lifecycle_offboarding_package_bindings binding
            JOIN personnel_lifecycle_offboarding_package_runs package_run
              ON package_run.package_binding_id = binding.id
            JOIN custom_process_run_steps run_step ON run_step.run_id = package_run.run_id
            WHERE binding.case_id = OLD.id AND run_step.status <> 'completed'
          )
          AND NOT EXISTS (
            SELECT 1 FROM personnel_lifecycle_offboarding_run_terminations termination
            WHERE termination.case_id = OLD.id
          )
        )))
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 case transition is invalid');
    END;
  `),
  definition("trg_personnel_lifecycle_case_reference_dates_o5_insert_guard", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_lifecycle_case_reference_dates_o5_insert_guard
    BEFORE INSERT ON personnel_lifecycle_case_reference_dates
    WHEN NOT EXISTS (
      SELECT 1 FROM personnel_lifecycle_cases lifecycle_case
      WHERE lifecycle_case.id = NEW.case_id
        AND NEW.protected_payload LIKE 'enc:v2:%'
        AND (
          (lifecycle_case.case_type = 'onboarding'
            AND lifecycle_case.state IN ('prepared','approved','active')
            AND (
              (NEW.revision = 1 AND NEW.previous_revision_id IS NULL)
              OR EXISTS (
                SELECT 1 FROM personnel_lifecycle_case_reference_dates previous
                WHERE previous.id = NEW.previous_revision_id
                  AND previous.case_id = NEW.case_id
                  AND NEW.revision = previous.revision + 1
                  AND previous.revision = (
                    SELECT MAX(latest.revision)
                    FROM personnel_lifecycle_case_reference_dates latest
                    WHERE latest.case_id = NEW.case_id
                  )
              )
            ))
          OR (lifecycle_case.case_type = 'offboarding'
            AND lifecycle_case.state = 'internally_prepared'
            AND NEW.revision = 1 AND NEW.previous_revision_id IS NULL)
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 reference dates are invalid');
    END;
  `),
  definition("trg_personnel_lifecycle_case_assignments_o5_insert_guard", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_lifecycle_case_assignments_o5_insert_guard
    BEFORE INSERT ON personnel_lifecycle_case_assignments
    WHEN NOT EXISTS (
      SELECT 1
      FROM personnel_lifecycle_cases lifecycle_case
      JOIN portal_users portal_user ON portal_user.employee_number = NEW.assignee_actor_id
      JOIN employees employee ON employee.personnel_number = portal_user.employee_number
      LEFT JOIN portal_roles portal_role ON portal_role.id = portal_user.role
      WHERE lifecycle_case.id = NEW.case_id
        AND portal_user.active = 1
        AND employee.active = 1
        AND TRIM(COALESCE(portal_user.password_hash, '')) <> ''
        AND (
          (lifecycle_case.case_type = 'onboarding'
            AND portal_user.role NOT IN ('it_admin','developer','local'))
          OR (lifecycle_case.case_type = 'offboarding'
            AND portal_user.role <> 'local'
            AND NOT EXISTS (
              SELECT 1 FROM portal_permission_denials denial
              WHERE denial.employee_number = portal_user.employee_number
                AND denial.permission IN (
                  'personnel:lifecycle:operational:read',
                  'personnel:lifecycle:operational:update'
                )
            )
            AND EXISTS (
              SELECT 1 FROM json_each(COALESCE(portal_role.permissions, '[]')) permission
              WHERE permission.value = 'personnel:lifecycle:operational:read'
              UNION ALL
              SELECT 1 FROM portal_permission_grants grant_row
              WHERE grant_row.employee_number = portal_user.employee_number
                AND grant_row.permission = 'personnel:lifecycle:operational:read'
            )
            AND EXISTS (
              SELECT 1 FROM json_each(COALESCE(portal_role.permissions, '[]')) permission
              WHERE permission.value = 'personnel:lifecycle:operational:update'
              UNION ALL
              SELECT 1 FROM portal_permission_grants grant_row
              WHERE grant_row.employee_number = portal_user.employee_number
                AND grant_row.permission = 'personnel:lifecycle:operational:update'
            ))
        )
        AND (
          (lifecycle_case.case_type = 'onboarding'
            AND lifecycle_case.state = 'approved'
            AND EXISTS (
              SELECT 1 FROM personnel_lifecycle_case_package_bindings binding
              JOIN custom_process_publications publication
                ON publication.id = binding.publication_id
              JOIN json_each(publication.snapshot_json, '$.steps') snapshot_step
                ON json_extract(snapshot_step.value, '$.id') = NEW.step_reference
              WHERE binding.case_id = NEW.case_id
                AND json_extract(snapshot_step.value, '$.responsibilityType')
                  IN ('role','employee')
            ))
          OR (lifecycle_case.case_type = 'offboarding'
            AND lifecycle_case.state IN ('communication_released','employee_informed','active')
            AND EXISTS (
              SELECT 1
              FROM personnel_lifecycle_offboarding_package_bindings binding
              JOIN personnel_lifecycle_offboarding_package_runs package_run
                ON package_run.package_binding_id = binding.id
              JOIN personnel_lifecycle_offboarding_runtime_steps runtime_step
                ON runtime_step.run_id = package_run.run_id
                AND runtime_step.step_reference = NEW.step_reference
              WHERE binding.case_id = NEW.case_id
                AND runtime_step.recipient_class <> 'employee'
                AND (
                  (runtime_step.recipient_class = 'leadership'
                    AND portal_user.role IN (
                      'manager','department_manager','hr','admin','developer'
                    ))
                  OR (runtime_step.recipient_class = 'it_security'
                    AND portal_user.role IN ('it_admin','developer'))
                  OR (runtime_step.recipient_class = 'asset_custodian'
                    AND portal_user.role IN (
                      'manager','department_manager','admin','it_admin','developer'
                    ))
                  OR (runtime_step.recipient_class = 'payroll'
                    AND portal_user.role IN ('hr','admin','developer'))
                )
            ))
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 assignment is invalid');
    END;
  `),
  definition("trg_personnel_lifecycle_case_events_o5_insert_guard", `
    CREATE TRIGGER IF NOT EXISTS trg_personnel_lifecycle_case_events_o5_insert_guard
    BEFORE INSERT ON personnel_lifecycle_case_events
    WHEN NOT EXISTS (
      SELECT 1 FROM personnel_lifecycle_cases lifecycle_case
      WHERE lifecycle_case.id = NEW.case_id
        AND NEW.protected_payload LIKE 'enc:v2:%'
        AND (
          (lifecycle_case.case_type = 'onboarding'
            AND NEW.data_classification IN (
              'operational_standard','personal_restricted','hr_confidential'
            ))
          OR (lifecycle_case.case_type = 'offboarding'
            AND NEW.data_classification = 'offboarding_strict_confidential')
        )
        AND (
          (NEW.sequence_number = 1 AND NEW.previous_receipt_sha256 = ''
            AND NOT EXISTS (
              SELECT 1 FROM personnel_lifecycle_case_events existing
              WHERE existing.case_id = NEW.case_id
            ))
          OR EXISTS (
            SELECT 1 FROM personnel_lifecycle_case_events previous
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
      SELECT RAISE(ABORT, 'personnel lifecycle O5 event is invalid');
    END;
  `),
  definition("trg_personnel_lifecycle_confidential_access_events_o5_insert_guard", `
    CREATE TRIGGER IF NOT EXISTS
      trg_personnel_lifecycle_confidential_access_events_o5_insert_guard
    BEFORE INSERT ON personnel_lifecycle_confidential_access_events
    WHEN NOT EXISTS (
      SELECT 1 FROM personnel_lifecycle_cases lifecycle_case
      WHERE lifecycle_case.id = NEW.case_id
        AND lifecycle_case.case_type = 'offboarding'
        AND (
          (NEW.sequence_number = 1 AND NEW.previous_receipt_sha256 = ''
            AND NOT EXISTS (
              SELECT 1 FROM personnel_lifecycle_confidential_access_events existing
              WHERE existing.case_id = NEW.case_id
            ))
          OR EXISTS (
            SELECT 1 FROM personnel_lifecycle_confidential_access_events previous
            WHERE previous.case_id = NEW.case_id
              AND previous.sequence_number = NEW.sequence_number - 1
              AND previous.receipt_sha256 = NEW.previous_receipt_sha256
              AND previous.sequence_number = (
                SELECT MAX(latest.sequence_number)
                FROM personnel_lifecycle_confidential_access_events latest
                WHERE latest.case_id = NEW.case_id
              )
          )
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 confidential access event is invalid');
    END;
  `),
  ...immutableTriggers(
    "personnel_lifecycle_confidential_access_events",
    "personnel lifecycle O5 confidential access events",
  ),
  definition("trg_personnel_lifecycle_offboarding_package_versions_o5_insert_guard", `
    CREATE TRIGGER IF NOT EXISTS
      trg_personnel_lifecycle_offboarding_package_versions_o5_insert_guard
    BEFORE INSERT ON personnel_lifecycle_offboarding_package_versions
    WHEN NOT EXISTS (
      SELECT 1 FROM custom_processes process
      WHERE process.id = NEW.runtime_process_id
        AND process.title = 'Geschützter Personalprozess'
        AND process.symbol = 'P'
        AND process.description = ''
        AND process.category = 'other'
        AND process.scope_type = 'company'
        AND process.location_id IS NULL
        AND process.department_id IS NULL
        AND process.trigger_type = 'manual'
        AND process.trigger_minimum_shortfall = 1
        AND process.status = 'active'
        AND process.revision = NEW.version_number
        AND process.archived_at IS NULL
        AND NEW.runtime_manifest_sha256 = CASE NEW.family_code
          ${OFFBOARDING_RUNTIME_MANIFEST_FOR_FAMILY_SQL}
          ELSE ''
        END
        AND NOT EXISTS (
          SELECT 1 FROM custom_process_steps process_step
          WHERE process_step.process_id = process.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM custom_process_revisions process_revision
          WHERE process_revision.process_id = process.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM custom_process_publications publication
          WHERE publication.process_id = process.id
        )
        AND (
          (NEW.version_number = 1 AND NEW.predecessor_version_id IS NULL)
          OR EXISTS (
            SELECT 1 FROM personnel_lifecycle_offboarding_package_versions previous
            WHERE previous.id = NEW.predecessor_version_id
              AND previous.series_id = NEW.series_id
              AND NEW.version_number = previous.version_number + 1
              AND previous.version_number = (
                SELECT MAX(latest.version_number)
                FROM personnel_lifecycle_offboarding_package_versions latest
                WHERE latest.series_id = NEW.series_id
              )
          )
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 package version is invalid');
    END;
  `),
  ...immutableTriggers(
    "personnel_lifecycle_offboarding_package_versions",
    "personnel lifecycle O5 package versions",
  ),
  ...immutableTriggers(
    "personnel_lifecycle_offboarding_package_version_archives",
    "personnel lifecycle O5 package version archives",
  ),
  definition("trg_custom_processes_o5_runtime_shell_update_blocked", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_processes_o5_runtime_shell_update_blocked
    BEFORE UPDATE ON custom_processes
    WHEN EXISTS (
      SELECT 1 FROM personnel_lifecycle_offboarding_package_versions version
      WHERE version.runtime_process_id = OLD.id
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 runtime shell is immutable');
    END;
  `),
  definition("trg_custom_processes_o5_runtime_shell_delete_blocked", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_processes_o5_runtime_shell_delete_blocked
    BEFORE DELETE ON custom_processes
    WHEN EXISTS (
      SELECT 1 FROM personnel_lifecycle_offboarding_package_versions version
      WHERE version.runtime_process_id = OLD.id
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 runtime shell cannot be deleted');
    END;
  `),
  definition("trg_custom_process_steps_o5_runtime_shell_insert_blocked", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_steps_o5_runtime_shell_insert_blocked
    BEFORE INSERT ON custom_process_steps
    WHEN EXISTS (
      SELECT 1 FROM personnel_lifecycle_offboarding_package_versions version
      WHERE version.runtime_process_id = NEW.process_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 runtime shell rejects generic steps');
    END;
  `),
  definition("trg_custom_process_steps_o5_runtime_shell_update_blocked", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_steps_o5_runtime_shell_update_blocked
    BEFORE UPDATE ON custom_process_steps
    WHEN EXISTS (
      SELECT 1 FROM personnel_lifecycle_offboarding_package_versions version
      WHERE version.runtime_process_id IN (OLD.process_id, NEW.process_id)
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 runtime shell rejects generic steps');
    END;
  `),
  definition("trg_custom_process_steps_o5_runtime_shell_delete_blocked", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_steps_o5_runtime_shell_delete_blocked
    BEFORE DELETE ON custom_process_steps
    WHEN EXISTS (
      SELECT 1 FROM personnel_lifecycle_offboarding_package_versions version
      WHERE version.runtime_process_id = OLD.process_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 runtime shell rejects generic steps');
    END;
  `),
  definition("trg_custom_process_revisions_o5_runtime_shell_insert_blocked", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_revisions_o5_runtime_shell_insert_blocked
    BEFORE INSERT ON custom_process_revisions
    WHEN EXISTS (
      SELECT 1 FROM personnel_lifecycle_offboarding_package_versions version
      WHERE version.runtime_process_id = NEW.process_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 runtime shell rejects generic revisions');
    END;
  `),
  definition("trg_custom_process_revisions_o5_runtime_shell_update_blocked", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_revisions_o5_runtime_shell_update_blocked
    BEFORE UPDATE ON custom_process_revisions
    WHEN EXISTS (
      SELECT 1 FROM personnel_lifecycle_offboarding_package_versions version
      WHERE version.runtime_process_id IN (OLD.process_id, NEW.process_id)
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 runtime shell rejects generic revisions');
    END;
  `),
  definition("trg_custom_process_revisions_o5_runtime_shell_delete_blocked", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_revisions_o5_runtime_shell_delete_blocked
    BEFORE DELETE ON custom_process_revisions
    WHEN EXISTS (
      SELECT 1 FROM personnel_lifecycle_offboarding_package_versions version
      WHERE version.runtime_process_id = OLD.process_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 runtime shell rejects generic revisions');
    END;
  `),
  definition("trg_custom_process_publications_o5_runtime_shell_insert_blocked", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_publications_o5_runtime_shell_insert_blocked
    BEFORE INSERT ON custom_process_publications
    WHEN EXISTS (
      SELECT 1 FROM personnel_lifecycle_offboarding_package_versions version
      WHERE version.runtime_process_id = NEW.process_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 runtime shell rejects publications');
    END;
  `),
  definition("trg_custom_process_publications_o5_runtime_shell_update_blocked", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_publications_o5_runtime_shell_update_blocked
    BEFORE UPDATE ON custom_process_publications
    WHEN EXISTS (
      SELECT 1 FROM personnel_lifecycle_offboarding_package_versions version
      WHERE version.runtime_process_id IN (OLD.process_id, NEW.process_id)
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 runtime shell rejects publications');
    END;
  `),
  definition("trg_custom_process_publications_o5_runtime_shell_delete_blocked", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_publications_o5_runtime_shell_delete_blocked
    BEFORE DELETE ON custom_process_publications
    WHEN EXISTS (
      SELECT 1 FROM personnel_lifecycle_offboarding_package_versions version
      WHERE version.runtime_process_id = OLD.process_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 runtime shell rejects publications');
    END;
  `),
  definition("trg_personnel_lifecycle_offboarding_package_bindings_o5_insert_guard", `
    CREATE TRIGGER IF NOT EXISTS
      trg_personnel_lifecycle_offboarding_package_bindings_o5_insert_guard
    BEFORE INSERT ON personnel_lifecycle_offboarding_package_bindings
    WHEN NOT EXISTS (
      SELECT 1
      FROM personnel_lifecycle_cases lifecycle_case
      JOIN personnel_lifecycle_offboarding_package_versions version
        ON version.id = NEW.package_version_id
      LEFT JOIN personnel_lifecycle_offboarding_package_version_archives archive
        ON archive.package_version_id = version.id
      WHERE lifecycle_case.id = NEW.case_id
        AND lifecycle_case.case_type = 'offboarding'
        AND lifecycle_case.state = 'communication_released'
        AND NEW.scope_snapshot_sha256 = lifecycle_case.scope_snapshot_sha256
        AND version.version_number = NEW.version_number
        AND archive.package_version_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM personnel_lifecycle_offboarding_package_bindings existing_binding
          JOIN personnel_lifecycle_offboarding_package_versions existing_version
            ON existing_version.id = existing_binding.package_version_id
          WHERE existing_binding.case_id = NEW.case_id
            AND existing_version.family_code = version.family_code
        )
        AND (
          version.scope_type = 'company'
          OR (version.scope_type = 'location'
            AND version.location_id = lifecycle_case.location_id)
          OR (version.scope_type = 'department'
            AND version.location_id = lifecycle_case.location_id
            AND version.department_id = lifecycle_case.department_id)
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 package binding is invalid');
    END;
  `),
  ...immutableTriggers(
    "personnel_lifecycle_offboarding_package_bindings",
    "personnel lifecycle O5 package bindings",
  ),
  definition("trg_personnel_lifecycle_offboarding_package_runs_o5_insert_guard", `
    CREATE TRIGGER IF NOT EXISTS
      trg_personnel_lifecycle_offboarding_package_runs_o5_insert_guard
    BEFORE INSERT ON personnel_lifecycle_offboarding_package_runs
    WHEN NOT EXISTS (
      SELECT 1
      FROM personnel_lifecycle_offboarding_package_bindings binding
      JOIN personnel_lifecycle_offboarding_package_versions version
        ON version.id = binding.package_version_id
      JOIN personnel_lifecycle_cases lifecycle_case ON lifecycle_case.id = binding.case_id
      JOIN personnel_employment_episodes episode
        ON episode.id = lifecycle_case.employment_episode_id
      JOIN custom_process_runs run ON run.id = NEW.run_id
      WHERE binding.id = NEW.package_binding_id
        AND lifecycle_case.case_type = 'offboarding'
        AND lifecycle_case.state = 'communication_released'
        AND episode.state = 'exit_in_progress'
        AND run.process_id = version.runtime_process_id
        AND run.process_revision = version.version_number
        AND run.trigger_type = 'personnel_lifecycle_offboarding'
        AND run.trigger_key = 'personnel-offboarding:' || NEW.run_operation_id
        AND run.status = 'open'
        AND run.activation_count = 1
        AND run.location_id = lifecycle_case.location_id
        AND run.department_id IS lifecycle_case.department_id
        AND NEW.scope_snapshot_sha256 = binding.scope_snapshot_sha256
        AND NEW.runtime_manifest_sha256 = version.runtime_manifest_sha256
        AND NOT EXISTS (
          SELECT 1 FROM custom_process_run_bindings generic_binding
          WHERE generic_binding.run_id = run.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM custom_process_run_steps existing_step
          WHERE existing_step.run_id = run.id
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 package run is invalid');
    END;
  `),
  ...immutableTriggers(
    "personnel_lifecycle_offboarding_package_runs",
    "personnel lifecycle O5 package runs",
  ),
  definition("trg_personnel_lifecycle_offboarding_runtime_steps_o5_insert_guard", `
    CREATE TRIGGER IF NOT EXISTS
      trg_personnel_lifecycle_offboarding_runtime_steps_o5_insert_guard
    BEFORE INSERT ON personnel_lifecycle_offboarding_runtime_steps
    WHEN NOT EXISTS (
      SELECT 1
      FROM personnel_lifecycle_offboarding_package_runs package_run
      JOIN personnel_lifecycle_offboarding_package_bindings binding
        ON binding.id = package_run.package_binding_id
      JOIN personnel_lifecycle_offboarding_package_versions version
        ON version.id = binding.package_version_id
      JOIN personnel_lifecycle_cases lifecycle_case ON lifecycle_case.id = binding.case_id
      JOIN custom_process_runs run ON run.id = package_run.run_id
      WHERE package_run.package_binding_id = NEW.package_binding_id
        AND package_run.run_id = NEW.run_id
        AND lifecycle_case.case_type = 'offboarding'
        AND lifecycle_case.state IN ('communication_released','employee_informed')
        AND run.status = 'open'
        AND NEW.sort_order = 1
        AND NEW.release_gate = 'communication_released'
        AND NEW.data_classification = 'personal_restricted'
        AND NEW.step_reference = CASE version.family_code
          ${OFFBOARDING_STEP_FOR_FAMILY_SQL}
        END
        AND NEW.order_reference = CASE version.family_code
          ${OFFBOARDING_ORDER_FOR_FAMILY_SQL}
        END
        AND NEW.recipient_class = CASE version.family_code
          ${OFFBOARDING_RECIPIENT_FOR_FAMILY_SQL}
        END
        AND NOT EXISTS (
          SELECT 1 FROM custom_process_run_steps existing_step
          WHERE existing_step.run_id = NEW.run_id
            AND existing_step.step_id = NEW.step_reference
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 runtime step is invalid');
    END;
  `),
  ...immutableTriggers(
    "personnel_lifecycle_offboarding_runtime_steps",
    "personnel lifecycle O5 runtime steps",
  ),
  definition("trg_personnel_lifecycle_offboarding_assignment_bindings_o5_insert_guard", `
    CREATE TRIGGER IF NOT EXISTS
      trg_personnel_lifecycle_offboarding_assignment_bindings_o5_insert_guard
    BEFORE INSERT ON personnel_lifecycle_offboarding_assignment_bindings
    WHEN NOT EXISTS (
      SELECT 1
      FROM personnel_lifecycle_case_assignments assignment
      JOIN personnel_lifecycle_offboarding_package_bindings binding
        ON binding.id = NEW.package_binding_id AND binding.case_id = assignment.case_id
      JOIN personnel_lifecycle_offboarding_package_runs package_run
        ON package_run.package_binding_id = binding.id AND package_run.run_id = NEW.run_id
      JOIN personnel_lifecycle_offboarding_runtime_steps runtime_step
        ON runtime_step.run_id = NEW.run_id
        AND runtime_step.step_reference = NEW.step_reference
      JOIN personnel_lifecycle_cases lifecycle_case ON lifecycle_case.id = assignment.case_id
      WHERE assignment.id = NEW.assignment_id
        AND assignment.step_reference = NEW.step_reference
        AND lifecycle_case.case_type = 'offboarding'
        AND lifecycle_case.state IN ('communication_released','employee_informed','active')
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 assignment binding is invalid');
    END;
  `),
  ...immutableTriggers(
    "personnel_lifecycle_offboarding_assignment_bindings",
    "personnel lifecycle O5 assignment bindings",
  ),
  definition("trg_personnel_lifecycle_offboarding_operations_o5_insert_guard", `
    CREATE TRIGGER IF NOT EXISTS
      trg_personnel_lifecycle_offboarding_operations_o5_insert_guard
    BEFORE INSERT ON personnel_lifecycle_offboarding_operations
    WHEN NOT EXISTS (
      SELECT 1
      FROM personnel_lifecycle_cases lifecycle_case
      JOIN personnel_employment_episodes episode
        ON episode.id = lifecycle_case.employment_episode_id
      WHERE lifecycle_case.id = NEW.case_id
        AND lifecycle_case.case_type = 'offboarding'
        AND (
          (NEW.operation_type = 'prepare' AND NEW.subject_key = episode.employee_number)
          OR NEW.operation_type = 'task_complete'
          OR (NEW.operation_type NOT IN ('prepare','task_complete')
            AND NEW.subject_key = lifecycle_case.id)
        )
        AND (
          NEW.operation_type = 'prepare'
          OR EXISTS (
            SELECT 1 FROM personnel_lifecycle_offboarding_operations preparation
            WHERE preparation.case_id = NEW.case_id
              AND preparation.operation_type = 'prepare'
              AND preparation.plan_receipt_sha256 = NEW.plan_receipt_sha256
          )
        )
        AND (
          (NEW.operation_type = 'prepare'
            AND lifecycle_case.state = 'internally_prepared'
            AND episode.state = 'employment_active'
            AND EXISTS (
              SELECT 1 FROM personnel_lifecycle_case_reference_dates reference
              WHERE reference.case_id = lifecycle_case.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM personnel_lifecycle_offboarding_package_bindings binding
              WHERE binding.case_id = lifecycle_case.id
            ))
          OR (NEW.operation_type = 'time_critical_approval'
            AND lifecycle_case.state = 'internally_prepared'
            AND episode.state = 'employment_active')
          OR (NEW.operation_type = 'communication_release'
            AND lifecycle_case.state = 'communication_released'
            AND episode.state = 'exit_in_progress'
            AND EXISTS (
              SELECT 1 FROM personnel_lifecycle_offboarding_package_bindings binding
              WHERE binding.case_id = lifecycle_case.id
            )
            AND (
              SELECT COUNT(*) FROM personnel_lifecycle_offboarding_package_bindings binding
              WHERE binding.case_id = lifecycle_case.id
            ) = ${PERSONNEL_LIFECYCLE_OFFBOARDING_REQUIRED_PACKAGE_FAMILIES.length}
            AND NOT EXISTS (
              SELECT 1
              FROM personnel_lifecycle_offboarding_package_bindings binding
              LEFT JOIN personnel_lifecycle_offboarding_package_runs package_run
                ON package_run.package_binding_id = binding.id
              WHERE binding.case_id = lifecycle_case.id
                AND package_run.package_binding_id IS NULL
            )
            AND NOT EXISTS (
              SELECT 1
              FROM personnel_lifecycle_offboarding_package_bindings binding
              JOIN personnel_lifecycle_offboarding_package_runs package_run
                ON package_run.package_binding_id = binding.id
              LEFT JOIN personnel_lifecycle_offboarding_runtime_steps runtime_step
                ON runtime_step.run_id = package_run.run_id
              WHERE binding.case_id = lifecycle_case.id
                AND runtime_step.run_id IS NULL
            )
            AND NOT EXISTS (
              SELECT 1
              FROM personnel_lifecycle_offboarding_package_bindings binding
              JOIN personnel_lifecycle_offboarding_runtime_steps runtime_step
                ON runtime_step.package_binding_id = binding.id
              LEFT JOIN custom_process_run_steps run_step
                ON run_step.run_id = runtime_step.run_id
                AND run_step.step_id = runtime_step.step_reference
                AND run_step.sort_order = runtime_step.sort_order
              WHERE binding.case_id = lifecycle_case.id
                AND run_step.run_id IS NULL
            )
            AND NOT EXISTS (
              SELECT 1
              FROM personnel_lifecycle_offboarding_package_bindings binding
              JOIN personnel_lifecycle_offboarding_runtime_steps runtime_step
                ON runtime_step.package_binding_id = binding.id
              LEFT JOIN personnel_lifecycle_offboarding_assignment_bindings assignment_binding
                ON assignment_binding.package_binding_id = binding.id
                AND assignment_binding.run_id = runtime_step.run_id
                AND assignment_binding.step_reference = runtime_step.step_reference
              WHERE binding.case_id = lifecycle_case.id
                AND assignment_binding.assignment_id IS NULL
            )
            AND NOT EXISTS (
              SELECT 1
              FROM personnel_lifecycle_offboarding_package_bindings binding
              JOIN personnel_lifecycle_offboarding_package_runs package_run
                ON package_run.package_binding_id = binding.id
              JOIN custom_process_run_steps run_step ON run_step.run_id = package_run.run_id
              WHERE binding.case_id = lifecycle_case.id AND run_step.status <> 'pending'
            ))
          OR (NEW.operation_type = 'information_confirmation'
            AND lifecycle_case.state = 'employee_informed'
            AND episode.state = 'exit_in_progress')
          OR (NEW.operation_type = 'activation'
            AND lifecycle_case.state = 'active'
            AND episode.state = 'exit_in_progress'
            AND NOT EXISTS (
              SELECT 1
              FROM personnel_lifecycle_offboarding_package_bindings binding
              JOIN personnel_lifecycle_offboarding_package_runs package_run
                ON package_run.package_binding_id = binding.id
              JOIN custom_process_runs run ON run.id = package_run.run_id
              WHERE binding.case_id = lifecycle_case.id AND run.status = 'open'
                AND NOT EXISTS (
                  SELECT 1 FROM custom_process_run_steps active_step
                  WHERE active_step.run_id = run.id AND active_step.status = 'active'
                )
            ))
          OR (NEW.operation_type = 'task_complete'
            AND lifecycle_case.state = 'active'
            AND episode.state = 'exit_in_progress'
            AND EXISTS (
              SELECT 1
              FROM personnel_lifecycle_offboarding_assignment_bindings assignment_binding
              JOIN personnel_lifecycle_case_assignments assignment
                ON assignment.id = assignment_binding.assignment_id
              JOIN personnel_lifecycle_offboarding_package_bindings binding
                ON binding.id = assignment_binding.package_binding_id
              JOIN custom_process_run_steps run_step
                ON run_step.run_id = assignment_binding.run_id
                AND run_step.step_id = assignment_binding.step_reference
              WHERE binding.case_id = lifecycle_case.id
                AND NEW.subject_key = assignment_binding.run_id || ':'
                  || assignment_binding.step_reference
                AND assignment.assignee_actor_id = NEW.actor_id
                AND run_step.status = 'completed'
                AND run_step.completed_by = NEW.actor_id
                AND run_step.completion_request_id = NEW.request_sha256
            ))
          OR (NEW.operation_type = 'cancellation'
            AND lifecycle_case.state = 'cancelled'
            AND episode.state = 'employment_active'
            AND NOT EXISTS (
              SELECT 1
              FROM personnel_lifecycle_offboarding_package_bindings binding
              JOIN personnel_lifecycle_offboarding_package_runs package_run
                ON package_run.package_binding_id = binding.id
              JOIN custom_process_runs run ON run.id = package_run.run_id
              WHERE binding.case_id = lifecycle_case.id AND run.status <> 'resolved'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM personnel_lifecycle_offboarding_package_bindings binding
              JOIN personnel_lifecycle_offboarding_package_runs package_run
                ON package_run.package_binding_id = binding.id
              LEFT JOIN personnel_lifecycle_offboarding_run_terminations termination
                ON termination.run_id = package_run.run_id
                AND termination.case_id = lifecycle_case.id
                AND termination.operation_id = NEW.operation_id
              WHERE binding.case_id = lifecycle_case.id
                AND EXISTS (
                  SELECT 1 FROM custom_process_run_steps unfinished_step
                  WHERE unfinished_step.run_id = package_run.run_id
                    AND unfinished_step.status <> 'completed'
                )
                AND termination.run_id IS NULL
            ))
          OR (NEW.operation_type = 'close'
            AND lifecycle_case.state = 'completed'
            AND episode.state = 'employment_ended'
            AND NOT EXISTS (
              SELECT 1 FROM personnel_lifecycle_offboarding_run_terminations termination
              WHERE termination.case_id = lifecycle_case.id
            ))
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 operation ledger is incomplete');
    END;
  `),
  ...immutableTriggers(
    "personnel_lifecycle_offboarding_operations",
    "personnel lifecycle O5 operations",
  ),
  definition("trg_personnel_lifecycle_offboarding_run_terminations_o5_insert_guard", `
    CREATE TRIGGER IF NOT EXISTS
      trg_personnel_lifecycle_offboarding_run_terminations_o5_insert_guard
    BEFORE INSERT ON personnel_lifecycle_offboarding_run_terminations
    WHEN NOT EXISTS (
      SELECT 1
      FROM personnel_lifecycle_offboarding_package_runs package_run
      JOIN personnel_lifecycle_offboarding_package_bindings binding
        ON binding.id = package_run.package_binding_id
      JOIN personnel_lifecycle_cases lifecycle_case ON lifecycle_case.id = binding.case_id
      JOIN custom_process_runs run ON run.id = package_run.run_id
      WHERE package_run.run_id = NEW.run_id
        AND binding.case_id = NEW.case_id
        AND lifecycle_case.case_type = 'offboarding'
        AND lifecycle_case.state = 'cancelled'
        AND run.status = 'open'
        AND EXISTS (
          SELECT 1 FROM custom_process_run_steps unfinished_step
          WHERE unfinished_step.run_id = run.id
            AND unfinished_step.status <> 'completed'
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 run termination is invalid');
    END;
  `),
  ...immutableTriggers(
    "personnel_lifecycle_offboarding_run_terminations",
    "personnel lifecycle O5 run terminations",
  ),
  definition("trg_custom_process_run_bindings_o5_offboarding_blocked", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_run_bindings_o5_offboarding_blocked
    BEFORE INSERT ON custom_process_run_bindings
    WHEN EXISTS (
      SELECT 1 FROM personnel_lifecycle_offboarding_package_runs package_run
      WHERE package_run.run_id = NEW.run_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 runs reject generic bindings');
    END;
  `),
  definition("trg_custom_process_run_step_assignments_o5_offboarding_blocked", `
    CREATE TRIGGER IF NOT EXISTS
      trg_custom_process_run_step_assignments_o5_offboarding_blocked
    BEFORE INSERT ON custom_process_run_step_assignments
    WHEN EXISTS (
      SELECT 1 FROM personnel_lifecycle_offboarding_package_runs package_run
      WHERE package_run.run_id = NEW.run_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 runs reject generic assignments');
    END;
  `),
  definition("trg_custom_process_runs_o5_core_immutable", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_runs_o5_core_immutable
    BEFORE UPDATE OF
      id, process_id, process_revision, trigger_type, trigger_key,
      location_id, department_id, triggered_by, activation_count, created_at
    ON custom_process_runs
    WHEN EXISTS (
      SELECT 1 FROM personnel_lifecycle_offboarding_package_runs package_run
      WHERE package_run.run_id = OLD.id
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 run core is immutable');
    END;
  `),
  definition("trg_custom_process_runs_o5_state_transition", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_runs_o5_state_transition
    BEFORE UPDATE OF status, resolved_at ON custom_process_runs
    WHEN EXISTS (
      SELECT 1 FROM personnel_lifecycle_offboarding_package_runs package_run
      WHERE package_run.run_id = OLD.id
    ) AND NOT (
      OLD.status = 'open' AND NEW.status = 'resolved'
      AND TRIM(COALESCE(NEW.resolved_at, '')) <> ''
      AND (
        EXISTS (
          SELECT 1 FROM custom_process_run_steps existing_step
          WHERE existing_step.run_id = OLD.id
        )
        AND
        NOT EXISTS (
          SELECT 1 FROM custom_process_run_steps run_step
          WHERE run_step.run_id = OLD.id AND run_step.status <> 'completed'
        )
        OR EXISTS (
          SELECT 1 FROM personnel_lifecycle_offboarding_run_terminations termination
          WHERE termination.run_id = OLD.id
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM personnel_lifecycle_offboarding_runtime_steps runtime_step
        JOIN custom_process_run_steps run_step
          ON run_step.run_id = runtime_step.run_id
          AND run_step.step_id = runtime_step.step_reference
        LEFT JOIN personnel_lifecycle_offboarding_package_runs package_run
          ON package_run.run_id = runtime_step.run_id
        LEFT JOIN personnel_lifecycle_offboarding_package_bindings binding
          ON binding.id = package_run.package_binding_id
        LEFT JOIN personnel_lifecycle_offboarding_operations operation
          ON operation.case_id = binding.case_id
          AND operation.operation_type = 'task_complete'
          AND operation.subject_key = runtime_step.run_id || ':' || runtime_step.step_reference
          AND operation.request_sha256 = run_step.completion_request_id
        WHERE runtime_step.run_id = OLD.id
          AND run_step.status = 'completed'
          AND operation.operation_id IS NULL
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 run transition is invalid');
    END;
  `),
  definition("trg_custom_process_runs_o5_delete_blocked", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_runs_o5_delete_blocked
    BEFORE DELETE ON custom_process_runs
    WHEN EXISTS (
      SELECT 1 FROM personnel_lifecycle_offboarding_package_runs package_run
      WHERE package_run.run_id = OLD.id
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 runs cannot be deleted');
    END;
  `),
  definition("trg_custom_process_run_steps_o5_insert_guard", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_run_steps_o5_insert_guard
    BEFORE INSERT ON custom_process_run_steps
    WHEN EXISTS (
      SELECT 1 FROM personnel_lifecycle_offboarding_package_runs package_run
      WHERE package_run.run_id = NEW.run_id
    ) AND (
      NEW.status <> 'pending'
      OR NEW.activated_at IS NOT NULL
      OR NEW.completed_at IS NOT NULL
      OR NEW.completed_by <> ''
      OR NEW.completion_note <> ''
      OR NEW.completion_request_id <> ''
      OR NOT EXISTS (
        SELECT 1 FROM personnel_lifecycle_offboarding_runtime_steps runtime_step
        WHERE runtime_step.run_id = NEW.run_id
          AND runtime_step.step_reference = NEW.step_id
          AND runtime_step.sort_order = NEW.sort_order
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 run step is invalid');
    END;
  `),
  definition("trg_custom_process_run_steps_o5_transition_guard", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_run_steps_o5_transition_guard
    BEFORE UPDATE ON custom_process_run_steps
    WHEN EXISTS (
      SELECT 1 FROM personnel_lifecycle_offboarding_package_runs package_run
      WHERE package_run.run_id = OLD.run_id
    ) AND NOT (
      NEW.run_id IS OLD.run_id
      AND NEW.step_id IS OLD.step_id
      AND NEW.sort_order IS OLD.sort_order
      AND NEW.created_at IS OLD.created_at
      AND NOT EXISTS (
        SELECT 1 FROM personnel_lifecycle_offboarding_run_terminations termination
        WHERE termination.run_id = OLD.run_id
      )
      AND EXISTS (
        SELECT 1
        FROM personnel_lifecycle_offboarding_package_runs package_run
        JOIN personnel_lifecycle_offboarding_package_bindings binding
          ON binding.id = package_run.package_binding_id
        JOIN personnel_lifecycle_cases lifecycle_case ON lifecycle_case.id = binding.case_id
        WHERE package_run.run_id = OLD.run_id
          AND lifecycle_case.case_type = 'offboarding'
          AND lifecycle_case.state = 'active'
      )
      AND (
        (OLD.status = 'pending' AND NEW.status = 'active'
          AND TRIM(COALESCE(NEW.activated_at, '')) <> ''
          AND NEW.completed_at IS OLD.completed_at
          AND NEW.completed_by IS OLD.completed_by
          AND NEW.completion_note IS OLD.completion_note
          AND NEW.completion_request_id IS OLD.completion_request_id
          AND NOT EXISTS (
            SELECT 1 FROM custom_process_run_steps active_step
            WHERE active_step.run_id = OLD.run_id AND active_step.status = 'active'
              AND active_step.step_id <> OLD.step_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM custom_process_run_steps previous_step
            WHERE previous_step.run_id = OLD.run_id
              AND previous_step.sort_order < OLD.sort_order
              AND previous_step.status <> 'completed'
          ))
        OR (OLD.status = 'active' AND NEW.status = 'completed'
          AND NEW.activated_at IS OLD.activated_at
          AND TRIM(COALESCE(NEW.completed_at, '')) <> ''
          AND TRIM(COALESCE(NEW.completed_by, '')) <> ''
          AND NEW.completion_note = ''
          AND length(NEW.completion_request_id) = 64
          AND NEW.completion_request_id = lower(NEW.completion_request_id)
          AND NEW.completion_request_id NOT GLOB '*[^0-9a-f]*'
          AND EXISTS (
            SELECT 1
            FROM personnel_lifecycle_offboarding_assignment_bindings assignment_binding
            JOIN personnel_lifecycle_case_assignments assignment
              ON assignment.id = assignment_binding.assignment_id
            WHERE assignment_binding.run_id = OLD.run_id
              AND assignment_binding.step_reference = OLD.step_id
              AND assignment.assignee_actor_id = NEW.completed_by
          ))
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 run step transition is invalid');
    END;
  `),
  definition("trg_custom_process_run_steps_o5_delete_blocked", `
    CREATE TRIGGER IF NOT EXISTS trg_custom_process_run_steps_o5_delete_blocked
    BEFORE DELETE ON custom_process_run_steps
    WHEN EXISTS (
      SELECT 1 FROM personnel_lifecycle_offboarding_package_runs package_run
      WHERE package_run.run_id = OLD.run_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'personnel lifecycle O5 run steps cannot be deleted');
    END;
  `),
]);

const PERSONNEL_LIFECYCLE_OFFBOARDING_TRIGGER_DEFINITIONS = Object.freeze([
  ...PRESERVED_O4_TRIGGER_DEFINITIONS,
  ...PERSONNEL_LIFECYCLE_OFFBOARDING_OWN_TRIGGER_DEFINITIONS,
]);
const PERSONNEL_LIFECYCLE_OFFBOARDING_TRIGGER_NAMES = Object.freeze(
  PERSONNEL_LIFECYCLE_OFFBOARDING_TRIGGER_DEFINITIONS.map(({ name }) => name),
);

const PERSONNEL_LIFECYCLE_OFFBOARDING_REQUIRED_TABLES = Object.freeze([
  ...PERSONNEL_LIFECYCLE_CASE_TABLE_NAMES,
  ...PERSONNEL_LIFECYCLE_ONBOARDING_TABLE_NAMES,
  "custom_processes",
  "custom_process_steps",
  "custom_process_revisions",
  "custom_process_publications",
  "custom_process_publication_archives",
  "custom_process_runs",
  "custom_process_run_steps",
  "custom_process_run_bindings",
  "custom_process_run_step_assignments",
  "portal_users",
  "employees",
  "locations",
  "departments",
]);

function normalizeDefinitionSql(sql, type) {
  let normalized = String(sql || "").trim().replace(/\s+/g, " ")
    .replace(/\s*;\s*$/, "").toLowerCase();
  if (type === "table") normalized = normalized.replace(/^create table if not exists /i, "create table ");
  else if (type === "trigger") normalized = normalized.replace(/^create trigger if not exists /i, "create trigger ");
  else if (type === "index") {
    normalized = normalized.replace(
      /^create (unique )?index if not exists /i,
      (_, unique) => `create ${unique || ""}index `,
    );
  }
  return normalized;
}

function sqliteObject(database, type, name) {
  return database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = ? AND name = ?",
  ).get(type, name);
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
  return Object.freeze({ missing: Object.freeze(missing), invalid: Object.freeze(invalid) });
}

function inspectSqlitePersonnelLifecycleOffboardingSchema(database) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Inspektionsdatenbank wird benoetigt.");
  }
  const baseTables = inspectDefinitions(
    database,
    "table",
    [...PERSONNEL_LIFECYCLE_CASE_TABLE_DEFINITIONS, ...PERSONNEL_LIFECYCLE_ONBOARDING_TABLE_DEFINITIONS],
  );
  const tables = inspectDefinitions(
    database,
    "table",
    PERSONNEL_LIFECYCLE_OFFBOARDING_TABLE_DEFINITIONS,
  );
  const indexes = inspectDefinitions(
    database,
    "index",
    [...PERSONNEL_LIFECYCLE_ONBOARDING_INDEX_DEFINITIONS,
      ...PERSONNEL_LIFECYCLE_OFFBOARDING_INDEX_DEFINITIONS],
  );
  const triggers = inspectDefinitions(
    database,
    "trigger",
    PERSONNEL_LIFECYCLE_OFFBOARDING_TRIGGER_DEFINITIONS,
  );
  const staleO4Triggers = [...O5_REPLACED_O4_TRIGGER_NAMES]
    .filter((name) => sqliteObject(database, "trigger", name));
  const issues = Object.freeze([
    ...baseTables.missing.map((name) => `base-table-missing:${name}`),
    ...baseTables.invalid.map((name) => `base-table-invalid:${name}`),
    ...tables.missing.map((name) => `table-missing:${name}`),
    ...tables.invalid.map((name) => `table-invalid:${name}`),
    ...indexes.missing.map((name) => `index-missing:${name}`),
    ...indexes.invalid.map((name) => `index-invalid:${name}`),
    ...triggers.missing.map((name) => `trigger-missing:${name}`),
    ...triggers.invalid.map((name) => `trigger-invalid:${name}`),
    ...staleO4Triggers.map((name) => `o4-trigger-still-active:${name}`),
  ]);
  return Object.freeze({
    valid: issues.length === 0,
    absent: tables.missing.length === PERSONNEL_LIFECYCLE_OFFBOARDING_TABLE_DEFINITIONS.length,
    issues,
    missingTables: tables.missing,
    invalidTables: tables.invalid,
    missingIndexes: indexes.missing,
    invalidIndexes: indexes.invalid,
    missingTriggers: triggers.missing,
    invalidTriggers: triggers.invalid,
    staleO4Triggers: Object.freeze(staleO4Triggers),
  });
}

function countRows(database, tableName) {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM "${tableName}"`).get().count || 0);
}

function inspectSqlitePersonnelLifecycleOffboardingRows(database) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Inspektionsdatenbank wird benoetigt.");
  }
  const schema = inspectSqlitePersonnelLifecycleOffboardingSchema(database);
  if (schema.absent) return Object.freeze({ valid: true, absent: true, issues: Object.freeze([]) });
  if (!schema.valid) return Object.freeze({ valid: false, absent: false, issues: Object.freeze(["schema-invalid"]) });
  const issues = [];
  for (const tableName of [
    ...PERSONNEL_LIFECYCLE_CASE_TABLE_NAMES,
    ...PERSONNEL_LIFECYCLE_ONBOARDING_TABLE_NAMES,
    ...PERSONNEL_LIFECYCLE_OFFBOARDING_TABLE_NAMES,
  ]) {
    for (const violation of database.prepare(`PRAGMA foreign_key_check("${tableName}")`).all()) {
      issues.push(`foreign-key:${tableName}:${violation.rowid ?? "unknown"}`);
    }
  }
  const protectedColumns = [
    ["personnel_lifecycle_offboarding_package_versions", "protected_snapshot"],
    ["personnel_lifecycle_offboarding_package_version_archives", "protected_payload"],
    ["personnel_lifecycle_offboarding_operations", "protected_result_payload"],
    ["personnel_lifecycle_offboarding_runtime_steps", "protected_payload"],
    ["personnel_lifecycle_offboarding_run_terminations", "protected_payload"],
  ];
  for (const [tableName, columnName] of protectedColumns) {
    const invalid = Number(database.prepare(`
      SELECT COUNT(*) AS count FROM "${tableName}"
      WHERE "${columnName}" NOT LIKE 'enc:v2:%'
    `).get().count || 0);
    if (invalid) issues.push(`protected-envelope:${tableName}:${invalid}`);
  }
  const protectedOffboardingRows = [
    ["case", `SELECT COUNT(*) AS count
      FROM personnel_lifecycle_cases
      WHERE case_type = 'offboarding' AND protected_payload NOT LIKE 'enc:v2:%'`],
    ["episode", `SELECT COUNT(DISTINCT episode.id) AS count
      FROM personnel_employment_episodes episode
      JOIN personnel_lifecycle_cases lifecycle_case
        ON lifecycle_case.employment_episode_id = episode.id
      WHERE lifecycle_case.case_type = 'offboarding'
        AND episode.protected_payload NOT LIKE 'enc:v2:%'`],
    ["reference", `SELECT COUNT(*) AS count
      FROM personnel_lifecycle_case_reference_dates reference
      JOIN personnel_lifecycle_cases lifecycle_case ON lifecycle_case.id = reference.case_id
      WHERE lifecycle_case.case_type = 'offboarding'
        AND reference.protected_payload NOT LIKE 'enc:v2:%'`],
    ["event", `SELECT COUNT(*) AS count
      FROM personnel_lifecycle_case_events event
      JOIN personnel_lifecycle_cases lifecycle_case ON lifecycle_case.id = event.case_id
      WHERE lifecycle_case.case_type = 'offboarding'
        AND event.protected_payload NOT LIKE 'enc:v2:%'`],
  ];
  for (const [label, sql] of protectedOffboardingRows) {
    const invalid = Number(database.prepare(sql).get().count || 0);
    if (invalid) issues.push(`protected-envelope:offboarding-${label}:${invalid}`);
  }
  const operationRows = database.prepare(`
    SELECT operation.*, episode.employee_number
    FROM personnel_lifecycle_offboarding_operations operation
    JOIN personnel_lifecycle_cases lifecycle_case ON lifecycle_case.id = operation.case_id
    JOIN personnel_employment_episodes episode
      ON episode.id = lifecycle_case.employment_episode_id
    ORDER BY operation.occurred_at, operation.operation_id
  `).all();
  const taskSubjectExists = database.prepare(`
    SELECT 1
    FROM personnel_lifecycle_offboarding_package_bindings binding
    JOIN personnel_lifecycle_offboarding_package_runs package_run
      ON package_run.package_binding_id = binding.id
    JOIN personnel_lifecycle_offboarding_runtime_steps runtime_step
      ON runtime_step.run_id = package_run.run_id
    WHERE binding.case_id = ?
      AND runtime_step.run_id || ':' || runtime_step.step_reference = ?
    LIMIT 1
  `);
  for (const row of operationRows) {
    if (personnelLifecycleOffboardingOperationReceiptSha256(row)
      !== row.result_receipt_sha256) {
      issues.push(`operation-receipt:${row.operation_id}`);
    }
    if ((row.operation_type === "prepare" && row.subject_key !== row.employee_number)
      || (row.operation_type === "task_complete"
        && !taskSubjectExists.get(row.case_id, row.subject_key))
      || (!["prepare", "task_complete"].includes(row.operation_type)
        && row.subject_key !== row.case_id)) {
      issues.push(`operation-subject:${row.operation_id}`);
    }
  }
  for (const row of database.prepare(`
    SELECT * FROM personnel_lifecycle_offboarding_package_versions
    ORDER BY published_at, id
  `).all()) {
    if (personnelLifecycleOffboardingPackageVersionReceiptSha256(row)
      !== row.receipt_sha256) {
      issues.push(`package-version-receipt:${row.id}`);
    }
  }
  for (const row of database.prepare(`
    SELECT * FROM personnel_lifecycle_offboarding_package_version_archives
    ORDER BY archived_at, package_version_id
  `).all()) {
    if (personnelLifecycleOffboardingPackageVersionArchiveReceiptSha256(row)
      !== row.receipt_sha256) {
      issues.push(`package-version-archive-receipt:${row.package_version_id}`);
    }
  }
  for (const row of database.prepare(`
    SELECT * FROM personnel_lifecycle_offboarding_package_bindings
    ORDER BY bound_at, id
  `).all()) {
    if (personnelLifecycleOffboardingPackageBindingReceiptSha256(row) !== row.receipt_sha256) {
      issues.push(`package-binding-receipt:${row.id}`);
    }
  }
  for (const row of database.prepare(`
    SELECT * FROM personnel_lifecycle_offboarding_package_runs
    ORDER BY linked_at, run_id
  `).all()) {
    if (personnelLifecycleOffboardingPackageRunReceiptSha256(row) !== row.receipt_sha256) {
      issues.push(`package-run-receipt:${row.run_id}`);
    }
  }
  for (const row of database.prepare(`
    SELECT * FROM personnel_lifecycle_offboarding_runtime_steps
    ORDER BY created_at, run_id, sort_order
  `).all()) {
    if (personnelLifecycleOffboardingRuntimeStepReceiptSha256(row) !== row.receipt_sha256) {
      issues.push(`runtime-step-receipt:${row.run_id}:${row.step_reference}`);
    }
  }
  for (const row of database.prepare(`
    SELECT assignment.*, assignment_binding.package_binding_id,
      assignment_binding.run_id
    FROM personnel_lifecycle_case_assignments assignment
    JOIN personnel_lifecycle_offboarding_assignment_bindings assignment_binding
      ON assignment_binding.assignment_id = assignment.id
    JOIN personnel_lifecycle_cases lifecycle_case ON lifecycle_case.id = assignment.case_id
    WHERE lifecycle_case.case_type = 'offboarding'
    ORDER BY assignment.assigned_at, assignment.id
  `).all()) {
    if (personnelLifecycleOffboardingAssignmentReceiptSha256(row) !== row.receipt_sha256) {
      issues.push(`assignment-receipt:${row.id}`);
    }
  }
  const unlinkedAssignmentCount = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM personnel_lifecycle_case_assignments assignment
    JOIN personnel_lifecycle_cases lifecycle_case ON lifecycle_case.id = assignment.case_id
    LEFT JOIN personnel_lifecycle_offboarding_assignment_bindings assignment_binding
      ON assignment_binding.assignment_id = assignment.id
    WHERE lifecycle_case.case_type = 'offboarding'
      AND assignment_binding.assignment_id IS NULL
  `).get().count || 0);
  if (unlinkedAssignmentCount) {
    issues.push(`unlinked-offboarding-assignment:${unlinkedAssignmentCount}`);
  }
  for (const row of database.prepare(`
    SELECT * FROM personnel_lifecycle_offboarding_assignment_bindings
    ORDER BY bound_at, assignment_id
  `).all()) {
    if (personnelLifecycleOffboardingAssignmentBindingReceiptSha256(row)
      !== row.receipt_sha256) {
      issues.push(`assignment-binding-receipt:${row.assignment_id}`);
    }
  }
  for (const row of database.prepare(`
    SELECT * FROM personnel_lifecycle_offboarding_run_terminations
    ORDER BY terminated_at, run_id
  `).all()) {
    if (personnelLifecycleOffboardingRunTerminationReceiptSha256(row)
      !== row.receipt_sha256) {
      issues.push(`run-termination-receipt:${row.run_id}`);
    }
  }
  for (const row of database.prepare(`
    SELECT reference.*
    FROM personnel_lifecycle_case_reference_dates reference
    JOIN personnel_lifecycle_cases lifecycle_case ON lifecycle_case.id = reference.case_id
    WHERE lifecycle_case.case_type = 'offboarding'
    ORDER BY reference.case_id, reference.revision
  `).all()) {
    if (personnelLifecycleOffboardingReferenceDatesReceiptSha256(row)
      !== row.receipt_sha256) {
      issues.push(`reference-dates-receipt:${row.id}`);
    }
  }
  for (const row of database.prepare(`
    SELECT * FROM personnel_lifecycle_cases WHERE case_type = 'offboarding'
    ORDER BY created_at, id
  `).all()) {
    if (personnelLifecycleOffboardingScopeSnapshotSha256(row)
      !== row.scope_snapshot_sha256) {
      issues.push(`case-scope-receipt:${row.id}`);
    }
  }
  const confidentialAccessRows = database.prepare(`
    SELECT * FROM personnel_lifecycle_confidential_access_events
    ORDER BY case_id, sequence_number
  `).all();
  for (const row of confidentialAccessRows) {
    if (personnelLifecycleOffboardingConfidentialAccessReceiptSha256(row)
      !== row.receipt_sha256) {
      issues.push(`confidential-access-receipt:${row.id}`);
    }
  }
  const caseEventRows = database.prepare(`
    SELECT event.*
    FROM personnel_lifecycle_case_events event
    JOIN personnel_lifecycle_cases lifecycle_case ON lifecycle_case.id = event.case_id
    WHERE lifecycle_case.case_type = 'offboarding'
    ORDER BY event.case_id, event.sequence_number
  `).all();
  for (const row of caseEventRows) {
    if (personnelLifecycleOffboardingCaseEventReceiptSha256(row) !== row.receipt_sha256) {
      issues.push(`case-event-receipt:${row.id}`);
    }
  }
  function inspectReceiptChain(rows, label) {
    const byCase = new Map();
    for (const row of rows) {
      if (!byCase.has(row.case_id)) byCase.set(row.case_id, []);
      byCase.get(row.case_id).push(row);
    }
    for (const [caseId, caseRows] of byCase) {
      let previousReceiptSha256 = "";
      for (let index = 0; index < caseRows.length; index += 1) {
        const row = caseRows[index];
        if (Number(row.sequence_number) !== index + 1
          || String(row.previous_receipt_sha256 || "") !== previousReceiptSha256) {
          issues.push(`${label}-chain:${caseId}:${row.id}`);
        }
        previousReceiptSha256 = row.receipt_sha256;
      }
    }
  }
  inspectReceiptChain(caseEventRows, "case-event");
  inspectReceiptChain(confidentialAccessRows, "confidential-access");
  const caseEventById = new Map(caseEventRows.map((row) => [row.id, row]));
  const expectedEventIds = new Set();
  for (const operation of operationRows) {
    const eventType = OFFBOARDING_EVENT_TYPE_BY_OPERATION[operation.operation_type];
    const eventId = deterministicUuidV4(
      "personnel-lifecycle-offboarding-event",
      eventType,
      operation.operation_id,
    );
    expectedEventIds.add(eventId);
    const event = caseEventById.get(eventId);
    if (!event || event.case_id !== operation.case_id || event.event_type !== eventType
      || event.data_classification !== "offboarding_strict_confidential"
      || event.actor_id !== operation.actor_id || event.occurred_at !== operation.occurred_at) {
      issues.push(`operation-event:${operation.operation_id}`);
    }
  }
  for (const event of caseEventRows) {
    if (!expectedEventIds.has(event.id)) issues.push(`orphan-case-event:${event.id}`);
  }
  const invalidManifestCount = database.prepare(`
    SELECT family_code, runtime_manifest_sha256
    FROM personnel_lifecycle_offboarding_package_versions
  `).all().filter((row) => (
    row.runtime_manifest_sha256
      !== OFFBOARDING_RUNTIME_MANIFEST_SHA256_BY_FAMILY.get(row.family_code)
  )).length;
  if (invalidManifestCount) issues.push(`runtime-manifest:${invalidManifestCount}`);
  const bindingScopeDriftCount = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM personnel_lifecycle_offboarding_package_bindings binding
    JOIN personnel_lifecycle_cases lifecycle_case ON lifecycle_case.id = binding.case_id
    WHERE binding.scope_snapshot_sha256 <> lifecycle_case.scope_snapshot_sha256
  `).get().count || 0);
  if (bindingScopeDriftCount) issues.push(`binding-scope-drift:${bindingScopeDriftCount}`);
  const runBindingDriftCount = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM personnel_lifecycle_offboarding_package_runs package_run
    JOIN personnel_lifecycle_offboarding_package_bindings binding
      ON binding.id = package_run.package_binding_id
    JOIN personnel_lifecycle_offboarding_package_versions version
      ON version.id = binding.package_version_id
    WHERE package_run.scope_snapshot_sha256 <> binding.scope_snapshot_sha256
      OR package_run.runtime_manifest_sha256 <> version.runtime_manifest_sha256
  `).get().count || 0);
  if (runBindingDriftCount) issues.push(`run-binding-drift:${runBindingDriftCount}`);
  const customRunCoreDriftCount = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM personnel_lifecycle_offboarding_package_runs package_run
    JOIN personnel_lifecycle_offboarding_package_bindings binding
      ON binding.id = package_run.package_binding_id
    JOIN personnel_lifecycle_offboarding_package_versions version
      ON version.id = binding.package_version_id
    JOIN personnel_lifecycle_cases lifecycle_case ON lifecycle_case.id = binding.case_id
    JOIN custom_process_runs run ON run.id = package_run.run_id
    WHERE run.process_id <> version.runtime_process_id
      OR run.process_revision <> version.version_number
      OR run.trigger_type <> 'personnel_lifecycle_offboarding'
      OR run.trigger_key <> 'personnel-offboarding:' || package_run.run_operation_id
      OR run.status NOT IN ('open','resolved')
      OR run.activation_count <> 1
      OR run.location_id <> lifecycle_case.location_id
      OR run.department_id IS NOT lifecycle_case.department_id
  `).get().count || 0);
  if (customRunCoreDriftCount) issues.push(`custom-run-core-drift:${customRunCoreDriftCount}`);
  const runtimeStepFamilyDriftCount = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM personnel_lifecycle_offboarding_runtime_steps runtime_step
    JOIN personnel_lifecycle_offboarding_package_bindings binding
      ON binding.id = runtime_step.package_binding_id
    JOIN personnel_lifecycle_offboarding_package_versions version
      ON version.id = binding.package_version_id
    WHERE runtime_step.step_reference <> CASE version.family_code
        ${OFFBOARDING_STEP_FOR_FAMILY_SQL} ELSE '' END
      OR runtime_step.order_reference <> CASE version.family_code
        ${OFFBOARDING_ORDER_FOR_FAMILY_SQL} ELSE '' END
      OR runtime_step.recipient_class <> CASE version.family_code
        ${OFFBOARDING_RECIPIENT_FOR_FAMILY_SQL} ELSE '' END
      OR runtime_step.sort_order <> 1
      OR runtime_step.release_gate <> 'communication_released'
      OR runtime_step.data_classification <> 'personal_restricted'
  `).get().count || 0);
  if (runtimeStepFamilyDriftCount) {
    issues.push(`runtime-step-family-drift:${runtimeStepFamilyDriftCount}`);
  }
  const assignmentRelationDriftCount = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM personnel_lifecycle_offboarding_assignment_bindings assignment_binding
    JOIN personnel_lifecycle_case_assignments assignment
      ON assignment.id = assignment_binding.assignment_id
    JOIN personnel_lifecycle_offboarding_package_bindings binding
      ON binding.id = assignment_binding.package_binding_id
    WHERE assignment.case_id <> binding.case_id
      OR assignment.step_reference <> assignment_binding.step_reference
  `).get().count || 0);
  if (assignmentRelationDriftCount) {
    issues.push(`assignment-relation-drift:${assignmentRelationDriftCount}`);
  }
  const terminationRelationDriftCount = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM personnel_lifecycle_offboarding_run_terminations termination
    JOIN personnel_lifecycle_offboarding_package_runs package_run
      ON package_run.run_id = termination.run_id
    JOIN personnel_lifecycle_offboarding_package_bindings binding
      ON binding.id = package_run.package_binding_id
    LEFT JOIN personnel_lifecycle_offboarding_operations operation
      ON operation.operation_id = termination.operation_id
      AND operation.case_id = termination.case_id
      AND operation.operation_type = 'cancellation'
    WHERE termination.case_id <> binding.case_id OR operation.operation_id IS NULL
  `).get().count || 0);
  if (terminationRelationDriftCount) {
    issues.push(`termination-relation-drift:${terminationRelationDriftCount}`);
  }
  const reservedRunOrphanCount = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM custom_process_runs run
    LEFT JOIN personnel_lifecycle_offboarding_package_runs package_run
      ON package_run.run_id = run.id
    WHERE run.trigger_type = 'personnel_lifecycle_offboarding'
      AND package_run.run_id IS NULL
  `).get().count || 0);
  if (reservedRunOrphanCount) issues.push(`reserved-run-orphan:${reservedRunOrphanCount}`);
  const extraRunStepCount = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM personnel_lifecycle_offboarding_package_runs package_run
    JOIN custom_process_run_steps run_step ON run_step.run_id = package_run.run_id
    LEFT JOIN personnel_lifecycle_offboarding_runtime_steps runtime_step
      ON runtime_step.run_id = run_step.run_id
      AND runtime_step.step_reference = run_step.step_id
      AND runtime_step.sort_order = run_step.sort_order
    WHERE runtime_step.run_id IS NULL
  `).get().count || 0);
  if (extraRunStepCount) issues.push(`extra-run-step:${extraRunStepCount}`);
  const runtimeShellCoreDriftCount = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM personnel_lifecycle_offboarding_package_versions version
    JOIN custom_processes process ON process.id = version.runtime_process_id
    WHERE process.title <> 'Geschützter Personalprozess'
      OR process.symbol <> 'P'
      OR process.description <> ''
      OR process.category <> 'other'
      OR process.scope_type <> 'company'
      OR process.location_id IS NOT NULL
      OR process.department_id IS NOT NULL
      OR process.trigger_type <> 'manual'
      OR process.trigger_minimum_shortfall <> 1
      OR process.status <> 'active'
      OR process.revision <> version.version_number
      OR process.archived_at IS NOT NULL
  `).get().count || 0);
  if (runtimeShellCoreDriftCount) {
    issues.push(`runtime-shell-core-drift:${runtimeShellCoreDriftCount}`);
  }
  const versionChainDriftCount = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM personnel_lifecycle_offboarding_package_versions version
    LEFT JOIN personnel_lifecycle_offboarding_package_versions predecessor
      ON predecessor.id = version.predecessor_version_id
    WHERE NOT (
      (version.version_number = 1 AND version.predecessor_version_id IS NULL)
      OR (version.version_number > 1
        AND predecessor.id IS NOT NULL
        AND predecessor.series_id = version.series_id
        AND predecessor.version_number = version.version_number - 1
        AND predecessor.family_code = version.family_code)
    )
  `).get().count || 0);
  if (versionChainDriftCount) issues.push(`version-chain-drift:${versionChainDriftCount}`);
  const runtimeShellChildCount = Number(database.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT process_step.process_id, 'step' AS child_kind
      FROM custom_process_steps process_step
      JOIN personnel_lifecycle_offboarding_package_versions version
        ON version.runtime_process_id = process_step.process_id
      UNION ALL
      SELECT process_revision.process_id, 'revision'
      FROM custom_process_revisions process_revision
      JOIN personnel_lifecycle_offboarding_package_versions version
        ON version.runtime_process_id = process_revision.process_id
      UNION ALL
      SELECT publication.process_id, 'publication'
      FROM custom_process_publications publication
      JOIN personnel_lifecycle_offboarding_package_versions version
        ON version.runtime_process_id = publication.process_id
    )
  `).get().count || 0);
  if (runtimeShellChildCount) issues.push(`runtime-shell-child:${runtimeShellChildCount}`);
  const relationRows = database.prepare(`
    SELECT lifecycle_case.id AS case_id, lifecycle_case.state AS case_state,
      episode.state AS episode_state,
      COUNT(DISTINCT binding.id) AS binding_count,
      COUNT(DISTINCT version.family_code) AS family_count,
      COUNT(DISTINCT package_run.run_id) AS run_count,
      COUNT(DISTINCT runtime_step.run_id || ':' || runtime_step.step_reference)
        AS runtime_step_count,
      COUNT(DISTINCT run_step.run_id || ':' || run_step.step_id) AS run_step_count,
      COUNT(DISTINCT CASE WHEN run.status = 'open' THEN run.id END) AS open_run_count,
      COUNT(DISTINCT CASE WHEN run.status = 'resolved' THEN run.id END) AS resolved_run_count,
      SUM(CASE WHEN run_step.status = 'active' THEN 1 ELSE 0 END) AS active_step_count,
      SUM(CASE WHEN run_step.status = 'pending' THEN 1 ELSE 0 END) AS pending_step_count,
      SUM(CASE WHEN run_step.status = 'skipped' THEN 1 ELSE 0 END) AS skipped_step_count,
      SUM(CASE WHEN run_step.status <> 'completed' THEN 1 ELSE 0 END) AS unfinished_step_count,
      COUNT(DISTINCT CASE WHEN run_step.status <> 'completed' THEN run.id END)
        AS unfinished_run_count,
      COUNT(DISTINCT termination.run_id) AS termination_count,
      (SELECT COUNT(*) FROM personnel_lifecycle_offboarding_operations operation
        WHERE operation.case_id = lifecycle_case.id
          AND operation.operation_type = 'prepare') AS prepare_operation_count,
      (SELECT COUNT(*) FROM personnel_lifecycle_offboarding_operations operation
        WHERE operation.case_id = lifecycle_case.id
          AND operation.operation_type = 'communication_release') AS release_operation_count,
      (SELECT COUNT(*) FROM personnel_lifecycle_offboarding_operations operation
        WHERE operation.case_id = lifecycle_case.id
          AND operation.operation_type = 'information_confirmation') AS information_operation_count,
      (SELECT COUNT(*) FROM personnel_lifecycle_offboarding_operations operation
        WHERE operation.case_id = lifecycle_case.id
          AND operation.operation_type = 'activation') AS activate_operation_count,
      (SELECT COUNT(*) FROM personnel_lifecycle_offboarding_operations operation
        WHERE operation.case_id = lifecycle_case.id
          AND operation.operation_type = 'cancellation') AS cancel_operation_count,
      (SELECT COUNT(*) FROM personnel_lifecycle_offboarding_operations operation
        WHERE operation.case_id = lifecycle_case.id
          AND operation.operation_type = 'close') AS close_operation_count
      ,(SELECT COUNT(*) FROM personnel_lifecycle_case_reference_dates reference
        WHERE reference.case_id = lifecycle_case.id) AS reference_date_count
    FROM personnel_lifecycle_cases lifecycle_case
    JOIN personnel_employment_episodes episode
      ON episode.id = lifecycle_case.employment_episode_id
    LEFT JOIN personnel_lifecycle_offboarding_package_bindings binding
      ON binding.case_id = lifecycle_case.id
    LEFT JOIN personnel_lifecycle_offboarding_package_runs package_run
      ON package_run.package_binding_id = binding.id
    LEFT JOIN personnel_lifecycle_offboarding_package_versions version
      ON version.id = binding.package_version_id
    LEFT JOIN custom_process_runs run ON run.id = package_run.run_id
    LEFT JOIN personnel_lifecycle_offboarding_runtime_steps runtime_step
      ON runtime_step.run_id = package_run.run_id
    LEFT JOIN custom_process_run_steps run_step
      ON run_step.run_id = runtime_step.run_id
      AND run_step.step_id = runtime_step.step_reference
    LEFT JOIN personnel_lifecycle_offboarding_run_terminations termination
      ON termination.run_id = package_run.run_id
    WHERE lifecycle_case.case_type = 'offboarding'
    GROUP BY lifecycle_case.id, lifecycle_case.state, episode.state
  `).all();
  for (const row of relationRows) {
    const state = row.case_state;
    const bindings = Number(row.binding_count || 0);
    const runs = Number(row.run_count || 0);
    const families = Number(row.family_count || 0);
    const runtimeSteps = Number(row.runtime_step_count || 0);
    const runSteps = Number(row.run_step_count || 0);
    const openRuns = Number(row.open_run_count || 0);
    const activeSteps = Number(row.active_step_count || 0);
    const pendingSteps = Number(row.pending_step_count || 0);
    const skippedSteps = Number(row.skipped_step_count || 0);
    const unfinished = Number(row.unfinished_step_count || 0);
    const unfinishedRuns = Number(row.unfinished_run_count || 0);
    const terminations = Number(row.termination_count || 0);
    const preparedOperation = Number(row.prepare_operation_count || 0) === 1;
    const releaseOperation = Number(row.release_operation_count || 0) === 1;
    const informationOperation = Number(row.information_operation_count || 0) === 1;
    const activateOperation = Number(row.activate_operation_count || 0) === 1;
    const cancelOperation = Number(row.cancel_operation_count || 0) === 1;
    const closeOperation = Number(row.close_operation_count || 0) === 1;
    const referenceDates = Number(row.reference_date_count || 0);
    if (referenceDates !== 1) {
      issues.push(`reference-dates-cardinality:${row.case_id}:${referenceDates}`);
    }
    if (skippedSteps) issues.push(`offboarding-skip:${row.case_id}:${skippedSteps}`);
    if (state === "internally_prepared") {
      if (row.episode_state !== "employment_active" || bindings || runs
        || !preparedOperation || releaseOperation || informationOperation
        || activateOperation || cancelOperation || closeOperation) {
        issues.push(`prepared-runtime-leak:${row.case_id}`);
      }
    } else if (state === "communication_released") {
      if (row.episode_state !== "exit_in_progress"
        || bindings !== PERSONNEL_LIFECYCLE_OFFBOARDING_REQUIRED_PACKAGE_FAMILIES.length
        || families !== bindings || bindings !== runs || runtimeSteps !== runs
        || runSteps !== runs || openRuns !== runs || pendingSteps !== runs
        || activeSteps || terminations
        || !preparedOperation || !releaseOperation || informationOperation
        || activateOperation || cancelOperation || closeOperation) {
        issues.push(`pending-release-state:${row.case_id}`);
      }
    } else if (state === "employee_informed") {
      if (row.episode_state !== "exit_in_progress"
        || bindings !== PERSONNEL_LIFECYCLE_OFFBOARDING_REQUIRED_PACKAGE_FAMILIES.length
        || families !== bindings || bindings !== runs || runtimeSteps !== runs
        || runSteps !== runs || openRuns !== runs || pendingSteps !== runs
        || activeSteps || terminations
        || !preparedOperation || !releaseOperation || !informationOperation
        || activateOperation || cancelOperation || closeOperation) {
        issues.push(`pending-information-state:${row.case_id}`);
      }
    } else if (state === "active") {
      if (row.episode_state !== "exit_in_progress"
        || bindings !== PERSONNEL_LIFECYCLE_OFFBOARDING_REQUIRED_PACKAGE_FAMILIES.length
        || families !== bindings || bindings !== runs || runtimeSteps !== runs
        || runSteps !== runs || pendingSteps || terminations
        || (openRuns > 0 && activeSteps !== openRuns)
        || !preparedOperation || !releaseOperation || !informationOperation
        || !activateOperation || cancelOperation || closeOperation) {
        issues.push(`active-runtime-state:${row.case_id}`);
      }
    } else if (state === "completed") {
      if (row.episode_state !== "employment_ended"
        || bindings !== PERSONNEL_LIFECYCLE_OFFBOARDING_REQUIRED_PACKAGE_FAMILIES.length
        || families !== bindings || bindings !== runs || runtimeSteps !== runs
        || runSteps !== runs
        || openRuns || unfinished || terminations
        || !preparedOperation || !releaseOperation || !informationOperation
        || !activateOperation || cancelOperation || !closeOperation) {
        issues.push(`completed-runtime-state:${row.case_id}`);
      }
    } else if (state === "cancelled") {
      if (row.episode_state !== "employment_active" || openRuns
        || (bindings > 0 && (
          bindings !== PERSONNEL_LIFECYCLE_OFFBOARDING_REQUIRED_PACKAGE_FAMILIES.length
          || families !== bindings || bindings !== runs || runtimeSteps !== runs
          || runSteps !== runs
        ))
        || terminations !== unfinishedRuns
        || !preparedOperation || !cancelOperation || closeOperation) {
        issues.push(`cancelled-runtime-state:${row.case_id}`);
      }
    }
  }
  const orphanRuntimeSteps = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM personnel_lifecycle_offboarding_runtime_steps runtime_step
    LEFT JOIN custom_process_run_steps run_step
      ON run_step.run_id = runtime_step.run_id
      AND run_step.step_id = runtime_step.step_reference
      AND run_step.sort_order = runtime_step.sort_order
    WHERE run_step.run_id IS NULL
  `).get().count || 0);
  if (orphanRuntimeSteps) issues.push(`runtime-step-link:${orphanRuntimeSteps}`);
  const genericBindings = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM personnel_lifecycle_offboarding_package_runs package_run
    JOIN custom_process_run_bindings generic_binding ON generic_binding.run_id = package_run.run_id
  `).get().count || 0);
  if (genericBindings) issues.push(`generic-binding:${genericBindings}`);
  const genericAssignments = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM personnel_lifecycle_offboarding_package_runs package_run
    JOIN custom_process_run_step_assignments generic_assignment
      ON generic_assignment.run_id = package_run.run_id
  `).get().count || 0);
  if (genericAssignments) issues.push(`generic-assignment:${genericAssignments}`);
  const planChainViolations = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM personnel_lifecycle_offboarding_operations operation
    LEFT JOIN personnel_lifecycle_offboarding_operations preparation
      ON preparation.case_id = operation.case_id
      AND preparation.operation_type = 'prepare'
    WHERE operation.operation_type <> 'prepare'
      AND (
        preparation.operation_id IS NULL
        OR preparation.plan_receipt_sha256 <> operation.plan_receipt_sha256
      )
  `).get().count || 0);
  if (planChainViolations) issues.push(`operation-plan-chain:${planChainViolations}`);
  const missingTaskLedgers = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM personnel_lifecycle_offboarding_runtime_steps runtime_step
    JOIN personnel_lifecycle_offboarding_package_runs package_run
      ON package_run.run_id = runtime_step.run_id
    JOIN personnel_lifecycle_offboarding_package_bindings binding
      ON binding.id = package_run.package_binding_id
    JOIN custom_process_run_steps run_step
      ON run_step.run_id = runtime_step.run_id
      AND run_step.step_id = runtime_step.step_reference
    LEFT JOIN personnel_lifecycle_offboarding_operations operation
      ON operation.case_id = binding.case_id
      AND operation.operation_type = 'task_complete'
      AND operation.subject_key = runtime_step.run_id || ':' || runtime_step.step_reference
      AND operation.request_sha256 = run_step.completion_request_id
      AND operation.actor_id = run_step.completed_by
    WHERE run_step.status = 'completed' AND operation.operation_id IS NULL
  `).get().count || 0);
  if (missingTaskLedgers) issues.push(`task-ledger-missing:${missingTaskLedgers}`);
  const orphanTaskLedgers = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM personnel_lifecycle_offboarding_operations operation
    WHERE operation.operation_type = 'task_complete'
      AND NOT EXISTS (
        SELECT 1
        FROM personnel_lifecycle_offboarding_package_bindings binding
        JOIN personnel_lifecycle_offboarding_package_runs package_run
          ON package_run.package_binding_id = binding.id
        JOIN personnel_lifecycle_offboarding_runtime_steps runtime_step
          ON runtime_step.run_id = package_run.run_id
        JOIN custom_process_run_steps run_step
          ON run_step.run_id = runtime_step.run_id
          AND run_step.step_id = runtime_step.step_reference
        WHERE binding.case_id = operation.case_id
          AND operation.subject_key = runtime_step.run_id || ':' || runtime_step.step_reference
          AND run_step.status = 'completed'
          AND run_step.completion_request_id = operation.request_sha256
          AND run_step.completed_by = operation.actor_id
      )
  `).get().count || 0);
  if (orphanTaskLedgers) issues.push(`task-ledger-orphan:${orphanTaskLedgers}`);
  return Object.freeze({ valid: issues.length === 0, absent: false, issues: Object.freeze(issues) });
}

function schemaError(code, message, details = []) {
  const error = new Error(message);
  error.code = code;
  error.details = Object.freeze([...details]);
  return error;
}

function ensureRequiredTables(database) {
  const missing = PERSONNEL_LIFECYCLE_OFFBOARDING_REQUIRED_TABLES.filter(
    (name) => !sqliteObject(database, "table", name),
  );
  if (missing.length) {
    throw schemaError(
      "PERSONNEL_LIFECYCLE_OFFBOARDING_SCHEMA_DEPENDENCY_MISSING",
      "Das O5-Offboarding-Schema kann ohne seine kanonischen Grundlagen nicht geoeffnet werden.",
      missing,
    );
  }
}

function offboardingDataExists(database) {
  const tableData = PERSONNEL_LIFECYCLE_OFFBOARDING_TABLE_NAMES.some(
    (name) => sqliteObject(database, "table", name) && countRows(database, name) > 0,
  );
  if (tableData) return true;
  return Boolean(database.prepare(`
    SELECT 1 FROM personnel_lifecycle_cases WHERE case_type = 'offboarding' LIMIT 1
  `).get()) || Boolean(database.prepare(`
    SELECT 1 FROM personnel_lifecycle_confidential_access_events LIMIT 1
  `).get());
}

function dropEmptyOffboardingSchema(database) {
  for (const { name } of PERSONNEL_LIFECYCLE_OFFBOARDING_TRIGGER_DEFINITIONS) {
    database.exec(`DROP TRIGGER IF EXISTS "${name}"`);
  }
  for (const { name } of PERSONNEL_LIFECYCLE_OFFBOARDING_INDEX_DEFINITIONS) {
    database.exec(`DROP INDEX IF EXISTS "${name}"`);
  }
  for (const name of [...PERSONNEL_LIFECYCLE_OFFBOARDING_TABLE_NAMES].reverse()) {
    database.exec(`DROP TABLE IF EXISTS "${name}"`);
  }
}

function ensureSqlitePersonnelLifecycleOffboardingSchema(database) {
  if (!database || typeof database.exec !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benoetigt.");
  }
  ensureRequiredTables(database);
  const current = inspectSqlitePersonnelLifecycleOffboardingSchema(database);
  if (current.valid) return current;
  if (!current.absent && offboardingDataExists(database)) {
    throw schemaError(
      "PERSONNEL_LIFECYCLE_OFFBOARDING_SCHEMA_DRIFT_WITH_DATA",
      "Ein abweichender O5-Stand mit Daten wird nicht automatisch repariert.",
      current.issues,
    );
  }
  const predecessorRows = inspectSqlitePersonnelLifecycleOnboardingRows(database);
  if (!predecessorRows.valid) {
    throw schemaError(
      "PERSONNEL_LIFECYCLE_OFFBOARDING_SCHEMA_PREDECESSOR_INVALID",
      "Der O4-Vorgaengerstand ist vor der O5-Migration nicht kanonisch.",
      predecessorRows.issues,
    );
  }
  database.exec("SAVEPOINT personnel_lifecycle_o5_schema");
  try {
    if (!current.absent) dropEmptyOffboardingSchema(database);
    for (const item of PERSONNEL_LIFECYCLE_OFFBOARDING_TABLE_DEFINITIONS) database.exec(item.sql);
    for (const item of O5_REPLACED_O4_TRIGGER_NAMES) {
      database.exec(`DROP TRIGGER IF EXISTS "${item}"`);
    }
    for (const item of PERSONNEL_LIFECYCLE_OFFBOARDING_INDEX_DEFINITIONS) database.exec(item.sql);
    for (const item of PERSONNEL_LIFECYCLE_OFFBOARDING_TRIGGER_DEFINITIONS) database.exec(item.sql);
    const result = inspectSqlitePersonnelLifecycleOffboardingSchema(database);
    if (!result.valid) {
      throw schemaError(
        "PERSONNEL_LIFECYCLE_OFFBOARDING_SCHEMA_INVALID",
        "Das O5-Offboarding-Schema konnte nicht kanonisch hergestellt werden.",
        result.issues,
      );
    }
    database.exec("RELEASE SAVEPOINT personnel_lifecycle_o5_schema");
    return result;
  } catch (error) {
    database.exec("ROLLBACK TO SAVEPOINT personnel_lifecycle_o5_schema");
    database.exec("RELEASE SAVEPOINT personnel_lifecycle_o5_schema");
    throw error;
  }
}

module.exports = {
  O5_REPLACED_O4_TRIGGER_NAMES: Object.freeze([...O5_REPLACED_O4_TRIGGER_NAMES]),
  PERSONNEL_LIFECYCLE_OFFBOARDING_INDEX_DEFINITIONS,
  PERSONNEL_LIFECYCLE_OFFBOARDING_MIGRATION_ID,
  PERSONNEL_LIFECYCLE_OFFBOARDING_OWN_TRIGGER_DEFINITIONS,
  PERSONNEL_LIFECYCLE_OFFBOARDING_REQUIRED_TABLES,
  PERSONNEL_LIFECYCLE_OFFBOARDING_TABLE_DEFINITIONS,
  PERSONNEL_LIFECYCLE_OFFBOARDING_TABLE_NAMES,
  PERSONNEL_LIFECYCLE_OFFBOARDING_TRIGGER_DEFINITIONS,
  PERSONNEL_LIFECYCLE_OFFBOARDING_TRIGGER_NAMES,
  ensureSqlitePersonnelLifecycleOffboardingSchema,
  inspectSqlitePersonnelLifecycleOffboardingRows,
  inspectSqlitePersonnelLifecycleOffboardingSchema,
};
