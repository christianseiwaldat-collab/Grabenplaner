"use strict";

const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
} = require("../../errors");
const {
  openSqliteLegacyDatabase,
} = require("../provider");
const {
  inspectSqlitePersonalNotificationContactRows,
  inspectSqlitePersonalNotificationContactsSchema,
} = require("./application-schema");
const {
  inspectSqlitePersonnelLifecycleConversionSchema,
  inspectSqlitePersonnelLifecycleScopedRightsRows,
  inspectSqlitePersonnelLifecycleScopedRightsSchema,
} = require("./personnel-lifecycle-schema");
const {
  inspectSqlitePersonnelWorkflowRows,
  inspectSqlitePersonnelWorkflowSchema,
} = require("./personnel-workflow-schema");

const SQLITE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function invalidImportOperation(operation, cause) {
  return new PersistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, {
    operation,
    cause,
  });
}

function quotedIdentifier(value) {
  const identifier = String(value || "");
  if (!SQLITE_IDENTIFIER.test(identifier)) throw invalidImportOperation("database-import");
  return `"${identifier}"`;
}

function tableHasColumn(database, tableName, columnName) {
  const table = quotedIdentifier(tableName);
  return database.prepare(`PRAGMA table_info(${table})`).all()
    .some((column) => column.name === String(columnName || ""));
}

function rowsWhenColumnExists(database, tableName, columnName, sql, onError) {
  try {
    return tableHasColumn(database, tableName, columnName)
      ? database.prepare(sql).all()
      : [];
  } catch {
    onError();
    return [];
  }
}

function inspectSqliteImportForeignKeyIntegrity(database) {
  if (!database || typeof database.prepare !== "function") {
    throw invalidImportOperation("database-import-foreign-key-integrity");
  }
  try {
    const violationCount = database.prepare("PRAGMA foreign_key_check").all().length;
    return Object.freeze({
      valid: violationCount === 0,
      violationCount,
    });
  } catch (error) {
    throw invalidImportOperation("database-import-foreign-key-integrity", error);
  }
}

function applyBrandingSnapshotToSqliteFile(importPath, snapshot = {}) {
  const imported = openSqliteLegacyDatabase(importPath);
  try {
    imported.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pdf_settings (
        scope_type TEXT NOT NULL,
        location_id TEXT NOT NULL,
        department_key TEXT NOT NULL DEFAULT '',
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (scope_type, location_id, department_key, key)
      );
      CREATE TABLE IF NOT EXISTS location_branding (
        location_id TEXT PRIMARY KEY,
        kit_id TEXT NOT NULL DEFAULT 'custom',
        company_name TEXT NOT NULL DEFAULT '',
        logo_url TEXT NOT NULL DEFAULT '/assets/grabenplaner-logo.svg',
        icon_url TEXT NOT NULL DEFAULT '/assets/webicon.svg',
        logo_alt TEXT NOT NULL DEFAULT 'Grabenplaner',
        admin_email TEXT NOT NULL DEFAULT '',
        updated_by TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (location_id) REFERENCES locations(id)
          ON UPDATE CASCADE ON DELETE CASCADE
      );
    `);
    const updateSetting = imported.prepare(`
      INSERT INTO settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    const updatePdfSetting = imported.prepare(`
      INSERT INTO pdf_settings (
        scope_type,
        location_id,
        department_key,
        key,
        value,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(scope_type, location_id, department_key, key)
      DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `);
    const updateLocationBranding = imported.prepare(`
      INSERT INTO location_branding (
        location_id,
        kit_id,
        company_name,
        logo_url,
        icon_url,
        logo_alt,
        admin_email,
        updated_by,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(location_id) DO UPDATE SET
        kit_id = excluded.kit_id,
        company_name = excluded.company_name,
        logo_url = excluded.logo_url,
        icon_url = excluded.icon_url,
        logo_alt = excluded.logo_alt,
        admin_email = excluded.admin_email,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP
    `);
    imported.exec("BEGIN IMMEDIATE");
    try {
      for (const row of snapshot.settings || []) updateSetting.run(row.key, row.value);
      for (const row of snapshot.pdfSettings || []) {
        updatePdfSetting.run(
          row.scopeType,
          row.locationId,
          row.departmentKey || "",
          row.key,
          row.value,
        );
      }
      imported.prepare("DELETE FROM location_branding").run();
      const importedLocationExists = imported.prepare("SELECT 1 FROM locations WHERE id = ?");
      for (const row of snapshot.locationBranding || []) {
        if (!importedLocationExists.get(row.locationId)) continue;
        updateLocationBranding.run(
          row.locationId,
          row.kitId,
          row.companyName,
          row.logoUrl,
          row.iconUrl,
          row.logoAlt,
          row.adminEmail,
          row.updatedBy || "",
        );
      }
      imported.exec("COMMIT");
    } catch (error) {
      imported.exec("ROLLBACK");
      throw error;
    }
  } finally {
    imported.close();
  }
}

