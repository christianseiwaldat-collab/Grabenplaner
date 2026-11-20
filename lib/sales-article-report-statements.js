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
 {statement:stockCandidates,returning:false,sql:`SELECT DISTINCT r.id,chosen.revision FROM import_history_references a
 CROSS JOIN import_history_references l CROSS JOIN import_history_records r
 CROSS JOIN (${require('./persistence/catalogs/history-snapshot-selection').stockSnapshotSelection({sourceInstance:"'tradefoto-trade'"})}) chosen
 WHERE l.record_id=a.record_id AND l.revision=a.revision AND r.id=a.record_id
 AND chosen.id=r.id AND chosen.revision=a.revision
 AND a.role='article' AND a.master_record_id IN (SELECT value FROM json_each($articles))
 AND l.role='location.filialid' AND l.master_record_id IN (SELECT value FROM json_each($locations))
 AND r.scope_id=$scopeId AND r.source_instance='tradefoto-trade'
 AND r.source='trade' AND r.source_table='ARTIKEL_FILIALEN'
 AND r.id>$after ORDER BY r.id LIMIT $limit`}]);
function nativeStockCandidates(){
 const H=require('./tradefoto-history-profiles'),legacy=H.profilesFor('trade','ARTIKEL_FILIALEN').filter(p=>!H.usesSnapshotMembership(p));
 if(legacy.length!==1)throw new Error('Article report legacy profile requires qualification');
 // As in reporting/article-stock-selection, resolve indexed references before
 // entering the snapshot UNION. OFFSET 0 retains the per-candidate lateral
 // lookup instead of expanding the entire published snapshot for every batch.
 const parameterOrder=['articles','locations','scopeId','snapshot','after','limit'];
 return {statement:stockCandidates,returning:false,parameterOrder,parameterBindings:parameterOrder.map(parameter=>({parameter,source:'value',path:[]})),
 sql:`WITH candidates AS MATERIALIZED (
  SELECT DISTINCT a.record_id,a.revision FROM integration.import_history_references a
  JOIN integration.import_history_references l ON l.record_id=a.record_id AND l.revision=a.revision
  WHERE a.role='article' AND a.master_record_id IN (SELECT value FROM jsonb_array_elements_text($1::jsonb))
   AND l.role='location.filialid' AND l.master_record_id IN (SELECT value FROM jsonb_array_elements_text($2::jsonb))
   AND a.record_id>$5
 ) SELECT chosen.id,chosen.revision FROM candidates q CROSS JOIN LATERAL (
  SELECT r.id,m.revision FROM integration.import_history_snapshot_members m
  JOIN integration.import_history_snapshots h ON h.run_id=m.run_id
  JOIN integration.import_history_records r ON r.id=m.record_id
  JOIN integration.import_history_versions v ON v.record_id=m.record_id AND v.revision=m.revision
  WHERE m.run_id=$4 AND m.record_id=q.record_id AND m.revision=q.revision
   AND h.scope_id=$3 AND h.source_instance='tradefoto-trade' AND h.status='published'
   AND r.scope_id=h.scope_id AND r.source_instance=h.source_instance AND r.profile_hash=h.profile_hash
   AND r.source='trade' AND r.source_table='ARTIKEL_FILIALEN'
  UNION ALL
  SELECT r.id,r.revision FROM integration.import_history_records r
  JOIN integration.import_history_versions v ON v.record_id=r.id AND v.revision=r.revision
  WHERE r.id=q.record_id AND r.revision=q.revision AND r.scope_id=$3 AND r.source_instance='tradefoto-trade'
   AND r.source='trade' AND r.source_table='ARTIKEL_FILIALEN' AND r.profile_hash='${legacy[0].fingerprint}'
   AND (v.run_id=$4 OR v.file_sha256=$4)
   AND NOT EXISTS (SELECT 1 FROM integration.import_history_snapshots h WHERE h.scope_id=$3
    AND h.source_instance='tradefoto-trade' AND (h.run_id=$4 OR h.file_sha256=$4))
  OFFSET 0
 ) chosen ORDER BY chosen.id LIMIT $6`};
}
function postgresql(){return sqlite.map(entry=>{if(entry.statement===stockCandidates)return nativeStockCandidates();const compiled=require('./persistence/postgresql/sales/catalog').compileSalesEntry(entry,8).providerEntry;
 let sql=compiled.sql;for(const [index,binding] of compiled.parameterBindings.entries()){if(!['keys','articles','locations'].includes(binding.parameter))continue;const slot='$'+(index+1),old=`gp . json_each ( ( ${slot} :: text ) )`;
  if(!sql.includes(old))throw new Error('Article report membership predicate requires review');sql=sql.replace(old,`jsonb_array_elements_text(${slot}::jsonb)`);}
 return {...compiled,sql};});}
module.exports={catalog,stockCandidates,sqlite,postgresql};
