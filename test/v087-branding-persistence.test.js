"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createBrandingSnapshotRepository,
} = require("../lib/persistence/repositories/branding-snapshot");
const {
  SQLITE_BRANDING_SNAPSHOT_CATALOG,
} = require("../lib/persistence/sqlite/branding-snapshot-catalog");
const {
  applyBrandingSnapshotToSqliteFile,
  inspectSqliteImportFile,
} = require("../lib/persistence/sqlite/operations/database-import");
const {
  openSqliteApplicationPersistence,
  openSqliteLegacyDatabase,
} = require("../lib/persistence/sqlite/provider");

test("v0.87 Datenbank Block 3: Branding-Snapshot bleibt gefiltert und importierbar", async (context) => {
  const source = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_BRANDING_SNAPSHOT_CATALOG,
  });
  context.after(async () => {
    await source.provider.close();
    source.database.close();
  });
  source.database.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE pdf_settings (
      scope_type TEXT NOT NULL,
      location_id TEXT NOT NULL,
      department_key TEXT NOT NULL DEFAULT '',
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (scope_type, location_id, department_key, key)
    );
    CREATE TABLE location_branding (
      location_id TEXT PRIMARY KEY,
      kit_id TEXT NOT NULL,
      company_name TEXT NOT NULL,
      logo_url TEXT NOT NULL,
      icon_url TEXT NOT NULL,
      logo_alt TEXT NOT NULL,
      admin_email TEXT NOT NULL,
      updated_by TEXT NOT NULL
    );
    INSERT INTO settings VALUES ('branding_logo_alt', 'GP'), ('smtp_password', 'secret');
    INSERT INTO pdf_settings VALUES ('global', '', '', 'branding_logo_alt', 'PDF GP');
    INSERT INTO location_branding VALUES
      ('01', 'custom', 'Firma', '/logo.svg', '/icon.svg', 'Firma', 'dev@example.test', 'dev');
  `);

  const repository = createBrandingSnapshotRepository(source.provider);
  const snapshot = await repository.read(["branding_logo_alt"]);
  assert.deepEqual(snapshot.settings, [{ key: "branding_logo_alt", value: "GP" }]);
  assert.deepEqual(snapshot.pdfSettings, [{
    scopeType: "global",
    locationId: "",
    departmentKey: "",
    key: "branding_logo_alt",
    value: "PDF GP",
  }]);
  assert.equal(snapshot.locationBranding[0].locationId, "01");

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-branding-import-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const destinationPath = path.join(directory, "destination.db");
  const destination = openSqliteLegacyDatabase(destinationPath);
  destination.exec("CREATE TABLE locations (id TEXT PRIMARY KEY); INSERT INTO locations VALUES ('01')");
  destination.close();

  applyBrandingSnapshotToSqliteFile(destinationPath, snapshot);
  const verified = openSqliteLegacyDatabase(destinationPath, { readOnly: true });
  try {
    assert.equal(
      verified.prepare("SELECT value FROM settings WHERE key = 'branding_logo_alt'").get().value,
      "GP",
    );
    assert.equal(
      verified.prepare("SELECT company_name FROM location_branding WHERE location_id = '01'").get().company_name,
      "Firma",
    );
  } finally {
    verified.close();
  }
});

test("v0.87 Datenbank Block 3: Importinspektion trennt Dateifehler von Schutzdatenfehlern", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-import-inspection-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "foreign.db");
  const database = openSqliteLegacyDatabase(databasePath);
  database.exec(`
    CREATE TABLE amu_reports (
      id INTEGER PRIMARY KEY,
      employee_number TEXT NOT NULL,
      status TEXT NOT NULL,
      protected_payload TEXT NOT NULL
    );
    INSERT INTO amu_reports VALUES (1, 'E1', 'purged', 'enc:v2:foreign');
  `);
  database.close();

  const inspection = inspectSqliteImportFile(databasePath);
  assert.equal(inspection.amuDocuments, 0);
  assert.equal(inspection.personnelDocuments, 0);
  assert.equal(inspection.protectedInspectionError, true);

  const invalidPath = path.join(directory, "invalid.db");
  fs.writeFileSync(invalidPath, "not a database");
  assert.throws(() => inspectSqliteImportFile(invalidPath));
});
