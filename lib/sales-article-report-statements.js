'use strict';
const {definePersistenceStatement}=require('./persistence/contract');
const A=require('./persistence/statements/sales-article-catalog').SALES_ARTICLE_CATALOG_STATEMENTS;
// Immutable source membership joins the CURRENT accepted catalog projection.
// A manually changed visible article number is never used as a source key.
const catalog=definePersistenceStatement({id:'sales-article-report.catalog',operation:'queryAll',parameters:{keys:'json',limit:'safe_integer'},columns:{sourceArticleKey:'text',...A.search.columns}});
const stockCandidates=definePersistenceStatement({id:'sales-article-report.stock-candidates',operation:'queryAll',parameters:{articles:'json',locations:'json',scopeId:'text',snapshot:'text',after:'text',limit:'safe_integer'},columns:{id:'text',revision:'safe_integer'}});
const snake=id=>id.replace(/[A-Z]/g,c=>'_'+c.toLowerCase());
const sqlite=Object.freeze([{statement:catalog,returning:false,sql:`SELECT a.source_article_key AS sourceArticleKey,
 ${Object.keys(A.search.columns).map(id=>`p.${snake(id)} AS "${id}"`).join(', ')}
 FROM sales_articles a JOIN sales_article_search_projection p ON p.product_id=a.product_id
 WHERE a.source_system='tradefoto.artikel_stamm' AND a.source_article_key IN (SELECT value FROM json_each($keys))
 ORDER BY a.source_article_key LIMIT $limit`},
 // CROSS JOIN retains the selective article-reference first on SQLite;
 // PostgreSQL may reorder the same relational predicates using its statistics.
 {statement:stockCandidates,returning:false,sql:`SELECT DISTINCT r.id,r.revision FROM import_history_references a
 CROSS JOIN import_history_references l CROSS JOIN import_history_records r CROSS JOIN import_history_versions v
 WHERE l.record_id=a.record_id AND l.revision=a.revision AND r.id=a.record_id AND r.revision=a.revision
 AND v.record_id=r.id AND v.revision=r.revision
 AND a.role='article' AND a.master_record_id IN (SELECT value FROM json_each($articles))
 AND l.role='location.filialid' AND l.master_record_id IN (SELECT value FROM json_each($locations))
 AND r.scope_id=$scopeId AND r.source_instance='tradefoto-trade'
 AND r.source='trade' AND r.source_table='ARTIKEL_FILIALEN'
 AND v.file_sha256=$snapshot AND r.id>$after ORDER BY r.id LIMIT $limit`}]);
function postgresql(){return sqlite.map(entry=>{const compiled=require('./persistence/postgresql/sales/catalog').compileSalesEntry(entry,8).providerEntry;
 let sql=compiled.sql;for(const [index,binding] of compiled.parameterBindings.entries()){if(!['keys','articles','locations'].includes(binding.parameter))continue;const slot='$'+(index+1),old=`gp . json_each ( ( ${slot} :: text ) )`;
  if(!sql.includes(old))throw new Error('Article report membership predicate requires review');sql=sql.replace(old,`jsonb_array_elements_text(${slot}::jsonb)`);}
 return {...compiled,sql};});}
module.exports={catalog,stockCandidates,sqlite,postgresql};
