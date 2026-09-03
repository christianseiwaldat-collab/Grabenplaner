"use strict";

function assertSqliteOperationsDatabase(database) {
  if (!database || typeof database.exec !== "function" || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benoetigt.");
  }
  return database;
}

const PERSONAL_ACTION_RECEIPT_COLUMNS = Object.freeze([
  "id", "actor_kind", "actor_id", "action_type", "entity_type", "entity_id",
  "scope", "summary", "compensator_key", "undo_payload", "result_revision",
  "result_fingerprint", "source_audit_id", "undo_expires_at", "compensates_action_id",
  "created_at",
]);

function personalActionReceiptTableSql(tableName, { ifNotExists = false } = {}) {
  if (!["personal_action_receipts", "personal_action_receipts_next"].includes(tableName)) {
    throw new TypeError("Der Tabellenname der persönlichen Aktionsbelege ist ungültig.");
  }
  return `
    CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${tableName} (
      id TEXT PRIMARY KEY CHECK(length(id) = 36),
      actor_kind TEXT NOT NULL CHECK(actor_kind = 'employee'),
      actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 120),
      action_type TEXT NOT NULL CHECK(length(action_type) BETWEEN 3 AND 120),
      entity_type TEXT NOT NULL CHECK(length(entity_type) BETWEEN 1 AND 120),
      entity_id TEXT NOT NULL CHECK(length(entity_id) BETWEEN 1 AND 160),
      scope TEXT NOT NULL CHECK(length(scope) BETWEEN 1 AND 160),
      summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 300),
      compensator_key TEXT CHECK(compensator_key IS NULL OR compensator_key IN (
        'schedule.manual-lock.restore.v1',
        'sales.article-catalog.restore.v1',
        'sales.article-catalog.import.restore.v1'
      )),
      undo_payload TEXT,
      result_revision INTEGER CHECK(result_revision IS NULL OR result_revision > 0),
      result_fingerprint TEXT CHECK(
        result_fingerprint IS NULL OR (
          length(result_fingerprint) = 64
          AND result_fingerprint = lower(result_fingerprint)
          AND result_fingerprint NOT GLOB '*[^0-9a-f]*'
        )
      ),
      source_audit_id INTEGER CHECK(source_audit_id IS NULL OR source_audit_id > 0),
      undo_expires_at TEXT CHECK(undo_expires_at IS NULL OR length(undo_expires_at) = 24),
      compensates_action_id TEXT UNIQUE,
      created_at TEXT NOT NULL CHECK(length(created_at) = 24),
      CHECK(
        (compensator_key IS NULL AND undo_payload IS NULL AND undo_expires_at IS NULL)
        OR (
          compensator_key IS NOT NULL
          AND undo_payload IS NOT NULL
          AND undo_expires_at IS NOT NULL
          AND undo_expires_at > created_at
          AND (result_revision IS NOT NULL OR result_fingerprint IS NOT NULL)
          AND compensates_action_id IS NULL
        )
      ),
      FOREIGN KEY (compensates_action_id) REFERENCES ${tableName}(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    )
  `;
}

function migratePersonalActionReceiptCompensators(database) {
  const schema = database.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'personal_action_receipts'
  `).get()?.sql || "";
  if (!schema || schema.includes("sales.article-catalog.import.restore.v1")) return;
  const columns = database.prepare("PRAGMA table_info(personal_action_receipts)").all()
    .map((column) => String(column.name || ""));
  const withoutAudit = PERSONAL_ACTION_RECEIPT_COLUMNS.filter(
    (column) => column !== "source_audit_id",
  );
  const completeLegacyShape = columns.length === PERSONAL_ACTION_RECEIPT_COLUMNS.length
    && PERSONAL_ACTION_RECEIPT_COLUMNS.every((column) => columns.includes(column));
  const completePreAuditShape = columns.length === withoutAudit.length
    && withoutAudit.every((column) => columns.includes(column));
  if (!completeLegacyShape && !completePreAuditShape) return;
  if (database.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'personal_action_receipts_next'
  `).get()) {
    throw new Error("Eine unvollständige Migration persönlicher Aktionsbelege wurde erkannt.");
  }
  const foreignKeysEnabled = Number(
    database.prepare("PRAGMA foreign_keys").get()?.foreign_keys,
  ) === 1;
  if (foreignKeysEnabled) database.exec("PRAGMA foreign_keys = OFF");
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    database.exec(personalActionReceiptTableSql("personal_action_receipts_next"));
    database.exec(`
      INSERT INTO personal_action_receipts_next (
        ${PERSONAL_ACTION_RECEIPT_COLUMNS.join(", ")}
      )
      SELECT
        ${PERSONAL_ACTION_RECEIPT_COLUMNS.map((column) => (
          column === "source_audit_id" && completePreAuditShape ? "NULL" : column
        )).join(", ")}
      FROM personal_action_receipts
    `);
    database.exec(`
      DROP TABLE personal_action_receipts;
      ALTER TABLE personal_action_receipts_next RENAME TO personal_action_receipts;
    `);
    database.exec("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try { database.exec("ROLLBACK"); } catch {}
    }
    throw error;
  } finally {
    if (foreignKeysEnabled) database.exec("PRAGMA foreign_keys = ON");
  }
  const violation = database.prepare(
    "PRAGMA foreign_key_check(personal_action_receipts)",
  ).get();
  if (violation) throw new Error("Die Migration persönlicher Aktionsbelege verletzt Fremdschlüssel.");
}

function ensureSqlitePersonalActionLogSchema(database) {
  const target = assertSqliteOperationsDatabase(database);
  migratePersonalActionReceiptCompensators(target);
  target.exec(`
    ${personalActionReceiptTableSql("personal_action_receipts", { ifNotExists: true })};

    CREATE INDEX IF NOT EXISTS idx_personal_action_receipts_actor_created
      ON personal_action_receipts(actor_kind, actor_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_personal_action_receipts_actor_id
      ON personal_action_receipts(actor_kind, actor_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_actor_id
      ON audit_log(actor, id DESC);

    CREATE TRIGGER IF NOT EXISTS trg_personal_action_receipts_immutable_update
    BEFORE UPDATE ON personal_action_receipts
    BEGIN
      SELECT RAISE(ABORT, 'personal action receipts are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_personal_action_receipts_immutable_delete
    BEFORE DELETE ON personal_action_receipts
    BEGIN
      SELECT RAISE(ABORT, 'personal action receipts are immutable');
    END;
  `);
  const columns = new Set(target.prepare("PRAGMA table_info(personal_action_receipts)").all()
    .map((column) => column.name));
  if (!columns.has("source_audit_id")) {
    target.exec("ALTER TABLE personal_action_receipts ADD COLUMN source_audit_id INTEGER CHECK(source_audit_id IS NULL OR source_audit_id > 0)");
  }
  target.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_action_receipts_source_audit
      ON personal_action_receipts(source_audit_id)
      WHERE source_audit_id IS NOT NULL;
  `);
}

module.exports = {
  ensureSqlitePersonalActionLogSchema,
};
