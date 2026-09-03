"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  PERSISTENCE_ERROR_CODES,
} = require("../lib/persistence/contract");
const {
  POSTGRESQL_APPLICATION_DIALECT_PLAN,
} = require("../lib/persistence/dialects/application-manifest");
const {
  createPersonalActionLogRepository,
} = require("../lib/persistence/repositories/personal-action-log");
const {
  openSqliteApplicationPersistence,
  openSqliteLegacyDatabase,
} = require("../lib/persistence/sqlite/provider");
const {
  ensureSqlitePersonalActionLogSchema,
} = require("../lib/persistence/sqlite/operations/personal-action-log-schema");
const {
  SQLITE_PERSONAL_ACTION_LOG_CATALOG,
} = require("../lib/persistence/sqlite/personal-action-log-catalog");
const {
  PERSONAL_ACTION_LOG_STATEMENTS,
} = require("../lib/persistence/statements/personal-action-log");

const root = path.resolve(__dirname, "..");

function ensureAuditLog(database) {
  database.exec(`
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function schemaFixture() {
  const database = openSqliteLegacyDatabase(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  ensureAuditLog(database);
  ensureSqlitePersonalActionLogSchema(database);
  return database;
}

function repositoryFixture() {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_PERSONAL_ACTION_LOG_CATALOG,
  });
  application.database.exec("PRAGMA foreign_keys = ON");
  ensureAuditLog(application.database);
  ensureSqlitePersonalActionLogSchema(application.database);
  return {
    ...application,
    repository: createPersonalActionLogRepository(application.provider),
    async close() {
      await application.provider.close();
      application.database.close();
    },
  };
}

function action(overrides = {}) {
  return {
    actorId: "419",
    actionType: "schedule.manual-lock.lock",
    entityType: "schedule_manual_lock",
    entityId: "01:2026-08-31",
    scope: "Filiale 01 · KW 36",
    summary: "Dienstplan gesperrt",
    compensatorKey: "schedule.manual-lock.restore.v1",
    undoPayload: {
      locationId: "01",
      weekStart: "2026-08-31",
      restoreLocked: false,
    },
    resultRevision: 3,
    resultFingerprint: null,
    sourceAuditId: null,
    undoExpiresAt: "2026-09-03T09:30:00.000Z",
    compensatesActionId: null,
    createdAt: "2026-09-03T09:00:00.000Z",
    ...overrides,
  };
}

function nonUndoable(overrides = {}) {
  return action({
    actionType: "crm.customer.read",
    entityType: "crm_customer",
    entityId: "customer-01",
    scope: "CRM",
    summary: "Kundenkartei geöffnet",
    compensatorKey: null,
    undoPayload: null,
    resultRevision: null,
    resultFingerprint: null,
    undoExpiresAt: null,
    ...overrides,
  });
}

test("Persönliche Aktionsbelege sind append-only, eigentümergebunden und indiziert", () => {
  const database = schemaFixture();
  try {
    ensureSqlitePersonalActionLogSchema(database);
    const columns = database.prepare("PRAGMA table_info(personal_action_receipts)").all()
      .map((column) => column.name);
    assert.deepEqual(columns, [
      "id", "actor_kind", "actor_id", "action_type", "entity_type", "entity_id",
      "scope", "summary", "compensator_key", "undo_payload", "result_revision",
      "result_fingerprint", "source_audit_id", "undo_expires_at", "compensates_action_id", "created_at",
    ]);
    const indexes = database.prepare("PRAGMA index_list(personal_action_receipts)").all()
      .map((row) => row.name);
    assert.ok(indexes.includes("idx_personal_action_receipts_actor_created"));
    assert.ok(indexes.includes("idx_personal_action_receipts_actor_id"));
    assert.ok(indexes.includes("idx_personal_action_receipts_source_audit"));
    assert.deepEqual(
      database.prepare("PRAGMA index_info(idx_audit_log_actor_id)").all()
        .map((row) => row.name),
      ["actor", "id"],
    );

    database.prepare(`
      INSERT INTO personal_action_receipts (
        id, actor_kind, actor_id, action_type, entity_type, entity_id, scope, summary,
        compensator_key, undo_payload, result_revision, result_fingerprint,
        undo_expires_at, compensates_action_id, created_at
      ) VALUES (?, 'employee', '419', 'crm.customer.read', 'crm_customer', 'customer-01',
        'CRM', 'Kundenkartei geöffnet', NULL, NULL, NULL, NULL, NULL, NULL, ?)
    `).run("11111111-1111-4111-8111-111111111111", "2026-09-03T09:00:00.000Z");
    assert.throws(
      () => database.prepare("UPDATE personal_action_receipts SET summary = 'Geändert' WHERE actor_id = '419'").run(),
      /personal action receipts are immutable/,
    );
    assert.throws(
      () => database.prepare("DELETE FROM personal_action_receipts WHERE actor_id = '419'").run(),
      /personal action receipts are immutable/,
    );
  } finally {
    database.close();
  }
});

test("Bestehende Aktionsbelegtabellen erhalten die eindeutige Auditverknüpfung nachträglich", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    ensureAuditLog(database);
    database.exec(`
      CREATE TABLE personal_action_receipts (
        id TEXT PRIMARY KEY,
        actor_kind TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    ensureSqlitePersonalActionLogSchema(database);
    const columns = database.prepare("PRAGMA table_info(personal_action_receipts)").all()
      .map((column) => column.name);
    assert.ok(columns.includes("source_audit_id"));
    const indexes = database.prepare("PRAGMA index_list(personal_action_receipts)").all()
      .map((row) => row.name);
    assert.ok(indexes.includes("idx_personal_action_receipts_source_audit"));
  } finally {
    database.close();
  }
});

