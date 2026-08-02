"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createSicknessAmuManagementRepository,
} = require("../lib/persistence/repositories/sickness-amu-management");
const {
  SQLITE_SICKNESS_AMU_MANAGEMENT_CATALOG,
} = require("../lib/persistence/sqlite/sickness-amu-management-catalog");
const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  inspectSqliteImportFile,
} = require("../lib/persistence/sqlite/operations/database-import");
const {
  protectedSicknessAmuStorageSnapshotFromDatabase,
  protectedStorageReferencesFromDatabase,
} = require("../lib/persistence/sqlite/operations/maintenance");
const {
  PERSONNEL_DOCUMENT_HISTORY_MIGRATION_ID,
  PERSONNEL_DOCUMENT_HISTORY_TABLE_NAMES,
  PERSONNEL_DOCUMENT_HISTORY_TRIGGER_DEFINITIONS,
  ensureSqlitePersonnelDocumentHistorySchema,
  eventReceiptSha256,
  inspectSqlitePersonnelDocumentHistoryRows,
  inspectSqlitePersonnelDocumentHistorySchema,
} = require("../lib/persistence/sqlite/operations/personnel-document-history-schema");
const {
  runSqliteStartupSchemaMigrations,
} = require("../lib/persistence/sqlite/operations/startup-schema-migrations");
const {
  openSqliteApplicationPersistence,
  openSqliteLegacyDatabase,
} = require("../lib/persistence/sqlite/provider");
const { canonicalSha256 } = require("../lib/work-rules/receipt");

function runMigrations(database, {
  databaseExistedBeforeOpen = false,
  onBackup = () => {},
} = {}) {
  return runSqliteStartupSchemaMigrations({
    database,
    databaseExistedBeforeOpen,
    appVersion: "0.90-personnel-document-history-test",
    ensureApplicationSchema: () => ensureSqliteApplicationSchema(database),
    createPreMigrationBackup: onBackup,
    workRuleSha256: canonicalSha256,
  });
}

function removeHistorySchema(database) {
  for (const { name } of PERSONNEL_DOCUMENT_HISTORY_TRIGGER_DEFINITIONS) {
    database.exec(`DROP TRIGGER IF EXISTS "${name}"`);
  }
  for (const name of [...PERSONNEL_DOCUMENT_HISTORY_TABLE_NAMES].reverse()) {
    database.exec(`DROP TABLE IF EXISTS "${name}"`);
  }
  database.prepare("DELETE FROM schema_migrations WHERE id = ?")
    .run(PERSONNEL_DOCUMENT_HISTORY_MIGRATION_ID);
}

function insertEmployee(database, employeeNumber) {
  database.prepare(`
    INSERT INTO employees (personnel_number, full_name, nickname)
    VALUES (?, ?, ?)
  `).run(employeeNumber, `M6 ${employeeNumber}`, `M6 ${employeeNumber}`);
}

function eventPayload({
  id,
  documentId,
  sequenceNumber,
  eventType,
  previousReceiptSha256 = "",
  actorEmployeeNumber = "M6-HR",
  createdAt = "2026-08-02T12:00:00.000Z",
}) {
  const event = {
    id,
    documentId,
    sequenceNumber,
    eventType,
    previousReceiptSha256,
    actorEmployeeNumber,
    createdAt,
  };
  return { ...event, receiptSha256: eventReceiptSha256(event) };
}

