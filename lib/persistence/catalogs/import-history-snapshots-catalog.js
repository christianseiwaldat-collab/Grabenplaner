'use strict';
const {S,HEADER,MEMBER}=require('../statements/import-history-snapshots');
const snake=n=>n.replace(/[A-Z]/g,c=>'_'+c.toLowerCase());
const select=columns=>Object.keys(columns).map(n=>`${snake(n)} AS "${n}"`).join(',');
const entry=(statement,sql)=>Object.freeze({statement,sql,returning:false});
const CATALOG=Object.freeze([
 entry(S.get,`SELECT ${select(HEADER)},'scan' AS publicationCheck,0 AS coverageVerified FROM import_history_snapshots WHERE run_id=$runId`),
 entry(S.insert,`INSERT INTO import_history_snapshots(${Object.keys(HEADER).map(snake).join(',')}) VALUES(${Object.keys(HEADER).map(n=>'$'+n).join(',')})`),
 entry(S.transition,'UPDATE import_history_snapshots SET status=$status,payload=$payload WHERE run_id=$runId AND status=$expectedStatus'),
 entry(S.member,`SELECT ${select(MEMBER)} FROM import_history_snapshot_members WHERE run_id=$runId AND record_id=$recordId`),
 entry(S.membersPut,`INSERT INTO import_history_snapshot_members(${Object.keys(MEMBER).map(snake).join(',')})
 SELECT ${Object.keys(MEMBER).map(n=>`json_extract(value,'$.${n}')`).join(',')} FROM json_each($rows)
 WHERE EXISTS(SELECT 1 FROM import_history_snapshots s WHERE s.run_id=json_extract(value,'$.runId') AND s.status='building')
 ON CONFLICT(run_id,row_number) DO UPDATE SET record_id=excluded.record_id,revision=excluded.revision,payload=excluded.payload`),
 entry(S.membersClear,'DELETE FROM import_history_snapshot_members WHERE run_id=$runId'),
 entry(S.coverage,`SELECT COUNT(*) AS count,COALESCE(MIN(m.row_number),0) AS first,COALESCE(MAX(m.row_number),0) AS last,
 COALESCE(SUM(CASE WHEN r.scope_id=s.scope_id AND r.source_instance=s.source_instance AND r.profile_hash=s.profile_hash
  AND r.source='trade' AND r.source_table='ARTIKEL_FILIALEN' AND v.record_id IS NOT NULL THEN 1 ELSE 0 END),0) AS qualified
 FROM import_history_snapshot_members m JOIN import_history_snapshots s ON s.run_id=m.run_id
 LEFT JOIN import_history_records r ON r.id=m.record_id
 LEFT JOIN import_history_versions v ON v.record_id=m.record_id AND v.revision=m.revision WHERE m.run_id=$runId`),
 entry(S.dependencies,`SELECT COUNT(*) AS count FROM import_history_snapshot_members m JOIN import_history_snapshots s ON s.run_id=m.run_id
 WHERE m.record_id=$recordId AND m.revision>=$fromRevision AND m.run_id<>$runId AND s.status<>'withdrawn'`),
 entry(S.deleteMembers,`DELETE FROM import_history_snapshot_members WHERE run_id=$runId AND EXISTS(
 SELECT 1 FROM import_history_snapshots s WHERE s.run_id=$runId AND s.scope_id=$scopeId AND s.owner_id=$ownerId AND s.status<>'published')`),
 entry(S.deleteHeader,"DELETE FROM import_history_snapshots WHERE run_id=$runId AND scope_id=$scopeId AND owner_id=$ownerId AND status<>'published'"),
]);
module.exports={CATALOG,SQLITE_IMPORT_HISTORY_SNAPSHOTS_CATALOG:CATALOG};
