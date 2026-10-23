'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {snapshotFixture}=require('../test-support/article-stock-snapshots-fixture');
const enabled=!!process.env.GP_CORE_MIGRATOR_URL;
test('native stock imports batch membership, reuse unchanged versions and keep snapshot/undo/reader isolation',{skip:!enabled},async t=>{
 await require('../test-support/postgresql-migration/report-fixture').withReportFixture(async pg=>{
  const f=await snapshotFixture(t,{access:pg.access,protection:pg.protection,scopeId:'synthetic-migration',ownerId:'00001'});
  const values=Array.from({length:205},(_,i)=>({EAN:String(42+i).padStart(13,'0'),FilialID:18,FBestand:String(i+1)}));
  await f.ingest('ARTIKEL_STAMM',values.map(v=>({EAN:v.EAN,Artikelbezeichnung:'Synthetic '+v.EAN})),{master:true});
  await f.ingest('FILIALEN',[{FilialID:'18'}],{master:true});
  const started=performance.now(),a=await f.ingest('ARTIKEL_FILIALEN',values),firstMs=performance.now()-started;
  const readCounts=async()=>(await pg.client.query(`SELECT
   (SELECT COUNT(*)::int FROM integration.import_history_versions v JOIN integration.import_history_records r ON r.id=v.record_id WHERE r.source_table='ARTIKEL_FILIALEN') AS versions,
   (SELECT COUNT(*)::int FROM integration.import_history_snapshot_members) AS members`)).rows[0];
  const first=await readCounts();assert.equal(first.versions,205);assert.equal(first.members,205);
  const nextStarted=performance.now(),b=await f.ingest('ARTIKEL_FILIALEN',values.slice().reverse()),unchangedMs=performance.now()-nextStarted;
  assert.equal(b.counts.unchanged,205);assert.deepEqual(await readCounts(),{versions:205,members:410});
  let record=(await f.list(a)).items[0];assert.equal((await f.history.detail(record.id,{revision:record.revision,snapshot:b.id})).snapshot.runId,b.id);
  await assert.rejects(f.undo(a),e=>e.code==='IMPORT_UNDO_DEPENDENCIES');
  const modified=values.slice(0,2).map((v,i)=>({...v,FBestand:String(500+i)}));
  const c=await f.ingest('ARTIKEL_FILIALEN',modified);assert.equal((await f.list(c)).items.length,2);
  assert.equal((await readCounts()).versions,207);
  assert.equal((await f.history.detail(record.id,{revision:record.revision,snapshot:b.id})).snapshot.runId,b.id);
  const runtime=require('../lib/persistence/repositories/trade-insights').createTradeInsightRuntime(pg.runtimeOptions);
  const page=await runtime.run(()=>pg.resolvePrincipal('00001'),'inventory');assert.equal(page.scanned,2);
  await f.undo(c);assert.equal((await f.list(b)).items.length,100);
  const empty=await f.ingest('ARTIKEL_FILIALEN',[]);assert.equal((await f.list(empty)).items.length,0);
  console.log(JSON.stringify({qualification:'native-stock-snapshot-reuse',rows:205,unchanged:205,additionalVersionsForUnchanged:0,firstMs:Math.round(firstMs),unchangedMs:Math.round(unchangedMs)}));
 },{warmWorkers:false});
});
