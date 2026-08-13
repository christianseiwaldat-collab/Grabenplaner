"use strict";

const {
  createSqliteSchemaOperations,
} = require("./maintenance");
const {
  dropSqliteWorkRuleEvaluationReceiptTriggers,
  ensureSqliteWorkRuleEvaluationReceiptTriggers,
} = require("./work-rule-store-schema");
const {
  PERSONAL_NOTIFICATION_CONTACTS_CREATE_SQL,
  inspectSqlitePersonalNotificationContactsSchema,
} = require("./application-schema");
const {
  PERSONNEL_LIFECYCLE_CONVERSION_MIGRATION_ID,
  PERSONNEL_LIFECYCLE_CONVERSION_TRIGGER_DEFINITIONS,
  PERSONNEL_LIFECYCLE_LEGACY_SCOPED_RIGHTS_TABLE_DEFINITION,
  PERSONNEL_LIFECYCLE_M4_SCOPED_RIGHTS_TABLE_DEFINITION,
  PERSONNEL_LIFECYCLE_MIGRATION_ID,
  PERSONNEL_LIFECYCLE_OPERATIONAL_SCOPED_RIGHTS_MIGRATION_ID,
  PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_MIGRATION_ID,
  PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TABLE_DEFINITIONS,
  PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TABLE_NAMES,
  PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TRIGGER_DEFINITIONS,
  PERSONNEL_LIFECYCLE_TABLE_NAMES,
  PERSONNEL_LIFECYCLE_TRIGGER_DEFINITIONS,
  PERSONNEL_PROFILE_SCOPED_RIGHTS_MIGRATION_ID,
  PERSONNEL_PROFILE_SCOPED_RIGHTS_TABLE_DEFINITION,
  inspectSqlitePersonnelLifecycleConversionSchema,
  inspectSqlitePersonnelLifecycleScopedRightsRows,
  inspectSqlitePersonnelLifecycleScopedRightsSchema,
  inspectSqlitePersonnelLifecycleSchema,
} = require("./personnel-lifecycle-schema");
const {
  PERSONNEL_WORKFLOW_MIGRATION_ID,
  PERSONNEL_WORKFLOW_TABLE_NAMES,
  PERSONNEL_WORKFLOW_TRIGGER_DEFINITIONS,
  inspectSqlitePersonnelWorkflowRows,
  inspectSqlitePersonnelWorkflowSchema,
} = require("./personnel-workflow-schema");
const {
  PERSONNEL_WORKFLOW_INSTANCE_ASSIGNED_EMPLOYEE_MIGRATION_ID,
  PERSONNEL_WORKFLOW_INSTANCE_ASSIGNED_EMPLOYEE_TRIGGER_NAME,
  PERSONNEL_WORKFLOW_INSTANCE_MIGRATION_ID,
  PERSONNEL_WORKFLOW_INSTANCE_TABLE_NAMES,
  PERSONNEL_WORKFLOW_INSTANCE_TRIGGER_DEFINITIONS,
  inspectSqlitePersonnelWorkflowInstanceRows,
  inspectSqlitePersonnelWorkflowInstanceSchema,
  migrateSqlitePersonnelWorkflowInstanceAssignedEmployeeTrigger,
} = require("./personnel-workflow-instance-schema");
const {
  PERSONNEL_LIFECYCLE_CASE_FOUNDATION_MIGRATION_ID,
  PERSONNEL_LIFECYCLE_CASE_TABLE_NAMES,
  PERSONNEL_LIFECYCLE_CASE_TRIGGER_DEFINITIONS,
  inspectSqlitePersonnelLifecycleCaseRows,
  inspectSqlitePersonnelLifecycleCaseSchema,
} = require("./personnel-lifecycle-case-schema");
const {
  PERSONNEL_LIFECYCLE_ONBOARDING_MIGRATION_ID,
  inspectSqlitePersonnelLifecycleOnboardingRows,
  inspectSqlitePersonnelLifecycleOnboardingSchema,
} = require("./personnel-lifecycle-onboarding-schema");
const {
  PERSONNEL_LIFECYCLE_OFFBOARDING_ASSIGNED_EMPLOYEE_MIGRATION_ID,
  PERSONNEL_LIFECYCLE_OFFBOARDING_MIGRATION_ID,
  inspectSqlitePersonnelLifecycleOffboardingRows,
  inspectSqlitePersonnelLifecycleOffboardingSchema,
  migrateSqlitePersonnelLifecycleOffboardingAssignedEmployeeTrigger,
} = require("./personnel-lifecycle-offboarding-schema");
const {
  PERSONNEL_DOCUMENT_HISTORY_MIGRATION_ID,
  PERSONNEL_DOCUMENT_HISTORY_TABLE_NAMES,
  PERSONNEL_DOCUMENT_HISTORY_TRIGGER_DEFINITIONS,
  eventReceiptSha256: personnelDocumentEventReceiptSha256,
  inspectSqlitePersonnelDocumentHistoryRows,
  inspectSqlitePersonnelDocumentHistorySchema,
} = require("./personnel-document-history-schema");

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
const personalNotificationContactsMigrationId = "v0.89-personal-notification-preferences";
const personnelLifecycleMigrationId = PERSONNEL_LIFECYCLE_MIGRATION_ID;
const personnelLifecycleConversionMigrationId = PERSONNEL_LIFECYCLE_CONVERSION_MIGRATION_ID;
const personnelLifecycleScopedRightsMigrationId = PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_MIGRATION_ID;
const personnelProfileScopedRightsMigrationId = PERSONNEL_PROFILE_SCOPED_RIGHTS_MIGRATION_ID;
const personnelLifecycleOperationalScopedRightsMigrationId =
  PERSONNEL_LIFECYCLE_OPERATIONAL_SCOPED_RIGHTS_MIGRATION_ID;
const personnelWorkflowMigrationId = PERSONNEL_WORKFLOW_MIGRATION_ID;
const personnelWorkflowInstanceMigrationId = PERSONNEL_WORKFLOW_INSTANCE_MIGRATION_ID;
const personnelWorkflowInstanceAssignedEmployeeMigrationId =
  PERSONNEL_WORKFLOW_INSTANCE_ASSIGNED_EMPLOYEE_MIGRATION_ID;
const personnelLifecycleCaseFoundationMigrationId =
  PERSONNEL_LIFECYCLE_CASE_FOUNDATION_MIGRATION_ID;
const personnelLifecycleOnboardingMigrationId =
  PERSONNEL_LIFECYCLE_ONBOARDING_MIGRATION_ID;
const personnelLifecycleOffboardingMigrationId =
  PERSONNEL_LIFECYCLE_OFFBOARDING_MIGRATION_ID;
const personnelLifecycleOffboardingAssignedEmployeeMigrationId =
  PERSONNEL_LIFECYCLE_OFFBOARDING_ASSIGNED_EMPLOYEE_MIGRATION_ID;
const personnelDocumentHistoryMigrationId = PERSONNEL_DOCUMENT_HISTORY_MIGRATION_ID;
const principalSeparationTriggerNames = Object.freeze([
  "trg_employees_organization_login_insert",
  "trg_employees_organization_login_update",
  "trg_organization_accounts_employee_login_insert",
  "trg_organization_accounts_employee_login_update",
]);

const legacyPersonalNotificationContactColumns = Object.freeze([
  "employee_number",
  "protected_address",
  "address_active",
  "verified_at",
  "verification_hash",
  "verification_salt",
  "verification_generation",
  "verification_expires_at",
  "verification_attempts",
  "verification_sent_at",
  "verification_rate_window_started_at",
  "verification_rate_count",
  "created_at",
  "updated_at",
]);

