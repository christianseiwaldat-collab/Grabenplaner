'use strict';
const { definePersistenceStatement: def } = require('../contract');
const { SALES_ARTICLE_CATALOG_STATEMENTS: A } = require('./sales-article-catalog');
const clone = (id, s) => def({ id:'sales-article-workspace.' + id, operation:s.operation,
  parameters:{...s.parameters, orderKeys:{kind:'json',nullable:true}}, columns:s.columns });
const search = clone('search', A.search), count = clone('count', A.countSearch);
const revisions = def({id:'sales-article-workspace.order-revisions', operation:'queryAll',
  parameters:{scopeId:'text',after:'text',limit:'safe_integer'},
  columns:{id:'text',revision:'safe_integer',sourceTable:'text'}});
const segments = def({id:'sales-article-workspace.order-segments', operation:'queryAll',
  parameters:{scopeId:'text',ids:'json'}, columns:{id:'text',revision:'safe_integer',sourceTable:'text',
    sourceInstance:'text',identityHash:'text',profileHash:'text',kind:'text',dataClass:'text',payload:'text',provenancePayload:{kind:'text',nullable:true}}});
module.exports = { search, count, revisions, segments };
