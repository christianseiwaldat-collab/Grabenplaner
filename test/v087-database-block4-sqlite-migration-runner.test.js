"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MIGRATION_ERROR_CODES,
  defineMigrationManifest,
} = require("../lib/persistence/migrations/contract");
const {
  createSqliteMigrationFixture,
} = require("../test-support/sqlite-migration-fixture");
const {
  runMigrationManifest,
} = require("../lib/persistence/migrations/runner");
const {
  createSqliteMigrationAdapter,
} = require("../lib/persistence/sqlite/migrations/adapter");
const {
  openSqliteLegacyDatabase,
} = require("../lib/persistence/sqlite/provider");

const PERSONNEL_MANIFEST = defineMigrationManifest({
  id: "fixture.personnel-history",
  migrations: [
    {
      id: "v1.legacy-personnel",
      operations: ["personnel.legacy.create"],
      rollbackOperations: ["personnel.legacy.drop"],
    },
    {
      id: "v2.stable-personnel-number",
      operations: ["personnel.number.upgrade"],
      rollbackOperations: ["personnel.number.rollback"],
    },
  ],
});

const PERSONNEL_OPERATIONS = Object.freeze({
  "personnel.legacy.create"({ database }) {
    database.exec(`
      CREATE TABLE employees_legacy (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
  },
  "personnel.legacy.drop"({ database }) {
    database.exec("DROP TABLE employees_legacy");
  },
  "personnel.number.upgrade"({ database }) {
    database.exec(`
      ALTER TABLE employees_legacy RENAME TO employees_source;
      CREATE TABLE employees (
        personnel_number TEXT PRIMARY KEY,
        full_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO employees (personnel_number, full_name, created_at)
      SELECT CAST(id AS TEXT), name, created_at
      FROM employees_source;
      DROP TABLE employees_source;
    `);
  },
  "personnel.number.rollback"({ database }) {
    database.exec(`
      ALTER TABLE employees RENAME TO employees_source;
      CREATE TABLE employees_legacy (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO employees_legacy (id, name, created_at)
      SELECT CAST(personnel_number AS INTEGER), full_name, created_at
      FROM employees_source;
      DROP TABLE employees_source;
    `);
  },
});

function tableExists(database, tableName) {
  return Boolean(database.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName));
}

test("Block 4/7: SQLite-Neuaufbau fuehrt die deterministische Kette bis zum Ziel aus", async () => {
  const fixture = createSqliteMigrationFixture({
    manifest: PERSONNEL_MANIFEST,
    operations: PERSONNEL_OPERATIONS,
  });
  try {
    const result = await fixture.migrate();

    assert.equal(result.kind, "rebuild");
    assert.deepEqual(
      result.applied,
      ["v1.legacy-personnel", "v2.stable-personnel-number"],
    );
    assert.equal(tableExists(fixture.database, "employees"), true);
    assert.equal(tableExists(fixture.database, "employees_legacy"), false);
    assert.deepEqual(
      (await fixture.history()).map(({ id }) => id),
      ["v1.legacy-personnel", "v2.stable-personnel-number"],
    );
    assert.equal(fixture.database.prepare("PRAGMA quick_check").get().quick_check, "ok");
  } finally {
    fixture.close();
  }
});

test("Block 4/7: historische SQLite-Fixture wird beim Upgrade verlustfrei uebernommen", async () => {
  const fixture = createSqliteMigrationFixture({
    manifest: PERSONNEL_MANIFEST,
    operations: PERSONNEL_OPERATIONS,
  });
  try {
    await fixture.migrate({ targetId: "v1.legacy-personnel" });
    fixture.database.prepare(`
      INSERT INTO employees_legacy (id, name, created_at)
      VALUES (?, ?, ?)
    `).run(41, "Historische Person", "2024-01-01T08:00:00Z");

    const result = await fixture.migrate();

    assert.equal(result.kind, "upgrade");
    assert.deepEqual(result.applied, ["v2.stable-personnel-number"]);
    assert.deepEqual(
      { ...fixture.database.prepare(`
        SELECT personnel_number, full_name, created_at
        FROM employees
      `).get() },
      {
        personnel_number: "41",
        full_name: "Historische Person",
        created_at: "2024-01-01T08:00:00Z",
      },
    );
  } finally {
    fixture.close();
  }
});

test("Block 4/7: SQLite-Rollback laeuft rueckwaerts und aktualisiert Verlauf atomar", async () => {
  const fixture = createSqliteMigrationFixture({
    manifest: PERSONNEL_MANIFEST,
    operations: PERSONNEL_OPERATIONS,
  });
  try {
    await fixture.migrate();
    fixture.database.prepare(`
      INSERT INTO employees (personnel_number, full_name, created_at)
      VALUES (?, ?, ?)
    `).run("52", "Rollback Person", "2025-02-01T09:00:00Z");

    const result = await fixture.migrate({ targetId: "v1.legacy-personnel" });

    assert.equal(result.kind, "rollback");
    assert.deepEqual(result.rolledBack, ["v2.stable-personnel-number"]);
    assert.equal(tableExists(fixture.database, "employees"), false);
    assert.deepEqual(
      { ...fixture.database.prepare(`
        SELECT id, name, created_at
        FROM employees_legacy
      `).get() },
      {
        id: 52,
        name: "Rollback Person",
        created_at: "2025-02-01T09:00:00Z",
      },
    );
    assert.deepEqual(
      (await fixture.history()).map(({ id }) => id),
      ["v1.legacy-personnel"],
    );
  } finally {
    fixture.close();
  }
});

test("Block 4/7: fehlgeschlagener SQLite-Schritt rollt Schema und Verlauf gemeinsam zurueck", async () => {
  const manifest = defineMigrationManifest({
    id: "fixture.atomic-failure",
    migrations: [
      {
        id: "v1.baseline",
        operations: ["schema.baseline.create"],
        rollbackOperations: ["schema.baseline.drop"],
      },
      {
        id: "v2.failing-audit",
        operations: ["schema.audit.create", "schema.audit.fail"],
        rollbackOperations: ["schema.audit.drop"],
      },
    ],
  });
  const fixture = createSqliteMigrationFixture({
    manifest,
    operations: {
      "schema.baseline.create"({ database }) {
        database.exec("CREATE TABLE baseline (id TEXT PRIMARY KEY)");
      },
      "schema.baseline.drop"({ database }) {
        database.exec("DROP TABLE baseline");
      },
      "schema.audit.create"({ database }) {
        database.exec("CREATE TABLE audit_events (id TEXT PRIMARY KEY)");
      },
      "schema.audit.fail"() {
        throw new Error("controlled fixture failure");
      },
      "schema.audit.drop"({ database }) {
        database.exec("DROP TABLE audit_events");
      },
    },
  });
  try {
    await fixture.migrate({ targetId: "v1.baseline" });
    await assert.rejects(
      fixture.migrate(),
      /controlled fixture failure/,
    );

    assert.equal(tableExists(fixture.database, "baseline"), true);
    assert.equal(tableExists(fixture.database, "audit_events"), false);
    assert.deepEqual(
      (await fixture.history()).map(({ id }) => id),
      ["v1.baseline"],
    );
    assert.equal(fixture.database.prepare("PRAGMA quick_check").get().quick_check, "ok");
  } finally {
    fixture.close();
  }
});

test("Block 4/7: geaenderte SQLite-Implementierung macht bestehende Historie ungueltig", async () => {
  const manifest = defineMigrationManifest({
    id: "fixture.implementation-drift",
    migrations: [{
      id: "v1.implementation-drift",
      operations: ["schema.drift.create"],
      rollbackOperations: null,
    }],
  });
  const database = openSqliteLegacyDatabase(":memory:");
  const handler = ({ database: operationDatabase }) => {
    operationDatabase.exec("CREATE TABLE implementation_drift_probe (id TEXT)");
  };
  try {
    const initialAdapter = createSqliteMigrationAdapter({
      database,
      operations: {
        "schema.drift.create": {
          handler,
          implementationFingerprint: "1".repeat(64),
        },
      },
    });
    await runMigrationManifest({ manifest, adapter: initialAdapter });

    const changedAdapter = createSqliteMigrationAdapter({
      database,
      operations: {
        "schema.drift.create": {
          handler,
          implementationFingerprint: "2".repeat(64),
        },
      },
    });
    await assert.rejects(
      runMigrationManifest({ manifest, adapter: changedAdapter }),
      (error) => error.code === MIGRATION_ERROR_CODES.HISTORY_INVALID,
    );

    assert.equal(tableExists(database, "implementation_drift_probe"), true);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM persistence_migration_history")
        .get().count,
      1,
    );
  } finally {
    database.close();
  }
});

test("Block 4/7: SQLite-Adapter verlangt explizite primitive Implementierungsfingerprints", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  const handler = () => {};
  try {
    assert.throws(
      () => createSqliteMigrationAdapter({
        database,
        operations: {
          "schema.implicit-closure": handler,
        },
      }),
      (error) => error.code === MIGRATION_ERROR_CODES.ADAPTER_INVALID,
    );
    assert.throws(
      () => createSqliteMigrationAdapter({
        database,
        operations: {
          "schema.boxed-fingerprint": {
            handler,
            implementationFingerprint: Object("a".repeat(64)),
          },
        },
      }),
      (error) => error.code === MIGRATION_ERROR_CODES.ADAPTER_INVALID,
    );
    assert.equal(tableExists(database, "persistence_migration_history"), false);
  } finally {
    database.close();
  }
});

test("Block 4/7: asynchrone Handler koennen nach await nicht ausserhalb der Transaktion schreiben", async () => {
  const manifest = defineMigrationManifest({
    id: "fixture.async-escape",
    migrations: [{
      id: "v1.async-escape",
      operations: ["schema.async.escape"],
      rollbackOperations: null,
    }],
  });
  const fixture = createSqliteMigrationFixture({
    manifest,
    operations: {
      async "schema.async.escape"({ database }) {
        const escapedCreate = database.prepare(
          "CREATE TABLE async_escape_probe (value TEXT NOT NULL)",
        );
        await Promise.resolve();
        escapedCreate.run();
      },
    },
  });
  try {
    await assert.rejects(
      fixture.migrate(),
      (error) => error.code === MIGRATION_ERROR_CODES.EXECUTION_INVALID,
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(tableExists(fixture.database, "async_escape_probe"), false);
    assert.deepEqual(await fixture.history(), []);
    assert.equal(fixture.database.prepare("PRAGMA quick_check").get().quick_check, "ok");
  } finally {
    fixture.close();
  }
});

test("Block 4/7: Handler koennen die aeussere SQLite-Transaktion nicht steuern", async () => {
  const attempts = [
    ["commit", "COMMIT"],
    ["rollback", "ROLLBACK"],
    ["savepoint", "SAVEPOINT unauthorized"],
    ["end", "END"],
    ["nested", "BEGIN"],
    ["release", "RELEASE unauthorized"],
  ];

  for (const [attempt, sql] of attempts) {
    const operationId = `schema.transaction.${attempt}`;
    const manifest = defineMigrationManifest({
      id: `fixture.transaction-${attempt}`,
      migrations: [{
        id: `v1.transaction-${attempt}`,
        operations: [operationId],
        rollbackOperations: null,
      }],
    });
    const fixture = createSqliteMigrationFixture({
      manifest,
      operations: {
        [operationId]({ database }) {
          database.exec(`
            CREATE TABLE transaction_probe_${attempt} (id TEXT);
            /* adversarial second statement */
            ${sql}
          `);
        },
      },
    });
    try {
      await assert.rejects(
        fixture.migrate(),
        (error) => error.code === MIGRATION_ERROR_CODES.EXECUTION_INVALID,
      );
      assert.equal(tableExists(fixture.database, `transaction_probe_${attempt}`), false);
      assert.deepEqual(await fixture.history(), []);
      assert.equal(fixture.database.prepare("PRAGMA quick_check").get().quick_check, "ok");
    } finally {
      fixture.close();
    }
  }

  for (const [attempt, sql] of attempts.slice(0, 4)) {
    const operationId = `schema.transaction.prepared-${attempt}`;
    const preparedManifest = defineMigrationManifest({
      id: `fixture.transaction-prepared-${attempt}`,
      migrations: [{
        id: `v1.transaction-prepared-${attempt}`,
        operations: [operationId],
        rollbackOperations: null,
      }],
    });
    const preparedFixture = createSqliteMigrationFixture({
      manifest: preparedManifest,
      operations: {
        [operationId]({ database }) {
          database.prepare(sql).run();
        },
      },
    });
    try {
      await assert.rejects(
        preparedFixture.migrate(),
        (error) => error.code === MIGRATION_ERROR_CODES.EXECUTION_INVALID,
      );
      assert.deepEqual(await preparedFixture.history(), []);
      assert.equal(
        preparedFixture.database.prepare("PRAGMA quick_check").get().quick_check,
        "ok",
      );
    } finally {
      preparedFixture.close();
    }
  }

  const triggerManifest = defineMigrationManifest({
    id: "fixture.transaction-trigger-body",
    migrations: [{
      id: "v1.transaction-trigger-body",
      operations: ["schema.transaction.trigger-body"],
      rollbackOperations: null,
    }],
  });
  const triggerFixture = createSqliteMigrationFixture({
    manifest: triggerManifest,
    operations: {
      "schema.transaction.trigger-body"({ database }) {
        database.exec(`
          CREATE TABLE trigger_source (value TEXT NOT NULL);
          CREATE TABLE trigger_audit (value TEXT NOT NULL);
          CREATE TRIGGER trigger_source_audit
          AFTER INSERT ON trigger_source
          BEGIN
            INSERT INTO trigger_audit (value)
            VALUES (CASE WHEN NEW.value = '' THEN 'empty' ELSE NEW.value END);
          END;
        `);
      },
    },
  });
  try {
    await triggerFixture.migrate();
    triggerFixture.database.prepare(
      "INSERT INTO trigger_source (value) VALUES (?)",
    ).run("allowed");
    assert.equal(
      triggerFixture.database.prepare(
        "SELECT value FROM trigger_audit",
      ).get().value,
      "allowed",
    );
  } finally {
    triggerFixture.close();
  }
});

test("Block 4/7: Handler koennen die SQLite-Verbindung nicht schliessen", async () => {
  const manifest = defineMigrationManifest({
    id: "fixture.connection-close",
    migrations: [{
      id: "v1.connection-close",
      operations: ["schema.connection.close"],
      rollbackOperations: null,
    }],
  });
  const fixture = createSqliteMigrationFixture({
    manifest,
    operations: {
      "schema.connection.close"({ database }) {
        database.exec("CREATE TABLE connection_close_probe (id TEXT)");
        database.close();
      },
    },
  });
  try {
    await assert.rejects(
      fixture.migrate(),
      (error) => error.code === MIGRATION_ERROR_CODES.EXECUTION_INVALID,
    );
    assert.equal(tableExists(fixture.database, "connection_close_probe"), false);
    assert.deepEqual(await fixture.history(), []);
    assert.equal(fixture.database.prepare("PRAGMA quick_check").get().quick_check, "ok");
  } finally {
    fixture.close();
  }
});
