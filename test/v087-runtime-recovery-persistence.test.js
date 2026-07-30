"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createRuntimeRecoveryRepository,
} = require("../lib/persistence/repositories/runtime-recovery");
const {
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");
const {
  SQLITE_RUNTIME_RECOVERY_CATALOG,
} = require("../lib/persistence/sqlite/runtime-recovery-catalog");

test("v0.87 Datenbank Block 3: Runtime-Recovery zählt Schutzdaten und markiert Unterbrechungen", async (context) => {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_RUNTIME_RECOVERY_CATALOG,
  });
  context.after(async () => {
    await application.provider.close();
    application.database.close();
  });
  application.database.exec(`
    CREATE TABLE amu_documents (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE personnel_record_documents (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE outbound_notification_jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      last_error_code TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO amu_documents VALUES ('a1', 'active'), ('a2', 'purged');
    INSERT INTO personnel_record_documents VALUES ('p1', 'active');
    INSERT INTO outbound_notification_jobs (id, status) VALUES
      ('n1', 'processing'),
      ('n2', 'sent');
  `);

  const repository = createRuntimeRecoveryRepository(application.provider);
  assert.deepEqual(await repository.protectedDocumentCounts(), {
    amuDocuments: 1,
    personnelDocuments: 1,
  });
  assert.deepEqual(await repository.markInterruptedNotifications(), {
    rowsAffected: 1,
    returnedRows: [],
  });
  assert.equal(
    application.database.prepare(
      "SELECT last_error_code FROM outbound_notification_jobs WHERE id = 'n1'",
    ).get().last_error_code,
    "INTERRUPTED_DELIVERY",
  );
});
