"use strict";

const {
  createSqliteSchemaOperations,
} = require("./maintenance");
const {
  dropSqliteWorkRuleEvaluationReceiptTriggers,
  ensureSqliteWorkRuleEvaluationReceiptTriggers,
} = require("./work-rule-store-schema");

function assertFunction(value, label) {
  if (typeof value !== "function") {
    throw new TypeError(`${label} muss eine Funktion sein.`);
  }
  return value;
}

function runSqliteStartupSchemaMigrations({
  database,
  databaseExistedBeforeOpen = false,
  appVersion,
  ensureApplicationSchema,
  createPreMigrationBackup,
  workRuleSha256,
} = {}) {
  if (!database || typeof database.exec !== "function" || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benoetigt.");
  }
  const db = database;
  const packageMetadata = { version: String(appVersion || "") };
  const createSchema = assertFunction(ensureApplicationSchema, "ensureApplicationSchema");
  const createInternalDatabaseBackup = assertFunction(
    createPreMigrationBackup,
    "createPreMigrationBackup",
  );
  assertFunction(workRuleSha256, "workRuleSha256");
  const {
    columnExists,
    ensureColumn,
    tableExists,
    triggerExists,
  } = createSqliteSchemaOperations(db);

function migrateLegacySchema() {
  if (!tableExists("employees") || columnExists("employees", "personnel_number")) return;

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      ALTER TABLE shifts RENAME TO shifts_legacy;
      ALTER TABLE employees RENAME TO employees_legacy;
    `);
    createSchema();
    db.exec(`
      INSERT INTO employees
        (personnel_number, full_name, nickname, color, contracted_hours, home_location_id, active, created_at)
      SELECT CAST(id AS TEXT), name, name, color, contracted_hours, '01', active, created_at
      FROM employees_legacy;

      INSERT INTO shifts
        (id, employee_number, location_id, shift_date, start_time, end_time, area, note, created_at)
      SELECT id, CAST(employee_id AS TEXT), '01', shift_date, start_time, end_time, area, note, created_at
      FROM shifts_legacy;

      DROP TABLE shifts_legacy;
      DROP TABLE employees_legacy;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function ensureWorkRuleEvaluationReceiptIntegrity() {
  if (!tableExists("work_rule_evaluation_runs")
    || !columnExists("work_rule_evaluation_runs", "receipt_sha256")) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    dropSqliteWorkRuleEvaluationReceiptTriggers(db);
    const legacyRows = db.prepare(`
      SELECT *
      FROM work_rule_evaluation_runs
      WHERE TRIM(COALESCE(receipt_sha256, '')) = ''
      ORDER BY created_at, id
    `).all();
    const updateReceipt = db.prepare(`
      UPDATE work_rule_evaluation_runs
      SET receipt_sha256 = ?
      WHERE id = ? AND TRIM(COALESCE(receipt_sha256, '')) = ''
    `);
    for (const row of legacyRows) {
      let result;
      let profileVersionIds;
      try {
        result = JSON.parse(row.result_json);
        profileVersionIds = JSON.parse(row.profile_version_ids_json);
      } catch {
        throw new Error(`Der bestehende Prüfbeleg ${row.id} kann nicht sicher migriert werden.`);
      }
      if (!result || typeof result !== "object" || Array.isArray(result)
        || !Array.isArray(profileVersionIds)
        || workRuleSha256(result) !== row.result_sha256) {
        throw new Error(`Der bestehende Prüfbeleg ${row.id} hat keine gültige Ergebnis-Prüfsumme.`);
      }
      const receiptSha256 = workRuleSha256({
        schemaVersion: 1,
        id: row.id,
        targetType: row.target_type,
        scopeType: row.scope_type,
        scopeKey: row.scope_key,
        periodFrom: row.period_from,
        periodTo: row.period_to,
        profileVersionIds,
        inputSha256: row.input_sha256,
        resultSha256: row.result_sha256,
        outcome: row.outcome,
        result,
        createdBy: row.created_by,
        createdAt: row.created_at,
      });
      updateReceipt.run(receiptSha256, row.id);
    }
    ensureSqliteWorkRuleEvaluationReceiptTriggers(db);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

const protectedPersonnelMigrationRequired = tableExists("amu_reports") && (
  !columnExists("amu_reports", "protected_payload")
  || !columnExists("amu_documents", "protected_payload")
  || Boolean(db.prepare("SELECT 1 FROM amu_reports WHERE TRIM(COALESCE(protected_payload, '')) = '' LIMIT 1").get())
  || Boolean(db.prepare("SELECT 1 FROM amu_documents WHERE TRIM(COALESCE(protected_payload, '')) = '' AND status <> 'purged' LIMIT 1").get())
);
const unreleasedSicknessDraftSchemaPresent = tableExists("sickness_cases")
  && !columnExists("sickness_cases", "employee_lookup");
const legacySchemaMigrationRequired = tableExists("employees") && !columnExists("employees", "personnel_number");
const portalMobileBaselineMigrationRequired = !tableExists("schema_migrations")
  || !db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v0.60-portal-mobile-foundation' LIMIT 1").get();
const costCenterMigrationId = "v0.71-cost-centers-personnel";
const costCenterTypeMigrationId = "v0.87-cost-center-types";
const employeeCostCenterAssignmentMigrationId = "v0.87-employee-cost-center-assignment";
const shiftLocationMigrationId = "v0.71-shift-locations";
const workRuleMigrationId = "v0.81-austrian-work-rule-engine";
const privacyGovernanceMigrationId = "v0.82-leave-records-privacy";
const vacationHistoryProtectionMigrationId = "v0.82-protected-vacation-history";
const payrollHandoffMigrationId = "v0.83-payroll-handoffs";
const productReadinessMigrationId = "v0.84-product-readiness";
const loanModuleMigrationId = "v0.85-loan-module-foundation";
const loanPhotoPdfMigrationId = "v0.87-loan-photo-pdf-attachments";
const block7SettingsMigrationId = "v0.87-block7-settings-appearance";
const principalSeparationMigrationId = "v0.87-block8-principal-separation";
const principalSeparationTriggerNames = Object.freeze([
  "trg_employees_organization_login_insert",
  "trg_employees_organization_login_update",
  "trg_organization_accounts_employee_login_insert",
  "trg_organization_accounts_employee_login_update",
]);
const loanPhotoPdfTriggerNames = Object.freeze([
  "trg_loan_photos_retention_insert",
  "trg_loan_photo_attachments_immutable_update",
  "trg_loan_photo_attachments_immutable_delete",
]);
const collectiveAgreementMigrationId = "v0.85-collective-agreement-register";
const workRuleGovernanceMigrationId = "v0.86-work-rule-governance";
const workRuleGovernanceTables = Object.freeze([
  "work_rule_conflict_runs",
  "work_rule_review_requests",
  "work_rule_review_decisions",
  "work_rule_publications",
  "work_rule_publication_events",
  "work_rule_assignment_revisions",
  "work_rule_assignment_events",
  "collective_agreement_assignment_events",
  "work_rule_governance_events",
]);
const workRuleGovernanceTriggerNames = Object.freeze(workRuleGovernanceTables.flatMap((name) => [
  `trg_${name}_immutable_update`,
  `trg_${name}_immutable_delete`,
]));
const loanModuleTables = Object.freeze([
  "articles",
  "article_identifiers",
  "loan_location_settings",
  "loans",
  "loan_items",
  "loan_return_confirmations",
  "loan_documents",
  "loan_photos",
  "loan_document_deliveries",
  "loan_events",
]);
const loanModuleTriggerNames = Object.freeze([
  "trg_loan_documents_immutable_update",
  "trg_loan_documents_immutable_delete",
  "trg_loan_photos_immutable_update",
  "trg_loan_photos_immutable_delete",
  "trg_loan_document_deliveries_immutable_update",
  "trg_loan_document_deliveries_immutable_delete",
  "trg_loan_events_immutable_update",
  "trg_loan_events_immutable_delete",
]);
const privacyGovernanceTables = [
  "vacation_account_revisions",
  "vacation_account_events",
  "vacation_history_events",
  "time_record_statements",
  "time_record_statement_events",
  "payroll_handoffs",
  "payroll_handoff_events",
  "retention_policy_versions",
  "retention_preview_runs",
  "legal_holds",
  "privacy_requests",
  "privacy_request_events",
  "privacy_export_receipts",
];
const privacyGovernanceImmutableTriggers = [
  "trg_vacation_account_revisions_immutable_update",
  "trg_vacation_account_revisions_immutable_delete",
  "trg_vacation_account_events_immutable_update",
  "trg_vacation_account_events_immutable_delete",
  "trg_vacation_history_events_immutable_update",
  "trg_vacation_history_events_immutable_delete",
  "trg_time_record_statements_immutable_update",
  "trg_time_record_statements_immutable_delete",
  "trg_time_record_statement_events_immutable_update",
  "trg_time_record_statement_events_immutable_delete",
  "trg_payroll_handoffs_immutable_update",
  "trg_payroll_handoffs_immutable_delete",
  "trg_payroll_handoff_events_immutable_update",
  "trg_payroll_handoff_events_immutable_delete",
  "trg_retention_policy_versions_immutable_update",
  "trg_retention_policy_versions_immutable_delete",
  "trg_retention_preview_runs_immutable_update",
  "trg_retention_preview_runs_immutable_delete",
  "trg_privacy_request_events_immutable_update",
  "trg_privacy_request_events_immutable_delete",
];
const privacyGovernanceImmutableTriggerMessages = Object.freeze({
  vacation_account_revisions: "vacation account revisions are immutable",
  vacation_account_events: "vacation account events are immutable",
  vacation_history_events: "vacation history events are immutable",
  time_record_statements: "time record statements are immutable",
  time_record_statement_events: "time record statement events are immutable",
  payroll_handoffs: "payroll handoffs are immutable",
  payroll_handoff_events: "payroll handoff events are immutable",
  retention_policy_versions: "retention policy versions are immutable",
  retention_preview_runs: "retention preview runs are immutable",
  privacy_request_events: "privacy request events are immutable",
});
const privacyGovernanceImmutableTriggerDefinitions = privacyGovernanceImmutableTriggers.map((name) => {
  const operation = name.endsWith("_immutable_update") ? "UPDATE" : "DELETE";
  const suffix = `_immutable_${operation.toLowerCase()}`;
  const table = name.slice("trg_".length, -suffix.length);
  return Object.freeze({
    name,
    table,
    operation,
    message: privacyGovernanceImmutableTriggerMessages[table],
  });
});
const productReadinessTables = [
  "product_readiness_evidence",
  "product_readiness_acceptances",
];
const productReadinessImmutableTriggerDefinitions = [
  {
    name: "trg_product_readiness_evidence_immutable_update",
    table: "product_readiness_evidence",
    operation: "UPDATE",
    message: "product readiness evidence is immutable",
  },
  {
    name: "trg_product_readiness_evidence_immutable_delete",
    table: "product_readiness_evidence",
    operation: "DELETE",
    message: "product readiness evidence is immutable",
  },
  {
    name: "trg_product_readiness_acceptances_immutable_update",
    table: "product_readiness_acceptances",
    operation: "UPDATE",
    message: "product readiness acceptances are immutable",
  },
  {
    name: "trg_product_readiness_acceptances_immutable_delete",
    table: "product_readiness_acceptances",
    operation: "DELETE",
    message: "product readiness acceptances are immutable",
  },
];

function normalizeImmutableTriggerSql(sql) {
  return String(sql || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*;\s*$/, "")
    .replace(/^create trigger if not exists /i, "create trigger ")
    .toLowerCase();
}

function privacyGovernanceImmutableTriggerMatches(definition) {
  const stored = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
  ).get(definition.name);
  if (!stored?.sql || !definition.message) return false;
  const expected = `
    CREATE TRIGGER ${definition.name}
    BEFORE ${definition.operation} ON ${definition.table}
    BEGIN
      SELECT RAISE(ABORT, '${definition.message}');
    END
  `;
  return normalizeImmutableTriggerSql(stored.sql) === normalizeImmutableTriggerSql(expected);
}

function removeMalformedPrivacyGovernanceImmutableTriggers() {
  for (const definition of privacyGovernanceImmutableTriggerDefinitions) {
    if (triggerExists(definition.name)
      && !privacyGovernanceImmutableTriggerMatches(definition)) {
      db.exec(`DROP TRIGGER IF EXISTS "${definition.name}"`);
    }
  }
}
function productReadinessImmutableTriggerMatches(definition) {
  const stored = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
  ).get(definition.name);
  if (!stored?.sql) return false;
  const expected = `
    CREATE TRIGGER ${definition.name}
    BEFORE ${definition.operation} ON ${definition.table}
    BEGIN
      SELECT RAISE(ABORT, '${definition.message}');
    END
  `;
  return normalizeImmutableTriggerSql(stored.sql) === normalizeImmutableTriggerSql(expected);
}

function removeMalformedProductReadinessImmutableTriggers() {
  for (const definition of productReadinessImmutableTriggerDefinitions) {
    if (triggerExists(definition.name) && !productReadinessImmutableTriggerMatches(definition)) {
      db.exec(`DROP TRIGGER IF EXISTS "${definition.name}"`);
    }
  }
}

function costCenterTypeDataRepairNeeded() {
  if (!tableExists("cost_center_types") || !tableExists("cost_centers")
    || !columnExists("cost_centers", "cost_center_type_id")) return false;
  for (const id of ["branch", "administration", "production", "other"]) {
    if (!db.prepare("SELECT 1 FROM cost_center_types WHERE id = ? LIMIT 1").get(id)) return true;
  }
  return Boolean(db.prepare(`
    SELECT 1
    FROM cost_centers center
    LEFT JOIN cost_center_types type ON type.id = center.cost_center_type_id
    WHERE TRIM(COALESCE(center.cost_center_type_id, '')) = '' OR type.id IS NULL
    LIMIT 1
  `).get());
}

function costCenterDataRepairNeeded() {
  if (!tableExists("cost_centers") || !tableExists("cost_center_types")
    || !tableExists("locations") || !tableExists("employees")
    || !columnExists("locations", "cost_center_id")
    || !columnExists("employees", "cost_center_id")
    || !columnExists("cost_centers", "cost_center_type_id")) return false;
  const administrationMissing = !db.prepare(`
    SELECT 1 FROM cost_centers
    WHERE id = 'cc-administration' OR code = 'VERW' COLLATE NOCASE
    LIMIT 1
  `).get();
  if (administrationMissing) return true;
  const invalidLocation = db.prepare(`
    SELECT 1
    FROM locations location
    LEFT JOIN cost_centers center ON center.id = location.cost_center_id
    LEFT JOIN cost_center_types type ON type.id = center.cost_center_type_id
    WHERE center.id IS NULL OR center.active <> 1
      OR type.id IS NULL OR type.active <> 1 OR type.is_branch <> 1
    LIMIT 1
  `).get();
  if (invalidLocation) return true;
  const duplicateLocationCenter = db.prepare(`
    SELECT 1
    FROM locations
    WHERE TRIM(COALESCE(cost_center_id, '')) <> ''
    GROUP BY cost_center_id
    HAVING COUNT(*) > 1
    LIMIT 1
  `).get();
  if (duplicateLocationCenter) return true;
  return Boolean(db.prepare(`
    SELECT 1
    FROM employees employee
    LEFT JOIN cost_centers center ON center.id = employee.cost_center_id
    WHERE TRIM(COALESCE(employee.cost_center_id, '')) = '' OR center.id IS NULL
    LIMIT 1
  `).get());
}

function employeeCostCenterAssignmentDataRepairNeeded() {
  if (!tableExists("employees") || !tableExists("cost_centers")
    || !tableExists("cost_center_types") || !tableExists("cost_center_type_positions")
    || !tableExists("locations") || !tableExists("departments")
    || !columnExists("employees", "cost_center_id")
    || !columnExists("employees", "home_location_id")
    || !columnExists("employees", "preferred_department_id")
    || !columnExists("cost_centers", "cost_center_type_id")) return false;
  return Boolean(db.prepare(`
    SELECT 1
    FROM employees employee
    JOIN cost_centers center ON center.id = employee.cost_center_id
    JOIN cost_center_types type ON type.id = center.cost_center_type_id
    WHERE NOT EXISTS (
        SELECT 1
        FROM cost_center_type_positions mapping
        WHERE mapping.cost_center_type_id = center.cost_center_type_id
          AND mapping.position_id = employee.position_id
      )
      OR COALESCE(employee.home_location_id, '') <> COALESCE(
        CASE WHEN type.is_branch = 1
          THEN (
            SELECT location.id
            FROM locations location
            WHERE location.cost_center_id = center.id
            ORDER BY location.id
            LIMIT 1
          )
          ELSE NULL
        END,
        ''
      )
      OR (
        employee.preferred_department_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM departments department
          WHERE department.id = employee.preferred_department_id
            AND department.location_id = CASE WHEN type.is_branch = 1
              THEN (
                SELECT location.id
                FROM locations location
                WHERE location.cost_center_id = center.id
                ORDER BY location.id
                LIMIT 1
              )
              ELSE NULL
            END
        )
      )
    LIMIT 1
  `).get());
}

const costCenterMigrationRequired = !tableExists("schema_migrations")
  || !db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1").get(costCenterMigrationId)
  || !tableExists("cost_centers")
  || !columnExists("employees", "cost_center_id")
  || !columnExists("locations", "cost_center_id")
  || costCenterDataRepairNeeded();
const costCenterTypeMigrationApplied = tableExists("schema_migrations")
  && Boolean(db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1").get(costCenterTypeMigrationId));
const costCenterTypeTableMissingBeforeSchema = !tableExists("cost_center_types");
const costCenterTypePositionTableMissingBeforeSchema = !tableExists("cost_center_type_positions");
const costCenterTypeMigrationRequired = !costCenterTypeMigrationApplied
  || costCenterTypeTableMissingBeforeSchema
  || costCenterTypePositionTableMissingBeforeSchema
  || !columnExists("cost_centers", "cost_center_type_id")
  || costCenterTypeDataRepairNeeded();
const employeeCostCenterAssignmentMigrationRequired = !tableExists("schema_migrations")
  || !db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1")
    .get(employeeCostCenterAssignmentMigrationId)
  || costCenterMigrationRequired
  || costCenterTypeMigrationRequired
  || employeeCostCenterAssignmentDataRepairNeeded();
const shiftLocationMigrationRequired = !tableExists("schema_migrations")
  || !db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1").get(shiftLocationMigrationId)
  || !columnExists("shifts", "location_id")
  || !db.prepare("PRAGMA foreign_key_list(shifts)").all()
    .some((row) => row.from === "location_id" && row.table === "locations" && row.to === "id");
const workRuleMigrationRequired = !tableExists("schema_migrations")
  || !db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1").get(workRuleMigrationId)
  || !tableExists("work_rule_profiles")
  || !tableExists("work_rule_profile_versions")
  || !tableExists("work_rule_assignments")
  || !tableExists("work_rule_evaluation_runs")
  || !columnExists("work_rule_evaluation_runs", "receipt_sha256")
  || !tableExists("work_rule_exceptions");
const privacyGovernanceMigrationRequired = !tableExists("schema_migrations")
  || !db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1").get(privacyGovernanceMigrationId)
  || privacyGovernanceTables.some((name) => !tableExists(name))
  || privacyGovernanceImmutableTriggerDefinitions.some(
    (definition) => !privacyGovernanceImmutableTriggerMatches(definition),
  );
const vacationHistoryProtectionMigrationRequired = tableExists("vacation_history_events") && (
  !db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1").get(vacationHistoryProtectionMigrationId)
  || Boolean(db.prepare(`
    SELECT 1 FROM vacation_history_events
    WHERE snapshot_json NOT LIKE 'enc:v2:%'
    LIMIT 1
  `).get())
);
const payrollHandoffMigrationRequired = !tableExists("schema_migrations")
  || !db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1").get(payrollHandoffMigrationId)
  || !tableExists("payroll_handoffs")
  || !tableExists("payroll_handoff_events");
const productReadinessMigrationRequired = !tableExists("schema_migrations")
  || !db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1").get(productReadinessMigrationId)
  || productReadinessTables.some((name) => !tableExists(name))
  || productReadinessImmutableTriggerDefinitions.some(
    (definition) => !productReadinessImmutableTriggerMatches(definition),
  );
const loanModuleMigrationRequired = !tableExists("schema_migrations")
  || !db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1").get(loanModuleMigrationId)
  || loanModuleTables.some((name) => !tableExists(name))
  || loanModuleTriggerNames.some((name) => !triggerExists(name));
const loanPhotoPdfMigrationRequired = !tableExists("schema_migrations")
  || !db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1").get(loanPhotoPdfMigrationId)
  || !tableExists("loan_photo_attachments")
  || loanPhotoPdfTriggerNames.some((name) => !triggerExists(name))
  || !columnExists("loan_location_settings", "photo_pdf_output_mode")
  || !columnExists("loan_location_settings", "photo_original_retention")
  || !columnExists("loan_photos", "original_retained")
  || !columnExists("loan_photos", "original_deleted_at")
  || !columnExists("loan_photos", "original_deletion_reason");
const collectiveAgreementMigrationRequired = !tableExists("schema_migrations")
  || !db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1").get(collectiveAgreementMigrationId)
  || !tableExists("collective_agreements")
  || !tableExists("collective_agreement_versions")
  || !tableExists("collective_agreement_business_units")
  || !tableExists("collective_agreement_business_unit_scopes")
  || !tableExists("collective_agreement_assignments")
  || !triggerExists("trg_collective_agreement_versions_immutable_update")
  || !triggerExists("trg_collective_agreement_assignments_immutable_update");
const workRuleGovernanceMigrationRequired = !tableExists("schema_migrations")
  || !db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1").get(workRuleGovernanceMigrationId)
  || workRuleGovernanceTables.some((name) => !tableExists(name))
  || workRuleGovernanceTriggerNames.some((name) => !triggerExists(name));
const block7SettingsMigrationRequired = !tableExists("schema_migrations")
  || !db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1").get(block7SettingsMigrationId);
const principalSeparationMigrationRequired = !tableExists("schema_migrations")
  || !db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1")
    .get(principalSeparationMigrationId)
  || principalSeparationTriggerNames.some((name) => !triggerExists(name));
if (databaseExistedBeforeOpen && (portalMobileBaselineMigrationRequired || protectedPersonnelMigrationRequired
  || unreleasedSicknessDraftSchemaPresent || legacySchemaMigrationRequired || costCenterMigrationRequired
  || costCenterTypeMigrationRequired || employeeCostCenterAssignmentMigrationRequired
  || shiftLocationMigrationRequired || workRuleMigrationRequired || privacyGovernanceMigrationRequired
  || vacationHistoryProtectionMigrationRequired || payrollHandoffMigrationRequired
   || productReadinessMigrationRequired || loanModuleMigrationRequired || loanPhotoPdfMigrationRequired
   || collectiveAgreementMigrationRequired || workRuleGovernanceMigrationRequired
   || block7SettingsMigrationRequired || principalSeparationMigrationRequired)) {
  createInternalDatabaseBackup("pre-migration");
}

if (privacyGovernanceMigrationRequired) {
  removeMalformedPrivacyGovernanceImmutableTriggers();
}
if (productReadinessMigrationRequired) {
  removeMalformedProductReadinessImmutableTriggers();
}

if (unreleasedSicknessDraftSchemaPresent) {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (tableExists("amu_reports") && columnExists("amu_reports", "sickness_case_id")) {
      db.prepare("UPDATE amu_reports SET sickness_case_id = NULL, revision = revision + 1").run();
    }
    db.exec(`
      DROP TABLE IF EXISTS outbound_notification_jobs;
      DROP TABLE IF EXISTS sickness_alerts;
      DROP TABLE IF EXISTS sickness_notification_preferences;
      DROP TABLE IF EXISTS sickness_cases;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

if (legacySchemaMigrationRequired) {
  migrateLegacySchema();
} else {
  createSchema();
}
createSchema();
ensureColumn("cost_centers", "cost_center_type_id", "TEXT");
ensureColumn("shifts", "location_id", "TEXT");
ensureColumn("sickness_notification_preferences", "process_notifications_enabled", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("custom_processes", "category", "TEXT NOT NULL DEFAULT 'other'");
ensureColumn("custom_process_runs", "activation_count", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("custom_process_run_steps", "completion_request_id", "TEXT NOT NULL DEFAULT ''");
ensureColumn("integration_connections", "revision", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("integration_deliveries", "connection_revision", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("integration_deliveries", "connection_fingerprint", "TEXT NOT NULL DEFAULT ''");
ensureColumn("work_rule_evaluation_runs", "receipt_sha256", "TEXT NOT NULL DEFAULT ''");
ensureColumn("loan_location_settings", "document_recipient_employee_number", "TEXT");
ensureColumn("loan_location_settings", "document_email_enabled", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("loan_location_settings", "document_recipient_email", "TEXT NOT NULL DEFAULT ''");
ensureColumn("loan_location_settings", "photo_pdf_output_mode", "TEXT NOT NULL DEFAULT 'grayscale'");
ensureColumn("loan_location_settings", "photo_original_retention", "TEXT NOT NULL DEFAULT 'retain'");
ensureColumn("loan_photos", "original_retained", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("loan_photos", "original_deleted_at", "TEXT");
ensureColumn("loan_photos", "original_deletion_reason", "TEXT NOT NULL DEFAULT ''");
db.exec(`
  CREATE TRIGGER IF NOT EXISTS trg_loan_photos_retention_insert
  BEFORE INSERT ON loan_photos
  WHEN NEW.original_retained NOT IN (0,1)
    OR (NEW.original_retained = 1
      AND (NEW.original_deleted_at IS NOT NULL OR NEW.original_deletion_reason <> ''))
    OR (NEW.original_retained = 0
      AND (NEW.original_deleted_at IS NULL OR TRIM(NEW.original_deletion_reason) = ''))
  BEGIN
    SELECT RAISE(ABORT, 'loan photo retention state is invalid');
  END;
`);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run(loanPhotoPdfMigrationId, packageMetadata.version);
db.exec("CREATE INDEX IF NOT EXISTS idx_custom_processes_category ON custom_processes(category, status, title)");
ensureWorkRuleEvaluationReceiptIntegrity();
if (!columnExists("week_options", "group_id")) {
  db.exec("ALTER TABLE week_options ADD COLUMN group_id TEXT");
}
db.exec("CREATE INDEX IF NOT EXISTS idx_week_options_group ON week_options(group_id)");
if (!columnExists("week_options", "credited_minutes_per_day")) {
  db.exec("ALTER TABLE week_options ADD COLUMN credited_minutes_per_day INTEGER");
}
if (!columnExists("week_options", "all_day")) {
  db.exec("ALTER TABLE week_options ADD COLUMN all_day INTEGER NOT NULL DEFAULT 1");
}
if (!columnExists("week_options", "start_time")) {
  db.exec("ALTER TABLE week_options ADD COLUMN start_time TEXT");
}
if (!columnExists("week_options", "end_time")) {
  db.exec("ALTER TABLE week_options ADD COLUMN end_time TEXT");
}
if (!columnExists("employees", "preferred_day_off")) {
  db.exec("ALTER TABLE employees ADD COLUMN preferred_day_off TEXT");
}
if (!columnExists("employees", "fixed_workdays")) {
  db.exec("ALTER TABLE employees ADD COLUMN fixed_workdays TEXT NOT NULL DEFAULT ''");
}
if (!columnExists("employees", "position_id")) {
  db.exec("ALTER TABLE employees ADD COLUMN position_id TEXT NOT NULL DEFAULT 'verkaufsmitarbeiter'");
}
ensureColumn("employees", "time_confirmation_level", "TEXT NOT NULL DEFAULT 'C'");
ensureColumn("employees", "target_workdays_per_week", "INTEGER NOT NULL DEFAULT 5");
ensureColumn("employees", "sickness_without_aum_enabled", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("wifi_time_suggestions", "confirmed_start_at", "TEXT");
ensureColumn("wifi_time_suggestions", "confirmed_end_at", "TEXT");
ensureColumn("wifi_time_suggestions", "confirmed_break_start_at", "TEXT");
ensureColumn("wifi_time_suggestions", "confirmed_break_end_at", "TEXT");
ensureColumn("wifi_time_suggestions", "rejected_by", "TEXT");
ensureColumn("wifi_time_suggestions", "rejection_reason", "TEXT NOT NULL DEFAULT ''");
if (!columnExists("employees", "home_location_id")) {
  db.exec("ALTER TABLE employees ADD COLUMN home_location_id TEXT");
}
if (!columnExists("employees", "preferred_department_id")) {
  db.exec("ALTER TABLE employees ADD COLUMN preferred_department_id INTEGER");
}
ensureColumn("employees", "cost_center_id", "TEXT");
ensureColumn("locations", "cost_center_id", "TEXT");
db.exec("CREATE INDEX IF NOT EXISTS idx_employees_cost_center ON employees(cost_center_id, active, personnel_number)");
db.exec("CREATE INDEX IF NOT EXISTS idx_locations_cost_center ON locations(cost_center_id, active, id)");
if (tableExists("locations") && !columnExists("locations", "min_staff")) {
  db.exec("ALTER TABLE locations ADD COLUMN min_staff INTEGER NOT NULL DEFAULT 0");
}
ensureColumn("locations", "day_settings_json", "TEXT NOT NULL DEFAULT ''");
ensureColumn("locations", "time_tracking_enabled", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("locations", "time_tracking_access_mode", "TEXT NOT NULL DEFAULT 'anywhere'");
ensureColumn("locations", "time_tracking_allowed_networks", "TEXT NOT NULL DEFAULT ''");
ensureColumn("locations", "time_tracking_variance_minutes", "INTEGER NOT NULL DEFAULT 15");
if (tableExists("departments") && !columnExists("departments", "min_staff")) {
  db.exec("ALTER TABLE departments ADD COLUMN min_staff INTEGER NOT NULL DEFAULT 0");
}
if (tableExists("schedule_notes") && !columnExists("schedule_notes", "note_html")) {
  db.exec("ALTER TABLE schedule_notes ADD COLUMN note_html TEXT NOT NULL DEFAULT ''");
}
if (!columnExists("shifts", "department_id")) {
  db.exec("ALTER TABLE shifts ADD COLUMN department_id INTEGER");
}
ensureColumn("portal_users", "password_changed_at", "TEXT");
ensureColumn("portal_users", "failed_login_attempts", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("portal_users", "locked_until", "TEXT");
ensureColumn("portal_users", "role_locked", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("portal_roles", "description", "TEXT NOT NULL DEFAULT ''");
ensureColumn("portal_roles", "sort_order", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("portal_roles", "updated_at", "TEXT");
ensureColumn("time_entries", "location_id", "TEXT");
ensureColumn("time_entries", "department_id", "INTEGER");
ensureColumn("time_entries", "work_date", "TEXT NOT NULL DEFAULT ''");
ensureColumn("time_entries", "voided_at", "TEXT");
ensureColumn("time_entries", "voided_by", "TEXT");
ensureColumn("time_entries", "void_reason", "TEXT NOT NULL DEFAULT ''");
ensureColumn("time_entries", "correction_id", "INTEGER");
ensureColumn("time_entries", "client_request_id", "TEXT");
ensureColumn("time_entries", "mobile_session_id", "TEXT");
ensureColumn("mobile_mutation_receipts", "entity_type", "TEXT NOT NULL DEFAULT ''");
ensureColumn("mobile_mutation_receipts", "entity_id", "TEXT NOT NULL DEFAULT ''");
ensureColumn("mobile_mutation_receipts", "action_completed_at", "TEXT");
ensureColumn("time_corrections", "location_id", "TEXT");
ensureColumn("time_corrections", "department_id", "INTEGER");
ensureColumn("time_corrections", "request_note", "TEXT NOT NULL DEFAULT ''");
ensureColumn("time_corrections", "decision_note", "TEXT NOT NULL DEFAULT ''");
ensureColumn("time_corrections", "requested_by", "TEXT");
ensureColumn("time_day_reviews", "evaluation_version", "TEXT NOT NULL DEFAULT 'v1'");
ensureColumn("time_day_reviews", "snapshot_json", "TEXT NOT NULL DEFAULT '{}'");
ensureColumn("time_day_reviews", "department_key", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("amu_reports", "department_id", "INTEGER");
ensureColumn("amu_reports", "sickness_case_id", "INTEGER");
ensureColumn("amu_reports", "revision", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("amu_reports", "protected_payload", "TEXT NOT NULL DEFAULT ''");
ensureColumn("amu_documents", "protected_payload", "TEXT NOT NULL DEFAULT ''");
ensureColumn("sickness_cases", "revision", "INTEGER NOT NULL DEFAULT 1");
db.exec("CREATE INDEX IF NOT EXISTS idx_amu_reports_sickness_case ON amu_reports(sickness_case_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_protected_case_events_entity ON protected_case_events(entity_kind, entity_id, created_at, id)");

  return Object.freeze({
    block7SettingsMigrationId,
    block7SettingsMigrationRequired,
    collectiveAgreementMigrationId,
    costCenterMigrationId,
    costCenterTypeMigrationApplied,
    costCenterTypeMigrationId,
    costCenterTypePositionTableMissingBeforeSchema,
    costCenterTypeTableMissingBeforeSchema,
    employeeCostCenterAssignmentMigrationId,
    employeeCostCenterAssignmentMigrationRequired,
    ensureWorkRuleEvaluationReceiptIntegrity,
    loanModuleMigrationId,
    payrollHandoffMigrationId,
    principalSeparationMigrationId,
    principalSeparationMigrationRequired,
    privacyGovernanceMigrationId,
    productReadinessMigrationId,
    shiftLocationMigrationId,
    vacationHistoryProtectionMigrationId,
    vacationHistoryProtectionMigrationRequired,
    workRuleGovernanceMigrationId,
    workRuleMigrationId,
  });
}

module.exports = {
  runSqliteStartupSchemaMigrations,
};
