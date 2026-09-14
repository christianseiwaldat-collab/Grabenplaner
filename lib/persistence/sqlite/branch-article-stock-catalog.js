'use strict';
const { articleStock } = require('../statements/branch-article-stock');
const BRANCH_ARTICLE_STOCK_CATALOG = Object.freeze([{ statement: articleStock, returning: false,
  sql: `SELECT r.id FROM import_history_references q
    JOIN import_history_records r ON r.id=q.record_id AND r.revision=q.revision
    JOIN import_history_versions v ON v.record_id=r.id AND v.revision=r.revision
    WHERE (q.lookup_hash=$articleHash OR q.master_record_id=$masterRecordId) AND q.role='article' AND r.scope_id=$scopeId
      AND r.source_instance=$sourceInstance AND r.source='trade' AND r.source_table='ARTIKEL_FILIALEN'
      AND v.file_sha256=$snapshot ORDER BY r.id LIMIT $limit` }]);
module.exports = { BRANCH_ARTICLE_STOCK_CATALOG };
