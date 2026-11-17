'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),os=require('node:os');
const {createRequire,Module}=require('node:module');
const {captureCheckpoint,verifyCheckpoint}=require('../lib/persistence/postgresql/operations/paired-checkpoint');
const {RULES,buildSalesPlan}=require('../lib/persistence/postgresql/operations/deploy-data-policy');
const projectedCounts=()=>RULES.filter(t=>t.mode==='projection').map(t=>({...t,rows:t.table==='data_import_changes'?900:0}));

function checkpointClient({restored=false,imageRows='2',schemaChanged=false,sequenceChanged=false}={}){
 const queries=[],counts=new Map([
  ['"gp"."environment_contract"','1'],['"integration"."data_import_changes"','900'],
  ['"kassa"."cash_snapshot_0"',restored?'0':'8000000'],['"kassa"."cash_snapshot_4"',restored?'0':'15000000'],
  ['"trade"."new_owned_annotation"','3'],['"trade"."sales_article_own_images"',imageRows],
  ['"trade"."sales_article_search_projection"',restored?'0':'19000'],
 ]);
 const tables=[...counts.keys()].map(name=>{const [schemaname,tablename]=name.replaceAll('"','').split('.');return {schemaname,tablename};});
 const client={async query(sql){
  queries.push(sql);
  if(sql.includes('FROM pg_tables'))return {rows:tables};
  if(sql.startsWith('SELECT count(*)::text AS n FROM ')){
   const name=sql.slice('SELECT count(*)::text AS n FROM '.length);assert.ok(counts.has(name),name);return {rows:[{n:counts.get(name)}]};
  }
  if(sql.startsWith('SELECT n.nspname AS schema,c.relname AS name'))return {rows:[{schema:'trade',name:'retained_identity_seq'}]};
  if(sql.startsWith('SELECT last_value::text'))return {rows:[{value:sequenceChanged?'24':'23',called:true}]};
  if(sql.includes('SELECT kind,name,definition FROM'))return {rows:[{kind:'relation',name:'synthetic-schema',definition:schemaChanged?'changed':'retained schema'}]};
  if(sql.startsWith('SET LOCAL search_path='))return {rows:[]};
  throw new Error('Unexpected checkpoint adapter query: '+sql);
 }};
 return {client,queries};
}

test('reduced checkpoints skip only reviewed bulk counts while retaining every table, owned count, sequence and schema contract',async()=>{
 const source=checkpointClient(),reduced=await captureCheckpoint(source.client,'sales',{excludedTables:RULES,projectedTables:projectedCounts()});
 const counted=source.queries.filter(sql=>sql.startsWith('SELECT count(*)'));
 assert.ok(!counted.some(sql=>sql.includes('cash_snapshot_')));
 assert.ok(!counted.some(sql=>sql.endsWith('"trade"."sales_article_search_projection"')));
 assert.ok(counted.some(sql=>sql.endsWith('"trade"."sales_article_own_images"')));
 assert.ok(counted.some(sql=>sql.endsWith('"trade"."new_owned_annotation"')));
 assert.ok(!counted.some(sql=>sql.endsWith('"integration"."data_import_changes"')));
 assert.equal(reduced.tables.find(t=>t.table==='data_import_changes').rows,'900');
 assert.equal(reduced.tables.length,7);
 assert.deepEqual(reduced.tables.filter(row=>row.table.startsWith('cash_snapshot_')).map(row=>row.rows),['0','0']);
 assert.deepEqual(reduced.sequences,[{schema:'trade',name:'retained_identity_seq',value:'23',called:true}]);
 const full=await captureCheckpoint(checkpointClient().client,'sales');
 assert.equal(full.schemaSha256,reduced.schemaSha256);assert.deepEqual(full.sequences,reduced.sequences);
 assert.equal(full.tables.find(row=>row.table==='cash_snapshot_0').rows,'8000000');
 assert.equal(full.tables.find(row=>row.table==='cash_snapshot_4').rows,'15000000');
 assert.equal(full.tables.find(row=>row.table==='sales_article_search_projection').rows,'19000');
});