test("Personalmodul M6: Legacy-Dokumente werden nach Backup verlustfrei und idempotent versioniert", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  const blobDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-m6-deleted-"));
  const deletedBlobPath = path.join(blobDirectory, "legacy-deleted.gpamu");
  const deletedBlob = Buffer.from("GPAMU002-deleted-legacy-sentinel");
  const deletedMetadata = {
    filename: "legacy-deleted.pdf",
    byteSize: deletedBlob.byteLength,
    sha256: createHash("sha256").update(deletedBlob).digest("hex"),
  };
  const deletedProtectedPayload = `enc:v2:${Buffer.from(JSON.stringify(deletedMetadata))
    .toString("base64url")}`;
  fs.writeFileSync(deletedBlobPath, deletedBlob);
  const backups = [];
  try {
    runMigrations(database);
    removeHistorySchema(database);
    insertEmployee(database, "M6-LEGACY");
    database.prepare(`
      INSERT INTO personnel_record_documents (
        id, employee_number, storage_key, status, protected_payload,
        created_at, updated_at, deleted_by, deleted_at
      ) VALUES (?, 'M6-LEGACY', ?, 'deleted', ?, ?, ?, 'M6-ARCHIVER', ?)
    `).run(
      "legacy-deleted",
      "personnel/legacy-deleted.gpamu",
      deletedProtectedPayload,
      "2026-06-15T08:00:00.000Z",
      "2026-06-20T09:00:00.000Z",
      "2026-06-20T09:00:00.000Z",
    );
    database.prepare(`
      INSERT INTO personnel_record_documents (
        id, employee_number, storage_key, status, protected_payload, created_at, updated_at
      ) VALUES (?, 'M6-LEGACY', ?, ?, ?, ?, ?)
    `).run(
      "legacy-active",
      "personnel/legacy-active.gpamu",
      "active",
      "enc:v2:legacy-active",
      "2026-07-01T08:00:00.000Z",
      "2026-07-01T08:00:00.000Z",
    );
    database.prepare(`
      INSERT INTO personnel_record_documents (
        id, employee_number, storage_key, status, protected_payload,
        created_at, updated_at, deleted_by, deleted_at
      ) VALUES (?, 'M6-LEGACY', ?, 'purged', ?, ?, ?, 'M6-HR', ?)
    `).run(
      "legacy-purged",
      "personnel/legacy-purged.gpamu",
      "enc:v2:legacy-purged",
      "2026-06-01T08:00:00.000Z",
      "2026-06-02T08:00:00.000Z",
      "2026-06-02T08:00:00.000Z",
    );

    const result = runMigrations(database, {
      databaseExistedBeforeOpen: true,
      onBackup: () => backups.push(
        database.prepare("SELECT COUNT(*) AS count FROM personnel_record_documents").get().count,
      ),
    });

    assert.equal(result.personnelDocumentHistoryMigrationRequired, true);
    assert.deepEqual(backups, [3]);
    assert.equal(inspectSqlitePersonnelDocumentHistorySchema(database).valid, true);
    assert.equal(inspectSqlitePersonnelDocumentHistoryRows(database).valid, true);
    assert.deepEqual(
      database.prepare(`
        SELECT document_id, version_number, storage_key, protected_payload
        FROM personnel_record_document_versions
        ORDER BY document_id, version_number
      `).all().map((row) => ({ ...row })),
      [
        {
          document_id: "legacy-active",
          version_number: 1,
          storage_key: "personnel/legacy-active.gpamu",
          protected_payload: "enc:v2:legacy-active",
        },
        {
          document_id: "legacy-deleted",
          version_number: 1,
          storage_key: "personnel/legacy-deleted.gpamu",
          protected_payload: deletedProtectedPayload,
        },
      ],
    );
    assert.deepEqual(
      { ...database.prepare(`
        SELECT status, current_version, revision, storage_key, protected_payload,
               archived_by, archived_at
        FROM personnel_record_documents
        WHERE id = 'legacy-deleted'
      `).get() },
      {
        status: "archived",
        current_version: 1,
        revision: 3,
        storage_key: "personnel/legacy-deleted.gpamu",
        protected_payload: deletedProtectedPayload,
        archived_by: "M6-ARCHIVER",
        archived_at: "2026-06-20T09:00:00.000Z",
      },
    );
    assert.deepEqual(
      database.prepare(`
        SELECT document_id, sequence_number, event_type
        FROM personnel_record_document_events
        ORDER BY document_id, sequence_number
      `).all().map((row) => ({ ...row })),
      [
        { document_id: "legacy-active", sequence_number: 1, event_type: "registered" },
        { document_id: "legacy-deleted", sequence_number: 1, event_type: "registered" },
        { document_id: "legacy-deleted", sequence_number: 2, event_type: "archived" },
        { document_id: "legacy-purged", sequence_number: 1, event_type: "legacy_purged" },
      ],
    );
    assert.deepEqual(fs.readFileSync(deletedBlobPath), deletedBlob);
    assert.deepEqual(protectedStorageReferencesFromDatabase(database), [
      "personnel/legacy-deleted.gpamu",
      "personnel/legacy-active.gpamu",
    ]);
    assert.deepEqual(
      protectedSicknessAmuStorageSnapshotFromDatabase(database)
        .personnelDocumentVersions
        .filter(({ id }) => id === "legacy-deleted")
        .map(({ storage_key: storageKey, protected_payload: payload }) => ({
          storageKey,
          payload,
        })),
      [{
        storageKey: "personnel/legacy-deleted.gpamu",
        payload: deletedProtectedPayload,
      }],
    );
    assert.throws(
      () => database.prepare(`
        UPDATE personnel_record_documents SET protected_payload = 'enc:v2:tampered'
        WHERE id = 'legacy-active'
      `).run(),
      /current pointer is invalid/,
    );
    assert.throws(
      () => database.prepare(`
        INSERT INTO personnel_record_document_versions (
          document_id, version_number, storage_key, protected_payload, created_by, created_at
        ) VALUES (
          'legacy-deleted', 2, 'personnel/legacy-deleted-v2.gpamu',
          'enc:v2:must-not-exist', 'M6-HR', '2026-07-01T09:00:00.000Z'
        )
      `).run(),
      /version sequence is invalid/,
    );

    const repeated = runMigrations(database, { databaseExistedBeforeOpen: true });
    assert.equal(repeated.personnelDocumentHistoryMigrationRequired, false);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM personnel_record_document_versions")
      .get().count, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM personnel_record_document_events")
      .get().count, 4);
  } finally {
    database.close();
    fs.rmSync(blobDirectory, { recursive: true, force: true });
  }
});

