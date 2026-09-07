"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createSqliteMaintenanceOperations,
  createSqliteSchemaOperations,
  protectedStorageReferencesFromFile,
  verifySqliteDatabaseFile,
} = require("../lib/persistence/sqlite/operations/maintenance");
const {
  openSqliteLegacyDatabase,
} = require("../lib/persistence/sqlite/provider");
const {
  createSqliteSystemDiagnosticsOperations,
} = require("../lib/persistence/sqlite/operations/system-diagnostics");
const {
  createSqliteAuditLogOperations,
} = require("../lib/persistence/sqlite/operations/audit-log");

test("v0.87 Datenbank Block 3: benannte SQLite-Schemaoperationen sind begrenzt", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    database.exec("CREATE TABLE values_table (id TEXT PRIMARY KEY)");
    const schema = createSqliteSchemaOperations(database);

    assert.equal(schema.tableExists("values_table"), true);
    assert.equal(schema.columnExists("values_table", "id"), true);
    assert.equal(schema.ensureColumn("values_table", "label", "TEXT NOT NULL DEFAULT ''"), true);
    assert.equal(schema.ensureColumn("values_table", "label", "TEXT NOT NULL DEFAULT ''"), false);
    assert.equal(schema.columnExists("values_table", "label"), true);

    assert.throws(() => schema.columnExists("values_table;DROP TABLE values_table", "id"));
    assert.throws(() => schema.ensureColumn("values_table", "unsafe", "TEXT; DROP TABLE values_table"));
    assert.equal(schema.tableExists("values_table"), true);
  } finally {
    database.close();
  }
});

test("v0.87 Datenbank Block 3: SQLite-Sicherung und geschützte Referenzen bleiben vollständig", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-sqlite-operations-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "source.db");
  const snapshotPath = path.join(directory, "snapshot.db");
  const database = openSqliteLegacyDatabase(databasePath);
  try {
    database.exec(`
      CREATE TABLE amu_documents (
        storage_key TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE loan_photos (
        storage_key TEXT NOT NULL,
        original_retained INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO amu_documents VALUES ('A-1', 'active'), ('ignored', 'purged');
      INSERT INTO loan_photos VALUES ('P-1', 1), ('ignored-photo', 0);
    `);
    const maintenance = createSqliteMaintenanceOperations(database);
    maintenance.checkpointWal();
    maintenance.vacuumInto(snapshotPath);
  } finally {
    database.close();
  }

  assert.deepEqual(verifySqliteDatabaseFile(snapshotPath), { ok: true, result: ["ok"] });
  assert.deepEqual(
    protectedStorageReferencesFromFile(snapshotPath).sort(),
    ["a-1", "p-1"],
  );

  const duplicate = openSqliteLegacyDatabase(snapshotPath);
  try {
    duplicate.prepare("INSERT INTO amu_documents VALUES (?, 'active')").run("p-1");
  } finally {
    duplicate.close();
  }
  assert.throws(
    () => protectedStorageReferencesFromFile(snapshotPath),
    /doppelte Verweise/i,
  );
});

test("v0.87 Datenbank Block 3: Systemdiagnose bleibt eine begrenzte SQLite-Operation", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    database.exec(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        app_version TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE integration_connections (
        id TEXT PRIMARY KEY,
        protected_credentials TEXT NOT NULL,
        active INTEGER NOT NULL
      );
      CREATE TABLE portal_users (
        employee_number TEXT PRIMARY KEY,
        locked_until TEXT
      );
      CREATE TABLE portal_sessions (
        id TEXT PRIMARY KEY,
        revoked_at TEXT,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY,
        action TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations VALUES
        ('first', '1.0.0', '2026-01-01 00:00:00'),
        ('latest', '2.0.0', '2026-02-01 00:00:00');
      INSERT INTO integration_connections VALUES ('protected', 'enc:v2:test', 1);
      INSERT INTO portal_users VALUES ('locked', '2999-01-01 00:00:00');
      INSERT INTO portal_sessions VALUES ('active', NULL, '2999-01-01 00:00:00');
      INSERT INTO audit_log (action, created_at) VALUES
        ('system.server_monitor.restart.accepted', '2026-01-01 00:00:00'),
        ('system.server_monitor.restart.accepted', '2026-02-01 00:00:00');
    `);
    const diagnostics = createSqliteSystemDiagnosticsOperations(database);
    assert.match(diagnostics.sqliteVersion(), /^\d+\.\d+/);
    assert.equal(String(diagnostics.pragmaValue("journal_mode")).length > 0, true);
    assert.equal(diagnostics.latestMigration().id, "latest");
    assert.equal(diagnostics.protectedIntegrationConnectionCount(), 1);
    assert.equal(diagnostics.lockedPortalAccountCount(), 1);
    assert.equal(diagnostics.activePortalSessionCount(), 1);
    assert.equal(
      diagnostics.latestAuditActionCreatedAt("system.server_monitor.restart.accepted"),
      "2026-02-01 00:00:00",
    );
    assert.throws(() => diagnostics.pragmaValue("table_info(portal_users)"));
  } finally {
    database.close();
  }
});

test("v0.87 Datenbank Block 3: alte App-Backupeinstellungen bleiben atomar", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    database.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const maintenance = createSqliteMaintenanceOperations(database);
    maintenance.updateLegacyBackupSettings({
      externalBackupEnabled: true,
      backupDirectory: "C:\\Sicherungen",
      backupIntervalHours: 3,
    });
    assert.deepEqual(
      Object.fromEntries(
        database.prepare("SELECT key, value FROM settings ORDER BY key").all()
          .map((row) => [row.key, row.value]),
      ),
      {
        backup_directory: "C:\\Sicherungen",
        backup_interval_hours: "3",
        external_backup_enabled: "1",
      },
    );
    assert.throws(() => maintenance.updateLegacyBackupSettings({
      externalBackupEnabled: true,
      backupDirectory: "",
      backupIntervalHours: 3,
    }));
    maintenance.updateLegacyBackupSettings({
      externalBackupEnabled: true,
      backupDirectory: "C:\\Sicherungen",
      backupIntervalHours: 24,
    });
    const dailySettings = database.prepare("SELECT key, value FROM settings ORDER BY key").all();
    assert.equal(dailySettings.find(row => row.key === "backup_interval_hours").value, "24");
    assert.throws(() => maintenance.updateLegacyBackupSettings({
      externalBackupEnabled: false,
      backupDirectory: "C:\\Unveraendert",
      backupIntervalHours: 25,
    }));
    assert.deepEqual(database.prepare("SELECT key, value FROM settings ORDER BY key").all(), dailySettings);
  } finally {
    database.close();
  }
});

test("v0.87 Datenbank Block 3: Auditprotokoll bleibt eine begrenzte Betriebsoperation", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    database.exec(`
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        detail TEXT NOT NULL
      )
    `);
    const audit = createSqliteAuditLogOperations(database);
    assert.equal(audit.record({
      actor: "E1",
      action: "employee.read",
      entityType: "employee",
      entityId: "E2",
      detail: "x".repeat(2100),
    }), 1);
    const stored = database.prepare("SELECT * FROM audit_log").get();
    assert.equal(stored.actor, "E1");
    assert.equal(stored.action, "employee.read");
    assert.equal(stored.detail.length, 2000);
    assert.throws(() => audit.record({ action: "" }));
  } finally {
    database.close();
  }
});
