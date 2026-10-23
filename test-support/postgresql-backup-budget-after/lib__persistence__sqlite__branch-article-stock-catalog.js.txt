'use strict';
const { articleStock, branchStock, articleBranchStock } = require('../statements/branch-article-stock');
const BRANCH_ARTICLE_STOCK_CATALOG = Object.freeze([{ statement: articleStock, returning: false,
  sql: `SELECT r.id FROM import_history_references q
    JOIN import_history_records r ON r.id=q.record_id AND r.revision=q.revision
    JOIN import_history_versions v ON v.record_id=r.id AND v.revision=r.revision
    WHERE (q.lookup_hash=$articleHash OR q.master_record_id=$masterRecordId) AND q.role='article' AND r.scope_id=$scopeId
      AND r.source_instance=$sourceInstance AND r.source='trade' AND r.source_table='ARTIKEL_FILIALEN'
      AND v.file_sha256=$snapshot ORDER BY r.id LIMIT $limit` },
 {statement:branchStock,returning:false,sql:`SELECT DISTINCT r.id,r.revision FROM import_history_references q
  JOIN import_history_records r ON r.id=q.record_id AND r.revision=q.revision
  JOIN import_history_versions v ON v.record_id=r.id AND v.revision=r.revision
  WHERE (q.lookup_hash=$locationHash OR q.master_record_id IN (${Array.from({length:32},(_,i)=>'$master'+i).join(',')}))
   AND q.role='location.filialid' AND r.scope_id=$scopeId AND r.source_instance='tradefoto-trade'
   AND r.source='trade' AND r.source_table='ARTIKEL_FILIALEN' AND v.file_sha256=$snapshot AND r.id>$after ORDER BY r.id LIMIT $limit` },
 {statement:articleBranchStock,returning:false,sql:`SELECT DISTINCT r.id,r.revision FROM import_history_references a
  JOIN import_history_references l ON l.record_id=a.record_id AND l.revision=a.revision
  JOIN import_history_records r ON r.id=a.record_id AND r.revision=a.revision
  JOIN import_history_versions v ON v.record_id=r.id AND v.revision=r.revision
  WHERE a.role='article' AND a.master_record_id=$articleMaster AND l.role='location.filialid' AND l.master_record_id=$locationMaster
   AND r.scope_id=$scopeId AND r.source_instance='tradefoto-trade' AND r.source='trade' AND r.source_table='ARTIKEL_FILIALEN'
   AND v.file_sha256=$snapshot ORDER BY r.id LIMIT 2` }]);
module.exports = { BRANCH_ARTICLE_STOCK_CATALOG };
