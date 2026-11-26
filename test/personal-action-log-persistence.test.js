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
  ensureSqlitePersonalActionLogSchema,
} = require("../lib/persistence/sqlite/operations/personal-action-log-schema");
const {
  SQLITE_PERSONAL_ACTION_LOG_CATALOG,
} = require("../lib/persistence/sqlite/personal-action-log-catalog");
const {
  PERSONAL_ACTION_LOG_STATEMENTS,
} = require("../lib/persistence/statements/personal-action-log");
const {
  normalizePersonalActionReceiptInput,
} = require("../lib/personal-action-log");

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

test("Artikel-Undo-Belege verlangen eine explizite Zielrevision", () => {
  assert.throws(
    () => normalizePersonalActionReceiptInput(action({
      actionType: "sales.article-catalog.update",
      entityType: "sales_article",
      entityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      scope: "Artikelstamm",
      summary: "Artikel bearbeitet",
      compensatorKey: "sales.article-catalog.restore.v1",
      undoPayload: {
        productId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    })),
    /persönliche Aktionslog/,
  );
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
    path.join(root, "lib", "persistence", "catalogs", "application-catalog.js"),
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
