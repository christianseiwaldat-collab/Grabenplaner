'use strict';
const C = require('../../data-import-contract');
const M = require('../../tradefoto-master-profiles');
const Search = require('../../flexible-search');
const W = require('../statements/sales-article-workspace');
const { IMPORT_HISTORY_STATEMENTS: H } = require('../statements/import-history');
const { SOURCES } = require('../statements/trade-insights');
const { SALES_ARTICLE_CATALOG_STATEMENTS: A } = require('../statements/sales-article-catalog');
const { PRICE_SEARCH_FIELDS } = require('../../sales-article-table');
const { loadManagedDataImportProtection } = require('../../data-import-managed-protection');
const caches = new WeakMap();
function decodeOrder(row, protection, scopeId) {
  const profile = M.profileFor(row.sourceTable);
  if (row.profileHash !== profile.fingerprint || row.sourceInstance !== 'tradefoto-trade') C.fail('IMPORT_MASTER_INTEGRITY');
  const data = protection.open(row.payload, ['master-segment', scopeId, row.sourceInstance, row.sourceTable,
    row.identityHash, row.id, row.profileHash, row.revision, row.kind, row.dataClass]);
  const expected = M.masterSegments(row.sourceTable, {}).find(s => s.kind === row.kind && s.dataClass === row.dataClass);
  if (!expected || !C.equal(Object.keys(data).sort(), Object.keys(expected.data).sort())) C.fail('IMPORT_MASTER_INTEGRITY');
  const get = name => data[profile.fields.find(f => f.source === name)?.target];
  const provenance = row.provenancePayload ? protection.open(row.provenancePayload, ['master-segment', scopeId, row.sourceInstance, row.sourceTable,
    row.identityHash, row.id, row.profileHash, row.revision, 'provenance', 'internal_business']) : null;
  if (row.sourceTable === 'ARTIKEL_ZWEITLIEFERANT' && (!provenance
    || !C.equal(Object.keys(provenance).sort(), ['ordinal','snapshot'])
    || typeof provenance.snapshot !== 'string' || !/^[a-f0-9]{64}$/.test(provenance.snapshot)
    || !Number.isSafeInteger(provenance.ordinal) || provenance.ordinal < 1)) C.fail('IMPORT_MASTER_INTEGRITY');
  return { revision:row.revision, articleKey:get('EAN'), secondary:row.sourceTable === 'ARTIKEL_ZWEITLIEFERANT', snapshot:provenance?.snapshot,
    number:Search.text(get(row.sourceTable === 'ARTIKEL_STAMM' ? 'Bestellnummer' : 'ZBestellnummer')) };
}
async function orderKeys(tx, access, protection, scopeId, query) {
  const epoch = JSON.stringify(await tx.queryOne(H.epoch, {scopeId}));
  const old = caches.get(access);
  if (old?.scopeId === scopeId && old.epoch === epoch) return matching(old.rows, query, old.secondarySnapshot);
  if (!protection) return [];
  {
    const profile = M.profileFor('ARTIKEL_ZWEITLIEFERANT');
    const runs = await tx.queryAll(SOURCES,{scopeId,profileHash:profile.fingerprint,limit:100});
    const latest = runs.filter(r => ['applied','purged'].includes(r.status) && r.manifest.sourceInstance === 'tradefoto-trade')
      .sort((a,b) => b.manifest.snapshotAt.localeCompare(a.manifest.snapshotAt) || b.createdAt.localeCompare(a.createdAt))[0];
    if (latest && (latest.receivedCount !== latest.manifest.expectedRows
      || latest.id !== protection.digest(['run', C.VERSION, {scopeId:latest.scopeId,ownerId:latest.ownerId}, profile.fingerprint, latest.manifest, latest.attemptId]))) C.fail('IMPORT_MASTER_INTEGRITY');
    const secondarySnapshot = latest?.manifest.fileSha256 || null;
    const rows = new Map();
    let after = '';
    for (;;) {
      const page = await tx.queryAll(W.revisions, {scopeId,after,limit:500});
      const changed = page.filter(r => old?.scopeId !== scopeId || old.rows.get(r.id)?.revision !== r.revision);
      const decoded = changed.length ? await tx.queryAll(W.segments, {scopeId,ids:changed.map(r => r.id)}) : [];
      const byId = new Map();
      for (const row of decoded) {
        if (byId.has(row.id)) C.fail('IMPORT_MASTER_INTEGRITY');
        byId.set(row.id, decodeOrder(row,protection,scopeId));
      }
      for (const row of page) {
        const cached = old?.scopeId === scopeId ? old.rows.get(row.id) : null;
        const value = cached?.revision === row.revision ? cached : byId.get(row.id);
        if (!value || value.revision !== row.revision) C.fail('IMPORT_MASTER_INTEGRITY');
        rows.set(row.id,value);
      }
      if (rows.size > 500000) C.fail('IMPORT_REPORT_METADATA_LIMIT',413);
      if (page.length < 500) break;
      after = page.at(-1).id;
    }
    caches.set(access,{scopeId,epoch,rows,secondarySnapshot});
    return matching(rows,query,secondarySnapshot);
  }
}
function matching(rows, query, secondarySnapshot = null) {
  return [...new Set([...rows.values()].filter(r => (!r.secondary || r.snapshot === secondarySnapshot)
    && r.articleKey && r.number && Search.matches([r.number],query)).map(r => r.articleKey))];
}
async function searchSalesArticleWorkspace({access,vault,search,orderNumber='',projection,scopeId='grabenplaner-main'}) {
  const priceSort = PRICE_SEARCH_FIELDS.find(p => p.id === search.sort);
  if (!projection.read || priceSort && projection[priceSort.permission] !== true) C.fail('IMPORT_ARTICLE_ACCESS_DENIED',403);
  const protection = orderNumber ? await loadManagedDataImportProtection({access,vault,create:false}) : null;
  try { return await access.transaction(async tx => {
    if (await tx.queryOne(A.searchProjectionDirty,{})) C.fail('IMPORT_ARTICLE_SEARCH_NOT_CURRENT',409);
    const keys = orderNumber ? await orderKeys(tx,access,protection,scopeId,orderNumber) : null;
    const parameters = {...Search.parameters(search.query),identifierLike:search.identifierLike,
      active:search.active,sourceSystem:search.sourceSystem,orderKeys:keys};
    const [items,count] = await Promise.all([
      tx.queryAll(W.search,{...parameters,sort:search.sort,direction:search.direction,limit:search.limit,offset:search.offset}),
      tx.queryOne(W.count,parameters),
    ]);
    return {items:items.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => {
      const price = PRICE_SEARCH_FIELDS.find(p => p.id === key);
      return !price || projection[price.permission] === true;
    }))),total:count?.total || 0,limit:search.limit,offset:search.offset,sort:search.sort,direction:search.direction};
  },{isolation:'serializable',readOnly:true}); } finally { protection?.destroy(); }
}
module.exports = { searchSalesArticleWorkspace, decodeOrder, matching };
