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
  ensureSqlitePersonnelWorkflowSchema,
  inspectSqlitePersonnelWorkflowRows,
  inspectSqlitePersonnelWorkflowSchema,
} = require("../lib/persistence/sqlite/operations/personnel-workflow-schema");
const {
  openSqliteLegacyDatabase,
} = require("../lib/persistence/sqlite/provider");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fileSha256(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function temporaryWorkflowDatabase(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `grabenplaner-m4-import-${label}-`));
  const databasePath = path.join(root, "snapshot.sqlite");
  const database = openSqliteLegacyDatabase(databasePath);
  database.exec(`
    CREATE TABLE locations (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE departments (
      id INTEGER PRIMARY KEY,
      location_id TEXT
    );
    CREATE TABLE custom_processes (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE custom_process_revisions (
      process_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      PRIMARY KEY (process_id, revision),
      FOREIGN KEY (process_id) REFERENCES custom_processes(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );
    CREATE TABLE custom_process_runs (
      id TEXT PRIMARY KEY,
      process_id TEXT NOT NULL,
      process_revision INTEGER NOT NULL
    );
  `);
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

function publicationReceiptBody(row) {
  return {
    schemaVersion: 1,
    id: row.id,
    processId: row.processId,
    sourceRevision: row.sourceRevision,
    versionNumber: row.versionNumber,
    workflowCode: row.workflowCode,
    workflowType: row.workflowType,
    authorityLevel: row.authorityLevel,
    requirementKind: row.requirementKind,
    dataClassification: row.dataClassification,
    scope: {
      type: row.scopeType,
      locationId: row.locationId,
      departmentId: row.departmentId,
    },
    snapshotSha256: row.snapshotSha256,
    publishedBy: row.publishedBy,
    publishedAt: row.publishedAt,
  };
}

function insertPublication(database, { manipulatedSnapshotHash = false } = {}) {
  const snapshot = {
    id: "process-onboarding",
    revision: 1,
    scope: {
      type: "company",
      locationId: null,
      departmentId: null,
    },
    steps: [{ id: "welcome", title: "Willkommen" }],
  };
  const snapshotJson = JSON.stringify(snapshot);
  database.prepare("INSERT INTO custom_processes (id) VALUES (?)")
    .run(snapshot.id);
  database.prepare(`
    INSERT INTO custom_process_revisions (process_id, revision, snapshot_json)
    VALUES (?, ?, ?)
  `).run(snapshot.id, snapshot.revision, snapshotJson);

  const publication = {
    id: "publication-onboarding-v1",
    processId: snapshot.id,
    sourceRevision: snapshot.revision,
    versionNumber: 1,
    workflowCode: "onboarding-standard",
    workflowType: "onboarding",
    authorityLevel: "central",
    requirementKind: "mandatory",
    dataClassification: "standard",
    scopeType: "company",
    locationId: null,
    departmentId: null,
    snapshotSha256: manipulatedSnapshotHash ? "f".repeat(64) : sha256(snapshotJson),
    publishedBy: "PL-PLUS",
    publishedAt: "2026-08-01T12:00:00.000Z",
  };
  const receiptSha256 = sha256(JSON.stringify(publicationReceiptBody(publication)));
  database.prepare(`
    INSERT INTO custom_process_publications (
      id, process_id, source_revision, version_number, workflow_code,
      workflow_type, authority_level, requirement_kind, data_classification,
      scope_type, location_id, department_id, snapshot_json, snapshot_sha256,
      receipt_sha256, published_by, published_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    publication.id,
    publication.processId,
    publication.sourceRevision,
    publication.versionNumber,
    publication.workflowCode,
    publication.workflowType,
    publication.authorityLevel,
    publication.requirementKind,
    publication.dataClassification,
    publication.scopeType,
    publication.locationId,
    publication.departmentId,
    snapshotJson,
    publication.snapshotSha256,
    receiptSha256,
    publication.publishedBy,
    publication.publishedAt,
  );
}

test("Personalmodul M4 Import: Altstaende ohne Publikationsschicht bleiben read-only kompatibel", () => {
  const fixture = temporaryWorkflowDatabase("legacy");
  try {
    fixture.close();
    const before = fileSha256(fixture.databasePath);

    const inspection = inspectSqliteImportFile(fixture.databasePath);

    assert.equal(inspection.personnelWorkflowSchemaState, "pre-m4-compatible");
    assert.equal(inspection.protectedInspectionError, false);
    assert.equal(fileSha256(fixture.databasePath), before);
  } finally {
    try { fixture.database.close(); } catch {}
    fixture.cleanup();
  }
});

test("Personalmodul M4 Import: vollstaendiges Schema mit gueltiger Publikation wird akzeptiert", () => {
  const fixture = temporaryWorkflowDatabase("valid");
  try {
    ensureSqlitePersonnelWorkflowSchema(fixture.database);
    insertPublication(fixture.database);
    assert.equal(inspectSqlitePersonnelWorkflowSchema(fixture.database).valid, true);
    assert.equal(inspectSqlitePersonnelWorkflowRows(fixture.database).valid, true);
    fixture.close();
    const before = fileSha256(fixture.databasePath);

    const inspection = inspectSqliteImportFile(fixture.databasePath);

    assert.equal(inspection.personnelWorkflowSchemaState, "m4");
    assert.equal(inspection.protectedInspectionError, false);
    assert.equal(fileSha256(fixture.databasePath), before);
  } finally {
    try { fixture.database.close(); } catch {}
    fixture.cleanup();
  }
});

test("Personalmodul M4 Import: ein partielles Schema wird fail-closed abgelehnt", () => {
  const fixture = temporaryWorkflowDatabase("partial");
  try {
    ensureSqlitePersonnelWorkflowSchema(fixture.database);
    fixture.database.exec("DROP TRIGGER trg_custom_process_publications_immutable_delete");
    fixture.close();

    const inspection = inspectSqliteImportFile(fixture.databasePath);

    assert.equal(inspection.personnelWorkflowSchemaState, "invalid");
    assert.equal(inspection.protectedInspectionError, true);
  } finally {
    try { fixture.database.close(); } catch {}
    fixture.cleanup();
  }
});

test("Personalmodul M4 Import: manipulierte Publikationsdaten werden fail-closed abgelehnt", () => {
  const fixture = temporaryWorkflowDatabase("manipulated");
  try {
    ensureSqlitePersonnelWorkflowSchema(fixture.database);
    insertPublication(fixture.database, { manipulatedSnapshotHash: true });
    assert.equal(inspectSqlitePersonnelWorkflowSchema(fixture.database).valid, true);
    assert.deepEqual(inspectSqlitePersonnelWorkflowRows(fixture.database).issues, [
      "snapshot-hash:publication-onboarding-v1",
    ]);
    fixture.close();

    const inspection = inspectSqliteImportFile(fixture.databasePath);

    assert.equal(inspection.personnelWorkflowSchemaState, "invalid");
    assert.equal(inspection.protectedInspectionError, true);
  } finally {
    try { fixture.database.close(); } catch {}
    fixture.cleanup();
  }
});
