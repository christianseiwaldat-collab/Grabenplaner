'use strict';
// Native regression for bounded, authenticated plan validation before apply.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const repo=path.resolve(__dirname,'..');
const req=name=>require(path.join(repo,name));
const C=req('lib/data-import-contract'),H=req('lib/tradefoto-history-profiles');
const {withCoreFixture}=req('test-support/postgresql-migration/core-fixture');
const {withSalesFixture}=req('test-support/postgresql-migration/sales-fixture');
const {openTwoDatabaseDevelopmentApplication}=req('lib/persistence/postgresql/boundary/application');
const S=req('lib/persistence/statements/data-import-runtime').DATA_IMPORT_RUNTIME_STATEMENTS;
const TIME='2026-11-11T12:00:00.000Z',enabled=process.env.GP_PG_MIGRATION_LIVE==='1';
// A legal adaptive packet may shrink to one row. These are semantic work
// bounds, not a speed requirement; monotonic cursor progress is asserted below.
const CURSOR_STEPS=502,SOURCE_STEPS=2100;
const isCode=expected=>error=>error?.code===expected;
const repair=id=>({...Object.fromEntries(H.tableFor('trade','Reparatur').columns.map(c=>[c.name,null])),
 ReparaturNr:id,FilialId:'18',AName:'Synthetic '+id,Fehler:'Synthetic protected evidence. '.repeat(90)});