test('restored owned counts, schema or sequence loss rejects the same reduced checkpoint',async()=>{
 const expected=await captureCheckpoint(checkpointClient().client,'sales',{excludedTables:RULES,projectedTables:projectedCounts()});
 assert.equal((await verifyCheckpoint(checkpointClient({restored:true}).client,'sales',expected)).tables,7);
 for(const options of [{imageRows:'0'},{schemaChanged:true},{sequenceChanged:true}])await assert.rejects(
  verifyCheckpoint(checkpointClient({restored:true,...options}).client,'sales',expected),/PG_PAIR_RESTORE_CHECKPOINT_MISMATCH/);
});

test('Core data and nonreviewed Sales tables can never be excluded from checkpoint verification',async()=>{
 const core=checkpointClient();await assert.rejects(captureCheckpoint(core.client,'core',{excludedTables:RULES}),/PG_DEPLOY_CORE_EXCLUSION/);
 assert.ok(!core.queries.some(sql=>sql.startsWith('SELECT count(*)')));
 const sales=checkpointClient();await assert.rejects(captureCheckpoint(sales.client,'sales',{excludedTables:[{schema:'trade',table:'sales_article_own_images'}]}),/PG_DEPLOY_TABLE_EXCLUSION/);
 assert.ok(!sales.queries.some(sql=>sql.startsWith('SELECT count(*)')));
});

