'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {snapshotFixture}=require('../test-support/article-stock-snapshots-fixture');
const {retireUnpublishedSnapshot}=require('../lib/persistence/postgresql/operations/import-retention');
const {S}=require('../lib/persistence/statements/import-history-snapshots');
const stock={EAN:'0000000000042',FilialID:18,FBestand:'2'};
function adapter(db){return {query:async(sql,args)=>{
 const parameters=[],query=sql.replaceAll('integration.','').replace(/\$(\d+)/g,(_match,index)=>{parameters.push(args[Number(index)-1]);return '?';});
 return {rowCount:db.prepare(query).run(...parameters).changes};
}};}
const source=f=>({row:{scope_id:f.scopeId,owner_id:f.ownerId}});

test('discarding an unpublished stock preview releases its holds but preserves published snapshots and foreign scope',async t=>{
 const f=await snapshotFixture(t),a=await f.ingest('ARTIKEL_FILIALEN',[stock]),b=await f.ready('ARTIKEL_FILIALEN',[stock]);
 const db=f.app.database,sales=adapter(db),initialHeader=await f.access.queryOne(S.get,{runId:a.id});
 const initialMember=db.prepare('SELECT * FROM import_history_snapshot_members WHERE run_id=?').get(a.id);
 await assert.rejects(f.undo(a),error=>error.code==='IMPORT_UNDO_DEPENDENCIES');
 for(const row of [{scope_id:'foreign-scope',owner_id:f.ownerId},{scope_id:f.scopeId,owner_id:'foreign-owner'}]){
  await retireUnpublishedSnapshot(sales,{row},b);
  assert.equal((await f.access.queryOne(S.get,{runId:b.id})).status,'building');
 }
 // Even a mismatched requested run status may never remove a published header.
 await retireUnpublishedSnapshot(sales,source(f),{id:a.id,status:'ready'});
 await retireUnpublishedSnapshot(sales,source(f),a);
 assert.deepEqual(await f.access.queryOne(S.get,{runId:a.id}),initialHeader);
 assert.deepEqual(db.prepare('SELECT * FROM import_history_snapshot_members WHERE run_id=?').get(a.id),initialMember);
 db.exec('BEGIN');
 try {await retireUnpublishedSnapshot(sales,source(f),b);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
 assert.equal(await f.access.queryOne(S.get,{runId:b.id}),null);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM import_history_snapshot_members WHERE run_id=?').get(b.id).n,0);
 await retireUnpublishedSnapshot(sales,source(f),b);
 assert.equal((await f.list(a)).items.length,1);
 await f.undo(a);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM import_history_records').get().n,0);
});

test('a failed final retirement transaction restores the unpublished membership and its dependency protection',async t=>{
 const f=await snapshotFixture(t),a=await f.ingest('ARTIKEL_FILIALEN',[stock]),b=await f.ready('ARTIKEL_FILIALEN',[stock]);
 const db=f.app.database,sales=adapter(db),before=db.prepare('SELECT * FROM import_history_snapshot_members WHERE run_id=?').get(b.id);
 db.exec('BEGIN');await retireUnpublishedSnapshot(sales,source(f),b);db.exec('ROLLBACK');
 assert.equal((await f.access.queryOne(S.get,{runId:b.id})).status,'building');
 assert.deepEqual(db.prepare('SELECT * FROM import_history_snapshot_members WHERE run_id=?').get(b.id),before);
 await assert.rejects(f.undo(a),error=>error.code==='IMPORT_UNDO_DEPENDENCIES');
});
