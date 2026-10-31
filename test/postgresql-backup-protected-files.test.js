'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {createAmuStorage}=require('../lib/amu-storage');
const {verifyProtectedRecoveryFiles}=require('../lib/persistence/postgresql/operations/protected-files');
const {createPairedSnapshot}=require('../lib/persistence/postgresql/operations/paired-backup');
const {copyRecoveryFiles}=require('../lib/persistence/postgresql/operations/runtime');
const sourceSchema=require('../lib/persistence/postgresql/contracts/source-schema-v09237.json');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

test('synthetic backup connector rejects unowned endpoints and closes only its two verified restricted pools',async t=>{
 const {Module}=require('node:module'),file=path.resolve(__dirname,'../test-support/postgresql-api/backup-pools.js');
 const values={GP_PG_API_FIXTURE_BRIDGE:'1',GP_CI_POSTGRESQL_FIXTURE:'github-actions-service-v1',CI:'true',GITHUB_ACTIONS:'true',
  TEST_POSTGRESQL_URL:'postgresql://postgres:synthetic@127.0.0.1:5432/grabenplaner_test'};
 for(const domain of ['core','sales'])for(const purpose of ['app','reader','migrator'])values['GP_'+domain.toUpperCase()+'_'+purpose.toUpperCase()+'_URL']='postgresql://gp_'+domain+'_'+purpose+':synthetic@127.0.0.1:5432/gp_migration_'+domain;
 const prior=Object.fromEntries(Object.keys(values).map(name=>[name,process.env[name]]));Object.assign(process.env,values);
 t.after(()=>{for(const [name,value] of Object.entries(prior))if(value===undefined)delete process.env[name];else process.env[name]=value;});
 function subject(state={}){
  const created=[];
  class Pool{
   constructor(options){this.options=options;created.push(this);}
   async connect(){const pool=this,url=new URL(this.options.connectionString),domain=url.pathname.slice('/gp_migration_'.length);
    return{release(error){pool.released=true;pool.releaseError=error;},async query(sql){
     if(sql.includes('current_database() AS database'))return{rows:[{database:'gp_migration_'+domain,username:'gp_'+domain+'_migrator',rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false,rolbypassrls:false,
      environment_id:require('../lib/persistence/postgresql/core/environment').ENVIRONMENT_ID,domain,profile:state.badProfile?'unqualified':require('../lib/persistence/postgresql/core/environment').PROFILE}]};
     if(sql.includes('migration-test-owner')||sql.includes('migration_fixture_owner'))return{rows:[{id:state.badOwner&&domain==='sales'?'synthetic-api-22222222-2222-4222-8222-222222222222':'synthetic-api-11111111-1111-4111-8111-111111111111'}]};
     return{rows:[]};
    }};
   }
   async end(){this.ended=true;if(state.closeError)throw state.closeError;}
  }
  const loaded=new Module(file,module);loaded.filename=file;loaded.paths=Module._nodeModulePaths(path.dirname(file));
  const actualRequire=loaded.require.bind(loaded);loaded.require=name=>name==='pg'?{Pool}:actualRequire(name);loaded._compile(fs.readFileSync(file,'utf8'),file);
  return{run:loaded.exports.withBackupPools,created};
 }
 await t.test('only the exact synthetic pair reaches the callback',async()=>{
  const s=subject();let called=false;
  await s.run(async domains=>{called=true;assert.deepEqual(domains.map(row=>row.database),['gp_migration_core','gp_migration_sales']);
   for(const row of domains){assert.equal(row.pool.options.max,1);assert.equal(row.pool.options.connectionTimeoutMillis,5000);assert.equal(row.pool.options.statement_timeout,10000);assert.equal(row.pool.options.query_timeout,12000);}});
  assert.equal(called,true);assert.equal(s.created.length,2);assert.ok(s.created.every(pool=>pool.released&&pool.ended));
 });
 await t.test('missing explicit fixture authority is refused before any Pool exists',async()=>{
  const s=subject();delete process.env.GP_PG_API_FIXTURE_BRIDGE;
  try{await assert.rejects(s.run(()=>assert.fail('must not run')),/EXPLICIT_SYNTHETIC_ENVIRONMENT/);assert.equal(s.created.length,0);}finally{process.env.GP_PG_API_FIXTURE_BRIDGE=values.GP_PG_API_FIXTURE_BRIDGE;}
 });
 await t.test('a productive endpoint cannot reach a constructor',async()=>{
  const s=subject();process.env.GP_CORE_MIGRATOR_URL='postgresql://gp_core_migrator:synthetic@127.0.0.1:5432/grabenplaner_core';
  try{await assert.rejects(s.run(()=>assert.fail('must not run')),/SYNTHETIC_ENDPOINT/);assert.equal(s.created.length,0);}finally{process.env.GP_CORE_MIGRATOR_URL=values.GP_CORE_MIGRATOR_URL;}
 });
 for(const mode of ['badProfile','badOwner'])await t.test(mode,async()=>{
  const s=subject({[mode]:true});await assert.rejects(s.run(()=>assert.fail('must not run')),mode==='badOwner'?/OWNED_PAIR_REQUIRED/:/environment verification failed/i);
  assert.ok(s.created.every(pool=>pool.released&&pool.ended));
 });
 await t.test('callback failure survives even a later pool cleanup failure',async()=>{
  const error=Error('synthetic primary failure'),s=subject({closeError:Error('synthetic close error')});
  await assert.rejects(s.run(async()=>{throw error;}),caught=>caught===error);assert.ok(s.created.every(pool=>pool.ended));
 });
});

