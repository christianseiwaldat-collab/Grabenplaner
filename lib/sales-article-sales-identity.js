'use strict';
const C = require('./data-import-contract');
const { SALES_ARTICLE_CATALOG_STATEMENTS: Catalog } = require('./persistence/statements/sales-article-catalog');
const { articleSourceLinks } = require('./sales-article-sales-statements');
const { TRADEFOTO_ARTICLE_SOURCE_SYSTEM,normalizeTradeFotoSourceArticleKey } = require('./tradefoto-article-source-profile');
const MAX_SOURCE_KEYS = 14;
// Display numbers and Trade EAN article keys have different contracts. Only an
// explicit catalog source link proves they belong to the same GP product. Older
// imports can have shorter exact source keys; those links remain exact too.
// Never create aliases by trimming/padding zeros or numeric comparisons.
async function resolveArticleSalesIdentity(tx,articleNumber) {
  const article = await tx.queryOne(Catalog.getArticleByNumber,{articleNumber});
  if (!article) return {articleNumber,productId:null,sourceKeys:[articleNumber],basis:'exact_source_key'};
  const links = await tx.queryAll(articleSourceLinks,{productId:article.productId,sourceSystem:TRADEFOTO_ARTICLE_SOURCE_SYSTEM,limit:MAX_SOURCE_KEYS + 1});
  if (links.length > MAX_SOURCE_KEYS) C.fail('IMPORT_HISTORY_INTEGRITY');
  const sourceKeys = [...new Set(links.map(link => {
    const key = link.sourceArticleKey;
    if (typeof key !== 'string' || !key || key !== key.trim() || key.length > 160 || /[\u0000-\u001f\u007f]/.test(key)) C.fail('IMPORT_HISTORY_INTEGRITY');
    try { return /^\d{13}$/.test(key) ? normalizeTradeFotoSourceArticleKey(key).sourceArticleKey : key; }
    catch { C.fail('IMPORT_HISTORY_INTEGRITY'); }
  }))];
  return {articleNumber,productId:article.productId,sourceKeys:sourceKeys.length ? sourceKeys : [articleNumber],
    basis:sourceKeys.length ? 'catalog_source_link' : 'exact_source_key'};
}
module.exports = {resolveArticleSalesIdentity,MAX_SOURCE_KEYS};
