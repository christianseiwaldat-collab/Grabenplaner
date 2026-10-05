'use strict';
const { CASH_LOCATION_READS: R } = require('../statements/cash-location-reads');
const { CASH_SNAPSHOT_TABLES: TABLES } = require('../statements/cash-snapshots');
const { CASH_PUBLICATION_STATEMENTS: S } = require('../statements/cash-publications');
const { SQLITE_CASH_SNAPSHOTS_CATALOG } = require('./cash-snapshots-catalog');
const { SQLITE_CASH_PUBLICATIONS_CATALOG } = require('./cash-publications-catalog');
const entry = (statement, sql) => Object.freeze({ statement, sql, returning: false });
const sql = statement => [...SQLITE_CASH_SNAPSHOTS_CATALOG, ...SQLITE_CASH_PUBLICATIONS_CATALOG].find(e => e.statement === statement).sql;
const CATALOG = Object.freeze([
  ...TABLES.map((table, index) => entry(R.nullRows[index], sql(table.statements.page).replace('WHERE ', 'WHERE location_key IS NULL AND '))),
  ...Object.entries(S.search).flatMap(([name, statement]) => [
    entry(R.nullSearch[name], sql(statement).replace('(\u0028$unassigned=1 AND l.target_id IS NULL) OR ($unassigned=0 AND l.target_id=$locationId))', 'r.location_key IS NULL')),
    entry(R.nonNullSearch[name], sql(statement).replace('WHERE r.dataset_slot=', 'WHERE r.location_key IS NOT NULL AND r.dataset_slot=')),
  ]),
]);
module.exports = { CATALOG };