const sourceContext=row=>['source',row.scopeId,row.ownerId,row.id,row.revision];
async function fixture(work){return withCoreFixture(core=>withSalesFixture(8,async f=>{
 await core.application.close();await f.application.close();
 const app=await openTwoDatabaseDevelopmentApplication({coreUrl:process.env.GP_CORE_APP_URL,salesUrl:process.env.GP_SALES_APP_URL,stage:8,authorize:async()=>true});
 try{await work({...f,core,access:app.provider});}finally{await app.close();}
}));}
async function setup(f,label){
 const scopeId='synthetic-ready-'+label,actor={scopeId,ownerId:'00001'};
 const {definitions,readTradeFotoFullSource}=req('lib/tradefoto-full-import-source'),defs=definitions('bestell');
 const sourceRows=Array.from({length:501},(_,i)=>repair(i+1));
 const readerFactory=()=>({getTableNames:()=>defs.map(d=>d.name),getTable:name=>{
  const def=defs.find(d=>d.name===name),rows=name==='Reparatur'?sourceRows:[];
  return {rowCount:rows.length,getColumnNames:()=>def.columns.map(c=>c.name),getColumns:()=>def.columns.map(c=>({name:c.name,type:c.type})),
   getData:({columns,rowOffset=0,rowLimit=Infinity})=>rows.slice(rowOffset,rowOffset+rowLimit).map(r=>Object.fromEntries(columns.map(k=>[k,r[k]??null])))};
 }});
 const vault=req('lib/integration-secret-vault').createIntegrationSecretVault({activeKeyId:'synthetic-native',keys:{'synthetic-native':Buffer.alloc(32,61)}});
 const permissions=req('lib/data-import-access').DATA_IMPORT_PERMISSIONS;
 const session=async()=>({employeeNumber:'00001',accountId:'synthetic-personal',isEmployee:true,permissions:[...Object.values(permissions),'sales:analytics:access','sales:analytics:company:read']});
 const options={access:f.access,vault,scopeId,allowApply:true,sharedPayloads:true,syncArticleCatalog:false,clock:()=>TIME,
  readSource:options=>readTradeFotoFullSource({...options,readerFactory,send:options.onMessage})};
 const createRuntime=()=>req('lib/persistence/repositories/data-import-runtime').createDataImportRuntime(options);
 let runtime=createRuntime();
 const bytes=Buffer.alloc(4096);bytes.write('Standard ACE DB',4);bytes[0x14]=3;
 let source=await runtime.upload(session,{buffer:bytes,kind:'bestell',fileName:'Trade_DatenBestell.accdb'});
 for(let i=0;source.status==='reviewing';i++){
  assert.ok(i<SOURCE_STEPS);source=await runtime.sourceOperation(session,source.id,'review',{expectedRevision:source.revision});
 }
 assert.equal(source.status,'ready');assert.equal(source.tables.reduce((n,t)=>n+t.run.receivedRows,0),501);
 const table=source.tables.find(t=>t.name==='Reparatur');assert.equal(table.run.counts.create,501);
 const protection=await req('lib/data-import-managed-protection').loadManagedDataImportProtection({access:f.access,vault,create:false});
 const state={f,actor,scopeId,session,options,createRuntime,protection,source,table,runtime};
 state.stored=async()=>{
  const row=await f.access.queryOne(S.source,{id:state.source.id,...actor});assert.ok(row);
  return {row,data:protection.open(row.payload,sourceContext(row))};
 };
 state.step=async()=>{state.source=await state.runtime.sourceOperation(session,state.source.id,'apply',{expectedRevision:state.source.revision});return state.stored();};
 state.restart=async()=>{await state.runtime.stop();state.runtime=createRuntime();state.source=await state.runtime.sourceOperation(session,state.source.id,'read');};
 state.close=async()=>{await state.runtime.stop();protection.destroy();};
 return state;
}
async function snapshot(s){return {
 rows:(await s.f.client.query('SELECT row_number,state,issue,payload FROM integration.data_import_rows WHERE run_id=$1 ORDER BY row_number',[s.table.run.id])).rows,
 refs:(await s.f.client.query('SELECT row_number,slot,block_id FROM integration.data_import_row_payload_refs WHERE run_id=$1 ORDER BY row_number,slot',[s.table.run.id])).rows,
};}
async function noCurrentBusinessWrites(s){
 for(const [table,field] of [['integration.import_history_versions','run_id'],['integration.data_import_links','last_run_id'],['integration.data_import_changes','run_id']])
  assert.equal((await s.f.client.query('SELECT count(*)::int n FROM '+table+' WHERE '+field+'=$1',[s.table.run.id])).rows[0].n,0);
}
async function firstCursor(s){
 for(let i=0;i<150;i++){
  const stored=await s.step();await noCurrentBusinessWrites(s);
  const p=stored.data.readyPlanValidation;
  if(p?.runId===s.table.run.id){assert.equal(p.fallback,undefined);assert.ok(p.verifiedRows>0&&p.verifiedRows<=200);return stored;}
 }
 assert.fail('No bounded ready-plan cursor reached');
}
async function completeCursor(s){
 let stored=await s.stored(),last=stored.data.readyPlanValidation?.verifiedRows||0;
 for(let i=0;i<CURSOR_STEPS;i++){
  const p=stored.data.readyPlanValidation;
  assert.equal(p?.runId,s.table.run.id);assert.equal(p.fallback,undefined);
  await noCurrentBusinessWrites(s);
  if(p.complete){assert.equal(p.verifiedRows,501);return stored;}
  stored=await s.step();const next=stored.data.readyPlanValidation;
  assert.ok(next.verifiedRows>last&&next.verifiedRows-last<=200);last=next.verifiedRows;
 }
 assert.fail('Validation did not finish in bounded packets');
}
async function finish(s){
 for(let i=0;s.source.status!=='applied';i++){assert.ok(i<SOURCE_STEPS);await s.step();}
}
async function unlocked(f){assert.equal((await f.core.migrator.query("SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND objid=9261207 AND granted")).rows[0].n,0);}
function sqlTrace(work){
 const {Client}=require('pg'),old=Client.prototype.query,events=[];
 Client.prototype.query=function(...args){
  const sql=typeof args[0]==='string'?args[0]:args[0]?.text||'',database=this.connectionParameters.database;
  if(/^\s*SELECT\b/i.test(sql)&&/\bdata_import_sources\b/i.test(sql))events.push({kind:'source-read',database});
  if(/^\s*SELECT\b/i.test(sql)&&/\bdata_import_runs\b/i.test(sql))events.push({kind:'run-read',database});
  if(/^\s*INSERT\b/i.test(sql)&&/\bimport_history_records\b/i.test(sql))events.push({kind:'target-insert',database});
  return old.apply(this,args);
 };
 return Promise.resolve().then(()=>work(events)).finally(()=>{Client.prototype.query=old;});
}

