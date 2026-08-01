"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  inspectSqliteImportFile,
} = require("../lib/persistence/sqlite/operations/database-import");
const {
  PERSISTENCE_ERROR_CODES,
} = require("../lib/persistence/errors");
const {
  protectedSicknessAmuStorageSnapshotFromDatabase,
} = require("../lib/persistence/sqlite/operations/maintenance");
const {
  PERSONNEL_LIFECYCLE_CONVERSION_TRIGGER_DEFINITIONS,
  ensureSqlitePersonnelLifecycleSchema,
} = require("../lib/persistence/sqlite/operations/personnel-lifecycle-schema");
const {
  openSqliteLegacyDatabase,
} = require("../lib/persistence/sqlite/provider");

function fileSha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function temporaryDatabase(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `grabenplaner-m3-import-${label}-`));
  const databasePath = path.join(root, "snapshot.sqlite");
  const database = openSqliteLegacyDatabase(databasePath);
  database.exec(`
    CREATE TABLE employees (
      personnel_number TEXT PRIMARY KEY,
      full_name TEXT NOT NULL DEFAULT '',
      nickname TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE locations (id TEXT PRIMARY KEY);
    CREATE TABLE departments (id INTEGER PRIMARY KEY, location_id TEXT);
    CREATE TABLE positions (id TEXT PRIMARY KEY);
  `);
  ensureSqlitePersonnelLifecycleSchema(database);
  return {
    database,
    databasePath,
    close() {
      database.close();
    },
    cleanup() {
      const resolvedRoot = path.resolve(root);
      if (resolvedRoot.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
        fs.rmSync(resolvedRoot, { recursive: true, force: true });
      }
    },
  };
}

function removeConversionSchema(database) {
  for (const definition of PERSONNEL_LIFECYCLE_CONVERSION_TRIGGER_DEFINITIONS) {
    database.exec(`DROP TRIGGER IF EXISTS "${definition.name}"`);
  }
  database.exec("DROP TABLE IF EXISTS candidate_conversions");
}

