"use strict";

const {
  createSqliteSchemaOperations,
} = require("./maintenance");

function assertFunction(value, label) {
  if (typeof value !== "function") {
    throw new TypeError(`${label} muss eine Funktion sein.`);
  }
  return value;
}

function createSqliteProtectedRecordOperations(database, {
  appVersion,
  vacationHistoryProtectionMigrationId,
  httpError,
  parseProtectedJson,
  personnelRecordDocumentProtectionContext,
  personnelSensitiveProtectionContext,
  parseVacationHistorySnapshot,
  protectJson,
  vacationHistoryProtectionContext,
  requireAmuStorage,
  amuReportProtectionContext,
  amuDocumentProtectionContext,
} = {}) {
  if (!database || typeof database.exec !== "function" || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benoetigt.");
  }
  const db = database;
  const packageMetadata = { version: String(appVersion || "") };
  const { tableExists } = createSqliteSchemaOperations(db);
  for (const [label, callback] of Object.entries({
    httpError,
    parseProtectedJson,
    personnelRecordDocumentProtectionContext,
    personnelSensitiveProtectionContext,
    parseVacationHistorySnapshot,
    protectJson,
    vacationHistoryProtectionContext,
    requireAmuStorage,
    amuReportProtectionContext,
    amuDocumentProtectionContext,
  })) {
    assertFunction(callback, label);
  }

function verifyProtectedPersonnelRecordDocuments() {
  if (!tableExists("personnel_record_documents")) return 0;
  const rows = db.prepare(`
    SELECT id, employee_number, protected_payload
    FROM personnel_record_documents
    ORDER BY employee_number, created_at, id
  `).all();
  for (const row of rows) {
    if (!String(row.protected_payload || "").startsWith("enc:v2:")) {
      throw httpError(503, "Personalakt-Dokumente liegen nicht im erwarteten verschlüsselten Format vor.", "PERSONNEL_DOCUMENT_INTEGRITY_FAILED");
    }
    parseProtectedJson(row.protected_payload, personnelRecordDocumentProtectionContext(row));
  }
  return rows.length;
}

function verifyProtectedSensitivePersonnelRecords() {
  if (!tableExists("personnel_sensitive_records")) return 0;
  const rows = db.prepare(`
    SELECT employee_number, protected_payload
    FROM personnel_sensitive_records ORDER BY employee_number
  `).all();
  for (const row of rows) {
    if (!String(row.protected_payload || "").startsWith("enc:v2:")) {
      throw httpError(503, "Sensible Personalakt-Daten liegen nicht im erwarteten verschlüsselten Format vor.", "PERSONNEL_RECORD_INTEGRITY_FAILED");
    }
    parseProtectedJson(row.protected_payload, personnelSensitiveProtectionContext(row));
  }
  return rows.length;
}

function migrateProtectedVacationHistoryRecords() {
  if (!tableExists("vacation_history_events")) return { migrated: 0 };
  const rows = db.prepare(`
    SELECT id, group_id, employee_number, action, snapshot_json, receipt_sha256, created_by, created_at
    FROM vacation_history_events
    ORDER BY created_at, id
  `).all();
  const pending = rows.filter((row) => !String(row.snapshot_json || "").startsWith("enc:v2:"));
  for (const row of pending) parseVacationHistorySnapshot(row, { allowPlaintext: true });
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DROP TRIGGER IF EXISTS trg_vacation_history_events_immutable_update");
    const update = db.prepare("UPDATE vacation_history_events SET snapshot_json = ? WHERE id = ?");
    for (const row of pending) {
      const snapshot = parseVacationHistorySnapshot(row, { allowPlaintext: true });
      update.run(protectJson(snapshot, vacationHistoryProtectionContext(row)), row.id);
    }
    db.exec(`
      CREATE TRIGGER trg_vacation_history_events_immutable_update
      BEFORE UPDATE ON vacation_history_events
      BEGIN
        SELECT RAISE(ABORT, 'vacation history events are immutable');
      END
    `);
    db.prepare(`
      INSERT OR REPLACE INTO schema_migrations (id, app_version, applied_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `).run(vacationHistoryProtectionMigrationId, packageMetadata.version);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return { migrated: pending.length };
}

function migrateProtectedPersonnelRecords() {
  const reports = db.prepare("SELECT * FROM amu_reports ORDER BY id").all();
  const documents = db.prepare(`
    SELECT d.*, r.employee_number
    FROM amu_documents d JOIN amu_reports r ON r.id = d.report_id
    WHERE d.status <> 'purged'
    ORDER BY d.created_at, d.id
  `).all();
  const pendingReports = reports.filter((row) => !String(row.protected_payload || "").startsWith("enc:v2:"));
  const pendingDocuments = documents.filter((row) => !String(row.protected_payload || "").startsWith("enc:v2:"));
  if (!pendingReports.length && !pendingDocuments.length) {
    for (const row of reports) {
      if (row.protected_payload) parseProtectedJson(row.protected_payload, amuReportProtectionContext(row));
    }
    for (const row of documents) parseProtectedJson(row.protected_payload, amuDocumentProtectionContext(row));
    return { reports: 0, documents: 0 };
  }
  const storage = requireAmuStorage();
  const updateReport = db.prepare(`
    UPDATE amu_reports SET protected_payload = ?, incapacity_from = '', incapacity_to = '', employee_note = '',
      reviewed_by = NULL, reviewed_at = NULL, review_note = '', retention_until = NULL, withdrawn_at = NULL,
      revision = revision + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  const updateDocument = db.prepare(`
    UPDATE amu_documents SET protected_payload = ?, original_filename = '', detected_mime = 'application/octet-stream',
      byte_size = 0, sha256 = '', uploaded_by = ''
    WHERE id = ?
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of pendingReports) {
      const payload = {
        incapacityFrom: row.incapacity_from || "",
        incapacityTo: row.incapacity_to || "",
        employeeNote: storage.unprotectText(row.employee_note || ""),
        reviewedBy: row.reviewed_by || "",
        reviewedAt: row.reviewed_at || "",
        reviewNote: storage.unprotectText(row.review_note || ""),
        retentionUntil: row.retention_until || "",
        withdrawnAt: row.withdrawn_at || "",
      };
      updateReport.run(storage.protectRecord(JSON.stringify(payload), amuReportProtectionContext(row)), row.id);
    }
    for (const row of pendingDocuments) {
      const payload = {
        originalFilename: storage.unprotectText(row.original_filename || "") || "Dokument",
        detectedMime: row.detected_mime || "application/octet-stream",
        byteSize: Number(row.byte_size || 0),
        sha256: row.sha256 || "",
        uploadedBy: row.uploaded_by || "",
      };
      updateDocument.run(storage.protectRecord(JSON.stringify(payload), amuDocumentProtectionContext(row)), row.id);
    }
    db.prepare("INSERT OR REPLACE INTO schema_migrations (id, app_version, applied_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
      .run("v0.58-protected-personnel-records", packageMetadata.version);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { reports: pendingReports.length, documents: pendingDocuments.length };
}

  return Object.freeze({
    migrateProtectedPersonnelRecords,
    migrateProtectedVacationHistoryRecords,
    verifyProtectedPersonnelRecordDocuments,
    verifyProtectedSensitivePersonnelRecords,
  });
}

module.exports = {
  createSqliteProtectedRecordOperations,
};