test('Native ready validation: all 501 plans precede first write; restart, lost reply, Core routing and unchanged ciphers',
 {skip:!enabled},()=>fixture(async f=>{
 const s=await setup(f,'complete');
 try{
  const reviewed=await snapshot(s);
  await sqlTrace(async events=>{
   await firstCursor(s);
   assert.equal(events.some(e=>e.kind==='target-insert'),false);
   assert.equal(Object.hasOwn(s.source,'readyPlanValidation'),false,'Cursor must stay inside protected source storage');
  });
  await s.restart();
  const acknowledged=s.source;
  await s.runtime.sourceOperation(s.session,s.source.id,'apply',{expectedRevision:s.source.revision}); // committed reply intentionally lost
  await assert.rejects(s.runtime.sourceOperation(s.session,s.source.id,'apply',{expectedRevision:acknowledged.revision}),isCode('IMPORT_REVISION_CONFLICT'));
  await s.restart();
  await sqlTrace(async events=>{await completeCursor(s);assert.equal(events.some(e=>e.kind==='target-insert'),false);});
  assert.deepEqual(await snapshot(s),reviewed,'Validation must not rewrite row states, ciphertexts or evidence refs');
  assert.equal((await f.client.query("SELECT to_regclass('gp.data_import_sources')::text AS name")).rows[0].name,null,'Sales has no Core source table');
  assert.notEqual((await f.core.migrator.query("SELECT to_regclass('gp.data_import_sources')::text AS name")).rows[0].name,null);
  await sqlTrace(async events=>{
   await s.step();
   const write=events.findIndex(e=>e.kind==='target-insert');assert.ok(write>=0);
   const lastRun=events.slice(0,write).findLastIndex(e=>e.kind==='run-read');assert.ok(lastRun>=0);
   const guard=events.findIndex((e,i)=>i>lastRun&&i<write&&e.kind==='source-read');assert.ok(guard>lastRun,'Core source fence executes inside the first apply, after Sales run read and before target insert');
   assert.equal(events[guard].database,decodeURIComponent(new URL(process.env.GP_CORE_APP_URL).pathname.slice(1)));
   assert.equal(events[write].database,decodeURIComponent(new URL(process.env.GP_SALES_APP_URL).pathname.slice(1)));
  });
  await finish(s);assert.equal(s.source.tables.find(t=>t.name==='Reparatur').run.counts.applied,501);
  const applied=await snapshot(s);assert.deepEqual(applied.rows.map(r=>({row_number:r.row_number,payload:r.payload})),reviewed.rows.map(r=>({row_number:r.row_number,payload:r.payload})));
  assert.deepEqual(applied.refs,reviewed.refs);await unlocked(f);
 }finally{await s.close();}
}));

test('Native ready validation: a stale plan only in row 500 forces the complete original recheck before this run writes',
 {skip:!enabled},()=>fixture(async f=>{
 const s=await setup(f,'late-row');
 try{
  await firstCursor(s);await noCurrentBusinessWrites(s);
  const {createDataImportEngine}=req('lib/data-import-engine'),{createDataImportRepository}=req('lib/persistence/repositories/data-import');
  const other=createDataImportEngine({repository:createDataImportRepository(f.access),protection:s.protection,profiles:H.TRADEFOTO_HISTORY_PROFILES,
   sharedPayloads:true,getActor:()=>s.actor,authorize:()=>true,clock:()=>TIME,
   writers:req('lib/persistence/repositories/import-history').createImportHistoryWriters({protection:s.protection,authorize:()=>true,resolveMasterSourceInstance:()=> 'tradefoto-trade'})});
  const profile=H.profileFor('trade','Reparatur');
  let run=await other.start({profileHash:profile.fingerprint,manifest:{sourceInstance:'tradefoto-bestell',fileSha256:'c'.repeat(64),schemaSha256:profile.schemaSha256,expectedRows:1,declaredRows:1,snapshotAt:TIME,gates:[]}});
  run=await other.stage(run.id,{expectedRevision:run.revision,startRow:1,rows:[H.prepareTradeFotoHistoryRow('trade','Reparatur',repair(500))]});
  run=await other.seal(run.id,run.revision);
  do{run=await other.review(run.id,run.revision);}while(run.status==='reviewing');
  do{run=await other.apply(run.id,run.revision);}while(run.status==='applying');
  assert.equal(run.counts.applied,1);await noCurrentBusinessWrites(s);
  let fallback=false,maxStaged=0;
  for(let i=0;i<CURSOR_STEPS+20;i++){
   const stored=await s.step(),table=stored.data.tables.find(t=>t.name==='Reparatur');
   await noCurrentBusinessWrites(s);
   maxStaged=Math.max(maxStaged,table.run.counts.staged||0);
   fallback ||= stored.data.readyPlanValidation?.fallback===true;
   if(table.run.status==='reviewing'&&maxStaged===501)break;
  }
  assert.equal(fallback,true);assert.equal(maxStaged,501,'Fallback must reset all 501 plans, not only row 500 or its page');
  await finish(s);
  assert.deepEqual(s.source.tables.find(t=>t.name==='Reparatur').run.counts,{applied:500,unchanged:1});
  assert.equal((await f.client.query('SELECT count(*)::int n FROM integration.import_history_versions WHERE run_id=$1',[run.id])).rows[0].n,1);
  await unlocked(f);
 }finally{await s.close();}
}));

