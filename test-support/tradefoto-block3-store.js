"use strict";
// Isolated verification only: never accepts an existing application database.
const fs = require('node:fs');
const path = require('node:path');
const { openSqliteApplicationPersistence } = require('../lib/persistence/sqlite/provider');
const { SQLITE_APPLICATION_CATALOG } = require('../lib/persistence/sqlite/application-catalog');
const { ensureSqliteDataImportRuntimeSchema } = require('../lib/persistence/sqlite/operations/data-import-runtime-schema');
function openTradeFotoBlock3Store(directory) {
  const root = path.resolve(__dirname, '../tmp');
  const resolved = fs.realpathSync(directory);
  if (path.dirname(resolved) !== root || !path.basename(resolved).startsWith('tradefoto-block3-')) throw new Error('TEST_DIRECTORY_INVALID');
  const filename = path.join(resolved, 'isolated-encrypted.db');
  const app = openSqliteApplicationPersistence({ databasePath: filename, catalog: SQLITE_APPLICATION_CATALOG });
  app.database.exec('CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY, actor TEXT, action TEXT, entity_type TEXT, entity_id TEXT, detail TEXT, created_at TEXT);');
  ensureSqliteDataImportRuntimeSchema(app.database);
  const scalar = sql => app.database.prepare(sql).get().n;
  return { provider: app.provider,
    storageFootprint({ compact = false } = {}) {
      app.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      if (compact) app.database.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE)');
      return { databaseBytes: fs.statSync(filename).size, compacted: compact,
        tablesAndIndexes: app.database.prepare('SELECT name,sum(pgsize) bytes FROM dbstat GROUP BY name ORDER BY bytes DESC').all() };
    },
    seedTestTargets(sellers = []) {
      app.database.exec('CREATE TABLE IF NOT EXISTS locations(id TEXT PRIMARY KEY, active INTEGER); CREATE TABLE IF NOT EXISTS employees(personnel_number TEXT PRIMARY KEY, active INTEGER);');
      app.database.prepare('INSERT INTO locations VALUES (?,1)').run('test-branch-18');
      for (const seller of sellers) app.database.prepare('INSERT INTO employees VALUES (?,1)').run('test-seller-' + seller);
    },
    counts: () => Object.fromEntries(['data_import_sources', 'data_import_runs', 'data_import_rows', 'data_import_links', 'data_import_changes',
      'data_import_payload_blocks', 'data_import_row_payload_refs', 'data_import_change_payload_refs',
      'import_master_records', 'import_history_records', 'import_history_versions', 'import_master_holds'].map(table => [table, scalar(`SELECT COUNT(*) AS n FROM ${table}`)])),
    issues: () => app.database.prepare("SELECT r.profile_hash AS profileHash, d.state, d.issue, COUNT(*) AS count FROM data_import_rows d JOIN data_import_runs r ON r.id=d.run_id WHERE d.state IN ('conflict','invalid') GROUP BY r.profile_hash,d.state,d.issue").all(),
    verify: () => ({ integrity: app.database.prepare('PRAGMA integrity_check').all().every(row => Object.values(row)[0] === 'ok'),
      foreignKeys: app.database.prepare('PRAGMA foreign_key_check').all().length === 0 }),
    async close() { await app.provider.close(); app.database.close(); },
  };
}
module.exports = { openTradeFotoBlock3Store };
