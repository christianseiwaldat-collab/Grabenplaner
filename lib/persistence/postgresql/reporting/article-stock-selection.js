'use strict';
const H=require('../../../tradefoto-history-profiles');
const W=require('../../statements/sales-article-workspace');
const legacy=H.profilesFor('trade','ARTIKEL_FILIALEN').filter(p=>!H.usesSnapshotMembership(p));
if(legacy.length!==1)throw new Error('Article stock legacy profile requires qualification');
// Resolve the article's indexed references before entering either snapshot
// representation. The lateral fence keeps PostgreSQL from expanding the whole
// published stock snapshot and only then applying a single article's keys.
const articleStock=Object.freeze({statement:W.articleStock,returning:false,
 parameterOrder:['scopeId','sourceInstance','snapshot','articleHash','masterRecordId','limit'],
 sql:`WITH candidates AS MATERIALIZED (
  SELECT DISTINCT record_id,revision FROM integration.import_history_references
  WHERE role='article' AND (lookup_hash=$4 OR master_record_id=$5)
 )
 SELECT chosen.id,chosen.revision FROM candidates q CROSS JOIN LATERAL (
  SELECT r.id,m.revision FROM integration.import_history_snapshot_members m
  JOIN integration.import_history_snapshots h ON h.run_id=m.run_id
  JOIN integration.import_history_records r ON r.id=m.record_id
  JOIN integration.import_history_versions v ON v.record_id=m.record_id AND v.revision=m.revision
  WHERE m.run_id=$3 AND m.record_id=q.record_id AND m.revision=q.revision
   AND h.scope_id=$1 AND h.source_instance=$2 AND h.status='published'
   AND r.scope_id=h.scope_id AND r.source_instance=h.source_instance AND r.profile_hash=h.profile_hash
   AND r.source='trade' AND r.source_table='ARTIKEL_FILIALEN'
  UNION ALL
  SELECT r.id,r.revision FROM integration.import_history_records r
  JOIN integration.import_history_versions v ON v.record_id=r.id AND v.revision=r.revision
  WHERE r.id=q.record_id AND r.revision=q.revision AND r.scope_id=$1 AND r.source_instance=$2
   AND r.source='trade' AND r.source_table='ARTIKEL_FILIALEN' AND r.profile_hash='${legacy[0].fingerprint}'
   AND (v.run_id=$3 OR v.file_sha256=$3)
   AND NOT EXISTS(SELECT 1 FROM integration.import_history_snapshots h
    WHERE h.scope_id=$1 AND h.source_instance=$2 AND (h.run_id=$3 OR h.file_sha256=$3))
  OFFSET 0
 ) chosen ORDER BY chosen.id LIMIT $6`});
module.exports={articleStock};
