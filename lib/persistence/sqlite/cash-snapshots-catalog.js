'use strict';
const { CASH_SNAPSHOT_STATEMENTS: S, CASH_SNAPSHOT_COLUMNS: C, CASH_SNAPSHOT_TABLES: TABLES } = require('../statements/cash-snapshots');
const snake = key => key.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
const select = columns => Object.keys(columns).map(k => `${snake(k)} AS "${k}"`).join(', ');
const insert = (table, columns) => `INSERT INTO ${table} (${Object.keys(columns).map(snake).join(', ')}) VALUES (${Object.keys(columns).map(k => '$' + k).join(', ')})`;
const entry = (statement, sql) => Object.freeze({ statement, sql, returning: false });
const SQLITE_CASH_SNAPSHOTS_CATALOG = Object.freeze([
  entry(S.nextSlot, 'SELECT COALESCE(MAX(slot),0)+1 AS slot FROM cash_snapshot_datasets'),
  entry(S.get, `SELECT ${select(C.DATASET)} FROM cash_snapshot_datasets WHERE id=$id AND scope_id=$scopeId AND owner_id=$ownerId`),
  entry(S.inventory, 'SELECT table_index AS "tableIndex",row_count AS "rowCount",generation FROM cash_snapshot_inventory WHERE dataset_slot=$datasetSlot ORDER BY table_index'),
  entry(S.insert, insert('cash_snapshot_datasets', C.DATASET)),
  entry(S.update, 'UPDATE cash_snapshot_datasets SET revision=revision+1,payload=$payload WHERE slot=$slot AND revision=$revision'),
  ...TABLES.flatMap(t => [
    entry(t.statements.insert, insert(t.sqlName, C.ROW)),
    entry(t.statements.row, `SELECT ${select(C.ROW)} FROM ${t.sqlName} WHERE dataset_slot=$datasetSlot AND source_row=$sourceRow`),
    entry(t.statements.key, `SELECT ${select(C.ROW)} FROM ${t.sqlName} WHERE dataset_slot=$datasetSlot AND source_key=$sourceKey`),
    entry(t.statements.page, `SELECT ${select(C.ROW)} FROM ${t.sqlName} WHERE dataset_slot=$datasetSlot AND source_row>$after ORDER BY source_row LIMIT $limit`),
    entry(t.statements.count, `SELECT COUNT(*) AS count FROM ${t.sqlName} WHERE dataset_slot=$datasetSlot`),
    // Without statistics SQLite can prefer scanning the dataset primary key for
    // this ORDER BY/LIMIT. Receipt reads must use the existing parent index.
    entry(t.statements.children, `SELECT ${select(C.ROW)} FROM ${t.sqlName}${['Umsatz_Kasse_Details', 'KassenJournal_Details'].includes(t.name) ? ` INDEXED BY ${t.sqlName}_parent` : ''} WHERE dataset_slot=$datasetSlot AND parent_row=$parentRow ORDER BY source_row LIMIT $limit`),
  ]),
]);
module.exports = { SQLITE_CASH_SNAPSHOTS_CATALOG };
