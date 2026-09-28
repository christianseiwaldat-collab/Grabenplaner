'use strict';
const C = require('./data-import-contract');
const M = require('./tradefoto-master-profiles');
const { SOURCES } = require('./persistence/statements/trade-insights');
const W = require('./persistence/statements/sales-article-workspace');
async function loadSalesArticleNotes({ tx, reader, protection, article, scopeId }) {
  const profile = M.profileFor('Artikel_Bemerkungen'), sourceInstance = 'tradefoto-trade';
  const runs = await tx.queryAll(SOURCES, { scopeId, profileHash: profile.fingerprint, limit: 100 });
  const run = runs.filter(r => ['applied','purged'].includes(r.status) && r.manifest.sourceInstance === sourceInstance)
    .sort((a,b) => b.manifest.snapshotAt.localeCompare(a.manifest.snapshotAt) || b.createdAt.localeCompare(a.createdAt))[0];
  if (!run) return { items: [], available: false, sourceAt: null };
  if (run.id !== protection.digest(['run', C.VERSION, { scopeId, ownerId: run.ownerId }, profile.fingerprint, run.manifest, run.attemptId])
    || !C.equal(run.profile, profile) || run.receivedCount !== run.manifest.expectedRows) C.fail('IMPORT_MASTER_INTEGRITY');
  const articleIdentity = M.masterIdentity(protection, {scopeId, sourceInstance}, 'ARTIKEL_STAMM', [article.sourceArticleKey]);
  const items = []; let after = '', processed = 0;
  for (;;) {
    const records = await tx.queryAll(W.notes, {scopeId, articleIdentity, after, limit: 200});
    processed += records.length;
    if (processed > 10000) C.fail('IMPORT_REPORT_METADATA_LIMIT', 413);
    for (const record of records) {
      const fields = await reader.projectedRecord(tx, record, ['EAN','Text','Datum','LBAe','_source_snapshot_sha256','_source_row']);
      const snapshot = fields._source_snapshot_sha256, ordinal = fields._source_row;
      if (fields.EAN !== article.sourceArticleKey || typeof snapshot !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot)
        || !Number.isSafeInteger(ordinal) || ordinal < 1
        || record.identityHash !== M.masterIdentity(protection, {scopeId, sourceInstance}, 'Artikel_Bemerkungen', [snapshot, ordinal])) C.fail('IMPORT_MASTER_INTEGRITY');
      // Keyless source rows accumulate across imports. Only the latest fully applied snapshot is current.
      if (snapshot !== run.manifest.fileSha256 || !String(fields.Text ?? '').trim()) continue;
      items.push({date: fields.Datum || null, text: String(fields.Text), person: fields.LBAe ?? null, ordinal});
    }
    if (records.length < 200) break;
    after = records.at(-1).id;
  }
  items.sort((a,b) => String(b.date || '').localeCompare(String(a.date || '')) || a.ordinal - b.ordinal);
  return {items, available: true, sourceAt: run.manifest.snapshotAt};
}
module.exports = {loadSalesArticleNotes};
