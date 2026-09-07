"use strict";
// Portable archive schema. Startup creates empty storage only. Versions are
// immutable; customer/article references and journal rows remain historical data.
const IMPORT_HISTORY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS import_history_epochs (
    scope_id TEXT PRIMARY KEY, token TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS import_history_records (
    id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, source_instance TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('trade','cash')), source_table TEXT NOT NULL,
    profile_hash TEXT NOT NULL CHECK(length(profile_hash)=64), identity_hash TEXT NOT NULL UNIQUE CHECK(length(identity_hash)=64),
    revision INTEGER NOT NULL CHECK(revision>0)
  );
  CREATE INDEX IF NOT EXISTS idx_import_history_scope ON import_history_records(scope_id, source_instance, source, source_table, id);
  CREATE TABLE IF NOT EXISTS import_history_versions (
    record_id TEXT NOT NULL REFERENCES import_history_records(id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL CHECK(revision>0), file_sha256 TEXT NOT NULL CHECK(length(file_sha256)=64),
    snapshot_at TEXT NOT NULL, imported_by TEXT NOT NULL, imported_at TEXT NOT NULL, run_id TEXT NOT NULL,
    master_source_instance TEXT NOT NULL, business_date TEXT, parent_id TEXT, parent_revision INTEGER,
    payload TEXT NOT NULL, PRIMARY KEY(record_id, revision),
    FOREIGN KEY(parent_id, parent_revision) REFERENCES import_history_versions(record_id, revision) ON DELETE RESTRICT,
    CHECK((parent_id IS NULL AND parent_revision IS NULL) OR (parent_id IS NOT NULL AND parent_revision>0))
  );
  CREATE INDEX IF NOT EXISTS idx_import_history_parent ON import_history_versions(parent_id, parent_revision);
  CREATE INDEX IF NOT EXISTS idx_import_history_snapshot ON import_history_versions(file_sha256, record_id, revision);
  CREATE INDEX IF NOT EXISTS idx_import_history_date ON import_history_versions(business_date, record_id, revision);
  CREATE TABLE IF NOT EXISTS import_history_segments (
    record_id TEXT NOT NULL, revision INTEGER NOT NULL, data_class TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(record_id, revision, data_class),
    FOREIGN KEY(record_id, revision) REFERENCES import_history_versions(record_id, revision) ON DELETE RESTRICT
  );
  CREATE TABLE IF NOT EXISTS import_history_references (
    record_id TEXT NOT NULL, revision INTEGER NOT NULL, role TEXT NOT NULL, data_class TEXT NOT NULL,
    master_record_id TEXT REFERENCES import_master_records(id) ON DELETE RESTRICT, lookup_hash TEXT,
    PRIMARY KEY(record_id, revision, role),
    FOREIGN KEY(record_id, revision) REFERENCES import_history_versions(record_id, revision) ON DELETE RESTRICT
  );
  CREATE INDEX IF NOT EXISTS idx_import_history_reference ON import_history_references(lookup_hash, role, record_id, revision);
  CREATE TABLE IF NOT EXISTS import_history_holds (
    record_id TEXT NOT NULL REFERENCES import_history_records(id) ON DELETE RESTRICT,
    consumer_id TEXT NOT NULL, PRIMARY KEY(record_id, consumer_id)
  );
`;
function ensureSqliteImportHistorySchema(database) {
  if (!database || typeof database.exec !== 'function') throw new TypeError('SQLite operations database required');
  database.exec(IMPORT_HISTORY_SCHEMA_SQL);
}
module.exports = { IMPORT_HISTORY_SCHEMA_SQL, ensureSqliteImportHistorySchema };