function tree(directory){
 if(!fs.existsSync(directory))return null;
 return Object.fromEntries(fs.readdirSync(directory,{recursive:true}).filter(name=>fs.lstatSync(path.join(directory,name)).isFile()).sort().map(name=>[name,hash(fs.readFileSync(path.join(directory,name)))]));
}
async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gp-protected-pair-'));fs.chmodSync(root,0o700);
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'source'),storageRoot=path.join(source,'private','amu');
 const environment={GRABENPLANER_AMU_KEY_ID:'synthetic',GRABENPLANER_AMU_KEY:Buffer.alloc(32,7).toString('base64'),
  GRABENPLANER_INTEGRATION_KEY_ID:'synthetic',GRABENPLANER_INTEGRATION_KEY:Buffer.alloc(32,8).toString('base64')};
 const storage=createAmuStorage({rootDirectory:storageRoot,encryptionKeys:{synthetic:environment.GRABENPLANER_AMU_KEY},activeKeyId:'synthetic'});
 const metadata=await storage.saveBuffer({buffer:Buffer.from('%PDF-1.7\n% synthetic retained attachment\n%%EOF'),originalName:'attachment.pdf'});
 const context={namespace:'personnel-sensitive-record',recordId:'synthetic-person',field:'payload',employeeNumber:'synthetic-person'};
 const rows={loan_photo_attachments:[{id:'synthetic-attachment',storage_key:metadata.storageKey,filename:'attachment.pdf',detected_mime:metadata.detectedMime,byte_size:metadata.byteSize,sha256:metadata.sha256}],
  loan_photos:[{id:'deleted-original',storage_key:'aa/'+crypto.randomUUID()+'.amu',original_retained:0}],
  personnel_sensitive_records:[{employee_number:'synthetic-person',protected_payload:storage.protectRecord('{"privateEmail":"synthetic@example.test"}',context)}]};
 const queries=[];
 function query(snapshot,sql,values=[]){
  queries.push(sql);
  if(sql.includes('information_schema.columns'))return{rows:(sourceSchema.tables.find(table=>table.name===values[1])?.columns||[]).map(column=>({column_name:column.name}))};
  if(sql.includes('to_regclass'))return{rows:[{present:false}]};
  if(sql.includes('LEFT JOIN personnel_record_document_versions current_version'))return{rows:[]};
  const table=/\bFROM\s+(?:gp\.)?"?([a-z_]+)"?/i.exec(sql)?.[1];
  let result=structuredClone(snapshot[table]||[]);
  if(table==='loan_photos'&&sql.includes('original_retained = 1'))result=result.filter(row=>row.original_retained===1);
  return{rows:result};
 }
 const client={query:async(sql,values)=>query(rows,sql,values)};
 return{root,source,storageRoot,environment,storage,metadata,rows,queries,query,client,options:{sourceDirectory:storageRoot,environment}};
}

test('current protected backup authenticates retained attachments and records without requiring a deliberately deleted original or writing the tree',async t=>{
 const f=await fixture(t),before=tree(f.source);
 const result=await verifyProtectedRecoveryFiles(f.client,f.options);
 assert.deepEqual(result,{verified:true,encryptedFiles:1,fileReferences:1,protectedRecords:1,metadataFiles:1,loanDocuments:0,loanPhotos:0,loanPhotoAttachments:1});
 assert.deepEqual(tree(f.source),before);assert.ok(f.queries.every(sql=>sql.trim().startsWith('SELECT')));
});

