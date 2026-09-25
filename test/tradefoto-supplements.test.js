'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../lib/data-import-contract'),H=require('../lib/tradefoto-history-profiles');
const {readTradeFotoFullSource,definitions}=require('../lib/tradefoto-full-import-source');
const F=require('./fixtures/trade-supplement-source');
async function read(kind,values,options={},send=()=>{}) {
 const messages=[];
 await readTradeFotoFullSource({buffer:F.buffer(),kind,readerFactory:F.reader(kind,values,options),send:async m=>{messages.push(m);return send(m);}});
 return messages;
}
test('WEUM only reads approved movement/archive fields and keeps negative quantities without activating articles',async()=>{
 const seen=new Set(),messages=await read('weum',{
  WE:[{We_ID:1,We:true,Umlagerung:false,EAN:'000123',Menge:-2,FilialID:0,Filialid2:70,WEDatum:new Date('2026-09-18T00:00:00Z'),Bemerkung:'private',WEVerkaeuferid:123}],
  'ARTIKEL_STAMMGelöscht':[{EAN:'000123',Artikelbezeichnung:'Historischer Artikel',Löschdatum:new Date('2026-09-17T00:00:00Z'),Verkaufspreis:999,Löschperson:123}],
 },{columns:(_name,columns)=>columns.forEach(c=>seen.add(c))});
 for(const name of ['Bemerkung','WEVerkaeuferid','Verkaufspreis','Löschperson'])assert.ok(!seen.has(name));
 const rows=messages.filter(m=>m.type==='rows');assert.equal(rows.length,2);
 const movement=rows.find(m=>m.name==='WE').rows[0];assert.equal(movement.Menge,'-2');assert.equal(movement.EAN,'000123');assert.equal(movement.FilialID,'0');
 for(const m of rows)assert.doesNotThrow(()=>C.normalizeDataImportRow(H.profileFor('trade',m.name),m.rows[0]));
 assert.deepEqual(messages[0].tables.map(t=>t.name),definitions('weum').map(t=>t.name));
 assert.equal(messages.at(-1).rows,2);
});
test('compact inventory retains differences, incomplete quantities and inconsistent zero differences, with complete summary counts',async()=>{
 const messages=await read('inventur',F.inventory()),manifest=messages[0];
 assert.deepEqual(manifest.selection.tables,[{name:'Inventur',sourceRows:2,selectedRows:1},{name:'Inventurdetails',sourceRows:5,selectedRows:4}]);
 const summary=messages.find(m=>m.type==='rows'&&m.name==='Inventur').rows[0];
 assert.equal(summary.Positionszahl,5);assert.equal(summary.PositiveDifferenzen,1);assert.equal(summary.NegativeDifferenzen,1);assert.equal(summary.OhneDifferenz,2);assert.equal(summary.UnvollstaendigeMengen,1);
 const details=messages.find(m=>m.type==='rows'&&m.name==='Inventurdetails').rows;
 assert.deepEqual(details.map(r=>r.ID),['2','3','4','5']);assert.equal(details[2].AlteMenge,null);assert.equal(messages.at(-1).rows,5);
});
test('compact inventory checks original counters, unknown tables and orphaned positions before staging anything',async()=>{
 for(const [values,options,code] of [
  [F.inventory(),{counts:{Inventurdetails:4}},'IMPORT_SOURCE_ROW_COUNT_MISMATCH'],
  [F.inventory(),{extraTables:['Unreviewed']},'IMPORT_SOURCE_TABLE_UNCLASSIFIED'],
  [{...F.inventory(),Inventur:[]},{},'IMPORT_INVENTORY_HEAD_MISSING'],
  [{...F.inventory(),Inventur:[...F.inventory().Inventur,F.inventory().Inventur[0]]},{},'IMPORT_INVENTORY_HEAD_INVALID'],
 ]) {let sent=0;await assert.rejects(read('inventur',values,options,()=>{sent++;}),e=>e.code===code);assert.equal(sent,0);}
});
test('resuming compact inventory uses the selected-row offset and reconstructs the same summary without duplicate rows',async()=>{
 const values=F.inventory();values.Inventurdetails=Array.from({length:450},(_,i)=>({...values.Inventurdetails[1],ID:i+1,Differenz:i%2?1:0,AlteMenge:0,NeueMenge:i%2?1:0}));
 const all=await read('inventur',values),resumed=await read('inventur',values,{},m=>m.type==='table'?{resumeAfter:m.name==='Inventur'?1:200}:undefined);
 const expected=all.filter(m=>m.type==='rows'&&m.name==='Inventurdetails').flatMap(m=>m.rows).slice(200);
 assert.deepEqual(resumed.filter(m=>m.type==='rows').flatMap(m=>m.rows),expected);assert.equal(resumed.find(m=>m.type==='rows').startRow,201);
 assert.equal(resumed.at(-1).rows,226);
});

