"use strict";

// Portable TEXT/INTEGER DDL. Not registered in application startup in Block 2.
// Central relations use columns/FKs, not provider-specific JSON queries or rowids.
const DATA_IMPORT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS data_import_runs (
  id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, owner_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
  profile_hash TEXT NOT NULL CHECK(length(profile_hash)=64), profile TEXT NOT NULL, manifest TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('staging','reviewing','needs_review','ready','applying','applied','reverting','reverted','cancelled','purged')),
  revision INTEGER NOT NULL CHECK(revision>0), received_count INTEGER NOT NULL CHECK(received_count BETWEEN 0 AND 2000000),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  CHECK(created_at<=updated_at AND created_at<expires_at)
);
CREATE INDEX IF NOT EXISTS idx_data_import_runs_owner ON data_import_runs(scope_id,owner_id,created_at,id);
CREATE TABLE IF NOT EXISTS data_import_rows (
  run_id TEXT NOT NULL REFERENCES data_import_runs(id) ON DELETE RESTRICT,
  row_number INTEGER NOT NULL CHECK(row_number BETWEEN 1 AND 2000000), identity_hash TEXT,
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  state TEXT NOT NULL CHECK(state IN ('staged','invalid','duplicate','conflict','create','update','refresh','unchanged','applied','reverted')),
  issue TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(run_id,row_number)
);
CREATE INDEX IF NOT EXISTS idx_data_import_rows_identity ON data_import_rows(run_id,identity_hash,row_number);
CREATE INDEX IF NOT EXISTS idx_data_import_rows_state ON data_import_rows(run_id,state,row_number);
CREATE TABLE IF NOT EXISTS data_import_links (
  id TEXT PRIMARY KEY CHECK(length(id)=64), scope_id TEXT NOT NULL, entity TEXT NOT NULL,
  target_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
  last_run_id TEXT NOT NULL REFERENCES data_import_runs(id) ON DELETE RESTRICT, payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_data_import_links_target ON data_import_links(scope_id,entity,target_id);
CREATE TABLE IF NOT EXISTS data_import_changes (
  run_id TEXT NOT NULL REFERENCES data_import_runs(id) ON DELETE RESTRICT,
  row_number INTEGER NOT NULL, identity_hash TEXT NOT NULL, payload TEXT NOT NULL, reverted_at TEXT,
  PRIMARY KEY(run_id,row_number), FOREIGN KEY(run_id,row_number) REFERENCES data_import_rows(run_id,row_number) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_data_import_changes_undo ON data_import_changes(run_id,reverted_at,row_number);
CREATE TABLE IF NOT EXISTS data_import_events (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES data_import_runs(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision>0), actor_id TEXT NOT NULL, action TEXT NOT NULL, at TEXT NOT NULL,
  UNIQUE(run_id,revision)
);
`;
function ensureSqliteDataImportSchema(database) {
  if (!database || typeof database.exec !== "function") throw new TypeError("SQLite-Operationsdatenbank erforderlich.");
  database.exec(DATA_IMPORT_SCHEMA_SQL);
}
module.exports = { DATA_IMPORT_SCHEMA_SQL, ensureSqliteDataImportSchema };
