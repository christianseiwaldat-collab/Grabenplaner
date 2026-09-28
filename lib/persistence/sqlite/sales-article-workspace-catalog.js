'use strict';
const W = require('../statements/sales-article-workspace');
const { SALES_ARTICLE_CATALOG_STATEMENTS: A } = require('../statements/sales-article-catalog');
const { SQLITE_SALES_ARTICLE_CATALOG: entries } = require('./sales-article-catalog-catalog');
// New read statements leave the historically pinned import/search contracts intact.
function searchBase(statement) {
  const base = entries.find(e => e.statement === statement).sql;
  return base.replaceAll(/LOWER\(article.search_text\) LIKE LOWER\((\$query\d+)\) ESCAPE '!'/g,
    "(LOWER(article.search_text) LIKE LOWER($1) ESCAPE '!' OR EXISTS (SELECT 1 FROM sales_article_identifiers aliases WHERE aliases.product_id=article.product_id AND aliases.source_snapshot_id=article.source_snapshot_id AND aliases.identifier_value LIKE $1 ESCAPE '!'))");
}
const membership = "(CAST($orderKeys AS TEXT) IS NULL OR article.product_id IN (SELECT a.product_id FROM sales_articles a WHERE a.source_system='tradefoto.artikel_stamm' AND a.source_article_key IN (SELECT value FROM json_each($orderKeys))))";
const CATALOG = [
  // Resolve article references first; CROSS JOIN keeps SQLite from scanning every
  // branch-stock header before it checks the article relation. All scope/revision
  // predicates still apply to the exact same rows as the original stock lookup.
  {statement:W.articleStock,returning:false,sql:`SELECT r.id FROM
    (SELECT DISTINCT record_id,revision FROM import_history_references
      WHERE (lookup_hash=$articleHash OR master_record_id=$masterRecordId) AND role='article') q
    CROSS JOIN import_history_records r CROSS JOIN import_history_versions v
    WHERE r.id=q.record_id AND r.revision=q.revision AND v.record_id=r.id AND v.revision=r.revision
      AND r.scope_id=$scopeId AND r.source_instance=$sourceInstance AND r.source='trade' AND r.source_table='ARTIKEL_FILIALEN'
      AND v.file_sha256=$snapshot ORDER BY r.id LIMIT $limit`},
  ...W.readerBatches.map(({source,batch,table,filters}) => ({statement:batch,returning:false,
    sql:`SELECT request.key+1 AS batchOrdinal, ${Object.keys(source.columns).map(name => `r.${name.replace(/[A-Z]/g,c=>'_'+c.toLowerCase())} AS "${name}"`).join(', ')}
      FROM json_each($requests) request JOIN ${table} r ON ${Object.entries(filters).map(([name,column]) => `r.${column}=json_extract(request.value,'$.${name}')`).join(' AND ')} ORDER BY request.key`})),
  { statement:W.notes, returning:false, sql:`SELECT r.id,r.scope_id AS scopeId,r.source_instance AS sourceInstance,r.source_table AS sourceTable,
    r.profile_hash AS profileHash,r.identity_hash AS identityHash,r.revision,r.updated_by AS updatedBy,r.updated_at AS updatedAt
    FROM (SELECT DISTINCT l.record_id FROM import_master_relations l WHERE l.parent_table='ARTIKEL_STAMM' AND l.identity_hash=$articleIdentity) note
    JOIN import_master_records r ON r.id=note.record_id
    WHERE r.scope_id=$scopeId AND r.source_instance='tradefoto-trade' AND r.source_table='Artikel_Bemerkungen' AND r.id>$after
    ORDER BY r.id LIMIT $limit` },
  ...[[W.search,A.search],[W.count,A.countSearch]].map(([statement,base]) => ({statement,returning:false,
    sql:searchBase(base).replace(/\bWHERE\b/, 'WHERE ' + membership + ' AND')})),
  { statement:W.revisions, returning:false, sql:"SELECT id,revision,source_table AS sourceTable FROM import_master_records WHERE scope_id=$scopeId AND source_instance='tradefoto-trade' AND source_table IN ('ARTIKEL_STAMM','ARTIKEL_ZWEITLIEFERANT') AND id>$after ORDER BY id LIMIT $limit" },
  { statement:W.segments, returning:false, sql:"SELECT r.id,r.revision,r.source_table AS sourceTable,r.source_instance AS sourceInstance,r.identity_hash AS identityHash,r.profile_hash AS profileHash,s.kind,s.data_class AS dataClass,s.payload,p.payload AS provenancePayload FROM import_master_records r JOIN import_master_segments s ON s.record_id=r.id LEFT JOIN import_master_segments p ON p.record_id=r.id AND p.kind='provenance' AND p.data_class='internal_business' WHERE r.scope_id=$scopeId AND r.source_instance='tradefoto-trade' AND r.id IN (SELECT value FROM json_each($ids)) AND ((r.source_table='ARTIKEL_STAMM' AND s.kind='attributes' AND s.data_class='internal_business') OR (r.source_table='ARTIKEL_ZWEITLIEFERANT' AND s.kind='costs' AND s.data_class='catalog_costs'))" },
];
module.exports = { CATALOG, searchBase, membership };
