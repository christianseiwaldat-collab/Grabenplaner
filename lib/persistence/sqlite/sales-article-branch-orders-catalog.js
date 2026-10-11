'use strict';
const { ARTICLE_BRANCH_ORDER_STATEMENTS: S } = require('../statements/sales-article-branch-orders');
const ARTICLE_BRANCH_ORDERS_CATALOG = Object.freeze([
  { statement: S.articleLinks, returning:false, sql:`SELECT l.source_article_key AS sourceArticleKey,a.product_id AS productId,a.article_number AS articleNumber
    FROM sales_article_source_links l JOIN sales_articles a ON a.product_id=l.product_id
    WHERE l.source_system=$sourceSystem AND l.source_article_key IN (SELECT value FROM json_each($sourceKeys))` },
  { statement: S.page, returning: false, sql: `SELECT r.id,r.revision
    FROM import_history_references q CROSS JOIN import_history_records r
    WHERE q.master_record_id IN (${Array.from({length:14},(_,i)=>'$master'+(i+1)).join(',')}) AND q.role='article'
      AND r.id=q.record_id AND r.revision=q.revision AND r.scope_id=$scopeId
      AND r.source_instance='tradefoto-bestell' AND r.source='trade'
      AND r.source_table IN ('BESTELLDETAILS','BestellVerteilung') AND r.id>$after
    ORDER BY r.id LIMIT CASE WHEN $limit BETWEEN 1 AND 101 THEN $limit ELSE 0 END` },
  // The existing master-reference index resolves this article before the current
  // record join. Unchanged keyed imports deliberately retain older provenance.
  { statement: S.candidates, returning: false, sql: `SELECT r.id,r.revision
    FROM import_history_references q CROSS JOIN import_history_records r
    WHERE q.master_record_id=$articleMaster AND q.role='article'
      AND r.id=q.record_id AND r.revision=q.revision AND r.scope_id=$scopeId
      AND r.source_instance='tradefoto-bestell' AND r.source='trade'
      AND r.source_table IN ('BESTELLDETAILS','BestellVerteilung')
    ORDER BY r.id LIMIT CASE WHEN $limit BETWEEN 1 AND 401 THEN $limit ELSE 0 END` },
  // Trusted callers validate and split requests into packets of at most 200.
  // Match the existing reader-batch convention: one-based ordinals, missing rows omitted.
  { statement: S.internalSegments, returning: false, sql: `SELECT request.key+1 AS batchOrdinal,
    s.record_id AS recordId,s.revision,s.data_class AS dataClass,s.payload
    FROM json_each($requests) request JOIN import_history_segments s
      ON s.record_id=json_extract(request.value,'$.recordId')
      AND s.revision=json_extract(request.value,'$.revision')
    WHERE s.data_class='internal_business' ORDER BY request.key` },
]);
module.exports = { ARTICLE_BRANCH_ORDERS_CATALOG };