test("Öffentliche Listen sind keyset-paginiert und geben keine internen Undo-Daten aus", async () => {
  const context = repositoryFixture();
  try {
    const earlier = await context.repository.record(nonUndoable({
      createdAt: "2026-09-03T08:00:00.000Z",
    }));
    const latest = await context.repository.record(action());
    await context.repository.record(nonUndoable({
      actorId: "420",
      entityId: "customer-02",
      createdAt: "2026-09-03T10:00:00.000Z",
    }));

    const firstPage = await context.repository.listOwn("419", { limit: 1 });
    assert.equal(firstPage.length, 1);
    assert.equal(firstPage[0].id, latest.id);
    assert.equal(firstPage[0].actorId, "419");
    assert.equal(Object.hasOwn(firstPage[0], "undoPayload"), false);
    assert.equal(Object.hasOwn(firstPage[0], "resultFingerprint"), false);
    assert.equal(Object.hasOwn(firstPage[0], "resultRevision"), false);

    const secondPage = await context.repository.listOwn("419", {
      beforeCreatedAt: firstPage[0].createdAt,
      beforeId: firstPage[0].id,
      limit: 10,
    });
    assert.deepEqual(secondPage.map((row) => row.id), [earlier.id]);
    const internal = await context.repository.getOwn("419", latest.id);
    assert.deepEqual(internal.undoPayload, {
      locationId: "01",
      weekStart: "2026-08-31",
      restoreLocked: false,
    });
    assert.equal(internal.resultRevision, 3);
    assert.equal(await context.repository.getOwn("420", latest.id), null);
  } finally {
    await context.close();
  }
});

