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
 {statement:stockCandidates,returning:false,sql:`SELECT DISTINCT r.id,a.revision FROM import_history_references a
 CROSS JOIN import_history_references l CROSS JOIN import_history_records r
 WHERE l.record_id=a.record_id AND l.revision=a.revision AND r.id=a.record_id
 AND a.role='article' AND a.master_record_id IN (SELECT value FROM json_each($articles))
 AND l.role='location.filialid' AND l.master_record_id IN (SELECT value FROM json_each($locations))
 AND r.scope_id=$scopeId AND r.source_instance='tradefoto-trade'
 AND r.source='trade' AND r.source_table='ARTIKEL_FILIALEN'
 AND EXISTS (${require('./persistence/sqlite/history-snapshot-selection').stockSnapshotSelection({sourceInstance:"'tradefoto-trade'",candidate:'a'})})
 AND r.id>$after ORDER BY r.id LIMIT $limit`}]);
function postgresql(){return sqlite.map(entry=>{const compiled=require('./persistence/postgresql/sales/catalog').compileSalesEntry(entry,8).providerEntry;
 let sql=compiled.sql;for(const [index,binding] of compiled.parameterBindings.entries()){if(!['keys','articles','locations'].includes(binding.parameter))continue;const slot='$'+(index+1),old=`gp . json_each ( ( ${slot} :: text ) )`;
  if(!sql.includes(old))throw new Error('Article report membership predicate requires review');sql=sql.replace(old,`jsonb_array_elements_text(${slot}::jsonb)`);}
 if(entry.statement===stockCandidates){
  const slot=name=>'$'+(compiled.parameterBindings.findIndex(binding=>binding.parameter===name)+1);
  const membership=require('./persistence/postgresql/sales/layout').qualify(
   require('./persistence/sqlite/history-snapshot-selection').stockCandidateMembership({sourceInstance:"'tradefoto-trade'"})
    .replace(/\$(scopeId|snapshot)\b/g,(_,name)=>`(${slot(name)}::text)`));
  // PostgreSQL otherwise estimates both JSON lists as 100 values and may start
  // with every record in a branch. Materialize the bounded article references
  // first, before the authenticated source-membership checks and version reads.
  sql=`WITH reference_candidates AS MATERIALIZED (
   SELECT record_id,revision FROM integration.import_history_references
   WHERE role='article' AND master_record_id IN (SELECT value FROM jsonb_array_elements_text(${slot('articles')}::jsonb))
    AND record_id>${slot('after')}::text
   INTERSECT
   SELECT record_id,revision FROM integration.import_history_references
   WHERE role='location.filialid' AND master_record_id IN (SELECT value FROM jsonb_array_elements_text(${slot('locations')}::jsonb))
    AND record_id>${slot('after')}::text
  ), stock_records AS MATERIALIZED (
   SELECT a.record_id,a.revision,r.revision AS current_revision,r.profile_hash
   FROM reference_candidates a JOIN integration.import_history_records r ON r.id=a.record_id
   WHERE r.scope_id=${slot('scopeId')}::text AND r.source_instance='tradefoto-trade'
    AND r.source='trade' AND r.source_table='ARTIKEL_FILIALEN'
  ), stock_candidates AS MATERIALIZED (
   SELECT a.record_id,a.revision,a.current_revision,a.profile_hash,v.run_id,v.file_sha256
   FROM stock_records a JOIN integration.import_history_versions v ON v.record_id=a.record_id AND v.revision=a.revision
  ) SELECT a.record_id::text AS "id",a.revision AS "revision" FROM stock_candidates a
   WHERE ${membership}
   ORDER BY "id" LIMIT ${slot('limit')}::bigint`;
 }
 return {...compiled,sql};});}
module.exports={catalog,stockCandidates,sqlite,postgresql};
