'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {snapshotFixture}=require('../test-support/article-stock-snapshots-fixture');
const H=require('../lib/tradefoto-history-profiles');
const stock={EAN:'0000000000042',FilialID:18,FBestand:'2'};
const incomplete=error=>error.code==='IMPORT_HISTORY_SNAPSHOT_INCOMPLETE';

test('foreign snapshot members cannot disappear through the stock selector while preserving coverage counts',async t=>{
 const f=await snapshotFixture(t);
 const original=await f.ingest('ARTIKEL_FILIALEN',[stock]);
 const foreign=await f.ingest('ARTIKEL_FILIALEN',[stock],{instance:'foreign-source'});
 const originalItem=(await f.list(original)).items[0],foreignItem=(await f.list(foreign,'foreign-source')).items[0];
 f.app.database.prepare('UPDATE import_history_snapshot_members SET record_id=? WHERE run_id=?').run(foreignItem.id,original.id);
 await assert.rejects(f.list(original),incomplete);
 f.app.database.prepare('UPDATE import_history_snapshot_members SET record_id=? WHERE run_id=?').run(originalItem.id,original.id);
 assert.equal((await f.list(original)).items.length,1);
});

test('publication rejects member header drift before source, table or profile filters can hide it',async t=>{
 const f=await snapshotFixture(t),run=await f.ingest('ARTIKEL_FILIALEN',[stock]);
 const item=(await f.list(run)).items[0];
 const original=f.app.database.prepare('SELECT * FROM import_history_records WHERE id=?').get(item.id);
 const mutations={scope_id:'foreign-scope',source_instance:'foreign-source',source:'cash',source_table:'OTHER_TABLE',
  profile_hash:H.profilesFor('trade','ARTIKEL_FILIALEN').find(profile=>profile.version===1).fingerprint};
 for(const [column,value] of Object.entries(mutations)){
  f.app.database.prepare(`UPDATE import_history_records SET ${column}=? WHERE id=?`).run(value,item.id);
  await assert.rejects(f.list(run),incomplete,column);
  f.app.database.prepare(`UPDATE import_history_records SET ${column}=? WHERE id=?`).run(original[column],item.id);
 }
 assert.equal((await f.list(run)).items.length,1);
});
