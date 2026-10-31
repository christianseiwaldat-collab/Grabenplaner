'use strict';
const { CASH_SNAPSHOT_TABLES } = require('../statements/cash-snapshots');
const head = CASH_SNAPSHOT_TABLES.find(t => t.name === 'Umsatz_KASSE');
const { sourceSearch } = require('../statements/branch-receipt');
const rowSql = require('./cash-snapshots-catalog').SQLITE_CASH_SNAPSHOTS_CATALOG.find(e => e.statement === head.statements.row).sql;
const BRANCH_RECEIPT_CATALOG = Object.freeze([{ statement: sourceSearch, returning: false,
  sql: rowSql.slice(0, rowSql.indexOf(' WHERE ')) + ` WHERE dataset_slot=$datasetSlot AND location_key IS $locationKey
    AND business_date >= $dateFrom AND business_date <= $dateTo
    AND (business_date<$afterDate OR (business_date=$afterDate AND source_row<$afterRow))
    ORDER BY business_date DESC,source_row DESC LIMIT $limit` }]);
module.exports = { sourceSearch, BRANCH_RECEIPT_CATALOG };
