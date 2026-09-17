'use strict';
const { loadManagedDataImportProtection } = require('./data-import-managed-protection');
const { createSalesMasterReader } = require('./persistence/repositories/sales-master-data');
const { buildSalesArticlePriceMatrix, AUX_FIELDS } = require('./sales-article-price-matrix');
const { articleCalculation } = require('./branch-article-basis');
const { productLinks } = require('./branch-article-detail');
const GROUPS = [
  { id: 'master', title: 'TradeFoto-Stammdaten', fields: [['Marke','Marke'],['Sortiment','WGR / Sortiment'],['Sortimentsart','Sortimentsart'],['Einheit','Einheit'],['MWST','MwSt-Kennzeichen'],['Artikelbezeichnung3','Weitere Bezeichnung'],['ArtikelBezInternet','Internetbezeichnung'],['Erklärung','Erklärung']] },
  { id: 'supplier', title: 'Lieferant & Bestellung', fields: [['Suchname','Lieferant'],['Kondition','Kondition'],['Bestellnummer','Bestellnummer'],['Bestelleinheit','Bestelleinheit'],['GWertmenge','Wertmenge'],['AZweitLief','Zweitlieferanten'],['Bestelldaten','Bestelldaten'],['LBemerkung','Lieferantenbemerkung']] },
  { id: 'stock', title: 'Bestand laut Import', fields: [['Filialbestand','Filialbestand'],['AgBestand','AgBestand (Quellwert)'],['Bestellt','Bestellt'],['Reserviert','Reserviert'],['Gerichtet','Gerichtet'],['Mindestbestand','Mindestbestand'],['Lager Sollmenge','Lager-Sollmenge'],['BDatenVom','Bestandsdaten vom']] },
  { id: 'flags', title: 'Kennzeichen', fields: [['Abverkauf','Abverkauf'],['Auslaufartikel','Auslaufartikel'],['Sonderbestellung','Sonderbestellung'],['Set','Set'],['Kommission','Kommission'],['OhneBestand','Ohne Bestand'],['Gerät','Gerät'],['Sachkonto','Sachkonto'],['Internet','Internet'],['IAngebot','Internetangebot'],['Gelegenheit','Gelegenheit'],['VKKosten','VK-Kosten']] },
  { id: 'description', title: 'Beschreibung & Lieferumfang', fields: [['AKurzbeschreibung','Kurzbeschreibung'],['ALieferumfang','Lieferumfang'],['ShopText','Shoptext'],['Meldungstext','Hinweis']] },
  { id: 'links', title: 'Produktlinks', fields: [['HerstellerLink','Produktlink']] },
];
function projectSalesArticleSourceField(key, label, raw) {
  const value = raw === true ? 'Ja' : raw === false ? 'Nein' : String(raw);
  if (key === 'HerstellerLink') {
    try {
      const url = new URL(value.trim());
      if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
        return { label: /(^|\.)geizhals\.(at|de|eu)$/i.test(url.hostname) ? 'Geizhals' : label, value: url.href, href: url.href };
      }
    } catch {}
  }
  return { label, value };
}
async function loadSalesArticleDetailData({ access, vault, article, projection, scopeId = 'grabenplaner-main' }) {
  const empty = () => ({ sourceSections: [], branchStock: { rows: [], sourceAt: null },
    priceMatrix: buildSalesArticlePriceMatrix(article, null, projection) });
  if (!projection.read || !String(article.sourceSystem).startsWith('tradefoto')) return empty();
  const protection = await loadManagedDataImportProtection({ access, vault, create: false });
  if (!protection) return empty();
  try {
    const reader = createSalesMasterReader({ protection, scopeId });
    return await access.transaction(async tx => {
      const names = [...new Set([...GROUPS.flatMap(g => g.fields.map(f => f[0])), ...AUX_FIELDS, 'DurchschnittEK'])];
      const metadata = require('./tradefoto-master-profiles').tableFor('ARTIKEL_STAMM');
      const allowed = names.filter(name => {
        const column = metadata.columns.find(c => c.name === name);
        return column && (column.dataClass === 'internal_business'
          || column.dataClass === 'catalog_prices' && projection.pricesRead
          || column.dataClass === 'catalog_costs' && projection.costsRead);
      });
      const source = await reader.byKey(tx, 'ARTIKEL_STAMM', [article.sourceArticleKey], allowed);
      if (!source) return empty();
      const group = source.Sortiment == null ? null : await reader.byKey(tx, 'ARTIKEL_Sortimente', [String(source.Sortiment)], ['Bezeichnung']);
      if (group?.Bezeichnung) source.Sortiment = `${source.Sortiment} · ${group.Bezeichnung}`;
      const supplier = source.Suchname ? await reader.byKey(tx, 'LIEFERANTEN', [String(source.Suchname)], ['Firma']) : null;
      const vat = articleCalculation(article, source).vatPercent;
      const sections = GROUPS.map(g => ({ id: g.id, title: g.title, fields: g.fields.filter(([key]) => source[key] !== null && source[key] !== undefined && source[key] !== '')
        .flatMap(([key, label]) => {
          if (key === 'HerstellerLink') return productLinks(source[key]).map(link => ({ label: link.kind === 'product' ? 'Produktlink' : link.kind === 'idealo' ? 'Idealo' : 'Geizhals', value: link.label, href: link.href }));
          if (key === 'MWST') return [{ label: 'MwSt.', value: vat === null ? 'Nicht eindeutig hinterlegt' : String(vat) + ' %' }];
          const field = projectSalesArticleSourceField(key, label, source[key]);
          if (key === 'Suchname' && supplier?.Firma) field.title = supplier.Firma;
          return [field];
        }) })).filter(g => g.fields.length);
      return { sourceSections: sections,
        branchStock: await require('./sales-article-branch-stock').loadSalesArticleBranchStock({ access, tx, protection, reader, article, scopeId }),
        priceMatrix: buildSalesArticlePriceMatrix(article, source, projection) };
    }, { isolation: 'serializable', readOnly: true });
  } finally { protection.destroy(); }
}
async function loadSalesArticleSourceSections(options) { return (await loadSalesArticleDetailData(options)).sourceSections; }
module.exports = { loadSalesArticleSourceSections, loadSalesArticleDetailData, projectSalesArticleSourceField };
