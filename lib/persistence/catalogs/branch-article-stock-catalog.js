'use strict';
const { articleStock, branchStock, articleBranchStock } = require('../statements/branch-article-stock');
const { stockSnapshotSelection } = require('./history-snapshot-selection');
const BRANCH_ARTICLE_STOCK_CATALOG = Object.freeze([{ statement: articleStock, returning: false,
  sql: `SELECT r.id,chosen.revision FROM import_history_references q
    JOIN (${stockSnapshotSelection()}) chosen ON chosen.id=q.record_id AND chosen.revision=q.revision
    JOIN import_history_records r ON r.id=chosen.id
    WHERE (q.lookup_hash=$articleHash OR q.master_record_id=$masterRecordId) AND q.role='article' AND r.scope_id=$scopeId
      AND r.source_instance=$sourceInstance AND r.source='trade' AND r.source_table='ARTIKEL_FILIALEN'
      ORDER BY r.id LIMIT $limit` },
 {statement:branchStock,returning:false,sql:`SELECT DISTINCT r.id,chosen.revision FROM import_history_references q
  JOIN (${stockSnapshotSelection({sourceInstance:"'tradefoto-trade'"})}) chosen ON chosen.id=q.record_id AND chosen.revision=q.revision
  JOIN import_history_records r ON r.id=chosen.id
  WHERE (q.lookup_hash=$locationHash OR q.master_record_id IN (${Array.from({length:32},(_,i)=>'$master'+i).join(',')}))
   AND q.role='location.filialid' AND r.scope_id=$scopeId AND r.source_instance='tradefoto-trade'
   AND r.source='trade' AND r.source_table='ARTIKEL_FILIALEN' AND r.id>$after ORDER BY r.id LIMIT $limit` },
 {statement:articleBranchStock,returning:false,sql:`SELECT DISTINCT r.id,chosen.revision FROM import_history_references a
  JOIN import_history_references l ON l.record_id=a.record_id AND l.revision=a.revision
  JOIN (${stockSnapshotSelection({sourceInstance:"'tradefoto-trade'"})}) chosen ON chosen.id=a.record_id AND chosen.revision=a.revision
  JOIN import_history_records r ON r.id=chosen.id
  WHERE a.role='article' AND a.master_record_id=$articleMaster AND l.role='location.filialid' AND l.master_record_id=$locationMaster
   AND r.scope_id=$scopeId AND r.source_instance='tradefoto-trade' AND r.source='trade' AND r.source_table='ARTIKEL_FILIALEN'
   ORDER BY r.id LIMIT 2` }]);
module.exports = { BRANCH_ARTICLE_STOCK_CATALOG };
