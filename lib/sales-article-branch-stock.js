'use strict';
const C = require('./data-import-contract');
const M = require('./tradefoto-master-profiles');
const H = require('./tradefoto-history-profiles');
const { IMPORT_MASTER_STATEMENTS: S } = require('./persistence/statements/import-master-data');
const { createImportHistoryService } = require('./persistence/repositories/import-history');
const { decimal } = require('./branch-article-basis');
async function loadSalesArticleBranchStock({ access, tx, protection, reader, article, scopeId }) {
  const sourceInstance = 'tradefoto-trade';
  const profile = H.profileFor('trade', 'ARTIKEL_FILIALEN');
  const runs = await tx.queryAll(require('./persistence/statements/trade-insights').SOURCES,
    { scopeId, profileHash: profile.fingerprint, limit: 100 });
  const run = runs.filter(r => ['applied','purged'].includes(r.status) && r.manifest.sourceInstance === sourceInstance)
    .sort((a,b) => b.manifest.snapshotAt.localeCompare(a.manifest.snapshotAt) || b.createdAt.localeCompare(a.createdAt))[0];
  if (!run) return { rows: [], sourceAt: null };
  const expected = protection.digest(['run', C.VERSION, { scopeId: run.scopeId, ownerId: run.ownerId }, profile.fingerprint, run.manifest, run.attemptId]);
  if (run.id !== expected || !C.equal(run.profile, profile) || run.receivedCount !== run.manifest.expectedRows) C.fail('IMPORT_HISTORY_INTEGRITY');
  const master = await tx.queryOne(S.find, { scopeId,
    identityHash: M.masterIdentity(protection, { scopeId, sourceInstance }, 'ARTIKEL_STAMM', [article.sourceArticleKey]) });
  const rows = await tx.queryAll(require('./persistence/statements/branch-article-stock').articleStock, { scopeId, sourceInstance,
    snapshot: run.manifest.fileSha256, articleHash: protection.digest(['history-reference', scopeId, 'sales_article', article.productId]),
    masterRecordId: master?.id || '', limit: 101 });
  if (rows.length > 100) C.fail('BRANCH_ARTICLE_STOCK_LIMIT', 413);
  const history = createImportHistoryService({ access, executor: tx, protection, getActor: () => ({ scopeId, ownerId: 'article-catalog' }),
    authorize: request => ['history.read','history.scope','history.reference'].includes(request.action)
      && (!request.sourceTable || request.sourceTable === 'ARTIKEL_FILIALEN' && request.source === 'trade' && request.sourceInstance === sourceInstance)
      && request.dataClasses.every(c => c === 'internal_business') });
  const grouped = new Map();
  for (const row of rows) {
    const value = await history.detail(row.id), f = value.fields;
    if (f.EAN !== article.sourceArticleKey || value.provenance.fileSha256 !== run.manifest.fileSha256) C.fail('IMPORT_HISTORY_INTEGRITY');
    const id = String(f.FilialID ?? '');
    if (!id) continue;
    let location = await reader.byKey(tx, 'FILIALEN', [id], ['FName']);
    if (!location && id === '00') location = await reader.byKey(tx, 'FILIALEN', ['0'], ['FName']);
    grouped.set(id, { id, name: location?.FName || null, quantity: grouped.has(id) ? null : decimal(f.FBestand),
      ambiguous: grouped.has(id), updatedAt: f.Bestandsänderungsdatum || null });
  }
  return { rows: [...grouped.values()].sort((a,b) => a.id.localeCompare(b.id, 'de', { numeric: true })), sourceAt: run.manifest.snapshotAt };
}
module.exports = { loadSalesArticleBranchStock };
