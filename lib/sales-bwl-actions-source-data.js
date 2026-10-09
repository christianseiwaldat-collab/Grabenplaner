'use strict';
const C = require('./data-import-contract'), M = require('./sales-bwl-actions-model'), Data = require('./sales-article-report-data');
const { IMPORT_MASTER_STATEMENTS: MS } = require('./persistence/statements/import-master-data');
const { masterIdentity } = require('./tradefoto-master-profiles');
const Catalog = require('./persistence/statements/sales-article-catalog').SALES_ARTICLE_CATALOG_STATEMENTS, Epoch = require('./sales-bwl-simulation-statements');
async function sourceHint(env, input) {
  C.exact(input, ['locationId', 'sourceHint']); const auth = M.authority(env.session), locationId = M.assertLocation(auth, input.locationId, { write: true });
  const selector = M.normalizeSource(input.sourceHint); if (selector?.kind !== 'inventory') C.fail('BWL_ACTIONS_SOURCE_INVALID');
  let pair;
  try { pair = JSON.parse(selector.rowId); } catch { C.fail('BWL_ACTIONS_SOURCE_INVALID'); }
  if (!Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== 'string') || C.canonical(pair) !== selector.rowId || pair[1] !== locationId) C.fail('BWL_ACTIONS_FORBIDDEN', 403);
  const key = C.text(pair[0], 256), fingerprint = await Epoch.fingerprint(env.tx, env.scopeId, env.protection);
  if (fingerprint !== selector.sourceFingerprint) C.fail('BWL_ACTIONS_SOURCE_CHANGED', 409);
  const branches = (await Data.locationsFor(env)).filter(location => location.locationId === locationId);
  if (!branches.length) C.fail('BWL_ACTIONS_FORBIDDEN', 403);
  const active = await env.source('ARTIKEL_FILIALEN', 'tradefoto-trade'); if (!active) C.fail('BWL_ACTIONS_SOURCE_UNAVAILABLE', 503);
  const master = await env.tx.queryOne(MS.find, { scopeId: env.scopeId, identityHash: masterIdentity(env.protection, { scopeId: env.scopeId, sourceInstance: 'tradefoto-trade' }, 'ARTIKEL_STAMM', [key]) });
  if (!master) C.fail('BWL_ACTIONS_SOURCE_MISSING', 404);
  const source = await env.reader.projectedRecord(env.tx, master, ['EAN', 'Artikelbezeichnung', 'Abverkauf', 'Auslaufartikel', 'OhneBestand', 'Sachkonto']);
  if (source?.EAN !== key) C.fail('IMPORT_MASTER_INTEGRITY');
  const stock = await Data.stockRows(env, active, branches, [{ masterId: master.id, source }]), row = stock.pairs.find(r => r.key === selector.rowId);
  if (!row || row.ambiguous) C.fail('BWL_ACTIONS_SOURCE_MISSING', row ? 409 : 404);
  // The accepted article head is sufficient. This proof does not read prices,
  // purchase costs or any unrelated catalog rows.
  const article = await env.tx.queryOne(Catalog.getArticleBySource, { sourceSystem: 'tradefoto.artikel_stamm', sourceArticleKey: key });
  if (article && article.sourceArticleKey !== key) C.fail('IMPORT_MASTER_INTEGRITY');
  const result = M.validateSourceRecord({ kind: 'inventory', rowId: selector.rowId,
    articleNumber: article?.articleNumber || require('./sales-article-report-model').articleNumber(key), label: article?.description || source.Artikelbezeichnung || null,
    sourceFingerprint: fingerprint, sourceAt: active.manifest.snapshotAt,
    reason: source.Abverkauf === true || source.Abverkauf === 1 ? 'Abverkaufsartikel und Filialbestand prüfen.' : 'Artikel und Filialbestand prüfen.', type: 'catalog-stock-review' });
  await env.fresh(env.tx); if (await Epoch.fingerprint(env.tx, env.scopeId, env.protection) !== fingerprint) C.fail('BWL_ACTIONS_SOURCE_CHANGED', 409); return result;
}
async function run(env, operation, input) { if (operation !== 'source') C.fail('BWL_ACTIONS_SOURCE_INVALID'); return sourceHint(env, input); }
module.exports = { run, sourceHint };
