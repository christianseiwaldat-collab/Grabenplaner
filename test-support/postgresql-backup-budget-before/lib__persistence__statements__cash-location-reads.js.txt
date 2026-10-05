'use strict';
const { definePersistenceStatement } = require('../contract');
const { CASH_SNAPSHOT_TABLES: TABLES } = require('./cash-snapshots');
const { CASH_PUBLICATION_STATEMENTS: S } = require('./cash-publications');
const define = (id, parameters, columns) => definePersistenceStatement({ id: 'cash-location-reads.' + id.toLowerCase().replaceAll('_', '-'), operation: 'queryAll', parameters, columns });
// Older sealed snapshots index both a missing location and the real branch 0
// as NULL. Read and authenticate those candidates; never rewrite sealed rows.
const CASH_LOCATION_READS = Object.freeze({
  nullRows: Object.freeze(TABLES.map((table, index) => define('null-rows.' + index, table.statements.page.parameters, table.statements.page.columns))),
  nullSearch: Object.freeze(Object.fromEntries(Object.entries(S.search).map(([name, statement]) => [name,
    define('null-search.' + name, Object.fromEntries(Object.entries(statement.parameters).filter(([key]) => !['locationId', 'unassigned'].includes(key))), statement.columns)]))),
  nonNullSearch: Object.freeze(Object.fromEntries(Object.entries(S.search).map(([name, statement]) => [name,
    define('non-null-search.' + name, statement.parameters, statement.columns)]))),
});
module.exports = { CASH_LOCATION_READS };
