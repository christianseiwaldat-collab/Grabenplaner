"use strict";
// Portable archive DDL. Application startup creates empty storage only.
const IMPORT_MASTER_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS import_master_records (
    id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, source_instance TEXT NOT NULL,
    source_table TEXT NOT NULL, profile_hash TEXT NOT NULL CHECK(length(profile_hash)=64),
    identity_hash TEXT NOT NULL UNIQUE CHECK(length(identity_hash)=64),
    revision INTEGER NOT NULL CHECK(revision>0), updated_by TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_import_master_scope ON import_master_records(scope_id, source_instance, source_table);
  CREATE TABLE IF NOT EXISTS import_master_segments (
    record_id TEXT NOT NULL REFERENCES import_master_records(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL, data_class TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(record_id, kind, data_class)
  );
  CREATE TABLE IF NOT EXISTS import_master_relations (
    record_id TEXT NOT NULL REFERENCES import_master_records(id) ON DELETE RESTRICT,
    slot INTEGER NOT NULL CHECK(slot>=0), parent_table TEXT NOT NULL, identity_hash TEXT,
    state TEXT NOT NULL CHECK(state IN ('unassigned','candidate','key_review')), evidence TEXT NOT NULL,
    PRIMARY KEY(record_id, slot)
  );
  CREATE INDEX IF NOT EXISTS idx_import_master_parent ON import_master_relations(identity_hash);
  CREATE TABLE IF NOT EXISTS import_master_bindings (
    record_id TEXT PRIMARY KEY REFERENCES import_master_records(id) ON DELETE RESTRICT,
    scope_id TEXT NOT NULL, source_instance TEXT NOT NULL, source_table TEXT NOT NULL,
    target_kind TEXT NOT NULL CHECK(target_kind IN ('crm_customer','sales_article','employee','location')),
    target_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
    source_revision INTEGER NOT NULL CHECK(source_revision>0), historical BOOLEAN NOT NULL CHECK(historical IN (TRUE,FALSE)),
    payload TEXT NOT NULL, last_event_id TEXT NOT NULL,
    UNIQUE(scope_id, source_instance, source_table, target_kind, target_id)
  );
  CREATE TABLE IF NOT EXISTS import_master_events (
    id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, record_id TEXT NOT NULL,
    actor_id TEXT NOT NULL, action TEXT NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL, reverted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_import_master_events ON import_master_events(scope_id, record_id, at);
  CREATE TABLE IF NOT EXISTS import_master_holds (
    record_id TEXT NOT NULL REFERENCES import_master_records(id) ON DELETE RESTRICT,
    consumer_id TEXT NOT NULL, PRIMARY KEY(record_id, consumer_id)
  );
`;
function ensureSqliteImportMasterSchema(database) {
  if (!database || typeof database.exec !== "function") throw new TypeError("SQLite operations database required");
  database.exec(IMPORT_MASTER_SCHEMA_SQL);
}
module.exports = { IMPORT_MASTER_SCHEMA_SQL, ensureSqliteImportMasterSchema };
