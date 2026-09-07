'use strict';
const C = require('./data-import-contract');
const Search = require('./flexible-search');
const KINDS = Object.freeze({ receipts: 'Umsatz_KASSE', daily: 'Tagesbericht', journal: 'KassenJournal_Details' });
const COLUMNS = Object.freeze({ date: 'Datum', receipt: 'Belegnummer', invoice: 'Rechnungsreferenz', location: 'Filiale', personnel: 'Personalnummer',
  register: 'Kasse', description: 'Bezeichnung', positions: 'Positionen', gross: 'Brutto / Quellbetrag', state: 'Prüfung', account: 'Konto', inflow: 'Einzahlung', outflow: 'Auszahlung',
  customerNumber: 'Kundennummer', customerAccount: 'Kunden-Kontonummer', customerSourceAccount: 'TradeFoto-KontoNr', customerName: 'Kunde', customerAddress: 'Kundenadresse', customerPhone: 'Kundentelefon', customerEmail: 'Kunden-E-Mail' });
const CUSTOMER_COLUMNS = Object.freeze(['customerNumber', 'customerAccount', 'customerSourceAccount', 'customerName', 'customerAddress', 'customerPhone', 'customerEmail']);
const DEFAULT_COLUMNS = Object.freeze(['date', 'receipt', 'location', 'personnel', 'description', 'gross', 'state']);
const FINANCE_COLUMNS = Object.freeze(['date', 'receipt', 'location', 'description', 'account', 'inflow', 'outflow']);
const PREFERENCE_KEY = 'sales_receipt_columns_v1';
function preferences(input) {
  C.exact(input, ['columns', 'kind']);
  const kind = input.kind || 'receipts';
  if (typeof kind !== 'string' || !Object.hasOwn(KINDS, kind)) C.fail('IMPORT_HISTORY_KIND');
  if (!Array.isArray(input.columns) || !input.columns.length || input.columns.some(k => typeof k !== 'string' || !Object.hasOwn(COLUMNS, k)) || new Set(input.columns).size !== input.columns.length) C.fail('IMPORT_RECEIPT_COLUMNS');
  return { kind, columns: [...input.columns] };
}
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) C.fail('IMPORT_HISTORY_DATE_RANGE');
  return value;
}
function query(input, { today, projection }) {
  C.exact(input, ['sourceId', 'kind', 'dateFrom', 'dateTo', 'locationId', 'query', 'receipt', 'seller', 'sellerRole', 'customer', 'sort', 'direction', 'resultSet', 'cursor', 'limit']);
  const kind = input.kind || 'receipts';
  if (typeof kind !== 'string' || !Object.hasOwn(KINDS, kind)) C.fail('IMPORT_HISTORY_KIND');
  if (!projection.read || (kind !== 'receipts' && !projection.finance) || (input.seller && !projection.sellers)
    || (input.customer && !projection.customerPurchases)) C.fail('IMPORT_FORBIDDEN', 403);
  const dateFrom = date(input.dateFrom), dateTo = date(input.dateTo);
  if (dateFrom > dateTo || dateTo > today || dateFrom < '1900-01-01') C.fail('IMPORT_HISTORY_DATE_RANGE');
  const normalized = { sourceId: C.id(input.sourceId), kind, dateFrom, dateTo, locationId: input.locationId || '', sellerRole: input.sellerRole || 'header_seller' };
  if (!['header_seller', 'line_seller'].includes(normalized.sellerRole)) C.fail('IMPORT_HISTORY_SELLER_ROLE');
  if (normalized.locationId) C.id(normalized.locationId);
  for (const key of ['query', 'receipt', 'seller', 'customer']) {
    const value = input[key] ?? '';
    if (typeof value !== 'string' || value.length > (['query', 'customer'].includes(key) ? 160 : 80) || /[\u0000-\u001f\u007f]/.test(value)) C.fail('IMPORT_RECEIPT_QUERY');
    try { Search.terms(value); } catch { C.fail('IMPORT_RECEIPT_QUERY'); }
    normalized[key] = value.trim();
  }
  if (kind !== 'receipts' && (normalized.seller || normalized.customer)) C.fail('IMPORT_RECEIPT_QUERY');
  normalized.sort = input.sort || 'date'; normalized.direction = input.direction || 'desc';
  if (typeof normalized.sort !== 'string' || !Object.hasOwn(COLUMNS, normalized.sort) || !['asc', 'desc'].includes(normalized.direction)) C.fail('IMPORT_RECEIPT_SORT');
  if ((normalized.sort === 'personnel' && !projection.sellers) || (CUSTOMER_COLUMNS.includes(normalized.sort) && !projection.customerPurchases)) C.fail('IMPORT_FORBIDDEN', 403);
  if (kind !== 'receipts' ? ['personnel', 'positions', 'gross', 'state', ...CUSTOMER_COLUMNS].includes(normalized.sort) : ['account', 'inflow', 'outflow'].includes(normalized.sort)) C.fail('IMPORT_RECEIPT_SORT');
  normalized.resultSet = input.resultSet || '';
  if (typeof normalized.resultSet !== 'string' || normalized.resultSet.length > 2000) C.fail('IMPORT_HISTORY_CURSOR');
  normalized.limit = input.limit === undefined ? 50 : C.integer(input.limit, 1, 100);
  normalized.cursor = input.cursor || '';
  if (typeof normalized.cursor !== 'string' || normalized.cursor.length > 2000) C.fail('IMPORT_HISTORY_CURSOR');
  return normalized;
}
function decimalCompare(a, b) {
  const parse = value => {
    const match = String(value ?? '0').match(/^(-?)(\d+)(?:\.(\d+))?$/);
    if (!match) C.fail('IMPORT_HISTORY_INTEGRITY');
    return { negative: match[1], whole: match[2], fraction: match[3] || '' };
  };
  const left = parse(a), right = parse(b), scale = Math.max(left.fraction.length, right.fraction.length);
  const integer = v => BigInt(v.negative + v.whole + v.fraction.padEnd(scale, '0'));
  const l = integer(left), r = integer(right);
  return l < r ? -1 : l > r ? 1 : 0;
}
function compareRows(a, b, key, direction) {
  const value = r => key === 'gross' ? r.gross ?? r.sourceAmount : r[key];
  const l = value(a), r = value(b);
  const missing = v => v === undefined || v === null || v === '';
  if (missing(l) !== missing(r)) return missing(l) ? 1 : -1;
  const compared = ['gross', 'inflow', 'outflow', 'positions'].includes(key) ? decimalCompare(l || 0, r || 0)
    : String(l ?? '').localeCompare(String(r ?? ''), 'de-AT', { numeric: true });
  return compared * (direction === 'asc' ? 1 : -1) || a.id.localeCompare(b.id);
}
module.exports = { KINDS, COLUMNS, CUSTOMER_COLUMNS, DEFAULT_COLUMNS, FINANCE_COLUMNS, PREFERENCE_KEY, preferences, query, compareRows };