function insertConversionFixture(database, suffix = "one") {
  const fixture = {
    id: `123e4567-e89b-42d3-a456-4266141740${suffix === "one" ? "10" : "11"}`,
    candidateId: `candidate-${suffix}`,
    applicationId: `application-${suffix}`,
    employeeNumber: `employee-${suffix}`,
    requestSha256: "a".repeat(64),
    protectedPayload: `enc:v2:conversion-${suffix}`,
    receiptSha256: "b".repeat(64),
    actorEmployeeNumber: "M3-HR",
    createdAt: "2026-08-01T13:00:00.000Z",
  };
  database.prepare(`
    INSERT INTO employees (personnel_number, full_name, nickname)
    VALUES (?, ?, ?)
  `).run(fixture.employeeNumber, `Conversion ${suffix}`, `C ${suffix}`);
  database.prepare(`
    INSERT INTO candidates (
      id, state, protected_payload, revision, created_by, updated_by, created_at, updated_at
    ) VALUES (?, 'active', ?, 1, ?, ?, ?, ?)
  `).run(
    fixture.candidateId,
    `enc:v2:candidate-${suffix}`,
    fixture.actorEmployeeNumber,
    fixture.actorEmployeeNumber,
    fixture.createdAt,
    fixture.createdAt,
  );
  database.prepare(`
    INSERT INTO candidate_applications (
      id, candidate_id, status, protected_payload, revision, status_changed_at,
      created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, 'converted', ?, 2, ?, ?, ?, ?, ?)
  `).run(
    fixture.applicationId,
    fixture.candidateId,
    `enc:v2:application-${suffix}`,
    fixture.createdAt,
    fixture.actorEmployeeNumber,
    fixture.actorEmployeeNumber,
    fixture.createdAt,
    fixture.createdAt,
  );
  database.prepare(`
    INSERT INTO candidate_conversions (
      id, candidate_id, application_id, employee_number, request_sha256,
      protected_payload, receipt_sha256, actor_employee_number, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fixture.id,
    fixture.candidateId,
    fixture.applicationId,
    fixture.employeeNumber,
    fixture.requestSha256,
    fixture.protectedPayload,
    fixture.receiptSha256,
    fixture.actorEmployeeNumber,
    fixture.createdAt,
  );
  return fixture;
}

test("Personalmodul M3 Import: reine Foundation-M2 bleibt read-only kompatibel", () => {
  const fixture = temporaryDatabase("m2");
  try {
    removeConversionSchema(fixture.database);
    assert.deepEqual(
      protectedSicknessAmuStorageSnapshotFromDatabase(fixture.database).candidateConversions,
      [],
    );
    fixture.close();
    const before = fileSha256(fixture.databasePath);

    const inspection = inspectSqliteImportFile(fixture.databasePath);

    assert.equal(inspection.candidateConversionSchemaState, "m2-compatible");
    assert.equal(inspection.candidateConversions, 0);
    assert.deepEqual(inspection.protected.candidateConversions, []);
    assert.equal(inspection.protectedInspectionError, false);
    assert.equal(fileSha256(fixture.databasePath), before);

    const readOnlyVerification = openSqliteLegacyDatabase(fixture.databasePath, { readOnly: true });
    try {
      assert.equal(Boolean(readOnlyVerification.prepare(`
        SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'candidate_conversions'
      `).get()), false);
    } finally {
      readOnlyVerification.close();
    }
  } finally {
    try { fixture.database.close(); } catch {}
    fixture.cleanup();
  }
});

test("Personalmodul M3 Import: exaktes M3 liefert Conversion-Zeilen vollstaendig", () => {
  const storage = temporaryDatabase("valid");
  try {
    const fixture = insertConversionFixture(storage.database);
    const maintenanceSnapshot = protectedSicknessAmuStorageSnapshotFromDatabase(storage.database);
    assert.equal(Object.isFrozen(maintenanceSnapshot.candidateConversions), true);
    assert.deepEqual(maintenanceSnapshot.candidateConversions.map((row) => ({ ...row })), [{
      id: fixture.id,
      candidate_id: fixture.candidateId,
      application_id: fixture.applicationId,
      employee_number: fixture.employeeNumber,
      request_sha256: fixture.requestSha256,
      protected_payload: fixture.protectedPayload,
      receipt_sha256: fixture.receiptSha256,
      actor_employee_number: fixture.actorEmployeeNumber,
      created_at: fixture.createdAt,
    }]);
    storage.close();
    const before = fileSha256(storage.databasePath);

    const inspection = inspectSqliteImportFile(storage.databasePath);

    assert.equal(inspection.candidateConversionSchemaState, "m3");
    assert.equal(inspection.candidateConversions, 1);
    assert.deepEqual(inspection.protected.candidateConversions.map((row) => ({ ...row })), [{
      id: fixture.id,
      candidate_id: fixture.candidateId,
      application_id: fixture.applicationId,
      employee_number: fixture.employeeNumber,
      request_sha256: fixture.requestSha256,
      protected_payload: fixture.protectedPayload,
      receipt_sha256: fixture.receiptSha256,
      actor_employee_number: fixture.actorEmployeeNumber,
      created_at: fixture.createdAt,
    }]);
    assert.equal(inspection.protectedInspectionError, false);
    assert.equal(fileSha256(storage.databasePath), before);
  } finally {
    try { storage.database.close(); } catch {}
    storage.cleanup();
  }
});

test("Personalmodul M3 Import: fehlender Immutability-Trigger wird fail-closed erkannt", () => {
  const storage = temporaryDatabase("partial");
  try {
    insertConversionFixture(storage.database, "partial");
    storage.database.exec("DROP TRIGGER trg_candidate_conversions_immutable_delete");
    assert.throws(
      () => protectedSicknessAmuStorageSnapshotFromDatabase(storage.database),
      (error) => error?.code === PERSISTENCE_ERROR_CODES.STATEMENT_INVALID,
    );
    storage.close();
    const before = fileSha256(storage.databasePath);

    const inspection = inspectSqliteImportFile(storage.databasePath);

    assert.equal(inspection.candidateConversionSchemaState, "invalid");
    assert.equal(inspection.candidateConversions, 0);
    assert.deepEqual(inspection.protected.candidateConversions, []);
    assert.equal(inspection.protectedInspectionError, true);
    assert.equal(fileSha256(storage.databasePath), before);
  } finally {
    try { storage.database.close(); } catch {}
    storage.cleanup();
  }
});

test("Personalmodul M3 Import: abweichende Conversion-Tabelle wird fail-closed erkannt", () => {
  const storage = temporaryDatabase("invalid");
  try {
    removeConversionSchema(storage.database);
    storage.database.exec(`
      CREATE TABLE candidate_conversions (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        protected_payload TEXT NOT NULL,
        legacy_source TEXT
      );
      INSERT INTO candidate_conversions (id, candidate_id, protected_payload, legacy_source)
      VALUES ('legacy-conversion', 'legacy-candidate', 'enc:v2:legacy', 'legacy');
    `);
    assert.throws(
      () => protectedSicknessAmuStorageSnapshotFromDatabase(storage.database),
      (error) => error?.code === PERSISTENCE_ERROR_CODES.STATEMENT_INVALID,
    );
    storage.close();
    const before = fileSha256(storage.databasePath);

    const inspection = inspectSqliteImportFile(storage.databasePath);

    assert.equal(inspection.candidateConversionSchemaState, "invalid");
    assert.equal(inspection.candidateConversions, 0);
    assert.deepEqual(inspection.protected.candidateConversions, []);
    assert.equal(inspection.protectedInspectionError, true);
    assert.equal(fileSha256(storage.databasePath), before);

    const readOnlyVerification = openSqliteLegacyDatabase(storage.databasePath, { readOnly: true });
    try {
      assert.deepEqual(
        { ...readOnlyVerification.prepare(`
          SELECT id, candidate_id, protected_payload, legacy_source
          FROM candidate_conversions
        `).get() },
        {
          id: "legacy-conversion",
          candidate_id: "legacy-candidate",
          protected_payload: "enc:v2:legacy",
          legacy_source: "legacy",
        },
      );
    } finally {
      readOnlyVerification.close();
    }
  } finally {
    try { storage.database.close(); } catch {}
    storage.cleanup();
  }
});
