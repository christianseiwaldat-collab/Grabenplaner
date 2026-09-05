"use strict";
// Explicitly isolated test fixture, never used by application startup.
const { openSqliteApplicationPersistence } = require('../lib/persistence/sqlite/provider');
const { ensureSqliteDataImportSchema } = require('../lib/persistence/sqlite/operations/data-import-schema');
const { ensureSqliteImportMasterSchema } = require('../lib/persistence/sqlite/operations/import-master-schema');
const { ensureSqliteImportHistorySchema } = require('../lib/persistence/sqlite/operations/import-history-schema');
const { SQLITE_DATA_IMPORT_CATALOG } = require('../lib/persistence/sqlite/data-import-catalog');
const { SQLITE_IMPORT_MASTER_CATALOG } = require('../lib/persistence/sqlite/import-master-catalog');
const { SQLITE_IMPORT_HISTORY_CATALOG } = require('../lib/persistence/sqlite/import-history-catalog');
function openTradeFotoBlock6Store(databasePath) {
  const app = openSqliteApplicationPersistence({ databasePath, catalog: [...SQLITE_DATA_IMPORT_CATALOG, ...SQLITE_IMPORT_MASTER_CATALOG, ...SQLITE_IMPORT_HISTORY_CATALOG] });
  app.database.exec('CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY, actor TEXT, action TEXT, entity_type TEXT, entity_id TEXT, detail TEXT, created_at TEXT);');
  for (const ensure of [ensureSqliteDataImportSchema, ensureSqliteImportMasterSchema, ensureSqliteImportHistorySchema]) ensure(app.database);
  return { provider: app.provider, counts: () => Object.fromEntries(['data_import_runs', 'import_master_records', 'import_history_records', 'import_history_versions', 'import_master_holds'].map(table => [table,
    app.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n])),
    verify: () => ({ integrity: app.database.prepare('PRAGMA integrity_check').all().every(r => Object.values(r)[0] === 'ok'),
      foreignKeys: app.database.prepare('PRAGMA foreign_key_check').all().length === 0 }),
    async close() { await app.provider.close(); app.database.close(); } };
}
module.exports = { openTradeFotoBlock6Store };
