'use strict';
const { definePersistenceStatement } = require('./persistence/contract');
const { CASH_SNAPSHOT_TABLES } = require('./persistence/statements/cash-snapshots');
const nullableDate = Object.freeze({ kind: 'date', nullable: true });
const statement = definePersistenceStatement({ id: 'sales-report.receipt-issue-candidates', operation: 'queryAll',
  parameters: { datasetSlot: 'safe_integer', dateFrom: 'date', dateTo: 'date', afterDate: nullableDate,
    afterRow: 'safe_integer', limit: 'safe_integer' },
  columns: { sourceRow: 'safe_integer', businessDate: nullableDate } });
const head = CASH_SNAPSHOT_TABLES.find(t => t.name === 'Umsatz_KASSE').sqlName;
const line = CASH_SNAPSHOT_TABLES.find(t => t.name === 'Umsatz_Kasse_Details').sqlName;
const CATALOG = Object.freeze([Object.freeze({ statement, returning: false,
  sql: `SELECT h.source_row AS "sourceRow",h.business_date AS "businessDate" FROM ${head} h
    WHERE h.dataset_slot=$datasetSlot
    AND ((h.business_date >= $dateFrom AND h.business_date <= $dateTo) OR h.business_date IS NULL)
    AND (h.business_date IS NULL OR NOT EXISTS (
      SELECT 1 FROM ${line} d WHERE d.dataset_slot=h.dataset_slot AND d.parent_row=h.source_row))
    AND (($afterDate IS NOT NULL AND (h.business_date<$afterDate OR h.business_date IS NULL))
      OR (h.business_date IS $afterDate AND h.source_row<$afterRow))
    ORDER BY h.business_date DESC,h.source_row DESC LIMIT $limit` })]);
let compiled;
function postgresql() {
  return compiled ||= Object.freeze(CATALOG.map(entry => Object.freeze(
    require('./persistence/postgresql/sales/catalog').compileSalesEntry(entry, 8).providerEntry)));
}
module.exports = { statement, CATALOG, postgresql };
