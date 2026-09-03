"use strict";

function assertSqliteOperationsDatabase(database) {
  if (!database || typeof database.exec !== "function" || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benoetigt.");
  }
  return database;
}

function ensureSqlitePersonalActionLogSchema(database) {
  const target = assertSqliteOperationsDatabase(database);
  target.exec(`
    CREATE TABLE IF NOT EXISTS personal_action_receipts (
      id TEXT PRIMARY KEY CHECK(length(id) = 36),
      actor_kind TEXT NOT NULL CHECK(actor_kind = 'employee'),
      actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 120),
      action_type TEXT NOT NULL CHECK(length(action_type) BETWEEN 3 AND 120),
      entity_type TEXT NOT NULL CHECK(length(entity_type) BETWEEN 1 AND 120),
      entity_id TEXT NOT NULL CHECK(length(entity_id) BETWEEN 1 AND 160),
      scope TEXT NOT NULL CHECK(length(scope) BETWEEN 1 AND 160),
      summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 300),
      compensator_key TEXT
        CHECK(compensator_key IS NULL OR compensator_key = 'schedule.manual-lock.restore.v1'),
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
      FOREIGN KEY (compensates_action_id) REFERENCES personal_action_receipts(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );

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