const {openSqliteApplicationPersistence}=require('../lib/persistence/sqlite/provider');
const {SQLITE_APPLICATION_CATALOG}=require('../lib/persistence/sqlite/application-catalog');
const {ensureSqliteDataImportRuntimeSchema}=require('../lib/persistence/sqlite/operations/data-import-runtime-schema');
const {createIntegrationSecretVault}=require('../lib/integration-secret-vault');
const {createDataImportRuntime}=require('../lib/persistence/repositories/data-import-runtime');
const {DATA_IMPORT_PERMISSIONS:P}=require('../lib/data-import-access');
async function runtimeFixture(t,kind,values) {
 const app=openSqliteApplicationPersistence({databasePath:':memory:',catalog:SQLITE_APPLICATION_CATALOG});ensureSqliteDataImportRuntimeSchema(app.database);
 const state={session:{employeeNumber:'synthetic',accountId:'one',isEmployee:true,permissions:[...Object.values(P),'sales:analytics:access','sales:analytics:company:read']},date:'2026-09-25T10:00:00.000Z'},get=async()=>state.session;
 const runtime=createDataImportRuntime({access:app.provider,vault:createIntegrationSecretVault({activeKeyId:'test',keys:{test:Buffer.alloc(32,7)}}),allowApply:true,clock:()=>state.date,
  readSource:o=>readTradeFotoFullSource({...o,readerFactory:F.reader(kind,values),send:o.onMessage})});
 async function finish(source,action){for(let i=0;i<30;i++){source=await runtime.sourceOperation(get,source.id,action,{expectedRevision:source.revision});if(source.status!==({review:'reviewing',apply:'applying',undo:'reverting'})[action])return source;}throw new Error('Unfinished test operation');}
 t.after(async()=>{await runtime.stop();await app.provider.close();app.database.close();});return {...app,runtime,get,state,finish};
}
test('supplements persist only the compact selection, support review/apply/replay/undo and do not create active articles or cash sales',async t=>{
 for(const [kind,values,total] of [['inventur',F.inventory(),5],['weum',{WE:[{We_ID:1,We:true,Umlagerung:false,EAN:'001',Menge:-2,WEDatum:new Date('2026-09-18T00:00:00Z')}],'ARTIKEL_STAMMGelöscht':[{EAN:'001',Artikelbezeichnung:'Archiviert'}]},2]]) {
  const f=await runtimeFixture(t,kind,values),upload=()=>f.runtime.upload(f.get,{buffer:F.buffer(),kind,fileName:kind+'.accdb'});
  let source=await upload();assert.ok(source.selection);source=await f.finish(source,'review');assert.equal(source.status,kind==='inventur'?'needs_review':'ready');
  source=await f.finish(source,'apply');assert.equal(source.status,'applied');assert.equal(f.database.prepare('SELECT count(*) n FROM import_history_records').get().n,total);
  assert.equal(f.database.prepare('SELECT count(*) n FROM import_master_records').get().n,0);
  assert.equal(f.database.prepare("SELECT count(*) n FROM import_history_records WHERE source='cash'").get().n,0);
  const replay=await upload();assert.equal(replay.id,source.id);assert.equal(replay.status,'applied');
  source=await f.finish(source,'undo');assert.equal(source.status,'reverted');assert.equal(f.database.prepare('SELECT count(*) n FROM import_history_records').get().n,0);
 }
});
test('overview finds a database behind multiple history pages and preserves owner and permission boundaries',async t=>{
 const f=await runtimeFixture(t,'weum',{});
 await f.runtime.reserve(f.get,{buffer:F.buffer(1),kind:'weum',fileName:'WEUM.accdb'});
 for(let i=0;i<55;i++){f.state.date=new Date(Date.parse(f.state.date)+1000).toISOString();await f.runtime.reserve(f.get,{buffer:F.buffer(i+2),kind:'trade',fileName:'Trade_Daten.accdb'});}
 const result=await f.runtime.overview(f.get);assert.equal(result.complete,true);assert.deepEqual(result.items.map(s=>s.kind).sort(),['trade','weum']);
 assert.equal(result.items.find(s=>s.kind==='trade').createdAt,f.state.date);
 f.state.session={...f.state.session,employeeNumber:'other'};assert.deepEqual((await f.runtime.overview(f.get)).items,[]);
 f.state.session={...f.state.session,permissions:[]};await assert.rejects(f.runtime.overview(f.get),e=>e.code==='IMPORT_FORBIDDEN');
});