test('existing valid 15 MiB personnel document versions remain recoverable above the ordinary 10 MiB upload default',async t=>{
 const f=await fixture(t);f.storage.deleteBlob(f.metadata.storageKey);f.rows.loan_photo_attachments=[];
 const bytes=Buffer.alloc(15*1024*1024,32);Buffer.from('%PDF-1.7\n').copy(bytes);
 const metadata=await f.storage.saveBuffer({buffer:bytes,originalName:'existing-personnel.pdf',maxBytes:15*1024*1024});
 const protected_payload=f.storage.protectRecord(JSON.stringify({byteSize:metadata.byteSize,sha256:metadata.sha256,detectedMime:metadata.detectedMime,originalFilename:metadata.originalFilename}),
  {namespace:'personnel-record-attachment',recordId:'existing-document',field:'payload',employeeNumber:'synthetic-person'});
 const document={id:'existing-document',employee_number:'synthetic-person',storage_key:metadata.storageKey,status:'active',protected_payload,current_version:1};
 f.rows.personnel_record_documents=[document];f.rows.personnel_record_document_versions=[{...document,document_id:document.id,version_number:1}];
 const before=tree(f.source),result=await verifyProtectedRecoveryFiles(f.client,f.options);
 assert.equal(result.verified,true);assert.equal(result.fileReferences,1);assert.equal(result.metadataFiles,1);assert.deepEqual(tree(f.source),before);
});

test('every required document family rejects an absent snapshot file without modifying source data',async t=>{
 for(const table of ['amu_documents','personnel_record_documents','candidate_document_versions','crm_customer_photos','loan_documents','loan_photos','loan_photo_attachments'])await t.test(table,async child=>{
  const f=await fixture(child),key='ab/'+crypto.randomUUID()+'.amu';
  if(table==='personnel_record_documents')f.rows.personnel_record_document_versions=[{storage_key:key}];
  else f.rows[table]=[...(f.rows[table]||[]),{storage_key:key,original_retained:1}];
  const before=tree(f.source);await assert.rejects(verifyProtectedRecoveryFiles(f.client,f.options),/PG_PAIR_PROTECTED_FILE_MISSING/);
  assert.deepEqual(tree(f.source),before);
 });
});

test('snapshot attachment ciphertext, metadata digest and protected record context all fail closed',async t=>{
 for(const mode of ['ciphertext','metadata','record'])await t.test(mode,async child=>{
  const f=await fixture(child);
  if(mode==='ciphertext'){const file=f.storage.blobPath(f.metadata.storageKey),bytes=fs.readFileSync(file);bytes[bytes.length-1]^=1;fs.writeFileSync(file,bytes);}
  if(mode==='metadata')f.rows.loan_photo_attachments[0].sha256='0'.repeat(64);
  if(mode==='record')f.rows.personnel_sensitive_records[0].employee_number='different-person';
  const before=tree(f.source);
  await assert.rejects(verifyProtectedRecoveryFiles(f.client,f.options),{code:mode==='record'?'PERSONNEL_RECORD_INTEGRITY_FAILED':'AMU_DOCUMENT_INTEGRITY_FAILED'});
  assert.deepEqual(tree(f.source),before);
 });
});

test('protected snapshot verification propagates the operation deadline and rejects duplicate document references',async t=>{
 const f=await fixture(t);let checks=0;
 await assert.rejects(verifyProtectedRecoveryFiles(f.client,{...f.options,checkBudget(){if(++checks===4)throw Object.assign(Error('synthetic deadline'),{code:'PG_BACKUP_OPERATION_TIMEOUT'});}}),{code:'PG_BACKUP_OPERATION_TIMEOUT'});
 f.rows.loan_documents=[{storage_key:f.metadata.storageKey}];
 await assert.rejects(verifyProtectedRecoveryFiles(f.client,f.options),/ungültige oder doppelte Verweise/);
});

