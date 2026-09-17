'use strict';
const W = require('../../statements/sales-article-workspace');
const { SALES_ARTICLE_CATALOG_STATEMENTS: A } = require('../../statements/sales-article-catalog');
const { searchBase, CATALOG: source } = require('../../sqlite/sales-article-workspace-catalog');
const { compileSalesEntry } = require('../sales/catalog');
const { relation } = require('../sales/layout');
const CATALOG = [[W.search,A.search],[W.count,A.countSearch]].map(([statement,base]) => {
  const compiled = compileSalesEntry({statement:base,sql:searchBase(base),returning:false},8).providerEntry;
  const parameter = '$' + (compiled.parameterBindings.length + 1);
  const filter = '(' + parameter + '::jsonb IS NULL OR article.product_id IN (SELECT a.product_id FROM '
    + relation('sales_articles') + " a WHERE a.source_system='tradefoto.artikel_stamm' AND a.source_article_key IN (SELECT value FROM jsonb_array_elements_text("
    + parameter + '::jsonb))))';
  return {...compiled,statement,sql:compiled.sql.replace(/\bWHERE\b/i,'WHERE ' + filter + ' AND'),
    parameterOrder:[...compiled.parameterOrder,'orderKeys'],
    parameterBindings:[...compiled.parameterBindings,{parameter:'orderKeys',source:'value',path:[]}]};
});
CATALOG.push(compileSalesEntry(source.find(e => e.statement === W.revisions),8).providerEntry);
CATALOG.push({statement:W.segments,returning:false,parameterOrder:['scopeId','ids'],
  sql:'SELECT r.id,r.revision,r.source_table AS "sourceTable",r.source_instance AS "sourceInstance",r.identity_hash AS "identityHash",r.profile_hash AS "profileHash",s.kind,s.data_class AS "dataClass",s.payload,p.payload AS "provenancePayload" FROM '
    + relation('import_master_records') + ' r JOIN ' + relation('import_master_segments')
    + " s ON s.record_id=r.id LEFT JOIN " + relation('import_master_segments') + " p ON p.record_id=r.id AND p.kind='provenance' AND p.data_class='internal_business' WHERE r.scope_id=$1 AND r.source_instance='tradefoto-trade' AND r.id IN (SELECT value FROM jsonb_array_elements_text($2::jsonb)) AND ((r.source_table='ARTIKEL_STAMM' AND s.kind='attributes' AND s.data_class='internal_business') OR (r.source_table='ARTIKEL_ZWEITLIEFERANT' AND s.kind='costs' AND s.data_class='catalog_costs'))"});
module.exports = { CATALOG };
