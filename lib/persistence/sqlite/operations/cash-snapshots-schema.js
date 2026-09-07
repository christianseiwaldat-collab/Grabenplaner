'use strict';
const { CASH_SNAPSHOT_TABLES: TABLES } = require('../../statements/cash-snapshots');
const parents = { Umsatz_Kasse_Details: 'Umsatz_KASSE', KassenJournal_Details: 'KassenJournal' };
const indexFields = { location_key: ['Filialid', 'Filiale', 'FilialId'], seller_key: ['VerkäuferID', 'Verkäuferid'], customer_key: ['KUND_NR'], article_key: ['EAN'] };
const CASH_SNAPSHOTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cash_snapshot_datasets (
  slot INTEGER PRIMARY KEY CHECK(slot>0), id TEXT NOT NULL UNIQUE CHECK(length(id)=64),
  scope_id TEXT NOT NULL, owner_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
  created_at TEXT NOT NULL, payload TEXT NOT NULL
);
${TABLES.map(t => {
  const parent = TABLES.find(p => p.name === parents[t.name]);
  return `CREATE TABLE IF NOT EXISTS ${t.sqlName} (
    dataset_slot INTEGER NOT NULL REFERENCES cash_snapshot_datasets(slot), source_row INTEGER NOT NULL CHECK(source_row>0),
    source_key BLOB NOT NULL CHECK(length(source_key)=32), business_date TEXT, parent_row INTEGER,
    location_key BLOB, seller_key BLOB, customer_key BLOB, article_key BLOB, payload TEXT NOT NULL,
    PRIMARY KEY(dataset_slot,source_row), UNIQUE(dataset_slot,source_key),
    ${parent ? `FOREIGN KEY(dataset_slot,parent_row) REFERENCES ${parent.sqlName}(dataset_slot,source_row), CHECK(parent_row IS NOT NULL)` : 'CHECK(parent_row IS NULL)'}
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS ${t.sqlName}_date ON ${t.sqlName}(dataset_slot,business_date,source_row);
  ${parent ? `CREATE INDEX IF NOT EXISTS ${t.sqlName}_parent ON ${t.sqlName}(dataset_slot,parent_row,source_row);` : ''}
  ${Object.entries(indexFields).filter(([, fields]) => fields.some(f => t.columns.some(c => c.name === f)))
    .map(([index]) => `CREATE INDEX IF NOT EXISTS ${t.sqlName}_${index} ON ${t.sqlName}(dataset_slot,${index},business_date,source_row);`).join('\n')}`;
}).join('\n')}
`;
function ensureSqliteCashSnapshotsSchema(database) {
  if (!database || typeof database.exec !== 'function') throw new TypeError('SQLite operations database required');
  database.exec(CASH_SNAPSHOTS_SCHEMA_SQL);
}
module.exports = { CASH_SNAPSHOTS_SCHEMA_SQL, ensureSqliteCashSnapshotsSchema };