async function paired(f,{changeLiveRows=false}={}){
 const backupDirectory=path.join(f.root,'pairs');fs.mkdirSync(backupDirectory,{recursive:true,mode:0o700});
 const clients=[],domains=['core','sales'].map(domain=>({domain,database:'synthetic_'+domain,ownerRole:'gp_'+domain+'_owner',pool:{async connect(){
  const client=new EventEmitter();client.events=[];client.release=()=>{};
  client.query=async(sql,values)=>{
   client.events.push(sql);
   if(sql==='BEGIN ISOLATION LEVEL REPEATABLE READ')client.snapshot=structuredClone(f.rows);
   if(sql.includes('current_database() AS name'))return{rows:[{name:'synthetic_'+domain}]};
   if(sql.includes('FROM pg_tables'))return{rows:[{schemaname:'gp',tablename:'loan_photo_attachments'}]};
   if(sql.includes('pg_database_size'))return{rows:[{bytes:'1024'}]};
   if(sql.includes('pg_export_snapshot'))return{rows:[{id:'123-AB'}]};
   if(/^(?:SET |LOCK |BEGIN|COMMIT|ROLLBACK|SELECT pg_advisory)/.test(sql))return{rows:[]};
   assert.ok(client.snapshot,'All protected reads use the retained dump snapshot.');
   assert.ok(!client.events.includes('COMMIT')&&!client.events.includes('ROLLBACK'));
   return f.query(client.snapshot,sql,values);
  };clients.push(client);return client;
 }}}));
 let snapshot,proof,rolesWritten=false;
 const work=createPairedSnapshot({backupDirectory,domains,withQuiescedWrites:run=>run({active:true,pendingMutations:0}),
  async readCheckpoint({domain,client}){if(domain==='core')snapshot=client;return{syntheticOnly:true};},
  async runDump({domain,targetFile}){fs.writeFileSync(targetFile,'explicit synthetic '+domain+' dump',{flag:'wx',mode:0o600});if(changeLiveRows&&domain==='sales')f.rows.loan_photo_attachments=[];},
  async captureRecoveryFiles({directory}){
   copyRecoveryFiles(f.source,directory);
   fs.writeFileSync(path.join(directory,'configuration.env'),'SYNTHETIC_ONLY=1',{flag:'wx',mode:0o600});
   proof=await verifyProtectedRecoveryFiles(snapshot,{...f.options,sourceDirectory:path.join(directory,'private','amu')});
   fs.writeFileSync(path.join(directory,'roles.sql'),'explicit synthetic roles',{flag:'wx',mode:0o600});rolesWritten=true;
  }});
 return{work,clients,backupDirectory,proof:()=>proof,rolesWritten:()=>rolesWritten};
}

test('actual paired coordinator binds verification to both retained dump snapshots before committing and sealing',async t=>{
 const f=await fixture(t),run=await paired(f,{changeLiveRows:true}),result=await run.work;
 assert.equal(f.rows.loan_photo_attachments.length,0);assert.equal(run.proof().loanPhotoAttachments,1);
 assert.equal(fs.existsSync(result.commitMarker),true);assert.equal(run.rolesWritten(),true);assert.equal(run.clients.length,2);
 for(const client of run.clients)assert.ok(client.events.includes('COMMIT'));
 const manifest=JSON.parse(fs.readFileSync(path.join(result.bundle,'manifest.json'),'utf8'));
 assert.deepEqual(manifest.databases.map(row=>row.file),['core.dump','sales.dump']);
});

test('missing or tampered attachments roll back both snapshots, publish no new marker and retain every byte of the earlier complete point',async t=>{
 for(const mode of ['missing','tampered'])await t.test(mode,async child=>{
  const f=await fixture(child),first=await paired(f),old=await first.work,before=tree(first.backupDirectory);
  const file=f.storage.blobPath(f.metadata.storageKey);
  if(mode==='missing')fs.unlinkSync(file);else{const bytes=fs.readFileSync(file);bytes[bytes.length-1]^=1;fs.writeFileSync(file,bytes);}
  const failed=await paired(f);await assert.rejects(failed.work);
  assert.equal(failed.rolesWritten(),false);
  for(const client of failed.clients){assert.ok(client.events.includes('ROLLBACK'));assert.ok(!client.events.includes('COMMIT'));}
  assert.deepEqual(fs.readdirSync(failed.backupDirectory).filter(name=>name.endsWith('.complete.json')),[path.basename(old.commitMarker)]);
  const after=tree(failed.backupDirectory);for(const [name,digest] of Object.entries(before))assert.equal(after[name],digest,name);
 });
});

