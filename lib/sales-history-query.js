"use strict";
const C = require('./data-import-contract');
const SOURCES = Object.freeze({ sales: 'Umsatz_Kasse_Details', daily: 'Tagesbericht', journal: 'KassenJournal_Details' });
const MAX_DAYS = 366, ANALYSIS_LIMIT = 5000;
function date(value) { C.normalizeDataImportRow(dateProfile, { date: value }); return value; }
const dateProfile = C.defineDataImportProfile({ id: 'history-date', entity: 'history-date', version: 1, sourceSystem: 'gp.history', sourceTable: 'filter', schemaSha256: '0'.repeat(64),
  keyFields: ['date'], fields: [{ source: 'date', target: 'date', type: 'date', nullable: false }], dataClasses: ['internal_business'] });
function normalizeSalesHistoryQuery(input, { today, projection, customerId = null }) {
  C.exact(input, ['sourceId', 'kind', 'dateFrom', 'dateTo', 'locationId', 'sellerRole', 'sellerId', 'snapshot', 'limit', 'cursor']);
  date(today); const from = date(input.dateFrom || today.slice(0, 4) + '-01-01'), to = date(input.dateTo || today);
  if (from > to || to > today || (Date.parse(to) - Date.parse(from)) / 86400000 >= MAX_DAYS) C.fail('IMPORT_HISTORY_DATE_RANGE');
  const kind = input.kind || 'sales'; if (!Object.hasOwn(SOURCES, kind)) C.fail('IMPORT_HISTORY_KIND');
  if (!projection.read || (kind !== 'sales' && !projection.finance)) C.fail('IMPORT_FORBIDDEN', 403);
  const locationId = input.locationId || '', sellerRole = input.sellerRole || 'line_seller', sellerId = input.sellerId || '';
  if (locationId) C.id(locationId);
  if (locationId === 'unassigned' ? !projection.unassigned : locationId && !projection.company && !projection.locationIds.includes(locationId)) C.fail('IMPORT_FORBIDDEN', 403);
  if (!['line_seller', 'header_seller'].includes(sellerRole)) C.fail('IMPORT_HISTORY_SELLER_ROLE');
  if (sellerId) { C.id(sellerId); if (!projection.sellers || kind !== 'sales') C.fail('IMPORT_FORBIDDEN', 403); }
  if (customerId) { C.id(customerId); if (!projection.customerPurchases || kind !== 'sales') C.fail('IMPORT_FORBIDDEN', 403); }
  const snapshot = input.snapshot || null; if (snapshot) C.sha(snapshot);
  if (kind !== 'sales' && !snapshot) C.fail('IMPORT_HISTORY_SNAPSHOT_REQUIRED');
  const limit = input.limit === undefined ? 50 : Number(input.limit); C.integer(limit, 1, 100);
  const cursor = input.cursor || ''; if (typeof cursor !== 'string' || cursor.length > 1400) C.fail('IMPORT_HISTORY_CURSOR');
  return C.freeze({ sourceId: C.id(input.sourceId), kind, table: SOURCES[kind], dateFrom: from, dateTo: to,
    locationId, sellerRole, sellerId, customerId, snapshot, limit, cursor });
}
function historyBusinessDate(source, table, data, H) {
  const values = H.historySource(source, table, data);
  const value = ['Bondatum', 'Datum', 'Aenderung', 'WEDatum', 'Anlegedatum', 'Bestandsänderungsdatum', 'LDatum'].map(key => values[key]).find(v => v !== undefined && v !== null);
  return typeof value === 'string' ? value.slice(0, 10) : null;
}
module.exports = { SOURCES, MAX_DAYS, ANALYSIS_LIMIT, normalizeSalesHistoryQuery, historyBusinessDate };