function legacyPersonalNotificationContactsSchemaPresent() {
  if (!tableExists("personal_notification_contacts")) return false;
  const columns = db.prepare("PRAGMA table_info(personal_notification_contacts)").all();
  const names = new Set(columns.map((column) => String(column.name || "")));
  return legacyPersonalNotificationContactColumns.every((name) => names.has(name))
    && columns.length === legacyPersonalNotificationContactColumns.length
    && columns.some((column) => column.name === "employee_number" && Number(column.pk) === 1)
    && !names.has("email_target_fingerprint");
}

function rebuildLegacyPersonalNotificationContacts() {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE personal_notification_contacts
        RENAME TO personal_notification_contacts_legacy_v088;
      ${PERSONAL_NOTIFICATION_CONTACTS_CREATE_SQL}
      INSERT INTO personal_notification_contacts (
        employee_number,
        verification_rate_window_started_at,
        verification_rate_count,
        created_at,
        updated_at
      )
      SELECT
        employee_number,
        verification_rate_window_started_at,
        verification_rate_count,
        created_at,
        updated_at
      FROM personal_notification_contacts_legacy_v088;
      DROP TABLE personal_notification_contacts_legacy_v088;
    `);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
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
  "loan_return_preparations",
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

function normalizeTriggerSql(sql) {
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
  return normalizeTriggerSql(stored.sql) === normalizeTriggerSql(expected);
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
  return normalizeTriggerSql(stored.sql) === normalizeTriggerSql(expected);
}

function removeMalformedProductReadinessImmutableTriggers() {
  for (const definition of productReadinessImmutableTriggerDefinitions) {
    if (triggerExists(definition.name) && !productReadinessImmutableTriggerMatches(definition)) {
      db.exec(`DROP TRIGGER IF EXISTS "${definition.name}"`);
    }
  }
}

const personnelLifecycleTableDropOrder = Object.freeze([
  "candidate_events",
  "candidate_document_versions",
  "candidate_documents",
  "candidate_applications",
  "candidate_document_categories",
  "candidates",
]);

const expectedBuiltinCandidateDocumentCategories = Object.freeze([
  Object.freeze(["resume", "resume", "Lebenslauf", "recruiting", "manual_review", null, 1, 1, 1, 10]),
  Object.freeze(["cover-letter", "cover_letter", "Bewerbungsschreiben", "recruiting", "manual_review", null, 1, 1, 1, 20]),
  Object.freeze(["certificate", "certificate", "Zeugnis", "hr_confidential", "manual_review", null, 1, 1, 1, 30]),
  Object.freeze(["reference", "reference", "Referenz", "hr_confidential", "manual_review", null, 1, 1, 1, 40]),
  Object.freeze(["work-sample", "work_sample", "Arbeitsprobe", "recruiting", "manual_review", null, 0, 1, 1, 50]),
  Object.freeze(["other", "other", "Sonstiges", "hr_confidential", "manual_review", null, 0, 1, 1, 60]),
]);

function personnelLifecycleSchemaDataError() {
  const error = new Error(
    "Das Personalmodul-Schema weicht vom erwarteten Stand ab und enthaelt bereits Fachdaten. "
      + "Die automatische Reparatur wurde nach der Sicherheitssicherung ohne Datenaenderung beendet.",
  );
  error.code = "PERSONNEL_LIFECYCLE_SCHEMA_DATA_PRESENT";
  return error;
}

function tableContainsRows(tableName) {
  return Boolean(db.prepare(`SELECT 1 FROM "${tableName}" LIMIT 1`).get());
}

function candidateDocumentCategoriesContainBusinessData() {
  if (!tableExists("candidate_document_categories")) return false;
  if (!tableContainsRows("candidate_document_categories")) return false;
  const expectedColumns = Object.freeze([
    "id", "code", "label", "default_visibility", "retention_disposition",
    "default_retention_days", "transfer_eligible", "active", "builtin", "sort_order",
    "created_at", "updated_at",
  ]);
  const actualColumns = db.prepare("PRAGMA table_info(candidate_document_categories)").all()
    .map(({ name }) => String(name));
  if (expectedColumns.some((name) => !actualColumns.includes(name))) return true;
  const rows = db.prepare(`
    SELECT *
    FROM candidate_document_categories
    ORDER BY sort_order, id
  `).all();
  const expectedColumnSet = new Set(expectedColumns);
  if (rows.some((row) => Object.keys(row).some((name) => (
    !expectedColumnSet.has(name) && row[name] !== null
  )))) return true;
  const signatures = rows.map((row) => [
    row.id,
    row.code,
    row.label,
    row.default_visibility,
    row.retention_disposition,
    row.default_retention_days ?? null,
    Number(row.transfer_eligible),
    Number(row.active),
    Number(row.builtin),
    Number(row.sort_order),
  ]);
  return JSON.stringify(signatures)
    !== JSON.stringify(expectedBuiltinCandidateDocumentCategories);
}

function personnelLifecycleBusinessDataExists() {
  try {
    for (const tableName of PERSONNEL_LIFECYCLE_TABLE_NAMES) {
      if (tableName === "candidate_document_categories" || !tableExists(tableName)) continue;
      if (tableContainsRows(tableName)) return true;
    }
    return candidateDocumentCategoriesContainBusinessData();
  } catch {
    throw personnelLifecycleSchemaDataError();
  }
}

function removePersonnelLifecycleTriggers(triggerNames) {
  const allowedNames = new Set(
    PERSONNEL_LIFECYCLE_TRIGGER_DEFINITIONS.map(({ name }) => name),
  );
  for (const triggerName of triggerNames) {
    if (allowedNames.has(triggerName)) db.exec(`DROP TRIGGER IF EXISTS "${triggerName}"`);
  }
}

function rebuildEmptyPersonnelLifecycleSchema() {
  db.exec("BEGIN IMMEDIATE");
  try {
    removePersonnelLifecycleTriggers(
      PERSONNEL_LIFECYCLE_TRIGGER_DEFINITIONS.map(({ name }) => name),
    );
    for (const tableName of personnelLifecycleTableDropOrder) {
      if (tableExists(tableName)) db.exec(`DROP TABLE "${tableName}"`);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function repairPersonnelLifecycleSchemaBeforeCreate(inspection) {
  const partialTableSchema = !inspection.absent && inspection.missingTables.length > 0;
  if (inspection.invalidTables.length || partialTableSchema) {
    if (personnelLifecycleBusinessDataExists()) {
      throw personnelLifecycleSchemaDataError();
    }
    rebuildEmptyPersonnelLifecycleSchema();
    return;
  }
  removePersonnelLifecycleTriggers(inspection.invalidTriggers);
}

function validatePersonnelLifecycleSchema() {
  const inspection = inspectSqlitePersonnelLifecycleSchema(db);
  if (!inspection.valid) {
    const error = new Error(
      "Das Personalmodul-Schema konnte nicht sicher auf den erwarteten Stand gebracht werden.",
    );
    error.code = "PERSONNEL_LIFECYCLE_SCHEMA_INVALID";
    throw error;
  }
}

function personnelLifecycleConversionSchemaDataError() {
  const error = new Error(
    "Das Umwandlungsschema des Personalmoduls weicht vom erwarteten Stand ab und enthaelt bereits Fachdaten. "
      + "Die automatische Reparatur wurde nach der Sicherheitssicherung ohne Datenaenderung beendet.",
  );
  error.code = "PERSONNEL_LIFECYCLE_CONVERSION_SCHEMA_DATA_PRESENT";
  return error;
}

function removePersonnelLifecycleConversionTriggers(triggerNames) {
  const allowedNames = new Set(
    PERSONNEL_LIFECYCLE_CONVERSION_TRIGGER_DEFINITIONS.map(({ name }) => name),
  );
  for (const triggerName of triggerNames) {
    if (allowedNames.has(triggerName)) db.exec(`DROP TRIGGER IF EXISTS "${triggerName}"`);
  }
}

function rebuildEmptyPersonnelLifecycleConversionSchema() {
  db.exec("BEGIN IMMEDIATE");
  try {
    removePersonnelLifecycleConversionTriggers(
      PERSONNEL_LIFECYCLE_CONVERSION_TRIGGER_DEFINITIONS.map(({ name }) => name),
    );
    if (tableExists("candidate_conversions")) db.exec("DROP TABLE candidate_conversions");
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function repairPersonnelLifecycleConversionSchemaBeforeCreate(inspection) {
  if (inspection.invalidTables.length) {
    try {
      if (tableContainsRows("candidate_conversions")) {
        throw personnelLifecycleConversionSchemaDataError();
      }
    } catch (error) {
      if (error?.code === "PERSONNEL_LIFECYCLE_CONVERSION_SCHEMA_DATA_PRESENT") throw error;
      throw personnelLifecycleConversionSchemaDataError();
    }
    rebuildEmptyPersonnelLifecycleConversionSchema();
    return;
  }
  removePersonnelLifecycleConversionTriggers(inspection.invalidTriggers);
}

function validatePersonnelLifecycleConversionSchema() {
  const inspection = inspectSqlitePersonnelLifecycleConversionSchema(db);
  if (!inspection.valid) {
    const error = new Error(
      "Das Umwandlungsschema des Personalmoduls konnte nicht sicher auf den erwarteten Stand gebracht werden.",
    );
    error.code = "PERSONNEL_LIFECYCLE_CONVERSION_SCHEMA_INVALID";
    throw error;
  }
}

function normalizedSqliteSchemaSql(value, type = "table") {
  const prefix = type === "trigger"
    ? /^create trigger if not exists /i
    : /^create table if not exists /i;
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*;\s*$/, "")
    .replace(prefix, `create ${type} `)
    .toLowerCase();
}

function legacyPersonnelLifecycleScopedRightsSchemaPresent() {
  if (!tableExists("portal_permission_scope_grants")) return false;
  const row = db.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table' AND name = 'portal_permission_scope_grants'
  `).get();
  const storedSql = normalizedSqliteSchemaSql(row?.sql);
  return [
    PERSONNEL_LIFECYCLE_LEGACY_SCOPED_RIGHTS_TABLE_DEFINITION,
    PERSONNEL_LIFECYCLE_M4_SCOPED_RIGHTS_TABLE_DEFINITION,
    PERSONNEL_PROFILE_SCOPED_RIGHTS_TABLE_DEFINITION,
  ].some((definition) => storedSql === normalizedSqliteSchemaSql(definition.sql));
}

