'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {snapshotFixture}=require('../test-support/article-stock-snapshots-fixture');
const H=require('../lib/tradefoto-history-profiles');
const {S}=require('../lib/persistence/statements/import-history-snapshots');
const {withReportFixture}=require('../test-support/postgresql-migration/report-fixture');
const stock=(EAN='0000000000042',FilialID=18,FBestand='2')=>({EAN,FilialID,FBestand,Bestellt:'0'});
const error=expected=>e=>e.code===expected;
async function seed(f){await f.ingest('ARTIKEL_STAMM',[{EAN:'0000000000042'},{EAN:'0000000000043'}],{master:true});await f.ingest('FILIALEN',[{FilialID:'18'},{FilialID:'19'}],{master:true});}
async function count(database, table) {
  const result=await database.query('SELECT COUNT(*)::int AS n FROM integration.'+table);
  return result.rows[0].n;
}
function stockTest(name,work,{batchSize}={}) {
  test(name,{skip:process.env.GP_PG_MIGRATION_LIVE!=='1'}, t=>withReportFixture(async pg=>{
    const fixture=await snapshotFixture({access:pg.access,protection:pg.protection,scopeId:'synthetic-migration',ownerId:'00001',batchSize});
    await work(fixture,pg.client);
  },{warmWorkers:false}));
}
stockTest('stock snapshots reuse identical versions across new files and preserve exact historical revisions',async (f,database)=>{
 await seed(f);
 const values=[stock(),stock('0000000000043',19,'7')],a=await f.ingest('ARTIKEL_FILIALEN',values);
 const initial=await f.list(a),versions=await count(database,'import_history_versions');
 const ready=await f.ready('ARTIKEL_FILIALEN',values.slice().reverse());assert.equal(ready.counts.unchanged,2);
 await assert.rejects(f.list(ready),error('IMPORT_HISTORY_SNAPSHOT_UNPUBLISHED'));
 const b=await f.apply(ready);assert.equal(await count(database,'import_history_versions'),versions);
 const second=await f.list(b);assert.deepEqual(second.items.map(v=>[v.id,v.revision]).sort(),initial.items.map(v=>[v.id,v.revision]).sort());
 assert.ok(second.items.every(v=>v.snapshot.runId===b.id&&v.provenance.runId===a.id));
 const c=await f.ingest('ARTIKEL_FILIALEN',[stock(undefined,18,'9')]);assert.equal(await count(database,'import_history_versions'),versions+1);
 assert.equal((await f.list(c)).items.length,1);assert.equal((await f.list(c)).items[0].fields.FBestand,'9');
 assert.equal((await f.list(b)).items.find(v=>v.fields.FilialID==='18').fields.FBestand,'2');
 const d=await f.ingest('ARTIKEL_FILIALEN',values);assert.equal((await f.list(d)).items.length,2);
 assert.equal((await f.list(d)).items.find(v=>v.fields.FilialID==='19').revision,1);
 const empty=await f.ingest('ARTIKEL_FILIALEN',[]);assert.equal((await f.list(empty)).items.length,0);
 assert.equal((await f.access.queryOne(S.get,{runId:empty.id})).status,'published');
});
stockTest('partial apply, lost acknowledgement and resume never replace the published snapshot',async (f,database)=>{
 await seed(f);
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
},{batchSize:1});
stockTest('later unchanged membership protects its producer; undo withdraws even an all-unchanged run',async (f,database)=>{
 await seed(f);const a=await f.ingest('ARTIKEL_FILIALEN',[stock()]);
 const b=await f.ingest('ARTIKEL_FILIALEN',[stock()]);
 await assert.rejects(f.undo(a),error('IMPORT_UNDO_DEPENDENCIES'));
 assert.equal((await f.list(a)).items.length,1);assert.equal((await f.list(b)).items.length,1);
 await f.undo(b);assert.equal((await f.access.queryOne(S.get,{runId:b.id})).status,'withdrawn');
 await f.undo(a);assert.equal(await count(database,'import_history_records'),0);assert.equal(await count(database,'import_history_snapshot_members'),0);
});
stockTest('undo of a changed snapshot preserves older referenced versions',async (f,database)=>{
 await seed(f);const a=await f.ingest('ARTIKEL_FILIALEN',[stock()]);
 const b=await f.ingest('ARTIKEL_FILIALEN',[stock(undefined,18,'5')]);await f.undo(b);
 assert.equal((await f.list(a)).items[0].fields.FBestand,'2');
 const c=await f.ingest('ARTIKEL_FILIALEN',[stock()]);assert.equal(c.counts.unchanged,1);
 assert.equal((await f.list(c)).items[0].fields.FBestand,'2');
});
stockTest('legacy profile remains readable and resumable while new stock keys preserve leading zeros',async (f,database)=>{
 await seed(f);
 const legacy=await f.ready('ARTIKEL_FILIALEN',[stock()],{legacy:true});
 assert.equal(legacy.status,'ready');const a=await f.apply(legacy);
 const b=await f.ingest('ARTIKEL_FILIALEN',[stock()]);
 assert.equal((await f.list(a)).items[0].fields.EAN,'0000000000042');assert.equal((await f.list(b)).items[0].fields.EAN,'0000000000042');
 const profile=H.profileFor('trade','ARTIKEL_FILIALEN');assert.equal(profile.version,2);assert.deepEqual(profile.keyFields,['EAN','FilialID']);
 const duplicate=await f.ready('ARTIKEL_FILIALEN',[stock(),stock()]);assert.equal(duplicate.status,'needs_review');assert.equal(duplicate.counts.conflict,2);
 const missing=await f.ready('ARTIKEL_FILIALEN',[stock(null)]);assert.equal(missing.status,'needs_review');assert.equal(missing.counts.invalid,1);
});
