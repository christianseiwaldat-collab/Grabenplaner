'use strict';
// Synthetic owned PostgreSQL fixture only. Unselected padding is deliberately
// not decryptable; the two returned stock records and their memberships are
// generated/authenticated through the real importer. Never use on business data.
const assert=require('node:assert/strict');
const C=require('../lib/data-import-contract'),H=require('../lib/tradefoto-history-profiles');
const headerContext=h=>['history-snapshot',h.runId,h.scopeId,h.sourceInstance,h.profileHash,h.fileSha256,h.snapshotAt,h.ownerId,h.expectedRows,h.status];
async function addArticleVolume(pg,f,{historyRows=2100000,snapshotRows=237630}={}){
 assert.equal(f.scopeId,'synthetic-migration');assert.ok(historyRows>=snapshotRows&&snapshotRows>2);
 const marker=(await pg.client.query('SELECT id FROM gp.migration_fixture_owner')).rows;
 assert.equal(marker.length,1);assert.match(marker[0].id,/^synthetic-sales-/);
 const old=(await pg.client.query("SELECT * FROM integration.import_history_snapshots WHERE status='published' ORDER BY run_id LIMIT 1")).rows[0];
 assert.equal(Number(old.expected_rows),2);
 const members=(await pg.client.query('SELECT * FROM integration.import_history_snapshot_members WHERE run_id=$1 ORDER BY row_number',[old.run_id])).rows;
 const profile=H.profileFor('trade','ARTIKEL_FILIALEN');
 const run=await f.engine.start({profileHash:profile.fingerprint,manifest:{sourceInstance:'tradefoto-trade',fileSha256:C.fingerprint('synthetic-article-volume'),schemaSha256:profile.schemaSha256,expectedRows:snapshotRows,declaredRows:snapshotRows,snapshotAt:'2026-10-16T10:00:00.000Z',gates:[]}});
 const saved=(await pg.client.query('SELECT manifest FROM integration.data_import_runs WHERE id=$1',[run.id])).rows[0].manifest;
 const manifest=typeof saved==='string'?JSON.parse(saved):saved;
 const h={runId:run.id,scopeId:f.scopeId,sourceInstance:manifest.sourceInstance,profileHash:profile.fingerprint,fileSha256:manifest.fileSha256,snapshotAt:manifest.snapshotAt,ownerId:f.ownerId,expectedRows:snapshotRows,status:'building'};
 await pg.client.query(`INSERT INTO integration.import_history_snapshots(run_id,scope_id,source_instance,profile_hash,file_sha256,snapshot_at,owner_id,expected_rows,status,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[h.runId,h.scopeId,h.sourceInstance,h.profileHash,h.fileSha256,h.snapshotAt,h.ownerId,h.expectedRows,h.status,pg.protection.seal({version:1},headerContext(h))]);
 const oldHeader={runId:old.run_id,scopeId:old.scope_id,sourceInstance:old.source_instance,profileHash:old.profile_hash,fileSha256:old.file_sha256,snapshotAt:old.snapshot_at,ownerId:old.owner_id,expectedRows:Number(old.expected_rows),status:'building'};
 for(const m of members){
  const data=pg.protection.open(m.payload,[...headerContext(oldHeader),'member',Number(m.row_number),m.record_id,Number(m.revision)]);
  await pg.client.query('INSERT INTO integration.import_history_snapshot_members VALUES($1,$2,$3,$4,$5)',[run.id,m.row_number,m.record_id,m.revision,pg.protection.seal(data,[...headerContext(h),'member',Number(m.row_number),m.record_id,Number(m.revision)])]);
 }
 await pg.client.query("SET statement_timeout='120s'");
 const start=performance.now();
 for(let from=3;from<=historyRows;from+=100000){
  const until=Math.min(historyRows,from+99999);
  await pg.client.query(`INSERT INTO integration.import_history_records SELECT 'volume-'||g,$3,'tradefoto-trade','trade',CASE WHEN g<=$5 THEN 'ARTIKEL_FILIALEN' ELSE 'WE' END,$4,md5('volume-'||g)||md5('identity-'||g),1 FROM generate_series($1::int,$2::int) g`,[from,until,f.scopeId,profile.fingerprint,snapshotRows]);
  await pg.client.query(`INSERT INTO integration.import_history_versions SELECT 'volume-'||g,1,v.file_sha256,v.snapshot_at,v.imported_by,v.imported_at,v.run_id,v.master_source_instance,NULL,NULL,NULL,v.payload FROM generate_series($1::int,$2::int) g CROSS JOIN integration.import_history_versions v WHERE v.record_id=$3 AND v.revision=1`,[from,until,members[0].record_id]);
  await pg.client.query(`INSERT INTO integration.import_history_references SELECT 'volume-'||g,1,'article','internal_business',NULL,md5('article-'||g)||md5('lookup-'||g) FROM generate_series($1::int,$2::int) g`,[from,until]);
  if(from<=snapshotRows)await pg.client.query(`INSERT INTO integration.import_history_snapshot_members SELECT $3,g,'volume-'||g,1,'synthetic-unselected-padding' FROM generate_series($1::int,$2::int) g`,[from,Math.min(until,snapshotRows),run.id]);
  console.log(JSON.stringify({volumePrepared:until,elapsedMs:Math.round(performance.now()-start)}));
 }
 for(const table of ['import_history_records','import_history_versions','import_history_references','import_history_snapshot_members','import_history_snapshots'])await pg.client.query('ANALYZE integration.'+table);
 const certifyStarted=performance.now();
 await pg.client.query("UPDATE integration.import_history_snapshots SET status='published',payload=$2 WHERE run_id=$1",[run.id,pg.protection.seal({version:1},headerContext({...h,status:'published'}))]);
 const certificationMs=performance.now()-certifyStarted;
 await pg.client.query("UPDATE integration.data_import_runs SET status='applied',received_count=$2 WHERE id=$1",[run.id,snapshotRows]);
 console.log(JSON.stringify({qualification:'synthetic-volume-ready',historyRows,snapshotRows,certificationMs}));
 return {run,historyRows,snapshotRows,certificationMs};
}
module.exports={addArticleVolume};
