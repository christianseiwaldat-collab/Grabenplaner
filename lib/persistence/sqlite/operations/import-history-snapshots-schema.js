'use strict';
// Snapshot membership is durable business provenance. It has no foreign key to
// disposable staging rows, change journals or import-run retention envelopes.
const IMPORT_HISTORY_SNAPSHOTS_SCHEMA_SQL = `
 CREATE TABLE IF NOT EXISTS import_history_snapshots (
  run_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, source_instance TEXT NOT NULL,
  profile_hash TEXT NOT NULL CHECK(length(profile_hash)=64),
  file_sha256 TEXT NOT NULL CHECK(length(file_sha256)=64), snapshot_at TEXT NOT NULL,
  owner_id TEXT NOT NULL, expected_rows INTEGER NOT NULL CHECK(expected_rows>=0),
  status TEXT NOT NULL CHECK(status IN ('building','published','withdrawn')), payload TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS import_history_snapshots_source
  ON import_history_snapshots(scope_id,source_instance,file_sha256,run_id);
 CREATE TABLE IF NOT EXISTS import_history_snapshot_members (
  run_id TEXT NOT NULL REFERENCES import_history_snapshots(run_id) ON DELETE RESTRICT,
  row_number INTEGER NOT NULL CHECK(row_number>0), record_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0), payload TEXT NOT NULL,
  PRIMARY KEY(run_id,row_number), UNIQUE(run_id,record_id),
  FOREIGN KEY(record_id,revision) REFERENCES import_history_versions(record_id,revision) ON DELETE RESTRICT
 );
 CREATE INDEX IF NOT EXISTS import_history_snapshot_members_version
  ON import_history_snapshot_members(record_id,revision,run_id);
`;
function ensureSqliteImportHistorySnapshotsSchema(database) {
 if (!database || typeof database.exec !== 'function') throw new TypeError('SQLite operations database required');
 database.exec(IMPORT_HISTORY_SNAPSHOTS_SCHEMA_SQL);
}
module.exports={IMPORT_HISTORY_SNAPSHOTS_SCHEMA_SQL,ensureSqliteImportHistorySnapshotsSchema};
