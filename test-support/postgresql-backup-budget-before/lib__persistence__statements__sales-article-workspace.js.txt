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
const notes = def({id:'sales-article-workspace.notes', operation:'queryAll',
  parameters:{scopeId:'text',articleIdentity:'text',after:'text',limit:'safe_integer'},
  columns:require('./import-master-data').IMPORT_MASTER_COLUMNS.RECORD});
const stockSource = require('./branch-article-stock').articleStock;
const articleStock = def({id:'sales-article-workspace.article-stock',operation:'queryAll',
  parameters:stockSource.parameters,columns:stockSource.columns});
const {IMPORT_MASTER_STATEMENTS:M} = require('./import-master-data');
const {IMPORT_HISTORY_STATEMENTS:H} = require('./import-history');
const readerBatches = Object.freeze([
  {source:M.find,table:'import_master_records',filters:{scopeId:'scope_id',identityHash:'identity_hash'}},
  {source:M.segments,table:'import_master_segments',filters:{recordId:'record_id'}},
  {source:H.get,table:'import_history_records',filters:{id:'id',scopeId:'scope_id'}},
  {source:H.find,table:'import_history_records',filters:{identityHash:'identity_hash',scopeId:'scope_id'}},
  {source:H.version,table:'import_history_versions',filters:{recordId:'record_id',revision:'revision'}},
  {source:H.segments,table:'import_history_segments',filters:{recordId:'record_id',revision:'revision'}},
  {source:H.references,table:'import_history_references',filters:{recordId:'record_id',revision:'revision'}},
].map(entry => Object.freeze({...entry,batch:def({id:'sales-article-workspace.batch-'+entry.source.id,
  operation:'queryAll',parameters:{requests:'json'},columns:{batchOrdinal:'safe_integer',...entry.source.columns}})})));
module.exports = { search, count, revisions, segments, notes, articleStock, readerBatches };
