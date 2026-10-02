'use strict';

const { branchSalesContext, BRANCH_ARTICLES_PERMISSION } = require('./branch-sales-access');
const { buildSalesArticleCatalogProjection, SALES_ARTICLE_CATALOG_PERMISSIONS: P } = require('./sales-article-catalog-access');

// This projection is local to the price-label endpoints. It does not grant the
// personal article workspace, editing, cost prices or importer access.
function priceLabelSession(session) {
  if (!session || session.mustChangePassword) denied();
  if (session.sessionKind === 'organization' || session.isEmployee === false) {
    branchSalesContext(session, BRANCH_ARTICLES_PERMISSION);
    return Object.freeze({ ...session, permissions: Object.freeze([
      ...(session.permissions || []).filter(permission => !permission.startsWith('sales:articles:')),
      P.ACCESS, P.READ, P.PRICES_READ,
    ]) });
  }
  if (!buildSalesArticleCatalogProjection(session).pricesRead) denied();
  return session;
}
function denied() { throw Object.assign(new Error('Für Preisschilder fehlt die Freigabe zum Lesen der Verkaufspreise.'), { code: 'PRICE_LABEL_ACCESS', status: 403 }); }
module.exports = { priceLabelSession };
