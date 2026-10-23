'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {snapshotFixture}=require('../test-support/article-stock-snapshots-fixture');
const H=require('../lib/tradefoto-history-profiles');
const {S}=require('../lib/persistence/statements/import-history-snapshots');
const {IMPORT_HISTORY_STATEMENTS:HS}=require('../lib/persistence/statements/import-history');
const stock=(EAN='0000000000042',FilialID=18,FBestand='2')=>({EAN,FilialID,FBestand,Bestellt:'0'});
const error=expected=>e=>e.code===expected;
async function seed(f){await f.ingest('ARTIKEL_STAMM',[{EAN:'0000000000042'},{EAN:'0000000000043'}],{master:true});await f.ingest('FILIALEN',[{FilialID:'18'},{FilialID:'19'}],{master:true});}
const count=(f,table)=>f.app.database.prepare('SELECT COUNT(*) AS n FROM '+table).get().n;
test('stock snapshots reuse identical versions across new files and preserve exact historical revisions',async t=>{
 const f=await snapshotFixture(t);await seed(f);
 const values=[stock(),stock('0000000000043',19,'7')],a=await f.ingest('ARTIKEL_FILIALEN',values);
 const initial=await f.list(a),versions=count(f,'import_history_versions');
 const ready=await f.ready('ARTIKEL_FILIALEN',values.slice().reverse());assert.equal(ready.counts.unchanged,2);
 await assert.rejects(f.list(ready),error('IMPORT_HISTORY_SNAPSHOT_UNPUBLISHED'));
 const b=await f.apply(ready);assert.equal(count(f,'import_history_versions'),versions);
 const second=await f.list(b);assert.deepEqual(second.items.map(v=>[v.id,v.revision]).sort(),initial.items.map(v=>[v.id,v.revision]).sort());
 assert.ok(second.items.every(v=>v.snapshot.runId===b.id&&v.provenance.runId===a.id));
 const c=await f.ingest('ARTIKEL_FILIALEN',[stock(undefined,18,'9')]);assert.equal(count(f,'import_history_versions'),versions+1);
 assert.equal((await f.list(c)).items.length,1);assert.equal((await f.list(c)).items[0].fields.FBestand,'9');
 assert.equal((await f.list(b)).items.find(v=>v.fields.FilialID==='18').fields.FBestand,'2');
 const d=await f.ingest('ARTIKEL_FILIALEN',values);assert.equal((await f.list(d)).items.length,2);
 assert.equal((await f.list(d)).items.find(v=>v.fields.FilialID==='19').revision,1);
 const empty=await f.ingest('ARTIKEL_FILIALEN',[]);assert.equal((await f.list(empty)).items.length,0);
 assert.equal((await f.access.queryOne(S.get,{runId:empty.id})).status,'published');
});
test('partial apply, lost acknowledgement and resume never replace the published snapshot',async t=>{
 const f=await snapshotFixture(t,{batchSize:1});await seed(f);
 const a=await f.ingest('ARTIKEL_FILIALEN',[stock(),stock('0000000000043')]);
 const b=await f.ready('ARTIKEL_FILIALEN',[stock(undefined,18,'9'),stock('0000000000043',18,'4')]);
 const progress=await f.engine.apply(b.id,b.revision);assert.equal(progress.status,'applying');
 assert.deepEqual((await f.list(a)).items.map(v=>v.fields.FBestand),['2','2']);
 await assert.rejects(f.list(b),error('IMPORT_HISTORY_SNAPSHOT_UNPUBLISHED'));
 await assert.rejects(f.engine.apply(b.id,b.revision),error('IMPORT_REVISION_CONFLICT'));
 const resumed=require('../lib/data-import-engine').createDataImportEngine(f.engineOptions);
 const checkpoint=await resumed.checkpoint(b.id);await resumed.apply(b.id,checkpoint.revision);
 assert.deepEqual((await f.list(b)).items.map(v=>v.fields.FBestand).sort(),['4','9']);
 assert.deepEqual((await f.list(a)).items.map(v=>v.fields.FBestand),['2','2']);
});
test('later unchanged membership protects its producer; undo withdraws even an all-unchanged run',async t=>{
 const f=await snapshotFixture(t);await seed(f);const a=await f.ingest('ARTIKEL_FILIALEN',[stock()]);
 const b=await f.ingest('ARTIKEL_FILIALEN',[stock()]);
 await assert.rejects(f.undo(a),error('IMPORT_UNDO_DEPENDENCIES'));
 assert.equal((await f.list(a)).items.length,1);assert.equal((await f.list(b)).items.length,1);
 await f.undo(b);assert.equal((await f.access.queryOne(S.get,{runId:b.id})).status,'withdrawn');
 await f.undo(a);assert.equal(count(f,'import_history_records'),0);assert.equal(count(f,'import_history_snapshot_members'),0);
});
test('undo of a changed snapshot preserves older referenced versions',async t=>{
 const f=await snapshotFixture(t);await seed(f);const a=await f.ingest('ARTIKEL_FILIALEN',[stock()]);
 const b=await f.ingest('ARTIKEL_FILIALEN',[stock(undefined,18,'5')]);await f.undo(b);
 assert.equal((await f.list(a)).items[0].fields.FBestand,'2');
 const c=await f.ingest('ARTIKEL_FILIALEN',[stock()]);assert.equal(c.counts.unchanged,1);
 assert.equal((await f.list(c)).items[0].fields.FBestand,'2');
});
test('legacy profile remains readable and resumable while new stock keys preserve leading zeros',async t=>{
 const f=await snapshotFixture(t);await seed(f);
 const legacy=await f.ready('ARTIKEL_FILIALEN',[stock()],{legacy:true});
 assert.equal(legacy.status,'ready');const a=await f.apply(legacy);
 const b=await f.ingest('ARTIKEL_FILIALEN',[stock()]);
 assert.equal((await f.list(a)).items[0].fields.EAN,'0000000000042');assert.equal((await f.list(b)).items[0].fields.EAN,'0000000000042');
 const profile=H.profileFor('trade','ARTIKEL_FILIALEN');assert.equal(profile.version,2);assert.deepEqual(profile.keyFields,['EAN','FilialID']);
 const duplicate=await f.ready('ARTIKEL_FILIALEN',[stock(),stock()]);assert.equal(duplicate.status,'needs_review');assert.equal(duplicate.counts.conflict,2);
 const missing=await f.ready('ARTIKEL_FILIALEN',[stock(null)]);assert.equal(missing.status,'needs_review');assert.equal(missing.counts.invalid,1);
});
test('snapshot proof rejects tampered revision, absent membership, foreign context and denied access',async t=>{
 const f=await snapshotFixture(t);await seed(f);const a=await f.ingest('ARTIKEL_FILIALEN',[stock()]);
 const b=await f.ingest('ARTIKEL_FILIALEN',[stock(undefined,18,'7')]);const item=(await f.list(a)).items[0];
 f.app.database.prepare('UPDATE import_history_snapshot_members SET revision=2 WHERE run_id=?').run(a.id);
 await assert.rejects(f.history.detail(item.id,{revision:2,snapshot:a.id}),error('IMPORT_PROTECTED_PAYLOAD_INVALID'));
 f.app.database.prepare('UPDATE import_history_snapshot_members SET revision=1 WHERE run_id=?').run(a.id);
 await assert.rejects(f.history.detail(item.id,{revision:1,snapshot:b.id}),error('IMPORT_HISTORY_SNAPSHOT_MISMATCH'));
 f.state.denied=true;await assert.rejects(f.list(a),error('IMPORT_FORBIDDEN'));f.state.denied=false;
 const header=f.app.database.prepare('SELECT scope_id FROM import_history_snapshots WHERE run_id=?').get(a.id);
 f.app.database.prepare("UPDATE import_history_snapshots SET scope_id='foreign' WHERE run_id=?").run(a.id);
 await assert.rejects(f.history.detail(item.id,{revision:1,snapshot:a.id}),error('IMPORT_PROTECTED_PAYLOAD_INVALID'));
 f.app.database.prepare('UPDATE import_history_snapshots SET scope_id=? WHERE run_id=?').run(header.scope_id,a.id);
 f.app.database.prepare('DELETE FROM import_history_snapshot_members WHERE run_id=?').run(a.id);
 await assert.rejects(f.history.detail(item.id,{revision:1,snapshot:a.id}),error('IMPORT_HISTORY_SNAPSHOT_INCOMPLETE'));
});
test('snapshot membership and immutable data survive staging retention',async t=>{
 const f=await snapshotFixture(t);await seed(f);const a=await f.ingest('ARTIKEL_FILIALEN',[stock()]);const b=await f.ingest('ARTIKEL_FILIALEN',[stock()]);
 for(const run of [a,b]){
  f.app.database.prepare('DELETE FROM data_import_changes WHERE run_id=?').run(run.id);
  f.app.database.prepare('DELETE FROM data_import_rows WHERE run_id=?').run(run.id);
  f.app.database.prepare("UPDATE data_import_runs SET status='purged' WHERE id=?").run(run.id);
 }
 assert.equal((await f.list(b)).items[0].fields.FBestand,'2');assert.equal((await f.list(a)).items.length,1);
 assert.equal(count(f,'import_history_versions'),1);assert.equal(count(f,'import_history_snapshot_members'),2);
});
