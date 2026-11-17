'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {sealPairBundle,verifyPairBundle}=require('../lib/persistence/postgresql/operations/paired-bundle');
const {buildSalesPlan}=require('../lib/persistence/postgresql/operations/deploy-data-policy');
const {validateRecovery,validateRecoveryFiles}=require('../lib/persistence/postgresql/operations/deploy-owned-contract');
const {createImportSourceArchive}=require('../lib/data-import-source-archive');
const {createIntegrationSecretVault}=require('../lib/integration-secret-vault');
const {CASH_SNAPSHOT_TABLES}=require('../lib/persistence/statements/cash-snapshots');
const {PLAN_FORMAT}=require('../lib/persistence/postgresql/operations/cash-rehydration');
const C=require('../lib/data-import-contract');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const clone=value=>JSON.parse(JSON.stringify(value));

async function fixture(t,{full=false}={}){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'gp-owned-bundle-'));fs.chmodSync(root,0o700);
 t.after(()=>{assert.equal(path.dirname(fs.realpathSync(root)),fs.realpathSync(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
 const bundle=path.join(root,'checkpoint'+(full?'.pair':'.owned'));fs.mkdirSync(bundle,{mode:0o700});
 for(const [name,value] of Object.entries({'core.dump':'synthetic core component','sales.dump':'synthetic retained Sales component',
  'roles.sql':'synthetic roles','configuration.env':'SYNTHETIC_CONFIG=fixture'}))fs.writeFileSync(path.join(bundle,name),value,{mode:0o600});
 const options={databases:['core','sales'].map(domain=>({domain,database:'fixture_'+domain,file:domain+'.dump'})),checkpoint:{kind:'synthetic-component-contract'}};
 if(full)return {root,bundle,options};
 const privateRoot=path.join(bundle,'private');fs.mkdirSync(privateRoot,{mode:0o700});
 const directory=path.join(privateRoot,'import-sources'),objectDirectory=path.join(root,'source-objects'),vault=createIntegrationSecretVault({activeKeyId:'fixture',keys:{fixture:Buffer.alloc(32,61)}});
 const archive=createImportSourceArchive({directory:objectDirectory,vault});
 const buffer=Buffer.alloc(4096);buffer.write('Standard ACE DB',4);buffer[0x14]=3;buffer.write('Synthetic source archive fixture',256);
 const source={id:hash('synthetic-cash-source'),kind:'cash',fileSha256:hash(buffer),bytes:buffer.length,fileName:'Kassen_Umsaetze.accdb',revision:1};
 await archive.stage({source,buffer});
 await archive.promote({source:{...source,complete:true,status:'applied',revision:2}});
 const sourceArchive=await archive.referenceSnapshot({directory});
 const accessPlan=require('./fixtures/empty-access-projection').emptyAccessProjection(bundle,sourceArchive.generationSha256);
 const dataset={id:source.id,slot:1,scopeId:'fixture-scope',ownerId:'fixture-owner',revision:2,metadataSha256:hash('synthetic authenticated metadata'),
  fileSha256:source.fileSha256,bytes:source.bytes,generation:'current',
  tables:CASH_SNAPSHOT_TABLES.map(table=>({name:table.name,profileHash:table.profile.fingerprint,expectedRows:0,declaredRows:0,sourceHash:'0'.repeat(64)})),
  inventory:CASH_SNAPSHOT_TABLES.map((table,tableIndex)=>({tableIndex,rowCount:0,generation:0}))};
 const cashPlan={format:PLAN_FORMAT,archiveGenerationSha256:sourceArchive.generationSha256,datasets:[dataset]};cashPlan.planSha256=hash(C.canonical(cashPlan));
 const tables=[...Array.from({length:7},(_,i)=>({schema:'kassa',table:'cash_snapshot_'+i})),
  ...['sales_article_search_projection','sales_article_search_dirty','sales_article_own_images'].map(table=>({schema:'trade',table})),
  {schema:'gp',table:'environment_contract'}];
 const recovery={scope:'deploy-owned',fullRecovery:false,requiresCashRehydration:true,requiresAccessRehydration:true,archiveStorage:'server-reference-v1',accessPlan,rehydrationDatabaseBytes:{core:1048576,sales:1048576},salesPlan:buildSalesPlan({tables,foreignKeys:[]}),sourceArchive,cashPlan};
 return {root,bundle,directory,objectDirectory,archive,source,recovery,options:{...options,scope:'deploy-owned',recovery}};
}

test('reduced owned bundles and complete pair bundles cannot satisfy each other\'s verification scope',async t=>{
 const f=await fixture(t),sealed=await sealPairBundle(f.bundle,f.options);
 assert.equal(sealed.providerId,'postgresql-deploy-owned');assert.equal(sealed.fullRecovery,false);assert.equal(sealed.recoveryScope,'deploy-owned');
 const proof=await verifyPairBundle(f.bundle,sealed.commitMarker,{scope:'deploy-owned',expectedSha256:sealed.sha256});
 assert.equal(proof.manifest.format,'grabenplaner-postgresql-deploy-owned');
 assert.deepEqual(proof.manifest.recovery.sourceArchive,f.recovery.sourceArchive);
 await assert.rejects(verifyPairBundle(f.bundle,sealed.commitMarker),/PG_PAIR_MARKER/);
 const complete=await fixture(t,{full:true}),full=await sealPairBundle(complete.bundle,complete.options);
 assert.equal((await verifyPairBundle(complete.bundle,full.commitMarker)).manifest.format,'grabenplaner-postgresql-pair');
 await assert.rejects(verifyPairBundle(complete.bundle,full.commitMarker,{scope:'deploy-owned'}),/PG_PAIR_MARKER/);
});

async function freshFixture(t){
 const f=await fixture(t,{full:true}),bundle=f.bundle.replace(/\.pair$/,'.owned');fs.renameSync(f.bundle,bundle);
 const protection=require('../lib/data-import-protection').createDataImportProtection({encryptionKey:Buffer.alloc(32,31),indexKey:Buffer.alloc(32,47),keyId:'synthetic-fresh'});
 t.after(()=>protection.destroy());
 const actor={scopeId:'fixture-scope',ownerId:'fixture-owner'},fileSha256=hash('synthetic earlier source'),id=protection.digest(['source',actor,'trade',fileSha256]);
 const row={...actor,id,revision:'1',createdAt:'2026-11-16T00:00:00.000Z',updatedAt:'2026-11-16T00:00:00.000Z'};
 row.payload=protection.seal({kind:'trade',fileSha256},['source',row.scopeId,row.ownerId,row.id,1]);
 const freshSourcePlan=await require('../lib/persistence/postgresql/operations/access-fresh-rebuild').createFreshPlan({core:{async query(){return {rows:[row]};}},sales:{async query(){return {rows:[]};}},protection});
 const accessPlan={format:'grabenplaner-access-owned-state-v4',basis:'fresh-source-rebuild',file:'access-owned-state.rows',bytes:0,sha256:hash(''),rows:0,tables:[],
  stats:{completedAccessRuns:0,retainedPendingOrUnknownRuns:0,masterAnchors:0,historyAnchors:0,catalogRevisions:0}};
 accessPlan.planSha256=hash(C.canonical(accessPlan));fs.writeFileSync(path.join(bundle,accessPlan.file),'',{mode:0o600});
 const tables=Array.from({length:7},(_,i)=>({schema:'kassa',table:'cash_snapshot_'+i}));
 const recovery={scope:'deploy-owned',basis:'fresh-source-rebuild',fullRecovery:false,requiresCashRehydration:true,requiresAccessRehydration:true,requiresFreshAccess:true,
  archiveStorage:'none',accessPlan,freshSourcePlan,rehydrationDatabaseBytes:{core:1048576,sales:1048576},salesPlan:buildSalesPlan({tables,foreignKeys:[],basis:'fresh-source-rebuild'})};
 return {...f,bundle,recovery,options:{...f.options,scope:'deploy-owned',recovery}};
}

test('a fresh-source point seals without original files and binds the distinct ownership and source policy',async t=>{
 const f=await freshFixture(t),sealed=await sealPairBundle(f.bundle,f.options);
 const proof=await verifyPairBundle(f.bundle,sealed.commitMarker,{scope:'deploy-owned'});
 assert.equal(proof.manifest.recovery.requiresFreshAccess,true);assert.equal(proof.manifest.recovery.sourceArchive,undefined);
 assert.equal(proof.manifest.files.some(entry=>entry.file.startsWith('private/import-sources/')),false);
 for(const change of [r=>r.requiresFreshAccess=false,r=>r.archiveStorage='server-reference-v1',r=>r.sourceArchive={},
  r=>r.salesPlan=buildSalesPlan({tables:r.salesPlan.tables,foreignKeys:[]}),r=>r.freshSourcePlan.kinds.pop(),r=>r.accessPlan.basis='exact-archive']){
  const recovery=clone(f.recovery);change(recovery);assert.throws(()=>validateRecovery(recovery));
 }
 await assert.rejects(verifyPairBundle(f.bundle,sealed.commitMarker),/PG_PAIR_MARKER/);
});

test('fresh-source bundles reject hidden original objects and still authenticate the complete own-state stream',async t=>{
 const f=await freshFixture(t),files=[{file:f.recovery.accessPlan.file,bytes:f.recovery.accessPlan.bytes,sha256:f.recovery.accessPlan.sha256}];
 assert.equal(validateRecoveryFiles(f.recovery,files).verified,true);
 assert.throws(()=>validateRecoveryFiles(f.recovery,[]),/PG_DEPLOY_RECOVERY_PROJECTION_FILE/);
 assert.throws(()=>validateRecoveryFiles(f.recovery,[...files,{file:'private/import-sources/index.source-archive',bytes:1,sha256:hash('x')}]),/PG_DEPLOY_FRESH_SOURCE_ARCHIVE_UNEXPECTED/);
 const sealed=await sealPairBundle(f.bundle,f.options);fs.writeFileSync(path.join(f.bundle,f.recovery.accessPlan.file),'tampered');
 await assert.rejects(verifyPairBundle(f.bundle,sealed.commitMarker,{scope:'deploy-owned'}),/PG_PAIR_COMPONENT_HASH/);
});

test('recovery claims cannot promote a reduced point to a full recovery or relax retained GP data',async t=>{
 const f=await fixture(t);
 await assert.rejects(sealPairBundle(f.bundle,{...f.options,scope:'full'}),/PG_DEPLOY_RECOVERY_UNEXPECTED/);
 for(const change of [r=>r.fullRecovery=true,r=>r.requiresCashRehydration=false,r=>r.scope='full',
  r=>r.salesPlan.excludedTables.push({schema:'trade',table:'sales_article_own_images'}),r=>r.rehydrationDatabaseBytes.sales=0]){
  const recovery=clone(f.recovery);change(recovery);assert.throws(()=>validateRecovery(recovery));
 }
});

test('cash source identities, archive generation and plan content must remain bound together',async t=>{
 const f=await fixture(t);
 for(const change of [r=>r.cashPlan.datasets[0].fileSha256='f'.repeat(64),r=>r.cashPlan.datasets[0].id='f'.repeat(64),
  r=>r.cashPlan.datasets[0].tables[0].expectedRows=1,r=>r.cashPlan.archiveGenerationSha256='e'.repeat(64),
  r=>r.cashPlan.planSha256='d'.repeat(64),r=>r.sourceArchive.generation++,
  r=>r.sourceArchive.files[0].sha256='c'.repeat(64),r=>r.sourceArchive.files[1].file='../external.source']){
  const recovery=clone(f.recovery);change(recovery);assert.throws(()=>validateRecovery(recovery));
 }
 const recovery=clone(f.recovery);recovery.sourceArchive.kinds.find(slot=>slot.kind==='cash').current=null;
 assert.throws(()=>validateRecovery(recovery));
});

test('a reduced point cannot exceed the actual replay reference admission limit',async t=>{
 const f=await fixture(t),recovery=clone(f.recovery);
 const count=require('../lib/persistence/postgresql/operations/access-value-recipes').DEFAULT_LIMITS.maxReferences+1;
 recovery.accessPlan.stats.omittedValues=count;recovery.accessPlan.stats.omittedByKind.trade=count;
 const {planSha256,...content}=recovery.accessPlan;recovery.accessPlan.planSha256=hash(C.canonical(content));
 assert.throws(()=>validateRecovery(recovery),/PG_DEPLOY_RECOVERY_PROJECTION_LIMIT/);
});

test('a reduced seal requires its frozen source index and projection while source objects remain external',async t=>{
 const f=await fixture(t),manifestFiles=[];
 for(const name of fs.readdirSync(f.directory)){
  const buffer=fs.readFileSync(path.join(f.directory,name));manifestFiles.push({file:'private/import-sources/'+name,bytes:buffer.length,sha256:hash(buffer)});
 }
 manifestFiles.push({file:f.recovery.accessPlan.file,bytes:f.recovery.accessPlan.bytes,sha256:f.recovery.accessPlan.sha256});
 assert.equal(validateRecoveryFiles(f.recovery,manifestFiles).verified,true);
 assert.throws(()=>validateRecoveryFiles(f.recovery,manifestFiles.filter(entry=>!entry.file.endsWith('index.source-archive'))),/PG_DEPLOY_RECOVERY_ARCHIVE_FILES/);
 assert.throws(()=>validateRecoveryFiles(f.recovery,manifestFiles.filter(entry=>entry.file!==f.recovery.accessPlan.file)),/PG_DEPLOY_RECOVERY_PROJECTION_FILE/);
 const extra=[...manifestFiles,{file:'private/import-sources/'+'f'.repeat(64)+'.source',bytes:4096,sha256:'f'.repeat(64)}];
 assert.throws(()=>validateRecoveryFiles(f.recovery,extra),/PG_DEPLOY_RECOVERY_ARCHIVE_FILES/);
 fs.unlinkSync(path.join(f.directory,'index.source-archive'));
 await assert.rejects(sealPairBundle(f.bundle,f.options),/PG_DEPLOY_RECOVERY_ARCHIVE_FILES/);
 assert.equal(fs.existsSync(f.bundle+'.complete.json'),false);
});

test('same-size frozen index changes between source authentication and sealing cannot publish a recovery point',async t=>{
 const f=await fixture(t),file=path.join(f.directory,'index.source-archive');
 const bytes=fs.readFileSync(file);bytes[bytes.length-1]^=1;fs.writeFileSync(file,bytes);
 await assert.rejects(sealPairBundle(f.bundle,f.options),/PG_DEPLOY_RECOVERY_ARCHIVE_FILES/);
 assert.equal(fs.existsSync(f.bundle+'.complete.json'),false);
});

test('a sealed reduced point detects later frozen index corruption and remains pinned to its external digest',async t=>{
 const f=await fixture(t),sealed=await sealPairBundle(f.bundle,f.options),name='index.source-archive';
 const file=path.join(f.directory,name),bytes=fs.readFileSync(file),changed=Buffer.from(bytes);changed[0]^=1;fs.writeFileSync(file,changed);
 await assert.rejects(verifyPairBundle(f.bundle,sealed.commitMarker,{scope:'deploy-owned'}),/PG_PAIR_COMPONENT_HASH/);
 fs.writeFileSync(file,bytes);
 await assert.rejects(verifyPairBundle(f.bundle,sealed.commitMarker,{scope:'deploy-owned',expectedSha256:'f'.repeat(64)}),/PG_PAIR_MARKER/);
});

test('latest full selection and scoped retention never substitute or prune the other recovery class',async t=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'gp-recovery-classes-'));fs.chmodSync(root,0o700);
 t.after(()=>{assert.equal(path.dirname(fs.realpathSync(root)),fs.realpathSync(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
 const {prunePairedSnapshots}=require('../lib/persistence/postgresql/operations/paired-retention');
 const {latestBackup}=require('../lib/persistence/postgresql/operations/runtime');
 const now=Date.now(),points={full:[],owned:[]};
 for(const type of ['full','owned'])for(let i=0;i<3;i++){
  const f=await fixture(t,{full:type==='full'}),id=crypto.randomUUID(),target=path.join(root,id+(type==='full'?'.pair':'.owned'));
  assert.equal(fs.realpathSync(path.dirname(f.bundle)),fs.realpathSync(f.root));assert.equal(fs.realpathSync(path.dirname(target)),fs.realpathSync(root));
  assert.equal(fs.existsSync(target),false);fs.renameSync(f.bundle,target);
  const point=await sealPairBundle(target,{...f.options,snapshotId:id,createdAt:new Date(now-(type==='full'?60:10)*60000+i*60000).toISOString()});
  points[type].push(point);
 }
 const latest=await latestBackup({backupDirectory:root});
 assert.equal(latest.manifestSha256,points.full[2].sha256,'a newer owned point cannot qualify as the latest full backup');
 const fullResult=await prunePairedSnapshots(root,{keepCount:2,now});assert.equal(fullResult.providerId,'postgresql-pair');assert.equal(fullResult.removed.length,1);
 assert.deepEqual(points.full.map(point=>fs.existsSync(point.bundle)),[false,true,true]);
 assert.ok(points.owned.every(point=>fs.existsSync(point.bundle)&&fs.existsSync(point.commitMarker)));
 const newest=path.join(points.owned[2].bundle,'sales.dump'),content=fs.readFileSync(newest);fs.appendFileSync(newest,'corrupt owned component');
 await assert.rejects(prunePairedSnapshots(root,{keepCount:2,now,scope:'deploy-owned'}),/PG_PAIR_COMPONENT_HASH/);
 assert.ok(points.owned.every(point=>fs.existsSync(point.bundle)&&fs.existsSync(point.commitMarker)),'every owned point survives a failed pre-deletion verification');
 fs.writeFileSync(newest,content);
 const ownedResult=await prunePairedSnapshots(root,{keepCount:2,now,scope:'deploy-owned'});
 assert.equal(ownedResult.providerId,'postgresql-deploy-owned');assert.equal(ownedResult.removed.length,1);
 assert.deepEqual(points.owned.map(point=>fs.existsSync(point.bundle)),[false,true,true]);
 assert.deepEqual(points.full.map(point=>fs.existsSync(point.bundle)),[false,true,true]);
 assert.equal((await latestBackup({backupDirectory:root})).manifestSha256,points.full[2].sha256);
});
