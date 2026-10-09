'use strict';
const { fixture, rights } = require('./trade-insights-sqlite');
const Catalog = require('../lib/sales-article-catalog');
const Report = require('../lib/sales-article-report-model');
async function simulationFixture(t, options = {}) {
  const f = await fixture(t, options); f.state.session.permissions = [...rights, ...require('../lib/sales-article-catalog-access').SALES_ARTICLE_CATALOG_PERMISSION_IDS];
  f.state.session.accountId = 'synthetic-account';
  const source = options.source || [{ EAN: '0000000000042', Artikelbezeichnung: 'BEISPIEL Fernglas', Abverkauf: true, Sortiment: 'Abverkauf', DurchschnittEK: '70', MWST: 1, OhneBestand: false, Sachkonto: false }];
  await f.ingest('ARTIKEL_STAMM', source, { master: true });
  await f.ingest('ARTIKEL_FILIALEN', options.stocks || [{ EAN: source[0].EAN, FilialID: 18, FBestand: '4', Bestellt: '0' }, { EAN: source[0].EAN, FilialID: 19, FBestand: '2', Bestellt: '0' }], { sourceInstance: 'tradefoto-trade' });
  const repo = require('../lib/persistence/repositories/sales-article-catalog').createSalesArticleCatalogRepository(f.app.provider);
  const price = (priceType, priceBasis, amount) => ({ priceType, priceBasis, amount, currency: 'EUR', qualityStatus: 'confirmed', sourceField: 'BEISPIEL' });
  const articles = source.map(a => ({ sourceArticleKey: a.EAN, articleNumber: Report.articleNumber(a.EAN), description: a.Artikelbezeichnung, active: true, sourceUpdatedAt: null, identifiers: [],
    prices: [price('sales', 'gross', '120'), price('sales', 'net', '100'), price('average_purchase', 'net', a.DurchschnittEK || '70')] }));
  const snapshot = { sourceSystem: 'tradefoto.artikel_stamm', sourceProfileVersion: 'simulation-test-v1', sourceSchemaSha256: 'a'.repeat(64), sourceFileSha256: 'b'.repeat(64),
    snapshotAt: '2026-09-14T09:00:00.000Z', articles, contentSha256: Catalog.salesArticleImportContentSha256(articles) };
  await repo.importSnapshot({ snapshot, actor: 'synthetic-owner', timestamp: '2026-09-14T09:01:00.000Z' });
  return { ...f, repo, source, simulation: (op, input = {}) => f.run('bwl-simulation-' + op, input) };
}
module.exports = { simulationFixture };
