'use strict';
const C = require('./data-import-contract');
const MathModel = require('./sales-report-model');
const { buildSalesHistoryProjection } = require('./sales-history-access');
const { buildSalesAnalyticsProjection } = require('./sales-analytics-access');
const { buildSalesArticleCatalogProjection } = require('./sales-article-catalog-access');
const COLUMNS = Object.freeze({ date: 'Datum', locationId: 'Filial-ID', personnel: 'Personalnummer', articleNumber: 'Artikelnummer',
  quantity: 'Anzahl', description: 'Artikelbezeichnung', customerNumber: 'Kundennummer', customerName: 'Kunde',
  listSourcePrice: 'Soll-VK (Quellwert)', listGross: 'Soll-VK brutto', listMargin: 'Soll-RE netto / Stück', listMarginPercent: 'Soll-RE %',
  actualGross: 'Tatsächlicher VK brutto / Stück', actualMargin: 'Tatsächlicher RE netto / Stück', actualMarginPercent: 'Tatsächlicher RE %',
  deviceNumber: 'Gerätenummer', receipt: 'Belegnummer', status: 'Prüfung' });
const MONEY_COLUMNS = new Set(['quantity','listSourcePrice','listGross','listMargin','listMarginPercent','actualGross','actualMargin','actualMarginPercent']);
function capabilities(session) {
  const history = buildSalesHistoryProjection(session), catalog = buildSalesArticleCatalogProjection(session), analytics = buildSalesAnalyticsProjection(session);
  return { sales: history.read && catalog.read, sellers: history.read && catalog.read && history.sellers,
    customers: history.read && catalog.read && history.customerPurchases, margin: history.read && catalog.read && catalog.costsRead && analytics.grossMargin };
}
function availableColumns(grants) {
  return Object.keys(COLUMNS).filter(k => (k !== 'personnel' || grants.sellers)
    && (!['customerNumber','customerName'].includes(k) || grants.customers)
    && (!['listMargin','listMarginPercent','actualMargin','actualMarginPercent'].includes(k) || grants.margin));
}
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) C.fail('IMPORT_HISTORY_DATE_RANGE');
  return value;
}
function query(input, { today, grants }) {
  C.exact(input, ['articleNumber','dateFrom','dateTo','locationId','personnel','sort','direction','limit','cursor','resultSet']);
  if (!grants.sales) C.fail('IMPORT_FORBIDDEN',403);
  // Identifiers remain strings: 00042 and 42 are different source articles.
  if (typeof input.articleNumber !== 'string' || !input.articleNumber.trim() || input.articleNumber.length > 160 || /[\u0000-\u001f\u007f]/.test(input.articleNumber)) C.fail('IMPORT_ARTICLE_SALES_QUERY');
  const dateFrom = date(input.dateFrom || '1900-01-01'), dateTo = date(input.dateTo || today);
  if (dateFrom > dateTo || dateTo > today || dateFrom < '1900-01-01') C.fail('IMPORT_HISTORY_DATE_RANGE');
  const sort = input.sort || 'date', direction = input.direction || 'desc';
  if (!availableColumns(grants).includes(sort)) C.fail(Object.hasOwn(COLUMNS,sort) ? 'IMPORT_FORBIDDEN' : 'IMPORT_ARTICLE_SALES_QUERY',Object.hasOwn(COLUMNS,sort) ? 403 : 400);
  if (!['asc','desc'].includes(direction)) C.fail('IMPORT_ARTICLE_SALES_QUERY');
  const locationId = input.locationId || ''; if (locationId) C.id(locationId);
  const personnel = input.personnel === undefined ? '' : input.personnel;
  if (typeof personnel !== 'string' || personnel.length > 160 || /[\u0000-\u001f\u007f]/.test(personnel)) C.fail('IMPORT_ARTICLE_SALES_QUERY');
  if (personnel.trim() && !grants.sellers) C.fail('IMPORT_FORBIDDEN',403);
  for (const key of ['cursor','resultSet']) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 3000)) C.fail('IMPORT_HISTORY_CURSOR');
  return { articleNumber: input.articleNumber.trim(),dateFrom,dateTo,locationId,personnel: personnel.trim(),sort,direction,
    limit: input.limit === undefined ? 50 : C.integer(input.limit,1,100),cursor: input.cursor || '',resultSet: input.resultSet || '' };
}
const SCALE = 324, UNIT = 10n ** 324n;
function precise(value) { return MathModel.scaled(value,SCALE); }
function metrics(fields, checked, policy, marginPolicy, marginAllowed, listPricePolicy = null) {
  const result = { listSourcePrice: fields.Sollpreis ?? null, listGross: null, listMargin: null, listMarginPercent: null,
    actualGross: null, actualMargin: null, actualMarginPercent: null, listBasis: 'unconfirmed', actualBasis: 'unconfirmed' };
  if (!marginAllowed) for (const key of ['listMargin','listMarginPercent','actualMargin','actualMarginPercent']) delete result[key];
  if (!checked || !['sale','return'].includes(checked.status) || policy?.priceMeaning !== 'final_unit' || !Object.hasOwn(policy.vatRates || {},String(fields.MWST))) return result;
  const price = precise(fields.VK_Preis), rate = precise(policy.vatRates[fields.MWST]);
  if (price === null || rate === null || price < 0n || rate < 0n) return result;
  const tax = 100n * UNIT, net = policy.priceBasis === 'gross' ? MathModel.divide(price * tax,tax + rate) : price;
  const gross = policy.priceBasis === 'gross' ? price : MathModel.divide(price * (tax + rate),tax);
  result.actualGross = MathModel.decimal(MathModel.divide(gross,10n ** 322n)); result.actualBasis = 'confirmed_final_unit';
  let margin = null;
  if (marginAllowed && marginPolicy?.field === 'RohertragDM' && marginPolicy?.meaning === 'unit') {
    margin = precise(fields.RohertragDM);
    if (margin !== null) {
      result.actualMargin = MathModel.decimal(MathModel.divide(margin,10n ** 322n));
      if (net > 0n) result.actualMarginPercent = MathModel.decimal(MathModel.divide(margin * 10000n,net));
    }
  }
  // A VK policy does not prove Sollpreis's meaning. Only evidence-backed trusted
  // composition can activate the separate historical list-price calculation.
  if (listPricePolicy?.field === 'Sollpreis' && listPricePolicy?.meaning === 'unit' && listPricePolicy?.basis === 'gross' && listPricePolicy?.evidenceSha256) {
    const list = precise(fields.Sollpreis);
    if (list !== null && list >= 0n) {
      result.listBasis = 'confirmed_unit_gross'; result.listGross = MathModel.decimal(MathModel.divide(list,10n ** 322n));
      if (margin !== null) {
        const listNet = MathModel.divide(list * tax,tax + rate), cost = net - margin, planned = listNet - cost;
        result.listMargin = MathModel.decimal(MathModel.divide(planned,10n ** 322n));
        if (listNet > 0n) result.listMarginPercent = MathModel.decimal(MathModel.divide(planned * 10000n,listNet));
      }
    }
  }
  if (!marginAllowed) for (const key of ['listMargin','listMarginPercent','actualMargin','actualMarginPercent']) delete result[key];
  return result;
}
const collator = new Intl.Collator('de-AT',{numeric:true});
function compare(a,b,key,direction) {
  // The Filial-ID column displays Trade's source ID; GP UUIDs carry scope only.
  const left = key === 'locationId' ? a.sourceLocationId : a[key], right = key === 'locationId' ? b.sourceLocationId : b[key], absent = v => v === null || v === undefined || v === '';
  if (absent(left) !== absent(right)) return absent(left) ? 1 : -1;
  let value;
  if (MONEY_COLUMNS.has(key) && !absent(left) && !absent(right)) { const l = precise(String(left)), r = precise(String(right)); value = l !== null && r !== null ? l < r ? -1 : l > r ? 1 : 0 : collator.compare(String(left),String(right)); }
  else value = collator.compare(String(left ?? ''),String(right ?? ''));
  return value * (direction === 'asc' ? 1 : -1) || b.date.localeCompare(a.date) || a.id.localeCompare(b.id);
}
module.exports = { COLUMNS,MONEY_COLUMNS,capabilities,availableColumns,query,metrics,compare };
