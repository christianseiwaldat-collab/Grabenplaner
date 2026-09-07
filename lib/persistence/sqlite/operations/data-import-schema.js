"use strict";

// Portable TEXT/INTEGER DDL. Startup registration does not provision keys or data.
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
CREATE TABLE IF NOT EXISTS data_import_run_state_counts (
  run_id TEXT NOT NULL REFERENCES data_import_runs(id) ON DELETE RESTRICT,
  state TEXT NOT NULL, count INTEGER NOT NULL CHECK(count>=0), PRIMARY KEY(run_id,state)
);
-- Keep the ordered work queue small as completed rows leave it. Without this
-- portable partial index, repeated LIMIT batches may rescan the whole prefix.
CREATE INDEX IF NOT EXISTS idx_data_import_rows_pending_apply ON data_import_rows(run_id,row_number)
  WHERE state IN ('create','update','refresh');
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
CREATE TABLE IF NOT EXISTS data_import_payload_blocks (
  id TEXT NOT NULL PRIMARY KEY CHECK(length(id)=64),
  scope_id TEXT NOT NULL CHECK(length(scope_id) BETWEEN 1 AND 120),
  owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 120),
  profile_hash TEXT NOT NULL CHECK(length(profile_hash)=64),
  source_system TEXT NOT NULL CHECK(length(source_system) BETWEEN 1 AND 120),
  source_instance TEXT NOT NULL CHECK(length(source_instance) BETWEEN 1 AND 120),
  source_table TEXT NOT NULL CHECK(length(source_table) BETWEEN 1 AND 120),
  entity TEXT NOT NULL CHECK(length(entity) BETWEEN 1 AND 120),
  block_type TEXT NOT NULL CHECK(block_type IN ('object','string')),
  payload TEXT NOT NULL CHECK(length(payload) BETWEEN 1 AND 2359296),
  key_id TEXT NOT NULL CHECK(length(key_id) BETWEEN 1 AND 64),
  nonce TEXT NOT NULL CHECK(length(nonce)=16),
  created_at TEXT NOT NULL CHECK(length(created_at)=24),
  UNIQUE(key_id,nonce)
);
CREATE TABLE IF NOT EXISTS data_import_row_payload_refs (
  run_id TEXT NOT NULL, row_number INTEGER NOT NULL CHECK(row_number BETWEEN 1 AND 2000000),
  slot TEXT NOT NULL CHECK(slot IN ('record.source','record.data','beforeTarget.data','afterTarget.data','beforeLink.payload','patch')),
  block_id TEXT NOT NULL REFERENCES data_import_payload_blocks(id) ON DELETE RESTRICT,
  PRIMARY KEY(run_id,row_number,slot),
  FOREIGN KEY(run_id,row_number) REFERENCES data_import_rows(run_id,row_number) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS data_import_change_payload_refs (
  run_id TEXT NOT NULL, row_number INTEGER NOT NULL CHECK(row_number BETWEEN 1 AND 2000000),
  slot TEXT NOT NULL CHECK(slot IN ('record.source','record.data','beforeTarget.data','afterTarget.data','beforeLink.payload','patch')),
  block_id TEXT NOT NULL REFERENCES data_import_payload_blocks(id) ON DELETE RESTRICT,
  PRIMARY KEY(run_id,row_number,slot),
  FOREIGN KEY(run_id,row_number) REFERENCES data_import_changes(run_id,row_number) ON DELETE RESTRICT
);
`;
// SQLite enforcement is separate from portable table/statement contracts.
// PostgreSQL remains a partial development slice, not a migrated application.
const SQLITE_DATA_IMPORT_PAYLOAD_GUARDS_SQL = `
CREATE TRIGGER IF NOT EXISTS data_import_payload_blocks_no_update
BEFORE UPDATE ON data_import_payload_blocks BEGIN
  SELECT RAISE(ABORT,'DATA_IMPORT_PAYLOAD_BLOCK_IMMUTABLE');
END;
CREATE TRIGGER IF NOT EXISTS data_import_payload_blocks_no_delete
BEFORE DELETE ON data_import_payload_blocks BEGIN
  SELECT RAISE(ABORT,'DATA_IMPORT_PAYLOAD_BLOCK_IMMUTABLE');
END;
`;
const SQLITE_DATA_IMPORT_COUNT_TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS data_import_count_insert AFTER INSERT ON data_import_rows BEGIN
  INSERT INTO data_import_run_state_counts(run_id,state,count) VALUES(NEW.run_id,NEW.state,1)
    ON CONFLICT(run_id,state) DO UPDATE SET count=count+1;
END;
CREATE TRIGGER IF NOT EXISTS data_import_count_delete AFTER DELETE ON data_import_rows BEGIN
  UPDATE data_import_run_state_counts SET count=count-1 WHERE run_id=OLD.run_id AND state=OLD.state;
  DELETE FROM data_import_run_state_counts WHERE run_id=OLD.run_id AND state=OLD.state AND count=0;
END;
CREATE TRIGGER IF NOT EXISTS data_import_count_update AFTER UPDATE OF state,run_id ON data_import_rows
WHEN OLD.state<>NEW.state OR OLD.run_id<>NEW.run_id BEGIN
  UPDATE data_import_run_state_counts SET count=count-1 WHERE run_id=OLD.run_id AND state=OLD.state;
  DELETE FROM data_import_run_state_counts WHERE run_id=OLD.run_id AND state=OLD.state AND count=0;
  INSERT INTO data_import_run_state_counts(run_id,state,count) VALUES(NEW.run_id,NEW.state,1)
    ON CONFLICT(run_id,state) DO UPDATE SET count=count+1;
END;
`;
function ensureSqliteDataImportSchema(database) {
  if (!database || typeof database.exec !== "function") throw new TypeError("SQLite-Operationsdatenbank erforderlich.");
  const hasCounts = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='data_import_run_state_counts'").get();
  if (hasCounts && database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('data_import_count_insert','data_import_count_delete','data_import_count_update')").get().n !== 3) {
    throw new Error('DATA_IMPORT_COUNT_SCHEMA_INCOMPLETE');
  }
  database.exec('SAVEPOINT data_import_schema');
  try {
    database.exec(DATA_IMPORT_SCHEMA_SQL);
    if (!hasCounts) database.exec('INSERT INTO data_import_run_state_counts(run_id,state,count) SELECT run_id,state,COUNT(*) FROM data_import_rows GROUP BY run_id,state');
    database.exec(SQLITE_DATA_IMPORT_PAYLOAD_GUARDS_SQL);
    database.exec(SQLITE_DATA_IMPORT_COUNT_TRIGGERS_SQL);
    database.exec('RELEASE data_import_schema');
  } catch (error) {
    database.exec('ROLLBACK TO data_import_schema'); database.exec('RELEASE data_import_schema'); throw error;
  }
}
module.exports = { DATA_IMPORT_SCHEMA_SQL, SQLITE_DATA_IMPORT_PAYLOAD_GUARDS_SQL, SQLITE_DATA_IMPORT_COUNT_TRIGGERS_SQL, ensureSqliteDataImportSchema };