function actualRuntime(f){
 const {Module}=require('node:module'),filename=path.resolve(__dirname,'../lib/persistence/postgresql/operations/runtime.js');
 const clients=[],events=[];
 class Pool{
  constructor(options){this.database=options.database;}
  async connect(){
   const client=new EventEmitter();client.events=[];client.release=()=>{};
   client.query=async(sql,values)=>{
    client.events.push(sql);
    if(sql==='BEGIN ISOLATION LEVEL REPEATABLE READ')client.snapshot=structuredClone(f.rows);
    if(sql.includes('pg_stat_activity'))return{rows:[{n:0}]};
    if(sql.includes('current_database() AS name'))return{rows:[{name:this.database}]};
    if(sql.includes('FROM pg_tables'))return{rows:[{schemaname:'gp',tablename:'loan_photo_attachments'}]};
    if(sql.includes('pg_database_size'))return{rows:[{bytes:'1024'}]};
    if(sql.includes('pg_export_snapshot'))return{rows:[{id:'123-AB'}]};
    if(/^(?:SET |LOCK |BEGIN|COMMIT|ROLLBACK|SELECT pg_advisory)/.test(sql))return{rows:[]};
    assert.ok(client.snapshot,'The runtime must use its still-retained Core dump snapshot.');
    assert.ok(!client.events.includes('COMMIT')&&!client.events.includes('ROLLBACK'));
    return f.query(client.snapshot,sql,values);
   };clients.push(client);return client;
  }
  async end(){events.push('pool-end');}
 }
 const subject=new Module(filename,module);subject.filename=filename;subject.paths=Module._nodeModulePaths(path.dirname(filename));
 const actualRequire=subject.require.bind(subject);
 subject.require=name=>name==='pg'?{Pool}:name==='./paired-checkpoint'?{captureCheckpoint:async()=>({syntheticOnly:true})}:actualRequire(name);
 subject.__nativeStub=async(_config,name,_args,output)=>{events.push(name);fs.writeFileSync(output.outputFile,'explicit synthetic tool output',{flag:'wx',mode:0o600});};
 subject._compile(fs.readFileSync(filename,'utf8')+'\ninspectPair=async()=>({core:{},sales:{}});nativeTool=module.__nativeStub;',filename);
 const backupDirectory=path.join(f.root,'runtime-pairs'),workDirectory=path.join(f.root,'runtime-work');
 fs.mkdirSync(backupDirectory,{mode:0o700});fs.mkdirSync(workDirectory,{mode:0o700});
 const environmentFile=path.join(f.root,'runtime.env');fs.writeFileSync(environmentFile,Object.entries(f.environment).map(([name,value])=>name+'='+value).join('\n')+'\n',{mode:0o600});
 const config={mode:'qualification',sourceFiles:f.source,environmentFile,backupDirectory,workDirectory,host:'synthetic',port:1,
  administrator:{role:'synthetic',password:'synthetic'},domains:['core','sales'].map(domain=>({domain,database:'synthetic_'+domain,role:'gp_'+domain+'_migrator',password:'synthetic'}))};
 return{run:()=>subject.exports.createBackup(config),clients,events,backupDirectory};
}

test('actual runtime entry authenticates ordinary attachments before roles dump and rejects missing or tampered next points without publishing a marker',async t=>{
 for(const mode of ['missing','tampered'])await t.test(mode,async child=>{
  const f=await fixture(child),runtime=actualRuntime(f),complete=await runtime.run();
  assert.equal(complete.ok,true);assert.equal(complete.protectedRecoveryFiles.loanPhotoAttachments,1);assert.equal(complete.protectedRecoveryFiles.protectedRecords,1);
  assert.equal(fs.existsSync(complete.commitMarker),true);const before=tree(runtime.backupDirectory);
  const file=f.storage.blobPath(f.metadata.storageKey);if(mode==='missing')fs.unlinkSync(file);else{const bytes=fs.readFileSync(file);bytes[bytes.length-1]^=1;fs.writeFileSync(file,bytes);}
  const clientsBefore=runtime.clients.length,rolesBefore=runtime.events.filter(name=>name==='pg_dumpall').length;
  await assert.rejects(runtime.run(),mode==='missing'?/PG_PAIR_PROTECTED_FILE_MISSING/:{code:'AMU_DOCUMENT_INTEGRITY_FAILED'});
  assert.equal(runtime.events.filter(name=>name==='pg_dumpall').length,rolesBefore,'Failure is before the remaining roles dump.');
  const retained=runtime.clients.slice(clientsBefore).filter(client=>client.snapshot);assert.equal(retained.length,2);
  for(const client of retained){assert.ok(client.events.includes('ROLLBACK'));assert.ok(!client.events.includes('COMMIT'));}
  assert.deepEqual(fs.readdirSync(runtime.backupDirectory).filter(name=>name.endsWith('.complete.json')),[path.basename(complete.commitMarker)]);
  const after=tree(runtime.backupDirectory);for(const [name,digest] of Object.entries(before))assert.equal(after[name],digest,name);
 });
});