function inspectSqliteImportFile(importPath) {
  const imported = openSqliteLegacyDatabase(importPath, { readOnly: true });
  try {
    let protectedInspectionError = false;
    let integrationInspectionError = false;
    const protectedRows = (...args) => rowsWhenColumnExists(
      imported,
      ...args,
      () => { protectedInspectionError = true; },
    );
    imported.prepare("SELECT name FROM sqlite_master LIMIT 1").all();
    const tableExists = imported.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    );
    const personalNotificationContactsSchema =
      inspectSqlitePersonalNotificationContactsSchema(imported);
    const candidateConversionSchema =
      inspectSqlitePersonnelLifecycleConversionSchema(imported);
    const candidateConversionSchemaState = candidateConversionSchema.absent
      ? "m2-compatible"
      : candidateConversionSchema.valid ? "m3" : "invalid";
    const candidateScopedRightsSchema =
      inspectSqlitePersonnelLifecycleScopedRightsSchema(imported);
    const candidateScopedRightsRows =
      inspectSqlitePersonnelLifecycleScopedRightsRows(imported);
    const candidateScopedRightsSchemaState = candidateScopedRightsSchema.absent
      && candidateScopedRightsRows.valid
      ? "pre-r1-compatible"
      : candidateScopedRightsSchema.valid && candidateScopedRightsRows.valid
        ? "r1"
        : "invalid";
    const personnelWorkflowSchema = inspectSqlitePersonnelWorkflowSchema(imported);
    const personnelWorkflowRows = inspectSqlitePersonnelWorkflowRows(imported);
    const personnelWorkflowSchemaState = personnelWorkflowSchema.absent
      && personnelWorkflowRows.valid
      ? "pre-m4-compatible"
      : personnelWorkflowSchema.valid && personnelWorkflowRows.valid
        ? "m4"
        : "invalid";
    if (candidateConversionSchemaState === "invalid") {
      protectedInspectionError = true;
    }
    if (candidateScopedRightsSchemaState === "invalid") {
      protectedInspectionError = true;
    }
    if (personnelWorkflowSchemaState === "invalid") {
      protectedInspectionError = true;
    }
    if (personalNotificationContactsSchema.exists
      && !personalNotificationContactsSchema.valid) {
      protectedInspectionError = true;
    }
    if (personalNotificationContactsSchema.valid
      && !inspectSqlitePersonalNotificationContactRows(imported).valid) {
      protectedInspectionError = true;
    }
    if (tableExists.get("employees")
      && tableHasColumn(imported, "employees", "personnel_number")
      && imported.prepare(`
        SELECT 1
        FROM employees
        WHERE LOWER(TRIM(
          personnel_number,
          CHAR(9) || CHAR(10) || CHAR(11) || CHAR(12) || CHAR(13) || CHAR(32)
        )) = 'local'
        LIMIT 1
      `).get()) {
      protectedInspectionError = true;
    }
    if (tableExists.get("sickness_notification_preferences")
      && tableHasColumn(imported, "sickness_notification_preferences", "protected_destination")
      && imported.prepare(`
        SELECT 1
        FROM sickness_notification_preferences
        WHERE TRIM(COALESCE(protected_destination, '')) <> ''
        LIMIT 1
      `).get()) {
      protectedInspectionError = true;
    }
    const countNonPurged = (tableName) => {
      if (!tableExists.get(tableName)) return 0;
      const table = quotedIdentifier(tableName);
      return Number(imported.prepare(
        `SELECT COUNT(*) AS count FROM ${table} WHERE status <> 'purged'`,
      ).get().count || 0);
    };

    return Object.freeze({
      amuDocuments: countNonPurged("amu_documents"),
      personnelDocuments: countNonPurged("personnel_record_documents"),
      candidateDocuments: tableExists.get("candidate_documents")
        ? Number(imported.prepare("SELECT COUNT(*) AS count FROM candidate_documents").get().count || 0)
        : 0,
      candidateConversions: candidateConversionSchema.valid
        ? Number(imported.prepare("SELECT COUNT(*) AS count FROM candidate_conversions").get().count || 0)
        : 0,
      candidateConversionSchemaState,
      candidateScopedRightsSchemaState,
      personnelWorkflowSchemaState,
      protected: Object.freeze({
        personnelProfiles: protectedRows(
          "personnel_sensitive_records",
          "protected_payload",
          `SELECT employee_number, protected_payload
           FROM personnel_sensitive_records
           ORDER BY employee_number`,
        ),
        personnelDocuments: protectedRows(
          "personnel_record_documents",
          "protected_payload",
          `SELECT id, employee_number, protected_payload
           FROM personnel_record_documents
           ORDER BY employee_number, created_at, id`,
        ),
        candidates: protectedRows(
          "candidates",
          "protected_payload",
          `SELECT id, protected_payload
           FROM candidates
           ORDER BY created_at, id`,
        ),
        candidateApplications: protectedRows(
          "candidate_applications",
          "protected_payload",
          `SELECT id, candidate_id, protected_payload
           FROM candidate_applications
           ORDER BY created_at, id`,
        ),
        candidateDocuments: protectedRows(
          "candidate_documents",
          "protected_payload",
          `SELECT id, candidate_id, protected_payload
           FROM candidate_documents
           ORDER BY created_at, id`,
        ),
        candidateDocumentVersions: protectedRows(
          "candidate_document_versions",
          "protected_payload",
          `SELECT version.document_id, version.version_number,
                  document.candidate_id, version.protected_payload
           FROM candidate_document_versions version
           JOIN candidate_documents document ON document.id = version.document_id
           ORDER BY version.document_id, version.version_number`,
        ),
        candidateEvents: protectedRows(
          "candidate_events",
          "protected_payload",
          `SELECT id, candidate_id, protected_payload
           FROM candidate_events
           ORDER BY candidate_id, sequence_number`,
        ),
        candidateConversions: candidateConversionSchema.valid
          ? protectedRows(
            "candidate_conversions",
            "protected_payload",
            `SELECT id, candidate_id, application_id, employee_number,
                    request_sha256, protected_payload, receipt_sha256,
                    actor_employee_number, created_at
             FROM candidate_conversions
             ORDER BY created_at, id`,
          )
          : [],
        amuReports: protectedRows(
          "amu_reports",
          "protected_payload",
          `SELECT id, employee_lookup, protected_payload
           FROM amu_reports
           WHERE protected_payload <> ''
           ORDER BY id`,
        ),
        sicknessAlerts: protectedRows(
          "sickness_alerts",
          "protected_payload",
          `SELECT id, sickness_case_id, protected_payload
           FROM sickness_alerts
           ORDER BY id`,
        ),
        legacyAmuNotes: tableHasColumn(imported, "amu_reports", "employee_note")
          && tableHasColumn(imported, "amu_reports", "review_note")
          ? protectedRows(
            "amu_reports",
            "employee_note",
            `
              SELECT employee_note, review_note
              FROM amu_reports
              WHERE employee_note LIKE 'enc:v1:%' OR review_note LIKE 'enc:v1:%'
            `,
          )
          : [],
        amuDocuments: protectedRows(
          "amu_documents",
          "protected_payload",
          `SELECT d.id, d.protected_payload, r.employee_number
           FROM amu_documents d
           JOIN amu_reports r ON r.id = d.report_id
           WHERE d.protected_payload <> ''
           ORDER BY d.id`,
        ),
        legacyAmuDocumentNames: protectedRows(
          "amu_documents",
          "original_filename",
          `SELECT original_filename
           FROM amu_documents
           WHERE original_filename LIKE 'enc:v1:%'`,
        ),
        sicknessCases: protectedRows(
          "sickness_cases",
          "protected_payload",
          `SELECT id, employee_number, protected_payload
           FROM sickness_cases
           ORDER BY id`,
        ),
        sicknessPreferences: [],
        personalNotificationContacts: [],
        outboundNotificationJobs: protectedRows(
          "outbound_notification_jobs",
          "protected_payload",
          `SELECT id, recipient_lookup, protected_payload
           FROM outbound_notification_jobs
           ORDER BY created_at, id`,
        ),
      }),
      get protectedInspectionError() {
        return protectedInspectionError;
      },
      integrationConnections: (() => {
        try {
          return tableExists.get("integration_connections")
            && tableHasColumn(imported, "integration_connections", "protected_credentials")
            ? imported.prepare(`
                SELECT id, kind, protected_credentials
                FROM integration_connections
                WHERE protected_credentials <> ''
                ORDER BY id
              `).all()
            : [];
        } catch {
          integrationInspectionError = true;
          return [];
        }
      })(),
      get integrationInspectionError() {
        return integrationInspectionError;
      },
    });
  } finally {
    imported.close();
  }
}

module.exports = {
  applyBrandingSnapshotToSqliteFile,
  inspectSqliteImportForeignKeyIntegrity,
  inspectSqliteImportFile,
};