test("Kompensationen bleiben beim Eigentümer und dürfen eine Aktion nur einmal referenzieren", async () => {
  const context = repositoryFixture();
  try {
    const source = await context.repository.record(action());
    await assert.rejects(
      context.repository.record(nonUndoable({
        actorId: "420",
        actionType: "personal-action.undo",
        entityType: "personal_action",
        entityId: source.id,
        scope: "Dienstplanung",
        summary: "Aktion rückgängig gemacht",
        compensatesActionId: source.id,
        createdAt: "2026-09-03T09:05:00.000Z",
      })),
      (error) => error?.code === PERSISTENCE_ERROR_CODES.STATEMENT_INVALID,
    );

    const compensation = await context.repository.record(nonUndoable({
      actionType: "personal-action.undo",
      entityType: "personal_action",
      entityId: source.id,
      scope: "Dienstplanung",
      summary: "Aktion rückgängig gemacht",
      compensatesActionId: source.id,
      createdAt: "2026-09-03T09:05:00.000Z",
    }));
    assert.equal(
      (await context.repository.findCompensation("419", source.id)).id,
      compensation.id,
    );
    assert.equal(await context.repository.findCompensation("420", source.id), null);

    await assert.rejects(
      context.repository.record(nonUndoable({
        actionType: "personal-action.undo",
        entityType: "personal_action",
        entityId: source.id,
        scope: "Dienstplanung",
        summary: "Doppelter Rücknahmeversuch",
        compensatesActionId: source.id,
        createdAt: "2026-09-03T09:06:00.000Z",
      })),
      (error) => error?.code === PERSISTENCE_ERROR_CODES.UNIQUE_VIOLATION,
    );
  } finally {
    await context.close();
  }
});

test("Legacy-Audit wird exakt pro Mitarbeiter und ohne Detailspalte gelesen", async () => {
  const context = repositoryFixture();
  try {
    const insert = context.database.prepare(`
      INSERT INTO audit_log (actor, action, entity_type, entity_id, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insert.run("419", "crm.customer.create", "crm_customer", "customer-01", "secret-1", "2026-09-03 08:00:00");
    insert.run("419", "schedule.manual-lock.lock", "schedule_manual_lock", "01:2026-08-31", "secret-2", "2026-09-03 09:00:00");
    insert.run("420", "crm.customer.update", "crm_customer", "customer-02", "secret-3", "2026-09-03 10:00:00");

    const firstPage = await context.repository.listLegacyAuditForActor("419", { limit: 1 });
    assert.equal(firstPage.length, 1);
    assert.equal(firstPage[0].action, "schedule.manual-lock.lock");
    assert.equal(Object.hasOwn(firstPage[0], "detail"), false);
    const secondPage = await context.repository.listLegacyAuditForActor("419", {
      beforeId: firstPage[0].id,
      limit: 5,
    });
    assert.deepEqual(secondPage.map((row) => row.action), ["crm.customer.create"]);
  } finally {
    await context.close();
  }
});

test("Aktionslog ist in Anwendungskatalog, Repository-Factory und PostgreSQL-Plan registriert", () => {
  const ids = SQLITE_PERSONAL_ACTION_LOG_CATALOG.map((entry) => entry.statement.id);
  assert.equal(ids.length, new Set(ids).size);
  for (const statement of Object.values(PERSONAL_ACTION_LOG_STATEMENTS)) {
    assert.ok(ids.includes(statement.id), `SQLite-Statement fehlt: ${statement.id}`);
  }
  assert.equal(
    Object.hasOwn(PERSONAL_ACTION_LOG_STATEMENTS.listOwn.columns, "undoPayload"),
    false,
  );
  assert.equal(
    Object.hasOwn(PERSONAL_ACTION_LOG_STATEMENTS.listLegacyAuditForActor.columns, "detail"),
    false,
  );

  const repositories = fs.readFileSync(
    path.join(root, "lib", "persistence", "application-repositories.js"),
    "utf8",
  );
  const applicationCatalog = fs.readFileSync(
    path.join(root, "lib", "persistence", "sqlite", "application-catalog.js"),
    "utf8",
  );
  const applicationSchema = fs.readFileSync(
    path.join(root, "lib", "persistence", "sqlite", "operations", "application-schema.js"),
    "utf8",
  );
  assert.match(repositories, /personalActionLog:\s*createPersonalActionLogRepository\(access\)/);
  assert.match(applicationCatalog, /SQLITE_PERSONAL_ACTION_LOG_CATALOG/);
  assert.match(applicationSchema, /ensureSqlitePersonalActionLogSchema\(sqliteDatabase\)/);

  const planned = POSTGRESQL_APPLICATION_DIALECT_PLAN.entries
    .filter((entry) => entry.statementId.startsWith("personal-action-log."));
  assert.equal(planned.length, ids.length);
  assert.ok(planned.every((entry) => entry.strategy === "portable-generated"));
});
