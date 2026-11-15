'use strict';
// Separate external qualification: real old/new graphs and default Java factory.
// Normal CI covers current proof/owner gates in data-import-known-af-proof.test.js.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createRequire}=require('node:module'),{pathToFileURL}=require('node:url');
const {spawnSync}=require('node:child_process');
const EXTERNAL_LIVE=process.env.GP_IMPORT_AF_COMPATIBILITY_LIVE==='1';
function compatibilityOptIn(environment){
 if(environment.GP_IMPORT_AF_COMPATIBILITY_LIVE!=='1')return false;
 assert.equal(environment.GP_PG_MIGRATION_LIVE,'1','Explicit AF compatibility qualification also requires live PostgreSQL');
 for(const name of ['GP_IMPORT_CANDIDATE_ROOT','GP_IMPORT_OLD_SOURCE_ROOT','GP_IMPORT_OLD_MANIFEST_PATH','GP_AF_TEST_TOOLS_ROOT'])
  assert(typeof environment[name]==='string'&&environment[name].length>0,name+' is required for explicit AF compatibility qualification');
 return true;
}
const AF='ARTIKEL_FILIALEN',INSTANCE='tradefoto-trade',BOUND=2400;
const TIME='2026-11-11T12:00:00.000Z',PREVIOUS='2026-11-10T12:00:00.000Z';
const OLD_MANIFEST_SHA='806580e889bd7aca42d5c3c75180c3f1d2faa6566fe850b57dbdd6f95b749425';
const OLD_CONTENT_SHA='f93bc07a2590bdb9f2fadc7a59add37d19ed23c10139baa13ce4908311b9cf3f';
const CURRENT_ORIGINAL_SHA='4c25531eee514cff4c5fbc0e608338bbf4e8c11196c7b55f2758589869808ca7';
const CANDIDATE_PINS=Object.freeze({
 'lib/persistence/postgresql/boundary/application.js':'a2b474b6369e7784fd479ec686e7c3d7b5434fc3415809ed4a0d34745104cf5e',
 'lib/data-import-engine.js':'e1a36335ac7385fb8bd88395851aac62669ab8927c5effb42e2e2989b6baddd0',
 'lib/persistence/repositories/data-import-runtime.js':'6717affa00243ed5bb8dc5f58c4224a370f034e632f4d0238bc4c05d59606222',
 'lib/data-import-af-verifier.js':'846206fce9bf41a4c8c72d437b881040833672b7ac6dd1078c6d058d78e4ffca',
 'lib/data-import-known-af-proof.js':'bf16d10fbb3611fb39804df02f9a6519631368e42270376857c20b2464fc7dde',
 'lib/data-import-af-verifier-policy.js':'0f83ce856362576fa4599b584f1281e1995fce6b0a1743421a1d3ac157f7c51b',
 'lib/persistence/postgresql/operations/import-retention.js':'c3c63174dc7690ab6c0531c302669f2ba03e32a2d8abe76fe0e235018db9202a'
});
const OLD_READER_PINS=Object.freeze({
 'lib/persistence/repositories/history-snapshot-source.js':'c9cbb653a128dc0c571970ef9d07fc26a2e050798ba36cfc0391b340ce1f27a5',
 'lib/persistence/repositories/import-history-snapshots.js':'5d3fccbdae9500488bef63e79e772d0efebdd65cf0da09e1b2bc0a38eb07b0d6',
 'lib/persistence/repositories/import-history.js':'e2a87ccff881de461036e1978dafbd34c3aca46d8fa13ede361d71c20fdfac25',
 'lib/persistence/repositories/trade-insights.js':'bf5a495fd9f81b788fae8bfb7f3dd735ce946f49e08b0bf55462254e06864d1b',
 'lib/sales-article-branch-stock.js':'20cfc5e75d53fc1fd831a202b4eae8b53e66c3098995287cb79a41300c747918',
 'lib/persistence/repositories/trade-stock.js':'4ccb4df34abc22e5017fc0a820cf4d2ad1d5ce664af3ec3c58e3f559bab93e3b',
 'lib/persistence/repositories/trade-stock-summary.js':'c08a77591f9784fcded0f16754a4e38bcb5735b8ed63210ad142ddc2e8acfcc9',
 'lib/persistence/catalogs/history-snapshot-selection.js':'d12e612678302623dedb560549efd88cc7761c168def36c51bc91a9cb7405f8b',
 'lib/persistence/catalogs/trade-insights-catalog.js':'0e9aef6d2861dc19b048cfcd64a8dc8544f4cdd4ce80e61bc03ee18fc8adef7b',
 'lib/persistence/postgresql/sales/import-history-snapshots-catalog.js':'8c25fe7b9c600eafaa54e47dd05b121f291bcbc900c4b5a7273893fec97c6a64',
 'lib/persistence/postgresql/sales/import-history-attestations.js':'11846bcb8c5f8806c63169026cb58c04acddf0afcfb7300338ca3fdd3c83185b',
 'lib/data-import-managed-protection.js':'c0057f75a3b60b4980218e20ab727a3ae128e9e8f1aa4517dbfda0b6829e0fb9',
 'lib/data-import-protection.js':'d5bd506e0175ecf89bb43032db6c6060e4727a3c1014f30ab4fdf33f51991cef',
 'lib/data-import-contract.js':'5e3f2708e5769cce8759389ce9f1ef87fa7e5cdbb3bab1ae32c79777c7ba86b3',
 'lib/tradefoto-history-profiles.js':'0527bd51b181821324a506db7629eeb4157c31fde8e2a295c4ea12ad2e2cda38',
 'lib/data-import-engine.js':'f8de6d112553ba594688d7d6b49d9e01e7e6a5138382655c95d735ad97afca7f',
 'lib/persistence/repositories/data-import-runtime.js':'93ea8b913ca7b518d884bdd092af62b7865c8c447c9f322d4d9225a042531c1d'
});
const TOOL_PINS=Object.freeze([
 ['KnownAfVerifierFixture.class',3080,'9fd71ded092f58ebec53fadd0c0acbd538a6cf32051a1908ced28d27beabc7fe'],
 ['KnownAfCountVerifierTest.class',18401,'b067eefa8fb8d708dededdc2d92e9450b6465f20e1d7296ea2cfacf85c7864f6'],
 ['KnownAfCountVerifierTest$Fixture.class',1388,'ae6fd6cbfb8e0b4fccc85200b857accb8bae7fb398e8781172a71ff86a78ef1e'],
 ['KnownAfCountVerifierTest$Action.class',293,'f8f2b69f829f62b72f000145b135adbeaa742cfbff7eda5c36727dae8fcb191a']
]);
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const isCode=code=>e=>e?.code===code;
function canonical(v){return JSON.stringify(v===null||typeof v!=='object'?v:Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])));}
function envPath(name){assert(process.env[name],name+' is required in LIVE mode');return fs.realpathSync(process.env[name]);}
function file(root,name){assert(!path.isAbsolute(name)&&!name.split(/[\\/]/).some(p=>p==='..'||!p));const out=path.resolve(root,name);assert(out.startsWith(root+path.sep));let p=out;while(p!==root){assert.equal(fs.lstatSync(p).isSymbolicLink(),false);p=path.dirname(p);}assert.equal(fs.statSync(out).isFile(),true);assert.equal(fs.realpathSync(out),out);return out;}
function sealed(p){for(let at=p;;at=path.dirname(at)){const s=fs.lstatSync(at);assert(!s.isSymbolicLink());assert.equal(s.uid,0,'Fixture tools/assets must be root owned');assert.equal(s.mode&0o6022,0,'Fixture tools/assets must have no setid or group/world write');if(path.dirname(at)===at)break;}}
function loadGraphs(){
 assert.equal(process.platform,'linux','Default Linux factory qualification must run on Linux');
 const candidate=envPath('GP_IMPORT_CANDIDATE_ROOT'),old=envPath('GP_IMPORT_OLD_SOURCE_ROOT'),manifestPath=envPath('GP_IMPORT_OLD_MANIFEST_PATH');
 assert.notEqual(candidate,old);const raw=fs.readFileSync(manifestPath);assert.equal(hash(raw),OLD_MANIFEST_SHA);
 const manifest=JSON.parse(raw);assert.equal(manifest.format,'gp-import-final-candidate-files-v1');assert.equal(manifest.files.length,2844);
 assert.equal(new Set(manifest.files.map(f=>f.path)).size,2844);assert.equal(manifest.contentSha256,OLD_CONTENT_SHA);assert.equal(hash(canonical(manifest.files)),OLD_CONTENT_SHA);
 for(const pin of manifest.files){const b=fs.readFileSync(file(old,pin.path));assert.equal(b.length,pin.bytes,pin.path);assert.equal(hash(b),pin.sha256,pin.path);}
 for(const [name,sha]of Object.entries(OLD_READER_PINS)){assert.equal(hash(fs.readFileSync(file(old,name))),sha,name);assert.equal(manifest.files.find(f=>f.path===name)?.sha256,sha);}
 for(const [name,sha]of Object.entries(CANDIDATE_PINS))assert.equal(hash(fs.readFileSync(file(candidate,name),'utf8').replace(/\r\n/g,'\n')),sha,name);
 const candidateRequire=createRequire(file(candidate,'package.json')),oldRequire=createRequire(file(old,'package.json'));
 const req=name=>candidateRequire('./'+name),oldReq=name=>oldRequire('./'+name);
 for(const name of Object.keys(OLD_READER_PINS))assert.equal(oldRequire.resolve('./'+name),file(old,name));
 assert.notEqual(req('lib/data-import-contract'),oldReq('lib/data-import-contract'),'Independent module graphs');
 function assertOldIsolation(){const seen=new Set();function walk(mod){if(!mod||seen.has(mod.id))return;seen.add(mod.id);if(mod.filename?.startsWith(candidate+path.sep))assert(mod.filename.startsWith(path.join(candidate,'node_modules')+path.sep),'Old source graph must not import candidate source');for(const child of mod.children)walk(child);}for(const name of Object.keys(OLD_READER_PINS))walk(require.cache[oldRequire.resolve('./'+name)]);}
 return {candidate,old,req,oldReq,candidateRequire,oldRequire,assertOldIsolation};
}
function syntheticBytes(g){
 const tools=envPath('GP_AF_TEST_TOOLS_ROOT');sealed(tools);for(const [name,bytes,sha]of TOOL_PINS){const p=file(tools,name);sealed(p);const b=fs.readFileSync(p);assert.equal(b.length,bytes);assert.equal(hash(b),sha);}
 const policy=g.req('lib/data-import-af-verifier-policy').runtime;assert(policy);const root=path.resolve(g.candidate,policy.installPrefix);sealed(root);
 const descriptorBytes=fs.readFileSync(file(root,policy.descriptorPath));assert.equal(hash(descriptorBytes),policy.descriptorSha256);const d=JSON.parse(descriptorBytes);
 for(const pin of d.files){const p=file(root,pin.path);sealed(p);const b=fs.readFileSync(p);assert.equal(b.length,pin.bytes);assert.equal(hash(b),pin.sha256);}
 const classpath=[tools,path.join(root,d.helperClassesRoot),...d.jars.map(j=>file(root,j.path))].join(path.delimiter);
 const env={LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TZ:'UTC',PATH:'/usr/bin:/bin'};
 const emitted=spawnSync(file(root,d.javaPath),['-Dfile.encoding=UTF-8','-Djava.io.tmpdir=/nonexistent/gp-af-test-no-temp','-Xmx128m','-XX:MaxDirectMemorySize=16m','-XX:-HeapDumpOnOutOfMemoryError','-cp',classpath,'KnownAfVerifierFixture','--emit'],{env,timeout:10000,maxBuffer:2*1024*1024,shell:false});
 assert.equal(emitted.error,undefined);assert.equal(emitted.signal,null);assert.equal(emitted.status,0);assert.equal(emitted.stderr.length,0);assert(emitted.stdout.length>=4096&&emitted.stdout.length<2*1024*1024);assert.notEqual(hash(emitted.stdout),CURRENT_ORIGINAL_SHA);return emitted.stdout;
}
async function ownedFixture(g,work){
 const {withCoreFixture}=g.req('test-support/postgresql-migration/core-fixture'),{withSalesFixture}=g.req('test-support/postgresql-migration/sales-fixture');
 return withCoreFixture(core=>withSalesFixture(8,async sales=>{
  await core.application.close();await sales.application.close();let candidateApp,oldApp;
  const options={coreUrl:process.env.GP_CORE_APP_URL,salesUrl:process.env.GP_SALES_APP_URL,stage:8,autoDeliver:true,authorize:async()=>true};
  try{candidateApp=await g.req('lib/persistence/postgresql/boundary/application').openTwoDatabaseDevelopmentApplication(options);oldApp=await g.oldReq('lib/persistence/postgresql/boundary/application').openTwoDatabaseDevelopmentApplication(options);
   assert.notEqual(candidateApp.provider,oldApp.provider);await work({...sales,core,access:candidateApp.provider,oldAccess:oldApp.provider});
  }finally{if(oldApp)await oldApp.close();if(candidateApp)await candidateApp.close();}
 }));
}
async function setup(g,f,bytes){
 const {req,oldReq}=g,C=req('lib/data-import-contract'),M=req('lib/tradefoto-master-profiles'),H=req('lib/tradefoto-history-profiles'),profile=H.profileFor('trade',AF);
 const actor={scopeId:'synthetic-dynamic-af-compatibility',ownerId:'00001'};
 const vault=req('lib/integration-secret-vault').createIntegrationSecretVault({activeKeyId:'synthetic-af-compatibility',keys:{'synthetic-af-compatibility':Buffer.alloc(32,72)}});
 const oldVault=oldReq('lib/integration-secret-vault').createIntegrationSecretVault({activeKeyId:'synthetic-af-compatibility',keys:{'synthetic-af-compatibility':Buffer.alloc(32,72)}});
 const protection=await req('lib/data-import-managed-protection').loadManagedDataImportProtection({access:f.access,vault,create:true,clock:()=>TIME});
 const oldProtection=await oldReq('lib/data-import-managed-protection').loadManagedDataImportProtection({access:f.oldAccess,vault:oldVault,create:false,clock:()=>TIME});assert(oldProtection);assert.notEqual(protection,oldProtection);
 const writers={...req('lib/persistence/repositories/import-master-data').createImportMasterWriters({protection}),...req('lib/persistence/repositories/import-history').createImportHistoryWriters({protection,authorize:()=>true,resolveMasterSourceInstance:()=>INSTANCE})};
 const seedEngine=req('lib/data-import-engine').createDataImportEngine({repository:req('lib/persistence/repositories/data-import').createDataImportRepository(f.access),protection,profiles:[...M.TRADEFOTO_MASTER_PROFILES,profile],sharedPayloads:true,getActor:()=>actor,authorize:()=>true,clock:()=>TIME,writers});
 const MDBReader=(await import(pathToFileURL(g.candidateRequire.resolve('mdb-reader')).href)).default,db=new MDBReader(bytes),physical=db.getTable(AF),rows=physical.getData();assert.equal(physical.rowCount,2);assert.equal(rows.length,3);
 assert.equal(profile.fingerprint,'6f0b0798b089440320a755b9999334aad7ef858a28cb1efacf2e63437eb52a41');assert.equal(profile.schemaSha256,'6eb145ac270d384c290e3f8f67d888c31b6bf75f13b04ac312cbcc1255d6ef7e');
 const eans=[...new Set(rows.map(r=>r.EAN))];assert.equal(eans.length,3);assert.deepEqual([...new Set(rows.map(r=>String(r.FilialID)))],['7']);
 const rawMaster=(name,extra)=>({...Object.fromEntries(M.tableFor(name).columns.map(c=>[c.name,null])),...extra});let ordinal=0;
 async function seed(name,sourceRows){const p=M.profileFor(name),fileSha256=C.fingerprint(['synthetic-dynamic-af-seed',++ordinal,name]);let run=await seedEngine.start({profileHash:p.fingerprint,manifest:{sourceInstance:INSTANCE,fileSha256,schemaSha256:p.schemaSha256,expectedRows:sourceRows.length,declaredRows:sourceRows.length,snapshotAt:PREVIOUS,gates:[]}});
  run=await seedEngine.stage(run.id,{expectedRevision:run.revision,startRow:1,rows:sourceRows.map((r,i)=>M.prepareTradeFotoMasterRow(name,r,{fileSha256,rowNumber:i+1}))});run=await seedEngine.seal(run.id,run.revision);
  for(let n=0;run.status==='reviewing';n++){assert(n<BOUND);run=await seedEngine.review(run.id,run.revision);}assert.equal(run.status,'ready');for(let n=0;run.status!=='applied';n++){assert(n<BOUND);run=await seedEngine.apply(run.id,run.revision);}return run;}
 await seed('FILIALEN',[rawMaster('FILIALEN',{FilialID:'7',FName:'Synthetic branch 7'})]);await seed('ARTIKEL_STAMM',eans.map(EAN=>rawMaster('ARTIKEL_STAMM',{EAN,Artikelbezeichnung:'Synthetic compatibility item'})));
 const permissions=[...Object.values(req('lib/data-import-access').DATA_IMPORT_PERMISSIONS),'sales:analytics:access','sales:analytics:company:read','sales:analytics:inventory:read','sales:history:read','sales:history:unassigned:read'];
 const sessionValue={employeeNumber:'00001',accountId:'synthetic-af-compatibility',isEmployee:true,permissions},session=async()=>sessionValue;
 const {definitions,readTradeFotoFullSource}=req('lib/tradefoto-full-import-source'),defs=definitions('trade');
 const readerFactory=()=>({getTableNames:()=>defs.map(d=>d.name),getTable:name=>{if(name===AF)return physical;const d=defs.find(v=>v.name===name);assert(d);return{rowCount:0,getColumnNames:()=>d.columns.map(c=>c.name),getColumns:()=>d.columns.map(c=>({name:c.name,type:c.type})),getData:()=>[]};}});
 const options={access:f.access,vault,scopeId:actor.scopeId,allowApply:true,sharedPayloads:true,syncArticleCatalog:false,clock:()=>TIME,readSource:o=>readTradeFotoFullSource({...o,readerFactory,send:o.onMessage})};
 const runtime=req('lib/persistence/repositories/data-import-runtime').createDataImportRuntime(options);
 const oldRuntime=oldReq('lib/persistence/repositories/data-import-runtime').createDataImportRuntime({access:f.oldAccess,vault:oldVault,scopeId:actor.scopeId,allowApply:true,sharedPayloads:true,syncArticleCatalog:false,clock:()=>TIME});
 let source=await runtime.upload(session,{buffer:Buffer.from(bytes),kind:'trade',fileName:'Trade_Daten.accdb'});
 for(let n=0;source.status==='reviewing';n++){assert(n<BOUND);source=await runtime.sourceOperation(session,source.id,'review',{expectedRevision:source.revision});}
 assert.equal(source.status,'needs_review');const s={g,f,C,M,H,profile,actor,vault,oldVault,protection,oldProtection,writers,runtime,oldRuntime,session,sessionValue,source,rows,eans,bytes};
 s.table=()=>s.source.tables.find(t=>t.name===AF);s.reload=async()=>{s.source=await runtime.sourceOperation(session,s.source.id,'read');return s.source;};
 s.close=async()=>{await oldRuntime.stop();await runtime.stop();oldProtection.destroy();protection.destroy();};return s;
}
async function noCurrentBusinessWrites(s){for(const [table,column]of[['integration.data_import_changes','run_id'],['integration.import_history_versions','run_id'],['integration.data_import_links','last_run_id'],['integration.import_history_snapshot_members','run_id'],['integration.import_history_snapshots','run_id']])assert.equal((await s.f.client.query('SELECT count(*)::int n FROM '+table+' WHERE '+column+'=$1',[s.table().run.id])).rows[0].n,0);}
async function ownerEventCount(s){return (await s.f.client.query("SELECT count(*)::int n FROM integration.data_import_events WHERE run_id=$1 AND action LIKE 'import.source-tolerance.%'",[s.table().run.id])).rows[0].n;}
async function oldPublication(s){const {oldReq}=s.g,SS=oldReq('lib/persistence/statements/import-history-snapshots').S;
 return s.f.oldAccess.transaction(async tx=>{const snapshots=oldReq('lib/persistence/repositories/import-history-snapshots').createHistorySnapshots({protection:s.oldProtection}),h=await snapshots.publication(tx,s.table().run.id);
  assert.equal(h.status,'published');assert.equal(h.expectedRows,3);assert.equal(h.coverageVerified,1);assert.equal(h.fileSha256,hash(s.bytes));assert.equal(h.profileHash,s.profile.fingerprint);
  assert.deepEqual(await tx.queryOne(SS.coverage,{runId:h.runId}),{count:3,first:1,last:3,qualified:3});
  const active=await oldReq('lib/persistence/repositories/history-snapshot-source').latestHistorySource(tx,{scopeId:s.actor.scopeId,sourceInstance:INSTANCE,source:'trade',table:AF,protection:s.oldProtection});assert.equal(active.id,h.runId);
  const members=(await s.f.client.query('SELECT row_number,record_id,revision,payload FROM integration.import_history_snapshot_members WHERE run_id=$1 ORDER BY row_number',[h.runId])).rows;assert.equal(members.length,3);
  const service=oldReq('lib/persistence/repositories/import-history').createImportHistoryService({access:s.f.oldAccess,executor:tx,protection:s.oldProtection,getActor:()=>s.actor,authorize:request=>request.dataClasses.every(c=>c==='internal_business')});
  const observed=new Map();for(const m of members){const value=await service.detail(m.record_id,{revision:Number(m.revision),snapshot:h.runId});assert.equal(value.snapshot.runId,h.runId);assert.equal(value.snapshot.fileSha256,hash(s.bytes));assert.equal(value.fields.FilialID,'7');observed.set(value.fields.EAN,String(value.fields.FBestand));
   const record=await tx.queryOne(oldReq('lib/persistence/statements/import-history').IMPORT_HISTORY_STATEMENTS.get,{scopeId:s.actor.scopeId,id:m.record_id});
   const writer=oldReq('lib/persistence/repositories/import-history').createImportHistoryWriters({protection:s.oldProtection,authorize:()=>true,resolveMasterSourceInstance:()=>INSTANCE})[s.profile.entity];
   const context={scopeId:h.scopeId,ownerId:h.ownerId,sourceInstance:h.sourceInstance,sourceSystem:s.profile.sourceSystem,sourceTable:AF,profileHash:h.profileHash,fileSha256:h.fileSha256,snapshotAt:h.snapshotAt,runId:h.runId,expectedRows:h.expectedRows,at:TIME};
   const target=await writer.read(tx,record.id,context);const memberContext=['history-snapshot',h.runId,h.scopeId,h.sourceInstance,h.profileHash,h.fileSha256,h.snapshotAt,h.ownerId,h.expectedRows,'building','member',Number(m.row_number),m.record_id,Number(m.revision)];
   assert.deepEqual(s.oldProtection.open(m.payload,memberContext),{dataHash:s.oldProtection.digest(target.data)});
  }assert.deepEqual([...observed].sort(),s.rows.map(r=>[r.EAN,String(r.FBestand)]).sort());
  assert.equal((await s.f.client.query('SELECT count(*)::int n FROM integration.import_history_snapshot_attestations a JOIN integration.import_history_snapshots h USING(run_id) WHERE h.run_id=$1 AND a.header_payload=h.payload',[h.runId])).rows[0].n,1);
  return h;
 },{isolation:'serializable',readOnly:true});
}
async function oldBusinessReads(s,today=TIME.slice(0,10)){const {oldReq}=s.g;
 const publicRuntime=oldReq('lib/persistence/repositories/trade-insights').createTradeInsightRuntime({access:s.f.oldAccess,vault:s.oldVault,scopeId:s.actor.scopeId,today:()=>today});
 const inventory=await publicRuntime.run(s.session,'inventory',{});assert.equal(inventory.available,true);assert.equal(inventory.next,null);assert.equal(inventory.rows.length,3);
 assert.deepEqual(inventory.rows.map(r=>[r.articleNumber,String(r.stock)]).sort(),s.rows.map(r=>[r.EAN,String(r.FBestand)]).sort());
 const summary=await publicRuntime.run(s.session,'stock-summary',{});assert.equal(summary.available,true);assert.equal(summary.complete,true);assert.equal(summary.next,null);assert.equal(summary.totals.positions,3);
 const D=oldReq('lib/tradefoto-bestell/decimal');assert.equal(summary.totals.quantity,s.rows.reduce((n,r)=>D.add(n,String(r.FBestand)),'0'));assert.equal(summary.totals.ambiguous,0);assert.equal(summary.totals.missingArticle,0);
 await s.f.oldAccess.transaction(async tx=>{const reader=oldReq('lib/persistence/repositories/sales-master-data').createSalesMasterReader({protection:s.oldProtection,scopeId:s.actor.scopeId,batch:true});for(const row of s.rows){const result=await oldReq('lib/sales-article-branch-stock').loadSalesArticleBranchStock({access:s.f.oldAccess,tx,protection:s.oldProtection,reader,article:{sourceArticleKey:row.EAN,productId:'synthetic-product-'+row.EAN},scopeId:s.actor.scopeId,session:s.sessionValue,deferOrderDetails:true});assert.equal(result.rows.length,1);assert.equal(result.rows[0].id,'7');assert.equal(String(result.rows[0].quantity),String(row.FBestand));assert.equal(result.rows[0].ambiguous,false);assert(result.sourceAt);}}, {isolation:'serializable',readOnly:true});
 const denied=async()=>({...s.sessionValue,permissions:[]});await assert.rejects(publicRuntime.run(denied,'inventory',{}),isCode('IMPORT_FORBIDDEN'));await assert.rejects(publicRuntime.run(denied,'stock-summary',{}),isCode('IMPORT_FORBIDDEN'));
 const narrow=async()=>({...s.sessionValue,permissions:s.sessionValue.permissions.filter(p=>p!=='sales:analytics:company:read').concat('sales:analytics:location:read'),scopes:[{locationId:'999999',departmentId:0}]});
 const hidden=await publicRuntime.run(narrow,'inventory',{});assert.equal(hidden.rows.length,0,'Foreign authorized location must not reveal unmapped source branch');
}

