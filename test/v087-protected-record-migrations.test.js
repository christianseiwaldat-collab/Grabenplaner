"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createSqliteProtectedRecordOperations,
} = require("../lib/persistence/sqlite/operations/protected-record-migrations");
const {
  openSqliteLegacyDatabase,
} = require("../lib/persistence/sqlite/provider");

function protectedValue(value) {
  return `enc:v2:${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
}

function parseProtected(value) {
  if (!String(value || "").startsWith("enc:v2:")) throw new Error("PROTECTED_VALUE_REQUIRED");
  return JSON.parse(Buffer.from(String(value).slice(7), "base64url").toString("utf8"));
}

function fixture() {
  const database = openSqliteLegacyDatabase(":memory:");
  database.exec(`
    CREATE TABLE schema_migrations (
      id TEXT PRIMARY KEY,
      app_version TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE amu_reports (
      id INTEGER PRIMARY KEY,
      employee_number TEXT NOT NULL,
      protected_payload TEXT NOT NULL DEFAULT '',
      incapacity_from TEXT NOT NULL DEFAULT '',
      incapacity_to TEXT NOT NULL DEFAULT '',
      employee_note TEXT NOT NULL DEFAULT '',
      reviewed_by TEXT,
      reviewed_at TEXT,
      review_note TEXT NOT NULL DEFAULT '',
      retention_until TEXT,
      withdrawn_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE amu_documents (
      id TEXT PRIMARY KEY,
      report_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      protected_payload TEXT NOT NULL DEFAULT '',
      original_filename TEXT NOT NULL DEFAULT '',
      detected_mime TEXT NOT NULL DEFAULT '',
      byte_size INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL DEFAULT '',
      uploaded_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE vacation_history_events (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      employee_number TEXT NOT NULL,
      action TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TRIGGER trg_vacation_history_events_immutable_update
    BEFORE UPDATE ON vacation_history_events
    BEGIN
      SELECT RAISE(ABORT, 'vacation history events are immutable');
    END;
    CREATE TABLE personnel_sensitive_records (
      employee_number TEXT PRIMARY KEY,
      protected_payload TEXT NOT NULL
    );
    CREATE TABLE personnel_record_documents (
      id TEXT PRIMARY KEY,
      employee_number TEXT NOT NULL,
      protected_payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  const storage = {
    protectRecord: (value) => protectedValue(JSON.parse(value)),
    unprotectText: (value) => String(value || ""),
  };
  const operations = createSqliteProtectedRecordOperations(database, {
    appVersion: "0.87-test",
    vacationHistoryProtectionMigrationId: "v0.82-protected-vacation-history",
    httpError: (_status, message, code) => Object.assign(new Error(message), { code }),
    parseProtectedJson: parseProtected,
    personnelRecordDocumentProtectionContext: (row) => ({ id: row.id }),
    personnelSensitiveProtectionContext: (row) => ({ employeeNumber: row.employee_number }),
    parseVacationHistorySnapshot: (row, { allowPlaintext = false } = {}) => {
      if (String(row.snapshot_json).startsWith("enc:v2:")) return parseProtected(row.snapshot_json);
      if (!allowPlaintext) throw new Error("PROTECTED_VALUE_REQUIRED");
      return JSON.parse(row.snapshot_json);
    },
    protectJson: protectedValue,
    vacationHistoryProtectionContext: (row) => ({ id: row.id }),
    requireAmuStorage: () => storage,
    amuReportProtectionContext: (row) => ({ id: row.id }),
    amuDocumentProtectionContext: (row) => ({ id: row.id }),
  });
  return { database, operations };
}

test("Block 3/7: Schutzmigrationen sind verlustfrei und idempotent", () => {
  const { database, operations } = fixture();
  try {
    database.prepare(`
      INSERT INTO amu_reports
        (id, employee_number, incapacity_from, incapacity_to, employee_note,
         reviewed_by, reviewed_at, review_note, retention_until, withdrawn_at)
      VALUES
        (1, 'E-1', '2026-07-01', '2026-07-03', 'Notiz', 'HR-1',
         '2026-07-04', 'Geprueft', '2027-01-01', NULL)
    `).run();
    database.prepare(`
      INSERT INTO amu_documents
        (id, report_id, status, original_filename, detected_mime, byte_size, sha256, uploaded_by)
      VALUES
        ('D-1', 1, 'active', 'aum.pdf', 'application/pdf', 123, 'abc', 'E-1')
    `).run();
    database.prepare(`
      INSERT INTO vacation_history_events
        (id, group_id, employee_number, action, snapshot_json, receipt_sha256, created_by, created_at)
      VALUES
        ('V-1', 'G-1', 'E-1', 'created', '{"days":2}', 'receipt', 'HR-1', '2026-07-05')
    `).run();

    assert.deepEqual(operations.migrateProtectedPersonnelRecords(), { reports: 1, documents: 1 });
    assert.deepEqual(operations.migrateProtectedVacationHistoryRecords(), { migrated: 1 });
    assert.deepEqual(operations.migrateProtectedPersonnelRecords(), { reports: 0, documents: 0 });
    assert.deepEqual(operations.migrateProtectedVacationHistoryRecords(), { migrated: 0 });

    const report = database.prepare("SELECT * FROM amu_reports WHERE id = 1").get();
    const document = database.prepare("SELECT * FROM amu_documents WHERE id = 'D-1'").get();
    assert.deepEqual(parseProtected(report.protected_payload), {
      incapacityFrom: "2026-07-01",
      incapacityTo: "2026-07-03",
      employeeNote: "Notiz",
      reviewedBy: "HR-1",
      reviewedAt: "2026-07-04",
      reviewNote: "Geprueft",
      retentionUntil: "2027-01-01",
      withdrawnAt: "",
    });
    assert.equal(report.incapacity_from, "");
    assert.equal(report.employee_note, "");
    assert.deepEqual(parseProtected(document.protected_payload), {
      originalFilename: "aum.pdf",
      detectedMime: "application/pdf",
      byteSize: 123,
      sha256: "abc",
      uploadedBy: "E-1",
    });
    assert.equal(document.original_filename, "");
    assert.deepEqual(
      parseProtected(database.prepare("SELECT snapshot_json FROM vacation_history_events WHERE id = 'V-1'").get().snapshot_json),
      { days: 2 },
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count,
      2,
    );
  } finally {
    database.close();
  }
});

test("Block 3/7: geschuetzte Personal- und Dokumentverifikation stoppt bei Klartext", () => {
  const { database, operations } = fixture();
  try {
    database.prepare(`
      INSERT INTO personnel_sensitive_records (employee_number, protected_payload)
      VALUES ('E-1', ?)
    `).run(protectedValue({ phone: "123" }));
    database.prepare(`
      INSERT INTO personnel_record_documents (id, employee_number, protected_payload, created_at)
      VALUES ('P-1', 'E-1', ?, '2026-07-01')
    `).run(protectedValue({ fileName: "personal.pdf" }));

    assert.equal(operations.verifyProtectedSensitivePersonnelRecords(), 1);
    assert.equal(operations.verifyProtectedPersonnelRecordDocuments(), 1);

    database.prepare(`
      UPDATE personnel_sensitive_records
      SET protected_payload = 'Klartext'
      WHERE employee_number = 'E-1'
    `).run();
    assert.throws(
      () => operations.verifyProtectedSensitivePersonnelRecords(),
      (error) => error.code === "PERSONNEL_RECORD_INTEGRITY_FAILED",
    );
  } finally {
    database.close();
  }
});