test('actual backup runtime applies data-only exclusions exclusively to reduced Sales dumps and never updates full-backup status',async t=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'gp-owned-runtime-'));fs.chmodSync(root,0o700);
 t.after(()=>{assert.equal(path.dirname(fs.realpathSync(root)),fs.realpathSync(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
 const sourceRoot=path.join(root,'source');fs.mkdirSync(path.join(sourceRoot,'private'),{recursive:true,mode:0o700});
 fs.writeFileSync(path.join(sourceRoot,'private','owned-image.bin'),'synthetic protected own image bytes',{mode:0o600});
 const environmentFile=path.join(root,'configuration.env');fs.writeFileSync(environmentFile,'SYNTHETIC_ONLY=1\n',{mode:0o600});
 const filename=path.resolve(__dirname,'../lib/persistence/postgresql/operations/runtime.js'),realRequire=createRequire(filename);
 for(const scope of ['deploy-owned','full']){
  const events=[],native=[],snapshots={},statusWrites=[],bundle=path.join(root,scope);fs.mkdirSync(bundle,{mode:0o700});
  for(const domain of ['core','sales']){
   const f=checkpointClient(),base=f.client.query;
   f.client.query=async(sql,parameters)=>{
    if(sql.includes('pg_database_size'))return {rows:[{bytes:'1048576'}]};
    if(sql.includes('COALESCE(sum(pg_total_relation_size'))return {rows:[{bytes:'524288'}]};
    return base(sql,parameters);
   };snapshots[domain]=f;
  }
  const salesTables=[...RULES.map(({schema,table})=>({schema,table})),{schema:'trade',table:'sales_article_own_images'},{schema:'gp',table:'environment_contract'}];
  const recovery={scope:'deploy-owned',salesPlan:buildSalesPlan({tables:salesTables,foreignKeys:[]}),accessPlan:{tables:projectedCounts()}};
  class Pool{
   constructor(options){this.domain=options.database.endsWith('core')?'core':'sales';}
   async connect(){return {query:async sql=>{assert.ok(sql.includes('pg_stat_activity')||sql.startsWith('SET LOCAL statement_timeout=')||['BEGIN READ ONLY','ROLLBACK'].includes(sql),sql);return {rows:sql.includes('pg_stat_activity')?[{n:0}]:[]};},release(){}};}
   async end(){events.push('pool-end');}
  }
  const mocks={
   'pg':{Pool},
   'node:fs':{...fs,copyFileSync(from,to,flags){
    if(['/etc/grabenplaner/postgresql-application.json','/var/lib/grabenplaner/data/postgresql-pair.json'].includes(from))return fs.writeFileSync(to,'synthetic binding',{flag:'wx',mode:0o600});
    return fs.copyFileSync(from,to,flags);
   }},
   './owned-recovery':{async prepareOwnedRecovery({core,sales}){assert.equal(core,snapshots.core.client);assert.equal(sales,snapshots.sales.client);events.push('prepare-owned');return recovery;},
    async sourceArchive(){events.push('verify-archive');return {available:false};},
    async verifyOwnedRecovery({core,sales,sourceRoot:copied,recovery:actual}){assert.equal(core,snapshots.core.client);assert.equal(sales,snapshots.sales.client);assert.equal(copied,bundle);assert.equal(actual,recovery);events.push('verify-owned-copy');}},
   './protected-files':{async verifyProtectedRecoveryFiles(client){assert.equal(client,snapshots.core.client);events.push('verify-protected-files');return {verified:true};}},
   './status':{readStatus(){return {};},writeStatus(...args){statusWrites.push(args);}},
   './paired-backup':{async createPairedSnapshot(options){
    assert.equal(options.scope,scope);
    return options.withQuiescedWrites(async()=>{
     if(options.databaseSize)await options.databaseSize({domain:'core',client:snapshots.core.client});
     await options.readCheckpoint({domain:'core',client:snapshots.core.client});
     if(options.databaseSize)await options.databaseSize({domain:'sales',client:snapshots.sales.client});
     const checkpoint=await options.readCheckpoint({domain:'sales',client:snapshots.sales.client});
     assert.equal(checkpoint.restore.tables.find(table=>table.table==='cash_snapshot_0').rows,scope==='full'?'8000000':'0');
     assert.equal(checkpoint.restore.tables.find(table=>table.table==='sales_article_own_images').rows,'2');
     for(const domain of ['core','sales'])await options.runDump({domain,database:'fixture_'+domain,snapshotId:'123-ABC',targetFile:path.join(bundle,domain+'.dump')});
     await options.captureRecoveryFiles({directory:bundle});
     if(scope!=='full')assert.equal(await options.recoveryContract(),recovery);
     return {createdAt:'2026-11-16T00:00:00.000Z',sha256:'synthetic-marker',bundle,phaseTimings:[]};
    });
   }},
  };
  const subject=new Module(filename,module);subject.filename=filename;subject.paths=Module._nodeModulePaths(path.dirname(filename));
  subject.require=name=>Object.hasOwn(mocks,name)?mocks[name]:realRequire(name);
  subject.__nativeStub=async(_config,name,args,output)=>{native.push({name,args});fs.writeFileSync(output.outputFile,'explicitly synthetic tool output',{flag:'wx',mode:0o600});};
  subject._compile(fs.readFileSync(filename,'utf8')+'\ninspectPair=async()=>({core:{},sales:{}});nativeTool=module.__nativeStub;verifyPriceLabelImageFiles=async()=>2;',filename);
  const config={mode:'productive',sourceFiles:sourceRoot,environmentFile,backupDirectory:bundle,workDirectory:bundle,host:'synthetic',port:1,binding:{},
   administrator:{role:'synthetic',password:'synthetic'},domains:['core','sales'].map(domain=>({domain,database:'fixture_'+domain,role:'gp_'+domain+'_migrator',password:'synthetic'}))};
  const result=await subject.exports.createBackup(config,{scope});assert.equal(result.ok,true);
  assert.equal(fs.readFileSync(path.join(bundle,'private','owned-image.bin'),'utf8'),'synthetic protected own image bytes');
  const dumps=native.filter(tool=>tool.name==='pg_dump');assert.equal(dumps.length,2);
  for(const dump of dumps){
   const exclusions=dump.args.argv.filter(argument=>argument.startsWith('--exclude-table-data='));
   assert.equal(exclusions.length,scope==='deploy-owned'&&dump.args.database==='fixture_sales'?RULES.length:0);
   assert.ok(!exclusions.some(argument=>argument.includes('own_images')));
  }
  assert.equal(statusWrites.length,scope==='full'?1:0);
  assert.equal(events.includes('verify-owned-copy'),scope==='deploy-owned');assert.equal(events.filter(event=>event==='pool-end').length,2);
 }
});

// The native process, filesystem and SQL boundaries below are adapters. The
// production restore orchestrator itself runs unchanged; no cluster is launched.
function restoreFixture({bundleScope='deploy-owned',archiveError=null,ownedError=null,compact=false,fresh=false,replayError=null,replayVerified=true,cashVerified=true,prepareVerified=true}={}){
 const file=path.resolve(__dirname,'../lib/persistence/postgresql/operations/paired-restore.js'),localRequire=createRequire(file);
 const events=[],mutations=[],clients=[],native=[];
 const accounts=Object.fromEntries(['gp_migration_admin','gp_operations_monitor',...['core','sales'].flatMap(domain=>['app','reader','migrator'].map(purpose=>'gp_'+domain+'_'+purpose))].map(name=>[name,'x'.repeat(24)]));
 const config={format:'grabenplaner-postgresql-operations-v1',recoveryAccounts:accounts,domains:['core','sales'].map(domain=>({domain,database:'fixture_'+domain,environmentId:'synthetic',profile:'synthetic'}))};
 const verified={manifestSha256:'synthetic-marker-pin',manifest:{files:[{file:'postgresql-operations.json',bytes:1024}],databases:config.domains,
  checkpoint:{domains:{core:{restore:{}},sales:{restore:{}}}},recovery:{scope:'deploy-owned',...(fresh?{basis:'fresh-source-rebuild',freshSourcePlan:{}}:{}),accessPlan:fresh?{format:'grabenplaner-access-owned-state-v4'}:compact?{format:'grabenplaner-access-owned-state-v3'}:{},rehydrationDatabaseBytes:{core:1048576,sales:1048576}}}};
 class Client{
  constructor(options){this.options=options;this.bootstrap=options.database==='postgres';this.closed=false;clients.push(this);}
  async connect(){events.push(this.bootstrap?'admin-connect':'client-connect');}
  async query(sql){
   assert.equal(this.closed,false);
   if(sql.startsWith('CREATE DATABASE'))mutations.push('create-database');
   if(sql==='DELETE FROM trade.sales_article_search_projection')events.push('clear-replayed-search');
   if(sql.startsWith('SELECT format'))return {rows:[{sql:'synthetic role password assignment'}]};
   if(sql.includes('FROM gp.environment_contract')){const domain=config.domains.find(domain=>domain.database===this.options.database);return {rows:[{domain:domain.domain,environment_id:domain.environmentId,profile:domain.profile}]};}
   if(sql.includes('FROM gp.data_import_runtime_keys'))return {rows:[{payload:'synthetic-key'}]};
   return {rows:[]};
  }
  async end(){this.closed=true;events.push(this.bootstrap?'admin-end':'client-end');}
 }
 const virtualFs={
  statSync:name=>({uid:name.startsWith('/usr/')?0:500}),readdirSync:()=>[],statfsSync:()=>({bavail:20,bsize:1024**3}),
  mkdtempSync(){mutations.push('create-socket');return '/tmp/gp-pg-recovery-synthetic';},
  chmodSync(){mutations.push('chmod');},mkdirSync(){mutations.push('mkdir');},writeFileSync(){mutations.push('write');},appendFileSync(){mutations.push('append');},unlinkSync(){mutations.push('unlink');},
  closeSync(){},openSync(){mutations.push('open');return 3;},lstatSync:()=>({uid:0,mode:0o755,isFile:()=>true}),realpathSync:name=>name,
  rmSync(name){assert.equal(name,'/tmp/gp-pg-recovery-synthetic');events.push('socket-removed');},
  readFileSync(name){
   if(name.endsWith('/postgresql-operations.json'))return JSON.stringify(config);
   if(name.endsWith('/roles.sql'))return 'CREATE ROLE gp_migration_admin;\n';
   if(name.endsWith('/configuration.env'))return '';
   throw new Error('Unexpected synthetic restore file: '+name);
  },
 };
 const owned={recoveryVault:()=>({}),withProtection:async(_core,_vault,work)=>work({}),async sourceArchive(){events.push('archive-authentication');if(archiveError)throw archiveError;return {verified:true};},
  async verifyOwnedRecovery(){events.push('owned-verification');if(ownedError)throw ownedError;return {verified:true};},
  async rehydrateOwnedSources(options){events.push('source-replay');if(fresh)assert.equal(options.freshSourceDirectory,'/synthetic/fresh-access');if(replayError)throw replayError;return {verified:replayVerified,rehydrated:replayVerified,...(fresh?{cash:{verified:cashVerified,rowsRestored:7}}:{})};},
  async rehydrateOwnedCash(){events.push('cash-rehydration');return {verified:true,rowsRestored:7};}};
 const mocks={
  'node:fs':virtualFs,'node:path':path.posix,'pg':{Client},
  'node:child_process':{spawn(binary,args){const stop=binary.endsWith('/pg_ctl')&&args.at(-1)==='stop';native.push({binary,args});if(stop)events.push('cluster-stop');return {once(){},stop};}},
  './paired-bundle':{safeRoot(){},async verifyPairBundle(_bundle,_marker,{scope}){events.push('verify-bundle-'+scope);if(scope!==bundleScope)throw new Error('PG_PAIR_MARKER');return verified;}},
  './paired-checkpoint':{async verifyCheckpoint(_client,domain){events.push('verify-'+domain);return {verified:true};}},
  './runtime':{async verifyPriceLabelImageFiles(){events.push('verify-protected-images');return 2;}},
  './owned-recovery':owned,
  './access-owned-state':{async restoreOwnedState(){events.push('sparse-owned-state');return {verified:true,rehydrated:false,requiresAccessRehydration:true};}},
  './access-fresh-rebuild':{async prepareFreshRestore(){events.push('invalidate-cash-readiness');return {verified:prepareVerified};}},
  './access-recovery-projection':{async restoreProjection({rehydrate}){events.push('access-projection');return {verified:true,rehydrated:rehydrate};},async rebuildSearchProjection(){events.push('rebuild-search');return {verified:true};}},
  '../../../data-import-source-archive':{createImportSourceArchive:()=>({})},
  './restore-privileges':{async materializeDefaultPrivileges(){}},'../sales/layout':{SCHEMAS:['synthetic']},
  '../../../../server-tools/linux/recovery/lib/recovery-shared':{protectedRecordChecks:function*(){return 0;}},
  '../../../../server-tools/linux/recovery/lib/postgresql-recovery-activity':{childCompletion:()=>Promise.resolve({code:0}),monitorActivity:({completion})=>completion,terminateAndConfirm(){},readCgroupActivity(){},processCgroup(){}},
  '../../../amu-storage':{validateEncryptionKeyForStorage:()=>({fileCount:0}),createAmuStorage:()=>({})},
  '../../../integration-secret-vault':{createIntegrationSecretVault:()=>({useSecret:async(_secret,_context,work)=>work(Buffer.alloc(64))})},
 };
 const context={module:{exports:{}},process:{platform:'linux',getuid:()=>500},performance,Buffer,require:name=>Object.hasOwn(mocks,name)?mocks[name]:localRequire(name)};
 vm.runInNewContext(fs.readFileSync(file,'utf8'),context,{filename:file});
 return {events,mutations,native,clients,run:options=>context.module.exports.restorePair({bundle:'/synthetic/bundle',commitMarker:'/synthetic/marker',workRoot:'/synthetic/work',sourceArchiveDirectory:'/synthetic/access-sources',...options})};
}

test('restore callback and bundle scope mismatches reject before creating files, databases or native processes',async()=>{
 for(const options of [{scope:'deploy-owned',onRestored:async()=>{}},{scope:'full',onOwnedRestored:async()=>{}},{scope:'full',rehydrate:true},{scope:'core'}]){
  const f=restoreFixture();await assert.rejects(f.run(options));assert.deepEqual(f.mutations,[]);assert.deepEqual(f.native,[]);assert.deepEqual(f.events,[]);
 }
 for(const [bundleScope,scope] of [['full','deploy-owned'],['deploy-owned','full']]){
  const f=restoreFixture({bundleScope});await assert.rejects(f.run({scope}),/PG_PAIR_MARKER/);assert.deepEqual(f.mutations,[]);assert.deepEqual(f.native,[]);
 }
});

test('owned restore authenticates protected files and copied source plans before its scoped callback without claiming full recovery',async()=>{
 const f=restoreFixture();const result=await f.run({scope:'deploy-owned',onOwnedRestored:async({rehydrated})=>{assert.equal(rehydrated,false);assert.ok(f.clients.every(client=>client.closed));f.events.push('owned-callback');return {fullApplicationSmoke:false,passed:true};}});
 assert.equal(result.providerId,'postgresql-deploy-owned');assert.equal(result.fullRecovery,false);assert.equal(result.requiresCashRehydration,true);
 assert.equal(result.protectedPriceLabelImages,2);
 for(const event of ['verify-core','verify-sales','verify-protected-images','archive-authentication','owned-verification'])assert.ok(f.events.indexOf(event)<f.events.indexOf('owned-callback'),event);
 assert.equal(f.events.includes('cash-rehydration'),false);
 assert.deepEqual(f.events.slice(-3),['verify-bundle-deploy-owned','cluster-stop','socket-removed']);
});

test('cash rehydration is explicit and still cannot promote an owned point to a full recovery',async()=>{
 const f=restoreFixture();const result=await f.run({scope:'deploy-owned',rehydrate:true,onOwnedRestored:async({rehydrated})=>{assert.equal(rehydrated,true);f.events.push('callback');return {passed:true};}});
 assert.equal(result.fullRecovery,false);assert.equal(result.requiresCashRehydration,false);assert.equal(result.cashRehydration.rowsRestored,7);
 assert.ok(f.events.indexOf('owned-verification')<f.events.indexOf('cash-rehydration'));
 assert.ok(f.events.indexOf('cash-rehydration')<f.events.indexOf('callback'));
 const premature=restoreFixture();await assert.rejects(premature.run({scope:'deploy-owned',onOwnedRestored:async()=>({fullApplicationSmoke:true})}),/PG_RECOVERY_FULL_SMOKE_SCOPE/);
 assert.deepEqual(premature.events.slice(-2),['cluster-stop','socket-removed']);
});

test('sparse recovery restores GP rows first and replays sources and cash before rebuilding search or exposing the application',async()=>{
 const f=restoreFixture({compact:true});
 const result=await f.run({scope:'deploy-owned',rehydrate:true,onOwnedRestored:async()=>{f.events.push('callback');return {passed:true};}});
 assert.equal(result.fullRecovery,false);assert.equal(result.accessRehydration.rehydrated,true);
 assert.equal(result.accessRehydration.requiresAccessRehydration,false);
 assert.equal(result.accessRehydration.sourceReplay.verified,true);
 const order=['sparse-owned-state','verify-sales','verify-protected-images','owned-verification','source-replay','cash-rehydration','clear-replayed-search','rebuild-search','callback'];
 for(let i=1;i<order.length;i++)assert.ok(f.events.indexOf(order[i-1])<f.events.indexOf(order[i]),order.slice(i-1,i+1).join(' before '));
 assert.equal(f.events.includes('access-projection'),false);
});

test('a failed or incomplete source replay cannot reach cash replay or the application and still stops the cluster',async()=>{
 for(const options of [{replayError:new Error('synthetic replay failure')},{replayVerified:false}]){
  const f=restoreFixture({compact:true,...options});let callback=false;
  await assert.rejects(f.run({scope:'deploy-owned',rehydrate:true,onOwnedRestored:async()=>{callback=true;}}),/synthetic replay failure|PG_DEPLOY_SOURCE_REPLAY_INCOMPLETE/);
  assert.equal(callback,false);assert.equal(f.events.includes('cash-rehydration'),false);
  assert.ok(f.clients.every(client=>client.closed));assert.deepEqual(f.events.slice(-2),['cluster-stop','socket-removed']);
 }
});

test('fresh-source restores invalidate omitted cash readiness before any application access and need no historical archive',async()=>{
 for(const rehydrate of [false,true]){
  const f=restoreFixture({fresh:true,archiveError:new Error('historical archive must not be opened')});
  const result=await f.run({scope:'deploy-owned',rehydrate,freshSourceDirectory:'/synthetic/fresh-access',onOwnedRestored:async()=>{f.events.push('callback');return {passed:true};}});
  assert.equal(result.requiresFreshAccess,!rehydrate);assert.equal(result.fullRecovery,false);
  for(const event of ['verify-sales','verify-protected-images','owned-verification'])assert.ok(f.events.indexOf(event)<f.events.indexOf('invalidate-cash-readiness'));
  assert.ok(f.events.indexOf('invalidate-cash-readiness')<f.events.indexOf('callback'));
  assert.equal(f.events.includes('archive-authentication'),false);assert.equal(f.events.includes('cash-rehydration'),false);
  assert.equal(f.events.includes('source-replay'),rehydrate);
  if(rehydrate)assert.equal(result.cashRehydration.verified,true);
 }
 for(const options of [{prepareVerified:false},{cashVerified:false}]){
  const f=restoreFixture({fresh:true,...options});let exposed=false;
  await assert.rejects(f.run({scope:'deploy-owned',rehydrate:true,freshSourceDirectory:'/synthetic/fresh-access',onOwnedRestored:async()=>{exposed=true;}}),/PG_DEPLOY_FRESH_/);
  assert.equal(exposed,false);assert.ok(f.clients.every(client=>client.closed));assert.deepEqual(f.events.slice(-2),['cluster-stop','socket-removed']);
 }
});

test('corrupt source archives and changed recovery bindings prevent callbacks while always closing the disposable cluster',async()=>{
 for(const key of ['archiveError','ownedError']){
  const failure=new Error('synthetic failed '+key),f=restoreFixture({[key]:failure});let callback=false;
  await assert.rejects(f.run({scope:'deploy-owned',onOwnedRestored:async()=>{callback=true;}}),error=>error===failure);
  assert.equal(callback,false);assert.ok(f.clients.every(client=>client.closed));assert.deepEqual(f.events.slice(-2),['cluster-stop','socket-removed']);
 }
});

test('full restore remains the default and uses only the ordinary full application callback',async()=>{
 const f=restoreFixture({bundleScope:'full'});const result=await f.run({onRestored:async()=>{f.events.push('full-callback');return {passed:true};}});
 assert.equal(result.providerId,'postgresql-pair');assert.equal(Object.hasOwn(result,'fullRecovery'),false);assert.equal(Object.hasOwn(result,'ownedRecovery'),false);
 assert.equal(f.events.includes('owned-verification'),false);assert.equal(f.events.includes('cash-rehydration'),false);
 assert.ok(f.events.includes('full-callback'));assert.deepEqual(f.events.slice(-3),['verify-bundle-full','cluster-stop','socket-removed']);
});