function migrateLegacyPersonnelLifecycleScopedRightsSchema() {
  const target = PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TABLE_DEFINITIONS[0];
  const copyTableName = "portal_permission_scope_grants_m7_copy";
  const copyTableExists = Boolean(db.prepare(`
    SELECT 1 FROM sqlite_temp_master WHERE type = 'table' AND name = ?
  `).get(copyTableName));
  if (!target || copyTableExists) {
    throw personnelLifecycleScopedRightsSchemaDataError();
  }
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    removePersonnelLifecycleScopedRightsTriggers(
      PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TRIGGER_DEFINITIONS.map(({ name }) => name),
    );
    db.exec(`
      CREATE TEMP TABLE portal_permission_scope_grants_m7_copy AS
      SELECT
        employee_number, permission, location_id, department_id,
        approved_by, created_at, updated_at
      FROM portal_permission_scope_grants;
      DROP TABLE portal_permission_scope_grants;
      ${target.sql}
      INSERT INTO portal_permission_scope_grants (
        employee_number, permission, location_id, department_id,
        approved_by, created_at, updated_at
      )
      SELECT
        employee_number, permission, location_id, department_id,
        approved_by, created_at, updated_at
      FROM portal_permission_scope_grants_m7_copy;
      DROP TABLE portal_permission_scope_grants_m7_copy;
    `);
    for (const trigger of PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TRIGGER_DEFINITIONS) {
      db.exec(trigger.sql);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function personnelLifecycleScopedRightsSchemaDataError() {
  const error = new Error(
    "Das bereichsbezogene Rechteschema des Personalmoduls weicht vom erwarteten Stand ab "
      + "oder enthaelt widerspruechliche Bereichsdaten. Die automatische Reparatur wurde "
      + "nach der Sicherheitssicherung ohne Datenaenderung beendet.",
  );
  error.code = "PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_SCHEMA_DATA_PRESENT";
  return error;
}

function removePersonnelLifecycleScopedRightsTriggers(triggerNames) {
  const allowedNames = new Set(
    PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TRIGGER_DEFINITIONS.map(({ name }) => name),
  );
  for (const triggerName of triggerNames) {
    if (allowedNames.has(triggerName)) db.exec(`DROP TRIGGER IF EXISTS "${triggerName}"`);
  }
}

function personnelLifecycleScopedRightsDataExists() {
  try {
    return PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TABLE_NAMES.some((tableName) => (
      tableExists(tableName) && tableContainsRows(tableName)
    ));
  } catch {
    throw personnelLifecycleScopedRightsSchemaDataError();
  }
}

function rebuildEmptyPersonnelLifecycleScopedRightsSchema() {
  db.exec("BEGIN IMMEDIATE");
  try {
    removePersonnelLifecycleScopedRightsTriggers(
      PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TRIGGER_DEFINITIONS.map(({ name }) => name),
    );
    for (const tableName of PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TABLE_NAMES) {
      if (tableExists(tableName)) db.exec(`DROP TABLE "${tableName}"`);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function repairPersonnelLifecycleScopedRightsSchemaBeforeCreate(inspection, rowInspection) {
  const schemaDiverges = !inspection.valid && !inspection.absent;
  const rowsDiverge = !rowInspection.valid;
  const scopedRowsDiverge = rowInspection.invalidPortalAccessScopes.length > 0
    || rowInspection.invalidPermissionScopes.length > 0;
  const containsScopedRightsData = personnelLifecycleScopedRightsDataExists();
  const legacyScopedRightsSchemaPresent = inspection.invalidTables.includes(
    "portal_permission_scope_grants",
  ) && legacyPersonnelLifecycleScopedRightsSchemaPresent();
  const legacyScopedRightsTriggersAreCanonical = inspection.missingTriggers.length === 0
    && inspection.invalidTriggers.length === 0;
  if (legacyScopedRightsSchemaPresent && !legacyScopedRightsTriggersAreCanonical) {
    throw personnelLifecycleScopedRightsSchemaDataError();
  }
  if (legacyScopedRightsSchemaPresent && !scopedRowsDiverge) {
    migrateLegacyPersonnelLifecycleScopedRightsSchema();
    return;
  }
  if ((schemaDiverges || rowsDiverge) && containsScopedRightsData) {
    throw personnelLifecycleScopedRightsSchemaDataError();
  }
  if (rowInspection.invalidPortalAccessScopes.length || rowInspection.invalidPermissionScopes.length) {
    throw personnelLifecycleScopedRightsSchemaDataError();
  }
  if (inspection.invalidTables.length) {
    rebuildEmptyPersonnelLifecycleScopedRightsSchema();
    return;
  }
  if (schemaDiverges && inspection.missingTables.length) {
    rebuildEmptyPersonnelLifecycleScopedRightsSchema();
    return;
  }
  removePersonnelLifecycleScopedRightsTriggers(inspection.invalidTriggers);
}

function validatePersonnelLifecycleScopedRightsSchema() {
  const inspection = inspectSqlitePersonnelLifecycleScopedRightsSchema(db);
  const rowInspection = inspectSqlitePersonnelLifecycleScopedRightsRows(db);
  if (!inspection.valid || !rowInspection.valid) {
    const error = new Error(
      "Das bereichsbezogene Rechteschema des Personalmoduls konnte nicht sicher "
        + "auf den erwarteten Stand gebracht werden.",
    );
    error.code = "PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_SCHEMA_INVALID";
    throw error;
  }
}

function personnelDocumentHistorySchemaDataError() {
  const error = new Error(
    "Das Dokumenthistorienschema der Personalakte weicht vom erwarteten Stand ab "
      + "oder enthaelt bereits widerspruechliche Fachdaten. Die automatische Reparatur wurde "
      + "nach der Sicherheitssicherung ohne Datenverlust beendet.",
  );
  error.code = "PERSONNEL_DOCUMENT_HISTORY_SCHEMA_DATA_PRESENT";
  return error;
}

function personnelDocumentHistoryBusinessDataExists() {
  try {
    for (const tableName of [
      "personnel_record_document_versions",
      "personnel_record_document_events",
    ]) {
      if (tableExists(tableName) && tableContainsRows(tableName)) return true;
    }
    if (tableExists("personnel_record_documents")
      && columnExists("personnel_record_documents", "current_version")
      && db.prepare(`
        SELECT 1 FROM personnel_record_documents
        WHERE current_version <> 0
        LIMIT 1
      `).get()) return true;
    if (tableExists("personnel_document_categories")) {
      const custom = db.prepare(`
        SELECT 1
        FROM personnel_document_categories
        WHERE id NOT IN ('contract','amendment','certificate','training','identity','payroll','other')
          OR builtin <> 1
        LIMIT 1
      `).get();
      if (custom) return true;
    }
    return false;
  } catch {
    throw personnelDocumentHistorySchemaDataError();
  }
}

function removePersonnelDocumentHistoryTriggers(triggerNames) {
  const allowed = new Set(
    PERSONNEL_DOCUMENT_HISTORY_TRIGGER_DEFINITIONS.map(({ name }) => name),
  );
  for (const name of triggerNames) {
    if (allowed.has(name)) db.exec(`DROP TRIGGER IF EXISTS "${name}"`);
  }
}

function rebuildEmptyPersonnelDocumentHistoryTables() {
  db.exec("BEGIN IMMEDIATE");
  try {
    removePersonnelDocumentHistoryTriggers(
      PERSONNEL_DOCUMENT_HISTORY_TRIGGER_DEFINITIONS.map(({ name }) => name),
    );
    for (const name of [...PERSONNEL_DOCUMENT_HISTORY_TABLE_NAMES].reverse()) {
      if (tableExists(name)) db.exec(`DROP TABLE "${name}"`);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function repairPersonnelDocumentHistorySchemaBeforeCreate(inspection, rowInspection) {
  const tablesDiverge = inspection.invalidTables.length > 0
    || (!inspection.absent && inspection.missingTables.length > 0);
  const rowsDiverge = !rowInspection.valid && !rowInspection.absent;
  if ((tablesDiverge || rowsDiverge) && personnelDocumentHistoryBusinessDataExists()) {
    throw personnelDocumentHistorySchemaDataError();
  }
  if (tablesDiverge) rebuildEmptyPersonnelDocumentHistoryTables();
  else removePersonnelDocumentHistoryTriggers(inspection.invalidTriggers);
}

function personnelDocumentHistoryEvent({
  documentId,
  sequenceNumber,
  eventType,
  previousReceiptSha256 = "",
  actorEmployeeNumber = "migration",
  createdAt,
}) {
  const id = `pdh-${workRuleSha256({
    schemaVersion: 1,
    documentId,
    sequenceNumber,
    eventType,
    createdAt,
  }).slice(0, 32)}`;
  const event = {
    id,
    document_id: documentId,
    sequence_number: sequenceNumber,
    event_type: eventType,
    previous_receipt_sha256: previousReceiptSha256,
    actor_employee_number: actorEmployeeNumber,
    created_at: createdAt,
  };
  return { ...event, receipt_sha256: personnelDocumentEventReceiptSha256(event) };
}

function backfillPersonnelDocumentHistory() {
  if (!tableExists("personnel_record_documents")) return { documents: 0, purged: 0 };
  const rows = db.prepare(`
    SELECT id, employee_number, storage_key, status, protected_payload,
           created_at, updated_at, deleted_by, deleted_at, current_version
    FROM personnel_record_documents
    ORDER BY created_at, id
  `).all();
  const insertVersion = db.prepare(`
    INSERT INTO personnel_record_document_versions (
      document_id, version_number, storage_key, protected_payload, created_by, created_at
    ) VALUES (?, 1, ?, ?, ?, ?)
  `);
  const updatePointer = db.prepare(`
    UPDATE personnel_record_documents
    SET current_version = 1, revision = revision + 1, updated_at = ?
    WHERE id = ? AND current_version = 0
  `);
  const activateLegacy = db.prepare(`
    UPDATE personnel_record_documents
    SET status = 'active'
    WHERE id = ? AND status = 'deleted' AND current_version = 0
  `);
  const archiveLegacy = db.prepare(`
    UPDATE personnel_record_documents
    SET status = 'archived', archived_by = ?, archived_at = ?,
        revision = revision + 1, updated_at = ?
    WHERE id = ? AND status = 'active' AND current_version = 1 AND revision = 2
  `);
  const insertEvent = db.prepare(`
    INSERT INTO personnel_record_document_events (
      id, document_id, sequence_number, event_type, previous_receipt_sha256,
      receipt_sha256, actor_employee_number, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let documents = 0;
  let purged = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      if (Number(row.current_version || 0) !== 0) continue;
      const createdAt = String(row.created_at || row.updated_at || new Date(0).toISOString());
      if (row.status === "purged") {
        const event = personnelDocumentHistoryEvent({
          documentId: row.id,
          sequenceNumber: 1,
          eventType: "legacy_purged",
          actorEmployeeNumber: String(row.deleted_by || "migration"),
          createdAt: String(row.deleted_at || row.updated_at || createdAt),
        });
        insertEvent.run(
          event.id, event.document_id, event.sequence_number, event.event_type,
          event.previous_receipt_sha256, event.receipt_sha256,
          event.actor_employee_number, event.created_at,
        );
        purged += 1;
        continue;
      }
      const actor = String(row.deleted_by || "migration");
      const deletedLegacy = row.status === "deleted";
      if (deletedLegacy && activateLegacy.run(row.id).changes !== 1) {
        throw new Error("legacy personnel document activation failed");
      }
      insertVersion.run(
        row.id,
        row.storage_key,
        row.protected_payload,
        actor,
        createdAt,
      );
      if (updatePointer.run(String(row.updated_at || createdAt), row.id).changes !== 1) {
        throw new Error("legacy personnel document pointer update failed");
      }
      const registered = personnelDocumentHistoryEvent({
        documentId: row.id,
        sequenceNumber: 1,
        eventType: "registered",
        actorEmployeeNumber: actor,
        createdAt,
      });
      insertEvent.run(
        registered.id, registered.document_id, registered.sequence_number,
        registered.event_type, registered.previous_receipt_sha256,
        registered.receipt_sha256, registered.actor_employee_number, registered.created_at,
      );
      if (deletedLegacy) {
        const archivedAt = String(row.deleted_at || row.updated_at || createdAt);
        if (archiveLegacy.run(actor, archivedAt, archivedAt, row.id).changes !== 1) {
          throw new Error("legacy personnel document archive failed");
        }
        const archived = personnelDocumentHistoryEvent({
          documentId: row.id,
          sequenceNumber: 2,
          eventType: "archived",
          previousReceiptSha256: registered.receipt_sha256,
          actorEmployeeNumber: actor,
          createdAt: archivedAt,
        });
        insertEvent.run(
          archived.id, archived.document_id, archived.sequence_number,
          archived.event_type, archived.previous_receipt_sha256,
          archived.receipt_sha256, archived.actor_employee_number, archived.created_at,
        );
      }
      documents += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return { documents, purged };
}

function validatePersonnelDocumentHistorySchema() {
  const schema = inspectSqlitePersonnelDocumentHistorySchema(db);
  const rows = inspectSqlitePersonnelDocumentHistoryRows(db);
  if (!schema.valid || !rows.valid) {
    const error = new Error(
      "Das Dokumenthistorienschema der Personalakte konnte nicht sicher auf den erwarteten Stand gebracht werden.",
    );
    error.code = "PERSONNEL_DOCUMENT_HISTORY_SCHEMA_INVALID";
    throw error;
  }
}

function personnelWorkflowSchemaDataError() {
  const error = new Error(
    "Das Publikationsschema der Personal-Workflows weicht vom erwarteten Stand ab "
      + "oder enthaelt widerspruechliche Versionsdaten. Die automatische Reparatur wurde "
      + "nach der Sicherheitssicherung ohne Datenaenderung beendet.",
  );
  error.code = "PERSONNEL_WORKFLOW_SCHEMA_DATA_PRESENT";
  return error;
}

function removePersonnelWorkflowTriggers(triggerNames) {
  const allowed = new Set(PERSONNEL_WORKFLOW_TRIGGER_DEFINITIONS.map(({ name }) => name));
  for (const name of triggerNames) {
    if (allowed.has(name)) db.exec(`DROP TRIGGER IF EXISTS "${name}"`);
  }
}

function personnelWorkflowDataExists() {
  try {
    return PERSONNEL_WORKFLOW_TABLE_NAMES.some((name) => (
      tableExists(name) && tableContainsRows(name)
    ));
  } catch {
    throw personnelWorkflowSchemaDataError();
  }
}

function rebuildEmptyPersonnelWorkflowSchema() {
  db.exec("BEGIN IMMEDIATE");
  try {
    removePersonnelWorkflowTriggers(
      PERSONNEL_WORKFLOW_TRIGGER_DEFINITIONS.map(({ name }) => name),
    );
    for (const name of [...PERSONNEL_WORKFLOW_TABLE_NAMES].reverse()) {
      if (tableExists(name)) db.exec(`DROP TABLE "${name}"`);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function repairPersonnelWorkflowSchemaBeforeCreate(inspection, rowInspection) {
  const schemaDiverges = !inspection.valid && !inspection.absent;
  const rowsDiverge = !rowInspection.valid
    && !rowInspection.issues.every((issue) => issue === "schema-invalid");
  if ((schemaDiverges || rowsDiverge) && personnelWorkflowDataExists()) {
    throw personnelWorkflowSchemaDataError();
  }
  if (rowsDiverge) throw personnelWorkflowSchemaDataError();
  if (inspection.invalidTables.length
    || (schemaDiverges && inspection.missingTables.length)) {
    rebuildEmptyPersonnelWorkflowSchema();
    return;
  }
  removePersonnelWorkflowTriggers(inspection.invalidTriggers);
}

function validatePersonnelWorkflowSchema() {
  const schema = inspectSqlitePersonnelWorkflowSchema(db);
  const rows = inspectSqlitePersonnelWorkflowRows(db);
  if (!schema.valid || !rows.valid) {
    const error = new Error(
      "Das Publikationsschema der Personal-Workflows konnte nicht sicher auf den erwarteten Stand gebracht werden.",
    );
    error.code = "PERSONNEL_WORKFLOW_SCHEMA_INVALID";
    throw error;
  }
}

function personnelWorkflowInstanceSchemaDataError() {
  const error = new Error(
    "Das Instanzschema der Personal-Workflows weicht vom erwarteten Stand ab "
      + "oder enthaelt widerspruechliche Bindungsdaten. Die automatische Reparatur wurde "
      + "nach der Sicherheitssicherung ohne Datenaenderung beendet.",
  );
  error.code = "PERSONNEL_WORKFLOW_INSTANCE_SCHEMA_DATA_PRESENT";
  return error;
}

function removePersonnelWorkflowInstanceTriggers(triggerNames) {
  const allowed = new Set(
    PERSONNEL_WORKFLOW_INSTANCE_TRIGGER_DEFINITIONS.map(({ name }) => name),
  );
  for (const name of triggerNames) {
    if (allowed.has(name)) db.exec(`DROP TRIGGER IF EXISTS "${name}"`);
  }
}

function personnelWorkflowInstanceDataExists() {
  try {
    if (PERSONNEL_WORKFLOW_INSTANCE_TABLE_NAMES.some((name) => (
      tableExists(name) && tableContainsRows(name)
    ))) return true;
    return tableExists("custom_process_runs")
      && columnExists("custom_process_runs", "trigger_type")
      && Boolean(db.prepare(`
        SELECT 1 FROM custom_process_runs
        WHERE trigger_type = 'personnel_manual'
        LIMIT 1
      `).get());
  } catch {
    throw personnelWorkflowInstanceSchemaDataError();
  }
}

function rebuildEmptyPersonnelWorkflowInstanceSchema() {
  db.exec("BEGIN IMMEDIATE");
  try {
    removePersonnelWorkflowInstanceTriggers(
      PERSONNEL_WORKFLOW_INSTANCE_TRIGGER_DEFINITIONS.map(({ name }) => name),
    );
    for (const name of [...PERSONNEL_WORKFLOW_INSTANCE_TABLE_NAMES].reverse()) {
      if (tableExists(name)) db.exec(`DROP TABLE "${name}"`);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function repairPersonnelWorkflowInstanceSchemaBeforeCreate(inspection, rowInspection) {
  const schemaDiverges = !inspection.valid && !inspection.absent;
  const dependencyGap = !rowInspection.valid
    && rowInspection.issues.some((issue) => issue.startsWith("dependency-missing:"))
    && rowInspection.issues.every((issue) => (
      issue === "schema-invalid" || issue.startsWith("dependency-missing:")
    ));
  const rowsDiverge = !rowInspection.valid
    && !dependencyGap
    && !rowInspection.issues.every((issue) => issue === "schema-invalid");
  if ((schemaDiverges || rowsDiverge || dependencyGap)
    && personnelWorkflowInstanceDataExists()) {
    throw personnelWorkflowInstanceSchemaDataError();
  }
  if (rowsDiverge) throw personnelWorkflowInstanceSchemaDataError();
  if (inspection.invalidTables.length
    || (schemaDiverges && inspection.missingTables.length)) {
    rebuildEmptyPersonnelWorkflowInstanceSchema();
    return;
  }
  removePersonnelWorkflowInstanceTriggers(inspection.invalidTriggers);
}

function validatePersonnelWorkflowInstanceSchema() {
  const schema = inspectSqlitePersonnelWorkflowInstanceSchema(db);
  const rows = inspectSqlitePersonnelWorkflowInstanceRows(db);
  if (!schema.valid || !rows.valid) {
    const error = new Error(
      "Das Instanzschema der Personal-Workflows konnte nicht sicher auf den erwarteten Stand gebracht werden.",
    );
    error.code = "PERSONNEL_WORKFLOW_INSTANCE_SCHEMA_INVALID";
    throw error;
  }
}

function personnelLifecycleCaseFoundationSchemaDataError() {
  const error = new Error(
    "Das O2-Fallfundament weicht vom erwarteten read-only Stand ab oder enthaelt "
      + "bereits Falldaten. Die automatische Reparatur wurde nach der "
      + "Sicherheitssicherung ohne Datenaenderung beendet.",
  );
  error.code = "PERSONNEL_LIFECYCLE_CASE_FOUNDATION_SCHEMA_DATA_PRESENT";
  return error;
}

function removePersonnelLifecycleCaseFoundationTriggers(triggerNames) {
  const allowed = new Set(
    PERSONNEL_LIFECYCLE_CASE_TRIGGER_DEFINITIONS.map(({ name }) => name),
  );
  for (const name of triggerNames) {
    if (allowed.has(name)) db.exec(`DROP TRIGGER IF EXISTS "${name}"`);
  }
}

function personnelLifecycleCaseFoundationDataExists() {
  try {
    return PERSONNEL_LIFECYCLE_CASE_TABLE_NAMES.some((name) => (
      tableExists(name) && tableContainsRows(name)
    ));
  } catch {
    throw personnelLifecycleCaseFoundationSchemaDataError();
  }
}

function rebuildEmptyPersonnelLifecycleCaseFoundationSchema() {
  db.exec("BEGIN IMMEDIATE");
  try {
    removePersonnelLifecycleCaseFoundationTriggers(
      PERSONNEL_LIFECYCLE_CASE_TRIGGER_DEFINITIONS.map(({ name }) => name),
    );
    for (const name of [...PERSONNEL_LIFECYCLE_CASE_TABLE_NAMES].reverse()) {
      if (tableExists(name)) db.exec(`DROP TABLE "${name}"`);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function repairPersonnelLifecycleCaseFoundationSchemaBeforeCreate(
  inspection,
  rowInspection,
) {
  const schemaDiverges = !inspection.valid && !inspection.absent;
  const dependencyGap = !rowInspection.valid
    && rowInspection.issues.some((issue) => issue.startsWith("dependency-missing:"))
    && rowInspection.issues.every((issue) => (
      issue === "schema-invalid" || issue.startsWith("dependency-missing:")
    ));
  const rowsDiverge = !rowInspection.valid
    && !dependencyGap
    && !rowInspection.issues.every((issue) => issue === "schema-invalid");
  if ((schemaDiverges || rowsDiverge || dependencyGap)
    && personnelLifecycleCaseFoundationDataExists()) {
    throw personnelLifecycleCaseFoundationSchemaDataError();
  }
  if (rowsDiverge) throw personnelLifecycleCaseFoundationSchemaDataError();
  if (inspection.invalidTables.length
    || (schemaDiverges && inspection.missingTables.length)) {
    rebuildEmptyPersonnelLifecycleCaseFoundationSchema();
    return;
  }
  removePersonnelLifecycleCaseFoundationTriggers(inspection.invalidTriggers);
}

function validatePersonnelLifecycleCaseFoundationSchema() {
  const schema = inspectSqlitePersonnelLifecycleCaseSchema(db);
  const rows = inspectSqlitePersonnelLifecycleCaseRows(db);
  if (!schema.valid || !rows.valid) {
    const error = new Error(
      "Das O2-Fall- und Instanzfundament konnte nicht sicher auf den erwarteten "
        + "read-only Stand gebracht werden.",
    );
    error.code = "PERSONNEL_LIFECYCLE_CASE_FOUNDATION_SCHEMA_INVALID";
    throw error;
  }
}

function validatePersonnelLifecycleOnboardingSchema() {
  const schema = inspectSqlitePersonnelLifecycleOnboardingSchema(db);
  const rows = inspectSqlitePersonnelLifecycleOnboardingRows(db);
  if (!schema.valid || !rows.valid) {
    const error = new Error(
      "Das O4-Onboarding-Schema konnte nicht sicher auf den erwarteten Stand gebracht werden.",
    );
    error.code = "PERSONNEL_LIFECYCLE_ONBOARDING_SCHEMA_INVALID";
    error.details = Object.freeze([...(schema.issues || []), ...(rows.issues || [])]);
    throw error;
  }
}

function validatePersonnelLifecycleOffboardingSchema() {
  const schema = inspectSqlitePersonnelLifecycleOffboardingSchema(db);
  const rows = inspectSqlitePersonnelLifecycleOffboardingRows(db);
  if (!schema.valid || !rows.valid) {
    const error = new Error(
      "Das O5-Offboarding-Schema konnte nicht sicher auf den erwarteten Stand gebracht werden.",
    );
    error.code = "PERSONNEL_LIFECYCLE_OFFBOARDING_SCHEMA_INVALID";
    error.details = Object.freeze([...(schema.issues || []), ...(rows.issues || [])]);
    throw error;
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
const personalNotificationContactsSchemaBeforeMigration =
  inspectSqlitePersonalNotificationContactsSchema(db);
const personalNotificationContactsMigrationRequired = !tableExists("schema_migrations")
  || !db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1")
    .get(personalNotificationContactsMigrationId)
  || !personalNotificationContactsSchemaBeforeMigration.valid;
const personnelLifecycleSchemaBeforeMigration = inspectSqlitePersonnelLifecycleSchema(db);
const personnelLifecycleMigrationRequired = !tableExists("schema_migrations")
  || !db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1")
    .get(personnelLifecycleMigrationId)
  || !personnelLifecycleSchemaBeforeMigration.valid;
const personnelLifecycleConversionSchemaBeforeMigration =
  inspectSqlitePersonnelLifecycleConversionSchema(db);
const personnelLifecycleConversionMigrationRequired = !tableExists("schema_migrations")
  || !db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1")
    .get(personnelLifecycleConversionMigrationId)
  || !personnelLifecycleConversionSchemaBeforeMigration.valid;
const personnelLifecycleScopedRightsSchemaBeforeMigration =
  inspectSqlitePersonnelLifecycleScopedRightsSchema(db);
const personnelLifecycleScopedRightsRowsBeforeMigration =
  inspectSqlitePersonnelLifecycleScopedRightsRows(db);
const personnelLifecycleScopedRightsMigrationRequired = !tableExists("schema_migrations")
  || !db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1")
    .get(personnelLifecycleScopedRightsMigrationId)
  || !personnelLifecycleScopedRightsSchemaBeforeMigration.valid
  || !personnelLifecycleScopedRightsRowsBeforeMigration.valid;
const personnelProfileScopedRightsMigrationRequired = !tableExists("schema_migrations")
  || !db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1")
    .get(personnelProfileScopedRightsMigrationId)
  || !personnelLifecycleScopedRightsSchemaBeforeMigration.valid
  || !personnelLifecycleScopedRightsRowsBeforeMigration.valid;
const personnelLifecycleOperationalScopedRightsMigrationRequired = !tableExists("schema_migrations")
  || !db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1")
    .get(personnelLifecycleOperationalScopedRightsMigrationId)
  || !personnelLifecycleScopedRightsSchemaBeforeMigration.valid
  || !personnelLifecycleScopedRightsRowsBeforeMigration.valid;
const personnelDocumentHistorySchemaBeforeMigration =
  inspectSqlitePersonnelDocumentHistorySchema(db);
const personnelDocumentHistoryRowsBeforeMigration =
  inspectSqlitePersonnelDocumentHistoryRows(db);
const personnelDocumentHistoryMigrationRequired = !tableExists("schema_migrations")
  || !db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1")
    .get(personnelDocumentHistoryMigrationId)
  || !personnelDocumentHistorySchemaBeforeMigration.valid
  || !personnelDocumentHistoryRowsBeforeMigration.valid;
const personnelWorkflowSchemaBeforeMigration = inspectSqlitePersonnelWorkflowSchema(db);
const personnelWorkflowRowsBeforeMigration = inspectSqlitePersonnelWorkflowRows(db);
const personnelWorkflowMigrationRequired = !tableExists("schema_migrations")
  || !db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1")
    .get(personnelWorkflowMigrationId)
  || !personnelWorkflowSchemaBeforeMigration.valid
  || !personnelWorkflowRowsBeforeMigration.valid;
const personnelWorkflowInstanceSchemaBeforeMigration =
  inspectSqlitePersonnelWorkflowInstanceSchema(db);
const personnelWorkflowInstanceRowsBeforeMigration =
  inspectSqlitePersonnelWorkflowInstanceRows(db);
const personnelWorkflowInstanceAssignedEmployeeMigrationRequired =
  tableExists("custom_process_run_step_assignments")
  && tableExists("personnel_lifecycle_case_package_runs")
  && tableExists("personnel_lifecycle_case_package_bindings")
  && tableExists("personnel_lifecycle_cases")
  && (!tableExists("schema_migrations")
    || !db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1")
      .get(personnelWorkflowInstanceAssignedEmployeeMigrationId));
const personnelWorkflowInstanceAssignedEmployeeTriggerDriftOnly =
  !personnelWorkflowInstanceSchemaBeforeMigration.valid
  && personnelWorkflowInstanceSchemaBeforeMigration.issues.length === 1
  && [
    `trigger-invalid:${PERSONNEL_WORKFLOW_INSTANCE_ASSIGNED_EMPLOYEE_TRIGGER_NAME}`,
    `trigger-missing:${PERSONNEL_WORKFLOW_INSTANCE_ASSIGNED_EMPLOYEE_TRIGGER_NAME}`,
  ].includes(personnelWorkflowInstanceSchemaBeforeMigration.issues[0]);
const personnelWorkflowInstanceRowsBlockedOnlyByAssignedEmployeeTrigger =
  personnelWorkflowInstanceAssignedEmployeeTriggerDriftOnly
  && personnelWorkflowInstanceRowsBeforeMigration.issues.length === 1
  && personnelWorkflowInstanceRowsBeforeMigration.issues[0] === "schema-invalid";
const personnelWorkflowInstanceMigrationRequired = !tableExists("schema_migrations")
  || !db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1")
    .get(personnelWorkflowInstanceMigrationId)
  || (!personnelWorkflowInstanceSchemaBeforeMigration.valid
    && !(personnelWorkflowInstanceAssignedEmployeeMigrationRequired
      && personnelWorkflowInstanceAssignedEmployeeTriggerDriftOnly))
  || (!personnelWorkflowInstanceRowsBeforeMigration.valid
    && !(personnelWorkflowInstanceAssignedEmployeeMigrationRequired
      && personnelWorkflowInstanceRowsBlockedOnlyByAssignedEmployeeTrigger));
const personnelLifecycleCaseFoundationSchemaBeforeMigration =
  inspectSqlitePersonnelLifecycleCaseSchema(db);
const personnelLifecycleCaseFoundationRowsBeforeMigration =
  inspectSqlitePersonnelLifecycleCaseRows(db);
const personnelLifecycleOnboardingSchemaBeforeMigration =
  inspectSqlitePersonnelLifecycleOnboardingSchema(db);
const personnelLifecycleOnboardingRowsBeforeMigration =
  inspectSqlitePersonnelLifecycleOnboardingRows(db);
const personnelLifecycleOnboardingMigrationRequired = !tableExists("schema_migrations")
  || !db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1")
    .get(personnelLifecycleOnboardingMigrationId)
  || !personnelLifecycleOnboardingSchemaBeforeMigration.valid
  || !personnelLifecycleOnboardingRowsBeforeMigration.valid;
const personnelLifecycleOffboardingSchemaBeforeMigration =
  inspectSqlitePersonnelLifecycleOffboardingSchema(db);
const personnelLifecycleOffboardingRowsBeforeMigration =
  inspectSqlitePersonnelLifecycleOffboardingRows(db);
const personnelLifecycleOffboardingMigrationRequired = !tableExists("schema_migrations")
  || !db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1")
    .get(personnelLifecycleOffboardingMigrationId)
  || !personnelLifecycleOffboardingSchemaBeforeMigration.valid
  || !personnelLifecycleOffboardingRowsBeforeMigration.valid;
const personnelLifecycleOffboardingAssignedEmployeeMigrationRequired =
  tableExists("personnel_lifecycle_offboarding_operations")
  && (!tableExists("schema_migrations")
    || !db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1")
      .get(personnelLifecycleOffboardingAssignedEmployeeMigrationId));
const personnelLifecycleCaseFoundationMigrationRequired =
  personnelLifecycleOnboardingSchemaBeforeMigration.absent
  && (!tableExists("schema_migrations")
    || !db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1")
      .get(personnelLifecycleCaseFoundationMigrationId)
    || !personnelLifecycleCaseFoundationSchemaBeforeMigration.valid
    || !personnelLifecycleCaseFoundationRowsBeforeMigration.valid);
if (databaseExistedBeforeOpen && (portalMobileBaselineMigrationRequired || protectedPersonnelMigrationRequired
  || unreleasedSicknessDraftSchemaPresent || legacySchemaMigrationRequired || costCenterMigrationRequired
  || costCenterTypeMigrationRequired || employeeCostCenterAssignmentMigrationRequired
  || shiftLocationMigrationRequired || workRuleMigrationRequired || privacyGovernanceMigrationRequired
  || vacationHistoryProtectionMigrationRequired || payrollHandoffMigrationRequired
   || productReadinessMigrationRequired || loanModuleMigrationRequired || loanPhotoPdfMigrationRequired
   || collectiveAgreementMigrationRequired || workRuleGovernanceMigrationRequired
   || block7SettingsMigrationRequired || principalSeparationMigrationRequired
   || personalNotificationContactsMigrationRequired || personnelLifecycleMigrationRequired
   || personnelLifecycleConversionMigrationRequired
   || personnelLifecycleScopedRightsMigrationRequired
   || personnelProfileScopedRightsMigrationRequired
   || personnelLifecycleOperationalScopedRightsMigrationRequired
   || personnelDocumentHistoryMigrationRequired
   || personnelWorkflowMigrationRequired
   || personnelWorkflowInstanceMigrationRequired
   || personnelWorkflowInstanceAssignedEmployeeMigrationRequired
   || personnelLifecycleCaseFoundationMigrationRequired
   || personnelLifecycleOnboardingMigrationRequired
   || personnelLifecycleOffboardingMigrationRequired
   || personnelLifecycleOffboardingAssignedEmployeeMigrationRequired)) {
  createInternalDatabaseBackup("pre-migration");
}

if (personnelLifecycleMigrationRequired) {
  repairPersonnelLifecycleSchemaBeforeCreate(personnelLifecycleSchemaBeforeMigration);
}
if (personnelLifecycleConversionMigrationRequired) {
  repairPersonnelLifecycleConversionSchemaBeforeCreate(
    personnelLifecycleConversionSchemaBeforeMigration,
  );
}
if (personnelLifecycleScopedRightsMigrationRequired
  || personnelProfileScopedRightsMigrationRequired
  || personnelLifecycleOperationalScopedRightsMigrationRequired) {
  repairPersonnelLifecycleScopedRightsSchemaBeforeCreate(
    personnelLifecycleScopedRightsSchemaBeforeMigration,
    personnelLifecycleScopedRightsRowsBeforeMigration,
  );
}
if (personnelDocumentHistoryMigrationRequired) {
  repairPersonnelDocumentHistorySchemaBeforeCreate(
    personnelDocumentHistorySchemaBeforeMigration,
    personnelDocumentHistoryRowsBeforeMigration,
  );
}
if (personnelWorkflowMigrationRequired) {
  repairPersonnelWorkflowSchemaBeforeCreate(
    personnelWorkflowSchemaBeforeMigration,
    personnelWorkflowRowsBeforeMigration,
  );
}
if (personnelWorkflowInstanceAssignedEmployeeMigrationRequired) {
  migrateSqlitePersonnelWorkflowInstanceAssignedEmployeeTrigger(db);
}
if (personnelWorkflowInstanceMigrationRequired) {
  repairPersonnelWorkflowInstanceSchemaBeforeCreate(
    personnelWorkflowInstanceSchemaBeforeMigration,
    personnelWorkflowInstanceRowsBeforeMigration,
  );
}
if (personnelLifecycleCaseFoundationMigrationRequired) {
  repairPersonnelLifecycleCaseFoundationSchemaBeforeCreate(
    personnelLifecycleCaseFoundationSchemaBeforeMigration,
    personnelLifecycleCaseFoundationRowsBeforeMigration,
  );
}
if (personnelLifecycleOffboardingAssignedEmployeeMigrationRequired) {
  migrateSqlitePersonnelLifecycleOffboardingAssignedEmployeeTrigger(db);
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

if (personalNotificationContactsMigrationRequired
  && legacyPersonalNotificationContactsSchemaPresent()) {
  rebuildLegacyPersonalNotificationContacts();
}

if (legacySchemaMigrationRequired) {
  migrateLegacySchema();
} else {
  createSchema();
}
createSchema();
if (personnelDocumentHistoryMigrationRequired) backfillPersonnelDocumentHistory();
const reservedEmployeePrincipal = db.prepare(`
  SELECT personnel_number
  FROM employees
  WHERE LOWER(TRIM(
    personnel_number,
    CHAR(9) || CHAR(10) || CHAR(11) || CHAR(12) || CHAR(13) || CHAR(32)
  )) = 'local'
  LIMIT 1
`).get();
if (reservedEmployeePrincipal) {
  const error = new Error(
    "Die Datenbank enthaelt die reservierte Personalnummer local. "
      + "Der Serverstart wurde aus Sicherheitsgruenden abgebrochen; bitte den Konflikt kontrolliert bereinigen.",
  );
  error.code = "EMPLOYEE_PRINCIPAL_RESERVED";
  throw error;
}
validatePersonnelLifecycleSchema();
validatePersonnelLifecycleConversionSchema();
validatePersonnelLifecycleScopedRightsSchema();
validatePersonnelDocumentHistorySchema();
validatePersonnelWorkflowSchema();
validatePersonnelWorkflowInstanceSchema();
validatePersonnelLifecycleOnboardingSchema();
validatePersonnelLifecycleOffboardingSchema();
const personalNotificationContactsSchemaAfterMigration =
  inspectSqlitePersonalNotificationContactsSchema(db);
if (!personalNotificationContactsSchemaAfterMigration.valid) {
  throw new Error(
    "Die Tabelle personal_notification_contacts entspricht nicht dem erforderlichen Schema: "
      + personalNotificationContactsSchemaAfterMigration.issues.join(", "),
  );
}
if (personalNotificationContactsMigrationRequired) {
  db.prepare(`
    UPDATE sickness_notification_preferences
    SET
      protected_destination = '',
      verified_at = NULL,
      verification_hash = '',
      verification_salt = '',
      verification_expires_at = NULL,
      verification_attempts = 0,
      verification_sent_at = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE protected_destination <> ''
      OR verified_at IS NOT NULL
      OR verification_hash <> ''
      OR verification_salt <> ''
      OR verification_expires_at IS NOT NULL
      OR verification_attempts <> 0
      OR verification_sent_at IS NOT NULL
  `).run();
  db.prepare("DELETE FROM outbound_notification_jobs").run();
}
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run(personalNotificationContactsMigrationId, packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run(personnelLifecycleMigrationId, packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run(personnelLifecycleConversionMigrationId, packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run(personnelLifecycleScopedRightsMigrationId, packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run(personnelProfileScopedRightsMigrationId, packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run(personnelLifecycleOperationalScopedRightsMigrationId, packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run(personnelDocumentHistoryMigrationId, packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run(personnelWorkflowMigrationId, packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run(personnelWorkflowInstanceMigrationId, packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run(personnelWorkflowInstanceAssignedEmployeeMigrationId, packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run(personnelLifecycleCaseFoundationMigrationId, packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run(personnelLifecycleOnboardingMigrationId, packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run(personnelLifecycleOffboardingMigrationId, packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run(personnelLifecycleOffboardingAssignedEmployeeMigrationId, packageMetadata.version);
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
ensureColumn("loan_location_settings", "branch_overview_columns", "TEXT NOT NULL DEFAULT '[\"borrowerName\",\"description\",\"articleNumber\",\"serialNumber\",\"dueDate\"]'");
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
    personalNotificationContactsMigrationId,
    personnelLifecycleConversionMigrationId,
    personnelLifecycleConversionMigrationRequired,
    personnelLifecycleMigrationId,
    personnelLifecycleMigrationRequired,
    personnelLifecycleCaseFoundationMigrationId,
    personnelLifecycleCaseFoundationMigrationRequired,
    personnelLifecycleOnboardingMigrationId,
    personnelLifecycleOnboardingMigrationRequired,
    personnelLifecycleOffboardingMigrationId,
    personnelLifecycleOffboardingMigrationRequired,
    personnelLifecycleOffboardingAssignedEmployeeMigrationId,
    personnelLifecycleOffboardingAssignedEmployeeMigrationRequired,
    personnelLifecycleScopedRightsMigrationId,
    personnelLifecycleScopedRightsMigrationRequired,
    personnelProfileScopedRightsMigrationId,
    personnelProfileScopedRightsMigrationRequired,
    personnelLifecycleOperationalScopedRightsMigrationId,
    personnelLifecycleOperationalScopedRightsMigrationRequired,
    personnelDocumentHistoryMigrationId,
    personnelDocumentHistoryMigrationRequired,
    personnelWorkflowMigrationId,
    personnelWorkflowMigrationRequired,
    personnelWorkflowInstanceMigrationId,
    personnelWorkflowInstanceMigrationRequired,
    personnelWorkflowInstanceAssignedEmployeeMigrationId,
    personnelWorkflowInstanceAssignedEmployeeMigrationRequired,
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