test("Personalmodul M6: revision TEXT NULL verletzt den Root-Vertrag fail-closed", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    database.exec(`
      CREATE TABLE personnel_record_documents (
        id TEXT PRIMARY KEY,
        employee_number TEXT NOT NULL,
        storage_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'active',
        protected_payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        deleted_by TEXT,
        deleted_at TEXT,
        current_version INTEGER NOT NULL DEFAULT 0,
        revision TEXT,
        archived_by TEXT,
        archived_at TEXT
      );
    `);
    ensureSqlitePersonnelDocumentHistorySchema(database);
    const inspection = inspectSqlitePersonnelDocumentHistorySchema(database);
    assert.equal(inspection.valid, false);
    assert.deepEqual(inspection.invalidRootColumns, ["revision"]);
    assert.ok(inspection.issues.includes("root-column-affinity-invalid:revision"));
    assert.ok(inspection.issues.includes("root-column-not-null-invalid:revision"));
    assert.ok(inspection.issues.includes("root-column-default-invalid:revision"));
    const rows = inspectSqlitePersonnelDocumentHistoryRows(database);
    assert.equal(rows.valid, false);
    assert.equal(rows.absent, false);
  } finally {
    database.close();
  }
});

test("Personalmodul M6: Import erkennt ein neu berechnetes oder manipuliertes Receipt", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-m6-import-"));
  const databasePath = path.join(directory, "import.sqlite");
  let database = openSqliteLegacyDatabase(databasePath);
  try {
    runMigrations(database);
    insertEmployee(database, "M6-IMPORT");
    database.prepare(`
      INSERT INTO personnel_record_documents (
        id, employee_number, storage_key, status, protected_payload
      ) VALUES ('import-document', 'M6-IMPORT', 'personnel/import-v1.gpamu',
                'active', 'enc:v2:import-v1')
    `).run();
    database.prepare(`
      INSERT INTO personnel_record_document_versions (
        document_id, version_number, storage_key, protected_payload, created_by, created_at
      ) VALUES ('import-document', 1, 'personnel/import-v1.gpamu',
                'enc:v2:import-v1', 'M6-HR', '2026-08-02T12:00:00.000Z')
    `).run();
    database.prepare(`
      UPDATE personnel_record_documents SET current_version = 1
      WHERE id = 'import-document'
    `).run();
    const registered = eventPayload({
      id: "import-event-1",
      documentId: "import-document",
      sequenceNumber: 1,
      eventType: "registered",
    });
    database.prepare(`
      INSERT INTO personnel_record_document_events (
        id, document_id, sequence_number, event_type, previous_receipt_sha256,
        receipt_sha256, actor_employee_number, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      registered.id,
      registered.documentId,
      registered.sequenceNumber,
      registered.eventType,
      registered.previousReceiptSha256,
      registered.receiptSha256,
      registered.actorEmployeeNumber,
      registered.createdAt,
    );
    database.close();

    const valid = inspectSqliteImportFile(databasePath);
    assert.equal(valid.personnelDocumentHistorySchemaState, "m6");
    assert.equal(valid.protected.personnelDocumentVersions.length, 1);

    database = openSqliteLegacyDatabase(databasePath);
    const immutableUpdate = PERSONNEL_DOCUMENT_HISTORY_TRIGGER_DEFINITIONS.find(
      ({ name }) => name === "trg_personnel_record_document_events_immutable_update",
    );
    database.exec(`DROP TRIGGER "${immutableUpdate.name}"`);
    database.prepare(`
      UPDATE personnel_record_document_events SET receipt_sha256 = ?
      WHERE id = 'import-event-1'
    `).run("a".repeat(64));
    database.exec(immutableUpdate.sql);
    database.close();

    const tampered = inspectSqliteImportFile(databasePath);
    assert.equal(tampered.personnelDocumentHistorySchemaState, "invalid");
    assert.equal(tampered.protectedInspectionError, true);
  } finally {
    try { database.close(); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Personalmodul M6: Repository fuehrt Versionen, Ereignisse und archivierte Backups zusammen", async () => {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_SICKNESS_AMU_MANAGEMENT_CATALOG,
  });
  const { database, provider } = application;
  const repository = createSicknessAmuManagementRepository(provider);
  try {
    ensureSqliteApplicationSchema(database);
    insertEmployee(database, "M6-REPO");
    const categories = await repository.listPersonnelDocumentCategories({ activeOnly: true });
    assert.deepEqual(categories.map(({ code }) => code), [
      "contract", "amendment", "certificate", "training", "identity", "payroll", "other",
    ]);
    assert.ok(categories.every((category) => (
      category.default_visibility === "hr_confidential"
      && category.retention_disposition === "manual_review"
      && category.default_retention_days === null
    )));

    await repository.insertPersonnelDocument({
      id: "repo-document",
      employeeNumber: "M6-REPO",
      storageKey: "personnel/repo-v1.gpamu",
      protectedPayload: "enc:v2:repo-v1",
    });
    await repository.insertPersonnelDocumentVersion({
      documentId: "repo-document",
      versionNumber: 1,
      storageKey: "personnel/repo-v1.gpamu",
      protectedPayload: "enc:v2:repo-v1",
      createdBy: "M6-HR",
      createdAt: "2026-08-02T12:00:00.000Z",
    });
    await repository.replacePersonnelDocumentCurrentPointer({
      id: "repo-document",
      employeeNumber: "M6-REPO",
      expectedCurrentVersion: 0,
      versionNumber: 1,
      storageKey: "personnel/repo-v1.gpamu",
      protectedPayload: "enc:v2:repo-v1",
      updatedAt: "2026-08-02T12:00:00.000Z",
    });
    const registered = eventPayload({
      id: "repo-event-1",
      documentId: "repo-document",
      sequenceNumber: 1,
      eventType: "registered",
    });
    await repository.insertPersonnelDocumentEvent(registered);

    await repository.insertPersonnelDocumentVersion({
      documentId: "repo-document",
      versionNumber: 2,
      storageKey: "personnel/repo-v2.gpamu",
      protectedPayload: "enc:v2:repo-v2",
      createdBy: "M6-HR",
      createdAt: "2026-08-02T12:10:00.000Z",
    });
    await repository.replacePersonnelDocumentCurrentPointer({
      id: "repo-document",
      employeeNumber: "M6-REPO",
      expectedCurrentVersion: 1,
      versionNumber: 2,
      storageKey: "personnel/repo-v2.gpamu",
      protectedPayload: "enc:v2:repo-v2",
      updatedAt: "2026-08-02T12:10:00.000Z",
    });
    const versionAdded = eventPayload({
      id: "repo-event-2",
      documentId: "repo-document",
      sequenceNumber: 2,
      eventType: "version_added",
      previousReceiptSha256: registered.receiptSha256,
      createdAt: "2026-08-02T12:10:00.000Z",
    });
    await repository.insertPersonnelDocumentEvent(versionAdded);

    const current = await repository.getPersonnelDocumentVersion({
      documentId: "repo-document",
      versionNumber: 2,
    });
    assert.equal(current.storage_key, "personnel/repo-v2.gpamu");
    assert.equal(current.protected_payload, "enc:v2:repo-v2");

    await repository.requestPersonnelDocumentRetentionReview({
      id: "repo-document",
      employeeNumber: "M6-REPO",
      expectedRevision: 3,
      occurredAt: "2026-08-02T12:20:00.000Z",
    });
    const retention = eventPayload({
      id: "repo-event-3",
      documentId: "repo-document",
      sequenceNumber: 3,
      eventType: "retention_review",
      previousReceiptSha256: versionAdded.receiptSha256,
      createdAt: "2026-08-02T12:20:00.000Z",
    });
    await repository.insertPersonnelDocumentEvent(retention);
    await repository.archivePersonnelDocument({
      id: "repo-document",
      employeeNumber: "M6-REPO",
      expectedRevision: 4,
      archivedBy: "M6-HR",
      archivedAt: "2026-08-02T12:30:00.000Z",
    });
    const archived = eventPayload({
      id: "repo-event-4",
      documentId: "repo-document",
      sequenceNumber: 4,
      eventType: "archived",
      previousReceiptSha256: retention.receiptSha256,
      createdAt: "2026-08-02T12:30:00.000Z",
    });
    await repository.insertPersonnelDocumentEvent(archived);

    assert.equal(inspectSqlitePersonnelDocumentHistoryRows(database).valid, true);
    database.prepare(`
      UPDATE personnel_record_documents SET revision = 0 WHERE id = 'repo-document'
    `).run();
    const invalidRevision = inspectSqlitePersonnelDocumentHistoryRows(database);
    assert.equal(invalidRevision.valid, false);
    assert.ok(invalidRevision.issues.includes("document-revision-invalid:repo-document"));
    database.prepare(`
      UPDATE personnel_record_documents SET revision = 5 WHERE id = 'repo-document'
    `).run();
    assert.equal(inspectSqlitePersonnelDocumentHistoryRows(database).valid, true);
    const archiveTransitionTrigger = PERSONNEL_DOCUMENT_HISTORY_TRIGGER_DEFINITIONS.find(
      ({ name }) => name === "trg_personnel_record_documents_archive_transition",
    );
    assert.throws(
      () => database.prepare(`
        UPDATE personnel_record_documents SET archived_at = '2026-08-02T12:31:00.000Z'
        WHERE id = 'repo-document'
      `).run(),
      /archive transition is invalid/,
    );
    database.exec(`DROP TRIGGER "${archiveTransitionTrigger.name}"`);
    database.prepare(`
      UPDATE personnel_record_documents SET archived_at = '2026-08-02T12:31:00.000Z'
      WHERE id = 'repo-document'
    `).run();
    assert.equal(inspectSqlitePersonnelDocumentHistoryRows(database).valid, false);
    database.prepare(`
      UPDATE personnel_record_documents SET archived_at = '2026-08-02T12:30:00.000Z'
      WHERE id = 'repo-document'
    `).run();
    database.exec(archiveTransitionTrigger.sql);
    assert.equal(inspectSqlitePersonnelDocumentHistoryRows(database).valid, true);
    assert.deepEqual(
      (await repository.listPersonnelDocumentEvents({ documentId: "repo-document" }))
        .map(({ event_type: type }) => type),
      ["registered", "version_added", "retention_review", "archived"],
    );
    assert.deepEqual(protectedStorageReferencesFromDatabase(database), [
      "personnel/repo-v1.gpamu",
      "personnel/repo-v2.gpamu",
    ]);
    assert.deepEqual(
      protectedSicknessAmuStorageSnapshotFromDatabase(database)
        .personnelDocumentVersions.map(({ id, version_number: version }) => ({ id, version })),
      [{ id: "repo-document", version: 1 }, { id: "repo-document", version: 2 }],
    );

    assert.throws(
      () => database.prepare(`
        INSERT INTO personnel_record_document_versions (
          document_id, version_number, storage_key, protected_payload, created_by, created_at
        ) VALUES (
          'repo-document', 3, 'personnel/repo-v3.gpamu', 'enc:v2:repo-v3',
          'M6-HR', '2026-08-02T12:30:00.000Z'
        )
      `).run(),
      /version sequence is invalid/,
    );

    const versionSequenceTrigger = PERSONNEL_DOCUMENT_HISTORY_TRIGGER_DEFINITIONS.find(
      ({ name }) => name === "trg_personnel_record_document_versions_sequence",
    );
    const pointerTrigger = PERSONNEL_DOCUMENT_HISTORY_TRIGGER_DEFINITIONS.find(
      ({ name }) => name === "trg_personnel_record_documents_pointer_update",
    );
    database.exec(`DROP TRIGGER "${versionSequenceTrigger.name}"`);
    database.exec(`DROP TRIGGER "${pointerTrigger.name}"`);
    database.prepare(`
      INSERT INTO personnel_record_document_versions (
        document_id, version_number, storage_key, protected_payload, created_by, created_at
      ) VALUES (
        'repo-document', 3, 'personnel/repo-v3.gpamu', 'enc:v2:repo-v3',
        'M6-HR', '2026-08-02T12:30:00.000Z'
      )
    `).run();
    database.prepare(`
      UPDATE personnel_record_documents
      SET storage_key = 'personnel/repo-v3.gpamu',
          protected_payload = 'enc:v2:repo-v3',
          current_version = 3
      WHERE id = 'repo-document'
    `).run();
    const impossibleVersion = eventPayload({
      id: "repo-event-5",
      documentId: "repo-document",
      sequenceNumber: 5,
      eventType: "version_added",
      previousReceiptSha256: archived.receiptSha256,
      createdAt: "2026-08-02T12:30:00.000Z",
    });
    const impossibleArchive = eventPayload({
      id: "repo-event-6",
      documentId: "repo-document",
      sequenceNumber: 6,
      eventType: "archived",
      previousReceiptSha256: impossibleVersion.receiptSha256,
      createdAt: "2026-08-02T12:30:00.000Z",
    });
    await repository.insertPersonnelDocumentEvent(impossibleVersion);
    await repository.insertPersonnelDocumentEvent(impossibleArchive);
    assert.equal(inspectSqlitePersonnelDocumentHistoryRows(database).valid, false);
  } finally {
    await provider.close();
    database.close();
  }
});