test('Native ready validation: authentication and source-CAS failures stay errors, never an automatic recheck waiver',
 {skip:!enabled},async t=>{
 await t.test('a corrupted late row is not masked as a stale plan',()=>fixture(async f=>{
  const s=await setup(f,'auth');
  try{
   await firstCursor(s);
   await f.client.query("UPDATE integration.data_import_rows SET payload=left(payload,length(payload)-1)||'!' WHERE run_id=$1 AND row_number=500",[s.table.run.id]);
   let rejected=false;
   for(let i=0;i<CURSOR_STEPS+20&&!rejected;i++){
    const before=await s.stored();
    try{await s.step();}catch(error){
     assert.equal(error.code,'IMPORT_PROTECTED_PAYLOAD_INVALID');rejected=true;
     assert.equal((await s.stored()).row.revision,before.row.revision,'Failed validation must not save a cursor');
    }
    await noCurrentBusinessWrites(s);
   }
   assert.equal(rejected,true);
   const states=(await f.client.query('SELECT state,count(*)::int n FROM integration.data_import_rows WHERE run_id=$1 GROUP BY state',[s.table.run.id])).rows;
   assert.deepEqual(states,[{state:'create',n:501}]);await unlocked(f);
  }finally{await s.close();}
 }));
 await t.test('the bound Core source guard rejects a changed source revision before writes',()=>fixture(async f=>{
  const s=await setup(f,'source-cas');
  try{
   await firstCursor(s);await completeCursor(s);const stored=await s.stored();
   assert.equal(stored.data.readyPlanValidation.complete,true,'Inject specifically in the first apply after full validation, not a read-only validation packet');
   const replacement=s.protection.seal(stored.data,sourceContext({...stored.row,revision:stored.row.revision+1}));
   const {Client}=require('pg'),old=Client.prototype.query;let reads=0,injected=false;
   Client.prototype.query=function(...args){
    const sql=typeof args[0]==='string'?args[0]:args[0]?.text||'';
    if(!injected&&/^\s*SELECT\b/i.test(sql)&&/\bdata_import_runs\b/i.test(sql)&&++reads===2){
     injected=true;const client=this;
     return (async()=>{
      // Deliberate owned-fixture race outside the application coordinator.
      const changed=await f.core.migrator.query('UPDATE gp.data_import_sources SET revision=revision+1,payload=$1 WHERE id=$2 AND revision=$3',[replacement,stored.row.id,stored.row.revision]);
      assert.equal(changed.rowCount,1);return old.apply(client,args);
     })();
    }
    return old.apply(this,args);
   };
   try{await assert.rejects(s.step(),isCode('IMPORT_CONCURRENT_CHANGE'));}finally{Client.prototype.query=old;}
   assert.equal(injected,true);await noCurrentBusinessWrites(s);
   assert.equal((await s.stored()).row.revision,stored.row.revision+1,'Only the injected Core update may have committed');
   const states=(await f.client.query('SELECT state,count(*)::int n FROM integration.data_import_rows WHERE run_id=$1 GROUP BY state',[s.table.run.id])).rows;
   assert.deepEqual(states,[{state:'create',n:501}]);await unlocked(f);
  }finally{await s.close();}
 }));
});