test('external AF compatibility qualification requires its own complete explicit opt-in',()=>{
 assert.equal(compatibilityOptIn({GP_PG_MIGRATION_LIVE:'1'}),false,'General native CI must not imply an external old006/Java fixture');
 const complete={GP_IMPORT_AF_COMPATIBILITY_LIVE:'1',GP_PG_MIGRATION_LIVE:'1',GP_IMPORT_CANDIDATE_ROOT:'/candidate',
  GP_IMPORT_OLD_SOURCE_ROOT:'/old006',GP_IMPORT_OLD_MANIFEST_PATH:'/manifest',GP_AF_TEST_TOOLS_ROOT:'/tools'};
 assert.equal(compatibilityOptIn(complete),true);
 for(const name of ['GP_PG_MIGRATION_LIVE','GP_IMPORT_CANDIDATE_ROOT','GP_IMPORT_OLD_SOURCE_ROOT','GP_IMPORT_OLD_MANIFEST_PATH','GP_AF_TEST_TOOLS_ROOT']){
  const missing={...complete};delete missing[name];assert.throws(()=>compatibilityOptIn(missing),assert.AssertionError,name);
 }
});

test('Native new-hash AF proof: separate owner approval and old006 authenticated business-reader compatibility',{skip:!EXTERNAL_LIVE&&'External old006/default-Java qualification requires GP_IMPORT_AF_COMPATIBILITY_LIVE=1',timeout:600000},async t=>{
 assert.equal(compatibilityOptIn(process.env),true);
 async function sub(name,work){let completed=false;await t.test(name,async()=>{await work();completed=true;});assert(completed,'Stop after failed compatibility subcase: '+name);}
 const g=loadGraphs(),bytes=syntheticBytes(g);
 try{await ownedFixture(g,async f=>{const s=await setup(g,f,bytes);try{
  await sub('real MDB + default Java factory yields exact new-hash evidence without business writes or owner approval',async()=>{
   const table=s.table();assert.equal(table.declaredRows,2);assert.equal(table.run.expectedRows,3);assert.equal(table.run.receivedRows,3);assert(table.run.gates.includes('SOURCE_ROW_COUNT_MISMATCH'));assert.equal(table.run.sourceToleranceReceipts.length,0);await noCurrentBusinessWrites(s);
   const before=await ownerEventCount(s),request=await s.runtime.verificationRequest(s.session,s.source.id);assert(request);assert.equal(request.fileSha256,hash(bytes));assert.equal(request.declaredRows,2);assert.equal(request.expectedRows,3);
   const verifier=g.req('lib/data-import-af-verifier').createKnownAfSourceVerifier();let evidence;const verifierBytes=Buffer.from(bytes);try{evidence=await verifier.verify({request,buffer:verifierBytes});}finally{verifierBytes.fill(0);}
   assert.equal(evidence.result.allFourIndexesExact,true);assert.equal(evidence.result.counts.logicalRows,3);assert.equal(evidence.result.counts.headerRows,2);assert.equal(evidence.result.indexes.length,4);
   s.source=await s.runtime.attachIndependentCountProof(s.session,s.source.id,{expectedRevision:request.sourceRevision,evidence});assert.equal(s.source.independentCountVerification.verified,true);assert.equal(Object.hasOwn(s.source,'independentCountProof'),false);
   assert(s.table().run.gates.includes('SOURCE_ROW_COUNT_MISMATCH'));assert.equal(s.table().run.sourceToleranceReceipts.length,0);assert.equal(s.table().run.availableSourceTolerances.length,1);assert.equal(s.table().run.availableSourceTolerances[0].requiresExplicitApproval,true);
   assert.equal(await ownerEventCount(s),before);await noCurrentBusinessWrites(s);await assert.rejects(s.runtime.sourceOperation(s.session,s.source.id,'apply',{expectedRevision:s.source.revision}),isCode('IMPORT_DECISION_GATE'));await noCurrentBusinessWrites(s);
  });
  await sub('actual old006 graph cannot approve an unknown dynamic proof or bypass its count mismatch',async()=>{
   const old=await s.oldRuntime.sourceOperation(s.session,s.source.id,'read'),table=old.tables.find(v=>v.name===AF);assert(table.run.gates.includes('SOURCE_ROW_COUNT_MISMATCH'));assert.equal(table.run.availableSourceTolerances.length,0);
   const before=await ownerEventCount(s);await assert.rejects(s.oldRuntime.sourceOperation(s.session,s.source.id,'approve-counts',{expectedRevision:old.revision}),isCode('IMPORT_TOLERANCE_UNAVAILABLE'));assert.equal(await ownerEventCount(s),before);await noCurrentBusinessWrites(s);
  });
  await sub('candidate owner receipt permits exact three-member AF publication, readable and authenticated by old006',async()=>{
   await s.reload();s.source=await s.runtime.sourceOperation(s.session,s.source.id,'approve-counts',{expectedRevision:s.source.revision});assert.equal(s.table().run.gates.length,0);assert.equal(s.table().run.sourceToleranceReceipts.length,1);await noCurrentBusinessWrites(s);
   for(let n=0;s.source.status!=='applied';n++){assert(n<BOUND,'Bounded complete source apply');s.source=await s.runtime.sourceOperation(s.session,s.source.id,'apply',{expectedRevision:s.source.revision});}
   assert.equal(s.table().run.counts.applied,3);assert.equal(s.table().deferred,undefined);await oldPublication(s);await oldBusinessReads(s);
   const old=await s.oldRuntime.sourceOperation(s.session,s.source.id,'read'),oldTable=old.tables.find(v=>v.name===AF);assert(oldTable.run.gates.includes('SOURCE_ROW_COUNT_MISMATCH'));assert(oldTable.run.gates.includes('SOURCE_TOLERANCE_UNAVAILABLE'));assert.equal(oldTable.run.availableSourceTolerances.length,0);
  });
  await sub('old importer expiry and public scope/ACL gates remain enforced while historical business data stays readable',async()=>{
   const oldWriters={...g.oldReq('lib/persistence/repositories/import-master-data').createImportMasterWriters({protection:s.oldProtection}),...g.oldReq('lib/persistence/repositories/import-history').createImportHistoryWriters({protection:s.oldProtection,authorize:()=>true,resolveMasterSourceInstance:()=>INSTANCE})};
   const expiredClock=new Date(Date.parse(TIME)+31*86400000).toISOString();
   const expired=g.oldReq('lib/data-import-engine').createDataImportEngine({repository:g.oldReq('lib/persistence/repositories/data-import').createDataImportRepository(f.oldAccess),protection:s.oldProtection,profiles:[...g.oldReq('lib/tradefoto-master-profiles').TRADEFOTO_MASTER_PROFILES,...g.oldReq('lib/tradefoto-history-profiles').TRADEFOTO_HISTORY_READABLE_PROFILES],sharedPayloads:true,getActor:()=>s.actor,authorize:()=>true,writers:oldWriters,clock:()=>expiredClock});
   await assert.rejects(expired.acceptSourceTolerance(s.table().run.id,s.table().run.revision),isCode('IMPORT_RUN_EXPIRED'));await oldPublication(s);await oldBusinessReads(s,expiredClock.slice(0,10));
   await assert.rejects(s.oldRuntime.sourceOperation(async()=>({...s.sessionValue,permissions:[]}),s.source.id,'read'),isCode('IMPORT_FORBIDDEN'));g.assertOldIsolation();
  });
 }finally{await s.close();}});}finally{bytes.fill(0);}
});
