'use strict';
const CASH_PUBLICATIONS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cash_publication_state (scope_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0),payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cash_publications (
 id TEXT PRIMARY KEY CHECK(length(id)=64),scope_id TEXT NOT NULL,dataset_id TEXT NOT NULL REFERENCES cash_snapshot_datasets(id),
 owner_id TEXT NOT NULL,created_at TEXT NOT NULL,payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cash_publication_bindings (
 publication_id TEXT NOT NULL REFERENCES cash_publications(id),kind TEXT NOT NULL,source_key BLOB NOT NULL CHECK(length(source_key)=32),
 target_id TEXT NOT NULL,historical INTEGER NOT NULL CHECK(historical IN (0,1)),payload TEXT NOT NULL,
 PRIMARY KEY(publication_id,kind,source_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS cash_publication_binding_target ON cash_publication_bindings(publication_id,kind,target_id,source_key);
`;
function ensureSqliteCashPublicationsSchema(database) { database.exec(CASH_PUBLICATIONS_SCHEMA_SQL); }
module.exports = { CASH_PUBLICATIONS_SCHEMA_SQL, ensureSqliteCashPublicationsSchema };
