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
  ...[[W.search,A.search],[W.count,A.countSearch]].map(([statement,base]) => ({statement,returning:false,
    sql:searchBase(base).replace(/\bWHERE\b/, 'WHERE ' + membership + ' AND')})),
  { statement:W.revisions, returning:false, sql:"SELECT id,revision,source_table AS sourceTable FROM import_master_records WHERE scope_id=$scopeId AND source_instance='tradefoto-trade' AND source_table IN ('ARTIKEL_STAMM','ARTIKEL_ZWEITLIEFERANT') AND id>$after ORDER BY id LIMIT $limit" },
  { statement:W.segments, returning:false, sql:"SELECT r.id,r.revision,r.source_table AS sourceTable,r.source_instance AS sourceInstance,r.identity_hash AS identityHash,r.profile_hash AS profileHash,s.kind,s.data_class AS dataClass,s.payload,p.payload AS provenancePayload FROM import_master_records r JOIN import_master_segments s ON s.record_id=r.id LEFT JOIN import_master_segments p ON p.record_id=r.id AND p.kind='provenance' AND p.data_class='internal_business' WHERE r.scope_id=$scopeId AND r.source_instance='tradefoto-trade' AND r.id IN (SELECT value FROM json_each($ids)) AND ((r.source_table='ARTIKEL_STAMM' AND s.kind='attributes' AND s.data_class='internal_business') OR (r.source_table='ARTIKEL_ZWEITLIEFERANT' AND s.kind='costs' AND s.data_class='catalog_costs'))" },
];
module.exports = { CATALOG, searchBase, membership };
