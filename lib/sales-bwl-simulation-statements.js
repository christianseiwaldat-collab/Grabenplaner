'use strict';
const { definePersistenceStatement: d } = require('./persistence/contract');
const catalogEpoch = d({ id: 'sales-bwl-simulation.catalog-epoch', operation: 'queryOne', parameters: {},
  columns: { count: 'safe_integer', revisions: 'safe_integer', modifiedAt: { kind: 'text', nullable: true } } });
const remove = d({ id: 'sales-bwl-simulation.annotation-remove', operation: 'execute',
  parameters: { id: 'text', scopeId: 'text', kind: 'text', expectedRevision: 'safe_integer' } });
const sqlite = Object.freeze([
  { statement: catalogEpoch, returning: false, sql: 'SELECT COUNT(*) AS count, COALESCE(SUM(current_revision),0) AS revisions, MAX(updated_at) AS modifiedAt FROM sales_articles' },
  { statement: remove, returning: false, sql: 'DELETE FROM trade_annotations WHERE id=$id AND scope_id=$scopeId AND kind=$kind AND revision=$expectedRevision' },
]);
function postgresqlSales() { return [require('./persistence/postgresql/sales/catalog').compileSalesEntry(sqlite[0], 8).providerEntry]; }
function postgresqlCore() {
  const entry = require('./persistence/postgresql/core/catalog').compileCoreEntry(sqlite[1]).providerEntry;
  return [{ ...entry, sql: entry.sql.replace(/\btrade_annotations\b/g, 'gp.trade_annotations') }];
}
function postgresql() { return [...postgresqlSales(), ...postgresqlCore()]; }
async function fingerprint(tx, scopeId, protection) {
  const epoch = await tx.queryOne(require('./persistence/statements/import-history').IMPORT_HISTORY_STATEMENTS.epoch, { scopeId });
  const annotation = await tx.queryOne(require('./persistence/statements/trade-annotations').A.epoch, { scopeId });
  const cash = await tx.queryOne(require('./persistence/statements/cash-publications').CASH_PUBLICATION_STATEMENTS.state, { scopeId });
  const catalog = await tx.queryOne(catalogEpoch, {});
  if (await tx.queryOne(require('./persistence/statements/sales-article-catalog').SALES_ARTICLE_CATALOG_STATEMENTS.searchProjectionDirty, {})) require('./data-import-contract').fail('IMPORT_ARTICLE_SEARCH_NOT_CURRENT', 409);
  return protection.digest(['bwl-simulation-source-v1', scopeId, epoch, annotation, cash?.revision || 0, catalog]);
}
module.exports = { catalogEpoch, remove, sqlite, postgresql, postgresqlSales, postgresqlCore, fingerprint };
