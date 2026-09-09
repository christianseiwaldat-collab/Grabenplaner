'use strict';
const { loadManagedDataImportProtection } = require('./data-import-managed-protection');
const { createSalesMasterReader } = require('./persistence/repositories/sales-master-data');
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
async function loadSalesArticleSourceSections({ access, vault, article, projection, scopeId = 'grabenplaner-main' }) {
  if (!projection.read || !String(article.sourceSystem).startsWith('tradefoto')) return [];
  const protection = await loadManagedDataImportProtection({ access, vault, create: false });
  if (!protection) return [];
  try {
    const reader = createSalesMasterReader({ protection, scopeId });
    return await access.transaction(async tx => {
      const source = await reader.byKey(tx, 'ARTIKEL_STAMM', [article.sourceArticleKey], GROUPS.flatMap(g => g.fields.map(f => f[0])));
      if (!source) return [];
      const group = source.Sortiment == null ? null : await reader.byKey(tx, 'ARTIKEL_Sortimente', [String(source.Sortiment)], ['Bezeichnung']);
      if (group?.Bezeichnung) source.Sortiment = `${source.Sortiment} · ${group.Bezeichnung}`;
      return GROUPS.map(g => ({ id: g.id, title: g.title, fields: g.fields.filter(([key]) => source[key] !== null && source[key] !== undefined && source[key] !== '')
        .map(([key, label]) => projectSalesArticleSourceField(key, label, source[key])) })).filter(g => g.fields.length);
    }, { isolation: 'serializable', readOnly: true });
  } finally { protection.destroy(); }
}
module.exports = { loadSalesArticleSourceSections, projectSalesArticleSourceField };
