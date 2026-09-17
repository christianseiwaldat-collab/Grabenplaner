'use strict';
const D = require('./tradefoto-bestell/decimal');
const { articleCalculation, decimal } = require('./branch-article-basis');
const PURCHASE_COLUMNS = [
  ['list_purchase', 'Listenpreis', 'Listeneckpreis', 'ListeneckpreisZu'],
  ['invoice_purchase', 'Re.-Preis', 'Rechnungspreis', 'RechnungspreisZu'],
  ['net_net_purchase', 'NN-Preis', 'NNPreis', 'NNPreisZu'],
  ['special', 'Kalk.-EK', 'SonderPreis', 'SonderPreisZu'],
  ['average_purchase', 'Ø EK', 'DurchschnittEK'],
  ['dek_a', 'Ø EK-A', 'DEK_A'],
  ['sellout', 'S-Out-B', 'S_Out'],
  ['order_purchase', 'Bestell-EK', 'EKBestell'],
];
const SALES_COLUMNS = [
  ['upe', 'UVP', 'UPE', null, 'LUVPDatum', 'LUVPAe'],
  ['future_upe', 'Zuk. UVP', 'ZukunftsUVP', null, 'ZukunftsUVPab', 'LZUVPAe'],
  ['sales', 'EH', 'Verkaufspreis', 'eNvk', 'LVKDatum', 'LVKAe'],
  ['wholesale', 'GH', 'Großhandelspreis', 'GNVK', 'LGHDatum', 'LGHAe'],
  ['internet_1', 'Internet', 'Internet_VK', 'Invk', 'LInternetDatum', 'LInternetAe'],
  ['internet_2', 'Internet 2', 'InternetVK2', 'InternetVKN2', 'LInternet2Datum', 'LInternet2Ae'],
  ['internet_3', 'Internet 3', 'InternetVK3', 'InternetVKN3', 'LInternet3Datum', 'LInternet3Ae'],
  ['internet_4', 'Internet 4', 'InternetVK4', 'InternetVKN4', 'LInternet4Datum', 'LInternet4Ae'],
  ['internet_5', 'Internet 5', 'InternetVK5', 'InternetVKN5', 'LInternet5Datum', 'LInternet5Ae'],
];
const AUX_FIELDS = ['ListeneckVom','ZKGueltigab','WKZ','WKZArt','DEK_AAB','S_Out','S_Oab',
  ...SALES_COLUMNS.flatMap(c => c.slice(4))];
function value(amount, options = {}) {
  return decimal(amount) === null ? null : { amount, currency: 'EUR', ...options };
}
function buildSalesArticlePriceMatrix(article, source, projection) {
  const trade = article.currentSourceSystem
    ? article.currentSourceSystem === 'tradefoto.artikel_stamm' : article.sourceSystem === 'tradefoto.artikel_stamm';
  const prices = article.prices || [];
  function price(field, type, basis, raw = false) {
    const sourcePrices = prices.filter(p => p.sourceField === field && p.currency === 'EUR');
    let found = trade ? sourcePrices : prices.filter(p => p.priceType === type && p.priceBasis === basis
      && p.currency === 'EUR' && ['confirmed','inferred'].includes(p.qualityStatus));
    if (!found.length) found = sourcePrices;
    if (!found.length) found = prices.filter(p => p.priceType === type && p.priceBasis === basis && p.currency === 'EUR');
    if (found.length !== 1) return null;
    const p = found[0], usable = ['confirmed', 'inferred'].includes(p.qualityStatus);
    if (!usable && !(raw && p.qualityStatus === 'unresolved')) return null;
    return value(p.amount, { sourceValue: !usable, note: !usable ? 'Importierter Quellwert; Preisbasis noch nicht bestätigt.' : null });
  }
  const calculation = articleCalculation(trade ? article : {...article,sourceSystem:article.currentSourceSystem || article.sourceSystem}, trade ? source : null);
  if (!trade && calculation.purchaseNet === null && article.sourceSystem === 'tradefoto.artikel_stamm') {
    // An unchanged imported cost can remain in a manual revision; use that
    // revision's value, never a newer unrelated source-master cost.
    calculation.purchaseNet = articleCalculation(article).purchaseNet;
  }
  const vatPercent = trade ? calculation.vatPercent : articleCalculation(article, source).vatPercent;
  const factor = vatPercent === null ? null : D.add('1', D.divide(String(vatPercent), '100', 4));
  const sales = projection.pricesRead ? SALES_COLUMNS.map(([type, label, grossField, netField, dateField, personField]) => {
    const gross = price(grossField, type, 'gross');
    let net = netField ? price(netField, type, 'net') : null;
    if (!net && gross && factor && !gross.sourceValue) net = value(D.divide(gross.amount, factor, 12), { calculated: true });
    const purchaseNet = projection.costsRead ? calculation.purchaseNet : null;
    const margin = net && purchaseNet !== null ? D.subtract(net.amount, purchaseNet) : null;
    const uvp = price('UPE', 'upe', 'gross');
    return { id: type, label, gross, net,
      margin: margin === null ? null : value(margin),
      marginPercent: margin === null || D.compare(net.amount, '0') === 0 ? null : D.multiply(D.divide(margin, net.amount, 8), '100'),
      // DEK_A's source meaning is not a confirmed net-cost calculation basis.
      marginAPercent: null, marginA: null,
      discountPercent: !gross || !uvp || D.compare(uvp.amount, '0') <= 0 ? null
        : D.multiply(D.divide(D.subtract(uvp.amount, gross.amount), uvp.amount, 8), '100'),
      date: trade ? source?.[dateField] || null : null,
      person: trade ? source?.[personField] ?? null : null };
  }) : null;
  const purchase = projection.costsRead ? PURCHASE_COLUMNS.map(([type, label, field, futureField]) => ({
    id: type, label,
    current: field === 'S_Out' ? (trade ? value(source?.S_Out, { sourceValue: true, unit:'number', note:'Importierter S-Out-B-Wert.' }) : null)
      : field === 'DurchschnittEK' && calculation.purchaseNet !== null ? value(calculation.purchaseNet)
        : price(field, type, 'net', true),
    future: futureField ? price(futureField, 'future_purchase', 'net', true) : null,
  })) : null;
  return { sales, purchase, vatPercent, costsRead: projection.costsRead === true,
    purchaseDate: projection.costsRead && trade ? source?.ListeneckVom || null : null,
    futurePurchaseDate: projection.costsRead && trade ? source?.ZKGueltigab || null : null,
    wkz: projection.costsRead && trade ? source?.WKZ ?? null : null,
    wkzType: projection.costsRead && trade ? source?.WKZArt ?? null : null };
}
module.exports = { buildSalesArticlePriceMatrix, AUX_FIELDS };
