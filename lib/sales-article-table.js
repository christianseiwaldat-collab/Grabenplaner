'use strict';
const PRICE_SEARCH_FIELDS = Object.freeze([
  { id: 'retailGross', column: 'retail_gross', label: 'VK brutto EH', type: 'sales', basis: 'gross', permission: 'pricesRead' },
  { id: 'internetGross', column: 'internet_gross', label: 'Preis Internet brutto', type: 'internet_1', basis: 'gross', permission: 'pricesRead' },
  { id: 'retailNet', column: 'retail_net', label: 'VK netto EH', type: 'sales', basis: 'net', permission: 'pricesRead' },
  { id: 'internetNet', column: 'internet_net', label: 'Preis Internet netto', type: 'internet_1', basis: 'net', permission: 'pricesRead' },
  { id: 'purchaseNet', column: 'purchase_net', label: 'Ø EK netto', type: 'average_purchase', basis: 'net', permission: 'costsRead' },
  { id: 'purchaseGross', column: 'purchase_gross', label: 'Ø EK brutto', type: 'average_purchase', basis: 'gross', permission: 'costsRead' },
]);
const ARTICLE_TABLE_COLUMNS = Object.freeze([
  { id: 'articleNumber', label: 'Artikelnummer' }, { id: 'description', label: 'Bezeichnung' },
  ...PRICE_SEARCH_FIELDS.map(({ id, label, permission }) => ({ id, label, permission })),
  { id: 'primaryIdentifier', label: 'EAN / GTIN' }, { id: 'status', label: 'Status' }, { id: 'sourceSystem', label: 'Quellsystem' },
]);
const DEFAULT_COLUMNS = ['articleNumber', 'description', 'retailGross', 'internetGross', 'primaryIdentifier', 'status'];
const PREFERENCE_KEY = 'sales_article_table_v1';
function articleTablePreferences(input, projection) {
  const available = ARTICLE_TABLE_COLUMNS.filter(c => !c.permission || projection[c.permission]).map(c => c.id);
  const columns = Array.isArray(input?.columns) ? [...new Set(input.columns.filter(c => available.includes(c)))] : DEFAULT_COLUMNS.filter(c => available.includes(c));
  if (!columns.includes('articleNumber')) columns.unshift('articleNumber');
  const sort = columns.includes(input?.sort) ? input.sort : 'articleNumber';
  return { columns, visibleRows: Math.min(20, Math.max(5, Math.round(Number(input?.visibleRows) || 10))), sort, direction: input?.direction === 'desc' ? 'desc' : 'asc' };
}
module.exports = { PRICE_SEARCH_FIELDS, ARTICLE_TABLE_COLUMNS, PREFERENCE_KEY, articleTablePreferences };
