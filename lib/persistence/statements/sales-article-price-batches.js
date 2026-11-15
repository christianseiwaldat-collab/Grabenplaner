'use strict';
const {definePersistenceStatement}=require('../contract');
// Installed only by the qualified stage-8 PostgreSQL composition.
const INSERT_ARTICLE_PRICES=definePersistenceStatement({
 id:'sales-article-price-batches.insert',operation:'execute',parameters:{rows:'json'},columns:{},
});
module.exports={INSERT_ARTICLE_PRICES};
