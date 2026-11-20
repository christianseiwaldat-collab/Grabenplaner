'use strict';
const H=require('../../../tradefoto-history-profiles');
const W=require('../../statements/sales-article-workspace');
const {stockCandidates}=require('../../../sales-article-report-statements');
const {definePersistenceStatement}=require('../../contract');
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

// Fetch each side through its reference index. Joining those sets before the
// snapshot lookup avoids a branch index probe for every historical reference.
const reportStockCandidates=Object.freeze({statement:stockCandidates,returning:false,
 parameterOrder:['articles','locations','scopeId','snapshot','after','limit'],
 sql:`WITH article_refs AS MATERIALIZED (
  SELECT a.record_id,a.revision FROM integration.import_history_references a
  WHERE a.role='article' AND a.record_id>$5
   AND a.master_record_id IN (SELECT value FROM jsonb_array_elements_text($1::jsonb))
 ), branch_refs AS MATERIALIZED (
  SELECT l.record_id,l.revision FROM integration.import_history_references l
  WHERE l.role='location.filialid' AND l.record_id>$5
   AND l.master_record_id IN (SELECT value FROM jsonb_array_elements_text($2::jsonb))
 ), candidates AS MATERIALIZED (
  SELECT DISTINCT a.record_id,a.revision FROM article_refs a
  JOIN branch_refs l ON l.record_id=a.record_id AND l.revision=a.revision
 )
 SELECT chosen.id,chosen.revision FROM candidates q CROSS JOIN LATERAL (
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
 ) chosen ORDER BY chosen.id LIMIT $6`});

const publishedReportStock=Object.freeze({statement:definePersistenceStatement({
 id:'sales-article-report.published-stock',operation:'queryAll',
 parameters:{keys:'json',articles:'json',location:'text',scopeId:'text',snapshot:'text'},columns:{id:'text',revision:'safe_integer'}
}),returning:false,parameterOrder:['keys','articles','location','scopeId','snapshot'],
 sql:`SELECT chosen.id,chosen.revision FROM jsonb_array_elements_text($1::jsonb) wanted(identity_hash)
 CROSS JOIN LATERAL (
 SELECT r.id,m.revision FROM integration.import_history_records r
 JOIN integration.import_history_snapshot_members m ON m.run_id=$5 AND m.record_id=r.id
 JOIN integration.import_history_snapshots h ON h.run_id=m.run_id
 JOIN integration.import_history_versions v ON v.record_id=m.record_id AND v.revision=m.revision
 JOIN integration.import_history_references a ON a.record_id=m.record_id AND a.revision=m.revision AND a.role='article'
 JOIN integration.import_history_references l ON l.record_id=m.record_id AND l.revision=m.revision AND l.role='location.filialid'
 WHERE r.identity_hash=wanted.identity_hash AND h.scope_id=$4 AND h.source_instance='tradefoto-trade' AND h.status='published'
  AND r.scope_id=h.scope_id AND r.source_instance=h.source_instance AND r.profile_hash=h.profile_hash
  AND r.source='trade' AND r.source_table='ARTIKEL_FILIALEN'
  AND a.master_record_id IN (SELECT value FROM jsonb_array_elements_text($2::jsonb))
  AND l.master_record_id=$3 OFFSET 0
 ) chosen ORDER BY chosen.id`});
module.exports={articleStock,reportStockCandidates,publishedReportStock};
