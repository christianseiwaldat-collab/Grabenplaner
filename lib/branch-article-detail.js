'use strict';
const C = require('./data-import-contract');
const M = require('./tradefoto-master-profiles');
const H = require('./tradefoto-history-profiles');
const { loadManagedDataImportProtection } = require('./data-import-managed-protection');
const { createSalesMasterReader } = require('./persistence/repositories/sales-master-data');
const { createImportHistoryService } = require('./persistence/repositories/import-history');
const { createSalesArticleCatalogRepository } = require('./persistence/repositories/sales-article-catalog');
const { createSalesArticleImagesRepository } = require('./persistence/repositories/sales-article-images');
const { IMPORT_MASTER_STATEMENTS: S } = require('./persistence/statements/import-master-data');
const { articleStock } = require('./persistence/statements/branch-article-stock');
const fields = ['Sortimentsart', 'Abverkauf', 'Auslaufartikel', 'OhneBestand', 'MWST', 'HerstellerLink', 'DurchschnittEK'];
const {articleCalculation,usablePrice,decimal}=require('./branch-article-basis');
function businessStatus(source) {
  const values = [String(source.Sortimentsart || '').trim()];
  if (source.Abverkauf === true && !/abverkauf/i.test(values[0])) values.push('Abverkauf');
  if (source.Auslaufartikel === true && !/auslauf/i.test(values[0])) values.push('Auslauf');
  if (source.OhneBestand === true && !/keine lw|ohne bestand/i.test(values[0])) values.push('Ohne Bestand');
  return values.filter(Boolean).join(' · ') || 'Status nicht hinterlegt';
}
function productLinks(value) {
  const links = new Map();
  for (const candidate of String(value || '').match(/https?:\/\/[^\s<>"#;]+/g) || []) {
    try {
      const url = new URL(candidate);
      if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) continue;
      const kind = /(^|\.)geizhals\.(at|de|eu)$/i.test(url.hostname) ? 'geizhals'
        : /(^|\.)idealo\.de$/i.test(url.hostname) ? 'idealo' : 'product';
      if (!links.has(kind)) links.set(kind, { kind, label: kind === 'product' ? 'Produkt' : url.hostname.replace(/^www\./, ''), href: url.href });
    } catch {}
  }
  return ['product', 'geizhals', 'idealo'].map(k => links.get(k)).filter(Boolean);
}
function createBranchArticleDetail({ access, vault, scopeId = 'grabenplaner-main', sourceInstance = 'tradefoto-trade' }) {
  return async function detail(articleNumber, context) {
    const protection = await loadManagedDataImportProtection({ access, vault, create: false });
    try {
      return await access.transaction(async tx => {
        const article = await createSalesArticleCatalogRepository(tx).getByArticleNumber(articleNumber);
        if (!article) C.fail('BRANCH_ARTICLE_NOT_FOUND', 404);
        const image = await createSalesArticleImagesRepository(tx).metadata(articleNumber);
        let source = {}, masterSource = null, stocks = [], stockAt = null;
        if (protection && article.sourceSystem === 'tradefoto.artikel_stamm') {
          const reader = createSalesMasterReader({ protection, scopeId, sourceInstance });
          masterSource = await reader.byKey(tx, 'ARTIKEL_STAMM', [article.sourceArticleKey], fields);
          source = masterSource || {};
          const master = await tx.queryOne(S.find, { scopeId, identityHash: M.masterIdentity(protection, { scopeId, sourceInstance }, 'ARTIKEL_STAMM', [article.sourceArticleKey]) });
          const profile = H.profileFor('trade', 'ARTIKEL_FILIALEN');
          const runs = await tx.queryAll(require('./persistence/statements/trade-insights').SOURCES, { scopeId, profileHash: profile.fingerprint, limit: 32 });
          const run = runs.filter(r => ['applied', 'purged'].includes(r.status) && r.manifest.sourceInstance === sourceInstance)
            .sort((a, b) => b.manifest.snapshotAt.localeCompare(a.manifest.snapshotAt) || b.createdAt.localeCompare(a.createdAt))[0];
          if (run) {
            const expectedId = protection.digest(['run', C.VERSION, { scopeId: run.scopeId, ownerId: run.ownerId }, profile.fingerprint, run.manifest, run.attemptId]);
            if (run.id !== expectedId || !C.equal(run.profile, profile) || run.receivedCount !== run.manifest.expectedRows) C.fail('IMPORT_HISTORY_INTEGRITY');
            stockAt = run.manifest.snapshotAt;
            const rows = await tx.queryAll(articleStock, { scopeId, sourceInstance, snapshot: run.manifest.fileSha256,
              articleHash: protection.digest(['history-reference', scopeId, 'sales_article', article.productId]), masterRecordId: master?.id || '', limit: 101 });
            if (rows.length > 100) C.fail('BRANCH_ARTICLE_STOCK_LIMIT', 413);
            const history = createImportHistoryService({ access, executor: tx, protection, getActor: () => ({ scopeId, ownerId: context.accountId }),
              authorize: request => ['history.read', 'history.scope', 'history.reference'].includes(request.action)
                && (!request.sourceTable || (request.sourceTable === 'ARTIKEL_FILIALEN' && request.source === 'trade' && request.sourceInstance === sourceInstance))
                && request.dataClasses.every(c => c === 'internal_business') });
            for (const row of rows) {
              const value = await history.detail(row.id), f = value.fields;
              if (f.EAN !== article.sourceArticleKey || value.provenance.fileSha256 !== run.manifest.fileSha256) C.fail('IMPORT_HISTORY_INTEGRITY');
              const id = String(f.FilialID ?? '');
              if (!id) continue;
              const binding = await require('./persistence/repositories/import-master-data').createImportMasterReferenceReader({protection,authorize:()=>true})(tx,
                {scopeId,ownerId:context.accountId,sourceInstance},'FILIALEN',[id]);
              stocks.push({ id, quantity: decimal(f.FBestand), own: ['linked','historical_mapping'].includes(binding.status) && binding.targetId === context.locationId,
                updatedAt: f.Bestandsänderungsdatum || null });
            }
            // Duplicate source rows are ambiguous, never additive stock movements.
            const grouped = new Map();
            for (const row of stocks) grouped.set(row.id, grouped.has(row.id) ? { ...row, quantity: null, ambiguous: true } : row);
            stocks = [...grouped.values()].sort((a, b) => a.id.localeCompare(b.id, 'de', { numeric: true }));
          }
        }
        // Business confirmation, 2026-09-13: TradeFoto DurchschnittEK is the
        // authoritative net purchase cost. Never substitute NNPreis or DEK_A.
        return { articleNumber: article.articleNumber, description: article.description,
          primaryIdentifier: article.identifiers?.find(v => v.isPrimary)?.identifierValue || null,
          status: businessStatus(source), retailGross: usablePrice(article, 'sales', 'gross'), internetGross: usablePrice(article, 'internet_1', 'gross'),
          calculation: articleCalculation(article,masterSource),
          stocks, stockAt, ownLocationId: context.locationId, links: productLinks(source.HerstellerLink),
          imageUrl: image.present ? '/api/portal/v1/branch-articles/image?articleNumber=' + encodeURIComponent(articleNumber) + '&v=' + encodeURIComponent(image.revision) : null };
      }, { isolation: 'serializable', readOnly: true });
    } finally { protection?.destroy(); }
  };
}
module.exports = { createBranchArticleDetail, businessStatus, productLinks, usablePrice };
