"use strict";
const { ensureSqliteDataImportSchema } = require('./data-import-schema');
const { ensureSqliteImportMasterSchema } = require('./import-master-schema');
const { ensureSqliteImportHistorySchema } = require('./import-history-schema');
const { ensureSqliteCashSnapshotsSchema } = require('./cash-snapshots-schema');
const { ensureSqliteCashPublicationsSchema } = require('./cash-publications-schema');
const DATA_IMPORT_RUNTIME_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS data_import_runtime_keys (
  id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS data_import_sources (
  id TEXT PRIMARY KEY CHECK(length(id)=64), scope_id TEXT NOT NULL, owner_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  payload TEXT NOT NULL, CHECK(created_at<=updated_at)
);
CREATE INDEX IF NOT EXISTS idx_data_import_sources_owner ON data_import_sources(scope_id,owner_id,created_at,id);
`;
function ensureSqliteDataImportRuntimeSchema(database) {
  if (!database || typeof database.exec !== 'function') throw new TypeError('SQLite operations database required');
  for (const ensure of [ensureSqliteDataImportSchema, ensureSqliteImportMasterSchema, ensureSqliteImportHistorySchema]) ensure(database);
  database.exec(DATA_IMPORT_RUNTIME_SCHEMA_SQL);
  ensureSqliteCashSnapshotsSchema(database);
  ensureSqliteCashPublicationsSchema(database);
  require('./sales-report-jobs-schema').ensureSqliteSalesReportJobsSchema(database);
}
module.exports = { DATA_IMPORT_RUNTIME_SCHEMA_SQL, ensureSqliteDataImportRuntimeSchema };
